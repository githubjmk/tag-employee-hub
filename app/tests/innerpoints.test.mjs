// R1.3 "My InnerPoints" (read-only) from the Order Manager ledger in Quickbase.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { makeInnerPoints, IP_TABLE, IPF, QB_API } from '../core/innerpoints.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
let hub, svc, db;
const T = {};
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid) { later(0.55); T[eid] = (await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) })).token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input);
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }

const cell = (v) => ({ value: v });
const allFields = Object.values(IPF).map(id => ({ id, label: 'f' + id }));

test('IP-01 the client only queries the InnerPoints ledger, with the token and realm; leaves out reversed rows; pages', async () => {
  const seen = [];
  const pages = [
    { data: [{ 6: cell(2), 7: cell('WO_COMPLETE'), 8: cell('2026-10-20T21:00:00Z'), 14: cell(21866), 13: cell(false) }, { 6: cell(2), 7: cell('WO_COMPLETE'), 8: cell('2026-10-20T20:00:00Z'), 14: cell(21860), 13: cell(true) }], fields: allFields, metadata: { totalRecords: 3, numRecords: 2 } },
    { data: [{ 6: cell(3), 7: cell('FAST_COMPLETE'), 8: cell('2026-10-19T20:00:00Z'), 14: cell(21850), 13: cell(false) }], fields: allFields, metadata: { totalRecords: 3, numRecords: 1 } }];
  const fetch = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return { status: 200, json: async () => pages[seen.length - 1] }; };
  const ip = makeInnerPoints({ fetch, token: 'b1234_tok' });
  const rows = await ip.awards({ empId: '4', sinceYmd: '2026-09-21' });
  assert.deepEqual(rows.map(r => r.points), [2, 3], 'reversed row left out');
  assert.deepEqual(rows[0], { points: 2, code: 'WO_COMPLETE', at: '2026-10-20T21:00:00Z', wo: '21866' });
  for (const s of seen) {
    assert.equal(s.url, QB_API + '/records/query'); assert.equal(s.init.method, 'POST');
    assert.equal(s.init.headers.Authorization, 'QB-USER-TOKEN b1234_tok');
    assert.equal(s.init.headers['QB-Realm-Hostname'], 'thearmoredgroup.quickbase.com');
    assert.equal(s.body.from, IP_TABLE);
  }
  assert.equal(seen[0].body.where, "{17.EX.4}AND{8.OAF.'2026-09-21'}");
  assert.equal(seen[1].body.options.skip, 2, 'second page');
  await assert.rejects(ip.awards({ empId: '4 OR 1=1' }), (e) => e.code === 'ip_link');
  assert.equal(makeInnerPoints({ fetch, token: '' }), null, 'no token, no connection');
});

test('IP-02 a changed ledger (Quickbase silently drops unknown fields) or a refused token stops with a clear message', async () => {
  const drop = makeInnerPoints({ fetch: async () => ({ status: 200, json: async () => ({ data: [], fields: allFields.filter(f => f.id !== 6), metadata: { totalRecords: 0 } }) }), token: 't' });
  await assert.rejects(drop.awards({ empId: 4 }), (e) => e.code === 'ip_schema' && /field 6/.test(e.message));
  const refused = makeInnerPoints({ fetch: async () => ({ status: 401, json: async () => ({}) }), token: 't' });
  await assert.rejects(refused.people(), (e) => e.code === 'ip_auth');
  const people = makeInnerPoints({ fetch: async () => ({ status: 200, json: async () => ({ data: [{ 17: cell(4), 19: cell('Alejandra Pacas') }, { 17: cell(4), 19: cell('Alejandra Pacas') }, { 17: cell(8), 19: cell('Louis') }, { 17: cell(''), 19: cell('') }], fields: allFields, metadata: { totalRecords: 4 } }) }), token: 't' });
  assert.deepEqual(await people.people('2026-09-21'), [{ id: '4', name: 'Alejandra Pacas' }, { id: '8', name: 'Louis' }], 'one entry per person, blanks skipped');
});

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  at('2026-10-21T19:30:00Z');   // Wednesday 12:30 PT
});

