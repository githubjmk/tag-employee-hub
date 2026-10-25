// Passkeys (WebAuthn Level 2) verification on the standard Web Crypto API, so the same code
// runs in Cloudflare Workers, Node 22 and browsers. No third-party library.
//
// What is checked (W3C WebAuthn §7.1 registration, §7.2 authentication):
//   clientDataJSON: type, challenge (exact, single use), origin (exact), not cross-origin
//   authenticatorData: rpIdHash == SHA-256(rpId), User Present and User Verified flags
//   registration: credential id and COSE public key taken from the attested credential data
//   authentication: signature over authenticatorData || SHA-256(clientDataJSON) with the stored key,
//                   signature counter must increase when the authenticator keeps one
// Attestation statements are not verified (attestation "none" is requested): the Hub only needs
// to know that the same key is used again, not which company made the phone.
// Supported keys: ES256 (-7, every iPhone/Android/Mac/Windows passkey) and RS256 (-257, older Windows Hello).

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();

export const ALG = { ES256: -7, RS256: -257 };

export function b64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new WebAuthnError('bad_encoding');
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  let bin;
  try { bin = atob(s + '==='.slice((s.length + 3) % 4)); } catch { throw new WebAuthnError('bad_encoding'); }
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export class WebAuthnError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const fail = (reason) => { throw new WebAuthnError(reason); };

// ---- minimal CBOR decoder (RFC 8949): unsigned/negative ints, byte/text strings, arrays,
// maps, simple values. Enough for attestationObject and COSE keys; rejects anything else.
export function cborDecode(bytes, start = 0) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start, depth = 0;
  const need = (n) => { if (p + n > bytes.length) fail('cbor_truncated'); };
  const len = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return bytes[p++]; }
    if (info === 25) { need(2); const v = dv.getUint16(p); p += 2; return v; }
    if (info === 26) { need(4); const v = dv.getUint32(p); p += 4; return v; }
    if (info === 27) { need(8); const hi = dv.getUint32(p), lo = dv.getUint32(p + 4); p += 8; if (hi > 0x1fffff) fail('cbor_too_big'); return hi * 2 ** 32 + lo; }
    fail('cbor_indefinite');
  };
  const item = () => {
    if (++depth > 16) fail('cbor_deep');
    need(1);
    const b = bytes[p++], major = b >> 5, info = b & 31;
    let out;
    switch (major) {
      case 0: out = len(info); break;
      case 1: out = -1 - len(info); break;
      case 2: { const n = len(info); need(n); out = bytes.slice(p, p + n); p += n; break; }
      case 3: { const n = len(info); need(n); out = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p, p + n)); p += n; break; }
      case 4: { const n = len(info); if (n > 1000) fail('cbor_big'); out = []; for (let i = 0; i < n; i++) out.push(item()); break; }
      case 5: { const n = len(info); if (n > 1000) fail('cbor_big'); out = new Map(); for (let i = 0; i < n; i++) { const k = item(); out.set(k, item()); } break; }
      case 7: out = info === 20 ? false : info === 21 ? true : info === 22 ? null : fail('cbor_simple'); break;
      default: fail('cbor_type');
    }
    depth--;
    return out;
  };
  const value = item();
  return { value, end: p };
}

// ---- authenticator data (WebAuthn §6.1)
export function parseAuthData(ad) {
  if (!(ad instanceof Uint8Array) || ad.length < 37) fail('authdata_short');
  const flags = ad[32];
  const out = {
    rpIdHash: ad.slice(0, 32), flags,
    up: !!(flags & 0x01), uv: !!(flags & 0x04), be: !!(flags & 0x08), bs: !!(flags & 0x10), at: !!(flags & 0x40), ed: !!(flags & 0x80),
    signCount: new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0)
  };
  if (out.at) {
    if (ad.length < 55) fail('authdata_short');
    const idLen = (ad[53] << 8) | ad[54];
    if (idLen < 16 || idLen > 1023 || 55 + idLen > ad.length) fail('credential_id_length');
    out.credentialId = ad.slice(55, 55 + idLen);
    const { value, end } = cborDecode(ad, 55 + idLen);
    if (!(value instanceof Map)) fail('cose_key');
    out.coseKey = value;
    out.attestedEnd = end;
  }
  return out;
}

// COSE_Key (RFC 9053) -> JWK for crypto.subtle.importKey.
export function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (alg === ALG.ES256) {
    if (kty !== 2 || cose.get(-1) !== 1) fail('unsupported_key');
    const x = cose.get(-2), y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) fail('bad_key');
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y), ext: true } };
  }
  if (alg === ALG.RS256) {
    if (kty !== 3) fail('unsupported_key');
    const n = cose.get(-1), e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256) fail('bad_key');
    return { alg, jwk: { kty: 'RSA', n: b64urlEncode(n), e: b64urlEncode(e), alg: 'RS256', ext: true } };
  }
  fail('unsupported_algorithm');
}

