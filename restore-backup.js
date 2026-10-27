'use strict';
// Gets a backup back from the bucket. Run it where the app runs (on Render: the service's Shell).
//
//   node restore-backup.js status          are the backup settings correct? what is the latest backup?
//   node restore-backup.js list            the backups in the bucket, newest first
//   node restore-backup.js stage latest    download the newest one and get it ready   (or: stage <name from the list>)
//
// "stage" changes nothing by itself. Restart the service afterwards and the backup is put in place as the app starts;
// the database that was there before is kept next to it as ...before-restore-<date>, so nothing is thrown away.
const bk = require('./backup');
const cfg = require('./backup-config')();
bk.init({ ...cfg, snapshot: async () => { throw new Error('not used here'); }, verify: async () => {} });

const [cmd, arg] = process.argv.slice(2);
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
(async () => {
  if (!bk.configured()) throw new Error('The BACKUP_S3_* settings are missing here. On Render they are in the service\'s Environment tab, and they are already available in its Shell.');
  if (cmd === 'status') {
    const list = await bk.listBackups(); const c = bk.config();
    console.log(`${cfg.label}: settings OK (bucket "${c.bucket}"). ${list.length} backup(s) found${bk.getStatus().encrypted ? '; locked with your passphrase' : ''}.`);
    if (list[0]) console.log(`Latest: ${list[0].key}  (${list[0].at}, ${mb(list[0].size)})`);
  } else if (cmd === 'list') {
    const list = await bk.listBackups();
    if (!list.length) return console.log('There are no backups in the bucket yet.');
    for (const b of list) console.log(`${b.key}   ${b.at}   ${mb(b.size)}${b.locked ? '   (locked)' : ''}`);
  } else if (cmd === 'stage') {
    const r = await bk.stageRestore(cfg.dbPath, arg || 'latest');
    console.log(`Ready: ${r.key} (${mb(r.bytes)}) has been downloaded and checked.\n\nNOW RESTART THE SERVICE (Render: Manual Deploy, then "Restart service").\nAs it starts it puts this backup in place and keeps the current database next to it, named ...before-restore-<date>.`);
  } else {
    console.log('Use:  node restore-backup.js status   |   list   |   stage latest   |   stage <name from the list>');
  }
})().catch((e) => { console.error('\n' + e.message + '\n'); process.exit(1); });
