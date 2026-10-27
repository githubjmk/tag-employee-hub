// TAG Employee Hub R1.2 — Weekly Report UI (vanilla JS modules, no build step).
// Two visible roles: Staff and Management. Permissions come from the server (session.me).
// Authorization is enforced on the server; the UI only hides what the server
// would refuse anyway.
import { STR } from './i18n.js';
import { api, ApiError } from './api.js';
// Branding (owner 2026-10-27): Innerspace Cases logo on top, "© The Armored Group" at the bottom.
const IS_LOGO_WHITE = '/innerspace-logo-white.png', IS_LOGO_NAVY = '/innerspace-logo-navy.png';
const copyright = () => html`<footer class="site-footer"><p>© ${new Date().getFullYear()} The Armored Group, Inc. ${t('rights')}</p></footer>`;
import qrcode from './qr.js';
import { passkeySupported, platformAvailable, pkHint, setPkHint, offerSkipped, skipOffer, methodName, cancelled, startRegister, finishRegister, passkeySignIn, prepareSignIn, isPhone, deviceGuess } from './passkey.js';

const TZ = 'America/Los_Angeles';
const root = document.getElementById('app');
const live = document.getElementById('live');

const fresh = () => ({ me: null, lang: 'en', tpl: null, consentText: null, supAck: null, seenStatement: null, survey: null, people: null, kiosk: null,
  idleTimer: null, lastActivity: Date.now(), autoOut: null, safetyResult: null, signinStep: 'pin', signinId: '', employees: null, pub: null, roster: undefined, next: null });
let S = fresh();