async function importKey(jwk, alg) {
  if (alg !== ALG.ES256 && alg !== ALG.RS256) fail('unsupported_algorithm');
  try {
    return alg === ALG.ES256
      ? await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      : await subtle().importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch { fail('bad_key'); }   // e.g. a point that is not on the curve
}

// ECDSA signatures from authenticators are ASN.1 DER; Web Crypto wants raw r||s (64 bytes for P-256).
export function derToRaw(der, size = 32) {
  let p = 0;
  const take = () => { if (p >= der.length) fail('bad_signature'); return der[p++]; };
  if (take() !== 0x30) fail('bad_signature');
  let total = take(); if (total & 0x80) { const n = total & 0x7f; total = 0; for (let i = 0; i < n; i++) total = (total << 8) | take(); }
  if (p + total !== der.length) fail('bad_signature');
  const int = () => {
    if (take() !== 0x02) fail('bad_signature');
    const l = take(); if (l < 1 || l > size + 1 || p + l > der.length) fail('bad_signature');
    let v = der.slice(p, p + l); p += l;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) fail('bad_signature');
    const out = new Uint8Array(size); out.set(v, size - v.length); return out;
  };
  const r = int(), s = int();
  if (p !== der.length) fail('bad_signature');
  const raw = new Uint8Array(size * 2); raw.set(r); raw.set(s, size); return raw;
}

const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes));
const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
const field = (o, k, max = 20000) => { const v = o && o[k]; if (typeof v !== 'string' || !v || v.length > max) fail('missing_' + k); return b64urlDecode(v); };

function checkClientData(bytes, { type, challenge, origin }) {
  let cd;
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('client_data'); }
  if (!cd || typeof cd !== 'object' || Array.isArray(cd)) fail('client_data');
  if (cd.type !== type) fail('wrong_type');
  if (typeof cd.challenge !== 'string' || cd.challenge !== challenge) fail('wrong_challenge');
  if (cd.origin !== origin) fail('wrong_origin');
  if (cd.crossOrigin === true) fail('cross_origin');
  return cd;
}

async function checkAuthData(ad, rpId) {
  if (!eq(ad.rpIdHash, await sha256(te.encode(rpId)))) fail('wrong_rp');
  if (!ad.up) fail('user_not_present');
  if (!ad.uv) fail('user_not_verified');
}

// Registration (navigator.credentials.create). `credential` is the JSON the page sends:
// { id, rawId, type, response: { clientDataJSON, attestationObject, transports? } } (base64url).
export async function verifyRegistration({ credential, challenge, origin, rpId, allowedAlgs = [ALG.ES256, ALG.RS256] }) {
  if (!credential || credential.type !== 'public-key' || !credential.response) fail('bad_credential');
  const cdBytes = field(credential.response, 'clientDataJSON');
  checkClientData(cdBytes, { type: 'webauthn.create', challenge, origin });
  const att = cborDecode(field(credential.response, 'attestationObject', 200000)).value;
  if (!(att instanceof Map) || !(att.get('authData') instanceof Uint8Array) || typeof att.get('fmt') !== 'string') fail('attestation_object');
  const ad = parseAuthData(att.get('authData'));
  await checkAuthData(ad, rpId);
  if (!ad.at) fail('no_credential_data');
  const credentialId = b64urlEncode(ad.credentialId);
  if (credential.id !== credentialId) fail('credential_id_mismatch');
  const key = coseToJwk(ad.coseKey);
  if (!allowedAlgs.includes(key.alg)) fail('unsupported_algorithm');
  await importKey(key.jwk, key.alg);   // proves the key is usable before it is stored
  const transports = Array.isArray(credential.response.transports) ? credential.response.transports.filter(t => typeof t === 'string' && t.length < 20).slice(0, 6) : [];
  return { credentialId, jwk: key.jwk, alg: key.alg, signCount: ad.signCount, backupEligible: ad.be, backedUp: ad.bs, transports, fmt: att.get('fmt') };
}

// Authentication (navigator.credentials.get). `credential`:
// { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle? } }.
// `stored` = { jwk, alg, signCount } of the passkey whose id equals credential.id.
export async function verifyAssertion({ credential, challenge, origin, rpId, stored }) {
  if (!credential || credential.type !== 'public-key' || !credential.response) fail('bad_credential');
  const cdBytes = field(credential.response, 'clientDataJSON');
  checkClientData(cdBytes, { type: 'webauthn.get', challenge, origin });
  const adBytes = field(credential.response, 'authenticatorData');
  const ad = parseAuthData(adBytes);
  await checkAuthData(ad, rpId);
  const sig = field(credential.response, 'signature');
  const signed = new Uint8Array(adBytes.length + 32);
  signed.set(adBytes); signed.set(await sha256(cdBytes), adBytes.length);
  const key = await importKey(stored.jwk, stored.alg);
  const raw = stored.alg === ALG.ES256 ? derToRaw(sig) : sig;
  let ok = false;
  try {
    ok = stored.alg === ALG.ES256
      ? await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed)
      : await subtle().verify({ name: 'RSASSA-PKCS1-v1_5' }, key, raw, signed);
  } catch { ok = false; }
  if (!ok) fail('bad_signature');
  // Counter: 0 means the authenticator does not count (all synced passkeys); otherwise it must grow.
  if ((ad.signCount !== 0 || stored.signCount !== 0) && ad.signCount <= stored.signCount) fail('counter_went_back');
  return { signCount: ad.signCount, backedUp: ad.bs };
}
