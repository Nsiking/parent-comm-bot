require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const db = require('./db');
const { hash, verify, sign, setCookie, requireAuth, requireAdmin } = require('./auth');
const ai = require('./ai');
const ch = require('./channels');

const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const newKey = () => 'pcb_' + crypto.randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Something went wrong' });
});
const placeholders = (n) => Array(n).fill('?').join(',');

// ---------------------------------------------------------------- auth
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { schoolName, name, email, password, signupCode } = req.body || {};
  if (process.env.SIGNUP_CODE && signupCode !== process.env.SIGNUP_CODE)
    return res.status(403).json({ error: 'Invalid signup code' });
  if (!schoolName?.trim() || !name?.trim() || !email?.includes('@') || (password || '').length < 8)
    return res.status(400).json({ error: 'School name, your name, a valid email and a password of 8+ characters are required' });
  const mail = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(mail)) return res.status(409).json({ error: 'Email already registered' });
  const user = db.transaction(() => {
    const s = db.prepare('INSERT INTO schools(name, api_key, signature) VALUES (?,?,?)').run(schoolName.trim(), newKey(), schoolName.trim());
    const u = db.prepare('INSERT INTO users(school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
      .run(s.lastInsertRowid, name.trim(), mail, hash(password), 'admin');
    return { id: u.lastInsertRowid };
  })();
  setCookie(res, sign(user));
  res.json({ ok: true });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!u || !verify(password || '', u.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  setCookie(res, sign(u));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => { res.clearCookie('pcb_token'); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const school = db.prepare('SELECT * FROM schools WHERE id=?').get(req.user.school_id);
  if (req.user.role !== 'admin') delete school.api_key;
  res.json({
    user: req.user,
    school,
    kinds: ai.KINDS,
    tones: ai.TONES,
    languages: ai.LANGUAGES,
    providers: { ai: !!process.env.ANTHROPIC_API_KEY, ...ch.status() },
    origin: `${req.protocol}://${req.get('host')}`,
  });
});

// ---------------------------------------------------------------- school settings & staff
app.put('/api/school', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const sender = String(b.sender_id || 'SmartClass').replace(/[^A-Za-z0-9]/g, '').slice(0, 11) || 'SmartClass';
  db.prepare(`UPDATE schools SET name=?, sender_id=?, signature=?, default_tone=?, default_language=?, auto_send_absence=? WHERE id=?`)
    .run(String(b.name || '').trim() || 'My School', sender, String(b.signature || '').trim(),
      ai.TONES[b.default_tone] ? b.default_tone : 'warm',
      ai.LANGUAGES.includes(b.default_language) ? b.default_language : 'English',
      b.auto_send_absence ? 1 : 0, req.user.school_id);
  if ('require_consent' in b) db.prepare('UPDATE schools SET require_consent=? WHERE id=?').run(b.require_consent ? 1 : 0, req.user.school_id);
  res.json({ ok: true });
});

