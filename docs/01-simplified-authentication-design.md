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
