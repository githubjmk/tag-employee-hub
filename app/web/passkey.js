// Passkeys in the browser: Face ID / fingerprint / phone passcode instead of the PIN, on a
// person's own phone. The phone keeps the private key; nothing secret is stored here.
// The only thing kept in this browser is which person set up Face ID on it ({ id, name }),
// so the Hub can greet them and skip "who are you". That is not a secret.
import { api } from './api.js';

const toB64u = (buf) => {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), c => c.charCodeAt(0)); };

export const passkeySupported = () => !window.HUB_LOCAL && window.isSecureContext && !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get);
// Phone/computer with Face ID, fingerprint or Windows Hello built in.
export async function platformAvailable() {
  try { return passkeySupported() && await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}

const KEY = 'hub_pk';
export const pkHint = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v.id === 'string' ? v : null; } catch { return null; } };
export const setPkHint = (who) => { try { if (who && who.id) localStorage.setItem(KEY, JSON.stringify({ id: who.id, name: who.name || '' })); else localStorage.removeItem(KEY); } catch { /* ignore */ } };
const SKIP = 'hub_pk_skip';
export const offerSkipped = (eid) => { try { const v = JSON.parse(localStorage.getItem(SKIP) || '{}'); return !!v[eid] && Date.now() - v[eid] < 30 * 86400000; } catch { return false; } };
export const skipOffer = (eid) => { try { const v = JSON.parse(localStorage.getItem(SKIP) || '{}'); v[eid] = Date.now(); localStorage.setItem(SKIP, JSON.stringify(v)); } catch { /* ignore */ } };

export function deviceGuess() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Computer';
  return 'Phone';
}
// What to call it on this device ("Face ID" on iPhone, "fingerprint" on Android, ...).
export function methodName(lang = 'en') {
  const ua = navigator.userAgent || '';
  const es = lang === 'es';
  if (/iPhone|iPad/.test(ua)) return 'Face ID';
  if (/Android/.test(ua)) return es ? 'huella' : 'fingerprint';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return es ? 'Face ID o huella' : 'Face ID or fingerprint';
}

// The user cancelled the system prompt, or it timed out.
export const cancelled = (e) => !!e && (e.name === 'NotAllowedError' || e.name === 'AbortError');

function credentialJSON(c) {
  const r = c.response;
  const out = { id: c.id, rawId: toB64u(c.rawId), type: c.type, response: { clientDataJSON: toB64u(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = toB64u(r.attestationObject);
    try { out.response.transports = r.getTransports ? r.getTransports() : []; } catch { out.response.transports = []; }
  } else {
    out.response.authenticatorData = toB64u(r.authenticatorData);
    out.response.signature = toB64u(r.signature);
    if (r.userHandle) out.response.userHandle = toB64u(r.userHandle);
  }
  return out;
}

export async function registerPasskey() {
  const o = await api.call('passkey.registerOptions', {});
  const pk = o.publicKey;
  const publicKey = { ...pk, challenge: fromB64u(pk.challenge), user: { ...pk.user, id: fromB64u(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials || []).map(x => ({ ...x, id: fromB64u(x.id) })) };
  const cred = await navigator.credentials.create({ publicKey });
  const r = await api.call('passkey.register', { challengeId: o.challengeId, credential: credentialJSON(cred), label: deviceGuess() });
  setPkHint(r.employee);
  return r;
}

// Sign in with Face ID. For signing a report pass purpose 'sign', the action and the exact content.
export async function passkeySignIn({ purpose, action, content, expectEmployeeId } = {}) {
  const o = await api.passkeyOptions({ purpose, action, content });
  const pk = o.publicKey;
  const cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: fromB64u(pk.challenge), allowCredentials: [] } });
  const r = await api.passkeyLogin({ challengeId: o.challengeId, credential: credentialJSON(cred), expectEmployeeId });
  setPkHint(r.employee);
  return r;
}