app.post('/api/school/rotate-key', requireAuth, requireAdmin, (req, res) => {
  const key = newKey();
  db.prepare('UPDATE schools SET api_key=? WHERE id=?').run(key, req.user.school_id);
  res.json({ api_key: key });
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role FROM users WHERE school_id=? ORDER BY id').all(req.user.school_id));
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !email?.includes('@') || (password || '').length < 8)
    return res.status(400).json({ error: 'Name, valid email and a password of 8+ characters are required' });
  const mail = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(mail)) return res.status(409).json({ error: 'Email already registered' });
  db.prepare('INSERT INTO users(school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(req.user.school_id, name.trim(), mail, hash(password), 'staff');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- contacts
app.get('/api/classes', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT class_name AS name, COUNT(*) AS total, SUM(opted_out=0) AS reachable, SUM(opted_out=0 AND consent_at IS NOT NULL) AS consented, SUM(consent_at IS NOT NULL) AS with_consent
    FROM contacts WHERE school_id=? GROUP BY class_name ORDER BY class_name`).all(req.user.school_id));
});

app.get('/api/contacts', requireAuth, (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  res.json(db.prepare(`SELECT * FROM contacts WHERE school_id=? AND
      (lower(student_name) LIKE ? OR lower(parent_name) LIKE ? OR lower(class_name) LIKE ? OR phone LIKE ? OR lower(admission_no) LIKE ?)
      ORDER BY class_name, student_name LIMIT 500`).all(req.user.school_id, q, q, q, q, q));
});

// ---- consent record: where/when a parent agreed to receive messages
const CONSENT_SOURCES = { admission_form: 'Admission form', verbal: 'Verbal', other: 'Other', imported: 'Imported list' };
const todayStr = () => new Date().toISOString().slice(0, 10);
const validDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && String(d) <= todayStr() ? String(d) : todayStr());
function consentFrom(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v || ['no', 'n', 'false', '0', 'none', 'not recorded'].includes(v)) return null;
  return CONSENT_SOURCES[v] ? v : 'imported';
}
// Messages held back for "no consent" return to Drafts as soon as that parent's consent is recorded.
function releaseHeld(schoolId) {
  db.prepare(`UPDATE messages SET status='draft', error=NULL WHERE school_id=? AND status='skipped' AND error LIKE 'No consent recorded%'
    AND contact_id IN (SELECT id FROM contacts WHERE school_id=? AND consent_at IS NOT NULL)`).run(schoolId, schoolId);
}

function cleanContact(b) {
  const phone = ch.normalizePhone(b.phone);
  const student = String(b.student_name || '').trim();
  if (!student) return { error: 'Student name is required' };
  if (!phone) return { error: `Invalid phone number: ${b.phone || '(empty)'}` };
  return {
    student_name: student,
    class_name: String(b.class_name || '').trim(),
    admission_no: String(b.admission_no || '').trim(),
    parent_name: String(b.parent_name || '').trim(),
    phone,
    channel: String(b.channel || '').toLowerCase() === 'sms' ? 'sms' : 'whatsapp',
  };
}

app.post('/api/contacts', requireAuth, (req, res) => {
  const c = cleanContact(req.body || {});
  if (c.error) return res.status(400).json({ error: c.error });
  const src = consentFrom((req.body || {}).consent);
  db.prepare(`INSERT INTO contacts(school_id, student_name, class_name, admission_no, parent_name, phone, channel, consent_at, consent_source) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.user.school_id, c.student_name, c.class_name, c.admission_no, c.parent_name, c.phone, c.channel, src ? todayStr() : null, src);
  res.json({ ok: true });
});

app.put('/api/contacts/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM contacts WHERE id=? AND school_id=?').get(req.params.id, req.user.school_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (Object.keys(b).length === 1 && 'opted_out' in b) {
    db.prepare('UPDATE contacts SET opted_out=? WHERE id=?').run(b.opted_out ? 1 : 0, existing.id);
    return res.json({ ok: true });
  }
  if ('consent_source' in b && Object.keys(b).every((k) => ['consent_source', 'consent_at'].includes(k))) {
    const src = String(b.consent_source || '');
    if (!src) db.prepare('UPDATE contacts SET consent_at=NULL, consent_source=NULL WHERE id=?').run(existing.id);
    else if (CONSENT_SOURCES[src]) {
      db.prepare('UPDATE contacts SET consent_at=?, consent_source=? WHERE id=?')
        .run(b.consent_at ? validDay(b.consent_at) : (existing.consent_at || todayStr()), src, existing.id);
      releaseHeld(req.user.school_id);
    } else return res.status(400).json({ error: 'Unknown consent source' });
    return res.json({ ok: true });
  }
  const c = cleanContact({ ...existing, ...b });
  if (c.error) return res.status(400).json({ error: c.error });
  db.prepare(`UPDATE contacts SET student_name=?, class_name=?, admission_no=?, parent_name=?, phone=?, channel=? WHERE id=?`)
    .run(c.student_name, c.class_name, c.admission_no, c.parent_name, c.phone, c.channel, existing.id);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id=? AND school_id=?').run(req.params.id, req.user.school_id);
  res.json({ ok: true });
});

