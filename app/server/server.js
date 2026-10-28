// TAG Employee Hub R1.1 — isolated Node prototype server. Synthetic data only.
// Run: npm start   (no production integrations, nothing is sent)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../core/service.js';
import { makeCrypto } from '../core/webcrypto.js';
import { seed, demoPeople, DEMO_NOW, PILOT_START_WEEK } from '../core/seed.js';
import { createHttpHandler, SEC_HEADERS } from '../core/http.js';
import { nodeDb, switchableClock } from './node-adapters.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const DEMO_PEPPER = 'demo-pepper-not-secret-0001';

export async function createHub({ demoNow = process.env.HUB_DEMO_NOW || DEMO_NOW, config = {}, autoTick = false, senders = {}, platform = {} } = {}) {
  const db = nodeDb();
  const clock = switchableClock();
  const crypto = makeCrypto({ pepper: process.env.HUB_PEPPER || DEMO_PEPPER });
  const service = createService({ db, crypto, clock, senders, platform, config: { demo: true, pilotStartWeek: PILOT_START_WEEK, ...config } });
  await seed({ db, crypto, clock, service });
  await service.sealLegacySecrets();
  await service.ensurePushKeys();
  clock.runFrom(demoNow === 'real' ? new Date() : demoNow);
  await service.seedDemoDocs();   // invented sample documents (demo only)
  let timer = null;
  if (autoTick) timer = setInterval(() => service.tick().catch(e => console.error('[hub] tick failed:', e.message)), 15000);
  return { db, clock, crypto, service, stop: () => clearInterval(timer) };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export function createServer(hubRef, { secureCookies = false, devReset = false } = {}) {
  const current = () => hubRef.hub;
  const handlerFor = () => createHttpHandler({
    service: current().service, secureCookies,
    demo: {
      people: () => demoPeople(current().db, current().crypto, current().clock.now()),
      deviceToken: () => current().db.get("SELECT v FROM meta WHERE k='demo_device_token'").v,
      reset: async () => { current().stop(); hubRef.hub = await createHub(hubRef.options); handler = handlerFor(); }
    },
    devReset: devReset ? Object.assign(async () => { current().stop(); hubRef.hub = await createHub(hubRef.options); handler = handlerFor(); }, {
      tick: async ({ advanceMinutes = 0 } = {}) => { current().clock.advance(Math.max(0, Math.min(24 * 60, Number(advanceMinutes) || 0)) * 60000); return current().service.tick(); }
    }) : null
  });
  let handler = handlerFor();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let size = 0;
      for await (const ch of req) { size += ch.length; if (size > 2_300_000) { res.writeHead(413); return res.end(); } chunks.push(ch); }
      const host = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
      const request = new Request('http://' + host + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await handler(request, { clientKey: req.socket.remoteAddress || 'x' });
      const headers = {};
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      if (setCookies.length) headers['set-cookie'] = setCookies;
      res.writeHead(response.status, headers);
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(WEB, decodeURIComponent(p)));
    const buf = file.startsWith(WEB) && req.method === 'GET' ? await readFile(file).catch(() => null) : null;
    if (!buf) { res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8788);
  const options = { autoTick: true };
  const hubRef = { hub: await createHub(options), options };
  createServer(hubRef, { devReset: process.env.HUB_DEV_RESET === '1' }).listen(port, '127.0.0.1', () => {
    console.log(`TAG Employee Hub R1.1 prototype (DEMO, synthetic data) on http://127.0.0.1:${port}`);
    console.log(`Demo clock starts at ${process.env.HUB_DEMO_NOW || DEMO_NOW}. Each sample person has their own PIN (shown on the demo sign-in screen).`);
  });
}
