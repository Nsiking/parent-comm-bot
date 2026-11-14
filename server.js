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
  if (req.user.role !== 'admin') { delete school.api_key; delete school.optin_token; }
  res.json({
    user: req.user,
    my_classes: myClasses(req.user),
    owner: isOwnerAccount(req.user),
    school,
    kinds: ai.KINDS,
    tones: ai.TONES,
    languages: ai.LANGUAGES,
    providers: { ai: !!process.env.ANTHROPIC_API_KEY, ...ch.status() },
    origin: `${req.protocol}://${req.get('host')}`,
  });
});

// ---------------------------------------------------------------- activity log (administrators can read it; it never blocks the action it records)
function logActivity(user, action, detail) {
  try {
    db.prepare('INSERT INTO activity_log(school_id, user_id, user_name, action, detail) VALUES (?,?,?,?,?)')
      .run(user.school_id, user.id, user.name, action, detail ? String(detail).slice(0, 300) : null);
    if (Math.random() < 0.02)   // keep the latest 5,000 entries per school
      db.prepare('DELETE FROM activity_log WHERE school_id=? AND id <= COALESCE((SELECT id FROM activity_log WHERE school_id=? ORDER BY id DESC LIMIT 1 OFFSET 5000), 0)').run(user.school_id, user.school_id);
  } catch (e) { console.error('Activity log error', e.message); }
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
app.get('/api/activity', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100), offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const uid = Number(req.query.user) || 0;
  const where = `school_id=?${uid ? ' AND user_id=?' : ''}`, params = uid ? [sid, uid] : [sid];
  const total = db.prepare(`SELECT COUNT(*) n FROM activity_log WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT id, user_id, user_name, action, detail, datetime(created_at, '+1 hour') AS at FROM activity_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const people = db.prepare('SELECT DISTINCT user_id AS id, user_name AS name FROM activity_log WHERE school_id=? ORDER BY user_name').all(sid);
  res.json({ total, rows, people });
});
// Colleagues at the same school (names only), so a reply can be given to one of them.
app.get('/api/colleagues', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM users WHERE school_id=? ORDER BY name').all(req.user.school_id));
});

// ---------------------------------------------------------------- class limits (a teacher with classes assigned only works with those classes)
// No assignment means no limit, so nothing changes until an administrator assigns classes. Administrators are never limited.
function myClasses(user) {
  if (!user || user.role === 'admin') return null;
  const r = db.prepare('SELECT class_name FROM staff_classes WHERE user_id=?').all(user.id);
  return r.length ? r.map((x) => x.class_name) : null;
}
const inClasses = (list, col) => (list ? { sql: ` AND ${col} IN (${placeholders(list.length)})`, params: list } : { sql: '', params: [] });
// of these message ids, the ones this person may work with
function mineIds(user, ids) {
  const list = myClasses(user);
  if (!list || !ids.length) return ids;
  return db.prepare(`SELECT m.id FROM messages m JOIN contacts c ON c.id=m.contact_id WHERE m.school_id=? AND c.class_name IN (${placeholders(list.length)}) AND m.id IN (${placeholders(ids.length)})`)
    .all(user.school_id, ...list, ...ids).map((r) => r.id);
}
const NOT_YOUR_CLASS = 'That class is not one of yours. Ask an administrator.';
app.get('/api/staff-classes', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id;
  const teachers = db.prepare("SELECT id, name FROM users WHERE school_id=? AND role='staff' ORDER BY name").all(sid)
    .map((t) => ({ ...t, classes: db.prepare('SELECT class_name FROM staff_classes WHERE user_id=? ORDER BY class_name').all(t.id).map((x) => x.class_name) }));
  const names = new Set(db.prepare("SELECT DISTINCT class_name FROM contacts WHERE school_id=? AND class_name<>''").all(sid).map((r) => r.class_name));
  teachers.forEach((t) => t.classes.forEach((c) => names.add(c)));
  res.json({ teachers, classes: [...names].sort((a, b) => a.localeCompare(b)) });
});
app.put('/api/staff-classes/:id', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id;
  const t = db.prepare("SELECT id, name FROM users WHERE id=? AND school_id=? AND role='staff'").get(Number(req.params.id) || 0, sid);
  if (!t) return res.status(404).json({ error: 'That teacher was not found in your school' });
  const list = [...new Set((Array.isArray(req.body?.classes) ? req.body.classes : []).map((c) => String(c).trim()).filter(Boolean))].slice(0, 100);
  const known = new Set(db.prepare("SELECT DISTINCT class_name FROM contacts WHERE school_id=? AND class_name<>''").all(sid).map((r) => r.class_name));
  db.prepare('SELECT class_name FROM staff_classes WHERE user_id=?').all(t.id).forEach((r) => known.add(r.class_name));
  const bad = list.find((c) => !known.has(c));
  if (bad) return res.status(400).json({ error: `${bad} is not a class in your parent list` });
  db.transaction(() => {
    db.prepare('DELETE FROM staff_classes WHERE user_id=?').run(t.id);
    const ins = db.prepare('INSERT INTO staff_classes(user_id, class_name) VALUES (?,?)');
    list.forEach((c) => ins.run(t.id, c));
  })();
  logActivity(req.user, 'classes', `${t.name}: ${list.length ? list.join(', ') : 'no limit (sees everyone)'}`);
  res.json({ ok: true, classes: list });
});

// ---------------------------------------------------------------- parent opt-in link
// A school can switch on a link that parents open WITHOUT signing in. They type their child's name and phone number and agree.
// A match with a parent already in the list records consent; anything else waits for an administrator. The answer is always the same,
// so the page never reveals who is or is not in the list.
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const optinLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const optinViewLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const optinPage = (school, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escHtml(school.name)}</title></head>
<body style="margin:0;background:#f6f3ea;font-family:Arial,Helvetica,sans-serif;color:#12332c"><div style="max-width:480px;margin:0 auto;padding:24px 16px">
<div style="background:#12332c;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">${escHtml(school.name)}</div>
<div style="background:#fff;padding:20px;border-radius:0 0 12px 12px;border:1px solid #e3dcc8">${inner}</div></div></body></html>`;
const optinForm = (school, token, error) => optinPage(school, `<h1 style="font-size:20px;margin:0 0 10px">Receive messages from the school</h1>
<p style="line-height:1.5;margin:0 0 14px">Please give ${escHtml(school.name)} your permission to send you messages about your child, such as notices, absences and results, by WhatsApp or SMS. You can stop at any time by replying STOP.</p>
${error ? `<p style="background:#fdecea;color:#8a1f11;padding:10px;border-radius:8px">${escHtml(error)}</p>` : ''}
<form method="post" action="/optin/${token}" autocomplete="off">
<label style="display:block;margin-bottom:12px">Your child's full name<input name="student_name" required maxlength="120" style="display:block;width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin-top:4px"></label>
<label style="display:block;margin-bottom:12px">Your name (optional)<input name="parent_name" maxlength="120" style="display:block;width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin-top:4px"></label>
<label style="display:block;margin-bottom:12px">Your phone number<input name="phone" inputmode="tel" required maxlength="20" placeholder="0803 123 4567" style="display:block;width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin-top:4px"></label>
<div style="position:absolute;left:-9999px" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
<label style="display:block;margin-bottom:16px;line-height:1.4"><input type="checkbox" name="agree" value="yes" required> I agree to receive messages from ${escHtml(school.name)} about my child.</label>
<button type="submit" style="background:#f4b400;color:#12332c;border:0;padding:12px 18px;font-size:16px;font-weight:bold;border-radius:8px;cursor:pointer">Give my consent</button></form>`);
const optinThanks = (school) => optinPage(school, `<h1 style="font-size:20px;margin:0 0 10px">Thank you</h1><p style="line-height:1.5;margin:0">Your answer has been received. If the details match the school's records, your consent is now recorded. The school may contact you to check the details.</p>`);
function optinSchool(token) {
  return /^[a-f0-9]{32}$/.test(String(token)) ? db.prepare('SELECT id, name FROM schools WHERE optin_token=?').get(token) : null;
}
const optinMissing = (res) => res.status(404).set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link not found</title><body style="font-family:Arial,sans-serif;padding:24px">This link is not active. Please ask the school for the current one.</body>');
app.get('/optin/:token', optinViewLimiter, (req, res) => {
  const school = optinSchool(req.params.token);
  if (!school) return optinMissing(res);
  res.set('Cache-Control', 'no-store').type('html').send(optinForm(school, req.params.token));
});
app.post('/optin/:token', optinLimiter, express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const school = optinSchool(req.params.token);
  if (!school) return optinMissing(res);
  res.set('Cache-Control', 'no-store').type('html');
  const b = req.body || {};
  if (b.website) return res.send(optinThanks(school));            // a hidden field only a robot fills in
  const name = String(b.student_name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const parent = String(b.parent_name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const phone = ch.normalizePhone(b.phone);
  if (b.agree !== 'yes') return res.status(400).send(optinForm(school, req.params.token, 'Please tick the box to give your consent.'));
  if (!name || !phone) return res.status(400).send(optinForm(school, req.params.token, "Please enter your child's name and a valid phone number."));
  const same = db.prepare('SELECT id, student_name, opted_out FROM contacts WHERE school_id=? AND phone=?').all(school.id, phone);
  const key = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const matched = same.some((c) => key(c.student_name) === key(name));
  let note = null;
  if (matched) {
    const ok = same.filter((c) => !c.opted_out);
    if (ok.length) {
      db.prepare(`UPDATE contacts SET consent_at=?, consent_source='parent_online' WHERE school_id=? AND consent_at IS NULL AND id IN (${placeholders(ok.length)})`).run(todayStr(), school.id, ...ok.map((c) => c.id));
      releaseHeld(school.id);
      return res.send(optinThanks(school));
    }
    note = 'This parent had opted out (replied STOP). Consent was not recorded automatically.';
  } else note = same.length ? 'This phone number is in your list, but under a different child name.' : 'This phone number is not in your list.';
  const dup = db.prepare("SELECT 1 FROM optin_requests WHERE school_id=? AND status='pending' AND phone=? AND lower(student_name)=lower(?)").get(school.id, phone, name);
  const count = db.prepare("SELECT COUNT(*) n FROM optin_requests WHERE school_id=? AND status='pending'").get(school.id).n;
  if (!dup && count < 300) db.prepare('INSERT INTO optin_requests(school_id, student_name, parent_name, phone, note) VALUES (?,?,?,?,?)').run(school.id, name, parent, phone, note);
  res.send(optinThanks(school));
});
// For the administrator: the link, and what is waiting.
app.get('/api/optin', requireAuth, requireAdmin, (req, res) => {
  const s = schoolRow(req.user.school_id);
  res.json({ link: s.optin_token ? `${req.protocol}://${req.get('host')}/optin/${s.optin_token}` : null,
    pending: db.prepare("SELECT COUNT(*) n FROM optin_requests WHERE school_id=? AND status='pending'").get(req.user.school_id).n });
});
app.post('/api/optin/enable', requireAuth, requireAdmin, (req, res) => {
  const had = !!schoolRow(req.user.school_id).optin_token, token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE schools SET optin_token=? WHERE id=?').run(token, req.user.school_id);
  logActivity(req.user, 'settings', had ? 'Parent opt-in link: new link made (the old one stopped working)' : 'Parent opt-in link: switched on');
  res.json({ link: `${req.protocol}://${req.get('host')}/optin/${token}` });
});
app.delete('/api/optin', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE schools SET optin_token=NULL WHERE id=?').run(req.user.school_id);
  logActivity(req.user, 'settings', 'Parent opt-in link: switched off');
  res.json({ ok: true });
});
app.get('/api/optin/pending', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id;
  res.json({ total: db.prepare("SELECT COUNT(*) n FROM optin_requests WHERE school_id=? AND status='pending'").get(sid).n,
    list: db.prepare("SELECT id, student_name, parent_name, phone, note, datetime(created_at, '+1 hour') AS at FROM optin_requests WHERE school_id=? AND status='pending' ORDER BY id DESC LIMIT 100").all(sid) });
});
app.post('/api/optin/:id/ignore', requireAuth, requireAdmin, (req, res) => {
  const r = db.prepare("UPDATE optin_requests SET status='ignored' WHERE id=? AND school_id=? AND status='pending'").run(Number(req.params.id) || 0, req.user.school_id);
  if (!r.changes) return res.status(404).json({ error: 'That request is no longer waiting' });
  res.json({ ok: true });
});
app.post('/api/optin/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id;
  const p = db.prepare("SELECT * FROM optin_requests WHERE id=? AND school_id=? AND status='pending'").get(Number(req.params.id) || 0, sid);
  if (!p) return res.status(404).json({ error: 'That request is no longer waiting' });
  const same = db.prepare('SELECT id, opted_out FROM contacts WHERE school_id=? AND phone=?').all(sid, p.phone);
  let recorded = 0, added = false;
  if (same.length) {
    const ok = same.filter((c) => !c.opted_out);
    if (ok.length) recorded = db.prepare(`UPDATE contacts SET consent_at=?, consent_source='parent_online' WHERE school_id=? AND consent_at IS NULL AND id IN (${placeholders(ok.length)})`).run(todayStr(), sid, ...ok.map((c) => c.id)).changes;
    else return res.status(409).json({ error: 'This parent opted out (replied STOP), so consent cannot be recorded. Ignore this request, or ask the parent to opt in again.' });
  } else {
    const cls = String(req.body?.class_name || '').trim();
    if (!cls) return res.status(409).json({ error: 'No parent in your list has this phone number. Type a class to add this child as a new parent.' });
    db.prepare(`INSERT INTO contacts(school_id, student_name, class_name, parent_name, phone, channel, consent_at, consent_source) VALUES (?,?,?,?,?,?,?,?)`)
      .run(sid, p.student_name, cls.slice(0, 60), p.parent_name || '', p.phone, 'whatsapp', todayStr(), 'parent_online');
    added = true;
  }
  db.prepare("UPDATE optin_requests SET status='approved' WHERE id=?").run(p.id);
  releaseHeld(sid);
  logActivity(req.user, 'consent', added ? `${p.student_name} added as a new parent with consent (opt-in link)` : `Consent recorded for ${p.student_name} (opt-in link, approved)`);
  res.json({ ok: true, added, recorded });
});

