const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
require('./backup').applyPendingRestore(path.join(dir, 'parentbot.db')); /* BK-BACKUP: a backup staged with restore-backup.js is put in place before the database opens */
const db = new Database(path.join(dir, 'parentbot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL DEFAULT 'SmartClass',
  signature TEXT,
  default_tone TEXT NOT NULL DEFAULT 'warm',
  default_language TEXT NOT NULL DEFAULT 'English',
  auto_send_absence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  class_name TEXT NOT NULL DEFAULT '',
  admission_no TEXT NOT NULL DEFAULT '',
  parent_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  opted_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_school_class ON contacts(school_id, class_name);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  tone TEXT,
  language TEXT,
  facts TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  ai INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  provider_id TEXT,
  error TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_school_status ON messages(school_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(school_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
`);

// Anything left "queued" by a crash/restart goes back to draft so nothing is silently lost.
db.prepare("UPDATE messages SET status='draft' WHERE status='queued'").run();

module.exports = db;
