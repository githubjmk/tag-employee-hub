# TAG Employee Hub

The Armored Group / Innerspace Cases employee portal: weekly performance & safety report with PIN signing, safety reports, and management review.

- **Live:** https://hub.innerspacecases.com (Cloudflare Worker `tag-employee-hub`, real data)
- **Test copy:** https://tag-employee-hub-test.joshua-kaye.workers.dev (sample data only)

## How updates go out
`.github/workflows/deploy.yml` runs in GitHub's cloud:
- push to `main` → API tests → deploy the **test copy**;
- **live** deploys only by hand: Actions → "Test and deploy" → Run workflow → `live`.

## Layout
- `app/core` — service logic (sign-in, surveys, safety, audit chain), shared by every runtime
- `app/web` — the page (vanilla JS, no build step)
- `app/workers` — Cloudflare Worker + Durable Objects, `wrangler.toml` (envs `test`, `production`)
- `app/server` — local Node server for development and tests
- `app/tests` — API tests (`npm test` in `app/`), browser tests, live checks
- `docs` — design, changes, test results, blockers, pilot plan

Never put real employee data in the test copy.
