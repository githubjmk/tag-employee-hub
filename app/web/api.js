// Transport. Server mode uses an HttpOnly session cookie (and an HttpOnly
// device cookie on registered shop tablets). The browser demo plugs in
// window.HUB_LOCAL instead. Nothing private is written to web storage.
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const local = () => window.HUB_LOCAL || null;

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Hub-Request': '1' } : {}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  } catch { throw new ApiError(0, 'network', 'network'); }
  let data = null;
  try { data = await res.json(); } catch { /* fallthrough */ }
  if (!res.ok || !data) throw new ApiError(res.status, data && data.error || 'http', data && data.message || 'error');
  return data;
}

export const api = {
  config: () => local() ? Promise.resolve({ turnstileSiteKey: null, setupNeeded: false, demo: true }) : request('GET', '/api/config'),
  setup: (payload) => request('POST', '/api/setup', payload),
  setupRestart: (payload) => request('POST', '/api/setup/restart', payload),
  publicInfo: () => local() ? local().publicInfo() : request('GET', '/api/public'),
  roster: () => local() ? local().roster() : request('GET', '/api/kiosk/roster'),
  demoPeople: () => local() ? local().people() : request('GET', '/api/demo/people'),
  demoKiosk: (on) => local() ? local().kiosk(on) : request('POST', '/api/demo/kiosk', { on }),
  demoStatus: () => local() ? local().status() : request('GET', '/api/demo/status'),
  login: (payload) => local() ? local().login(payload) : request('POST', '/api/login', payload),
  logout: () => local() ? local().logout() : request('POST', '/api/logout', {}),
  call: (action, input) => local() ? local().call(action, input || {}) : request('POST', '/api/call/' + action, input || {}),
  async download(submissionId, format) {
    if (local()) return local().download(submissionId, format);
    const a = document.createElement('a');
    a.href = `/api/record/${encodeURIComponent(submissionId)}.${format}`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  },
  async attachmentSrc(id) {
    if (!local()) return `/api/attachment/${encodeURIComponent(id)}`;
    const a = await local().call('attachment.get', { attachmentId: id });
    return `data:${a.mime};base64,${a.dataBase64}`;
  }
};
