# 4. Revised test results (R1.2)

Every result below comes from the final run on 2026-10-14, after all R1.2 changes. Raw output is in [`evidence/`](evidence/).

| Suite | Runtime | Result | Raw output |
|---|---|---|---|
| API acceptance + security (`npm test`) | Node 22 | **36/36 passed** | `evidence/r12-api-run.txt` |
| Browser suite U1–U10 (Playwright, Chromium, axe-core) | Node server | **10/10 passed** | `evidence/r12-ui-node-run.txt`, `r12-ui-node-results.json` |
| Browser suite U1–U10 | Local Cloudflare Workers + Durable Object | **10/10 passed** | `evidence/r12-ui-workers-run.txt`, `r12-ui-workers-results.json` |
| Workers smoke W1–W6, including a full restart | Local Workers | **6/6 passed** | `evidence/r12-workers-smoke-run.txt` |
| Single-file demo smoke (phone + tablet, network blocked) | Browser | **passed** | `evidence/r12-demo-smoke-run.txt` |

Wrangler 4.20.0 was used for the local Workers runs (`evidence/r12-wrangler-version.txt`). Nothing was deployed.

## R1.3 QuickBooks Time "My hours", 2026-10-27

Results:
- API: 69/69 passed (includes QB-01…QB-04).
- Browser U1–U15: 15/15 passed on Node and 15/15 on local Cloudflare.
- Workers smoke: 6/6 passed.

What the new tests check:
- QB-01:
  - Only GET requests go to rest.tsheets.com, with the token; pages are followed.
  - The fields are mapped correctly.
  - A refused token gives a clear message.
  - No token means no connection.
- QB-02:
  - Only full access can link accounts.
  - A matching name is only a suggestion until someone clicks it.
  - One QuickBooks Time person per account.
- QB-03: own hours only, for this week and last week, per day, and whether the person is on the clock.
- QB-04:
  - The live Hub without a token shows nothing.
  - A refused token returns a 502 with an explanation.
- U15: admin linking, the My hours card, and no card when the account isn't linked.

Not tested against the real QuickBooks Time account yet. That happens when the token is added to the live Hub.

## R1.3 everyday experience, 2026-10-26

Phone reminder tests PU-01…PU-07 (`tests/push.test.mjs`):
- VAPID keys are made by the Hub, with the private key encrypted at rest.
- Endpoints are limited to real push services; reminders are refused on shared devices; one entry per phone.
- Off by default, and only full access can switch them on.
- Friday "open" goes once per phone and only to people who haven't signed. The request carries no content and is signed with the Hub key; the test verifies that signature.
- The phone gets the text once, and it is not personal.
- Monday 9:00 "due today" goes only if last week is still unsigned; nothing outside work hours.
- A phone that turned notifications off (410) is removed.
- A test message goes only to the person who asked; deactivation removes their phones.
- "My week" review data is checked.

Browser tests:
- U14: translation is off; the manifest, icons and worker are served; the install tip shows and can be dismissed; the My week card shows; there is no staff badge; the reminders section and the Admin switch work.
- U1–U13 were updated for one question per screen. U5 checks that a keyboard choice never skips ahead.

## R1.3 Face ID / fingerprint sign-in (passkeys), 2026-10-25

| Suite | Runtime | Result |
|---|---|---|
| API (`npm test`: 45 existing + 13 passkey tests PK-01…PK-13) | Node 22 | **58/58 passed** |
| Browser suite U1–U13 (U13 = Face ID, Chromium virtual authenticator) | Node server | **13/13 passed** |
| Browser suite U1–U13 | Local Cloudflare Workers + Durable Object (wrangler 4.92.0) | **13/13 passed** |
| Workers smoke W1–W6, including a full restart | Local Workers | **6/6 passed** |
| Upgrade check: a database made by the code that is live today, then started with the new code | Local Workers, production mode | account kept; new tables added; Face ID challenge works |

