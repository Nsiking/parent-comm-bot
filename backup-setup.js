'use strict';
// Connects the backup engine to an Express app (School Management and the Parent Bot).
//   setup(app, { db, guards })   guards = who may look at backups and press "Back up now"
const bk = require('./backup');

module.exports = function setupBackups(app, { db, guards }) {
  const cfg = require('./backup-config')();
  bk.init({
    ...cfg,
    snapshot: async (file) => { db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); },       // a consistent copy while the app keeps running
    verify: async (file) => {                                                                 // never upload a damaged copy
      const Database = require('better-sqlite3');
      const t = new Database(file, { readonly: true });
      try {
        const r = t.pragma('integrity_check');
        const first = Array.isArray(r) ? r[0] : r;
        if (!(first === 'ok' || (first && first.integrity_check === 'ok'))) throw new Error('The copy failed its health check.');
      } finally { t.close(); }
    },
  });
  const router = require('express').Router();
  router.get('/status', async (req, res) => {
    const s = bk.getStatus();
    let recent = [], listError = null;
    if (s.configured && req.query.list === '1') { try { recent = (await bk.listBackups()).slice(0, 10); } catch (e) { listError = e.message; } }
    res.json({ ...s, recent, listError });
  });
  router.post('/run', async (req, res) => {
    try { const r = await bk.runBackup({ reason: 'manual' }); res.json({ ok: true, key: r.key, sizeBytes: r.sizeBytes, removed: r.removed, encrypted: r.encrypted }); }
    catch (e) { res.status(/already running/.test(e.message) ? 409 : 400).json({ error: e.message }); }
  });
  app.use('/api/backup', ...guards, router);
  bk.startSchedule();
};
