// InnerPoints, read-only, from the Order Manager in Quickbase (realm thearmoredgroup.quickbase.com).
// The Hub only ever calls POST https://api.quickbase.com/v1/records/query (a read: Quickbase uses
// POST for queries) on the InnerPoints ledger table, with a user token kept as the Worker secret
// QB_TOKEN. Nothing in Quickbase is created, changed or deleted by the Hub.
//   people(sinceYmd):            who has points since a date: [{ id: Employee record id, name }]
//   awards({ empId, sinceYmd }):  that person's ledger rows since a date (reversed rows left out)

export const QB_API = 'https://api.quickbase.com/v1';
export const QB_REALM = 'thearmoredgroup.quickbase.com';
export const IP_TABLE = 'bvd8m6g2v';          // InnerPoints ledger (Order Manager app bf5ukkqy7)
// Ledger fields (from the 2026-09 InnerPoints audit). Every answer is checked: Quickbase silently
// drops unknown field ids, so a missing field stops the card instead of showing wrong numbers.
export const IPF = { emp: 17, name: 19, points: 6, code: 7, at: 8, wo: 14, reversed: 13 };
// The team started using the Order Manager themselves the week of 2026-09-21; the leaderboard counts from then.
export const IP_LAUNCH = '2026-09-21';

export class IpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const val = (row, f) => { const c = row[String(f)]; return c ? c.value : null; };

export function makeInnerPoints({ fetch, token, realm = QB_REALM }) {
  if (!token) return null;
  async function query(where, select) {
    const out = [];
    for (let skip = 0, page = 0; page < 5; page++) {
      let r;
      try {
        r = await fetch(QB_API + '/records/query', {
          method: 'POST',
          headers: { 'QB-Realm-Hostname': realm, Authorization: 'QB-USER-TOKEN ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: IP_TABLE, select, where, sortBy: [{ fieldId: IPF.at, order: 'DESC' }], options: { skip, top: 1000 } }),
          signal: AbortSignal.timeout(8000)
        });
      } catch { throw new IpError('ip_network', 'Could not reach Quickbase (no answer within 8 seconds).'); }
      if (r.status === 401 || r.status === 403) throw new IpError('ip_auth', 'Quickbase refused the token (expired, removed, or no access to the Order Manager). Create a new user token and update QB_TOKEN.');
      if (r.status === 429) throw new IpError('ip_rate', 'Quickbase asked the Hub to slow down. Try again in a minute.');
      if (r.status < 200 || r.status >= 300) throw new IpError('ip_http', 'Quickbase answered HTTP ' + r.status + '.');
      let j; try { j = await r.json(); } catch { throw new IpError('ip_http', 'Quickbase sent an unreadable answer.'); }
      const got = new Set((j.fields || []).map(f => Number(f.id)));
      const missing = select.filter(f => !got.has(f));
      if (missing.length) throw new IpError('ip_schema', 'The InnerPoints ledger in Quickbase has changed (field ' + missing.join(', ') + ' missing). Points are hidden until the Hub is updated.');
      const rows = j.data || [];
      out.push(...rows);
      const md = j.metadata || {};
      skip += rows.length;
      if (!rows.length || (md.totalRecords != null && skip >= md.totalRecords)) break;
    }
    return out;
  }
  const since = (ymd) => /^\d{4}-\d{2}-\d{2}$/.test(String(ymd)) ? ymd : IP_LAUNCH;
  return {
    async people(sinceYmd) {
      const rows = await query(`{${IPF.at}.OAF.'${since(sinceYmd)}'}`, [IPF.emp, IPF.name]);
      const seen = new Map();
      for (const r of rows) { const id = val(r, IPF.emp); if (id != null && id !== '' && !seen.has(String(id))) seen.set(String(id), String(val(r, IPF.name) || 'Employee ' + id)); }
      return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async awards({ empId, sinceYmd }) {
      if (!/^\d{1,12}$/.test(String(empId))) throw new IpError('ip_link', 'The Quickbase employee link is not valid.');
      const rows = await query(`{${IPF.emp}.EX.${Number(empId)}}AND{${IPF.at}.OAF.'${since(sinceYmd)}'}`, [IPF.points, IPF.code, IPF.at, IPF.wo, IPF.reversed]);
      return rows.filter(r => !val(r, IPF.reversed)).map(r => ({ points: Number(val(r, IPF.points)) || 0, code: String(val(r, IPF.code) || ''), at: val(r, IPF.at), wo: val(r, IPF.wo) != null ? String(val(r, IPF.wo)) : null }));
    }
  };
}

// Invented points for the demo/test copy, so the card can be tried without the real Order Manager.
export function makeDemoInnerPoints({ clock, people }) {
  const codes = ['WO_COMPLETE', 'WO_COMPLETE', 'WO_COMPLETE', 'FAST_COMPLETE', 'WO_COMPLETE', 'SAFETY'];
  return {
    demo: true,
    async people() { return people().map((p, i) => ({ id: String(101 + i), name: p.name })); },
    async awards({ empId, sinceYmd }) {
      const out = [], now = clock.now(), seed = Number(empId) || 1;
      const start = new Date((sinceYmd || '2026-09-21') + 'T15:00:00Z');
      let n = 0;
      for (let d = new Date(start); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.getUTCDay(); if (day === 0 || day === 6) continue;
        const k = (seed * 7 + n++) % 5;          // 1–3 jobs a day, varies by person
        for (let j = 0; j <= k % 3; j++) {
          const at = new Date(d.getTime() + (j * 2 + 1) * 3600000);
          if (at > now) continue;
          const code = codes[(seed + n + j) % codes.length];
          out.push({ points: code === 'FAST_COMPLETE' ? 3 : code === 'SAFETY' ? 5 : 2, code, at: at.toISOString(), wo: String(21000 + seed * 37 + n * 3 + j) });
        }
      }
      return out.reverse();
    }
  };
}
