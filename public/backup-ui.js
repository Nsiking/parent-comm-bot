'use strict';
/* Backup status card: last backup, "Back up now", and the latest backups in the bucket.
   Added to: School Management (platform admin, Schools page), Report Cards (platform admin), Parent Bot (owner, Settings).
   Shown only to people the server allows; everybody else sees nothing new. */
(function () {
  var data = null, fetchedAt = 0, denied = false, busy = false, msg = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(iso) { try { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } }
  function ago(iso) { var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' minute' + (m === 1 ? '' : 's') + ' ago' : Math.round(m / 60) + ' hour' + (Math.round(m / 60) === 1 ? '' : 's') + ' ago'; }
  function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function call(method, url) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: method === 'POST' ? '{}' : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; } return d; }); });
  }

  /* where does this product want the card? */
  function place() {
    if (window.PCB && window.PCB.me && window.PCB.me()) {                                   // Parent Bot
      var v = document.getElementById('view'), h = v && v.querySelector('h1');
      return h && h.textContent.trim() === 'Settings' ? { host: v, cls: 'card', h: 'h3' } : null;
    }
    if (typeof A !== 'undefined' && A && A.view) {                                          // Report Cards
      var m = document.getElementById('main');
      return A.view === 'platform' && A.me && A.me.role === 'super_admin' && m ? { host: m, cls: 'panel', h: 'h2' } : null;
    }
    var v2 = document.getElementById('view'), h2 = v2 && v2.querySelector('h1');             // School Management
    return h2 && h2.textContent.trim() === 'Schools' && v2.querySelector('#adds') ? { host: v2, cls: 'card', h: 'h2' } : null;
  }

  function pill(text, colour) {
    var c = { green: '52,168,83', red: '217,45,32', amber: '230,150,20' }[colour];
    return '<span style="display:inline-block;padding:.1rem .6rem;border-radius:999px;border:1px solid rgba(' + c + ',.7);background:rgba(' + c + ',.16);font-size:.85em;font-weight:600">' + text + '</span>';
  }

  function html(p, d) {
    var t = '<' + p.h + ' style="margin-top:0">Automatic backups</' + p.h + '>';
    if (!d.configured) {
      return t + '<p style="margin:.4rem 0">' + pill('Not set up yet', 'amber') + '</p><p style="margin:.4rem 0">A copy of the database is not being saved anywhere else yet. To switch it on, open this service on Render, go to <b>Environment</b> and add four settings from your Cloudflare R2 bucket:</p>'
        + '<p style="margin:.4rem 0"><code>BACKUP_S3_ENDPOINT</code> &nbsp; <code>BACKUP_S3_BUCKET</code> &nbsp; <code>BACKUP_S3_ACCESS_KEY_ID</code> &nbsp; <code>BACKUP_S3_SECRET_ACCESS_KEY</code></p>'
        + '<p style="margin:.4rem 0;opacity:.8">Also add <code>BACKUP_ENCRYPTION_KEY</code> (a passphrase of your own) so the backups are locked. The step-by-step guide is in <b>BACKUPS.md</b>.</p>';
    }
    var late = d.hourAgo !== null && d.hourAgo > 36;
    var state = d.lastSuccessAt ? (late ? pill('Last backup was ' + d.hourAgo + ' hours ago', 'red') : pill('Working', 'green')) : pill('No successful backup yet', 'amber');
    var out = t + '<p style="margin:.4rem 0">' + state + ' ' + (d.encrypted ? pill('Locked with your passphrase', 'green') : pill('Not locked: add BACKUP_ENCRYPTION_KEY', 'amber')) + '</p>';
    if (d.lastSuccessAt) out += '<p style="margin:.4rem 0">Last backup: <b>' + esc(when(d.lastSuccessAt)) + '</b> (' + ago(d.lastSuccessAt) + ', ' + mb(d.lastSizeBytes || 0) + ')</p>';
    if (d.lastError) out += '<p style="margin:.4rem 0;color:#d92d20"><b>The last attempt failed:</b> ' + esc(d.lastError) + '</p>';
    out += '<p style="margin:.4rem 0;opacity:.85">Saved automatically about <b>' + (d.hour < 10 ? '0' : '') + d.hour + ':00</b> every night (Lagos time). Kept: everything from the last 2 days, then one a day for ' + d.retention.daily + ' days, one a week for ' + d.retention.weekly + ' weeks, one a month for ' + d.retention.monthly + ' months.</p>';
    out += '<p style="margin:.6rem 0"><button class="btn" id="bkrun"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Backing up\u2026' : 'Back up now') + '</button></p>';
    if (msg) out += '<p id="bkmsg" style="margin:.4rem 0;color:' + (msg.bad ? '#d92d20' : 'inherit') + '">' + esc(msg.text) + '</p>';
    if (d.listError) out += '<p style="margin:.4rem 0;color:#d92d20">Could not read the bucket: ' + esc(d.listError) + '</p>';
    if (d.recent && d.recent.length) {
      out += '<details style="margin-top:.6rem"><summary style="cursor:pointer"><b>Latest backups in the bucket</b> (' + d.recent.length + ')</summary><table style="margin-top:.4rem;border-collapse:collapse"><tbody>'
        + d.recent.map(function (b) { return '<tr><td style="padding:.15rem 1rem .15rem 0">' + esc(when(b.at)) + '</td><td style="padding:.15rem 1rem .15rem 0">' + mb(b.size) + '</td><td>' + (b.locked ? 'locked' : 'not locked') + '</td></tr>'; }).join('') + '</tbody></table></details>';
    }
    out += '<details style="margin-top:.6rem"><summary style="cursor:pointer"><b>How to restore a backup</b></summary><ol style="margin:.4rem 0;padding-left:1.2rem"><li>On Render open this service and click <b>Shell</b>.</li><li>Type <code>node restore-backup.js list</code> to see the backups, then <code>node restore-backup.js stage latest</code>.</li><li>Restart the service (Manual Deploy, then Restart). The backup is put in place as it starts, and the current database is kept beside it, so nothing is thrown away.</li></ol></details>';
    return out;
  }

  function paint() {
    var p = place(); if (!p || denied || !data) return;
    var card = document.getElementById('bkcard');
    var inner = html(p, data);
    if (!card) { card = document.createElement('div'); card.id = 'bkcard'; card.className = p.cls; card.style.marginTop = '1rem'; p.host.appendChild(card); }
    else if (card.getAttribute('data-sig') === inner) return;
    card.setAttribute('data-sig', inner); card.innerHTML = inner;
    var b = document.getElementById('bkrun');
    if (b) b.addEventListener('click', run);
  }
  function refresh(force) {
    if (denied) return Promise.resolve();
    if (!force && data && Date.now() - fetchedAt < 60000) { paint(); return Promise.resolve(); }
    return call('GET', '/api/backup/status?list=1').then(function (d) { data = d; fetchedAt = Date.now(); paint(); })
      .catch(function (e) { if (e.status === 401 || e.status === 403 || e.status === 404) denied = true; });
  }
  function run() {
    busy = true; msg = null; paint();
    call('POST', '/api/backup/run').then(function (r) { msg = { text: 'Done. Saved ' + r.key + ' (' + mb(r.sizeBytes) + ').' }; })
      .catch(function (e) { msg = { text: e.message, bad: true }; })
      .then(function () { busy = false; return refresh(true); }).then(function () { var m = document.getElementById('bkmsg'); if (!m && msg) paint(); });
  }

  var pending = false;
  function schedule() { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; if (place() && !document.getElementById('bkcard')) refresh(false); }); }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
