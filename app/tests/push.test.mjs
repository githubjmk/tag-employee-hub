// R1.3 phone reminders (web push) and the "My week" data. Real service, real VAPID signatures;
// the push service is a fake fetch that records what the Hub would send.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { pushEndpointOk } from '../core/webpush.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
let hub, svc, db, kiosk;
const T = {}, sent = [];
let reply = 201;
const fakeFetch = async (url, init) => { sent.push({ url, init }); return { status: reply }; };
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid, opts = {}) { later(0.55); const r = await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid), ...opts }); T[eid] = r.token; return r.token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input);
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }
const EP = (n) => `https://fcm.googleapis.com/fcm/send/test-${n}-` + 'x'.repeat(40);
const b64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

before(async () => {
  hub = await createHub({ platform: { fetch: fakeFetch } });
  ({ service: svc, db } = hub);
  kiosk = db.get("SELECT v FROM meta WHERE k='demo_device_token'").v;
  at('2026-10-16T17:30:00Z');   // Friday 10:30 PT: report open, work hours
});

test('PU-01 the Hub makes its own reminder keys; only the public key leaves it; reminders start switched off', async () => {
  const p = svc.pushPublic();
  assert.equal(b64u(p.publicKey).length, 65);
  assert.equal(p.enabled, false);
  assert.match(db.get("SELECT v FROM meta WHERE k='vapid_private'").v, /^enc1:/, 'private key encrypted at rest');
  assert.equal(await svc.ensurePushKeys(), false, 'created once');
});

test('PU-02 turning reminders on: only real push services, only on your own device, one entry per phone', async () => {
  assert.ok(pushEndpointOk('https://web.push.apple.com/QGx'));
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'not a url'])
    assert.equal(pushEndpointOk(bad), false, bad);
  await signIn('E-104');
  await rejects(call('E-104', 'push.subscribe', { endpoint: 'https://evil.example/x' }), 400, 'push_endpoint');
  const st = await call('E-104', 'push.subscribe', { endpoint: EP(1), device: 'iPhone' });
  assert.equal(st.phones.length, 1);
  await call('E-104', 'push.subscribe', { endpoint: EP(1), device: 'iPhone' });
  assert.equal((await call('E-104', 'push.status')).phones.length, 1);
  await signIn('E-106', { deviceToken: kiosk });
  await rejects(call('E-106', 'push.subscribe', { endpoint: EP(2) }), 403);
  await signIn('E-106', { sharedDevice: true });
  await rejects(call('E-106', 'push.subscribe', { endpoint: EP(2) }), 403);
  await signIn('E-105');
  await call('E-105', 'push.subscribe', { endpoint: EP(5), device: 'Android phone' });
  await signIn('E-106');
  await call('E-106', 'push.subscribe', { endpoint: EP(6), device: 'iPhone' });   // E-106 already signed this week
});

test('PU-03 switched off: nothing is queued or sent; only full access can switch it on', async () => {
  const r = await svc.pushTick();
  assert.equal(r.queued, 0); assert.equal(sent.length, 0);
  await rejects(call('E-104', 'admin.pushSettings', { enabled: true }), 403);
  await signIn('E-102');
  await rejects(call('E-102', 'admin.pushSettings', { enabled: true }), 403);
  await signIn('E-101');
  const st = await call('E-101', 'admin.pushSettings', { enabled: true });
  assert.equal(st.enabled, true); assert.equal(st.people, 3);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='push.enabled'"));
});

test('PU-04 Friday: "your report is open" once per phone, only to people who have not signed; signed VAPID request with no content', async () => {
  const r = await svc.pushTick();
  assert.equal(r.queued, 2, 'E-104 and E-105; E-106 already signed');
  assert.equal(r.sent, 2);
  assert.equal((await svc.pushTick()).queued, 0, 'never twice for the same week');
  const req = sent[0];
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['Content-Length'], '0'); assert.equal(req.init.body, undefined);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.init.headers.Authorization);
  assert.equal(m[2], svc.pushPublic().publicKey);
  const [h, p, sig] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert.equal(claims.sub, 'https://hub.innerspacecases.com');
  const key = await crypto.subtle.importKey('raw', b64u(m[2]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(sig), new TextEncoder().encode(h + '.' + p)), 'JWT signed with the Hub key');
  // The phone asks what to show: once, and nothing private.
  const shown = await svc.pushPending(EP(5));
  assert.equal(shown.title, 'Su reporte semanal está abierto');   // E-105 prefers Spanish
  assert.equal(shown.url, '/#/r');
  assert.ok(!JSON.stringify(shown).match(/Luis|E-105/));
  assert.deepEqual(await svc.pushPending(EP(5)), {});
  assert.deepEqual(await svc.pushPending('https://fcm.googleapis.com/unknown'), {});
});

test('PU-05 Monday 9:00: "due today" only if last week is still not signed; nothing outside work hours; a phone that unsubscribed is removed', async () => {
  sent.length = 0;
  at('2026-10-17T18:00:00Z');   // Saturday: outside work hours
  assert.equal((await svc.pushTick()).queued, 0);
  at('2026-10-19T15:30:00Z');   // Monday 08:30: too early
  assert.equal((await svc.pushTick()).queued, 0);
  at('2026-10-19T16:05:00Z');   // Monday 09:05
  reply = 410;                  // E-104's phone turned notifications off in the browser
  const r = await svc.pushTick();
  assert.equal(r.queued, 2);
  for (const n of [1, 5]) assert.equal(db.get('SELECT remove_reason FROM push_subscriptions WHERE endpoint=?', [EP(n)]).remove_reason, 'gone');
  reply = 201;
  assert.ok(db.get("SELECT 1 FROM push_messages WHERE kind='report_due'"));
  at('2026-10-16T17:30:00Z');
});

test('PU-06 "send me a test" goes only to the person who asked, even while reminders are off; deactivation removes their phones', async () => {
  await signIn('E-101');
  await call('E-101', 'admin.pushSettings', { enabled: false });
  sent.length = 0;
  await signIn('E-106');
  assert.equal((await call('E-106', 'push.test')).queued, 1);
  const r = await svc.pushTick();
  assert.equal(r.sent, 1); assert.equal(sent.length, 1); assert.match(sent[0].url, /test-6-/);
  assert.equal((await svc.pushPending(EP(6))).body, 'Reminders work on this phone.');
  await signIn('E-107');
  await rejects(call('E-107', 'push.test'), 400, 'push_none');
  await signIn('E-101');
  await call('E-101', 'accounts.deactivate', { employeeId: 'E-106', endDate: '2026-10-16' });
  assert.equal(db.get("SELECT remove_reason FROM push_subscriptions WHERE endpoint=?", [EP(6)]).remove_reason, 'deactivated');
});

test('PU-07 "My week": home shows each week\'s state and where the signed report is in review', async () => {
  await signIn('E-108');
  const h = await call('E-108', 'home');
  assert.equal(h.reviewer, 'Dana Lead');
  const prev = h.surveys.find(s => s.week.weekId === '2026-10-05');
  assert.equal(prev.state, 'missing');
  await signIn('E-104');
  const h4 = await call('E-104', 'home');
  const done = h4.surveys.find(s => s.submissionId);
  assert.ok(done && done.review && ['awaiting_review', 'signed_off', 'clarification_requested', 'employee_responded', 'amended_after_signoff'].includes(done.review.state), JSON.stringify(done));
});
