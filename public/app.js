(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = $('#root');
  const S = { me: null, view: 'compose', group: 'draft', classes: [], picked: new Set(['*']), msgs: [], counts: {}, contacts: [], poll: null };

  async function api(path, opts = {}) {
    const r = await fetch('/api' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/auth/login') { S.me = null; renderAuth(); throw new Error(d.error || 'Signed out'); }
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }
  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3500);
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---------- password field with show/hide eye
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const pwField = (label, autocomplete) => `<label>${label}<span class="pw"><input name="password" type="password" minlength="8" autocomplete="${autocomplete}" required><button type="button" class="pw-toggle" data-a="togglepw" aria-label="Show password" aria-pressed="false">${EYE}</button></span></label>`;

  // ---------- auth
  function renderAuth(mode = 'login') {
    clearInterval(S.poll);
    root.innerHTML = `<div class="auth"><div class="auth-card">
      <h1>Parent Communication Bot</h1>
      <p class="muted">SmartClass AI. Draft, review and send updates to parents by WhatsApp or SMS.</p>
      <form id="authForm">
        ${mode === 'register' ? `<label>School name<input name="schoolName" required></label><label>Your name<input name="name" required></label>` : ''}
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        ${pwField('Password', mode === 'login' ? 'current-password' : 'new-password')}
        ${mode === 'register' ? `<label>Signup code (if your provider gave you one)<input name="signupCode"></label>` : ''}
        <button class="btn" type="submit">${mode === 'login' ? 'Sign in' : 'Create school account'}</button>
      </form>
      <p class="small">${mode === 'login' ? `New school? <button class="link" data-a="mode-register">Create an account</button>` : `Already registered? <button class="link" data-a="mode-login">Sign in</button>`}</p>
    </div></div>`;
    $('#authForm').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
      await boot();
    }));
  }

  // ---------- shell
  async function boot() {
    try { S.me = await api('/me'); } catch { return renderAuth(); }
    S.view = S.me.owner ? 'platform' : 'compose';
    S.classes = await api('/classes');
    await refreshCounts();
    renderShell();
  }
  async function refreshCounts() {
    const d = await api('/messages?group=' + S.group);
    S.msgs = d.messages; S.counts = d.counts;
  }
  const roleLabel = (r) => (r === 'admin' ? 'Administrator' : 'Teacher');
  const NAV = [['compose', 'Compose'], ['messages', 'Messages'], ['history', 'History'], ['parents', 'Parents'], ['settings', 'Settings']];
  const navItems = () => (S.me && S.me.owner ? [['platform', 'Platform'], ...NAV] : NAV);
  function renderShell() {
    const m = S.me;
    root.innerHTML = `<div class="shell"><nav class="rail">
      <div class="brand">${esc(m.school.name)}<small>Parent Communication Bot</small></div>
      ${navItems().map(([id, label]) => `<button class="nav ${S.view === id ? 'active' : ''}" data-a="nav" data-v="${id}">${label}${id === 'messages' && S.counts.draft ? `<span class="badge">${S.counts.draft}</span>` : ''}</button>`).join('')}
      <div class="who">${esc(m.user.name)}<br><span style="color:#cfe0da;font-size:12px">${roleLabel(m.user.role)}</span><br><button class="link" style="color:#9db8b0" data-a="logout">Sign out</button></div>
    </nav><main id="view"></main></div>`;
    renderView();
  }
  function renderView() {
    ({ platform: viewPlatform, compose: viewCompose, messages: viewMessages, history: viewHistory, parents: viewParents, settings: viewSettings })[S.view]();
  }
  const setView = (v) => { S.view = v; clearInterval(S.poll); renderShell(); };

  // ---------- compose
  const HINTS = {
    absence: 'Optional. Leave blank to use the standard absence message.',
    late: 'Optional. Leave blank to use the standard late-arrival message.',
    progress: 'e.g. End of week 5. We covered fractions and comprehension. Keep encouraging reading at home.',
    commendation: 'e.g. won first place in the inter-house spelling bee on Friday',
    concern: 'e.g. has been unsettled in class this week and we would like to understand how we can help',
    fees: 'e.g. Second-term balance is N85,000, due Friday 17 October. Pay to the school account or at the bursar\'s office.',
    event: 'e.g. PTA meeting on Saturday 11 October at 10am in the school hall. Please arrive by 9:45am.',
    announcement: 'e.g. School closes for mid-term break on Thursday 23 October and resumes Monday 3 November.',
  };
  function viewCompose() {
    const { kinds, tones, languages, school } = S.me;
    const pickedAll = S.picked.has('*');
    $('#view').innerHTML = `
      <div class="head"><div><h1>Compose</h1><p class="muted">Pick who to message and what to say. The AI drafts one message per parent, and nothing is sent until you review it.</p></div></div>
      <div class="card"><div class="grid">
        <label>Message type<select id="kind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label>Tone<select id="tone">${Object.entries(tones).map(([k, v]) => `<option value="${k}" ${school.default_tone === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>Language<select id="language">${languages.map((l) => `<option ${school.default_language === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div></div>
      <div class="card"><h3>Send to</h3>
        ${S.classes.length ? `<div class="chips" style="margin-top:10px">
          <button class="chip ${pickedAll ? 'on' : ''}" data-a="pick" data-c="*">Whole school (${S.classes.reduce((n, c) => n + reach(c), 0)})</button>
          ${S.classes.map((c) => `<button class="chip ${S.picked.has(c.name) ? 'on' : ''}" data-a="pick" data-c="${esc(c.name)}">${esc(c.name || 'No class')} (${reach(c)})</button>`).join('')}
        </div>` : `<p class="muted">No parents yet. <button class="link" data-a="nav" data-v="parents">Add or import parents</button> first.</p>`}
      </div>
      <div class="card">
        <label>Key facts<textarea id="facts" placeholder=""></textarea></label>
        <p class="small muted" id="hint" style="margin:6px 0 0"></p>
        <div id="notesBox" style="margin-top:14px;display:none"><label>Note per child (optional)<textarea id="notes" placeholder="Adaeze Okafor: excellent in maths, needs more reading practice&#10;Tunde: improving in English"></textarea></label>
        <p class="small muted" style="margin:6px 0 0">One child per line as <code>Name: note</code>. Use the full name, admission number, or first name if unique.</p></div>
      </div>
      <button class="btn" data-a="draft" id="draftBtn">Draft messages</button>`;
    const sync = () => {
      const k = $('#kind').value;
      $('#facts').placeholder = HINTS[k]; $('#hint').textContent = HINTS[k];
      $('#notesBox').style.display = k === 'progress' ? 'block' : 'none';
    };
    $('#kind').addEventListener('change', sync); sync();
  }
  const draft = guard(async () => {
    const btn = $('#draftBtn'); btn.disabled = true; btn.textContent = 'Drafting…';
    try {
      const d = await api('/drafts', { method: 'POST', body: {
        kind: $('#kind').value, tone: $('#tone').value, language: $('#language').value,
        facts: $('#facts').value, notesText: $('#notes')?.value || '',
        classes: [...S.picked],
      } });
      toast(`${d.count} drafts ready${d.aiDrafted < d.count ? ` (${d.count - d.aiDrafted} from templates)` : ''}. Review before sending.${d.noConsent ? ` ${d.noConsent} left out: no consent recorded.` : ''}`);
      S.group = 'draft'; await refreshCounts(); setView('messages');
    } finally { btn.disabled = false; btn.textContent = 'Draft messages'; }
  });

  // ---------- messages
  function smsInfo(text) {
    const gsm = /^[\x20-\x7E\r\n£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
    const n = [...text].length, single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
    return { n, seg: n <= single ? 1 : Math.ceil(n / multi), gsm };
  }
  const counter = (m, text) => {
    if (m.channel === 'sms') { const i = smsInfo(text); return `${i.n} characters · ${i.seg} SMS${i.seg > 1 ? 's' : ''}${i.gsm ? '' : ' · special characters, costs more'}`; }
    return `${[...text].length} characters`;
  };
  function viewMessages() {
    const g = S.group, c = S.counts;
    const isDraft = g === 'draft', isSched = g === 'scheduled';
    $('#view').innerHTML = `
      <div class="head"><div><h1>Messages</h1><p class="muted">Edit any message, then send. Parents who opted out are skipped automatically.</p></div>
        ${isDraft && S.msgs.length ? `<div class="row"><label class="check"><input type="checkbox" id="all" checked data-a="toggle-all"> Select all</label><button class="btn" data-a="send">Send selected</button><button class="btn ghost" data-a="sched-open">Send later</button></div>` : ''}
        ${isSched && S.msgs.length ? `<div class="row"><label class="check"><input type="checkbox" id="all" checked data-a="toggle-all"> Select all</label><button class="btn ghost" data-a="unschedule">Cancel schedule</button></div>` : ''}
      </div>
      ${isDraft && S.msgs.length ? `<div class="card" id="schedPanel" hidden><h3>Send later</h3>
        <p class="small muted" style="margin:6px 0 10px">Choose when the selected messages should go out. Times are Nigerian time. Opt-outs, consent and your daily limit are checked again at that moment.</p>
        <div class="row"><label>Date and time<input type="datetime-local" id="schedAt" value="${schedDefault()}" min="${watNow()}"></label><button class="btn" data-a="sched-go">Schedule selected</button></div></div>` : ''}
      <div class="chips" style="margin-bottom:14px">
        ${[['draft', 'Drafts'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['failed', 'Needs attention']].map(([id, l]) => `<button class="chip ${g === id ? 'on' : ''}" data-a="group" data-g="${id}">${l} (${c[id] || 0})</button>`).join('')}
      </div>
      ${S.msgs.length ? S.msgs.map((m) => `<div class="msg" data-id="${m.id}">
        <header>${isDraft || isSched || g === 'failed' ? `<input type="checkbox" class="pick" style="width:auto" ${isDraft || isSched ? 'checked' : ''} aria-label="Select message">` : ''}
          <span class="who">${esc(m.parent_name || 'Parent')} <span class="muted" style="font-weight:400">for ${esc(m.student_name || '')}${m.class_name ? ', ' + esc(m.class_name) : ''}</span></span>
          <span class="pill ${m.channel === 'sms' ? 'sms' : 'wa'}">${m.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>
          ${!isDraft ? `<span class="pill ${m.status === 'scheduled' ? 'queued' : m.status}">${m.status === 'scheduled' ? 'Sends ' + esc(String(m.scheduled_wat).slice(0, 16)) : m.status}</span>` : ''}
          ${m.ai ? '<span class="pill">AI draft</span>' : ''}
          <span class="spacer"></span><span class="small muted">+${esc(m.phone)}</span></header>
        ${isDraft || g === 'failed' ? `<textarea>${esc(m.body)}</textarea>` : `<div style="white-space:pre-wrap">${esc(m.body)}</div>`}
        ${m.error ? `<div class="${m.status === 'failed' || m.status === 'skipped' ? 'err' : 'small muted'}" style="margin-top:6px">${esc(m.error)}</div>` : ''}
        <footer>${isDraft || g === 'failed' ? `<span class="small muted count">${counter(m, m.body)}</span><span class="spacer"></span>
          ${g === 'failed' && m.status === 'failed' ? `<button class="btn ghost" data-a="retry">Retry</button>` : ''}
          <button class="btn danger" data-a="discard">Discard</button>` : isSched ? `<span class="spacer"></span><button class="btn ghost" data-a="unschedule-one">Cancel schedule</button>` : `<span class="small muted">${esc(m.sent_at || '')}</span>`}</footer></div>`).join('')
      : `<div class="card empty">${isDraft ? 'No drafts waiting. Start from Compose.' : isSched ? 'Nothing is scheduled.' : g === 'sent' ? 'Nothing sent yet.' : 'Nothing needs attention.'}</div>`}`;
    clearInterval(S.poll);
    if (g === 'sent' && S.msgs.some((m) => m.status === 'queued' || m.status === 'sent')) {
      S.poll = setInterval(async () => { await refreshCounts(); if (S.view === 'messages' && S.group === 'sent') viewMessages(); else clearInterval(S.poll); }, 4000);
    }
  }
  const selectedIds = () => [...document.querySelectorAll('.msg')].filter((el) => $('.pick', el)?.checked).map((el) => +el.dataset.id);
  const send = guard(async (ids) => {
    ids = ids || selectedIds();
    if (!ids.length) return toast('Select at least one message', true);
    if (!confirm(`Send ${ids.length} message${ids.length > 1 ? 's' : ''} to parents now?`)) return;
    const r = await api('/messages/send', { method: 'POST', body: { ids } });
    toast(r.heldBack ? `Sending ${r.queued}. ${r.heldBack} held back by the daily limit of ${r.dailyLimit}.` : `Sending ${r.queued} message${r.queued > 1 ? 's' : ''}…`, !!r.heldBack);
    S.group = 'sent'; await refreshCounts(); setView('messages');
  });

  // ---------- parents
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    const push = () => { row.push(cur); cur = ''; };
    const endRow = () => { push(); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') push();
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
      else cur += c;
    }
    endRow();
    return rows;
  }
  const ALIAS = { student_name: ['student_name', 'student', 'pupil', 'name', 'child'], class_name: ['class_name', 'class', 'grade'], parent_name: ['parent_name', 'parent', 'guardian', 'guardian_name'], phone: ['phone', 'phone_number', 'mobile', 'whatsapp', 'tel'], admission_no: ['admission_no', 'admission_number', 'reg_no', 'admission'], channel: ['channel', 'preferred_channel'], consent: ['consent', 'consent_given', 'agreed'] };
  function csvToRows(text) {
    const [head, ...body] = parseCSV(text);
    const idx = {};
    head.forEach((h, i) => { const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_'); for (const [f, al] of Object.entries(ALIAS)) if (al.includes(k) && idx[f] === undefined) idx[f] = i; });
    return body.map((r) => Object.fromEntries(Object.entries(idx).map(([f, i]) => [f, (r[i] || '').trim()])));
  }
  // ---------- send later (scheduled sending). Times are Nigerian time (UTC+1), whatever the browser's own time zone is.
  const watNow = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 16);
  const schedDefault = () => { const t = new Date(Date.now() + 3600e3); t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(7, 0, 0, 0); return t.toISOString().slice(0, 16); };
  const schedule = guard(async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('Select at least one message', true);
    const at = $('#schedAt').value;
    if (!at) return toast('Choose a date and time', true);
    const r = await api('/messages/schedule', { method: 'POST', body: { ids, at } });
    toast(`${r.scheduled} message${r.scheduled === 1 ? '' : 's'} scheduled for ${r.at_wat} (Nigerian time)`);
    S.group = 'scheduled'; await refreshCounts(); setView('messages');
  });
  const unschedule = guard(async (ids) => {
    if (!ids.length) return toast('Select at least one message', true);
    const r = await api('/messages/unschedule', { method: 'POST', body: { ids } });
    toast(`${r.cancelled} message${r.cancelled === 1 ? '' : 's'} back in Drafts`);
    S.group = 'draft'; await refreshCounts(); setView('messages');
  });

  // ---------- history, export and monthly summary
  const STATUS_LABEL = { sent: 'Sent', delivered: 'Delivered', read: 'Read', queued: 'Sending', failed: 'Failed', skipped: 'Held back', draft: 'Draft', scheduled: 'Scheduled' };
  const prettyPhone = (p) => (/^234\d{10}$/.test(p) ? `+234 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : '+' + p);
  const histQuery = (f, extra = {}) => new URLSearchParams(Object.entries({ q: f.q, status: f.status, kind: f.kind, from: f.from, to: f.to, ...extra }).filter(([, v]) => v !== '' && v != null)).toString();
  const histRows = (rows) => rows.map((m) => `<tr><td class="small" style="white-space:nowrap">${esc(String(m.at).slice(0, 16))}</td>
      <td>${esc(m.parent_name || 'Parent')}<div class="small muted">${esc(m.student_name || '')}${m.class_name ? ', ' + esc(m.class_name) : ''}</div></td>
      <td class="small">${esc(S.me.kinds[m.kind] || '')}</td>
      <td><span class="pill ${m.channel === 'sms' ? 'sms' : 'wa'}">${m.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span></td>
      <td><span class="pill ${m.status === 'scheduled' ? 'queued' : m.status}">${STATUS_LABEL[m.status] || esc(m.status)}</span></td>
      <td><div class="small" title="${esc(m.body)}">${esc(m.body.length > 120 ? m.body.slice(0, 120) + '…' : m.body)}</div>${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}</td></tr>`).join('');
  const histBreakdown = (title, list) => `<div><h3>${title}</h3>${list.length ? `<div class="tablewrap"><table><thead><tr><th></th><th>Sent</th><th>Failed</th><th>Held back</th><th>Drafts</th><th>Scheduled</th></tr></thead><tbody>
      ${list.map((e) => `<tr><td>${esc(e.label)}</td><td>${e.sent}</td><td>${e.failed}</td><td>${e.skipped}</td><td>${e.draft}</td><td>${e.scheduled}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No messages in this month.</p>'}</div>`;
  function renderHistory() {
    const h = S.hist, f = h.applied, t = h.sum.totals;
    const sel = (cur, v, l) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
    const tile = (label, n) => `<div class="card" style="margin:0"><div class="small muted">${label}</div><div style="font:700 28px var(--head)">${n}</div></div>`;
    $('#view').innerHTML = `
      <div class="head"><div><h1>History</h1><p class="muted">Every message the bot has drafted, sent or held back. Times are Nigerian time.</p></div>
        <button class="btn" data-a="hist-csv">Download CSV</button></div>
      <div class="card"><div class="row"><h3>Summary for</h3><input type="month" id="histMonth" value="${esc(h.month)}" style="max-width:190px"></div>
        <div class="grid" style="margin-top:12px">${tile('Sent', t.sent)}${tile('Failed', t.failed)}${tile('Held back', t.skipped)}${tile('Drafts waiting', t.draft)}${tile('Scheduled', t.scheduled)}</div>
        <p class="small muted" style="margin:10px 0 14px">${t.whatsapp} by WhatsApp, ${t.sms} by SMS. ${t.delivered} confirmed delivered (WhatsApp, and SMS once delivery reports are connected in Settings). Held back means the parent opted out or has no consent recorded.</p>
        <div class="grid">${histBreakdown('By type', h.sum.by_kind)}${histBreakdown('By class', h.sum.by_class)}</div></div>
      <div class="card"><div class="grid">
        <label>Search<input id="hq" value="${esc(f.q)}" placeholder="Parent, student, class or phone"></label>
        <label>Status<select id="hstatus">${sel(f.status, '', 'All')}${sel(f.status, 'sent', 'Sent')}${sel(f.status, 'failed', 'Failed')}${sel(f.status, 'skipped', 'Held back')}${sel(f.status, 'draft', 'Drafts')}${sel(f.status, 'scheduled', 'Scheduled')}</select></label>
        <label>Type<select id="hkind">${sel(f.kind, '', 'All types')}${Object.entries(S.me.kinds).map(([k, v]) => sel(f.kind, k, esc(v))).join('')}</select></label>
        <label>From<input type="date" id="hfrom" value="${esc(f.from)}"></label><label>To<input type="date" id="hto" value="${esc(f.to)}"></label>
        <div style="align-self:end"><button class="btn" data-a="hist-apply">Show</button></div></div></div>
      <p class="small muted">${h.total} message${h.total === 1 ? '' : 's'} match${h.total === 1 ? 'es' : ''}.</p>
      ${h.rows.length ? `<div class="card tablewrap" style="padding:6px 12px"><table><thead><tr><th>When</th><th>Parent</th><th>Type</th><th>Channel</th><th>Status</th><th>Message</th></tr></thead><tbody>${histRows(h.rows)}</tbody></table></div>
        ${h.rows.length < h.total ? '<button class="btn ghost" data-a="hist-more">Show more</button>' : ''}` : '<div class="card empty">No messages match.</div>'}`;
  }
  async function viewHistory() {
    try {
      const h = (S.hist = S.hist || { month: todayLocal().slice(0, 7), applied: { q: '', status: '', kind: '', from: '', to: '' }, rows: [], total: 0, sum: null });
      const [sum, list] = await Promise.all([api('/messages/summary?month=' + h.month), api('/messages/history?' + histQuery(h.applied, { limit: 100, offset: 0 }))]);
      h.sum = sum; h.rows = list.rows; h.total = list.total;
      renderHistory();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- platform console (owner account only): counts, never content
  async function viewPlatform() {
    try {
      S.plat = S.plat || { month: '' };
      const d = await api('/platform/overview' + (S.plat.month ? '?month=' + S.plat.month : ''));
      S.plat.month = d.month;
      const t = d.totals;
      const tile = (label, n) => `<div class="card" style="margin:0"><div class="small muted">${label}</div><div style="font:700 28px var(--head)">${n}</div></div>`;
      const body = d.schools.map((s) => `<tr>
        <td><strong>${esc(s.name)}</strong>${s.is_yours ? ' <span class="pill">Your account</span>' : ''}
          <div class="small muted">Joined ${esc(String(s.created_at).slice(0, 10))}</div>
          <div class="small">${s.admins.length ? s.admins.map((x) => `${esc(x.name)} <span class="muted">${esc(x.email)}</span>`).join('<br>') : '<span class="muted">No administrator</span>'}</div></td>
        <td>${s.teachers}</td>
        <td>${s.parents}<div class="small muted">${s.consented} with consent</div></td>
        <td>${s.sent}<div class="small muted">${s.whatsapp} WhatsApp · ${s.sms} SMS</div></td>
        <td>${s.failed}</td><td>${s.skipped}</td>
        <td class="small" style="white-space:nowrap">${s.last_message ? esc(String(s.last_message).slice(0, 16)) : '<span class="muted">No messages yet</span>'}</td>
        <td class="small">SMS ID: ${esc(s.sender_id)}<br>School Management: ${s.sm_connected ? 'connected' : 'not connected'}${s.require_consent ? '<br>Consent required' : ''}${s.auto_send_absence ? '<br>Auto-send absence alerts' : ''}</td></tr>`).join('');
      const welcomeCard = S.welcome ? `<div class="card"><h3>${esc(S.welcome.title || 'School created: ' + S.welcome.school.name)}</h3>
        <p class="small muted" style="margin:6px 0 10px">${esc(S.welcome.note || 'Send this message to the administrator. The temporary password is shown only here, so copy the message now.')}</p>
        <textarea id="welcomeText" readonly style="min-height:240px">${esc(S.welcome.welcome)}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn" data-a="copy-welcome">Copy message</button>
          <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(S.welcome.welcome)}" target="_blank" rel="noopener">Send on WhatsApp</a>
          <span class="spacer"></span><button class="btn ghost" data-a="close-welcome">Done</button></div></div>` : '';
      const addCard = `<div class="card"><h3>Add a school</h3>
        <p class="small muted" style="margin:6px 0 10px">Creates the school and its administrator. You then get a welcome message to send them. Leave the password empty and I will make a temporary one.</p>
        <div class="grid"><label>School name<input id="newSchoolName" maxlength="120"></label><label>Administrator’s name<input id="newAdminName" maxlength="120"></label>
          <label>Administrator’s email<input id="newAdminEmail" type="email" placeholder="admin@school.com"></label><label>Temporary password (optional)<input id="newAdminPw" autocomplete="off"></label>
          <div style="align-self:end"><button class="btn" data-a="add-school">Add school</button></div></div></div>`;
      const adminCard = `<div class="card"><h3>Account tools</h3>
        <p class="small muted" style="margin:6px 0 10px">Type the exact email of any school administrator or teacher to change their email, or to give them a new temporary password. Your own account cannot be changed here. To move or delete a teacher, use Fix a teacher account below.</p>
        <div class="row"><input id="admEmail" type="email" placeholder="name@school.com" style="max-width:340px"><button class="btn" data-a="adm-find">Find</button></div><div id="admResult"></div></div>`;
      S.fix = null; S.adm = null;
      const fixCard = `<div class="card"><h3>Fix a teacher account</h3>
        <p class="small muted" style="margin:6px 0 10px">Type the exact email of a teacher account to move it to another school, or to delete it. Administrator accounts cannot be changed here.</p>
        <div class="row"><input id="fixEmail" type="email" placeholder="teacher@example.com" style="max-width:340px"><button class="btn" data-a="fix-find">Find</button></div><div id="fixResult"></div></div>`;
      const actionsCard = `<div class="card"><h3>Recent account changes</h3>${d.actions && d.actions.length ? `<table><tbody>${d.actions.map((x) => `<tr><td class="small" style="white-space:nowrap">${esc(String(x.at).slice(0, 16))}</td><td>${x.action === 'school_added' ? `Added school <strong>${esc(x.detail || '')}</strong>, administrator <strong>${esc(x.target_name)}</strong> <span class="muted">${esc(x.target_email)}</span>` : x.action === 'email_changed' ? `Changed the email of <strong>${esc(x.target_name)}</strong> ${esc(x.detail || '')}` : x.action === 'password_reset' ? `Gave <strong>${esc(x.target_name)}</strong> <span class="muted">${esc(x.target_email)}</span> a new temporary password` : `${x.action === 'removed' ? 'Removed' : 'Moved'} <strong>${esc(x.target_name)}</strong> <span class="muted">${esc(x.target_email)}</span>${x.action === 'removed' ? ` from ${esc(x.school_name || 'a school')}` : ` ${esc(x.detail || '')}`}`}</td><td class="small muted">by ${esc(x.actor_name)}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted" style="margin:6px 0 0">No changes yet.</p>'}</div>`;
      $('#view').innerHTML = `
        <div class="head"><div><h1>Platform</h1><p class="muted">How every school uses the bot. It shows counts only, never parents’ names, phone numbers or message text.</p></div>
          <label>Month<input type="month" id="platMonth" value="${esc(d.month)}" style="max-width:190px"></label></div>
        ${welcomeCard}
        <div class="grid" style="margin-bottom:12px">${tile('Schools', t.schools)}${tile('Parents', t.parents)}${tile('Sent this month', t.sent)}${tile('Failed', t.failed)}${tile('Held back', t.skipped)}</div>
        <p class="small muted" style="margin:0 0 14px">${t.whatsapp} by WhatsApp, ${t.sms} by SMS, ${t.delivered} confirmed delivered. Right now ${t.drafts} drafts and ${t.scheduled} scheduled messages are waiting across all accounts. Sent, Failed and Held back are for the month chosen (Nigerian time).</p>
        ${d.schools.length ? `<div class="card tablewrap" style="padding:6px 12px"><table><thead><tr><th>School and administrators</th><th>Teachers</th><th>Parents</th><th>Sent</th><th>Failed</th><th>Held back</th><th>Last message</th><th>Settings</th></tr></thead><tbody>${body}</tbody></table></div>` : '<div class="card empty">No schools yet.</div>'}${addCard}${adminCard}${fixCard}${actionsCard}`;
    } catch (e) { toast(e.message, true); }
  }

  function renderAdm() {
    const box = $('#admResult'), r = S.adm;
    if (!box || !r) return;
    if (!r.found) { box.innerHTML = '<p class="err" style="margin-top:10px">No account has that email.</p>'; return; }
    const u = r.user;
    if (r.is_you) { box.innerHTML = '<p style="margin-top:12px">This is your own account. It cannot be changed here.</p>'; return; }
    box.innerHTML = `<p style="margin-top:12px"><strong>${esc(u.name)}</strong> <span class="muted">${esc(u.email)}</span><br>${u.role === 'admin' ? 'Administrator' : 'Teacher'} at <strong>${esc(u.school_name)}</strong></p>
      <div class="row"><label>New email<input id="admNewEmail" type="email" placeholder="name@school.com"></label><button class="btn" data-a="adm-email" style="align-self:end">Change email</button>
        <span class="spacer"></span><button class="btn ghost" data-a="adm-password" style="align-self:end">New temporary password</button></div>`;
  }
  function renderFix() {
    const box = $('#fixResult'), r = S.fix;
    if (!box || !r) return;
    if (!r.found) { box.innerHTML = '<p class="err" style="margin-top:10px">No account has that email.</p>'; return; }
    const u = r.user;
    if (!r.can_change) { box.innerHTML = `<p style="margin-top:12px"><strong>${esc(u.name)}</strong> <span class="muted">${esc(u.email)}</span> is an <strong>Administrator</strong> at ${esc(u.school_name)}. Administrator accounts cannot be changed here.</p>`; return; }
    box.innerHTML = `<p style="margin-top:12px"><strong>${esc(u.name)}</strong> <span class="muted">${esc(u.email)}</span><br>Teacher at <strong>${esc(u.school_name)}</strong></p>
      <div class="row"><label>Move to<select id="fixTo">${r.schools.filter((s) => s.id !== u.school_id).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        <button class="btn" data-a="fix-move" style="align-self:end">Move teacher</button><span class="spacer"></span><button class="btn danger" data-a="fix-remove" style="align-self:end">Delete account</button></div>`;
  }

  // ---------- consent record
  const reach = (c) => (S.me.school.require_consent ? c.consented : c.reachable);
  const CONSENT_OPTS = [['admission_form', 'Admission form'], ['verbal', 'Verbal'], ['other', 'Other']];
  const consentOptions = (sel) => `<option value="">Not recorded</option>${CONSENT_OPTS.map(([v, l]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`).join('')}${sel === 'imported' ? '<option value="imported" selected>Imported list</option>' : ''}`;
  const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  async function viewParents(q = '') {
    S.contacts = await api('/contacts?q=' + encodeURIComponent(q));
    S.classes = await api('/classes');
    const totalParents = S.classes.reduce((n, c) => n + c.total, 0), withConsent = S.classes.reduce((n, c) => n + (c.with_consent || 0), 0);
    $('#view').innerHTML = `
      <div class="head"><div><h1>Parents</h1><p class="muted">One row per child and parent/guardian. Numbers like 0803… are converted to +234 automatically.</p></div></div>
      <div class="card"><h3>Add a parent</h3>
        <form id="addForm" class="grid" style="margin-top:12px">
          <label>Student name<input name="student_name" required></label><label>Class<input name="class_name" placeholder="JSS 1A"></label>
          <label>Parent name<input name="parent_name" placeholder="Mrs Okafor"></label><label>Phone<input name="phone" required placeholder="0803 123 4567"></label>
          <label>Admission no.<input name="admission_no"></label>
          <label>Consent<select name="consent">${consentOptions("")}</select></label>
          <label>Send by<select name="channel"><option value="whatsapp">WhatsApp (SMS if it fails)</option><option value="sms">SMS only</option></select></label>
          <div style="align-self:end"><button class="btn" type="submit">Add parent</button></div></form></div>
      <div class="card"><h3>Import from CSV</h3>
        <p class="small muted">Columns: student_name, class, parent_name, phone, admission_no, channel, consent (yes or no, optional). <button class="link" data-a="template">Download a template</button></p>
        <input type="file" id="csv" accept=".csv,text/csv"></div>
      <div class="card"><h3>Parent consent</h3>
        <p class="small muted" style="margin:6px 0 10px">Consent is recorded for <b>${withConsent}</b> of <b>${totalParents}</b> parents. Note where each parent agreed to receive messages (admission form or verbal). ${S.me.school.require_consent ? 'Messages are only sent to parents with consent recorded.' : 'You can make consent required in Settings.'}</p>
        ${S.me.user.role === 'admin' ? `<div class="grid"><label>Class<select id="bkClass"><option value="*">All classes</option>${S.classes.map((c) => `<option value="${esc(c.name)}">${esc(c.name || 'No class')}</option>`).join('')}</select></label>
          <label>Consent came from<select id="bkSource">${CONSENT_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label>Date<input type="date" id="bkDate" value="${todayLocal()}" max="${todayLocal()}"></label>
          <div style="align-self:end"><button class="btn" data-a="bulkconsent">Mark consent obtained</button></div></div>
        <p class="small muted" style="margin:8px 0 0">Only parents with no record yet are updated. Use this only when the school really holds those parents' consent.</p>` : ''}</div>
      <div class="row" style="margin-bottom:10px"><input id="q" placeholder="Search name, class, phone…" value="${esc(q)}" style="max-width:320px"><span class="muted small">${S.contacts.length} shown</span></div>
      ${S.contacts.length ? `<div class="card tablewrap" style="padding:6px 12px"><table><thead><tr><th>Student</th><th>Class</th><th>Parent</th><th>Phone</th><th>Channel</th><th>Consent</th><th></th></tr></thead><tbody>
        ${S.contacts.map((c) => `<tr data-id="${c.id}"><td>${esc(c.student_name)}<div class="small muted">${esc(c.admission_no)}</div></td><td>${esc(c.class_name)}</td><td>${esc(c.parent_name)}</td><td>+${esc(c.phone)}</td>
          <td><span class="pill ${c.channel === 'sms' ? 'sms' : 'wa'}">${c.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>${c.opted_out ? ' <span class="pill failed">opted out</span>' : ''}</td>
          <td><select class="consent-sel" aria-label="Consent">${consentOptions(c.consent_source || '')}</select>${c.consent_at ? `<div class="small muted">${esc(c.consent_at)}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn ghost" data-a="optout">${c.opted_out ? 'Opt in' : 'Opt out'}</button> <button class="btn danger" data-a="delcontact">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : `<div class="card empty">No parents found.</div>`}`;
    $('#addForm').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      await api('/contacts', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Parent added'); S.classes = await api('/classes'); viewParents();
    }));
    $('#csv').addEventListener('change', guard(async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = csvToRows(await f.text());
      const r = await api('/contacts/import', { method: 'POST', body: { rows } });
      toast(`${r.added} added, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped (row ${r.skipped[0].row}: ${r.skipped[0].reason})` : ''}`, !!r.skipped.length);
      S.classes = await api('/classes'); viewParents();
    }));
    let t; $('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => viewParents(e.target.value), 300); });
    if (q) { const el = $('#q'); el.focus(); el.setSelectionRange(q.length, q.length); }
  }

  // ---------- settings
  async function viewSettings() {
    const { school, user, providers, origin } = S.me;
    const admin = user.role === 'admin';
    const users = admin ? await api('/users') : [];
    const smsHook = admin ? await api('/sms-webhook').catch(() => null) : null;
    const staffMsg = S.staffMsg ? `<div style="border:1px solid #d8ddd4;border-radius:10px;padding:12px;margin:8px 0 14px"><strong>${esc(S.staffMsg.title)}</strong>
        <p class="small muted" style="margin:4px 0 8px">${esc(S.staffMsg.note)}</p>
        <textarea id="staffMsgText" readonly style="min-height:200px">${esc(S.staffMsg.text)}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn" data-a="copy-staffmsg">Copy message</button>
          <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(S.staffMsg.text)}" target="_blank" rel="noopener">Send on WhatsApp</a>
          <span class="spacer"></span><button class="btn ghost" data-a="close-staffmsg">Done</button></div></div>` : '';
    const pv = (v) => (v === true || v === 'live' ? '<span class="pill sent">live</span>' : '<span class="pill queued">' + (v === false ? 'templates only' : 'dry-run') + '</span>');
    $('#view').innerHTML = `
      <div class="head"><div><h1>Settings</h1></div></div>
      <div class="card"><h3>Connections</h3>
        <p style="margin:10px 0 4px">AI drafting ${pv(providers.ai)} &nbsp; SMS (Termii) ${pv(providers.sms)} &nbsp; WhatsApp ${pv(providers.whatsapp)}</p>
        <p class="small muted" style="margin:0">Dry-run means messages are logged on the server but not delivered. Add the API keys in the server environment to go live.</p></div>
      ${smsHook ? `<div class="card"><h3>SMS delivery reports</h3>
        <p class="small muted" style="margin:6px 0 10px">So that SMS messages change from Sent to Delivered (or Failed, with the reason), tell Termii where to send its delivery reports: in your Termii account, open the webhook settings and paste this address. Keep it private.</p>
        <p><code id="smsHookUrl">${esc(smsHook.url)}</code></p>
        <button class="btn ghost" data-a="copyhook">Copy address</button></div>` : ''}
      ${admin ? `<div class="card"><h3>School</h3><form id="schoolForm" class="grid" style="margin-top:12px">
        <label>School name<input name="name" value="${esc(school.name)}" required></label>
        <label>SMS sender ID (max 11 letters/numbers)<input name="sender_id" value="${esc(school.sender_id)}" maxlength="11"></label>
        <label>Sign-off on messages<input name="signature" value="${esc(school.signature)}"></label>
        <label>Default tone<select name="default_tone">${Object.entries(S.me.tones).map(([k, v]) => `<option value="${k}" ${school.default_tone === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>Default language<select name="default_language">${S.me.languages.map((l) => `<option ${school.default_language === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="auto_send_absence" ${school.auto_send_absence ? 'checked' : ''}> Send absence alerts automatically (no review)</label>
        <label class="check" style="align-self:end"><input type="checkbox" name="require_consent" ${school.require_consent ? 'checked' : ''}> Only send to parents with consent recorded</label>
        <div><button class="btn" type="submit">Save settings</button></div></form></div>
      <div class="card"><h3>Class Register connection</h3>
        <p class="small muted" style="margin:6px 0 10px">Your Class Register calls this address when a pupil is marked absent (A) or late (L). A drafted alert then appears in Messages, or is sent straight away if auto-send is on.</p>
        <p>Endpoint: <code>${esc(origin)}/api/hooks/absence</code></p>
        <p>API key: <code id="key">${esc(school.api_key)}</code> <button class="btn ghost" data-a="rotate">Generate new key</button></p></div>
      <div class="card"><h3>Staff accounts</h3>${staffMsg}
        <table><tbody>${users.map((u) => { const d = `data-uid="${u.id}" data-name="${esc(u.name)}" data-email="${esc(u.email)}"`; return `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><span class="pill">${roleLabel(u.role)}</span></td><td>${u.role === 'staff' ? `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap"><button class="btn ghost" data-a="staff-email" ${d}>Change email</button><button class="btn ghost" data-a="staff-pw" ${d}>New password</button><button class="btn danger" data-a="rm-teacher" ${d}>Remove</button></div>` : ''}</td></tr>`; }).join('')}</tbody></table>
        <form id="staffForm" class="grid" style="margin-top:12px"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>${pwField('Temporary password', 'new-password')}<div style="align-self:end"><button class="btn" type="submit">Add teacher</button></div></form></div>` : `<div class="card muted">Only school admins can change settings.</div>`}`;
    $('#schoolForm')?.addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target)); b.auto_send_absence = !!b.auto_send_absence; b.require_consent = !!b.require_consent;
      await api('/school', { method: 'PUT', body: b }); S.me = await api('/me'); toast('Settings saved'); renderShell();
    }));
    $('#staffForm')?.addEventListener('submit', guard(async (e) => {
      e.preventDefault(); await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Teacher added'); viewSettings();
    }));
  }

  // ---------- events
  document.addEventListener('click', guard(async (e) => {
    const el = e.target.closest('[data-a]'); if (!el) return;
    const a = el.dataset.a, msgEl = el.closest('.msg'), rowEl = el.closest('tr');
    if (a === 'mode-register') renderAuth('register');
    else if (a === 'mode-login') renderAuth('login');
    else if (a === 'nav') { setView(el.dataset.v); }
    else if (a === 'togglepw') {
      const input = $('input', el.closest('.pw'));
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.innerHTML = show ? EYE_OFF : EYE;
      el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      el.setAttribute('aria-pressed', String(show));
      input.focus();
    }
    else if (a === 'logout') { await api('/auth/logout', { method: 'POST' }); S.me = null; renderAuth(); }
    else if (a === 'pick') {
      const c = el.dataset.c;
      if (c === '*') S.picked = new Set(['*']);
      else { S.picked.delete('*'); S.picked.has(c) ? S.picked.delete(c) : S.picked.add(c); if (!S.picked.size) S.picked.add('*'); }
      const keep = { k: $('#kind').value, t: $('#tone').value, l: $('#language').value, f: $('#facts').value, n: $('#notes')?.value };
      viewCompose(); $('#kind').value = keep.k; $('#tone').value = keep.t; $('#language').value = keep.l; $('#facts').value = keep.f; if ($('#notes')) $('#notes').value = keep.n || ''; $('#kind').dispatchEvent(new Event('change'));
    }
    else if (a === 'draft') await draft();
    else if (a === 'group') { S.group = el.dataset.g; await refreshCounts(); viewMessages(); }
    else if (a === 'toggle-all') document.querySelectorAll('.msg .pick').forEach((c) => (c.checked = el.checked));
    else if (a === 'send') await send();
    else if (a === 'retry') await send([+msgEl.dataset.id]);
    else if (a === 'sched-open') { const p = $('#schedPanel'); p.hidden = !p.hidden; }
    else if (a === 'sched-go') await schedule();
    else if (a === 'unschedule') await unschedule(selectedIds());
    else if (a === 'unschedule-one') await unschedule([+msgEl.dataset.id]);
    else if (a === 'discard') { await api('/messages/' + msgEl.dataset.id, { method: 'DELETE' }); await refreshCounts(); renderShell(); }
    else if (a === 'hist-apply') {
      S.hist.applied = { q: $('#hq').value.trim(), status: $('#hstatus').value, kind: $('#hkind').value, from: $('#hfrom').value, to: $('#hto').value };
      await viewHistory();
    }
    else if (a === 'hist-more') {
      const more = await api('/messages/history?' + histQuery(S.hist.applied, { limit: 100, offset: S.hist.rows.length }));
      S.hist.rows = S.hist.rows.concat(more.rows); S.hist.total = more.total; renderHistory();
    }
    else if (a === 'hist-csv') {
      const link = document.createElement('a'); link.href = '/api/messages/export.csv?' + histQuery(S.hist.applied); link.download = ''; link.click();
    }
    else if (a === 'add-school') {
      const body = { schoolName: $('#newSchoolName').value, adminName: $('#newAdminName').value, email: $('#newAdminEmail').value, password: $('#newAdminPw').value };
      if (!body.schoolName.trim() || !body.adminName.trim() || !body.email.trim()) return toast('Fill in the school name, the administrator’s name and email', true);
      S.welcome = await api('/platform/schools', { method: 'POST', body });
      toast(`School created: ${S.welcome.school.name}`); await viewPlatform();
    }
    else if (a === 'copy-welcome') {
      try { await navigator.clipboard.writeText(S.welcome.welcome); toast('Message copied'); }
      catch { $('#welcomeText').focus && $('#welcomeText').focus(); toast('Select the message and copy it (Ctrl + C)', true); }
    }
    else if (a === 'close-welcome') { S.welcome = null; await viewPlatform(); }
    else if (a === 'staff-email') {
      const mail = (prompt(`Type the new email address for ${el.dataset.name}.\nTheir email now: ${el.dataset.email}`, '') || '').trim();
      if (!mail) return;
      const r = await api('/users/' + el.dataset.uid + '/email', { method: 'POST', body: { email: mail } });
      S.staffMsg = { title: `Email changed: ${r.name}`, note: 'Send this message to the teacher so they know the new email address.', text: r.message };
      toast(`Email changed for ${r.name}`); viewSettings();
    }
    else if (a === 'staff-pw') {
      if (!confirm(`Give ${el.dataset.name} (${el.dataset.email}) a new temporary password? They will be signed out and must use the new password.`)) return;
      const r = await api('/users/' + el.dataset.uid + '/password', { method: 'POST', body: {} });
      S.staffMsg = { title: `New temporary password: ${r.name}`, note: 'Send this message to the teacher. The temporary password is shown only here, so copy the message now.', text: r.message };
      toast(`New temporary password for ${r.name}`); viewSettings();
    }
    else if (a === 'copy-staffmsg') {
      try { await navigator.clipboard.writeText(S.staffMsg.text); toast('Message copied'); }
      catch { toast('Select the message and copy it (Ctrl + C)', true); }
    }
    else if (a === 'close-staffmsg') { S.staffMsg = null; viewSettings(); }
    else if (a === 'adm-find') {
      const mail = $('#admEmail').value.trim();
      if (!mail) return toast('Type the email address of the account', true);
      S.adm = await api('/platform/teacher?email=' + encodeURIComponent(mail)); renderAdm();
    }
    else if (a === 'adm-email') {
      const u = S.adm.user, mail = $('#admNewEmail').value.trim();
      if (!mail) return toast('Type the new email address', true);
      if (!confirm(`Change the email of ${u.name} from ${u.email} to ${mail}? Their password stays the same. School Management’s Open button matches people by email, so tell the school.`)) return;
      const r = await api('/platform/admin/email', { method: 'POST', body: { id: u.id, email: mail } });
      S.welcome = { title: `Email changed: ${r.name}`, note: 'Send this message so they know the new email address.', welcome: r.message };
      toast(`Email changed for ${r.name}`); await viewPlatform();
    }
    else if (a === 'adm-password') {
      const u = S.adm.user;
      if (!confirm(`Give ${u.name} (${u.email}) a new temporary password? They will be signed out and must use the new password.`)) return;
      const r = await api('/platform/admin/password', { method: 'POST', body: { id: u.id } });
      S.welcome = { title: `New temporary password: ${r.name}`, welcome: r.message };
      toast(`New temporary password for ${r.name}`); await viewPlatform();
    }
    else if (a === 'rm-teacher') {
      if (!confirm(`Remove ${el.dataset.name} (${el.dataset.email})? They will no longer be able to sign in. Parents and messages are not affected.`)) return;
      await api('/users/' + el.dataset.uid, { method: 'DELETE' });
      toast('Teacher removed'); viewSettings();
    }
    else if (a === 'fix-find') {
      const mail = $('#fixEmail').value.trim();
      if (!mail) return toast('Type the email address of the account', true);
      S.fix = await api('/platform/teacher?email=' + encodeURIComponent(mail)); renderFix();
    }
    else if (a === 'fix-move') {
      const u = S.fix.user, sel = S.fix.schools.find((s) => String(s.id) === String($('#fixTo').value));
      if (!sel) return toast('Choose the school to move the teacher to', true);
      if (!confirm(`Move ${u.name} (${u.email}) from ${u.school_name} to ${sel.name}? Their password stays the same.`)) return;
      await api('/platform/teacher/move', { method: 'POST', body: { id: u.id, school_id: sel.id } });
      toast(`${u.name} moved to ${sel.name}`); await viewPlatform();
    }
    else if (a === 'fix-remove') {
      const u = S.fix.user;
      if (!confirm(`Delete the account of ${u.name} (${u.email}) from ${u.school_name}? This cannot be undone. Parents and messages are not affected.`)) return;
      await api('/platform/teacher/remove', { method: 'POST', body: { id: u.id } });
      toast(`${u.name} deleted`); await viewPlatform();
    }
    else if (a === 'copyhook') {
      try { await navigator.clipboard.writeText($('#smsHookUrl').textContent); toast('Address copied'); }
      catch { toast('Select the address and copy it (Ctrl + C)', true); }
    }
    else if (a === 'bulkconsent') {
      const cls = $('#bkClass').value, src = $('#bkSource').value, date = $('#bkDate').value;
      const who = cls === '*' ? 'ALL parents who have no consent record yet' : `parents in ${cls || 'No class'} who have no consent record yet`;
      if (!confirm(`Record consent for ${who}? Only do this if the school really holds their consent.`)) return;
      const r = await api('/contacts/consent', { method: 'POST', body: { class_name: cls, source: src, date } });
      toast(`Consent recorded for ${r.updated} parent${r.updated === 1 ? '' : 's'}`);
      viewParents();
    }
    else if (a === 'optout') { const c = S.contacts.find((x) => x.id === +rowEl.dataset.id); await api('/contacts/' + c.id, { method: 'PUT', body: { opted_out: c.opted_out ? 0 : 1 } }); viewParents($('#q').value); }
    else if (a === 'delcontact') { if (confirm('Delete this parent?')) { await api('/contacts/' + rowEl.dataset.id, { method: 'DELETE' }); S.classes = await api('/classes'); viewParents($('#q').value); } }
    else if (a === 'rotate') { if (confirm('The old key stops working immediately. Continue?')) { const r = await api('/school/rotate-key', { method: 'POST' }); S.me.school.api_key = r.api_key; $('#key').textContent = r.api_key; toast('New key generated. Update it in your Class Register.'); } }
    else if (a === 'template') {
      const blob = new Blob(['student_name,class,parent_name,phone,admission_no,channel,consent\nAdaeze Okafor,JSS 1A,Mrs Okafor,08031234567,SC/001,whatsapp,yes\n'], { type: 'text/csv' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'parents-template.csv'; link.click();
    }
  }));
  document.addEventListener('input', (e) => {
    const ta = e.target.closest('.msg textarea'); if (!ta) return;
    const m = S.msgs.find((x) => x.id === +ta.closest('.msg').dataset.id);
    $('.count', ta.closest('.msg')).textContent = counter(m, ta.value);
  });
  document.addEventListener('change', guard(async (e) => {
    if (e.target.closest('#platMonth')) { S.plat.month = e.target.value; await viewPlatform(); return; }
    if (e.target.closest('#histMonth')) {
      const v = e.target.value;
      if (/^\d{4}-\d{2}$/.test(v)) { S.hist.month = v; S.hist.sum = await api('/messages/summary?month=' + v); renderHistory(); }
      return;
    }
    const cs = e.target.closest('select.consent-sel');
    if (cs) {
      await api('/contacts/' + cs.closest('tr').dataset.id, { method: 'PUT', body: { consent_source: cs.value } });
      toast(cs.value ? 'Consent recorded' : 'Consent record cleared');
      viewParents($('#q').value);
      return;
    }
    const ta = e.target.closest('.msg textarea'); if (!ta) return;
    const id = +ta.closest('.msg').dataset.id;
    await api('/messages/' + id, { method: 'PUT', body: { body: ta.value } });
    const m = S.msgs.find((x) => x.id === id); if (m) { m.body = ta.value; m.ai = 0; }
    toast('Saved');
  }));

  window.PCB = { toast, me: () => S.me, goto: (v) => setView(v), refresh: async () => { S.classes = await api('/classes'); await refreshCounts(); renderShell(); }, showDrafts: async () => { S.group = 'draft'; S.classes = await api('/classes'); await refreshCounts(); setView('messages'); } }; /* SM-CONNECTION */
  boot();
})();
