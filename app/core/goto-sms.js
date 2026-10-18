// GoTo Connect text-message gateway for urgent safety alerts.
//
// Sends from the company's SMS-enabled GoTo number through the GoTo Messaging API and
// reports "pending" until GoTo's DELIVERY_STATUS webhook confirms delivery. The Hub never
// marks a text delivered on the send response alone.
//
// Configuration (Worker secrets / vars; nothing is hard-coded):
//   GOTO_CLIENT_ID, GOTO_CLIENT_SECRET   OAuth client created by a GoTo admin
//   GOTO_REFRESH_TOKEN                   from a one-time authorization by the GoTo user who owns the number
//   GOTO_OWNER_NUMBER                    the company number texts are sent from, E.164 (+18185551234)
//   GOTO_WEBHOOK_SECRET                  random value; the webhook URL is /api/hooks/goto/<secret>
//
// API details follow GoTo's published guides (Send SMS tutorial; Messaging API v2
// notifications). They must be re-checked against the live account in the test copy before
// any real alert depends on them.

export const GOTO_TOKEN_URL = 'https://authentication.logmeininc.com/oauth/token';
export const GOTO_SEND_URL = 'https://api.goto.com/messaging/v1/messages';
const DELIVERED_CODES = new Set([1000]);

export function makeGoToSms({ fetch, clientId, clientSecret, refreshToken, ownerNumber, tokenStore = null, now = () => Date.now() }) {
  if (!clientId || !clientSecret || !refreshToken || !/^\+\d{10,15}$/.test(String(ownerNumber || ''))) throw new Error('GoTo texting is not configured');
  let cached = null; // { token, expires }
  let currentRefresh = refreshToken;

  async function accessToken() {
    if (cached && cached.expires > now() + 60_000) return cached.token;
    if (tokenStore) { const stored = await tokenStore.get(); if (stored) currentRefresh = stored; }
    const res = await fetch(GOTO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${clientId}:${clientSecret}`) },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: currentRefresh }).toString()
    });
    if (!res.ok) throw new Error(`GoTo sign-in failed (${res.status})`);
    const j = await res.json();
    if (j.refresh_token && j.refresh_token !== currentRefresh) { currentRefresh = j.refresh_token; if (tokenStore) await tokenStore.set(currentRefresh); }
    cached = { token: j.access_token, expires: now() + (Number(j.expires_in) || 3600) * 1000 };
    return cached.token;
  }

  // The service calls sms(recipient, message) and accepts a promise.
  async function sms(recipient, message) {
    if (!recipient || !recipient.sms_phone) return { ok: false, retryable: false, detail: 'No mobile number on file' };
    const token = await accessToken();
    const res = await fetch(GOTO_SEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerPhoneNumber: ownerNumber, contactPhoneNumbers: [recipient.sms_phone], body: String(message).slice(0, 600) })
    });
    if (res.status === 401) { cached = null; return { ok: false, detail: 'GoTo rejected the sign-in (will retry)' }; }
    if (!res.ok) return { ok: false, retryable: res.status >= 500 || res.status === 429, detail: `GoTo refused the text (${res.status})` };
    const j = await res.json().catch(() => ({}));
    if (!j.id) return { ok: false, detail: 'GoTo accepted the request but returned no message id' };
    return { ok: true, pending: true, providerId: String(j.id), detail: 'Accepted by GoTo — waiting for delivery confirmation' };
  }
  return { sms, provider: 'goto' };
}

// Translate a GoTo notification (DELIVERY_STATUS event) into a delivery receipt for the service.
export function parseGoToReceipt(body) {
  const items = Array.isArray(body) ? body : [body];
  const out = [];
  for (const item of items) {
    const ev = item && (item.content || item.data || item);
    const status = ev && (ev.deliveryStatus || (ev.message && ev.message.deliveryStatus));
    const messageId = ev && (ev.messageId || (ev.message && ev.message.id));
    if (!status || !messageId) continue;
    const code = Number(status.code);
    out.push({ providerId: String(messageId), delivered: DELIVERED_CODES.has(code), detail: `${status.description || 'status'} (${code})`, retryable: status.retryable !== false });
  }
  return out;
}
