# 9. Connecting QuickBooks Time ("My hours"), read-only

**Owner decision (2026-10-27):** staff mostly clock in with the QuickBooks Time app on their own phones, so the **My hours card is OFF by default**. A full-access manager can switch it on in Admin → QuickBooks Time. The connection is mainly for behind-the-scenes uses (see "Next").

**What the card does when switched on.** Each person sees **My hours** on their Home screen (management under More):
- their own clocked hours for this week and last week;
- hours per day;
- whether they are on the clock right now.

Nobody sees anyone else's hours. The Hub only *reads*: every request is a GET to `https://rest.tsheets.com/api/v1`, and nothing in QuickBooks Time is created, changed or deleted (`app/core/qbtime.js`, test QB-01).

**Where it runs.** Only the live Hub uses the real QuickBooks Time. The test copy always shows invented sample hours, so real hours never appear there.

## Steps for you (about 10 minutes)

1. **Create the access token in QuickBooks Time.** You need to be a QuickBooks Time admin.
   1. Open QuickBooks Time → **Feature Add-ons** → **Manage Add-ons**. Find **API** and install it.
   2. Open the API add-on and choose **Add a new application**. Name: `Innerspace Employee Hub (read-only)`. Description: `My hours for staff`. Redirect URI: `https://hub.innerspacecases.com` (it isn't used).
   3. Click **Add Token** and copy the token. If you can, extend its expiration in the same screen.
2. **Give the token to the live Hub, without pasting it anywhere else.**
   1. Cloudflare dashboard → **Workers & Pages** → `tag-employee-hub` (the live one, not `-test`) → **Settings** → **Variables and Secrets** → **Add**.
   2. Type **Secret**, name `QBT_TOKEN`, value = the token. Save. Cloudflare applies it to the live Hub straight away.
3. **Link the accounts.**
   1. On the live Hub, sign in as full access → **More** → **Admin** → **QuickBooks Time**. It should say **Connected** with the number of QuickBooks Time people.
   2. For each person, pick their QuickBooks Time name and click **Save**. When the names match, you can click **Use suggestion** instead.
   3. Nothing is linked automatically.
4. **Check.** Open the Hub as yourself (if you are linked). My hours should match QuickBooks Time.

## If something goes wrong
- **"Connection problem: QuickBooks Time refused the access token":** the token expired or was removed. Create a new one (step 1) and replace `QBT_TOKEN` (step 2).
- **To turn it off:** delete `QBT_TOKEN` in Cloudflare. My hours disappears; nothing else changes.

## What is stored
- **In the Hub:** only the link (Hub account ↔ QuickBooks Time user ID and name), in table `qbt_links`.
- **Hours:** read when someone opens Home and cached for 5 minutes. They are not stored in the Hub's database.
- **The token:** only in Cloudflare's secret store.

## Next (not built yet, needs your OK)
1. **Who worked this week, automatically.** Use QuickBooks Time hours to mark weeks with no hours as "not needed", so vacations and leave no longer have to be entered by hand.
2. **Missed-punch nudge.** Tell the person (and, optionally, their manager): "You didn't clock out yesterday — tell your supervisor before payroll."
3. **Proof of paid time.** Note in each signed report whether the person was on the clock while signing.
