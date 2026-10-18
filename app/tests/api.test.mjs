// R1.2 acceptance + security tests. Numbering follows the R1.1 brief §11; tests named R12-* cover the R1.2 brief §6 list.
// Every test here runs against the real service and HTTP handler; none are stubs.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createHub, createServer } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { sha256Bytes } from '../core/sha256.js';
import { reportingWeek, isoWithOffset, zonedToUtc, isWithinWorkingHours, addDays } from '../core/time.js';
import { pinProblem, SLA } from '../core/service.js';
import { WR_PAPER, WR_1_0 } from '../core/templates.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
const NAME = Object.fromEntries(PEOPLE.map(p => [p[0], p[1]]));
const ANS = { q1: 4, q2: 5, q3: 'no', q4: 'no' };
let hub, svc, db, server, base, kiosk;
const T = {};

// Tests jump the clock around; the authenticator replay guard (correctly) rejects
// codes from an earlier time step, so the test harness resets it on each jump.
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const local = (ymd, hms) => zonedToUtc(ymd, hms).toISOString();
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function emp(eid) { const r = await svc.login({ employeeId: eid, pin: PIN[eid], deviceToken: kiosk }); T[eid] = r.token; return r.token; }
async function staff(eid) { later(0.55); const r = await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) }); T[eid] = r.token; return r.token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input);
async function rejects(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, `expected ${status} got ${e.status} ${e.code}: ${e.message}`); if (code) assert.equal(e.code, code); return true; });
}
const current = async (eid) => (await call(eid, 'home')).surveys.at(-1);
const submit = (eid, assignmentId, extra = {}) => call(eid, 'survey.submit', {
  assignmentId, answers: ANS, typedName: NAME[eid], affirm: true, signPin: PIN[eid], language: 'en', idempotencyKey: 'k-' + Math.random(), ...extra });
