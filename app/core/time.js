// Time-zone utilities. All business dates (reporting weeks, due dates, working
// hours) are computed in the company zone, America/Los_Angeles, so DST changes
// never shift a reporting week. Instants are stored as UTC ISO strings and
// displayed with an explicit offset.

export const COMPANY_TZ = 'America/Los_Angeles';

const partsCache = new Map();
function fmt(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    }));
  }
  return partsCache.get(tz);
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(date, tz = COMPANY_TZ) {
  const o = {};
  for (const p of fmt(tz).formatToParts(date)) o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour, minute: +o.minute, second: +o.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday)
  };
}

/** Offset of the zone from UTC at an instant, in minutes (e.g. -420 for PDT). */
export function offsetMinutes(date, tz = COMPANY_TZ) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Instant for a wall-clock time in the zone. DST handling matches Temporal's
 *  "compatible" rule: a skipped time (spring forward) moves forward by the gap;
 *  a repeated time (fall back) resolves to the first (earlier) occurrence. */
export function zonedToUtc(ymd, hms = '00:00:00', tz = COMPANY_TZ) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm, ss = 0] = hms.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = new Date(wall);
  for (let i = 0; i < 3; i++) {
    guess = new Date(wall - offsetMinutes(guess, tz) * 60000);
  }
  return guess;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function ymdOf(date, tz = COMPANY_TZ) {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO-8601 with the zone's offset, e.g. 2026-10-14T07:14:00-07:00 */
export function isoWithOffset(date, tz = COMPANY_TZ) {
  const p = zonedParts(date, tz);
  const off = offsetMinutes(date, tz);
  const sign = off <= 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/**
 * Reporting week = payroll week, Monday through Sunday in company time
 * (verified against the QuickBooks Payroll "Weekly" schedule, 2026-10-14).
 */
export function reportingWeek(date, tz = COMPANY_TZ) {
  const p = zonedParts(date, tz);
  const today = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const sinceMonday = (p.weekday + 6) % 7;
  const start = addDays(today, -sinceMonday);
  const end = addDays(start, 6);
  return {
    weekId: start,
    start, end, tz,
    startsAt: zonedToUtc(start, '00:00:00', tz).toISOString(),
    endsAt: zonedToUtc(addDays(end, 1), '00:00:00', tz).toISOString(),
    // Survey opens Friday 07:00 and is due by end of the employee's first shift
    // the following Monday (15:30). Both inside normal working hours.
    opensAt: zonedToUtc(addDays(start, 4), '07:00:00', tz).toISOString(),
    dueAt: zonedToUtc(addDays(start, 7), '15:30:00', tz).toISOString()
  };
}

/** Working hours for reminders: Mon–Fri 07:00–15:30 company time. */
export const WORKING_HOURS = { days: [1, 2, 3, 4, 5], start: '07:00', end: '15:30' };

export function isWithinWorkingHours(date, tz = COMPANY_TZ, wh = WORKING_HOURS) {
  const p = zonedParts(date, tz);
  if (!wh.days.includes(p.weekday)) return false;
  const mins = p.hour * 60 + p.minute;
  const [sh, sm] = wh.start.split(':').map(Number);
  const [eh, em] = wh.end.split(':').map(Number);
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

/** Earliest instant >= date that falls inside working hours. */
export function nextWorkingSlot(date, tz = COMPANY_TZ, wh = WORKING_HOURS) {
  if (isWithinWorkingHours(date, tz, wh)) return date;
  let ymd = ymdOf(date, tz);
  for (let i = 0; i < 8; i++) {
    const candidate = zonedToUtc(ymd, wh.start + ':00', tz);
    if (candidate >= date && isWithinWorkingHours(candidate, tz, wh)) return candidate;
    ymd = addDays(ymd, 1);
  }
  throw new Error('no working slot found');
}

/** Add business hours (Mon–Fri working window) to an instant. Used for safety
 *  response deadlines that are not "immediate". */
export function addWorkingMinutes(date, minutes, tz = COMPANY_TZ, wh = WORKING_HOURS) {
  let t = nextWorkingSlot(date, tz, wh);
  let left = minutes;
  while (left > 0) {
    const ymd = ymdOf(t, tz);
    const close = zonedToUtc(ymd, wh.end + ':00', tz);
    const avail = Math.floor((close - t) / 60000);
    if (left <= avail) return new Date(t.getTime() + left * 60000);
    left -= avail;
    t = nextWorkingSlot(new Date(close.getTime() + 60000), tz, wh);
  }
  return t;
}

/** Working minutes (Mon–Fri working window) between two instants; 0 if b <= a. */
export function workingMinutesBetween(a, b, tz = COMPANY_TZ, wh = WORKING_HOURS) {
  if (b <= a) return 0;
  let total = 0;
  let t = nextWorkingSlot(a, tz, wh);
  for (let guard = 0; t < b && guard < 400; guard++) {
    const close = zonedToUtc(ymdOf(t, tz), wh.end + ':00', tz);
    const end = close < b ? close : b;
    if (end > t) total += Math.floor((end - t) / 60000);
    if (close >= b) break;
    t = nextWorkingSlot(new Date(close.getTime() + 60000), tz, wh);
  }
  return total;
}

/** Mon–Fri dates (YYYY-MM-DD) of a reporting week. */
export const weekdaysOf = (week) => [0, 1, 2, 3, 4].map(i => addDays(week.start, i));
