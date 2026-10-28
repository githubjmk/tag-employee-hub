// R1.3 Company documents: handbook and policies, versions, and signed acknowledgments (PIN or Face ID).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../server/server.js';
import { PEOPLE } from '../core/seed.js';
import { totpAt } from '../core/totp.js';
import { SoftAuthenticator } from './softauthn.mjs';

const PIN = Object.fromEntries(PEOPLE.map(p => [p[0], p[9]]));
const RP = { rpId: 'hub.example.test', origin: 'https://hub.example.test' };
let hub, svc, db;
const T = {};
const at = (iso) => { hub.clock.freeze(); hub.clock.set(new Date(iso)); db.run('UPDATE employees SET totp_last_counter=-1'); };
const later = (min) => hub.clock.advance(min * 60000);
const totp = async (eid) => { const e = db.get('SELECT totp_secret FROM employees WHERE id=?', [eid]); return e.totp_secret ? totpAt(hub.crypto, await hub.crypto.openSecret(e.totp_secret), Math.floor(hub.clock.now().getTime() / 1000)) : undefined; };
async function signIn(eid) { later(0.55); T[eid] = (await svc.login({ employeeId: eid, pin: PIN[eid], totp: await totp(eid) })).token; }
const call = (eid, action, input = {}) => svc.call(T[eid], action, input, { rp: RP });
async function rejects(p, status, code) { await assert.rejects(p, (e) => { assert.equal(e.status, status, `${e.status} ${e.code} ${e.message}`); if (code) assert.equal(e.code, code); return true; }); }

before(async () => {
  hub = await createHub();
  ({ service: svc, db } = hub);
  at('2026-10-16T17:30:00Z');
});

test('DOC-01 the test copy has an invented sample handbook (published) and a draft only full access sees; staff cannot write or publish', async () => {
  await signIn('E-104');
  const l = await call('E-104', 'docs.list');
  assert.equal(l.docs.length, 1); assert.match(l.docs[0].title.en, /Sample Employee Handbook \(example only\)/);
  assert.equal(l.pending.length, 1, 'waiting for Maria to sign'); assert.equal(l.canManage, false);
  assert.equal((await call('E-104', 'home')).pendingDocs.length, 1, 'Home shows it as a to-do');
  await signIn('E-101');
  const all = await call('E-101', 'docs.list');
  assert.equal(all.docs.length, 2); const draft = all.docs.find(d => !d.published);
  assert.ok(draft.draft.versionId);
  await rejects(call('E-104', 'docs.get', { versionId: draft.draft.versionId }), 404);
  await rejects(call('E-104', 'docs.get', { documentId: draft.id }), 404);
  await rejects(call('E-104', 'docs.saveDraft', { titleEn: 'x', bodyEn: 'y' }), 403);
  await rejects(call('E-104', 'docs.publish', { versionId: draft.draft.versionId }), 403);
  await signIn('E-102');
  await rejects(call('E-102', 'docs.publish', { versionId: draft.draft.versionId }), 403, undefined);
});

test('DOC-02 signing with the PIN: box and right PIN needed, only the text shown; record keeps the statement in the language signed; once; append-only', async () => {
  const hb = (await call('E-104', 'docs.list')).docs[0];
  const v = await call('E-104', 'docs.get', { documentId: hb.id });
  assert.equal(v.status, 'published'); assert.ok(v.body.es.includes('Bienvenido'));
  const base = { versionId: v.versionId, contentSha256: v.contentSha256, language: 'es' };
  await rejects(call('E-104', 'docs.ack', { ...base, signPin: PIN['E-104'] }), 400, 'no_affirm');
  later(0.6);
  await rejects(call('E-104', 'docs.ack', { ...base, affirm: true, signPin: '999999' }), 401, 'bad_sign_pin');
  await rejects(call('E-104', 'docs.ack', { ...base, contentSha256: 'f'.repeat(64), affirm: true, signPin: PIN['E-104'] }), 409, 'doc_changed');
  assert.equal(db.get('SELECT COUNT(*) n FROM document_acks').n, 0, 'nothing signed yet');
  later(0.6);
  const r = await call('E-104', 'docs.ack', { ...base, affirm: true, signPin: PIN['E-104'] });
  assert.equal(r.ok, true);
  const row = db.get("SELECT * FROM document_acks WHERE employee_id='E-104'");
  assert.match(row.statement, /^Recibí Manual del empleado de ejemplo/); assert.equal(row.language, 'es'); assert.equal(row.content_sha256, v.contentSha256);
  assert.match(JSON.parse(row.identity_json).method, /PIN re-entered/);
  assert.equal((await call('E-104', 'docs.ack', { ...base, affirm: true, signPin: PIN['E-104'] })).already, true, 'signing twice keeps the first');
  assert.equal((await call('E-104', 'docs.list')).pending.length, 0);
  assert.equal((await call('E-104', 'docs.get', { documentId: hb.id })).myAck.language, 'es');
  assert.throws(() => db.run("UPDATE document_acks SET signed_at='2020-01-01' WHERE employee_id='E-104'"), /append-only/);
  assert.throws(() => db.run("DELETE FROM document_acks WHERE employee_id='E-104'"), /append-only/);
  assert.ok(db.get("SELECT 1 FROM audit_events WHERE action='doc.acknowledged' AND actor_id='E-104'"));
});