function rawGet(path) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: server.address().port, path }, r => { r.resume(); res(r.statusCode); }).on('error', rej));
}
async function httpLogin(eid, { withKiosk = true } = {}) {
  const headers = { 'X-Hub-Request': '1', 'Content-Type': 'application/json' };
  if (withKiosk) headers.cookie = 'hub_device=' + kiosk;
  const r = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ employeeId: eid, pin: PIN[eid] }) });
  return { status: r.status, cookie: (r.headers.getSetCookie()[0] || '').split(';')[0], raw: r.headers.getSetCookie()[0] };
}
async function addEmployee(id, name, start, extra = {}) {
  const salt = 'ab'.repeat(16);
  db.run(`INSERT INTO employees (id, display_name, preferred_language, status, start_date, end_date, supervisor_id, roles, department, pin_salt, pin_hash, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, name, 'en', 'active', start, extra.end || null, 'E-102', '["employee"]', 'Assembly', salt, await hub.crypto.hashSecret('513864', salt), new Date().toISOString()]);
  PIN[id] = '513864'; NAME[id] = name;
}

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  kiosk = db.get("SELECT v FROM meta WHERE k='demo_device_token'").v;
  const hubRef = { hub, options: {} };
  server = createServer(hubRef);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  at('2026-10-16T17:30:00Z');   // Fri 10:30 PT, this week's report is open
});
after(() => server.close());

// ------------------------------------------------------------------ 1. Authenticated access
test('01 authenticated employee access: own report on the shop tablet; no session, no access', async () => {
  await emp('E-104');
  const a = await current('E-104');
  assert.equal(a.state, 'open');
  assert.equal((await call('E-104', 'survey.assignment', { assignmentId: a.assignmentId })).templateId, 'WR-1.0');
  await rejects(svc.call(null, 'home'), 401);
  await rejects(svc.call('f'.repeat(64), 'home'), 401);
  const r = await httpLogin('E-104');
  assert.equal(r.status, 200);
  assert.match(r.raw, /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + '/api/call/home', { method: 'POST', headers: { 'X-Hub-Request': '1' } })).status, 401);
});

// ------------------------------------------------------------------ 2. Isolation
test('02 cross-employee isolation: records, drafts, corrections, responses, safety and evidence', async () => {
  await emp('E-106'); await emp('E-104'); await staff('E-103');
  const kim = (await call('E-106', 'survey.mine')).find(m => m.submissionId);
  const kimOpen = (await call('E-106', 'survey.mine')).find(m => !m.submissionId && m.status === 'open');
  await rejects(call('E-104', 'survey.record', { submissionId: kim.submissionId }), 404);
  if (kimOpen) await rejects(call('E-104', 'survey.saveDraft', { assignmentId: kimOpen.assignmentId, answers: {} }), 404);
  await rejects(call('E-104', 'survey.amend', { submissionId: kim.submissionId, note: 'x', typedName: NAME['E-104'], affirm: true, signPin: PIN['E-104'] }), 404);
  await rejects(call('E-104', 'review.respond', { submissionId: kim.submissionId, text: 'x' }), 404);
  await rejects(call('E-104', 'review.seen', { submissionId: kim.submissionId }), 404);
  const kimSafety = db.get("SELECT id FROM safety_reports WHERE reporter_id='E-106' LIMIT 1").id;
  await rejects(call('E-104', 'safety.detail', { reportId: kimSafety }), 404);
  await rejects(call('E-104', 'attachment.add', { entityType: 'safety_report', entityId: kimSafety, filename: 'x.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }), 404);
  assert.ok(db.get("SELECT COUNT(*) n FROM audit_events WHERE action='record.denied' AND actor_id='E-104'").n >= 1);
  const { cookie } = await httpLogin('E-104');
  assert.equal((await fetch(`${base}/api/record/${kim.submissionId}.html`, { headers: { cookie } })).status, 404);
});

// ------------------------------------------------------------------ 3. Impersonation
test('03 impersonation: an open session cannot sign without its owner\'s PIN; nobody signs for someone else', async () => {
  await emp('E-106');
  const a = await current('E-106');
  // Kim already signed this week in the seed; use Jordan's open week instead.
  await emp('E-107');
  const j = await current('E-107');
  assert.equal(j.state, 'open');
  // Someone walks up to Jordan's unlocked session and tries to sign with their own PIN.
  await rejects(call('E-107', 'survey.submit', { assignmentId: j.assignmentId, answers: ANS, affirm: true, signPin: PIN['E-104'], idempotencyKey: 'imp2' }), 401, 'bad_sign_pin');
  // A supervisor cannot submit an employee's report.
  await staff('E-102');
  await rejects(call('E-102', 'survey.submit', { assignmentId: j.assignmentId, answers: ANS, typedName: NAME['E-107'], affirm: true, signPin: PIN['E-107'], idempotencyKey: 'imp3' }), 404);
  assert.equal(db.get('SELECT COUNT(*) n FROM survey_submissions WHERE assignment_id=?', [j.assignmentId]).n, 0);
  void a;
});

test('03b sign-in: staff use ID + PIN from any browser; management adds an authenticator code; temporary PINs; weak PINs', async () => {
  // Staff: one step, no registered device, no code.
  const s1 = await svc.login({ employeeId: 'E-108', pin: PIN['E-108'] });
  assert.ok(s1.token); assert.equal(s1.mustSetPin, false); assert.equal(s1.sharedDevice, false); assert.equal(s1.idleMinutes, 60);
  const s2 = await svc.login({ employeeId: ' e-108 ', pin: PIN['E-108'], sharedDevice: true });
  assert.equal(s2.sharedDevice, true); assert.equal(s2.idleMinutes, 5);
  // A registered tablet is optional; it labels the device and forces the shared-device timeout.
  assert.equal((await svc.login({ employeeId: 'E-108', pin: PIN['E-108'], deviceToken: kiosk })).sharedDevice, true);
  // Management: PIN is checked first, then the authenticator code; codes can't be replayed.
  later(1);
  await rejects(svc.login({ employeeId: 'E-102', pin: '000000', totp: '123456' }), 401, 'bad_login');
  await rejects(svc.login({ employeeId: 'E-102', pin: PIN['E-102'] }), 401, 'totp_required');
  const code = await totp('E-102');
  assert.ok((await svc.login({ employeeId: 'E-102', pin: PIN['E-102'], totp: code })).token);
  await rejects(svc.login({ employeeId: 'E-102', pin: PIN['E-102'], totp: code }), 401, 'bad_totp');
  // PIN rules: 6 to 12 digits, no easy patterns.
  for (const p of ['111111', '123456', '654321', '121212', '123123', '112233', '000101', '12345', '1234567890123', '11111111', '12121212', '12341234', '1101x9']) assert.ok(pinProblem(p, 'E-101'), p + ' should be rejected');
  for (const p of ['418093', '41809372', '418093726154']) assert.equal(pinProblem(p, 'E-101'), null, p);
  // Temporary PIN: typed in the normal PIN field, must be changed before anything else, single use.
  const temp = db.get("SELECT v FROM meta WHERE k='demo_setup_code_E-110'").v;
  assert.match(temp, /^\d{8}$/);
  const r = await svc.login({ employeeId: 'E-110', pin: temp });
  assert.equal(r.mustSetPin, true);
  await rejects(svc.call(r.token, 'home'), 403, 'must_set_pin');
  await rejects(svc.call(r.token, 'auth.setPin', { newPin: '123456', confirmPin: '123456' }), 400, 'weak_pin');
  await rejects(svc.call(r.token, 'auth.setPin', { newPin: '418093', confirmPin: '418094' }), 400, 'pin_mismatch');
  await svc.call(r.token, 'auth.setPin', { newPin: '418093', confirmPin: '418093' });
  assert.ok(await svc.call(r.token, 'home'));
  await rejects(svc.login({ employeeId: 'E-110', pin: temp }), 401);
  PIN['E-110'] = '418093';
  // Who can reset: a full-access manager, or the person's own manager for their staff; nobody resets themselves.
  await staff('E-102');
  await rejects(call('E-102', 'accounts.resetPin', { employeeId: 'E-103' }), 403);
  await rejects(call('E-102', 'accounts.resetPin', { employeeId: 'E-102' }), 403);
  const issued = await call('E-102', 'accounts.resetPin', { employeeId: 'E-108' });
  assert.match(issued.tempPin, /^\d{8}$/);
  // A reset replaces the old PIN at once and ends open sessions.
  await rejects(svc.call(s1.token, 'home'), 401);
  await rejects(svc.login({ employeeId: 'E-108', pin: PIN['E-108'] }), 401, 'bad_login');
  const r2 = await svc.login({ employeeId: 'E-108', pin: issued.tempPin });
  assert.equal(r2.mustSetPin, true);
  await svc.call(r2.token, 'auth.setPin', { newPin: PIN['E-108'], confirmPin: PIN['E-108'] });
  // Temporary PINs expire (72 h).
  const exp = await call('E-102', 'accounts.resetPin', { employeeId: 'E-108' });
  db.run('UPDATE employees SET setup_code_expires=? WHERE id=?', [new Date(hub.clock.now().getTime() - 1000).toISOString(), 'E-108']);
  await rejects(svc.login({ employeeId: 'E-108', pin: exp.tempPin }), 401, 'bad_login');
  const fresh = await call('E-102', 'accounts.resetPin', { employeeId: 'E-108' });
  const r3 = await svc.login({ employeeId: 'E-108', pin: fresh.tempPin });
  await svc.call(r3.token, 'auth.setPin', { newPin: PIN['E-108'], confirmPin: PIN['E-108'] });
  assert.ok(db.get("SELECT COUNT(*) n FROM audit_events WHERE action='pin.temp_issued' AND entity_id='E-108'").n >= 3);
  // Only hashes are stored, never the PIN.
  const row = db.get("SELECT * FROM employees WHERE id='E-108'");
  assert.ok(!JSON.stringify(row).includes(PIN['E-108']) && !JSON.stringify(row).includes(fresh.tempPin));
});

test('03c lockout: 5 wrong PINs lock for 15 min; 3 lockouts in 24 h need a reset; a lockout while signing ends the session', async () => {
  await addEmployee('E-190', 'Lou Lockme', '2020-01-01');
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) await rejects(svc.login({ employeeId: 'E-190', pin: '000000', deviceToken: kiosk }), 401);
    await rejects(svc.login({ employeeId: 'E-190', pin: '000000', deviceToken: kiosk }), 423, round < 2 ? 'locked' : 'hard_locked'); // the locking try says so
    await rejects(svc.login({ employeeId: 'E-190', pin: PIN['E-190'], deviceToken: kiosk }), 423); // correct PIN still refused while locked
    later(16);
  }
  await rejects(svc.login({ employeeId: 'E-190', pin: PIN['E-190'], deviceToken: kiosk }), 423, 'hard_locked');
  assert.ok(db.get("SELECT COUNT(*) n FROM notifications WHERE recipient_id='E-101' AND kind='security' AND ref='E-190'").n >= 1, 'HR alerted');
  // Wrong signing PINs count too, and the lockout revokes the open session.
  await addEmployee('E-191', 'Sam Signer', '2020-01-01');
  const t = (await svc.login({ employeeId: 'E-191', pin: PIN['E-191'], deviceToken: kiosk })).token;
  const a = (await svc.call(t, 'home')).surveys.at(-1);
  await svc.call(t, 'consent.record', { choice: 'electronic' });
  for (let i = 0; i < 5; i++) await rejects(svc.call(t, 'survey.submit', { assignmentId: a.assignmentId, answers: ANS, typedName: 'Sam Signer', affirm: true, signPin: '999999', idempotencyKey: 'L' + i }), 401);
  await rejects(svc.call(t, 'home'), 401, 'locked');
});

// ------------------------------------------------------------------ 4. Assignment by week
test('04 survey assignment by week: payroll week, opens Friday 07:00, due Monday 15:30, active questionnaire version', async () => {
  const w = reportingWeek(new Date('2026-10-14T19:00:00Z'));
  assert.deepEqual([w.start, w.end], ['2026-10-12', '2026-10-18']);
  assert.equal(isoWithOffset(new Date(w.opensAt)), '2026-10-16T07:00:00-07:00');
  assert.equal(isoWithOffset(new Date(w.dueAt)), '2026-10-19T15:30:00-07:00');
  const rows = db.all("SELECT * FROM survey_assignments WHERE week_id='2026-10-12'");
  assert.ok(rows.length >= 9 && rows.every(r => r.template_id === 'WR-1.0'));
  assert.equal(new Set(rows.map(r => r.employee_id)).size, rows.length, 'one per person per week');
  // Before Friday 07:00 the report is not open and can't be submitted.
  await addEmployee('E-192', 'Pat Early', '2020-01-01');
  at(local('2026-10-21', '12:00:00'));
  const t = (await svc.login({ employeeId: 'E-192', pin: PIN['E-192'], deviceToken: kiosk })).token;
  await svc.call(t, 'consent.record', { choice: 'electronic' });
  const a = (await svc.call(t, 'home')).surveys.at(-1);
  assert.equal(a.state, 'not_open');
  await rejects(svc.call(t, 'survey.submit', { assignmentId: a.assignmentId, answers: ANS, typedName: 'Pat Early', affirm: true, signPin: PIN['E-192'], idempotencyKey: 'early' }), 409, 'not_open');
  at(local('2026-10-23', '07:00:00'));
  assert.equal((await svc.call((await svc.login({ employeeId: 'E-192', pin: PIN['E-192'], deviceToken: kiosk })).token, 'home')).surveys.at(-1).state, 'open');
  // Versions: the archived paper form is preserved verbatim and can never be assigned.
  assert.equal(WR_PAPER.status, 'archived');
  assert.match(WR_PAPER.intro.en, /prior to returning to work on Monday morning/);
  assert.equal(WR_1_0.sections.flatMap(s => s.questions).find(q => q.id === 'q4').text.en, 'Have you suffered any injury at work or outside or work?');
  assert.throws(() => createServiceWith('WR-2.0-P'), /not approved/);
  at('2026-10-16T17:30:00Z');
});
import { createService } from '../core/service.js';
function createServiceWith(tid) { return createService({ db, crypto: hub.crypto, clock: hub.clock, config: { activeTemplate: tid } }); }

// ------------------------------------------------------------------ 5. Missing & late
test('05 missing and late: past due shows missing; late signing is allowed and flagged everywhere', async () => {
  at(local('2026-10-19', '16:00:00'));       // Monday after the due time
  await emp('E-107');
  const a = (await call('E-107', 'home')).surveys.find(s => s.week.weekId === '2026-10-12');
  assert.equal(a.state, 'missing');
  await staff('E-101');
  const d = await call('E-101', 'mgmt.dashboard', { view: 'week', weekId: '2026-10-12' });
  assert.ok(d.weeks[0].missing >= 1);
  // Outside work hours the report can't be signed (always paid time); the next morning it can, flagged late.
  await rejects(submit('E-107', a.assignmentId), 409, 'outside_work_hours');
  assert.equal((await call('E-107', 'session.me')).surveyWindow.openNow, false);
  at(local('2026-10-20', '08:00:00')); await emp('E-107'); await staff('E-101');
  assert.equal((await call('E-107', 'session.me')).surveyWindow.openNow, true);
  const r = await submit('E-107', a.assignmentId);
  assert.equal(r.late, true);
  const rec = await call('E-107', 'survey.record', { submissionId: r.submissionId });
  assert.equal(rec.original.payload.late, true);
  const d2 = await call('E-101', 'mgmt.dashboard', { view: 'week', weekId: '2026-10-12' });
  assert.equal(d2.weeks[0].late, d.weeks[0].late + 1);
  assert.equal(d2.weeks[0].missing, d.weeks[0].missing - 1);
  at('2026-10-16T17:30:00Z');
});

// ------------------------------------------------------------------ 6. Partial weeks
test('06 partial-week eligibility: new hires, absences, separations; recomputed when an absence is added', async () => {
  const week = '2026-11-02';
  await addEmployee('E-193', 'Wed Starter', '2026-11-04');     // Wed: 3 workdays -> expected
  await addEmployee('E-194', 'Thu Starter', '2026-11-05');     // Thu: 2 workdays -> excused
  await addEmployee('E-195', 'Tue Leaver', '2020-01-01', { end: '2026-11-03' });   // 2 workdays -> excused
  await addEmployee('E-196', 'Mid Absence', '2020-01-01');
  at(local('2026-11-06', '08:00:00'));
  await svc.tick();
  const row = (id) => db.get('SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=?', [id, week]);
  assert.equal(row('E-193').expected, 1);
  assert.equal(row('E-194').expected, 0); assert.match(row('E-194').excuse_reason, /Partial week \(2 workdays\)/);
  assert.equal(row('E-195').expected, 0);
  assert.equal(row('E-196').expected, 1);
  await staff('E-102');
  await call('E-102', 'hr.addAbsence', { employeeId: 'E-196', startDate: '2026-11-02', endDate: '2026-11-04', reason: 'vacation' });
  assert.equal(row('E-196').expected, 0, 'recomputed after absence');
  await rejects(call('E-102', 'hr.addAbsence', { employeeId: 'E-196', startDate: '2026-11-02', endDate: '2026-11-02', reason: 'surgery' }), 400);
  // Lee (on leave all of October) is not expected this week.
  assert.equal(db.get("SELECT expected FROM survey_assignments WHERE employee_id='E-109' AND week_id='2026-10-12'").expected, 0);
  at('2026-10-16T17:30:00Z');
});

// ------------------------------------------------------------------ 7. Drafts
test('07 draft preservation: survives a timeout and sign-in on the tablet; private; removed on submit', async () => {
  at('2026-10-16T17:30:00Z');
  await emp('E-108');
  const a = (await call('E-108', 'home')).surveys.find(s => s.week.weekId === '2026-10-12');
  await call('E-108', 'survey.saveDraft', { assignmentId: a.assignmentId, answers: { q1: 3, s2: 'Esperando material' } });
  later(6);                                       // shared tablet idles out after 5 minutes
  await rejects(call('E-108', 'home'), 401, 'expired');
  await emp('E-108');
  const d = await call('E-108', 'survey.assignment', { assignmentId: a.assignmentId });
  assert.deepEqual(d.draft, { q1: 3, s2: 'Esperando material' });
  await emp('E-104');
  await rejects(call('E-104', 'survey.assignment', { assignmentId: a.assignmentId }), 404);
  await submit('E-108', a.assignmentId, { answers: { ...ANS, s2: 'Esperando material' } });
  assert.equal(db.get('SELECT COUNT(*) n FROM survey_drafts WHERE assignment_id=?', [a.assignmentId]).n, 0);
});

// ------------------------------------------------------------------ 8. Duplicates
test('08 duplicate submission prevention: concurrent double taps (same key) give one record; a later different key is refused', async () => {
  await addEmployee('E-197', 'Dee Double', '2020-01-01');
  const t = (await svc.login({ employeeId: 'E-197', pin: PIN['E-197'], deviceToken: kiosk })).token; T['E-197'] = t;
  await call('E-197', 'consent.record', { choice: 'electronic' });
  const a = await current('E-197');
  const [r1, r2] = await Promise.all([submit('E-197', a.assignmentId, { idempotencyKey: 'same' }), submit('E-197', a.assignmentId, { idempotencyKey: 'same' })]);
  assert.equal(r1.submissionId, r2.submissionId);
  assert.ok(r1.duplicate || r2.duplicate);
  await rejects(submit('E-197', a.assignmentId, { idempotencyKey: 'other' }), 409, 'already_submitted');
  assert.equal(db.get('SELECT COUNT(*) n FROM survey_submissions WHERE assignment_id=?', [a.assignmentId]).n, 1);
});

// ------------------------------------------------------------------ 9. Explicit acknowledgment
test('09 explicit signature: acknowledgment box + PIN; e-sign consent is given with the first signature; paper choice respected', async () => {
  await addEmployee('E-198', 'Ana Affirm', '2020-01-01');
  const t = (await svc.login({ employeeId: 'E-198', pin: PIN['E-198'], deviceToken: kiosk })).token; T['E-198'] = t;
  const a = await current('E-198');
  await rejects(submit('E-198', a.assignmentId), 409, 'needs_consent');
  await call('E-198', 'consent.record', { choice: 'paper' });
  await rejects(submit('E-198', a.assignmentId, { esignConsent: true }), 409, 'paper_chosen');
  await call('E-198', 'consent.record', { choice: 'electronic' });
  await rejects(submit('E-198', a.assignmentId, { affirm: false }), 400, 'no_affirm');
  await rejects(submit('E-198', a.assignmentId, { signPin: '' }), 401, 'bad_sign_pin');
  await rejects(submit('E-198', a.assignmentId, { answers: { q1: 4 } }), 400, 'missing_answer');
  const r = await submit('E-198', a.assignmentId, { typedName: undefined });
  const p = (await call('E-198', 'survey.record', { submissionId: r.submissionId })).original.payload;
  assert.match(p.signature.statementShown, /does not mean I agree/);
  assert.match(p.signature.statementShown, /checking this box, entering my PIN/);
  assert.equal(p.signature.method, 'Signed-in session + acknowledgment checked + PIN re-entered at signing');
  assert.equal(p.signature.signerName, 'Ana Affirm');
  assert.equal(p.signature.typedName, undefined, 'no typed name in R1.2');
  assert.match(p.signature.identity.device, /Registered shop device/);
  assert.equal(p.form.templateId, 'WR-1.0');
  // First-time signer: one checkbox covers consent + signature; consent is recorded once, inside the signed record.
  await addEmployee('E-170', 'Fay First', '2020-01-01');
  T['E-170'] = (await svc.login({ employeeId: 'E-170', pin: PIN['E-170'] })).token;   // personal phone, no tablet
  const fa = await current('E-170');
  const fr = await submit('E-170', fa.assignmentId, { esignConsent: true });
  const fp = (await call('E-170', 'survey.record', { submissionId: fr.submissionId })).original.payload;
  assert.equal(fp.signature.consent.givenWithThisSignature, true);
  assert.equal(fp.signature.consent.version, 'esign-consent-2');
  assert.equal(db.get("SELECT COUNT(*) n FROM esign_consents WHERE employee_id='E-170' AND choice='electronic'").n, 1);
  assert.equal(fp.signature.identity.device, 'Personal device');
});

// ------------------------------------------------------------------ 10. Timestamps
test('10 signature timestamps: UTC and local with offset, reporting week, due time, late flag', async () => {
  const s = db.get("SELECT payload_json FROM survey_submissions WHERE employee_id='E-198'");
  const p = JSON.parse(s.payload_json);
  assert.match(p.signedAtUtc, /Z$/);
  assert.match(p.signedAtLocal, /-07:00$/);
  assert.equal(new Date(p.signedAtLocal).getTime(), new Date(p.signedAtUtc).getTime());
  assert.equal(p.reportingPeriod.start, '2026-10-12');
  assert.equal(p.reportingPeriod.dueAt, '2026-10-19T15:30:00-07:00');
  assert.equal(p.late, false);
});

// ------------------------------------------------------------------ 11. Immutability
test('11 signed records and evidence are append-only at the database level; integrity check catches tampering', async () => {
  for (const t of ['survey_submissions', 'survey_amendments', 'supervisor_reviews', 'review_events', 'esign_consents', 'safety_events', 'attachments', 'audit_events', 'notification_attempts', 'paper_events', 'ca_events']) {
    if (!db.get(`SELECT 1 FROM ${t} LIMIT 1`)) continue;
    assert.throws(() => db.run(`UPDATE ${t} SET rowid = rowid`), /append-only/, t);
    assert.throws(() => db.run(`DELETE FROM ${t}`), /append-only/, t);
  }
  const sr = db.get('SELECT id FROM safety_reports LIMIT 1').id;
  assert.throws(() => db.run("UPDATE safety_reports SET description='edited' WHERE id=?", [sr]), /locked/);
  await staff('E-101');
  assert.equal((await call('E-101', 'audit.verify')).ok, true);
});

// ------------------------------------------------------------------ 12. Amendments
test('12 amendment history: corrections are separately signed, keep the original, and reopen review', async () => {
  // Kim's week-4 report was signed off and then corrected in the seed.
  const s = db.get("SELECT s.* FROM survey_submissions s JOIN survey_amendments m ON m.submission_id = s.id WHERE s.employee_id='E-106'");
  await emp('E-106');
  const rec = await call('E-106', 'survey.record', { submissionId: s.id });
  assert.equal(rec.original.hash, s.payload_hash);
  assert.equal(rec.original.payload.answers.find(a => a.questionId === 'q3').answer, 'no');
  assert.equal(rec.amendments[0].payload.corrections.q3, 'yes');
  assert.equal(rec.amendments[0].payload.amends.originalHash, s.payload_hash);
  assert.equal(rec.review.state, 'amended_after_signoff');
  await staff('E-102');
  const q = await call('E-102', 'sup.queues', {});
  assert.ok(q.queues.awaiting.some(r => r.submissionId === s.id && r.review === 'amended_after_signoff'));
  await call('E-102', 'review.signoff', { submissionId: s.id, comments: 'Thanks for the correction.', closure: 'no_action', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] });
  const rec2 = await call('E-106', 'survey.record', { submissionId: s.id });
  assert.equal(rec2.reviews.length, 2);
  assert.equal(rec2.reviews[1].payload.reviews.latestAmendment.id, rec.amendments[0].id);
  assert.equal(rec2.original.hash, s.payload_hash);
});

// ------------------------------------------------------------------ 13. Supervisor authorization
test('13 supervisor authorization: team only; managers see status not answers; safety sees no survey answers; HR sees all', async () => {
  await staff('E-102'); await staff('E-103'); await staff('E-101');
  const pat = db.get("SELECT id FROM survey_submissions WHERE employee_id='E-103' LIMIT 1").id;   // Pat reports to Morgan
  const kim = db.get("SELECT id FROM survey_submissions WHERE employee_id='E-106' LIMIT 1").id;
  assert.ok(await call('E-102', 'survey.record', { submissionId: kim }));
  await rejects(call('E-102', 'survey.record', { submissionId: pat }), 404);
  const q = await call('E-102', 'sup.queues', {});
  assert.ok(q.team.every(e => db.get('SELECT supervisor_id FROM employees WHERE id=?', [e.id]).supervisor_id === 'E-102'));
  // Pat is Management (safety contact) with nobody reporting to her: no survey answers, status only.
  assert.equal((await call('E-103', 'sup.queues', {})).team.length, 0);
  await rejects(call('E-103', 'survey.record', { submissionId: kim }), 404);
  assert.ok((await call('E-103', 'mgmt.dashboard', { view: 'week' })).weeks[0].rows.filter(r => r.employee.id !== 'E-103').every(r => r.canOpen === false));
  assert.ok(await call('E-101', 'survey.record', { submissionId: pat }));                    // HR
  // A manager without HR or supervisor role sees completion status but no answers.
  const salt = 'cd'.repeat(16);
  db.run(`INSERT INTO employees (id, display_name, preferred_language, status, start_date, supervisor_id, roles, department, pin_salt, pin_hash, totp_secret, created_at)
          VALUES ('E-199','Mo Manager','en','active','2020-01-01','E-101','["employee","manager"]','Office',?,?,?,?)`, [salt, await hub.crypto.hashSecret('620481', salt), 'JBSWY3DPEHPK3PXP', new Date().toISOString()]);
  PIN['E-199'] = '620481';
  await staff('E-199');
  const d = await call('E-199', 'mgmt.dashboard', { view: 'week' });
  assert.ok(d.weeks[0].rows.length > 5 && d.weeks[0].rows.every(r => r.canOpen === false));
  await rejects(call('E-199', 'survey.record', { submissionId: kim }), 404);
  await emp('E-104');
  await rejects(call('E-104', 'mgmt.dashboard'), 403);
});

// ------------------------------------------------------------------ 14. Supervisor sign-off
test('14 supervisor sign-off: questions and answers, closure rules, separate signature, "seen" is not agreement', async () => {
  await staff('E-102');
  await emp('E-104');
  // Maria's last-week report has an open question from Dana.
  const sid = db.get("SELECT s.id FROM survey_submissions s JOIN survey_assignments a ON a.id=s.assignment_id WHERE s.employee_id='E-104' AND a.week_id='2026-10-05'").id;
  const before = db.get('SELECT payload_hash FROM survey_submissions WHERE id=?', [sid]).payload_hash;
  let rec = await call('E-102', 'survey.record', { submissionId: sid });
  assert.equal(rec.review.state, 'clarification_requested');
  await rejects(call('E-102', 'review.signoff', { submissionId: sid, closure: 'no_action', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] }), 409, 'pending');
  const home = await call('E-104', 'home');
  assert.ok(home.reviewItems.some(r => r.submissionId === sid && r.state === 'clarification_requested'));
  await call('E-104', 'review.respond', { submissionId: sid, text: 'Los dibujos del pedido 21866.' });
  rec = await call('E-102', 'survey.record', { submissionId: sid });
  assert.equal(rec.review.state, 'employee_responded');
  await rejects(call('E-102', 'review.signoff', { submissionId: sid, closure: 'action_assigned', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] }), 400, 'closure');
  await call('E-102', 'ca.create', { sourceType: 'survey', sourceId: sid, category: 'operational', title: 'Get foam drawings to the floor before cutting', priority: 'normal', assignedTo: 'E-102', dueDate: '2026-10-21' });
  await rejects(call('E-102', 'review.signoff', { submissionId: sid, closure: 'action_assigned', affirm: true, signPin: PIN['E-104'] }), 401, 'bad_sign_pin');   // someone else's PIN
  await call('E-102', 'review.signoff', { submissionId: sid, comments: 'Drawings issue logged.', trainingNeeded: true, trainingNote: 'Reading cut sheets', closure: 'action_assigned', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] });
  await rejects(call('E-102', 'review.signoff', { submissionId: sid, closure: 'no_action', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] }), 409, 'already');
  await call('E-104', 'review.seen', { submissionId: sid });
  await call('E-104', 'review.respond', { submissionId: sid, text: 'No estoy de acuerdo con la nota de capacitación.' });
  rec = await call('E-104', 'survey.record', { submissionId: sid });
  assert.equal(rec.original.hash, before);
  assert.equal(rec.reviews[0].payload.reviewer.id, 'E-102');
  assert.equal(rec.reviews[0].payload.closure, 'action_assigned');
  assert.ok(rec.events.some(e => e.kind === 'employee_seen' && /does not mean I agree/.test(e.text)));
  assert.ok(rec.events.some(e => e.kind === 'employee_response' && /No estoy de acuerdo/.test(e.text)));
  assert.equal(rec.review.needsSupervisor, true, 'a response after sign-off needs the supervisor');
  await rejects(call('E-104', 'review.signoff', { submissionId: sid, closure: 'no_action', typedName: NAME['E-104'], affirm: true, signPin: PIN['E-104'] }), 403);
});

// ------------------------------------------------------------------ 15. Corrective actions
test('15 corrective-action ownership: evidence required, verified by someone else, scoped by role', async () => {
  await staff('E-103'); await staff('E-102'); await emp('E-107');
  // The band-saw guard action is done by Dana and waiting for verification.
  const guard = db.get("SELECT * FROM corrective_actions WHERE title LIKE 'Replace band saw%'");
  assert.equal(guard.status, 'pending_verification');
  await rejects(call('E-102', 'ca.verify', { id: guard.id, decision: 'close' }), 403);           // did the work herself
  await call('E-103', 'ca.verify', { id: guard.id, decision: 'close', note: 'Checked guard.' });
  // Jordan's pallet-jack action: evidence required before marking done.
  const jack = db.get("SELECT * FROM corrective_actions WHERE title LIKE 'Paint a parking box%'");
  await rejects(call('E-107', 'ca.markDone', { id: jack.id, resolution: 'Painted' }), 400);
  await call('E-107', 'attachment.add', { entityType: 'corrective_action', entityId: jack.id, filename: 'box.png', mime: 'image/png', dataBase64: Buffer.from('fake-png').toString('base64') });
  await call('E-107', 'ca.markDone', { id: jack.id, resolution: 'Painted the box.' });
  await rejects(call('E-107', 'ca.verify', { id: jack.id, decision: 'close' }), 403);
  await call('E-103', 'ca.verify', { id: jack.id, decision: 'close' });
  assert.equal(db.get('SELECT status FROM corrective_actions WHERE id=?', [jack.id]).status, 'closed');
  // Employees only see actions assigned to them; HR-type categories are refused.
  assert.ok((await call('E-107', 'ca.list')).every(c => c.assignedTo.id === 'E-107'));
  await rejects(call('E-103', 'ca.create', { sourceType: 'manual', category: 'discipline', title: 'x', priority: 'low', assignedTo: 'E-102', dueDate: '2026-10-30' }), 400);
  await rejects(call('E-107', 'ca.create', { sourceType: 'manual', category: 'safety', title: 'x', priority: 'low', assignedTo: 'E-107', dueDate: '2026-10-30' }), 403);   // staff cannot assign actions
});

// ------------------------------------------------------------------ 16. Urgent ordering & escalation
test('16 urgent safety reports sort first and escalate every 15 minutes until acknowledged', async () => {
  at(local('2026-10-16', '16:50:00'));           // after hours
  await emp('E-108'); await staff('E-103');
  const r = await call('E-108', 'safety.report', { type: 'imminent', area: 'Foam', description: 'Hot wire cutter frayed cord sparking.' });
  assert.equal(r.guidance, 'STOP_AND_TELL');
  assert.equal(r.priority, 'urgent');
  assert.equal((new Date(r.responseDueAt) - hub.clock.now()) / 60000, SLA.urgent.minutes);
  const q = await call('E-103', 'safety.queue', { status: 'open' });
  assert.equal(q[0].id, r.reportId);
  later(16); await svc.tick();
  assert.equal(db.get('SELECT escalation_level FROM safety_reports WHERE id=?', [r.reportId]).escalation_level, 1);
  later(5); await svc.tick();
  assert.equal(db.get('SELECT escalation_level FROM safety_reports WHERE id=?', [r.reportId]).escalation_level, 1, 'no repeat within 15 minutes');
  later(11); await svc.tick();
  assert.equal(db.get('SELECT escalation_level FROM safety_reports WHERE id=?', [r.reportId]).escalation_level, 2);
  const esc = db.all("SELECT * FROM notifications WHERE ref=? AND subject LIKE 'ESCALATION%'", [r.reportId]);
  assert.ok(esc.some(n => n.recipient_id === 'E-101' && n.channel === 'sms'));
  assert.ok(esc.every(n => !isNaN(Date.parse(n.next_attempt_at)) && Math.abs(new Date(n.created_at) - new Date(n.next_attempt_at)) < 1000), 'urgent alerts are not held to working hours');
  await staff('E-103');
  await call('E-103', 'safety.acknowledge', { reportId: r.reportId, note: 'Unplugged and tagged out.' });
  later(20); await svc.tick();
  await emp('E-108');
  assert.equal(db.get('SELECT escalation_level FROM safety_reports WHERE id=?', [r.reportId]).escalation_level, 2, 'stops after acknowledgment');
  // Non-urgent alerts created after hours are held until working hours.
  const h = await call('E-108', 'safety.report', { type: 'suggestion', description: 'More hooks for aprons.' });
  void h;
  const held = db.get("SELECT * FROM notifications WHERE ref=(SELECT id FROM safety_reports ORDER BY created_at DESC LIMIT 1) LIMIT 1");
  assert.ok(isWithinWorkingHours(new Date(held.next_attempt_at)), held.next_attempt_at);
  at('2026-10-16T17:30:00Z');
});

// ------------------------------------------------------------------ 17. Delivery & retry
test('17 notification delivery with retry: failures back off 1, 2, 5 minutes and then deliver', async () => {
  at(local('2026-10-20', '09:00:00'));
  await staff('E-101');
  await call('E-101', 'demo.setSimFail', { employeeId: 'E-103', count: 2 });     // Pat's texts fail twice
  await emp('E-105');
  const r = await call('E-105', 'safety.report', { type: 'injury', area: 'CNC', description: 'Cut on hand from router bit change. First aid given.' });
  const sms = () => db.get("SELECT * FROM notifications WHERE ref=? AND recipient_id='E-103' AND channel='sms' AND backup_for IS NULL", [r.reportId]);
  assert.equal(sms().attempts, 1); assert.equal(sms().status, 'queued');
  later(0.5); await svc.tick(); assert.equal(sms().attempts, 1, 'waits 1 minute');
  later(0.6); await svc.tick(); assert.equal(sms().attempts, 2);
  later(2.1); await svc.tick(); assert.equal(sms().status, 'delivered'); assert.equal(sms().attempts, 3);
  const log = db.all('SELECT ok FROM notification_attempts WHERE notification_id=? ORDER BY id', [sms().id]).map(x => x.ok);
  assert.deepEqual(log, [0, 0, 1]);
  const mine = await call('E-105', 'safety.detail', { reportId: r.reportId });
  assert.ok(['delivered', 'seen'].includes(mine.deliverySummary.state));
  assert.ok(mine.deliverySummary.deliveredTo.includes('Pat Safety'));
});

// ------------------------------------------------------------------ 18. Failure visibility
test('18 failed notifications are visible, never reported as delivered, and trigger backup routes', async () => {
  at(local('2026-10-20', '10:00:00'));
  await staff('E-101');
  // Every text fails for every recipient.
  for (const id of ['E-101', 'E-102', 'E-103']) await call('E-101', 'demo.setSimFail', { employeeId: id, count: 9 });
  await emp('E-106');
  const r = await call('E-106', 'safety.report', { type: 'imminent', area: 'Assembly', description: 'Rivet gun air hose whipping loose.' });
  for (const m of [1.1, 2.1, 5.1]) { later(m); await svc.tick(); }
  await emp('E-106'); await staff('E-101');
  const failed = db.all("SELECT * FROM notifications WHERE ref=? AND status='failed'", [r.reportId]);
  assert.ok(failed.length >= 3, 'all first-line texts failed');
  assert.ok(db.get("SELECT COUNT(*) n FROM notifications WHERE ref=? AND backup_for IS NOT NULL AND channel='in_app'", [r.reportId]).n >= 3, 'in-app backups created');
  const mine = await call('E-106', 'safety.detail', { reportId: r.reportId });
  assert.ok(!['delivered', 'acknowledged'].includes(mine.deliverySummary.state), 'not claimed delivered: ' + mine.deliverySummary.state);
  assert.ok(mine.deliverySummary.failedCount >= 3);
  const d = await call('E-101', 'mgmt.dashboard', {});
  assert.ok(d.notificationFailures7d >= 3);
  const log = await call('E-101', 'notifications.log', { failedOnly: true });
  assert.ok(log.some(n => n.ref === r.reportId && n.attemptLog.length === 4));
  assert.ok(db.get("SELECT COUNT(*) n FROM audit_events WHERE action='notification.failed'").n >= 3);
  for (const id of ['E-101', 'E-102', 'E-103']) await call('E-101', 'demo.setSimFail', { employeeId: id, count: 0 });
  at('2026-10-16T17:30:00Z');
});

// ------------------------------------------------------------------ 19. Shared-device logout
test('19 shared-device sessions: 5-minute idle limit, sign-out, revoked tablet ends its sessions', async () => {
  at('2026-10-16T17:30:00Z');
  const t = await emp('E-104');
  assert.equal((await svc.call(t, 'session.me')).idleMinutes, 5);
  assert.equal((await svc.call(t, 'session.me')).sharedDevice, true);
  later(4); assert.ok(await svc.call(t, 'session.me'));
  later(6); await rejects(svc.call(t, 'session.me'), 401, 'expired');
  const t2 = await emp('E-104'); await svc.logout(t2); await rejects(svc.call(t2, 'session.me'), 401);
  // Registering and revoking a second tablet
  await staff('E-101');
  const dev = await call('E-101', 'device.register', { label: 'Test tablet' });
  const t3 = (await svc.login({ employeeId: 'E-104', pin: PIN['E-104'], deviceToken: dev.deviceToken })).token;
  await call('E-101', 'device.revoke', { deviceId: dev.deviceId });
  await rejects(svc.call(t3, 'session.me'), 401);
  // A revoked tablet token is simply ignored: the sign-in works as a personal device unless "shared" is chosen.
  assert.equal((await svc.login({ employeeId: 'E-104', pin: PIN['E-104'], deviceToken: dev.deviceToken })).sharedDevice, false);
  const t4 = (await svc.login({ employeeId: 'E-104', pin: PIN['E-104'], sharedDevice: true })).token;
  later(6); await rejects(svc.call(t4, 'session.me'), 401, 'expired');
  // Over HTTP, registering a device sets an HttpOnly cookie and never returns the token to page script.
  const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Hub-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: 'E-101', pin: PIN['E-101'], totp: await (async () => { later(0.6); return totp('E-101'); })() }) });
  const ck = lr.headers.getSetCookie()[0].split(';')[0];
  const reg = await fetch(base + '/api/call/device.register', { method: 'POST', headers: { 'X-Hub-Request': '1', cookie: ck, 'Content-Type': 'application/json' }, body: '{"label":"HTTP tablet"}' });
  const body = await reg.json();
  assert.equal(body.deviceToken, undefined);
  assert.match(reg.headers.getSetCookie()[0], /^hub_device=[a-f0-9]{64}; HttpOnly; SameSite=Strict/);
});

// ------------------------------------------------------------------ 23. Employee access to records
test('23 employees can download their own signed record; others and anonymous cannot', async () => {
  const s = db.get("SELECT id, payload_hash FROM survey_submissions WHERE employee_id='E-104' ORDER BY signed_at DESC LIMIT 1");
  const { cookie } = await httpLogin('E-104');
  const html = await fetch(`${base}/api/record/${s.id}.html`, { headers: { cookie } });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-disposition'), /attachment/);
  const text = await html.text();
  assert.ok(text.includes(s.payload_hash) && text.includes('DEMO RECORD') && text.includes('Supervisor review'));
  assert.match(text, /<h1>Weekly Report \d{1,2}\/\d{1,2}\/2026 for Maria Sample<\/h1>/, 'same heading as the paper form (Friday date)');
  assert.equal((await (await fetch(`${base}/api/record/${s.id}.json`, { headers: { cookie } })).json()).original.hash, s.payload_hash);
  assert.equal((await fetch(`${base}/api/record/${s.id}.html`)).status, 401);
  const other = await httpLogin('E-107');
  assert.equal((await fetch(`${base}/api/record/${s.id}.html`, { headers: { cookie: other.cookie } })).status, 404);
});

// ------------------------------------------------------------------ 24. Historical reporting
test('24 historical reporting: week, month and 12-week views; filters; supervisor reliability; recurring problems', async () => {
  at('2026-10-16T17:30:00Z');
  await staff('E-101'); await staff('E-102');
  const w = await call('E-101', 'mgmt.dashboard', { view: 'week', weekId: '2026-09-28' });
  const t = w.weeks[0];
  assert.equal(t.expected, t.onTime + t.late + t.paper + t.missing + t.notYet);
  assert.ok(t.rows.find(r => r.employee.id === 'E-109').state === 'excused');
  const m = await call('E-101', 'mgmt.dashboard', { view: 'month', month: '2026-09' });
  assert.deepEqual(m.weeks.map(x => x.week.weekId), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  const h = await call('E-101', 'mgmt.dashboard', { view: 'history' });
  assert.equal(h.weeks.length, 12);
  assert.ok(h.weeks.filter(x => x.week.weekId < '2026-08-31').every(x => x.expected === 0), 'pre-pilot weeks are not counted');
  const dana = h.reliability.find(r => r.supervisor === 'Dana Lead');
  assert.ok(dana && dana.submitted > 20 && dana.signedOff > 15 && dana.onTargetPct > 0);
  assert.ok(h.trends.byEquipment.some(x => x.label === 'Dust collector' && x.n >= 1) || h.trends.byArea.some(x => x.label === 'Foam'));
  const f = await call('E-101', 'mgmt.dashboard', { view: 'week', weekId: '2026-09-28', employeeId: 'E-104' });
  assert.deepEqual(f.weeks[0].rows.map(r => r.employee.id), ['E-104']);
  const ds = await call('E-102', 'mgmt.dashboard', { view: 'week', weekId: '2026-09-28', employeeId: 'E-103' });
  // Dana (Management, team access) sees everyone's completion status but can open answers only for her own team.
  assert.ok(ds.weeks[0].rows.every(r => r.canOpen === false), 'no answers outside her team');
});

// ------------------------------------------------------------------ 25. Time zones
test('25 time zone and daylight saving: weeks, due times and signature offsets', async () => {
  const fall = reportingWeek(new Date('2026-10-30T19:00:00Z'));
  assert.equal((new Date(fall.endsAt) - new Date(fall.startsAt)) / 3600000, 169);
  assert.equal(isoWithOffset(new Date(fall.dueAt)), '2026-11-02T15:30:00-08:00');
  assert.equal(reportingWeek(new Date('2026-11-01T09:30:00Z')).weekId, '2026-10-26');
  const spring = reportingWeek(new Date('2026-03-05T19:00:00Z'));
  assert.equal((new Date(spring.endsAt) - new Date(spring.startsAt)) / 3600000, 167);
  assert.equal(zonedToUtc('2026-03-08', '02:30:00').toISOString(), '2026-03-08T10:30:00.000Z');
  assert.equal(zonedToUtc('2026-11-01', '01:30:00').toISOString(), '2026-11-01T08:30:00.000Z');
  at(local('2026-11-06', '14:00:00'));
  await emp('E-106');
  await call('E-106', 'consent.record', { choice: 'electronic' });
  const a = (await call('E-106', 'home')).surveys.at(-1);
  assert.equal(a.week.weekId, '2026-11-02');
  const r = await submit('E-106', a.assignmentId);
  assert.match(r.signedAtLocal, /-08:00$/);
  at('2026-10-16T17:30:00Z');
});

// ------------------------------------------------------------------ extra security and evidence checks
test('S1 hashing: pure-JS SHA-256 matches node:crypto; attachments are type/size checked and hashed', async () => {
  for (const n of [0, 1, 55, 56, 64, 1000, 70000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
    assert.equal(sha256Bytes(b), createHash('sha256').update(b).digest('hex'));
  }
  await emp('E-104');
  const mine = db.get("SELECT id FROM safety_reports WHERE reporter_id='E-104' AND status != 'closed' LIMIT 1").id;
  await rejects(call('E-104', 'attachment.add', { entityType: 'safety_report', entityId: mine, filename: 'x.exe', mime: 'application/x-msdownload', dataBase64: 'AAAA' }), 400);
  await rejects(call('E-104', 'attachment.add', { entityType: 'safety_report', entityId: mine, filename: 'big.jpg', mime: 'image/jpeg', dataBase64: 'A'.repeat(2_100_000) }), 400);
  const data = Buffer.from('pretend-jpeg-bytes');
  const r = await call('E-104', 'attachment.add', { entityType: 'safety_report', entityId: mine, filename: 'floor.jpg', mime: 'image/jpeg', dataBase64: data.toString('base64') });
  assert.equal(r.sha256, createHash('sha256').update(data).digest('hex'));
  const { cookie } = await httpLogin('E-104');
  const res = await fetch(`${base}/api/attachment/${r.attachmentId}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), data);
});

