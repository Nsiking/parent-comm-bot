const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const SECRET = process.env.JWT_SECRET;
if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}
const KEY = SECRET || 'dev-only-secret';

const hash = (pw) => bcrypt.hashSync(pw, 10);
const verify = (pw, h) => bcrypt.compareSync(pw, h);
// PW-RESET: "t" is the exact moment (milliseconds) a session began, so a password reset can sign out every session that began before it
const sign = (user) => jwt.sign({ uid: user.id, t: Date.now() }, KEY, { expiresIn: '7d' });

function setCookie(res, token) {
  res.cookie('pcb_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

function requireAuth(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies.pcb_token || '', KEY);
    const { uid } = payload;
    const user = db.prepare('SELECT id, school_id, name, email, role FROM users WHERE id=?').get(uid);
    if (!user) throw new Error('no user');
    /* PW-RESET: a session that began before the password was reset is signed out */
    let changed = 0;
    try { const r = db.prepare('SELECT pw_changed_at FROM user_security WHERE user_id=?').get(uid); changed = r ? r.pw_changed_at : 0; } catch (_) { /* the table appears once password reset is set up */ }
    if (changed && (payload.t || (payload.iat || 0) * 1000) < changed) throw new Error('password was changed');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

module.exports = { hash, verify, sign, setCookie, requireAuth, requireAdmin };
