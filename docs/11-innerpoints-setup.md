# InnerPoints in the Employee Hub: switching it on for the live Hub

Owner, 2026-10-27: "just as a start my points on home … it's such a large part of our workflow incentive that it should be there."

## What it does
- Home shows a **My InnerPoints** card, above "My weekly reports". It has:
  - the person's points this week (and "+N today");
  - work orders finished this week;
  - last week's points;
  - points since Sept 21, matching the leaderboard;
  - their latest 5 points.
- **Read-only.** The Hub only queries the InnerPoints ledger (`bvd8m6g2v`, Order Manager `bf5ukkqy7`) on thearmoredgroup.quickbase.com. It never writes to Quickbase.
- Reversed points are left out.
- If the ledger's fields ever change, the card shows a message instead of wrong numbers. This matters because Quickbase silently drops unknown fields.
- The card is **on by default** once connected. A full-access manager can hide it in **Admin → InnerPoints**.
- Each Hub account is linked to its Order Manager name by a full-access manager in **Admin → InnerPoints**. A matching name is suggested, but nothing is linked until you click. Only people with points since Sept 21 are listed.
- The test copy shows invented sample points and never uses the real token.

## Steps (Josh, about 5 minutes)
1. In Quickbase, go to **My Profile** (top right) → **My preferences** → **Manage my user tokens** → **New user token**.
   - Name: `Innerspace Employee Hub (read-only)`
   - Assign it to the **Order Manager** app only.
   Copy the token. Don't change or deactivate any other token, because the automations depend on them.
2. In **dash.cloudflare.com**, open **Workers & Pages** → **tag-employee-hub** (the live worker, not `-test`) → **Settings** → **Variables and Secrets** → **Add**.
   - Type: **Secret**
   - Name: `QB_TOKEN`
   - Value: paste the token → **Deploy**.
3. In the Hub, open **Admin → InnerPoints**. It should say "Connected". Link each person (use the suggestions where they're right) and check your own Home.

## Good to know
- The token acts with the permissions of the Quickbase user who made it, but the Hub code only ever reads the points ledger. For extra safety, make the token from a Quickbase user with read-only access to the Order Manager.
- Points refresh every few minutes. Quickbase is asked at most once per person every 3 minutes.
- To turn it off, either hide the card in Admin or delete the `QB_TOKEN` secret.
- Later, if you want: a team leaderboard, points for an on-time weekly report or a safety report (that would write to the ledger and needs your OK), and rewards.
