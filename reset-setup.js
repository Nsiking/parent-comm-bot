'use strict';
// Password reset by email for the Parent Communication Bot: a 6-digit code (15 minutes, used once, 5 tries, 3 per hour), then a new password.
// Added by apply-reset.js. Does nothing visible until the EMAIL_* settings exist (see PASSWORD_RESET.md).
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const notify = require('./notify');

module.exports = function setupReset(app, { db, hash, guards }) {
  db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets (user_id, id DESC);
  CREATE TABLE IF NOT EXISTS user_security (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, pw_changed_at INTEGER NOT NULL DEFAULT 0);`);
  const secret = process.env.JWT_SECRET || 'dev-only-secret';
  const codeHash = (uid, code) => crypto.createHmac('sha256', secret).update(`pwreset:${uid}:${code}`).digest('hex');
  const MINUTES = 15, TRIES = 5, PER_HOUR = 3;
  const forgotLimiter = rateLimit({ windowMs: 3600 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait an hour and try again.' } });
  const confirmLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait 15 minutes.' } });
  const testLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many tests. Please wait a few minutes.' } });
  const emailOf = (v) => { const e = String(v || '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 150 ? e : null; };

  app.get('/api/reset/options', (_req, res) => res.json({ email: notify.options().email }));

  app.post('/api/reset/forgot', forgotLimiter, (req, res) => {
    const email = emailOf((req.body || {}).email);
    if (!email) return res.status(400).json({ error: 'Enter your email address' });
    if (!notify.options().email) return res.status(409).json({ error: 'Resetting by email is not switched on yet. Please ask your school administrator to reset your password.' });
    const generic = { ok: true, minutes: MINUTES };                          // the same answer whether or not the account exists
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u) return res.json(generic);
    if (db.prepare("SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')").get(u.id).n >= PER_HOUR) return res.json(generic);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(u.id);   // a new code replaces any earlier one
    db.prepare("INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?,?,datetime('now', ?))").run(u.id, codeHash(u.id, code), `+${MINUTES} minutes`);
    const msg = `Your SmartClass password reset code is ${code}. It expires in ${MINUTES} minutes. Do not share it. If you did not ask for it, ignore this message.`;
    notify.sendEmail(u.email, 'Your SmartClass password reset code', `${msg}\n\nSmartClass Parent Communication Bot`).catch((e) => console.error('Password reset code could not be sent:', e.message));   // not awaited: the answer must not reveal whether the account exists
    res.json(generic);
  });

  app.post('/api/reset/confirm', confirmLimiter, (req, res) => {
    const b = req.body || {}; const email = emailOf(b.email), code = String(b.code || '').replace(/\s/g, ''), pw = b.new_password;
    const bad = () => res.status(400).json({ error: 'That code is not valid or has expired. Please ask for a new one.' });
    if (typeof pw !== 'string' || pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (pw.length > 200) return res.status(400).json({ error: 'Password is too long.' });
    if (!email || !/^\d{6}$/.test(code)) return bad();
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u) return bad();
    const row = db.prepare("SELECT * FROM password_resets WHERE user_id = ? AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(u.id);
    if (!row) return bad();
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    if (row.attempts + 1 > TRIES) { db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id); return res.status(400).json({ error: 'Too many wrong codes. Please ask for a new one.' }); }
    const a = Buffer.from(codeHash(u.id, code)), c = Buffer.from(row.code_hash);
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return bad();
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(pw), u.id);
      db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(u.id);
      db.prepare('INSERT INTO user_security (user_id, pw_changed_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET pw_changed_at = excluded.pw_changed_at').run(u.id, Date.now());   // every open session on this account is signed out
    })();
    res.json({ ok: true });
  });

  // For the owner account: is email set up, and does a real message arrive?
  app.get('/api/reset/status', ...guards, (req, res) => res.json({ ...notify.status(), you: req.user.email }));
  app.post('/api/reset/test-email', ...guards, testLimiter, async (req, res) => {
    const st = notify.status().email;
    if (!st.ready) return res.status(409).json({ error: 'Email is not set up yet. Missing in the server settings: ' + st.missing.join(', ') + '.' });
    const to = emailOf((req.body || {}).to || req.user.email);
    if (!to) return res.status(400).json({ error: 'Type the email address to send the test to.' });
    try { await notify.sendEmail(to, 'SmartClass test email', 'This is a test message from the SmartClass Parent Communication Bot. If you can read it, password reset emails will reach people. You can ignore it.'); }
    catch (e) { console.error('Test email failed:', e.message); return res.status(424).json({ error: notify.explain(e) }); }
    res.json({ ok: true, to });
  });
};
