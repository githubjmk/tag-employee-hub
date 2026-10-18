# Next approval request (R1.2 → pilot)

**Status 2026-10-14: all four items approved by the owner.** No legal review is planned; the system uses conservative defaults instead (docs/05). What each approval still needs from you is in the last column of the reply in chat; it is summarised below. Nothing happens until it is approved in writing.

| # | Request | Allows | Does not allow |
|---|---|---|---|
| 1 | **Separate Cloudflare test copy:** one new Worker and one new Durable Object in your account, sample data only, with Turnstile on sign-in | Running every test on the real platform, including the scheduler and a restore drill | Touching existing Cloudflare resources or live DNS |
| 2 | **Workers Paid plan** ($5/month), if not already active | Production limits | Any other purchase |
| 3 | **GoTo Connect texting:** a GoTo admin creates an OAuth client (or gives me access to set one up) for the test copy, and confirms the company number is registered for texting | Testing urgent alerts from the company number to opted-in management phones, with delivery confirmation | Texting staff; any change to your GoTo phone system or call routing |
| 4 | **Pilot setup:** you name the management accounts (who has full access, who is a safety contact) and the pilot staff list | Planning, then creating real accounts only after a further explicit approval | Importing records from Quickbase or Intuit |

## What is needed to act on the approvals

| # | Approved item | Done so far | Needed from you |
|---|---|---|---|
| 1 | Test copy on Cloudflare | **Live** at https://tag-employee-hub-test.joshua-kaye.workers.dev (deployed from the owner's Mac, 2026-10-14). 10/10 live checks passed, including the scheduler running on its own (doc 04). | For future updates from the cloud: a Cloudflare API token limited to Workers, so deploys don't need your Mac. Restore drill passed on the test copy (doc 04). |
| 2 | Workers Paid plan | Owner confirmed active (2026-10-14) | Nothing |
| 3 | GoTo texting | **Moved to v2.0 by the owner (2026-10-14).** Sender and receipt webhook stay in the code, switched off. | Nothing for the pilot. |
| 4 | Pilot setup | Account screens, temporary PINs and first-account setup built | The list of management accounts (full access? safety contact? mobile number) and the pilot staff (name, preferred language, who they report to). Real accounts go into production only, never into the test copy. |

## Go-live approved (2026-10-15, 22:35)

Owner: "Yes, prepare the live production deployment of tag-employee-hub at hub.innerspacecases.com."

Prepared, not yet deployed (the owner runs `deploy-live.sh` from his Mac on Friday 2026-10-16):
- `wrangler.toml` `[env.production]` defines the Worker `tag-employee-hub` at the custom domain `hub.innerspacecases.com`, with the backup address `tag-employee-hub.joshua-kaye.workers.dev`. Settings: `HUB_DEMO=0`, no reset endpoints, Secure cookies, pilot start week 2026-10-12.
- `deploy-live.sh` deploys only that Worker. It sets a random pepper once, generates the one-time setup code (shown only in the owner's Terminal), and switches on the bot check only after the owner confirms the widget lists the new hostnames.
- Go-live fixes, tested:
  - New accounts default to this week's Monday as their start date, so their report is expected this week.
  - The owner's first account counts for this week.
  - Demo labels are hidden in live mode.
  - API R12-14 covers go-live day in live mode.
- Checked on the local Cloudflare runtime in live mode: the setup screen creates the owner account once and then switches off; there are no demo labels or sample people (the sample-people endpoint returns 404).
- Full run: API 44/44, browser 12/12 (Node) and 12/12 (Cloudflare runtime), Workers smoke 6/6, demo ok.

Real employee accounts are created by the owner in the live Hub only. Nothing real goes into the test copy.
