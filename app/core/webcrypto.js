// One crypto adapter for every runtime (Node 22, browsers, Cloudflare Workers),
// built on the standard Web Crypto API. No runtime-specific crypto.
import { sha256, sha256Bytes } from './sha256.js';

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

// Workers caps PBKDF2 at 100,000 iterations. A 6-digit PIN has only 10^6
// possibilities, so the real protection is (1) the server-side pepper kept as a
// secret outside the database, (2) online lockout and rate limits, and (3) temporary
// PINs that are single use and expire. See r1.2/docs/01-simplified-authentication-design.md.
export const PBKDF2_ITERATIONS = 100000;

export function makeCrypto({ pepper, iterations = PBKDF2_ITERATIONS } = {}) {
  if (!pepper || pepper.length < 16) throw new Error('A pepper of at least 16 characters is required');
  const subtle = globalThis.crypto.subtle;
  let keyPromise = null;
  const secretKey = () => keyPromise || (keyPromise = (async () => {
    const base = await subtle.importKey('raw', enc.encode(pepper), 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tag-employee-hub'), info: enc.encode('secrets-at-rest v1') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })());
  return {
    sha256,
    sha256Bytes,
    randomHex: (n) => hex(globalThis.crypto.getRandomValues(new Uint8Array(n))),
    randomCode(len = 8) {
      // Unambiguous alphabet for codes read aloud or copied by hand (no 0/O/1/I/L).
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len * 2));
      let out = '';
      for (let i = 0; out.length < len && i < bytes.length; i++) if (bytes[i] < 248) out += A[bytes[i] % A.length];
      return out.length === len ? out : this.randomCode(len);
    },
    async hashSecret(secret, salt) {
      const key = await subtle.importKey('raw', enc.encode(pepper + '\u0000' + String(secret)), 'PBKDF2', false, ['deriveBits']);
      return hex(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256));
    },
    async hmac(algo, keyBytes, msgBytes) {
      const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: algo }, false, ['sign']);
      return new Uint8Array(await subtle.sign('HMAC', key, msgBytes));
    },
    // Encryption at rest for small secrets (management authenticator secrets).
    // AES-256-GCM with a key derived (HKDF-SHA256) from the pepper, which lives outside
    // the database as a Worker secret. Stored as "enc1:<base64 iv|ciphertext>".
    // openSecret() passes through values written before encryption existed.
    async sealSecret(plain) {
      if (plain == null) return null;
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(), enc.encode(String(plain))));
      const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, iv.length);
      return 'enc1:' + btoa(String.fromCharCode(...all));
    },
    async openSecret(stored) {
      if (stored == null || !String(stored).startsWith('enc1:')) return stored;
      const all = Uint8Array.from(atob(String(stored).slice(5)), c => c.charCodeAt(0));
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await secretKey(), all.slice(12));
      return new TextDecoder().decode(pt);
    },
    isSealed: (stored) => stored != null && String(stored).startsWith('enc1:'),
    // Constant-time comparison of two hex strings of equal length.
    safeEqual(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
      let d = 0;
      for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return d === 0;
    }
  };
}