What the passkey tests check (real ECDSA P-256 and RSA keys, real CBOR/DER encodings from a software authenticator):
- **Setup:**
  - refused on a registered shop tablet;
  - refused for a wrong web address, wrong challenge, wrong ceremony type, or no Face ID/fingerprint ("user verified" flag);
  - only the public key is stored; the challenge works once.
- **Sign-in:**
  - creates a personal session without the PIN;
  - replays, tampered signed data, wrong origin, wrong relying party, approvals after 5 minutes, unknown or removed phones, deactivated people and the wrong person are all refused;
  - failures never touch the PIN lockout;
  - an old signature counter (a copied key) is refused;
  - RSA keys work.
- **Signing the report:**
  - no PIN, and the approval is bound to the exact answers;
  - changed answers, another person, a sign-in-only approval, a second use or more than 5 minutes: refused, nothing signed;
  - the record says "passkey", names the phone and keeps the hash of the approved content, with the Face ID wording of the statement;
  - PIN signing is unchanged; supervisor sign-off stays PIN only.
- **Management:**
  - Face ID counts as the second step;
  - the owner, or the person's own manager for staff, removes phones, which ends that person's sessions;
  - staff cannot remove others' phones.
- **HTTP:**
  - same HttpOnly SameSite=Strict session cookie;
  - the web address comes from the request;
  - CSRF header required;
  - refused with the shop-tablet cookie.
- **U13 (real browser WebAuthn):**
  - offer after a PIN signing; set up on the phone;
  - the portal greets the person and Face ID signs them in;
  - "who are you" is skipped, and Sign with Face ID works without a PIN; the record shows "passkey";
  - "Use my PIN instead" is available;
  - More lists phones; management removes them and Face ID then falls back to the PIN;
  - axe accessibility checks on the new screens.

Not tested here: a physical iPhone/Android. The test copy is where to try that (passkeys made on the test copy only work on the test copy).

## The R1.2 brief's test list

| Brief §6 item | Tests | What is checked |
|---|---|---|
| Individual employee authentication | API 01, 03b, R12-01, R12-02; UI U1, U9 | ID + PIN from any browser in one step for staff. Management adds an authenticator code, and codes can't be replayed. Staff land on the survey; management land on the dashboard. |
| PIN guessing protections | API 03c, R12-04; UI U7 | 5 wrong PINs → 15-minute lock (even the right PIN is refused). 3 lockouts → locked until reset. Wrong signing PINs count. HTTP limit of 30 attempts per minute per client IP. Weak and too-short or too-long PINs refused. |
| Unauthorized access to other employees' records | API 02, 23, R12-03 | Records, drafts, corrections, responses, safety reports, evidence and downloads all refused (404) to other staff. Attempts are audited. |
| Employee and management permission boundaries | API 13, 15, R12-03 | Staff refused 11 management actions. Team-access management sees only its own team's answers and can't administer accounts. Full access sees all. A role change ends sessions. |
| PIN reset and first-login change | API 03b, R12-01; UI U7, U9 | Temporary PIN: 8 digits, single use, 72-hour expiry. It cancels the old PIN and ends sessions, and nothing else works until a new PIN is chosen. Who may reset (own manager for staff, full access for anyone, never yourself). Only hashes are stored. |
| Shared-tablet session termination | API 19; UI U2 | 5-minute idle on shared sessions (warning at 4 minutes). Auto sign-out 20 seconds after submitting. Sign-out revokes the session. Nothing private is left in browser storage. A revoked tablet ends its sessions. |
| Electronic signature PIN verification | API 03, 09, 14; UI U1, U6 | Someone else's PIN in an open session can't sign. The acknowledgment box and PIN are required. Consent is given with the first signature and the exact consent text is shown (U9). Paper choice is respected. The record holds signer, method, statement, version, time and device. |
| Immutable signed submissions | API 11, 12; Workers W6 | Database triggers block changes. The integrity check catches tampering. Corrections are separate signed records. Records verify after a restart. |
| Safety reporting | API 16, 16b, 17, 18, R12-05; UI U1 | Urgent first. Designated safety contacts and the reporter's manager are alerted. Escalation reaches all management at level 2. Retries and failures are visible. Verification must be done by someone other than the fixer. |
| Work-hours window (added: always paid time) | API 05, R12-06; UI U10 | After hours, drafts, signing, corrections and responses are refused and the screen says when it opens next. A late report can be signed the next morning. Safety reports work at any hour. |
| Production pieces | API R12-07 (first-account setup), R12-08 (GoTo texting against a simulated GoTo: sent ≠ delivered, receipts, retry, 5-minute no-receipt rule, rotated sign-in token), R12-09 (Turnstile required when configured, webhook secret, CSRF unchanged) | Real GoTo and real Turnstile are not yet connected; they are verified in the test copy. |
| Management review | API 14, 14b; UI U1, U8 | Questions block sign-off. The supervisor signs off with acknowledgment + PIN. Closure rules apply. "Seen" is not agreement. The injury follow-up is hidden from the reviewing manager. |