test('S2 transport: CSRF header, unknown and prototype action names, raw path traversal, CSP', async () => {
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  await emp('E-104');
  await rejects(call('E-104', '__proto__'), 404);
  await rejects(call('E-104', 'constructor'), 404);
  await rejects(call('E-104', 'toString'), 404);
  for (const p of ['/../server/server.js', '/%2e%2e/server/server.js', '/..%2fcore%2fservice.js', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) assert.equal(await rawGet(p), 404, p);
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /default-src 'self'/);
});

test('S3 separation: revokes access immediately, cancels queued alerts, keeps every record', async () => {
  await staff('E-101');
  const t = await emp('E-107');
  const recs = db.get("SELECT COUNT(*) n FROM survey_submissions WHERE employee_id='E-107'").n;
  const r = await call('E-101', 'hr.setStatus', { employeeId: 'E-107', status: 'terminated', endDate: '2026-10-16' });
  assert.ok(r.sessionsRevoked >= 1);
  await rejects(svc.call(t, 'session.me'), 401);
  await rejects(svc.login({ employeeId: 'E-107', pin: PIN['E-107'], deviceToken: kiosk }), 401);
  assert.equal(db.get("SELECT COUNT(*) n FROM survey_submissions WHERE employee_id='E-107'").n, recs);
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE recipient_id='E-107' AND status='queued'").n, 0);
  await rejects(call('E-101', 'hr.setStatus', { employeeId: 'E-101', status: 'terminated' }), 403);
  assert.equal((await call('E-101', 'audit.verify')).ok, true, 'audit chain and every signed record still verify at the end');
});