// ---------------------------------------------------------------- helpers
const t = (k) => (STR[S.lang] && STR[S.lang][k]) ?? STR.en[k] ?? k;
const L = (o) => o ? (o[S.lang] ?? o.en) : '';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const fmtVal = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmtVal).join('') : (v === false || v === null || v === undefined) ? '' : esc(v);
const html = (strings, ...vals) => raw(strings.reduce((o, s, i) => o + s + (i < vals.length ? fmtVal(vals[i]) : ''), ''));
const locale = () => (S.lang === 'es' ? 'es-US' : 'en-US');
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const fmtDate = (v, o = { month: 'short', day: 'numeric' }) => v ? new Intl.DateTimeFormat(locale(), { timeZone: isYmd(v) ? 'UTC' : TZ, ...o }).format(new Date(isYmd(v) ? v + 'T12:00:00Z' : v)) : '';
const fmtDT = (iso) => iso ? new Intl.DateTimeFormat(locale(), { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
const fmtTime = (iso) => iso ? new Intl.DateTimeFormat(locale(), { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
const has = (r) => S.me && S.me.roles.includes(r);
const anyRole = (...rs) => rs.some(has);
const isStaff = () => !!S.me && S.me.role === 'management';   // "staff" in older code = management screens
const surveyOpen = () => !S.me || !S.me.surveyWindow || S.me.surveyWindow.openNow;
const closedNote = () => html`<div class="alert-soft closed-note" role="note"><strong>${t('closed_title')}.</strong> ${t('closed_body')}${S.me.surveyWindow && S.me.surveyWindow.nextOpen ? html` ${t('closed_next')}: <strong>${fmtDT(S.me.surveyWindow.nextOpen)}</strong>.` : ''} ${t('closed_safety')}</div>`;
const can = (perm) => !!S.me && (S.me.permissions || []).includes(perm);
const announce = (m) => { live.textContent = ''; setTimeout(() => { live.textContent = m; }, 30); };
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
const mondayOf = (iso) => { const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: TZ })); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isDemo = () => !!((S.config && S.config.demo) || (S.pub && S.pub.demo) || (S.me && S.me.demo));
// "in 2 h 15 min" until a moment, measured against the server's clock.
function untilText(iso, serverNow) {
  const ms = new Date(iso) - new Date(serverNow || Date.now());
  if (!(ms > 0)) return '';
  const min = Math.round(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (min < 60) return t('in_min').replace('{n}', Math.max(1, min));
  if (h < 24) return t('in_hm').replace('{h}', h).replace('{m}', min % 60);
  return d === 1 ? t('in_day') : t('in_days').replace('{d}', d);
}
const isStandalone = () => { try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (/Macintosh/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);
let installEvent = null;   // Android/Chrome: the browser's own "install app" prompt, kept for the button
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; const b = document.querySelector('[data-act=install]'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { document.querySelector('.install-tip')?.remove(); });
const installSkipped = () => { try { return Date.now() - Number(localStorage.getItem('hub_install_skip') || 0) < 30 * 86400000; } catch { return false; } };
const SHARE_ICON = raw('<svg class="ic inline-ic" viewBox="0 0 24 24" aria-label="Share" role="img"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
// One-time tip on phones: add the Hub to the home screen so it opens like an app.
function installTip() {
  if (!isPhone() || isStandalone() || installSkipped() || S.roster || window.HUB_LOCAL) return '';
  const chromeIOS = isIOS() && /CriOS/.test(navigator.userAgent);
  const how = isIOS() ? (chromeIOS ? t('install_ios_chrome') : t('install_ios')) : (installEvent ? t('install_android') : t('install_android_menu'));
  const [a, b] = how.split('{share}');
  return html`<section class="card install-tip"><img src="/icon-192.png" alt="" width="56" height="56" class="install-icon"><div class="grow"><h2 class="h3">${t('install_title')}</h2>
    <p>${a}${b !== undefined ? html`${SHARE_ICON}${b}` : ''}</p>
    <div class="row wrap">${!isIOS() ? html`<button class="btn primary" data-act="install" ${installEvent ? '' : raw('hidden')}>${t('install_btn')}</button>` : ''}<button class="btn-quiet" data-act="install-later">${t('install_later')}</button></div></div></section>`;
}
// Passkey wording for this device ("Face ID", "fingerprint", "Windows Hello").
const tm = (k) => t(k).replaceAll('{m}', methodName(S.lang));
// Face ID is offered only on a person's own device: never on a registered shop tablet.
const pkReadyFor = (eid) => { const h = pkHint(); return !!h && h.id === eid && passkeySupported() && !S.roster && !(S.me && S.me.deviceId); };
// Setting up Face ID: (1) PIN (+ authenticator code for management) -> (2) "Use Face ID".
const pkSetupBlock = () => html`<div class="pk-setup" id="pk-setup">${S.pkReg
  ? html`<button class="btn primary" data-act="pk-create">${icon('lock')} ${tm('pk_offer_yes')}</button><p class="hint">${tm('pk_step2')}</p>`
  : html`<form data-form="pkunlock" novalidate class="pk-unlock"><label class="field"><span>${t('pk_confirm_pin')}</span><input name="signPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required></label>
    ${S.me && S.me.elevated ? html`<label class="field"><span>${t('signin_code')}</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>` : ''}
    <button class="btn primary" type="submit">${t('next')}</button></form>`}<div class="pk-out" role="status"></div></div>`;
const rerenderPkSetup = (msg) => { const b = document.getElementById('pk-setup'); if (!b) return; b.outerHTML = String(pkSetupBlock()); if (msg) { const o = document.querySelector('#pk-setup .pk-out'); if (o) o.textContent = msg; } };
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function errMsg(e) {
  if (e instanceof ApiError) {
    if (e.code === 'network') return navigator.onLine === false ? t('offline') : t('err_generic');
    if (e.code === 'device_required') return t('device_required');
    return e.message && e.message !== 'error' ? e.message : t('err_generic');
  }
  return t('err_generic');
}

// A response that arrives after the user moved on is discarded.
let navSeq = 0;
class Stale extends Error {}
async function call(action, input) {
  const my = navSeq;
  let r;
  try { r = await api.call(action, input); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) { await wipe(e.code === 'locked' ? 'Too many wrong PINs. You have been signed out.' : e.message); throw e; }
    if (e instanceof ApiError && e.code === 'must_set_pin') { go('#/setpin'); throw new Stale(); }
    if (my !== navSeq) throw new Stale();
    throw e;
  }
  if (my !== navSeq) throw new Stale();
  return r;
}
const quiet = (e) => e instanceof Stale || (e instanceof ApiError && e.status === 401);

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  check: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 12l3 3 5-6"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.6 3.5-5.5 6.5-5.5s5.5 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5c2.6.2 4.4 1.9 5.2 4.7"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  q: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17v.5"/>'
};
const icon = (n) => ICONS[n] ? raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[n]}</svg>`) : '';

// ---------------------------------------------------------------- shell
function navItems() {
  if (!S.me) return [];
  if (!isStaff()) return [['#/home', 'home', t('nav_home')], ['#/checkin', 'check', t('nav_survey')], ['#/safety', 'alert', t('nav_safety')], ['#/more', 'more', t('nav_more')]];
  const items = [['#/dash', 'chart', t('nav_dash')], ['#/team', 'team', t('nav_review')], ['#/safety', 'alert', 'Safety']];
  if (can('accounts.manage') || can('accounts.pinReset.team')) items.push(['#/accounts', 'lock', t('nav_accounts')]);
  items.push(['#/more', 'more', t('nav_more')]);
  return items;
}
function bottomItems() { return navItems(); }

function shell(active, body) {
  // Staff see what needs action on Home, so no count badge for them; management keep it (safety alerts).
  const unseen = S.me && isStaff() ? S.me.unseenAlerts : 0;
  const tab = ([h, ic, label]) => html`<a href="${h}" class="${active === h ? 'on' : ''}" ${active === h ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${label}</span>${h === '#/more' && unseen ? html`<b class="badge" aria-label="${unseen} unseen">${unseen}</b>` : ''}</a>`;
  return html`
  <a class="skip" href="#main">${t('skip')}</a>
  <header class="topbar">
    <a class="brand" href="#/home" aria-label="Innerspace Cases ${t('portal_name')} — ${t('nav_home')}"><img class="brand-logo" src="${IS_LOGO_WHITE}" alt="Innerspace Cases" width="337" height="124"></a>
    ${isDemo() ? html`<span class="demo-badge"><span class="long">${t('demo')}</span><span class="short">DEMO</span></span>` : ''}
    <div class="top-actions">
      <button class="lang" data-act="lang" aria-label="${S.lang === 'en' ? 'Cambiar a español' : 'Switch to English'}">${S.lang === 'en' ? 'ES' : 'EN'}</button>
      ${S.me ? html`<button class="btn-quiet signout" data-act="signout" aria-label="${t('signout')}">${icon('logout')}<span class="lbl">${t('signout')}</span></button>` : html`<a class="btn-quiet signin-link" href="#/login">${icon('lock')}<span class="lbl">${t('signin_btn')}</span></a>`}
    </div>
  </header>
  ${S.me && S.me.sharedDevice ? html`<div class="shared-strip">${icon('lock')} ${t('shared_on')} · ${S.me.employee.name}</div>` : ''}
  <div class="layout">
    <nav class="sidenav" aria-label="Main">${navItems().map(tab)}</nav>
    <main id="main" tabindex="-1">${body}${copyright()}</main>
  </div>
  <nav class="tabbar" aria-label="Main">${bottomItems().map(tab)}</nav>
  <div id="idle" class="idle" hidden role="alertdialog" aria-label="${t('idle_warn')}"><p>${t('idle_warn')} <strong id="idle-count"></strong></p><button class="btn" data-act="stay">${t('stay')}</button></div>`;
}

function applyCssVars(scope) {
  scope.querySelectorAll('[data-css-p],[data-css-h]').forEach(el => {
    for (const k of ['p', 'h']) { const v = el.getAttribute('data-css-' + k); if (v !== null) el.style.setProperty('--' + k, v); }
  });
}
function render(active, body, focusSel) {
  root.innerHTML = String(shell(active, body));
  applyCssVars(root);
  hydrateImages(root);
  const h1 = root.querySelector(focusSel || 'main h1') || root.querySelector('main');
  h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: false });
  window.scrollTo(0, 0);
}
function hydrateImages(scope) {
  scope.querySelectorAll('img[data-att]').forEach(async img => { try { img.src = await api.attachmentSrc(img.dataset.att); } catch { img.alt = 'Could not load photo'; } });
}
const loadingView = (a) => render(a, html`<div class="loading" role="status">${t('loading')}</div>`);
const errorView = (a, e) => render(a, html`<div class="empty" role="alert"><h1>${t('err_generic')}</h1><p>${errMsg(e)}</p><button class="btn" data-act="retry">${t('continue')}</button></div>`);
const chip = (state, label) => html`<span class="chip c-${state}">${label || t('st_' + state)}</span>`;
const sChip = (s) => chip({ new: 'open', acknowledged: 'open', in_progress: 'open', pending_verification: 'warn', closed: 'submitted' }[s], t('s_' + s));
const prioChip = (p) => html`<span class="chip p-${p}">${p}</span>`;

// ---------------------------------------------------------------- sign-in
function keypad(target) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];
  return html`<div class="keypad" role="group" aria-label="PIN keypad">${keys.map(k => html`<button type="button" class="key ${k.length > 1 ? 'fn' : ''}" data-key="${k}" data-target="${target}" aria-label="${k === 'del' ? 'Delete' : k === 'clear' ? 'Clear' : k}">${k === 'del' ? '⌫' : k === 'clear' ? 'C' : k}</button>`)}</div>`;
}

// "Shared tablet" is a per-browser preference (not a secret), remembered for convenience.
// Default: unticked on a phone (it is the person's own), ticked on tablets and computers.
const sharedPref = () => { try { const v = localStorage.getItem('hub_shared'); return v === null ? !isPhone() : v !== '0'; } catch { return !isPhone(); } };
const setSharedPref = (on) => { try { localStorage.setItem('hub_shared', on ? '1' : '0'); } catch { /* ignore */ } };

// Cloudflare Turnstile (bot check) on the sign-in form, only when the server has it configured.
// The box must NOT have id="turnstile": browsers expose element ids as window properties,
// which would hide Cloudflare's window.turnstile object (bug found on the live test copy).
let turnstileWidget = null;
const tsReady = () => !!(window.turnstile && typeof window.turnstile.render === 'function');
function mountTurnstile(siteKey) {
  const render = () => {
    const box = root.querySelector('#ts-box'); if (!box || box.dataset.rendered) return;
    try {
      turnstileWidget = window.turnstile.render(box, { sitekey: siteKey, theme: 'light', appearance: 'interaction-only', language: S.lang === 'es' ? 'es' : 'en' });
      box.dataset.rendered = '1';
    } catch (e) {
      box.textContent = 'The "verify you are human" check did not load. Reload the page; if it keeps happening, tell management.';
    }
  };
  turnstileWidget = null;
  if (tsReady()) return render();
  let sc = document.getElementById('ts-script');
  if (!sc) {
    sc = document.createElement('script'); sc.id = 'ts-script'; sc.async = true;
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    sc.onerror = () => { const box = root.querySelector('#ts-box'); if (box) box.textContent = 'The "verify you are human" check could not load. Check the internet connection and reload.'; };
    document.head.appendChild(sc);
  }
  sc.addEventListener('load', render, { once: true });
}

async function loginView(msg) {
  document.body.classList.add('plain');
  try { if (!S.config) S.config = await api.config(); } catch { S.config = { turnstileSiteKey: null, setupNeeded: false }; }
  if (S.config.setupNeeded) return setupView(msg);
  try { if (!S.people) S.people = await api.demoPeople(); } catch { S.people = []; }
  const roster = await rosterOrNull();
  const step = S.signinStep;
  const pkLogin = !roster && passkeySupported() ? (pkHint() || ((await platformAvailable()) ? { id: '', name: '' } : null)) : null;
  root.innerHTML = String(html`
  <main id="main" class="login" tabindex="-1"><div class="login-card">
    <div class="login-brand logo-top"><img class="login-logo" src="${IS_LOGO_NAVY}" alt="Innerspace Cases" width="337" height="124"><div><p class="eyebrow">Innerspace Cases</p><h1>${t('portal_name')}</h1></div></div>
    ${msg ? html`<p class="alert" role="alert">${msg}</p>` : ''}
    ${pkLogin ? html`<button type="button" class="btn primary wide pk-btn" data-act="pk-login">${icon('lock')} ${t('pk_signin')} ${methodName(S.lang)}${pkLogin.name ? html` <small>(${pkLogin.name})</small>` : ''}</button><p class="or-line"><span>${t('pk_or')}</span></p>` : ''}
    <form data-form="login" novalidate>
      ${roster && roster.people.length ? html`<p class="field-label">${t('who_tap')}</p><div class="name-grid">${roster.people.map(x => html`<button type="button" class="name-btn ${x.id === S.signinId ? 'on' : ''}" data-act="pick" data-id="${x.id}">${x.name}</button>`)}</div>` : ''}
      <label class="field"><span>${t('signin_id')}</span><input name="employeeId" autocomplete="username" autocapitalize="characters" spellcheck="false" required value="${S.signinId}" placeholder="E-104"></label>
      <label class="field"><span>${t('signin_pin')}</span><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" required></label>
      ${keypad('pin')}
      ${step !== 'totp' ? html`<p class="hint">${t('signin_mgmt_hint')}</p>` : ''}
      ${step === 'totp' ? html`<label class="field"><span>${t('signin_code')}</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required aria-describedby="totphelp"></label><p class="hint" id="totphelp">${t('signin_code_help')}</p>` : ''}
      <label class="check"><input type="checkbox" name="sharedDevice" ${sharedPref() ? raw('checked') : ''}><span>${t('signin_shared')}</span></label>
      ${S.config.turnstileSiteKey ? html`<div id="ts-box" class="turnstile"></div>` : ''}
      <button class="btn primary wide" type="submit">${t('signin_btn')}</button>
    </form>
    <p class="hint">${t('signin_forgot')}</p>
    ${S.config.setupRecoverable ? html`<p class="hint"><button type="button" class="link" data-act="restart-setup">Lost the setup screen before signing in? Start over with the setup code</button></p>` : ''}
    <p><a href="#/home">${icon('back')} ${t('portal_back')}</a></p>
    <button class="lang standalone" data-act="lang">${S.lang === 'en' ? 'Español' : 'English'}</button>
    ${S.people.length ? html`<details class="demo-panel" open><summary><strong>${t('demo')}</strong> — sample people and their PINs</summary>
      <p>Invented people only. Tap a person to fill in their ID. Management accounts also need the 6-digit code shown (it changes every 30 seconds).</p>
      <div class="people">${S.people.map(p => html`<button type="button" class="person ${p.id === S.signinId ? 'on' : ''} ${p.status !== 'active' ? 'muted' : ''}" data-act="pick" data-id="${p.id}">
        <span class="pname">${p.name}</span><span class="prole">${p.id} · ${p.visibleRole === 'management' ? 'Management' : 'Staff'}${p.status !== 'active' ? ' · deactivated' : ''}</span>
        <span class="pcred">${p.pin ? 'PIN ' + p.pin : p.tempPin ? 'Temporary PIN ' + p.tempPin : ''}${p.totp ? ' · code ' + p.totp : ''}</span></button>`)}</div>
    </details>` : ''}
  </div>${copyright()}</main>`);
  root.querySelector(msg ? '.alert' : '#main').focus();
  if (S.config.turnstileSiteKey) mountTurnstile(S.config.turnstileSiteKey);
  if (pkLogin) prepareSignIn();
}

// One-time setup of the first (owner) account on an empty production database.
function setupView(msg, result, restart = false) {
  root.innerHTML = String(html`<main id="main" class="login" tabindex="-1"><div class="login-card">
    <div class="login-brand logo-top"><img class="login-logo" src="${IS_LOGO_NAVY}" alt="Innerspace Cases" width="337" height="124"><div><p class="eyebrow">First-time setup</p><h1>${t('portal_name')}</h1></div></div>
    ${result ? html`<div class="code-box" role="status">${onceWarning()}
        <p><strong>1.</strong> Your employee ID: <strong>${result.employeeId}</strong></p>
        <p><strong>2.</strong> Your temporary PIN (it goes in the PIN box):</p><p class="code-row"><span class="code">${result.tempPin}</span>${copyBtn(result.tempPin)}</p>
        <p><strong>3.</strong> Add the Hub to your phone's authenticator app:</p>${authBlock(result.mfa)}
        <p><strong>4.</strong> Tap <em>Go to sign-in</em>: enter your employee ID and the temporary PIN, tap Sign in, then type the 6-digit code from your phone in the box that appears. You then choose your own PIN.</p></div>
        <button class="btn primary wide" data-act="setup-done">Go to sign-in</button>`
      : restart ? html`${msg ? html`<p class="alert" role="alert">${msg}</p>` : ''}<p>Gives the first account a new temporary PIN and a new authenticator secret. This only works until someone has finished signing in.</p>
      <form data-form="restartsetup" novalidate><label class="field"><span>Setup code (from the Terminal)</span><input name="code" type="password" autocomplete="off" required></label>
        <button class="btn primary wide" type="submit">Start over</button></form><p><button type="button" class="link" data-act="setup-done">Back to sign-in</button></p>`
      : html`${msg ? html`<p class="alert" role="alert">${msg}</p>` : ''}<p>Creates your own full-access management account. This screen works once, with the setup code from the server configuration, and then switches off.</p>
      <form data-form="firstsetup" novalidate>
        <label class="field"><span>Setup code</span><input name="code" type="password" autocomplete="off" required></label>
        <label class="field"><span>Your employee ID</span><input name="employeeId" value="E-101" maxlength="20" autocapitalize="characters" required></label>
        <label class="field"><span>Your name</span><input name="name" maxlength="80" required autocomplete="name"></label>
        <label class="field"><span>Mobile number for urgent safety texts (optional)</span><input name="smsPhone" inputmode="tel" autocomplete="tel"></label>
        <button class="btn primary wide" type="submit">Create my account</button></form>`}
  </div>${copyright()}</main>`);
  root.querySelector(msg ? '.alert' : '#main').focus();
}

// Staff land straight on this week's survey when it is open; management land on the dashboard.
async function afterSignIn() {
  const next = S.next; S.next = null;
  const NEXT = { safety: '#/safety/new', checkin: '#/checkin', dash: '#/dash' };
  if (next && NEXT[next]) return go(isStaff() && next === 'checkin' ? '#/dash' : NEXT[next]);
  if (isStaff()) return go('#/dash');
  if (!surveyOpen()) return go('#/home');
  try {
    const h = await call('home', {});
    const open = h.surveys.slice().reverse().find(x => ['open', 'missing'].includes(x.state));
    if (open) return go('#/checkin/' + open.assignmentId);
  } catch (e) { if (quiet(e)) return; }
  return go('#/home');
}

async function loadMe() {
  S.me = await call('session.me', {});
  if (!S.tpl && !S.me.mustSetPin) {
    const r = await call('survey.template', {});
    S.tpl = r.template; S.consentText = r.consent; S.supAck = r.supervisorAck; S.seenStatement = r.seenStatement;
  }
  startIdleWatch();
}
async function refreshMe() { try { S.me = await api.call('session.me', {}); } catch { /* ignore */ } }

async function wipe(message) {
  stopIdleWatch(); clearInterval(S.autoOut);
  try { await api.logout(); } catch { /* ignore */ }
  const { lang, people } = S;
  S = fresh(); S.lang = lang; S.people = people;
  root.innerHTML = '';
  history.replaceState(null, '', '#/home');
  await portalView(message);
}

// Idle sign-out mirrors the server policy (the server is authoritative).
function startIdleWatch() {
  stopIdleWatch();
  const limit = (S.me.idleMinutes || 5) * 60000, warn = Math.max(limit - 60000, limit * 0.8);
  S.lastActivity = Date.now();
  S.idleTimer = setInterval(() => {
    const idle = Date.now() - S.lastActivity;
    const box = document.getElementById('idle');
    if (idle >= limit) return wipe();
    if (box) { box.hidden = idle < warn; const c = document.getElementById('idle-count'); if (c) c.textContent = Math.ceil((limit - idle) / 1000) + 's'; }
  }, 1000);
}
function stopIdleWatch() { clearInterval(S.idleTimer); S.idleTimer = null; }
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));

function setPinView(msg) {
  document.body.classList.add('plain');
  root.innerHTML = String(html`<main id="main" class="login" tabindex="-1"><div class="login-card">
    <h1>${t('setpin_title')}</h1><p>${t('setpin_help')}</p>
    ${msg ? html`<p class="alert" role="alert">${msg}</p>` : ''}
    <form data-form="setpin" novalidate>
      <label class="field"><span>${t('setpin_new')}</span><input id="np" name="newPin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" required></label>
      <label class="field"><span>${t('setpin_confirm')}</span><input id="cp" name="confirmPin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" required></label>
      <button class="btn primary wide" type="submit">${t('setpin_btn')}</button>
    </form><button class="btn-quiet" data-act="signout">${t('signout')}</button></div>${copyright()}</main>`);
  root.querySelector('h1').setAttribute('tabindex', '-1'); root.querySelector(msg ? '.alert' : 'h1').focus();
}

// ---------------------------------------------------------------- open portal (no sign-in needed)
// Owner decision 2026-10-15: the portal opens without a PIN. The weekly report asks for the
// PIN once, when signing. Past reports, safety reports and management screens need the PIN.
async function publicInfo() { if (!S.pub) S.pub = await api.publicInfo(); return S.pub; }
async function loadConfig() { try { if (!S.config) S.config = await api.config(); } catch { S.config = { turnstileSiteKey: null, setupNeeded: false }; } return S.config; }
// The tap-your-name list exists only on registered shop tablets (the server refuses it elsewhere).
async function rosterOrNull() { if (S.roster === undefined) { try { S.roster = await api.roster(); } catch { S.roster = null; } } return S.roster; }
// On a personal phone the employee ID (not a secret) is remembered so it is typed once.
const lastId = () => { try { return localStorage.getItem('hub_last_id') || ''; } catch { return ''; } };
const setLastId = (v) => { try { localStorage.setItem('hub_last_id', v); } catch { /* ignore */ } };

async function portalView(msg) {
  document.body.classList.remove('plain');
  await loadConfig();
  if (S.config.setupNeeded) return setupView();
  let p;
  try { p = await publicInfo(); } catch (e) { return render('#/home', html`<div class="empty" role="alert"><h1>${t('err_generic')}</h1><p>${errMsg(e)}</p><button class="btn" data-act="retry">${t('continue')}</button></div>`); }
  const w = p.surveyWindow;
  const pk = pkHint() && passkeySupported() && !(await rosterOrNull()) ? pkHint() : null;
  render('#/home', html`<div class="portal-public">
    ${msg ? html`<p class="alert" role="alert">${msg}</p>` : ''}
    <section class="portal-hero"><p class="eyebrow">Innerspace Cases · ${fmtDate(p.now, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1>${t('portal_name')}</h1><p class="hero-sub">${t('portal_sub')}</p><span class="gold-rule" aria-hidden="true"></span></section>
    ${pk ? html`<section class="card pk-card"><p class="pk-hello">${t('pk_hello')}, <strong>${pk.name || pk.id}</strong></p>
      <button class="btn primary wide pk-btn" data-act="pk-login">${icon('lock')} ${t('pk_signin')} ${methodName(S.lang)}</button>
      <p><button type="button" class="link" data-act="pk-forget">${t('pk_forget')}</button></p></section>` : ''}
    <div class="big-actions">
      ${w.openNow ? html`<a class="big-action primary" href="#/r">${icon('check')}<span><strong>${t('home_survey')}</strong><small>${t('week_of')} ${fmtDate(p.week.start)} · ${pk ? tm('portal_survey_sub_pk') : t('portal_survey_sub')}</small></span></a>`
        : html`<div class="big-action waiting">${icon('clock')}<span><strong>${t('home_survey')}</strong><small>${t('closed_title')} · ${t('closed_next')} <b>${fmtDT(w.nextOpen)}</b> · ${untilText(w.nextOpen, p.now)}</small></span></div>`}
      <a class="big-action safety" href="#/login?next=safety">${icon('alert')}<span><strong>${t('home_safety')}</strong><small>${t('home_safety_sub')}</small></span></a>
      <a class="big-action" href="#/login?next=checkin">${icon('clock')}<span><strong>${t('home_history')}</strong><small>${t('home_history_sub')}</small></span></a>
    </div>
    ${installTip()}
    ${p.links.length ? html`<h2 class="portal-section-title">${t('links')}</h2><div class="portal-tiles">${p.links.map(l => html`<a class="portal-tile" href="${l.url}" target="_blank" rel="noopener noreferrer">${icon('ext')}<strong>${L(l.label)}</strong><small>${l.note}</small><span class="sr">(${t('opens_new')})</span></a>`)}</div>` : ''}
    <p class="portal-mgmt"><a href="#/login?next=dash">${icon('lock')} ${t('portal_mgmt')}</a></p>
    ${p.demo ? await demoPeopleNote() : ''}
  </div>`, msg ? '.alert' : 'main h1');
  if (pk) prepareSignIn();
}

// Demo/test copy only: show the invented people and their PINs so the open flow can be tried.
async function demoPeopleNote() {
  try { if (!S.people) S.people = await api.demoPeople(); } catch { S.people = []; }
  if (!S.people.length) return '';
  return html`<details class="demo-panel"><summary><strong>${t('demo')}</strong> — sample people and their PINs</summary>
    <p>Invented people only. Use an ID and PIN below in the weekly report.</p>
    <div class="people">${S.people.filter(x => x.status === 'active').map(x => html`<div class="person"><span class="pname">${x.name}</span><span class="prole">${x.id} · ${x.visibleRole === 'management' ? 'Management' : 'Staff'}</span><span class="pcred">${x.pin ? 'PIN ' + x.pin : x.tempPin ? 'Temporary PIN ' + x.tempPin : ''}</span></div>`)}</div></details>`;
}

// Weekly report without signing in first: who are you -> questions -> PIN once to sign.
async function quickReport() {
  await loadConfig();
  const p = await publicInfo();
  if (!p.surveyWindow.openNow) return portalView();
  if (!S.survey || !S.survey.quick) {
    S.survey = { quick: true, who: null, tpl: p.template, week: p.week, answers: {}, step: -1, error: null };
    const roster = await rosterOrNull(), h = pkHint();
    if (!roster && h && passkeySupported()) { S.survey.who = { id: h.id, name: h.name || null }; S.survey.step = 0; }
  }
  if (S.survey.step < 0) return renderWho(await rosterOrNull());
  renderSurvey();
}
function renderWho(roster) {
  const sv = S.survey;
  render('#/checkin', html`<div class="flow"><h1>${t('who_title')}</h1>
    ${sv.error ? html`<p class="alert" role="alert">${sv.error}</p>` : ''}
    ${roster && roster.people.length
      ? html`<p class="lede">${t('who_tap')}</p><div class="name-grid big">${roster.people.map(x => html`<button type="button" class="name-btn" data-act="who" data-id="${x.id}" data-name="${x.name}">${x.name}</button>`)}</div>`
      : html`<form data-form="who" novalidate><label class="field"><span>${t('signin_id')}</span><input name="employeeId" autocomplete="username" autocapitalize="characters" spellcheck="false" required value="${sv.who ? sv.who.id : lastId()}" placeholder="E-104"></label>
          <p class="hint">${t('who_remember')}</p><button class="btn primary wide" type="submit">${t('next')}</button></form>`}
    <div class="flow-nav static"><a class="btn" href="#/home">${t('back')}</a></div></div>`);
}
function chooseWho(id, name) {
  const sv = S.survey; if (!sv || !sv.quick) return;
  const eid = String(id || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(eid)) { sv.error = t('who_bad_id'); return renderWho(S.roster); }
  sv.who = { id: eid, name: name || null }; sv.error = null; sv.step = 0; sv.signedIn = false; sv.needTotp = false; sv.mustSetPin = false;
  renderSurvey();
}
function quickSignForm(sv) {
  const who = sv.who, c = S.pub.consent;
  return html`<form data-form="qsign" novalidate class="card emphasis">
    <p class="signing-as">${t('sign_as')} <strong>${who.name || who.id}</strong>${who.name ? html` (${who.id})` : ''} <button type="button" class="link" data-act="quick-who">${t('not_you')}</button></p>
    <div class="consent-text"><p class="eyebrow">${t('esign')} · ${c.version}</p><p>${L(c.text)}</p></div>
    <label class="check"><input type="checkbox" name="affirm" required ${sv.affirm ? raw('checked') : ''}><span>${t('sign_affirm_consent')}</span></label>
    ${pkReadyFor(who.id) && !sv.mustSetPin && !sv.usePin ? pkSignButtons(sv) : html`${sv.mustSetPin ? html`<p class="alert-soft" role="note">${t('quick_new_pin')}</p>
        <label class="field"><span>${t('setpin_new')}</span><input id="np" name="newPin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" required></label>
        <label class="field"><span>${t('setpin_confirm')}</span><input id="cp" name="confirmPin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" required></label>`
      : html`<label class="field"><span>${t('sign_pin')}</span><input id="signpin" name="signPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required></label>${keypad('signpin')}`}
    ${sv.needTotp ? html`<label class="field"><span>${t('signin_code')}</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><p class="hint">${t('signin_code_help')}</p>` : ''}
    ${S.config && S.config.turnstileSiteKey && !sv.signedIn ? html`<div id="ts-box" class="turnstile"></div>` : ''}
    ${sv.error ? html`<p class="alert" role="alert">${sv.error}</p>` : ''}
    <button class="btn primary wide" type="submit" data-submit>${t('sign_submit')}</button>`}
  </form>`;
}
// "Sign with Face ID" (PIN as a fallback link). The approval covers exactly the answers shown.
const pkSignButtons = (sv) => html`${sv.error ? html`<p class="alert" role="alert">${sv.error}</p>` : ''}
  <button type="button" class="btn primary wide pk-btn" data-act="pk-sign">${icon('lock')} ${t('pk_sign')} ${methodName(S.lang)}</button>
  <p class="pk-alt"><button type="button" class="link" data-act="pk-usepin">${t('pk_use_pin')}</button></p>`;
// Exactly what the Face ID approval covers (the server recomputes it from the report being signed).
const pkContent = (sv) => ({ weekId: sv.week.weekId, answers: sv.answers, language: S.lang, esignConsent: sv.quick ? true : !S.me.consent });
async function pkSignSubmit(btn) {
  const sv = S.survey, form = btn.closest('form');
  sv.affirm = form.elements.affirm.checked;
  if (!sv.affirm) { sv.error = sv.quick || !S.me.consent ? t('sign_affirm_consent') : t('sign_affirm'); return renderSurvey(); }
  const eid = sv.quick ? sv.who.id : S.me.employee.id;
  if (!sv.quick) clearTimeout(saveTimer);
  btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = t('submitting');
  sv.submitting = true;
  try {
    const content = pkContent(sv);
    const r = await passkeySignIn({ purpose: 'sign', action: 'survey.submit', content, expectEmployeeId: eid });
    S.me = await api.call('session.me', {});
    if (S.me.consent && S.me.consent.choice === 'paper') throw new ApiError(409, 'paper_chosen', t('paper_chosen'));
    let assignmentId = sv.assignmentId;
    if (sv.quick) {
      const h = await api.call('home', {});
      const mine = h.surveys.find(x => x.week.weekId === sv.week.weekId);   // only the week shown on screen
      if (!mine || !['open', 'missing'].includes(mine.state)) { S.survey = null; await loadMe(); return go(mine && mine.submissionId ? '#/record/' + mine.submissionId : '#/home'); }
      assignmentId = mine.assignmentId;
    }
    sv.idem = sv.idem || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    const { weekId, ...fields } = content;
    const res = await api.call('survey.submit', { assignmentId, ...fields, affirm: true, idempotencyKey: sv.idem, signTicket: r.signTicket });
    S.survey = null;
    await loadMe();
    go('#/record/' + res.submissionId + '?new=1');
  } catch (e) {
    sv.submitting = false;
    if (cancelled(e)) sv.error = t('pk_cancelled');
    else {
      sv.error = errMsg(e);
      if (e instanceof ApiError && ['passkey_unknown', 'passkey_other_person'].includes(e.code)) { if (e.code === 'passkey_unknown') setPkHint(null); sv.usePin = true; }
    }
    renderSurvey(); announce(sv.error);
  }
}
async function quickSubmit(form, btn) {
  const sv = S.survey, f = form.elements;
  sv.affirm = f.affirm.checked;
  if (!sv.affirm) { sv.error = t('sign_affirm'); return renderSurvey(); }
  if (!sv.mustSetPin && !/^\d{6,12}$/.test(f.signPin.value)) { sv.error = t('sign_pin'); return renderSurvey(); }
  btn.disabled = true; btn.textContent = t('submitting'); btn.setAttribute('aria-busy', 'true');
  let signPin = sv.mustSetPin ? f.newPin.value : f.signPin.value;
  try {
    if (!sv.signedIn) {
      const turnstileToken = turnstileWidget !== null && tsReady() ? window.turnstile.getResponse(turnstileWidget) : undefined;
      // A phone is the person's own; a tablet or computer may be shared (short session, auto sign-out).
      const r = await api.login({ employeeId: sv.who.id, pin: signPin, totp: f.totp ? f.totp.value : undefined, sharedDevice: !!S.roster || !isPhone(), turnstileToken });
      sv.signedIn = true; sv.needTotp = false;
      if (r.mustSetPin) { sv.mustSetPin = true; sv.error = null; return renderSurvey(); }
    } else if (sv.mustSetPin) {
      await api.call('auth.setPin', { newPin: f.newPin.value, confirmPin: f.confirmPin.value });
      sv.mustSetPin = false;
    }
    S.me = await api.call('session.me', {});
    if (S.me.consent && S.me.consent.choice === 'paper') throw new ApiError(409, 'paper_chosen', t('paper_chosen'));
    const h = await api.call('home', {});
    const mine = h.surveys.find(x => x.week.weekId === sv.week.weekId);   // only the week shown on screen
    const open = mine && ['open', 'missing'].includes(mine.state) ? mine : null;
    if (!open) {
      await loadMe();
      return go(mine && mine.submissionId ? '#/record/' + mine.submissionId : '#/home');
    }
    sv.idem = sv.idem || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    const res = await api.call('survey.submit', { assignmentId: open.assignmentId, answers: sv.answers, signPin, affirm: true, esignConsent: true, language: S.lang, idempotencyKey: sv.idem });
    if (!S.roster) setLastId(sv.who.id);
    S.survey = null;
    await loadMe();
    go('#/record/' + res.submissionId + '?new=1');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'totp_required') { sv.needTotp = true; sv.error = t('signin_code_help'); }
    else sv.error = errMsg(e);
    renderSurvey(); announce(sv.error);
  }
}

// ---------------------------------------------------------------- employee home
async function homeView() {
  if (isStaff()) return go('#/dash');
  loadingView('#/home');
  await refreshMe();
  const h = await call('home', {});
  const cur = h.surveys.at(-1);
  const open = h.surveys.slice().reverse().find(x => ['open', 'missing'].includes(x.state));
  const todo = [];
  for (const r of h.reviewItems) todo.push(html`<a class="todo ${r.state === 'clarification_requested' ? 'urgent' : ''}" href="#/record/${r.submissionId}">${icon(r.state === 'clarification_requested' ? 'q' : 'check')}<span><strong>${r.state === 'clarification_requested' ? t('question_from') : t('review_title')}</strong><small>${t('week_of')} ${fmtDate(r.weekId)}</small></span><span class="go">${t('open')}</span></a>`);
  const nowS = S.me.now;
  const surveyTile = open && !surveyOpen()
    ? html`<div class="big-action waiting">${icon('clock')}<span><strong>${t('home_survey')}</strong><small>${t('closed_title')} · ${t('closed_next')} <b>${fmtDT(S.me.surveyWindow.nextOpen)}</b> · ${untilText(S.me.surveyWindow.nextOpen, nowS)}</small></span></div>`
    : open
    ? html`<a class="big-action primary" href="#/checkin/${open.assignmentId}">${icon('check')}<span><strong>${t('home_survey')}</strong><small>${t('week_of')} ${fmtDate(open.week.start)} · ${open.state === 'missing' ? t('st_missing') : t('due') + ' ' + fmtDT(open.week.dueAt)}</small></span></a>`
    : cur && cur.state === 'not_open'
    ? html`<div class="big-action waiting">${icon('clock')}<span><strong>${t('report_opens')} ${fmtDT(cur.week.opensAt)}</strong><small>${untilText(cur.week.opensAt, nowS)}</small></span></div>`
    : html`<a class="big-action done" href="#/checkin">${icon('shield')}<span><strong>${cur && cur.state.startsWith('submitted') ? t('home_survey_done') : t('home_survey')}</strong><small>${cur ? chip(cur.state) : ''}</small></span></a>`;
  render('#/home', html`
    <section class="portal-hero"><p class="eyebrow">Innerspace Cases · ${fmtDate(S.me.now, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>${t('hello')}, ${h.greetingName}</h1><span class="gold-rule" aria-hidden="true"></span></section>
    ${todo.length ? html`<section class="card attention"><h2>${t('attention')}</h2><div class="todo-list">${todo}</div></section>` : ''}
    <div class="big-actions">
      ${surveyTile}
      <a class="big-action safety" href="#/safety/new">${icon('alert')}<span><strong>${t('home_safety')}</strong><small>${t('home_safety_sub')}</small></span></a>
    </div>
    ${myWeekCard(h)}
    <div id="hours-slot"></div>
    ${installTip()}
    ${h.safety.length ? html`<section class="card"><h2>${t('my_reports')}</h2><ul class="plain-list">${h.safety.map(r => html`<li><a href="#/safety/r/${r.id}">${t('t_' + r.type)}</a><span>${sChip(r.status)} <span class="meta">${fmtDate(r.created_at)}</span></span></li>`)}</ul></section>` : ''}
    ${h.links && h.links.length ? html`<h2 class="portal-section-title">${t('links')}</h2><div class="portal-tiles">${h.links.map(l => html`<a class="portal-tile" href="${l.url}" target="_blank" rel="noopener noreferrer">${icon('ext')}<strong>${L(l.label)}</strong><small>${l.note}</small><span class="sr">(${t('opens_new')})</span></a>`)}</div>` : ''}
    ${S.lang === 'es' ? html`<p class="fine">${t('es_draft')}</p>` : ''}`);
  loadHours();
}
// "My weekly reports": this week and last week at a glance, including where the review is.
function myWeekCard(h) {
  const rows = h.surveys.slice().reverse().map((s, i) => {
    const label = i === 0 ? t('week_this') : t('week_last');
    const rv = s.review;
    let status, extra = '', tone = '';
    if (['open', 'missing'].includes(s.state)) { status = t('week_not_signed'); extra = html` · ${t('week_due')} ${fmtDT(s.week.dueAt)}`; tone = s.state === 'missing' ? 'bad' : 'warn'; }
    else if (s.state === 'not_open') { status = t('week_opens'); tone = 'muted'; }
    else if (s.state === 'excused') { status = t('week_excused'); tone = 'muted'; }
    else if (s.state === 'paper') { status = t('week_paper'); tone = 'muted'; }
    else {
      status = html`${icon('check')} ${t('week_signed')} ${fmtDT(s.signedAt)}`; tone = 'ok';
      if (rv && rv.state === 'clarification_requested') extra = html`<br><a class="week-q" href="#/record/${s.submissionId}">${icon('q')} ${t('week_question').replace('{n}', (rv.question && rv.question.by) || h.reviewer || '')} — ${t('week_answer')}</a>`;
      else if (rv && rv.state === 'signed_off') extra = html`<br><span class="meta">${t('week_reviewed').replace('{n}', rv.by || '')}</span>`;
      else extra = html`<br><span class="meta">${h.reviewer ? t('week_waiting_by').replace('{n}', h.reviewer) : t('week_waiting')}</span>`;
    }
    const link = s.submissionId ? '#/record/' + s.submissionId : ['open', 'missing'].includes(s.state) ? '#/checkin/' + s.assignmentId : null;
    return html`<li class="week-row ${tone}"><div><p class="week-label">${label} · ${fmtDate(s.week.start)}–${fmtDate(s.week.end)}</p><p class="week-status">${status}${extra}</p></div>${link ? html`<a class="go" href="${link}" aria-label="${t('open')}: ${label}">${t('open')}</a>` : ''}</li>`;
  });
  return rows.length ? html`<section class="card my-week"><h2>${t('week_title')}</h2><ul class="week-list">${rows}</ul><p><a href="#/checkin">${t('home_history')}</a></p></section>` : '';
}
// "My hours" from QuickBooks Time (read-only). Loaded after the page so a slow answer never blocks Home.
const dayShort = (ymd) => new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', weekday: 'short' }).format(new Date(ymd + 'T12:00:00Z'));
const fmtH = (n) => (Math.round(n * 10) / 10).toLocaleString(locale(), { maximumFractionDigits: 1 }) + ' ' + t('hrs_h');
function hoursCard(r) {
  const w = r.thisWeek, max = Math.max(8, ...w.days.map(d => d.hours));
  return html`<section class="card my-hours"><div class="row between wrap"><h2>${t('hrs_title')}</h2><span class="meta">${r.demo ? t('hrs_demo') : t('hrs_from')}</span></div>
    <p class="hours-total"><strong>${fmtH(w.totalHours)}</strong> <span class="meta">${t('hrs_this').toLowerCase()} · ${t('hrs_last').toLowerCase()} ${fmtH(r.lastWeek.totalHours)}</span></p>
    <p class="${w.onClockSince ? 'on-clock' : 'meta'}">${w.onClockSince ? html`<span class="dot" aria-hidden="true"></span> ${t('hrs_on')} ${fmtTime(w.onClockSince)}` : t('hrs_off')}</p>
    <ol class="hours-days" aria-label="${t('hrs_this')}">${w.days.map(d => html`<li><span class="bar" data-css-h="${Math.min(1, d.hours / max)}" aria-hidden="true"></span><b>${d.hours ? (Math.round(d.hours * 10) / 10) : '–'}</b><span>${dayShort(d.date)}</span></li>`)}</ol></section>`;
}
async function loadHours(slotId = 'hours-slot') {
  const slot = document.getElementById(slotId); if (!slot) return;
  let r; try { r = await api.call('hours.mine', {}); } catch (e) { const s2 = document.getElementById(slotId); if (s2 && !(e instanceof ApiError && e.status === 401)) s2.innerHTML = String(html`<section class="card my-hours"><h2>${t('hrs_title')}</h2><p class="meta">${t('hrs_err')}</p></section>`); return; }
  const s2 = document.getElementById(slotId); if (!s2 || !r.available || !r.linked) return;
  s2.innerHTML = String(hoursCard(r)); applyCssVars(s2);
}
const linkCard = (l) => html`<a class="link-card" href="${l.url}" target="_blank" rel="noopener noreferrer"><span>${L(l.label)}</span><small>${l.note}</small>${icon('ext')}<span class="sr">(${t('opens_new')})</span></a>`;

// ---------------------------------------------------------------- weekly report
async function checkinListView() {
  loadingView('#/checkin');
  const [h, mine] = await Promise.all([call('home', {}), call('survey.mine', {})]);
  render('#/checkin', html`<h1>${t('report_title')}</h1><p class="lede">${L(S.tpl.paidTimeNotice)}</p>
    <div class="stack">${h.surveys.slice().reverse().map(s => html`<article class="card row wrap"><div class="grow">
      <h2 class="h3">${t('week_of')} ${fmtDate(s.week.start, { month: 'long', day: 'numeric' })} – ${fmtDate(s.week.end, { month: 'long', day: 'numeric' })}</h2>
      <p class="meta">${chip(s.state)} ${['open', 'missing', 'not_open'].includes(s.state) ? html`· ${t('due')} ${fmtDT(s.week.dueAt)}` : ''}${s.reason ? ' · ' + s.reason : ''}</p></div>
      ${['open', 'missing'].includes(s.state) ? html`<a class="btn primary" href="#/checkin/${s.assignmentId}">${t('start')}</a>` : ''}
      ${s.submissionId ? html`<a class="btn" href="#/record/${s.submissionId}">${t('view')}</a>` : ''}</article>`)}</div>
    <section class="card"><h2>${t('nav_history')}</h2><ul class="plain-list">${mine.filter(m => m.submissionId).map(m => html`<li><a href="#/record/${m.submissionId}">${t('week_of')} ${fmtDate(m.weekId, { month: 'short', day: 'numeric', year: 'numeric' })}</a>
      <span class="meta">${fmtDT(m.signedAt)}${m.late ? ' · ' + t('st_submitted_late') : ''} · ${reviewLabel(m.review)}</span></li>`)}</ul></section>`);
}
const REVIEW_LABEL = { awaiting_review: 'Waiting for review', clarification_requested: 'Question asked', employee_responded: 'Employee answered', amended_after_signoff: 'Corrected — needs re-review', signed_off: 'Reviewed' };
const reviewLabel = (s) => REVIEW_LABEL[s] || s || '';

// One screen per question (tap an answer and the next one appears); optional write-in questions
// share one screen; the last screen is review & sign.
function pagesOf(tpl) {
  const pages = [];
  for (const sec of tpl.sections) {
    let text = null;
    for (const q of sec.questions) {
      if (q.type === 'text') { if (!text) { text = { kind: 'text', sec, qs: [] }; pages.push(text); } text.qs.push(q); }
      else { text = null; pages.push({ kind: 'q', sec, qs: [q] }); }
    }
  }
  pages.push({ kind: 'sign' });
  return pages;
}
const pageOfQuestion = (tpl, qid) => pagesOf(tpl).findIndex(p => p.qs && p.qs.some(q => q.id === qid));

async function surveyView(assignmentId) {
  await refreshMe();
  if (!surveyOpen()) return render('#/checkin', html`<h1>${t('report_title')}</h1>${closedNote()}<div class="row wrap"><a class="btn danger" href="#/safety/new">${t('home_safety')}</a><a class="btn" href="#/checkin">${t('home_history')}</a></div>`);
  if (!S.survey || S.survey.assignmentId !== assignmentId) {
    loadingView('#/checkin');
    const a = await call('survey.assignment', { assignmentId });
    if (a.submissionId) return go('#/record/' + a.submissionId);
    const tpl = (await call('survey.template', { assignmentId })).template;
    S.survey = { assignmentId, tpl, week: a.week, state: a.state, answers: a.draft || {}, step: 0, idem: null, error: null, savedAt: a.draftSavedAt, saveState: a.draftSavedAt ? 'saved' : '' };
  }
  renderSurvey();
}

function questionField(q) {
  const v = S.survey.answers[q.id];
  const tag = q.origin === 'paper' ? '' : html`<span class="tag">${t('added_item')}</span>`;
  if (q.type === 'rating' || q.type === 'yesno') return html`<fieldset class="q" id="q-${q.id}"><legend>${L(q.text)} ${tag}</legend>
    <div class="opts ${q.type}">${q.options.map(o => html`<label class="opt"><input type="radio" name="${q.id}" value="${o.value}" ${q.required ? raw('required') : ''} ${String(v) === String(o.value) ? raw('checked') : ''}>
    <span>${q.type === 'rating' ? html`<b>${o.value}</b> ` : ''}${L(o)}</span></label>`)}</div><p class="field-err" id="err-${q.id}" hidden>${t('answer_needed')}</p></fieldset>`;
  return html`<div class="q"><label class="field"><span>${L(q.text)} ${tag}</span>${q.help ? html`<small class="hint">${L(q.help)}</small>` : ''}
    <textarea name="${q.id}" rows="3" maxlength="${q.maxLength || 1000}" autocomplete="off">${v || ''}</textarea></label></div>`;
}

function saveIndicator() {
  const sv = S.survey;
  const txt = sv.saveState === 'saving' ? t('saving') : sv.saveState === 'error' ? t('not_saved') : sv.savedAt ? `${t('saved_at')} ${fmtTime(sv.savedAt)}` : '';
  return html`<p class="saved ${sv.saveState === 'error' ? 'bad' : ''}" id="saved" aria-live="polite">${txt}</p>`;
}

function renderSurvey() {
  const sv = S.survey, tpl = sv.tpl, pages = pagesOf(tpl);
  sv.step = Math.max(0, Math.min(sv.step, pages.length - 1));
  const page = pages[sv.step], step = page.kind === 'sign' ? 'sign' : page.sec.id, n = pages.length;
  const progress = html`<div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="${sv.step + 1}" aria-label="${t('step')} ${sv.step + 1} ${t('of')} ${n}"><span data-css-p="${(sv.step + 1) / n}"></span></div>
    <div class="row between"><p class="stepper">${t('step')} ${sv.step + 1} ${t('of')} ${n}</p>${saveIndicator()}</div>`;
  const period = html`<p class="period">${t('week_of')} <strong>${fmtDate(sv.week.start, { weekday: 'short', month: 'short', day: 'numeric' })} – ${fmtDate(sv.week.end, { weekday: 'short', month: 'short', day: 'numeric' })}</strong></p>`;
  let body;
  if (step !== 'sign') {
    const sec = page.sec;
    const firstOfSafety = step === 'safety' && pages.findIndex(p => p.sec && p.sec.id === 'safety') === sv.step;
    body = html`<h1 class="sec-title">${L(sec.title)}</h1>${sv.step === 0 ? period : ''}
      ${sv.step === 0 ? html`<div class="notice paid">${icon('clock')}<p><strong>${t('paid_time')}.</strong> ${L(tpl.paidTimeNotice)}</p></div><p class="intro">${L(tpl.intro)}</p>` : ''}
      ${firstOfSafety ? html`<a class="safety-cta small" href="#/safety/new">${icon('alert')}<span><strong>${t('safety_now')}</strong><small>${t('safety_now_sub')}</small></span></a>` : ''}
      <form data-form="survey-step" class="${page.kind === 'q' ? 'one-q' : ''}" novalidate>${page.qs.map(questionField)}</form>`;
  } else {
    const pkPath = !sv.usePin && (sv.quick ? !!sv.who && !sv.mustSetPin && pkReadyFor(sv.who.id) : !!S.me && pkReadyFor(S.me.employee.id));
    const rows = tpl.sections.map((sec, si) => sec.questions.map(q => {
      const v = sv.answers[q.id];
      const opt = q.options ? q.options.find(o => String(o.value) === String(v)) : null;
      return html`<div class="rv"><dt>${L(q.text)}</dt><dd><span>${v === undefined || v === '' ? html`<em>—</em>` : opt ? html`${q.type === 'rating' ? v + ' · ' : ''}${L(opt)}` : v}</span>
        <button class="link" data-act="goto-step" data-step="${pageOfQuestion(tpl, q.id)}">${t('edit')}</button></dd></div>`;
    }));
    body = html`<h1>${t('review_sign')}</h1>${period}<dl class="review card">${rows}</dl>
      <div class="sign-box"><p>${L(pkPath && tpl.signature.statementPasskey ? tpl.signature.statementPasskey : tpl.signature.statement)}</p></div>
      ${sv.quick ? quickSignForm(sv) : S.me.consent && S.me.consent.choice === 'paper' ? html`<p class="alert-soft" role="note">${t('paper_chosen')}</p>` : html`<form data-form="sign" novalidate class="card emphasis">
        <p class="signing-as">${t('sign_as')} <strong>${S.me.employee.name}</strong> (${S.me.employee.id})</p>
        ${!S.me.consent ? html`<div class="consent-text"><p class="eyebrow">${t('esign')} · ${S.consentText.version}</p><p>${L(S.consentText.text)}</p></div>` : ''}
        <label class="check"><input type="checkbox" name="affirm" required ${sv.affirm ? raw('checked') : ''}><span>${!S.me.consent ? t('sign_affirm_consent') : t('sign_affirm')}</span></label>
        ${pkReadyFor(S.me.employee.id) && !sv.usePin ? pkSignButtons(sv) : html`<label class="field"><span>${t('sign_pin')}</span><input id="signpin" name="signPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required></label>
        ${S.me.sharedDevice ? keypad('signpin') : ''}
        ${sv.error ? html`<p class="alert" role="alert">${sv.error}</p>` : ''}
        <button class="btn primary wide" type="submit" data-submit>${t('sign_submit')}</button>`}
      </form>`}
      ${isDemo() ? html`<p class="fine">DEMO: no signature made in this prototype is legally operative. Questionnaire ${tpl.id}.</p>` : html`<p class="fine">Questionnaire ${tpl.id}.</p>`}`;
  }
  render('#/checkin', html`<div class="flow">${progress}${body}
    <div class="flow-nav ${step === 'sign' ? 'static' : ''}">
      ${sv.step > 0 ? html`<button class="btn" data-act="survey-back">${t('back')}</button>` : sv.quick ? html`<button class="btn" data-act="quick-who">${t('back')}</button>` : html`<a class="btn" href="#/checkin">${t('back')}</a>`}
      ${step !== 'sign' ? html`<button class="btn primary" data-act="survey-next">${t('next')}</button>` : ''}
    </div></div>`);
  if (sv.quick && step === 'sign' && S.config && S.config.turnstileSiteKey && !sv.signedIn) mountTurnstile(S.config.turnstileSiteKey);
  if (step === 'sign' && root.querySelector('[data-act=pk-sign]')) prepareSignIn({ purpose: 'sign', action: 'survey.submit', content: pkContent(sv) });
}

function collectStep(validate = true) {
  const form = root.querySelector('form[data-form="survey-step"]');
  if (!form) return true;
  const page = pagesOf(S.survey.tpl)[S.survey.step];
  if (!page || !page.qs) return true;
  let firstBad = null;
  for (const q of page.qs) {
    if (q.type === 'text') { const v = form.elements[q.id].value.trim(); if (v) S.survey.answers[q.id] = v; else delete S.survey.answers[q.id]; continue; }
    const sel = form.querySelector(`input[name="${q.id}"]:checked`);
    const err = root.querySelector('#err-' + q.id), fs = root.querySelector('#q-' + q.id);
    if (sel) { S.survey.answers[q.id] = q.type === 'rating' ? Number(sel.value) : sel.value; err.hidden = true; fs.classList.remove('invalid'); fs.querySelectorAll('input').forEach(i => i.removeAttribute('aria-invalid')); }
    else if (q.required && validate) {
      err.hidden = false; fs.classList.add('invalid');
      fs.querySelectorAll('input').forEach(i => { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'err-' + q.id); });
      firstBad = firstBad || fs.querySelector('input');
    }
  }
  if (firstBad) { firstBad.focus(); announce(t('answer_needed')); return false; }
  return true;
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 700); }
async function saveDraft() {
  const sv = S.survey; if (!sv || sv.submitting || sv.quick) return;
  sv.saveState = 'saving'; updateSaved();
  try { const r = await api.call('survey.saveDraft', { assignmentId: sv.assignmentId, answers: sv.answers }); if (S.survey === sv) { sv.savedAt = r.savedAt; sv.saveState = 'saved'; } }
  catch (e) { if (S.survey === sv) sv.saveState = 'error'; if (e instanceof ApiError && e.status === 401) return wipe(e.message); }
  updateSaved();
}
function updateSaved() { const el = document.getElementById('saved'); if (el && S.survey) { el.outerHTML = String(saveIndicator()); } }

async function submitSurvey(form, btn) {
  const sv = S.survey, f = form.elements;
  clearTimeout(saveTimer);
  sv.affirm = f.affirm.checked;   // kept if the attempt fails; the PIN is never kept
  if (!/^\d{6,12}$/.test(f.signPin.value)) { sv.error = t('sign_pin'); return renderSurvey(); }
  if (!f.affirm.checked) { sv.error = t('sign_affirm'); return renderSurvey(); }
  sv.idem = sv.idem || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  btn.disabled = true; btn.textContent = t('submitting'); btn.setAttribute('aria-busy', 'true');
  sv.submitting = true;
  try {
    const r = await call('survey.submit', { assignmentId: sv.assignmentId, answers: sv.answers, signPin: f.signPin.value, affirm: true, esignConsent: !S.me.consent, language: S.lang, idempotencyKey: sv.idem });
    S.survey = null;
    if (!S.me.consent) S.me.consent = { choice: 'electronic' };
    go('#/record/' + r.submissionId + '?new=1');
  } catch (e) {
    sv.submitting = false;
    if (quiet(e)) return;
    sv.error = (e instanceof ApiError && e.code === 'network') ? t('submit_failed') : errMsg(e) + (e instanceof ApiError && e.status >= 500 ? ' — ' + t('submit_failed') : '');
    renderSurvey(); announce(sv.error);
  }
}

// ---------------------------------------------------------------- signed record (employee and supervisor)
const integ = (r) => r.integrity === 'verified' ? html`<span class="chip c-submitted">${icon('shield')} ${t('verified')}</span>` : html`<span class="chip c-missing">${t('mismatch')}</span>`;
const EVT = { clarification_requested: 'Question', clarification_withdrawn: 'Question withdrawn', employee_response: 'Response', employee_seen: 'Marked as seen', supervisor_note: 'Supervisor note' };
const CLOSURE = { no_action: 'Closed — no action needed', action_assigned: 'Closed — corrective action assigned', referred: 'Closed — referred to management' };

async function recordView(id, isNew) {
  loadingView('#/checkin');
  const rec = await call('survey.record', { submissionId: id });
  const o = rec.original.payload, rv = rec.review, active = rec.viewerIsOwner ? '#/checkin' : '#/team';
  const answers = o.answers.map(a => html`<div class="rv"><dt>${a.questionText}${a.origin !== 'paper' ? html` <span class="tag">${t('added_item')}</span>` : ''}</dt><dd>${a.answerLabel ? html`${typeof a.answer === 'number' ? a.answer + ' · ' : ''}${a.answerLabel}` : a.answer}</dd></div>`);
  const pendingQ = rv.pendingClarification;
  const shared = S.me.sharedDevice && rec.viewerIsOwner && isNew;
  S.pkReg = null;
  const offer = isNew && rec.viewerIsOwner && !S.me.deviceId && !S.me.sharedDevice && !S.roster && !pkReadyFor(S.me.employee.id) && !offerSkipped(S.me.employee.id) && await platformAvailable();
  render(active, html`
    ${isNew ? html`<div class="success" role="status"><h1>${t('confirm_title')}</h1><p>${t('confirm_sub')}</p>
      ${shared ? html`<p class="countdown" id="countdown">${t('auto_signout')} <strong id="cd">20</strong>${t('seconds')}</p><div class="row wrap"><button class="btn primary" data-act="signout">${t('signout_now')}</button><button class="btn" data-act="stay-after">${t('stay')}</button></div>` : ''}</div>`
      : html`<h1>${rec.viewerIsOwner ? t('record_title') : rec.employee.name + ' — weekly report'}</h1>`}
    ${offer ? html`<section class="card pk-offer" id="pk-offer"><h2>${tm('pk_offer_title')}</h2><p>${tm('pk_offer_body')}</p>
      ${pkSetupBlock()}<p><button class="btn-quiet" data-act="pk-offer-no">${t('pk_offer_no')}</button></p></section>` : ''}
    ${o.demo ? html`<p class="demo-note">DEMO RECORD — synthetic data, not a legally operative signature.</p>` : ''}
    ${pendingQ && rec.viewerIsOwner && surveyOpen() ? html`<section class="card emphasis"><h2>${icon('q')} ${t('question_from')}</h2><blockquote>${pendingQ.text}<br><small>${pendingQ.by} · ${fmtDT(pendingQ.at)}</small></blockquote>
      <form data-form="respond" data-id="${rec.submissionId}" novalidate><label class="field"><span>${t('your_answer')}</span><textarea name="text" rows="3" maxlength="4000" required></textarea></label><button class="btn primary" type="submit">${t('answer_btn')}</button></form></section>` : ''}
    <section class="card">
      <p class="meta"><strong>${o.employee.displayName}</strong> · ${t('week_of')} ${fmtDate(o.reportingPeriod.start, { month: 'long', day: 'numeric', year: 'numeric' })} · ${o.form.templateId} · ${chip(rv.state === 'signed_off' ? 'submitted' : 'open', reviewLabel(rv.state))}</p>
      <dl class="review">${answers}</dl>
      <div class="sig-block"><p>${o.signature.statementShown}</p>
        <p class="meta">${t('signed_by')} ${o.signature.signerName || o.signature.typedName} · ${fmtDT(o.signedAtUtc)} ${o.late ? html`· <span class="chip c-missing">${t('st_submitted_late')}</span>` : ''}</p>
        <p class="meta">${o.signature.identity ? o.signature.identity.method + ' · ' + o.signature.identity.device : ''}</p>
        <p class="meta">${t('integrity')}: ${integ(rec.original)} <code class="hash">${rec.original.hash.slice(0, 16)}…</code></p></div>
      <div class="row-actions"><button class="btn" data-act="download" data-id="${rec.submissionId}" data-fmt="html">${t('download_html')}</button><button class="btn-quiet" data-act="download" data-id="${rec.submissionId}" data-fmt="json">${t('download_json')}</button></div>
    </section>
    ${rec.amendments.map(m => html`<section class="card amend"><h2 class="h3">${t('correct_title')} · ${fmtDT(m.signedAt)}</h2><p>${m.payload.note}</p>
      ${Object.keys(m.payload.corrections || {}).length ? html`<p class="meta">→ ${Object.entries(m.payload.corrections).map(([k, v]) => k + ': ' + v).join(', ')}</p>` : ''}<p class="meta">${t('signed_by')} ${m.payload.signature.signerName || m.payload.signature.typedName} · ${integ(m)}</p></section>`)}
    ${rec.events.length ? html`<section class="card"><h2>Questions and responses</h2><ol class="timeline">${rec.events.map(e => html`<li class="ev-${e.kind}"><strong>${EVT[e.kind] || e.kind}</strong> · ${e.by} · <span class="meta">${fmtDT(e.at)}</span><p>${e.text}</p></li>`)}</ol></section>` : ''}
    <section class="card"><h2>${t('review_title')}</h2>
      ${rec.reviews.length ? rec.reviews.map(r => html`<article class="review-item"><p class="meta"><strong>${r.payload.reviewer.displayName}</strong> · ${fmtDT(r.signedAt)} · ${integ(r)}</p>
        <p>${r.payload.comments || html`<em>—</em>`}</p>
        ${r.payload.trainingNeeded ? html`<p class="meta">Training identified: ${r.payload.trainingNote || 'yes'}</p>` : ''}
        ${r.payload.performanceConcern ? html`<p class="meta">Performance concern: ${r.payload.performanceNote || 'yes'}</p>` : ''}
        <p><strong>${CLOSURE[r.payload.closure]}</strong></p><p class="fine">${r.payload.acknowledgment}</p></article>`) : html`<p class="empty-inline">${t('not_reviewed')}</p>`}
      ${rec.viewerIsOwner && rv.lastSignoff ? (rv.employeeSeen ? html`<p class="success-inline">${icon('shield')} ${t('seen_done')}</p>` : html`<div class="seen-box"><p>${L(S.seenStatement)}</p><button class="btn" data-act="seen" data-id="${rec.submissionId}">${t('mark_seen')}</button></div>`) : ''}
      ${rec.viewerIsOwner && surveyOpen() ? html`<details><summary>${t('respond')}</summary><form data-form="respond" data-id="${rec.submissionId}" novalidate><p class="hint">${t('respond_help')}</p>
        <label class="field"><span class="sr">${t('respond')}</span><textarea name="text" rows="3" maxlength="4000" required></textarea></label><button class="btn" type="submit">${t('respond_btn')}</button></form></details>` : ''}
      ${rec.paperEvents.map(p => html`<p class="meta">Paper: ${p.event} · ${fmtDT(p.created_at)} ${p.note}</p>`)}
    </section>
    ${rec.followups && rec.followups.length ? html`<section class="card"><h2>Safety follow-up created from this report</h2><ul class="plain-list">${rec.followups.map(f => html`<li>${rec.viewerIsOwner || anyRole('safety', 'manager', 'hr') ? html`<a href="#/safety/r/${f.id}">${t('t_' + f.type)}</a>` : html`<span>${t('t_' + f.type)} <small class="meta">(handled by the safety lead)</small></span>`}${sChip(f.status)}</li>`)}</ul></section>` : ''}
    ${rec.actions.length ? html`<section class="card"><h2>Corrective actions from this report</h2><ul class="plain-list">${rec.actions.map(c => html`<li><a href="#/actions">${c.title}</a><span class="chip c-${c.status === 'closed' ? 'submitted' : 'open'}">${c.status.replace('_', ' ')}</span></li>`)}</ul></section>` : ''}
    ${rec.viewerIsOwner ? (surveyOpen() ? correctionForm(rec, o) : closedNote()) : ''}
    ${rec.viewerCanReview ? reviewPanel(rec) : ''}`);
  if (shared) startAutoSignout();
}

function correctionForm(rec, o) {
  const qs = o.answers.filter(a => a.origin === 'paper');
  const opts = (qid) => { const q = S.tpl.sections.flatMap(s => s.questions).find(x => x.id === qid); return q && q.options ? q.options : []; };
  return html`<section class="card"><details><summary><strong>${t('correct_title')}</strong></summary><p class="hint">${t('correct_help')}</p>
    <form data-form="amend" data-id="${rec.submissionId}" novalidate>
      <label class="field"><span>${t('correct_note')}</span><textarea name="note" rows="3" maxlength="2000" required></textarea></label>
      <fieldset class="corr"><legend>${t('correct_change')}</legend>${qs.map(a => html`<label class="field"><span>${a.questionText}</span><select name="c_${a.questionId}"><option value="">${t('no_change')} (${a.answerLabel || a.answer})</option>${opts(a.questionId).map(op => html`<option value="${op.value}">${typeof op.value === 'number' ? op.value + ' · ' : ''}${L(op)}</option>`)}</select></label>`)}</fieldset>
      <label class="check"><input type="checkbox" name="affirm"><span>${t('sign_affirm')}</span></label>
      <label class="field"><span>${t('sign_pin')}</span><input name="signPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required></label>
      <button class="btn primary" type="submit">${t('correct_btn')}</button></form></details></section>`;
}

function reviewPanel(rec) {
  const rv = rec.review;
  const canSign = !['clarification_requested', 'signed_off'].includes(rv.state);
  return html`<section class="card emphasis" id="review-panel"><h2>Supervisor review</h2>
    <p class="hint">You are reviewing ${rec.employee.name}'s signed answers. You cannot change them or sign for them.</p>
    ${rv.state === 'clarification_requested' ? html`<p class="alert-soft">Waiting for ${rec.employee.name} to answer your question.</p>
      <form data-form="withdraw" data-id="${rec.submissionId}"><button class="btn-quiet" type="submit">Withdraw the question</button></form>` : html`
      <details ${rv.state === 'awaiting_review' ? '' : raw('')}><summary>Ask a question or request follow-up</summary>
        <form data-form="clarify" data-id="${rec.submissionId}" novalidate><label class="field"><span>Your question</span><textarea name="text" rows="2" maxlength="2000" required></textarea></label><button class="btn" type="submit">Send question</button></form></details>`}
    ${rv.needsSupervisor && rv.state === 'signed_off' ? html`<form data-form="note" data-id="${rec.submissionId}" novalidate class="card soft"><p><strong>${rec.employee.name} responded after your review.</strong></p>
      <label class="field"><span>Reply (kept with the record)</span><textarea name="text" rows="2" maxlength="2000" required></textarea></label><button class="btn" type="submit">Send reply</button></form>` : ''}
    <details><summary>Create a corrective action from this report</summary>${caForm('survey', rec.submissionId)}</details>
    ${canSign ? html`<form data-form="signoff" data-id="${rec.submissionId}" novalidate>
      <h3>Sign off</h3>
      <label class="field"><span>Comments for the employee</span><textarea name="comments" rows="3" maxlength="4000"></textarea></label>
      <label class="check"><input type="checkbox" name="trainingNeeded"><span>Training or coaching needed</span></label>
      <label class="field"><span>Training note (optional)</span><input name="trainingNote" maxlength="1000" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="performanceConcern"><span>Performance concern to follow up</span></label>
      <label class="field"><span>Performance note (optional)</span><input name="performanceNote" maxlength="1000" autocomplete="off"></label>
      <fieldset class="q"><legend>How is this review closed?</legend><div class="opts">
        ${Object.entries(CLOSURE).map(([k, v]) => html`<label class="opt"><input type="radio" name="closure" value="${k}" ${k === 'no_action' ? raw('checked') : ''}><span>${v}</span></label>`)}</div></fieldset>
      <div class="sign-box"><p>${L(S.supAck)}</p></div>
      <label class="check"><input type="checkbox" name="affirm"><span>I am signing this review electronically as ${S.me.employee.name}.</span></label>
      <label class="field"><span>Your PIN</span><input name="signPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required></label>
      <button class="btn primary" type="submit">Sign off review</button></form>` : rv.state === 'signed_off' ? html`<p class="success-inline">${icon('shield')} Signed off.</p>` : ''}
    <details><summary>Employee won't sign, or wants paper?</summary><p class="hint">Use Team → Missing for weeks not yet signed. Recording "declined" never counts as a signature.</p></details>
  </section>`;
}

function startAutoSignout() {
  let n = 20; clearInterval(S.autoOut);
  S.autoOut = setInterval(() => {
    n--; const el = document.getElementById('cd');
    if (!el) { clearInterval(S.autoOut); return; }
    el.textContent = n;
    if (n <= 0) { clearInterval(S.autoOut); wipe(); }
  }, 1000);
}

function consentView(next) {
  render('#/home', html`<div class="flow"><h1>${t('consent_title')}</h1><div class="sign-box"><p>${L(S.consentText.text)}</p></div><p class="fine">${S.consentText.version}</p>
    <div class="stack"><button class="btn primary wide" data-act="consent" data-choice="electronic" data-next="${next || '#/home'}">${t('consent_yes')}</button>
    <button class="btn wide" data-act="consent" data-choice="paper" data-next="#/home">${t('consent_paper')}</button></div></div>`);
}

// ---------------------------------------------------------------- safety (employee)
const TYPES = ['imminent', 'injury', 'unsafe_equipment', 'hazard', 'unsafe_condition', 'near_miss', 'suggestion'];

function deliveryText(sum) {
  if (!sum) return '';
  if (sum.state === 'acknowledged') return html`<p class="ok">${icon('shield')} ${t('deliv_acknowledged')}</p>`;
  if (sum.state === 'failed') return html`<p class="bad">${icon('alert')} ${t('deliv_failed')}</p>`;
  const parts = [];
  if (sum.seenBy.length) parts.push(html`<p class="ok">${t('deliv_seen')}: ${sum.seenBy.join(', ')}</p>`);
  if (sum.deliveredTo.length) parts.push(html`<p>${t('deliv_delivered')}: ${sum.deliveredTo.join(', ')}</p>`);
  if (sum.pendingCount) parts.push(html`<p class="warn">${t('deliv_sending')}</p>`);
  if (!parts.length) parts.push(html`<p>${t('deliv_in_app')}</p>`);
  if (sum.failedCount && sum.state !== 'acknowledged') parts.push(html`<p class="bad">${sum.failedCount} alert(s) could not be delivered and were rerouted.</p>`);
  return parts;
}

async function safetyNewView() {
  const r = S.safetyResult;
  if (r) {
    S.safetyResult = null;
    const urgent = ['imminent', 'injury'].includes(r.type) || r.priority === 'urgent';
    return render('#/safety', html`<div class="success ${urgent ? 'urgent' : ''}" role="status"><h1>${t('safety_sent')}</h1>
      <p>${t('safety_due')} <strong>${fmtDT(r.responseDueAt)}</strong>.</p>
      ${urgent ? html`<p class="stop">${icon('alert')} ${t('safety_tell_now')}</p>` : ''}
      <div class="deliv">${deliveryText(r.deliverySummary)}</div>
      <p class="fine">${icon('shield')} ${t('no_retaliation')}</p>
      <p class="fine">Prototype: text messages are simulated. Report ${r.reportId}.</p></div>
      <div class="row wrap"><a class="btn primary" href="#/safety/r/${r.reportId}">Track this report</a><a class="btn" href="#/home">${t('nav_home')}</a></div>`);
  }
  render('#/safety', html`<h1>${t('safety_title')}</h1>
    <div class="stop-banner" role="note">${icon('alert')}<p>${t('safety_stop')}</p></div>
    <form data-form="safety" novalidate>
      <fieldset class="q"><legend>${t('safety_kind')}</legend><div class="opts sev">${TYPES.map(k => html`<label class="opt sev-${k}"><input type="radio" name="type" value="${k}" required><span>${t('t_' + k)}</span></label>`)}</div>
        <p class="field-err" id="err-type" hidden>${t('answer_needed')}</p></fieldset>
      <label class="field"><span>${t('safety_area')}</span><select name="area"><option value="">—</option>${S.me.areas.map(a => html`<option>${a}</option>`)}</select></label>
      <div class="grid2"><label class="field"><span>${t('safety_location')}</span><input name="location" maxlength="200" autocomplete="off"></label>
        <label class="field"><span>${t('safety_equipment')}</span><input name="equipment" maxlength="120" autocomplete="off"></label></div>
      <label class="field"><span>${t('safety_what')}</span><textarea name="description" rows="4" maxlength="4000" required></textarea></label>
      <label class="field"><span>${t('safety_did')}</span><textarea name="immediateAction" rows="2" maxlength="1000"></textarea></label>
      <label class="field photo"><span>${icon('camera')} ${t('safety_photo')}</span><input type="file" name="photo" accept="image/*" capture="environment"></label>
      <label class="check"><input type="checkbox" name="confidential"><span>${t('safety_conf')}</span></label>
      <button class="btn danger wide" type="submit">${t('safety_send')}</button>
    </form><p class="fine">${icon('shield')} ${t('no_retaliation')}</p>`);
}

async function safetyMineView() {
  loadingView('#/safety');
  const mine = await call('safety.mine', {});
  render('#/safety', html`<h1>${t('nav_safety')}</h1>
    <a class="safety-cta" href="#/safety/new">${icon('alert')}<span><strong>${t('safety_now')}</strong><small>${t('safety_now_sub')}</small></span></a>
    <section class="card"><h2>${t('my_reports')}</h2>${mine.length ? html`<ul class="plain-list">${mine.map(r => html`<li><a href="#/safety/r/${r.id}">${t('t_' + r.type)}${r.area ? ' · ' + r.area : ''}</a><span>${sChip(r.status)} <span class="meta">${fmtDate(r.createdAt)}</span></span></li>`)}</ul>` : html`<p class="empty-inline">—</p>`}</section>
    <p class="fine">${icon('shield')} ${t('no_retaliation')}</p>`);
}

async function resizePhoto(file) {
  if (!file || !file.size) return null;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  let q = 0.82, url = c.toDataURL('image/jpeg', q);
  while (url.length > 1_900_000 && q > 0.4) { q -= 0.12; url = c.toDataURL('image/jpeg', q); }
  return { mime: 'image/jpeg', dataBase64: url.split(',')[1], filename: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg' };
}

// ---------------------------------------------------------------- safety (detail: reporter and staff)
const EV_LABEL = { reported: 'Reported', acknowledged: 'Acknowledged', classified: 'Reclassified', assigned: 'Owner assigned', note: 'Note', evidence_added: 'Photo/evidence added', action_created: 'Corrective action created',
  resolution_proposed: 'Fix proposed', verified_closed: 'Verified and closed', reopened: 'Reopened', escalated: 'Escalated (not acknowledged in time)' };

async function safetyDetailView(id) {
  loadingView('#/safety');
  const r = await call('safety.detail', { reportId: id });
  const staff = anyRole('safety', 'manager', 'hr');
  if (staff && !S.employees) S.employees = await call('employees.list', {});
  const owners = (S.employees || []).filter(e => e.roles.some(x => (r.confidential ? ['safety', 'hr'] : ['safety', 'manager', 'supervisor', 'hr']).includes(x)));
  render('#/safety', html`<a class="back" href="${staff ? '#/safety' : '#/safety'}">${icon('back')} ${staff ? 'Safety queue' : t('my_reports')}</a>
    <h1>${t('t_' + r.type) !== 't_' + r.type ? t('t_' + r.type) : r.typeLabel}</h1>
    <p class="meta">${sChip(r.status)} ${prioChip(r.priority)} ${r.overdue ? html`<span class="chip c-missing">Past response target</span>` : ''} · ${fmtDT(r.createdAt)}${r.area ? ' · ' + r.area : ''}${r.equipment ? ' · ' + r.equipment : ''}${r.location ? ' · ' + r.location : ''}</p>
    <section class="card"><p class="lead-text">${r.description}</p>${r.immediateAction ? html`<p class="meta">Already done: ${r.immediateAction}</p>` : ''}
      <p class="meta">Reported by ${r.reporter.name}${r.confidential ? ' (confidential)' : ''}${r.source === 'survey' ? ' · from a weekly report' : ''} · Owner: ${r.owner ? r.owner.name : '—'} · Respond by ${fmtDT(r.responseDueAt)}</p>
      ${r.attachments.length ? html`<div class="thumbs">${r.attachments.map(a => a.mime.startsWith('image/') ? html`<figure><img data-att="${a.id}" alt="Evidence photo added by ${a.by}"><figcaption>${a.by} · ${fmtDT(a.at)}<br><code>${a.sha256.slice(0, 12)}…</code></figcaption></figure>` : html`<p>${a.filename}</p>`)}</div>` : ''}
      ${r.status !== 'closed' ? html`<form data-form="evidence" data-type="safety_report" data-id="${r.id}" class="row wrap" novalidate><label class="field photo grow"><span>${icon('camera')} Add a photo</span><input type="file" name="photo" accept="image/*" capture="environment" required></label><button class="btn" type="submit">Upload</button></form>` : ''}
    </section>
    <section class="card"><h2>Who was alerted</h2><div class="deliv">${deliveryText(r.deliverySummary)}</div>
      ${staff ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Alert delivery"><table class="matrix"><thead><tr><th scope="col">Recipient</th><th scope="col">Channel</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Seen</th></tr></thead>
        <tbody>${r.delivery.map(d => html`<tr><td>${d.recipient}${d.backup ? ' (backup)' : ''}</td><td>${d.channel === 'in_app' ? 'Hub' : 'Text'}</td><td>${chip(d.status === 'delivered' ? 'submitted' : d.status === 'failed' ? 'missing' : 'open', d.status)}${d.lastError ? html`<br><small>${d.lastError}</small>` : ''}</td><td>${d.attempts}</td><td>${d.seenAt ? fmtTime(d.seenAt) : '—'}</td></tr>`)}</tbody></table></div>` : ''}
    </section>
    <section class="card"><h2>History</h2><ol class="timeline">${r.events.map(e => html`<li><strong>${EV_LABEL[e.kind] || e.kind}</strong>${e.by ? ' · ' + e.by : ''} · <span class="meta">${fmtDT(e.at)}</span>
      ${e.detail && (e.detail.note || e.detail.resolution || e.detail.title) ? html`<p>${e.detail.note || e.detail.resolution || e.detail.title}</p>` : ''}${e.kind === 'classified' ? html`<p class="meta">${e.detail.from.priority} → ${e.detail.to.priority}${e.detail.to.area ? ' · ' + e.detail.to.area : ''}${e.detail.to.equipment ? ' · ' + e.detail.to.equipment : ''}</p>` : ''}${e.kind === 'escalated' ? html`<p class="meta">Level ${e.detail.level}</p>` : ''}</li>`)}</ol>
      ${r.resolution ? html`<p><strong>${r.status === 'closed' ? 'Resolution' : 'Proposed fix'}:</strong> ${r.resolution}${r.verifiedBy ? ' · verified by ' + r.verifiedBy : ''}</p>` : ''}</section>
    ${r.actions.length ? html`<section class="card"><h2>Corrective actions</h2><ul class="plain-list">${r.actions.map(c => html`<li><a href="#/actions">${c.title}</a><span>${c.assignedTo} · due ${fmtDate(c.dueDate)} ${chip(c.status === 'closed' ? 'submitted' : 'open', c.status.replace(/_/g, ' '))}</span></li>`)}</ul></section>` : ''}
    ${staff && r.status !== 'closed' ? html`<section class="card emphasis"><h2>Manage</h2>
      ${r.status === 'new' ? html`<form data-form="sack" data-id="${r.id}" novalidate class="row wrap"><input name="note" aria-label="Note (optional)" placeholder="What you did (optional)" maxlength="1000" class="grow"><button class="btn primary" type="submit">Acknowledge</button></form>` : ''}
      <details><summary>Classify</summary><form data-form="classify" data-id="${r.id}" novalidate class="grid2">
        <label class="field"><span>Priority</span><select name="priority">${['urgent', 'high', 'normal', 'low'].map(p => html`<option ${p === r.priority ? raw('selected') : ''}>${p}</option>`)}</select></label>
        <label class="field"><span>Area</span><select name="area"><option value="">—</option>${S.me.areas.map(a => html`<option ${a === r.area ? raw('selected') : ''}>${a}</option>`)}</select></label>
        <label class="field"><span>Machine or tool</span><input name="equipment" value="${r.equipment || ''}" maxlength="120"></label>
        <div class="field end"><button class="btn" type="submit">Save classification</button></div></form></details>
      <details><summary>Change owner</summary><form data-form="assign" data-id="${r.id}" class="row wrap" novalidate><select name="ownerId" aria-label="Owner" class="grow">${owners.map(e => html`<option value="${e.id}" ${r.owner && r.owner.id === e.id ? raw('selected') : ''}>${e.name}</option>`)}</select><button class="btn" type="submit">Assign</button></form></details>
      ${r.status !== 'new' ? html`<form data-form="snote" data-id="${r.id}" novalidate class="row wrap"><input name="note" aria-label="Add a note" placeholder="Add a note" maxlength="2000" class="grow" required><button class="btn" type="submit">Add note</button></form>
        <details><summary>Create a corrective action</summary>${caForm('safety_report', r.id)}</details>` : ''}
      ${['acknowledged', 'in_progress'].includes(r.status) ? html`<details><summary>Propose the fix is done</summary><form data-form="propose" data-id="${r.id}" novalidate><label class="field"><span>What was done?</span><textarea name="resolution" rows="2" required></textarea></label><p class="hint">Someone else must verify before it closes. Close any corrective actions first.</p><button class="btn" type="submit">Send for verification</button></form></details>` : ''}
      ${r.status === 'pending_verification' ? (r.resolutionById === S.me.employee.id ? html`<p class="alert-soft">You proposed this fix. Someone else must verify it.</p>` : html`<form data-form="sverify" data-id="${r.id}" novalidate><label class="field"><span>Verification note</span><input name="note" maxlength="1000"></label>
        <div class="row wrap"><button class="btn primary" type="submit" name="decision" value="close">Verify and close</button><button class="btn" type="submit" name="decision" value="reopen">Reopen</button></div></form>`) : ''}
    </section>` : ''}
    <p class="fine">${icon('shield')} ${t('no_retaliation')}</p>`);
}

// ---------------------------------------------------------------- safety queue (staff)
async function safetyQueueView(params) {
  loadingView('#/safety');
  const status = params.get('status') || 'open', priority = params.get('priority') || '', area = params.get('area') || '';
  const q = await call('safety.queue', { status: status === 'all' ? undefined : status, priority: priority || undefined, area: area || undefined });
  const link = (k, v) => { const p = new URLSearchParams({ status, priority, area }); p.set(k, v); return '#/safety?' + p.toString(); };
  render('#/safety', html`<div class="row between wrap"><h1>Safety issues</h1><a class="btn danger" href="#/safety/new">${icon('alert')} Report a concern</a></div>
    ${safetySections('reports')}
    <p class="lede">Unacknowledged urgent reports first, then anything past its response target. Targets: urgent 15 min, high 4 h, normal 1 working day, low 2 working days.</p>
    <nav class="subtabs" aria-label="Status filter">${[['open', 'Open'], ['new', 'Not acknowledged'], ['pending_verification', 'Needs verification'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => html`<a href="${link('status', k)}" class="${status === k ? 'on' : ''}">${l}</a>`)}</nav>
    <form class="filters row wrap" data-form="qfilter"><label class="field"><span>Priority</span><select name="priority"><option value="">Any</option>${['urgent', 'high', 'normal', 'low'].map(p => html`<option ${p === priority ? raw('selected') : ''}>${p}</option>`)}</select></label>
      <label class="field"><span>Area</span><select name="area"><option value="">Any</option>${S.me.areas.map(a => html`<option ${a === area ? raw('selected') : ''}>${a}</option>`)}</select></label><input type="hidden" name="status" value="${status}"><button class="btn" type="submit">Filter</button></form>
    <p class="fine">${icon('shield')} ${t('no_retaliation')}</p>
    <div class="stack">${q.length ? q.map(r => html`<a class="card safety-item p-${r.priority} ${r.overdue ? 'overdue' : ''} link-row" href="#/safety/r/${r.id}">
      <div class="row between wrap"><h2 class="h3">${r.typeLabel}${r.area ? ' · ' + r.area : ''}</h2><span>${prioChip(r.priority)} ${sChip(r.status)} ${r.overdue ? html`<span class="chip c-missing">Past target</span>` : ''}</span></div>
      <p class="clip">${r.description}</p>
      <p class="meta">${r.reporter.name}${r.confidential ? ' (confidential)' : ''} · ${fmtDT(r.createdAt)} · owner ${r.owner ? r.owner.name : '—'}${r.deliverySummary.failedCount ? html` · <span class="bad">${r.deliverySummary.failedCount} failed alert(s)</span>` : ''}${r.actions.length ? ` · ${r.actions.filter(a => a.status !== 'closed').length} open action(s)` : ''}</p></a>`) : html`<p class="empty-inline">${icon('shield')} Nothing here.</p>`}</div>`);
}

// Management "Safety" area = safety reports + corrective actions.
const safetySections = (on) => html`<nav class="subtabs section-tabs" aria-label="Safety sections"><a href="#/safety" class="${on === 'reports' ? 'on' : ''}" ${on === 'reports' ? raw('aria-current="page"') : ''}>Safety reports</a><a href="#/actions" class="${on === 'actions' ? 'on' : ''}" ${on === 'actions' ? raw('aria-current="page"') : ''}>Corrective actions</a></nav>`;

// ---------------------------------------------------------------- corrective actions
let EMP = null;
async function employees() { if (!EMP) EMP = await call('employees.list', {}); return EMP; }
function caForm(sourceType, sourceId) {
  const due = addDays(S.me.now.slice(0, 10), 7);
  return html`<form data-form="ca" data-source-type="${sourceType}" data-source-id="${sourceId}" novalidate class="ca-form">
    <label class="field"><span>What needs to be done?</span><input name="title" maxlength="200" required></label>
    <label class="field"><span>Details</span><textarea name="description" rows="2" maxlength="4000"></textarea></label>
    <div class="grid2"><label class="field"><span>Category</span><select name="category"><option value="safety">Safety</option><option value="operational" ${sourceType === 'survey' ? raw('selected') : ''}>Operational</option></select></label>
      <label class="field"><span>Priority</span><select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></label>
      <label class="field"><span>Responsible person</span><select name="assignedTo" data-emp-select required></select></label>
      <label class="field"><span>Due</span><input type="date" name="dueDate" required value="${due}"></label></div>
    <p class="fine">Employee-relations or confidential HR matters do not belong here — route them to HR directly.</p>
    <button class="btn primary" type="submit">Create corrective action</button></form>`;
}

async function actionsView(params) {
  loadingView('#/actions');
  const status = params.get('status') || 'open';
  const list = await call('ca.list', { status: status === 'all' ? undefined : status });
  render(isStaff() ? '#/safety' : '#/actions', html`<h1>Corrective actions</h1>
    ${isStaff() ? safetySections('actions') : ''}
    <nav class="subtabs" aria-label="Status filter">${[['open', 'Open'], ['pending_verification', 'Needs verification'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => html`<a href="#/actions?status=${k}" class="${status === k ? 'on' : ''}">${l}</a>`)}</nav>
    <div class="stack">${list.length ? list.map(c => html`<article class="card ${c.overdue ? 'overdue' : ''}">
      <div class="row between wrap"><h2 class="h3">${c.title}</h2><span>${prioChip(c.priority)} ${chip(c.status === 'closed' ? 'submitted' : c.overdue ? 'missing' : c.status === 'pending_verification' ? 'warn' : 'open', c.overdue ? 'overdue' : c.status.replace(/_/g, ' '))}</span></div>
      <p class="meta">${c.category} · ${c.assignedTo.name} · due ${fmtDate(c.dueDate)} · from ${c.sourceType === 'survey' ? html`<a href="#/record/${c.sourceId}">weekly report</a>` : c.sourceType === 'safety_report' ? html`<a href="#/safety/r/${c.sourceId}">safety report</a>` : 'manual'} · created by ${c.createdBy}</p>
      ${c.description ? html`<p>${c.description}</p>` : ''}
      ${c.resolution ? html`<p><strong>Done:</strong> ${c.resolution}${c.closureEvidence ? ' · evidence: ' + c.closureEvidence : ''}${c.doneBy ? ' · by ' + c.doneBy : ''}${c.verifiedBy ? ' · verified by ' + c.verifiedBy : ''}</p>` : ''}
      ${c.attachments.length ? html`<div class="thumbs">${c.attachments.map(a => html`<figure><img data-att="${a.id}" alt="Evidence photo"><figcaption><code>${a.sha256.slice(0, 12)}…</code></figcaption></figure>`)}</div>` : ''}
      ${c.status === 'open' && c.assignedTo.id === S.me.employee.id ? html`<form data-form="castart" data-id="${c.id}"><button class="btn" type="submit">Start</button></form>` : ''}
      ${['open', 'in_progress'].includes(c.status) && (c.assignedTo.id === S.me.employee.id || anyRole('safety', 'manager', 'hr')) ? html`<details><summary>Mark as done</summary>
        <form data-form="evidence" data-type="corrective_action" data-id="${c.id}" class="row wrap" novalidate><label class="field photo grow"><span>${icon('camera')} Photo of the fix</span><input type="file" name="photo" accept="image/*" capture="environment" required></label><button class="btn" type="submit">Upload</button></form>
        <form data-form="cadone" data-id="${c.id}" novalidate><label class="field"><span>What was done?</span><textarea name="resolution" rows="2" required></textarea></label>
        <label class="field"><span>Evidence (note, receipt, inspection) — or upload a photo above</span><input name="closureEvidence" maxlength="4000"></label><button class="btn primary" type="submit">Send for verification</button></form></details>` : ''}
      ${c.status === 'pending_verification' && c.doneById !== S.me.employee.id && c.assignedTo.id !== S.me.employee.id && anyRole('safety', 'manager', 'hr', 'supervisor') ? html`<form data-form="caverify" data-id="${c.id}" novalidate class="row wrap"><input name="note" aria-label="Verification note" placeholder="Verification note" class="grow"><button class="btn primary" type="submit" name="decision" value="close">Verify and close</button><button class="btn" type="submit" name="decision" value="reopen">Reopen</button></form>` : ''}
    </article>`) : html`<p class="empty-inline">${icon('shield')} Nothing here.</p>`}</div>`);
}

// ---------------------------------------------------------------- supervisor: team queues
async function teamView(params) {
  if (!isStaff()) return go('#/home');
  loadingView('#/team');
  const tab = params.get('tab') || 'awaiting';
  const q = await call('sup.queues', { weekId: params.get('w') || undefined });
  const Q = q.queues;
  const tabs = [['awaiting', 'Needs your review', Q.awaiting.length], ['needsResponse', 'Needs your response', Q.needsResponse.length], ['waiting', 'Waiting on employee', Q.waitingOnEmployee.length],
    ['missing', 'Missing', Q.missing.length], ['safety', 'Safety concerns', Q.safety.length], ['obstacles', 'Work obstacles', Q.obstacles.length], ['completed', 'Completed', Q.completed.length],
    ['unresolved', 'Unresolved from earlier', Q.unresolved.reviews.length + Q.unresolved.actions.length]];
  const w = q.week;
  const repRow = (r, extra = '') => html`<a class="card row wrap link-row" href="#/record/${r.submissionId}"><div class="grow"><h2 class="h3">${r.employee.name} <span class="meta">· week of ${fmtDate(r.weekId)}</span></h2>
    <p class="meta">${reviewLabel(r.review)}${r.late ? ' · signed late' : ''}${r.safety ? ' · safety' : ''}${r.injuryYes ? ' · injury answered Yes' : ''}${r.obstacle ? ' · obstacle' : ''}${r.openActions ? ` · ${r.openActions} open action(s)` : ''}</p>${extra}</div><span class="go">Open</span></a>`;
  let body;
  if (tab === 'awaiting') body = Q.awaiting.map(r => repRow(r));
  else if (tab === 'needsResponse') body = Q.needsResponse.map(r => repRow(r));
  else if (tab === 'waiting') body = Q.waitingOnEmployee.map(r => repRow(r));
  else if (tab === 'safety') body = Q.safety.map(r => repRow(r, html`${r.safetyText ? html`<p class="clip">${r.safetyText}</p>` : ''}`));
  else if (tab === 'obstacles') body = Q.obstacles.map(r => repRow(r, html`<p class="clip">${r.obstacleText}</p>`));
  else if (tab === 'completed') body = Q.completed.map(r => repRow(r));
  else if (tab === 'unresolved') body = [...Q.unresolved.reviews.map(r => repRow(r)), ...Q.unresolved.actions.map(c => html`<a class="card link-row" href="#/actions"><h2 class="h3">${c.title}</h2><p class="meta">${c.assignedTo} · due ${fmtDate(c.dueDate)} · ${c.status.replace(/_/g, ' ')}${c.overdue ? ' · overdue' : ''}</p></a>`)];
  else if (tab === 'missing') body = Q.missing.map(r => html`<article class="card"><div class="row between wrap"><h2 class="h3">${r.employee.name} <span class="meta">· week of ${fmtDate(r.weekId || w.weekId)}</span></h2>${chip(r.state)}</div>
    <details><summary>Options</summary>
      <form data-form="excuse" data-id="${r.assignmentId}" novalidate class="row wrap"><label class="field grow"><span>Excuse this week — reason (no medical details)</span><input name="reason" maxlength="180" required placeholder="e.g. vacation, out on a delivery"></label><button class="btn" type="submit">Excuse</button></form>
      <form data-form="paper" data-id="${r.assignmentId}" novalidate><label class="field"><span>Paper process</span><select name="event"><option value="paper_requested">Employee asked for a paper form</option><option value="paper_received">Signed paper form received and filed</option><option value="declined_to_sign">Employee declined to sign (record only)</option></select></label>
        <label class="field"><span>Note</span><input name="note" maxlength="1000"></label><button class="btn" type="submit">Record</button></form></details></article>`);
  else body = [];
  const statusLine = q.status.map(s => html`<li><span>${s.employee.name}</span>${chip(s.state)}</li>`);
  render('#/team', html`<h1>Review surveys</h1>
    <div class="weeknav"><a class="btn-quiet" href="#/team?tab=${tab}&w=${addDays(w.weekId, -7)}">← Previous</a><strong>${fmtDate(w.start, { month: 'short', day: 'numeric' })} – ${fmtDate(w.end, { month: 'short', day: 'numeric', year: 'numeric' })}</strong><a class="btn-quiet" href="#/team?tab=${tab}&w=${addDays(w.weekId, 7)}">Next →</a></div>
    <details class="card"><summary><strong>This week at a glance</strong> · ${q.status.filter(s => s.state.startsWith('submitted') || s.state === 'paper').length} of ${q.status.filter(s => s.state !== 'excused').length} signed</summary><ul class="plain-list">${statusLine}</ul></details>
    <nav class="subtabs" aria-label="Team queues">${tabs.map(([k, l, n]) => html`<a href="#/team?tab=${k}&w=${w.weekId}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${l} <b>${n}</b></a>`)}</nav>
    <div class="stack">${body.length ? body : html`<p class="empty-inline">${icon('shield')} Nothing here.</p>`}</div>`);
}


// ---------------------------------------------------------------- management: employee accounts
const ROLE_LABEL = (a) => a.role === 'management' ? 'Management' : 'Staff';
// QR code for authenticator apps (otpauth:// link), drawn locally; nothing leaves the page.
const qrSrc = (text) => { try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(5, 4); } catch { return ''; } };
const copyBtn = (v, label = 'Copy') => html`<button type="button" class="btn-quiet copy-btn" data-act="copy" data-copy="${v}">${label}</button>`;
const onceWarning = () => html`<p class="once-warn" role="note"><strong>Shown only once.</strong> Finish these steps (or write them down) before leaving this screen.</p>`;
const tempPinBlock = (pin, who, extra) => html`<div class="temp-block"><p>${t('temp_pin')}${who ? html` for <strong>${who}</strong>` : ''}:</p><p class="code-row"><span class="code">${pin}</span>${copyBtn(pin)}</p>${extra ? html`<p class="fine">${extra}</p>` : ''}</div>`;
const authBlock = (mfa, forWhom) => {
  const src = qrSrc(mfa.otpauth);
  return html`<div class="auth-setup"><p><strong>Authenticator${forWhom ? ' for ' + forWhom : ''}</strong> (management sign-in)</p>
    <ol class="auth-steps"><li>On the phone, open <strong>Google Authenticator</strong> (or the iPhone <strong>Passwords</strong> app) and tap <strong>+</strong>, then <strong>Scan a QR code</strong>.</li>
      <li>Point the camera at this code. A 6-digit code labelled “TAG Employee Hub” appears.</li></ol>
    ${src ? html`<img class="qr" src="${src}" alt="QR code to add the TAG Employee Hub to an authenticator app" width="220" height="220">` : ''}
    <details class="auth-manual"><summary>Can't scan? Type it in instead</summary>
      <p class="fine">Tap <strong>+</strong> → <strong>Enter a setup key</strong>. Account: <strong>TAG Hub</strong>. Key:</p><p class="code-row"><span class="code small">${mfa.secret}</span>${copyBtn(mfa.secret)}</p>
      <p class="fine"><a href="${mfa.otpauth}">On this phone: open in the authenticator app</a></p></details></div>`;
};
const secretBox = (r) => html`<div class="code-box" role="status">
  ${r.tempPin || r.mfa ? onceWarning() : ''}
  ${r.tempPin ? tempPinBlock(r.tempPin, r.account ? r.account.name : r.employee ? r.employee.name : '', `${r.instructions} Expires ${fmtDT(r.expiresAt)}.`) : ''}
  ${r.mfa ? authBlock(r.mfa, r.account ? r.account.name : '') : ''}
</div>`;
function accountForm(a, managers) {
  const isNew = !a;
  const v = a || { role: 'staff', language: 'en', fullAccess: false, safetyContact: false, reportsTo: S.me.employee.id };
  return html`<form data-form="${isNew ? 'acreate' : 'aupdate'}" data-id="${a ? a.id : ''}" novalidate class="account-form">
    <div class="grid2">
      ${isNew ? html`<label class="field"><span>Employee ID (optional)</span><input name="employeeId" maxlength="20" autocapitalize="characters" spellcheck="false" placeholder="Leave blank to assign the next number"></label>` : ''}
      <label class="field"><span>Name</span><input name="name" maxlength="80" required value="${v.name || ''}" autocomplete="off"></label>
      ${isNew ? html`<label class="field"><span>Start date</span><input type="date" name="startDate" required value="${mondayOf(S.me.now)}"><small class="hint">For someone already working here, leave this week's Monday (or use their hire date) so this week's report is expected. A new hire's first partial week is skipped.</small></label>` : ''}
      <label class="field"><span>Language</span><select name="language"><option value="en" ${v.language === 'en' ? raw('selected') : ''}>English</option><option value="es" ${v.language === 'es' ? raw('selected') : ''}>Español</option></select></label>
      <label class="field"><span>Reports to</span><select name="reportsTo"><option value="">—</option>${managers.filter(m => !a || m.id !== a.id).map(m => html`<option value="${m.id}" ${v.reportsTo === m.id ? raw('selected') : ''}>${m.name}</option>`)}</select></label>
    </div>
    <fieldset class="q"><legend>Role</legend><div class="opts yesno">
      <label class="opt"><input type="radio" name="role" value="staff" ${v.role === 'staff' ? raw('checked') : ''}><span>Staff</span></label>
      <label class="opt"><input type="radio" name="role" value="management" ${v.role === 'management' ? raw('checked') : ''}><span>Management</span></label></div>
      <p class="hint">Management signs in with PIN + authenticator app, reviews surveys and manages safety issues.</p></fieldset>
    <label class="check"><input type="checkbox" name="fullAccess" ${v.fullAccess ? raw('checked') : ''}><span><strong>Full access</strong> (Management only): every employee's surveys and employee accounts</span></label>
    <label class="check"><input type="checkbox" name="safetyContact" ${v.safetyContact ? raw('checked') : ''}><span><strong>Safety contact</strong> (Management only): gets urgent safety alerts and escalations</span></label>
    <label class="field"><span>Mobile number for urgent safety texts (Management only, optional)</span><input name="smsPhone" inputmode="tel" autocomplete="off" value="${v.smsPhone && v.smsPhone !== 'on file' ? v.smsPhone : ''}" placeholder="818-555-0142"></label>
    <button class="btn primary" type="submit">${isNew ? 'Create account' : 'Save changes'}</button></form>`;
}
async function accountsView() {
  if (!(can('accounts.manage') || can('accounts.pinReset.team'))) return go('#/home');
  loadingView('#/accounts');
  const list = await call('accounts.list', {});
  const admin = can('accounts.manage');
  const tablets = anyRole('manager', 'hr') ? await call('device.list', {}) : null;
  const managers = list.filter(a => a.role === 'management' && a.status === 'active');
  const row = (a) => html`<article class="card account ${a.status !== 'active' ? 'inactive' : ''}" id="acct-${a.id}">
    <div class="row between wrap"><div class="grow"><h2 class="h3">${a.name} <span class="meta">· ${a.id}</span></h2>
      <p class="meta"><span class="chip ${a.role === 'management' ? 'c-open' : ''}">${ROLE_LABEL(a)}</span>${a.fullAccess ? html` <span class="chip">Full access</span>` : ''}${a.safetyContact ? html` <span class="chip c-warn">Safety contact</span>` : ''}
        ${a.status !== 'active' ? html` <span class="chip c-missing">Deactivated ${a.endDate || ''}</span>` : ''}
        · reports to ${a.reportsToName || '—'} · ${a.pinSet ? 'PIN set' : a.tempPinPending ? 'temporary PIN not used yet' : 'no PIN'}${a.locked ? html` · <span class="bad">locked</span>` : ''}${a.role === 'management' ? (a.mfaEnrolled ? ' · authenticator set up' : html` · <span class="bad">no authenticator</span>`) : ''}${a.safetyContact ? (a.smsPhone ? ' · texts on' : html` · <span class="warn">no mobile number for urgent texts</span>`) : ''}${a.passkeys ? html` · Face ID on ${a.passkeys} phone${a.passkeys > 1 ? 's' : ''}` : ''}</p></div></div>
    ${a.id !== S.me.employee.id && a.status === 'active' ? html`<div class="row-actions">
      ${admin || (a.role === 'staff' && a.reportsTo === S.me.employee.id) ? html`<form data-form="setupcode" data-id="${a.id}"><button class="btn" type="submit">Reset PIN</button></form>` : ''}
      ${admin && a.role === 'management' ? html`<form data-form="enrolltotp" data-id="${a.id}"><button class="btn-quiet" type="submit">Reset authenticator</button></form>` : ''}
      ${a.passkeys && (admin || (a.role === 'staff' && a.reportsTo === S.me.employee.id)) ? html`<form data-form="pkremoveall" data-id="${a.id}" data-name="${a.name}"><button class="btn-quiet" type="submit">Remove Face ID phones</button></form>` : ''}
      ${admin ? html`<form data-form="adeact" data-id="${a.id}"><button class="btn-quiet" type="submit">Deactivate</button></form>` : ''}
    </div>` : ''}
    ${a.status !== 'active' && admin ? html`<div class="row-actions"><form data-form="areact" data-id="${a.id}"><button class="btn" type="submit">Reactivate</button></form></div>` : ''}
    <div class="acct-out" role="status"></div>
    ${a.status === 'active' && (admin || a.reportsTo === S.me.employee.id) ? html`<details><summary>Record time off</summary><form data-form="absence" data-id="${a.id}" class="grid2" novalidate><label class="field"><span>From</span><input type="date" name="startDate" required></label><label class="field"><span>To</span><input type="date" name="endDate" required></label>
      <label class="field"><span>Type</span><select name="reason"><option value="vacation">Vacation</option><option value="leave">Leave</option><option value="other">Other</option></select></label><div class="field end"><button class="btn" type="submit">Save</button></div></form>
      <p class="fine">Never record medical reasons. Weeks with fewer than 3 workdays are not expected.</p></details>` : ''}
    ${admin && a.status === 'active' ? html`<details><summary>Edit</summary>${accountForm(a, managers)}</details>` : ''}
  </article>`;
  render('#/accounts', html`<h1>Employee accounts</h1>
    <p class="lede">Each person signs in with their employee ID and their own PIN. Give temporary PINs in person; the person chooses their own PIN at first sign-in.</p>
    ${admin ? html`<details class="card" id="new-account"><summary><strong>Add a person</strong></summary>${accountForm(null, managers)}<div id="create-out" role="status"></div></details>` : ''}
    <div class="stack">${list.map(row)}</div>
    ${tablets ? html`<section class="card" id="tablets"><h2>Shop tablets</h2>
      <p class="hint">Optional. A registered tablet always signs people out after 5 minutes idle and after each submission, whatever the "shared" box says, and its name goes into each signed record. Register a tablet from the tablet itself.</p>
      <form data-form="regdevice" class="row wrap" novalidate><label class="field grow"><span>Tablet name</span><input name="label" maxlength="60" value="Shop tablet" required></label><button class="btn" type="submit">Register this browser as a shop tablet</button></form>
      <ul class="plain-list">${tablets.map(d => html`<li><span><strong>${d.label}</strong> · ${d.id} · ${fmtDate(d.registered_at)}${d.revoked_at ? ' · revoked' : ''}</span>${d.revoked_at ? '' : html`<form data-form="revdevice" data-id="${d.id}"><button class="btn-quiet" type="submit">Revoke</button></form>`}</li>`)}</ul></section>` : ''}`);
}

// ---------------------------------------------------------------- dashboard
async function dashView(params) {
  if (!isStaff()) return go('#/home');
  loadingView('#/dash');
  const view = params.get('view') || 'week';
  const input = { view, weekId: params.get('w') || undefined, month: params.get('m') || undefined, supervisorId: params.get('sup') || undefined, employeeId: params.get('emp') || undefined };
  const [d, mine, alerts] = await Promise.all([call('mgmt.dashboard', input), call('home', {}), call('alerts.mine', {})]);
  const myOpen = mine.surveys.slice().reverse().find(x => ['open', 'missing'].includes(x.state));
  const urgentUnseen = alerts.filter(n => n.urgent && !n.seen_at);
  const qs = (patch) => { const p = new URLSearchParams(Object.entries({ view, w: input.weekId || '', m: input.month || '', sup: input.supervisorId || '', emp: input.employeeId || '' }).filter(([, v]) => v)); for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k); return '#/dash?' + p.toString(); };
  const tile = (n, label, href, tone = '') => html`<a class="tile ${tone}" href="${href}"><b>${n}</b><span>${label}</span></a>`;
  const W = d.weeks[0];
  const focus = d.focusWeek;
  const maxExp = Math.max(1, ...d.weeks.map(x => x.expected));
  const people = d.scope === 'safety-only' ? [] : (await employees().catch(() => []));
  const month = (input.month || focus.start.slice(0, 7));
  const prevMonth = (() => { const [y, m] = month.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 2, 1)); return dt.toISOString().slice(0, 7); })();
  const nextMonth = (() => { const [y, m] = month.split('-').map(Number); const dt = new Date(Date.UTC(y, m, 1)); return dt.toISOString().slice(0, 7); })();
  render('#/dash', html`<h1>Weekly completion</h1>
    ${urgentUnseen.length ? html`<a class="stop-banner" href="${refHref(urgentUnseen[0])}" data-seen="${urgentUnseen[0].id}">${icon('alert')}<span><strong>${urgentUnseen.length} urgent alert${urgentUnseen.length > 1 ? 's' : ''}</strong><br>${urgentUnseen[0].subject}</span></a>` : ''}
    ${myOpen ? html`<a class="todo ${myOpen.state === 'missing' ? 'urgent' : ''} own-survey" href="#/checkin/${myOpen.assignmentId}">${icon('check')}<span><strong>Your own weekly survey</strong><small>${t('week_of')} ${fmtDate(myOpen.week.start)} · ${myOpen.state === 'missing' ? t('st_missing') : t('due') + ' ' + fmtDT(myOpen.week.dueAt)}</small></span><span class="go">${t('start')}</span></a>` : ''}
    <p class="lede">${d.scope === 'team' ? 'Your direct reports' : d.scope === 'all' ? 'Everyone' : 'Safety view — weekly report answers are visible only to each employee\'s supervisor and HR.'}</p>
    ${d.scope !== 'safety-only' ? html`
    <nav class="subtabs" aria-label="Period">${[['week', 'Week'], ['month', 'Month'], ['history', 'Last 12 weeks']].map(([k, l]) => html`<a href="${qs({ view: k })}" class="${view === k ? 'on' : ''}" ${view === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
    <form class="filters row wrap" data-form="dfilter"><input type="hidden" name="view" value="${view}"><input type="hidden" name="w" value="${input.weekId || ''}"><input type="hidden" name="m" value="${input.month || ''}">
      ${d.supervisors.length ? html`<label class="field"><span>Supervisor</span><select name="sup"><option value="">All</option>${d.supervisors.map(s => html`<option value="${s.id}" ${s.id === input.supervisorId ? raw('selected') : ''}>${s.name}</option>`)}</select></label>` : ''}
      <label class="field"><span>Employee</span><select name="emp"><option value="">All</option>${people.map(e => html`<option value="${e.id}" ${e.id === input.employeeId ? raw('selected') : ''}>${e.name}</option>`)}</select></label>
      <button class="btn" type="submit">Apply</button></form>
    ${view === 'week' ? html`<div class="weeknav"><a class="btn-quiet" href="${qs({ w: addDays(focus.weekId, -7) })}">← Previous</a><strong>Week of ${fmtDate(focus.start, { month: 'short', day: 'numeric', year: 'numeric' })}</strong><a class="btn-quiet" href="${qs({ w: addDays(focus.weekId, 7) })}">Next →</a></div>
      <div class="tiles">
        ${tile(`${W.onTime + W.late + W.paper} / ${W.expected}`, 'Signed (incl. paper)', '#dash-table')}
        ${tile(W.notYet, 'Not yet submitted (still open)', '#dash-table')}
        ${tile(W.missing, 'Missing (past due)', '#dash-table', W.missing ? 'warn' : '')}
        ${tile(W.late, 'Signed late', '#dash-table')}
        ${tile(W.awaitingReview, 'Awaiting supervisor review', '#/team?tab=awaiting', W.awaitingReview ? 'info' : '')}
        ${tile(W.waitingOnEmployee, 'Waiting on employee answer', '#/team?tab=waiting')}
      </div>
      <section class="card" id="dash-table"><h2>Who submitted</h2><div class="table-wrap" tabindex="0" role="region" aria-label="Weekly status by employee"><table class="matrix"><thead><tr><th scope="col">Employee</th><th scope="col">Supervisor</th><th scope="col">Status</th><th scope="col">Review</th><th scope="col">Flags</th></tr></thead>
        <tbody>${W.rows.map(r => html`<tr><th scope="row">${r.canOpen ? html`<a href="#/record/${r.submissionId}">${r.employee.name}</a>` : r.employee.name}</th><td>${r.supervisor || '—'}</td><td>${chip(r.state)}${r.reason ? html`<br><small>${r.reason}</small>` : ''}</td><td>${r.review ? reviewLabel(r.review) : '—'}</td><td>${r.safety ? 'safety ' : ''}${r.obstacle ? 'obstacle' : ''}</td></tr>`)}</tbody></table></div></section>` : html`
      ${view === 'month' ? html`<div class="weeknav"><a class="btn-quiet" href="${qs({ m: prevMonth })}">← Previous</a><strong>${fmtDate(month + '-15', { month: 'long', year: 'numeric' })}</strong><a class="btn-quiet" href="${qs({ m: nextMonth })}">Next →</a></div>` : ''}
      <section class="card"><h2>Weekly completion</h2>
        <div class="bars" role="img" aria-label="${d.weeks.map(x => fmtDate(x.week.weekId) + ': ' + (x.rate ?? 'before pilot') + (x.rate !== null ? '%' : '')).join(', ')}">${d.weeks.map(x => html`<div class="bar"><span class="cap" data-css-h="${x.expected / maxExp}"></span><span class="fill" data-css-h="${x.expected ? (x.onTime + x.late + x.paper) / maxExp : 0}"></span><b>${x.rate === null ? '—' : x.rate + '%'}</b><small>${fmtDate(x.week.weekId)}</small></div>`)}</div>
        <p class="fine">Dashed outline = people expected; fill = signed (on time, late or paper). Weeks before the pilot show —.</p>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Weekly totals"><table class="matrix"><thead><tr><th scope="col">Week</th><th scope="col">Expected</th><th scope="col">On time</th><th scope="col">Late</th><th scope="col">Paper</th><th scope="col">Missing</th><th scope="col">Reviewed</th></tr></thead>
          <tbody>${d.weeks.map(x => html`<tr><th scope="row"><a href="${qs({ view: 'week', w: x.week.weekId })}">${fmtDate(x.week.weekId)}</a></th><td>${x.expected}</td><td>${x.onTime}</td><td>${x.late}</td><td>${x.paper}</td><td>${x.missing}</td><td>${x.signedOff}</td></tr>`)}</tbody></table></div></section>`}
    <section class="card"><h2>Supervisor review reliability</h2>${d.reliability.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Review reliability"><table class="matrix"><thead><tr><th scope="col">Supervisor</th><th scope="col">Reports</th><th scope="col">Signed off</th><th scope="col">Within 3 working days</th><th scope="col">Median working hours to review</th></tr></thead>
      <tbody>${d.reliability.map(r => html`<tr><th scope="row">${r.supervisor}</th><td>${r.submitted}</td><td>${r.signedOff}</td><td>${r.onTargetPct === null ? '—' : r.onTargetPct + '%'}</td><td>${r.medianWorkingHours ?? '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="empty-inline">No reports in this period.</p>`}</section>` : ''}
    <section class="card"><h2>Safety and corrective actions</h2><div class="tiles">
      ${tile(d.safety.open, 'Open safety reports', '#/safety?status=open', d.safety.open ? 'info' : '')}
      ${tile(d.safety.urgentOpen, 'Urgent still open', '#/safety?status=open&priority=urgent', d.safety.urgentOpen ? 'danger' : '')}
      ${tile(d.safety.overdue, 'Past response target', '#/safety?status=new', d.safety.overdue ? 'danger' : '')}
      ${tile(d.safety.pendingVerification, 'Fixes awaiting verification', '#/safety?status=pending_verification')}
      ${tile(d.actions.open, 'Open corrective actions', '#/actions?status=open')}
      ${tile(d.actions.overdue, 'Overdue corrective actions', '#/actions?status=open', d.actions.overdue ? 'danger' : '')}
      ${d.notificationFailures7d !== null ? tile(d.notificationFailures7d, 'Alerts that failed (7 days)', '#/admin?tab=delivery', d.notificationFailures7d ? 'warn' : '') : ''}
    </div>
    ${d.safety.unresolved.length ? html`<h3>Unresolved</h3><ul class="plain-list">${d.safety.unresolved.map(r => html`<li>${anyRole('safety', 'manager', 'hr') ? html`<a href="#/safety/r/${r.id}">${r.typeLabel}${r.area ? ' · ' + r.area : ''}</a>` : html`<span>${r.typeLabel}${r.area ? ' · ' + r.area : ''}</span>`}<span>${prioChip(r.priority)} ${sChip(r.status)}${r.overdue ? html` <span class="chip c-missing">past target</span>` : ''}</span></li>`)}</ul>` : ''}</section>
    <section class="card"><h2>Recurring problems (last 8 weeks)</h2><div class="grid3">
      <div><h3>By area</h3>${trendList(d.trends.byArea)}</div><div><h3>By machine or tool</h3>${trendList(d.trends.byEquipment)}</div><div><h3>By type</h3>${trendList(d.trends.byType)}</div></div>
      ${d.trends.obstacles.length ? html`<h3>Work obstacles from weekly reports</h3><ul class="plain-list">${d.trends.obstacles.map(o => html`<li><a href="#/record/${o.submissionId}">${o.text}</a><span class="meta">${o.employee} · ${fmtDate(o.weekId)}</span></li>`)}</ul>` : ''}
      <p class="fine">Counts describe problems, never people. Report counts are never used to score employees.</p></section>`);
}
const trendList = (arr) => arr.length ? html`<ul class="trend">${arr.map(x => html`<li><span>${x.label}</span><b>${x.n}</b></li>`)}</ul>` : html`<p class="meta">—</p>`;

// ---------------------------------------------------------------- alerts, more, admin
const refHref = (n) => n.kind === 'safety' || n.kind === 'safety_status' ? '#/safety/r/' + n.ref : n.kind === 'action' ? '#/actions' : (n.kind === 'review' || n.kind === 'clarification') ? '#/record/' + n.ref : n.kind === 'survey_open' ? '#/checkin' : '#/home';
async function alertsView() {
  loadingView('#/more');
  const list = await call('alerts.mine', {});
  const unseen = list.filter(n => !n.seen_at).map(n => n.id);
  render('#/more', html`<a class="back" href="#/more">${icon('back')} ${t('more_title')}</a><div class="row between wrap"><h1>${t('alerts_title')}</h1>${unseen.length ? html`<button class="btn-quiet" data-act="seen-all" data-ids="${unseen.join(',')}">${t('mark_all_seen')}</button>` : ''}</div>
    ${list.length ? html`<ul class="alerts">${list.map(n => html`<li class="${n.seen_at ? '' : 'unseen'} ${n.urgent ? 'urgent' : ''}"><a href="${refHref(n)}" data-seen="${n.id}"><strong>${n.subject}</strong><small>${fmtDT(n.created_at)}</small></a></li>`)}</ul>` : html`<p class="empty-inline">${t('no_alerts')}</p>`}`);
}

function moreView() {
  const m = S.me;
  const unseen = m.unseenAlerts || 0;
  render('#/more', html`<h1>${t('more_title')}</h1>
    <div class="stack">
      ${isStaff() ? html`<a class="card row link-row" href="#/checkin">${icon('check')}<span class="grow">My weekly survey and previous surveys</span></a>
        <a class="card row link-row" href="#/actions">${icon('wrench')}<span class="grow">All corrective actions</span></a>` : ''}
      <a class="card row link-row" href="#/alerts">${icon('bell')}<span class="grow">${t('alerts_title')}</span>${unseen ? html`<b class="badge">${unseen}</b>` : ''}</a>
      ${!isStaff() ? html`<a class="card row link-row" href="#/safety">${icon('alert')}<span class="grow">${t('my_reports')}</span></a>` : ''}
      ${can('admin.delivery') || can('admin.integrity') ? html`<a class="card row link-row" href="#/admin">${icon('lock')}<span class="grow">Admin: questionnaire versions, alert delivery, integrity check</span></a>` : ''}
    </div>
    <section class="card"><h2>${t('profile')}</h2><dl class="kv"><dt>${t('signin_id')}</dt><dd>${m.employee.id}</dd><dt>Name</dt><dd>${m.employee.name}</dd><dt>Role</dt><dd>${m.role === 'management' ? 'Management' : 'Staff'}${m.fullAccess ? ' · full access' : ''}${m.safetyContact ? ' · safety contact' : ''}</dd>
      <dt>${t('esign')}</dt><dd>${m.consent ? m.consent.choice : '—'} <button class="link" data-act="consent-change">${t('edit')}</button></dd>
      <dt>${t('language')}</dt><dd><button class="btn-quiet" data-act="lang">${S.lang === 'en' ? 'Español' : 'English'}</button></dd>
      <dt>Session</dt><dd>${m.sharedDevice ? t('shared_on') : 'Personal device'} · signs out after ${m.idleMinutes} min idle</dd></dl></section>
    ${isStaff() ? html`<div id="hours-more"></div>` : ''}
    ${!m.deviceId && !window.HUB_LOCAL ? html`<section class="card" id="rem-section"><h2>${t('rem_title')}</h2><p class="hint">${t('rem_help')}</p><div id="rem-box" role="status"><p class="meta">${t('loading')}</p></div></section>` : ''}
    ${passkeySupported() && !m.deviceId ? html`<section class="card" id="pk-section"><h2>${t('pk_section')}</h2><p class="hint">${t('pk_help')}</p><div id="pk-list" role="status"><p class="meta">${t('loading')}</p></div></section>` : ''}
    <section class="card"><details><summary><strong>${t('change_pin')}</strong></summary><form data-form="changepin" novalidate>
      <label class="field"><span>${t('current_pin')}</span><input name="currentPin" type="password" inputmode="numeric" maxlength="12" autocomplete="current-password" required></label>
      <label class="field"><span>${t('setpin_new')}</span><input name="newPin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" required></label>
      <label class="field"><span>${t('setpin_confirm')}</span><input name="confirmPin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" required></label>
      <button class="btn" type="submit">${t('setpin_btn')}</button></form></details></section>
    <section class="card"><h2>${t('links')}</h2><div class="links">${[
      { label: { en: 'My Work (Order Manager)', es: 'Mi trabajo (Order Manager)' }, url: 'https://thearmoredgroup.quickbase.com/db/bf5ukkqy7', note: 'Quickbase sign-in' },
      { label: { en: 'Time clock (QuickBooks Time)', es: 'Reloj (QuickBooks Time)' }, url: 'https://quickbooks.intuit.com/time-tracking/', note: 'Intuit sign-in' }].map(linkCard)}</div></section>
    <button class="btn wide" data-act="signout">${t('signout')}</button>`);
  if (passkeySupported() && !m.deviceId) renderPkList();
  if (!m.deviceId && !window.HUB_LOCAL) renderReminders();
  if (isStaff()) loadHours('hours-more');
}
// Reminders on this phone (web push). The server key is fetched first so the permission prompt
// opens right on the tap (phones ignore prompts that come after a network wait).
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function currentPushSub() { try { const reg = await navigator.serviceWorker.getRegistration('/'); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; } }
async function renderReminders(note) {
  const box = document.getElementById('rem-box'); if (!box) return;
  if (S.me.sharedDevice) { box.innerHTML = String(html`<p class="meta">${t('pk_shared_note')}</p>`); return; }
  if (!pushSupported()) { box.innerHTML = String(html`<p class="meta">${isIOS() && !isStandalone() ? t('rem_need_install') : t('rem_unsupported')}</p>`); return; }
  let st; try { st = await call('push.status', {}); } catch (e) { if (!quiet(e)) box.textContent = errMsg(e); return; }
  S.pushKey = st.publicKey;
  const sub = await currentPushSub();
  const on = !!sub && st.phones.some(p => sub.endpoint.endsWith(p.endpointTail));
  const denied = Notification.permission === 'denied';
  const b2 = document.getElementById('rem-box'); if (!b2) return;
  b2.innerHTML = String(html`${note ? html`<p class="success-inline">${note}</p>` : ''}
    ${!st.enabled ? html`<p class="alert-soft">${t('rem_mgmt_off')}</p>` : ''}
    ${denied ? html`<p class="alert-soft">${t('rem_denied')}</p>` : ''}
    ${on ? html`<p class="success-inline">${icon('bell')} ${t('rem_is_on')}</p><div class="row wrap"><button class="btn" data-act="push-test">${t('rem_test')}</button><button class="btn-quiet" data-act="push-off">${t('rem_off')}</button></div>`
      : html`<button class="btn primary" data-act="push-on" ${denied ? raw('disabled') : ''}>${icon('bell')} ${t('rem_on')}</button>`}`);
}
async function renderPkList(note) {
  const box = document.getElementById('pk-list'); if (!box) return;
  let list;
  try { list = await call('passkey.mine', {}); } catch (e) { if (!quiet(e)) box.textContent = errMsg(e); return; }
  // Hidden once this phone is set up for this person (the browser remembers it).
  const canAdd = !S.me.sharedDevice && !pkReadyFor(S.me.employee.id) && await platformAvailable();
  S.pkReg = null;
  const box2 = document.getElementById('pk-list'); if (!box2) return;
  box2.innerHTML = String(html`${note ? html`<p class="success-inline">${note}</p>` : ''}
    ${list.length ? html`<ul class="plain-list">${list.map(p => html`<li><span><strong>${p.device}</strong> · ${t('pk_added')} ${fmtDate(p.createdAt)}${p.lastUsedAt ? html` · ${t('pk_last_used')} ${fmtDT(p.lastUsedAt)}` : ''}</span><button class="btn-quiet" data-act="pk-remove" data-id="${p.id}">${t('pk_remove')}</button></li>`)}</ul>` : html`<p class="meta">${t('pk_none')}</p>`}
    ${S.me.sharedDevice ? html`<p class="alert-soft" role="note">${t('pk_shared_note')}</p><button class="btn" data-act="pk-relogin">${t('pk_relogin')}</button>` : ''}
    ${canAdd ? html`<details class="pk-add"><summary><strong>${tm('pk_setup_here')}</strong></summary>${pkSetupBlock()}</details>` : ''}`);
}

async function adminView(params) {
  loadingView('#/more');
  const tab = params.get('tab') || 'versions';
  const tabs = [['versions', 'Questionnaire versions']];
  if (anyRole('manager', 'hr', 'safety')) tabs.push(['delivery', 'Alert delivery']);
  if (anyRole('manager', 'hr')) tabs.push(['integrity', 'Integrity']);
  if (can('admin.restore')) tabs.push(['restore', 'Restore & backup']);
  if (can('admin.restore')) tabs.push(['reminders', 'Reminders']);
  if (can('admin.restore')) tabs.push(['qbt', 'QuickBooks Time']);
  let body = '';
  if (tab === 'versions') {
    const v = await call('survey.versions', {});
    const byId = Object.fromEntries(v.versions.map(x => [x.id, x]));
    const qids = ['q1', 'q2', 'q3', 'q4'];
    const q = (tpl, id) => tpl.sections.flatMap(s => s.questions).find(x => x.id === id);
    body = html`<p class="lede">Active version: <strong>${v.active}</strong>. The proposed version cannot be assigned until management approves it in writing.</p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Questionnaire comparison"><table class="matrix cmp"><thead><tr><th scope="col">#</th><th scope="col">Original paper (archived)</th><th scope="col">Digital v1.0 (active)</th><th scope="col">Proposed v2.0 (not approved)</th></tr></thead><tbody>
      <tr><th scope="row">Intro</th><td>${byId['WR-PAPER'].intro.en}</td><td>${byId['WR-1.0'].intro.en}<p class="bad">Withheld (gate G1): “${byId['WR-1.0'].withheld[0].text.en}”</p></td><td>${byId['WR-2.0-P'].intro.en}</td></tr>
      ${qids.map(id => html`<tr><th scope="row">${id.toUpperCase()}</th><td>${q(byId['WR-PAPER'], id).text.en}<br><small lang="es">${q(byId['WR-PAPER'], id).text.es}</small></td><td>${q(byId['WR-1.0'], id).text.en}<br><small lang="es">${q(byId['WR-1.0'], id).text.es}</small></td><td>${q(byId['WR-2.0-P'], id) ? html`${q(byId['WR-2.0-P'], id).text.en}<br><small lang="es">${q(byId['WR-2.0-P'], id).text.es}</small>` : '—'}</td></tr>`)}
      <tr><th scope="row">Added</th><td>—</td><td>${byId['WR-1.0'].sections.flatMap(s => s.questions).filter(x => x.origin === 'supplemental').map(x => html`<p>${x.text.en}</p>`)}</td><td>${byId['WR-2.0-P'].sections.flatMap(s => s.questions).filter(x => x.origin !== 'revised' && x.origin !== 'replaced').map(x => html`<p>${x.text.en}</p>`)}</td></tr>
      <tr><th scope="row">Signature</th><td>Wet ink signature and date</td><td>${byId['WR-1.0'].signature.method}</td><td>${byId['WR-2.0-P'].signature.method}</td></tr>
      </tbody></table></div><p class="fine">Full reasons for each change: docs/C-questionnaire-version-comparison.md.</p>`;
  } else if (tab === 'delivery') {
    const log = await call('notifications.log', { failedOnly: params.get('failed') === '1' });
    body = html`<p class="lede">Text alerts are retried after 1, 2 and 5 minutes. After 4 failed tries the alert is marked failed, the person gets an in-app copy, and urgent alerts go to the next people in line. Prototype: texts are simulated.</p>
      <p><a href="#/admin?tab=delivery&failed=1">Show failures only</a> · <a href="#/admin?tab=delivery">Show all</a></p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Delivery log"><table class="matrix"><thead><tr><th scope="col">When</th><th scope="col">To</th><th scope="col">Message</th><th scope="col">Status</th><th scope="col">Attempts</th></tr></thead>
      <tbody>${log.map(n => html`<tr><td>${fmtDT(n.created_at)}</td><td>${n.recipient}${n.backup_for ? ' (backup)' : ''}</td><td>${n.subject}</td><td>${chip(n.status === 'delivered' ? 'submitted' : n.status === 'failed' ? 'missing' : 'open', n.status)}</td><td>${n.attemptLog.map(a => (a.ok ? '✓ ' : '✗ ') + fmtTime(a.at)).join(', ')}</td></tr>`)}</tbody></table></div>
      ${S.me.demo && anyRole('manager', 'hr') ? html`<details><summary>Demo: simulate text failures</summary><form data-form="simfail" class="row wrap" novalidate><select name="employeeId" aria-label="Person">${(await employees()).map(e => html`<option value="${e.id}">${e.name}</option>`)}</select><input name="count" type="number" min="0" max="10" value="4" aria-label="Failures"><button class="btn" type="submit">Set</button></form></details>` : ''}`;
  } else if (tab === 'integrity') {
    body = html`<p>Re-computes every signed record and the audit-log hash chain.</p><button class="btn primary" data-act="verify">Run integrity check</button><div id="verify-out" role="status"></div>`;
  } else if (tab === 'qbt' && can('admin.restore')) {
    const st = await call('admin.qbtStatus', {});
    let list = null;
    if (st.configured && st.ok) list = await call('admin.qbtUsers', { refresh: params.get('refresh') === '1' });
    body = html`<p class="lede">Read-only: the Hub can read clocked hours from QuickBooks Time. Nothing in QuickBooks Time is changed.</p>
      <section class="card"><h2>“My hours” card for staff: ${st.showHours ? 'ON' : 'OFF'}</h2><p>Shows each person their own clocked hours (not their paycheck). Off by default, because staff already see their hours in the QuickBooks Time app.</p>
        <button class="btn" data-act="qbt-show" data-on="${st.showHours ? '0' : '1'}">${st.showHours ? 'Hide the My hours card' : 'Show the My hours card'}</button></section>
      <section class="card"><h2>${!st.configured ? 'Not connected' : st.ok ? (st.demo ? 'Sample data (test copy)' : 'Connected') : 'Connection problem'}</h2>
        ${!st.configured ? html`<p>Add the QuickBooks Time access token to the live Hub as the Cloudflare secret <code>QBT_TOKEN</code> (steps in the project docs, 09-quickbooks-time-setup). The test copy never uses the real token.</p>`
          : st.ok ? html`<p>${st.users} QuickBooks Time ${st.users === 1 ? 'person' : 'people'} · ${st.links} linked to Hub accounts.</p>` : html`<p class="alert">${st.error}</p>`}</section>
      ${list ? html`<section class="card"><div class="row between wrap"><h2>Link accounts</h2><a class="btn-quiet" href="#/admin?tab=qbt&refresh=1">Refresh list</a></div>
        <p class="hint">Pick each person's QuickBooks Time name. A matching name is suggested, but nothing is linked until you choose it.</p>
        <div class="table-wrap" tabindex="0" role="region" aria-label="QuickBooks Time links"><table class="matrix"><thead><tr><th scope="col">Hub account</th><th scope="col">QuickBooks Time person</th></tr></thead><tbody>
        ${list.accounts.map(a => html`<tr><td>${a.name} <span class="meta">${a.id}</span></td><td><form data-form="qbtlink" data-id="${a.id}" class="row wrap qbt-row"><select name="qbtUserId" aria-label="QuickBooks Time person for ${a.name}"><option value="">— not linked —</option>
          ${list.users.filter(u => !u.linkedTo || u.linkedTo === a.id).map(u => html`<option value="${u.id}" ${(a.linkedTo && a.linkedTo.id === u.id) ? raw('selected') : ''}>${u.name}</option>`)}</select>
          <button class="btn-quiet" type="submit">Save</button>${a.suggestion ? html`<button class="link" type="submit" name="suggest" value="${a.suggestion.id}">Use suggestion: ${a.suggestion.name}</button>` : ''}${a.linkedTo ? html`<span class="success-inline">✓ linked</span>` : ''}</form></td></tr>`)}
        </tbody></table></div></section>` : ''}`;
  } else if (tab === 'reminders' && can('admin.restore')) {
    const st = await call('admin.pushStatus', {});
    const sent = (k) => st.last14days.filter(x => x.kind === k && ['sent', 'shown'].includes(x.status)).reduce((a, b) => a + b.n, 0);
    body = html`<p class="lede">Phone notifications for the weekly report, instead of text messages. Free; nothing goes through GoTo.</p>
      <section class="card"><h2>${st.enabled ? 'Reminders are ON' : 'Reminders are OFF'}</h2>
        <ul><li>Friday when the report opens: “Your weekly report is open”.</li><li>Monday 9:00 AM, only if still not signed: “Your weekly report is due today”.</li><li>Only during work hours (Mon–Fri 7:00 AM–3:30 PM), only to people who turned reminders on, on their own phone. The notification text never contains answers or names.</li></ul>
        <p>${st.people} ${st.people === 1 ? 'person has' : 'people have'} turned reminders on. Last 14 days: ${sent('report_open')} “open” and ${sent('report_due')} “due today” delivered.</p>
        ${!st.available ? html`<p class="alert-soft">Sending works only on Cloudflare (not in this copy).</p>` : ''}
        <button class="btn ${st.enabled ? '' : 'primary'}" data-act="push-switch" data-on="${st.enabled ? '0' : '1'}">${st.enabled ? 'Switch reminders off' : 'Switch reminders on for everyone who opted in'}</button></section>
      <p class="hint">Each person turns reminders on under More on their phone (on iPhone, after adding the Hub to the home screen). “Send me a test” there works even while reminders are off.</p>`;
  } else if (tab === 'restore' && can('admin.restore')) {
    const st = await call('admin.restoreStatus', {});
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(Date.now() - 3600000);
    const defaultLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    body = html`<p class="lede">Puts <strong>all</strong> Hub data back to how it was at an earlier moment, up to ${st.maxDays} days ago. Use it only to recover from a serious mistake. Everything entered after that moment is set aside, and the Hub restarts. Every restore can be undone.</p>
      ${st.available ? html`<form data-form="restore" class="card stack" novalidate>
        <label>Go back to (your local time)<input type="datetime-local" name="toTime" value="${defaultLocal}"></label>
        ${st.log.length ? html`<label>Or undo an earlier restore<select name="undoId"><option value="">— no, go back to the time above —</option>${st.log.map(x => html`<option value="${x.id}">Undo ${x.id} (${fmtDT(x.requestedAt)}, ${x.requestedByName})</option>`)}</select></label>` : ''}
        <label>Your PIN<input name="signPin" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>
        <label>Authenticator code<input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>
        <label>Type RESTORE to confirm<input name="confirm" autocomplete="off"></label>
        <button class="btn danger" type="submit">Restore</button></form>` : html`<p class="alert-soft">Restore is available only on Cloudflare, not in this copy.</p>`}
      <h2>Backup copy</h2><p>Download a complete copy of the records to keep somewhere safe outside Cloudflare (sign-in secrets are left out). It contains confidential safety reports: store it like a personnel file. Do this weekly during the pilot.</p>
      <button class="btn" data-act="backup">Download backup</button><div id="backup-out" role="status"></div>
      ${st.log.length ? html`<h2>Past restores</h2><ul>${st.log.map(x => html`<li>${x.id} — ${fmtDT(x.requestedAt)} by ${x.requestedByName}: ${x.target.kind === 'undo' ? 'undo of ' + x.target.of : 'back to ' + fmtDT(x.target.time)}</li>`)}</ul>` : ''}`;
  }
  render('#/more', html`<a class="back" href="#/more">${icon('back')} ${t('more_title')}</a><h1>Admin</h1><nav class="subtabs" aria-label="Admin sections">${tabs.map(([k, l]) => html`<a href="#/admin?tab=${k}" class="${tab === k ? 'on' : ''}">${l}</a>`)}</nav>${body}`);
}

// ---------------------------------------------------------------- router
async function route() {
  navSeq++;
  const hash = location.hash || '#/home';
  const [pathPart, query = ''] = hash.slice(1).split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  await loadConfig();
  if (!S.me) {
    // Signed out: the portal and the weekly report are open; everything else asks for ID + PIN.
    let me = null;
    try { me = await api.call('session.me', {}); } catch { me = null; }
    if (!me) {
      if (parts[0] === 'r') return quickReport();
      if (parts[0] === undefined || parts[0] === 'home') return portalView();
      S.next = parts[0] === 'login' ? params.get('next') : null;
      return loginView();
    }
    try { await loadMe(); } catch { return loginView(); }
  }
  if (S.me.mustSetPin) return setPinView();
  document.body.classList.remove('plain');
  try {
    switch (parts[0]) {
      case 'login': return go('#/home');
      case 'r': return afterSignIn();
      case 'setpin': return setPinView();
      case 'home': case undefined: return await homeView();
      case 'checkin': return parts[1] ? await surveyView(parts[1]) : await checkinListView();
      case 'record': return await recordView(parts[1], params.get('new') === '1');
      case 'consent': return consentView(params.get('next'));
      case 'safety':
        if (parts[1] === 'new') return await safetyNewView();
        if (parts[1] === 'r') return await safetyDetailView(parts[2]);
        return anyRole('safety', 'manager', 'hr') ? await safetyQueueView(params) : await safetyMineView();
      case 'actions': return await actionsView(params);
      case 'team': return await teamView(params);
      case 'dash': return await dashView(params);
      case 'alerts': return await alertsView();
      case 'more': return moreView();
      case 'admin': return await adminView(params);
      case 'accounts': return await accountsView();
      default: return go('#/home');
    }
  } catch (e) {
    if (quiet(e)) return;
    errorView('#/' + (parts[0] || 'home'), e);
  }
}

// ---------------------------------------------------------------- events
root.addEventListener('click', async (ev) => {
  const k = ev.target.closest('[data-key]');
  if (k) {
    const input = document.getElementById(k.dataset.target); if (!input) return;
    if (k.dataset.key === 'del') input.value = input.value.slice(0, -1);
    else if (k.dataset.key === 'clear') input.value = '';
    else if (input.value.length < 12) input.value += k.dataset.key;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const seenLink = ev.target.closest('a[data-seen]');
  if (seenLink) { api.call('alerts.seen', { ids: [seenLink.dataset.seen] }).then(refreshMe).catch(() => {}); }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'lang') { S.lang = S.lang === 'en' ? 'es' : 'en'; document.documentElement.lang = S.lang; return S.me ? (S.survey && location.hash.startsWith('#/checkin/') ? renderSurvey() : route()) : loginView(); }
  if (act === 'signout') { ev.preventDefault(); return wipe(); }
  if (act === 'stay') { S.lastActivity = Date.now(); document.getElementById('idle').hidden = true; return api.call('session.me', {}).catch(() => {}); }
  if (act === 'stay-after') { clearInterval(S.autoOut); const c = document.getElementById('countdown'); if (c) c.remove(); el.remove(); return; }
  if (act === 'retry') return route();
  if (act === 'setup-done') { S.config = null; return loginView(); }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(el.dataset.copy); el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy'; }, 2000); }
    catch { announce('Select the text and copy it'); }
    return;
  }
  if (act === 'restart-setup') return setupView(null, null, true);
  if (act === 'pk-login') {
    el.disabled = true;
    const h = pkHint();
    try {
      const r = await passkeySignIn({ expectEmployeeId: h && h.id && location.hash.indexOf('login') < 0 ? h.id : undefined });
      await loadMe();
      S.lang = S.me.employee.language || S.lang; document.documentElement.lang = S.lang;
      return afterSignIn(r);
    } catch (e) {
      el.disabled = false;
      if (e instanceof ApiError && e.code === 'passkey_unknown') setPkHint(null);
      const msg = cancelled(e) ? t('pk_cancelled') : errMsg(e);
      return location.hash.startsWith('#/login') ? loginView(msg) : portalView(msg);
    }
  }
  if (act === 'install') { if (installEvent) { installEvent.prompt(); try { await installEvent.userChoice; } catch { /* ignore */ } installEvent = null; } document.querySelector('.install-tip')?.remove(); return; }
  if (act === 'install-later') { try { localStorage.setItem('hub_install_skip', String(Date.now())); } catch { /* ignore */ } document.querySelector('.install-tip')?.remove(); return; }
  if (act === 'push-on') {
    el.disabled = true;
    try {
      const perm = await Notification.requestPermission();   // first, while the tap still counts
      if (perm !== 'granted') return renderReminders();
      const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
      const key = S.pushKey || (await api.call('push.status', {})).publicKey;
      const raw64 = key.replace(/-/g, '+').replace(/_/g, '/'); const keyBytes = Uint8Array.from(atob(raw64 + '==='.slice((raw64.length + 3) % 4)), c => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
      await call('push.subscribe', { endpoint: sub.endpoint, device: deviceGuess() });
      return renderReminders();
    } catch (e) { if (quiet(e)) return; el.disabled = false; return renderReminders(errMsg(e)); }
  }
  if (act === 'push-off') {
    el.disabled = true;
    const sub = await currentPushSub();
    try { if (sub) { await call('push.unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } } catch (e) { if (quiet(e)) return; }
    return renderReminders();
  }
  if (act === 'push-test') { el.disabled = true; try { await call('push.test', {}); return renderReminders(t('rem_test_sent')); } catch (e) { if (!quiet(e)) { el.disabled = false; announce(errMsg(e)); } } return; }
  if (act === 'qbt-show') { el.disabled = true; try { await call('admin.qbtShowHours', { show: el.dataset.on === '1' }); return route(); } catch (e) { if (!quiet(e)) { el.disabled = false; announce(errMsg(e)); } } return; }
  if (act === 'push-switch') { el.disabled = true; try { await call('admin.pushSettings', { enabled: el.dataset.on === '1' }); return route(); } catch (e) { if (!quiet(e)) { el.disabled = false; announce(errMsg(e)); } } return; }
  if (act === 'pk-relogin') { setSharedPref(false); await wipe(); return go('#/login'); }
  if (act === 'pk-forget') { setPkHint(null); return portalView(); }
  if (act === 'pk-sign') return pkSignSubmit(el);
  if (act === 'pk-usepin') { if (S.survey) { S.survey.usePin = true; S.survey.error = null; renderSurvey(); const f = root.querySelector('#signpin'); if (f) f.focus(); } return; }
  if (act === 'pk-offer-no') { skipOffer(S.me.employee.id); document.getElementById('pk-offer')?.remove(); return; }
  if (act === 'pk-create') {
    clearInterval(S.autoOut); document.getElementById('countdown')?.remove();
    el.disabled = true;
    const inOffer = !!el.closest('#pk-offer');
    const o = S.pkReg; S.pkReg = null;    // a challenge is used once
    try {
      await finishRegister(o);
      if (inOffer) { document.getElementById('pk-setup').innerHTML = String(html`<p class="success-inline">${icon('shield')} ${tm('pk_done')}</p>`); document.querySelector('#pk-offer [data-act=pk-offer-no]')?.remove(); }
      else await renderPkList(tm('pk_done'));
    } catch (e) {
      if (e && e.name === 'InvalidStateError') setPkHint(S.me.employee);   // this phone was already set up
      const msg = cancelled(e) ? t('pk_cancelled') : (e && e.name === 'InvalidStateError') ? tm('pk_done') : errMsg(e);
      rerenderPkSetup(msg);
    }
    return;
  }
  if (act === 'pk-remove') {
    el.disabled = true;
    try { await call('passkey.remove', { passkeyId: el.dataset.id }); const left = await call('passkey.mine', {}); if (!left.length) setPkHint(null); return renderPkList(); }
    catch (e) { el.disabled = false; if (!quiet(e)) announce(errMsg(e)); }
    return;
  }
  if (act === 'who') return chooseWho(el.dataset.id, el.dataset.name);
  if (act === 'quick-who') { if (S.survey && S.survey.quick) { collectStep(false); S.survey.step = -1; S.survey.error = null; return renderWho(S.roster); } return; }
  if (act === 'pick') { S.signinId = el.dataset.id; S.signinStep = 'pin'; await loginView(); const f = root.querySelector('#pin'); if (f) f.focus(); return; }
  if (act === 'survey-next') {
    if (!collectStep()) return;
    scheduleSave(); S.survey.step = Math.min(pagesOf(S.survey.tpl).length - 1, S.survey.step + 1); S.survey.error = null; return renderSurvey();
  }
  if (act === 'survey-back') { collectStep(false); scheduleSave(); S.survey.step = Math.max(0, S.survey.step - 1); return renderSurvey(); }
  if (act === 'goto-step') { S.survey.step = Number(el.dataset.step); return renderSurvey(); }
  if (act === 'download') { try { await api.download(el.dataset.id, el.dataset.fmt); } catch (e) { announce(errMsg(e)); } return; }
  if (act === 'seen') { el.disabled = true; try { await call('review.seen', { submissionId: el.dataset.id }); return route(); } catch (e) { if (!quiet(e)) { el.disabled = false; announce(errMsg(e)); } } return; }
  if (act === 'seen-all') { try { await call('alerts.seen', { ids: el.dataset.ids.split(',') }); await refreshMe(); return route(); } catch (e) { if (!quiet(e)) announce(errMsg(e)); } return; }
  if (act === 'consent-change') return consentView('#/more');
  if (act === 'consent') {
    el.disabled = true;
    try { await call('consent.record', { choice: el.dataset.choice, language: S.lang }); S.me = await call('session.me', {}); if (el.dataset.choice === 'paper') announce(t('consent_paper_done')); return go(el.dataset.next || '#/home'); }
    catch (e) { el.disabled = false; if (!quiet(e)) announce(errMsg(e)); return; }
  }
  if (act === 'backup') {
    const out = document.getElementById('backup-out'); out.textContent = t('loading');
    try {
      const r = await call('admin.backupExport', {});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.body], { type: 'application/json' })); a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      out.textContent = `Saved ${r.filename} — ${r.counts.survey_submissions} signed reports, ${r.counts.safety_reports} safety reports. File fingerprint (SHA-256): ${r.sha256.slice(0, 16)}…`;
    } catch (e) { if (!quiet(e)) out.textContent = errMsg(e); }
    return;
  }
  if (act === 'verify') {
    const out = document.getElementById('verify-out'); out.textContent = t('loading');
    try { const r = await call('audit.verify', {}); out.innerHTML = String(html`<p class="${r.ok ? 'success-inline' : 'alert'}">${r.ok ? '✓ All records verify' : '✗ Problems found'}: ${r.auditEvents} audit events, ${r.signedRecordsChecked} signed items checked. ${r.problems.length ? JSON.stringify(r.problems) : ''}</p>`); }
    catch (e) { if (!quiet(e)) out.textContent = errMsg(e); }
  }
});

root.addEventListener('change', (ev) => {
  if (ev.target.closest('form[data-form="survey-step"]')) { collectStep(false); scheduleSave(); }
});
// Tapping an answer on a one-question screen moves on by itself (a short pause shows the choice).
// Only for a real tap or click: keyboard users move between choices with arrows and press Next.
let advanceTimer = null;
root.addEventListener('click', (ev) => {
  const opt = ev.target.closest('form.one-q label.opt');
  if (!opt || ev.detail === 0 || !S.survey) return;
  const sv = S.survey, at = sv.step;
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    if (S.survey !== sv || sv.step !== at || !root.querySelector('form.one-q input:checked')) return;
    collectStep(false); scheduleSave();
    sv.step = Math.min(pagesOf(sv.tpl).length - 1, sv.step + 1); sv.error = null; renderSurvey();
  }, 280);
});
root.addEventListener('input', (ev) => {
  if (ev.target.closest('form[data-form="survey-step"]') && ev.target.tagName === 'TEXTAREA') { collectStep(false); scheduleSave(); }
});
root.addEventListener('toggle', async (ev) => {
  const sel = ev.target.querySelector && ev.target.querySelector('select[data-emp-select]');
  if (sel && !sel.options.length) {
    try { const list = await employees(); sel.innerHTML = String(html`${list.map(e => html`<option value="${e.id}" ${e.id === S.me.employee.id ? raw('selected') : ''}>${e.name}</option>`)}`); } catch { /* ignore */ }
  }
}, true);

root.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const kind = form.dataset.form, f = form.elements;
  const btn = ev.submitter || form.querySelector('button[type="submit"]');
  const fail = (e) => { if (btn) btn.disabled = false; form.querySelector('.alert')?.remove(); const p = document.createElement('p'); p.className = 'alert'; p.setAttribute('role', 'alert'); p.textContent = errMsg(e); form.appendChild(p); p.focus?.(); announce(errMsg(e)); };
  if (kind === 'login') {
    btn.disabled = true;
    const id = f.employeeId.value.trim().toUpperCase(); S.signinId = id;
    const shared = f.sharedDevice.checked; setSharedPref(shared);
    try {
      const turnstileToken = turnstileWidget !== null && tsReady() ? window.turnstile.getResponse(turnstileWidget) : undefined;
      const r = await api.login({ employeeId: id, pin: f.pin.value, totp: f.totp ? f.totp.value : undefined, sharedDevice: shared, turnstileToken });
      S.signinStep = 'pin';
      await loadMe();
      S.lang = S.me.employee.language || S.lang; document.documentElement.lang = S.lang;
      if (r.mustSetPin || S.me.mustSetPin) return setPinView();
      return afterSignIn();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'totp_required')) { const pin = f.pin.value; S.signinStep = 'totp'; await loginView(); root.querySelector('#pin').value = pin; root.querySelector('input[name=totp]').focus(); return; }
      btn.disabled = false; if (f.pin) f.pin.value = ''; return loginView(errMsg(e));
    }
  }
  if (kind === 'restartsetup') {
    btn.disabled = true;
    try { const r = await api.setupRestart({ code: f.code.value }); S.config = null; return setupView(null, r); }
    catch (e) { return setupView(errMsg(e), null, true); }
  }
  if (kind === 'firstsetup') {
    btn.disabled = true;
    try { const r = await api.setup({ code: f.code.value, employeeId: f.employeeId.value.trim().toUpperCase(), name: f.name.value, smsPhone: f.smsPhone.value }); S.config = null; return setupView(null, r); }
    catch (e) { return setupView(errMsg(e)); }
  }
  if (kind === 'setpin') {
    btn.disabled = true;
    try { await api.call('auth.setPin', { newPin: f.newPin.value, confirmPin: f.confirmPin.value }); await loadMe(); return afterSignIn(); }
    catch (e) { return setPinView(errMsg(e)); }
  }
  if (kind === 'pkunlock') {
    clearInterval(S.autoOut); document.getElementById('countdown')?.remove();
    btn.disabled = true;
    try { S.pkReg = await startRegister({ signPin: f.signPin.value, totp: f.totp ? f.totp.value : undefined }); rerenderPkSetup(); document.querySelector('#pk-setup [data-act=pk-create]')?.focus(); }
    catch (e) { if (e instanceof ApiError && e.status === 401 && ['no_session', 'expired', 'locked'].includes(e.code)) return wipe(e.message); rerenderPkSetup(errMsg(e)); }
    return;
  }
  if (kind === 'sign') return submitSurvey(form, btn);
  if (kind === 'qsign') return quickSubmit(form, btn);
  if (kind === 'who') return chooseWho(form.elements.employeeId.value);
  if (btn) btn.disabled = true;
  try {
    if (kind === 'safety') {
      const type = form.querySelector('input[name="type"]:checked');
      if (!type) { document.getElementById('err-type').hidden = false; form.querySelector('input[name="type"]').focus(); btn.disabled = false; return; }
      if (!f.description.value.trim()) { f.description.focus(); btn.disabled = false; announce(t('answer_needed')); return; }
      const photo = f.photo.files[0] ? await resizePhoto(f.photo.files[0]) : null;
      const r = await call('safety.report', { type: type.value, area: f.area.value || undefined, location: f.location.value, equipment: f.equipment.value, description: f.description.value, immediateAction: f.immediateAction.value, confidential: f.confidential.checked });
      if (photo) { try { await call('attachment.add', { entityType: 'safety_report', entityId: r.reportId, ...photo }); } catch (e) { if (quiet(e)) return; announce('Report sent, but the photo did not upload: ' + errMsg(e)); } }
      S.safetyResult = { ...r, type: type.value };
      return safetyNewView();
    }
    if (kind === 'evidence') {
      const photo = await resizePhoto(f.photo.files[0]);
      if (!photo) { btn.disabled = false; return; }
      await call('attachment.add', { entityType: form.dataset.type, entityId: form.dataset.id, ...photo });
      return route();
    }
    if (kind === 'amend') {
      const corrections = {};
      for (const el of form.querySelectorAll('select[name^="c_"]')) if (el.value) corrections[el.name.slice(2)] = /^\d$/.test(el.value) ? Number(el.value) : el.value;
      await call('survey.amend', { submissionId: form.dataset.id, note: f.note.value, corrections, signPin: f.signPin.value, affirm: f.affirm.checked, language: S.lang });
      return route();
    }
    if (kind === 'respond') { await call('review.respond', { submissionId: form.dataset.id, text: f.text.value }); return route(); }
    if (kind === 'clarify') { await call('review.requestClarification', { submissionId: form.dataset.id, text: f.text.value }); return route(); }
    if (kind === 'withdraw') { await call('review.withdrawClarification', { submissionId: form.dataset.id }); return route(); }
    if (kind === 'note') { await call('review.note', { submissionId: form.dataset.id, text: f.text.value }); return route(); }
    if (kind === 'signoff') {
      await call('review.signoff', { submissionId: form.dataset.id, comments: f.comments.value, trainingNeeded: f.trainingNeeded.checked, trainingNote: f.trainingNote.value,
        performanceConcern: f.performanceConcern.checked, performanceNote: f.performanceNote.value, closure: form.querySelector('input[name=closure]:checked')?.value,
        signPin: f.signPin.value, affirm: f.affirm.checked });
      announce('Review signed off'); return route();
    }
    if (kind === 'excuse') { await call('mgmt.excuse', { assignmentId: form.dataset.id, reason: f.reason.value }); return route(); }
    if (kind === 'paper') { await call('mgmt.paperEvent', { assignmentId: form.dataset.id, event: f.event.value, note: f.note.value }); return route(); }
    if (kind === 'setupcode') {
      const r = await call('accounts.resetPin', { employeeId: form.dataset.id });
      const out = form.closest('article')?.querySelector('.acct-out');
      if (out) { out.innerHTML = String(secretBox(r)); form.remove(); } else form.outerHTML = String(secretBox(r));
      return;
    }
    if (kind === 'absence') { await call('hr.addAbsence', { employeeId: form.dataset.id, startDate: f.startDate.value, endDate: f.endDate.value, reason: f.reason.value }); announce('Saved'); return route(); }
    if (kind === 'sack') { await call('safety.acknowledge', { reportId: form.dataset.id, note: f.note.value }); await refreshMe(); return route(); }
    if (kind === 'classify') { await call('safety.classify', { reportId: form.dataset.id, priority: f.priority.value, area: f.area.value || undefined, equipment: f.equipment.value }); return route(); }
    if (kind === 'assign') { await call('safety.assign', { reportId: form.dataset.id, ownerId: f.ownerId.value }); return route(); }
    if (kind === 'snote') { await call('safety.note', { reportId: form.dataset.id, note: f.note.value }); return route(); }
    if (kind === 'propose') { await call('safety.proposeResolution', { reportId: form.dataset.id, resolution: f.resolution.value }); return route(); }
    if (kind === 'sverify') { await call('safety.verify', { reportId: form.dataset.id, decision: btn.value, note: f.note.value }); return route(); }
    if (kind === 'ca') {
      await call('ca.create', { sourceType: form.dataset.sourceType, sourceId: form.dataset.sourceId, category: f.category.value, title: f.title.value, description: f.description.value, priority: f.priority.value, assignedTo: f.assignedTo.value, dueDate: f.dueDate.value });
      announce('Corrective action created'); return route();
    }
    if (kind === 'castart') { await call('ca.start', { id: form.dataset.id }); return route(); }
    if (kind === 'cadone') { await call('ca.markDone', { id: form.dataset.id, resolution: f.resolution.value, closureEvidence: f.closureEvidence.value }); return route(); }
    if (kind === 'caverify') { await call('ca.verify', { id: form.dataset.id, decision: btn.value, note: f.note.value }); return route(); }
    if (kind === 'qfilter') { const p = new URLSearchParams(); for (const n of ['status', 'priority', 'area']) if (f[n].value) p.set(n, f[n].value); return go('#/safety?' + p.toString()); }
    if (kind === 'dfilter') { const p = new URLSearchParams(); for (const n of ['view', 'w', 'm', 'sup', 'emp']) if (f[n] && f[n].value) p.set(n, f[n].value); return go('#/dash?' + p.toString()); }
    if (kind === 'changepin') { await call('auth.setPin', { currentPin: f.currentPin.value, newPin: f.newPin.value, confirmPin: f.confirmPin.value }); form.reset(); announce('PIN changed'); btn.disabled = false; return; }
    if (kind === 'regdevice') { await call('device.register', { label: f.label.value }); announce('This browser is now a registered shop tablet'); return route(); }
    if (kind === 'revdevice') { await call('device.revoke', { deviceId: form.dataset.id }); return route(); }
    if (kind === 'qbtlink') {
      const pick = btn && btn.name === 'suggest' ? btn.value : f.qbtUserId.value;
      await call('admin.qbtLink', { employeeId: form.dataset.id, qbtUserId: pick || null });
      announce('Saved'); return route();
    }
    if (kind === 'pkremoveall') {
      const r = await call('accounts.removePasskeys', { employeeId: form.dataset.id });
      const out = form.closest('article')?.querySelector('.acct-out');
      if (out) out.textContent = `Removed ${r.removed} phone${r.removed === 1 ? '' : 's'}. ${form.dataset.name} was signed out everywhere and now signs in with the PIN.`;
      form.remove(); return;
    }
    if (kind === 'enrolltotp') { const r = await call('auth.enrollTotp', { employeeId: form.dataset.id }); const out = form.closest('article')?.querySelector('.acct-out'); if (out) out.innerHTML = String(secretBox({ mfa: r })); btn.disabled = false; return; }
    if (kind === 'acreate' || kind === 'aupdate') {
      const input = { name: f.name.value, language: f.language.value, reportsTo: f.reportsTo.value || null, role: form.querySelector('input[name=role]:checked')?.value, fullAccess: f.fullAccess.checked, safetyContact: f.safetyContact.checked, smsPhone: f.smsPhone.value };
      if (kind === 'acreate') {
        const r = await call('accounts.create', { ...input, employeeId: f.employeeId.value.trim() || undefined, startDate: f.startDate.value });
        EMP = null; await accountsView();
        const box = document.getElementById('acct-' + r.account.id)?.querySelector('.acct-out');
        if (box) { box.innerHTML = String(secretBox(r)); box.closest('article').scrollIntoView({ block: 'center' }); }
        announce('Account created'); return;
      }
      const r = await call('accounts.update', { ...input, employeeId: form.dataset.id });
      EMP = null; await accountsView();
      if (r.mfa) { const box = document.getElementById('acct-' + form.dataset.id)?.querySelector('.acct-out'); if (box) box.innerHTML = String(secretBox({ mfa: r.mfa })); }
      announce('Saved'); return;
    }
    if (kind === 'adeact') { await call('accounts.deactivate', { employeeId: form.dataset.id }); EMP = null; announce('Deactivated'); return route(); }
    if (kind === 'areact') { const r = await call('accounts.reactivate', { employeeId: form.dataset.id }); EMP = null; await accountsView(); const box = document.getElementById('acct-' + form.dataset.id)?.querySelector('.acct-out'); if (box) box.innerHTML = String(secretBox({ ...r, employee: { name: form.dataset.id } })); return; }
    if (kind === 'restore') {
      const undoId = f.undoId ? f.undoId.value : '';
      const toTime = f.toTime.value ? new Date(f.toTime.value).toISOString() : '';
      const r = await call('admin.restore', { toTime: undoId ? undefined : toTime, undoId: undoId || undefined, signPin: f.signPin.value, totp: f.totp.value, confirm: f.confirm.value });
      render('#/more', html`<h1>Restoring</h1><p class="lede" role="status">${r.message}</p><p>Restore ${r.restoreId}. Reload this page in a minute.</p>`);
      return;
    }
    if (kind === 'simfail') { await call('demo.setSimFail', { employeeId: f.employeeId.value, count: f.count.value }); announce('Saved'); btn.disabled = false; return; }
  } catch (e) {
    if (quiet(e)) return;
    fail(e);
  }
});

window.addEventListener('hashchange', route);
window.addEventListener('offline', () => announce(t('offline')));
// Home-screen app support and reminders (the worker caches nothing).
if ('serviceWorker' in navigator && !window.HUB_LOCAL && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
