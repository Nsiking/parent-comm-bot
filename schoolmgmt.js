'use strict';
// Connection between the SmartClass Parent Communication Bot and SmartClass School Management.
//
//   1. Parents:         "Import parents from School Management" brings every active pupil and their main parent's
//                       phone number into the Parents list. Nothing is lost: opt-outs and the chosen channel are kept.
//   2. Fee reminders:   drafts a reminder for every family that owes fees, using the REAL balance from School
//                       Management. Nothing is sent until staff review and click Send (as always in the Bot).
//   3. Absence alerts:  drafts absence / late alerts from the attendance School Management has received.
//   4. Delivery status: every message that reaches a pupil's parent is noted on the pupil's page in School Management.
//   5. Single sign-on:  School Management's Open button signs existing Parent Bot staff straight in.
//
// A school that has not connected is not affected in any way: every route answers "not connected".
//
// Safety rules (do not loosen these without thinking):
//   * Nothing here sends a message. Everything creates DRAFTS, exactly like the Bot's own Compose screen.
//   * The amounts in a fee reminder are checked against School Management before a draft is saved: if the
//     AI's wording leaves the amount out or changes it, the built-in wording is used instead.
//   * Signing in through School Management only signs in somebody who ALREADY has a Parent Bot account at that
//     school. It never creates an account (a Parent Bot account can message every parent).
//   * The School Management key is stored encrypted and is never sent to the browser.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED_SCOPES = ['read:students', 'read:classes', 'read:terms', 'read:fees'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class SmError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

/* ---------- amounts ---------- */
function naira(kobo) {
  const whole = Math.floor(kobo / 100), k = kobo % 100;
  return '₦' + whole.toLocaleString('en-NG') + (k ? '.' + String(k).padStart(2, '0') : '');
}
// Does this message really say this amount? (55,000 / 55000 / 55,000.00 all count; 5,500 inside 55,000 does not)
function mentionsAmount(body, kobo) {
  const text = String(body).replace(/,/g, '');
  const whole = Math.floor(kobo / 100), k = kobo % 100;
  const re = new RegExp('(?<![0-9.])' + whole + (k ? '\\.' + String(k).padStart(2, '0') : '(?:\\.00)?') + '(?![0-9])');
  return re.test(text);
}

