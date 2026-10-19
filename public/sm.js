'use strict';
/* SmartClass School Management connection: extra cards for the Parent Communication Bot.
   Loaded after app.js. A school that has not connected sees nothing new except the Connect card in Settings. */
(function () {
  var sm = null, loading = false, terms = null, classes = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function naira(k) { return '\u20A6' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: k % 100 ? 2 : 0, maximumFractionDigits: 2 }); }
  function call(method, url, body) {
    return fetch('/api' + url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.'); return d; }); });
  }
  function load(then) {
    if (loading) return; loading = true;
    call('GET', '/sm').then(function (d) { sm = d; loading = false; then && then(); })
      .catch(function () { sm = { connected: false, canManage: false }; loading = false; });
  }
  function msg(el, text, bad) { el.textContent = text; el.style.color = bad ? '#b42318' : ''; }

  /* ---------- Settings: connect (administrator) ---------- */
  function settingsCard(view) {
    if (document.getElementById('smcard') || !sm.canManage) return;
    var html = '<div class="card" id="smcard"><h3>SmartClass School Management</h3>';
    if (sm.connected) {
      html += '<p style="margin:10px 0 4px">Connected to <b>' + esc(sm.url) + '</b>.</p><p class="small muted" style="margin:0 0 10px">Staff can import parents, draft fee reminders from the real balances, and draft absence alerts from the attendance School Management has. Delivered messages are noted on each pupil\u2019s page there. Nothing is ever sent without your review.</p><button class="btn danger" id="smoff">Disconnect</button>';
    } else {
      html += '<p class="small muted" style="margin:6px 0 10px">Connect this school to School Management. There, open <b>Settings \u2192 Connected products \u2192 Connect a product \u2192 Parent Bot</b>, copy the key, then paste it here.</p>'
        + '<div class="grid"><label>Web address of School Management<input id="smurl" placeholder="https://your-school-management.onrender.com" autocomplete="off"></label><label>Key<input id="smkey" type="password" placeholder="scsm_..." autocomplete="off"></label><div style="align-self:end"><button class="btn" id="smon">Connect</button></div></div>';
    }
    html += '<p class="small" id="smerr" style="margin:8px 0 0"></p></div>';
    view.insertAdjacentHTML('beforeend', html);
    var err = document.getElementById('smerr'), on = document.getElementById('smon'), off = document.getElementById('smoff');
    if (on) on.addEventListener('click', function () {
      on.disabled = true; msg(err, 'Checking the key\u2026');
      call('PUT', '/sm', { url: document.getElementById('smurl').value, key: document.getElementById('smkey').value })
        .then(function (r) { sm = null; PCB.toast('Connected to ' + r.schoolName); if (r.notes && r.notes.length) alert(r.notes.join('\n')); PCB.goto('settings'); })
        .catch(function (e) { on.disabled = false; msg(err, e.message, true); });
    });
    if (off) off.addEventListener('click', function () {
      if (!confirm('Disconnect from School Management? Parents already imported stay in your list.')) return;
      call('DELETE', '/sm').then(function () { sm = null; PCB.toast('Disconnected'); PCB.goto('settings'); }).catch(function (e) { msg(err, e.message, true); });
    });
  }

  /* ---------- Parents: import ---------- */
  function parentsCard(view) {
    if (document.getElementById('smparents') || !sm.connected) return;
    var first = view.querySelector('.card'); if (!first) return;
    first.insertAdjacentHTML('beforebegin', '<div class="card" id="smparents"><h3>Import from School Management</h3><p class="small muted" style="margin:6px 0 10px">Brings in every active pupil with their main parent\u2019s name and phone number. Parents who opted out, and the channel you chose for each, are kept. Run it again any time to catch new pupils and changed numbers.</p><button class="btn" id="smsync">Import parents from School Management</button><p class="small" id="smsyncmsg" style="margin:8px 0 0"></p></div>');
    var b = document.getElementById('smsync'), m = document.getElementById('smsyncmsg');
    b.addEventListener('click', function () {
      b.disabled = true; msg(m, 'Importing\u2026');
      call('POST', '/sm/sync-parents', {}).then(function (r) {
        var t = r.added + ' added, ' + r.updated + ' updated.';
        if (r.skipped_count) t += ' ' + r.skipped_count + ' pupils were skipped because no parent phone number is on record: ' + r.skipped.slice(0, 5).map(function (x) { return x.pupil; }).join(', ') + (r.skipped_count > 5 ? '\u2026' : '') + '. Add their parent\u2019s number in School Management and import again.';
        if (r.no_longer_active) t += ' ' + r.no_longer_active + ' pupils in your list are no longer active in School Management (they were left as they are).';
        PCB.refresh().then(function () { PCB.goto('parents'); setTimeout(function () { var x = document.getElementById('smsyncmsg'); if (x) msg(x, t); PCB.toast(r.added + ' added, ' + r.updated + ' updated', !!r.skipped_count && !r.added && !r.updated); }, 400); });
      }).catch(function (e) { b.disabled = false; msg(m, e.message, true); });
    });
  }

  /* ---------- Compose: fee reminders and absence alerts ---------- */
  function composeCard(view) {
    if (document.getElementById('smcompose') || !sm.connected) return;
    var me = PCB.me();
    if (terms === null || classes === null) {
      terms = terms || []; classes = classes || [];
      Promise.all([call('GET', '/sm/terms').catch(function () { return []; }), call('GET', '/classes').catch(function () { return []; })]).then(function (r) { terms = r[0]; classes = r[1]; var old = document.getElementById('smcompose'); if (old) old.remove(); schedule(); });
      return;
    }
    var today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    var cur = terms.filter(function (t) { return t.is_current; })[0] || terms[0];
    var html = '<div class="card" id="smcompose"><h3>From School Management</h3>'
      + '<h4 style="margin:12px 0 4px">Fee reminders with the real balances</h4><p class="small muted" style="margin:0 0 10px">Drafts one reminder for each family that owes fees, with the exact amount from School Management. You review every message before anything is sent.</p>'
      + '<div class="grid"><label>Term<select id="smterm">' + terms.map(function (t) { return '<option value="' + t.id + '"' + (cur && t.id === cur.id ? ' selected' : '') + '>' + esc(t.name + ' ' + t.year) + '</option>'; }).join('') + '</select></label>'
      + '<label>Class<select id="smcls"><option value="">All classes</option>' + classes.map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.name || 'No class') + '</option>'; }).join('') + '</select></label>'
      + '<label>Only if they owe at least (\u20A6)<input id="smmin" type="number" min="1" value="1"></label>'
      + '<label>Tone<select id="smtone">' + Object.keys(me.tones).map(function (k) { return '<option value="' + k + '"' + (me.school.default_tone === k ? ' selected' : '') + '>' + esc(me.tones[k]) + '</option>'; }).join('') + '</select></label>'
      + '<label>Language<select id="smlang">' + me.languages.map(function (l) { return '<option' + (me.school.default_language === l ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select></label>'
      + (sm.ai ? '<label class="check" style="align-self:end"><input type="checkbox" id="smai" checked> Word with AI (the amount is always checked)</label>' : '') + '</div>'
      + '<label style="display:block;margin-top:10px">Extra words (optional)<textarea id="smextra" placeholder="e.g. Please pay at the bursar\u2019s office or into the school account by Friday."></textarea></label>'
      + '<div class="row" style="margin-top:10px"><button class="btn ghost" id="smcheck">Check who owes</button><button class="btn" id="smfees">Draft fee reminders</button></div><p class="small" id="smfeemsg" style="margin:8px 0 0"></p>'
      + '<h4 style="margin:18px 0 4px">Absence alerts from the register</h4><p class="small muted" style="margin:0 0 10px">Drafts an alert for every pupil School Management has marked absent (or late) on a day. Pupils already alerted that day are skipped.</p>'
      + '<div class="row"><label style="margin:0">Date<input type="date" id="smday" value="' + today + '" max="' + today + '"></label><button class="btn" id="smabs" style="align-self:end">Draft absence alerts</button></div><p class="small" id="smabsmsg" style="margin:8px 0 0"></p></div>';
    var anchor = view.querySelector('.head'); (anchor ? anchor : view.firstChild).insertAdjacentHTML('afterend', html);
    var $ = function (id) { return document.getElementById(id); };
    function feeBody(preview) {
      return { term_id: Number($('smterm').value), classes: $('smcls').value ? [$('smcls').value] : [], min_naira: Number($('smmin').value) || 1, tone: $('smtone').value, language: $('smlang').value, facts: $('smextra').value, use_ai: $('smai') ? $('smai').checked : false, preview: !!preview };
    }
    $('smcheck').addEventListener('click', function () {
      var m = $('smfeemsg'); msg(m, 'Checking\u2026');
      call('POST', '/sm/fee-drafts', feeBody(true)).then(function (r) {
        var t = r.families + ' famil' + (r.families === 1 ? 'y owes' : 'ies owe') + ' ' + naira(r.total_owed) + ' in total (' + r.term + '). ' + r.messages + ' message' + (r.messages === 1 ? '' : 's') + ' would be drafted.';
        if (r.no_contact_count) t += ' ' + r.no_contact_count + ' owing pupils have no parent in your list (' + r.no_contact.slice(0, 4).map(function (x) { return x.pupil; }).join(', ') + (r.no_contact_count > 4 ? '\u2026' : '') + '). Use \u201cImport parents\u201d on the Parents page.';
        if (r.opted_out) t += ' ' + r.opted_out + ' opted out of messages.';
        msg(m, t);
      }).catch(function (e) { msg(m, e.message, true); });
    });
    $('smfees').addEventListener('click', function () {
      var b = $('smfees'), m = $('smfeemsg'); b.disabled = true; msg(m, 'Drafting\u2026');
      call('POST', '/sm/fee-drafts', feeBody(false)).then(function (r) {
        PCB.toast(r.count + ' reminder' + (r.count === 1 ? '' : 's') + ' drafted' + (r.templates ? ' (' + r.templates + ' from the standard wording)' : '') + '. Review before sending.'); PCB.showDrafts();
      }).catch(function (e) { b.disabled = false; msg(m, e.message, true); });
    });
    $('smabs').addEventListener('click', function () {
      var b = $('smabs'), m = $('smabsmsg'); b.disabled = true; msg(m, 'Reading the register\u2026');
      call('POST', '/sm/absence-drafts', { date: $('smday').value }).then(function (r) {
        if (!r.drafted) { b.disabled = false; msg(m, r.absent + r.late === 0 ? 'Nobody was marked absent or late on ' + r.date + '.' : 'Nothing new to draft. ' + (r.already_notified ? r.already_notified + ' parents were already alerted that day. ' : '') + (r.no_contact ? r.no_contact + ' pupils have no parent in your list.' : '')); return; }
        PCB.toast(r.drafted + ' alert' + (r.drafted === 1 ? '' : 's') + (r.auto_sent ? ' sent' : ' drafted. Review before sending')); PCB.showDrafts();
      }).catch(function (e) { b.disabled = false; msg(m, e.message, true); });
    });
  }

  /* ---------- watch the screen and add the cards where they belong ---------- */
  var pending = false;
  function schedule() { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; inject(); }); }
  function inject() {
    var view = document.getElementById('view'); if (!view || !window.PCB || !PCB.me()) return;
    var h = view.querySelector('h1'); if (!h) return;
    if (sm === null) { load(schedule); return; }
    var t = h.textContent.trim();
    if (t === 'Settings') settingsCard(view); else if (t === 'Parents') parentsCard(view); else if (t === 'Compose') composeCard(view);
  }
  new MutationObserver(schedule).observe(document.getElementById('root'), { childList: true, subtree: true });
  schedule();
})();
