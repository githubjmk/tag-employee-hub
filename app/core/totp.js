// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — the format every authenticator app
// supports. Used as the second factor for supervisors, safety, managers and HR.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export async function totpAt(crypto, secretB32, unixSeconds, step = 30, digits = 6) {
  const counter = Math.floor(unixSeconds / step);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const mac = await crypto.hmac('SHA-1', base32Decode(secretB32), msg);
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Accepts the current step and one step either side (clock drift). Returns the
 *  matched counter so a code can't be replayed. */
export async function verifyTotp(crypto, secretB32, code, now, lastUsedCounter = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const t = Math.floor(now.getTime() / 1000);
  for (const drift of [0, -30, 30]) {
    const counter = Math.floor((t + drift) / 30);
    if (counter <= lastUsedCounter) continue;
    if (await totpAt(crypto, secretB32, t + drift) === code) return counter;
  }
  return null;
}
