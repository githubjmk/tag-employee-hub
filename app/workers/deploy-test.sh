#!/bin/bash
# TAG Employee Hub R1.2 — deploy the TEST COPY (sample data only) to Cloudflare.
# Creates/updates only the Worker "tag-employee-hub-test". Touches no other Worker.
# Run from macOS Terminal:  bash <this folder>/deploy-test.sh
set -euo pipefail
cd "$(dirname "$0")"
W="npx --yes wrangler@4"
echo "== Signed in to Cloudflare as:"; $W whoami
echo "== Deploying tag-employee-hub-test (sample data only)"
$W deploy --env test
# The pepper is set once and never changed (changing it would invalidate every PIN).
if $W secret list --env test 2>/dev/null | grep -q '"HUB_PEPPER"'; then
  echo "== HUB_PEPPER already set; leaving it unchanged"
else
  echo "== Setting a random HUB_PEPPER (never displayed)"
  openssl rand -hex 32 | $W secret put HUB_PEPPER --env test
fi
echo
echo "== Done. Copy the workers.dev address shown above (https://tag-employee-hub-test....workers.dev) back to Claude."