The R1.1 coverage (calendar, partial weeks, drafts, duplicates, time zones, dashboard, Spanish at 320 px, accessibility, keyboard-only use, network failure) still runs and passes. See the full list in `evidence/r12-api-run.txt`.

## "Finished in a few minutes"

- **Staff:** U1 and U9 drive the real flow on the tablet and on a phone. For a person, that flow is about 20 taps:
  - employee ID and PIN;
  - four answers and three "Next" taps;
  - the checkbox and PIN again;
  - Sign & submit.
- **Automated timing:** the scripted run took under 2 seconds. That measures software speed, not human time. Real timing will come from the pilot (target: under 5 minutes).

## Not tested

- Real SMS delivery: simulated by design.
- The scheduler firing every minute on real Cloudflare, and point-in-time restore. Both are planned for the approved test copy.
- Manual screen-reader pass.
- Real tablets and phones: the browser emulated 390×844, 820×1180 and 320×640.
- Some settings are covered by code review only:
  - the PBKDF2 iteration count;
  - the 30-minute management idle limit;
  - the alert routing fallback to all managers when no safety contact is active;
  - resetting an authenticator from Accounts.

## Live test copy on Cloudflare (2026-10-14)

Deployed by the owner from his Mac with `deploy-test.sh` (Worker `tag-employee-hub-test`, sample data only, `HUB_DEV_RESET=0`, Secure cookies). Checked from the cloud with `tests/live_check.py` against https://tag-employee-hub-test.joshua-kaye.workers.dev. Evidence: `evidence/r12-live-check-run.txt` and `evidence/r12-live-check-results.json`.

| Check | Result |
|---|---|
| L1 Security headers on page and script | Pass |
| L2 Request header, size limit and sign-in required | Pass (403 / 413 / 401) |
| L3 Reset and clock endpoints switched off | Pass (404) |
| L4 Staff sign-in with ID + PIN; cookie HttpOnly, Secure, SameSite=Strict | Pass |
| L5 Sign and submit; retry gives the same record; record verifies | Pass |
| L6 Staff refused on Employee Accounts | Pass (403) |
| L7 Wrong PIN refused, correct PIN accepted | Pass |
| L8 Management needs the authenticator code | Pass |
| L9 Audit chain and 111 signed records verify | Pass |
| L10 Scheduler runs on its own: an unacknowledged urgent sample report escalated after 15 minutes | Pass (2 escalation alerts queued, 15.1 minutes) |

**10/10 passed.** The UI browser suite and Workers smoke test were not run against the live copy, because they need the reset and clock endpoints, which stay switched off on a reachable address. They passed locally on the Workers runtime (above).

**Not yet done on the live copy:** a point-in-time restore drill. The Worker has no restore control yet. Adding one is a management-only, audited action that needs its own small build and test before it is used.

Note: Cloudflare refuses requests with Python's default user agent (403), so the live check sends its own.


## Pre-pilot safeguards (2026-10-14, after the test copy went live)

