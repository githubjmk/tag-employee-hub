// R1.3 Time off: request, manager decides, calendar, entered for someone, and the weekly report excused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
let hub, svc, db;
const T = {};
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid) { later(0.55); T[eid] = (await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) })).token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input);
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  at('2026-10-14T17:30:00Z');   // Wednesday 10:30 PT
  for (const e of ['E-101', 'E-102', 'E-103', 'E-104', 'E-105', 'E-106', 'E-107']) await signIn(e);
});

test('TO-01 a request: checked dates, no overlaps, goes to the person\'s manager; the test copy has sample requests', async () => {
  assert.ok(db.get('SELECT COUNT(*) n FROM time_off_requests').n >= 3, 'sample requests on the test copy');
  await rejects(call('E-106', 'timeoff.request', { kind: 'vacation', startDate: '2026-11-10', endDate: '2026-11-09' }), 400, 'dates');
  await rejects(call('E-106', 'timeoff.request', { kind: 'nap', startDate: '2026-11-10', endDate: '2026-11-10' }), 400, 'kind');
  await rejects(call('E-106', 'timeoff.request', { kind: 'vacation', startDate: '2026-11-14', endDate: '2026-11-15' }), 400, 'dates');   // a weekend
  await rejects(call('E-106', 'timeoff.request', { kind: 'vacation', startDate: '2026-08-01', endDate: '2026-08-03' }), 400, 'dates');   // too long ago
  const r = await call('E-106', 'timeoff.request', { kind: 'vacation', startDate: '2026-11-09', endDate: '2026-11-13', note: 'Trip' });
  assert.equal(r.request.status, 'pending'); assert.equal(r.request.workdays, 5); assert.equal(r.request.noticeDays, 26);
  await rejects(call('E-106', 'timeoff.request', { kind: 'sick', startDate: '2026-11-12', endDate: '2026-11-12' }), 409, 'overlap');
  assert.ok(db.get("SELECT 1 FROM notifications WHERE recipient_id='E-102' AND kind='timeoff_request' AND ref=?", [r.request.id]), 'Kim\'s manager (Dana) is told');
  assert.equal((await call('E-102', 'home')).timeOff.toApprove >= 1, true);
  assert.equal((await call('E-106', 'home')).timeOff.mine[0].status, 'pending');
  T.kimReq = r.request.id;
});

test('TO-02 deciding: their manager or full access, never their own; a decline needs a note; others off are shown', async () => {
  await rejects(call('E-106', 'timeoff.decide', { requestId: T.kimReq, decision: 'approve' }), 403);
  await rejects(call('E-103', 'timeoff.decide', { requestId: T.kimReq, decision: 'approve' }), 403);   // not Kim's manager
  const other = await call('E-107', 'timeoff.request', { kind: 'other', startDate: '2026-11-11', endDate: '2026-11-11' });
  const q = await call('E-102', 'timeoff.team');
  const kim = q.pending.find(x => x.id === T.kimReq);
  assert.ok(kim.canDecide); assert.ok(kim.alsoOff.some(o => o.name === 'Jordan Demo' && o.pending), 'shows who else is off');
  await rejects(call('E-102', 'timeoff.decide', { requestId: other.request.id, decision: 'decline' }), 400, 'note');
  const d = await call('E-102', 'timeoff.decide', { requestId: other.request.id, decision: 'decline', note: 'Big order that day' });
  assert.equal(d.request.status, 'declined');
  assert.ok(db.get("SELECT 1 FROM notifications WHERE recipient_id='E-107' AND kind='timeoff_decision'"));
  await rejects(call('E-102', 'timeoff.decide', { requestId: other.request.id, decision: 'approve' }), 409, 'not_pending');
  const own = await call('E-102', 'timeoff.request', { kind: 'vacation', startDate: '2026-12-21', endDate: '2026-12-24' });
  await rejects(call('E-102', 'timeoff.decide', { requestId: own.request.id, decision: 'approve' }), 403);
  assert.ok(db.get("SELECT 1 FROM notifications WHERE recipient_id='E-101' AND ref=?", [own.request.id]), 'a manager\'s request goes to their own manager');
  assert.equal((await call('E-101', 'timeoff.decide', { requestId: own.request.id, decision: 'approve' })).request.status, 'approved');
});

test('TO-03 approved time off excuses the weekly report for those days; cancelling brings it back', async () => {
  const wk = (eid) => db.get("SELECT status, expected, excuse_reason FROM survey_assignments WHERE employee_id=? AND week_id='2026-10-12'", [eid]);
  await call('E-104', 'home');
  assert.equal(wk('E-104').status, 'open');
  const r = await call('E-104', 'timeoff.request', { kind: 'sick', startDate: '2026-10-13', endDate: '2026-10-16', note: 'Sick' });
  assert.equal(wk('E-104').status, 'open', 'not excused while waiting');
  await call('E-102', 'timeoff.decide', { requestId: r.request.id, decision: 'approve' });
  assert.equal(wk('E-104').status, 'excused'); assert.match(wk('E-104').excuse_reason, /Partial week|Not working/);
  const abs = db.get("SELECT reason FROM absences WHERE employee_id='E-104' AND start_date='2026-10-13'");
  assert.equal(abs.reason, 'other', 'no medical reason stored with the absence');
  await call('E-104', 'timeoff.cancel', { requestId: r.request.id });
  assert.equal(wk('E-104').status, 'open', 'cancelled: the report is expected again');
  assert.equal(db.get("SELECT COUNT(*) n FROM absences WHERE employee_id='E-104' AND start_date='2026-10-13'").n, 0);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='timeoff.cancelled' AND entity_id='E-104'"));
});

test('TO-04 entered for someone who asked in person (approved at once); staff cannot enter for others; calendar shows names, not reasons, to staff', async () => {
  await rejects(call('E-106', 'timeoff.request', { employeeId: 'E-105', kind: 'vacation', startDate: '2026-12-07', endDate: '2026-12-09' }), 403);
  await rejects(call('E-103', 'timeoff.request', { employeeId: 'E-105', kind: 'vacation', startDate: '2026-12-07', endDate: '2026-12-09' }), 403);
  const r = await call('E-102', 'timeoff.request', { employeeId: 'E-105', kind: 'unpaid', startDate: '2026-12-07', endDate: '2026-12-09', approveNow: true });
  assert.equal(r.request.status, 'approved'); assert.equal(r.request.requestedBy, 'Dana Lead'); assert.match(r.request.decisionNote, /in person/);
  const staffCal = await call('E-106', 'timeoff.calendar', { month: '2026-12' });
  const kimNov = await call('E-106', 'timeoff.calendar', { month: '2026-11' });
  const luis = staffCal.entries.find(e => e.employeeId === 'E-105' && e.startDate === '2026-12-07');
  assert.equal(luis.kind, null, 'staff do not see the kind of someone else\'s time off');
  assert.ok(!staffCal.entries.some(e => e.pending && !e.mine), 'staff do not see others\' waiting requests');
  assert.equal(kimNov.entries.find(e => e.mine).kind, 'vacation', 'their own shows the kind');
  const mgrCal = await call('E-102', 'timeoff.calendar', { month: '2026-12' });
  assert.equal(mgrCal.entries.find(e => e.employeeId === 'E-105' && e.startDate === '2026-12-07').kind, 'unpaid');
  await rejects(call('E-106', 'timeoff.team'), 403);
  await rejects(call('E-106', 'timeoff.cancel', { requestId: r.request.id }), 403);
});
