// Synthetic data ONLY. Every person and record is invented. All signed history
// is created through the real service (same signing, hashing and auth code
// paths) with a controllable clock.
import { SCHEMA } from './schema.js';
import { zonedToUtc, addDays, reportingWeek } from './time.js';
import { totpAt, base32Encode } from './totp.js';
import { internalRolesFor, describeRoles } from './permissions.js';

export const DEMO_NOW = '2026-10-16T10:30:00-07:00';       // Friday: this week's report is open
export const PILOT_START_WEEK = '2026-08-31';

// id, name, lang, status, start, end, reports to, internal roles (from the visible role), dept, demo PIN, phone on file
// Visible roles: Morgan = Management (full access, safety contact); Dana = Management; Pat = Management (safety contact); everyone else = Staff.
export const PEOPLE = [
  ['E-101', 'Morgan Admin', 'en', 'active', '2015-03-02', null, null, internalRolesFor({ role: 'management', fullAccess: true, safetyContact: true }), 'Office', '417305', 1],
  ['E-102', 'Dana Lead', 'en', 'active', '2018-06-11', null, 'E-101', internalRolesFor({ role: 'management' }), 'Production', '582914', 1],
  ['E-103', 'Pat Safety', 'en', 'active', '2019-01-07', null, 'E-101', internalRolesFor({ role: 'management', safetyContact: true }), 'Production', '730628', 1],
  ['E-104', 'Maria Sample', 'es', 'active', '2020-02-03', null, 'E-102', ['employee'], 'Foam', '264809', 0],
  ['E-105', 'Luis Ejemplo', 'es', 'active', '2021-08-16', null, 'E-102', ['employee'], 'CNC', '918273', 0],
  ['E-106', 'Kim Testwell', 'en', 'active', '2022-04-04', null, 'E-102', ['employee'], 'Assembly', '305716', 0],
  ['E-107', 'Jordan Demo', 'en', 'active', '2023-09-18', null, 'E-102', ['employee'], 'Shipping', '847392', 0],
  ['E-108', 'Rosa Muestra', 'es', 'active', '2024-05-06', null, 'E-102', ['employee'], 'Foam', '629405', 0],
  ['E-109', 'Lee Onleave', 'en', 'active', '2021-01-11', null, 'E-102', ['employee'], 'Assembly', '156048', 0],
  ['E-110', 'Nina Newhire', 'es', 'active', '2026-10-15', null, 'E-102', ['employee'], 'Assembly', null, 0],
  ['E-111', 'Terry Former', 'en', 'terminated', '2017-07-10', '2026-09-30', 'E-102', ['employee'], 'CNC', '493017', 0]
];
const P = Object.fromEntries(PEOPLE.map(p => [p[0], { id: p[0], name: p[1], lang: p[2], pin: p[9] }]));

