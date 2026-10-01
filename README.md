# Parent Communication Bot (SmartClass AI)

AI-drafted SMS and WhatsApp updates for parents. Staff pick an audience, the AI drafts one message per parent, staff review and edit, then send.

Stack matches your Class Register: Node + Express + SQLite, deployable on Render.

## What it does
- **Message types:** absence, late arrival, progress update, commendation, concern, fees reminder, event/PTA notice, announcement
- **Audience:** whole school or one/more classes; opted-out parents are skipped automatically
- **AI drafting:** one personalised message per parent, tone (warm/formal/friendly/firm) and language (English, Pidgin, Hausa, Yoruba, Igbo). Falls back to built-in templates if the AI is unavailable
- **Per-child notes** for progress updates (`Adaeze Okafor: strong in maths, needs reading practice`)
- **Review before send:** every message is editable; nothing goes out until staff click Send
- **Delivery:** WhatsApp first, automatic SMS fallback (Termii). Dry-run mode until keys are added
- **Class Register hook:** absence/late alerts drafted (or auto-sent) when a pupil is marked A or L
- **Safeguards:** daily send limit, opt-out (STOP reply on WhatsApp), per-day duplicate protection on absence alerts, multi-school isolation, rate-limited login, webhook signature check
- **SMS cost control:** Naira sign, curly quotes and emojis are converted to plain characters so messages stay 160 characters/segment instead of 70

## Run locally
```
npm install
cp .env.example .env      # set JWT_SECRET at minimum
npm start                 # http://localhost:3000
```
With no API keys it runs in dry-run mode: drafts use templates, and "sent" messages are only logged to the console. Create a school account on first visit, import `sample-parents.csv`, and try it end to end.

## Go live
1. **AI drafting:** set `ANTHROPIC_API_KEY` (default model is Haiku 4.5, low cost; change with `ANTHROPIC_MODEL`).
2. **SMS:** create a Termii account, set `TERMII_API_KEY`. Register your sender ID with Termii/NCC (max 11 characters) and set it in Settings. Keep `TERMII_CHANNEL=dnd` so messages reach numbers on Do-Not-Disturb.
3. **WhatsApp (Meta Cloud API):** set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID`. Business-initiated messages need an approved template. Create one named `school_update` (category Utility, language English) with this body:
   ```
   Message from your child's school:

   {{1}}

   Reply STOP to opt out.
   ```
   Meta may take a day to approve, and templates that are mostly one variable are sometimes reclassified as Marketing. If that happens, SMS fallback still delivers. For sandbox testing set `WHATSAPP_SEND_MODE=text`.
4. **Webhook:** in Meta, set the callback URL to `https://YOUR-DOMAIN/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`, and set `WHATSAPP_APP_SECRET` so signatures are verified. This gives delivered/read receipts and STOP handling.
5. **Render:** new Web Service, add a persistent disk (e.g. mount `/var/data`), set `DATA_DIR=/var/data`, `NODE_ENV=production`, `JWT_SECRET`, and `SIGNUP_CODE` (so only schools you approve can register). Add a subdomain such as `parents.smartclassaiacademy.com`.

## Connect the Class Register
Settings shows your school's endpoint and API key. From the Class Register backend, call this whenever a pupil is marked A or L:

```js
await fetch('https://parents.smartclassaiacademy.com/api/hooks/absence', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.PARENTBOT_KEY },
  body: JSON.stringify({ admission_no: 'SC/001', date: '2026-10-05', status: 'A' })
});
```
Use `student_name` + `class_name` instead of `admission_no` if you do not track admission numbers. Repeat calls for the same pupil and day are ignored, so it is safe to call on every save.

By default alerts land in Messages as drafts for a teacher to approve. Turn on "Send absence alerts automatically" in Settings to skip review.

## Privacy (NDPA)
- Only the child's first name, class, the parent's name and the facts you type are sent to the AI. Phone numbers, admission numbers and surnames of children are not.
- Get parent consent for WhatsApp/SMS at admission (add a line to the enrolment form) and keep the STOP opt-out.
- Do not put sensitive details (health, discipline specifics) in bulk messages; use the Concern type to invite a conversation instead.

## API summary
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Sign up / in |
| GET/POST/PUT/DELETE | `/api/contacts`, `/api/contacts/import` | Parents |
| POST | `/api/drafts` | AI-draft a batch |
| GET/PUT/DELETE | `/api/messages` | Review, edit, discard |
| POST | `/api/messages/send` | Send selected |
| POST | `/api/hooks/absence` | Class Register hook (x-api-key) |
| GET/POST | `/webhooks/whatsapp` | Meta verification, receipts, STOP |
