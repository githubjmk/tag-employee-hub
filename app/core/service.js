// TAG Employee Hub R1.1 — Weekly Report service.
//
// Every read and write goes through `service.call(token, action, input)`, and
// authorization is enforced here on the server, never in the browser.
//
// Injected adapters (identical rules on Node, the browser demo and Workers):
//   db:      { exec(sql), run(sql, params), get(sql, params), all(sql, params), tx(fn) }  — synchronous
//   crypto:  makeCrypto({ pepper })  (core/webcrypto.js)
//   clock:   { now() -> Date }
//   senders: { sms(recipient, message) -> { ok, detail } }  — optional; prototype default is a simulator

import { canonical } from './canonical.js';
import {
  COMPANY_TZ, reportingWeek, isoWithOffset, addDays, ymdOf, zonedToUtc, nextWorkingSlot,
  addWorkingMinutes, isWithinWorkingHours, workingMinutesBetween, weekdaysOf
} from './time.js';
import { getTemplate, TEMPLATES, ASSIGNABLE, SUPERVISOR_ACK, SEEN_STATEMENT, ESIGN_CONSENT_V1, allQuestions } from './templates.js';
import { verifyTotp, base32Encode } from './totp.js';
import { internalRolesFor, describeRoles, permissionsOf } from './permissions.js';
import { verifyRegistration, verifyAssertion, b64urlEncode, WebAuthnError, ALG } from './webauthn.js';
import { pushEndpointOk, generateVapidKeys, sendPush } from './webpush.js';

export class HubError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const deny = (msg = 'Not allowed') => new HubError(403, 'forbidden', msg);
const bad = (msg, code = 'invalid') => new HubError(400, code, msg);
const notFound = () => new HubError(404, 'not_found', 'Not found');

export const SESSION_POLICY = {
  shared: { idleMinutes: 5, absoluteMinutes: 240 },
  personal: { idleMinutes: 60, absoluteMinutes: 720 },
  elevated: { idleMinutes: 30, absoluteMinutes: 600 }
};
export const LOGIN_POLICY = { maxFailures: 5, lockMinutes: 15, hardLockAfterLockouts: 3, tempPinHours: 72, tempPinDigits: 8, pinMin: 6, pinMax: 12 };
export const ELEVATED = ['supervisor', 'safety', 'manager', 'hr'];

// First-response targets by priority. Urgent and high run on the wall clock;
// normal and low on working time (Mon–Fri 07:00–15:30).
export const SLA = {
  urgent: { minutes: 15, clock: 'wall' },
  high: { minutes: 240, clock: 'wall' },
  normal: { minutes: 510, clock: 'working' },
  low: { minutes: 1020, clock: 'working' }
};
export const TYPE_PRIORITY = {
  imminent: 'urgent', injury: 'urgent', injury_followup: 'high', unsafe_equipment: 'high',
  unsafe_condition: 'high', hazard: 'normal', near_miss: 'normal', suggestion: 'low'
};
export const AREAS = ['CNC', 'Foam', 'Saw / cutting', 'Assembly', 'Hardware / riveting', 'Paint / finishing', 'Shipping / dock', 'Warehouse', 'Office', 'Outside / parking', 'Other'];
export const RETRY_BACKOFF_MIN = [1, 2, 5];       // after attempts 1, 2, 3; attempt 4 is the last
export const MAX_ATTEMPTS = 4;
export const ESCALATE_EVERY_MIN = 15;
const MAX_ATTACHMENT_BYTES = 1_500_000;
const ATTACH_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export function normalizeName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function pinProblem(pin, employeeId = '') {
  const p = String(pin || '');
  if (!/^\d{6,12}$/.test(p)) return 'Use 6 to 12 digits.';
  if (/^(\d)\1+$/.test(p)) return 'Too easy to guess: all the same digit.';
  if ('0123456789012345678901'.includes(p) || '9876543210987654321098'.includes(p)) return 'Too easy to guess: a sequence.';
  if (/^(\d{1,4})\1+$/.test(p) || /^(\d)\1(\d)\2(\d)\3$/.test(p)) return 'Too easy to guess: a repeating pattern.';
  if (['123321', '654456', '696969', '102030', '111222', '112233', '121314', '159753', '147258', '258369', '000123', '12344321', '11223344'].includes(p)) return 'Too easy to guess: a common PIN.';
  const idDigits = String(employeeId).replace(/\D/g, '');
  if (idDigits.length >= 3 && p.includes(idDigits)) return 'Do not use your employee number.';
  return null;
}

