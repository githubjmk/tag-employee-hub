import { DatabaseSync } from 'node:sqlite';

/** node:sqlite adapter with nested-transaction support (only the outermost tx commits). */
export function nodeDb(file = ':memory:') {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA foreign_keys = ON');
  const stmts = new Map();
  const prep = (sql) => { if (!stmts.has(sql)) stmts.set(sql, d.prepare(sql)); return stmts.get(sql); };
  const norm = (p) => p.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  let depth = 0;
  return {
    raw: d,
    exec: (sql) => { stmts.clear(); d.exec(sql); },
    run: (sql, p = []) => prep(sql).run(...norm(p)),
    get: (sql, p = []) => { const r = prep(sql).get(...norm(p)); return r ? { ...r } : undefined; },
    all: (sql, p = []) => prep(sql).all(...norm(p)).map(r => ({ ...r })),
    tx(fn) {
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      d.exec('BEGIN IMMEDIATE'); depth = 1;
      try { const r = fn(); d.exec('COMMIT'); return r; }
      catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
      finally { depth = 0; }
    }
  };
}

/** Deterministic clock for seeding and tests; can switch to running in real time. */
export function switchableClock(start = '2026-01-01T00:00:00Z') {
  let t = new Date(start); let live = null;
  return {
    now: () => live ? new Date(live.base + (Date.now() - live.started)) : new Date(t),
    set: (d) => { if (live) live = { base: new Date(d).getTime(), started: Date.now() }; else t = new Date(d); },
    runFrom: (d) => { live = { base: new Date(d).getTime(), started: Date.now() }; },
    freeze: () => { if (live) { t = new Date(live.base + (Date.now() - live.started)); live = null; } },
    advance: (ms) => { if (live) live.base += ms; else t = new Date(t.getTime() + ms); }
  };
}