// ------------------------------------------------------------------ Gaps found by the independent doc review
test('08b concurrent submits with different keys still produce exactly one record', async () => {
  at('2026-10-16T17:30:00Z');
  await addEmployee('E-180', 'Cy Concurrent', '2020-01-01');
  await emp('E-180');
  await call('E-180', 'consent.record', { choice: 'electronic' });
  const a = await current('E-180');
  const res = await Promise.allSettled([submit('E-180', a.assignmentId, { idempotencyKey: 'k-a' }), submit('E-180', a.assignmentId, { idempotencyKey: 'k-b' })]);
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(res.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal(db.get('SELECT COUNT(*) n FROM survey_submissions WHERE assignment_id=?', [a.assignmentId]).n, 1);
});

test('14b supervisor asks and withdraws a question; record carries its questionnaire version; injury follow-up hidden from the supervisor', async () => {
  at('2026-10-16T17:30:00Z');
  await addEmployee('E-181', 'Quinn Question', '2020-01-01');
  await emp('E-181');
  await call('E-181', 'consent.record', { choice: 'electronic' });
  const a = await current('E-181');
  const r = await submit('E-181', a.assignmentId, { answers: { ...ANS, q4: 'yes' } });
  await staff('E-102');
  let rec = await call('E-102', 'survey.record', { submissionId: r.submissionId });
  assert.equal(rec.original.payload.form.templateId, 'WR-1.0');
  assert.equal(rec.review.state, 'awaiting_review');
  assert.ok(!rec.followups.some(f => f.type === 'injury_followup'), 'supervisor does not get the injury follow-up');
  const own = await call('E-181', 'survey.record', { submissionId: r.submissionId });
  assert.ok(own.followups.some(f => f.type === 'injury_followup'), 'the employee sees their own follow-up');
  await staff('E-101');
  assert.ok((await call('E-101', 'survey.record', { submissionId: r.submissionId })).followups.some(f => f.type === 'injury_followup'), 'HR sees it');
  await call('E-102', 'review.requestClarification', { submissionId: r.submissionId, text: 'Was the injury at work?' });
  await rejects(call('E-102', 'review.requestClarification', { submissionId: r.submissionId, text: 'Again?' }), 409, 'pending');
  rec = await call('E-102', 'survey.record', { submissionId: r.submissionId });
  assert.equal(rec.review.state, 'clarification_requested');
  await rejects(call('E-102', 'review.signoff', { submissionId: r.submissionId, closure: 'no_action', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] }), 409, 'pending');
  await call('E-102', 'review.withdrawClarification', { submissionId: r.submissionId });
  rec = await call('E-102', 'survey.record', { submissionId: r.submissionId });
  assert.equal(rec.review.state, 'awaiting_review');
  await call('E-102', 'review.signoff', { submissionId: r.submissionId, closure: 'referred', typedName: NAME['E-102'], affirm: true, signPin: PIN['E-102'] });
  assert.equal((await call('E-102', 'survey.record', { submissionId: r.submissionId })).review.state, 'signed_off');
});

