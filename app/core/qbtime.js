// QuickBooks Time (formerly TSheets), read-only. The Hub only ever sends GET requests, to
// https://rest.tsheets.com/api/v1, with an access token kept as a Worker secret (QBT_TOKEN).
// Nothing in QuickBooks Time is created, changed or deleted by the Hub.
//   users():                       active QuickBooks Time users (id, name)
//   timesheets({ startDate, endDate, userIds }):  timesheets in a date range (YYYY-MM-DD, inclusive)
import { zonedToUtc } from './time.js';

export const QBT_BASE = 'https://rest.tsheets.com/api/v1';

export class QbtError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function makeQbTime({ fetch, token, base = QBT_BASE }) {
  if (!token) return null;
  async function get(path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let r;
    try { r = await fetch(url.toString(), { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }); }
    catch { throw new QbtError('qbt_network', 'Could not reach QuickBooks Time.'); }
    if (r.status === 401 || r.status === 403) throw new QbtError('qbt_auth', 'QuickBooks Time refused the access token (expired or removed). Create a new token and update QBT_TOKEN.');
    if (r.status === 429) throw new QbtError('qbt_rate', 'QuickBooks Time asked the Hub to slow down. Try again in a minute.');
    if (r.status < 200 || r.status >= 300) throw new QbtError('qbt_http', 'QuickBooks Time answered HTTP ' + r.status + '.');
    return r.json();
  }
  // QuickBooks Time pages results ("more": true); 200 per page is the maximum.
  async function all(path, params, key) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const j = await get(path, { ...params, page, limit: 200 });
      const items = j && j.results && j.results[key] ? Object.values(j.results[key]) : [];
      out.push(...items);
      if (!j || !j.more) break;
    }
    return out;
  }
  return {
    async users() {
      return (await all('/users', { active: 'yes' }, 'users')).map(u => ({ id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || String(u.id) }));
    },
    async timesheets({ startDate, endDate, userIds }) {
      const ids = (userIds || []).filter(Boolean).join(',');
      return (await all('/timesheets', { start_date: startDate, end_date: endDate, user_ids: ids || undefined, on_the_clock: 'both', supplemental_data: 'no' }, 'timesheets'))
        .map(t => ({ id: String(t.id), userId: String(t.user_id), date: t.date, start: t.start || null, end: t.end || null,
          seconds: Number(t.duration) || 0, onClock: !!t.on_the_clock || (!!t.start && !t.end), type: t.type }));
    }
  };
}

// Sample data for the demo/test copy (invented people only), so the screens can be tried
// without connecting the real QuickBooks Time. Weekdays 7:00–11:30 and 12:00–15:30.
export function makeDemoQbTime({ clock, people }) {
  return {
    demo: true,
    async users() { return people().map((p, i) => ({ id: String(9001 + i), name: p.name })); },
    async timesheets({ startDate, endDate, userIds }) {
      const out = [];
      const now = clock.now();
      const wanted = new Set(userIds || []);
      for (let d = new Date(startDate + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.getUTCDay(); if (day === 0 || day === 6) continue;
        const ymd = d.toISOString().slice(0, 10);
        for (const id of wanted) {
          for (const [a, b] of [['07:00', '11:30'], ['12:00', '15:30']]) {
            const start = zonedToUtc(ymd, a + ':00'), end = zonedToUtc(ymd, b + ':00');
            if (start > now) continue;
            const onClock = end > now;
            out.push({ id: `${id}-${ymd}-${a}`, userId: id, date: ymd, start: start.toISOString(), end: onClock ? null : end.toISOString(),
              seconds: Math.round(((onClock ? now : end) - start) / 1000), onClock, type: 'regular' });
          }
        }
      }
      return out;
    }
  };
}
