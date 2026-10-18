# TAG Weekly Report — R1.2 prototype (simplified sign-in)

This is an isolated prototype of the weekly performance and safety report. It uses **synthetic data only** and has **no production integrations**. Every signature it creates is marked DEMO and is not legally operative. Nothing here has been deployed.

There is one platform-neutral core (`core/`) and three ways to run it:

| Runtime | Command | Storage | Use |
|---|---|---|---|
| Node 22.13+ | `npm start` → http://127.0.0.1:8788 | in-memory `node:sqlite` | Development and the main test suites |
| Cloudflare Workers + Durable Object, **local only** | `cd workers && wrangler dev` → http://127.0.0.1:8787 | Durable Object SQLite, persisted under `workers/.wrangler/` | Proves the planned production platform runs the same code |
| Single HTML file | `node demo/build.mjs <esbuild> <sql-wasm.wasm>` → `demo/dist/tag-weekly-report-r12-demo.html` | sql.js in the browser tab | Click-through demo, nothing saved |

There are no npm runtime dependencies. Wrangler, esbuild and sql.js are only needed for the Workers run and the demo build.

## Run and test

```bash
npm start                                  # demo clock starts Fri 2026-10-16 10:30 PT and runs in real time
npm test                                   # 36 API acceptance + security tests (node:test)
python3 tests/ui_test.py                   # 10 browser tests (Playwright + Chromium + axe-core)
node tests/verify_paper.mjs ../docs/evidence/paper-form-page1-redacted.txt   # questionnaire vs paper form

cd workers && wrangler dev                 # local Workers runtime (needs workers/.dev.vars with HUB_PEPPER)
HUB_BASE=http://127.0.0.1:8787/ python3 tests/ui_test.py    # same browser tests against the Workers runtime
WRANGLER=$(which wrangler) python3 tests/workers_smoke.py   # Workers-specific checks incl. restart persistence
```

Environment variables (Node):
- `PORT`
- `HUB_PEPPER` (a demo value is used if unset)
- `HUB_DEMO_NOW` (`real` to use the current time)
- `HUB_DEV_RESET=1` (enables `/api/dev/reset` and `/api/dev/tick`; tests only)

## Sample people (all invented)

Sign in with an employee ID and PIN from any browser; the demo sign-in screen lists everyone's PIN, and the current authenticator code for management accounts. Leave "Shared or shop tablet" checked on a shared device (5-minute idle sign-out and sign-out after submitting); uncheck it on your own phone.

| Person | Role | Shows |
|---|---|---|
| Jordan Demo (E-107), Luis Ejemplo (E-105, Spanish) | Staff | Lands straight on this week's survey; sign with checkbox + PIN; confirmation and own copy |
| Maria Sample (E-104, Spanish) | Staff | A pending question from her manager |
| Kim Testwell (E-106) | Staff | Already signed this week; correction after sign-off; a confidential near miss |
| Rosa Muestra (E-108) | Staff | Use her to see the lockout after 5 wrong PINs |
| Nina Newhire (E-110) | Staff | First sign-in with a temporary PIN, then choose her own PIN |
| Terry Former (E-111) | Staff (deactivated) | Sign-in refused |
| Dana Lead (E-102) | Management | Review surveys for her team, corrective actions, PIN resets for her staff |
| Pat Safety (E-103) | Management, safety contact | Urgent safety alerts, safety issues |
| Morgan Admin (E-101) | Management, full access, safety contact | Everything, including Employee Accounts (add people, reset PINs and authenticators, deactivate) |

## Layout

```
core/       service.js (all rules and authorization), permissions.js (two visible roles -> internal permissions),
            schema.js, templates.js (questionnaire versions),
            seed.js (synthetic data), http.js (API handler), render.js (printable record),
            time.js, sha256.js, webcrypto.js, totp.js, canonical.js
server/     Node server + node:sqlite adapter
workers/    Worker + Durable Object (local dev only), wrangler.toml, DO SQLite adapter
web/        UI (vanilla ES modules, no build step), styles.css, i18n.js (EN/ES)
demo/       single-file browser demo build
tests/      api.test.mjs, ui_test.py, workers_smoke.py, demo_smoke.py, verify_paper.mjs, screens/
```

Documentation: `../docs/` (R1.2 design, changes, tests, blockers, pilot plan). The R1.1 deliverables (A–K) in `../../r1.1/docs/` still apply except where the R1.2 change list says otherwise.