app.post('/api/contacts/import', requireAuth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 2000) return res.status(400).json({ error: 'Import up to 2,000 rows at a time' });
  let added = 0, updated = 0;
  const skipped = [];
  const find = db.prepare('SELECT id FROM contacts WHERE school_id=? AND phone=? AND lower(student_name)=lower(?)');
  const ins = db.prepare(`INSERT INTO contacts(school_id, student_name, class_name, admission_no, parent_name, phone, channel, consent_at, consent_source) VALUES (?,?,?,?,?,?,?,?,?)`);
  const upd = db.prepare('UPDATE contacts SET class_name=?, admission_no=?, parent_name=?, channel=? WHERE id=?');
  const setConsent = db.prepare('UPDATE contacts SET consent_at=?, consent_source=? WHERE id=? AND consent_at IS NULL');
  db.transaction(() => {
    rows.forEach((r, i) => {
      const c = cleanContact(r);
      if (c.error) return skipped.push({ row: i + 2, reason: c.error });
      const src = consentFrom(r.consent);
      const hit = find.get(req.user.school_id, c.phone, c.student_name);
      if (hit) { upd.run(c.class_name, c.admission_no, c.parent_name, c.channel, hit.id); if (src) setConsent.run(todayStr(), src, hit.id); updated++; }
      else { ins.run(req.user.school_id, c.student_name, c.class_name, c.admission_no, c.parent_name, c.phone, c.channel, src ? todayStr() : null, src); added++; }
    });
  })();
  releaseHeld(req.user.school_id);
  res.json({ added, updated, skipped });
});

// Record consent for many parents at once (admin only). Only parents with no record yet are changed.
app.post('/api/contacts/consent', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const src = String(b.source || '');
  if (!CONSENT_SOURCES[src] || src === 'imported') return res.status(400).json({ error: 'Choose where the consent came from' });
  const day = validDay(b.date);
  const sid = req.user.school_id;
  const all = b.class_name === '*';
  const r = db.prepare(`UPDATE contacts SET consent_at=?, consent_source=? WHERE school_id=? AND consent_at IS NULL${all ? '' : ' AND class_name=?'}`)
    .run(...(all ? [day, src, sid] : [day, src, sid, String(b.class_name || '')]));
  releaseHeld(sid);
  res.json({ updated: r.changes });
});

// ---------------------------------------------------------------- drafting
function parseNotes(text, contacts) {
  const notes = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const note = line.slice(i + 1).trim();
    if (!note) continue;
    for (const c of contacts) {
      const full = c.student_name.toLowerCase();
      const first = ai.firstName(c.student_name).toLowerCase();
      const firstIsUnique = contacts.filter((x) => ai.firstName(x.student_name).toLowerCase() === first).length === 1;
      if (key === full || key === c.admission_no.toLowerCase() || (firstIsUnique && key === first)) notes[c.id] = note;
    }
  }
  return notes;
}