test('16b safety lead classifies and reassigns; confidential owners limited; the proposer cannot verify', async () => {
  at('2026-10-16T17:30:00Z');
  await addEmployee('E-182', 'Ray Reporter', '2020-01-01');
  await emp('E-182');
  const conf = await call('E-182', 'safety.report', { type: 'hazard', description: 'UNIT loose cable across aisle', confidential: true });
  const open = await call('E-182', 'safety.report', { type: 'hazard', description: 'UNIT oil on the floor by the press' });
  await staff('E-103');
  await rejects(call('E-103', 'safety.assign', { reportId: conf.reportId, ownerId: 'E-102' }), 400);
  await call('E-103', 'safety.acknowledge', { reportId: open.reportId });
  await call('E-103', 'safety.classify', { reportId: open.reportId, priority: 'high', area: 'CNC', equipment: 'Press 1' });
  await rejects(call('E-103', 'safety.classify', { reportId: open.reportId, area: 'Moon' }), 400);
  await call('E-103', 'safety.assign', { reportId: open.reportId, ownerId: 'E-102' });
  let d = await call('E-103', 'safety.detail', { reportId: open.reportId });
  assert.equal(d.priority, 'high'); assert.equal(d.area, 'CNC'); assert.equal(d.owner.id, 'E-102');
  assert.ok(d.events.some(e => e.kind === 'classified') && d.events.some(e => e.kind === 'assigned'));
  await call('E-103', 'safety.proposeResolution', { reportId: open.reportId, resolution: 'Cleaned and drip pan added' });
  await rejects(call('E-103', 'safety.verify', { reportId: open.reportId, decision: 'close' }), 403);
  await staff('E-101');
  await call('E-101', 'safety.verify', { reportId: open.reportId, decision: 'close', note: 'Checked' });
  d = await call('E-182', 'safety.detail', { reportId: open.reportId });
  assert.equal(d.status, 'closed');
});

// ================================================================== R1.2 brief §6
test('R12-01 account lifecycle: management creates an account, gives a temporary PIN, the person must change it; deactivation ends access', async () => {
  at('2026-10-16T17:30:00Z');
  await staff('E-101');
  const c = await call('E-101', 'accounts.create', { name: 'Gabe Newstart', language: 'en', role: 'staff', reportsTo: 'E-102' });
  const nid = c.account.id;
  assert.match(nid, /^E-\d+$/);
  assert.ok(Number(nid.slice(2)) > Math.max(...db.all("SELECT id FROM employees WHERE id LIKE 'E-%' AND id != ?", [nid]).map(r => Number(r.id.slice(2)))), 'next stable ID, never reused');
  assert.equal(c.account.role, 'staff');
  assert.match(c.tempPin, /^\d{8}$/);
  assert.equal(c.mfa, null, 'staff never get an authenticator');
  await rejects(call('E-101', 'accounts.create', { employeeId: nid, name: 'Dup', role: 'staff' }), 409, 'id_taken');
  const custom = await call('E-101', 'accounts.create', { employeeId: 'jsmith', name: 'Jo Smith', role: 'staff' });
  assert.equal(custom.account.id, 'JSMITH');
  // First sign-in from any browser with the temporary PIN; must choose a PIN before anything else.
  const s = await svc.login({ employeeId: nid, pin: c.tempPin });
  assert.equal(s.mustSetPin, true);
  await rejects(svc.call(s.token, 'survey.mine'), 403, 'must_set_pin');
  await svc.call(s.token, 'auth.setPin', { newPin: '583027', confirmPin: '583027' });
  assert.ok((await svc.call(s.token, 'home')).surveys.length >= 1, 'weekly survey right after first sign-in');
  // Deactivate: sessions end, sign-in refused, records kept; reactivation issues a new temporary PIN.
  await call('E-101', 'accounts.deactivate', { employeeId: nid });
  await rejects(svc.call(s.token, 'home'), 401);
  await rejects(svc.login({ employeeId: nid, pin: '583027' }), 401, 'bad_login');
  const re = await call('E-101', 'accounts.reactivate', { employeeId: nid });
  await rejects(svc.login({ employeeId: nid, pin: '583027' }), 401, 'bad_login');
  assert.equal((await svc.login({ employeeId: nid, pin: re.tempPin })).mustSetPin, true);
  const list = await call('E-101', 'accounts.list');
  assert.ok(list.find(a => a.id === nid && a.status === 'active' && a.tempPinPending === false));
  assert.ok(db.get("SELECT COUNT(*) n FROM audit_events WHERE action IN ('account.created','employee.status','pin.temp_issued') AND entity_id=?", [nid]).n >= 4);
});

