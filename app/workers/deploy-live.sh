#!/bin/bash
# TAG Employee Hub — deploy the LIVE Hub at hub.innerspacecases.com (owner go-ahead 2026-10-15).
# Creates/updates only the Worker "tag-employee-hub". Touches no other Worker.
# Run from macOS Terminal:  bash app/workers/deploy-live.sh (from the repository folder)
set -euo pipefail
cd "$(dirname "$0")"
W="npx --yes wrangler@4"
E="--env production"

echo "== Signed in to Cloudflare as:"; $W whoami
echo "== Deploying the live Hub (Worker tag-employee-hub -> hub.innerspacecases.com)"
$W deploy $E

have() { $W secret list $E 2>/dev/null | grep -q "\"$1\""; }

# Encryption pepper: set once, never changed (changing it would make every PIN and authenticator unusable).
if have HUB_PEPPER; then
  echo "== HUB_PEPPER already set; leaving it unchanged"
else
  echo "== Setting a random HUB_PEPPER (never displayed)"
  openssl rand -hex 32 | $W secret put HUB_PEPPER $E
fi

# One-time setup code for creating the first (owner) account. Shown only in this Terminal.
if have HUB_BOOTSTRAP_CODE; then
  echo "== Setup code already set (it was shown when it was created)"
else
  CODE=$(openssl rand -hex 8)
  printf '%s' "$CODE" | $W secret put HUB_BOOTSTRAP_CODE $E
  echo
  echo "############################################################"
  echo "  ONE-TIME SETUP CODE (write it down now; shown only here):"
  echo
  echo "      $CODE"
  echo
  echo "  Open https://hub.innerspacecases.com to create your account."
  echo "############################################################"
  echo
fi

# Bot check: only switched on after the widget lists the live address, otherwise sign-in would fail.
if have TURNSTILE_SECRET; then
  echo "== Bot check already on"
else
  read -r -p "Have you added hub.innerspacecases.com and tag-employee-hub.joshua-kaye.workers.dev to the Turnstile widget's hostnames? [y/N] " A
  if [[ "$A" =~ ^[Yy] ]]; then
    printf '%s' "0x4AAAAAAFYGcmWisZSw7KWk" | $W secret put TURNSTILE_SITE_KEY $E
    echo "Paste the Turnstile SECRET key (the same one you used for the test copy):"
    $W secret put TURNSTILE_SECRET $E
  else
    echo "== Bot check left off for now (PIN lockouts still protect sign-in). Run this script again after adding the hostnames."
  fi
fi

echo
echo "== Done. Open https://hub.innerspacecases.com (the very first time the address can take a few minutes)."
echo "   Backup address: https://tag-employee-hub.joshua-kaye.workers.dev"
