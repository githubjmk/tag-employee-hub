# 3. Exact changes from R1.1

**Scope.** R1.2 is a copy of the R1.1 app in `r1.2/app/`; R1.1 is untouched. The complete line-by-line diff is in `evidence/r11-to-r12.diff`.

**Unchanged:**
- the questionnaire wording (paper Q1–Q4, verbatim);
- the database schema;
- the API boundary (`core/http.js`);
- tamper-evident records, amendments and review history;
- safety and corrective-action workflow;
- the dashboard;
- the Workers/Durable Object adapter.

## Authentication (`core/service.js`)

| R1.1 | R1.2 | Why |
|---|---|---|
| Staff PIN sign-in only on a registered shop tablet (`pinOnlyOnRegisteredDevices: true`) | Any browser (`false`). Registered tablets stay optional and still mark the session as shared. | Brief §1: no device requirement |
| PIN exactly 6 digits | 6–12 digits, same weak-PIN rules extended to longer PINs | "six digits or longer" |
| First sign-in or reset used an 8-character **setup code** in a separate form; the old PIN kept working until it was used | 8-digit **temporary PIN** typed in the normal PIN box; issuing it cancels the old PIN and ends sessions; valid 72 h instead of 24 h | One sign-in form; "temporary PIN"; a reset really resets |
| `auth.issueSetupCode` | `accounts.resetPin` (old name kept as an alias) | Plain naming |
| Supervisors, safety, managers, HR needed TOTP | Every **Management** account needs TOTP; Staff never do | Brief §2: management MFA, no authenticator for staff |
| Lockout messages mentioned "HR or your supervisor" and "setup code" | "Ask management for a temporary PIN" | Two visible roles |
| — | New `accounts.list / create / update / deactivate / reactivate` | Management can create accounts, reset PINs, deactivate |

## Roles (new `core/permissions.js`)

- **Two visible roles,** Staff and Management, plus two account options for Management:
  - Full access → internal `hr`;
  - Safety contact → internal `safety`.
- **Internal capability roles unchanged:** `employee`, `supervisor`, `manager`, `safety`, `hr`. Server checks are unchanged apart from the routing below.
- **`session.me`** now returns `role`, `fullAccess`, `safetyContact` and a `permissions` list.
- **Effect on sample people:**
  - Dana (was supervisor only) is now Management. She gains `manager`: she can manage safety issues and see everyone's completion status. She still sees answers only for her own team.
  - Pat (was safety only) is now Management with the safety contact option.

## Safety alert routing

| R1.1 | R1.2 |
|---|---|
| Urgent report: owner, all safety leads, **all managers**, reporter's supervisor | Owner, **designated safety contacts**, reporter's manager. If no safety contact is active, all managers. |
| Escalation: safety, managers and HR at every level | Level 1: safety contacts + full access. Level 2 and up: all of management. |

Backup routing when a text fails is unchanged: all other management.

## Signing

| R1.1 | R1.2 |
|---|---|
| Typed full name (had to match) + affirm box + PIN | Affirm box + PIN. Signer name is taken from the account. |
| Separate e-sign consent screen before the first survey | The exact versioned consent text is shown inside the first signature. The same box records consent (`esign-consent-2`) in the same transaction, and the record notes `givenWithThisSignature`. Paper remains available; someone who chose paper cannot be signed electronically. |
| Payload `signature.typedName` | `signature.signerName`. Method: "Signed-in session + acknowledgment checked + PIN re-entered at signing". |
| Statement: "By entering my PIN, typing my name and tapping Sign & submit…" | "By checking this box, entering my PIN and tapping Sign & submit…". The rest is unchanged. This text belongs to the digital version; paper wording is untouched. |

Supervisor sign-off and employee corrections dropped the typed name the same way.

## Interface (`web/app.js`, `web/i18n.js`, `web/styles.css`)

**Sign-in:**
- One form: ID, PIN (keypad), "Shared or shop tablet" checkbox, Sign in. The code field appears only for management.
- Removed: the "This is the shop tablet / Personal phone" demo toggle and the setup-code mode.
- The demo people list moved below the form.

**After sign-in:**
- Staff go straight to this week's survey.
- Management go to the weekly completion dashboard.