// ---------------------------------------------------------------- school settings & staff
app.put('/api/school', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const was = schoolRow(req.user.school_id);
  // quiet hours are checked first, so a bad time saves nothing at all
  let quiet = null;
  if ('quiet_on' in b || 'quiet_start' in b || 'quiet_end' in b) {
    const s = String(b.quiet_start || '').trim(), e = String(b.quiet_end || '').trim();
    if (b.quiet_on === false || b.quiet_on === 0) quiet = { s: null, e: null };
    else {
      if (!HHMM.test(s) || !HHMM.test(e)) return res.status(400).json({ error: 'Quiet hours need a start and an end time, like 21:00 and 06:00' });
      if (s === e) return res.status(400).json({ error: 'The start and end of quiet hours must be different times' });
      quiet = { s, e };
    }
  }
  const sender = String(b.sender_id || 'SmartClass').replace(/[^A-Za-z0-9]/g, '').slice(0, 11) || 'SmartClass';
  db.prepare(`UPDATE schools SET name=?, sender_id=?, signature=?, default_tone=?, default_language=?, auto_send_absence=? WHERE id=?`)
    .run(String(b.name || '').trim() || 'My School', sender, String(b.signature || '').trim(),
      ai.TONES[b.default_tone] ? b.default_tone : 'warm',
      ai.LANGUAGES.includes(b.default_language) ? b.default_language : 'English',
      b.auto_send_absence ? 1 : 0, req.user.school_id);
  if ('require_consent' in b) db.prepare('UPDATE schools SET require_consent=? WHERE id=?').run(b.require_consent ? 1 : 0, req.user.school_id);
  if ('require_approval' in b) db.prepare('UPDATE schools SET require_approval=? WHERE id=?').run(b.require_approval ? 1 : 0, req.user.school_id);
  if (quiet) db.prepare('UPDATE schools SET quiet_start=?, quiet_end=? WHERE id=?').run(quiet.s, quiet.e, req.user.school_id);
  const now = schoolRow(req.user.school_id), changes = [];
  const flag = (k, label) => { if (!!was[k] !== !!now[k]) changes.push(`${label}: ${now[k] ? 'on' : 'off'}`); };
  flag('auto_send_absence', 'Automatic absence alerts'); flag('require_consent', 'Consent required'); flag('require_approval', 'Teachers need approval');
  if (was.quiet_start !== now.quiet_start || was.quiet_end !== now.quiet_end) changes.push(now.quiet_start ? `Quiet hours: ${now.quiet_start} to ${now.quiet_end}` : 'Quiet hours: off');
  if (was.name !== now.name) changes.push(`School name: ${now.name}`);
  if (was.sender_id !== now.sender_id) changes.push(`SMS sender ID: ${now.sender_id}`);
  if (changes.length) logActivity(req.user, 'settings', changes.join('; '));
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
  const lim = inClasses(myClasses(req.user), 'class_name');
  res.json(db.prepare(`SELECT class_name AS name, COUNT(*) AS total, SUM(opted_out=0) AS reachable, SUM(opted_out=0 AND consent_at IS NOT NULL) AS consented, SUM(consent_at IS NOT NULL) AS with_consent
    FROM contacts WHERE school_id=?${lim.sql} GROUP BY class_name ORDER BY class_name`).all(req.user.school_id, ...lim.params));
});

app.get('/api/contacts', requireAuth, (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const gid = Number(req.query.group) || 0;
  const lim = inClasses(myClasses(req.user), 'class_name');
  res.json(db.prepare(`SELECT * FROM contacts WHERE school_id=? AND
      (lower(student_name) LIKE ? OR lower(parent_name) LIKE ? OR lower(class_name) LIKE ? OR phone LIKE ? OR lower(admission_no) LIKE ?)${lim.sql}
      ${gid ? 'AND id IN (SELECT contact_id FROM parent_group_members WHERE group_id=?)' : ''}
      ORDER BY class_name, student_name LIMIT 500`).all(req.user.school_id, q, q, q, q, q, ...lim.params, ...(gid ? [gid] : [])));
});

// ---- consent record: where/when a parent agreed to receive messages
const CONSENT_SOURCES = { admission_form: 'Admission form', verbal: 'Verbal', other: 'Other', imported: 'Imported list', parent_online: 'Parent confirmed online' };
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

// A birthday is kept as MM-DD (the year is not needed). People type it the Nigerian way, day first: 15/03, 15-3, 15 March, 15/03/2014.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// -> 'MM-DD', '' (nothing typed) or null (not a date)
function parseBirthday(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let d, m, x;
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*\d{2,4})?$/.exec(s))) { d = +x[1]; m = +x[2]; }
  else if ((x = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-\/.]*([A-Za-z]{3,9})\.?(?:[\s,\-\/.]*\d{2,4})?$/.exec(s))) { d = +x[1]; m = MONTHS.indexOf(x[2].slice(0, 3).toLowerCase()) + 1; }
  else if ((x = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*\d{4})?$/.exec(s))) { m = MONTHS.indexOf(x[1].slice(0, 3).toLowerCase()) + 1; d = +x[2]; }
  else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= DAYS_IN[m - 1])) return null;
  return String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
const bdayShow = (md) => (/^\d{2}-\d{2}$/.test(md || '') ? md.slice(3) + '/' + md.slice(0, 2) : '');
function cleanContact(b) {
  const phone = ch.normalizePhone(b.phone);
  const student = String(b.student_name || '').trim();
  if (!student) return { error: 'Student name is required' };
  if (!phone) return { error: `Invalid phone number: ${b.phone || '(empty)'}` };
  const bday = parseBirthday(b.birthday);
  if (bday === null) return { error: `Invalid birthday: ${b.birthday}. Write the day first, like 15/03` };
  return {
    student_name: student,
    class_name: String(b.class_name || '').trim(),
    admission_no: String(b.admission_no || '').trim(),
    parent_name: String(b.parent_name || '').trim(),
    phone,
    channel: String(b.channel || '').toLowerCase() === 'sms' ? 'sms' : 'whatsapp',
    birthday: bday,
  };
}

app.post('/api/contacts', requireAuth, (req, res) => {
  const c = cleanContact(req.body || {});
  if (c.error) return res.status(400).json({ error: c.error });
  { const mine = myClasses(req.user); if (mine && !mine.includes(c.class_name)) return res.status(403).json({ error: NOT_YOUR_CLASS }); }
  const src = consentFrom((req.body || {}).consent);
  db.prepare(`INSERT INTO contacts(school_id, student_name, class_name, admission_no, parent_name, phone, channel, consent_at, consent_source, birthday) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.school_id, c.student_name, c.class_name, c.admission_no, c.parent_name, c.phone, c.channel, src ? todayStr() : null, src, c.birthday || null);
  res.json({ ok: true });
});

app.put('/api/contacts/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM contacts WHERE id=? AND school_id=?').get(req.params.id, req.user.school_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const mineCls = myClasses(req.user);
  if (mineCls && !mineCls.includes(existing.class_name)) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (Object.keys(b).length === 1 && 'opted_out' in b) {
    db.prepare('UPDATE contacts SET opted_out=? WHERE id=?').run(b.opted_out ? 1 : 0, existing.id);
    return res.json({ ok: true });
  }
  if (Object.keys(b).length === 1 && 'birthday' in b) {
    const bd = parseBirthday(b.birthday);
    if (bd === null) return res.status(400).json({ error: `Invalid birthday: ${b.birthday}. Write the day first, like 15/03` });
    db.prepare('UPDATE contacts SET birthday=? WHERE id=?').run(bd || null, existing.id);
    return res.json({ ok: true, birthday: bdayShow(bd) });
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
  const c = cleanContact({ ...existing, birthday: bdayShow(existing.birthday), ...b });
  if (c.error) return res.status(400).json({ error: c.error });
  if (mineCls && !mineCls.includes(c.class_name)) return res.status(403).json({ error: NOT_YOUR_CLASS });
  db.prepare(`UPDATE contacts SET student_name=?, class_name=?, admission_no=?, parent_name=?, phone=?, channel=?, birthday=? WHERE id=?`)
    .run(c.student_name, c.class_name, c.admission_no, c.parent_name, c.phone, c.channel, c.birthday || null, existing.id);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  const gone = db.prepare('SELECT student_name, class_name FROM contacts WHERE id=? AND school_id=?').get(req.params.id, req.user.school_id);
  { const mine = myClasses(req.user); if (gone && mine && !mine.includes(gone.class_name)) return res.status(403).json({ error: NOT_YOUR_CLASS }); }
  const r = db.prepare('DELETE FROM contacts WHERE id=? AND school_id=?').run(req.params.id, req.user.school_id);
  if (r.changes && gone) logActivity(req.user, 'parent_deleted', `${gone.student_name}${gone.class_name ? ', ' + gone.class_name : ''}`);
  res.json({ ok: true });
});

app.post('/api/contacts/import', requireAuth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 2000) return res.status(400).json({ error: 'Import up to 2,000 rows at a time' });
  let added = 0, updated = 0;
  const skipped = [];
  const mineCls = myClasses(req.user);
  const find = db.prepare('SELECT id FROM contacts WHERE school_id=? AND phone=? AND lower(student_name)=lower(?)');
  const ins = db.prepare(`INSERT INTO contacts(school_id, student_name, class_name, admission_no, parent_name, phone, channel, consent_at, consent_source, birthday) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const upd = db.prepare("UPDATE contacts SET class_name=?, admission_no=?, parent_name=?, channel=?, birthday=CASE WHEN ?<>'' THEN ? ELSE birthday END WHERE id=?");
  const setConsent = db.prepare('UPDATE contacts SET consent_at=?, consent_source=? WHERE id=? AND consent_at IS NULL');
  db.transaction(() => {
    rows.forEach((r, i) => {
      const c = cleanContact(r);
      if (c.error) return skipped.push({ row: i + 2, reason: c.error });
      if (mineCls && !mineCls.includes(c.class_name)) return skipped.push({ row: i + 2, reason: c.class_name ? `Class ${c.class_name} is not one of yours` : 'A class is required for your account' });
      const src = consentFrom(r.consent);
      const hit = find.get(req.user.school_id, c.phone, c.student_name);
      if (hit) { upd.run(c.class_name, c.admission_no, c.parent_name, c.channel, c.birthday, c.birthday, hit.id); if (src) setConsent.run(todayStr(), src, hit.id); updated++; }
      else { ins.run(req.user.school_id, c.student_name, c.class_name, c.admission_no, c.parent_name, c.phone, c.channel, src ? todayStr() : null, src, c.birthday || null); added++; }
    });
  })();
  releaseHeld(req.user.school_id);
  logActivity(req.user, 'imported', `${added} added, ${updated} updated${skipped.length ? `, ${skipped.length} left out` : ''}`);
  res.json({ added, updated, skipped });
});

// Check a file BEFORE importing it: nothing is saved. Shows what would be added or updated, which rows have problems, and classes that look like typos.
const classKey = (s) => String(s || '').toLowerCase().replace(/[\s\-_.]/g, '');
app.post('/api/contacts/import-check', requireAuth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 2000) return res.status(400).json({ error: 'Import up to 2,000 rows at a time' });
  const sid = req.user.school_id;
  const find = db.prepare('SELECT id FROM contacts WHERE school_id=? AND phone=? AND lower(student_name)=lower(?)');
  const existing = new Set(db.prepare('SELECT DISTINCT class_name FROM contacts WHERE school_id=? AND class_name<>\'\'').all(sid).map((r) => r.class_name));
  const seen = new Map(), phoneKids = new Map(), classCount = new Map();
  const mineCls = myClasses(req.user);
  const skipped = [], repeated = [], noClass = [];
  let add = 0, update = 0;
  rows.forEach((r, i) => {
    const row = i + 2, c = cleanContact(r);
    if (c.error) return skipped.push({ row, reason: c.error });
    if (mineCls && !mineCls.includes(c.class_name)) return skipped.push({ row, reason: c.class_name ? `Class ${c.class_name} is not one of yours` : 'A class is required for your account' });
    const key = `${c.phone}|${c.student_name.toLowerCase()}`;
    if (seen.has(key)) repeated.push({ row, first: seen.get(key), student: c.student_name });
    else { seen.set(key, row); if (find.get(sid, c.phone, c.student_name)) update++; else add++; }
    if (!c.class_name) noClass.push({ row, student: c.student_name });
    else classCount.set(c.class_name, (classCount.get(c.class_name) || 0) + 1);
    if (!phoneKids.has(c.phone)) phoneKids.set(c.phone, new Set());
    phoneKids.get(c.phone).add(c.student_name.toLowerCase());
  });
  const byKey = new Map();
  for (const n of [...existing, ...classCount.keys()]) { const k = classKey(n); if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(n); }
  const classes = [...classCount.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({
    name, count, isNew: existing.size > 0 && !existing.has(name),
    similar: [...byKey.get(classKey(name))].filter((x) => x !== name),
  }));
  res.json({
    total: rows.length, add, update,
    skippedTotal: skipped.length, skipped: skipped.slice(0, 20),
    repeatedTotal: repeated.length, repeated: repeated.slice(0, 20),
    noClassTotal: noClass.length, noClass: noClass.slice(0, 20),
    sharedPhones: [...phoneKids.values()].filter((s) => s.size > 1).length,
    classes,
  });
});

