# 1. Simplified authentication design (R1.2)

**Goal.** Open the Hub, enter employee ID and PIN, complete and sign the weekly survey, and be done in a few minutes. Management gets the same simple sign-in plus one extra code.

## Sign-in

| | Staff | Management |
|---|---|---|
| Where | Any supported browser: shop tablet, own phone, office PC | Same |
| What they enter | Employee ID + personal PIN (6–12 digits) | Employee ID + personal PIN, then a 6-digit authenticator code (MFA) |
| Steps | **One** screen | Two: the code is asked for only after the PIN is right |
| Device registration | None | None |
| Email or smartphone needed | No | An authenticator app (free) on a phone. Management only. |
| After sign-in | Straight to the survey if one is open or overdue and it is work hours; otherwise Home (after hours the survey says when it opens next) | Weekly completion dashboard, with their own open survey near the top (after any urgent-alert banner) |

**Shared or shop tablet.** A checkbox on the sign-in screen, checked by default and remembered per browser, labels the session as shared.
- Shared sessions sign out after 5 minutes idle and 20 seconds after submitting.
- On a personal device (box unticked), staff sessions sign out after 60 minutes idle and management sessions after 30.
- A tablet can still be registered (optional, under Accounts → Shop tablets). It then always counts as shared, and the signed record names the tablet.

## PINs

- **Personal PIN:** 6 to 12 digits. Repeats, sequences, repeating patterns, common PINs and the employee number are refused.
- **Storage:** PBKDF2-SHA256 with 100,000 iterations, a per-person salt and a server-side secret ("pepper") kept outside the database. PINs are stored only as hashes, never in recoverable form. Temporary PINs are stored the same way; each is shown once, in plain text, to the manager who issues it.
- **Temporary PIN** (new account, reset or reactivation):
  - 8 random digits, so it works on the keypad.
  - Typed into the normal PIN box.
  - Single use, valid 72 hours.
  - Issuing it cancels the old PIN at once and signs the person out everywhere.
  - At first use the person must choose their own PIN before anything else works.

**Guessing protection.**
- 5 wrong PINs lock the account for 15 minutes, and the message says so.
- 3 lockouts in 24 hours lock it until management issues a temporary PIN. Full-access management is alerted at every lockout.
- Wrong PINs at signing, and wrong authenticator codes, count too.
- Each client IP address is limited to 30 sign-in attempts a minute. The counter is kept in memory and resets on restart.
- With a 6-digit PIN that allows at most about 15 guesses a day per account, out of 1,000,000 possibilities.

## Two visible roles, extensible underneath

| Visible role | Can |
|---|---|
| **Staff** | Complete weekly surveys, sign them, report safety concerns, view their own signed records and follow-ups |
| **Management** | Review and sign surveys of the people who report to them; see everyone's completion status; track missing surveys; manage safety issues; assign and close corrective actions; reset PINs for their own staff; view management reports |

Two options apply to Management accounts only. They are settings on the account, not more roles:
- **Full access:** every employee's survey answers, and Employee Accounts (create, edit, deactivate, reset any PIN or authenticator).
- **Safety contact:** receives urgent safety alerts and escalations, and sees confidential reporters' names.

**Internal mapping** (`app/core/permissions.js`):
- Staff = `employee`.
- Management = `employee + supervisor + manager`.
- Full access adds `hr`; safety contact adds `safety`.
- Every server check uses these capability roles. A permission table (`PERMISSIONS`) lists what each role can do.
- The UI asks the server for the caller's permissions to decide what to show (a few screens still check roles directly). The server enforces everything either way.
- New capabilities can be added later without new visible roles.

## Account management (Management → Employee Accounts)

| Action | Who | What happens |
|---|---|---|
| Add a person | Full access | Name, start date, language, reports to, role. The ID is chosen (2–20 letters, digits, dashes) or the next `E-###`; it never changes and is never reused. A temporary PIN is shown once. For a Management account, the authenticator secret is also shown once. |
| Edit | Full access | Name, language, reports to, role, options. A role change ends the person's open sessions so the new permissions and MFA apply at next sign-in. Nobody can remove their own full access. |
| Reset PIN | Full access, or the person's own manager (staff only) | New temporary PIN. Nobody resets their own. |
| Reset authenticator | Full access | New secret shown once, with the person present |
| Deactivate / reactivate | Full access | Deactivation ends sessions, refuses sign-in, cancels queued alerts, keeps every record. Reactivation issues a new temporary PIN. |
| Record time off | Full access or own manager | Vacation, leave or other; never medical |

Every action is in the hash-chained audit log.

## Signing (unchanged evidence, less friction)

1. Review the answers.
2. Check the acknowledgment box. The first time, the exact versioned consent text (`esign-consent-2`, which includes the paper option) is shown above it, and the same box also gives e-sign consent.
3. Re-enter the PIN.
4. Tap Sign & submit.

The record captures:
- identity (employee ID, name, session, device type);
- the exact statement shown and every answer as displayed;
- the questionnaire version;
- UTC and local time with offset, and the reporting week;
- the consent version.

It is hashed (SHA-256) into the append-only store, and the employee immediately gets the record and a downloadable copy.

