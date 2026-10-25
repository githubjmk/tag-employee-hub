// R1.3 passkeys (Face ID / fingerprint on a person's own phone). Real service, real HTTP handler,
// real ECDSA/RSA keys from a software authenticator (tests/softauthn.mjs). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHub, createServer } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { canonical } from '../core/canonical.js';
import { cborDecode, derToRaw, parseAuthData, WebAuthnError } from '../core/webauthn.js';
import { SoftAuthenticator, rawToDer, cbor } from './softauthn.mjs';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
const ANS = { q1: 4, q2: 5, q3: 'no', q4: 'no' };
const RP = { rpId: 'hub.example.test', origin: 'https://hub.example.test' };
let hub, svc, db, server, base, kiosk;
const T = {};

const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid, opts = {}) { later(0.55); const r = await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid), ...opts }); T[eid] = r.token; return r.token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input, { rp: RP });
async function rejects(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, `expected ${status} got ${e.status} ${e.code}: ${e.message}`); if (code) assert.equal(e.code, code); return true; });
}
const auditCount = (action) => db.get('SELECT COUNT(*) n FROM audit_events WHERE action=?', [action]).n;
const openFor = async (eid) => (await call(eid, 'home')).surveys.slice().reverse().find(x => ['open', 'missing'].includes(x.state));