export async function seed({ db, crypto, clock, service }) {
  db.exec(SCHEMA);
  const at = (iso) => clock.set(new Date(iso));
  const local = (ymd, hms) => zonedToUtc(ymd, hms).toISOString();
  at('2026-08-01T16:00:00Z');

  for (const [eid, name, lang, status, start, end, sup, roles, dept, pin, phone] of PEOPLE) {
    const salt = crypto.randomHex(16);
    const elevated = roles.some(r => ['supervisor', 'safety', 'manager', 'hr'].includes(r));
    const secret = elevated ? base32Encode(Uint8Array.from(crypto.randomHex(20).match(/../g), h => parseInt(h, 16))) : null;
    db.run(`INSERT INTO employees (id, display_name, preferred_language, status, start_date, end_date, supervisor_id, roles, department,
              pin_salt, pin_hash, pin_set_at, totp_secret, phone_on_file, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [eid, name, lang, status, start, end, sup, JSON.stringify(roles), dept, salt, pin ? await crypto.hashSecret(pin, salt) : null,
        pin ? clock.now().toISOString() : null, secret ? await crypto.sealSecret(secret) : null, phone, clock.now().toISOString()]);
  }
  db.run("INSERT INTO meta (k, v) VALUES ('pilot_start_week', ?)", [PILOT_START_WEEK]);

  const totpNow = async (eid) => {
    const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]);
    return e.totp_secret ? totpAt(crypto, await crypto.openSecret(e.totp_secret), Math.floor(clock.now().getTime() / 1000)) : undefined;
  };

  // Morgan registers the shop tablet (Morgan signs in from the office PC with PIN + authenticator).
  // Authenticator codes can't be reused within a 30 s step, so staff sign-ins are spaced out.
  const login = async (eid, deviceToken) => {
    if (!deviceToken) clock.set(new Date(clock.now().getTime() + 31000));
    return (await service.login({ employeeId: eid, pin: P[eid].pin, totp: await totpNow(eid), deviceToken })).token;
  };
  const tMorgan = await login('E-101');
  const dev = await service.call(tMorgan, 'device.register', { label: 'Shop tablet 1 (by time clock)' });
  db.run("INSERT INTO meta (k, v) VALUES ('demo_device_token', ?)", [dev.deviceToken]);
  const kiosk = dev.deviceToken;
  const asEmp = async (eid) => login(eid, kiosk);          // employees sign in at the shop tablet
  const asStaff = async (eid) => login(eid);               // supervisors/safety/managers from their own devices

  // E-sign consent for everyone already employed.
  at(local('2026-08-31', '07:30:00'));
  for (const eid of ['E-101', 'E-102', 'E-103', 'E-104', 'E-105', 'E-106', 'E-107', 'E-108', 'E-109']) {
    const t = ['E-101', 'E-102', 'E-103'].includes(eid) ? await asStaff(eid) : await asEmp(eid);
    await service.call(t, 'consent.record', { choice: 'electronic', language: P[eid].lang });
    clock.set(new Date(clock.now().getTime() + 31000));
  }
  // Lee is on leave for most of October.
  { const t = await asStaff('E-101'); await service.call(t, 'hr.addAbsence', { employeeId: 'E-109', startDate: '2026-09-28', endDate: '2026-10-30', reason: 'leave' }); }

  const weeks = [];
  for (let i = 6; i >= 0; i--) weeks.push(reportingWeek(zonedToUtc(addDays('2026-10-12', -7 * i), '12:00:00')));
  const people = ['E-102', 'E-103', 'E-104', 'E-105', 'E-106', 'E-107', 'E-108', 'E-109'];
  const obstacles = {
    1: { 'E-104': 'Esperando los dibujos de espuma para el pedido grande.' },
    3: { 'E-105': 'Router bits are dull on CNC 2, slows every sheet.' },
    5: { 'E-107': 'Out of 3/8 rivets most of Wednesday.', 'E-104': 'La aspiradora de polvo se tapa otra vez.' }
  };
  const ans = (eid, i) => ({ q1: [4, 3, 5, 4, 3][(eid.charCodeAt(4) + i) % 5], q2: [5, 4, 5, 4][(eid.charCodeAt(4) + i) % 4], q3: 'no', q4: 'no' });
  const submissions = {};
  const prevW = weeks[5].weekId, w3 = weeks[3].weekId, w4 = weeks[4].weekId;

  // Everything below runs in strict time order, like real use.
  const events = [];
  const on = (iso, fn) => events.push({ at: iso, fn });

  for (const [wi, w] of weeks.entries()) {
    const isCurrent = wi === 6, isPrev = wi === 5;
    on(local(addDays(w.start, 4), '07:05:00'), () => service.tick());
    for (const [pi, eid] of people.entries()) {
      if (isPrev && eid === 'E-108') continue;                                          // Rosa missed last week
      if (isCurrent && ['E-104', 'E-105', 'E-107', 'E-108'].includes(eid)) continue;    // not yet this week
      if (wi === 1 && eid === 'E-107') continue;                                        // Jordan missed week 2
      let when = local(addDays(w.start, 4), `${12 + (pi % 3)}:${String(10 + pi * 5).padStart(2, '0')}:00`);
      if (isCurrent) when = local(addDays(w.start, 4), `0${8 + (pi % 2)}:${String(10 + pi * 5).padStart(2, '0')}:00`);
      if (wi === 4 && eid === 'E-105') when = local(addDays(w.start, 8), '09:20:00');   // late (Tuesday)
      on(when, async () => {
        const t = ['E-102', 'E-103'].includes(eid) ? await asStaff(eid) : await asEmp(eid);
        const a = (await service.call(t, 'home')).surveys.find(x => x.week.weekId === w.weekId);
        if (!a || !['open', 'missing'].includes(a.state)) return;
        const answers = ans(eid, wi);
        if (obstacles[wi] && obstacles[wi][eid]) answers.s2 = obstacles[wi][eid];
        if (wi === 2 && eid === 'E-104') answers.q4 = 'yes';
        if (wi === 1 && eid === 'E-108') answers.s1 = 'El colector de polvo de espuma está tapado y hay mucho polvo en el aire.';
        if (isPrev && eid === 'E-106') { answers.s1 = 'Band saw blade guard on the foam saw is cracked — taped for now.'; answers.s3 = 'Otherwise a good week.'; }
        const r = await service.call(t, 'survey.submit', { assignmentId: a.assignmentId, answers, typedName: P[eid].name, affirm: true, signPin: P[eid].pin, language: P[eid].lang, idempotencyKey: `seed-${eid}-${w.weekId}` });
        (submissions[w.weekId] ||= {})[eid] = r.submissionId;
      });
    }
    if (!isCurrent) on(local(addDays(w.start, 7), '10:00:00'), async () => {            // Dana reviews on Monday
      const td = await asStaff('E-102');
      for (const [eid, sid] of Object.entries(submissions[w.weekId] || {})) {
        if (!['E-104', 'E-105', 'E-106', 'E-107', 'E-108', 'E-109'].includes(eid)) continue;
        if (isPrev && ['E-104', 'E-105', 'E-106'].includes(eid)) continue;               // left for the demo
        clock.set(new Date(clock.now().getTime() + 40000));
        await service.call(td, 'review.signoff', { submissionId: sid, comments: 'Reviewed. Thanks. (sample comment)', closure: 'no_action', typedName: 'Dana Lead', affirm: true, signPin: P['E-102'].pin });
      }
    });
  }

  // Dust collector via Rosa's weekly report (week 2): classified, fixed, verified, closed.
  let dustId, caDustId;
  on(local(addDays(weeks[1].start, 7), '08:00:00'), async () => {
    const tp = await asStaff('E-103');
    const dust = (await service.call(tp, 'safety.queue', { status: 'open' })).find(r => r.source === 'survey' && r.type === 'hazard');
    dustId = dust.id;
    await service.call(tp, 'safety.acknowledge', { reportId: dustId, note: 'Checked. Filter bags full.' });
    await service.call(tp, 'safety.classify', { reportId: dustId, priority: 'high', area: 'Foam', equipment: 'Dust collector' });
    caDustId = (await service.call(tp, 'ca.create', { sourceType: 'safety_report', sourceId: dustId, category: 'safety', title: 'Replace dust collector filter bags', priority: 'high', assignedTo: 'E-102', dueDate: addDays(weeks[1].start, 9) })).id;
  });
  on(local(addDays(weeks[1].start, 8), '14:00:00'), async () => {
    await service.call(await asStaff('E-102'), 'ca.markDone', { id: caDustId, resolution: 'Replaced all 6 bags; added to monthly PM list.', closureEvidence: 'PM log page 14 (sample)' });
  });
  on(local(addDays(weeks[1].start, 9), '08:30:00'), async () => {
    const tp = await asStaff('E-103');
    await service.call(tp, 'ca.verify', { id: caDustId, decision: 'close', note: 'Inspected, airflow normal.' });
    await service.call(tp, 'safety.proposeResolution', { reportId: dustId, resolution: 'Bags replaced; added to PM schedule.' });
    await service.call(await asStaff('E-101'), 'safety.verify', { reportId: dustId, decision: 'close', note: 'Confirmed on walk-through.' });
  });

  // Maria's "injury Yes" (week 3): confidential follow-up by Pat, closed by Morgan.
  on(local(addDays(weeks[2].start, 7), '08:15:00'), async () => {
    const tp = await asStaff('E-103');
    const inj = (await service.call(tp, 'safety.queue', {})).find(r => r.type === 'injury_followup');
    await service.call(tp, 'safety.acknowledge', { reportId: inj.id, note: 'Spoke privately. First aid only; nothing further to report.' });
    await service.call(tp, 'safety.note', { reportId: inj.id, note: 'Reminded about the first-aid kit and reporting cuts the same day.' });
    await service.call(tp, 'safety.proposeResolution', { reportId: inj.id, resolution: 'Followed up; first aid only.' });
    await service.call(await asStaff('E-101'), 'safety.verify', { reportId: inj.id, decision: 'close' });
  });

  // Dust collector again (direct report, week 6): still open, shows a recurring problem.
  on(local(addDays(weeks[5].start, 2), '11:20:00'), async () => {
    await service.call(await asEmp('E-104'), 'safety.report', { type: 'unsafe_equipment', area: 'Foam', equipment: 'Dust collector', description: 'El colector de polvo hace un ruido fuerte y no jala bien.' });
  });

  // Kim's band-saw guard (last week's report): high priority, action done, waiting for verification.
  let caGuardId;
  on(local(addDays(weeks[5].start, 7), '07:40:00'), async () => {
    const tp = await asStaff('E-103');
    const guard = (await service.call(tp, 'safety.queue', {})).find(r => r.source === 'survey' && r.description.startsWith('Band saw'));
    await service.call(tp, 'safety.acknowledge', { reportId: guard.id, note: 'Saw locked out until the guard is replaced.' });
    await service.call(tp, 'safety.classify', { reportId: guard.id, priority: 'high', area: 'Saw / cutting', equipment: 'Band saw' });
    caGuardId = (await service.call(tp, 'ca.create', { sourceType: 'safety_report', sourceId: guard.id, category: 'safety', title: 'Replace band saw blade guard', priority: 'high', assignedTo: 'E-102', dueDate: '2026-10-14' })).id;
  });

  // Supervisor questions (Monday): one answered, one still waiting.
  on(local('2026-10-12', '10:30:00'), async () => {
    const td = await asStaff('E-102');
    await service.call(td, 'review.requestClarification', { submissionId: submissions[prevW]['E-105'], text: '¿Puedes contarme más sobre la productividad de esta semana? (muestra)' });
    await service.call(td, 'review.requestClarification', { submissionId: submissions[prevW]['E-104'], text: 'Which foam drawings were you waiting on? (sample)' });
  });
  on(local('2026-10-12', '13:15:00'), async () => {
    await service.call(await asEmp('E-105'), 'review.respond', { submissionId: submissions[prevW]['E-105'], text: 'El router 2 estuvo parado dos días esperando una pieza. (muestra)' });
  });

  // Tuesday: Kim corrects a signed report (reopens it) and marks another review as seen; Jordan disagrees with a review.
  on(local('2026-10-13', '07:50:00'), async () => {
    const t = await asEmp('E-106');
    await service.call(t, 'survey.amend', { submissionId: submissions[w3]['E-106'], note: 'I did report the wet floor by the dock to Dana on Tuesday — I marked No by mistake.', corrections: { q3: 'yes' }, typedName: 'Kim Testwell', affirm: true, signPin: P['E-106'].pin });
    await service.call(t, 'review.seen', { submissionId: submissions[w4]['E-106'] });
  });
  on(local('2026-10-13', '08:05:00'), async () => {
    await service.call(await asEmp('E-107'), 'review.respond', { submissionId: submissions[w4]['E-107'], text: 'I disagree with the comment — the rivets were out most of Wednesday.' });
  });

  // Jordan's pallet-jack hazard: acknowledged, action in progress and now overdue.
  on(local('2026-10-13', '09:12:00'), async () => {
    await service.call(await asEmp('E-107'), 'safety.report', { type: 'hazard', area: 'Shipping / dock', location: 'By the roll-up door', description: 'Pallet jack left in the walkway by the roll-up door, hard to see in the morning.' });
  });
  on(local('2026-10-13', '10:00:00'), async () => {
    const tp = await asStaff('E-103');
    const jack = (await service.call(tp, 'safety.queue', { status: 'new' })).find(r => r.area === 'Shipping / dock');
    await service.call(tp, 'safety.acknowledge', { reportId: jack.id, note: 'Moved the jack. Will mark a parking spot.' });
    const ca = await service.call(tp, 'ca.create', { sourceType: 'safety_report', sourceId: jack.id, category: 'safety', title: 'Paint a parking box for the pallet jack', description: 'Yellow floor paint by the dock door.', priority: 'normal', assignedTo: 'E-107', dueDate: '2026-10-15' });
    await service.call(await asEmp('E-107'), 'ca.start', { id: ca.id });
  });

  // Kim's confidential near miss: still new and past its response target.
  on(local('2026-10-14', '14:40:00'), async () => {
    await service.call(await asEmp('E-106'), 'safety.report', { type: 'near_miss', area: 'CNC', equipment: 'CNC router 2', description: 'Offcut kicked back off the router table when the vacuum hold-down dropped. Nobody hurt.', confidential: true });
  });
  on(local('2026-10-14', '15:00:00'), async () => {
    await service.call(await asStaff('E-102'), 'ca.markDone', { id: caGuardId, resolution: 'New guard installed and adjusted.', closureEvidence: 'Part #BG-14 receipt (sample)' });
  });

  // New hire: management issues a temporary PIN on Friday morning (shown in the demo sign-in picker; single use, 72 h).
  on(local('2026-10-16', '07:20:00'), async () => {
    const code = await service.call(await asStaff('E-101'), 'accounts.resetPin', { employeeId: 'E-110' });
    db.run("INSERT INTO meta (k, v) VALUES ('demo_setup_code_E-110', ?)", [code.tempPin]);
  });

  // Thursday: urgent report. Pat's texts fail (simulated), retries run, Morgan acknowledges.
  on(local('2026-10-15', '13:05:00'), async () => {
    db.run('UPDATE employees SET sim_fail_sms=4 WHERE id=?', ['E-103']);
    await service.call(await asEmp('E-105'), 'safety.report', { type: 'imminent', area: 'CNC', equipment: 'CNC router 1', description: 'Guard door interlock bypassed with tape on router 1, machine running.', immediateAction: 'Told the operator to stop. Machine is still on.' });
    for (const m of [1, 2, 5]) { clock.set(new Date(clock.now().getTime() + m * 60000 + 1000)); await service.tick(); }
  });
  on(local('2026-10-15', '13:16:00'), async () => {
    const tm = await asStaff('E-101');
    const urgent = (await service.call(tm, 'safety.queue', { status: 'new' })).find(r => r.type === 'imminent');
    await service.call(tm, 'safety.acknowledge', { reportId: urgent.id, note: 'On the floor now. Machine locked out, tape removed.' });
    await service.call(tm, 'safety.assign', { reportId: urgent.id, ownerId: 'E-101' });
    await service.call(tm, 'ca.create', { sourceType: 'safety_report', sourceId: urgent.id, category: 'safety', title: 'Retrain CNC operators on interlocks; inspect all guard switches', priority: 'urgent', assignedTo: 'E-103', dueDate: '2026-10-20' });
    await service.call(tm, 'demo.setSimFail', { employeeId: 'E-103', count: 0 });
  });

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const ev of events) {
    if (clock.now().toISOString() < ev.at) at(ev.at);
    await ev.fn();
  }

  db.run("UPDATE sessions SET revoked_at=?, revoke_reason='seed_end' WHERE revoked_at IS NULL", [clock.now().toISOString()]);
  return { deviceToken: kiosk };
}

/** Demo helper: who can sign in and how (never available outside demo mode). */
export async function demoPeople(db, crypto, now) {
  const out = [];
  for (const [eid, name, , , , , , , dept, pin] of PEOPLE) {
    const e = db.get('SELECT totp_secret, roles, status, pin_hash FROM employees WHERE id=?', [eid]);
    if (!e) continue;
    const roles = JSON.parse(e.roles), status = e.status;
    const code = db.get('SELECT v FROM meta WHERE k=?', ['demo_setup_code_' + eid]);
    out.push({ id: eid, name, status, roles, department: dept, pin, setupCode: !pin && code ? code.v : null, tempPin: !pin && code ? code.v : null, visibleRole: describeRoles(roles).role,
      totp: e && e.totp_secret ? await totpAt(crypto, await crypto.openSecret(e.totp_secret), Math.floor(now.getTime() / 1000)) : null });
  }
  return out;
}
