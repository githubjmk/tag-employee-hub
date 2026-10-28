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

// New staff accounts (no PIN chosen yet) are the only ones that can get a welcome link.
async function newStaff(name, { lang = 'en', email, reportsTo = 'E-102' } = {}) {
  const r = await call('E-101', 'accounts.create', { name, language: lang, role: 'staff', reportsTo, email, startDate: '2026-10-19' });
  return r.account.id;
}

test('IN-02 email on the account; the test copy shows a preview and sends nothing; the link opens the welcome page', async () => {
  await signIn('E-101');
  const uma = await newStaff('Uma Nueva', { lang: 'es', email: ' Uma@Example.com ' });
  T.uma = uma;
  const acct = (await call('E-101', 'accounts.list')).find(a => a.id === uma);
  assert.equal(acct.email, 'uma@example.com');
  await rejects(call('E-101', 'accounts.update', { employeeId: 'E-105', email: 'uma@example.com' }), 409, 'email_taken');
  for (const bad of ['not-an-email', 'x"onfocus=alert(1)@example.com', 'a<b>@example.com', 'a b@example.com'])
    await rejects(call('E-101', 'accounts.update', { employeeId: 'E-105', email: bad }), 400, 'email');
  const noEmail = await newStaff('Pat Noemail');
  await rejects(call('E-101', 'invite.create', { employeeId: noEmail, send: true }), 400, 'no_email');
  const r = await call('E-101', 'invite.create', { employeeId: uma, send: true });
  assert.equal(r.sent.ok, true); assert.equal(r.sent.live, false); assert.equal(r.emailLive, false);
  assert.equal(r.sent.to, 'uma@example.com');
  assert.match(r.sent.preview.subject, /Bienvenido/, 'Uma reads Spanish');
  const pv = await call('E-101', 'invite.preview', { inviteId: r.sent.preview.inviteId });
  assert.ok(pv.html.includes(r.link), 'the preview shows the real link');
  await rejects(call('E-101', 'invite.preview', { inviteId: 'INV-0000000000' }), 404);
  T.previewId = r.sent.preview.inviteId;
  assert.match(r.link, /^https:\/\/hub\.example\.test\/#\/join\/[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM invites')).includes(tokenOf(r.link)), 'only a hash of the link is stored');
  const peek = await svc.invitePeek(tokenOf(r.link));
  assert.deepEqual({ valid: peek.valid, firstName: peek.firstName, management: peek.management }, { valid: true, firstName: 'Uma', management: false });
  assert.equal((await svc.invitePeek('f'.repeat(64))).valid, false);
  assert.equal((await svc.invitePeek('../etc')).valid, false);
  const ob = (await call('E-101', 'accounts.list')).find(a => a.id === uma).onboarding;
  assert.equal(ob.invite.opened, true); assert.equal(ob.invite.sentTo, 'uma@example.com');
});

test('IN-03 accepting sets the PIN, starts a session, works once; the inviter is told; login by email works', async () => {
  const r = await call('E-101', 'invite.create', { employeeId: T.uma, send: false });
  assert.equal(r.sent, null);
  const old = db.all('SELECT * FROM invites WHERE employee_id=? ORDER BY created_at', [T.uma]);
  assert.ok(old.slice(0, -1).every(i => i.revoked_at), 'a new invite replaces the old one');
  const t = tokenOf(r.link);
  await rejects(svc.inviteAccept({ token: t, newPin: '480157', confirmPin: '480158' }), 400, 'pin_mismatch');
  await rejects(svc.inviteAccept({ token: t, newPin: '111111', confirmPin: '111111' }), 400, 'weak_pin');
  const a = await svc.inviteAccept({ token: t, newPin: '480157', confirmPin: '480157' });
  assert.ok(a.token); assert.equal(a.mfa, null); assert.equal(a.employee.id, T.uma);
  assert.ok(await svc.call(a.token, 'home', {}, RP), 'the new session works');
  await rejects(svc.inviteAccept({ token: t, newPin: '480157', confirmPin: '480157' }), 410, 'invite_invalid');
  assert.equal((await svc.invitePeek(t)).reason, 'used');
  later(1);
  assert.ok((await svc.login({ employeeId: 'UMA@example.com', pin: '480157' })).token, 'email works in the ID box');
  const n = db.get("SELECT subject FROM notifications WHERE recipient_id='E-101' ORDER BY created_at DESC LIMIT 1");
  assert.match(n.subject, /Uma Nueva finished setting up/);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='invite.used' AND entity_id=?", [T.uma]));
});

test('IN-04 review fixes: no links for people who already chose a PIN or for management; links die on role or manager change, PIN reset and hard lock', async () => {
  await rejects(call('E-101', 'invite.create', { employeeId: 'E-104' }), 409, 'already_set_up');
  await rejects(call('E-101', 'invite.create', { employeeId: T.uma }), 409, 'already_set_up');
  const mgr = (await call('E-101', 'accounts.create', { name: 'Mo Manager', role: 'management', reportsTo: 'E-101', startDate: '2026-10-19' })).account.id;
  await rejects(call('E-101', 'invite.create', { employeeId: mgr }), 409, 'management_in_person');
  // role change after the link was made
  const v = await newStaff('Vic Promote');
  const l1 = await call('E-101', 'invite.create', { employeeId: v });
  await call('E-101', 'accounts.update', { employeeId: v, role: 'management', fullAccess: true, reportsTo: 'E-101' });
  assert.equal((await svc.invitePeek(tokenOf(l1.link))).valid, false);
  await rejects(svc.inviteAccept({ token: tokenOf(l1.link), newPin: '480157', confirmPin: '480157' }), 410, 'invite_invalid');
  // manager change
  const w = await newStaff('Wes Move');
  const l2 = await call('E-101', 'invite.create', { employeeId: w });
  await call('E-101', 'accounts.update', { employeeId: w, reportsTo: 'E-103' });
  await rejects(svc.inviteAccept({ token: tokenOf(l2.link), newPin: '480157', confirmPin: '480157' }), 410);
  // temporary PIN issued afterwards
  const x = await newStaff('Xia Temp');
  const l3 = await call('E-101', 'invite.create', { employeeId: x });
  await call('E-101', 'accounts.resetPin', { employeeId: x });
  await rejects(svc.inviteAccept({ token: tokenOf(l3.link), newPin: '480157', confirmPin: '480157' }), 410);
  // hard lock
  const y = await newStaff('Yan Lock');
  const l4 = await call('E-101', 'invite.create', { employeeId: y });
  db.run('UPDATE employees SET hard_locked=1 WHERE id=?', [y]);
  await rejects(svc.inviteAccept({ token: tokenOf(l4.link), newPin: '480157', confirmPin: '480157' }), 410);
  assert.equal(db.get('SELECT hard_locked FROM employees WHERE id=?', [y]).hard_locked, 1, 'an invite never unlocks an account');
});

test('IN-05 the inviter\'s permission is checked again when the link is used; links expire after 72 hours; revoke and deactivation end them', async () => {
  await signIn('E-102');
  const z = await newStaff('Zoe Inv');
  const l = await call('E-102', 'invite.create', { employeeId: z });
  db.run("UPDATE employees SET roles=? WHERE id='E-102'", [JSON.stringify(['employee'])]);   // Dana loses management
  await rejects(svc.inviteAccept({ token: tokenOf(l.link), newPin: '480157', confirmPin: '480157' }), 410);
  db.run("UPDATE employees SET roles=? WHERE id='E-102'", [JSON.stringify(PEOPLE.find(p => p[0] === 'E-102')[7])]);
  const a = await newStaff('Al Expire');
  const r = await call('E-101', 'invite.create', { employeeId: a });
  later(71 * 60);
  assert.equal((await svc.invitePeek(tokenOf(r.link))).valid, true);
  later(2 * 60);
  assert.equal((await svc.invitePeek(tokenOf(r.link))).reason, 'expired');
  await signIn('E-101');
  const r2 = await call('E-101', 'invite.create', { employeeId: a });
  await call('E-101', 'invite.revoke', { employeeId: a });
  assert.equal((await svc.invitePeek(tokenOf(r2.link))).valid, false);
  const r3 = await call('E-101', 'invite.create', { employeeId: a });
  await call('E-101', 'hr.setStatus', { employeeId: a, status: 'terminated', endDate: '2026-10-22' });
  assert.equal((await svc.invitePeek(tokenOf(r3.link))).valid, false, 'a deactivated person\'s link stops working');
});

test('IN-06 who can invite: full access anyone new; a manager only their own new staff; staff nobody', async () => {
  await signIn('E-102');
  const b = await newStaff('Bo Team', { reportsTo: 'E-102' });
  const c = await newStaff('Cy Other', { reportsTo: 'E-103' });
  assert.ok((await call('E-102', 'invite.create', { employeeId: b })).link, 'Dana invites her own new staff');
  await rejects(call('E-102', 'invite.create', { employeeId: c }), 403);
  await rejects(call('E-102', 'invite.create', { employeeId: 'E-102' }), 403);
  assert.ok((await call('E-102', 'invite.preview', { inviteId: T.previewId })).html, 'Uma\'s manager can see the preview');
  await signIn('E-106');
  await rejects(call('E-106', 'invite.preview', { inviteId: T.previewId }), 404);
  await rejects(call('E-106', 'invite.create', { employeeId: b }), 403);
  await rejects(call('E-106', 'invite.revoke', { employeeId: b }), 403);
});