// Sets up a passkey for eid on a fresh software authenticator and returns it.
async function enroll(eid, opts = {}) {
  await signIn(eid);
  const a = new SoftAuthenticator({ origin: RP.origin, ...opts });
  const o = await regOptions(eid);
  const r = await call(eid, 'passkey.register', { challengeId: o.challengeId, credential: await a.create(o.publicKey), label: 'iPhone' });
  assert.equal(r.ok, true);
  return a;
}
// Setup needs the PIN again (plus a fresh authenticator code for management).
async function regOptions(eid) { later(0.55); return call(eid, 'passkey.registerOptions', { signPin: PIN[eid], totp: await totp(eid) }); }
const weekNow = '2026-10-12';
const signContent = (extra = {}) => ({ weekId: weekNow, answers: ANS, language: 'en', esignConsent: true, ...extra });
// "Sign in with Face ID": returns the passkeyLogin result.
async function faceIdLogin(a, { purpose, action, content, getOpts = {}, expectEmployeeId, deviceToken } = {}) {
  const o = await svc.passkeyOptions({ rp: RP, purpose, action, content });
  return svc.passkeyLogin({ challengeId: o.challengeId, credential: await a.get(o.publicKey, getOpts), expectEmployeeId, deviceToken });
}

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  kiosk = db.get("SELECT v FROM meta WHERE k='demo_device_token'").v;
  server = createServer({ hub, options: {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
  at('2026-10-16T17:30:00Z');   // Fri 10:30 PT, this week's report is open
});
after(() => server.close());

test('PK-01 set up Face ID on your own phone: options ask for a phone passkey with Face ID/fingerprint; only the public key is stored; audited', async () => {
  await signIn('E-104');
  await rejects(call('E-104', 'passkey.registerOptions'), 401, 'bad_sign_pin');            // an open session alone is not enough
  await rejects(call('E-104', 'passkey.registerOptions', { signPin: '000000' }), 401, 'bad_sign_pin');
  const o = await regOptions('E-104');
  assert.equal(o.publicKey.rp.id, RP.rpId);
  assert.equal(o.publicKey.user.name, 'E-104');
  assert.equal(o.publicKey.authenticatorSelection.userVerification, 'required');
  assert.equal(o.publicKey.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(o.publicKey.attestation, 'none');
  assert.deepEqual(o.publicKey.pubKeyCredParams.map(p => p.alg), [-7, -257]);
  const a = new SoftAuthenticator({ origin: RP.origin });
  const r = await call('E-104', 'passkey.register', { challengeId: o.challengeId, credential: await a.create(o.publicKey), label: 'iPhone <script>' });
  assert.equal(r.passkey.device, 'iPhone script');
  const row = db.get("SELECT * FROM passkeys WHERE employee_id='E-104'");
  assert.equal(row.rp_id, RP.rpId);
  const jwk = JSON.parse(row.public_key_jwk);
  assert.equal(jwk.kty, 'EC'); assert.ok(!('d' in jwk), 'no private key material');
  assert.equal((await call('E-104', 'passkey.mine')).length, 1);
  assert.equal(auditCount('passkey.registered'), 1);
  assert.ok(db.get("SELECT 1 FROM notifications WHERE recipient_id='E-104' AND kind='security' AND subject LIKE 'Face ID sign-in was set up%'"), 'the person is told a phone was added');
  db.run("UPDATE employees SET failed_logins=0 WHERE id='E-104'");
  // The same challenge cannot be used twice; the phone already set up is excluded next time.
  await rejects(call('E-104', 'passkey.register', { challengeId: o.challengeId, credential: await a.create(o.publicKey) }), 401, 'passkey_expired');
  const o2 = await regOptions('E-104');
  assert.deepEqual(o2.publicKey.excludeCredentials.map(c => c.id), [row.credential_id]);
});

test('PK-02 setup is refused for a wrong web address, wrong challenge, no Face ID/fingerprint, or on a registered shop tablet', async () => {
  await signIn('E-105');
  for (const [opts, reason] of [[{ origin: 'https://evil.example' }, 'wrong_origin'], [{ rpId: 'evil.example' }, 'wrong_rp'], [{ challenge: 'AAAA' }, 'wrong_challenge'], [{ type: 'webauthn.get' }, 'wrong_type']]) {
    const o = await regOptions('E-105');
    const a = new SoftAuthenticator({ origin: RP.origin });
    await assert.rejects(call('E-105', 'passkey.register', { challengeId: o.challengeId, credential: await a.create(o.publicKey, opts) }), (e) => e.code === 'passkey_failed' && e.message.includes(reason));
  }
  const o = await regOptions('E-105');
  await assert.rejects(call('E-105', 'passkey.register', { challengeId: o.challengeId, credential: await new SoftAuthenticator({ origin: RP.origin, uv: false }).create(o.publicKey) }), (e) => e.message.includes('user_not_verified'));
  assert.equal(db.get("SELECT COUNT(*) n FROM passkeys WHERE employee_id='E-105'").n, 0);
  // Shop tablet session (registered device cookie): no passkeys there.
  await signIn('E-106', { deviceToken: kiosk });
  await rejects(call('E-106', 'passkey.registerOptions'), 403);
  await rejects(call('E-106', 'passkey.register', { challengeId: 'WAC-00000', credential: {} }), 403);
  // "Shared device" chosen at sign-in: no passkeys either (a shared computer's Windows Hello is shared too).
  await signIn('E-106', { sharedDevice: true });
  await rejects(call('E-106', 'passkey.registerOptions', { signPin: PIN['E-106'] }), 403);
});

test('PK-03 sign in with Face ID: personal session without the PIN; single use; wrong address, tampered data, slow approval and unknown phones are refused', async () => {
  const a = await enroll('E-106');
  const r = await faceIdLogin(a);
  assert.equal(r.employee.id, 'E-106'); assert.equal(r.sharedDevice, false); assert.equal(r.signTicket, null);
  const me = await svc.call(r.token, 'session.me', {});
  assert.equal(me.employee.id, 'E-106'); assert.equal(me.sharedDevice, false); assert.equal(me.idleMinutes, 60);
  assert.ok(db.get("SELECT last_used_at FROM passkeys WHERE employee_id='E-106'").last_used_at);
  assert.equal(auditCount('login.passkey'), 1);
  // Replay of the same approval
  const o = await svc.passkeyOptions({ rp: RP });
  const cred = await a.get(o.publicKey);
  await svc.passkeyLogin({ challengeId: o.challengeId, credential: cred });
  await rejects(svc.passkeyLogin({ challengeId: o.challengeId, credential: cred }), 401, 'passkey_expired');
  // Wrong origin, wrong relying party, tampered signed data, wrong challenge
  await rejects(faceIdLogin(a, { getOpts: { origin: 'https://hub.example.test.evil.example' } }), 401, 'passkey_failed');
  await rejects(faceIdLogin(a, { getOpts: { rpId: 'example.test' } }), 401, 'passkey_failed');
  await rejects(faceIdLogin(a, { getOpts: { tamper: true } }), 401, 'passkey_failed');
  await rejects(faceIdLogin(a, { getOpts: { challenge: 'xyz' } }), 401, 'passkey_failed');
  // A failed approval uses up the challenge too
  const o2 = await svc.passkeyOptions({ rp: RP });
  await rejects(svc.passkeyLogin({ challengeId: o2.challengeId, credential: await a.get(o2.publicKey, { tamper: true }) }), 401, 'passkey_failed');
  await rejects(svc.passkeyLogin({ challengeId: o2.challengeId, credential: await a.get(o2.publicKey) }), 401, 'passkey_expired');
  // Approval after 5 minutes
  const o3 = await svc.passkeyOptions({ rp: RP });
  later(6);
  await rejects(svc.passkeyLogin({ challengeId: o3.challengeId, credential: await a.get(o3.publicKey) }), 401, 'passkey_expired');
  // A phone the Hub does not know
  const stranger = new SoftAuthenticator({ origin: RP.origin });
  await stranger.create({ rp: { id: RP.rpId }, user: { id: 'x' }, challenge: 'x' });
  await rejects(faceIdLogin(stranger), 401, 'passkey_unknown');
  // Failures never count toward the PIN lockout
  assert.equal(db.get("SELECT failed_logins FROM employees WHERE id='E-106'").failed_logins, 0);
  assert.ok(auditCount('login.passkey_failed') >= 6);
  // Shop tablet: refused even with a valid passkey
  await rejects(faceIdLogin(a, { deviceToken: kiosk }), 403, 'passkey_shop_tablet');
  // "Not you": the passkey belongs to someone else
  await rejects(faceIdLogin(a, { expectEmployeeId: 'E-104' }), 409, 'passkey_other_person');
});

test('PK-04 sign the weekly report with Face ID: no PIN, approval bound to the exact answers, single use, own report only; record says how it was signed', async () => {
  const a = await enroll('E-107');
  const open = await openFor('E-107');
  assert.equal(open.week.weekId, weekNow);
  const content = signContent();
  const r = await faceIdLogin(a, { purpose: 'sign', action: 'survey.submit', content });
  assert.ok(r.signTicket);
  T['E-107'] = r.token;
  const { weekId, ...fields } = content;
  // Different answers than the ones approved: nothing is signed.
  await rejects(call('E-107', 'survey.submit', { assignmentId: open.assignmentId, ...fields, answers: { ...ANS, q1: 1 }, affirm: true, signTicket: r.signTicket, idempotencyKey: 'pk-a' }), 401, 'bad_sign_ticket');
  // Missing acknowledgment
  await rejects(call('E-107', 'survey.submit', { assignmentId: open.assignmentId, ...fields, signTicket: r.signTicket, idempotencyKey: 'pk-b' }), 400, 'no_affirm');
  assert.equal(db.get("SELECT COUNT(*) n FROM survey_submissions WHERE employee_id='E-107' AND assignment_id=?", [open.assignmentId]).n, 0);
  const res = await call('E-107', 'survey.submit', { assignmentId: open.assignmentId, ...fields, affirm: true, signTicket: r.signTicket, idempotencyKey: 'pk-c' });
  const rec = await call('E-107', 'survey.record', { submissionId: res.submissionId });
  const sig = rec.original.payload.signature;
  assert.match(sig.method, /passkey/);
  assert.match(sig.affirmativeAction, /Face ID/);
  assert.match(sig.statementShown, /approving with Face ID, fingerprint or my phone's passcode/);
  assert.equal(sig.identity.passkey.device, 'iPhone');
  assert.equal(sig.identity.passkey.boundContentSha256, hub.crypto.sha256(canonical({ action: 'survey.submit', ...content })));

  assert.equal(rec.original.integrity, 'verified');
  // The ticket is single use (a correction needs its own approval)
  await rejects(call('E-107', 'survey.amend', { submissionId: res.submissionId, note: 'fix', affirm: true, signTicket: r.signTicket }), 401, 'bad_sign_ticket');
  // A correction with its own Face ID approval
  const amendContent = { submissionId: res.submissionId, note: 'Rating should be 3', corrections: { q1: 3 }, language: 'en' };
  const r2 = await faceIdLogin(a, { purpose: 'sign', action: 'survey.amend', content: amendContent });
  T['E-107'] = r2.token;
  const am = await call('E-107', 'survey.amend', { ...amendContent, affirm: true, signTicket: r2.signTicket });
  assert.ok(am.amendmentId || am.id || am.hash);
  // The PIN still works as before for everyone (fallback)
  await signIn('E-108');
  const o8 = await openFor('E-108');
  const s8 = await call('E-108', 'survey.submit', { assignmentId: o8.assignmentId, ...fields, affirm: true, signPin: PIN['E-108'], idempotencyKey: 'pk-d' });
  const p8 = (await call('E-108', 'survey.record', { submissionId: s8.submissionId })).original.payload.signature;
  assert.match(p8.statementShown, /entering my PIN/); assert.ok(!p8.identity.passkey);
});

test('PK-05 a signing approval cannot be used by someone else, for another action, or after 5 minutes', async () => {
  const a4 = new SoftAuthenticator({ origin: RP.origin });
  await signIn('E-104');
  const o = await regOptions('E-104');
  await call('E-104', 'passkey.register', { challengeId: o.challengeId, credential: await a4.create(o.publicKey), label: 'Android phone' });
  const content = signContent();
  const { weekId, ...fields } = content;
  const r = await faceIdLogin(a4, { purpose: 'sign', action: 'survey.submit', content });
  // E-105 signed in with a PIN tries to use E-104's approval
  await signIn('E-105');
  const o5 = await openFor('E-105');
  await rejects(call('E-105', 'survey.submit', { assignmentId: o5.assignmentId, ...fields, affirm: true, signTicket: r.signTicket, idempotencyKey: 'pk-e' }), 401, 'bad_sign_ticket');
  // A plain sign-in approval is not a signing approval
  const plain = await faceIdLogin(a4);
  T['E-104'] = plain.token;
  const o4 = await openFor('E-104');
  const forged = db.get("SELECT id FROM webauthn_challenges WHERE purpose='login' AND verified_employee='E-104' ORDER BY created_at DESC LIMIT 1").id;
  await rejects(call('E-104', 'survey.submit', { assignmentId: o4.assignmentId, ...fields, affirm: true, signTicket: forged, idempotencyKey: 'pk-f' }), 401, 'bad_sign_ticket');
  // Too late
  const r2 = await faceIdLogin(a4, { purpose: 'sign', action: 'survey.submit', content });
  T['E-104'] = r2.token;
  later(5.5);
  await rejects(call('E-104', 'survey.submit', { assignmentId: o4.assignmentId, ...fields, affirm: true, signTicket: r2.signTicket, idempotencyKey: 'pk-g' }), 401, 'bad_sign_ticket');
  assert.ok(auditCount('sign.passkey_refused') >= 3);
  // Supervisor sign-off stays PIN only: no signing approval can be asked for it, and a ticket is ignored there.
  await rejects(svc.passkeyOptions({ rp: RP, purpose: 'sign', action: 'review.signoff', content: {} }), 400);
  await signIn('E-102');
  const sub = db.get("SELECT id FROM survey_submissions WHERE employee_id='E-107' ORDER BY signed_at DESC LIMIT 1").id;
  await rejects(call('E-102', 'review.signoff', { submissionId: sub, closure: 'no_action', affirm: true, signTicket: r2.signTicket }), 401, 'bad_sign_pin');
});

test('PK-06 management: Face ID sign-in counts as the second step (no authenticator code)', async () => {
  const a = await enroll('E-101');
  const r = await faceIdLogin(a);
  const me = await svc.call(r.token, 'session.me', {});
  assert.equal(me.role, 'management'); assert.equal(me.idleMinutes, 30);
  assert.ok((await svc.call(r.token, 'accounts.list', {})).length > 5);
});

test('PK-07 lost phone: the person removes a phone; management removes all of a person\'s phones and ends their sessions; staff cannot remove others', async () => {
  const a = await enroll('E-108');
  const r = await faceIdLogin(a);
  const mine = await call('E-108', 'passkey.mine');
  assert.equal(mine.length, 1);
  // Staff cannot see or remove someone else's phones
  await rejects(call('E-108', 'accounts.removePasskeys', { employeeId: 'E-104' }), 403);
  await rejects(call('E-108', 'passkey.remove', { passkeyId: (await svc.call(T['E-104'], 'passkey.mine', {}, { rp: RP }))[0].id }), 404);
  // Management sees the count and removes them
  await signIn('E-101');
  assert.equal((await call('E-101', 'accounts.list')).find(x => x.id === 'E-108').passkeys, 1);
  assert.equal((await call('E-101', 'accounts.passkeys', { employeeId: 'E-108' })).passkeys[0].device, 'iPhone');
  const out = await call('E-101', 'accounts.removePasskeys', { employeeId: 'E-108' });
  assert.equal(out.removed, 1);
  await rejects(svc.call(r.token, 'session.me', {}), 401);
  await rejects(faceIdLogin(a), 401, 'passkey_unknown');
  // The PIN still works
  await signIn('E-108');
  // The person's own manager (E-102) can remove a staff member's phones; not a management account's
  const b = await enroll('E-105');
  await signIn('E-102');
  assert.equal((await call('E-102', 'accounts.removePasskeys', { employeeId: 'E-105' })).removed, 1);
  await rejects(call('E-102', 'accounts.removePasskeys', { employeeId: 'E-101' }), 403);
  await rejects(faceIdLogin(b), 401, 'passkey_unknown');
  // Own removal
  const c = await enroll('E-106');
  const list = await call('E-106', 'passkey.mine');
  for (const p of list) await call('E-106', 'passkey.remove', { passkeyId: p.id });
  assert.equal((await call('E-106', 'passkey.mine')).length, 0);
  await rejects(faceIdLogin(c), 401, 'passkey_unknown');
  assert.ok(auditCount('passkey.removed') >= 3);
});

test('PK-08 a deactivated person\'s phone stops working; a hard-locked account stays locked', async () => {
  const a = await enroll('E-109');
  await signIn('E-101');
  await call('E-101', 'accounts.deactivate', { employeeId: 'E-109', endDate: '2026-10-16' });
  await rejects(faceIdLogin(a), 401, 'passkey_unknown');           // deactivation removes the person's phones
  assert.equal(db.get("SELECT remove_reason FROM passkeys WHERE employee_id='E-109'").remove_reason, 'deactivated');
  const b = await enroll('E-104');
  db.run("UPDATE employees SET hard_locked=1 WHERE id='E-104'");
  await rejects(faceIdLogin(b), 423, 'hard_locked');
  db.run("UPDATE employees SET hard_locked=0 WHERE id='E-104'");
});

test('PK-09 phones that count signatures: an old counter (a copied key) is refused; RSA (older Windows Hello) keys work', async () => {
  const a = await enroll('E-102', { counter: true, synced: false });
  await faceIdLogin(a);
  await faceIdLogin(a);
  await rejects(faceIdLogin(a, { getOpts: { countOverride: 1 } }), 401, 'passkey_failed');
  assert.equal(db.get("SELECT reason FROM (SELECT json_extract(detail_json,'$.reason') reason FROM audit_events WHERE action='login.passkey_failed' ORDER BY seq DESC LIMIT 1)").reason, 'counter_went_back');
  const rsa = await enroll('E-103', { alg: -257 });
  assert.equal(db.get("SELECT alg FROM passkeys WHERE employee_id='E-103' AND removed_at IS NULL").alg, -257);
  assert.equal((await faceIdLogin(rsa)).employee.id, 'E-103');
});

test('PK-10 over HTTP: Face ID sign-in sets the same HttpOnly session cookie; the web address comes from the request; CSRF header still required', async () => {
  const H = { 'X-Hub-Request': '1', 'Content-Type': 'application/json' };
  const login = await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ employeeId: 'E-104', pin: PIN['E-104'], sharedDevice: false }) });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const o = await (await fetch(base + '/api/call/passkey.registerOptions', { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify({ signPin: PIN['E-104'] }) })).json();
  assert.equal(o.publicKey.rp.id, 'localhost');
  const a = new SoftAuthenticator({ origin: base });
  const reg = await fetch(base + '/api/call/passkey.register', { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify({ challengeId: o.challengeId, credential: await a.create(o.publicKey), label: 'Mac' }) });
  assert.equal(reg.status, 200, await reg.clone().text());
  assert.equal((await fetch(base + '/api/passkey/options', { method: 'POST', body: '{}' })).status, 403);
  const po = await (await fetch(base + '/api/passkey/options', { method: 'POST', headers: H, body: '{}' })).json();
  assert.equal(po.publicKey.rpId, 'localhost');
  const pl = await fetch(base + '/api/passkey/login', { method: 'POST', headers: H, body: JSON.stringify({ challengeId: po.challengeId, credential: await a.get(po.publicKey) }) });
  assert.equal(pl.status, 200);
  const set = pl.headers.getSetCookie()[0];
  assert.match(set, /^hub_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict/);
  const me = await (await fetch(base + '/api/call/session.me', { method: 'POST', headers: { ...H, cookie: set.split(';')[0] }, body: '{}' })).json();
  assert.equal(me.employee.id, 'E-104');
  // A passkey made for localhost does not work at another address
  const po2 = await svc.passkeyOptions({ rp: RP });
  await rejects(svc.passkeyLogin({ challengeId: po2.challengeId, credential: await a.get(po2.publicKey) }), 401, 'passkey_unknown');
  // With the shop-tablet cookie: refused
  const po3 = await (await fetch(base + '/api/passkey/options', { method: 'POST', headers: H, body: '{}' })).json();
  const pl3 = await fetch(base + '/api/passkey/login', { method: 'POST', headers: { ...H, cookie: 'hub_device=' + kiosk }, body: JSON.stringify({ challengeId: po3.challengeId, credential: await a.get(po3.publicKey) }) });
  assert.equal(pl3.status, 403);
});