// Everything sent to one parent (and what they wrote back), newest first.
app.get('/api/contacts/:id/history', requireAuth, (req, res) => {
  const sid = req.user.school_id;
  const c = db.prepare('SELECT * FROM contacts WHERE id=? AND school_id=?').get(req.params.id, sid);
  if (!c) return res.status(404).json({ error: 'Parent not found' });
  { const mine = myClasses(req.user); if (mine && !mine.includes(c.class_name)) return res.status(404).json({ error: 'Parent not found' }); }
  const messages = db.prepare(`SELECT m.id, ${WHEN_SQL} AS at, m.status, m.channel, m.body, m.error, ${KIND_SQL} AS kind
    ${HISTORY_FROM} WHERE m.school_id=? AND m.contact_id=? ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 100`).all(sid, c.id);
  const replies = db.prepare("SELECT id, body, datetime(received_at, '+1 hour') AS at FROM parent_replies WHERE school_id=? AND phone=? ORDER BY id DESC LIMIT 50").all(sid, c.phone);
  const groups = db.prepare('SELECT g.name FROM parent_group_members mm JOIN parent_groups g ON g.id=mm.group_id WHERE mm.contact_id=? AND g.school_id=? ORDER BY lower(g.name)').all(c.id, sid).map((g) => g.name);
  res.json({
    contact: { id: c.id, student_name: c.student_name, class_name: c.class_name, parent_name: c.parent_name, phone: c.phone, channel: c.channel, opted_out: c.opted_out, consent_at: c.consent_at, consent_source: c.consent_source },
    groups, messages, replies,
  });
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

// ---------------------------------------------------------------- SMS usage
// Counts come from the message records already kept. A long SMS is sent in several parts, and each part is charged.
// Messages sent while SMS was in test (dry-run) mode carry a "mock-" id and are listed apart, because nothing really went out.
const monthBefore = (m) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 2, 1)); return d.toISOString().slice(0, 7); };
function smsUsage(schoolId, month) {
  const rows = db.prepare(`SELECT m.status AS status, m.channel AS channel, m.body AS body, m.provider_id AS provider_id, ${KIND_SQL} AS kind
    ${HISTORY_FROM} WHERE m.school_id=? AND m.status IN ('queued','sent','delivered','read','failed') AND strftime('%Y-%m', ${WHEN_SQL}) = ?`).all(schoolId, month);
  const u = { month, messages: 0, parts: 0, failed: 0, test: 0, whatsapp: 0, by_kind: [] };
  const kinds = {};
  for (const r of rows) {
    if (r.channel !== 'sms') { if (r.status !== 'failed' && !String(r.provider_id || '').startsWith('mock-')) u.whatsapp += 1; continue; }
    if (r.status === 'failed') { u.failed += 1; continue; }
    if (String(r.provider_id || '').startsWith('mock-')) { u.test += 1; continue; }
    const parts = ch.smsSegments(ch.sanitizeSms(r.body || '')).segments;
    u.messages += 1; u.parts += parts;
    const k = kinds[r.kind || ''] || (kinds[r.kind || ''] = { label: ai.KINDS[r.kind] || 'Other', messages: 0, parts: 0 });
    k.messages += 1; k.parts += parts;
  }
  u.by_kind = Object.values(kinds).sort((a, b) => b.parts - a.parts || a.label.localeCompare(b.label));
  return u;
}
app.get('/api/sms/usage', requireAuth, requireAdmin, (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date(Date.now() + 3600e3).toISOString().slice(0, 7);
  const price = db.prepare('SELECT sms_price FROM schools WHERE id=?').get(req.user.school_id).sms_price;
  res.json({ price: price == null ? null : price, months: [smsUsage(req.user.school_id, month), smsUsage(req.user.school_id, monthBefore(month))] });
});
app.put('/api/sms/price', requireAuth, requireAdmin, (req, res) => {
  const raw = String((req.body || {}).price ?? '').trim().replace(/^[₦N]\s*/i, '').replace(/,/g, '');
  if (raw === '') { db.prepare('UPDATE schools SET sms_price=NULL WHERE id=?').run(req.user.school_id); return res.json({ ok: true, price: null }); }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ error: 'Enter the price as a number, for example 4 or 4.5' });
  const price = Math.round(n * 100) / 100;
  db.prepare('UPDATE schools SET sms_price=? WHERE id=?').run(price, req.user.school_id);
  res.json({ ok: true, price });
});

// ---------------------------------------------------------------- saved templates
// A template stores the message type, tone, language and key facts. Everyone at the school sees the same list;
// the person who saved one, or an administrator, can replace or delete it.
const TEMPLATE_LIMIT = 50;
function cleanTemplate(body) {
  const b = body || {};
  const title = String(b.title || '').trim().replace(/\s+/g, ' ');
  const kind = String(b.kind || '');
  const facts = String(b.facts || '').trim();
  if (title.length < 2 || title.length > 60) return { error: 'Give the template a name of 2 to 60 characters' };
  if (!ai.KINDS[kind]) return { error: 'Choose a message type' };
  if (facts.length > 1500) return { error: 'The key facts are too long (1,500 characters at most)' };
  if (kind !== 'progress' && kind !== 'absence' && kind !== 'late' && facts.length < 3) return { error: 'Add the key facts before saving a template' };
  const tone = ai.TONES[b.tone] ? b.tone : '';
  const language = ai.LANGUAGES.includes(b.language) ? b.language : '';
  return { title, kind, facts, tone, language };
}
const templateRow = (t, user) => ({ id: t.id, title: t.title, kind: t.kind, facts: t.facts, tone: t.tone, language: t.language, by: t.created_by_name, can_change: user.role === 'admin' || t.created_by === user.id });
function ownTemplate(req, res) {
  const t = db.prepare('SELECT * FROM message_templates WHERE id=? AND school_id=?').get(+req.params.id, req.user.school_id);
  if (!t) { res.status(404).json({ error: 'Template not found' }); return null; }
  if (req.user.role !== 'admin' && t.created_by !== req.user.id) { res.status(403).json({ error: 'Only the person who saved this template, or an administrator, can change it' }); return null; }
  return t;
}
app.get('/api/templates', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM message_templates WHERE school_id=? ORDER BY lower(title), id').all(req.user.school_id);
  res.json(rows.map((t) => templateRow(t, req.user)));
});
app.post('/api/templates', requireAuth, (req, res) => {
  const c = cleanTemplate(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const sid = req.user.school_id;
  if (db.prepare('SELECT COUNT(*) n FROM message_templates WHERE school_id=?').get(sid).n >= TEMPLATE_LIMIT)
    return res.status(400).json({ error: `Your school already has ${TEMPLATE_LIMIT} saved templates. Delete one you no longer use first` });
  if (db.prepare('SELECT 1 FROM message_templates WHERE school_id=? AND lower(title)=lower(?)').get(sid, c.title))
    return res.status(409).json({ error: 'A template with that name already exists' });
  const id = db.prepare('INSERT INTO message_templates(school_id, title, kind, facts, tone, language, created_by, created_by_name) VALUES (?,?,?,?,?,?,?,?)')
    .run(sid, c.title, c.kind, c.facts, c.tone, c.language, req.user.id, req.user.name).lastInsertRowid;
  res.json({ ok: true, template: templateRow(db.prepare('SELECT * FROM message_templates WHERE id=?').get(id), req.user) });
});
app.put('/api/templates/:id', requireAuth, (req, res) => {
  const t = ownTemplate(req, res); if (!t) return;
  const c = cleanTemplate(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  if (db.prepare('SELECT 1 FROM message_templates WHERE school_id=? AND lower(title)=lower(?) AND id<>?').get(t.school_id, c.title, t.id))
    return res.status(409).json({ error: 'A template with that name already exists' });
  db.prepare('UPDATE message_templates SET title=?, kind=?, facts=?, tone=?, language=? WHERE id=?').run(c.title, c.kind, c.facts, c.tone, c.language, t.id);
  res.json({ ok: true, template: templateRow(db.prepare('SELECT * FROM message_templates WHERE id=?').get(t.id), req.user) });
});
app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const t = ownTemplate(req, res); if (!t) return;
  db.prepare('DELETE FROM message_templates WHERE id=?').run(t.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- parent groups (any set of parents you choose, besides classes)
const MAX_GROUPS = 50;
function groupList(sid, mine) {
  const lim = inClasses(mine, 'c.class_name');
  return db.prepare(`SELECT g.id, g.name, COUNT(c.id) AS total, COALESCE(SUM(c.opted_out=0), 0) AS reachable
    FROM parent_groups g LEFT JOIN parent_group_members mm ON mm.group_id=g.id LEFT JOIN contacts c ON c.id=mm.contact_id${lim.sql}
    WHERE g.school_id=? GROUP BY g.id ORDER BY lower(g.name)`).all(...lim.params, sid);
}
const idList = (v) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
app.get('/api/groups', requireAuth, (req, res) => res.json(groupList(req.user.school_id, myClasses(req.user))));

app.post('/api/groups/add', requireAuth, (req, res) => {
  const sid = req.user.school_id;
  const ids = idList(req.body?.contactIds);
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one parent first' });
  let g;
  const gid = Number(req.body?.groupId) || 0;
  if (gid) {
    g = db.prepare('SELECT * FROM parent_groups WHERE id=? AND school_id=?').get(gid, sid);
    if (!g) return res.status(404).json({ error: 'That group no longer exists' });
  } else {
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: 'Choose a group or type a name for a new one' });
    if (name.length > 40) return res.status(400).json({ error: 'The group name is too long (max 40 characters)' });
    g = db.prepare('SELECT * FROM parent_groups WHERE school_id=? AND name=? COLLATE NOCASE').get(sid, name);
    if (!g) {
      if (db.prepare('SELECT COUNT(*) n FROM parent_groups WHERE school_id=?').get(sid).n >= MAX_GROUPS)
        return res.status(400).json({ error: `A school can have up to ${MAX_GROUPS} groups. Delete one you no longer use.` });
      const r = db.prepare('INSERT INTO parent_groups(school_id, name) VALUES (?,?)').run(sid, name);
      g = { id: Number(r.lastInsertRowid), name };
    }
  }
  const lim = inClasses(myClasses(req.user), 'class_name');
  const mine = db.prepare(`SELECT id FROM contacts WHERE school_id=? AND id IN (${placeholders(ids.length)})${lim.sql}`).all(sid, ...ids, ...lim.params).map((r) => r.id);
  const ins = db.prepare('INSERT OR IGNORE INTO parent_group_members(group_id, contact_id) VALUES (?,?)');
  let added = 0;
  db.transaction(() => { for (const id of mine) added += ins.run(g.id, id).changes; })();
  if (added) logActivity(req.user, 'group', `${plural(added, 'parent')} added to group "${g.name}"`);
  res.json({ ok: true, group: { id: g.id, name: g.name }, added, already: mine.length - added });
});

app.post('/api/groups/remove', requireAuth, (req, res) => {
  const sid = req.user.school_id;
  const g = db.prepare('SELECT id FROM parent_groups WHERE id=? AND school_id=?').get(Number(req.body?.groupId) || 0, sid);
  if (!g) return res.status(404).json({ error: 'That group no longer exists' });
  const ids = idList(req.body?.contactIds);
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one parent first' });
  const lim = inClasses(myClasses(req.user), 'class_name');
  const r = db.prepare(`DELETE FROM parent_group_members WHERE group_id=? AND contact_id IN (SELECT id FROM contacts WHERE school_id=? AND id IN (${placeholders(ids.length)})${lim.sql})`).run(g.id, sid, ...ids, ...lim.params);
  res.json({ ok: true, removed: r.changes });
});

app.delete('/api/groups/:id', requireAuth, (req, res) => {
  if (myClasses(req.user)) return res.status(403).json({ error: 'Only an administrator can delete a group' });
  const gone = db.prepare('SELECT name FROM parent_groups WHERE id=? AND school_id=?').get(req.params.id, req.user.school_id);
  db.prepare('DELETE FROM parent_groups WHERE id=? AND school_id=?').run(req.params.id, req.user.school_id);   // the parents themselves are not touched
  if (gone) logActivity(req.user, 'group', `Group "${gone.name}" deleted`);
  res.json({ ok: true });
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
  const groupIds = idList(req.body?.groups);
  if (!ai.KINDS[kind]) return res.status(400).json({ error: 'Choose a message type' });
  const factsText = String(facts || '').trim();
  if (kind !== 'progress' && kind !== 'absence' && kind !== 'late' && factsText.length < 3)
    return res.status(400).json({ error: 'Add the key facts for this message' });
  const sid = req.user.school_id;
  let contacts;
  if (Array.isArray(contactIds) && contactIds.length) {
    contacts = db.prepare(`SELECT * FROM contacts WHERE school_id=? AND id IN (${placeholders(contactIds.length)})`).all(sid, ...contactIds);
  } else if (groupIds.length && !(Array.isArray(classes) && classes.includes('*'))) {
    // chosen groups, plus any chosen classes; a parent in two of them is drafted once
    const cl = Array.isArray(classes) ? classes : [];
    contacts = db.prepare(`SELECT DISTINCT c.* FROM contacts c WHERE c.school_id=? AND (
        c.id IN (SELECT mm.contact_id FROM parent_group_members mm JOIN parent_groups g ON g.id=mm.group_id WHERE g.school_id=? AND g.id IN (${placeholders(groupIds.length)}))
        ${cl.length ? `OR c.class_name IN (${placeholders(cl.length)})` : ''})`).all(sid, sid, ...groupIds, ...cl);
  } else if (Array.isArray(classes) && classes.length && !classes.includes('*')) {
    contacts = db.prepare(`SELECT * FROM contacts WHERE school_id=? AND class_name IN (${placeholders(classes.length)})`).all(sid, ...classes);
  } else {
    contacts = db.prepare('SELECT * FROM contacts WHERE school_id=?').all(sid);
  }
  { const mine = myClasses(req.user); if (mine) contacts = contacts.filter((c) => mine.includes(c.class_name)); }
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
  logActivity(req.user, 'drafted', `${plural(contacts.length, 'message')}: ${ai.KINDS[kind]}`);
  res.json({ batchId, count: contacts.length, aiDrafted: contacts.filter((c) => drafts[c.id].ai).length, optedOut, noConsent });
}));