test('R12-02 management accounts: individual credentials + MFA; role changes take effect at next sign-in', async () => {
  at('2026-10-16T17:30:00Z');
  await staff('E-101');
  const m = await call('E-101', 'accounts.create', { name: 'Sam Second', role: 'management', reportsTo: 'E-101' });
  assert.equal(m.account.role, 'management'); assert.equal(m.account.fullAccess, false); assert.equal(m.account.safetyContact, false);
  assert.ok(m.mfa && m.mfa.secret && /^otpauth:\/\/totp\//.test(m.mfa.otpauth));
  await rejects(svc.login({ employeeId: m.account.id, pin: m.tempPin }), 401, 'totp_required');
  const code = await totpAt(hub.crypto, m.mfa.secret, Math.floor(hub.clock.now().getTime() / 1000));
  const s = await svc.login({ employeeId: m.account.id, pin: m.tempPin, totp: code });
  assert.equal(s.mustSetPin, true);
  await svc.call(s.token, 'auth.setPin', { newPin: '730519', confirmPin: '730519' });
  const me = await svc.call(s.token, 'session.me');
  assert.equal(me.role, 'management');
  assert.ok(me.permissions.includes('safety.manage') && !me.permissions.includes('accounts.manage'));
  // Promote a staff member: their open session ends and the next sign-in asks for the authenticator.
  const k = await emp('E-106');
  const up = await call('E-101', 'accounts.update', { employeeId: 'E-106', role: 'management' });
  assert.ok(up.mfa && up.mfa.secret);
  await rejects(svc.call(k, 'home'), 401);
  await rejects(svc.login({ employeeId: 'E-106', pin: PIN['E-106'] }), 401, 'totp_required');
  await call('E-101', 'accounts.update', { employeeId: 'E-106', role: 'staff' });
  assert.ok((await svc.login({ employeeId: 'E-106', pin: PIN['E-106'] })).token);
  await rejects(call('E-101', 'accounts.update', { employeeId: 'E-101', role: 'management', fullAccess: false }), 403);   // can't drop own full access
});

test('R12-03 permission boundaries: staff vs management vs full access', async () => {
  at('2026-10-16T17:30:00Z');
  await addEmployee('E-172', 'Stu Staff', '2020-01-01'); await emp('E-172'); await staff('E-102'); await staff('E-101');
  const meStaff = await call('E-172', 'session.me');
  assert.equal(meStaff.role, 'staff');
  assert.deepEqual(meStaff.permissions.sort(), ['records.own', 'safety.report', 'survey.complete']);
  for (const [action, input] of [['sup.queues', {}], ['mgmt.dashboard', {}], ['safety.queue', {}], ['accounts.list', {}], ['accounts.create', { name: 'X', role: 'staff' }],
    ['accounts.resetPin', { employeeId: 'E-104' }], ['ca.create', { sourceType: 'manual', category: 'safety', title: 'x', priority: 'low', assignedTo: 'E-172', dueDate: '2026-10-30' }],
    ['notifications.log', {}], ['audit.verify', {}], ['employees.list', {}], ['hr.addAbsence', { employeeId: 'E-104', startDate: '2026-11-02', endDate: '2026-11-03', reason: 'vacation' }]]) {
    await assert.rejects(call('E-172', action, input), (e) => [403, 404].includes(e.status), `staff must not call ${action}`);
  }
  // Team-access management: own team's answers, no account administration.
  const maria = db.get("SELECT id FROM survey_submissions WHERE employee_id='E-104' LIMIT 1").id;
  const pat = db.get("SELECT id FROM survey_submissions WHERE employee_id='E-103' LIMIT 1").id;
  assert.ok(await call('E-102', 'survey.record', { submissionId: maria }));
  await rejects(call('E-102', 'survey.record', { submissionId: pat }), 404);
  await rejects(call('E-102', 'accounts.create', { name: 'X', role: 'staff' }), 403);
  await rejects(call('E-102', 'accounts.update', { employeeId: 'E-104', role: 'management' }), 403);
  await rejects(call('E-102', 'accounts.deactivate', { employeeId: 'E-104' }), 403);
  assert.ok((await call('E-102', 'accounts.list')).every(a => a.reportsTo === 'E-102' || a.id === 'E-102'));
  // Full access: everything.
  assert.ok(await call('E-101', 'survey.record', { submissionId: pat }));
  assert.ok((await call('E-101', 'accounts.list')).length >= 11);
});

test('R12-04 PIN guessing: per-account lockout and a per-connection rate limit over HTTP', async () => {
  at('2026-10-16T17:30:00Z');
  await addEmployee('E-171', 'Gus Guess', '2020-01-01');
  for (let i = 0; i < 4; i++) await rejects(svc.login({ employeeId: 'E-171', pin: String(100000 + i * 7919) }), 401, 'bad_login');
  await rejects(svc.login({ employeeId: 'E-171', pin: '999998' }), 423, 'locked');
  await rejects(svc.login({ employeeId: 'E-171', pin: PIN['E-171'] }), 423, 'locked');   // even the right PIN, while locked
  // Over HTTP one connection gets at most 30 sign-in attempts a minute, whichever IDs it tries.
  const statuses = [];
  for (let i = 0; i < 32; i++) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Hub-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: 'NOBODY' + i, pin: '583027' }) });
    statuses.push(r.status);
  }
  assert.ok(statuses.every(x => x === 401 || x === 429), 'never signed in');
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.filter(x => x === 401).length <= 30);
});

test('R12-05 designated safety contacts get urgent alerts; other management is reached by escalation', async () => {
  at('2026-10-16T17:30:00Z');
  const sam = db.get("SELECT id FROM employees WHERE display_name='Sam Second'").id;
  await emp('E-104');
  const r = await call('E-104', 'safety.report', { type: 'imminent', description: 'UNIT forklift brakes failing', area: 'Warehouse' });
  const to = (rid) => db.all("SELECT DISTINCT recipient_id FROM notifications WHERE kind='safety' AND ref=?", [rid]).map(x => x.recipient_id).sort();
  const first = to(r.reportId);
  assert.ok(first.includes('E-103') && first.includes('E-101'), 'safety contacts');
  assert.ok(first.includes('E-102'), "reporter's manager");
  assert.ok(!first.includes(sam), 'not every manager at first');
  later(16); await svc.tick();
  assert.ok(!to(r.reportId).includes(sam), 'level 1 escalation: contacts and full access only');
  later(15); await svc.tick();
  assert.ok(to(r.reportId).includes(sam), 'level 2 escalation reaches all of management');
  await staff('E-103');
  await call('E-103', 'safety.acknowledge', { reportId: r.reportId });
});

test('R12-06 work-hours window: the weekly report is filled in only on paid time; safety reports are never blocked', async () => {
  at(local('2026-10-17', '10:00:00'));      // Saturday
  await addEmployee('E-173', 'Wendy Weekend', '2020-01-01');
  T['E-173'] = (await svc.login({ employeeId: 'E-173', pin: PIN['E-173'] })).token;   // own phone at home
  await call('E-173', 'consent.record', { choice: 'electronic' });
  const a = await current('E-173');
  const w = (await call('E-173', 'session.me')).surveyWindow;
  assert.equal(w.openNow, false); assert.equal(w.restricted, true);
  assert.equal(isoWithOffset(new Date(w.nextOpen)), '2026-10-19T07:00:00-07:00');
  await rejects(call('E-173', 'survey.saveDraft', { assignmentId: a.assignmentId, answers: { q1: 4 } }), 409, 'outside_work_hours');
  await rejects(submit('E-173', a.assignmentId), 409, 'outside_work_hours');
  assert.ok((await call('E-173', 'safety.report', { type: 'hazard', description: 'UNIT loose step on the loading dock' })).reportId, 'safety reports work anytime');
  at(local('2026-10-19', '07:05:00'));      // Monday, start of shift
  T['E-173'] = (await svc.login({ employeeId: 'E-173', pin: PIN['E-173'] })).token;
  assert.ok((await submit('E-173', a.assignmentId)).submissionId);
  at('2026-10-16T17:30:00Z');
});

// ------------------------------------------------------------------ R1.2 production pieces (approved 2026-10-14)
import { makeCrypto } from '../core/webcrypto.js';
import { SCHEMA } from '../core/schema.js';
import { nodeDb, switchableClock } from '../server/node-adapters.js';
import { makeGoToSms, parseGoToReceipt, GOTO_SEND_URL, GOTO_TOKEN_URL } from '../core/goto-sms.js';
import { createHttpHandler } from '../core/http.js';

test('R12-07 first-account setup: works once on an empty production database, with the setup code, then switches off', async () => {
  const db2 = nodeDb(); db2.exec(SCHEMA);
  const clock2 = switchableClock('2026-11-02T16:00:00Z');
  const crypto2 = makeCrypto({ pepper: 'test-pepper-0123456789abcdef' });
  const svc2 = createService({ db: db2, crypto: crypto2, clock: clock2, config: { demo: false } });
  const CODE = 'boot-code-0123456789-abcdef';
  assert.equal((await svc2.bootstrapStatus()).needed, true);
  await rejects(svc2.bootstrap({ code: 'wrong', expectedCode: CODE, name: 'Owner Person' }), 401, 'bad_code');
  await rejects(svc2.bootstrap({ code: CODE, expectedCode: 'short', name: 'Owner Person' }), 404);
  const r = await svc2.bootstrap({ code: CODE, expectedCode: CODE, employeeId: 'e-101', name: 'Owner Person', smsPhone: '(818) 555-0142' });
  assert.equal(r.employeeId, 'E-101'); assert.match(r.tempPin, /^\d{8}$/); assert.ok(r.mfa.secret);
  assert.equal(db2.get("SELECT sms_phone FROM employees WHERE id='E-101'").sms_phone, '+18185550142');
  await rejects(svc2.bootstrap({ code: CODE, expectedCode: CODE, name: 'Someone Else' }), 409, 'already_set_up');
  assert.equal((await svc2.bootstrapStatus()).needed, false);
  await rejects(svc2.login({ employeeId: 'E-101', pin: r.tempPin }), 401, 'totp_required');
  const s = await svc2.login({ employeeId: 'E-101', pin: r.tempPin, totp: await totpAt(crypto2, r.mfa.secret, Math.floor(clock2.now().getTime() / 1000)) });
  assert.equal(s.mustSetPin, true);
  await svc2.call(s.token, 'auth.setPin', { newPin: '730519', confirmPin: '730519' });
  const me = await svc2.call(s.token, 'session.me');
  assert.equal(me.role, 'management'); assert.equal(me.fullAccess, true); assert.equal(me.safetyContact, true);
  // A demo build never offers setup.
  await rejects(svc.bootstrap({ code: CODE, expectedCode: CODE, name: 'X' }), 404);
});