**What was removed:**
- the typed name: the PIN already proves who signed, so it only added friction;
- the separate consent screen.

## Why this keeps privacy, attribution and auditability

| Concern | Still guaranteed by |
|---|---|
| Record privacy | Server checks on every request: staff see only their own; management see answers only for their reports (or all, with full access) |
| Signature attribution | Personal PIN re-entered at the moment of signing, plus the session identity. A session left open can't sign without the owner's PIN. |
| Auditability | Append-only signed records and reviews, amendment history, a hash-chained audit log including every account and PIN action, integrity check |
| Management accounts | Individual credentials plus MFA. No shared logins. |

## Face ID / fingerprint instead of the PIN (passkeys, R1.3, owner 2026-10-25)

On a person's **own phone** the PIN can be replaced by the phone's own lock: Face ID, a fingerprint or the phone's passcode. This uses the passkey standard (WebAuthn), the same thing banks and Apple/Google accounts use.

**How people use it**
- After signing a weekly report with the PIN on their phone, the Hub asks once: "Skip the PIN next time? Use Face ID on this phone." (Not now = not asked again for 30 days.) It can also be set up under More → Face ID / fingerprint.
- Setting up a phone takes the PIN again (plus the authenticator code for management), then one Face ID approval. An open session alone, or a PIN seen over someone's shoulder plus a session, is not enough to add a phone. The person gets an in-app notice for every phone added (for management accounts, full-access managers do too).
- On a phone, the open weekly report now starts a personal session (60 minutes idle). Tablets and computers keep the short shared session and the auto sign-out.
- From then on that phone greets them on the portal ("Hi, Maria · Sign in with Face ID"), skips "who are you" in the weekly report, and shows **Sign with Face ID** at the end. One Face ID approval both identifies them and signs.
- **The PIN always works** ("Use my PIN instead"), on every screen.
- **Shop tablets keep name + PIN.** The server refuses passkeys on registered tablets and on any session marked "shared device", both for setup and for signing.

**What the phone and the Hub keep**
- The phone keeps the private key; the face/fingerprint never leaves the phone and the Hub never sees it.
- The Hub stores only the public key, the phone type ("iPhone") and when it was added/last used (`passkeys` table).
- The browser remembers only which person set it up (ID and name), to greet them. That is not a secret.
- Passkeys belong to the web address: those made on hub.innerspacecases.com work only there (not on the test copy or the workers.dev backup address).

**Signing with Face ID: same evidence, bound to the answers**
- Before the Face ID prompt, the page sends the exact answers, the week, the language and the consent choice. The server turns their SHA-256 hash into a one-time challenge (5 minutes).
- The phone signs that challenge. The server checks:
  - the signature against the stored key;
  - the web address;
  - that Face ID/fingerprint was actually used ("user verified");
  - the phone's signature counter.
- The approval becomes a single-use signing ticket for exactly that content. The server recomputes the hash from the report actually being signed, taking the week from its assignment, not from the page. Changed answers, another week, someone else's session, a shared session, a second use or more than 5 minutes are all refused, and nothing is signed.
- The open weekly report always shows, and files to, the week that can be signed now. Before Friday 07:00 that is still last week's report.
- The signed record says how it was signed:
  - method "passkey (Face ID / fingerprint / phone lock) on the person's own phone";
  - the phone type and passkey ID;
  - the hash of the approved content;
  - the signing statement worded for Face ID ("approving with Face ID, fingerprint or my phone's passcode"). The meaning is unchanged.
- Supervisor sign-off stays PIN only.

**Management**
- A management Face ID sign-in counts as both steps: the phone is something you have, and Face ID/passcode is something you are or know. So no authenticator code is needed there.
- Restore still needs PIN + authenticator code.

**Lost or replaced phone**
- The person removes the phone under More.
- A full-access manager, or the person's own manager for staff, uses Accounts → "Remove Face ID phones". This also signs the person out everywhere. Their PIN keeps working.
- **Credential resets remove every phone:** a new temporary PIN, an authenticator reset, or deactivation. That way a stolen PIN plus a phone set up with it stops working once management resets the PIN.
- When the person removes a phone, the sessions that phone started end too.

**Rules**
- Face ID obeys the same gates as the PIN: a temporary lock (5 wrong PINs), a hard lock, an unfinished PIN reset, management without an authenticator, and the "shop tablet only" policy all stop it.
- Failed Face ID attempts don't add to the PIN lockout count (they can't be guessed). They are rate limited (120 per minute per address, because the shop Wi-Fi shares one address) and audited.
- Each Face ID sign-in replaces the browser's previous session, so sessions don't pile up.
- Malformed data is refused cleanly and uses up the challenge.
- Note: management Face ID relies on the phone's own lock. A passkey kept in a shared password group would be shared too, so management should keep their passkey in their own account.
- Independent review (2026-10-25) found gaps in the first version; these rules close them. Tests PK-12 and PK-13 cover them.
- Every setup, removal, sign-in and failure is in the hash-chained audit log.

**Owner decisions (2026-10-26: "yes face id should be king"):**
- The Face ID wording of the signing statement is approved.
- A management Face ID sign-in replaces the authenticator code. Restore still needs PIN + code.
