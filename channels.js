// Delivery layer: Termii (SMS) + WhatsApp Cloud API. Falls back to dry-run when credentials are missing.

const smsLive = () => !!process.env.TERMII_API_KEY;
const waLive = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

// -> digits only, country code included (e.g. 2348031234567). Returns null if invalid.
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  else if (p.startsWith('0')) p = '234' + p.slice(1);
  else if (p.length === 10) p = '234' + p;
  if (p.startsWith('234') && p.length !== 13) return null;
  if (p.length < 10 || p.length > 15) return null;
  return p;
}

// GSM-7 safe text. The Naira sign, curly quotes and emojis push an SMS into UCS-2 (70 chars/segment instead of 160).
function sanitizeSms(text) {
  return String(text)
    .replace(/₦/g, 'N')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
function smsSegments(text) {
  const len = [...text].length;
  const gsm = GSM.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return { length: len, segments: len === 0 ? 0 : len <= single ? 1 : Math.ceil(len / multi), gsm };
}

async function sendSms({ phone, body, senderId }) {
  const text = sanitizeSms(body);
  if (!smsLive()) {
    console.log(`[DRY-RUN SMS] to ${phone}: ${text}`);
    return { id: 'mock-sms-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), mock: true };
  }
  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: phone,
      from: senderId || 'SmartClass',
      sms: text,
      type: 'plain',
      channel: process.env.TERMII_CHANNEL || 'dnd',
      api_key: process.env.TERMII_API_KEY,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 'ok')) {
    throw new Error('Termii: ' + (data.message || `HTTP ${res.status}`));
  }
  return { id: String(data.message_id || data.message_id_str || ''), mock: false };
}

async function sendWhatsApp({ phone, body }) {
  if (!waLive()) {
    console.log(`[DRY-RUN WHATSAPP] to ${phone}: ${body}`);
    return { id: 'mock-wa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), mock: true };
  }
  const mode = process.env.WHATSAPP_SEND_MODE || 'template';
  let payload;
  if (mode === 'text') {
    payload = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body, preview_url: false } };
  } else {
    // Template parameters cannot contain newlines/tabs or 4+ consecutive spaces.
    const param = body.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, 1000);
    payload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: process.env.WHATSAPP_TEMPLATE_NAME || 'school_update',
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }],
      },
    };
  }
  const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('WhatsApp: ' + (data.error?.message || `HTTP ${res.status}`));
  return { id: data.messages?.[0]?.id || '', mock: false };
}

// Returns { id, channel, mock, fallback }
async function send({ channel, phone, body, senderId }) {
  if (channel === 'sms') {
    return { ...(await sendSms({ phone, body, senderId })), channel: 'sms' };
  }
  try {
    return { ...(await sendWhatsApp({ phone, body })), channel: 'whatsapp' };
  } catch (err) {
    if (process.env.FALLBACK_TO_SMS === 'false') throw err;
    try {
      return { ...(await sendSms({ phone, body, senderId })), channel: 'sms', fallback: true };
    } catch (err2) {
      throw new Error(`${err.message}; SMS fallback: ${err2.message}`);
    }
  }
}

function status() {
  return { sms: smsLive() ? 'live' : 'dry-run', whatsapp: waLive() ? 'live' : 'dry-run' };
}

module.exports = { normalizePhone, sanitizeSms, smsSegments, send, status };
