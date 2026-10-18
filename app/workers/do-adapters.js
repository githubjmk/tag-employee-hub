// Durable Object SQLite adapter with the same synchronous interface as
// server/node-adapters.js: { exec, run, get, all, tx }. DO SQLite forbids
// BEGIN/COMMIT statements; transactionSync() is the transaction boundary and
// nested tx() calls join the outer transaction.
export function doDb(storage) {
  const sql = storage.sql;
  const norm = (p) => p.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  let depth = 0;
  return {
    exec: (text) => { sql.exec(text); },
    run: (text, p = []) => { const c = sql.exec(text, ...norm(p)); c.toArray(); return { changes: c.rowsWritten }; },
    get: (text, p = []) => { const r = sql.exec(text, ...norm(p)).toArray(); return r.length ? { ...r[0] } : undefined; },
    all: (text, p = []) => sql.exec(text, ...norm(p)).toArray().map(r => ({ ...r })),
    tx(fn) {
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      depth = 1;
      try { return storage.transactionSync(fn); } finally { depth = 0; }
    }
  };
}

// Demo clock persisted in the DO's own SQLite (meta table) so it survives
// restarts/evictions: demo time = base + (real now - started).
export function persistentClock(db) {
  let frozen = new Date('2026-01-01T00:00:00Z'), live = null;
  const save = () => { if (live) for (const [k, v] of [['clock_base', String(live.base)], ['clock_started', String(live.started)]]) db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, v]); };
  return {
    now: () => live ? new Date(live.base + (Date.now() - live.started)) : new Date(frozen),
    set: (d) => { if (live) { live = { base: new Date(d).getTime(), started: Date.now() }; save(); } else frozen = new Date(d); },
    runFrom: (d) => { live = { base: new Date(d).getTime(), started: Date.now() }; save(); },
    resume: () => {
      const b = db.get("SELECT v FROM meta WHERE k='clock_base'"), s = db.get("SELECT v FROM meta WHERE k='clock_started'");
      if (b && s) { live = { base: Number(b.v), started: Number(s.v) }; return true; }
      return false;
    },
    freeze: () => { if (live) { frozen = new Date(live.base + (Date.now() - live.started)); live = null; } },
    advance: (ms) => { if (live) { live.base += ms; save(); } else frozen = new Date(frozen.getTime() + ms); }
  };
}
