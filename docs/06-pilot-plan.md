# 6. Simple pilot plan (about 20 employees)

**Nothing here has been done.** No legal review step: the system uses conservative defaults instead (see [05](05-production-blockers.md)). Each step needs your approval. No production system is touched: Quickbase OM and PID, QuickBooks Time and Payroll, and Workforce all stay as they are.

## What you need

| Item | Cost |
|---|---|
| Cloudflare Workers Paid plan (one Worker plus one Durable Object holding all data) | $5 / month |
| Cloudflare Turnstile bot check on the sign-in page | Free |
| Authenticator app for each management account (Google Authenticator, Microsoft Authenticator, etc.) | Free |
| Urgent safety texts (GoTo) | Not in the pilot: planned for v2.0 |
| The shop tablet(s) already on site, registered once as shared | $0 |

## Steps

| Week | Step | Who |
|---|---|---|
| 1 | Set up a **separate test copy** on Cloudflare with sample data. Re-run all tests there, including the scheduler and a restore drill. Add Turnstile. | Claude, after approval |
| 2 | Production setup: demo off, secrets set, first full-access account created through the one-time setup screen (S9, built). You create the other management accounts (yourself with full access and safety contact, plus 1–2 others) and set up authenticators in person. | You |
| 2 | Add the pilot staff: name, ID, reports to. Hand each person their temporary PIN **in person**. On each shop tablet, sign in as a manager and register it under Accounts → Shop tablets. | You / a manager |
| 2 | **Five-minute walkthrough** with each person at the tablet: enter ID and temporary PIN, choose a PIN, see the survey. | Manager |
| 3–6 | **Pilot:** everyone fills in the Friday survey in the Hub. Paper stays available for anyone who prefers it. Management reviews by Wednesday. Safety concerns go through the app **and** in person. | Everyone |
| 3–6 | Weekly 10-minute check: dashboard completion, any lockouts or PIN resets, how quickly urgent reports were acknowledged, feedback | You |
| 7 | Decide: go company-wide, adjust, or stop. Paper becomes the fallback only. | You |

## How you'll know it works

- **Speed:** a staff member signs in, completes and signs in under 5 minutes. The automated test measures sign-in to submitted on the tablet.
- **Completion:** at least 90% of expected surveys signed by Monday 15:30, with the rest marked missing.
- **Review:** management signs off within 3 working days (the dashboard shows this per manager).
- **Safety:** every urgent safety report is acknowledged by management the same working day (the dashboard shows when). If that proves too slow, bring texting (v2.0) forward.
- **Resets:** fewer than 2 PIN resets a week after the first week.

## Rollback

- If the Hub is unavailable on a Friday, use the paper form that week and record "paper received" later.
- Code rollback uses Cloudflare's version history.
- A data restore uses point-in-time recovery (30 days).
