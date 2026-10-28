// Platform-neutral API handler (standard Request/Response). Used by the Node
// server and by the Cloudflare Worker/Durable Object, so both run identical
// request handling. Static files are served by the platform.
import { HubError } from './service.js';
import { renderRecordHtml } from './render.js';
import { parseGoToReceipt } from './goto-sms.js';

export const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
const MAX_BODY = 64 * 1024;
const MAX_UPLOAD_BODY = 2_200_000;

const safeEq = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };

// Cloudflare Turnstile server-side check (https://challenges.cloudflare.com/turnstile/v0/siteverify).
export function makeTurnstile({ siteKey, secret, fetch }) {
  if (!siteKey || !secret) return null;
  return {
    siteKey,
    async verify(token, ip) {
      if (!token) return false;
      try {
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret, response: token, ...(ip && ip !== 'local' ? { remoteip: ip } : {}) }) });
        const j = await r.json();
        return !!j.success;
      } catch { return false; }
    }
  };
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const tokenFrom = (c, name) => (c[name] && /^[a-f0-9]{64}$/.test(c[name]) ? c[name] : null);

// Optional production features (all off unless configured):
//   turnstile: { siteKey, verify(token, ip) -> Promise<boolean> }   bot check on sign-in
//   bootstrapCode: string                                          one-time first-account setup (empty database only)
//   gotoWebhookSecret: string                                      GoTo delivery receipts at /api/hooks/goto/<secret>
export function createHttpHandler({ service, secureCookies = false, demo = null, devReset = null, turnstile = null, bootstrapCode = null, gotoWebhookSecret = null }) {
  const cookie = (name, value, maxAge) => `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const json = (status, obj, extra = {}) => {
    const h = new Headers({ ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const [k, v] of Object.entries(extra)) for (const vv of [].concat(v)) h.append(k, vv);
    return new Response(JSON.stringify(obj), { status, headers: h });
  };
  const hits = new Map();
  const rateLimited = (key, limit, windowMs) => {
    const n = Date.now();
    const list = (hits.get(key) || []).filter(t => n - t < windowMs);
    list.push(n); hits.set(key, list);
    return list.length > limit;
  };

  async function body(req, limit) {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > limit) throw new HubError(413, 'too_large', 'Request too large');
    const text = await req.text();
    if (text.length > limit) throw new HubError(413, 'too_large', 'Request too large');
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new HubError(400, 'invalid', 'Bad request'); }
  }

  return async function handle(req, { clientKey = 'local' } = {}) {
    const url = new URL(req.url);
    const c = cookies(req);
    const rp = { rpId: url.hostname, origin: url.origin };   // passkeys belong to the address the page was opened at
    try {
      const p = url.pathname;
      // Gateway delivery receipts come from GoTo's servers, so they carry a URL secret instead of the CSRF header.
      const hook = /^\/api\/hooks\/goto\/([A-Za-z0-9_-]{16,128})$/.exec(p);
      if (hook && req.method === 'POST') {
        if (!gotoWebhookSecret || !safeEq(hook[1], gotoWebhookSecret)) throw new HubError(404, 'not_found', 'Not found');
        const b = await body(req, MAX_BODY);
        let matched = 0;
        for (const r of parseGoToReceipt(b)) if ((await service.deliveryReceipt(r)).matched) matched++;
        return json(200, { ok: true, matched });
      }
      if (req.method === 'POST' && req.headers.get('x-hub-request') !== '1') throw new HubError(403, 'csrf', 'Missing request header');
      if (p === '/api/config' && req.method === 'GET') {
        const bs = bootstrapCode ? await service.bootstrapStatus() : { needed: false, recoverable: false };
        return json(200, { turnstileSiteKey: turnstile ? turnstile.siteKey : null, setupNeeded: bs.needed, setupRecoverable: bs.recoverable, demo: !!demo });
      }
      if (p === '/api/public' && req.method === 'GET') return json(200, service.publicInfo());
      if (p === '/api/push/key' && req.method === 'GET') return json(200, service.pushPublic());
      if (p === '/api/push/pending' && req.method === 'POST') {
        if (rateLimited('push:' + clientKey, 120, 60000)) throw new HubError(429, 'rate', 'Too many requests.');
        const b = await body(req, MAX_BODY);
        return json(200, await service.pushPending(b.endpoint));
      }
      if (p === '/api/kiosk/roster' && req.method === 'GET') return json(200, service.kioskRoster(tokenFrom(c, 'hub_device')));
      if (p === '/api/setup/restart' && req.method === 'POST') {
        if (!bootstrapCode) throw new HubError(404, 'not_found', 'Not found');
        if (rateLimited('setup:' + clientKey, 5, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        const b = await body(req, MAX_BODY);
        return json(200, await service.bootstrapRecover({ code: b.code, expectedCode: bootstrapCode }));
      }
      if (p === '/api/setup' && req.method === 'POST') {
        if (!bootstrapCode) throw new HubError(404, 'not_found', 'Not found');
        if (rateLimited('setup:' + clientKey, 5, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        const b = await body(req, MAX_BODY);
        return json(200, await service.bootstrap({ code: b.code, expectedCode: bootstrapCode, employeeId: b.employeeId, name: b.name, smsPhone: b.smsPhone }));
      }

      if (p === '/api/login' && req.method === 'POST') {
        if (rateLimited('login:' + clientKey, 30, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        const b = await body(req, MAX_BODY);
        if (turnstile && !(await turnstile.verify(String(b.turnstileToken || ''), clientKey))) throw new HubError(400, 'bot_check', 'Please complete the "verify you are human" check and try again.');
        const r = await service.login({ employeeId: b.employeeId, pin: b.pin, setupCode: b.setupCode, totp: b.totp, sharedDevice: !!b.sharedDevice, deviceToken: tokenFrom(c, 'hub_device') });
        return json(200, { ok: true, sharedDevice: r.sharedDevice, idleMinutes: r.idleMinutes, mustSetPin: r.mustSetPin }, { 'Set-Cookie': cookie('hub_session', r.token, 12 * 3600) });
      }
      // Passkeys (Face ID / fingerprint) on a person's own phone. Bound to this web address.
      if (p === '/api/passkey/options' && req.method === 'POST') {
        if (rateLimited('pk:' + clientKey, 120, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        const b = await body(req, MAX_BODY);
        return json(200, await service.passkeyOptions({ rp, purpose: b.purpose, action: b.action, content: b.content }));
      }
      if (p === '/api/passkey/login' && req.method === 'POST') {
        if (rateLimited('pk:' + clientKey, 120, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        const b = await body(req, MAX_BODY);
        const r = await service.passkeyLogin({ challengeId: b.challengeId, credential: b.credential, expectEmployeeId: b.expectEmployeeId, deviceToken: tokenFrom(c, 'hub_device'), currentToken: tokenFrom(c, 'hub_session') });
        return json(200, { ok: true, employee: r.employee, idleMinutes: r.idleMinutes, signTicket: r.signTicket, sharedDevice: false }, { 'Set-Cookie': cookie('hub_session', r.token, 12 * 3600) });
      }
      // Onboarding invite (welcome email or QR code): who it is for, then choose the PIN.
      const inv = /^\/api\/invite\/([a-f0-9]{64})$/.exec(p);
      if (inv && req.method === 'GET') {
        if (rateLimited('invite:' + clientKey, 30, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        return json(200, service.invitePeek(inv[1]));
      }
      if (p === '/api/invite/accept' && req.method === 'POST') {
        if (rateLimited('invite:' + clientKey, 30, 60000)) throw new HubError(429, 'rate', 'Too many attempts. Wait a minute.');
        const b = await body(req, MAX_BODY);
        const r = await service.inviteAccept({ token: String(b.token || ''), newPin: b.newPin, confirmPin: b.confirmPin, deviceToken: tokenFrom(c, 'hub_device') });
        return json(200, { ok: true, employee: r.employee, idleMinutes: r.idleMinutes, mfa: r.mfa }, { 'Set-Cookie': cookie('hub_session', r.token, 12 * 3600) });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        await service.logout(tokenFrom(c, 'hub_session'));
        return json(200, { ok: true }, { 'Set-Cookie': cookie('hub_session', '', 0) });
      }
      const m = /^\/api\/call\/([a-zA-Z.]+)$/.exec(p);
      if (m && req.method === 'POST') {
        const action = m[1];
        const b = await body(req, ['attachment.add', 'docs.saveDraft'].includes(action) ? MAX_UPLOAD_BODY : MAX_BODY);
        const result = await service.call(tokenFrom(c, 'hub_session'), action, b, { rp });
        if (action === 'device.register') {
          // The device token never reaches page script: it becomes an HttpOnly cookie on this browser.
          const { deviceToken, ...rest } = result;
          return json(200, { ...rest, registeredThisBrowser: true }, { 'Set-Cookie': cookie('hub_device', deviceToken, 400 * 86400) });
        }
        return json(200, result);
      }
      const rec = /^\/api\/record\/([A-Z0-9-]{4,40})\.(html|json)$/.exec(p);
      if (rec && req.method === 'GET') {
        const r = await service.call(tokenFrom(c, 'hub_session'), 'survey.record', { submissionId: rec[1] });
        const h = new Headers({ ...SEC_HEADERS, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="weekly-report-${rec[1]}.${rec[2]}"`,
          'Content-Type': rec[2] === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' });
        return new Response(rec[2] === 'json' ? JSON.stringify(r, null, 2) : renderRecordHtml(r), { status: 200, headers: h });
      }
      // Test copy: the welcome email as it would arrive (own sandboxed page so its inline styles work).
      const ipv = /^\/api\/invite-preview\/(INV-[A-F0-9]{10})$/.exec(p);
      if (ipv && req.method === 'GET') {
        const r = await service.call(tokenFrom(c, 'hub_session'), 'invite.preview', { inviteId: ipv[1] });
        return new Response(r.html, { status: 200, headers: { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox" } });
      }
      const att = /^\/api\/attachment\/(ATT-[A-F0-9]{10})$/.exec(p);
      if (att && req.method === 'GET') {
        const a = await service.call(tokenFrom(c, 'hub_session'), 'attachment.get', { attachmentId: att[1] });
        const bytes = Uint8Array.from(atob(a.dataBase64), ch => ch.charCodeAt(0));
        return new Response(bytes, { status: 200, headers: { ...SEC_HEADERS, 'Content-Type': a.mime, 'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Content-Disposition': `inline; filename="${a.filename}"`, 'X-Content-SHA256': a.sha256 } });
      }
      if (demo && p === '/api/demo/people' && req.method === 'GET') return json(200, await demo.people());
      if (demo && p === '/api/demo/kiosk' && req.method === 'POST') {
        const b = await body(req, MAX_BODY);
        const token = b.on ? await demo.deviceToken() : '';
        return json(200, { ok: true, kiosk: !!b.on }, { 'Set-Cookie': cookie('hub_device', token, b.on ? 400 * 86400 : 0) });
      }
      if (demo && demo.reset && p === '/api/demo/reset' && req.method === 'POST') {
        await service.call(tokenFrom(c, 'hub_session'), 'demo.resetCheck', {});
        await demo.reset();
        return json(200, { ok: true }, { 'Set-Cookie': cookie('hub_session', '', 0) });
      }
      if (demo && p === '/api/demo/status' && req.method === 'GET') return json(200, { kiosk: !!tokenFrom(c, 'hub_device') });
      if (devReset && p === '/api/dev/reset' && req.method === 'POST') { await devReset(); return json(200, { ok: true }); }
      if (devReset && p === '/api/dev/tick' && req.method === 'POST') { const b = await body(req, MAX_BODY); return json(200, await devReset.tick(b)); }
      throw new HubError(404, 'not_found', 'Not found');
    } catch (e) {
      const status = e instanceof HubError ? e.status : 500;
      if (status === 500) console.error('[hub] internal error:', e && e.message);   // never logs request bodies
      // Clear the session cookie only when the session itself is gone (not for a wrong signing PIN or code).
      const extra = status === 401 && e instanceof HubError && ['no_session', 'expired', 'locked'].includes(e.code) && !['/api/login', '/api/passkey/login', '/api/passkey/options'].includes(url.pathname) ? { 'Set-Cookie': cookie('hub_session', '', 0) } : {};
      return json(status, { error: e instanceof HubError ? e.code : 'internal', message: e instanceof HubError ? e.message : 'Something went wrong' }, extra);
    }
  };
}
