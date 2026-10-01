// Drafts personalised parent messages with Claude. Falls back to built-in templates if no key / on error.
const { sanitizeSms } = require('./channels');

const KINDS = {
  absence: 'Absence alert',
  late: 'Late arrival',
  progress: 'Progress update',
  commendation: 'Commendation',
  concern: 'Behaviour or welfare concern',
  fees: 'Fees reminder',
  event: 'Event / PTA notice',
  announcement: 'General announcement',
};

const KIND_GUIDE = {
  absence: 'Tell the parent their child was absent, ask them to reply or call the school to confirm the reason. Caring, not accusing.',
  late: 'Tell the parent their child arrived late and ask for help with punctuality. Polite, not scolding.',
  progress: 'Share a short, honest progress update using only the supplied facts and the child-specific note. Lead with a strength, then one clear next step.',
  commendation: 'Celebrate something the child did well. Warm and specific.',
  concern: 'Raise a concern gently and invite the parent to speak with the school. No labels, no diagnosis, no blame.',
  fees: 'Remind the parent about school fees using only the supplied amounts and dates. Courteous and respectful; never threatening.',
  event: 'Announce the event clearly: what, when, where, and any action needed.',
  announcement: 'Communicate the supplied announcement clearly and briefly.',
};

const TONES = { warm: 'warm and caring', formal: 'formal and professional', friendly: 'friendly and conversational', firm: 'polite but firm' };
const LANGUAGES = ['English', 'Nigerian Pidgin', 'Hausa', 'Yoruba', 'Igbo'];

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'your child';
const greet = (c) => (c.parent_name ? `Dear ${c.parent_name}` : 'Dear Parent/Guardian');

function fallbackBody(kind, c, facts, note) {
  const kid = firstName(c.student_name);
  const f = (facts || '').trim();
  const n = note ? ` ${note.trim()}` : '';
  const lines = {
    absence: `${greet(c)}, ${kid} was absent from school today. Please reply or call the school office to let us know the reason.`,
    late: `${greet(c)}, ${kid} arrived late to school today. Please help us keep to the school start time. Thank you.`,
    progress: `${greet(c)}, update on ${kid}: ${f}${n}`.trim(),
    commendation: `${greet(c)}, we are pleased to share that ${kid} ${f || 'has done very well'}. Well done!`,
    concern: `${greet(c)}, we would like to speak with you about ${kid}. ${f} Please contact the school office at your convenience.`,
    fees: `${greet(c)}, a friendly reminder about school fees for ${kid}. ${f} Thank you for your support.`,
    event: `${greet(c)}, ${f}`,
    announcement: `${greet(c)}, ${f}`,
  };
  return lines[kind] || `${greet(c)}, ${f}`;
}

function signatureOf(school) {
  return school.signature || school.name;
}

function finalize(body, school, channel) {
  let text = String(body || '').trim();
  const sig = `\n- ${signatureOf(school)}`;
  if (!text.toLowerCase().includes(signatureOf(school).toLowerCase())) text += sig;
  return channel === 'sms' ? sanitizeSms(text) : text;
}

async function callClaude({ school, kind, tone, language, facts, chunk, notes }) {
  const sigLen = signatureOf(school).length + 3;
  const system = [
    `You write short messages from a Nigerian school to parents, sent by SMS or WhatsApp.`,
    `Rules:`,
    `- Use ONLY the facts provided. Never invent dates, amounts, scores, names, or events. If a detail is missing, leave it out.`,
    `- Address the parent using the "parent" field exactly as given (or "Dear Parent/Guardian" if empty). Refer to the child by first name.`,
    `- Do NOT include a sign-off or school name at the end; it is added automatically.`,
    `- Plain text only. No markdown, no emojis, no links or phone numbers unless they appear in the facts.`,
    `- For "sms" recipients: at most ${300 - sigLen} characters and write "N" instead of the Naira sign. For "whatsapp" recipients: at most ${600 - sigLen} characters.`,
    `- Each message must read naturally and differ slightly between children (do not copy-paste), but stay accurate.`,
    `- Purpose: ${KIND_GUIDE[kind]}`,
    `- Tone: ${TONES[tone] || TONES.warm}. Language: ${language}.`,
    `Reply with ONLY a JSON array: [{"id": <recipient id>, "message": "<text>"}] covering every recipient.`,
  ].join('\n');

  const user = JSON.stringify({
    school: school.name,
    facts,
    recipients: chunk.map((c) => ({
      id: c.id,
      parent: c.parent_name || '',
      child_first_name: firstName(c.student_name),
      class: c.class_name,
      channel: c.channel,
      child_note: notes[c.id] || '',
    })),
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const arr = JSON.parse(text.replace(/```json|```/g, '').trim());
  const out = {};
  for (const item of arr) if (item && item.id != null && item.message) out[item.id] = String(item.message);
  return out;
}

async function pool(items, size, fn) {
  const queue = items.slice();
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

// -> { [contactId]: { body, ai } }
async function draftMessages({ school, kind, tone, language, facts, contacts, notes = {} }) {
  const results = {};
  if (process.env.ANTHROPIC_API_KEY) {
    const chunks = [];
    for (let i = 0; i < contacts.length; i += 8) chunks.push(contacts.slice(i, i + 8));
    await pool(chunks, 4, async (chunk) => {
      try {
        const got = await callClaude({ school, kind, tone, language, facts, chunk, notes });
        for (const c of chunk) if (got[c.id]) results[c.id] = { body: finalize(got[c.id], school, c.channel), ai: 1 };
      } catch (err) {
        console.error('AI drafting failed, using templates:', err.message);
      }
    });
  }
  for (const c of contacts) {
    if (!results[c.id]) results[c.id] = { body: finalize(fallbackBody(kind, c, facts, notes[c.id]), school, c.channel), ai: 0 };
  }
  return results;
}

module.exports = { KINDS, TONES, LANGUAGES, draftMessages, firstName };
