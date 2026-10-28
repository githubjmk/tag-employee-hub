# Time off requests and My time

Owner, 2026-10-27: "we currently have an in person request system" → recommendation accepted ("ok"): requests in the Hub, with in-person requests still possible.

## What it does
**More → My time**, plus a Time off card on Home:
- **Hours:** "My hours" from QuickBooks Time, when that card is switched on in Admin and `QBT_TOKEN` is set.
- **Time off:** Request time off, the person's requests and their status, and Cancel (before the days have passed).
- **Team calendar:** month by month. Staff see who is off (approved), not why. Managers also see the kind and requests still waiting.

**Requests:**
- **Kinds:** Vacation, Sick or personal day, Unpaid time off, Other (appointment, jury duty…).
- **Dates:** first and last day. The screen shows the workday count, plus the handbook's 60-days-ahead hint for vacation (a hint only; managers can still approve).
- **Note:** optional, up to 300 characters. The screen says not to include medical details, and the kind is never stored with the absence as a medical reason.
- **Checks:** the dates must be in order, include at least one weekday, start no more than 30 days back and no more than a year ahead, and run at most 60 workdays. There's no overlap with the person's own requests.

**Deciding:**
- The person's manager (Dana for the shop) or full access decides. Nobody decides their own request; a manager's own request goes to their manager, and if there's none, to full access.
- The decision screen shows the dates, workdays, how many days ahead it was asked, the note, and who else is off or has asked for those days.
- A decline needs a short note. The person gets an in-app notice either way.
- **Entered in person:** a manager can enter time off for someone ("Enter time off for someone") and approve it at once. The record shows who entered it.

**Approved = the weekly report is excused** for those days (it becomes an absence; partial weeks follow the usual rule). Cancelling approved time off removes the absence, and the report is expected again.

**Balances are not tracked** (days left stay in payroll and the office sheet). Everything is in the audit log and the backup.

Test copy: sample requests (Luis approved, Rosa and Jordan waiting) so the screens can be tried.
