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

  // ---------- auth
  function renderAuth(mode = 'login') {
    clearInterval(S.poll);
    root.innerHTML = `<div class="auth"><div class="auth-card">
      <h1>Parent Communication Bot</h1>
      <p class="muted">SmartClass AI. Draft, review and send updates to parents by WhatsApp or SMS.</p>
      <form id="authForm">
        ${mode === 'register' ? `<label>School name<input name="schoolName" required></label><label>Your name<input name="name" required></label>` : ''}
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></label>
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
    S.classes = await api('/classes');
    await refreshCounts();
    renderShell();
  }
  async function refreshCounts() {
    const d = await api('/messages?group=' + S.group);
    S.msgs = d.messages; S.counts = d.counts;
  }
  const NAV = [['compose', 'Compose'], ['messages', 'Messages'], ['parents', 'Parents'], ['settings', 'Settings']];
  function renderShell() {
    const m = S.me;
    root.innerHTML = `<div class="shell"><nav class="rail">
      <div class="brand">${esc(m.school.name)}<small>Parent Communication Bot</small></div>
      ${NAV.map(([id, label]) => `<button class="nav ${S.view === id ? 'active' : ''}" data-a="nav" data-v="${id}">${label}${id === 'messages' && S.counts.draft ? `<span class="badge">${S.counts.draft}</span>` : ''}</button>`).join('')}
      <div class="who">${esc(m.user.name)}<br><button class="link" style="color:#9db8b0" data-a="logout">Sign out</button></div>
    </nav><main id="view"></main></div>`;
    renderView();
  }
  function renderView() {
    ({ compose: viewCompose, messages: viewMessages, parents: viewParents, settings: viewSettings })[S.view]();
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
          <button class="chip ${pickedAll ? 'on' : ''}" data-a="pick" data-c="*">Whole school (${S.classes.reduce((n, c) => n + c.reachable, 0)})</button>
          ${S.classes.map((c) => `<button class="chip ${S.picked.has(c.name) ? 'on' : ''}" data-a="pick" data-c="${esc(c.name)}">${esc(c.name || 'No class')} (${c.reachable})</button>`).join('')}
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
      toast(`${d.count} drafts ready${d.aiDrafted < d.count ? ` (${d.count - d.aiDrafted} from templates)` : ''}. Review before sending.`);
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
    const isDraft = g === 'draft';
    $('#view').innerHTML = `
      <div class="head"><div><h1>Messages</h1><p class="muted">Edit any message, then send. Parents who opted out are skipped automatically.</p></div>
        ${isDraft && S.msgs.length ? `<div class="row"><label class="check"><input type="checkbox" id="all" checked data-a="toggle-all"> Select all</label><button class="btn" data-a="send">Send selected</button></div>` : ''}
      </div>
      <div class="chips" style="margin-bottom:14px">
        ${[['draft', 'Drafts'], ['sent', 'Sent'], ['failed', 'Needs attention']].map(([id, l]) => `<button class="chip ${g === id ? 'on' : ''}" data-a="group" data-g="${id}">${l} (${c[id] || 0})</button>`).join('')}
      </div>
      ${S.msgs.length ? S.msgs.map((m) => `<div class="msg" data-id="${m.id}">
        <header>${isDraft || g === 'failed' ? `<input type="checkbox" class="pick" style="width:auto" ${isDraft ? 'checked' : ''} aria-label="Select message">` : ''}
          <span class="who">${esc(m.parent_name || 'Parent')} <span class="muted" style="font-weight:400">for ${esc(m.student_name || '')}${m.class_name ? ', ' + esc(m.class_name) : ''}</span></span>
          <span class="pill ${m.channel === 'sms' ? 'sms' : 'wa'}">${m.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>
          ${!isDraft ? `<span class="pill ${m.status}">${m.status}</span>` : ''}
          ${m.ai ? '<span class="pill">AI draft</span>' : ''}
          <span class="spacer"></span><span class="small muted">+${esc(m.phone)}</span></header>
        ${isDraft || g === 'failed' ? `<textarea>${esc(m.body)}</textarea>` : `<div style="white-space:pre-wrap">${esc(m.body)}</div>`}
        ${m.error ? `<div class="${m.status === 'failed' || m.status === 'skipped' ? 'err' : 'small muted'}" style="margin-top:6px">${esc(m.error)}</div>` : ''}
        <footer>${isDraft || g === 'failed' ? `<span class="small muted count">${counter(m, m.body)}</span><span class="spacer"></span>
          ${g === 'failed' && m.status === 'failed' ? `<button class="btn ghost" data-a="retry">Retry</button>` : ''}
          <button class="btn danger" data-a="discard">Discard</button>` : `<span class="small muted">${esc(m.sent_at || '')}</span>`}</footer></div>`).join('')
      : `<div class="card empty">${isDraft ? 'No drafts waiting. Start from Compose.' : g === 'sent' ? 'Nothing sent yet.' : 'Nothing needs attention.'}</div>`}`;
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
  const ALIAS = { student_name: ['student_name', 'student', 'pupil', 'name', 'child'], class_name: ['class_name', 'class', 'grade'], parent_name: ['parent_name', 'parent', 'guardian', 'guardian_name'], phone: ['phone', 'phone_number', 'mobile', 'whatsapp', 'tel'], admission_no: ['admission_no', 'admission_number', 'reg_no', 'admission'], channel: ['channel', 'preferred_channel'] };
  function csvToRows(text) {
    const [head, ...body] = parseCSV(text);
    const idx = {};
    head.forEach((h, i) => { const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_'); for (const [f, al] of Object.entries(ALIAS)) if (al.includes(k) && idx[f] === undefined) idx[f] = i; });
    return body.map((r) => Object.fromEntries(Object.entries(idx).map(([f, i]) => [f, (r[i] || '').trim()])));
  }
  async function viewParents(q = '') {
    S.contacts = await api('/contacts?q=' + encodeURIComponent(q));
    $('#view').innerHTML = `
      <div class="head"><div><h1>Parents</h1><p class="muted">One row per child and parent/guardian. Numbers like 0803… are converted to +234 automatically.</p></div></div>
      <div class="card"><h3>Add a parent</h3>
        <form id="addForm" class="grid" style="margin-top:12px">
          <label>Student name<input name="student_name" required></label><label>Class<input name="class_name" placeholder="JSS 1A"></label>
          <label>Parent name<input name="parent_name" placeholder="Mrs Okafor"></label><label>Phone<input name="phone" required placeholder="0803 123 4567"></label>
          <label>Admission no.<input name="admission_no"></label>
          <label>Send by<select name="channel"><option value="whatsapp">WhatsApp (SMS if it fails)</option><option value="sms">SMS only</option></select></label>
          <div style="align-self:end"><button class="btn" type="submit">Add parent</button></div></form></div>
      <div class="card"><h3>Import from CSV</h3>
        <p class="small muted">Columns: student_name, class, parent_name, phone, admission_no, channel. <button class="link" data-a="template">Download a template</button></p>
        <input type="file" id="csv" accept=".csv,text/csv"></div>
      <div class="row" style="margin-bottom:10px"><input id="q" placeholder="Search name, class, phone…" value="${esc(q)}" style="max-width:320px"><span class="muted small">${S.contacts.length} shown</span></div>
      ${S.contacts.length ? `<div class="card tablewrap" style="padding:6px 12px"><table><thead><tr><th>Student</th><th>Class</th><th>Parent</th><th>Phone</th><th>Channel</th><th></th></tr></thead><tbody>
        ${S.contacts.map((c) => `<tr data-id="${c.id}"><td>${esc(c.student_name)}<div class="small muted">${esc(c.admission_no)}</div></td><td>${esc(c.class_name)}</td><td>${esc(c.parent_name)}</td><td>+${esc(c.phone)}</td>
          <td><span class="pill ${c.channel === 'sms' ? 'sms' : 'wa'}">${c.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>${c.opted_out ? ' <span class="pill failed">opted out</span>' : ''}</td>
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
    const pv = (v) => (v === true || v === 'live' ? '<span class="pill sent">live</span>' : '<span class="pill queued">' + (v === false ? 'templates only' : 'dry-run') + '</span>');
    $('#view').innerHTML = `
      <div class="head"><div><h1>Settings</h1></div></div>
      <div class="card"><h3>Connections</h3>
        <p style="margin:10px 0 4px">AI drafting ${pv(providers.ai)} &nbsp; SMS (Termii) ${pv(providers.sms)} &nbsp; WhatsApp ${pv(providers.whatsapp)}</p>
        <p class="small muted" style="margin:0">Dry-run means messages are logged on the server but not delivered. Add the API keys in the server environment to go live.</p></div>
      ${admin ? `<div class="card"><h3>School</h3><form id="schoolForm" class="grid" style="margin-top:12px">
        <label>School name<input name="name" value="${esc(school.name)}" required></label>
        <label>SMS sender ID (max 11 letters/numbers)<input name="sender_id" value="${esc(school.sender_id)}" maxlength="11"></label>
        <label>Sign-off on messages<input name="signature" value="${esc(school.signature)}"></label>
        <label>Default tone<select name="default_tone">${Object.entries(S.me.tones).map(([k, v]) => `<option value="${k}" ${school.default_tone === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>Default language<select name="default_language">${S.me.languages.map((l) => `<option ${school.default_language === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="auto_send_absence" ${school.auto_send_absence ? 'checked' : ''}> Send absence alerts automatically (no review)</label>
        <div><button class="btn" type="submit">Save settings</button></div></form></div>
      <div class="card"><h3>Class Register connection</h3>
        <p class="small muted" style="margin:6px 0 10px">Your Class Register calls this address when a pupil is marked absent (A) or late (L). A drafted alert then appears in Messages, or is sent straight away if auto-send is on.</p>
        <p>Endpoint: <code>${esc(origin)}/api/hooks/absence</code></p>
        <p>API key: <code id="key">${esc(school.api_key)}</code> <button class="btn ghost" data-a="rotate">Generate new key</button></p></div>
      <div class="card"><h3>Staff accounts</h3>
        <table><tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><span class="pill">${u.role}</span></td></tr>`).join('')}</tbody></table>
        <form id="staffForm" class="grid" style="margin-top:12px"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Temporary password<input name="password" type="password" minlength="8" required></label><div style="align-self:end"><button class="btn" type="submit">Add teacher</button></div></form></div>` : `<div class="card muted">Only school admins can change settings.</div>`}`;
    $('#schoolForm')?.addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target)); b.auto_send_absence = !!b.auto_send_absence;
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
    else if (a === 'discard') { await api('/messages/' + msgEl.dataset.id, { method: 'DELETE' }); await refreshCounts(); renderShell(); }
    else if (a === 'optout') { const c = S.contacts.find((x) => x.id === +rowEl.dataset.id); await api('/contacts/' + c.id, { method: 'PUT', body: { opted_out: c.opted_out ? 0 : 1 } }); viewParents($('#q').value); }
    else if (a === 'delcontact') { if (confirm('Delete this parent?')) { await api('/contacts/' + rowEl.dataset.id, { method: 'DELETE' }); S.classes = await api('/classes'); viewParents($('#q').value); } }
    else if (a === 'rotate') { if (confirm('The old key stops working immediately. Continue?')) { const r = await api('/school/rotate-key', { method: 'POST' }); S.me.school.api_key = r.api_key; $('#key').textContent = r.api_key; toast('New key generated. Update it in your Class Register.'); } }
    else if (a === 'template') {
      const blob = new Blob(['student_name,class,parent_name,phone,admission_no,channel\nAdaeze Okafor,JSS 1A,Mrs Okafor,08031234567,SC/001,whatsapp\n'], { type: 'text/csv' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'parents-template.csv'; link.click();
    }
  }));
  document.addEventListener('input', (e) => {
    const ta = e.target.closest('.msg textarea'); if (!ta) return;
    const m = S.msgs.find((x) => x.id === +ta.closest('.msg').dataset.id);
    $('.count', ta.closest('.msg')).textContent = counter(m, ta.value);
  });
  document.addEventListener('change', guard(async (e) => {
    const ta = e.target.closest('.msg textarea'); if (!ta) return;
    const id = +ta.closest('.msg').dataset.id;
    await api('/messages/' + id, { method: 'PUT', body: { body: ta.value } });
    const m = S.msgs.find((x) => x.id === id); if (m) { m.body = ta.value; m.ai = 0; }
    toast('Saved');
  }));

  window.PCB = { toast, me: () => S.me, goto: (v) => setView(v), refresh: async () => { S.classes = await api('/classes'); await refreshCounts(); renderShell(); }, showDrafts: async () => { S.group = 'draft'; S.classes = await api('/classes'); await refreshCounts(); setView('messages'); } }; /* SM-CONNECTION */
  boot();
})();