test('DOC-03 a new version: copied from the published one, published with a check of the text, old one retired; everyone signs again; earlier signatures kept', async () => {
  const hb = (await call('E-101', 'docs.list')).docs.find(d => d.category === 'handbook');
  const v1 = await call('E-101', 'docs.get', { versionId: hb.published.versionId });
  const nd = await call('E-101', 'docs.newDraft', { documentId: hb.id });
  const dv = await call('E-101', 'docs.get', { versionId: nd.versionId });
  assert.equal(dv.status, 'draft'); assert.equal(dv.version, '2'); assert.equal(dv.body.en, v1.body.en, 'the new draft starts from the published text');
  assert.equal((await call('E-101', 'docs.newDraft', { documentId: hb.id })).versionId, nd.versionId, 'one draft at a time');
  assert.equal((await call('E-104', 'docs.get', { documentId: hb.id })).version, '1', 'staff still see version 1 while the draft is worked on');
  await call('E-101', 'docs.saveDraft', { documentId: hb.id, category: 'handbook', version: '2', titleEn: dv.title.en, titleEs: dv.title.es, bodyEn: dv.body.en + '\n\n## New section\n- Added rule', bodyEs: dv.body.es, ackRequired: true });
  await rejects(call('E-101', 'docs.publish', { versionId: nd.versionId, contentSha256: dv.contentSha256 }), 409, 'doc_changed');
  const fresh = await call('E-101', 'docs.get', { versionId: nd.versionId });
  const pub = await call('E-101', 'docs.publish', { versionId: nd.versionId, contentSha256: fresh.contentSha256 });
  assert.equal(pub.ok, true);
  assert.equal(db.get("SELECT COUNT(*) n FROM document_versions WHERE document_id=? AND status='published'", [hb.id]).n, 1);
  assert.equal(db.get("SELECT status FROM document_versions WHERE id=?", [hb.published.versionId]).status, 'retired', 'version 1 retired');
  const v2 = await call('E-104', 'docs.get', { documentId: hb.id });
  assert.equal(v2.version, '2'); assert.equal(v2.myAck, null);
  assert.equal((await call('E-104', 'docs.list')).pending.length, 1, 'Maria signs again');
  assert.equal(db.get("SELECT COUNT(*) n FROM document_acks WHERE employee_id='E-104'").n, 1, 'version 1 signature kept');
  assert.ok(db.get("SELECT 1 FROM notifications WHERE recipient_id='E-104' AND kind='document' AND subject LIKE 'Please read and sign%'"));
  await rejects(call('E-101', 'docs.ack', { versionId: hb.published.versionId, contentSha256: 'x', affirm: true, signPin: PIN['E-101'] }), 409, 'doc_not_current');
});

