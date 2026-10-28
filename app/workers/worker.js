// TAG Employee Hub R1.2 — Cloudflare Worker + Durable Object.
// One Durable Object instance holds the whole hub in its private SQLite
// database (single writer, transactional, point-in-time recovery in
// production). The Worker serves the static UI from the ASSETS binding and
// forwards /api/* to the Durable Object.
//   HUB_DEMO=1  -> synthetic sample data and a demo clock (test copy)
//   HUB_DEMO=0  -> real clock, empty database; the first account is created once via
//                  /api/setup with the HUB_BOOTSTRAP_CODE secret (then it switches off).
import { DurableObject } from 'cloudflare:workers';
import { createService } from '../core/service.js';
import { makeCrypto } from '../core/webcrypto.js';
import { seed, demoPeople, DEMO_NOW, PILOT_START_WEEK } from '../core/seed.js';
import { createHttpHandler, makeTurnstile, SEC_HEADERS } from '../core/http.js';
import { SCHEMA, UPGRADES } from '../core/schema.js';
import { makeGoToSms } from '../core/goto-sms.js';
import { makeQbTime } from '../core/qbtime.js';
import { makeResendMailer } from '../core/mailer.js';
import { makeInnerPoints } from '../core/innerpoints.js';
import { doDb, persistentClock } from './do-adapters.js';