test('IP-03 linking needs a full-access manager and a click; then the card shows this week, today, since launch and the latest', async () => {
  await signIn('E-104');
  assert.deepEqual(await call('E-104', 'points.mine'), { available: true, linked: false }, 'on by default; not linked yet');
  await rejects(call('E-104', 'admin.ipPeople'), 403);
  await rejects(call('E-104', 'admin.ipLink', { employeeId: 'E-104', ipEmpId: '104' }), 403);
  await signIn('E-102');
  await rejects(call('E-102', 'admin.ipLink', { employeeId: 'E-104', ipEmpId: '104' }), 403);
  await signIn('E-101');
  const st = await call('E-101', 'admin.ipStatus');
  assert.equal(st.configured, true); assert.equal(st.demo, true); assert.equal(st.show, true); assert.equal(st.links, 0);
  const list = await call('E-101', 'admin.ipPeople');
  const maria = list.accounts.find(a => a.id === 'E-104');
  assert.equal(maria.suggestion.name, 'Maria Sample'); assert.equal(maria.linkedTo, null);
  assert.equal(db.get('SELECT COUNT(*) n FROM ip_links').n, 0, 'nothing linked by itself');
  await call('E-101', 'admin.ipLink', { employeeId: 'E-104', ipEmpId: maria.suggestion.id });
  await rejects(call('E-101', 'admin.ipLink', { employeeId: 'E-105', ipEmpId: maria.suggestion.id }), 409, 'ip_taken');
  await rejects(call('E-101', 'admin.ipLink', { employeeId: 'E-105', ipEmpId: '999999' }), 400, 'ip_emp');
  const r = await call('E-104', 'points.mine');
  assert.equal(r.available, true); assert.equal(r.linked, true); assert.equal(r.demo, true);
  assert.ok(r.sinceLaunch >= r.thisWeek && r.thisWeek >= r.today && r.thisWeek > 0, JSON.stringify(r));
  assert.ok(r.recent.length > 0 && r.recent.length <= 5);
  assert.ok(r.recent.every(x => ['wo', 'fast', 'safety', 'other', 'design', 'sales', 'bonus'].includes(x.kind)));
  assert.equal(r.launch, '2026-09-21');
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='ip.linked' AND entity_id='E-104'"));
});

test('IP-04 a full-access manager can hide the card; a Quickbase problem shows a message, never wrong numbers; the test copy never uses a real token', async () => {
  await call('E-101', 'admin.ipShow', { show: false });
  assert.deepEqual(await call('E-104', 'points.mine'), { available: false });
  await rejects(call('E-104', 'admin.ipShow', { show: true }), 403);
  await call('E-101', 'admin.ipShow', { show: true });
  assert.equal((await call('E-104', 'points.mine')).linked, true);
  // Live-style hub with a broken ledger answer.
  const h2 = await createHub({ platform: { innerpoints: makeInnerPoints({ fetch: async () => ({ status: 200, json: async () => ({ data: [], fields: [], metadata: {} }) }), token: 't' }) } });
  const t = (await h2.service.login({ employeeId: 'E-101', pin: PIN['E-101'], totp: await totpAt(h2.crypto, await h2.crypto.openSecret(h2.db.get("SELECT totp_secret FROM employees WHERE id='E-101'").totp_secret), Math.floor(h2.clock.now().getTime() / 1000)) })).token;
  const st = await h2.service.call(t, 'admin.ipStatus', {});
  assert.equal(st.ok, false); assert.match(st.error, /changed/);
  h2.db.run("INSERT INTO ip_links (employee_id, ip_emp_id, ip_name, linked_by, linked_at) VALUES ('E-101','4','Morgan','E-101','2026-10-21')");
  await rejects(h2.service.call(t, 'points.mine', {}), 502, 'ip_schema');
  const h3 = await createHub({ platform: { innerpoints: null } });
  const t3 = (await h3.service.login({ employeeId: 'E-106', pin: PIN['E-106'] })).token;
  assert.deepEqual(await h3.service.call(t3, 'points.mine', {}), { available: false }, 'not connected: no card');
});