test('R12-08 GoTo texting: a text is "sent" until GoTo confirms delivery; failures retry; no receipt in 5 minutes counts as failed', async () => {
  const calls = [];
  let nextId = 1, failSends = 0;
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url === GOTO_TOKEN_URL) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600, refresh_token: 'refresh-2' }), { status: 200 });
    if (url === GOTO_SEND_URL) { if (failSends > 0) { failSends--; return new Response('{}', { status: 503 }); } return new Response(JSON.stringify({ id: 'msg-' + (nextId++) }), { status: 201 }); }
    return new Response('{}', { status: 404 });
  };
  let stored = null;
  const g = makeGoToSms({ fetch: fakeFetch, clientId: 'cid', clientSecret: 'sec', refreshToken: 'refresh-1', ownerNumber: '+18185550100', tokenStore: { get: async () => stored, set: async (v) => { stored = v; } } });
  const hub2 = await createHub({ senders: { sms: g.sms, smsProvider: 'goto' } });
  const db3 = hub2.db, svc3 = hub2.service;
  hub2.clock.freeze(); hub2.clock.set(new Date('2026-10-16T17:30:00Z')); db3.run('UPDATE employees SET totp_last_counter=-1');
  db3.run("UPDATE employees SET sms_phone='+18185550142' WHERE id='E-103'");
  db3.run("UPDATE employees SET sms_phone=NULL, phone_on_file=0 WHERE id NOT IN ('E-103')");
  const t = (await svc3.login({ employeeId: 'E-104', pin: PIN['E-104'] })).token;
  const rep = await svc3.call(t, 'safety.report', { type: 'imminent', description: 'UNIT GoTo test: guard missing on saw' });
  await svc3.tick();
  let n = db3.get("SELECT * FROM notifications WHERE ref=? AND channel='sms' AND recipient_id='E-103'", [rep.reportId]);
  assert.equal(n.status, 'sent', 'accepted by GoTo is not "delivered"');
  assert.equal(n.provider, 'goto'); assert.equal(n.provider_id, 'msg-1');
  const send = calls.find(c => c.url === GOTO_SEND_URL);
  assert.deepEqual(JSON.parse(send.opts.body), { ownerPhoneNumber: '+18185550100', contactPhoneNumbers: ['+18185550142'], body: n.subject });
  assert.equal(stored, 'refresh-2', 'rotated refresh token is kept');
  let d = (await svc3.call(t, 'safety.detail', { reportId: rep.reportId })).deliverySummary;
  assert.notEqual(d.state, 'delivered'); assert.ok(!d.deliveredTo.includes('Pat Safety'));
  // GoTo's DELIVERY_STATUS webhook confirms it.
  const receipts = parseGoToReceipt({ eventName: 'DELIVERY_STATUS', content: { messageId: 'msg-1', deliveryStatus: { code: 1000, description: 'DELIVERED', retryable: false } } });
  assert.deepEqual((await svc3.deliveryReceipt(receipts[0])), { matched: true, status: 'delivered' });
  d = (await svc3.call(t, 'safety.detail', { reportId: rep.reportId })).deliverySummary;
  assert.ok(d.deliveredTo.includes('Pat Safety'));
  // Second alert: GoTo is down once (retried), then accepts but never confirms -> failed attempt after 5 minutes.
  failSends = 1;
  const rep2 = await svc3.call(t, 'safety.report', { type: 'imminent', description: 'UNIT GoTo test 2' });
  await svc3.tick();
  n = db3.get("SELECT * FROM notifications WHERE ref=? AND channel='sms' AND recipient_id='E-103'", [rep2.reportId]);
  assert.equal(n.status, 'queued'); assert.match(n.last_error, /GoTo refused the text \(503\)/);
  hub2.clock.advance(61000); await svc3.tick();
  n = db3.get('SELECT * FROM notifications WHERE id=?', [n.id]);
  assert.equal(n.status, 'sent');
  hub2.clock.advance(6 * 60000); await svc3.tick();
  n = db3.get('SELECT * FROM notifications WHERE id=?', [n.id]);
  assert.match(n.last_error || '', /No delivery confirmation/);
  assert.equal(n.status, 'queued'); assert.equal(n.attempts, 2, 'the unconfirmed send counts as the failed second attempt');
  hub2.clock.advance(3 * 60000); await svc3.tick();
  n = db3.get('SELECT * FROM notifications WHERE id=?', [n.id]);
  assert.equal(n.status, 'sent'); assert.equal(n.attempts, 3);
  // A failed receipt (e.g. invalid number) fails the attempt and is never shown as delivered.
  const last = db3.get("SELECT provider_id FROM notifications WHERE id=?", [n.id]).provider_id;
  if (db3.get('SELECT status FROM notifications WHERE id=?', [n.id]).status === 'sent') {
    const res = await svc3.deliveryReceipt({ providerId: last, delivered: false, detail: 'INVALID_DESTINATION (4000)', retryable: false });
    assert.equal(res.status, 'failed');
    assert.ok(db3.get("SELECT COUNT(*) n FROM notifications WHERE backup_for=?", [n.id]).n >= 1, 'backup routes start');
  }
  hub2.stop();
});

test('R12-09 HTTP: bot check on sign-in when configured; GoTo receipts only with the webhook secret; no CSRF bypass elsewhere', async () => {
  const handler = createHttpHandler({ service: svc, turnstile: { siteKey: 'site-key', verify: async (token) => token === 'good-token' }, gotoWebhookSecret: 'hook-secret-0123456789abcdef' });
  const post = (path, body, headers = { 'X-Hub-Request': '1' }) => handler(new Request('http://x' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), { clientKey: 'r12-09' });
  at('2026-10-16T17:30:00Z');
  assert.equal((await (await handler(new Request('http://x/api/config'))).json()).turnstileSiteKey, 'site-key');
  let r = await post('/api/login', { employeeId: 'E-104', pin: PIN['E-104'] });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'bot_check');
  r = await post('/api/login', { employeeId: 'E-104', pin: PIN['E-104'], turnstileToken: 'good-token' });
  assert.equal(r.status, 200);
  assert.equal((await post('/api/hooks/goto/wrong-secret-0123456789', [], {})).status, 404);
  r = await post('/api/hooks/goto/hook-secret-0123456789abcdef', { content: { messageId: 'nope', deliveryStatus: { code: 1000, description: 'DELIVERED' } } }, {});
  assert.equal(r.status, 200); assert.equal((await r.json()).matched, 0);
  assert.equal((await post('/api/call/home', {}, {})).status, 403, 'other POSTs still need the CSRF header');
  assert.equal((await post('/api/setup', { code: 'x' })).status, 404, 'setup is off unless configured');
});

test('R12-10 authenticator secrets are encrypted at rest; older plain values are encrypted at start-up; a different pepper cannot read them', async () => {
  // Seeded management accounts: nothing readable in the database.
  // (E-199 is written in plain by an earlier test to stand in for an older record; it is covered below.)
  for (const r of db.all("SELECT id, totp_secret FROM employees WHERE totp_secret IS NOT NULL AND id != 'E-199'", [])) assert.match(r.totp_secret, /^enc1:[A-Za-z0-9+/=]+$/, r.id);
  // A fresh production database with a plain value written before encryption existed.
  const db3 = nodeDb(); db3.exec(SCHEMA);
  const clock3 = switchableClock('2026-11-02T16:00:00Z');
  const crypto3 = makeCrypto({ pepper: 'test-pepper-0123456789abcdef' });
  const svc3 = createService({ db: db3, crypto: crypto3, clock: clock3, config: { demo: false } });
  const CODE = 'boot-code-0123456789-abcdef';
  const r = await svc3.bootstrap({ code: CODE, expectedCode: CODE, employeeId: 'E-101', name: 'Owner Person' });
  assert.ok(crypto3.isSealed(db3.get("SELECT totp_secret FROM employees WHERE id='E-101'").totp_secret), 'new enrolment stored encrypted');
  db3.run("UPDATE employees SET totp_secret=? WHERE id='E-101'", [r.mfa.secret]);          // simulate an R1.1-era plain value
  assert.equal(await svc3.sealLegacySecrets(), 1);
  assert.equal(await svc3.sealLegacySecrets(), 0, 'idempotent');
  const stored = db3.get("SELECT totp_secret FROM employees WHERE id='E-101'").totp_secret;
  assert.ok(crypto3.isSealed(stored) && !stored.includes(r.mfa.secret));
  assert.equal(await crypto3.openSecret(stored), r.mfa.secret);
  await assert.rejects(makeCrypto({ pepper: 'another-pepper-0123456789' }).openSecret(stored));
  // Sign-in still works with the encrypted secret.
  const s = await svc3.login({ employeeId: 'E-101', pin: r.tempPin, totp: await totpAt(crypto3, r.mfa.secret, Math.floor(clock3.now().getTime() / 1000)) });
  assert.ok(s.token);
  assert.ok(db3.get("SELECT 1 FROM audit_events WHERE action='security.secrets_sealed'"), 'migration is audited');
});

