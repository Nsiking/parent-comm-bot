'use strict';
// Sends short messages: SMS through Termii, email through Brevo or Resend (all by plain web requests, no extra packages).
// Nothing is sent, and nothing breaks, until the settings exist. Used for password reset codes.
//
//   SMS:    TERMII_API_KEY, TERMII_SENDER_ID (the name parents see, approved by Termii), TERMII_CHANNEL (default "dnd")
//   Email:  EMAIL_PROVIDER ("brevo" or "resend"), EMAIL_API_KEY, EMAIL_FROM (the sending address), EMAIL_FROM_NAME

const env = (k) => String(process.env[k] || '').trim();
const emailProvider = () => { const p = env('EMAIL_PROVIDER').toLowerCase(); return p === 'brevo' || p === 'resend' ? p : null; };
const smsReady = () => !!(env('TERMII_API_KEY') && env('TERMII_SENDER_ID'));
const emailReady = () => !!(emailProvider() && env('EMAIL_API_KEY') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env('EMAIL_FROM')));
const options = () => ({ sms: smsReady(), email: emailReady() });

async function post(url, headers, body) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    let j = null; try { j = await r.json(); } catch (_) { /* not JSON */ }
    return { ok: r.ok, status: r.status, body: j };
  } finally { clearTimeout(t); }
}

// phone = a Nigerian number as 0803..., sent to Termii as 234803...
async function sendSms(phone, text) {
  if (!smsReady()) throw new Error('SMS is not set up');
  const base = (env('TERMII_BASE_URL') || 'https://api.ng.termii.com').replace(/\/+$/, '');
  const r = await post(`${base}/api/sms/send`, {}, { to: '234' + String(phone).replace(/^0/, ''), from: env('TERMII_SENDER_ID'), sms: text, type: 'plain', channel: env('TERMII_CHANNEL') || 'dnd', api_key: env('TERMII_API_KEY') });
  if (!r.ok || !r.body || !(r.body.message_id || r.body.code === 'ok')) throw new Error('Termii: ' + ((r.body && r.body.message) || `HTTP ${r.status}`));
}

async function sendEmail(to, subject, text) {
  if (!emailReady()) throw new Error('Email is not set up');
  const name = env('EMAIL_FROM_NAME') || 'SmartClass';
  if (emailProvider() === 'brevo') {
    const base = (env('EMAIL_BASE_URL') || 'https://api.brevo.com').replace(/\/+$/, '');
    const r = await post(`${base}/v3/smtp/email`, { 'api-key': env('EMAIL_API_KEY') }, { sender: { name, email: env('EMAIL_FROM') }, to: [{ email: to }], subject, textContent: text });
    if (!r.ok) throw new Error('Brevo: ' + [r.body && r.body.code, (r.body && r.body.message) || `HTTP ${r.status}`].filter(Boolean).join(': '));
  } else {
    const base = (env('EMAIL_BASE_URL') || 'https://api.resend.com').replace(/\/+$/, '');
    const r = await post(`${base}/emails`, { Authorization: 'Bearer ' + env('EMAIL_API_KEY') }, { from: `${name} <${env('EMAIL_FROM')}>`, to: [to], subject, text });
    if (!r.ok) throw new Error('Resend: ' + [r.body && r.body.name, (r.body && r.body.message) || `HTTP ${r.status}`].filter(Boolean).join(': '));
  }
}
// What is set up, and exactly which setting names are missing (never the values themselves)
function status() {
  const emailMissing = [];
  if (!emailProvider()) emailMissing.push('EMAIL_PROVIDER (brevo or resend)');
  if (!env('EMAIL_API_KEY')) emailMissing.push('EMAIL_API_KEY');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env('EMAIL_FROM'))) emailMissing.push('EMAIL_FROM (a proper address such as support@yourdomain.com)');
  const smsMissing = [];
  if (!env('TERMII_API_KEY')) smsMissing.push('TERMII_API_KEY');
  if (!env('TERMII_SENDER_ID')) smsMissing.push('TERMII_SENDER_ID');
  return { email: { ready: emailReady(), provider: emailProvider(), from: env('EMAIL_FROM') || null, missing: emailMissing }, sms: { ready: smsReady(), sender: env('TERMII_SENDER_ID') || null, missing: smsMissing } };
}

// The provider's own message, turned into what the person should do about it
function explain(err) {
  const m = String((err && err.message) || err || '');
  if (/unrecognis|unrecogniz|IP not authori|not verified|unknown IP/i.test(m)) return 'Brevo is blocking this server\'s address. In Brevo open your account name (top right), then Settings, Security, Authorized IPs. On the API keys row click Deactivate, and confirm. Then try again. (' + m + ')';
  if (/sender/i.test(m) && /(not valid|not found|invalid|not verified|not authori|unverified|does not exist)/i.test(m)) return 'The sending address is not accepted. In Brevo, open Settings, Senders, Domains & Dedicated IPs, and check that the address in EMAIL_FROM shows Verified, spelled exactly the same. (' + m + ')';
  if (/domain.*(not verified|verify)|only send testing emails|not allowed to send from/i.test(m)) return 'This provider only allows sending from a verified domain. Verify your domain with the provider, then use an address on it in EMAIL_FROM. (' + m + ')';
  if (/key not found|invalid.*key|api.?key|missing_api_key|invalid_api_key|unauthori[sz]ed/i.test(m)) return 'The provider did not accept the API key. Create a new key there, paste it into EMAIL_API_KEY with no spaces, save, and wait for the deploy. (' + m + ')';
  if (/Termii/i.test(m) && /sender|from|ID/i.test(m)) return 'Termii did not accept the Sender ID. It must be approved by Termii first, and typed exactly the same in TERMII_SENDER_ID. (' + m + ')';
  if (/Termii/i.test(m) && /balance|insufficient|fund/i.test(m)) return 'Your Termii balance is too low. Top it up and try again. (' + m + ')';
  if (/abort|fetch failed|ENOTFOUND|ECONN|timeout/i.test(m)) return 'This server could not reach the provider. Check EMAIL_BASE_URL / TERMII_BASE_URL are not set to a wrong address, and try again in a minute. (' + m + ')';
  return 'The provider refused the message: ' + m;
}
module.exports = { options, status, explain, sendSms, sendEmail };
