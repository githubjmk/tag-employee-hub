// R1.3 Onboarding checklist (from the company's New Hire Checklist).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
const RP = { rp: { rpId: 'hub.example.test', origin: 'https://hub.example.test' } };
let hub, svc, db;
const T = {};
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid) { later(0.55); T[eid] = (await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) })).token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input, RP);
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  at('2026-10-16T17:30:00Z');
  for (const e of ['E-101', 'E-102', 'E-103', 'E-106']) await signIn(e);
});

test('OB-01 a new account starts a checklist; existing staff have none; the new hire sees only their own and automatic items', async () => {
  const r = await call('E-101', 'accounts.create', { name: 'Nia Newcomer', language: 'en', role: 'staff', reportsTo: 'E-102', email: 'nia@example.com', startDate: '2026-10-19' });
  T.nia = r.account.id;
  assert.ok(db.get('SELECT 1 FROM onboarding WHERE employee_id=?', [T.nia]));
  assert.equal((await call('E-106', 'onboard.get')).active, false, 'Kim (existing) has no checklist');
  const full = await call('E-101', 'onboard.get', { employeeId: T.nia });
  assert.equal(full.items.length, 17); assert.equal(full.done, 0);
  // Nia accepts her invite and looks at her own checklist
  const inv = await call('E-101', 'invite.create', { employeeId: T.nia });
  const a = await svc.inviteAccept({ token: inv.link.split('/#/join/')[1], newPin: '480157', confirmPin: '480157' });
  T.nia_t = a.token;
  const mine = await svc.call(a.token, 'onboard.get', {}, RP);
  assert.ok(mine.items.every(i => ['employee', 'auto'].includes(i.who)), 'only her own and automatic items');
  assert.equal(mine.items.find(i => i.key === 'a_account').done, true, 'account + PIN ticked by the Hub');
  assert.ok(mine.othersLeft > 0, 'she sees how many items the office and supervisor still have');
  assert.ok((await svc.call(a.token, 'home', {}, RP)).onboarding.me, 'Home shows "Your first week"');
  const home = await call('E-102', 'home');
  assert.ok(home.onboarding.team.some(p => p.id === T.nia && p.open >= 4), 'her supervisor gets a to-do');
});

test('OB-02 who ticks what: office items full access only, supervisor items her manager, her own items herself; automatic items nobody', async () => {
  await rejects(call('E-102', 'onboard.mark', { employeeId: T.nia, task: 'o_i9', status: 'done' }), 403);
  await rejects(svc.call(T.nia_t, 'onboard.mark', { employeeId: T.nia, task: 's_safety', status: 'done' }, RP), 403);
  await rejects(call('E-103', 'onboard.mark', { employeeId: T.nia, task: 's_safety', status: 'done' }), 404, undefined);   // not her manager
  await rejects(call('E-106', 'onboard.get', { employeeId: T.nia }), 404);
  await rejects(call('E-101', 'onboard.mark', { employeeId: T.nia, task: 'a_docs', status: 'done' }), 400, 'task');
  await rejects(call('E-101', 'onboard.mark', { employeeId: T.nia, task: 'o_i9', status: 'na' }), 400, 'na');
  const r = await call('E-102', 'onboard.mark', { employeeId: T.nia, task: 's_safety', status: 'done' });
  const it = r.items.find(i => i.key === 's_safety');
  assert.equal(it.done, true); assert.equal(it.doneBy, 'Dana Lead');
  await svc.call(T.nia_t, 'onboard.mark', { employeeId: T.nia, task: 'e_payroll', status: 'done' }, RP);
  assert.equal((await call('E-101', 'onboard.mark', { employeeId: T.nia, task: 'o_eeoc', status: 'na' })).items.find(i => i.key === 'o_eeoc').status, 'na');
  const undo = await call('E-102', 'onboard.mark', { employeeId: T.nia, task: 's_safety', status: 'undo' });
  assert.equal(undo.items.find(i => i.key === 's_safety').done, false);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='onboarding.item' AND entity_id=?", [T.nia]));
});

test('OB-03 the checklist completes by itself when every required item is done; full access can close or reopen it; nothing sensitive is stored', async () => {
  for (const k of ['o_offer', 'o_i9', 'o_tax', 'o_deposit', 'o_emergency', 'o_payroll']) await call('E-101', 'onboard.mark', { employeeId: T.nia, task: k, status: 'done' });
  for (const k of ['s_firstday', 's_ppe', 's_locker', 's_safety']) await call('E-102', 'onboard.mark', { employeeId: T.nia, task: k, status: 'done' });
  await svc.call(T.nia_t, 'onboard.mark', { employeeId: T.nia, task: 'e_i9docs', status: 'done' }, RP);
  let c = await call('E-101', 'onboard.get', { employeeId: T.nia });
  assert.equal(c.active, true, 'still open: documents and first report are not done');
  // she signs the sample handbook
  const hb = (await svc.call(T.nia_t, 'docs.list', {}, RP)).docs[0];
  const v = await svc.call(T.nia_t, 'docs.get', { documentId: hb.id }, RP);
  later(1);
  await svc.call(T.nia_t, 'docs.ack', { versionId: v.versionId, contentSha256: v.contentSha256, language: 'en', affirm: true, signPin: '480157' }, RP);
  c = await call('E-101', 'onboard.get', { employeeId: T.nia });
  assert.equal(c.items.find(i => i.key === 'a_docs').done, true);
  assert.equal(c.done, c.total - 1, 'only the first weekly report is left');
  await call('E-101', 'onboard.finish', { employeeId: T.nia });
  assert.ok((await call('E-101', 'onboard.get', { employeeId: T.nia })).completedAt);
  await rejects(call('E-102', 'onboard.finish', { employeeId: T.nia }), 403);
  await call('E-101', 'onboard.finish', { employeeId: T.nia, reopen: true });
  assert.equal((await call('E-101', 'onboard.get', { employeeId: T.nia })).active, true);
  // when the last item is automatic (her first weekly report), the checklist completes on its own
  db.run("INSERT INTO survey_assignments (id, employee_id, week_id, template_id, expected, workdays, status, excuse_reason, created_at) VALUES ('SA-PROBE', ?, '2026-10-19', 'WR-1.0', 1, 5, 'submitted', NULL, '2026-10-16')", [T.nia]);
  db.run("INSERT INTO survey_submissions (id, assignment_id, employee_id, idempotency_key, payload_json, payload_hash, signed_at, late, has_safety, has_obstacle) VALUES ('SUB-PROBE', 'SA-PROBE', ?, 'probe', '{}', 'x', '2026-10-23T18:00:00Z', 0, 0, 0)", [T.nia]);
  const auto = await call('E-101', 'onboard.get', { employeeId: T.nia });
  assert.equal(auto.active, false); assert.ok(auto.completedAt);
  const cols = db.all("PRAGMA table_info(onboarding_items)").map(c => c.name);
  assert.deepEqual(cols.sort(), ['done_at', 'done_by', 'employee_id', 'status', 'task_key'], 'only ticks are stored');
  // an existing person can get a checklist started by their manager
  await call('E-102', 'onboard.start', { employeeId: 'E-106' });
  assert.equal((await call('E-106', 'onboard.get')).active, true);
  const list = await call('E-102', 'onboard.list');
  assert.ok(list.people.some(p => p.employee.id === 'E-106') && list.people.some(p => p.employee.id === T.nia));
  await rejects(call('E-106', 'onboard.list'), 403);
});