test('R12-11 point-in-time restore: full access only, PIN + authenticator + typed RESTORE, 30-day window, durable log copied into the audit chain, undo', async () => {
  const db4 = nodeDb(); db4.exec(SCHEMA);
  const clock4 = switchableClock('2026-11-02T16:00:00Z');
  const crypto4 = makeCrypto({ pepper: 'test-pepper-0123456789abcdef' });
  // Stand-in for Cloudflare: the real Worker uses the Durable Object PITR API, which does not run locally.
  const logStore = [], scheduled = [];
  const platform = { restore: {
    log: async () => logStore.map(x => ({ ...x })),
    schedule: async (entry) => { const bookmark = 'bm-' + (entry.target.time || entry.target.bookmark); logStore.push({ ...entry, bookmark, before: 'bm-before-' + entry.id, undoBookmark: 'bm-undo-' + entry.id }); scheduled.push(bookmark); return { bookmark, undoBookmark: 'bm-undo-' + entry.id }; }
  } };
  const svc4 = createService({ db: db4, crypto: crypto4, clock: clock4, platform, config: { demo: false } });
  const CODE = 'boot-code-0123456789-abcdef';
  const b = await svc4.bootstrap({ code: CODE, expectedCode: CODE, employeeId: 'E-101', name: 'Owner Person' });
  // Each code comes from a new 30-second step (the replay guard refuses reuse).
  const code = async () => { clock4.advance(31000); return totpAt(crypto4, b.mfa.secret, Math.floor(clock4.now().getTime() / 1000)); };
  const s = await svc4.login({ employeeId: 'E-101', pin: b.tempPin, totp: await code() });
  await svc4.call(s.token, 'auth.setPin', { newPin: '730519', confirmPin: '730519' });
  const s2 = await svc4.login({ employeeId: 'E-101', pin: '730519', totp: await code() });
  // A manager without full access is refused.
  const mgr = await svc4.call(s2.token, 'accounts.create', { name: 'Dana Manager', role: 'management', employeeId: 'E-102' });
  db4.run("UPDATE employees SET totp_last_counter=-1");
  const m = await svc4.login({ employeeId: 'E-102', pin: mgr.tempPin, totp: await (async () => { clock4.advance(31000); return totpAt(crypto4, mgr.mfa.secret, Math.floor(clock4.now().getTime() / 1000)); })() });
  await rejects(svc4.call(m.token, 'admin.restoreStatus'), 403);
  await rejects(svc4.call(m.token, 'admin.restore', { toTime: new Date(Date.now() - 3600000).toISOString(), confirm: 'RESTORE' }), 403);
  const hour = new Date(Date.now() - 3600000).toISOString();
  await rejects(svc4.call(s2.token, 'admin.restore', { toTime: hour, signPin: '730519', totp: await code(), confirm: 'yes' }), 400);
  await rejects(svc4.call(s2.token, 'admin.restore', { toTime: hour, signPin: '000000', totp: await code(), confirm: 'RESTORE' }), 401, 'bad_sign_pin');
  await rejects(svc4.call(s2.token, 'admin.restore', { toTime: hour, signPin: '730519', totp: '000000', confirm: 'RESTORE' }), 401, 'bad_totp');
  await rejects(svc4.call(s2.token, 'admin.restore', { toTime: new Date(Date.now() - 31 * 86400000).toISOString(), signPin: '730519', totp: await code(), confirm: 'RESTORE' }), 400);
  await rejects(svc4.call(s2.token, 'admin.restore', { toTime: new Date().toISOString(), signPin: '730519', totp: await code(), confirm: 'RESTORE' }), 400);
  assert.equal(scheduled.length, 0, 'nothing scheduled by refused requests');
  const r = await svc4.call(s2.token, 'admin.restore', { toTime: hour, signPin: '730519', totp: await code(), confirm: 'restore' });
  assert.match(r.restoreId, /^RS-/); assert.equal(scheduled.length, 1);
  // After the restart the Hub copies the durable log into the audit chain (once).
  assert.equal(await svc4.recordRestores(), 1);
  assert.equal(await svc4.recordRestores(), 0);
  const a = db4.get("SELECT * FROM audit_events WHERE action='system.restored'");
  assert.equal(a.entity_id, r.restoreId); assert.equal(a.actor_id, 'E-101');
  // Undo uses the bookmark from just before the restore.
  const u = await svc4.call(s2.token, 'admin.restore', { undoId: r.restoreId, signPin: '730519', totp: await code(), confirm: 'RESTORE' });
  assert.equal(scheduled.at(-1), 'bm-bm-undo-' + r.restoreId);
  const st = await svc4.call(s2.token, 'admin.restoreStatus');
  assert.equal(st.available, true); assert.deepEqual(st.log.map(x => x.id), [u.restoreId, r.restoreId]);
  // Without the Cloudflare platform (local server / demo) restore says so.
  const login101 = await svc.login({ employeeId: 'E-101', pin: PIN['E-101'], totp: await totp('E-101') });
  await rejects(svc.call(login101.token, 'admin.restore', { toTime: hour, signPin: PIN['E-101'], confirm: 'RESTORE' }), 409, 'restore_unavailable');
});

test('R12-12 backup export: full access only; complete records without sign-in secrets; fingerprint and audit-chain head included; the export is audited', async () => {
  const mgr = await staff('E-101');
  const dana = await staff('E-102');
  await rejects(svc.call(dana, 'admin.backupExport'), 403);
  const staffTok = (await svc.login({ employeeId: 'E-108', pin: PIN['E-108'] })).token;
  await rejects(svc.call(staffTok, 'admin.backupExport'), 403);
  const r = await svc.call(mgr, 'admin.backupExport');
  assert.equal(createHash('sha256').update(r.body).digest('hex'), r.sha256);
  const b = JSON.parse(r.body);
  assert.equal(b.format, 'tag-employee-hub-backup-1');
  assert.equal(b.counts.survey_submissions, db.get('SELECT COUNT(*) n FROM survey_submissions').n);
  assert.equal(b.tables.audit_events.at(-1).hash, b.auditHead.hash);
  for (const e of b.tables.employees) for (const k of ['pin_hash', 'pin_salt', 'totp_secret', 'setup_code_hash']) assert.ok(!(k in e), k);
  for (const d of b.tables.devices) assert.ok(!('token_hash' in d));
  assert.ok(!('sessions' in b.tables));
  assert.ok(!/enc1:|"pin_hash"/.test(r.body));
  // Signed records in the copy still verify against their stored hashes.
  for (const s of b.tables.survey_submissions) assert.equal(createHash('sha256').update(s.payload_json).digest('hex'), s.payload_hash);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='backup.exported' AND actor_id='E-101'"));
});

test('R12-13 open portal: public info has no personal data; the name list only on a registered shop tablet; over HTTP without cookies', async () => {
  const p = svc.publicInfo();
  assert.equal(p.template.id, 'WR-1.0'); assert.ok(p.consent.version && p.surveyWindow && p.week.start && Array.isArray(p.links));
  const body = JSON.stringify(p);
  for (const [, name] of PEOPLE) assert.ok(!body.includes(name), 'public info must not name anyone: ' + name);
  await rejects((async () => svc.kioskRoster(undefined))(), 403, 'not_a_shop_tablet');
  await rejects((async () => svc.kioskRoster('not-a-real-token'))(), 403, 'not_a_shop_tablet');
  const r = svc.kioskRoster(kiosk);
  assert.ok(r.people.length > 3 && r.people.every(x => x.id && x.name));
  assert.ok(!r.people.some(x => x.id === 'E-111'), 'deactivated people are not listed');
  assert.equal(r.people.find(x => x.id === 'E-101').needsCode, true);
  assert.ok(!JSON.stringify(r).match(/pin|totp|secret/i));
  // Over HTTP: /api/public needs no session; the roster needs the shop-tablet cookie.
  const pub = await fetch(base + '/api/public'); assert.equal(pub.status, 200);
  const ros = await fetch(base + '/api/kiosk/roster'); assert.equal(ros.status, 403);
});

test('R12-14 go-live day (live mode, empty database): owner set up Friday morning, staff added with this week\'s Monday as start date can sign this week\'s report with one PIN', async () => {
  const db5 = nodeDb(); db5.exec(SCHEMA);
  const clock5 = switchableClock('2026-10-16T15:30:00Z');            // Friday 8:30 AM Pacific
  const crypto5 = makeCrypto({ pepper: 'live-pepper-0123456789abcdef' });
  const svc5 = createService({ db: db5, crypto: crypto5, clock: clock5, config: { demo: false, pilotStartWeek: '2026-10-12' } });
  const pub = svc5.publicInfo();
  assert.equal(pub.demo, false); assert.equal(pub.week.start, '2026-10-12'); assert.equal(pub.surveyWindow.openNow, true);
  const CODE = 'boot-code-0123456789-abcdef';
  const b = await svc5.bootstrap({ code: CODE, expectedCode: CODE, employeeId: 'E-101', name: 'Owner Person' });
  assert.equal(db5.get("SELECT start_date FROM employees WHERE id='E-101'").start_date, '2026-10-12', 'owner counts for this week');
  const code = async () => { clock5.advance(31000); return totpAt(crypto5, b.mfa.secret, Math.floor(clock5.now().getTime() / 1000)); };
  let s = await svc5.login({ employeeId: 'E-101', pin: b.tempPin, totp: await code() });
  await svc5.call(s.token, 'auth.setPin', { newPin: '730519', confirmPin: '730519' });
  s = await svc5.login({ employeeId: 'E-101', pin: '730519', totp: await code() });
  const staffA = await svc5.call(s.token, 'accounts.create', { name: 'Staff Existing', role: 'staff', employeeId: 'E-120', startDate: '2026-10-12', reportsTo: 'E-101' });
  const staffB = await svc5.call(s.token, 'accounts.create', { name: 'Staff Newhire', role: 'staff', employeeId: 'E-121', startDate: '2026-10-16', reportsTo: 'E-101' });
  // What the open-portal report does: sign in with the PIN typed at signing, set an own PIN (temporary PIN), find the open week, submit.
  const signWeekly = async (eid, temp, own) => {
    const l = await svc5.login({ employeeId: eid, pin: temp, sharedDevice: true });
    assert.equal(l.mustSetPin, true);
    await svc5.call(l.token, 'auth.setPin', { newPin: own, confirmPin: own });
    const h = await svc5.call(l.token, 'home');
    const open = h.surveys.slice().reverse().find(x => ['open', 'missing'].includes(x.state));
    return { l, h, open };
  };
  const A = await signWeekly('E-120', staffA.tempPin, '583920');
  assert.ok(A.open, 'existing employee has this week open');
  const r = await svc5.call(A.l.token, 'survey.submit', { assignmentId: A.open.assignmentId, answers: ANS, signPin: '583920', affirm: true, esignConsent: true, language: 'en', idempotencyKey: 'golive-1' });
  const rec = await svc5.call(A.l.token, 'survey.record', { submissionId: r.submissionId });
  assert.equal(rec.original.integrity, 'verified'); assert.equal(rec.original.payload.demo, false);
  const B = await signWeekly('E-121', staffB.tempPin, '640271');
  assert.equal(B.open, undefined, 'a new hire starting Friday is not expected this week (partial week)');
  assert.match(B.h.surveys.at(-1).state, /excused/);
  // Before the pilot week nothing is "missing".
  assert.ok(!A.h.surveys.some(x => x.week.start < '2026-10-12'));
});

test('R12-15 start over after losing the setup screen: setup code only, only before anyone has chosen a PIN; old temporary PIN and authenticator stop working', async () => {
  const db6 = nodeDb(); db6.exec(SCHEMA);
  const clock6 = switchableClock('2026-10-16T17:00:00Z');
  const crypto6 = makeCrypto({ pepper: 'live-pepper-0123456789abcdef' });
  const svc6 = createService({ db: db6, crypto: crypto6, clock: clock6, config: { demo: false, pilotStartWeek: '2026-10-12' } });
  const CODE = 'boot-code-0123456789-abcdef';
  await rejects(svc6.bootstrapRecover({ code: CODE, expectedCode: CODE }), 409, 'in_use');   // nothing to restart yet
  const first = await svc6.bootstrap({ code: CODE, expectedCode: CODE, employeeId: 'E-101', name: 'Owner Person' });
  assert.deepEqual(await svc6.bootstrapStatus(), { needed: false, recoverable: true });
  // A few wrong tries (locks) do not block the restart.
  for (let i = 0; i < 5; i++) await svc6.login({ employeeId: 'E-101', pin: '00000000' }).catch(() => {});
  await rejects(svc6.bootstrapRecover({ code: 'wrong', expectedCode: CODE }), 401, 'bad_code');
  const again = await svc6.bootstrapRecover({ code: CODE, expectedCode: CODE });
  assert.match(again.tempPin, /^\d{8}$/); assert.notEqual(again.mfa.secret, first.mfa.secret);
  const code = (secret) => { clock6.advance(31000); return totpAt(crypto6, secret, Math.floor(clock6.now().getTime() / 1000)); };
  await rejects(svc6.login({ employeeId: 'E-101', pin: first.tempPin, totp: await code(first.mfa.secret) }), 401);
  const s = await svc6.login({ employeeId: 'E-101', pin: again.tempPin, totp: await code(again.mfa.secret) });
  assert.equal(s.mustSetPin, true);
  await svc6.call(s.token, 'auth.setPin', { newPin: '730519', confirmPin: '730519' });
  assert.equal((await svc6.bootstrapStatus()).recoverable, false);
  await rejects(svc6.bootstrapRecover({ code: CODE, expectedCode: CODE }), 409, 'in_use');
  assert.ok(db6.get("SELECT 1 FROM audit_events WHERE action='bootstrap.recovered'"));
});