export function createService({ db, crypto, clock, config = {}, senders = {}, platform = {} }) {
  const tz = config.tz || COMPANY_TZ;
  const cfg = {
    demo: !!config.demo,
    // R1.2: staff may sign in from any browser. Registered tablets remain optional
    // (they label the device in the signature record and force the shared-device timeout).
    pinOnlyOnRegisteredDevices: config.pinOnlyOnRegisteredDevices ?? false,
    elevatedRequireTotp: config.elevatedRequireTotp ?? true,
    activeTemplate: config.activeTemplate || 'WR-1.0',
    minWorkdaysExpected: config.minWorkdaysExpected ?? 3,
    reviewTargetWorkingDays: config.reviewTargetWorkingDays ?? 3,
    pilotStartWeek: config.pilotStartWeek || null,
    // Conservative default (owner decision 2026-10-14: no new legal review): employees can fill in,
    // save, sign, correct or answer about their weekly report only during work hours, so it is
    // always done on paid time. Safety reports are never blocked.
    surveyDuringWorkHoursOnly: config.surveyDuringWorkHoursOnly ?? true
  };
  if (!ASSIGNABLE.has(cfg.activeTemplate)) throw new Error(`Template ${cfg.activeTemplate} is not approved for use`);
  const now = () => clock.now();
  const nowIso = () => now().toISOString();
  const id = (prefix) => `${prefix}-${crypto.randomHex(5).toUpperCase()}`;
  const tx = (fn) => db.tx(fn);

  // All actions run one at a time so the audit chain and idempotency checks
  // never interleave (Durable Objects interleave across awaits otherwise).
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // ---------------------------------------------------------------- helpers
  const emp = (eid) => (typeof eid === 'string' ? db.get('SELECT * FROM employees WHERE id = ?', [eid]) : undefined);
  const rolesOf = (e) => JSON.parse(e.roles);
  const isElevated = (e) => rolesOf(e).some(r => ELEVATED.includes(r));
  const has = (ctx, r) => ctx.roles.includes(r);
  const any = (ctx, ...rs) => rs.some(r => ctx.roles.includes(r));
  const pub = (e) => e && ({ id: e.id, name: e.display_name, department: e.department, status: e.status });
  const nameOf = (eid) => { const e = emp(eid); return e ? e.display_name : null; };
  const activeWith = (role) => db.all("SELECT * FROM employees WHERE status='active'", []).filter(e => rolesOf(e).includes(role));

  function audit(actorId, action, entity, entityId, detail = {}) {
    const last = db.get('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1', []);
    const prev = last ? last.hash : 'GENESIS';
    const at = nowIso();
    const body = { at, actorId: actorId || null, action, entity: entity || null, entityId: entityId || null, detail };
    const hash = crypto.sha256(prev + '|' + canonical(body));
    db.run(`INSERT INTO audit_events (at, actor_id, action, entity, entity_id, detail_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)`,
      [at, actorId || null, action, entity || null, entityId || null, canonical(detail), prev, hash]);
  }

  const supervisesOrHr = (ctx, e) => !!e && (has(ctx, 'hr') || (has(ctx, 'supervisor') && e.supervisor_id === ctx.me.id));
  const canViewAnswers = (ctx, employeeId) => ctx.me.id === employeeId || supervisesOrHr(ctx, emp(employeeId));

  // ---------------------------------------------------------------- notifications
  function queueNotification(recipientId, { kind, ref, subject, urgent = false, channels = ['in_app'], hold = !urgent, backupFor = null }) {
    const r = emp(recipientId);
    if (!r || r.status !== 'active') return [];
    const out = [];
    const when = hold ? nextWorkingSlot(now(), tz) : now();
    for (const ch of channels) {
      if (ch === 'sms' && !(r.phone_on_file || r.sms_phone)) continue;   // only people with a mobile number on file are texted
      const nid = id('N');
      const inApp = ch === 'in_app';
      db.run(`INSERT INTO notifications (id, recipient_id, channel, kind, ref, urgent, subject, status, attempts, next_attempt_at, delivered_at, backup_for, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [nid, r.id, ch, kind, ref || null, urgent ? 1 : 0, subject, inApp ? 'delivered' : 'queued', inApp ? 1 : 0,
          when.toISOString(), inApp ? when.toISOString() : null, backupFor, nowIso()]);
      out.push(nid);
    }
    return out;
  }

  // Prototype SMS sender: succeeds unless the recipient is configured to fail
  // (to demonstrate retry, failure detection and backup routing). Production
  // replaces this with a real gateway and its delivery receipts.
  const smsSender = senders.sms || ((recipient) => {
    if (recipient.sim_fail_sms > 0) {
      db.run('UPDATE employees SET sim_fail_sms = sim_fail_sms - 1 WHERE id = ?', [recipient.id]);
      return { ok: false, detail: 'Simulated carrier error (prototype)' };
    }
    return { ok: true, detail: 'Simulated delivery receipt (prototype)' };
  });

  function backupRecipientsFor(n) {
    // Next tier: every active manager and HR user, then safety leads, excluding the failed recipient.
    const ids = new Set([...activeWith('manager'), ...activeWith('hr'), ...activeWith('safety')].map(e => e.id));
    ids.delete(n.recipient_id);
    return [...ids];
  }

  // Text delivery. A sender returns (or resolves to) one of:
  //   { ok: true, delivered: true, detail }            -> confirmed delivered (simulator)
  //   { ok: true, pending: true, providerId, detail }  -> accepted by the gateway; waits for a delivery receipt
  //   { ok: false, detail, retryable }                 -> failed attempt (retried, then backups)
  // A notification is only ever marked "delivered" on confirmation. A gateway that accepts a
  // message but sends no receipt within RECEIPT_TIMEOUT_MIN counts as a failed attempt.
  const smsProvider = senders.smsProvider || (senders.sms ? 'custom' : 'simulator');
  function recordResult(n, res) {
    const r = emp(n.recipient_id);
    const attempts = n.attempts + 1;
    db.run('INSERT INTO notification_attempts (notification_id, at, ok, detail) VALUES (?,?,?,?)', [n.id, nowIso(), res.ok ? 1 : 0, String(res.detail || '').slice(0, 200)]);
    if (res.ok && res.pending) {
      db.run("UPDATE notifications SET status='sent', attempts=?, provider=?, provider_id=?, sent_at=?, last_error=NULL WHERE id=?", [attempts, smsProvider, String(res.providerId || ''), nowIso(), n.id]);
      return 'sent';
    }
    if (res.ok) {
      db.run("UPDATE notifications SET status='delivered', attempts=?, delivered_at=?, last_error=NULL, provider=COALESCE(provider, ?) WHERE id=?", [attempts, nowIso(), smsProvider, n.id]);
      return 'delivered';
    }
    if (attempts >= MAX_ATTEMPTS || res.retryable === false) {
      db.run("UPDATE notifications SET status='failed', attempts=?, last_error=? WHERE id=?", [attempts, String(res.detail).slice(0, 200), n.id]);
      audit(null, 'notification.failed', 'notification', n.id, { recipient: n.recipient_id, channel: n.channel, ref: n.ref });
      // Backup paths: in-app copy for the same person, plus the next tier by SMS + in-app.
      queueNotification(n.recipient_id, { kind: n.kind, ref: n.ref, subject: '[Text failed] ' + n.subject, urgent: !!n.urgent, channels: ['in_app'], backupFor: n.id });
      if (n.urgent) for (const b of backupRecipientsFor(n)) {
        const already = db.get("SELECT 1 FROM notifications WHERE ref=? AND recipient_id=? AND channel='sms' AND status IN ('queued','sent','delivered')", [n.ref, b]);
        if (!already) queueNotification(b, { kind: n.kind, ref: n.ref, subject: `[Backup — could not reach ${r.display_name}] ${n.subject}`, urgent: true, channels: ['sms', 'in_app'], backupFor: n.id });
      }
      return 'failed';
    }
    const wait = RETRY_BACKOFF_MIN[attempts - 1] || RETRY_BACKOFF_MIN.at(-1);
    db.run("UPDATE notifications SET status='queued', attempts=?, last_error=?, next_attempt_at=? WHERE id=?",
      [attempts, String(res.detail).slice(0, 200), new Date(now().getTime() + wait * 60000).toISOString(), n.id]);
    return 'retry';
  }

  function dispatchDue() {
    const due = db.all("SELECT * FROM notifications WHERE status='queued' AND next_attempt_at <= ? ORDER BY urgent DESC, created_at LIMIT 50", [nowIso()]);
    let sent = 0, failed = 0, inFlight = [];
    for (const n of due) {
      const r = emp(n.recipient_id);
      let res;
      try { res = n.channel === 'sms' ? smsSender(r, n.subject) : { ok: false, detail: 'No sender for channel ' + n.channel }; }
      catch (e) { res = { ok: false, detail: 'Sender error: ' + String(e && e.message).slice(0, 120) }; }
      if (res && typeof res.then === 'function') {
        // Network gateway: hold the row (lease) so nothing re-sends it while the request is in flight.
        tx(() => db.run('UPDATE notifications SET next_attempt_at=? WHERE id=?', [new Date(now().getTime() + 10 * 60000).toISOString(), n.id]));
        inFlight.push(res.then(v => v, e => ({ ok: false, detail: 'Gateway error: ' + String(e && e.message).slice(0, 120) }))
          .then(v => tx(() => { const fresh = db.get('SELECT * FROM notifications WHERE id=?', [n.id]); if (fresh && fresh.status === 'queued') recordResult(fresh, v || { ok: false, detail: 'No response' }); })));
        continue;
      }
      const outcome = tx(() => recordResult(n, res));
      if (outcome === 'delivered' || outcome === 'sent') sent++; else if (outcome === 'failed') failed++;
    }
    const out = { sent, failed, processed: due.length };
    return inFlight.length ? Promise.all(inFlight).then(() => out) : out;
  }

  // Delivery receipt from the gateway (e.g. GoTo DELIVERY_STATUS webhook), matched by its message id.
  function deliveryReceipt({ providerId, delivered, detail, retryable }) {
    if (!providerId || typeof providerId !== 'string') return { matched: false };
    return tx(() => {
      const n = db.get("SELECT * FROM notifications WHERE provider_id=? AND status='sent'", [providerId]);
      if (!n) return { matched: false };
      if (delivered) {
        db.run("UPDATE notifications SET status='delivered', delivered_at=?, last_error=NULL WHERE id=?", [nowIso(), n.id]);
        db.run('INSERT INTO notification_attempts (notification_id, at, ok, detail) VALUES (?,?,?,?)', [n.id, nowIso(), 1, ('Delivery receipt: ' + (detail || 'DELIVERED')).slice(0, 200)]);
        return { matched: true, status: 'delivered' };
      }
      // A failed receipt counts against the attempt already recorded at send time.
      db.run("UPDATE notifications SET status='queued', attempts=attempts-1 WHERE id=?", [n.id]);
      return { matched: true, status: recordResult(db.get('SELECT * FROM notifications WHERE id=?', [n.id]), { ok: false, detail: 'Delivery receipt: ' + (detail || 'not delivered'), retryable }) };
    });
  }
  const RECEIPT_TIMEOUT_MIN = 5;
  function expireUnconfirmed() {
    const cutoff = new Date(now().getTime() - RECEIPT_TIMEOUT_MIN * 60000).toISOString();
    for (const n of db.all("SELECT * FROM notifications WHERE status='sent' AND sent_at < ?", [cutoff])) {
      db.run("UPDATE notifications SET status='queued', attempts=attempts-1 WHERE id=?", [n.id]);
      recordResult(db.get('SELECT * FROM notifications WHERE id=?', [n.id]), { ok: false, detail: `No delivery confirmation within ${RECEIPT_TIMEOUT_MIN} minutes` });
    }
  }

  function deliveryFor(ref) {
    return db.all('SELECT * FROM notifications WHERE ref=? ORDER BY created_at', [ref]).map(n => ({
      id: n.id, recipient: nameOf(n.recipient_id), recipientId: n.recipient_id, channel: n.channel, status: n.status,
      attempts: n.attempts, lastError: n.last_error, deliveredAt: n.delivered_at, seenAt: n.seen_at, backup: !!n.backup_for, urgent: !!n.urgent
    }));
  }

  function markSeen(recipientId, ref) {
    db.run('UPDATE notifications SET seen_at=? WHERE recipient_id=? AND ref=? AND seen_at IS NULL', [nowIso(), recipientId, ref]);
  }

  // ---------------------------------------------------------------- eligibility
  function workdaysFor(e, week) {
    const absences = db.all('SELECT start_date, end_date FROM absences WHERE employee_id=? AND end_date >= ? AND start_date <= ?', [e.id, week.start, week.end]);
    return weekdaysOf(week).filter(d =>
      d >= e.start_date && (!e.end_date || d <= e.end_date) && !absences.some(a => d >= a.start_date && d <= a.end_date)).length;
  }

  function ensureAssignments(week) {
    if (cfg.pilotStartWeek && week.weekId < cfg.pilotStartWeek) return;   // before the pilot: paper era
    for (const e of db.all('SELECT * FROM employees', [])) {
      if (e.start_date > addDays(week.start, 4)) continue;
      if (e.end_date && e.end_date < week.start) continue;
      const workdays = workdaysFor(e, week);
      const expected = workdays >= cfg.minWorkdaysExpected ? 1 : 0;
      const reason = expected ? null : (workdays === 0 ? 'Not working this week' : `Partial week (${workdays} workday${workdays === 1 ? '' : 's'})`);
      const a = db.get('SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=?', [e.id, week.weekId]);
      if (!a) {
        if (workdays === 0 && e.status === 'terminated') continue;
        db.run(`INSERT INTO survey_assignments (id, employee_id, week_id, template_id, expected, workdays, status, excuse_reason, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`, [id('SA'), e.id, week.weekId, cfg.activeTemplate, expected, workdays, expected ? 'open' : 'excused', reason, nowIso()]);
      } else if (a.status === 'open' || (a.status === 'excused' && a.excuse_reason && /^(Partial week|Not working)/.test(a.excuse_reason))) {
        // Recompute when absences or dates change, unless already signed, on paper, or manually excused.
        db.run('UPDATE survey_assignments SET expected=?, workdays=?, status=?, excuse_reason=? WHERE id=?',
          [expected, workdays, expected ? 'open' : 'excused', reason, a.id]);
      }
    }
  }

  function weekFor(weekId) {
    if (weekId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekId))) throw bad('Bad week');
      return reportingWeek(zonedToUtc(weekId, '12:00:00', tz), tz);
    }
    return reportingWeek(now(), tz);
  }
  const prevWeek = (w) => reportingWeek(new Date(new Date(w.startsAt).getTime() - 3600000), tz);

  function assignmentState(a, week) {
    const sub = db.get('SELECT id, signed_at, late FROM survey_submissions WHERE assignment_id=?', [a.id]);
    if (sub) return { state: sub.late ? 'submitted_late' : 'submitted', submissionId: sub.id, signedAt: sub.signed_at };
    if (a.status === 'excused') return { state: 'excused', reason: a.excuse_reason };
    if (a.status === 'paper') return { state: 'paper' };
    const n = nowIso();
    if (n < week.opensAt) return { state: 'not_open' };
    if (n > week.dueAt) return { state: 'missing' };
    return { state: 'open' };
  }

  // ---------------------------------------------------------------- work-hours window
  const WORK_HOURS_TEXT = 'Monday to Friday, 7:00 AM to 3:30 PM';
  function surveyWindow() {
    const n = now();
    const openNow = !cfg.surveyDuringWorkHoursOnly || isWithinWorkingHours(n, tz);
    return { restricted: cfg.surveyDuringWorkHoursOnly, openNow, hours: WORK_HOURS_TEXT, nextOpen: openNow ? null : nextWorkingSlot(n, tz).toISOString() };
  }
  function requireWorkTime() {
    if (cfg.surveyDuringWorkHoursOnly && !isWithinWorkingHours(now(), tz)) {
      throw new HubError(409, 'outside_work_hours', `The weekly report is available during work hours (${WORK_HOURS_TEXT}), so it is always done on paid time. Safety concerns can be reported anytime.`);
    }
  }

  // ---------------------------------------------------------------- answers & signatures
  function validateAnswers(t, answers, { requireAll }) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw bad('Answers missing');
    const qs = allQuestions(t);
    const known = new Set(qs.map(q => q.id));
    for (const k of Object.keys(answers)) if (!known.has(k)) throw bad(`Unknown question ${k}`);
    const clean = {};
    for (const q of qs) {
      const v = answers[q.id];
      if (v === undefined || v === null || v === '') { if (requireAll && q.required) throw bad(`Question ${q.id} is required`, 'missing_answer'); continue; }
      if (q.type === 'rating') { const n = Number(v); if (!q.options.some(o => o.value === n)) throw bad(`Invalid answer for ${q.id}`); clean[q.id] = n; }
      else if (q.type === 'yesno') { if (!q.options.some(o => o.value === v)) throw bad(`Invalid answer for ${q.id}`); clean[q.id] = v; }
      else { const s = String(v).trim(); if (s.length > (q.maxLength || 1000)) throw bad(`Answer ${q.id} is too long`); if (s) clean[q.id] = s; }
    }
    return clean;
  }

  // Wrong PINs count toward lockout exactly like failed sign-ins. A lockout
  // during signing also ends every open session for that person.
  async function verifyPinFor(e, pin, ctx) {
    if (!e.pin_hash) throw new HubError(409, 'no_pin', 'Set your PIN first.');
    const ok = crypto.safeEqual(await crypto.hashSecret(String(pin || ''), e.pin_salt), e.pin_hash);
    if (ok) return true;
    await serialFailure(e, ctx ? 'sign.pin_failed' : 'login.failed');
    return false;
  }

  function registerFailure(e, action) {
    const fresh = emp(e.id);
    const fails = fresh.failed_logins + 1;
    let lockedUntil = null, hard = fresh.hard_locked, lockouts = JSON.parse(fresh.lockouts_24h || '[]');
    if (fails >= LOGIN_POLICY.maxFailures) {
      const n = now();
      lockedUntil = new Date(n.getTime() + LOGIN_POLICY.lockMinutes * 60000).toISOString();
      lockouts = lockouts.filter(t => n - new Date(t) < 86400000).concat(n.toISOString());
      if (lockouts.length >= LOGIN_POLICY.hardLockAfterLockouts) hard = 1;
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='lockout' WHERE employee_id=? AND revoked_at IS NULL", [nowIso(), e.id]);
      for (const h of activeWith('hr')) queueNotification(h.id, { kind: 'security', ref: e.id, subject: `${fresh.display_name}: too many wrong PINs${hard ? ' — account locked until reset' : ''}`, channels: ['in_app'], hold: false });
    }
    db.run('UPDATE employees SET failed_logins=?, locked_until=?, lockouts_24h=?, hard_locked=? WHERE id=?',
      [lockedUntil ? 0 : fails, lockedUntil, JSON.stringify(lockouts), hard, e.id]);
    audit(e.id, action, 'employee', e.id, { locked: !!lockedUntil, hardLocked: !!hard });
    return { locked: !!lockedUntil, hard: !!hard };
  }
  // The failure that triggers a lock says so, so the person stops trying (see doc F on enumeration).
  const HARD_LOCK_MSG = 'This account is locked. Ask management for a new temporary PIN.';
  const LOCK_MSG = 'Too many wrong tries. Wait 15 minutes or ask management.';
  const lockErr = (r) => r.hard ? new HubError(423, 'hard_locked', HARD_LOCK_MSG) : new HubError(423, 'locked', LOCK_MSG);
  const serialFailure = async (e, action) => tx(() => registerFailure(e, action));

  // R1.2 signature: acknowledgment box + PIN re-entered by the signed-in person.
  // R1.1 also asked for a typed name; it added friction without adding attribution
  // (the PIN already proves who signed), so it was dropped.
  const SIGN_METHOD = 'Signed-in session + acknowledgment checked + PIN re-entered at signing';
  const SIGN_METHOD_PASSKEY = 'Signed-in session + acknowledgment checked + passkey (Face ID / fingerprint / phone lock) on the person\'s own phone at signing';
  // R1.3: on a phone with a passkey, Face ID (or fingerprint / phone passcode) replaces the PIN.
  // The passkey approval is bound to the exact content being signed: the page asks for a
  // challenge for these fields, the phone signs it, and the server re-computes the hash here.
  // weekId is the week of the report actually being signed (from its assignment, never from the page).
  const SIGN_BIND = { 'survey.submit': ['weekId', 'answers', 'language', 'esignConsent'], 'survey.amend': ['submissionId', 'note', 'corrections', 'language'] };
  const bindHash = (action, src) => crypto.sha256(canonical({ action, ...Object.fromEntries((SIGN_BIND[action] || []).map(k => [k, src[k] ?? null])) }));
  async function requireSignature(ctx, input, action) {
    const { affirm, signPin, signTicket } = input;
    if (affirm !== true) throw bad('Check the box to confirm you are signing.', 'no_affirm');
    if (signTicket !== undefined && signTicket !== null && signTicket !== '') {
      if (ctx.session.device_id || ctx.session.shared_device) throw new HubError(403, 'passkey_shared_device', 'Face ID signing works only on your own phone. Sign with your PIN here.');
      const c = SIGN_BIND[action] && db.get('SELECT * FROM webauthn_challenges WHERE id=?', [String(signTicket)]);
      const fresh = c && c.verified_at && new Date(now().getTime() - 5 * 60000).toISOString() < c.verified_at;
      if (!c || c.purpose !== 'sign' || c.verified_employee !== ctx.me.id || c.consumed_at || !fresh || c.action !== action || c.content_hash !== bindHash(action, input)) {
        tx(() => audit(ctx.me.id, 'sign.passkey_refused', 'employee', ctx.me.id, { action }));
        throw new HubError(401, 'bad_sign_ticket', 'The Face ID approval did not match this report (or took too long). Nothing was signed. Try again.');
      }
      const pk = db.get('SELECT id, label FROM passkeys WHERE id=? AND removed_at IS NULL', [c.passkey_id]);
      if (!pk) throw new HubError(401, 'bad_sign_ticket', 'That passkey was removed. Sign with your PIN.');
      tx(() => db.run('UPDATE webauthn_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL', [nowIso(), c.id]));
      return { method: SIGN_METHOD_PASSKEY, passkey: { id: pk.id, device: pk.label, approvalId: c.id, boundContentSha256: c.content_hash } };
    }
    if (!await verifyPinFor(ctx.me, signPin, ctx)) throw new HubError(401, 'bad_sign_pin', 'That PIN is not right. Nothing was signed.');
    return { method: SIGN_METHOD };
  }

  const consentOf = (eid) => db.get('SELECT * FROM esign_consents WHERE employee_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [eid]);
  const identityRecord = (ctx, sig = { method: SIGN_METHOD }) => ({
    method: sig.passkey ? 'Signed-in session + passkey approved on own phone at signing (acknowledgment checked)' : 'Signed-in session + PIN re-entered at signing (acknowledgment checked)',
    device: ctx.session.device_id ? `Registered shop device ${ctx.session.device_id}` : sig.passkey ? `Own phone (${sig.passkey.device}, passkey ${sig.passkey.id})` : (ctx.session.shared_device ? 'Shared device (chosen at sign-in)' : 'Personal device'),
    sessionStartedAt: ctx.session.created_at,
    ...(sig.passkey ? { passkey: sig.passkey } : {})
  });

  // ---------------------------------------------------------------- record assembly
  function verified(row) {
    const ok = crypto.sha256(row.payload_json) === row.payload_hash;
    return { id: row.id, payload: JSON.parse(row.payload_json), hash: row.payload_hash, integrity: ok ? 'verified' : 'MISMATCH', signedAt: row.signed_at };
  }

  function reviewState(submissionId) {
    const events = db.all('SELECT * FROM review_events WHERE submission_id=? ORDER BY rowid', [submissionId]);
    let pending = null, lastClar = -1, lastResp = -1, lastSup = -1, lastSignoffIdx = -1, lastAmend = -1, lastSeen = -1;
    events.forEach((ev, i) => {
      switch (ev.kind) {
        case 'clarification_requested': pending = ev; lastClar = i; lastSup = i; break;
        case 'clarification_withdrawn': pending = null; lastSup = i; break;
        case 'employee_response': pending = null; lastResp = i; break;
        case 'employee_seen': lastSeen = i; break;
        case 'supervisor_note': lastSup = i; break;
        case 'signed_off': lastSignoffIdx = i; lastSup = i; break;
        case 'amended': lastAmend = i; break;
      }
    });
    let state;
    if (pending) state = 'clarification_requested';
    else if (lastSignoffIdx < 0) state = (lastClar >= 0 && lastResp > lastClar) ? 'employee_responded' : 'awaiting_review';
    else if (lastAmend > lastSignoffIdx) state = 'amended_after_signoff';
    else state = 'signed_off';
    const needsSupervisor = ['awaiting_review', 'employee_responded', 'amended_after_signoff'].includes(state) || (state === 'signed_off' && lastResp > lastSup);
    const lastSignoff = db.get('SELECT id, signed_at, reviewer_id, closure FROM supervisor_reviews WHERE submission_id=? ORDER BY signed_at DESC, rowid DESC LIMIT 1', [submissionId]);
    return {
      state, needsSupervisor, employeeSeen: lastSignoffIdx >= 0 && lastSeen > lastSignoffIdx, lastSignoff: lastSignoff || null,
      pendingClarification: pending ? { text: pending.text, at: pending.created_at, by: nameOf(pending.actor_id) } : null
    };
  }

  function buildRecord(submissionId) {
    const s = db.get('SELECT * FROM survey_submissions WHERE id=?', [submissionId]);
    if (!s) throw notFound();
    const original = verified(s);
    const amendments = db.all('SELECT * FROM survey_amendments WHERE submission_id=? ORDER BY signed_at', [s.id]).map(verified);
    const reviews = db.all('SELECT * FROM supervisor_reviews WHERE submission_id=? ORDER BY signed_at', [s.id]).map(verified);
    const events = db.all("SELECT * FROM review_events WHERE submission_id=? AND kind NOT IN ('signed_off','amended') ORDER BY rowid", [s.id]).map(ev => ({
      id: ev.id, kind: ev.kind, text: ev.text, at: ev.created_at, by: nameOf(ev.actor_id), byId: ev.actor_id,
      integrity: crypto.sha256(ev.text) === ev.text_hash ? 'verified' : 'MISMATCH'
    }));
    const paper = db.all('SELECT event, note, created_at FROM paper_events WHERE assignment_id=? ORDER BY created_at', [s.assignment_id]);
    const actions = db.all("SELECT id, title, status, due_date FROM corrective_actions WHERE source_type='survey' AND source_id=?", [s.id]);
    const followups = db.all("SELECT id, type, status FROM safety_reports WHERE source='survey' AND source_ref=?", [s.id]);
    return { submissionId: s.id, employeeId: s.employee_id, original, amendments, reviews, events, paperEvents: paper, actions, followups, review: reviewState(s.id) };
  }

  // ---------------------------------------------------------------- sessions
  function deviceFromToken(deviceToken) {
    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.length > 128) return null;
    return db.get('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL', [crypto.sha256('device|' + deviceToken)]) || null;
  }

  async function login({ employeeId, pin, setupCode, totp, deviceToken, sharedDevice }) {
    return serial(async () => {
      const generic = new HubError(401, 'bad_login', 'Employee number or PIN is not right.');
      const e = emp(String(employeeId || '').trim().toUpperCase());
      if (!e) { tx(() => audit(null, 'login.failed', 'employee', String(employeeId || '').slice(0, 20), { reason: 'unknown' })); throw generic; }
      if (e.status === 'terminated') { tx(() => audit(e.id, 'login.blocked', 'employee', e.id, { reason: 'separated' })); throw generic; }
      if (e.hard_locked) throw new HubError(423, 'hard_locked', HARD_LOCK_MSG);
      if (e.locked_until && e.locked_until > nowIso()) throw new HubError(423, 'locked', LOCK_MSG);
      const device = deviceFromToken(deviceToken);
      const elevated = isElevated(e);
      if (cfg.pinOnlyOnRegisteredDevices && !device && !elevated) {
        tx(() => audit(e.id, 'login.blocked', 'employee', e.id, { reason: 'unregistered_device' }));
        throw new HubError(403, 'device_required', 'Sign in on the shop tablet.');
      }
      // One field: the personal PIN, or a temporary PIN issued by management
      // (which must be changed straight away). `setupCode` is accepted as an alias.
      const secret = String(pin ?? setupCode ?? '').trim();
      let mustSetPin = false;
      const pinOk = !!e.pin_hash && crypto.safeEqual(await crypto.hashSecret(secret, e.pin_salt), e.pin_hash);
      if (!pinOk) {
        const tempOk = !!e.setup_code_hash && e.setup_code_expires > nowIso() && /^\d{6,12}$/.test(secret)
          && crypto.safeEqual(await crypto.hashSecret('setup|' + secret, e.pin_salt || e.id), e.setup_code_hash);
        if (!tempOk) {
          if (!e.pin_hash && !e.setup_code_hash) throw new HubError(409, 'no_pin', 'No PIN is set for this account yet. Ask management for a temporary PIN.');
          const r = await serialFailure(e, 'login.failed'); throw r.locked ? lockErr(r) : generic;
        }
        mustSetPin = true;
      }
      // Management accounts: second factor (authenticator code). Staff never see this step.
      if (elevated && cfg.elevatedRequireTotp) {
        if (!e.totp_secret) throw new HubError(403, 'totp_not_enrolled', 'Management accounts need an authenticator app. Ask a full-access manager to set it up.');
        if (!totp) throw new HubError(401, 'totp_required', 'Enter the 6-digit code from your authenticator app.');
        const counter = await verifyTotp(crypto, await crypto.openSecret(e.totp_secret), String(totp), now(), e.totp_last_counter);
        if (counter === null) { const r = await serialFailure(e, 'login.totp_failed'); throw r.locked ? lockErr(r) : new HubError(401, 'bad_totp', 'That code is not right. Codes change every 30 seconds.'); }
        tx(() => db.run('UPDATE employees SET totp_last_counter=? WHERE id=?', [counter, e.id]));
      }
      const token = crypto.randomHex(32);
      const shared = !!device || (!cfg.pinOnlyOnRegisteredDevices && !!sharedDevice);
      const pol = shared ? SESSION_POLICY.shared : (elevated ? SESSION_POLICY.elevated : SESSION_POLICY.personal);
      const n = now();
      tx(() => {
        if (mustSetPin) db.run('UPDATE employees SET setup_code_hash=NULL, setup_code_expires=NULL WHERE id=?', [e.id]);
        db.run('UPDATE employees SET failed_logins=0, locked_until=NULL WHERE id=?', [e.id]);
        db.run(`INSERT INTO sessions (token_hash, employee_id, device_id, shared_device, must_set_pin, created_at, last_seen, idle_minutes, absolute_expires_at)
                VALUES (?,?,?,?,?,?,?,?,?)`, [crypto.sha256(token), e.id, device ? device.id : null, shared ? 1 : 0, mustSetPin ? 1 : 0,
          n.toISOString(), n.toISOString(), pol.idleMinutes, new Date(n.getTime() + pol.absoluteMinutes * 60000).toISOString()]);
        audit(e.id, mustSetPin ? 'login.setup_code' : 'login', 'employee', e.id, { device: device ? device.id : null, shared });
      });
      return { token, sharedDevice: shared, idleMinutes: pol.idleMinutes, mustSetPin };
    });
  }

  function authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 128) throw new HubError(401, 'no_session', 'Please sign in.');
    const th = crypto.sha256(token);
    const s = db.get('SELECT * FROM sessions WHERE token_hash=?', [th]);
    if (!s || s.revoked_at) throw new HubError(401, s && s.revoke_reason === 'lockout' ? 'locked' : 'no_session', 'Please sign in.');
    const n = now();
    const idleLimit = new Date(new Date(s.last_seen).getTime() + s.idle_minutes * 60000);
    if (n > idleLimit || n.toISOString() > s.absolute_expires_at) {
      tx(() => db.run("UPDATE sessions SET revoked_at=?, revoke_reason='expired' WHERE token_hash=?", [n.toISOString(), th]));
      throw new HubError(401, 'expired', 'Signed out for privacy. Please sign in again.');
    }
    const e = emp(s.employee_id);
    if (!e || e.status === 'terminated') {
      tx(() => db.run("UPDATE sessions SET revoked_at=?, revoke_reason='separated' WHERE token_hash=?", [n.toISOString(), th]));
      throw new HubError(401, 'no_session', 'Please sign in.');
    }
    if (s.device_id && !db.get('SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL', [s.device_id])) {
      tx(() => db.run("UPDATE sessions SET revoked_at=?, revoke_reason='device_revoked' WHERE token_hash=?", [n.toISOString(), th]));
      throw new HubError(401, 'no_session', 'This device is no longer registered.');
    }
    tx(() => db.run('UPDATE sessions SET last_seen=? WHERE token_hash=?', [n.toISOString(), th]));
    return { me: e, roles: rolesOf(e), session: s, tokenHash: th };
  }

  async function logout(token) {
    if (!token || typeof token !== 'string') return { ok: true };
    return serial(async () => {
      const th = crypto.sha256(token);
      const s = db.get('SELECT employee_id FROM sessions WHERE token_hash=?', [th]);
      if (s) tx(() => { db.run("UPDATE sessions SET revoked_at=?, revoke_reason='signed_out' WHERE token_hash=? AND revoked_at IS NULL", [nowIso(), th]); audit(s.employee_id, 'logout', 'employee', s.employee_id, {}); });
      return { ok: true };
    });
  }

  const A = Object.create(null);   // actions, by name (see call())

  // ---------------------------------------------------------------- passkeys (R1.3, owner 2026-10-25)
  // On a person's own phone, Face ID / fingerprint / the phone's passcode replaces the PIN for
  // signing in and for signing the weekly report. The PIN keeps working everywhere. Passkeys are
  // refused on registered shop tablets (shared devices keep name + PIN). The phone keeps the
  // private key; the Hub stores only the public key. Biometrics never leave the phone.
  const PK_CHALLENGE_MIN = 5, PK_MAX_PER_PERSON = 10;
  const rpOk = (rp) => !!rp && typeof rp.rpId === 'string' && typeof rp.origin === 'string' && /^[a-z0-9.-]{1,200}$/.test(rp.rpId) && rp.origin.length < 250;
  const userHandle = (eid) => b64urlEncode(Uint8Array.from(crypto.sha256('passkey-user|' + eid).slice(0, 32).match(/../g), h => parseInt(h, 16)));
  const deviceLabel = (s) => String(s || '').replace(/[^\p{L}\p{N} ()'.,-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Phone';
  const pkView = (p) => ({ id: p.id, device: p.label, createdAt: p.created_at, lastUsedAt: p.last_used_at, address: p.rp_id, synced: !!p.backed_up });
  const livePasskeys = (eid) => db.all('SELECT * FROM passkeys WHERE employee_id=? AND removed_at IS NULL ORDER BY created_at', [eid]);
  const PK_SHOP_TABLET = 'Face ID sign-in is for your own phone. On the shop tablet, use your name and PIN.';

  function newChallenge({ purpose, employeeId = null, rp, action = null, contentHash = null }) {
    if (!rpOk(rp)) throw bad('Passkeys need the Hub\'s web address.', 'no_rp');
    const cid = id('WAC');
    const challenge = b64urlEncode(Uint8Array.from(crypto.randomHex(32).match(/../g), h => parseInt(h, 16)));
    const n = now();
    tx(() => {
      db.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', [new Date(n.getTime() - 3600000).toISOString()]);
      db.run(`INSERT INTO webauthn_challenges (id, purpose, employee_id, challenge, rp_id, origin, action, content_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [cid, purpose, employeeId, challenge, rp.rpId, rp.origin, action, contentHash, n.toISOString(), new Date(n.getTime() + PK_CHALLENGE_MIN * 60000).toISOString()]);
    });
    return { cid, challenge };
  }
  function openChallenge(cid, purposes) {
    const c = db.get('SELECT * FROM webauthn_challenges WHERE id=?', [String(cid || '').slice(0, 40)]);
    if (!c || !purposes.includes(c.purpose) || c.verified_at || c.consumed_at || c.expires_at < nowIso()) throw new HubError(401, 'passkey_expired', 'That took too long. Try again.');
    return c;
  }
  const consumeChallenge = (cid) => db.run('UPDATE webauthn_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL', [nowIso(), cid]);

  // Setting up a phone needs the PIN re-entered (and the authenticator code for management), so an
  // open session alone, or a PIN seen over someone's shoulder plus a session, is not enough to add
  // a phone. Shared sessions (shop tablets, or "shared device" chosen at sign-in) cannot add phones.
  A['passkey.registerOptions'] = async (ctx, { signPin, totp } = {}) => {
    if (ctx.session.device_id || ctx.session.shared_device) throw deny(PK_SHOP_TABLET);
    const mine = livePasskeys(ctx.me.id);
    if (mine.length >= PK_MAX_PER_PERSON) throw bad(`You already have ${PK_MAX_PER_PERSON} phones set up. Remove one under More first.`, 'passkey_limit');
    if (!rpOk(ctx.rp)) throw bad('Passkeys need the Hub\'s web address.', 'no_rp');
    if (!await verifyPinFor(ctx.me, signPin, ctx)) throw new HubError(401, 'bad_sign_pin', 'That PIN is not right.');
    if (isElevated(ctx.me) && cfg.elevatedRequireTotp) {
      const me = emp(ctx.me.id);
      const plain = await crypto.openSecret(me.totp_secret);
      const counter = plain ? await verifyTotp(crypto, plain, String(totp || ''), now(), me.totp_last_counter) : null;
      if (counter === null) { const r = await serialFailure(me, 'passkey.totp_failed'); throw r.locked ? lockErr(r) : new HubError(401, 'bad_totp', 'That authenticator code is not right.'); }
      tx(() => db.run('UPDATE employees SET totp_last_counter=? WHERE id=?', [counter, me.id]));
    }
    const { cid, challenge } = newChallenge({ purpose: 'register', employeeId: ctx.me.id, rp: ctx.rp });
    return { challengeId: cid, publicKey: {
      challenge, rp: { id: ctx.rp.rpId, name: 'Innerspace Employee Hub' },
      user: { id: userHandle(ctx.me.id), name: ctx.me.id, displayName: ctx.me.display_name },
      pubKeyCredParams: [{ type: 'public-key', alg: ALG.ES256 }, { type: 'public-key', alg: ALG.RS256 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: mine.map(m => ({ type: 'public-key', id: m.credential_id })),
      attestation: 'none', timeout: 120000, hints: ['client-device']
    } };
  };
  A['passkey.register'] = async (ctx, { challengeId, credential, label }) => {
    if (ctx.session.device_id || ctx.session.shared_device) throw deny(PK_SHOP_TABLET);
    const c = openChallenge(challengeId, ['register']);
    if (c.employee_id !== ctx.me.id) throw new HubError(401, 'passkey_expired', 'That took too long. Try again.');
    let r;
    try { r = await verifyRegistration({ credential, challenge: c.challenge, origin: c.origin, rpId: c.rp_id }); }
    catch (e) {
      const reason = e instanceof WebAuthnError ? e.reason : 'malformed';   // anything unexpected is refused, never a 500
      tx(() => { consumeChallenge(c.id); audit(ctx.me.id, 'passkey.register_failed', 'employee', ctx.me.id, { reason }); });
      throw bad(`Face ID could not be set up on this phone (${reason}). You can keep using your PIN.`, 'passkey_failed');
    }
    if (db.get('SELECT 1 FROM passkeys WHERE credential_id=?', [r.credentialId])) throw new HubError(409, 'passkey_exists', 'This phone is already set up.');
    const pid = id('PK'), device = deviceLabel(label);
    tx(() => {
      consumeChallenge(c.id);
      db.run(`INSERT INTO passkeys (id, employee_id, credential_id, public_key_jwk, alg, sign_count, rp_id, label, transports, backed_up, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [pid, ctx.me.id, r.credentialId, JSON.stringify(r.jwk), r.alg, r.signCount, c.rp_id, device, JSON.stringify(r.transports), r.backedUp ? 1 : 0, nowIso()]);
      audit(ctx.me.id, 'passkey.registered', 'employee', ctx.me.id, { passkeyId: pid, device, alg: r.alg, address: c.rp_id, synced: r.backedUp });
      // The person (and, for management accounts, full-access managers) hear about every new phone.
      queueNotification(ctx.me.id, { kind: 'security', ref: ctx.me.id, subject: `Face ID sign-in was set up on a ${device}. If this was not you, tell management right away.`, channels: ['in_app'], hold: false });
      if (isElevated(ctx.me)) for (const h of activeWith('hr')) if (h.id !== ctx.me.id) queueNotification(h.id, { kind: 'security', ref: ctx.me.id, subject: `${ctx.me.display_name} set up Face ID sign-in on a ${device}`, channels: ['in_app'], hold: false });
    });
    return { ok: true, passkey: pkView(db.get('SELECT * FROM passkeys WHERE id=?', [pid])), employee: pub(ctx.me) };
  };
  A['passkey.mine'] = (ctx) => livePasskeys(ctx.me.id).map(pkView);
  A['passkey.remove'] = (ctx, { passkeyId }) => {
    const p = db.get('SELECT * FROM passkeys WHERE id=? AND removed_at IS NULL', [String(passkeyId || '')]);
    if (!p || p.employee_id !== ctx.me.id) throw notFound();
    tx(() => {
      db.run("UPDATE passkeys SET removed_at=?, removed_by=?, remove_reason='removed_by_owner' WHERE id=?", [nowIso(), ctx.me.id, p.id]);
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='passkey_removed' WHERE revoked_at IS NULL AND token_hash != ? AND token_hash IN (SELECT token_hash FROM passkey_sessions WHERE passkey_id=?)", [nowIso(), ctx.tokenHash, p.id]);
      audit(ctx.me.id, 'passkey.removed', 'employee', ctx.me.id, { passkeyId: p.id, device: p.label, by: 'owner' });
    });
    return { ok: true, passkeys: livePasskeys(ctx.me.id).map(pkView) };
  };
  // Credential resets remove every phone: a new temporary PIN, a new authenticator, or deactivation.
  // (Call inside a transaction.)
  function dropPasskeys(eid, byId, reason) {
    const list = livePasskeys(eid);
    if (!list.length) return 0;
    db.run('UPDATE passkeys SET removed_at=?, removed_by=?, remove_reason=? WHERE employee_id=? AND removed_at IS NULL', [nowIso(), byId, reason, eid]);
    audit(byId, 'passkey.removed', 'employee', eid, { passkeyIds: list.map(p => p.id), by: reason });
    return list.length;
  }
  // Lost or replaced phone: a full-access manager (or the person's own manager, for staff) removes
  // the person's passkeys and ends their open sessions. Their PIN keeps working.
  const canManagePasskeys = (ctx, e) => !!e && e.id !== ctx.me.id && (has(ctx, 'hr') || (has(ctx, 'supervisor') && e.supervisor_id === ctx.me.id && !isElevated(e)));
  A['accounts.passkeys'] = (ctx, { employeeId }) => {
    const e = emp(employeeId);
    if (!e || !(canManagePasskeys(ctx, e) || e.id === ctx.me.id)) throw notFound();
    return { employee: pub(e), passkeys: livePasskeys(e.id).map(pkView), canRemove: canManagePasskeys(ctx, e) };
  };
  A['accounts.removePasskeys'] = (ctx, { employeeId, passkeyId }) => {
    const e = emp(employeeId);
    if (!e) throw notFound();
    if (!canManagePasskeys(ctx, e)) throw deny(e.id === ctx.me.id ? 'Remove your own phones under More.' : 'Only a full-access manager, or the person\'s own manager, can remove Face ID phones.');
    const list = livePasskeys(e.id).filter(p => !passkeyId || p.id === passkeyId);
    if (passkeyId && !list.length) throw notFound();
    tx(() => {
      for (const p of list) db.run("UPDATE passkeys SET removed_at=?, removed_by=?, remove_reason='removed_by_management' WHERE id=?", [nowIso(), ctx.me.id, p.id]);
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='passkeys_removed' WHERE employee_id=? AND revoked_at IS NULL", [nowIso(), e.id]);
      audit(ctx.me.id, 'passkey.removed', 'employee', e.id, { passkeyIds: list.map(p => p.id), by: 'management' });
    });
    return { ok: true, removed: list.length, passkeys: livePasskeys(e.id).map(pkView) };
  };

  // Public (no session): challenge for "Sign in with Face ID" or "Sign with Face ID".
  // purpose 'sign' binds the challenge to the exact content (see SIGN_BIND).
  async function passkeyOptions({ rp, purpose, action, content }) {
    return serial(async () => {
      let contentHash = null, act = null, p = 'login';
      if (purpose === 'sign') {
        if (!SIGN_BIND[action] || !content || typeof content !== 'object' || Array.isArray(content)) throw bad('Nothing to sign.', 'invalid');
        p = 'sign'; act = action; contentHash = bindHash(action, content);
      }
      const { cid, challenge } = newChallenge({ purpose: p, rp, action: act, contentHash });
      return { challengeId: cid, publicKey: { challenge, rpId: rp.rpId, userVerification: 'required', allowCredentials: [], timeout: 120000, hints: ['client-device'] } };
    });
  }
  // Public: verify the phone's approval and start a personal session. For a 'sign' challenge the
  // verified approval also becomes a single-use signing ticket (5 minutes) for that content only.
  async function passkeyLogin({ challengeId, credential, deviceToken, expectEmployeeId, currentToken }) {
    return serial(async () => {
      const failed = new HubError(401, 'passkey_failed', 'Face ID sign-in did not work. Use your employee ID and PIN.');
      if (deviceFromToken(deviceToken)) throw new HubError(403, 'passkey_shop_tablet', PK_SHOP_TABLET);
      const c = openChallenge(challengeId, ['login', 'sign']);
      const credId = credential && typeof credential.id === 'string' ? credential.id.slice(0, 1400) : '';
      const pk = credId ? db.get('SELECT * FROM passkeys WHERE credential_id=? AND removed_at IS NULL', [credId]) : null;
      if (!pk || pk.rp_id !== c.rp_id) {
        tx(() => { consumeChallenge(c.id); audit(null, 'login.passkey_failed', 'passkey', credId.slice(0, 24) || null, { reason: pk ? 'other_address' : 'unknown_passkey' }); });
        throw new HubError(401, 'passkey_unknown', 'Face ID on this phone is no longer set up for the Hub. Sign in with your PIN, then set it up again under More.');
      }
      let r;
      try { r = await verifyAssertion({ credential, challenge: c.challenge, origin: c.origin, rpId: c.rp_id, stored: { jwk: JSON.parse(pk.public_key_jwk), alg: pk.alg, signCount: pk.sign_count } }); }
      catch (e) {
        const reason = e instanceof WebAuthnError ? e.reason : 'malformed';
        tx(() => { consumeChallenge(c.id); audit(pk.employee_id, 'login.passkey_failed', 'employee', pk.employee_id, { reason, passkeyId: pk.id }); });
        throw failed;
      }
      const e = emp(pk.employee_id);
      if (!e || e.status === 'terminated') { tx(() => { consumeChallenge(c.id); audit(pk.employee_id, 'login.blocked', 'employee', pk.employee_id, { reason: 'separated', via: 'passkey' }); }); throw failed; }
      if (e.hard_locked) { tx(() => consumeChallenge(c.id)); throw new HubError(423, 'hard_locked', HARD_LOCK_MSG); }
      // Same gates as PIN sign-in: a temporary lock, an unfinished PIN reset, management without an
      // authenticator, or a "shop tablet only" policy all stop Face ID too.
      const refuse = (err) => { tx(() => { consumeChallenge(c.id); audit(e.id, 'login.blocked', 'employee', e.id, { reason: err.code, via: 'passkey' }); }); throw err; };
      if (e.locked_until && e.locked_until > nowIso()) refuse(new HubError(423, 'locked', LOCK_MSG));
      if (!e.pin_hash) refuse(new HubError(409, 'no_pin', 'Finish setting your PIN first (sign in with your temporary PIN).'));
      if (isElevated(e) && cfg.elevatedRequireTotp && !e.totp_secret) refuse(new HubError(403, 'totp_not_enrolled', 'Management accounts need an authenticator app. Ask a full-access manager to set it up.'));
      if (cfg.pinOnlyOnRegisteredDevices && !isElevated(e)) refuse(new HubError(403, 'device_required', 'Sign in on the shop tablet.'));
      if (expectEmployeeId && String(expectEmployeeId).trim().toUpperCase() !== e.id) {
        tx(() => consumeChallenge(c.id));
        throw new HubError(409, 'passkey_other_person', `Face ID on this phone is set up for ${e.display_name} (${e.id}). Use the PIN to sign as someone else.`);
      }
      // Passkey with user verification = something you have (the phone) + something you are/know
      // (Face ID, fingerprint or the phone's passcode), so it also counts as management's second step.
      const elevated = isElevated(e);
      const pol = elevated ? SESSION_POLICY.elevated : SESSION_POLICY.personal;
      const token = crypto.randomHex(32);
      const n = now();
      tx(() => {
        if (c.purpose === 'sign') db.run('UPDATE webauthn_challenges SET verified_employee=?, passkey_id=?, verified_at=? WHERE id=?', [e.id, pk.id, n.toISOString(), c.id]);
        else db.run('UPDATE webauthn_challenges SET verified_employee=?, passkey_id=?, verified_at=?, consumed_at=? WHERE id=?', [e.id, pk.id, n.toISOString(), n.toISOString(), c.id]);
        db.run('UPDATE passkeys SET sign_count=?, last_used_at=?, backed_up=? WHERE id=?', [r.signCount, n.toISOString(), r.backedUp ? 1 : 0, pk.id]);
        // The session this browser had (if any) is replaced, so repeated Face ID use does not pile up sessions.
        if (typeof currentToken === 'string' && currentToken.length <= 128) db.run("UPDATE sessions SET revoked_at=?, revoke_reason='replaced' WHERE token_hash=? AND revoked_at IS NULL", [n.toISOString(), crypto.sha256(currentToken)]);
        db.run(`INSERT INTO sessions (token_hash, employee_id, device_id, shared_device, must_set_pin, created_at, last_seen, idle_minutes, absolute_expires_at)
                VALUES (?,?,?,?,?,?,?,?,?)`, [crypto.sha256(token), e.id, null, 0, 0, n.toISOString(), n.toISOString(), pol.idleMinutes, new Date(n.getTime() + pol.absoluteMinutes * 60000).toISOString()]);
        db.run('INSERT INTO passkey_sessions (token_hash, passkey_id) VALUES (?,?)', [crypto.sha256(token), pk.id]);
        audit(e.id, 'login.passkey', 'employee', e.id, { passkeyId: pk.id, device: pk.label, forSigning: c.purpose === 'sign' });
      });
      return { token, idleMinutes: pol.idleMinutes, employee: pub(e), elevated, signTicket: c.purpose === 'sign' ? c.id : null, sharedDevice: false };
    });
  }

  // ---------------------------------------------------------------- actions
  const PRE_PIN_ACTIONS = new Set(['session.me', 'auth.setPin']);

  A['session.me'] = (ctx) => {
    const c = consentOf(ctx.me.id);
    const unseen = db.get("SELECT COUNT(*) n FROM notifications WHERE recipient_id=? AND channel='in_app' AND seen_at IS NULL", [ctx.me.id]).n;
    return {
      employee: { ...pub(ctx.me), language: ctx.me.preferred_language }, roles: ctx.roles, elevated: isElevated(ctx.me),
      ...describeRoles(ctx.roles), permissions: permissionsOf(ctx.roles),
      sharedDevice: !!ctx.session.shared_device, deviceId: ctx.session.device_id, idleMinutes: ctx.session.idle_minutes,
      mustSetPin: !!ctx.session.must_set_pin, consent: c ? { choice: c.choice, version: c.version } : null,
      unseenAlerts: unseen, surveyWindow: surveyWindow(), now: nowIso(), nowLocal: isoWithOffset(now(), tz), tz, demo: cfg.demo, areas: AREAS
    };
  };

  A['auth.setPin'] = async (ctx, { newPin, confirmPin, currentPin }) => {
    if (!ctx.session.must_set_pin) {
      if (!await verifyPinFor(ctx.me, currentPin, ctx)) throw new HubError(401, 'bad_pin', 'Your current PIN is not right.');
    }
    if (String(newPin) !== String(confirmPin)) throw bad('The two PINs do not match.', 'pin_mismatch');
    const problem = pinProblem(newPin, ctx.me.id);
    if (problem) throw bad(problem, 'weak_pin');
    const salt = crypto.randomHex(16);
    const hash = await crypto.hashSecret(String(newPin), salt);
    tx(() => {
      db.run('UPDATE employees SET pin_salt=?, pin_hash=?, pin_set_at=?, hard_locked=0, lockouts_24h=\'[]\' WHERE id=?', [salt, hash, nowIso(), ctx.me.id]);
      db.run('UPDATE sessions SET must_set_pin=0 WHERE token_hash=?', [ctx.tokenHash]);
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='pin_changed' WHERE employee_id=? AND token_hash != ? AND revoked_at IS NULL", [nowIso(), ctx.me.id, ctx.tokenHash]);
      audit(ctx.me.id, 'pin.set', 'employee', ctx.me.id, {});
    });
    return { ok: true };
  };

  // Temporary PIN: random digits (works on the keypad), single use, expires,
  // replaces the old PIN, and must be changed at first sign-in. Only a hash is stored.
  function randomDigits(n) {
    let out = '';
    while (out.length < n) for (const h of crypto.randomHex(16).match(/../g)) { const b = parseInt(h, 16); if (b < 250 && out.length < n) out += String(b % 10); }
    return out;
  }
  async function issueTempPin(ctx, e, reason) {
    let code; do { code = randomDigits(LOGIN_POLICY.tempPinDigits); } while (pinProblem(code, e.id));
    const salt = e.pin_salt || crypto.randomHex(16);
    const hash = await crypto.hashSecret('setup|' + code, salt);
    const expires = new Date(now().getTime() + LOGIN_POLICY.tempPinHours * 3600000).toISOString();
    tx(() => {
      db.run('UPDATE employees SET pin_hash=NULL, setup_code_hash=?, setup_code_expires=?, setup_code_issued_by=?, failed_logins=0, locked_until=NULL, hard_locked=0, lockouts_24h=\'[]\', pin_salt=? WHERE id=?',
        [hash, expires, ctx.me.id, salt, e.id]);
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='pin_reset' WHERE employee_id=? AND revoked_at IS NULL", [nowIso(), e.id]);
      dropPasskeys(e.id, ctx.me.id, 'pin_reset');
      audit(ctx.me.id, 'pin.temp_issued', 'employee', e.id, { expires, reason });
    });
    return { tempPin: code, code, expiresAt: expires, employee: pub(e),
      instructions: `Give this temporary PIN to ${e.display_name} in person. It works once, within ${LOGIN_POLICY.tempPinHours} hours, and they must choose their own PIN right away. Their old PIN no longer works.` };
  }

  A['accounts.resetPin'] = async (ctx, { employeeId }) => {
    const e = emp(employeeId);
    if (!e || e.status === 'terminated') throw notFound();
    if (e.id === ctx.me.id) throw deny('Ask another full-access manager to reset your own PIN.');
    const allowed = has(ctx, 'hr') || (has(ctx, 'supervisor') && e.supervisor_id === ctx.me.id && !isElevated(e));
    if (!allowed) throw deny('Only a full-access manager, or the person\'s own manager, can reset a PIN.');
    return issueTempPin(ctx, e, 'reset');
  };
  A['auth.issueSetupCode'] = (ctx, input) => A['accounts.resetPin'](ctx, input);   // R1.1 name, kept for compatibility

  // A full-access manager sets up (or resets) a management account's authenticator, with the person present.
  A['auth.enrollTotp'] = async (ctx, { employeeId }) => {
    if (!has(ctx, 'hr')) throw deny();
    const e = emp(employeeId);
    if (!e || e.status !== 'active' || !isElevated(e)) throw bad('Only management accounts use an authenticator.');
    if (e.id === ctx.me.id && e.totp_secret) throw deny('Ask another HR user to reset your own authenticator.');
    const secret = base32Encode(Uint8Array.from(crypto.randomHex(20).match(/../g), h => parseInt(h, 16)));
    const sealed = await crypto.sealSecret(secret);   // stored encrypted; shown in plain once, here
    tx(() => {
      db.run('UPDATE employees SET totp_secret=?, totp_last_counter=-1 WHERE id=?', [sealed, e.id]);
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='totp_reset' WHERE employee_id=? AND revoked_at IS NULL", [nowIso(), e.id]);
      dropPasskeys(e.id, ctx.me.id, 'totp_reset');
      audit(ctx.me.id, 'totp.enrolled', 'employee', e.id, {});
    });
    return { secret, otpauth: `otpauth://totp/TAG%20Employee%20Hub:${encodeURIComponent(e.id)}?secret=${secret}&issuer=TAG%20Employee%20Hub`, instructions: 'Scan or type this into the person\'s authenticator app now. It is shown once.' };
  };

  // ---- employee accounts (Management → Employee Accounts)
  // IDs are stable: chosen once (or generated as E-###), never changed, never reused.
  const accountView = (ctx, e) => ({
    ...pub(e), language: e.preferred_language, startDate: e.start_date, endDate: e.end_date, reportsTo: e.supervisor_id, reportsToName: nameOf(e.supervisor_id),
    ...describeRoles(rolesOf(e)), pinSet: !!e.pin_hash, tempPinPending: !!e.setup_code_hash && e.setup_code_expires > nowIso(),
    locked: !!e.hard_locked || !!(e.locked_until && e.locked_until > nowIso()), mfaEnrolled: !!e.totp_secret,
    passkeys: db.get('SELECT COUNT(*) n FROM passkeys WHERE employee_id=? AND removed_at IS NULL', [e.id]).n,
    smsPhone: has(ctx, 'hr') || e.id === ctx.me.id ? e.sms_phone : (e.sms_phone ? 'on file' : null)
  });
  const canSeeAccount = (ctx, e) => has(ctx, 'hr') || e.supervisor_id === ctx.me.id || e.id === ctx.me.id;
  A['accounts.list'] = (ctx) => {
    if (!any(ctx, 'supervisor', 'hr')) throw deny();
    return db.all('SELECT * FROM employees ORDER BY status, display_name', []).filter(e => canSeeAccount(ctx, e)).map(e => accountView(ctx, e));
  };
  function accountFields(input, existing) {
    const name = String(input.name ?? existing?.display_name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80) throw bad('Enter the person\'s name.', 'name');
    const language = (input.language ?? existing?.preferred_language) === 'es' ? 'es' : 'en';
    const role = input.role ?? describeRoles(existing ? rolesOf(existing) : ['employee']).role;
    if (!['staff', 'management'].includes(role)) throw bad('Role must be Staff or Management.', 'role');
    const roles = internalRolesFor({ role, fullAccess: role === 'management' && !!input.fullAccess, safetyContact: role === 'management' && !!input.safetyContact });
    const reportsTo = input.reportsTo === undefined ? (existing ? existing.supervisor_id : null) : (input.reportsTo || null);
    if (reportsTo) { const m = emp(reportsTo); if (!m || m.status !== 'active' || !isElevated(m)) throw bad('"Reports to" must be an active management account.', 'reports_to'); }
    const department = String(input.department ?? existing?.department ?? '').trim().slice(0, 40) || null;
    // Mobile number for urgent safety texts: management only (staff are never texted).
    let smsPhone = input.smsPhone === undefined ? (existing ? existing.sms_phone : null) : String(input.smsPhone || '').trim();
    if (smsPhone) {
      const d = smsPhone.replace(/[^\d+]/g, '');
      smsPhone = /^\+\d{10,15}$/.test(d) ? d : /^1?\d{10}$/.test(d) ? '+1' + d.slice(-10) : null;
      if (!smsPhone) throw bad('Mobile number: 10 digits, e.g. 818-555-0142.', 'phone');
    } else smsPhone = null;
    if (role !== 'management') smsPhone = null;
    return { name, language, roles, reportsTo, department, smsPhone };
  }
  A['accounts.create'] = async (ctx, input) => {
    if (!has(ctx, 'hr')) throw deny('Only a full-access manager can create accounts.');
    const f = accountFields(input || {}, null);
    let eid = String(input.employeeId || '').trim().toUpperCase();
    if (eid) {
      if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(eid)) throw bad('Employee ID: 2–20 letters, digits or dashes.', 'employee_id');
      if (emp(eid)) throw new HubError(409, 'id_taken', 'That employee ID is already used (IDs are never reused).');
    } else {
      const max = db.all("SELECT id FROM employees WHERE id LIKE 'E-%'", []).map(r => Number(r.id.slice(2))).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 100);
      eid = 'E-' + (max + 1);
    }
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || '')) ? input.startDate : ymdOf(now(), tz);
    tx(() => {
      db.run(`INSERT INTO employees (id, display_name, preferred_language, status, start_date, supervisor_id, roles, department, sms_phone, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [eid, f.name, f.language, 'active', start, f.reportsTo, JSON.stringify(f.roles), f.department, f.smsPhone, nowIso()]);
      audit(ctx.me.id, 'account.created', 'employee', eid, { roles: f.roles, reportsTo: f.reportsTo });
    });
    const e = emp(eid);
    const pinOut = await issueTempPin(ctx, e, 'new_account');
    const mfa = isElevated(e) && cfg.elevatedRequireTotp ? await A['auth.enrollTotp'](ctx, { employeeId: eid }) : null;
    return { account: accountView(ctx, emp(eid)), tempPin: pinOut.tempPin, expiresAt: pinOut.expiresAt, instructions: pinOut.instructions, mfa };
  };
  A['accounts.update'] = async (ctx, input) => {
    if (!has(ctx, 'hr')) throw deny('Only a full-access manager can change accounts.');
    const e = emp(input.employeeId); if (!e) throw notFound();
    const f = accountFields(input, e);
    if (e.id === ctx.me.id && !f.roles.includes('hr')) throw deny('You cannot remove your own full access.');
    if (f.reportsTo === e.id) throw bad('A person cannot report to themselves.', 'reports_to');
    const becameManagement = !isElevated(e) && f.roles.some(r => r !== 'employee');
    tx(() => {
      db.run('UPDATE employees SET display_name=?, preferred_language=?, roles=?, supervisor_id=?, department=?, sms_phone=? WHERE id=?', [f.name, f.language, JSON.stringify(f.roles), f.reportsTo, f.department, f.smsPhone, e.id]);
      // A role change ends open sessions so new permissions (and MFA) apply at next sign-in.
      if (JSON.stringify(f.roles) !== e.roles) db.run("UPDATE sessions SET revoked_at=?, revoke_reason='role_changed' WHERE employee_id=? AND revoked_at IS NULL", [nowIso(), e.id]);
      audit(ctx.me.id, 'account.updated', 'employee', e.id, { from: JSON.parse(e.roles), to: f.roles, reportsTo: f.reportsTo });
    });
    const mfa = becameManagement && cfg.elevatedRequireTotp && !e.totp_secret ? await A['auth.enrollTotp'](ctx, { employeeId: e.id }) : null;
    return { account: accountView(ctx, emp(e.id)), mfa };
  };
  A['accounts.deactivate'] = (ctx, { employeeId, endDate }) => A['hr.setStatus'](ctx, { employeeId, status: 'terminated', endDate });
  A['accounts.reactivate'] = async (ctx, { employeeId }) => {
    const r = A['hr.setStatus'](ctx, { employeeId, status: 'active' });
    const e = emp(employeeId);
    const pinOut = await issueTempPin(ctx, e, 'reactivated');
    return { ...r, tempPin: pinOut.tempPin, expiresAt: pinOut.expiresAt, instructions: pinOut.instructions };
  };

  // ---- first account (production only): a one-time bootstrap creates the owner's full-access
  // management account on an empty database, guarded by a secret setup code, then switches off.
  async function bootstrapStatus() {
    const n = db.get('SELECT COUNT(*) n FROM employees', []).n;
    // "Start over" is possible only until anyone has finished signing in (chosen their own PIN).
    const inUse = !!db.get('SELECT 1 FROM employees WHERE pin_hash IS NOT NULL', []);
    return { needed: n === 0 && !cfg.demo, recoverable: n > 0 && !inUse && !cfg.demo };
  }
  // Owner lost the one-time setup screen before finishing sign-in: with the same setup code,
  // issue a new temporary PIN and a new authenticator secret for the first account. Refused once
  // anyone has chosen their own PIN (from then on a full-access manager resets PINs as usual).
  async function bootstrapRecover({ code, expectedCode }) {
    return serial(async () => {
      if (cfg.demo) throw new HubError(404, 'not_found', 'Not found');
      if (!expectedCode || String(expectedCode).length < 16) throw new HubError(404, 'not_found', 'Not found');
      const st = await bootstrapStatus();
      if (!st.recoverable) throw new HubError(409, 'in_use', 'The Hub is already in use. A full-access manager can reset PINs and authenticators under Accounts.');
      if (!crypto.safeEqual(crypto.sha256('boot|' + String(code || '')), crypto.sha256('boot|' + String(expectedCode)))) {
        tx(() => audit(null, 'bootstrap.recover_refused', 'system', null, {}));
        throw new HubError(401, 'bad_code', 'Setup code is not right.');
      }
      const first = db.get("SELECT entity_id FROM audit_events WHERE action='bootstrap.first_account' ORDER BY seq LIMIT 1", []);
      const e = first && emp(first.entity_id);
      if (!e) throw new HubError(409, 'in_use', 'No first account to restart.');
      const ctx = { me: e, roles: rolesOf(e) };
      const pinOut = await issueTempPin(ctx, e, 'bootstrap_recover');
      const secret = base32Encode(Uint8Array.from(crypto.randomHex(20).match(/../g), h => parseInt(h, 16)));
      const sealed = await crypto.sealSecret(secret);
      tx(() => {
        db.run('UPDATE employees SET totp_secret=?, totp_last_counter=-1 WHERE id=?', [sealed, e.id]);
        audit(null, 'bootstrap.recovered', 'employee', e.id, {});
      });
      return { employeeId: e.id, name: e.display_name, tempPin: pinOut.tempPin, expiresAt: pinOut.expiresAt,
        mfa: { secret, otpauth: `otpauth://totp/TAG%20Employee%20Hub:${encodeURIComponent(e.id)}?secret=${secret}&issuer=TAG%20Employee%20Hub` },
        instructions: 'Add the authenticator secret to your phone now, then sign in with this employee ID and the temporary PIN; the 6-digit code is asked for on the next step.' };
    });
  }
  async function bootstrap({ code, expectedCode, employeeId, name, smsPhone }) {
    return serial(async () => {
      if (cfg.demo) throw new HubError(404, 'not_found', 'Not found');
      if (!expectedCode || String(expectedCode).length < 16) throw new HubError(404, 'not_found', 'Not found');
      if (db.get('SELECT COUNT(*) n FROM employees', []).n > 0) throw new HubError(409, 'already_set_up', 'Already set up.');
      if (!crypto.safeEqual(crypto.sha256('boot|' + String(code || '')), crypto.sha256('boot|' + String(expectedCode)))) {
        tx(() => audit(null, 'bootstrap.refused', 'system', null, {}));
        throw new HubError(401, 'bad_code', 'Setup code is not right.');
      }
      const eid = String(employeeId || 'E-101').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(eid)) throw bad('Employee ID: 2–20 letters, digits or dashes.', 'employee_id');
      const f = accountFields({ name, role: 'management', fullAccess: true, safetyContact: true, smsPhone, reportsTo: null }, null);
      tx(() => {
        db.run(`INSERT INTO employees (id, display_name, preferred_language, status, start_date, supervisor_id, roles, department, sms_phone, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [eid, f.name, f.language, 'active', reportingWeek(now(), tz).start, null, JSON.stringify(f.roles), 'Office', f.smsPhone, nowIso()]);   // counts for the current week
        audit(null, 'bootstrap.first_account', 'employee', eid, { roles: f.roles });
      });
      const e = emp(eid);
      const ctx = { me: e, roles: rolesOf(e) };
      const pinOut = await issueTempPin(ctx, e, 'bootstrap');
      const mfa = await A['auth.enrollTotp'](ctx, { employeeId: eid });
      return { employeeId: eid, tempPin: pinOut.tempPin, expiresAt: pinOut.expiresAt, mfa,
        instructions: 'Add the authenticator secret to your phone now, then sign in with this employee ID, the temporary PIN and the 6-digit code. Setup is now switched off.' };
    });
  }

  A['device.register'] = (ctx, { label }) => {
    if (!any(ctx, 'manager', 'hr')) throw deny();
    const l = String(label || '').trim().slice(0, 60) || 'Shop tablet';
    const token = crypto.randomHex(32);
    const did = id('DEV');
    tx(() => {
      db.run('INSERT INTO devices (id, label, token_hash, registered_by, registered_at) VALUES (?,?,?,?,?)', [did, l, crypto.sha256('device|' + token), ctx.me.id, nowIso()]);
      audit(ctx.me.id, 'device.registered', 'device', did, { label: l });
    });
    return { deviceId: did, label: l, deviceToken: token };
  };
  A['device.list'] = (ctx) => {
    if (!any(ctx, 'manager', 'hr')) throw deny();
    return db.all('SELECT id, label, registered_by, registered_at, revoked_at FROM devices ORDER BY registered_at DESC', []).map(d => ({ ...d, registeredBy: nameOf(d.registered_by) }));
  };
  A['device.revoke'] = (ctx, { deviceId }) => {
    if (!any(ctx, 'manager', 'hr')) throw deny();
    const d = db.get('SELECT * FROM devices WHERE id=? AND revoked_at IS NULL', [String(deviceId || '')]);
    if (!d) throw notFound();
    tx(() => {
      db.run('UPDATE devices SET revoked_at=? WHERE id=?', [nowIso(), d.id]);
      db.run("UPDATE sessions SET revoked_at=?, revoke_reason='device_revoked' WHERE device_id=? AND revoked_at IS NULL", [nowIso(), d.id]);
      audit(ctx.me.id, 'device.revoked', 'device', d.id, {});
    });
    return { ok: true };
  };

  A['consent.record'] = (ctx, { choice, language }) => {
    if (!['electronic', 'paper'].includes(choice)) throw bad('Choose electronic or paper.');
    tx(() => {
      db.run('INSERT INTO esign_consents (id, employee_id, version, choice, language, created_at) VALUES (?,?,?,?,?,?)',
        [id('CON'), ctx.me.id, ESIGN_CONSENT_V1.version, choice, language === 'es' ? 'es' : 'en', nowIso()]);
      audit(ctx.me.id, 'esign.consent', 'employee', ctx.me.id, { choice, version: ESIGN_CONSENT_V1.version });
    });
    return { ok: true, choice };
  };

  // ---- employee home & survey
  A['home'] = (ctx) => {
    const week = reportingWeek(now(), tz);
    tx(() => { ensureAssignments(prevWeek(week)); ensureAssignments(week); });
    const surveys = [prevWeek(week), week].map(w => {
      const a = db.get('SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=?', [ctx.me.id, w.weekId]);
      if (!a) return null;
      const st = assignmentState(a, w);
      // "My week" card: where the signed report is in review.
      if (st.submissionId) { const rv = reviewState(st.submissionId); st.review = { state: rv.state, by: rv.lastSignoff ? nameOf(rv.lastSignoff.reviewer_id) : null, at: rv.lastSignoff ? rv.lastSignoff.signed_at : null, question: rv.pendingClarification }; }
      return { assignmentId: a.id, week: w, ...st };
    }).filter(Boolean);
    const myReviewItems = db.all('SELECT id, assignment_id FROM survey_submissions WHERE employee_id=? ORDER BY signed_at DESC LIMIT 12', [ctx.me.id])
      .map((s, i) => ({ submissionId: s.id, weekId: db.get('SELECT week_id FROM survey_assignments WHERE id=?', [s.assignment_id]).week_id, recent: i < 3, ...reviewState(s.id) }))
      // Open questions always; unread reviews only for the latest three reports (older ones stay in history).
      .filter(r => r.state === 'clarification_requested' || (r.recent && r.lastSignoff && !r.employeeSeen));
    const safety = db.all("SELECT id, type, status, created_at FROM safety_reports WHERE reporter_id=? AND (status != 'closed' OR closed_at >= ?) ORDER BY created_at DESC LIMIT 5",
      [ctx.me.id, new Date(now().getTime() - 14 * 86400000).toISOString()]);
    return { greetingName: ctx.me.display_name.split(' ')[0], surveys, reviewItems: myReviewItems, safety, links: LINKS, reviewer: nameOf(ctx.me.supervisor_id) };
  };

  A['survey.template'] = (ctx, { assignmentId }) => {
    let tid = cfg.activeTemplate;
    if (assignmentId) {
      const a = db.get('SELECT * FROM survey_assignments WHERE id=?', [String(assignmentId)]);
      if (!a || a.employee_id !== ctx.me.id) throw notFound();
      tid = a.template_id;
    }
    return { template: getTemplate(tid), consent: ESIGN_CONSENT_V1, supervisorAck: SUPERVISOR_ACK, seenStatement: SEEN_STATEMENT };
  };

  A['survey.versions'] = (ctx) => {
    if (!any(ctx, 'manager', 'hr', 'supervisor')) throw deny();
    return { active: cfg.activeTemplate, versions: Object.values(TEMPLATES) };
  };

  A['survey.assignment'] = (ctx, { assignmentId }) => {
    const a = db.get('SELECT * FROM survey_assignments WHERE id=?', [String(assignmentId || '')]);
    if (!a || a.employee_id !== ctx.me.id) throw notFound();
    const w = weekFor(a.week_id);
    const d = db.get('SELECT answers_json, updated_at FROM survey_drafts WHERE assignment_id=?', [a.id]);
    return { assignmentId: a.id, templateId: a.template_id, week: w, ...assignmentState(a, w), draft: d ? JSON.parse(d.answers_json) : null, draftSavedAt: d && d.updated_at };
  };

  A['survey.saveDraft'] = (ctx, { assignmentId, answers }) => {
    requireWorkTime();
    const a = db.get('SELECT * FROM survey_assignments WHERE id=?', [String(assignmentId || '')]);
    if (!a || a.employee_id !== ctx.me.id) throw notFound();
    if (db.get('SELECT 1 FROM survey_submissions WHERE assignment_id=?', [a.id])) throw new HubError(409, 'already_submitted', 'Already signed.');
    const clean = validateAnswers(getTemplate(a.template_id), answers, { requireAll: false });
    const at = nowIso();
    tx(() => db.run(`INSERT INTO survey_drafts (assignment_id, employee_id, answers_json, updated_at) VALUES (?,?,?,?)
            ON CONFLICT(assignment_id) DO UPDATE SET answers_json=excluded.answers_json, updated_at=excluded.updated_at`, [a.id, ctx.me.id, JSON.stringify(clean), at]));
    return { ok: true, savedAt: at };
  };

  A['survey.submit'] = async (ctx, input) => {
    const { assignmentId, answers, language, idempotencyKey } = input;
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 80) throw bad('Missing submission key');
    const dup = db.get('SELECT id, employee_id, payload_hash, signed_at FROM survey_submissions WHERE idempotency_key=?', [idempotencyKey]);
    if (dup) {
      if (dup.employee_id !== ctx.me.id) throw bad('Key already used');
      return { submissionId: dup.id, hash: dup.payload_hash, duplicate: true, signedAtLocal: isoWithOffset(new Date(dup.signed_at), tz), followups: [] };
    }
    requireWorkTime();
    const a = db.get('SELECT * FROM survey_assignments WHERE id=?', [String(assignmentId || '')]);
    if (!a || a.employee_id !== ctx.me.id) throw notFound();
    // R1.2: the e-sign consent is part of the first signature (one checkbox shows the consent text
    // the first time) instead of a separate screen. Someone who chose paper is not signed electronically.
    const prior = consentOf(ctx.me.id);
    if (prior && prior.choice === 'paper') throw new HubError(409, 'paper_chosen', 'You chose paper forms. Ask your manager for a paper form, or switch back to electronic signing.');
    if (!prior && input.esignConsent !== true) throw new HubError(409, 'needs_consent', 'Agree to sign electronically (or ask for a paper form) to submit.');
    const consent = prior || { id: id('CON'), version: ESIGN_CONSENT_V1.version, created_at: nowIso(), isNew: true };
    if (db.get('SELECT 1 FROM survey_submissions WHERE assignment_id=?', [a.id])) throw new HubError(409, 'already_submitted', 'This week is already signed. Add a correction instead.');
    if (a.status === 'excused' || a.status === 'paper') throw new HubError(409, 'not_open', 'This week is handled outside the Hub.');
    const w = weekFor(a.week_id);
    if (nowIso() < w.opensAt) throw new HubError(409, 'not_open', 'This week\'s report opens Friday.');
    const t = getTemplate(a.template_id);
    const clean = validateAnswers(t, answers, { requireAll: true });
    const sig = await requireSignature(ctx, { ...input, weekId: a.week_id }, 'survey.submit');
    const lang = language === 'es' ? 'es' : 'en';
    const n = now();
    const subId = id('SUB');
    const payload = {
      recordType: 'weekly-report-submission', submissionId: subId, assignmentId: a.id,
      employee: { id: ctx.me.id, displayName: ctx.me.display_name },
      form: { templateId: t.id, label: t.label, source: t.source },
      reportingPeriod: { start: w.start, end: w.end, timeZone: tz, dueAt: isoWithOffset(new Date(w.dueAt), tz) },
      language: lang,
      answers: allQuestions(t).filter(q => clean[q.id] !== undefined).map(q => ({
        questionId: q.id, origin: q.origin, questionText: q.text[lang], questionTextEn: q.text.en, answer: clean[q.id],
        answerLabel: q.options ? q.options.find(o => o.value === clean[q.id])[lang] : undefined
      })),
      signature: {
        method: sig.method, statementShown: (sig.passkey && t.signature.statementPasskey ? t.signature.statementPasskey : t.signature.statement)[lang], signerName: ctx.me.display_name,
        affirmativeAction: sig.passkey ? 'Checked the signing acknowledgment, tapped Sign with Face ID and approved on own phone' : 'Checked the signing acknowledgment, re-entered PIN and tapped Sign & submit',
        identity: identityRecord(ctx, sig), consent: { id: consent.id, version: consent.version, at: consent.created_at, givenWithThisSignature: !!consent.isNew }
      },
      signedAtUtc: n.toISOString(), signedAtLocal: isoWithOffset(n, tz), late: n.toISOString() > w.dueAt, demo: cfg.demo
    };
    const json = canonical(payload);
    const hash = crypto.sha256(json);
    const followups = [];
    tx(() => {
      if (consent.isNew) {
        db.run('INSERT INTO esign_consents (id, employee_id, version, choice, language, created_at) VALUES (?,?,?,?,?,?)', [consent.id, ctx.me.id, consent.version, 'electronic', lang, consent.created_at]);
        audit(ctx.me.id, 'esign.consent', 'employee', ctx.me.id, { choice: 'electronic', version: consent.version, withSignature: subId });
      }
      db.run(`INSERT INTO survey_submissions (id, assignment_id, employee_id, idempotency_key, payload_json, payload_hash, signed_at, late, has_safety, has_obstacle)
              VALUES (?,?,?,?,?,?,?,?,?,?)`, [subId, a.id, ctx.me.id, idempotencyKey, json, hash, n.toISOString(), payload.late ? 1 : 0,
        (clean.s1 || clean.q4 === 'yes') ? 1 : 0, clean.s2 ? 1 : 0]);
      db.run("UPDATE survey_assignments SET status='submitted' WHERE id=?", [a.id]);
      db.run('DELETE FROM survey_drafts WHERE assignment_id=?', [a.id]);
      audit(ctx.me.id, 'survey.signed', 'survey_submission', subId, { hash, week: w.weekId, template: t.id });
      if (clean.q4 === 'yes') followups.push(createSafetyReport(ctx, {
        type: 'injury_followup', description: 'Answered Yes to the weekly injury question. Check in privately to see whether a work injury needs reporting. No medical details were collected.',
        confidential: true }, { source: 'survey', sourceRef: subId }));
      if (clean.s1) followups.push(createSafetyReport(ctx, { type: 'hazard', description: clean.s1, confidential: false }, { source: 'survey', sourceRef: subId }));
      if (ctx.me.supervisor_id) queueNotification(ctx.me.supervisor_id, { kind: 'review', ref: subId, subject: `${ctx.me.display_name} signed the weekly report${clean.s1 || clean.s2 ? ' (has items to look at)' : ''}`, channels: ['in_app'] });
    });
    if (followups.some(f => f.priority === 'urgent' || f.priority === 'high')) dispatchDue();
    return { submissionId: subId, hash, signedAtLocal: payload.signedAtLocal, late: payload.late, followups };
  };

  A['survey.mine'] = (ctx) => db.all(`
      SELECT a.id assignmentId, a.week_id weekId, a.status, a.excuse_reason excuseReason, s.id submissionId, s.signed_at signedAt, s.late
      FROM survey_assignments a LEFT JOIN survey_submissions s ON s.assignment_id = a.id
      WHERE a.employee_id = ? ORDER BY a.week_id DESC LIMIT 52`, [ctx.me.id]).map(r => ({ ...r, review: r.submissionId ? reviewState(r.submissionId).state : null }));

  A['survey.record'] = (ctx, { submissionId }) => {
    const s = db.get('SELECT employee_id FROM survey_submissions WHERE id=?', [String(submissionId || '')]);
    if (!s || !canViewAnswers(ctx, s.employee_id)) {
      if (s) tx(() => audit(ctx.me.id, 'record.denied', 'survey_submission', submissionId, {}));
      throw notFound();
    }
    if (ctx.me.id !== s.employee_id) tx(() => audit(ctx.me.id, 'record.viewed', 'survey_submission', submissionId, {}));
    if (ctx.me.id === s.employee_id) tx(() => markSeen(ctx.me.id, submissionId));
    const rec = buildRecord(submissionId);
    rec.employee = pub(emp(s.employee_id));
    rec.viewerIsOwner = ctx.me.id === s.employee_id;
    rec.viewerCanReview = !rec.viewerIsOwner && supervisesOrHr(ctx, emp(s.employee_id));
    // The private injury follow-up is not listed for supervisors (gate G3); they still see the Q4 answer itself.
    if (!rec.viewerIsOwner && !seesIdentity(ctx)) rec.followups = rec.followups.filter(f => f.type !== 'injury_followup');
    if (rec.viewerCanReview) tx(() => markSeen(ctx.me.id, submissionId));
    return rec;
  };

  A['survey.amend'] = async (ctx, input) => {
    requireWorkTime();
    const { submissionId, note, corrections, language } = input;
    const s = db.get('SELECT * FROM survey_submissions WHERE id=?', [String(submissionId || '')]);
    if (!s || s.employee_id !== ctx.me.id) throw notFound();
    const text = String(note || '').trim();
    if (!text || text.length > 2000) throw bad('Explain the correction (up to 2000 characters).');
    const a = db.get('SELECT template_id FROM survey_assignments WHERE id=?', [s.assignment_id]);
    const corr = corrections ? validateAnswers(getTemplate(a.template_id), corrections, { requireAll: false }) : {};
    const sig = await requireSignature(ctx, input, 'survey.amend');
    const n = now(); const aid = id('AMD'); const lang = language === 'es' ? 'es' : 'en';
    const payload = {
      recordType: 'weekly-report-amendment', amendmentId: aid, amends: { submissionId: s.id, originalHash: s.payload_hash },
      employee: { id: ctx.me.id, displayName: ctx.me.display_name }, note: text, corrections: corr, language: lang,
      signature: { method: sig.method, signerName: ctx.me.display_name, identity: identityRecord(ctx, sig) },
      signedAtUtc: n.toISOString(), signedAtLocal: isoWithOffset(n, tz), demo: cfg.demo
    };
    const json = canonical(payload); const hash = crypto.sha256(json);
    tx(() => {
      db.run('INSERT INTO survey_amendments (id, submission_id, employee_id, payload_json, payload_hash, signed_at) VALUES (?,?,?,?,?,?)', [aid, s.id, ctx.me.id, json, hash, n.toISOString()]);
      addReviewEvent(s.id, ctx.me.id, 'amended', aid);
      audit(ctx.me.id, 'survey.amended', 'survey_submission', s.id, { amendmentId: aid, hash });
      if (ctx.me.supervisor_id) queueNotification(ctx.me.supervisor_id, { kind: 'review', ref: s.id, subject: `${ctx.me.display_name} added a correction to a signed report`, channels: ['in_app'] });
    });
    return { amendmentId: aid, hash };
  };

  // ---- supervisor review
  function reviewTarget(ctx, submissionId) {
    const s = db.get('SELECT * FROM survey_submissions WHERE id=?', [String(submissionId || '')]);
    if (!s) throw notFound();
    if (s.employee_id === ctx.me.id) throw deny('You cannot review your own report.');
    const subject = emp(s.employee_id);
    if (!supervisesOrHr(ctx, subject)) throw notFound();
    return { s, subject };
  }
  function addReviewEvent(submissionId, actorId, kind, text) {
    const t = String(text || '').trim();
    db.run('INSERT INTO review_events (id, submission_id, actor_id, kind, text, text_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      [id('RE'), submissionId, actorId, kind, t, crypto.sha256(t), nowIso()]);
  }

  A['review.requestClarification'] = (ctx, { submissionId, text }) => {
    const { s, subject } = reviewTarget(ctx, submissionId);
    const t = String(text || '').trim();
    if (!t || t.length > 2000) throw bad('Write your question (up to 2000 characters).');
    if (reviewState(s.id).state === 'clarification_requested') throw new HubError(409, 'pending', 'A question is already waiting for an answer.');
    tx(() => {
      addReviewEvent(s.id, ctx.me.id, 'clarification_requested', t);
      audit(ctx.me.id, 'review.clarification_requested', 'survey_submission', s.id, {});
      queueNotification(subject.id, { kind: 'clarification', ref: s.id, subject: `${ctx.me.display_name} asked a question about your weekly report`, channels: ['in_app'] });
    });
    return { ok: true };
  };

  A['review.withdrawClarification'] = (ctx, { submissionId, text }) => {
    const { s } = reviewTarget(ctx, submissionId);
    if (reviewState(s.id).state !== 'clarification_requested') throw new HubError(409, 'state', 'No open question to withdraw.');
    tx(() => { addReviewEvent(s.id, ctx.me.id, 'clarification_withdrawn', String(text || 'Question withdrawn').slice(0, 500)); audit(ctx.me.id, 'review.clarification_withdrawn', 'survey_submission', s.id, {}); });
    return { ok: true };
  };

  A['review.note'] = (ctx, { submissionId, text }) => {
    const { s, subject } = reviewTarget(ctx, submissionId);
    const t = String(text || '').trim();
    if (!t || t.length > 2000) throw bad('Write your note (up to 2000 characters).');
    tx(() => {
      addReviewEvent(s.id, ctx.me.id, 'supervisor_note', t);
      audit(ctx.me.id, 'review.note', 'survey_submission', s.id, {});
      queueNotification(subject.id, { kind: 'review', ref: s.id, subject: `${ctx.me.display_name} replied about your weekly report`, channels: ['in_app'] });
    });
    return { ok: true };
  };

  A['review.respond'] = (ctx, { submissionId, text }) => {
    requireWorkTime();
    const s = db.get('SELECT * FROM survey_submissions WHERE id=?', [String(submissionId || '')]);
    if (!s || s.employee_id !== ctx.me.id) throw notFound();
    const t = String(text || '').trim();
    if (!t || t.length > 4000) throw bad('Write your response (up to 4000 characters).');
    tx(() => {
      addReviewEvent(s.id, ctx.me.id, 'employee_response', t);
      audit(ctx.me.id, 'review.employee_response', 'survey_submission', s.id, {});
      if (ctx.me.supervisor_id) queueNotification(ctx.me.supervisor_id, { kind: 'review', ref: s.id, subject: `${ctx.me.display_name} responded about a weekly report`, channels: ['in_app'] });
    });
    return { ok: true };
  };

  A['review.seen'] = (ctx, { submissionId }) => {
    const s = db.get('SELECT * FROM survey_submissions WHERE id=?', [String(submissionId || '')]);
    if (!s || s.employee_id !== ctx.me.id) throw notFound();
    const st = reviewState(s.id);
    if (!st.lastSignoff) throw new HubError(409, 'state', 'There is no supervisor review yet.');
    if (st.employeeSeen) return { ok: true, already: true };
    tx(() => { addReviewEvent(s.id, ctx.me.id, 'employee_seen', SEEN_STATEMENT.en); audit(ctx.me.id, 'review.seen', 'survey_submission', s.id, {}); });
    return { ok: true };
  };

  A['review.signoff'] = async (ctx, input) => {
    const { submissionId, comments, trainingNeeded, trainingNote, performanceConcern, performanceNote, closure } = input;
    const { s, subject } = reviewTarget(ctx, submissionId);
    const st = reviewState(s.id);
    if (st.state === 'clarification_requested') throw new HubError(409, 'pending', 'Wait for the employee\'s answer or withdraw the question before signing off.');
    if (st.state === 'signed_off') throw new HubError(409, 'already', 'Already signed off. It reopens only if the employee adds a correction.');
    if (!['no_action', 'action_assigned', 'referred'].includes(closure)) throw bad('Choose how this review is closed.', 'closure');
    const caCount = db.get("SELECT COUNT(*) n FROM corrective_actions WHERE source_type='survey' AND source_id=?", [s.id]).n;
    if (closure === 'action_assigned' && !caCount) throw bad('Create the corrective action first, then close as "Action assigned".', 'closure');
    const c = String(comments || '').trim();
    if (c.length > 4000) throw bad('Comments are too long.');
    await requireSignature(ctx, { ...input, signTicket: undefined }, 'review.signoff');   // PIN only
    const n = now(); const rid = id('REV');
    const lastAmend = db.get('SELECT id, payload_hash FROM survey_amendments WHERE submission_id=? ORDER BY signed_at DESC LIMIT 1', [s.id]);
    const payload = {
      recordType: 'supervisor-review', reviewId: rid,
      reviews: { submissionId: s.id, originalHash: s.payload_hash, latestAmendment: lastAmend ? { id: lastAmend.id, hash: lastAmend.payload_hash } : null },
      reviewer: { id: ctx.me.id, displayName: ctx.me.display_name }, employee: { id: subject.id, displayName: subject.display_name },
      comments: c, trainingNeeded: !!trainingNeeded, trainingNote: String(trainingNote || '').trim().slice(0, 1000),
      performanceConcern: !!performanceConcern, performanceNote: String(performanceNote || '').trim().slice(0, 1000),
      closure, correctiveActions: caCount, acknowledgment: SUPERVISOR_ACK.en,
      signature: { method: SIGN_METHOD, signerName: ctx.me.display_name, identity: identityRecord(ctx) },
      signedAtUtc: n.toISOString(), signedAtLocal: isoWithOffset(n, tz), demo: cfg.demo
    };
    const json = canonical(payload); const hash = crypto.sha256(json);
    tx(() => {
      db.run('INSERT INTO supervisor_reviews (id, submission_id, reviewer_id, closure, payload_json, payload_hash, signed_at) VALUES (?,?,?,?,?,?,?)', [rid, s.id, ctx.me.id, closure, json, hash, n.toISOString()]);
      addReviewEvent(s.id, ctx.me.id, 'signed_off', rid);
      audit(ctx.me.id, 'review.signed_off', 'survey_submission', s.id, { reviewId: rid, hash, closure });
      queueNotification(subject.id, { kind: 'review', ref: s.id, subject: 'Your supervisor reviewed your weekly report', channels: ['in_app'] });
    });
    return { reviewId: rid, hash };
  };

  // ---- supervisor queues
  function teamOf(ctx) {
    if (has(ctx, 'hr') || has(ctx, 'manager')) return db.all('SELECT * FROM employees ORDER BY display_name', []);
    if (has(ctx, 'supervisor')) return db.all('SELECT * FROM employees WHERE supervisor_id=? ORDER BY display_name', [ctx.me.id]);
    return [];
  }

  A['sup.queues'] = (ctx, { weekId }) => {
    if (!any(ctx, 'supervisor', 'hr')) throw deny();
    const week = weekFor(weekId);
    tx(() => { ensureAssignments(week); ensureAssignments(prevWeek(week)); });
    const team = db.all('SELECT * FROM employees ORDER BY display_name', []).filter(e => e.id !== ctx.me.id && supervisesOrHr(ctx, e));
    const ids = team.map(e => e.id);
    if (!ids.length) return { week, team: [], queues: {} };
    const ph = ids.map(() => '?').join(',');
    const since = addDays(week.start, -56);
    const subs = db.all(`SELECT s.*, a.week_id FROM survey_submissions s JOIN survey_assignments a ON a.id = s.assignment_id
                         WHERE s.employee_id IN (${ph}) AND a.week_id >= ? ORDER BY s.signed_at DESC`, [...ids, since]);
    const rows = subs.map(s => {
      const rs = reviewState(s.id);
      const p = JSON.parse(s.payload_json);
      const ans = Object.fromEntries(p.answers.map(x => [x.questionId, x.answer]));
      return {
        submissionId: s.id, employee: pub(emp(s.employee_id)), weekId: s.week_id, signedAt: s.signed_at, late: !!s.late,
        review: rs.state, needsSupervisor: rs.needsSupervisor, employeeSeen: rs.employeeSeen,
        safety: !!s.has_safety, injuryYes: ans.q4 === 'yes', obstacle: !!s.has_obstacle,
        safetyText: ans.s1 || null, obstacleText: ans.s2 || null, comments: ans.s3 || null,
        openActions: db.get("SELECT COUNT(*) n FROM corrective_actions WHERE source_type='survey' AND source_id=? AND status!='closed'", [s.id]).n
      };
    });
    const status = team.map(e => {
      const a = db.get('SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=?', [e.id, week.weekId]);
      return a ? { employee: pub(e), assignmentId: a.id, ...assignmentState(a, week) } : null;
    }).filter(Boolean);
    const prev = prevWeek(week);
    const prevMissing = team.map(e => {
      const a = db.get('SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=?', [e.id, prev.weekId]);
      return a ? { employee: pub(e), assignmentId: a.id, weekId: prev.weekId, ...assignmentState(a, prev) } : null;
    }).filter(r => r && r.state === 'missing');
    const unresolvedActions = db.all(`SELECT c.* FROM corrective_actions c JOIN survey_submissions s ON c.source_type='survey' AND c.source_id=s.id
                                      WHERE s.employee_id IN (${ph}) AND c.status != 'closed' ORDER BY c.due_date`, ids)
      .map(c => ({ id: c.id, title: c.title, status: c.status, dueDate: c.due_date, assignedTo: nameOf(c.assigned_to), overdue: c.due_date < ymdOf(now(), tz) }));
    const inWeek = (r) => r.weekId === week.weekId;
    return {
      week, team: team.map(pub),
      queues: {
        awaiting: rows.filter(r => ['awaiting_review', 'employee_responded', 'amended_after_signoff'].includes(r.review)),
        needsResponse: rows.filter(r => r.needsSupervisor && r.review !== 'awaiting_review'),
        waitingOnEmployee: rows.filter(r => r.review === 'clarification_requested'),
        missing: status.filter(r => r.state === 'missing' || r.state === 'open').concat(prevMissing),
        safety: rows.filter(r => r.safety && (inWeek(r) || r.review !== 'signed_off')),
        obstacles: rows.filter(r => r.obstacle && (inWeek(r) || r.review !== 'signed_off')),
        completed: rows.filter(r => r.review === 'signed_off' && inWeek(r)),
        unresolved: {
          reviews: rows.filter(r => r.weekId < week.weekId && r.review !== 'signed_off'),
          actions: unresolvedActions
        }
      },
      status
    };
  };

  // ---- safety
  function slaDue(priority, from) {
    const s = SLA[priority];
    return s.clock === 'wall' ? new Date(from.getTime() + s.minutes * 60000) : addWorkingMinutes(from, s.minutes, tz);
  }
  const defaultOwner = () => (activeWith('safety')[0] || activeWith('manager')[0] || activeWith('hr')[0] || {}).id || null;

  function notifyNewSafety(r, reporter) {
    const urgent = r.priority === 'urgent';
    const high = r.priority === 'high';
    const label = `${TYPE_LABEL[r.type]}${r.area ? ' · ' + r.area : ''}`;
    const recipients = new Set();
    if (r.owner_id) recipients.add(r.owner_id);
    if (urgent || high) activeWith('safety').forEach(e => recipients.add(e.id));
    // R1.2: urgent alerts go to the designated safety contacts and the reporter's manager.
    // Everyone else in management is reached by escalation or as a backup if delivery fails.
    if (urgent) { if (reporter.supervisor_id) recipients.add(reporter.supervisor_id); if (!activeWith('safety').length) activeWith('manager').forEach(e => recipients.add(e.id)); }
    recipients.delete(reporter.id);
    for (const rid of recipients) {
      const isOwner = rid === r.owner_id;
      queueNotification(rid, {
        kind: 'safety', ref: r.id, subject: `${urgent ? 'URGENT safety report' : 'Safety report'}: ${label}`,
        urgent, channels: urgent || (high && isOwner) ? ['sms', 'in_app'] : ['in_app'], hold: !(urgent || high)
      });
    }
  }

  function createSafetyReport(ctx, input, { source = 'direct', sourceRef = null } = {}) {
    const type = String(input.type || '');
    if (!TYPE_PRIORITY[type] || (type === 'injury_followup' && source !== 'survey')) throw bad('Choose what kind of concern this is.', 'type');
    const description = String(input.description || '').trim();
    if (!description || description.length > 4000) throw bad('Describe the concern (up to 4000 characters).', 'description');
    const area = input.area && AREAS.includes(input.area) ? input.area : null;
    const priority = TYPE_PRIORITY[type];
    const n = now();
    const due = slaDue(priority, n);
    const rid = id('SR');
    const owner = defaultOwner();
    db.run(`INSERT INTO safety_reports (id, reporter_id, confidential, type, priority, area, location, equipment, description, immediate_action,
            source, source_ref, owner_id, created_at, response_due_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new')`,
      [rid, ctx.me.id, input.confidential ? 1 : 0, type, priority, area, input.location ? String(input.location).slice(0, 200) : null,
        input.equipment ? String(input.equipment).slice(0, 120) : null, description, input.immediateAction ? String(input.immediateAction).slice(0, 1000) : null,
        source, sourceRef, owner, n.toISOString(), due.toISOString()]);
    db.run('INSERT INTO safety_events (id, report_id, actor_id, kind, detail_json, created_at) VALUES (?,?,?,?,?,?)',
      [id('SE'), rid, ctx.me.id, 'reported', canonical({ priority, owner, source }), n.toISOString()]);
    audit(ctx.me.id, 'safety.reported', 'safety_report', rid, { type, priority, source, confidential: !!input.confidential });
    const r = db.get('SELECT * FROM safety_reports WHERE id=?', [rid]);
    notifyNewSafety(r, ctx.me);
    return { reportId: rid, type, priority, owner: nameOf(owner), responseDueAt: due.toISOString(), responseDueLocal: isoWithOffset(due, tz) };
  }

  const canSafety = (ctx) => any(ctx, 'safety', 'manager', 'hr');
  const seesIdentity = (ctx) => any(ctx, 'safety', 'hr');
  function safetyEvent(reportId, actorId, kind, detail = {}) {
    db.run('INSERT INTO safety_events (id, report_id, actor_id, kind, detail_json, created_at) VALUES (?,?,?,?,?,?)', [id('SE'), reportId, actorId, kind, canonical(detail), nowIso()]);
  }

  function safetyView(ctx, r, { forReporter = false } = {}) {
    const staff = canSafety(ctx);
    if (!staff && !(forReporter && r.reporter_id === ctx.me.id)) return null;
    if (staff && r.type === 'injury_followup' && !seesIdentity(ctx) && r.reporter_id !== ctx.me.id) return null;
    const hideWho = r.confidential && !seesIdentity(ctx) && r.reporter_id !== ctx.me.id;
    const events = db.all('SELECT * FROM safety_events WHERE report_id=? ORDER BY created_at, rowid', [r.id]).map(e => ({ kind: e.kind, at: e.created_at, by: nameOf(e.actor_id), detail: JSON.parse(e.detail_json) }));
    const atts = db.all("SELECT id, filename, mime, size, sha256, created_at, uploaded_by FROM attachments WHERE entity_type='safety_report' AND entity_id=? ORDER BY created_at", [r.id])
      .map(x => ({ id: x.id, filename: x.filename, mime: x.mime, size: x.size, sha256: x.sha256, at: x.created_at, by: nameOf(x.uploaded_by) }));
    const delivery = deliveryFor(r.id);
    return {
      id: r.id, type: r.type, typeLabel: TYPE_LABEL[r.type], priority: r.priority, area: r.area, location: r.location, equipment: r.equipment,
      description: r.description, immediateAction: r.immediate_action, source: r.source, sourceRef: seesIdentity(ctx) ? r.source_ref : null,
      reporter: hideWho ? { name: 'Confidential reporter' } : pub(emp(r.reporter_id)), confidential: !!r.confidential,
      owner: r.owner_id ? { id: r.owner_id, name: nameOf(r.owner_id) } : null,
      createdAt: r.created_at, responseDueAt: r.response_due_at, status: r.status, acknowledgedAt: r.acknowledged_at, acknowledgedBy: nameOf(r.acknowledged_by),
      resolution: r.resolution, resolutionBy: nameOf(r.resolution_by), resolutionById: r.resolution_by, verifiedBy: nameOf(r.verified_by), closedAt: r.closed_at,
      overdue: r.status === 'new' && nowIso() > r.response_due_at, escalationLevel: r.escalation_level,
      events, attachments: atts,
      actions: db.all("SELECT id, title, status, due_date dueDate, assigned_to FROM corrective_actions WHERE source_type='safety_report' AND source_id=?", [r.id]).map(c => ({ ...c, assignedTo: nameOf(c.assigned_to) })),
      delivery: staff ? delivery : delivery.map(d => ({ recipient: d.recipient, channel: d.channel, status: d.status, deliveredAt: d.deliveredAt, seenAt: d.seenAt, backup: d.backup })),
      deliverySummary: summarizeDelivery(delivery, r)
    };
  }

  function summarizeDelivery(list, r) {
    const seen = list.filter(d => d.seenAt).map(d => d.recipient);
    const delivered = list.filter(d => d.status === 'delivered' && d.channel !== 'in_app').map(d => d.recipient);
    const failed = list.filter(d => d.status === 'failed');
    const pending = list.filter(d => d.status === 'queued' || d.status === 'sent');
    let state = 'in_app_only';
    if (r.acknowledged_at) state = 'acknowledged';
    else if (seen.length) state = 'seen';
    else if (delivered.length) state = 'delivered';
    else if (pending.length) state = 'sending';
    if (failed.length && !r.acknowledged_at && !delivered.length && !seen.length) state = 'failed';
    return { state, seenBy: [...new Set(seen)], deliveredTo: [...new Set(delivered)], failedCount: failed.length, pendingCount: pending.length };
  }

  A['safety.report'] = (ctx, input) => {
    const r = tx(() => createSafetyReport(ctx, input || {}));
    if (r.priority === 'urgent' || r.priority === 'high') dispatchDue();
    const view = safetyView(ctx, db.get('SELECT * FROM safety_reports WHERE id=?', [r.reportId]), { forReporter: true });
    return { ...r, guidance: r.type === 'imminent' ? 'STOP_AND_TELL' : (r.priority === 'urgent' ? 'TELL_NOW' : 'RECEIVED'), deliverySummary: view.deliverySummary, delivery: view.delivery };
  };

  A['safety.mine'] = (ctx) => db.all('SELECT * FROM safety_reports WHERE reporter_id=? ORDER BY created_at DESC', [ctx.me.id]).map(r => safetyView(ctx, r, { forReporter: true }));

  A['safety.detail'] = (ctx, { reportId }) => {
    const r = db.get('SELECT * FROM safety_reports WHERE id=?', [String(reportId || '')]);
    const v = r && safetyView(ctx, r, { forReporter: true });
    if (!v) throw notFound();
    if (canSafety(ctx)) tx(() => markSeen(ctx.me.id, r.id));
    return v;
  };

  A['safety.queue'] = (ctx, { status, priority, area, ownerId } = {}) => {
    if (!canSafety(ctx)) throw deny();
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
    const hot = (v) => (v.status === 'new' && v.priority === 'urgent') ? 1 : 0;
    return db.all('SELECT * FROM safety_reports ORDER BY created_at DESC', []).map(r => safetyView(ctx, r)).filter(Boolean)
      .filter(v => !status || (status === 'open' ? v.status !== 'closed' : v.status === status))
      .filter(v => !priority || v.priority === priority)
      .filter(v => !area || v.area === area)
      .filter(v => !ownerId || (v.owner && v.owner.id === ownerId))
      .sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || hot(b) - hot(a) || (b.overdue - a.overdue)
        || rank[a.priority] - rank[b.priority] || (a.createdAt < b.createdAt ? 1 : -1));
  };

  function staffReport(ctx, reportId) {
    if (!canSafety(ctx)) throw deny();
    const r = db.get('SELECT * FROM safety_reports WHERE id=?', [String(reportId || '')]);
    if (!r || !safetyView(ctx, r)) throw notFound();
    return r;
  }

  A['safety.acknowledge'] = (ctx, { reportId, note }) => {
    const r = staffReport(ctx, reportId);
    if (r.status !== 'new') throw new HubError(409, 'state', 'Already acknowledged.');
    tx(() => {
      db.run("UPDATE safety_reports SET status='acknowledged', acknowledged_at=?, acknowledged_by=? WHERE id=?", [nowIso(), ctx.me.id, r.id]);
      safetyEvent(r.id, ctx.me.id, 'acknowledged', { note: note ? String(note).slice(0, 1000) : null, late: nowIso() > r.response_due_at });
      markSeen(ctx.me.id, r.id);
      audit(ctx.me.id, 'safety.acknowledged', 'safety_report', r.id, { late: nowIso() > r.response_due_at });
      queueNotification(r.reporter_id, { kind: 'safety_status', ref: r.id, subject: `${ctx.me.display_name} received your safety report`, channels: ['in_app'], hold: false });
    });
    return { ok: true };
  };

  A['safety.classify'] = (ctx, { reportId, priority, area, equipment, location }) => {
    const r = staffReport(ctx, reportId);
    if (r.status === 'closed') throw new HubError(409, 'closed', 'Reopen it first.');
    if (priority && !SLA[priority]) throw bad('Bad priority');
    if (area && !AREAS.includes(area)) throw bad('Bad area');
    const next = { priority: priority || r.priority, area: area ?? r.area, equipment: equipment !== undefined ? String(equipment).slice(0, 120) : r.equipment, location: location !== undefined ? String(location).slice(0, 200) : r.location };
    const due = next.priority !== r.priority ? slaDue(next.priority, new Date(r.created_at)).toISOString() : r.response_due_at;
    tx(() => {
      db.run('UPDATE safety_reports SET priority=?, area=?, equipment=?, location=?, response_due_at=? WHERE id=?', [next.priority, next.area, next.equipment, next.location, due, r.id]);
      safetyEvent(r.id, ctx.me.id, 'classified', { from: { priority: r.priority, area: r.area, equipment: r.equipment }, to: next });
      audit(ctx.me.id, 'safety.classified', 'safety_report', r.id, { from: r.priority, to: next.priority });
    });
    return { ok: true };
  };

  A['safety.assign'] = (ctx, { reportId, ownerId }) => {
    const r = staffReport(ctx, reportId);
    const o = emp(ownerId);
    if (!o || o.status !== 'active' || !rolesOf(o).some(x => ['safety', 'manager', 'supervisor', 'hr'].includes(x))) throw bad('Choose an active manager, supervisor or safety lead.');
    if (r.confidential && !rolesOf(o).some(x => ['safety', 'hr'].includes(x))) throw bad('Confidential reports can only be owned by the safety lead or HR.');
    tx(() => {
      db.run('UPDATE safety_reports SET owner_id=? WHERE id=?', [o.id, r.id]);
      safetyEvent(r.id, ctx.me.id, 'assigned', { from: r.owner_id, to: o.id });
      audit(ctx.me.id, 'safety.assigned', 'safety_report', r.id, { to: o.id });
      if (o.id !== ctx.me.id) queueNotification(o.id, { kind: 'safety', ref: r.id, subject: `You now own a safety report: ${TYPE_LABEL[r.type]}`, urgent: r.priority === 'urgent', channels: r.priority === 'urgent' ? ['sms', 'in_app'] : ['in_app'] });
    });
    return { ok: true };
  };

  A['safety.note'] = (ctx, { reportId, note }) => {
    const r = staffReport(ctx, reportId);
    const t = String(note || '').trim(); if (!t) throw bad('Write a note.');
    tx(() => {
      if (r.status === 'acknowledged') db.run("UPDATE safety_reports SET status='in_progress' WHERE id=?", [r.id]);
      safetyEvent(r.id, ctx.me.id, 'note', { note: t.slice(0, 2000) });
      audit(ctx.me.id, 'safety.note', 'safety_report', r.id, {});
    });
    return { ok: true };
  };

  A['safety.proposeResolution'] = (ctx, { reportId, resolution }) => {
    const r = staffReport(ctx, reportId);
    if (['new', 'closed', 'pending_verification'].includes(r.status)) throw new HubError(409, 'state', r.status === 'new' ? 'Acknowledge it first.' : 'Not possible in this state.');
    const t = String(resolution || '').trim(); if (!t) throw bad('Describe what was done.');
    const open = db.get("SELECT COUNT(*) n FROM corrective_actions WHERE source_type='safety_report' AND source_id=? AND status!='closed'", [r.id]).n;
    if (open) throw new HubError(409, 'open_actions', 'Close the corrective actions first.');
    tx(() => {
      db.run("UPDATE safety_reports SET status='pending_verification', resolution=?, resolution_by=?, resolution_at=? WHERE id=?", [t.slice(0, 2000), ctx.me.id, nowIso(), r.id]);
      safetyEvent(r.id, ctx.me.id, 'resolution_proposed', { resolution: t.slice(0, 2000) });
      audit(ctx.me.id, 'safety.resolution_proposed', 'safety_report', r.id, {});
    });
    return { ok: true };
  };

  A['safety.verify'] = (ctx, { reportId, decision, note }) => {
    const r = staffReport(ctx, reportId);
    if (r.status !== 'pending_verification') throw new HubError(409, 'state', 'Nothing waiting for verification.');
    if (r.resolution_by === ctx.me.id) throw deny('Someone other than the person who resolved it must verify.');
    if (!['close', 'reopen'].includes(decision)) throw bad('Choose close or reopen.');
    tx(() => {
      if (decision === 'close') db.run("UPDATE safety_reports SET status='closed', verified_by=?, closed_at=? WHERE id=?", [ctx.me.id, nowIso(), r.id]);
      else db.run("UPDATE safety_reports SET status='in_progress', resolution=NULL, resolution_by=NULL, resolution_at=NULL WHERE id=?", [r.id]);
      safetyEvent(r.id, ctx.me.id, decision === 'close' ? 'verified_closed' : 'reopened', { note: note ? String(note).slice(0, 1000) : null });
      audit(ctx.me.id, 'safety.' + (decision === 'close' ? 'closed' : 'reopened'), 'safety_report', r.id, {});
      if (decision === 'close') queueNotification(r.reporter_id, { kind: 'safety_status', ref: r.id, subject: 'Your safety report was resolved', channels: ['in_app'] });
    });
    return { ok: true };
  };

  // ---- attachments (evidence)
  A['attachment.add'] = (ctx, { entityType, entityId, filename, mime, dataBase64 }) => {
    if (!['safety_report', 'corrective_action'].includes(entityType)) throw bad('Bad target');
    if (!ATTACH_TYPES[mime]) throw bad('Photos (JPEG, PNG, WebP) or PDF only.');
    const b64 = String(dataBase64 || '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw bad('Bad file data');
    const size = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (size > MAX_ATTACHMENT_BYTES) throw bad('File is too large (1.5 MB max). Photos are resized automatically in the app.');
    if (entityType === 'safety_report') {
      const r = db.get('SELECT * FROM safety_reports WHERE id=?', [String(entityId || '')]);
      if (!r) throw notFound();
      const ok = (r.reporter_id === ctx.me.id && r.status !== 'closed') || (canSafety(ctx) && safetyView(ctx, r));
      if (!ok) throw notFound();
    } else {
      const c = db.get('SELECT * FROM corrective_actions WHERE id=?', [String(entityId || '')]);
      if (!c || !(canSafety(ctx) || c.assigned_to === ctx.me.id)) throw notFound();
    }
    const aid = id('ATT');
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const hash = crypto.sha256Bytes(bytes);
    tx(() => {
      db.run('INSERT INTO attachments (id, entity_type, entity_id, uploaded_by, filename, mime, size, sha256, data_b64, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [aid, entityType, entityId, ctx.me.id, String(filename || 'evidence').replace(/[^\w. -]/g, '_').slice(0, 80), mime, size, hash, b64, nowIso()]);
      if (entityType === 'safety_report') safetyEvent(entityId, ctx.me.id, 'evidence_added', { attachmentId: aid, sha256: hash });
      else db.run('INSERT INTO ca_events (id, ca_id, actor_id, kind, detail_json, created_at) VALUES (?,?,?,?,?,?)', [id('CE'), entityId, ctx.me.id, 'evidence_added', canonical({ attachmentId: aid, sha256: hash }), nowIso()]);
      audit(ctx.me.id, 'attachment.added', entityType, entityId, { attachmentId: aid, sha256: hash, size });
    });
    return { attachmentId: aid, sha256: hash, size };
  };

  A['attachment.get'] = (ctx, { attachmentId }) => {
    const x = db.get('SELECT * FROM attachments WHERE id=?', [String(attachmentId || '')]);
    if (!x) throw notFound();
    if (x.entity_type === 'safety_report') {
      const r = db.get('SELECT * FROM safety_reports WHERE id=?', [x.entity_id]);
      if (!r || !safetyView(ctx, r, { forReporter: true })) throw notFound();
    } else {
      const c = db.get('SELECT * FROM corrective_actions WHERE id=?', [x.entity_id]);
      if (!c || !(canSafety(ctx) || c.assigned_to === ctx.me.id)) throw notFound();
    }
    return { filename: x.filename, mime: x.mime, dataBase64: x.data_b64, sha256: x.sha256 };
  };

  // ---- corrective actions
  function caView(c) {
    const today = ymdOf(now(), tz);
    return {
      id: c.id, sourceType: c.source_type, sourceId: c.source_id, category: c.category, title: c.title, description: c.description,
      priority: c.priority, assignedTo: pub(emp(c.assigned_to)), dueDate: c.due_date, status: c.status,
      resolution: c.resolution, closureEvidence: c.closure_evidence, doneBy: nameOf(c.done_by), doneById: c.done_by, doneAt: c.done_at,
      verifiedBy: nameOf(c.verified_by), closedAt: c.closed_at, createdBy: nameOf(c.created_by),
      overdue: c.status !== 'closed' && c.due_date < today,
      events: db.all('SELECT kind, actor_id, detail_json, created_at FROM ca_events WHERE ca_id=? ORDER BY created_at, rowid', [c.id]).map(e => ({ kind: e.kind, by: nameOf(e.actor_id), at: e.created_at, detail: JSON.parse(e.detail_json) })),
      attachments: db.all("SELECT id, filename, mime, size, sha256, created_at FROM attachments WHERE entity_type='corrective_action' AND entity_id=?", [c.id])
    };
  }
  function caEvent(caId, actorId, kind, detail = {}) {
    db.run('INSERT INTO ca_events (id, ca_id, actor_id, kind, detail_json, created_at) VALUES (?,?,?,?,?,?)', [id('CE'), caId, actorId, kind, canonical(detail), nowIso()]);
  }

  A['ca.list'] = (ctx, { status } = {}) => {
    let rows;
    if (canSafety(ctx)) rows = db.all('SELECT * FROM corrective_actions ORDER BY status=\'closed\', due_date', []);
    else if (has(ctx, 'supervisor')) {
      rows = db.all(`SELECT c.* FROM corrective_actions c WHERE c.assigned_to=? OR c.created_by=?
                     OR (c.source_type='survey' AND c.source_id IN (SELECT s.id FROM survey_submissions s JOIN employees e ON e.id=s.employee_id WHERE e.supervisor_id=?))
                     ORDER BY c.status='closed', c.due_date`, [ctx.me.id, ctx.me.id, ctx.me.id]);
    } else rows = db.all('SELECT * FROM corrective_actions WHERE assigned_to=? ORDER BY status=\'closed\', due_date', [ctx.me.id]);
    return rows.map(caView).filter(c => !status || (status === 'open' ? c.status !== 'closed' : c.status === status));
  };

  A['ca.create'] = (ctx, { sourceType, sourceId, category, title, description, priority, assignedTo, dueDate }) => {
    if (!canSafety(ctx) && !has(ctx, 'supervisor')) throw deny();
    if (!['safety_report', 'survey', 'manual'].includes(sourceType)) throw bad('Bad source');
    if (!['safety', 'operational'].includes(category)) throw bad('Category must be safety or operational. Employee-relations matters go to HR, not here.');
    if (!['urgent', 'high', 'normal', 'low'].includes(priority)) throw bad('Bad priority');
    const t = String(title || '').trim(); if (!t || t.length > 200) throw bad('Title required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ''))) throw bad('Due date required');
    const assignee = emp(String(assignedTo || ''));
    if (!assignee || assignee.status !== 'active') throw bad('Assign it to an active employee.');
    if (sourceType === 'safety_report') staffReport(ctx, sourceId);
    if (sourceType === 'survey') {
      const s = db.get('SELECT employee_id FROM survey_submissions WHERE id=?', [String(sourceId || '')]);
      if (!s || !canViewAnswers(ctx, s.employee_id) || s.employee_id === ctx.me.id) throw notFound();
    }
    if (sourceType === 'manual' && !canSafety(ctx)) throw deny('Supervisors create actions from a team member\'s report.');
    const cid = id('CA');
    tx(() => {
      db.run(`INSERT INTO corrective_actions (id, source_type, source_id, category, title, description, priority, assigned_to, due_date, status, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?, 'open', ?, ?)`, [cid, sourceType, sourceId || null, category, t, String(description || '').slice(0, 4000), priority, assignee.id, dueDate, ctx.me.id, nowIso()]);
      caEvent(cid, ctx.me.id, 'created', { assignedTo: assignee.id, dueDate });
      if (sourceType === 'safety_report') {
        const r = db.get('SELECT status FROM safety_reports WHERE id=?', [sourceId]);
        if (r.status === 'acknowledged') db.run("UPDATE safety_reports SET status='in_progress' WHERE id=?", [sourceId]);
        safetyEvent(sourceId, ctx.me.id, 'action_created', { caId: cid, title: t });
      }
      audit(ctx.me.id, 'ca.created', 'corrective_action', cid, { sourceType, sourceId, assignedTo: assignee.id });
      queueNotification(assignee.id, { kind: 'action', ref: cid, subject: `Corrective action assigned to you: ${t}`, channels: ['in_app'] });
    });
    return { id: cid };
  };

  const caFor = (ctx, caId) => {
    const c = db.get('SELECT * FROM corrective_actions WHERE id=?', [String(caId || '')]);
    if (!c || !(canSafety(ctx) || c.assigned_to === ctx.me.id || c.created_by === ctx.me.id)) throw notFound();
    return c;
  };

  A['ca.start'] = (ctx, { id: caId, note }) => {
    const c = caFor(ctx, caId);
    if (c.status !== 'open') throw new HubError(409, 'state', 'Already started.');
    tx(() => { db.run("UPDATE corrective_actions SET status='in_progress' WHERE id=?", [c.id]); caEvent(c.id, ctx.me.id, 'started', { note: note || null }); audit(ctx.me.id, 'ca.started', 'corrective_action', c.id, {}); });
    return { ok: true };
  };

  A['ca.markDone'] = (ctx, { id: caId, resolution, closureEvidence }) => {
    const c = caFor(ctx, caId);
    if (!['open', 'in_progress'].includes(c.status)) throw new HubError(409, 'state', 'Not possible in this state.');
    const res = String(resolution || '').trim(), ev = String(closureEvidence || '').trim();
    const hasAttachment = db.get("SELECT 1 FROM attachments WHERE entity_type='corrective_action' AND entity_id=?", [c.id]);
    if (!res || (!ev && !hasAttachment)) throw bad('Describe what was done and add evidence (a note or a photo).');
    tx(() => {
      db.run("UPDATE corrective_actions SET status='pending_verification', resolution=?, closure_evidence=?, done_by=?, done_at=? WHERE id=?", [res.slice(0, 4000), ev.slice(0, 4000), ctx.me.id, nowIso(), c.id]);
      caEvent(c.id, ctx.me.id, 'marked_done', { resolution: res.slice(0, 4000) });
      audit(ctx.me.id, 'ca.marked_done', 'corrective_action', c.id, {});
      const verifiers = new Set([c.created_by, ...activeWith('safety').map(e => e.id)]); verifiers.delete(ctx.me.id);
      for (const v of verifiers) queueNotification(v, { kind: 'action', ref: c.id, subject: `Ready to verify: ${c.title}`, channels: ['in_app'] });
    });
    return { ok: true };
  };

  A['ca.verify'] = (ctx, { id: caId, decision, note }) => {
    const c = db.get('SELECT * FROM corrective_actions WHERE id=?', [String(caId || '')]);
    if (!c) throw notFound();
    const involved = c.done_by === ctx.me.id || c.assigned_to === ctx.me.id;
    if (!(canSafety(ctx) || c.created_by === ctx.me.id || involved)) throw notFound();
    if (involved) throw deny('Someone other than the person who did the work must verify.');
    if (c.status !== 'pending_verification') throw new HubError(409, 'state', 'Nothing waiting for verification.');
    if (!['close', 'reopen'].includes(decision)) throw bad('Choose close or reopen.');
    tx(() => {
      if (decision === 'close') db.run("UPDATE corrective_actions SET status='closed', verified_by=?, closed_at=? WHERE id=?", [ctx.me.id, nowIso(), c.id]);
      else db.run("UPDATE corrective_actions SET status='in_progress' WHERE id=?", [c.id]);
      caEvent(c.id, ctx.me.id, decision === 'close' ? 'verified_closed' : 'reopened', { note: note || null });
      audit(ctx.me.id, 'ca.' + (decision === 'close' ? 'closed' : 'reopened'), 'corrective_action', c.id, {});
    });
    return { ok: true };
  };

  // ---- alerts (in-app notifications)
  A['alerts.mine'] = (ctx) => db.all("SELECT id, kind, ref, urgent, subject, created_at, seen_at FROM notifications WHERE recipient_id=? AND channel='in_app' ORDER BY created_at DESC LIMIT 40", [ctx.me.id]);
  A['alerts.seen'] = (ctx, { ids }) => {
    const list = Array.isArray(ids) ? ids.slice(0, 100).map(String) : [];
    tx(() => { for (const nid of list) db.run("UPDATE notifications SET seen_at=? WHERE id=? AND recipient_id=? AND seen_at IS NULL", [nowIso(), nid, ctx.me.id]); });
    return { ok: true };
  };
  A['notifications.log'] = (ctx, { failedOnly } = {}) => {
    if (!any(ctx, 'manager', 'hr', 'safety')) throw deny();
    const rows = db.all(`SELECT * FROM notifications WHERE channel != 'in_app' ${failedOnly ? "AND status='failed'" : ''} ORDER BY created_at DESC LIMIT 80`, []);
    return rows.map(n => ({ ...n, recipient: nameOf(n.recipient_id), attemptLog: db.all('SELECT at, ok, detail FROM notification_attempts WHERE notification_id=? ORDER BY id', [n.id]) }));
  };

  // ---- management
  A['mgmt.excuse'] = (ctx, { assignmentId, reason }) => {
    const a = db.get('SELECT * FROM survey_assignments WHERE id=?', [String(assignmentId || '')]);
    if (!a) throw notFound();
    if (!(supervisesOrHr(ctx, emp(a.employee_id)) || has(ctx, 'manager'))) throw notFound();
    if (db.get('SELECT 1 FROM survey_submissions WHERE assignment_id=?', [a.id])) throw new HubError(409, 'signed', 'Already signed.');
    const r = String(reason || '').trim(); if (!r) throw bad('Reason required');
    tx(() => { db.run("UPDATE survey_assignments SET status='excused', expected=0, excuse_reason=? WHERE id=?", ['Excused: ' + r.slice(0, 180), a.id]); audit(ctx.me.id, 'survey.excused', 'survey_assignment', a.id, { reason: r.slice(0, 200) }); });
    return { ok: true };
  };

  A['mgmt.paperEvent'] = (ctx, { assignmentId, event, note }) => {
    const a = db.get('SELECT * FROM survey_assignments WHERE id=?', [String(assignmentId || '')]);
    if (!a || !supervisesOrHr(ctx, emp(a.employee_id))) throw notFound();
    if (!['paper_requested', 'paper_received', 'declined_to_sign'].includes(event)) throw bad('Bad event');
    if (db.get('SELECT 1 FROM survey_submissions WHERE assignment_id=?', [a.id])) throw new HubError(409, 'signed', 'Already signed electronically.');
    tx(() => {
      db.run('INSERT INTO paper_events (id, assignment_id, recorded_by, event, note, created_at) VALUES (?,?,?,?,?,?)', [id('PE'), a.id, ctx.me.id, event, String(note || '').slice(0, 1000), nowIso()]);
      if (event === 'paper_received') db.run("UPDATE survey_assignments SET status='paper' WHERE id=?", [a.id]);
      audit(ctx.me.id, 'survey.' + event, 'survey_assignment', a.id, {});
    });
    return { ok: true };
  };

  A['employees.list'] = (ctx) => {
    if (!any(ctx, 'supervisor', 'manager', 'safety', 'hr')) throw deny();
    return db.all("SELECT * FROM employees WHERE status='active' ORDER BY display_name", []).map(e => ({
      ...pub(e), roles: rolesOf(e), supervisorId: e.supervisor_id,
      ...(any(ctx, 'hr') || e.supervisor_id === ctx.me.id ? { pinSet: !!e.pin_hash, locked: !!e.hard_locked || (e.locked_until && e.locked_until > nowIso()) } : {})
    }));
  };

  A['hr.setStatus'] = (ctx, { employeeId, status, endDate }) => {
    if (!has(ctx, 'hr')) throw deny();
    const e = emp(employeeId); if (!e) throw notFound();
    if (e.id === ctx.me.id) throw deny('You cannot change your own status.');
    if (!['active', 'terminated'].includes(status)) throw bad('Bad status');
    const end = status === 'terminated' ? (endDate || ymdOf(now(), tz)) : null;
    let revoked = 0;
    tx(() => {
      db.run('UPDATE employees SET status=?, end_date=?, setup_code_hash=NULL WHERE id=?', [status, end, e.id]);
      if (status === 'terminated') {
        revoked = db.get('SELECT COUNT(*) n FROM sessions WHERE employee_id=? AND revoked_at IS NULL', [e.id]).n;
        db.run("UPDATE sessions SET revoked_at=?, revoke_reason='separated' WHERE employee_id=? AND revoked_at IS NULL", [nowIso(), e.id]);
        db.run("UPDATE notifications SET status='cancelled' WHERE recipient_id=? AND status IN ('queued','sent')", [e.id]);
        dropPasskeys(e.id, ctx.me.id, 'deactivated');
        db.run("UPDATE push_subscriptions SET removed_at=?, remove_reason='deactivated' WHERE employee_id=? AND removed_at IS NULL", [nowIso(), e.id]);
      }
      audit(ctx.me.id, 'employee.status', 'employee', e.id, { status, endDate: end, sessionsRevoked: revoked });
    });
    return { ok: true, sessionsRevoked: revoked };
  };

  A['hr.addAbsence'] = (ctx, { employeeId, startDate, endDate, reason }) => {
    const e = emp(employeeId); if (!e) throw notFound();
    if (!(has(ctx, 'hr') || (has(ctx, 'supervisor') && e.supervisor_id === ctx.me.id))) throw deny();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate)) || endDate < startDate) throw bad('Enter valid dates.');
    if (!['leave', 'vacation', 'other'].includes(reason)) throw bad('Reason must be leave, vacation or other. Do not record medical reasons here.');
    tx(() => {
      db.run('INSERT INTO absences (id, employee_id, start_date, end_date, reason, recorded_by, created_at) VALUES (?,?,?,?,?,?,?)', [id('ABS'), e.id, startDate, endDate, reason, ctx.me.id, nowIso()]);
      audit(ctx.me.id, 'absence.added', 'employee', e.id, { startDate, endDate, reason });
      // Re-evaluate weeks that have already opened; future weeks are evaluated when they open.
      const cur = weekFor().weekId;
      for (let wk = weekFor(startDate); wk.weekId <= weekFor(endDate).weekId && wk.weekId <= cur; wk = weekFor(addDays(wk.weekId, 7))) ensureAssignments(wk);
    });
    return { ok: true };
  };

  // ---- dashboard
  A['mgmt.dashboard'] = (ctx, { view = 'week', weekId, month, supervisorId, employeeId } = {}) => {
    if (!any(ctx, 'supervisor', 'manager', 'safety', 'hr')) throw deny();
    const scope = any(ctx, 'manager', 'hr') ? 'all' : (has(ctx, 'supervisor') ? 'team' : 'safety-only');
    const cur = reportingWeek(now(), tz);
    const focus = weekId ? weekFor(weekId) : (nowIso() >= cur.opensAt ? cur : prevWeek(cur));
    let people = scope === 'safety-only' ? [] : teamOf(ctx).filter(e => e.id !== ctx.me.id || scope === 'all');
    if (supervisorId && scope === 'all') people = people.filter(e => e.supervisor_id === supervisorId);
    if (employeeId) people = people.filter(e => e.id === employeeId);
    const supervisors = scope === 'all' ? db.all('SELECT * FROM employees', []).filter(e => rolesOf(e).includes('supervisor')).map(pub) : [];

    const weekRows = (w) => {
      tx(() => ensureAssignments(w));
      return people.map(e => {
        const a = db.get('SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=?', [e.id, w.weekId]);
        if (!a) return null;
        const st = assignmentState(a, w);
        const rs = st.submissionId ? reviewState(st.submissionId) : null;
        const sub = st.submissionId ? db.get('SELECT has_safety, has_obstacle FROM survey_submissions WHERE id=?', [st.submissionId]) : null;
        return { employee: pub(e), supervisor: nameOf(e.supervisor_id), assignmentId: a.id, ...st, review: rs && rs.state,
          canOpen: !!st.submissionId && canViewAnswers(ctx, e.id), safety: !!(sub && sub.has_safety), obstacle: !!(sub && sub.has_obstacle) };
      }).filter(Boolean);
    };
    const tally = (rows) => ({
      expected: rows.filter(r => r.state !== 'excused').length,
      onTime: rows.filter(r => r.state === 'submitted').length,
      late: rows.filter(r => r.state === 'submitted_late').length,
      paper: rows.filter(r => r.state === 'paper').length,
      missing: rows.filter(r => r.state === 'missing').length,
      notYet: rows.filter(r => r.state === 'open').length,
      excused: rows.filter(r => r.state === 'excused').length,
      awaitingReview: rows.filter(r => ['awaiting_review', 'employee_responded', 'amended_after_signoff'].includes(r.review)).length,
      waitingOnEmployee: rows.filter(r => r.review === 'clarification_requested').length,
      signedOff: rows.filter(r => r.review === 'signed_off').length
    });
    const rate = (t) => t.expected ? Math.round(100 * (t.onTime + t.late + t.paper) / t.expected) : null;

    let weeks;
    if (view === 'month') {
      const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : focus.start.slice(0, 7);
      weeks = []; let w = weekFor(m + '-01');
      if (w.start.slice(0, 7) < m) w = weekFor(addDays(w.start, 7));
      while (w.start.slice(0, 7) === m) { weeks.push(w); w = weekFor(addDays(w.start, 7)); }
    } else if (view === 'history') {
      weeks = []; for (let i = 11; i >= 0; i--) weeks.push(weekFor(addDays(focus.start, -7 * i)));
    } else weeks = [focus];
    const perWeek = scope === 'safety-only' ? [] : weeks.map(w => { const rows = weekRows(w); const t = tally(rows); return { week: w, ...t, rate: rate(t), rows: view === 'week' ? rows : undefined }; });

    // Supervisor review reliability over the selected period
    const periodStart = weeks[0].startsAt, periodEnd = weeks.at(-1).endsAt;
    const reliability = scope === 'safety-only' ? [] : (() => {
      const ids = people.map(e => e.id); if (!ids.length) return [];
      const subs = db.all(`SELECT s.id, s.signed_at, e.supervisor_id FROM survey_submissions s JOIN employees e ON e.id=s.employee_id
                           WHERE s.employee_id IN (${ids.map(() => '?').join(',')}) AND s.signed_at >= ? AND s.signed_at < ?`, [...ids, periodStart, periodEnd]);
      const bySup = {};
      for (const s of subs) {
        const k = s.supervisor_id || 'none';
        const first = db.get('SELECT signed_at FROM supervisor_reviews WHERE submission_id=? ORDER BY signed_at LIMIT 1', [s.id]);
        const b = bySup[k] || (bySup[k] = { supervisor: nameOf(s.supervisor_id) || 'No supervisor', submitted: 0, signedOff: 0, onTarget: 0, hours: [] });
        b.submitted++;
        if (first) {
          b.signedOff++;
          const wm = workingMinutesBetween(new Date(s.signed_at), new Date(first.signed_at), tz);
          b.hours.push(wm / 60);
          if (wm <= cfg.reviewTargetWorkingDays * 510) b.onTarget++;
        }
      }
      return Object.values(bySup).map(b => {
        const h = b.hours.sort((x, y) => x - y);
        return { supervisor: b.supervisor, submitted: b.submitted, signedOff: b.signedOff, onTargetPct: b.submitted ? Math.round(100 * b.onTarget / b.submitted) : null,
          medianWorkingHours: h.length ? Math.round(10 * h[Math.floor((h.length - 1) / 2)]) / 10 : null };
      });
    })();

    // Safety & actions (safety, manager, HR see all; supervisors see their team's)
    let reports = [];
    if (canSafety(ctx)) reports = db.all('SELECT * FROM safety_reports', []).map(r => safetyView(ctx, r)).filter(Boolean);
    else if (has(ctx, 'supervisor')) reports = db.all('SELECT r.* FROM safety_reports r JOIN employees e ON e.id = r.reporter_id WHERE e.supervisor_id=? AND r.confidential=0 AND r.type != \'injury_followup\'', [ctx.me.id])
      .map(r => ({ id: r.id, type: r.type, typeLabel: TYPE_LABEL[r.type], priority: r.priority, area: r.area, equipment: r.equipment, status: r.status, createdAt: r.created_at, overdue: r.status === 'new' && nowIso() > r.response_due_at }));
    const inPeriod = reports.filter(r => r.createdAt >= periodStart && r.createdAt < periodEnd);
    const cas = A['ca.list'](ctx, {});
    const count = (arr, key) => Object.entries(arr.reduce((m, x) => { const k = (x[key] || '').trim(); if (k) { const kk = k.toLowerCase(); m[kk] = m[kk] || { label: k, n: 0 }; m[kk].n++; } return m; }, {}))
      .map(([, v]) => v).sort((a, b) => b.n - a.n).slice(0, 6);
    const trendSince = new Date(new Date(focus.endsAt).getTime() - 8 * 7 * 86400000).toISOString();
    const recent = reports.filter(r => r.createdAt >= trendSince);
    const obstacles = scope === 'safety-only' ? [] : (() => {
      const ids = people.filter(e => canViewAnswers(ctx, e.id)).map(e => e.id); if (!ids.length) return [];
      return db.all(`SELECT s.id, s.employee_id, s.payload_json, a.week_id FROM survey_submissions s JOIN survey_assignments a ON a.id=s.assignment_id
                     WHERE s.has_obstacle=1 AND s.employee_id IN (${ids.map(() => '?').join(',')}) AND s.signed_at >= ? ORDER BY s.signed_at DESC LIMIT 12`, [...ids, trendSince])
        .map(s => ({ submissionId: s.id, employee: nameOf(s.employee_id), weekId: s.week_id, text: JSON.parse(s.payload_json).answers.find(a => a.questionId === 's2')?.answer }));
    })();
    const failed = any(ctx, 'manager', 'hr', 'safety') ? db.get("SELECT COUNT(*) n FROM notifications WHERE status='failed' AND created_at >= ?", [new Date(now().getTime() - 7 * 86400000).toISOString()]).n : null;

    return {
      view, scope, focusWeek: focus, currentWeek: cur, supervisors, weeks: perWeek, reliability,
      safety: {
        open: reports.filter(r => r.status !== 'closed').length,
        urgentOpen: reports.filter(r => r.status !== 'closed' && r.priority === 'urgent').length,
        overdue: reports.filter(r => r.overdue).length,
        pendingVerification: reports.filter(r => r.status === 'pending_verification').length,
        reportedInPeriod: inPeriod.length,
        closedInPeriod: reports.filter(r => r.closedAt && r.closedAt >= periodStart && r.closedAt < periodEnd).length,
        unresolved: reports.filter(r => r.status !== 'closed').slice(0, 10).map(r => ({ id: r.id, typeLabel: r.typeLabel, priority: r.priority, area: r.area, status: r.status, overdue: r.overdue, createdAt: r.createdAt }))
      },
      actions: { open: cas.filter(c => c.status !== 'closed').length, overdue: cas.filter(c => c.overdue).length, pendingVerification: cas.filter(c => c.status === 'pending_verification').length },
      trends: { byArea: count(recent, 'area'), byEquipment: count(recent, 'equipment'), byType: count(recent.map(r => ({ t: r.typeLabel })), 't'), obstacles },
      notificationFailures7d: failed
    };
  };

  A['audit.verify'] = (ctx) => {
    if (!any(ctx, 'hr', 'manager')) throw deny();
    const problems = [];
    let prev = 'GENESIS';
    const events = db.all('SELECT * FROM audit_events ORDER BY seq', []);
    for (const ev of events) {
      const body = { at: ev.at, actorId: ev.actor_id, action: ev.action, entity: ev.entity, entityId: ev.entity_id, detail: JSON.parse(ev.detail_json) };
      if (ev.prev_hash !== prev || ev.hash !== crypto.sha256(prev + '|' + canonical(body))) problems.push({ kind: 'audit', seq: ev.seq });
      prev = ev.hash;
    }
    let checked = 0;
    for (const t of ['survey_submissions', 'survey_amendments', 'supervisor_reviews']) {
      for (const r of db.all(`SELECT id, payload_json, payload_hash FROM ${t}`, [])) { checked++; if (crypto.sha256(r.payload_json) !== r.payload_hash) problems.push({ kind: t, id: r.id }); }
    }
    for (const r of db.all('SELECT id, text, text_hash FROM review_events', [])) { checked++; if (crypto.sha256(r.text) !== r.text_hash) problems.push({ kind: 'review_events', id: r.id }); }
    return { auditEvents: events.length, signedRecordsChecked: checked, problems, ok: problems.length === 0 };
  };

  A['demo.setSimFail'] = (ctx, { employeeId, count }) => {
    if (!cfg.demo) throw new HubError(404, 'unknown_action', 'Unknown action');
    if (!any(ctx, 'manager', 'hr')) throw deny();
    const e = emp(employeeId); if (!e) throw notFound();
    const n = Math.max(0, Math.min(10, Number(count) || 0));
    tx(() => { db.run('UPDATE employees SET sim_fail_sms=?, phone_on_file=1 WHERE id=?', [n, e.id]); audit(ctx.me.id, 'demo.sim_fail_set', 'employee', e.id, { count: n }); });
    return { ok: true };
  };

  // ---------------------------------------------------------------- scheduler
  // Runs every minute on Workers (Durable Object alarm) and every 15 s in the Node and browser demos.
  function tick() {
    return serial(async () => {
      const n = now();
      const week = reportingWeek(n, tz);
      const out = { escalated: 0, reminders: 0 };
      tx(() => {
        ensureAssignments(week);
        // Weekly report is open: one in-app reminder per expected employee, in working hours.
        if (n.toISOString() >= week.opensAt && isWithinWorkingHours(n, tz)) {
          for (const a of db.all("SELECT * FROM survey_assignments WHERE week_id=? AND status='open' AND expected=1", [week.weekId])) {
            if (!db.get("SELECT 1 FROM notifications WHERE recipient_id=? AND kind='survey_open' AND ref=?", [a.employee_id, a.id])) {
              queueNotification(a.employee_id, { kind: 'survey_open', ref: a.id, subject: 'This week\'s report is ready. Please do it during your shift.', channels: ['in_app'] }); out.reminders++;
            }
          }
        }
        // Unacknowledged urgent reports: escalate immediately at the target, then every 15 minutes.
        for (const r of db.all("SELECT * FROM safety_reports WHERE status='new' AND priority='urgent' AND response_due_at < ?", [n.toISOString()])) {
          const last = r.last_reminder_at ? new Date(r.last_reminder_at) : null;
          if (last && n - last < ESCALATE_EVERY_MIN * 60000) continue;
          if (r.escalation_level >= 6) continue;
          const level = r.escalation_level + 1;
          db.run('UPDATE safety_reports SET escalation_level=?, last_reminder_at=? WHERE id=?', [level, n.toISOString(), r.id]);
          safetyEvent(r.id, null, 'escalated', { level });
          audit(null, 'safety.escalated', 'safety_report', r.id, { level });
          // Level 1: safety contacts and full-access managers; level 2 and up: all of management.
          const to = new Set([...activeWith('safety'), ...activeWith('hr'), ...(level >= 2 ? activeWith('manager') : [])].map(e => e.id));
          to.delete(r.reporter_id);
          for (const rid of to) queueNotification(rid, { kind: 'safety', ref: r.id, subject: `ESCALATION ${level}: urgent safety report not yet acknowledged (${TYPE_LABEL[r.type]})`, urgent: true, channels: ['sms', 'in_app'] });
          out.escalated++;
        }
        // High-priority reports past their target: one reminder per working day, in working hours.
        if (isWithinWorkingHours(n, tz)) {
          const today = ymdOf(n, tz);
          for (const r of db.all("SELECT * FROM safety_reports WHERE status != 'closed' AND priority IN ('high','urgent') AND response_due_at < ?", [n.toISOString()])) {
            if (r.status === 'new' && r.priority === 'urgent') continue;
            if (r.last_reminder_at && ymdOf(new Date(r.last_reminder_at), tz) === today) continue;
            db.run('UPDATE safety_reports SET last_reminder_at=? WHERE id=?', [n.toISOString(), r.id]);
            for (const rid of new Set([r.owner_id, ...activeWith('safety').map(e => e.id)].filter(Boolean))) {
              queueNotification(rid, { kind: 'safety', ref: r.id, subject: `Still open: ${TYPE_LABEL[r.type]} (${r.priority})`, channels: ['in_app'], hold: false }); out.reminders++;
            }
          }
          for (const c of db.all("SELECT * FROM corrective_actions WHERE status IN ('open','in_progress') AND due_date < ?", [today])) {
            if (c.last_reminder_at && ymdOf(new Date(c.last_reminder_at), tz) === today) continue;
            db.run('UPDATE corrective_actions SET last_reminder_at=? WHERE id=?', [n.toISOString(), c.id]);
            for (const rid of new Set([c.assigned_to, c.created_by])) { queueNotification(rid, { kind: 'action', ref: c.id, subject: `Overdue: ${c.title}`, channels: ['in_app'], hold: false }); out.reminders++; }
          }
        }
      });
      tx(() => expireUnconfirmed());
      const d = await dispatchDue();
      return { ...out, ...d };
    });
  }

  // ---------------------------------------------------------------- dispatcher
  // meta.rp = { rpId, origin } of the page (passkeys are bound to the web address).
  async function call(token, action, input = {}, meta = {}) {
    if (typeof action !== 'string' || !Object.hasOwn(A, action)) throw new HubError(404, 'unknown_action', 'Unknown action');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw bad('Bad input');
    return serial(async () => {
      const ctx = authenticate(token);
      ctx.rp = meta.rp || null;
      if (ctx.session.must_set_pin && !PRE_PIN_ACTIONS.has(action)) throw new HubError(403, 'must_set_pin', 'Choose your PIN first.');
      return A[action](ctx, input);
    });
  }

  // ---------------------------------------------------------------- point-in-time restore (R1.2)
  // Cloudflare keeps 30 days of history for the Durable Object's database. A full-access
  // manager can put the whole database back to an earlier moment (for example after a bad
  // bulk change). The runtime supplies platform.restore = { log(), schedule(entry) }:
  // schedule() records the request in a separate restore log (outside the database being
  // restored, so it survives the restore), asks Cloudflare to restore on the next start, and
  // restarts. After the restart, recordRestores() copies the log into the audit chain.
  // Every restore can be undone (a second restore to the moment just before it).
  const RESTORE_MAX_DAYS = 30;
  A['admin.restoreStatus'] = async (ctx) => {
    if (!has(ctx, 'hr')) throw deny('Only a full-access manager can restore data.');
    const p = platform.restore;
    return { available: !!p, maxDays: RESTORE_MAX_DAYS, realNowUtc: new Date().toISOString(), log: p ? (await p.log()).slice(-20).reverse() : [] };
  };
  A['admin.restore'] = async (ctx, { toTime, undoId, signPin, totp, confirm } = {}) => {
    if (!has(ctx, 'hr')) throw deny('Only a full-access manager can restore data.');
    const p = platform.restore;
    if (!p) throw new HubError(409, 'restore_unavailable', 'Restore works only on Cloudflare (not in this copy).');
    if (String(confirm || '').trim().toUpperCase() !== 'RESTORE') throw bad('Type RESTORE to confirm.', 'confirm');
    if (!await verifyPinFor(ctx.me, signPin, ctx)) throw new HubError(401, 'bad_sign_pin', 'That PIN is not right. Nothing was restored.');
    if (cfg.elevatedRequireTotp) {
      const me = emp(ctx.me.id);
      const plain = await crypto.openSecret(me.totp_secret);
      const counter = plain ? await verifyTotp(crypto, plain, String(totp || ''), now(), me.totp_last_counter) : null;
      if (counter === null) throw new HubError(401, 'bad_totp', 'That authenticator code is not right. Nothing was restored.');
      tx(() => db.run('UPDATE employees SET totp_last_counter=? WHERE id=?', [counter, me.id]));
    }
    let target;
    if (undoId) {
      const prior = (await p.log()).find(x => x.id === String(undoId));
      if (!prior || !(prior.undoBookmark || prior.before)) throw bad('That restore cannot be undone.', 'undo');
      target = { kind: 'undo', of: prior.id, bookmark: prior.undoBookmark || prior.before };
    } else {
      // Real time, not the demo clock: Cloudflare's history is kept in real time.
      const t = new Date(String(toTime || '')), real = Date.now();
      if (isNaN(t.getTime())) throw bad('Choose the date and time to go back to.', 'to_time');
      if (t.getTime() > real - 60000) throw bad('Choose a time at least 1 minute ago.', 'to_time');
      if (t.getTime() < real - RESTORE_MAX_DAYS * 86400000 + 3600000) throw bad(`Restore reaches back ${RESTORE_MAX_DAYS} days at most.`, 'to_time');
      target = { kind: 'time', time: t.toISOString() };
    }
    const entry = { id: id('RS'), requestedBy: ctx.me.id, requestedByName: ctx.me.display_name, requestedAt: new Date().toISOString(), target };
    const r = await p.schedule(entry);
    return { restoreId: entry.id, ...r, message: 'Restoring now. The Hub restarts in a few seconds. Everyone may need to sign in again.' };
  };
  // ---------------------------------------------------------------- open portal (R1.2, owner 2026-10-15)
  // The home page and the questions are open; the PIN is typed once, when signing.
  // Nothing here is personal: the active questionnaire, the e-sign consent text, the
  // work-hours window and links to company systems that have their own sign-ins.
  function publicInfo() {
    const n = now();
    // The week people can sign now: before Friday 07:00 that is still last week's report.
    const cur = reportingWeek(n, tz);
    const week = n.toISOString() < cur.opensAt ? prevWeek(cur) : cur;
    return { now: n.toISOString(), week, template: getTemplate(cfg.activeTemplate), consent: ESIGN_CONSENT_V1, surveyWindow: surveyWindow(), links: LINKS, demo: cfg.demo };
  }
  // Names for the tap-your-name grid, only on a registered shop tablet (never on the open web).
  function kioskRoster(deviceToken) {
    const d = deviceFromToken(deviceToken);
    if (!d) throw new HubError(403, 'not_a_shop_tablet', 'The name list is only shown on registered shop tablets.');
    return { device: d.label, people: db.all("SELECT id, display_name, roles FROM employees WHERE status='active' ORDER BY display_name", [])
      .map(e => ({ id: e.id, name: e.display_name, needsCode: isElevated(e) && cfg.elevatedRequireTotp })) };
  }

  // ---------------------------------------------------------------- phone reminders (web push, R1.3)
  // Off until a full-access manager switches them on (Admin → Reminders). Each person turns them on
  // per phone. Only during work hours: "your weekly report is open" (Friday) and "due today"
  // (Monday morning, if still not signed). Pushes carry no content; the phone fetches the text.
  const PUSH_SUBJECT = 'https://hub.innerspacecases.com';
  const pushEnabled = () => { try { return (db.get("SELECT v FROM meta WHERE k='push_enabled'") || {}).v === '1'; } catch { return false; } };
  const metaGet = (k) => { const r = db.get('SELECT v FROM meta WHERE k=?', [k]); return r ? r.v : null; };
  const metaSet = (k, v) => db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, v]);
  async function ensurePushKeys() {
    if (metaGet('vapid_public')) return false;
    const { publicKey, privateJwk } = await generateVapidKeys();
    const sealed = await crypto.sealSecret(JSON.stringify(privateJwk));
    tx(() => { if (!metaGet('vapid_public')) { metaSet('vapid_public', publicKey); metaSet('vapid_private', sealed); audit(null, 'push.keys_created', 'system', 'push', {}); } });
    return true;
  }
  function pushPublic() { return { publicKey: metaGet('vapid_public'), enabled: pushEnabled() }; }
  const livePush = (eid) => db.all('SELECT * FROM push_subscriptions WHERE employee_id=? AND removed_at IS NULL ORDER BY created_at', [eid]);
  A['push.status'] = (ctx) => ({ ...pushPublic(), phones: livePush(ctx.me.id).map(p => ({ id: p.id, device: p.device, createdAt: p.created_at, endpointTail: p.endpoint.slice(-12) })) });
  A['push.subscribe'] = (ctx, { endpoint, device }) => {
    if (ctx.session.device_id || ctx.session.shared_device) throw deny('Reminders are for your own phone, not a shared device.');
    if (!pushEndpointOk(endpoint)) throw bad('This browser\'s reminder address is not supported.', 'push_endpoint');
    const n = nowIso(), dev = deviceLabel(device);
    tx(() => {
      const old = db.get('SELECT * FROM push_subscriptions WHERE endpoint=?', [endpoint]);
      if (old && old.employee_id === ctx.me.id && !old.removed_at) return;
      if (old) db.run('DELETE FROM push_subscriptions WHERE id=?', [old.id]);   // the phone changed hands, or was turned back on
      db.run('INSERT INTO push_subscriptions (id, employee_id, endpoint, device, created_at) VALUES (?,?,?,?,?)', [id('PS'), ctx.me.id, endpoint, dev, n]);
      audit(ctx.me.id, 'push.subscribed', 'employee', ctx.me.id, { device: dev });
    });
    return A['push.status'](ctx);
  };
  A['push.unsubscribe'] = (ctx, { endpoint }) => {
    const p = db.get('SELECT * FROM push_subscriptions WHERE endpoint=? AND removed_at IS NULL', [String(endpoint || '')]);
    if (p && p.employee_id === ctx.me.id) tx(() => { db.run("UPDATE push_subscriptions SET removed_at=?, remove_reason='turned_off' WHERE id=?", [nowIso(), p.id]); audit(ctx.me.id, 'push.unsubscribed', 'employee', ctx.me.id, { device: p.device }); });
    return A['push.status'](ctx);
  };
  // "Send me a test": only ever to the person who taps it.
  A['push.test'] = (ctx) => {
    const subs = livePush(ctx.me.id);
    if (!subs.length) throw bad('Turn on reminders on this phone first.', 'push_none');
    tx(() => { for (const p of subs) queuePush(p, 'test', 'test:' + nowIso(), 'Employee Hub', 'Reminders work on this phone.', '/'); });
    return { queued: subs.length };
  };
  A['admin.pushStatus'] = (ctx) => {
    if (!has(ctx, 'hr')) throw deny();
    const people = db.get('SELECT COUNT(DISTINCT employee_id) n FROM push_subscriptions WHERE removed_at IS NULL').n;
    const last = db.all("SELECT kind, status, COUNT(*) n FROM push_messages WHERE created_at > ? GROUP BY kind, status", [new Date(now().getTime() - 14 * 86400000).toISOString()]);
    return { enabled: pushEnabled(), people, last14days: last, available: !!platform.fetch };
  };
  A['admin.pushSettings'] = (ctx, { enabled }) => {
    if (!has(ctx, 'hr')) throw deny('Only a full-access manager can switch reminders on or off.');
    tx(() => { metaSet('push_enabled', enabled ? '1' : '0'); audit(ctx.me.id, enabled ? 'push.enabled' : 'push.disabled', 'system', 'push', {}); });
    return A['admin.pushStatus'](ctx);
  };
  function queuePush(sub, kind, dedupe, title, body, url) {
    db.run(`INSERT OR IGNORE INTO push_messages (id, subscription_id, employee_id, kind, dedupe_key, title, body, url, status, created_at) VALUES (?,?,?,?,?,?,?,?,'queued',?)`,
      [id('PM'), sub.id, sub.employee_id, kind, dedupe, title, body, url, nowIso()]);
  }
  // The phone asks what to show for a push it just received. Never anything private.
  function pushPending(endpoint) {
    return serial(async () => {
      const sub = typeof endpoint === 'string' && endpoint.length <= 1200 ? db.get('SELECT * FROM push_subscriptions WHERE endpoint=? AND removed_at IS NULL', [endpoint]) : null;
      if (!sub) return {};
      const m = db.get("SELECT * FROM push_messages WHERE subscription_id=? AND status='sent' AND sent_at > ? ORDER BY sent_at DESC LIMIT 1", [sub.id, new Date(now().getTime() - 86400000).toISOString()]);
      if (!m) return {};
      tx(() => db.run("UPDATE push_messages SET status='shown', shown_at=? WHERE id=?", [nowIso(), m.id]));
      return { title: m.title, body: m.body, url: m.url, tag: m.kind };
    });
  }
  const es = (eid) => (emp(eid) || {}).preferred_language === 'es';
  async function pushTick() {
    return serial(async () => {
      const out = { queued: 0, sent: 0, failed: 0 };
      const n = now();
      if (pushEnabled() && isWithinWorkingHours(n, tz)) {
        const cur = reportingWeek(n, tz), prev = prevWeek(cur);
        tx(() => {
          ensureAssignments(cur);
          for (const sub of db.all('SELECT * FROM push_subscriptions WHERE removed_at IS NULL', [])) {
            const e = emp(sub.employee_id);
            if (!e || e.status !== 'active') continue;
            const a = db.get("SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=? AND status='open' AND expected=1", [e.id, cur.weekId]);
            if (a && n.toISOString() >= cur.opensAt && !db.get('SELECT 1 FROM survey_submissions WHERE assignment_id=?', [a.id])) {
              const before = db.get('SELECT COUNT(*) n FROM push_messages WHERE subscription_id=?', [sub.id]).n;
              queuePush(sub, 'report_open', 'open:' + cur.weekId, es(e.id) ? 'Su reporte semanal está abierto' : 'Your weekly report is open', es(e.id) ? 'Unos 2 minutos, durante su turno. Toque para llenarlo.' : 'About 2 minutes, during your shift. Tap to fill it in.', '/#/r');
              out.queued += db.get('SELECT COUNT(*) n FROM push_messages WHERE subscription_id=?', [sub.id]).n - before;
            }
            const p = db.get("SELECT * FROM survey_assignments WHERE employee_id=? AND week_id=? AND status='open' AND expected=1", [e.id, prev.weekId]);
            const monMorning = new Date(new Date(prev.dueAt).getTime() - 6.5 * 3600000).toISOString();   // Monday 09:00
            if (p && n.toISOString() >= monMorning && n.toISOString() < prev.dueAt && !db.get('SELECT 1 FROM survey_submissions WHERE assignment_id=?', [p.id])) {
              const before = db.get('SELECT COUNT(*) n FROM push_messages WHERE subscription_id=?', [sub.id]).n;
              queuePush(sub, 'report_due', 'due:' + prev.weekId, es(e.id) ? 'Su reporte semanal vence hoy' : 'Your weekly report is due today', es(e.id) ? 'Vence hoy a las 3:30 PM. Toque para llenarlo.' : 'Due by 3:30 PM today. Tap to fill it in.', '/#/r');
              out.queued += db.get('SELECT COUNT(*) n FROM push_messages WHERE subscription_id=?', [sub.id]).n - before;
            }
          }
        });
      }
      if (!platform.fetch) return out;
      const pub = metaGet('vapid_public'), sealed = metaGet('vapid_private');
      if (!pub || !sealed) return out;
      const privateJwk = JSON.parse(await crypto.openSecret(sealed));
      // Tests are sent even while reminders are switched off (they go only to the person who asked).
      for (const m of db.all("SELECT m.*, s.endpoint FROM push_messages m JOIN push_subscriptions s ON s.id = m.subscription_id WHERE m.status='queued' AND s.removed_at IS NULL ORDER BY m.created_at LIMIT 50", [])) {
        if (m.kind !== 'test' && !pushEnabled()) continue;
        const r = await sendPush({ fetch: platform.fetch, endpoint: m.endpoint, publicKey: pub, privateJwk, subject: PUSH_SUBJECT, nowSec: Math.floor(Date.now() / 1000) });
        tx(() => {
          if (r.ok) { db.run("UPDATE push_messages SET status='sent', sent_at=?, attempts=attempts+1, detail=? WHERE id=?", [nowIso(), r.detail, m.id]); db.run('UPDATE push_subscriptions SET last_ok_at=? WHERE id=?', [nowIso(), m.subscription_id]); out.sent++; }
          else {
            const last = r.gone || m.attempts + 1 >= 3;
            db.run(`UPDATE push_messages SET status=?, attempts=attempts+1, detail=? WHERE id=?`, [last ? 'failed' : 'queued', r.detail, m.id]);
            if (r.gone) db.run("UPDATE push_subscriptions SET removed_at=?, remove_reason='gone' WHERE id=?", [nowIso(), m.subscription_id]);
            if (last) out.failed++;
          }
        });
      }
      return out;
    });
  }

  // S5: backup export. A full-access manager downloads a complete copy of the records
  // (everything except sign-in secrets and live sessions) to keep outside Cloudflare.
  // The file carries the audit-chain head and its own SHA-256 so a copy can be checked later.
  const BACKUP_TABLES = ['employees', 'devices', 'esign_consents', 'absences', 'survey_assignments', 'survey_drafts', 'survey_submissions', 'survey_amendments',
    'supervisor_reviews', 'review_events', 'paper_events', 'safety_reports', 'safety_events', 'corrective_actions', 'ca_events', 'attachments', 'notifications',
    'notification_attempts', 'audit_events', 'passkeys'];
  const BACKUP_OMIT = { employees: ['pin_salt', 'pin_hash', 'setup_code_hash', 'setup_code_expires', 'setup_code_issued_by', 'totp_secret', 'totp_last_counter', 'failed_logins', 'locked_until', 'lockouts_24h', 'sim_fail_sms'], devices: ['token_hash'], passkeys: ['public_key_jwk', 'credential_id'] };
  A['admin.backupExport'] = (ctx) => {
    if (!has(ctx, 'hr')) throw deny('Only a full-access manager can export a backup.');
    tx(() => audit(ctx.me.id, 'backup.exported', 'system', 'all', { tables: BACKUP_TABLES.length }));
    const tables = {}, counts = {};
    for (const t of BACKUP_TABLES) {
      const omit = BACKUP_OMIT[t] || [];
      tables[t] = db.all(`SELECT * FROM ${t}`, []).map(row => { const o = { ...row }; for (const k of omit) delete o[k]; return o; });
      counts[t] = tables[t].length;
    }
    const head = db.get('SELECT seq, hash, at FROM audit_events ORDER BY seq DESC LIMIT 1');
    const body = canonical({ format: 'tag-employee-hub-backup-1', generatedAt: new Date().toISOString(), generatedBy: ctx.me.id, demo: cfg.demo, auditHead: head, counts, tables });
    return { filename: `tag-hub-backup-${ymdOf(now(), tz)}.json`, sha256: crypto.sha256(body), counts, auditHead: head, body };
  };

  // After any start: make sure every restore in the durable log is in the audit chain.
  async function recordRestores() {
    const p = platform.restore;
    if (!p) return 0;
    let n = 0;
    for (const e of (await p.log()).sort((a, b) => a.requestedAt < b.requestedAt ? -1 : 1)) {
      if (db.get("SELECT 1 FROM audit_events WHERE action='system.restored' AND entity_id=?", [e.id])) continue;
      tx(() => audit(e.requestedBy, 'system.restored', 'system', e.id, { requestedAt: e.requestedAt, target: e.target, bookmark: e.bookmark || null, undoBookmark: e.undoBookmark || null }));
      n++;
    }
    return n;
  }

  // S4: encrypt any authenticator secrets stored before encryption at rest existed. Runs at start-up; idempotent.
  async function sealLegacySecrets() {
    let n = 0;
    for (const row of db.all("SELECT id, totp_secret FROM employees WHERE totp_secret IS NOT NULL AND totp_secret NOT LIKE 'enc1:%'", [])) {
      const sealed = await crypto.sealSecret(row.totp_secret);
      tx(() => db.run('UPDATE employees SET totp_secret=? WHERE id=? AND totp_secret=?', [sealed, row.id, row.totp_secret]));
      n++;
    }
    if (n) tx(() => audit(null, 'security.secrets_sealed', 'system', 'employees', { count: n }));
    return n;
  }

  return { call, login, logout, passkeyOptions, passkeyLogin, ensurePushKeys, pushPublic, pushPending, pushTick, tick, sealLegacySecrets, recordRestores, publicInfo, kioskRoster, dispatchDue, deliveryReceipt, bootstrap, bootstrapStatus, bootstrapRecover, ensureAssignments, actions: Object.keys(A), config: cfg, _audit: audit, _serial: serial, _weekFor: weekFor };
}

export const TYPE_LABEL = {
  imminent: 'Someone could get hurt right now', injury: 'Someone got hurt', injury_followup: 'Weekly report: injury answered Yes',
  unsafe_equipment: 'Unsafe equipment', hazard: 'Workplace hazard', unsafe_condition: 'Unsafe working condition',
  near_miss: 'Near miss', suggestion: 'Safety suggestion or question'
};

// Links to the systems that stay authoritative. No single sign-on is claimed.
export const LINKS = [
  { key: 'mywork', label: { en: 'My Work (Order Manager)', es: 'Mi trabajo (Order Manager)' }, url: 'https://thearmoredgroup.quickbase.com/db/bf5ukkqy7', note: 'Quickbase sign-in' },
  { key: 'time', label: { en: 'Time clock (QuickBooks Time)', es: 'Reloj (QuickBooks Time)' }, url: 'https://quickbooks.intuit.com/time-tracking/', note: 'Intuit sign-in' },
  { key: 'pay', label: { en: 'Pay stubs (Workforce)', es: 'Talones de pago (Workforce)' }, url: 'https://workforce.intuit.com/', note: 'Intuit sign-in' }
];