Full local run after adding encrypted authenticator secrets, point-in-time restore and backup download (evidence `r12-*` files, overwritten by this run):

| Suite | Result |
|---|---|
| API (Node) | **42/42** — new R12-10 (secrets encrypted at rest, older values encrypted at start-up, a different pepper cannot read them), R12-11 (restore: full access only, PIN + authenticator + typed RESTORE, 30-day window, durable log copied into the audit chain, undo), R12-12 (backup: full access only, no sign-in secrets, fingerprint, audit-chain head, audited) |
| Browser (Node server) | **11/11** — new U11 Restore & backup page; backup downloads; management without full access does not see it |
| Browser (Cloudflare runtime, `wrangler dev`) | **11/11** — U11 shows the restore form, because the restore log binding exists there |
| Workers smoke | **6/6** |
| Demo build + smoke | ok |

**What these tests do not show:** the restore itself. Cloudflare's point-in-time API does not run locally, so R12-11 uses a stand-in for it. A real restore drill on the live test copy is the next step: restore to a moment before a sample change, check the change is gone and the restore is in the audit log, then undo.

### Restore drill on the live test copy (2026-10-14, after the second deploy)

`tests/restore_drill.py` against https://tag-employee-hub-test.joshua-kaye.workers.dev (evidence `evidence/r12-restore-drill-run.txt`, `r12-restore-drill-results.json`):

1. Noted T0, waited 70 seconds, then added a sample account `DRILL-A21B3C` (the "mistake").
2. Restored to T0 as a full-access manager (PIN + authenticator + RESTORE). The Hub was back in about 6 seconds.
3. The sample account was gone, the restore was in the restore log, and the audit chain verified (227 events).
4. Undid the restore. The sample account was back after about 6 seconds, and the chain verified.
5. A backup export from the live copy shows both restores in the audit chain (`system.restored` RS-19BAC8C522 and RS-DB9444B3FA), plus `security.secrets_sealed`, which confirms the existing authenticator secrets were encrypted when the new version started.

**Passed.** This was sample data on the test copy only.


## Open portal and one-PIN signing (2026-10-15)

Full local run (evidence `r12-*` files, overwritten by this run): **API 43/43**, **browser 12/12 on the Node server**, **browser 12/12 on the Cloudflare runtime**, **Workers smoke 6/6**, and the demo build and smoke ok.

New checks:
- **R12-13:** the public info names no one; the name list is refused without a registered tablet (403 over HTTP too), leaves out deactivated people, and contains no PIN or secret.
- **U12:**
  - The open portal shows no employee names outside the demo panel.
  - On a phone: ID, then questions, then a wrong PIN is refused with nothing signed, then the right PIN signs with the record verified. The ID is remembered for next time, and signing out returns to the portal with the session gone (401).
  - On a registered shop tablet: tap your name, answer, PIN, signed. It then counts down to sign itself out and does not remember who signed.
- **Manual check on the Cloudflare runtime with Cloudflare's test keys:** the bot check rendered invisibly (no visible box) and the one-PIN report signed.

## Onboarding email (2026-10-27, commit a0015e7)
- API: 75/75 (`npm test`), including IN-01…IN-06. These cover the Resend request from info@innerspacecases.com; the preview-only test copy; the single-use 72-hour link; PIN and session on accept; a fresh authenticator code for management; login by email; who can invite; and revoke and deactivation.
- Browser: 17/17 on the Node server and 17/17 on local Cloudflare (wrangler dev), including U17. U17 covers adding a person with an email, the styled email preview, opening the link on a phone, choosing a PIN, landing in the guided setup, the link refusing a second use, and the setup list showing Invited and PIN.
- Not tested: a real email delivery. That needs the live `RESEND_API_KEY`, which has not been added.

## Choose-your-PIN page and My InnerPoints (2026-10-27)
- API: 79/79 (`npm test`), including IP-01…IP-04. These cover:
  - read-only queries to the InnerPoints ledger only, with paging;
  - reversed points left out;
  - dropped or changed fields and refused tokens stopping with a message;
  - linking by full access only;
  - hide/show;
  - no card when not connected.
