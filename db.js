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

// Consent record (NDPA). Columns are only ever ADDED.
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
if (!hasCol('contacts', 'consent_at')) db.exec('ALTER TABLE contacts ADD COLUMN consent_at TEXT');
if (!hasCol('contacts', 'consent_source')) db.exec('ALTER TABLE contacts ADD COLUMN consent_source TEXT');
if (!hasCol('schools', 'require_consent')) db.exec('ALTER TABLE schools ADD COLUMN require_consent INTEGER NOT NULL DEFAULT 0');
// Scheduled sending ("send later"): the time is kept in UTC, like every other time in this database.
if (!hasCol('messages', 'scheduled_at')) db.exec('ALTER TABLE messages ADD COLUMN scheduled_at TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_scheduled ON messages(status, scheduled_at)');
// A record of removed / moved teacher accounts (new table; nothing existing is changed).
db.exec(`CREATE TABLE IF NOT EXISTS staff_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_email TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Saved message templates, shared by everyone at a school (new table; nothing existing is changed).
db.exec(`CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_templates_school ON message_templates(school_id)');

// What one SMS part costs this school (naira), typed in by the administrator; empty means "show counts only".
if (!hasCol('schools', 'sms_price')) db.exec('ALTER TABLE schools ADD COLUMN sms_price REAL');

// Replies parents send back on WhatsApp (new table; nothing existing is changed).
db.exec(`CREATE TABLE IF NOT EXISTS parent_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  wa_id TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_wa ON parent_replies(school_id, wa_id) WHERE wa_id IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_replies_school ON parent_replies(school_id, id)');

// Message approval, quiet hours and parent groups. Everything here is ADDED; both settings are off until a school switches them on.
if (!hasCol('schools', 'require_approval')) db.exec('ALTER TABLE schools ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0');
if (!hasCol('schools', 'quiet_start')) db.exec('ALTER TABLE schools ADD COLUMN quiet_start TEXT');
if (!hasCol('schools', 'quiet_end')) db.exec('ALTER TABLE schools ADD COLUMN quiet_end TEXT');
if (!hasCol('messages', 'approval_requested_at')) db.exec('ALTER TABLE messages ADD COLUMN approval_requested_at TEXT');
if (!hasCol('messages', 'approval_requested_by')) db.exec('ALTER TABLE messages ADD COLUMN approval_requested_by INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS parent_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name ON parent_groups(school_id, name COLLATE NOCASE)');
db.exec(`CREATE TABLE IF NOT EXISTS parent_group_members (
  group_id INTEGER NOT NULL REFERENCES parent_groups(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, contact_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_group_members_contact ON parent_group_members(contact_id)');

// Activity log, event reminders and reply follow-up. Everything here is ADDED.
db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_activity_school ON activity_log(school_id, id)');
if (!hasCol('messages', 'reminder_of')) db.exec('ALTER TABLE messages ADD COLUMN reminder_of INTEGER');
if (!hasCol('parent_replies', 'handled_at')) db.exec('ALTER TABLE parent_replies ADD COLUMN handled_at TEXT');
if (!hasCol('parent_replies', 'handled_by')) db.exec('ALTER TABLE parent_replies ADD COLUMN handled_by INTEGER');
if (!hasCol('parent_replies', 'assigned_to')) db.exec('ALTER TABLE parent_replies ADD COLUMN assigned_to INTEGER');

// Class limits for teachers, and the parent opt-in link. Everything here is ADDED.
db.exec(`CREATE TABLE IF NOT EXISTS staff_classes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  PRIMARY KEY (user_id, class_name)
)`);
if (!hasCol('schools', 'optin_token')) db.exec('ALTER TABLE schools ADD COLUMN optin_token TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS optin_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  parent_name TEXT,
  phone TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_optin_school ON optin_requests(school_id, status)');

// Anything left "queued" by a crash/restart goes back to draft so nothing is silently lost.
db.prepare("UPDATE messages SET status='draft' WHERE status='queued'").run();

module.exports = db;
