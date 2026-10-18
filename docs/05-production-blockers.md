# 5. Remaining production security and legal blockers

> Not legal advice. Passing tests show the software behaves as designed. They do not show legal compliance.

## Security

| # | Blocker or risk | Why it matters | Fix before go-live | Size |
|---|---|---|---|---|
| S1 | **Sign-in is now reachable from any browser on the internet** | Anyone who knows or guesses an employee ID can try PINs. Lockouts cap this at about 15 guesses a day per account, but they also let a stranger **lock someone out on purpose** (3 lockouts = locked until management resets). | **Built:** a Cloudflare Turnstile bot check on sign-in, switched on by adding the `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` secrets (API R12-09). **On in the test copy (2026-10-15):** widget "TAG Employee Hub" created by the owner, secret set by the owner, site key in `wrangler.toml`. The live sign-in page shows the check, the owner signed in through it on his phone (2026-10-15), and the server refuses sign-ins without it (missing or fake token: `bot_check`). Still to consider: letting a hard lock clear itself after 24 h. The live version needs the same widget hostname added. | Dashboard step |
| S2 | **"Shared tablet" is a checkbox the employee can untick** | On a shared tablet left unticked, the session stays open 60 min instead of 5. A PIN is still needed to sign, but answers and history are visible. | Register the actual shop tablets under Accounts → Shop tablets (optional; a manager does it once on each tablet). A registered tablet is always treated as shared, whatever the checkbox says. | Process |
| S3 | **No text alerts in the pilot: texting moves to v2.0** (owner, 2026-10-14) | An urgent safety report reaches management only when someone opens the dashboard or is told in person | **Pilot:** urgent reports show as a red banner on the Management dashboard. Management checks it at least at the start of each shift and after lunch. Staff are also told to tell a supervisor in person (already on every safety screen). **v2.0:** the GoTo sender and receipt webhook are already built and tested against a simulated GoTo (API R12-08). They stay switched off until the GoTo OAuth client, number and webhook are set up. | Process now; GoTo admin steps in v2.0 |
| S4 | Authenticator secrets for management were stored unencrypted | A database leak would expose the second factor | **Built:** encrypted at rest with AES-256-GCM using a key derived from the pepper; older values are encrypted at start-up (API R12-10). | Done |
| S5 | Off-site backup | Point-in-time recovery covers 30 days only, inside Cloudflare | **Built:** Admin → Restore & backup → Download backup (full access only, audited, no sign-in secrets, SHA-256 fingerprint; API R12-12, UI U11). **Restore built too:** point-in-time restore with undo (API R12-11); **Restore drill passed on the live test copy** (restore, check, undo; doc 04). Still to decide: an automatic daily copy to Cloudflare R2 (a new storage bucket needs your approval). Process for the pilot: download a backup weekly and keep it like a personnel file. | Done (manual); R2 optional |
| S6 | Temporary PINs are shown on screen to the manager who issues them | They must be handed over in person, not texted or emailed | Process and training. The PIN is single use, expires in 72 h, and the person must change it. | Process |
| S7 | Management with team access sees **everyone's completion status** (not answers) | Probably right for a 20-person shop, but it is a privacy choice | Owner confirms | Decision |
| S9 | First full-access account in production | Only a full-access account can create accounts | **Built:** with `HUB_DEMO=0` the Worker starts with an empty database and real time. The `/api/setup` screen creates your own full-access + safety-contact account once, with the `HUB_BOOTSTRAP_CODE` secret, then switches off (API R12-07). | Done |
| S8 | Local tests used Wrangler 4.20.0 (`evidence/r12-wrangler-version.txt`) | Newer runtime versions exist | Re-run all suites in the approved dev environment on current Wrangler | Small |

## Legal questions: designed around, not escalated

**Owner decision (2026-10-14).** No new legal review will be obtained. The system therefore uses the most conservative choice wherever there was an open question, and sticks to what is known: the paper survey you have used for years.

None of this is legal advice, and passing tests do not show compliance. These are the defaults that avoid needing anyone to decide the questions.

| Earlier open question | How the design steers clear of it |
|---|---|
| Paid time (completing the survey off the clock) | **The weekly report can only be filled in, saved, signed, corrected or answered during work hours (Mon–Fri 7:00 AM–3:30 PM).** Outside those hours the survey shows "Available during work hours" and when it opens next. The server enforces this (API R12-06, UI U10). The "required before Monday morning" sentence stays hidden; the paid-time notice is shown instead. |
| Survey wording, including the injury question | **No wording changes.** Q1–Q4 are exactly the paper form you have used for years (verified word for word against your Word master and two print batches). A "Yes" to Q4 collects nothing more: it only creates a private check-in for the safety contact. The proposed rewrite (WR-2.0-P) stays unused. |
| Electronic signature and consent | **Paper always stays available.** The consent text is shown in full, word for word, the first time someone signs. Anyone can choose paper at any time (More → Electronic signing), and someone who chose paper cannot be signed electronically. The signature is the person's own PIN plus a checked statement, and the record captures who, what, when and which version. |
| Records and copies | **Nothing is ever deleted.** Each employee can view and download their own signed copy at any time, and corrections are added alongside, never over, the original. |
| Medical information | **None collected.** There are no medical fields, and time-off entries allow only vacation, leave or other. |
| Retaliation | **Reporting is never blocked**, at any hour. The "you will not be punished for reporting" statement is on every safety screen, and report counts are never tied to people. |
| Ratings | **No scoring.** Self-ratings are recorded as answered, never averaged, ranked or used in dashboards. |
| Text messages | **None in the pilot.** In v2.0, only opted-in management safety contacts are texted, from the company GoTo number. Staff are never texted. |

**Minimum before a pilot:**
- Turnstile widget keys added (S1).
- Management agrees the dashboard-check routine for urgent reports (S3); texting is v2.0.
- The test copy deployed and checked.
