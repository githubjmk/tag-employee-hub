# 8. Do we need to connect QuickBooks Time and Quickbase?

**Short answer: not to run the pilot.** The Hub works on its own: you enter about 20 people once, and the work-hours window keeps the survey on paid time without reading timesheets. Connections would add convenience later. Each one would be **read-only**, so nothing in QuickBooks Time, Workforce or Quickbase changes.

## What each connection would add

| Connection | What the Hub would read | What it gives you | Effort / prerequisites |
|---|---|---|---|
| **QuickBooks Time** (best value) | Who has timesheet hours in a given week; optionally who is clocked in right now | **Expected list built automatically:** no need to enter vacations or leave by hand, because anyone with no hours that week is "not needed". Optional proof that each survey was signed while the person was clocked in. | QuickBooks Time API (OAuth). A QuickBooks Time admin authorizes the Hub once. API access for your account still needs to be verified (open item from R1). Medium effort. |
| **Quickbase OM** (Employee table, 15 records) | Names, and the Quickbase user for each person | A one-time starting roster, and a "My Work" link that opens the right person's Order Manager page | A server-side Quickbase token (R1 found none reachable from the cloud; your `my-innerspace` Worker shows one can be set up). Low value at 20 people: typing the roster is faster. |
| **QuickBooks Workforce** | The official employee list (18 active on the weekly schedule at R1) | Who joined or left, to prompt management to add or deactivate accounts | Same Intuit sign-in route. Optional. |

## Why the Hub doesn't need them to start

- **Paid time:** surveys can only be filled in during work hours, so no timesheet check is needed.
- **Who is expected:** active accounts minus recorded time off. Management can excuse a week in two taps.
- **Identity:** the Hub's own employee ID is the stable key. When a connection is added, each account gets the matching QuickBooks Time user ID or Quickbase user stored alongside it. There is no matching by name, which R1 showed would mis-link people across the two Quickbase employee lists and payroll.

## No-code option already in place

The R1 plan already suggests a **"Weekly safety check-in" job code** in QuickBooks Time. People clock that job while doing the survey, so the time shows up on payroll as paid work, without any integration.

## Recommendation

Pilot without connections. If the pilot goes well, the first one to add is **read-only QuickBooks Time** for the automatic "who worked this week" list. Adding it needs its own approval and a QuickBooks Time admin to authorize it.
