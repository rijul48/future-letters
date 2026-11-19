# Letters to the Future

Write a letter today. It is emailed to you on the date you choose.
One Cloudflare Worker serves the page (`public/`) and the API (`src/`), with D1 for storage and Resend for email.

## How it works
1. `POST /api/letters` validates the letter, encrypts subject and body (AES-GCM), stores it as `pending`, and emails a confirm link.
2. The link opens a page with a button. Only the button press confirms (so email scanners cannot confirm or delete by accident).
3. An hourly cron (`scheduled()`) delivers due letters around 9:00 in the writer's own time zone, then erases the address, subject and body.
4. Unconfirmed letters are erased after 48 hours. A letter can be deleted any time from the link.

## Run the tests (no account needed)
```
npm test
```
Needs Node 22 or newer. The tests cover validation, encryption, the full write-confirm-deliver-erase journey, retries, limits and deletion.

## Deploy, step by step
1. `npm install`
2. `npx wrangler login` (opens your browser to sign in to Cloudflare).
3. `npx wrangler d1 create future-letters` and copy the `database_id` it prints into `wrangler.toml`.
4. `npx wrangler d1 execute future-letters --remote --file=schema.sql`
5. Make an encryption key and store it. Keep a safe copy: **letters cannot be read without it**.
   - `npm run genkey` prints a key.
   - `npx wrangler secret put ENCRYPTION_KEY` and paste it.
6. In Resend, verify your sending domain, create an API key, then `npx wrangler secret put RESEND_API_KEY`.
7. Edit `FROM_EMAIL` and `SITE_URL` in `wrangler.toml` (use an address on your verified domain).
8. `npx wrangler deploy`
9. In the Cloudflare dashboard, open the Worker, then Settings, Domains and Routes, and attach your address (for example `letters.yourdomain.com`).

Try it end to end with your own email before sharing the link. For local testing, copy `.dev.vars.example` to `.dev.vars` and run `npm run dev` (with `DRY_RUN=true` no email is sent).

## Where to extend
- `src/config.js`: every limit and plan. Add a `plus` plan and teach `planFor()` who has it.
- `src/lib.js`: validation, crypto and email templates.
- `src/index.js`: routes and the hourly delivery job.
- Ideas ready to plug in: paid plan via Razorpay, letters on a repeating date, photo attachments (R2 storage), more languages for the page and emails, a Cloudflare Turnstile check on the form.

## Before a public launch
- Have the terms and privacy text reviewed (the plain-language terms on the page are a draft).
- Check your Resend plan limits, and set `MAX_NEW_PER_DAY` to match.
- Keep a backup of `ENCRYPTION_KEY` somewhere safe and separate from the code.
