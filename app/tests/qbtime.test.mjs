// R1.3 QuickBooks Time "My hours" (read-only). Client checked against a fake QuickBooks Time API;
// the Hub logic against the demo sample data and a real-format fake.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { makeQbTime, QBT_BASE } from '../core/qbtime.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
let hub, svc, db;
const T = {};
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid) { later(0.55); T[eid] = (await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) })).token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input);
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }

test('QB-01 the client only reads: GET with the token, follows pages, maps fields; refused tokens give a clear message', async () => {
  const seen = [];
  const pages = { '/users': [{ results: { users: { 1: { id: 1, first_name: 'Ana', last_name: 'Lopez' } } }, more: true }, { results: { users: { 2: { id: 2, first_name: 'Bo', last_name: '' } } }, more: false }],
    '/timesheets': [{ results: { timesheets: { 7: { id: 7, user_id: 1, date: '2026-10-12', start: '2026-10-12T07:00:00-07:00', end: '', duration: 3600, on_the_clock: true, type: 'regular' } } }, more: false }] };
  const fetch = async (url, init) => { seen.push({ url, init }); const u = new URL(url); const page = Number(u.searchParams.get('page')); return { status: 200, json: async () => pages[u.pathname.replace('/api/v1', '')][page - 1] }; };
  const q = makeQbTime({ fetch, token: 'tok-123' });
  assert.deepEqual(await q.users(), [{ id: '1', name: 'Ana Lopez' }, { id: '2', name: 'Bo' }]);
  const ts = await q.timesheets({ startDate: '2026-10-12', endDate: '2026-10-18', userIds: ['1'] });
  assert.deepEqual(ts[0], { id: '7', userId: '1', date: '2026-10-12', start: '2026-10-12T07:00:00-07:00', end: null, seconds: 3600, onClock: true, type: 'regular' });
  assert.ok(seen.every(s => s.init.method === 'GET' && s.init.headers.Authorization === 'Bearer tok-123' && s.url.startsWith(QBT_BASE)), 'GET only, to QuickBooks Time only');
  const tsUrl = new URL(seen.at(-1).url);
  assert.equal(tsUrl.searchParams.get('start_date'), '2026-10-12'); assert.equal(tsUrl.searchParams.get('end_date'), '2026-10-18'); assert.equal(tsUrl.searchParams.get('user_ids'), '1');
  const bad = makeQbTime({ fetch: async () => ({ status: 401, json: async () => ({}) }), token: 'x' });
  await assert.rejects(bad.users(), (e) => e.code === 'qbt_auth' && /token/.test(e.message));
  assert.equal(makeQbTime({ fetch, token: '' }), null, 'no token, no connection');
});

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  at('2026-10-16T17:30:00Z');   // Friday 10:30 PT
});

test('QB-02 linking is done by full access only, never automatically; one QuickBooks Time person per account', async () => {
  await signIn('E-104');
  assert.deepEqual(await call('E-104', 'hours.mine'), { available: false }, 'card is off by default');
  await signIn('E-101');
  await call('E-101', 'admin.qbtShowHours', { show: true });
  assert.deepEqual(await call('E-104', 'hours.mine'), { available: true, linked: false });
  await rejects(call('E-104', 'admin.qbtUsers'), 403);
  await rejects(call('E-104', 'admin.qbtShowHours', { show: false }), 403);
  await signIn('E-102');
  await rejects(call('E-102', 'admin.qbtLink', { employeeId: 'E-104', qbtUserId: '9004' }), 403);
  await signIn('E-101');
  const st = await call('E-101', 'admin.qbtStatus');
  assert.equal(st.configured, true); assert.equal(st.demo, true); assert.equal(st.links, 0);
  const list = await call('E-101', 'admin.qbtUsers');
  const maria = list.accounts.find(a => a.id === 'E-104');
  assert.equal(maria.linkedTo, null);
  assert.equal(maria.suggestion.name, 'Maria Sample', 'matching name is only a suggestion');
  assert.equal(db.get('SELECT COUNT(*) n FROM qbt_links').n, 0);
  await call('E-101', 'admin.qbtLink', { employeeId: 'E-104', qbtUserId: maria.suggestion.id });
  await rejects(call('E-101', 'admin.qbtLink', { employeeId: 'E-105', qbtUserId: maria.suggestion.id }), 409, 'qbt_taken');
  await rejects(call('E-101', 'admin.qbtLink', { employeeId: 'E-105', qbtUserId: 'nope' }), 400, 'qbt_user');
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='qbt.linked' AND entity_id='E-104'"));
});

test('QB-03 My hours: own hours only, this week and last week, per day, and whether the person is on the clock now', async () => {
  at('2026-10-16T17:30:00Z');
  const r = await call('E-104', 'hours.mine');
  assert.equal(r.linked, true); assert.equal(r.demo, true);
  assert.equal(r.thisWeek.weekStart, '2026-10-12');
  assert.equal(r.lastWeek.totalHours, 40);                 // sample: 8 h a day, Mon–Fri
  assert.deepEqual(r.thisWeek.days.slice(0, 4).map(d => d.hours), [8, 8, 8, 8]);
  assert.equal(r.thisWeek.days[4].hours, 3.5);             // Friday 7:00 → 10:30
  assert.equal(r.thisWeek.totalHours, 35.5);
  assert.ok(r.thisWeek.onClockSince);
  await signIn('E-105');
  assert.equal((await call('E-105', 'hours.mine')).linked, false, 'nobody sees someone else\'s hours');
  // Hide the card again: linked people see nothing
  await call('E-101', 'admin.qbtShowHours', { show: false });
  assert.deepEqual(await call('E-104', 'hours.mine'), { available: false });
  // Unlink
  await call('E-101', 'admin.qbtShowHours', { show: true });
  await call('E-101', 'admin.qbtLink', { employeeId: 'E-104', qbtUserId: null });
  assert.equal((await call('E-104', 'hours.mine')).linked, false);
});

test('QB-04 the live Hub without a token shows nothing; a refused token shows a clear message to management only', async () => {
  const live = await createHub({ platform: { qbtime: null } });   // like the live Hub before QBT_TOKEN is set
  const s = live.service;
  const tok = (await s.login({ employeeId: 'E-104', pin: PIN['E-104'] })).token;
  assert.deepEqual(await s.call(tok, 'hours.mine', {}), { available: false });
  const broken = await createHub({ platform: { qbtime: makeQbTime({ fetch: async () => ({ status: 401, json: async () => ({}) }), token: 'old' }) } });
  broken.db.run("INSERT INTO meta (k, v) VALUES ('qbt_show_hours', '1')");
  broken.db.run("INSERT INTO qbt_links (employee_id, qbt_user_id, qbt_name, linked_by, linked_at) VALUES ('E-104','1','Maria','E-101','2026-10-16')");
  const t2 = (await broken.service.login({ employeeId: 'E-104', pin: PIN['E-104'] })).token;
  await assert.rejects(broken.service.call(t2, 'hours.mine', {}), (e) => e.status === 502 && e.code === 'qbt_auth');
});
