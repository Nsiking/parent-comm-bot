'use strict';
/*
  ONE-TIME SCRIPT: give the owner (the first administrator) their own company account, and make a chosen
  teacher the administrator of the school the owner is leaving.

  It is safe by default: WITHOUT --apply it only shows what it would do and changes nothing.

    Preview:  node separate-owner.js --admin-email=gallu@gmail.com
    Do it:    node separate-owner.js --admin-email=gallu@gmail.com --apply
    Options:  --company-name="SmartClass AI Academy Limited"   (this is the default name)

  What it changes (and nothing else):
    1. creates one new account named like the company (no parents, no messages)
    2. moves ONLY the owner's login into that account
    3. makes the chosen teacher an administrator of the school the owner is leaving
  Parents, messages, History, teachers, School Management connection and keys of that school are not touched.
  Before it changes anything it saves a copy of the database next to it (parentbot.db.before-separate-...).
  Everything happens in one step: if anything goes wrong, nothing is changed.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const apply = args.apply === true;
const adminEmail = String(args['admin-email'] || '').trim().toLowerCase();
const companyName = String(args['company-name'] || 'SmartClass AI Academy Limited').trim();

const say = (s = '') => console.log(s);
function stop(why) { say('\nSTOPPED. Nothing was changed.'); say(why); say(''); process.exit(1); }

if (!adminEmail) stop('Tell me who becomes the administrator, for example:  --admin-email=teacher@example.com');
if (!companyName) stop('The company name cannot be empty.');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
const file = path.join(dir, 'parentbot.db');
if (!fs.existsSync(file)) stop(`I cannot find the database at ${file}. Run this on the server where the Parent Bot lives.`);

const db = new Database(file);
db.pragma('busy_timeout = 8000');

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const roleName = (r) => (r === 'admin' ? 'Administrator' : 'Teacher');
const listUsers = (sid) => all('SELECT id, name, email, role FROM users WHERE school_id = ? ORDER BY id', sid)
  .map((u) => `      ${u.name} <${u.email}>  ${roleName(u.role)}`).join('\n') || '      (nobody)';
const counts = (sid) => ({
  parents: one('SELECT COUNT(*) n FROM contacts WHERE school_id = ?', sid).n,
  messages: one('SELECT COUNT(*) n FROM messages WHERE school_id = ?', sid).n,
  batches: one('SELECT COUNT(*) n FROM batches WHERE school_id = ?', sid).n,
  users: one('SELECT COUNT(*) n FROM users WHERE school_id = ?', sid).n,
});

// ---------------------------------------------------------------- who is who
const owner = one("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
if (!owner) stop('There is no administrator account in this database.');
const ownerSchool = one('SELECT * FROM schools WHERE id = ?', owner.school_id);
const admin = one('SELECT * FROM users WHERE lower(email) = ?', adminEmail);
if (!admin) stop(`I cannot find anybody with the email ${adminEmail}.`);
if (admin.id === owner.id) stop('The new administrator must be a different person from the owner.');

say(`Owner (first administrator): ${owner.name} <${owner.email}>`);
say(`Their school today:          ${ownerSchool.name}`);

// ---------------------------------------------------------------- already done?
if (admin.school_id !== owner.school_id) {
  const c = counts(owner.school_id);
  if (c.users === 1 && c.parents === 0 && c.messages === 0) {
    say(`\nNothing to do. The owner already has an account of their own ("${ownerSchool.name}") with no parents or messages in it.`);
    process.exit(0);
  }
  stop(`${admin.name} belongs to a different school than the owner. The new administrator must be one of the teachers in "${ownerSchool.name}".`);
}

// ---------------------------------------------------------------- the plan
const before = counts(owner.school_id);
say(`\nTHE PLAN${apply ? '' : ' (preview only, nothing is changed yet)'}`);
say(`  1. Create a new account named "${companyName}" (no parents, no messages).`);
say(`  2. Move ${owner.name} <${owner.email}> into it. Their login, password and sign-in stay the same.`);
say(`  3. Make ${admin.name} <${admin.email}> an Administrator of "${ownerSchool.name}".`);
say(`\n  "${ownerSchool.name}" keeps all of this, unchanged: ${before.parents} parents, ${before.messages} messages, ${before.batches} drafting batches, its settings, keys and connections.`);
say('\n  People in "' + ownerSchool.name + '" now:\n' + listUsers(owner.school_id));
say('\n  People in "' + ownerSchool.name + '" after:\n' + all('SELECT id, name, email, role FROM users WHERE school_id = ? AND id != ? ORDER BY id', owner.school_id, owner.id)
  .map((u) => `      ${u.name} <${u.email}>  ${roleName(u.id === admin.id ? 'admin' : u.role)}`).join('\n'));
say(`\n  People in "${companyName}" after:\n      ${owner.name} <${owner.email}>  Administrator`);

if (!apply) {
  say('\nThis was a preview. To do it, run the same command again with  --apply  at the end.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- do it (one step, with a restore point)
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode: fine */ }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const restorePoint = `${file}.before-separate-${stamp}`;
fs.copyFileSync(file, restorePoint);
say(`\nSaved a copy of the database first: ${restorePoint}`);

let newSchoolId;
try {
  db.transaction(() => {
    const apiKey = 'pcb_' + crypto.randomBytes(24).toString('hex');
    newSchoolId = Number(db.prepare('INSERT INTO schools(name, api_key, signature) VALUES (?,?,?)').run(companyName, apiKey, companyName).lastInsertRowid);
    db.prepare('UPDATE users SET school_id = ? WHERE id = ?').run(newSchoolId, owner.id);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);

    // checks inside the same step: if any is wrong, everything is undone
    const after = counts(owner.school_id);
    if (after.parents !== before.parents || after.messages !== before.messages || after.batches !== before.batches) throw new Error('The school data changed unexpectedly');
    if (one('SELECT school_id FROM users WHERE id = ?', owner.id).school_id !== newSchoolId) throw new Error('The owner was not moved');
    if (one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").id !== owner.id) throw new Error('The owner would stop being the first administrator');
    if (one('SELECT role, school_id FROM users WHERE id = ?', admin.id).role !== 'admin') throw new Error('The new administrator was not saved');
    if (counts(newSchoolId).users !== 1) throw new Error('The new account should hold only the owner');
  })();
} catch (e) {
  stop(`Something went wrong ("${e.message}"), so everything was undone. The database is exactly as before (a copy is at ${restorePoint}).`);
}

say('\nDONE.');
say(`  "${companyName}" now exists and holds ${owner.name}.`);
say(`  ${admin.name} is now an Administrator of "${ownerSchool.name}".`);
say('\nWhat to do next: sign out and sign in again, and check the name at the top left of each account.');
say(`If you ever need to go back, the copy of the database is: ${restorePoint}\n`);
if (db.close) db.close();