test('PK-11 parser hardening: CBOR, DER and authenticator data reject malformed input', () => {
  const bad = (fn, reason) => assert.throws(fn, (e) => e instanceof WebAuthnError && (!reason || e.reason === reason));
  bad(() => cborDecode(Uint8Array.of(0x5f)), 'cbor_indefinite');
  bad(() => cborDecode(Uint8Array.of(0x58, 10, 1, 2)), 'cbor_truncated');
  bad(() => cborDecode(new Uint8Array(40).fill(0x81)), 'cbor_deep');
  assert.deepEqual([...cborDecode(cbor(new Map([[1, 2], [-1, Uint8Array.of(9)]]))).value.entries()].map(([k, v]) => [k, v instanceof Uint8Array ? [...v] : v]), [[1, 2], [-1, [9]]]);
  bad(() => derToRaw(Uint8Array.of(0x31, 0)), 'bad_signature');
  bad(() => parseAuthData(new Uint8Array(10)), 'authdata_short');
  // DER round trip with leading zero bytes
  const raw = new Uint8Array(64); raw[31] = 7; raw[32] = 0x80; raw[63] = 1;
  assert.deepEqual([...derToRaw(rawToDer(raw))], [...raw]);
});

test('PK-12 review fixes: resets remove phones; locks and unfinished resets stop Face ID; tickets are bound to the week; no ticket on shared sessions; removal ends that phone\'s sessions; malformed input is a clean refusal', async () => {
  // A ticket approved for this week's report cannot sign last week's missing report.
  const a8 = await enroll('E-108');
  const prev = (await call('E-108', 'home')).surveys.find(x => x.week.weekId === '2026-10-05');
  assert.equal(prev.state, 'missing');
  const r8 = await faceIdLogin(a8, { purpose: 'sign', action: 'survey.submit', content: signContent() });
  T['E-108'] = r8.token;
  const { weekId, ...fields } = signContent();
  await rejects(call('E-108', 'survey.submit', { assignmentId: prev.assignmentId, ...fields, affirm: true, signTicket: r8.signTicket, idempotencyKey: 'pk-w' }), 401, 'bad_sign_ticket');
  // Consent flag differs from what was approved: refused
  const r8b = await faceIdLogin(a8, { purpose: 'sign', action: 'survey.submit', content: signContent({ weekId: '2026-10-05' }) });
  T['E-108'] = r8b.token;
  await rejects(call('E-108', 'survey.submit', { assignmentId: prev.assignmentId, ...fields, esignConsent: false, affirm: true, signTicket: r8b.signTicket, idempotencyKey: 'pk-x' }), 401, 'bad_sign_ticket');
  // A new Face ID session replaces this browser's old one (no pile-up).
  const first = await faceIdLogin(a8);
  const o = await svc.passkeyOptions({ rp: RP });
  const second = await svc.passkeyLogin({ challengeId: o.challengeId, credential: await a8.get(o.publicKey), currentToken: first.token });
  await rejects(svc.call(first.token, 'session.me', {}), 401);
  assert.equal((await svc.call(second.token, 'session.me', {})).employee.id, 'E-108');
  // Owner removes the phone: the sessions it started end, the current one stays.
  await signIn('E-108');
  await call('E-108', 'passkey.remove', { passkeyId: (await call('E-108', 'passkey.mine'))[0].id });
  await rejects(svc.call(second.token, 'session.me', {}), 401);
  assert.equal((await call('E-108', 'session.me')).employee.id, 'E-108');

  // A new temporary PIN removes every phone (a stolen PIN + a phone set up with it stop working).
  const a5 = await enroll('E-105');
  await signIn('E-101');
  await call('E-101', 'accounts.resetPin', { employeeId: 'E-105' });
  await rejects(faceIdLogin(a5), 401, 'passkey_unknown');
  // An authenticator reset removes a management account's phones.
  const a2 = await enroll('E-102');
  await signIn('E-101');
  await call('E-101', 'auth.enrollTotp', { employeeId: 'E-102' });
  await rejects(faceIdLogin(a2), 401, 'passkey_unknown');

  // Temporary lock (wrong PINs) also stops Face ID; an unfinished PIN reset too; management without an authenticator too.
  const a7 = await enroll('E-107');
  db.run("UPDATE employees SET locked_until=? WHERE id='E-107'", [new Date(hub.clock.now().getTime() + 600000).toISOString()]);
  await rejects(faceIdLogin(a7), 423, 'locked');
  db.run("UPDATE employees SET locked_until=NULL, pin_hash=NULL WHERE id='E-107'");
  await rejects(faceIdLogin(a7), 409, 'no_pin');
  const a3 = await enroll('E-103');
  const sec = db.get("SELECT totp_secret FROM employees WHERE id='E-103'").totp_secret;
  db.run("UPDATE employees SET totp_secret=NULL WHERE id='E-103'");
  await rejects(faceIdLogin(a3), 403, 'totp_not_enrolled');
  db.run("UPDATE employees SET totp_secret=? WHERE id='E-103'", [sec]);

  // A signing ticket cannot be redeemed in a shop-tablet or shared session.
  const a4 = await enroll('E-104');
  const r4 = await faceIdLogin(a4, { purpose: 'sign', action: 'survey.submit', content: signContent() });
  await signIn('E-104', { deviceToken: kiosk });
  const o4 = await openFor('E-104');
  await rejects(call('E-104', 'survey.submit', { assignmentId: o4.assignmentId, ...fields, affirm: true, signTicket: r4.signTicket, idempotencyKey: 'pk-y' }), 403, 'passkey_shared_device');

  // Malformed input: refused cleanly (401), never an internal error, and the challenge is used up.
  for (const mutate of [(c) => { c.response.clientDataJSON = Buffer.from('null').toString('base64url'); }, (c) => { c.response.signature = 'abcde'; }, (c) => { c.response.authenticatorData = '@@'; }]) {
    const po = await svc.passkeyOptions({ rp: RP });
    const cred = await a4.get(po.publicKey); mutate(cred);
    await rejects(svc.passkeyLogin({ challengeId: po.challengeId, credential: cred }), 401, 'passkey_failed');
    await rejects(svc.passkeyLogin({ challengeId: po.challengeId, credential: await a4.get(po.publicKey) }), 401, 'passkey_expired');
  }
});

test('PK-13 the open weekly report shows the week that can be signed now (before Friday it is still last week)', async () => {
  at('2026-10-19T16:00:00Z');   // Monday 09:00 PT: last week's report (week of Oct 12) is due today
  assert.equal(svc.publicInfo().week.weekId, '2026-10-12');
  at('2026-10-23T15:00:00Z');   // Friday 08:00 PT: this week's report is open
  assert.equal(svc.publicInfo().week.weekId, '2026-10-19');
  at('2026-10-16T17:30:00Z');
});