**Staff:**
- Home has three large buttons: Complete Weekly Survey, Report Safety Concern, View My Previous Surveys.
- "Needs your attention" appears only when a supervisor asked a question or left a review.
- Tabs: Home, Survey, Safety, More. Alerts, PIN change and e-sign choice are under More.

**Management:**
- Tabs: Dashboard (weekly completion, with an urgent-alert banner and the person's own survey card), Review (team queues), Safety (reports + corrective actions), Accounts (new), More.

**Removed screens:**
- Admin → Shop tablets and Admin → Authenticators: tablet registration moved to Accounts → Shop tablets (optional); authenticator reset moved to each management account;
- Team → People (moved to Accounts);
- the consent screen at first sign-in (still reachable from More to change the choice).

## Work-hours window (added 2026-10-14, owner decision: no new legal review)

- New setting `surveyDuringWorkHoursOnly` is on by default. The server refuses `survey.saveDraft`, `survey.submit`, `survey.amend` and `review.respond` outside Mon–Fri 7:00 AM–3:30 PM, with code `outside_work_hours`.
- Safety reports are never blocked.
- `session.me` returns `surveyWindow` (open now, hours, next opening).
- The UI shows "Available during work hours" with the next opening time. Staff signing in after hours land on Home instead of the survey.
- Sample-data submission times were moved inside work hours.
- Tests: API 05 updated; new API R12-06 and UI U10.

## Production pieces (built 2026-10-14 after approval)

- **First-account setup:** `service.bootstrap`, `/api/setup` and a setup screen. It works only on an empty, non-demo database, with a secret code, and only once.
- **Worker modes:** `HUB_DEMO=0` runs a real clock with an empty database, ready for setup.
- **Turnstile:** `makeTurnstile` in `core/http.js` and a widget on the sign-in screen. It is off unless keys are set. The CSP allows `challenges.cloudflare.com`.
- **GoTo texting** (`core/goto-sms.js`):
  - OAuth refresh-token sign-in (rotated tokens are kept), send from the company number.
  - New notification state `sent`, cleared only by a GoTo delivery receipt. No receipt within 5 minutes counts as a failed attempt.
  - Webhook `/api/hooks/goto/<secret>` (no CSRF header, secret in the URL).
- **Mobile numbers:** new column `sms_phone`, management accounts only. Only people with a number on file are texted.
- **Test copy:** `wrangler.toml` has an `[env.test]` (sample data, Secure cookies, no reset endpoint).
- **Tests:** API R12-07, R12-08, R12-09.

## Printable record

Added after you sent the paper source: the signed record's heading now matches the paper form, "Weekly Report <Friday's date> for <name>" (`core/render.js`, checked in API test 23).

## Tests

- **API:**
  - 30 → 35 tests.
  - Updated for the new behaviour: 03, 03b, 09, 13, 14, 15, 19, 24.
  - New: R12-01 to R12-05 (account lifecycle, management MFA and role changes, permission boundaries, PIN guessing including the HTTP rate limit, designated safety contacts).
- **Browser:**
  - 8 → 9 tests, rewritten for the new sign-in.
  - New U9: management adds a person; the person signs in on a phone with the temporary PIN, sets a PIN and signs.
- **Workers and demo smoke tests:** updated for the new sign-in.

## Pre-pilot safeguards (added after the test copy went live, 2026-10-14)

- **Texting moved to v2.0** (owner decision). The GoTo sender stays in the code, switched off unless its secrets are set. Pilot alerts: dashboard banner plus telling a supervisor in person.
- **Signed-record label:** the pen icon on records is replaced by "Signed by <name>" ("Firmado por" in Spanish). No change to how people sign.
- **Authenticator secrets encrypted at rest** (blocker S4):
  - AES-256-GCM with a key derived (HKDF) from `HUB_PEPPER`, stored as `enc1:…` (`core/webcrypto.js` `sealSecret`/`openSecret`).
  - New enrolments are encrypted. Older plain values are encrypted at start-up by `sealLegacySecrets()`, which is audited as `security.secrets_sealed`.
  - Changing the pepper would make both PINs and authenticators unusable, so it is set once.
- **Point-in-time restore** (management with full access only):
  - Admin → Restore & backup. It needs the PIN, a fresh authenticator code and typing RESTORE.
  - Allowed times: at least 1 minute ago and at most 30 days back (less 1 hour of margin).
  - Uses the Durable Object PITR API (`getBookmarkForTime`, `onNextSessionRestoreBookmark`, then a restart).
  - Each request goes to a separate `RestoreLog` Durable Object, so the record survives the restore. After the restart it is copied into the audit chain (`system.restored`).
  - Every restore can be undone.
  - New Wrangler binding `RESTORE_LOG` and migration `v2`.
  - Not available on the local server or in the demo.
- **Backup download** (blocker S5, manual for now):
  - On the same page, a full-access manager downloads a complete JSON copy of all records.
  - Left out: PIN hashes, authenticator secrets, temporary-PIN hashes, tablet tokens and live sessions.
  - The file includes the audit-chain head and its SHA-256 fingerprint. Every export is audited (`backup.exported`).
  - An automatic daily copy to Cloudflare R2 would need a new storage bucket, and that needs your approval.
- **Bug fix: the bot-check widget never appeared** (found when Turnstile was switched on in the test copy). The widget box had `id="turnstile"`, and browsers expose element ids as `window` properties, so the page thought Cloudflare's script was already loaded and never fetched it. The box is now `#ts-box`. The page checks for `window.turnstile.render` before using it and shows a message if the check cannot load. Verified locally with Cloudflare's test keys (widget shows, token accepted, sign-in reaches home) and on the live copy (widget shows).
- **Look (owner feedback, 2026-10-15):**
  - Always light, on a warm paper background. Automatic dark mode is removed because the owner found it hard to read.
  - The sign-in page is light, with a navy band across the top of the card.
  - The staff home has a portal feel: a navy "TAG Employee Hub" welcome band with the date, greeting and this week's status, then the three big buttons, then company-system tiles (Order Manager, Time clock, pay stubs).
  - The accessibility checks (axe) still pass.
- **Open portal; PIN typed once (owner decision, 2026-10-15: "my team is going to think its a pain"):**
  - Signed out, the home page is an open portal: the Weekly Report, Safety and My past reports buttons, company-system tiles, and a "Management sign-in" link. Nothing personal is shown (`GET /api/public` returns the active questionnaire, the consent text, the work-hours window and links).
  - The weekly report has no separate sign-in. The person says who they are, answers, checks the box and types the PIN once.
    - Saying who you are: a phone types the employee ID once and remembers it afterwards (`localStorage hub_last_id`, not a secret). A registered shop tablet shows tap-your-name buttons instead (`GET /api/kiosk/roster`, refused without the tablet cookie).
    - Behind the scenes, that single PIN signs in for this one report (shared-device session: 5-minute idle, auto sign-out on the confirmation screen) and is re-checked as the signature. Lockouts, rate limits and the bot check apply unchanged.
    - A temporary PIN asks for a new PIN on the same screen. Management accounts are asked for their authenticator code.
    - Nothing is saved before signing (no drafts in this flow).
  - Past reports and safety reports still ask for ID + PIN first (the same sign-in page, now with the name buttons on shop tablets). Management screens still need PIN + authenticator.
  - The bot check is now invisible (`appearance: interaction-only`). It only shows a box if Cloudflare wants an interaction.
  - Signing out returns to the open portal.
  - The demo/test copy lists its invented people on the portal in a labelled demo panel.
- **Go-live day fixes (2026-10-16, from the owner's first sign-in):**
  - The real Armored Group logo (the exact asset from thearmoredgroup.com, unchanged) appears in the top bar and on the sign-in and setup screens.
  - "Start over" for the first account: with the setup code, the owner gets a new temporary PIN and authenticator secret. It only works until anyone has chosen their own PIN (API R12-15).
  - A QR code for authenticator apps on every authenticator screen (first setup, new or reset management accounts), drawn locally with the MIT `qrcode-generator` library vendored as `web/qr.js`. There are copy buttons for the temporary PIN and secret, a "shown only once" warning, numbered steps, a "PIN (or temporary PIN)" label, and a hint that the 6-digit code comes on the next step. Checked by decoding the QR image and signing in with its secret on the local Cloudflare runtime.
- **Live check script** `tests/live_check.py` runs against the deployed test copy (no reset endpoints needed).
- **Deploy script** `workers/deploy-test.sh` (the test copy only).
- **Tests:** API 39 → 43 (R12-10 encrypted secrets, R12-11 restore, R12-12 backup, R12-13 open portal: no personal data, name list only on shop tablets). UI 10 → 12 (U11 Restore & backup page; U12 open portal: one PIN at signing on a phone with a remembered ID, and on a shop tablet with the name grid; a wrong PIN is refused; signing out returns to the portal). U4, U7 and the demo smoke were updated for the portal landing.

## Not changed on purpose

- Schema and migrations: the `setup_code_*` columns now hold the temporary-PIN hash.
- Durable Object and Worker code, except for the pre-pilot safeguards above (restore log, restart after a restore, start-up encryption of older secrets).
- Notification retry logic.
- Question wording and version IDs. **Note:** the signature statement inside `WR-1.0` (and `WR-2.0-P`) was edited in place for the new signing steps. Each record stores the exact statement shown, so R1.1 and R1.2 demo records stay distinguishable. Before production, a new version ID for the edited statement is recommended.
- Paper-form baseline.

## R1.3 everyday experience (owner go-ahead 2026-10-26, "lets GO 1-7")

1. **No browser machine translation.** The page is marked `translate="no"`. The Hub has its own Spanish, and a phone's automatic translation had turned Spanish screens into wrong English ("Yam" for Name), which is a risk on a signing statement.
2. **Home-screen app.**
   - Manifest, TAG icons and a service worker that caches nothing.
   - On phones, a one-time tip explains how to add the Hub to the home screen: the Share button on iPhone, the browser's own install prompt on Android. "Not now" hides it for 30 days.
3. **One question per screen.**
   - Tapping an answer moves on after a short pause; keyboard users still use Next.
   - The optional write-in questions share one screen.
   - Review & sign lists everything, with a "Change" link per question.
   - The questions and their wording are unchanged.
4. **Calmer home.**
   - Items that need action ("your manager asked a question") come first.
   - Staff no longer see an alert count on the tab bar; management keep it for safety alerts.
   - The shared-device strip now says "Shared device — signs out automatically" instead of "Shop tablet".
5. **Clear waiting state.** Instead of a grey dashed box: "Available during work hours · opens again Tue 7:00 AM · in 9 h 26 min", or "Your weekly report opens Fri 7:00 AM · in 2 days".
6. **Phone reminders (web push), switched OFF until a full-access manager turns them on** (Admin → Reminders).
   - What is sent: "Your weekly report is open" on Friday, and "due today" on Monday 9:00 if the report is still not signed. Only during work hours, only to people who turned reminders on for their own phone (More → Reminders). On iPhone the Hub has to be added to the home screen first.
   - "Send me a test" works even while reminders are off; it only goes to the person who taps it.
   - Pushes carry no content: the phone fetches the text from the Hub, which never includes answers or names.
   - The Hub creates its own sending keys at start-up and stores the private one encrypted; nobody handles it.
   - It only ever sends to Apple, Google, Mozilla or Microsoft push addresses.
   - Deactivating a person removes their phones.
   - No GoTo and no cost. Texting stays v2.0.
7. **"My weekly reports" card.**
   - This week and last week at a glance: not signed (with the due time), signed (with the time), "waiting for Dana Lead to review", "reviewed by …", or "Dana asked you a question — Answer".

## Branding (owner 2026-10-27)
- Innerspace Cases logo in the top bar (white logo on navy) and on the sign-in card (navy logo). The logo is taken from innerspacecases.com.
- Every screen ends with "© <year> The Armored Group, Inc. All rights reserved."
- The app is named "Innerspace Employee Hub" ("Innerspace" under the home-screen icon), and the app icon uses the Innerspace logo.
- Authenticator entries keep the name "TAG Employee Hub", so people's existing authenticator codes keep working.

## Guided phone setup (owner 2026-10-27: "i need a animation or guided setup")
- **Set up this phone** has three short steps. Each one shows a moving picture of exactly what to tap:
  1. **Home screen.** iPhone: the Share button pulses, the sheet slides up and "Add to Home Screen" lights up. Android: the ⋮ menu, then "Add to Home screen".
  2. **Face ID.** A face-scan picture; the PIN (plus the code for management) and the Face ID approval happen right on that screen.
  3. **Reminders.** A notification slides in. On iPhone the step explains that the Hub must be on the home screen first.
- Steps that are already done are skipped, and every step can be skipped. It ends with "You are all set" and a checklist.
- **Where to find it:**
  - A card near the top of Home: "Set up this phone · 3 steps · about 2 minutes". "Not now" hides it for 7 days.
  - Always available under More → Set up this phone.
- The pictures are still images when the phone has "reduce motion" turned on.
- Covered by browser test U16.

## Onboarding email (owner 2026-10-27: "send them an email so its like an onboarding process")
- Accounts → Add a person has an **Email** field and a **Send the welcome email now** box (ticked). Existing people get **Send welcome email** / **Show invite QR code** buttons.
- The email (English or Spanish, by the person's language) comes from **Innerspace Employee Hub &lt;info@innerspacecases.com&gt;** (owner 2026-10-27), so replies land in the info@ mailbox. It has one button, **Set up my account**, and the steps.
- The link works **once, for 72 hours**. A new invite cancels the old one; deactivating someone cancels theirs. Only a hash of the link is stored.
- Opening the link: "Welcome, {first name}" → choose a PIN → the guided phone setup (home-screen icon, Face ID, reminders). Management also gets their authenticator code on that phone (shown once).
- The temporary PIN is still made, folded under "Backup", for when the email doesn't arrive.
- Accounts shows each person's setup list: Invited · PIN · Face ID · Reminders · First report. The person who sent the invite gets a Hub notice when setup is finished.
- The ID box at sign-in also accepts the person's email.
- Who can invite: a full-access manager (anyone), or a manager (their own staff only).
- **Test copy never sends email**: it shows a preview of the exact email instead. The live Hub sends through Resend only once the `RESEND_API_KEY` secret is added (see `10-onboarding-email-setup.md`); without it, invites still work as a QR code or a copied link.

## My InnerPoints (owner 2026-10-27: "my points on home … such a large part of our workflow incentive")
- Home card above "My weekly reports" showing:
  - points this week and today;
  - work orders finished this week;
  - last week;
  - since Sept 21;
  - the latest 5 points.
- It reads the Order Manager ledger in Quickbase; it never writes.
- Linking is done by full access in Admin → InnerPoints; names are only suggestions.
- On by default once `QB_TOKEN` is added; it can be hidden in Admin.
- See `11-innerpoints-setup.md`.

## Choose-your-PIN page (owner 2026-10-27: "It needs to be easy to understand and do")
- Shows the steps ahead (PIN → home screen → Face ID; management also adds the authenticator), with the current step highlighted.
- A small animation shows a PIN being typed.
- Live checks as they type: "6 to 12 numbers" and "Both PINs match".
- A Show PIN button; letters are dropped automatically.
- Mistakes are caught on the phone before anything is sent.

## Management Home (owner 2026-10-27: "Why does a manager not have a home page?")
- Managers now land on **Home**, the same Home everyone has: their own weekly report, safety report button, My InnerPoints, My weekly reports, phone setup and company links.
- At the top is a **Your team** card with:
  - any urgent safety alert;
  - this week's signed count, missing, waiting for review and waiting on an employee;
  - **Open the dashboard** and **People & invites** buttons.
- Bottom bar for managers: Home · Dashboard · Review · Safety · More. Accounts ("People & invites") moved to the Home team card and More.

## Test copy: start the sample data over (2026-10-27)
- More → "Start the sample data over" (test copy only, full-access managers, two taps). It puts the invented data and the demo clock back to Oct 16 and signs everyone out. The live Hub has no such button: the server refuses unless the copy is the demo.

## Company documents (owner 2026-10-27: "1")
- Handbook and policies with versions and Face ID or PIN acknowledgments; see `12-company-documents.md`.
