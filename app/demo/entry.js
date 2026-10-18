// Browser-only click-through demo of R1.1. Runs the SAME core service
// (authorization, signing, hashing, escalation, notification retries) as the
// Node and Cloudflare builds, against an in-memory SQLite (sql.js).
// Synthetic data only; nothing persists after the tab closes. The session and
// "shop tablet" tokens live in memory (the server builds use HttpOnly cookies).
import { createService, HubError } from '../core/service.js';
import { makeCrypto } from '../core/webcrypto.js';
import { seed, demoPeople, DEMO_NOW, PILOT_START_WEEK } from '../core/seed.js';
import { renderRecordHtml } from '../core/render.js';
import { ApiError } from '../web/api.js';

function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sqljsDb(SQL) {
  const d = new SQL.Database();
  d.exec('PRAGMA foreign_keys = ON');
  const norm = (p) => p.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  let depth = 0;
  return {
    exec: (sql) => { d.exec(sql); },
    run: (sql, p = []) => { const st = d.prepare(sql); try { st.bind(norm(p)); st.step(); } finally { st.free(); } return { changes: d.getRowsModified() }; },
    get: (sql, p = []) => { const st = d.prepare(sql); try { st.bind(norm(p)); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } },
    all: (sql, p = []) => { const st = d.prepare(sql); const rows = []; try { st.bind(norm(p)); while (st.step()) rows.push(st.getAsObject()); } finally { st.free(); } return rows; },
    tx(fn) {
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      d.exec('BEGIN IMMEDIATE'); depth = 1;
      try { const r = fn(); d.exec('COMMIT'); return r; }
      catch (e) { try { d.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
      finally { depth = 0; }
    }
  };
}

function switchableClock() {
  let t = new Date('2026-01-01T00:00:00Z'); let live = null;
  return {
    now: () => live ? new Date(live.base + (Date.now() - live.started)) : new Date(t),
    set: (d) => { if (live) live = { base: new Date(d).getTime(), started: Date.now() }; else t = new Date(d); },
    runFrom: (d) => { live = { base: new Date(d).getTime(), started: Date.now() }; },
    freeze: () => { if (live) { t = new Date(live.base + (Date.now() - live.started)); live = null; } },
    advance: (ms) => { if (live) live.base += ms; else t = new Date(t.getTime() + ms); }
  };
}

const toApi = (e) => e instanceof HubError ? new ApiError(e.status, e.code, e.message) : new ApiError(500, 'internal', 'Something went wrong');

function showRecord(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let box = document.getElementById('record-overlay');
  if (!box) {
    box = document.createElement('div'); box.id = 'record-overlay'; box.className = 'record-overlay';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Signed record copy');
    document.body.appendChild(box);
  }
  box.innerHTML = '';
  const bar = document.createElement('div'); bar.className = 'record-bar';
  const p = document.createElement('p'); p.textContent = 'Employee copy. In the server build this downloads as a file.';
  const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Close';
  btn.addEventListener('click', () => { box.hidden = true; });
  bar.append(p, btn);
  const body = document.createElement('div'); body.className = 'record-paper';
  for (const n of Array.from(doc.body.childNodes)) if (n.nodeName !== 'SCRIPT' && n.nodeName !== 'STYLE') body.appendChild(document.importNode(n, true));
  box.append(bar, body); box.hidden = false; btn.focus();
}

async function start() {
  const status = document.getElementById('boot');
  const SQL = await window.initSqlJs({ wasmBinary: b64ToBytes(window.__SQL_WASM_B64) });
  const db = sqljsDb(SQL);
  const clock = switchableClock();
  // Demo-only: fewer PBKDF2 iterations so the page starts quickly. Server builds use 100,000.
  const crypto = makeCrypto({ pepper: 'browser-demo-pepper-not-secret', iterations: 2000 });
  const service = createService({ db, crypto, clock, config: { demo: true, pilotStartWeek: PILOT_START_WEEK } });
  if (status) status.textContent = 'Signing seven weeks of sample reports…';
  await seed({ db, crypto, clock, service });
  clock.runFrom(DEMO_NOW);
  setInterval(() => service.tick().catch(() => {}), 15000);
  let token = null;                 // session: memory only
  let device = null;                // "this browser is the shop tablet": memory only
  const kioskToken = db.get("SELECT v FROM meta WHERE k='demo_device_token'").v;
  window.HUB_LOCAL = {
    people: () => demoPeople(db, crypto, clock.now()),
    async status() { return { kiosk: !!device }; },
    async publicInfo() { return service.publicInfo(); },
    async roster() { try { return service.kioskRoster(device); } catch (e) { throw toApi(e); } },
    async kiosk(on) { device = on ? kioskToken : null; return { ok: true, kiosk: !!on }; },
    async login(payload) {
      try { const r = await service.login({ ...payload, deviceToken: device || undefined }); token = r.token; return { ok: true, sharedDevice: r.sharedDevice, idleMinutes: r.idleMinutes, mustSetPin: r.mustSetPin }; }
      catch (e) { throw toApi(e); }
    },
    async logout() { const t = token; token = null; try { await service.logout(t); } catch { /* ignore */ } return { ok: true }; },
    async call(action, input) {
      try {
        const r = await service.call(token, action, input);
        if (action === 'device.register' && r && r.deviceToken) { device = r.deviceToken; const { deviceToken, ...rest } = r; return rest; }
        return r;
      } catch (e) { throw toApi(e); }
    },
    async download(id, fmt) {
      try {
        const rec = await service.call(token, 'survey.record', { submissionId: id });
        if (fmt === 'json') {
          const pre = `<pre class="json">${JSON.stringify(rec, null, 2).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
          showRecord(`<body>${pre}</body>`);
        } else showRecord(renderRecordHtml(rec));
      } catch (e) { throw toApi(e); }
    }
  };
  if (status) status.remove();
  await import('../web/app.js');
}
start().catch((e) => {
  const s = document.getElementById('boot');
  if (s) s.textContent = 'The demo could not start in this browser: ' + (e && e.message);
});
