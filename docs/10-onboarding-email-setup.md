# Onboarding email: switching it on for the live Hub

The welcome email is built and tested. On the test copy it only shows previews. The live Hub sends real email after these one-time steps. Josh does them himself, because the key is a password and stays with him.

**Sender:** Innerspace Employee Hub &lt;info@innerspacecases.com&gt;. The domain innerspacecases.com is already verified in Resend, with sending turned on.

## Steps (about 5 minutes)
1. Sign in to **resend.com** → **API Keys** → **Create API key**.
   - Name: `Innerspace Employee Hub`
   - Permission: **Sending access**
   - Domain: **innerspacecases.com**
   Copy the key (it starts with `re_`). Resend shows it only once.
2. Open **dash.cloudflare.com** → **Workers & Pages** → **tag-employee-hub** (the live worker, *not* `tag-employee-hub-test`) → **Settings** → **Variables and Secrets** → **Add**.
   - Type: **Secret**
   - Name: `RESEND_API_KEY`
   - Value: paste the key → **Deploy**.
3. Optional: to show a different sender, add a plain variable `HUB_MAIL_FROM`, for example `Innerspace Cases <info@innerspacecases.com>`. The address must be on innerspacecases.com.
4. Test it on yourself: in the Hub, open **Accounts** → use a person whose inbox you can check (yourself as a second test account, or a trusted manager). Add the email → **Send welcome email**, then check that it arrived and that the button works.

## Good to know
- Each email is a live employee notification. It goes out only when a manager presses **Send** for that one person. There is no bulk send.
- Replies to the welcome email go to the info@ mailbox.
- If the key is missing or Resend refuses a send, the Hub says so and offers the QR code or copy-link instead. Nothing is lost.
- To turn email off, delete the `RESEND_API_KEY` secret in Cloudflare.