const TICK_MS = 60_000;

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() => this.boot());
  }

  async boot() {
    const env = this.env;
    if (!env.HUB_PEPPER || env.HUB_PEPPER.length < 16) throw new Error('HUB_PEPPER secret missing (set it in .dev.vars for local dev)');
    const demo = env.HUB_DEMO === '1';
    const db = doDb(this.ctx.storage);
    const clock = demo ? persistentClock(db) : { now: () => new Date() };
    const crypto = makeCrypto({ pepper: env.HUB_PEPPER });
    // Urgent safety texts through the company's GoTo Connect number, when configured.
    let senders = {};
    if (env.GOTO_CLIENT_ID && env.GOTO_REFRESH_TOKEN) {
      const store = { get: async () => { try { const r = db.get("SELECT v FROM meta WHERE k='goto_refresh'"); return r && r.v; } catch { return null; } },
        set: async (v) => db.run("INSERT INTO meta (k, v) VALUES ('goto_refresh', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [v]) };
      const g = makeGoToSms({ fetch: (...a) => fetch(...a), clientId: env.GOTO_CLIENT_ID, clientSecret: env.GOTO_CLIENT_SECRET, refreshToken: env.GOTO_REFRESH_TOKEN, ownerNumber: env.GOTO_OWNER_NUMBER, tokenStore: store });
      senders = { sms: g.sms, smsProvider: 'goto' };
    }
    // Point-in-time restore (see core/service.js). The restore log lives in its own Durable
    // Object so it survives the restore of this one.
    const logStub = () => env.RESTORE_LOG.get(env.RESTORE_LOG.idFromName('tag-hub-restore-log'));
    const platform = env.RESTORE_LOG ? { fetch: (...a) => fetch(...a), restore: {
      log: () => logStub().list(),
      schedule: async (entry) => {
        const st = this.ctx.storage;
        const before = await st.getCurrentBookmark();
        const bookmark = entry.target.kind === 'undo' ? entry.target.bookmark : await st.getBookmarkForTime(new Date(entry.target.time));
        await logStub().add({ ...entry, bookmark, before });
        const undoBookmark = await st.onNextSessionRestoreBookmark(bookmark);
        await logStub().patch(entry.id, { undoBookmark });
        this.restartPending = true;
        return { bookmark, undoBookmark };
      }
    } } : { fetch: (...a) => fetch(...a) };
    // QuickBooks Time (read-only) only on the live Hub: the test copy always uses invented sample hours.
    // Welcome emails only from the live Hub (Resend, innerspacecases.com). The test copy keeps previews.
    if (!demo) platform.mailer = makeResendMailer({ fetch: (...a) => fetch(...a), apiKey: env.RESEND_API_KEY, from: env.HUB_MAIL_FROM || undefined, replyTo: env.HUB_MAIL_REPLY_TO || null });
    // InnerPoints (read-only, Order Manager in Quickbase) only on the live Hub; the test copy shows invented points.
    if (!demo && env.QB_TOKEN) platform.innerpoints = makeInnerPoints({ fetch: (...a) => fetch(...a), token: env.QB_TOKEN, realm: env.QB_REALM || undefined });
    if (!demo && env.QBT_TOKEN) platform.qbtime = makeQbTime({ fetch: (...a) => fetch(...a), token: env.QBT_TOKEN });
    const service = createService({ db, crypto, clock, senders, platform, config: { demo, pilotStartWeek: demo ? PILOT_START_WEEK : (env.HUB_PILOT_START_WEEK || null) } });
    const seeded = (() => { try { return !!db.get("SELECT v FROM meta WHERE k='seeded'"); } catch { return false; } })();
    if (!seeded) {
      if (demo) {
        await seed({ db, crypto, clock, service });
        clock.runFrom(env.HUB_DEMO_NOW || DEMO_NOW);
      } else {
        db.exec(SCHEMA);                       // empty production database; first account via /api/setup
      }
      db.run("INSERT INTO meta (k, v) VALUES ('seeded', ?)", [demo ? 'demo ' + new Date().toISOString() : 'empty ' + new Date().toISOString()]);
    } else if (demo && !clock.resume()) clock.runFrom(env.HUB_DEMO_NOW || DEMO_NOW);
    db.exec(UPGRADES);                       // tables added since go-live (idempotent)
    try { await service.ensurePushKeys(); } catch (e) { console.error('push keys not created', e && e.message); }
    await service.sealLegacySecrets();      // S4: authenticator secrets encrypted at rest
    try { await service.recordRestores(); } catch (e) { console.error('restore log not recorded yet', e); }
    this.hub = { db, clock, crypto, service };
    const devReset = env.HUB_DEV_RESET === '1' ? Object.assign(() => this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();      // wipes the DO's SQLite database and alarm
      this.hub = null; await this.boot();
    }), { tick: async ({ advanceMinutes = 0 } = {}) => { if (clock.advance) clock.advance(Math.max(0, Math.min(1440, Number(advanceMinutes) || 0)) * 60000); return this.hub.service.tick(); } }) : null;
    this.handler = createHttpHandler({
      service, secureCookies: env.HUB_SECURE_COOKIES === '1',
      demo: demo ? { people: () => demoPeople(this.hub.db, this.hub.crypto, this.hub.clock.now()), deviceToken: () => this.hub.db.get("SELECT v FROM meta WHERE k='demo_device_token'").v,
        // Test copy only: wipe the invented data and seed it again (clock back to the sample start).
        reset: () => this.ctx.blockConcurrencyWhile(async () => { await this.ctx.storage.deleteAll(); this.hub = null; await this.boot(); }) } : null,
      devReset,
      turnstile: makeTurnstile({ siteKey: env.TURNSTILE_SITE_KEY, secret: env.TURNSTILE_SECRET, fetch: (...a) => fetch(...a) }),
      bootstrapCode: !demo && env.HUB_BOOTSTRAP_CODE ? env.HUB_BOOTSTRAP_CODE : null,
      gotoWebhookSecret: env.GOTO_WEBHOOK_SECRET || null
    });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(request) {
    await this.ready;
    if (this.restartPending) return new Response(JSON.stringify({ error: 'restoring', message: 'The Hub is restoring data. Try again in a minute.' }), { status: 503, headers: { 'Content-Type': 'application/json', ...SEC_HEADERS } });
    // Read the whole body up front: handlers that ignore the body must not
    // leave the stream half-read when the response is sent.
    if (!['GET', 'HEAD'].includes(request.method)) request = new Request(request, { body: await request.arrayBuffer() });
    const res = await this.handler(request, { clientKey: request.headers.get('cf-connecting-ip') || 'local' });
    // A restore was just scheduled: answer first, then restart so Cloudflare applies it.
    if (this.restartPending) setTimeout(() => this.ctx.abort('point-in-time restore'), 250);
    return res;
  }

  // Scheduler: reminders, escalations and notification retries.
  async alarm() {
    await this.ready;
    try { await this.hub.service.tick(); await this.hub.service.pushTick(); }
    finally { await this.ctx.storage.setAlarm(Date.now() + TICK_MS); }
  }
}

// Durable log of restores, kept outside the Hub's database (which a restore rewinds).
export class RestoreLog extends DurableObject {
  async add(entry) { await this.ctx.storage.put('e:' + entry.requestedAt + ':' + entry.id, entry); return true; }
  async patch(id, fields) {
    const all = await this.ctx.storage.list({ prefix: 'e:' });
    for (const [k, v] of all) if (v.id === id) { await this.ctx.storage.put(k, { ...v, ...fields }); return true; }
    return false;
  }
  async list() { return [...(await this.ctx.storage.list({ prefix: 'e:' })).values()]; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.HUB.get(env.HUB.idFromName('tag-hub'));
      return stub.fetch(request);
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
    if ((out.headers.get('content-type') || '').includes('text/html')) out.headers.set('Cache-Control', 'no-store');
    return out;
  }
};