// ---------------------------------------------------------------- messages
const GROUPS = { draft: ['draft'], scheduled: ['scheduled'], sent: ['queued', 'sent', 'delivered', 'read'], failed: ['failed', 'skipped'] };

app.get('/api/messages', requireAuth, (req, res) => {
  const statuses = GROUPS[req.query.group] || GROUPS.draft;
  const lim = inClasses(myClasses(req.user), 'c.class_name');
  const rows = db.prepare(`SELECT m.*, c.student_name, c.parent_name, c.class_name, b.kind, datetime(m.scheduled_at, '+1 hour') AS scheduled_wat, ru.name AS approval_by
    FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id LEFT JOIN batches b ON b.id=m.batch_id LEFT JOIN users ru ON ru.id=m.approval_requested_by
    WHERE m.school_id=? AND m.status IN (${placeholders(statuses.length)})${lim.sql}
    ORDER BY ${req.query.group === 'scheduled' ? 'm.scheduled_at ASC, m.id ASC' : 'm.id DESC'} LIMIT 300`).all(req.user.school_id, ...statuses, ...lim.params);
  const counts = {};
  for (const [g, s] of Object.entries(GROUPS))
    counts[g] = db.prepare(`SELECT COUNT(*) n FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id WHERE m.school_id=? AND m.status IN (${placeholders(s.length)})${lim.sql}`).get(req.user.school_id, ...s, ...lim.params).n;
  const approvals = db.prepare(`SELECT COUNT(*) n FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id WHERE m.school_id=? AND m.status IN ('draft','failed') AND m.approval_requested_at IS NOT NULL${lim.sql}`).get(req.user.school_id, ...lim.params).n;
  res.json({ messages: rows.map((m) => ({ ...m, ...(m.channel === 'sms' ? ch.smsSegments(m.body) : {}) })), counts, approvals });
});

app.put('/api/messages/:id', requireAuth, (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message is too long (max 1,000 characters)' });
  if (!mineIds(req.user, [Number(req.params.id) || 0]).length) return res.status(404).json({ error: 'Message not editable' });
  const before = db.prepare("SELECT approval_requested_at AS a, body FROM messages WHERE id=? AND school_id=? AND status IN ('draft','failed')").get(req.params.id, req.user.school_id);
  const r = db.prepare("UPDATE messages SET body=?, ai=0 WHERE id=? AND school_id=? AND status IN ('draft','failed')").run(body, req.params.id, req.user.school_id);
  if (!r.changes) return res.status(404).json({ error: 'Message not editable' });
  // a changed text is no longer what the administrator was asked to approve
  const reset = !!(before && before.a && before.body !== body);
  if (reset) db.prepare('UPDATE messages SET approval_requested_at=NULL, approval_requested_by=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true, approvalReset: reset });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  if (!mineIds(req.user, [Number(req.params.id) || 0]).length) return res.status(404).json({ error: 'Message not found' });
  const r = db.prepare("DELETE FROM messages WHERE id=? AND school_id=? AND status IN ('draft','failed','skipped')").run(req.params.id, req.user.school_id);
  if (r.changes) logActivity(req.user, 'discarded', 'A message was discarded');
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

// Quiet hours: a window (Nigerian time) in which nothing is sent. It may cross midnight (21:00 to 06:00). Off when either time is empty.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function inQuiet(school, minutes) {
  if (!school || !HHMM.test(school.quiet_start || '') || !HHMM.test(school.quiet_end || '')) return false;
  const a = toMin(school.quiet_start), b = toMin(school.quiet_end);
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}
function watMinutesNow() { const w = new Date(Date.now() + 3600e3); return w.getUTCHours() * 60 + w.getUTCMinutes(); }
const quietNow = (school) => inQuiet(school, watMinutesNow());
const quietText = (school) => `Messages are not sent between ${school.quiet_start} and ${school.quiet_end} (Nigerian time). They stay in Drafts. Send them after ${school.quiet_end}.`;
const schoolRow = (id) => db.prepare('SELECT * FROM schools WHERE id=?').get(id);

function queueAndSend(schoolId, ids) {
  const sch = schoolRow(schoolId);
  if (quietNow(sch)) return { queued: 0, heldBack: 0, dailyLimit: Number(process.env.DAILY_LIMIT || 500), quiet: { start: sch.quiet_start, end: sch.quiet_end } };
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
  let ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one message' });
  ids = mineIds(req.user, ids);
  if (!ids.length) return res.status(403).json({ error: 'Those messages are not in your classes.' });
  const sch = schoolRow(req.user.school_id);
  if (sch.require_approval && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Your school needs an administrator to approve messages before they are sent. Use "Ask for approval".' });
  if (quietNow(sch)) return res.status(409).json({ error: quietText(sch) });
  const approved = sch.require_approval ? db.prepare(`SELECT COUNT(*) n FROM messages WHERE school_id=? AND approval_requested_at IS NOT NULL AND status IN ('draft','failed') AND id IN (${placeholders(ids.length)})`).get(req.user.school_id, ...ids).n : 0;
  const out = queueAndSend(req.user.school_id, ids);
  if (out.queued) logActivity(req.user, 'sent', `${plural(out.queued, 'message')} sent${approved ? `, ${approved} of them after a request for approval` : ''}${out.heldBack ? `, ${out.heldBack} held back by the daily limit` : ''}`);
  res.json(out);
});

// A teacher asks the administrator to approve drafts (used when the school setting "Teachers need approval" is on).
app.post('/api/messages/request-approval', requireAuth, (req, res) => {
  let ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one message' });
  ids = mineIds(req.user, ids);
  if (!ids.length) return res.status(403).json({ error: 'Those messages are not in your classes.' });
  if (!schoolRow(req.user.school_id).require_approval) return res.status(400).json({ error: 'Approval is not switched on for this school' });
  const r = db.prepare(`UPDATE messages SET approval_requested_at=datetime('now'), approval_requested_by=? WHERE school_id=? AND status IN ('draft','failed') AND id IN (${placeholders(ids.length)})`)
    .run(req.user.id, req.user.school_id, ...ids);
  if (r.changes) logActivity(req.user, 'requested', `Asked for approval of ${plural(r.changes, 'message')}`);
  res.json({ requested: r.changes });
});

// ---------------------------------------------------------------- history, CSV export and monthly summary
// The database stores UTC; history shows Nigerian time (WAT, UTC+1), like the School Management connection does.
const WHEN_SQL = "datetime(COALESCE(m.sent_at, m.created_at), '+1 hour')";
const KIND_SQL = "CASE WHEN b.kind IS NOT NULL THEN b.kind WHEN m.dedupe_key LIKE 'absence:%' THEN 'absence' WHEN m.dedupe_key LIKE 'late:%' THEN 'late' ELSE NULL END";
const HISTORY_FROM = 'FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id LEFT JOIN batches b ON b.id=m.batch_id';
const HISTORY_STATUS = { sent: ['queued', 'sent', 'delivered', 'read'], failed: ['failed'], skipped: ['skipped'], draft: ['draft'], scheduled: ['scheduled'] };

function historyFilter(schoolId, query, user) {
  const where = ['m.school_id=?'];
  const params = [schoolId];
  { const lim = inClasses(myClasses(user), 'c.class_name'); if (lim.sql) { where.push(lim.sql.slice(5)); params.push(...lim.params); } }
  const text = String(query.q || '').trim().toLowerCase();
  if (text) {
    const like = `%${text}%`;
    const phone = ch.normalizePhone(text);
    where.push(`(lower(c.parent_name) LIKE ? OR lower(c.student_name) LIKE ? OR lower(c.class_name) LIKE ? OR m.phone LIKE ?${phone ? ' OR m.phone = ?' : ''})`);
    params.push(like, like, like, like);
    if (phone) params.push(phone);
  }
  const st = HISTORY_STATUS[query.status];
  if (st) { where.push(`m.status IN (${placeholders(st.length)})`); params.push(...st); }
  if (ai.KINDS[query.kind]) { where.push(`(${KIND_SQL}) = ?`); params.push(query.kind); }
  const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);
  if (day(query.from)) { where.push(`date(${WHEN_SQL}) >= ?`); params.push(day(query.from)); }
  if (day(query.to)) { where.push(`date(${WHEN_SQL}) <= ?`); params.push(day(query.to)); }
  return { where: where.join(' AND '), params };
}

app.get('/api/messages/history', requireAuth, (req, res) => {
  const f = historyFilter(req.user.school_id, req.query, req.user);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) AS n ${HISTORY_FROM} WHERE ${f.where}`).get(...f.params).n;
  const rows = db.prepare(`SELECT m.id, ${WHEN_SQL} AS at, m.status, m.channel, m.phone, m.body, m.error, c.parent_name, c.student_name, c.class_name, ${KIND_SQL} AS kind
    ${HISTORY_FROM} WHERE ${f.where} ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT ? OFFSET ?`).all(...f.params, limit, offset);
  res.json({ total, rows });
});

// A spreadsheet can run text that starts with = + - @ as a formula, so such text is stored with a leading apostrophe.
const csvCell = (v) => {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const prettyPhone = (p) => {
  const d = String(p || '');
  return /^234\d{10}$/.test(d) ? `+234 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : (d ? '+' + d : '');
};

// ---------------------------------------------------------------- download your lists (administrators): parents, groups, classes
// The first eight columns of the parents file are the same as the import template, so the file can be corrected in Excel and imported again.
const sendCsv = (res, name, lines) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}-${todayStr()}.csv"`);
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
};
app.get('/api/export/parents.csv', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id;
  const groups = {};
  for (const g of db.prepare('SELECT mm.contact_id AS cid, g.name FROM parent_group_members mm JOIN parent_groups g ON g.id=mm.group_id WHERE g.school_id=? ORDER BY lower(g.name)').all(sid)) (groups[g.cid] = groups[g.cid] || []).push(g.name);
  const rows = db.prepare('SELECT * FROM contacts WHERE school_id=? ORDER BY class_name, student_name, id').all(sid);
  const lines = ['student_name,class,parent_name,phone,admission_no,channel,consent,birthday,consent_date,opted_out,groups'];
  for (const c of rows) {
    lines.push([c.student_name, c.class_name, c.parent_name].map(csvCell).concat([prettyPhone(c.phone)],
      [c.admission_no, c.channel, c.consent_source || 'no', bdayShow(c.birthday), c.consent_at || '', c.opted_out ? 'yes' : 'no', (groups[c.id] || []).join('; ')].map(csvCell)).join(','));
  }
  logActivity(req.user, 'exported', `Downloaded the parents list (${plural(rows.length, 'row')})`);
  sendCsv(res, 'parent-bot-parents', lines);
});
app.get('/api/export/groups.csv', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT g.name AS grp, c.student_name, c.class_name, c.parent_name, c.phone FROM parent_groups g
    JOIN parent_group_members mm ON mm.group_id=g.id JOIN contacts c ON c.id=mm.contact_id WHERE g.school_id=? AND c.school_id=g.school_id ORDER BY lower(g.name), c.class_name, c.student_name`).all(req.user.school_id);
  const lines = ['group,student_name,class,parent_name,phone'];
  for (const r of rows) lines.push([r.grp, r.student_name, r.class_name, r.parent_name].map(csvCell).concat([prettyPhone(r.phone)]).join(','));
  logActivity(req.user, 'exported', `Downloaded the groups list (${plural(rows.length, 'row')})`);
  sendCsv(res, 'parent-bot-groups', lines);
});
app.get('/api/export/classes.csv', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT class_name AS name, COUNT(*) AS total, SUM(opted_out=0) AS reachable, SUM(consent_at IS NOT NULL) AS with_consent, SUM(opted_out=1) AS opted_out
    FROM contacts WHERE school_id=? GROUP BY class_name ORDER BY class_name`).all(req.user.school_id);
  const lines = ['class,parents,can_receive_messages,consent_recorded,opted_out'];
  for (const r of rows) lines.push([r.name || '(no class)', r.total, r.reachable || 0, r.with_consent || 0, r.opted_out || 0].map(csvCell).join(','));
  logActivity(req.user, 'exported', `Downloaded the classes list (${plural(rows.length, 'row')})`);
  sendCsv(res, 'parent-bot-classes', lines);
});