module.exports = function mountSchoolManagement(app, ctx) {
  const { db, requireAuth, requireAdmin, sign, setCookie, ai, ch, queueAndSend } = ctx;

  /* ---------- columns and tables (all empty until a school connects) ---------- */
  const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  for (const [name, type] of [['sm_url', 'TEXT'], ['sm_key', 'TEXT'], ['sm_school_id', 'INTEGER']]) if (!hasCol('schools', name)) db.exec(`ALTER TABLE schools ADD COLUMN ${name} ${type}`);
  if (!hasCol('contacts', 'sm_student_id')) db.exec('ALTER TABLE contacts ADD COLUMN sm_student_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_sm ON contacts(school_id, sm_student_id)');
  db.exec('CREATE TABLE IF NOT EXISTS sm_reported (message_id INTEGER PRIMARY KEY, status TEXT NOT NULL, at TEXT NOT NULL)');

  /* ---------- the stored key is encrypted (AES-256-GCM) ---------- */
  // The secret is SM_KEY_SECRET if set, otherwise a random one kept in a small file next to the database
  // (so a copy of the database alone cannot be used to read the key).
  let sealKey = null;
  function getSealKey() {
    if (sealKey) return sealKey;
    let secret = process.env.SM_KEY_SECRET;
    if (!secret) {
      const f = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'parentbot.db.smsecret');
      try { secret = fs.readFileSync(f, 'utf8').trim(); } catch (_) { /* first use */ }
      if (!secret) { secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, secret, { mode: 0o600 }); }
    }
    sealKey = crypto.createHash('sha256').update('sm-key:' + secret).digest();
    return sealKey;
  }
  const seal = (text) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', getSealKey(), iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  };
  function unseal(blob) {
    try {
      const [iv, tag, enc] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', getSealKey(), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch (_) {
      throw new SmError('The saved School Management key can no longer be read. The school administrator needs to connect again in Settings.', 409);
    }
  }

  /* ---------- talking to School Management ---------- */
  function normalizeUrl(v) {
    const s = String(v || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '').replace(/\/+$/, '');
    let u;
    try { u = new URL(s); } catch (_) { throw new SmError('That web address is not valid. Example: https://school.example.com'); }
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new SmError('The web address must start with https:// (http:// is only allowed for localhost).');
    if (u.username || u.password) throw new SmError('The web address must not contain a username or password.');
    return u.origin;
  }
  async function smCall(conn, method, p, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try {
      r = await fetch(conn.url + '/api/v1' + p, {
        method, headers: { Authorization: 'Bearer ' + conn.key, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal,
      });
    } catch (e) {
      throw new SmError(e.name === 'AbortError' ? 'School Management did not answer in time. Please try again.' : 'Could not reach School Management. Check the web address and the internet connection.', 502);
    } finally { clearTimeout(timer); }
    let j = null;
    try { j = await r.json(); } catch (_) { /* no body */ }
    if (!r.ok) {
      if (r.status === 401 && j && /sign-in code/i.test(j.error || '')) throw new SmError(j.error, 401);
      if (r.status === 401) throw new SmError('School Management did not accept the key. Ask the School Management administrator to check Settings, Connected products.', 502);
      if (r.status === 403) throw new SmError((j && j.error) || 'The School Management key is missing a permission for this. In School Management open Settings, Connected products, Edit, and tick the missing permissions.', 403);
      throw new SmError((j && j.error) || `School Management returned an error (${r.status}).`, 502);
    }
    return j;
  }
  function connectionOf(schoolId) {
    const s = db.prepare('SELECT id, name, sm_url, sm_key, sm_school_id FROM schools WHERE id = ?').get(schoolId);
    if (!s || !s.sm_url || !s.sm_key) throw new SmError("This school isn't connected to School Management yet. The school administrator can connect it in Settings.", 409);
    return { school: s, url: s.sm_url, key: unseal(s.sm_key) };
  }
  const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof SmError) return res.status(e.status).json({ error: e.message });
    console.error('School Management connection error:', e);
    res.status(500).json({ error: 'Something went wrong while talking to School Management.' });
  });
  const lagosToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  /* ---------- connect / disconnect ---------- */
  app.get('/api/sm', requireAuth, (req, res) => {
    const s = db.prepare('SELECT sm_url FROM schools WHERE id = ?').get(req.user.school_id);
    res.json({ connected: !!(s && s.sm_url), url: s && s.sm_url ? s.sm_url : null, canManage: req.user.role === 'admin', ai: !!process.env.ANTHROPIC_API_KEY });
  });

  app.put('/api/sm', requireAuth, requireAdmin, route(async (req, res) => {
    const url = normalizeUrl((req.body || {}).url);
    const key = String((req.body || {}).key || '').trim();
    if (!/^scsm_[A-Za-z0-9_-]{20,80}$/.test(key)) throw new SmError('That does not look like a School Management key. It starts with scsm_ and is shown once when the connection is created.');
    const info = await smCall({ url, key }, 'GET', '/school');
    const got = new Set((info.integration && info.integration.scopes) || []);
    const missing = REQUIRED_SCOPES.filter((x) => !got.has(x));
    if (missing.length) throw new SmError(`That key is missing permissions: ${missing.join(', ')}. In School Management open Settings, Connected products, Edit, and tick them.`);
    if (db.prepare('SELECT id FROM schools WHERE sm_school_id = ? AND id != ?').get(info.school.id, req.user.school_id)) throw new SmError('That School Management school is already connected to a different school here.', 409);
    db.prepare('UPDATE schools SET sm_url = ?, sm_key = ?, sm_school_id = ? WHERE id = ?').run(url, seal(key), info.school.id, req.user.school_id);
    res.json({
      ok: true, schoolName: info.school.name,
      notes: [!got.has('read:attendance') && 'Attendance is not ticked on that key, so absence alerts from School Management will not work.', !got.has('write:messages') && 'Sending messages is not ticked on that key, so delivered messages will not be noted on pupils\' pages.', !got.has('sso') && 'Single sign-on is not ticked on that key, so the Open button in School Management will not sign people in here.'].filter(Boolean),
    });
  }));

  app.delete('/api/sm', requireAuth, requireAdmin, (req, res) => {
    db.prepare('UPDATE schools SET sm_url = NULL, sm_key = NULL, sm_school_id = NULL WHERE id = ?').run(req.user.school_id);
    res.json({ ok: true });
  });

  app.get('/api/sm/terms', requireAuth, route(async (req, res) => {
    const conn = connectionOf(req.user.school_id);
    res.json((await smCall(conn, 'GET', '/terms')).data.map((t) => ({ id: t.id, name: t.name, year: t.year, is_current: !!t.is_current })));
  }));

  /* ---------- 1. parents from School Management ---------- */
  async function allPupils(conn) {
    const out = [];
    for (let page = 1; page <= 40; page++) {
      const r = await smCall(conn, 'GET', `/students?status=active&limit=500&page=${page}`);
      out.push(...r.data);
      if (page >= r.pages) break;
    }
    return out;
  }

  app.post('/api/sm/sync-parents', requireAuth, route(async (req, res) => {
    const sid = req.user.school_id;
    const conn = connectionOf(sid);
    const pupils = await allPupils(conn);
    if (!pupils.length) throw new SmError('School Management has no active pupils yet.', 409);
    const mine = db.prepare('SELECT * FROM contacts WHERE school_id = ?').all(sid);
    const bySm = new Map(), byAdm = new Map(), byPhoneName = new Map();
    for (const c of mine) {
      if (c.sm_student_id) bySm.set(c.sm_student_id, c);
      else {
        if (c.admission_no) byAdm.set(norm(c.admission_no), c);
        byPhoneName.set(c.phone + '|' + norm(c.student_name), c);
      }
    }
    const ins = db.prepare('INSERT INTO contacts (school_id, student_name, class_name, admission_no, parent_name, phone, channel, sm_student_id) VALUES (?,?,?,?,?,?,?,?)');
    const upd = db.prepare('UPDATE contacts SET student_name = ?, class_name = ?, admission_no = ?, parent_name = ?, phone = ?, sm_student_id = ? WHERE id = ?');
    let added = 0, updated = 0;
    const skipped = [];
    const seen = new Set();
    db.transaction(() => {
      for (const p of pupils) {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
        const g = (p.guardians || []).find((x) => x.is_primary) || (p.guardians || [])[0];
        const phone = g ? ch.normalizePhone(g.phone) || ch.normalizePhone(g.alt_phone) : null;
        if (!phone) { skipped.push({ pupil: name, class_name: p.class && p.class.name, reason: g ? 'The parent has no valid phone number' : 'No parent on record' }); continue; }
        seen.add(p.id);
        const cls = (p.class && p.class.name) || '';
        const hit = bySm.get(p.id) || (p.admission_no && byAdm.get(norm(p.admission_no))) || byPhoneName.get(phone + '|' + norm(name));
        if (hit) { upd.run(name, cls, p.admission_no || '', g.name || '', phone, p.id, hit.id); updated++; }
        else { ins.run(sid, name, cls, p.admission_no || '', g.name || '', phone, 'whatsapp', p.id); added++; }
      }
    })();
    const gone = mine.filter((c) => c.sm_student_id && !seen.has(c.sm_student_id) && !pupils.some((p) => p.id === c.sm_student_id)).length;
    res.json({ added, updated, skipped: skipped.slice(0, 200), skipped_count: skipped.length, no_longer_active: gone, pupils: pupils.length });
  }));

  /* ---------- helpers for drafting ---------- */
  function contactsByPupil(schoolId) {
    const bySm = new Map(), byAdm = new Map();
    for (const c of db.prepare('SELECT * FROM contacts WHERE school_id = ?').all(schoolId)) {
      if (c.sm_student_id) { if (!bySm.has(c.sm_student_id)) bySm.set(c.sm_student_id, []); bySm.get(c.sm_student_id).push(c); }
      if (c.admission_no) { const k = norm(c.admission_no); if (!byAdm.has(k)) byAdm.set(k, []); byAdm.get(k).push(c); }
    }
    return (pupil) => bySm.get(pupil.student_id) || (pupil.admission_no && byAdm.get(norm(pupil.admission_no))) || [];
  }
  function finalize(body, school, channel) {
    const sig = school.signature || school.name;
    let text = String(body || '').trim();
    if (!text.toLowerCase().includes(sig.toLowerCase())) text += `\n- ${sig}`;
    return channel === 'sms' ? ch.sanitizeSms(text) : text;
  }
  const greet = (c) => (c.parent_name ? `Dear ${c.parent_name}` : 'Dear Parent/Guardian');

  /* ---------- 2. fee reminders with the real balances ---------- */
  function feeNote(row, term) {
    const bits = [`Fees owing: ${naira(row.owed_total)}`];
    if (row.term_balance > 0 && row.earlier_owed > 0) bits.push(`(${naira(row.term_balance)} for ${term.name} ${term.year} and ${naira(row.earlier_owed)} from earlier terms)`);
    else if (row.term_balance > 0) bits.push(`(for ${term.name} ${term.year})`);
    else bits.push('(from earlier terms)');
    return bits.join(' ');
  }
  function feeTemplate(school, c, row, term, extra) {
    const kid = ai.firstName(c.student_name);
    let t = `${greet(c)}, a friendly reminder that ${kid}'s school fees balance is ${naira(row.owed_total)}`;
    if (row.term_balance > 0 && row.earlier_owed > 0) t += ` (${naira(row.term_balance)} for ${term.name} ${term.year} and ${naira(row.earlier_owed)} from earlier terms)`;
    else if (row.term_balance > 0) t += ` for ${term.name} ${term.year}`;
    else t += ' from earlier terms';
    t += `.${extra ? ' ' + extra : ''} Thank you for your support.`;
    return finalize(t, school, c.channel);
  }

  app.post('/api/sm/fee-drafts', requireAuth, route(async (req, res) => {
    const sid = req.user.school_id, b = req.body || {};
    const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(sid);
    const conn = connectionOf(sid);
    const terms = (await smCall(conn, 'GET', '/terms')).data;
    const term = terms.find((t) => t.id === Number(b.term_id)) || terms.find((t) => t.is_current) || terms[0];
    if (!term) throw new SmError('School Management has no academic term yet.', 409);
    const classes = Array.isArray(b.classes) ? b.classes.map(String).filter(Boolean) : [];
    const minKobo = Math.max(1, Math.round((Number(b.min_naira) || 1) * 100));
    const extra = String(b.facts || '').trim().slice(0, 500);
    const balances = (await smCall(conn, 'GET', `/fees/balances?term_id=${term.id}`)).data.filter((r) => r.owed_total >= minKobo);
    const find = contactsByPupil(sid);

    const targets = [];       // { c, row }
    const noContact = [];
    let optedOut = 0, families = 0, totalOwed = 0;
    for (const row of balances) {
      let cs = find(row);
      if (classes.length) cs = cs.filter((c) => classes.includes(c.class_name));
      if (!cs.length) { if (!classes.length) noContact.push({ pupil: `${row.last_name} ${row.first_name}`, class_name: row.class_name }); continue; }
      const live = cs.filter((c) => !c.opted_out);
      if (!live.length) { optedOut++; continue; }
      families++; totalOwed += row.owed_total;
      for (const c of live) targets.push({ c, row });
    }
    const summary = { term: `${term.name} ${term.year}`, families, messages: targets.length, total_owed: totalOwed, no_contact: noContact.slice(0, 30), no_contact_count: noContact.length, opted_out: optedOut, ai: !!process.env.ANTHROPIC_API_KEY };
    if (b.preview) return res.json(summary);
    if (!targets.length) throw new SmError(balances.length ? 'None of the families who owe fees could be messaged. Import the parents from School Management first, or check the class you chose.' : 'Nobody owes fees at the moment. Nothing to remind.', 409);
    if (targets.length > 200) throw new SmError(`That is ${targets.length} messages. Draft up to 200 at a time: choose a class.`, 400);

    const tone = ai.TONES[b.tone] ? b.tone : school.default_tone;
    const language = ai.LANGUAGES.includes(b.language) ? b.language : school.default_language;
    const rowOf = new Map(targets.map((t) => [t.c.id, t.row]));
    const contacts = targets.map((t) => t.c);
    let drafts = {};
    if (b.use_ai !== false && process.env.ANTHROPIC_API_KEY) {
      const notes = Object.fromEntries(targets.map((t) => [t.c.id, feeNote(t.row, term)]));
      drafts = await ai.draftMessages({ school, kind: 'fees', tone, language, facts: `Fee reminder for ${term.name} ${term.year}. ${extra}`.trim(), contacts, notes });
    }
    const today = lagosToday();
    let aiUsed = 0, templates = 0, already = 0;
    const out = db.transaction(() => {
      const batch = db.prepare('INSERT INTO batches(school_id, kind, tone, language, facts, created_by) VALUES (?,?,?,?,?,?)').run(sid, 'fees', tone, language, extra || `Fee reminder for ${term.name} ${term.year}`, req.user.id).lastInsertRowid;
      const insert = db.prepare('INSERT INTO messages(school_id, batch_id, contact_id, phone, channel, body, ai, dedupe_key) VALUES (?,?,?,?,?,?,?,?)');
      let made = 0;
      for (const c of contacts) {
        const row = rowOf.get(c.id);
        const d = drafts[c.id];
        // an amount in a message must be the real one: if the AI left it out or changed it, use the built-in wording
        const useAi = d && d.ai && mentionsAmount(d.body, row.owed_total);
        const body = useAi ? d.body : feeTemplate(school, c, row, term, extra);
        try { insert.run(sid, batch, c.id, c.phone, c.channel, body, useAi ? 1 : 0, `fees:${c.id}:${today}`); made++; useAi ? aiUsed++ : templates++; } catch (_) { already++; }
      }
      if (!made) db.prepare('DELETE FROM batches WHERE id = ?').run(batch);
      return { batch: made ? batch : null, made };
    })();
    if (!out.made) throw new SmError('Reminders for these families were already drafted or sent today. Check the Messages screen.', 409);
    res.json({ ...summary, batchId: out.batch, count: out.made, aiDrafted: aiUsed, templates, already_today: already });
  }));

  /* ---------- 3. absence / late alerts from the attendance School Management has ---------- */
  app.post('/api/sm/absence-drafts', requireAuth, route(async (req, res) => {
    const sid = req.user.school_id, b = req.body || {};
    const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(sid);
    const conn = connectionOf(sid);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : lagosToday();
    const marks = (await smCall(conn, 'GET', `/daily-attendance?date=${day}`)).data;
    if (!marks.length) throw new SmError(`School Management has no attendance for ${day} yet. Teachers mark it in Class Register, and it arrives within a few minutes.`, 409);
    const find = contactsByPupil(sid);
    const groups = { absence: [], late: [] };
    const noContact = [];
    for (const m of marks) {
      const sess = [m.am, m.pm].filter(Boolean);
      const kind = sess.length && sess.every((x) => x === 'A') ? 'absence' : sess.includes('L') ? 'late' : null;
      if (!kind) continue;
      const cs = find(m).filter((c) => !c.opted_out);
      if (!cs.length) { noContact.push(m.admission_no); continue; }
      groups[kind].push(...cs);
    }
    const ids = [];
    let already = 0;
    for (const kind of ['absence', 'late']) {
      const contacts = groups[kind];
      if (!contacts.length) continue;
      const facts = kind === 'late' ? `Each child named was marked late to school on ${day}.` : `Each child named was marked absent from school on ${day}.`;
      const drafts = await ai.draftMessages({ school, kind, tone: school.default_tone, language: school.default_language, facts, contacts });
      for (const c of contacts) {
        try {
          const r = db.prepare('INSERT INTO messages(school_id, contact_id, phone, channel, body, ai, dedupe_key) VALUES (?,?,?,?,?,?,?)').run(sid, c.id, c.phone, c.channel, drafts[c.id].body, drafts[c.id].ai, `${kind}:${c.id}:${day}`);
          ids.push(Number(r.lastInsertRowid));
        } catch (_) { already++; }   // already notified that day (by this button or by the Class Register hook)
      }
    }
    const sent = school.auto_send_absence && ids.length ? queueAndSend(sid, ids) : null;
    res.json({ date: day, absent: groups.absence.length, late: groups.late.length, drafted: ids.length, already_notified: already, no_contact: noContact.length, auto_sent: !!sent });
  }));

  /* ---------- 4. delivered messages noted on the pupil's page ---------- */
  let pushing = false;
  async function pushStatuses() {
    if (pushing) return { busy: true };
    pushing = true;
    const result = { pushed: 0, errors: 0 };
    try {
      for (const school of db.prepare('SELECT id, name, sm_url, sm_key FROM schools WHERE sm_url IS NOT NULL AND sm_key IS NOT NULL').all()) {
        let conn;
        try { conn = { url: school.sm_url, key: unseal(school.sm_key) }; } catch (_) { result.errors++; continue; }
        // one note per message: once it is delivered/read/failed, or has been "sent" for 10 minutes (SMS gives no receipt)
        const rows = db.prepare(
          `SELECT m.id, m.status, m.channel, m.provider_id, m.dedupe_key, b.kind AS batch_kind, c.sm_student_id
           FROM messages m JOIN contacts c ON c.id = m.contact_id LEFT JOIN batches b ON b.id = m.batch_id
           WHERE m.school_id = ? AND c.sm_student_id IS NOT NULL AND m.status IN ('sent','delivered','read','failed')
             AND m.created_at >= datetime('now','-30 days') AND (m.status != 'sent' OR m.sent_at <= datetime('now','-10 minutes'))
             AND m.id NOT IN (SELECT message_id FROM sm_reported) ORDER BY m.id LIMIT 500`
        ).all(school.id);
        for (let i = 0; i < rows.length; i += 100) {
          const chunk = rows.slice(i, i + 100);
          const events = chunk.map((m) => {
            const kind = m.batch_kind || String(m.dedupe_key || '').split(':')[0] || 'general';
            return { student_id: m.sm_student_id, channel: m.channel === 'sms' ? 'sms' : 'whatsapp', status: m.status, kind, summary: ai.KINDS[kind] || 'Message to parent', external_id: m.provider_id || `pcb-${m.id}` };
          });
          try { await smCall(conn, 'POST', '/message-status', { events }); }
          catch (e) { result.errors++; if (e.status === 403) break; continue; }   // missing permission: stop for this school
          const mark = db.prepare("INSERT OR REPLACE INTO sm_reported (message_id, status, at) VALUES (?,?,datetime('now'))");
          db.transaction(() => { for (const m of chunk) mark.run(m.id, m.status); })();
          result.pushed += chunk.length;
        }
      }
    } finally { pushing = false; }
    return result;
  }
  if (process.env.SM_SYNC !== 'off') {
    const every = Math.max(1, Number(process.env.SM_SYNC_SECONDS) || 300) * 1000;   // every 5 minutes unless told otherwise
    const log = (e) => console.error('School Management status sync failed:', e.message);
    setTimeout(() => pushStatuses().catch(log), Math.min(60000, every)).unref();
    setInterval(() => pushStatuses().catch(log), every).unref();
  }

  /* ---------- 5. single sign-on ---------- */
  const page = (message) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parent Communication Bot</title>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:12vh auto;padding:0 20px;color:#1f2d27">
