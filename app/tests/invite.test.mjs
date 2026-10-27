// R1.3 onboarding invites: the welcome email, the one-time link, choosing the PIN, login by email.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { makeResendMailer, inviteEmail } from '../core/mailer.js';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
const RP = { rp: { rpId: 'hub.example.test', origin: 'https://hub.example.test' } };
let hub, svc, db;
const T = {};
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid) { later(0.55); T[eid] = (await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) })).token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input, RP);
const tokenOf = (link) => link.split('/#/join/')[1];
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  at('2026-10-20T17:30:00Z');
});

test('IN-01 the live mailer posts one email to Resend from info@innerspacecases.com; no key, no mailer', async () => {
  const seen = [];
  const m = makeResendMailer({ fetch: async (url, init) => { seen.push({ url, init }); return { status: 200, json: async () => ({ id: 'em_1' }) }; }, apiKey: 're_test' });
  const r = await m.send({ to: 'a@b.co', subject: 'S', html: '<p>h</p>', text: 't' });
  assert.deepEqual(r, { ok: true, id: 'em_1', detail: 'HTTP 200' });
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer re_test');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.from, 'Innerspace Employee Hub <info@innerspacecases.com>');
  assert.deepEqual(body.to, ['a@b.co']);
  assert.equal(makeResendMailer({ fetch: async () => ({}), apiKey: '' }), null);
  const bad = makeResendMailer({ fetch: async () => ({ status: 403, json: async () => ({ message: 'domain not verified' }) }), apiKey: 'x' });
  assert.deepEqual(await bad.send({ to: 'a@b.co' }), { ok: false, detail: 'HTTP 403: domain not verified' });
  const es = inviteEmail({ name: 'Maria Sample', link: 'https://x/#/join/abc', expiresText: 'el viernes', lang: 'es', logoUrl: 'https://x/l.png' });
  assert.match(es.subject, /Bienvenido/); assert.match(es.html, /Hola Maria/); assert.match(es.text, /https:\/\/x\/#\/join\/abc/);
  const xss = inviteEmail({ name: '<b>x</b>', link: 'https://x/"a', expiresText: '', logoUrl: '' });
  assert.ok(!xss.html.includes('<b>x</b>') && !xss.html.includes('/"a'), 'names and links are escaped');
});

test('IN-02 email on the account; the test copy shows a preview and sends nothing; the link opens the welcome page', async () => {
  await signIn('E-101');
  await call('E-101', 'accounts.update', { employeeId: 'E-104', email: ' Maria@Example.com ' });
  const acct = (await call('E-101', 'accounts.list')).find(a => a.id === 'E-104');
  assert.equal(acct.email, 'maria@example.com');
  await rejects(call('E-101', 'accounts.update', { employeeId: 'E-105', email: 'maria@example.com' }), 409, 'email_taken');
  await rejects(call('E-101', 'accounts.update', { employeeId: 'E-105', email: 'not-an-email' }), 400, 'email');
  await rejects(call('E-101', 'invite.create', { employeeId: 'E-106', send: true }), 400, 'no_email');
  const r = await call('E-101', 'invite.create', { employeeId: 'E-104', send: true });
  assert.equal(r.sent.ok, true); assert.equal(r.sent.live, false); assert.equal(r.emailLive, false);
  assert.equal(r.sent.to, 'maria@example.com');
  assert.match(r.sent.preview.subject, /Bienvenido/, 'Maria reads Spanish');
  const pv = await call('E-101', 'invite.preview', { inviteId: r.sent.preview.inviteId });
  assert.ok(pv.html.includes(r.link), 'the preview shows the real link');
  await rejects(call('E-101', 'invite.preview', { inviteId: 'INV-0000000000' }), 404);
  T.previewId = r.sent.preview.inviteId;
  assert.match(r.link, /^https:\/\/hub\.example\.test\/#\/join\/[a-f0-9]{64}$/);
  assert.equal(db.get("SELECT COUNT(*) n FROM invites WHERE employee_id='E-104'").n, 1);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM invites')).includes(tokenOf(r.link)), 'only a hash of the link is stored');
  const peek = await svc.invitePeek(tokenOf(r.link));
  assert.deepEqual({ valid: peek.valid, firstName: peek.firstName, management: peek.management }, { valid: true, firstName: 'Maria', management: false });
  assert.equal((await svc.invitePeek('f'.repeat(64))).valid, false);
  assert.equal((await svc.invitePeek('../etc')).valid, false);
  const ob = (await call('E-101', 'accounts.list')).find(a => a.id === 'E-104').onboarding;
  assert.equal(ob.invite.opened, true); assert.equal(ob.invite.sentTo, 'maria@example.com');
});

test('IN-03 accepting sets the PIN, starts a session, works once; the inviter is told; login by email works', async () => {
  const r = await call('E-101', 'invite.create', { employeeId: 'E-104', send: false });
  assert.equal(r.sent, null);
  const old = db.all("SELECT * FROM invites WHERE employee_id='E-104' ORDER BY created_at");
  assert.ok(old.slice(0, -1).every(i => i.revoked_at), 'a new invite replaces the old one');
  const t = tokenOf(r.link);
  await rejects(svc.inviteAccept({ token: t, newPin: '480157', confirmPin: '480158' }), 400, 'pin_mismatch');
  await rejects(svc.inviteAccept({ token: t, newPin: '111111', confirmPin: '111111' }), 400, 'weak_pin');
  const a = await svc.inviteAccept({ token: t, newPin: '480157', confirmPin: '480157' });
  assert.ok(a.token); assert.equal(a.mfa, null); assert.equal(a.employee.id, 'E-104');
  const home = await svc.call(a.token, 'home', {}, RP);
  assert.ok(home, 'the new session works');
  await rejects(svc.inviteAccept({ token: t, newPin: '480157', confirmPin: '480157' }), 410, 'invite_invalid');
  assert.equal((await svc.invitePeek(t)).reason, 'used');
  later(1);
  const viaEmail = await svc.login({ employeeId: 'MARIA@example.com', pin: '480157' });
  assert.ok(viaEmail.token, 'email works in the ID box');
  const n = db.get("SELECT subject FROM notifications WHERE recipient_id='E-101' ORDER BY created_at DESC LIMIT 1");
  assert.match(n.subject, /Maria Sample finished setting up/);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='invite.used' AND entity_id='E-104'"));
});

test('IN-04 links expire after 72 hours; revoke and deactivation end them', async () => {
  const r = await call('E-101', 'invite.create', { employeeId: 'E-106' });
  later(71 * 60);
  assert.equal((await svc.invitePeek(tokenOf(r.link))).valid, true);
  later(2 * 60);
  assert.equal((await svc.invitePeek(tokenOf(r.link))).reason, 'expired');
  await rejects(svc.inviteAccept({ token: tokenOf(r.link), newPin: '480157', confirmPin: '480157' }), 410);
  await signIn('E-101');
  const r2 = await call('E-101', 'invite.create', { employeeId: 'E-106' });
  await call('E-101', 'invite.revoke', { employeeId: 'E-106' });
  assert.equal((await svc.invitePeek(tokenOf(r2.link))).valid, false);
  const r3 = await call('E-101', 'invite.create', { employeeId: 'E-107' });
  await call('E-101', 'hr.setStatus', { employeeId: 'E-107', status: 'terminated', endDate: '2026-10-22' });
  assert.equal((await svc.invitePeek(tokenOf(r3.link))).valid, false, 'a deactivated person\'s link stops working');
});

test('IN-05 who can invite: full access anyone; a manager only their own staff; staff nobody', async () => {
  await signIn('E-102');
  const ok = await call('E-102', 'invite.create', { employeeId: 'E-105' });
  assert.ok(ok.link, 'Dana invites her own staff');
  await rejects(call('E-102', 'invite.create', { employeeId: 'E-103' }), 403);
  await rejects(call('E-102', 'invite.create', { employeeId: 'E-101' }), 403);
  await rejects(call('E-102', 'invite.create', { employeeId: 'E-102' }), 403);
  assert.ok((await call('E-102', 'invite.preview', { inviteId: T.previewId })).html, 'Maria\'s manager can see the preview');
  await signIn('E-106');
  await rejects(call('E-106', 'invite.preview', { inviteId: T.previewId }), 404);
  await rejects(call('E-106', 'invite.create', { employeeId: 'E-105' }), 403);
  await rejects(call('E-106', 'invite.revoke', { employeeId: 'E-105' }), 403);
});

test('IN-06 management accepting an invite gets a fresh authenticator code shown once', async () => {
  await signIn('E-101');
  const r = await call('E-101', 'invite.create', { employeeId: 'E-103' });
  assert.equal((await svc.invitePeek(tokenOf(r.link))).management, true);
  const before = db.get("SELECT totp_secret FROM employees WHERE id='E-103'").totp_secret;
  const a = await svc.inviteAccept({ token: tokenOf(r.link), newPin: '480157', confirmPin: '480157' });
  assert.match(a.mfa.secret, /^[A-Z2-7]{32}$/);
  assert.match(a.mfa.otpauth, /^otpauth:\/\/totp\//);
  const after = db.get("SELECT totp_secret FROM employees WHERE id='E-103'").totp_secret;
  assert.notEqual(after, before); assert.ok(!after.includes(a.mfa.secret), 'stored sealed');
  later(1);
  const code = totpAt(hub.crypto, a.mfa.secret, Math.floor(hub.clock.now().getTime() / 1000));
  assert.ok((await svc.login({ employeeId: 'E-103', pin: '480157', totp: await code })).token, 'the new code works');
});