test('DOC-04 who has signed: full access sees everyone, a manager only their team, staff nobody', async () => {
  const hb = (await call('E-101', 'docs.list')).docs.find(d => d.category === 'handbook');
  const all = await call('E-101', 'docs.status', { versionId: hb.published.versionId });
  const active = db.get("SELECT COUNT(*) n FROM employees WHERE status='active'").n;
  assert.equal(all.signed.length + all.waiting.length, active);
  await signIn('E-103');
  const pat = await call('E-103', 'docs.status', { versionId: hb.published.versionId });
  assert.ok(pat.signed.length + pat.waiting.length < active, 'a manager sees their own people only');
  await rejects(call('E-104', 'docs.status', { versionId: hb.published.versionId }), 403);
});

test('DOC-05 signing with Face ID: the approval covers exactly this version; another version or a reused approval is refused', async () => {
  await signIn('E-106');
  const a = new SoftAuthenticator({ origin: RP.origin });
  later(0.55);
  const o = await call('E-106', 'passkey.registerOptions', { signPin: PIN['E-106'] });
  await call('E-106', 'passkey.register', { challengeId: o.challengeId, credential: await a.create(o.publicKey), label: 'iPhone' });
  const hb = (await call('E-106', 'docs.list')).docs[0];
  const v = await call('E-106', 'docs.get', { documentId: hb.id });
  const content = { versionId: v.versionId, contentSha256: v.contentSha256, language: 'en' };
  const face = async (c) => { const op = await svc.passkeyOptions({ rp: RP, purpose: 'sign', action: 'doc.ack', content: c }); return svc.passkeyLogin({ challengeId: op.challengeId, credential: await a.get(op.publicKey), expectEmployeeId: 'E-106' }); };
  const wrong = await face({ ...content, language: 'es' });
  T['E-106'] = wrong.token;
  await rejects(call('E-106', 'docs.ack', { ...content, affirm: true, signTicket: wrong.signTicket }), 401, 'bad_sign_ticket');
  const ok = await face(content);
  T['E-106'] = ok.token;
  assert.equal((await call('E-106', 'docs.ack', { ...content, affirm: true, signTicket: ok.signTicket })).ok, true);
  const row = db.get("SELECT identity_json FROM document_acks WHERE employee_id='E-106'");
  assert.match(JSON.parse(row.identity_json).method, /passkey/);
  assert.equal(JSON.parse(row.identity_json).passkey.device, 'iPhone');
});

test('DOC-06 drafts can be deleted; a document can be archived (no longer asked for) and brought back; text over the size limit is refused', async () => {
  const d = await call('E-101', 'docs.saveDraft', { category: 'policy', titleEn: 'Temp', bodyEn: 'Temp text' });
  assert.equal((await call('E-101', 'docs.discardDraft', { versionId: d.versionId })).documentGone, true);
  const hb = (await call('E-101', 'docs.list')).docs.find(x => x.category === 'handbook');
  await signIn('E-107');
  assert.equal((await call('E-107', 'docs.list')).pending.length, 1);
  await call('E-101', 'docs.archive', { documentId: hb.id });
  assert.equal((await call('E-107', 'docs.list')).pending.length, 0, 'archived: nobody is asked to sign');
  await rejects(call('E-107', 'docs.get', { documentId: hb.id }), 404);
  await call('E-101', 'docs.archive', { documentId: hb.id, restore: true });
  assert.equal((await call('E-107', 'docs.list')).pending.length, 1);
  assert.equal((await call('E-101', 'docs.saveDraft', { titleEn: 'x', bodyEn: 'y'.repeat(200001) }).catch(e => e)).code, 'too_long');
  // Review fix: published versions are locked in the database, and publishing needs the text fingerprint.
  const live = db.get("SELECT id FROM document_versions WHERE status='published' LIMIT 1").id;
  assert.throws(() => db.run("UPDATE document_versions SET body_en='changed' WHERE id=?", [live]), /cannot be changed/);
  assert.throws(() => db.run('DELETE FROM document_versions WHERE id=?', [live]), /cannot be deleted/);
  assert.throws(() => db.run("UPDATE document_versions SET status='draft' WHERE id=?", [live]), /cannot be changed/, 'a published version cannot be turned back into a draft');
  const d2 = await call('E-101', 'docs.saveDraft', { category: 'policy', titleEn: 'No hash', bodyEn: 'Text' });
  await rejects(call('E-101', 'docs.publish', { versionId: d2.versionId }), 409, 'doc_changed');
});