app.get('/api/messages/export.csv', requireAuth, (req, res) => {
  const f = historyFilter(req.user.school_id, req.query, req.user);
  const rows = db.prepare(`SELECT ${WHEN_SQL} AS at, m.status, m.channel, m.phone, m.body, m.error, c.parent_name, c.student_name, c.class_name, ${KIND_SQL} AS kind
    ${HISTORY_FROM} WHERE ${f.where} ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 20000`).all(...f.params);
  const head = ['Date', 'Time', 'Class', 'Student', 'Parent', 'Phone', 'Type', 'Channel', 'Status', 'Reason', 'Message'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const cells = [String(r.at).slice(0, 10), String(r.at).slice(11, 16), r.class_name, r.student_name, r.parent_name].map(csvCell);
    cells.push(prettyPhone(r.phone));
    cells.push(...[ai.KINDS[r.kind] || '', r.channel === 'sms' ? 'SMS' : 'WhatsApp', r.status, r.error, r.body].map(csvCell));
    lines.push(cells.join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="parent-bot-messages-${todayStr()}.csv"`);
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
});

app.get('/api/messages/summary', requireAuth, (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date(Date.now() + 3600e3).toISOString().slice(0, 7);
  const lim = inClasses(myClasses(req.user), 'c.class_name');
  const found = db.prepare(`SELECT m.status AS status, m.channel AS channel, c.class_name AS class_name, ${KIND_SQL} AS kind, COUNT(*) AS n
    ${HISTORY_FROM} WHERE m.school_id=? AND strftime('%Y-%m', ${WHEN_SQL}) = ?${lim.sql} GROUP BY m.status, m.channel, c.class_name, kind`).all(req.user.school_id, month, ...lim.params);
  const totals = { sent: 0, delivered: 0, failed: 0, skipped: 0, draft: 0, scheduled: 0, whatsapp: 0, sms: 0 };
  const byKind = {}, byClass = {};
  const add = (map, key, label, bucket, n) => { const e = map[key] || (map[key] = { key, label, sent: 0, failed: 0, skipped: 0, draft: 0, scheduled: 0 }); e[bucket] += n; };
  for (const r of found) {
    const bucket = ['queued', 'sent', 'delivered', 'read'].includes(r.status) ? 'sent' : r.status;
    totals[bucket] += r.n;
    if (r.status === 'delivered' || r.status === 'read') totals.delivered += r.n;
    if (bucket === 'sent') totals[r.channel === 'sms' ? 'sms' : 'whatsapp'] += r.n;
    add(byKind, r.kind || '', ai.KINDS[r.kind] || 'Other', bucket, r.n);
    add(byClass, r.class_name == null ? '\u0000' : r.class_name, r.class_name == null ? '(parent removed)' : (r.class_name || 'No class'), bucket, r.n);
  }
  const order = (map) => Object.values(map).sort((a, b) => (b.sent + b.failed + b.skipped + b.draft + b.scheduled) - (a.sent + a.failed + a.skipped + a.draft + a.scheduled) || a.label.localeCompare(b.label));
  res.json({ month, totals, by_kind: order(byKind), by_class: order(byClass) });
});

// Delivery report: for each batch of messages, what happened to them.
app.get('/api/batches', requireAuth, (req, res) => {
  const mine = myClasses(req.user);
  const mlim = mine ? ` AND m.contact_id IN (SELECT id FROM contacts WHERE school_id=b.school_id AND class_name IN (${placeholders(mine.length)}))` : '';
  const rows = db.prepare(`SELECT b.id, b.kind, datetime(b.created_at, '+1 hour') AS at, u.name AS by_name,
      COUNT(m.id) AS total,
      SUM(m.status IN ('queued','sent','delivered','read')) AS sent,
      SUM(m.status IN ('delivered','read')) AS delivered,
      SUM(m.status='failed') AS failed, SUM(m.status='skipped') AS skipped,
      SUM(m.status IN ('draft','scheduled')) AS waiting
    FROM batches b LEFT JOIN users u ON u.id=b.created_by LEFT JOIN messages m ON m.batch_id=b.id AND m.school_id=b.school_id${mlim}
    WHERE b.school_id=? GROUP BY b.id HAVING COUNT(m.id) > 0 ORDER BY b.id DESC LIMIT 30`).all(...(mine || []), req.user.school_id);
  res.json(rows.map((r) => ({ ...r, kind_label: ai.KINDS[r.kind] || 'Other' })));
});

app.get('/api/batches/:id', requireAuth, (req, res) => {
  const sid = req.user.school_id;
  const b = db.prepare('SELECT id FROM batches WHERE id=? AND school_id=?').get(req.params.id, sid);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  const lim = inClasses(myClasses(req.user), 'c.class_name');
  const problems = db.prepare(`SELECT m.id, m.status, m.phone, m.channel, m.error, c.parent_name, c.student_name, c.class_name
    FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id WHERE m.school_id=? AND m.batch_id=? AND m.status IN ('failed','skipped')${lim.sql}
    ORDER BY m.id LIMIT 200`).all(sid, b.id, ...lim.params);
  res.json({ id: b.id, problems });
});

// Send again the messages of one batch that failed (held-back ones return to Drafts by themselves once consent is recorded).
app.post('/api/batches/:id/retry', requireAuth, (req, res) => {
  const sid = req.user.school_id;
  const b = db.prepare('SELECT id FROM batches WHERE id=? AND school_id=?').get(req.params.id, sid);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  const sch = schoolRow(sid);
  if (sch.require_approval && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Your school needs an administrator to approve messages before they are sent. Ask an administrator to retry these.' });
  if (quietNow(sch)) return res.status(409).json({ error: quietText(sch) });
  let ids = db.prepare("SELECT id FROM messages WHERE school_id=? AND batch_id=? AND status='failed'").all(sid, b.id).map((r) => r.id);
  ids = mineIds(req.user, ids);
  if (!ids.length) return res.status(400).json({ error: 'Nothing failed in this batch' });
  const out = queueAndSend(sid, ids);
  if (out.queued) logActivity(req.user, 'retried', `${plural(out.queued, 'failed message')} sent again`);
  res.json(out);
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
  res.json({ ok: true, messageIds: ids, status: school.auto_send_absence && !result?.quiet ? 'queued' : 'draft', ...(result || {}) });
}));

// ---------------------------------------------------------------- WhatsApp webhook (delivery receipts + STOP)
app.get('/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
// A parent's WhatsApp reply is kept for every school that has that number in its parent list (numbers nobody knows are dropped).
const REPLY_KEEP = 500;
function replyText(msg) {
  const t = msg.type === 'text' ? msg.text?.body
    : msg.type === 'button' ? msg.button?.text
    : msg.type === 'interactive' ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title) : '';
  const clean = String(t || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 1000);
  return clean || `[${String(msg.type || 'message').replace(/[^a-z_]/gi, '').slice(0, 20)} received - open WhatsApp to see it]`;
}
function saveReply(msg) {
  const phone = ch.normalizePhone(msg.from);
  if (!phone) return;
  const body = replyText(msg);
  const waId = msg.id ? String(msg.id).slice(0, 200) : null;
  for (const { school_id } of db.prepare('SELECT DISTINCT school_id FROM contacts WHERE phone=?').all(phone)) {
    const r = db.prepare('INSERT OR IGNORE INTO parent_replies(school_id, phone, wa_id, body) VALUES (?,?,?,?)').run(school_id, phone, waId, body);
    if (r.changes) db.prepare('DELETE FROM parent_replies WHERE school_id=? AND id NOT IN (SELECT id FROM parent_replies WHERE school_id=? ORDER BY id DESC LIMIT ?)').run(school_id, school_id, REPLY_KEEP);
  }
}
app.get('/api/replies/summary', requireAuth, (req, res) => {
  res.json({ unread: db.prepare('SELECT COUNT(*) n FROM parent_replies WHERE school_id=? AND read_at IS NULL').get(req.user.school_id).n });
});
app.get('/api/replies', requireAuth, (req, res) => {
  const sid = req.user.school_id;
  const rows = db.prepare(`SELECT r.id, r.phone, r.body, datetime(r.received_at, '+1 hour') AS at_wat, r.read_at, r.handled_at, hu.name AS handled_name, r.assigned_to, au.name AS assigned_name
    FROM parent_replies r LEFT JOIN users hu ON hu.id=r.handled_by LEFT JOIN users au ON au.id=r.assigned_to WHERE r.school_id=? ORDER BY r.id DESC LIMIT 200`).all(sid);
  const who = {};
  const find = db.prepare('SELECT parent_name, student_name, class_name FROM contacts WHERE school_id=? AND phone=? ORDER BY student_name');
  const replies = rows.map((r) => {
    const cs = who[r.phone] || (who[r.phone] = find.all(sid, r.phone));
    return { id: r.id, phone: r.phone, text: r.body, at: r.at_wat, read: !!r.read_at, handled: !!r.handled_at, handled_by: r.handled_name || '', assigned_to: r.assigned_to || null, assigned_name: r.assigned_name || '', parent: (cs.find((c) => c.parent_name) || {}).parent_name || '', students: cs.map((c) => c.student_name), classes: [...new Set(cs.map((c) => c.class_name).filter(Boolean))] };
  });
  res.json({ unread: db.prepare('SELECT COUNT(*) n FROM parent_replies WHERE school_id=? AND read_at IS NULL').get(sid).n, replies });
});
// Follow-up on a reply: mark it handled (or open it again), and give it to a colleague.
app.post('/api/replies/handle', requireAuth, (req, res) => {
  const sid = req.user.school_id, b = req.body || {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Choose a reply first' });
  const r = b.handled === false
    ? db.prepare(`UPDATE parent_replies SET handled_at=NULL, handled_by=NULL WHERE school_id=? AND handled_at IS NOT NULL AND id IN (${placeholders(ids.length)})`).run(sid, ...ids)
    : db.prepare(`UPDATE parent_replies SET handled_at=datetime('now'), handled_by=?, read_at=COALESCE(read_at, datetime('now')) WHERE school_id=? AND handled_at IS NULL AND id IN (${placeholders(ids.length)})`).run(req.user.id, sid, ...ids);
  if (r.changes) logActivity(req.user, 'reply', `${plural(r.changes, 'parent reply', 'parent replies')} ${b.handled === false ? 'opened again' : 'marked handled'}`);
  res.json({ ok: true, changed: r.changes, unread: db.prepare('SELECT COUNT(*) n FROM parent_replies WHERE school_id=? AND read_at IS NULL').get(sid).n });
});
app.post('/api/replies/assign', requireAuth, (req, res) => {
  const sid = req.user.school_id, b = req.body || {};
  const rep = db.prepare('SELECT id FROM parent_replies WHERE id=? AND school_id=?').get(Number(b.id) || 0, sid);
  if (!rep) return res.status(404).json({ error: 'Reply not found' });
  let who = null;
  if (b.userId) {
    who = db.prepare('SELECT id, name FROM users WHERE id=? AND school_id=?').get(Number(b.userId) || 0, sid);
    if (!who) return res.status(400).json({ error: 'Choose a person from your school' });
  }
  db.prepare('UPDATE parent_replies SET assigned_to=? WHERE id=?').run(who ? who.id : null, rep.id);
  logActivity(req.user, 'reply', who ? `A parent reply was given to ${who.name}` : 'A parent reply is no longer assigned');
  res.json({ ok: true, assigned: who ? who.name : null });
});
app.post('/api/replies/read', requireAuth, (req, res) => {
  const b = req.body || {}, sid = req.user.school_id;
  if (b.all) db.prepare("UPDATE parent_replies SET read_at=datetime('now') WHERE school_id=? AND read_at IS NULL").run(sid);
  else {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: 'Choose a reply first' });
    db.prepare(`UPDATE parent_replies SET read_at=datetime('now') WHERE school_id=? AND read_at IS NULL AND id IN (${placeholders(ids.length)})`).run(sid, ...ids);
  }
  res.json({ ok: true, unread: db.prepare('SELECT COUNT(*) n FROM parent_replies WHERE school_id=? AND read_at IS NULL').get(sid).n });
});

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
        try { saveReply(msg); } catch (e) { console.error('reply not saved', e); }
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

// ---------------------------------------------------------------- SMS delivery reports (Termii webhook)
// Termii posts a report for every SMS. The address contains a secret part made from JWT_SECRET (nothing new to set on the server).
const termiiToken = () => crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-only-secret').update('termii-delivery-reports-v1').digest('hex').slice(0, 32);
const isOwnerAccount = (user) => { const first = db.prepare("SELECT MIN(id) AS id FROM users WHERE role='admin'").get(); return !!first && first.id === user.id; };
const TERMII_FAILED = {
  'message failed': "The message failed (poor network on the parent's side).",
  'failed': "The message failed (poor network on the parent's side).",
  'rejected': "Rejected: Do-Not-Disturb is active on the parent's number.",
  'dnd active on phone number': "Do-Not-Disturb is active on the parent's number.",
  'expired': "Expired: the parent's phone was off or out of signal for too long.",
};

app.get('/api/sms-webhook', requireAuth, requireAdmin, (req, res) => {
  if (!isOwnerAccount(req.user)) return res.status(403).json({ error: 'Only the owner account can see this' });
  res.json({ url: `${req.protocol}://${req.get('host')}/webhooks/termii/${termiiToken()}`, sms: ch.status().sms });
});

app.post('/webhooks/termii/:token', (req, res) => {
  const given = Buffer.from(String(req.params.token || '')), want = Buffer.from(termiiToken());
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.sendStatus(403);
  try {
    // Information only (not enforced): does Termii's X-Termii-Signature match an HMAC SHA512 made with the API key?
    const sig = req.get('x-termii-signature');
    let signed = 'unsigned';
    if (sig) {
      const key = process.env.TERMII_API_KEY || '';
      const mine = key ? crypto.createHmac('sha512', key).update(req.rawBody || '').digest('hex') : '';
      signed = mine && mine.toLowerCase() === String(sig).toLowerCase() ? 'signature matches the API key' : 'signature present, does not match the API key';
    }
    const events = Array.isArray(req.body) ? req.body : [req.body || {}];
    for (const ev of events) {
      const id = String((ev && ev.message_id) || '').trim();
      const status = String((ev && ev.status) || '').trim().toLowerCase();
      if (!id || !status) continue;
      const m = db.prepare('SELECT id, status FROM messages WHERE provider_id=?').get(id);
      console.log(`[termii] message ${id}: ${status} (${m ? 'matched' : 'no matching message'}; ${signed})`);
      if (!m) continue;
      const rank = RANK[m.status] ?? 0;
      if (status === 'delivered') {
        if (rank < RANK.delivered) db.prepare("UPDATE messages SET status='delivered' WHERE id=?").run(m.id);
      } else if (TERMII_FAILED[status]) {
        if (rank < RANK.delivered && m.status !== 'failed') db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(TERMII_FAILED[status], m.id);
      }
    }
  } catch (e) { console.error('Termii webhook error', e); }
  res.sendStatus(200);
});

// ---------------------------------------------------------------- scheduled sending ("send later")
// Times typed by staff are Nigerian time (WAT, UTC+1); the database keeps UTC.
const SCHEDULE_GRACE_HOURS = 6;   // if the server was off and a time is this overdue, a stale message is NOT sent

app.post('/api/messages/schedule', requireAuth, (req, res) => {
  let ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one message' });
  ids = mineIds(req.user, ids);
  if (!ids.length) return res.status(403).json({ error: 'Those messages are not in your classes.' });
  const sch = schoolRow(req.user.school_id);
  if (sch.require_approval && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Your school needs an administrator to approve messages before they are sent. Use "Ask for approval".' });
  const typed = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(String(req.body?.at || '').trim());
  const when = typed ? new Date(`${typed[1]}T${typed[2]}:00+01:00`) : null;
  if (!when || Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Choose a date and time' });
  const ahead = when.getTime() - Date.now();
  if (ahead < 2 * 60 * 1000) return res.status(400).json({ error: 'Choose a time at least 2 minutes from now (Nigerian time)' });
  if (ahead > 90 * 24 * 3600 * 1000) return res.status(400).json({ error: 'Choose a date within the next 90 days' });
  if (inQuiet(sch, toMin(typed[2]))) return res.status(409).json({ error: `That time is inside quiet hours (${sch.quiet_start} to ${sch.quiet_end}, Nigerian time). Choose a time outside them.` });
  const utc = when.toISOString().slice(0, 19).replace('T', ' ');
  const targets = req.body?.remind ? db.prepare(`SELECT * FROM messages WHERE school_id=? AND status='draft' AND id IN (${placeholders(ids.length)})`).all(req.user.school_id, ...ids) : [];
  const r = db.prepare(`UPDATE messages SET status='scheduled', scheduled_at=?, error=NULL WHERE school_id=? AND status='draft' AND id IN (${placeholders(ids.length)})`)
    .run(utc, req.user.school_id, ...ids);
  // optional reminder: the same message again, one day earlier at the same time, labelled "Reminder:"
  let reminders = 0, reminderNote = '';
  if (req.body?.remind && r.changes) {
    const remindAt = when.getTime() - 24 * 3600 * 1000;
    if (remindAt - Date.now() < 2 * 60 * 1000) reminderNote = 'No reminder was added, because the day before has already passed.';
    else {
      const rutc = new Date(remindAt).toISOString().slice(0, 19).replace('T', ' ');
      const ins = db.prepare("INSERT INTO messages(school_id, batch_id, contact_id, phone, channel, body, ai, status, scheduled_at, reminder_of) VALUES (?,?,?,?,?,?,0,'scheduled',?,?)");
      let tooLong = 0;
      db.transaction(() => {
        for (const m of targets) {
          const body = `Reminder: ${m.body}`;
          if (body.length > 1000) { tooLong++; continue; }
          ins.run(m.school_id, m.batch_id, m.contact_id, m.phone, m.channel, body, rutc, m.id); reminders++;
        }
      })();
      if (tooLong) reminderNote = `${plural(tooLong, 'message')} too long for a reminder, so no reminder was added for ${tooLong === 1 ? 'it' : 'them'}.`;
    }
  }
  if (r.changes) logActivity(req.user, 'scheduled', `${plural(r.changes, 'message')} for ${typed[1]} ${typed[2]}${reminders ? `, with ${plural(reminders, 'reminder')} the day before` : ''}`);
  res.json({ scheduled: r.changes, at_wat: `${typed[1]} ${typed[2]}`, reminders, reminderNote });
});

app.post('/api/messages/unschedule', requireAuth, (req, res) => {
  let ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one message' });
  ids = mineIds(req.user, ids);
  if (!ids.length) return res.status(403).json({ error: 'Those messages are not in your classes.' });
  // a reminder is simply removed (it is not a draft anyone wrote), and cancelling a message removes its reminder with it
  const gone = db.prepare(`DELETE FROM messages WHERE school_id=? AND status='scheduled' AND reminder_of IS NOT NULL AND (id IN (${placeholders(ids.length)}) OR reminder_of IN (${placeholders(ids.length)}))`)
    .run(req.user.school_id, ...ids, ...ids);
  const r = db.prepare(`UPDATE messages SET status='draft', scheduled_at=NULL WHERE school_id=? AND status='scheduled' AND id IN (${placeholders(ids.length)})`)
    .run(req.user.school_id, ...ids);
  if (r.changes || gone.changes) logActivity(req.user, 'unscheduled', `${plural(r.changes, 'message')} back in Drafts${gone.changes ? `, ${plural(gone.changes, 'reminder')} removed` : ''}`);
  res.json({ cancelled: r.changes, removedReminders: gone.changes });
});

// Every 30 seconds: messages whose time has come go through the normal sending path (opt-out, consent and the daily limit are checked there).
function runScheduled() {
  try {
    const due = db.prepare(`SELECT id, school_id, reminder_of, datetime(scheduled_at, '+1 hour') AS wat, scheduled_at < datetime('now', ?) AS stale
      FROM messages WHERE status='scheduled' AND scheduled_at <= datetime('now') ORDER BY scheduled_at, id`).all(`-${SCHEDULE_GRACE_HOURS} hours`);
    const bySchool = {};
    for (const d of due) {
      if (d.stale && d.reminder_of) db.prepare("DELETE FROM messages WHERE id=? AND status='scheduled'").run(d.id);   // a missed reminder is no use any more
      else if (d.stale) {
        db.prepare("UPDATE messages SET status='draft', scheduled_at=NULL, error=? WHERE id=? AND status='scheduled'")
          .run(`The scheduled time (${String(d.wat).slice(0, 16)}, Nigerian time) passed while the system was offline, so it was not sent. Review it and send it again.`, d.id);
      } else (bySchool[d.school_id] = bySchool[d.school_id] || []).push(d.id);
    }
    for (const [sid, ids] of Object.entries(bySchool)) {
      if (quietNow(schoolRow(Number(sid)))) continue;   // still scheduled; they go as soon as quiet hours end (unless that is later than the grace period)
      db.prepare(`UPDATE messages SET status='draft', scheduled_at=NULL WHERE status='scheduled' AND id IN (${placeholders(ids.length)})`).run(...ids);
      queueAndSend(Number(sid), ids);
      db.prepare(`UPDATE messages SET error='The daily sending limit was reached at the scheduled time. Send it again from Drafts.' WHERE status='draft' AND id IN (${placeholders(ids.length)})`).run(...ids);
    }
  } catch (e) { console.error('Scheduled sending error', e); }
}
const scheduleTimer = setInterval(runScheduled, Number(process.env.SCHEDULE_CHECK_SECONDS || 30) * 1000);
if (scheduleTimer.unref) scheduleTimer.unref();
const firstScheduleCheck = setTimeout(runScheduled, 5000);
if (firstScheduleCheck.unref) firstScheduleCheck.unref();

// ---------------------------------------------------------------- quick replies (saved answers to what parents write back)
// Words in {curly brackets} are filled in on the screen: {parent}, {child}, {school}, {me}. Nothing is sent from here; WhatsApp opens with the text ready.
const MAX_REPLY_TEMPLATES = 30;
const rtRow = (t) => ({ id: t.id, title: t.title, body: t.body });
const rtClean = (b) => {
  const title = String(b?.title || '').replace(/\s+/g, ' ').trim(), body = String(b?.body || '').trim();
  if (!title) return { error: 'Give the quick reply a short name' };
  if (title.length > 40) return { error: 'The name is too long (max 40 characters)' };
  if (body.length < 3) return { error: 'Write the reply text' };
  if (body.length > 1000) return { error: 'The reply is too long (max 1,000 characters)' };
  return { title, body };
};
const RT_STARTERS = [
  ['Received, thank you', 'Dear {parent}, thank you for your message about {child}. We have received it and will get back to you shortly. - {school}'],
  ['Please call the office', 'Dear {parent}, thank you for writing to us about {child}. Please call the school office so that we can talk it through properly. - {school}'],
  ['Absence noted', 'Dear {parent}, thank you for letting us know. We have noted the reason for {child}\'s absence. - {school}'],
  ['Fees: see the bursar', 'Dear {parent}, thank you for your message. Please see the school bursar about the fees for {child}, and we will gladly help. - {school}'],
];
app.get('/api/reply-templates', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, title, body FROM reply_templates WHERE school_id=? ORDER BY lower(title), id').all(req.user.school_id));
});
app.post('/api/reply-templates', requireAuth, requireAdmin, (req, res) => {
  const c = rtClean(req.body); if (c.error) return res.status(400).json({ error: c.error });
  if (db.prepare('SELECT COUNT(*) n FROM reply_templates WHERE school_id=?').get(req.user.school_id).n >= MAX_REPLY_TEMPLATES)
    return res.status(400).json({ error: `You can keep up to ${MAX_REPLY_TEMPLATES} quick replies. Delete one you no longer use.` });
  const id = Number(db.prepare('INSERT INTO reply_templates(school_id, title, body) VALUES (?,?,?)').run(req.user.school_id, c.title, c.body).lastInsertRowid);
  logActivity(req.user, 'settings', `Quick reply added: ${c.title}`);
  res.json({ id });
});
app.post('/api/reply-templates/starters', requireAuth, requireAdmin, (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM reply_templates WHERE school_id=?').get(req.user.school_id).n) return res.status(400).json({ error: 'You already have quick replies' });
  const ins = db.prepare('INSERT INTO reply_templates(school_id, title, body) VALUES (?,?,?)');
  db.transaction(() => RT_STARTERS.forEach(([t, b]) => ins.run(req.user.school_id, t, b)))();
  logActivity(req.user, 'settings', 'Quick replies: example replies added');
  res.json({ added: RT_STARTERS.length });
});
app.put('/api/reply-templates/:id', requireAuth, requireAdmin, (req, res) => {
  const c = rtClean(req.body); if (c.error) return res.status(400).json({ error: c.error });
  const r = db.prepare('UPDATE reply_templates SET title=?, body=? WHERE id=? AND school_id=?').run(c.title, c.body, Number(req.params.id) || 0, req.user.school_id);
  if (!r.changes) return res.status(404).json({ error: 'That quick reply was not found' });
  res.json({ ok: true });
});
app.delete('/api/reply-templates/:id', requireAuth, requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM reply_templates WHERE id=? AND school_id=?').run(Number(req.params.id) || 0, req.user.school_id);
  if (r.changes) logActivity(req.user, 'settings', 'Quick reply deleted');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- special days: birthdays and holidays
// The bot only PREPARES drafts a few days ahead (they wait in Messages > Drafts). It never sends anything by itself.
const watDate = (offsetDays = 0) => new Date(Date.now() + 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const dayNum = (ymd) => Math.round(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400e3);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// the next date on or after `today` that falls on month-day `md` ('MM-DD'); 29 February is kept on 28 February in other years
function nextOn(md, today) {
  const at = (y) => (md === '02-29' && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`);
  const y = +today.slice(0, 4), a = at(y);
  return a >= today ? a : at(y + 1);
}
const niceDate = (ymd) => `${+ymd.slice(8, 10)} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+ymd.slice(5, 7) - 1]}`;
const validYmd = (s) => { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return !!x && +x[2] >= 1 && +x[2] <= 12 && +x[3] >= 1 && +x[3] <= DAYS_IN[+x[2] - 1] && (+x[2] !== 2 || +x[3] <= 28 || isLeap(+x[1])); };
// the date this special day next falls on, or null if it was a one-off that has passed
const holidayNext = (h, today) => (h.yearly ? nextOn(h.day.slice(5), today) : (h.day >= today ? h.day : null));
const AUTO = (sid) => ({ school_id: sid, id: -1, name: 'Automatic' });
const MAX_SPECIAL_DAYS = 200, MAX_AUTO_AUDIENCE = 1000;

const dayRow = (h, today) => { const nx = holidayNext(h, today); return { id: h.id, title: h.title, day: h.day, yearly: !!h.yearly, message: h.message, next: nx, in_days: nx ? dayNum(nx) - dayNum(today) : null }; };
app.get('/api/special-days', requireAuth, requireAdmin, (req, res) => {
  const sid = req.user.school_id, today = watDate(), sc = schoolRow(sid);
  const days = db.prepare('SELECT * FROM special_days WHERE school_id=?').all(sid).map((h) => dayRow(h, today))
    .sort((a, b) => (a.next === null) - (b.next === null) || String(a.next).localeCompare(String(b.next)) || a.title.localeCompare(b.title));
  const withB = db.prepare("SELECT id, student_name, class_name, birthday FROM contacts WHERE school_id=? AND birthday IS NOT NULL AND birthday<>''").all(sid);
  const upcoming = withB.map((c) => { const nx = nextOn(c.birthday, today); return { student_name: c.student_name, class_name: c.class_name, birthday: bdayShow(c.birthday), next: nx, in_days: dayNum(nx) - dayNum(today) }; })
    .filter((c) => c.in_days <= 30).sort((a, b) => a.in_days - b.in_days || a.student_name.localeCompare(b.student_name));
  res.json({ settings: { birthday_msgs: !!sc.birthday_msgs, ahead: sc.special_ahead }, days, today,
    birthdays: { recorded: withB.length, total: db.prepare('SELECT COUNT(*) n FROM contacts WHERE school_id=?').get(sid).n, upcoming: upcoming.slice(0, 30), upcoming_total: upcoming.length } });
});
function dayClean(b) {
  const title = String(b?.title || '').replace(/\s+/g, ' ').trim(), message = String(b?.message || '').trim();
  if (!title) return { error: 'Give the special day a name, like Christmas break' };
  if (title.length > 60) return { error: 'The name is too long (max 60 characters)' };
  if (!validYmd(b?.day)) return { error: 'Choose a valid date' };
  if (message.length < 3) return { error: 'Write what the message should say, like "Merry Christmas! School closes on 18 December and resumes on 6 January."' };
  if (message.length > 500) return { error: 'That is too long (max 500 characters)' };
  return { title, day: String(b.day), yearly: b?.yearly ? 1 : 0, message };
}
app.post('/api/special-days', requireAuth, requireAdmin, (req, res) => {
  const c = dayClean(req.body); if (c.error) return res.status(400).json({ error: c.error });
  if (db.prepare('SELECT COUNT(*) n FROM special_days WHERE school_id=?').get(req.user.school_id).n >= MAX_SPECIAL_DAYS) return res.status(400).json({ error: `You can keep up to ${MAX_SPECIAL_DAYS} special days. Delete old ones.` });
  const id = Number(db.prepare('INSERT INTO special_days(school_id, title, day, yearly, message) VALUES (?,?,?,?,?)').run(req.user.school_id, c.title, c.day, c.yearly, c.message).lastInsertRowid);
  logActivity(req.user, 'settings', `Special day added: ${c.title}, ${niceDate(c.day)}${c.yearly ? ' (every year)' : ''}`);
  res.json({ id });
});
app.put('/api/special-days/:id', requireAuth, requireAdmin, (req, res) => {
  const c = dayClean(req.body); if (c.error) return res.status(400).json({ error: c.error });
  const r = db.prepare('UPDATE special_days SET title=?, day=?, yearly=?, message=? WHERE id=? AND school_id=?').run(c.title, c.day, c.yearly, c.message, Number(req.params.id) || 0, req.user.school_id);
  if (!r.changes) return res.status(404).json({ error: 'That special day was not found' });
  db.prepare("DELETE FROM special_log WHERE school_id=? AND key LIKE ?").run(req.user.school_id, `hol:${Number(req.params.id)}:%`);   // changed: it may be prepared again
  res.json({ ok: true });
});
app.delete('/api/special-days/:id', requireAuth, requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM special_days WHERE id=? AND school_id=?').run(Number(req.params.id) || 0, req.user.school_id);
  if (r.changes) logActivity(req.user, 'settings', 'Special day deleted');
  res.json({ ok: true });
});
app.put('/api/special-settings', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {}, cur = schoolRow(req.user.school_id);
  const ahead = b.ahead == null ? cur.special_ahead : Math.min(14, Math.max(1, Math.round(Number(b.ahead)) || cur.special_ahead));
  const bm = b.birthday_msgs == null ? cur.birthday_msgs : (b.birthday_msgs ? 1 : 0);
  db.prepare('UPDATE schools SET birthday_msgs=?, special_ahead=? WHERE id=?').run(bm, ahead, req.user.school_id);
  if (bm !== cur.birthday_msgs || ahead !== cur.special_ahead) logActivity(req.user, 'settings', `Birthday messages ${bm ? 'on' : 'off'}; drafts prepared ${ahead} day${ahead === 1 ? '' : 's'} ahead`);
  res.json({ ok: true, birthday_msgs: !!bm, ahead });
});

// Prepare drafts for one school: the same rules as the Compose page (opted-out parents and, if required, parents without consent are left out).
async function prepareSpecial(school, today) {
  const sid = school.id, ahead = Math.min(14, Math.max(1, school.special_ahead || 2));
  const logged = (k) => !!db.prepare('SELECT 1 FROM special_log WHERE school_id=? AND key=?').get(sid, k);
  const eligible = (list) => list.filter((c) => !c.opted_out && (!school.require_consent || c.consent_at));
  const out = { batches: 0, messages: 0 };
  async function make(kind, facts, contacts, keys, label) {
    if (!contacts.length) return;   // nobody to write to right now (opted out, or no consent yet): try again at the next check
    const drafts = {};
    for (let i = 0; i < contacts.length; i += 100)
      Object.assign(drafts, await ai.draftMessages({ school, kind, tone: school.default_tone, language: school.default_language, facts, contacts: contacts.slice(i, i + 100), notes: {} }));
    db.transaction(() => {
      const b = db.prepare('INSERT INTO batches(school_id, kind, tone, language, facts, created_by) VALUES (?,?,?,?,?,NULL)').run(sid, kind, school.default_tone, school.default_language, facts).lastInsertRowid;
      const ins = db.prepare('INSERT INTO messages(school_id, batch_id, contact_id, phone, channel, body, ai) VALUES (?,?,?,?,?,?,?)');
      for (const c of contacts) ins.run(sid, b, c.id, c.phone, c.channel, drafts[c.id].body, drafts[c.id].ai);
      keys.forEach((k) => db.prepare('INSERT OR IGNORE INTO special_log(school_id, key) VALUES (?,?)').run(sid, k));
    })();
    out.batches++; out.messages += contacts.length;
    logActivity(AUTO(sid), 'drafted', `${plural(contacts.length, 'message')} prepared ahead: ${label}. Check them in Messages before sending.`);
  }
  for (const h of db.prepare('SELECT * FROM special_days WHERE school_id=?').all(sid)) {
    const nx = holidayNext(h, today); if (!nx) continue;
    const gap = dayNum(nx) - dayNum(today), key = `hol:${h.id}:${nx}`;
    if (gap > ahead || logged(key)) continue;
    const people = eligible(db.prepare('SELECT * FROM contacts WHERE school_id=?').all(sid)).slice(0, MAX_AUTO_AUDIENCE);
    await make('holiday', h.message, people, [key], `${h.title} (${niceDate(nx)})`);
  }
  if (school.birthday_msgs) {
    const byDate = {};
    for (const c of db.prepare("SELECT * FROM contacts WHERE school_id=? AND birthday IS NOT NULL AND birthday<>''").all(sid)) {
      const nx = nextOn(c.birthday, today);
      if (dayNum(nx) - dayNum(today) > ahead || logged(`bday:${c.id}:${nx}`)) continue;
      (byDate[nx] = byDate[nx] || []).push(c);
    }
    for (const [nx, list] of Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]))) {
      const who = eligible(list).slice(0, MAX_AUTO_AUDIENCE);
      await make('birthday', `Birthday on ${niceDate(nx)}`, who, who.map((c) => `bday:${c.id}:${nx}`), `${plural(who.length, 'birthday')} on ${niceDate(nx)}`);
    }
  }
  return out;
}
let specialRunning = false;
async function runSpecialDays(onlySchool) {
  if (specialRunning) return null;
  specialRunning = true;
  const total = { batches: 0, messages: 0 };
  try {
    const today = watDate();
    const schools = onlySchool ? [schoolRow(onlySchool)] : db.prepare('SELECT * FROM schools').all();
    for (const s of schools) {
      if (!s) continue;
      try { const r = await prepareSpecial(s, today); total.batches += r.batches; total.messages += r.messages; }
      catch (e) { console.error('Special days error (school ' + s.id + ')', e); }
    }
    if (Math.random() < 0.05) db.prepare("DELETE FROM special_log WHERE created_at < datetime('now', '-400 days')").run();
  } finally { specialRunning = false; }
  return total;
}
app.post('/api/special-days/run', requireAuth, requireAdmin, wrap(async (req, res) => {
  const r = await runSpecialDays(req.user.school_id);
  res.json(r || { batches: 0, messages: 0, busy: true });
}));
const specialTimer = setInterval(() => runSpecialDays(), Number(process.env.SPECIAL_CHECK_SECONDS || 1800) * 1000);
if (specialTimer.unref) specialTimer.unref();
const firstSpecialCheck = setTimeout(() => runSpecialDays(), 20000);
if (firstSpecialCheck.unref) firstSpecialCheck.unref();

// ---------------------------------------------------------------- platform console (owner account only): counts, never content
// Shows how every school is using the bot. It returns NUMBERS ONLY: no parent names, phone numbers or message text.
app.get('/api/platform/overview', requireAuth, requireAdmin, (req, res) => {
  if (!isOwnerAccount(req.user)) return res.status(403).json({ error: 'Only the owner account can see this' });
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date(Date.now() + 3600e3).toISOString().slice(0, 7);
  const hasSm = db.prepare('PRAGMA table_info(schools)').all().some((c) => c.name === 'sm_school_id');
  const schools = db.prepare(`SELECT id, name, created_at, sender_id, require_consent, auto_send_absence,
    ${hasSm ? '(sm_school_id IS NOT NULL AND sm_key IS NOT NULL)' : '0'} AS sm_connected FROM schools ORDER BY id`).all();
  const users = db.prepare('SELECT school_id, role, name, email FROM users ORDER BY id').all();
  const contacts = db.prepare('SELECT school_id, COUNT(*) AS n, SUM(consent_at IS NOT NULL) AS consented, SUM(opted_out) AS opted_out FROM contacts GROUP BY school_id').all();
  const inMonth = db.prepare(`SELECT m.school_id AS school_id, m.status AS status, m.channel AS channel, COUNT(*) AS n FROM messages m
    WHERE strftime('%Y-%m', ${WHEN_SQL}) = ? GROUP BY m.school_id, m.status, m.channel`).all(month);
  const last = db.prepare(`SELECT m.school_id AS school_id, datetime(MAX(COALESCE(m.sent_at, m.created_at)), '+1 hour') AS last FROM messages m GROUP BY m.school_id`).all();
  const waiting = db.prepare("SELECT school_id, status, COUNT(*) AS n FROM messages WHERE status IN ('draft','scheduled') GROUP BY school_id, status").all();

  const rows = schools.map((s) => ({
    id: s.id, name: s.name, created_at: s.created_at, is_yours: s.id === req.user.school_id,
    admins: users.filter((u) => u.school_id === s.id && u.role === 'admin').map((u) => ({ name: u.name, email: u.email })),
    teachers: users.filter((u) => u.school_id === s.id && u.role !== 'admin').length,
    parents: 0, consented: 0, opted_out: 0, sent: 0, delivered: 0, failed: 0, skipped: 0, whatsapp: 0, sms: 0, drafts: 0, scheduled: 0,
    last_message: null, sender_id: s.sender_id, sm_connected: !!s.sm_connected, require_consent: !!s.require_consent, auto_send_absence: !!s.auto_send_absence,
  }));
  const idx = new Map(rows.map((r) => [r.id, r]));
  for (const c of contacts) { const r = idx.get(c.school_id); if (r) { r.parents = c.n; r.consented = c.consented || 0; r.opted_out = c.opted_out || 0; } }
  for (const m of inMonth) {
    const r = idx.get(m.school_id); if (!r) continue;
    if (['queued', 'sent', 'delivered', 'read'].includes(m.status)) { r.sent += m.n; r[m.channel === 'sms' ? 'sms' : 'whatsapp'] += m.n; }
    if (m.status === 'delivered' || m.status === 'read') r.delivered += m.n;
    if (m.status === 'failed') r.failed += m.n;
    if (m.status === 'skipped') r.skipped += m.n;
  }
  for (const l of last) { const r = idx.get(l.school_id); if (r) r.last_message = l.last; }
  for (const w of waiting) { const r = idx.get(w.school_id); if (r) r[w.status === 'draft' ? 'drafts' : 'scheduled'] += w.n; }
  rows.sort((a, b) => (a.is_yours ? 1 : 0) - (b.is_yours ? 1 : 0) || b.sent - a.sent || b.parents - a.parents || a.name.localeCompare(b.name));
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const actions = db.prepare(`SELECT a.id, datetime(a.created_at, '+1 hour') AS at, a.action, a.actor_name, a.target_name, a.target_email, a.detail, s.name AS school_name
    FROM staff_actions a LEFT JOIN schools s ON s.id = a.school_id ORDER BY a.id DESC LIMIT 10`).all();
  res.json({
    month,
    totals: { schools: rows.filter((r) => !r.is_yours).length, parents: sum('parents'), teachers: sum('teachers'), admins: rows.reduce((n, r) => n + r.admins.length, 0),
      sent: sum('sent'), delivered: sum('delivered'), failed: sum('failed'), skipped: sum('skipped'), whatsapp: sum('whatsapp'), sms: sum('sms'), drafts: sum('drafts'), scheduled: sum('scheduled') },
    schools: rows,
    actions,
  });
});

// ---------------------------------------------------------------- removing or moving TEACHER accounts
// Only teacher accounts. Administrators and the owner can never be removed or moved here. Every change is recorded.
function recordStaffAction(actor, action, target, detail) {
  db.prepare('INSERT INTO staff_actions(school_id, actor_name, actor_email, action, target_name, target_email, detail) VALUES (?,?,?,?,?,?,?)')
    .run(target.school_id, actor.name, actor.email, action, target.name, target.email, detail || null);
}
const ownerOnly = (req, res, next) => (isOwnerAccount(req.user) ? next() : res.status(403).json({ error: 'Only the owner account can do this' }));

// Saves a change in one step; if anything fails, nothing is changed and the person sees a clear message
// (instead of the misleading "Please sign in" that an error inside a route would otherwise cause).
function saveStaffChange(res, fn) {
  try { db.transaction(fn)(); return true; }
  catch (e) { console.error('Staff change failed:', e.message); res.status(500).json({ error: 'The change could not be saved, so nothing was changed.' }); return false; }
}

// A school administrator removes a teacher of THEIR OWN school.
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND school_id = ?').get(Number(req.params.id) || 0, req.user.school_id);
  if (!target) return res.status(404).json({ error: 'That account was not found in your school' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
  if (target.role !== 'staff') return res.status(400).json({ error: 'Administrator accounts cannot be removed here' });
  if (!saveStaffChange(res, () => {
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'staff'").run(target.id);
    recordStaffAction(req.user, 'removed', target, null);
  })) return;
  res.json({ ok: true });
});

// The owner looks up an account by its exact email.
app.get('/api/platform/teacher', requireAuth, requireAdmin, ownerOnly, (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Type the email address of the account' });
  const u = db.prepare('SELECT u.id, u.name, u.email, u.role, u.school_id, s.name AS school_name FROM users u JOIN schools s ON s.id = u.school_id WHERE lower(u.email) = ?').get(email);
  const schools = db.prepare('SELECT id, name FROM schools ORDER BY name').all();
  if (!u) return res.json({ found: false, schools });
  res.json({ found: true, user: u, can_change: u.role === 'staff', is_you: u.id === req.user.id, schools });
});

app.post('/api/platform/teacher/move', requireAuth, requireAdmin, ownerOnly, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number((req.body || {}).id) || 0);
  if (!target) return res.status(404).json({ error: 'That account was not found' });
  if (target.role !== 'staff') return res.status(400).json({ error: 'Only teacher accounts can be moved' });
  const to = db.prepare('SELECT * FROM schools WHERE id = ?').get(Number((req.body || {}).school_id) || 0);
  if (!to) return res.status(400).json({ error: 'Choose the school to move the teacher to' });
  if (to.id === target.school_id) return res.status(400).json({ error: 'The teacher is already in that school' });
  const from = db.prepare('SELECT name FROM schools WHERE id = ?').get(target.school_id);
  if (!saveStaffChange(res, () => {
    db.prepare("UPDATE users SET school_id = ? WHERE id = ? AND role = 'staff'").run(to.id, target.id);
    db.prepare('DELETE FROM staff_classes WHERE user_id = ?').run(target.id);   // classes belong to the old school
    recordStaffAction(req.user, 'moved', target, `from ${from.name} to ${to.name}`);
  })) return;
  res.json({ ok: true, to: to.name });
});

app.post('/api/platform/teacher/remove', requireAuth, requireAdmin, ownerOnly, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number((req.body || {}).id) || 0);
  if (!target) return res.status(404).json({ error: 'That account was not found' });
  if (target.role !== 'staff') return res.status(400).json({ error: 'Only teacher accounts can be deleted here' });
  if (!saveStaffChange(res, () => {
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'staff'").run(target.id);
    recordStaffAction(req.user, 'removed', target, null);
  })) return;
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the owner adds a school (account + administrator) from the Platform page
const TEMP_PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no look-alikes (0 O 1 l I)
function makeTempPassword() {
  for (;;) {
    let p = '';
    for (let i = 0; i < 10; i++) p += TEMP_PW_CHARS[crypto.randomInt(TEMP_PW_CHARS.length)];
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p;
  }
}

app.post('/api/platform/schools', requireAuth, requireAdmin, ownerOnly, (req, res) => {
  const b = req.body || {};
  const schoolName = String(b.schoolName || '').trim().replace(/\s+/g, ' ');
  const adminName = String(b.adminName || '').trim().replace(/\s+/g, ' ');
  const email = String(b.email || '').trim().toLowerCase();
  if (!schoolName || schoolName.length > 120) return res.status(400).json({ error: 'Type the school name (up to 120 characters)' });
  if (!adminName || adminName.length > 120) return res.status(400).json({ error: 'Type the administrator’s name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Type a valid email address for the administrator' });
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email))
    return res.status(409).json({ error: 'That email already has an account. Use another email, or move or delete the existing account first.' });
  if (db.prepare('SELECT 1 FROM schools WHERE lower(name) = lower(?)').get(schoolName))
    return res.status(409).json({ error: 'A school with this name already exists' });
  let password = String(b.password || '');
  const generated = !password;
  if (generated) password = makeTempPassword();
  else if (password.length < 8) return res.status(400).json({ error: 'The temporary password must have at least 8 characters' });
  let created;
  if (!saveStaffChange(res, () => {
    const sid = Number(db.prepare('INSERT INTO schools(name, api_key, signature) VALUES (?,?,?)').run(schoolName, newKey(), schoolName).lastInsertRowid);
    db.prepare('INSERT INTO users(school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)').run(sid, adminName, email, hash(password), 'admin');
    recordStaffAction(req.user, 'school_added', { school_id: sid, name: adminName, email }, schoolName);
    created = sid;
  })) return;
  const address = `${req.protocol}://${req.get('host')}`;
  const welcome = [
    `Welcome to the Parent Communication Bot, ${schoolName}!`,
    '',
    'Your school’s account is ready.',
    '',
    `Open: ${address}`,
    `Email: ${email}`,
    `Temporary password: ${password}`,
    '',
    'Your first steps:',
    '1. Sign in. To choose your own password, click “Get a code by email” on the sign-in page.',
    '2. Click Settings and check your School name, SMS sender ID and Sign-off on messages.',
    '3. Add your teachers (Settings, Staff accounts), then add your parents (Parents).',
    '4. Ask us for the user manual if you do not have it yet. Start with the practice day in Chapter 13.',
    '',
    'Need help? WhatsApp 0805 480 1320.',
    'SmartClass AI Academy',
  ].join('\n');
  res.json({ ok: true, school: { id: created, name: schoolName }, admin: { name: adminName, email }, password, generated, welcome });
});

// ---------------------------------------------------------------- change an email / give a new temporary password
// Used by two doors: the owner's Account tools (any administrator or teacher, never your own account) and a school
// administrator's Staff accounts buttons (teachers of their own school only). Every change is recorded, without passwords.
const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const accountWithSchool = (id, schoolId) => db.prepare(`SELECT u.*, s.name AS school_name FROM users u JOIN schools s ON s.id = u.school_id WHERE u.id = ?${schoolId ? ' AND u.school_id = ?' : ''}`)
  .get(...(schoolId ? [id, schoolId] : [id]));
const messageEnd = (who, t) => (who === 'owner' ? ['Need help? WhatsApp 0805 480 1320.', 'SmartClass AI Academy'] : [t.school_name]);

// The owner: any administrator or teacher except his own account.
function ownerTarget(req, res) {
  const t = accountWithSchool(Number((req.body || {}).id) || 0);
  if (!t) { res.status(404).json({ error: 'That account was not found' }); return null; }
  if (t.id === req.user.id) { res.status(400).json({ error: 'This is your own account. It cannot be changed here' }); return null; }
  return t;
}
// A school administrator: a teacher of their own school, never themselves or another administrator.
function schoolTarget(req, res) {
  const t = accountWithSchool(Number(req.params.id) || 0, req.user.school_id);
  if (!t) { res.status(404).json({ error: 'That account was not found in your school' }); return null; }
  if (t.id === req.user.id) { res.status(400).json({ error: 'This is your own account. It cannot be changed here' }); return null; }
  if (t.role !== 'staff') { res.status(400).json({ error: 'Administrator accounts cannot be changed here. Ask SmartClass AI Academy' }); return null; }
  return t;
}

function applyEmailChange(req, res, t, who) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) return res.status(400).json({ error: 'Type a valid email address' });
  if (email === String(t.email).toLowerCase()) return res.status(400).json({ error: 'That is already their email address' });
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id != ?').get(email, t.id))
    return res.status(409).json({ error: who === 'owner' ? 'That email already has an account' : 'That email already has an account, possibly at another school. Use a different email, or ask SmartClass AI Academy' });
  if (!saveStaffChange(res, () => {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, t.id);
    recordStaffAction(req.user, 'email_changed', { school_id: t.school_id, name: t.name, email }, `from ${t.email} to ${email}`);
  })) return;
  const message = [`Hello ${t.name},`, '', `The email address of your Parent Communication Bot account is now: ${email}`, 'Use it to sign in. Your password has not changed.', '',
    `Open: ${req.protocol}://${req.get('host')}`, '', ...messageEnd(who, t)].join('\n');
  res.json({ ok: true, name: t.name, email, message });
}

