// A software passkey authenticator for tests: it builds exactly what a phone sends
// (CBOR attestationObject, authenticatorData, DER-encoded ECDSA signatures) from real keys.
// Test use only: it lets the tests forge wrong origins, replays, tampered data and old counters.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

export const b64u = (b) => Buffer.from(b).toString('base64url');
export const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };

// Minimal CBOR encoder (ints, negative ints, byte strings, text, arrays, Maps/objects).
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Uint8Array.of((major << 5) | n);
    if (n < 256) return Uint8Array.of((major << 5) | 24, n);
    if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
    return cat(Uint8Array.of((major << 5) | 26), u32(n));
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (typeof v === 'string') { const b = te.encode(v); return cat(head(3, b.length), b); }
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor));
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return cat(head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

// Raw r||s -> ASN.1 DER, as authenticators send ECDSA signatures.
export function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = cat(Uint8Array.of(0), b); return cat(Uint8Array.of(0x02, b.length), b); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

export class SoftAuthenticator {
  constructor({ origin, rpId, alg = -7, counter = false, uv = true, synced = true } = {}) {
    Object.assign(this, { origin, rpId, alg, counter, uv, synced, count: 0, creds: [] });
  }
  async create(publicKey, { origin = this.origin, rpId = publicKey.rp.id, type = 'webauthn.create', challenge = publicKey.challenge } = {}) {
    const rsa = this.alg === -257;
    const kp = await subtle.generateKey(rsa ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await subtle.exportKey('jwk', kp.publicKey);
    const cose = rsa ? new Map([[1, 3], [3, -257], [-1, unb64u(jwk.n)], [-2, unb64u(jwk.e)]])
      : new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
    const credId = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const flags = 0x01 | (this.uv ? 0x04 : 0) | 0x40 | (this.synced ? 0x18 : 0);
    const authData = cat(await sha(te.encode(rpId)), Uint8Array.of(flags), u32(this.counter ? ++this.count : 0), new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cbor(cose));
    const clientDataJSON = te.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const cred = { id: b64u(credId), key: kp.privateKey, alg: this.alg, userHandle: publicKey.user.id };
    this.creds.push(cred);
    return { id: cred.id, rawId: cred.id, type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal', 'hybrid'] } };
  }
  async get(publicKey, { cred = this.creds.at(-1), origin = this.origin, rpId = publicKey.rpId, type = 'webauthn.get', challenge = publicKey.challenge, countOverride, tamper = false } = {}) {
    const flags = 0x01 | (this.uv ? 0x04 : 0) | (this.synced ? 0x18 : 0);
    const count = countOverride ?? (this.counter ? ++this.count : 0);
    const authData = cat(await sha(te.encode(rpId)), Uint8Array.of(flags), u32(count));
    const clientDataJSON = te.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const signed = cat(authData, await sha(clientDataJSON));
    const sig = cred.alg === -257
      ? new Uint8Array(await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, cred.key, signed))
      : rawToDer(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.key, signed)));
    if (tamper) authData[36] ^= 1;   // change the signed data after signing
    return { id: cred.id, rawId: cred.id, type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: cred.userHandle } };
  }
}