- Browser: 18/18 on the Node server and 18/18 on local Cloudflare. This includes U17, now as a new iPhone: the new PIN page, the mismatch caught on the phone, Show PIN, letters dropped, then the guide with moving pictures. It also includes U18: linking in Admin → InnerPoints, the card on Home above My weekly reports, and no card for unlinked people.
- Not tested: real Quickbase data. That needs the live `QB_TOKEN`, which has not been added.

## Management Home (2026-10-27, commit 4d4a206)
- API: 79/79. Browser: 19/19 on the Node server and 19/19 on local Cloudflare. This includes U19 (managers land on Home, see the Your team card, and reach the dashboard and accounts) and the updated U1.

## Company documents (2026-10-27)
- API: 85/85, including DOC-01…DOC-06. These cover:
  - the sample-only test copy;
  - drafts visible only to full access;
  - PIN signing (box, PIN and text fingerprint required);
  - the statement kept in the language signed;
  - signatures that are append-only;
  - new versions (everyone signs again, old signatures kept);
  - who-has-signed scope;
  - Face ID approval bound to the version and language;
  - archive and restore;
  - the size limit.
- Browser: 21/21 on the Node server and 21/21 on local Cloudflare, including U21 (Home to-do, then read, then sign with PIN; manager: new, save, publish with two taps, then who has signed).

## Time off and My time (2026-10-27)
- API: 89/89, including TO-01…TO-04. These cover:
  - date checks, overlaps, and the person's manager being told;
  - deciding by their manager or full access only, never their own, with a note required to decline and who else is off shown;
  - approved days excusing the weekly report, and cancelling bringing it back, with no medical reason stored;
  - entering in-person requests and approving them at once;
  - staff calendar privacy.
- Browser: 22/22 on the Node server and 22/22 on local Cloudflare, including U22 (request, then manager Home to-do, then approve, then Approved and the calendar).

## Before go-live of R1.3 features (2026-10-27, commit cc8b3cc)
- **Independent review:** two separate reviewers (server; web and HTTP) covered everything changed since the last live deploy. They found 1 high, 6 medium and 9 low issues. All were fixed and re-checked by the same reviewers, except two owner-policy items left as they are: signing documents outside work hours, and the registered-devices setting, which is off.
- **API:** 90/90 (`npm test`).
- **Browser:** 22/22 on the Node server and 22/22 on local Cloudflare (wrangler dev), on the final code.
- **Upgrade:** a production-mode database made by the live version (d72afb3) started on the new code with no errors. New tables were created, the account was kept, `/api/demo/reset` returned 404, and documents required sign-in.
- **Not tested:** real email delivery (needs `RESEND_API_KEY`) and real Quickbase/QuickBooks Time data (need `QB_TOKEN` / `QBT_TOKEN`).

## Live deploy 2026-10-27 22:23 PT (owner: "Yes, deploy live now")
- Commit 22af4e3, Worker version dbe3f61b-6ab9-4f93-9dba-f158716a2212, via the GitHub workflow (target live); tests passed in CI.
- Checked: production mode, the new routes respond, the demo reset returns 404, documents and time off need sign-in, the portal and the welcome-link page render, and there were no console errors in Chrome.
- Found after deploy: the sign-in and welcome-link pages were not centred on wide screens (an old 860px rule). Fixed on the test copy (next live deploy).

## Live deploy 2026-10-29 09:39 PT (owner: "please deploy now so we can test with Nicoletta")
- Commit caf06b0, Worker version 75c245ee-469d-4af9-a895-9ebc13eb5cc9, via the GitHub workflow (target live); CI tests passed.
- Includes the onboarding checklist, the "Already works here / New hire" choice, and the centred sign-in page.
- Checked: production mode, the onboarding actions need sign-in, the demo reset returns 404, the new code is served, the sign-in page is centred in Chrome, and there were no console errors.