<h2>We could not sign you in</h2><p>${esc(message)}</p><p><a href="/">Go to the sign-in page</a></p></body>`;

  app.get('/sso', async (req, res) => {
    const refuse = (msg, status = 401) => res.status(status).set('Cache-Control', 'no-store').send(page(msg));
    try {
      const code = String(req.query.code || '').slice(0, 200);
      if (!code) return refuse('This sign-in link is incomplete. Please open the Parent Bot again from School Management.');
      const smId = parseInt(req.query.school, 10);
      const school = Number.isInteger(smId) ? db.prepare('SELECT * FROM schools WHERE sm_school_id = ? AND sm_key IS NOT NULL').get(smId) : null;
      if (!school) return refuse("This school isn't connected to School Management yet. Ask your administrator to connect it in Settings.", 409);
      const r = await smCall({ url: school.sm_url, key: unseal(school.sm_key) }, 'POST', '/sso/exchange', { code });
      if (r.school.id !== school.sm_school_id) return refuse('This sign-in does not belong to this school.', 403);
      const email = String(r.user.email || '').trim().toLowerCase();
      const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
      if (!user || user.school_id !== school.id) return refuse('You do not have a Parent Bot account at this school. Ask your Parent Bot administrator to add you in Settings, then try again.', 403);
      setCookie(res, sign(user));
      res.set('Cache-Control', 'no-store').redirect('/');
    } catch (e) {
      refuse(e instanceof SmError ? e.message : 'Sign-in failed. Please open the Parent Bot again from School Management.', e instanceof SmError && e.status >= 500 ? 502 : 401);
    }
  });

  return { pushStatuses };
};

module.exports.mentionsAmount = mentionsAmount;
module.exports.naira = naira;
