# Parent Communication Bot: forgot your password?

Staff and administrators can reset their own password with a 6-digit code sent to their email. The code works for **15 minutes**, **once**, and stops after **5 wrong guesses**. One person can ask for at most **3 codes an hour**. Only a fingerprint of the code is stored. When the password is changed, every session already open on that account is signed out.

- **If email is not set up:** the sign-in page looks exactly as before.
- The screen never says whether an account exists. Everyone gets the same calm message.

## Switch it on (Render, Parent Bot service, Environment)
The same settings you already use for School Management:

| Name | Value |
|---|---|
| `EMAIL_PROVIDER` | `brevo` (or `resend`) |
| `EMAIL_API_KEY` | the provider's API key |
| `EMAIL_FROM` | the verified sending address, for example `support@smartclassaiacademy.com` |
| `EMAIL_FROM_NAME` | optional, for example `SmartClass` |

Save, wait for **Live**, and open the sign-in page. The link **Get a code by email** appears.

## Check that it really works
Sign in as the **owner** (the first administrator account) and open **Settings**. At the bottom is a card, **Email for password reset**. It says Ready or lists the missing settings, and has a **Send test email** button. If the provider refuses the message, the card explains why in plain words. Other accounts never see this card.

## Good to know
- Do not change `JWT_SECRET` on the server: it also signs the codes' fingerprints and the sessions.
- After **any update** of `server.js`, `auth.js` or `public/index.html`, run `node apply-reset.js` before you commit (together with `node apply-sm-connection.js` and `node apply-backup.js`). If everything is in place it says so and changes nothing. If an update removed it, it puts back only what is missing.
- Never use `node apply-reset.js --undo` to repair a lost feature: it would throw your update away.
