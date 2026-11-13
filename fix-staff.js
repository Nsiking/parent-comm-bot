'use strict';
/*
  SUPPORT TOOL: fix a teacher account that was added to the wrong school.
  It can either MOVE the teacher to the right school, or DELETE the teacher's account.

  It is safe by default: WITHOUT --apply it only shows what it would do and changes nothing.

    Preview:  node fix-staff.js --email=teacher@example.com
    Move:     node fix-staff.js --email=teacher@example.com --move-to="Bright Future School" --apply
    Delete:   node fix-staff.js --email=teacher@example.com --remove --apply

  Rules it keeps:
    - it only touches teachers: it refuses administrators and the owner account
    - a move or a delete changes exactly one account; parents, messages and History of every school stay as they are
    - before it changes anything it saves a copy of the database (parentbot.db.before-fix-staff-...)
    - everything happens in one step: if anything goes wrong, nothing is changed
*/
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const apply = args.apply === true;
const wantRemove = args.remove === true;
const moveTo = typeof args['move-to'] === 'string' ? args['move-to'].trim() : '';
const email = String(args.email || '').trim().toLowerCase();

const say = (s = '') => console.log(s);
function stop(why) { say('\nSTOPPED. Nothing was changed.'); say(why); say(''); process.exit(1); }

if (!email) stop('Tell me whose account to fix, for example:  --email=teacher@example.com');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
const file = path.join(dir, 'parentbot.db');
if (!fs.existsSync(file)) stop(`I cannot find the database at ${file}. Run this on the server where the Parent Bot lives.`);

const db = new Database(file);
db.pragma('busy_timeout = 8000');
db.pragma('foreign_keys = ON');
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const roleName = (r) => (r === 'admin' ? 'Administrator' : 'Teacher');

const person = one('SELECT * FROM users WHERE lower(email) = ?', email);
if (!person) stop(`I cannot find anybody with the email ${email}.`);
const school = one('SELECT * FROM schools WHERE id = ?', person.school_id);
const owner = one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");

say(`Found:      ${person.name} <${person.email}>`);
say(`Role:       ${roleName(person.role)}`);
say(`School now: ${school.name}`);
const listSchools = () => all('SELECT id, name FROM schools ORDER BY id').map((s) => `      ${s.name}`).join('\n');

if (person.role === 'admin' || (owner && owner.id === person.id)) stop('This is an administrator account. This tool only fixes teacher accounts, so that an administrator can never be removed by mistake.');
if (wantRemove && moveTo) stop('Choose one: either --remove or --move-to="School name", not both.');

let target = null;
if (moveTo) {
  target = one('SELECT * FROM schools WHERE lower(name) = lower(?)', moveTo);
  if (!target) stop(`There is no school called "${moveTo}". The schools are:\n${listSchools()}`);
  if (target.id === person.school_id) stop(`${person.name} is already in "${target.name}".`);
}

const sameEmailTeachers = one('SELECT COUNT(*) n FROM users WHERE school_id = ?', person.school_id).n;
say('\nTHE PLAN' + (apply ? '' : ' (preview only, nothing is changed yet)'));
if (!wantRemove && !moveTo) {
  say('  You did not say what to do. You can:');
  say(`    MOVE the account to the right school:  node fix-staff.js --email=${person.email} --move-to="School name" --apply`);
  say(`    DELETE the account:                    node fix-staff.js --email=${person.email} --remove --apply`);
  say('\n  The schools are:\n' + listSchools() + '\n');
  process.exit(0);
}
if (moveTo) {
  say(`  Move ${person.name} <${person.email}> from "${school.name}" to "${target.name}".`);
  say('  Their email and password stay the same. They become a teacher of the new school, and only the new school sees them.');
} else {
  say(`  DELETE the account of ${person.name} <${person.email}> from "${school.name}".`);
  say('  They can no longer sign in. Parents, messages and History are not touched. The email can be used again for a new account.');
}
say(`\n  People in "${school.name}" now: ${sameEmailTeachers}`);

if (!apply) {
  say('\nThis was a preview. To do it, run the same command again with  --apply  at the end.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- do it (one step, with a restore point)
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* fine */ }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const restorePoint = `${file}.before-fix-staff-${stamp}`;
fs.copyFileSync(file, restorePoint);
say(`\nSaved a copy of the database first: ${restorePoint}`);

const usersBefore = one('SELECT COUNT(*) n FROM users').n;
const dataBefore = ['contacts', 'messages', 'batches'].map((t) => one(`SELECT COUNT(*) n FROM ${t}`).n).join(',');
try {
  db.transaction(() => {
    if (moveTo) {
      db.prepare("UPDATE users SET school_id = ? WHERE id = ? AND role = 'staff'").run(target.id, person.id);
      if (one('SELECT school_id FROM users WHERE id = ?', person.id).school_id !== target.id) throw new Error('The account was not moved');
      if (one('SELECT COUNT(*) n FROM users').n !== usersBefore) throw new Error('The number of accounts changed');
    } else {
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'staff'").run(person.id);
      if (one('SELECT id FROM users WHERE id = ?', person.id)) throw new Error('The account was not deleted');
      if (one('SELECT COUNT(*) n FROM users').n !== usersBefore - 1) throw new Error('More than one account would have been deleted');
    }
    const dataAfter = ['contacts', 'messages', 'batches'].map((t) => one(`SELECT COUNT(*) n FROM ${t}`).n).join(',');
    if (dataAfter !== dataBefore) throw new Error('Parents, messages or batches changed unexpectedly');
    if (owner && !one('SELECT id FROM users WHERE id = ? AND role = ?', owner.id, 'admin')) throw new Error('The owner account would be affected');
  })();
} catch (e) {
  stop(`Something went wrong ("${e.message}"), so everything was undone. The database is exactly as before (a copy is at ${restorePoint}).`);
}

say('\nDONE.');
if (moveTo) say(`  ${person.name} <${person.email}> is now a teacher of "${target.name}".`);
else say(`  The account of ${person.name} <${person.email}> was deleted from "${school.name}".`);
say(`\nIf you ever need to go back, the copy of the database is: ${restorePoint}\n`);
if (db.close) db.close();
