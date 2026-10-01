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
const sign = (user) => jwt.sign({ uid: user.id }, KEY, { expiresIn: '7d' });

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
    const { uid } = jwt.verify(req.cookies.pcb_token || '', KEY);
    const user = db.prepare('SELECT id, school_id, name, email, role FROM users WHERE id=?').get(uid);
    if (!user) throw new Error('no user');
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