app.post('/api/drafts', requireAuth, wrap(async (req, res) => {
  const { kind, classes, contactIds, tone, language, facts, notesText } = req.body || {};
  if (!ai.KINDS[kind]) return res.status(400).json({ error: 'Choose a message type' });
  const factsText = String(facts || '').trim();
  if (kind !== 'progress' && kind !== 'absence' && kind !== 'late' && factsText.length < 3)
    return res.status(400).json({ error: 'Add the key facts for this message' });
  const sid = req.user.school_id;
  let contacts;
  if (Array.isArray(contactIds) && contactIds.length) {
    contacts = db.prepare(`SELECT * FROM contacts WHERE school_id=? AND id IN (${placeholders(contactIds.length)})`).all(sid, ...contactIds);
  } else if (Array.isArray(classes) && classes.length && !classes.includes('*')) {
    contacts = db.prepare(`SELECT * FROM contacts WHERE school_id=? AND class_name IN (${placeholders(classes.length)})`).all(sid, ...classes);
  } else {
    contacts = db.prepare('SELECT * FROM contacts WHERE school_id=?').all(sid);
  }
  const total = contacts.length;
  contacts = contacts.filter((c) => !c.opted_out);
  const optedOut = total - contacts.length;
  let noConsent = 0;
  if (db.prepare('SELECT require_consent FROM schools WHERE id=?').get(sid).require_consent) {
    const before = contacts.length;
    contacts = contacts.filter((c) => c.consent_at);
    noConsent = before - contacts.length;
  }
  if (!contacts.length) return res.status(400).json({ error: total ? (noConsent ? 'No parent in this audience has a consent record yet. Record consent on the Parents page first.' : 'Everyone in this audience has opted out') : 'No parents found. Add or import parents first.' });
  if (contacts.length > 200) return res.status(400).json({ error: `That audience has ${contacts.length} parents. Draft up to 200 at a time (pick fewer classes).` });

  const school = db.prepare('SELECT * FROM schools WHERE id=?').get(sid);
  const useTone = ai.TONES[tone] ? tone : school.default_tone;
  const useLang = ai.LANGUAGES.includes(language) ? language : school.default_language;
  const notes = parseNotes(notesText, contacts);
  const drafts = await ai.draftMessages({ school, kind, tone: useTone, language: useLang, facts: factsText, contacts, notes });

  const batchId = db.transaction(() => {
    const b = db.prepare('INSERT INTO batches(school_id, kind, tone, language, facts, created_by) VALUES (?,?,?,?,?,?)')
      .run(sid, kind, useTone, useLang, factsText, req.user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO messages(school_id, batch_id, contact_id, phone, channel, body, ai) VALUES (?,?,?,?,?,?,?)');
    for (const c of contacts) ins.run(sid, b, c.id, c.phone, c.channel, drafts[c.id].body, drafts[c.id].ai);
    return b;
  })();
  res.json({ batchId, count: contacts.length, aiDrafted: contacts.filter((c) => drafts[c.id].ai).length, optedOut, noConsent });
}));

// ---------------------------------------------------------------- messages
const GROUPS = { draft: ['draft'], sent: ['queued', 'sent', 'delivered', 'read'], failed: ['failed', 'skipped'] };

app.get('/api/messages', requireAuth, (req, res) => {
  const statuses = GROUPS[req.query.group] || GROUPS.draft;
  const rows = db.prepare(`SELECT m.*, c.student_name, c.parent_name, c.class_name, b.kind
    FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id LEFT JOIN batches b ON b.id=m.batch_id
    WHERE m.school_id=? AND m.status IN (${placeholders(statuses.length)})
    ORDER BY m.id DESC LIMIT 300`).all(req.user.school_id, ...statuses);
  const counts = {};
  for (const [g, s] of Object.entries(GROUPS))
    counts[g] = db.prepare(`SELECT COUNT(*) n FROM messages WHERE school_id=? AND status IN (${placeholders(s.length)})`).get(req.user.school_id, ...s).n;
  res.json({ messages: rows.map((m) => ({ ...m, ...(m.channel === 'sms' ? ch.smsSegments(m.body) : {}) })), counts });
});

app.put('/api/messages/:id', requireAuth, (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message is too long (max 1,000 characters)' });
  const r = db.prepare("UPDATE messages SET body=?, ai=0 WHERE id=? AND school_id=? AND status IN ('draft','failed')").run(body, req.params.id, req.user.school_id);
  if (!r.changes) return res.status(404).json({ error: 'Message not editable' });
  res.json({ ok: true });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  db.prepare("DELETE FROM messages WHERE id=? AND school_id=? AND status IN ('draft','failed','skipped')").run(req.params.id, req.user.school_id);
  res.json({ ok: true });
});

const DAY_STATUSES = "('queued','sent','delivered','read')";
function sentToday(schoolId) {
  return db.prepare(`SELECT COUNT(*) n FROM messages WHERE school_id=? AND status IN ${DAY_STATUSES} AND date(COALESCE(sent_at, created_at))=date('now')`).get(schoolId).n;
}

async function dispatch(schoolId, ids) {
  const school = db.prepare('SELECT * FROM schools WHERE id=?').get(schoolId);
  const get = db.prepare('SELECT m.*, c.opted_out, c.consent_at FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id WHERE m.id=? AND m.school_id=?');
  for (const id of ids) {
    const m = get.get(id, schoolId);
    if (!m || m.status !== 'queued') continue;
    if (m.opted_out) {
      db.prepare("UPDATE messages SET status='skipped', error='Parent opted out' WHERE id=?").run(id);
      continue;
    }
    if (school.require_consent && !m.consent_at) {
      db.prepare("UPDATE messages SET status='skipped', error='No consent recorded for this parent. Record it on the Parents page and this message returns to Drafts.' WHERE id=?").run(id);
      continue;
    }
    try {
      const r = await ch.send({ channel: m.channel, phone: m.phone, body: m.body, senderId: school.sender_id });
      db.prepare("UPDATE messages SET status='sent', provider_id=?, channel=?, error=?, sent_at=datetime('now') WHERE id=?")
        .run(r.id, r.channel, r.fallback ? 'WhatsApp failed - delivered by SMS instead' : null, id);
    } catch (err) {
      db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(String(err.message).slice(0, 300), id);
    }
    await sleep(250);
  }
}

function queueAndSend(schoolId, ids) {
  const rows = ids.length
    ? db.prepare(`SELECT id FROM messages WHERE school_id=? AND status IN ('draft','failed') AND id IN (${placeholders(ids.length)})`).all(schoolId, ...ids)
    : [];
  const limit = Number(process.env.DAILY_LIMIT || 500);
  const room = Math.max(0, limit - sentToday(schoolId));
  const go = rows.slice(0, room).map((r) => r.id);
  if (go.length) {
    db.prepare(`UPDATE messages SET status='queued', error=NULL WHERE id IN (${placeholders(go.length)})`).run(...go);
    dispatch(schoolId, go).catch((e) => console.error('dispatch error', e));
  }
  return { queued: go.length, heldBack: rows.length - go.length, dailyLimit: limit };
}

app.post('/api/messages/send', requireAuth, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one message' });
  res.json(queueAndSend(req.user.school_id, ids));
});

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT status, COUNT(*) n FROM messages WHERE school_id=? AND created_at >= datetime('now','-30 days') GROUP BY status`).all(req.user.school_id));
});

// ---------------------------------------------------------------- Class Register integration (absence alerts)
// POST /api/hooks/absence   header: x-api-key   body: { admission_no | student_name+class_name, date, status: "A"|"L" }
app.post('/api/hooks/absence', wrap(async (req, res) => {
  const school = db.prepare('SELECT * FROM schools WHERE api_key=?').get(req.get('x-api-key') || '');
  if (!school) return res.status(401).json({ error: 'Invalid API key' });
  const { admission_no, student_name, class_name, date, status } = req.body || {};
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
  const kind = String(status || 'A').toUpperCase() === 'L' ? 'late' : 'absence';
  let contacts = [];
  if (admission_no) contacts = db.prepare('SELECT * FROM contacts WHERE school_id=? AND admission_no=?').all(school.id, String(admission_no));
  if (!contacts.length && student_name)
    contacts = db.prepare('SELECT * FROM contacts WHERE school_id=? AND lower(student_name)=lower(?) AND (?=\'\' OR lower(class_name)=lower(?))')
      .all(school.id, String(student_name), String(class_name || ''), String(class_name || ''));
  if (!contacts.length) return res.status(404).json({ error: 'No matching student/parent found' });
  contacts = contacts.filter((c) => !c.opted_out);
  if (!contacts.length) return res.json({ ok: true, skipped: 'opted_out' });

  const facts = kind === 'late'
    ? `${ai.firstName(contacts[0].student_name)} arrived late to school on ${day}.`
    : `${ai.firstName(contacts[0].student_name)} was marked absent from school on ${day}.`;
  const drafts = await ai.draftMessages({ school, kind, tone: school.default_tone, language: school.default_language, facts, contacts });
  const ids = [];
  for (const c of contacts) {
    try {
      const r = db.prepare('INSERT INTO messages(school_id, contact_id, phone, channel, body, ai, dedupe_key) VALUES (?,?,?,?,?,?,?)')
        .run(school.id, c.id, c.phone, c.channel, drafts[c.id].body, drafts[c.id].ai, `${kind}:${c.id}:${day}`);
      ids.push(Number(r.lastInsertRowid));
    } catch { /* duplicate for that day - ignore */ }
  }
  if (!ids.length) return res.json({ ok: true, skipped: 'already_notified' });
  const result = school.auto_send_absence ? queueAndSend(school.id, ids) : null;
  res.json({ ok: true, messageIds: ids, status: school.auto_send_absence ? 'queued' : 'draft', ...(result || {}) });
}));

// ---------------------------------------------------------------- WhatsApp webhook (delivery receipts + STOP)
app.get('/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
app.post('/webhooks/whatsapp', (req, res) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.sendStatus(401);
  }
  try {
    for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const s of v.statuses || []) {
        const m = db.prepare('SELECT id, status FROM messages WHERE provider_id=?').get(s.id);
        if (!m) continue;
        if (s.status === 'failed') {
          db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(s.errors?.[0]?.title || 'WhatsApp delivery failed', m.id);
        } else if ((RANK[s.status] ?? -1) > (RANK[m.status] ?? 0)) {
          db.prepare('UPDATE messages SET status=? WHERE id=?').run(s.status, m.id);
        }
      }
      for (const msg of v.messages || []) {
        const text = String(msg.text?.body || '').trim().toUpperCase();
        if (['STOP', 'UNSUBSCRIBE', 'CANCEL'].includes(text)) db.prepare('UPDATE contacts SET opted_out=1 WHERE phone=?').run(msg.from);
        if (text === 'START') db.prepare('UPDATE contacts SET opted_out=0 WHERE phone=?').run(msg.from);
      }
    }
  } catch (e) { console.error('webhook error', e); }
  res.sendStatus(200);
});

/* SM-CONNECTION: link to SmartClass School Management (all of it lives in schoolmgmt.js).
   If it ever fails to start, the Parent Bot carries on exactly as before and only logs the reason. */
try {
  require('./schoolmgmt')(app, { db, requireAuth, requireAdmin, hash, sign, setCookie, ai, ch, queueAndSend, wrap });
} catch (e) {
  console.error('School Management connection could not start:', e.message);
}

/* BK-BACKUP: automatic off-site backups (Cloudflare R2). Only the owner account (the first administrator) can see them, because a backup holds every school's data.
   Does nothing until the BACKUP_S3_* settings exist. If it ever fails to start, the Bot carries on exactly as before and only logs the reason. */
try {
  const owner = (req, res, next) => {
    const first = db.prepare("SELECT MIN(id) AS id FROM users WHERE role='admin'").get();
    if (!first || first.id !== req.user.id) return res.status(403).json({ error: 'Only the owner account can manage backups' });
    next();
  };
  require('./backup-setup')(app, { db, guards: [requireAuth, requireAdmin, owner] });
} catch (e) {
  console.error('Automatic backups could not start:', e.message);
}

/* PW-RESET: password reset by email (a 6-digit code). Does nothing visible until the EMAIL_* settings exist.
   Only the owner account (the first administrator) sees its status card. If it ever fails to start, the Bot carries on exactly as before and only logs the reason. */
try {
  const resetOwner = (req, res, next) => {
    const first = db.prepare("SELECT MIN(id) AS id FROM users WHERE role='admin'").get();
    if (!first || first.id !== req.user.id) return res.status(403).json({ error: 'Only the owner account can manage this' });
    next();
  };
  require('./reset-setup')(app, { db, hash, guards: [requireAuth, requireAdmin, resetOwner] });
} catch (e) {
  console.error('Password reset could not start:', e.message);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Parent Communication Bot running on :${PORT}`));