function applyPasswordReset(req, res, t, who) {
  const password = makeTempPassword();
  const hasSecurity = tableExists('user_security'), hasResets = tableExists('password_resets');
  if (!saveStaffChange(res, () => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(password), t.id);
    if (hasResets) db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(t.id);   // old reset codes stop working
    if (hasSecurity) db.prepare('INSERT INTO user_security (user_id, pw_changed_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET pw_changed_at = excluded.pw_changed_at').run(t.id, Date.now());   // open sessions are signed out
    recordStaffAction(req.user, 'password_reset', t, 'new temporary password');
  })) return;
  const message = [`Hello ${t.name},`, '', 'Your Parent Communication Bot password has been reset.', '',
    `Open: ${req.protocol}://${req.get('host')}`, `Email: ${t.email}`, `Temporary password: ${password}`, '',
    'Sign in with it. To choose your own password, click “Get a code by email” on the sign-in page. The code is sent to the email above.', '',
    ...messageEnd(who, t)].join('\n');
  res.json({ ok: true, name: t.name, email: t.email, password, message });
}

app.post('/api/platform/admin/email', requireAuth, requireAdmin, ownerOnly, (req, res) => { const t = ownerTarget(req, res); if (t) applyEmailChange(req, res, t, 'owner'); });
app.post('/api/platform/admin/password', requireAuth, requireAdmin, ownerOnly, (req, res) => { const t = ownerTarget(req, res); if (t) applyPasswordReset(req, res, t, 'owner'); });
app.post('/api/users/:id/email', requireAuth, requireAdmin, (req, res) => { const t = schoolTarget(req, res); if (t) applyEmailChange(req, res, t, 'school'); });
app.post('/api/users/:id/password', requireAuth, requireAdmin, (req, res) => { const t = schoolTarget(req, res); if (t) applyPasswordReset(req, res, t, 'school'); });

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Parent Communication Bot running on :${PORT}`));
