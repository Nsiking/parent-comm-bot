(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = $('#root');
  const S = { me: null, view: 'compose', group: 'draft', classes: [], picked: new Set(['*']), groups: [], pickedG: new Set(), pgroup: 0, approvals: 0, tpls: [], tplsLoaded: false, msgs: [], counts: {}, contacts: [], poll: null };

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
    try { S.groups = await api('/groups'); } catch { S.groups = []; }
    await refreshCounts();
    renderShell();
  }
  async function refreshCounts() {
    const d = await api('/messages?group=' + S.group);
    S.msgs = d.messages; S.counts = d.counts; S.approvals = d.approvals || 0;
    try { S.unread = (await api('/replies/summary')).unread; } catch { S.unread = 0; }
  }
  const roleLabel = (r) => (r === 'admin' ? 'Administrator' : 'Teacher');
  const NAV = [['compose', 'Compose'], ['messages', 'Messages'], ['replies', 'Replies'], ['history', 'History'], ['parents', 'Parents'], ['settings', 'Settings']];
  const navItems = () => { const base = S.me && S.me.owner ? [['platform', 'Platform'], ...NAV] : NAV; return S.me && S.me.user.role === 'admin' ? base.flatMap((n) => (n[0] === 'history' ? [n, ['activity', 'Activity']] : [n])) : base; };
  function renderShell() {
    const m = S.me;
    root.innerHTML = `<div class="shell"><nav class="rail">
      <div class="brand">${esc(m.school.name)}<small>Parent Communication Bot</small></div>
      ${navItems().map(([id, label]) => `<button class="nav ${S.view === id ? 'active' : ''}" data-a="nav" data-v="${id}">${label}${id === 'messages' && S.counts.draft ? `<span class="badge">${S.counts.draft}</span>` : ''}${id === 'replies' && S.unread ? `<span class="badge">${S.unread}</span>` : ''}</button>`).join('')}
      <div class="who">${esc(m.user.name)}<br><span style="color:#cfe0da;font-size:12px">${roleLabel(m.user.role)}</span><br><button class="link" style="color:#9db8b0" data-a="logout">Sign out</button></div>
    </nav><main id="view"></main></div>`;
    renderView(); refreshUnread();
  }
  // The Replies badge is drawn with the menu, so it is refreshed separately (without redrawing the screen the person is typing in).
  function paintUnread() { const b = $('[data-v="replies"]'); if (b) b.innerHTML = 'Replies' + (S.unread ? `<span class="badge">${S.unread}</span>` : ''); }
  async function refreshUnread() { try { const d = await api('/replies/summary'); if (d.unread !== S.unread) { S.unread = d.unread; paintUnread(); } } catch { /* the badge stays as it was */ } }
  function renderView() {
    ({ platform: viewPlatform, compose: viewCompose, messages: viewMessages, replies: viewReplies, history: viewHistory, activity: viewActivity, parents: viewParents, settings: viewSettings })[S.view]();
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
  // Starter templates: examples to adjust. Anything in [square brackets] must be filled in before drafting.
  const STARTERS = [
    { title: 'Fee balance reminder', kind: 'fees', facts: "Second-term balance is [amount], due [date]. Pay to the school account or at the bursar's office." },
    { title: 'PTA meeting', kind: 'event', facts: 'PTA meeting on [day and date] at [time] in the school hall. Please arrive 15 minutes early.' },
    { title: 'School closing for a break', kind: 'announcement', facts: 'School closes for [name of break] on [date] and resumes on [date].' },
    { title: 'Homework reminder', kind: 'announcement', facts: 'Homework for [class or subject] is due on [date]. Please make sure your child completes it.' },
    { title: 'Well done this week', kind: 'commendation', facts: '[what the child did well] this week' },
    { title: 'End of week progress', kind: 'progress', facts: 'End of week [number]. We covered [topics]. Please encourage [reading or practice] at home.' },
  ];
  const tplOptions = () => `<option value="">Choose a template…</option>
    <optgroup label="Starter templates">${STARTERS.map((t, i) => `<option value="s:${i}">${esc(t.title)}</option>`).join('')}</optgroup>
    ${S.tpls.length ? `<optgroup label="Saved by your school">${S.tpls.map((t) => `<option value="u:${t.id}">${esc(t.title)}</option>`).join('')}</optgroup>` : ''}`;
  const chosenTpl = () => {
    const v = ($('#tplPick') || {}).value || '';
    if (v.startsWith('s:')) return { starter: true, ...STARTERS[+v.slice(2)] };
    if (v.startsWith('u:')) return S.tpls.find((t) => t.id === +v.slice(2)) || null;
    return null;
  };
  async function loadTpls(keep) {
    S.tpls = await api('/templates'); S.tplsLoaded = true;
    const sel = $('#tplPick'); if (sel) { sel.innerHTML = tplOptions(); if (keep) sel.value = keep; }
  }
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
          <button class="chip ${pickedAll ? 'on' : ''}" data-a="pick" data-c="*">${Array.isArray(S.me.my_classes) ? 'All my classes' : 'Whole school'} (${S.classes.reduce((n, c) => n + reach(c), 0)})</button>
          ${S.classes.map((c) => `<button class="chip ${S.picked.has(c.name) ? 'on' : ''}" data-a="pick" data-c="${esc(c.name)}">${esc(c.name || 'No class')} (${reach(c)})</button>`).join('')}
        </div>
        ${Array.isArray(S.me.my_classes) ? `<p class="small muted" style="margin:10px 0 0">Your classes: ${esc(S.me.my_classes.join(', '))}</p>` : ''}
        ${S.groups.length ? `<p class="small muted" style="margin:12px 0 0">Groups (make them on the Parents page)</p><div class="chips" style="margin-top:6px">
          ${S.groups.map((g) => `<button class="chip ${S.pickedG.has(g.id) ? 'on' : ''}" data-a="pick-group" data-g="${g.id}">${esc(g.name)} (${g.reachable})</button>`).join('')}</div>` : ''}` : `<p class="muted">No parents yet. <button class="link" data-a="nav" data-v="parents">Add or import parents</button> first.</p>`}
      </div>
      <div class="card"><h3>Templates</h3>
        <p class="small muted" style="margin:6px 0 10px">Start from a ready message and change it, or save what you have written below so you and your colleagues can use it again.</p>
        <div class="row"><select id="tplPick">${tplOptions()}</select><button class="btn ghost" data-a="tpl-use">Use template</button><button class="btn ghost" data-a="tpl-save">Save what I wrote as a template</button><button class="btn ghost" data-a="tpl-del">Delete template</button></div>
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
    if (!S.tplsLoaded) loadTpls().catch(() => {});
  }
  // Redraw Compose after a chip is clicked, keeping what was typed.
  function keepCompose() {
    const keep = { k: $('#kind').value, t: $('#tone').value, l: $('#language').value, f: $('#facts').value, n: $('#notes')?.value };
    viewCompose(); $('#kind').value = keep.k; $('#tone').value = keep.t; $('#language').value = keep.l; $('#facts').value = keep.f; if ($('#notes')) $('#notes').value = keep.n || ''; $('#kind').dispatchEvent(new Event('change'));
  }
  const draft = guard(async () => {
    const gap = /\[[^\]]*\]/.exec($('#facts').value);
    if (gap) throw new Error('Fill in the part in square brackets, ' + gap[0] + ', before drafting.');
    const btn = $('#draftBtn'); btn.disabled = true; btn.textContent = 'Drafting…';
    try {
      const d = await api('/drafts', { method: 'POST', body: {
        kind: $('#kind').value, tone: $('#tone').value, language: $('#language').value,
        facts: $('#facts').value, notesText: $('#notes')?.value || '',
        classes: S.picked.has('*') ? ['*'] : [...S.picked], groups: [...S.pickedG],
      } });
      toast(`${d.count} drafts ready${d.aiDrafted < d.count ? ` (${d.count - d.aiDrafted} from templates)` : ''}. Review before sending.${d.noConsent ? ` ${d.noConsent} left out: no consent recorded.` : ''}`);
      S.group = 'draft'; await refreshCounts(); setView('messages');
    } finally { btn.disabled = false; btn.textContent = 'Draft messages'; }
  });

  // ---------- replies (what parents write back on WhatsApp)
  async function viewReplies() {
    const [d, col] = await Promise.all([api('/replies'), api('/colleagues').catch(() => [])]);
    S.unread = d.unread; paintUnread();
    const when = (at) => String(at).slice(0, 16).replace('T', ' ');
    const me = S.me.user.id, f = S.rfilter || 'open';
    const open = d.replies.filter((r) => !r.handled), mine = open.filter((r) => r.assigned_to === me), done = d.replies.filter((r) => r.handled);
    const shown = f === 'mine' ? mine : f === 'handled' ? done : f === 'all' ? d.replies : open;
    const chip = (id, label, n) => `<button class="chip ${f === id ? 'on' : ''}" data-a="rfilter" data-f="${id}">${label} (${n})</button>`;
    $('#view').innerHTML = `
      <div class="head"><div><h1>Replies</h1><p class="muted">What parents write back on WhatsApp. Replies from numbers that are not in your parent list are not shown.</p></div>
        ${d.unread ? '<div class="row"><button class="btn ghost" data-a="reply-read-all">Mark all as read</button></div>' : ''}</div>
      ${d.replies.length ? `<div class="chips" style="margin-bottom:14px">${chip('open', 'Open', open.length)}${chip('mine', 'Given to me', mine.length)}${chip('handled', 'Handled', done.length)}${chip('all', 'All', d.replies.length)}</div>` : ''}
      ${shown.length ? shown.map((r) => `<div class="msg" data-rid="${r.id}">
        <header><span class="who">${esc(r.parent || 'Parent')} <span class="muted" style="font-weight:400">${r.students.length ? 'for ' + esc(r.students.join(', ')) : ''}${r.classes.length ? ', ' + esc(r.classes.join(', ')) : ''}</span></span>
          ${r.read ? '' : '<span class="pill sent">New</span>'}${r.handled ? `<span class="pill delivered">Handled${r.handled_by ? ' by ' + esc(r.handled_by) : ''}</span>` : ''}<span class="spacer"></span><span class="small muted">${esc(when(r.at))}</span></header>
        <p style="white-space:pre-wrap;margin:8px 0">${esc(r.text)}</p>
        <div class="row"><a class="btn ghost" href="https://wa.me/${esc(r.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">Reply on WhatsApp</a>
          ${r.read ? '' : `<button class="btn ghost" data-a="reply-read" data-id="${r.id}">Mark as read</button>`}
          <button class="btn ghost" data-a="reply-handle" data-id="${r.id}" data-h="${r.handled ? 0 : 1}">${r.handled ? 'Open again' : 'Mark handled'}</button>
          <select class="assign-sel" data-id="${r.id}" aria-label="Give to" style="max-width:200px"><option value="">Not given to anyone</option>${col.map((u) => `<option value="${u.id}" ${r.assigned_to === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div></div>`).join('')
        : d.replies.length ? `<div class="card empty">${f === 'mine' ? 'Nothing is given to you.' : f === 'handled' ? 'No reply is marked handled yet.' : 'Every reply has been handled.'}</div>`
        : '<div class="card empty">No replies yet. When a parent answers one of your WhatsApp messages, it appears here.</div>'}`;
  }

  // ---------- activity (administrators): who did what
  const ACT = { drafted: 'Drafted', requested: 'Asked for approval', sent: 'Sent', scheduled: 'Scheduled', unscheduled: 'Cancelled a schedule', discarded: 'Discarded', settings: 'Changed settings', imported: 'Imported parents', parent_deleted: 'Deleted a parent', group: 'Groups', retried: 'Sent again', reply: 'Replies' };
  async function viewActivity() {
    const a = (S.act = S.act || { user: 0, rows: [], total: 0, people: [] });
    const d = await api('/activity?limit=50&offset=0' + (a.user ? '&user=' + a.user : ''));
    a.rows = d.rows; a.total = d.total; a.people = d.people; renderActivity();
  }
  function renderActivity() {
    const a = S.act;
    $('#view').innerHTML = `
      <div class="head"><div><h1>Activity</h1><p class="muted">Who did what at your school. Times are Nigerian time. Only administrators can see this page.</p></div></div>
      <div class="row" style="margin-bottom:10px"><label>Person<select id="actUser"><option value="0">Everyone</option>${a.people.map((p) => `<option value="${p.id}" ${a.user === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><span class="muted small">${a.total} entr${a.total === 1 ? 'y' : 'ies'}</span></div>
      ${a.rows.length ? `<div class="card tablewrap" style="padding:6px 12px"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
        ${a.rows.map((r) => `<tr><td class="small" style="white-space:nowrap">${esc(String(r.at).slice(0, 16))}</td><td>${esc(r.user_name)}</td><td>${esc(ACT[r.action] || r.action)}</td><td class="small">${esc(r.detail || '')}</td></tr>`).join('')}</tbody></table></div>
        ${a.rows.length < a.total ? '<button class="btn ghost" data-a="act-more">Show more</button>' : ''}` : '<div class="card empty">Nothing has been recorded yet. Actions such as drafting, sending and changing settings appear here from now on.</div>'}`;
  }

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
    const sch = S.me.school, isAdmin = S.me.user.role === 'admin', needAppr = !!sch.require_approval && !isAdmin;
    const notes = isDraft ? [
      needAppr ? 'Your school asks an administrator to approve messages. Tick the messages you want approved and click Ask for approval. The administrator reviews and sends them.' : '',
      isAdmin && sch.require_approval && S.approvals ? `${S.approvals} message${S.approvals === 1 ? ' is' : 's are'} waiting for your approval. Review them below, then click Send selected.` : '',
      sch.quiet_start && sch.quiet_end ? `Quiet hours: nothing is sent between ${esc(sch.quiet_start)} and ${esc(sch.quiet_end)} (Nigerian time).` : '',
    ].filter(Boolean) : [];
    $('#view').innerHTML = `
      <div class="head"><div><h1>Messages</h1><p class="muted">Edit any message, then send. Parents who opted out are skipped automatically.</p></div>
        ${isDraft && S.msgs.length ? `<div class="row"><label class="check"><input type="checkbox" id="all" checked data-a="toggle-all"> Select all</label>${needAppr ? '<button class="btn" data-a="ask-approval">Ask for approval</button>' : '<button class="btn" data-a="send">Send selected</button><button class="btn ghost" data-a="sched-open">Send later</button>'}</div>` : ''}
        ${isSched && S.msgs.length ? `<div class="row"><label class="check"><input type="checkbox" id="all" checked data-a="toggle-all"> Select all</label><button class="btn ghost" data-a="unschedule">Cancel schedule</button></div>` : ''}
      </div>
      ${notes.length ? `<div class="card small" id="msgNotes">${notes.map((t) => `<p style="margin:2px 0">${t}</p>`).join('')}</div>` : ''}
      ${isDraft && S.msgs.length && !needAppr ? `<div class="card" id="schedPanel" hidden><h3>Send later</h3>
        <p class="small muted" style="margin:6px 0 10px">Choose when the selected messages should go out. Times are Nigerian time. Opt-outs, consent and your daily limit are checked again at that moment.</p>
        <div class="row"><label>Date and time<input type="datetime-local" id="schedAt" value="${schedDefault()}" min="${watNow()}"></label><label class="check" style="align-self:end"><input type="checkbox" id="remind"> Also send a reminder the day before (same time)</label><button class="btn" data-a="sched-go">Schedule selected</button></div></div>` : ''}
      <div class="chips" style="margin-bottom:14px">
        ${[['draft', 'Drafts'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['failed', 'Needs attention']].map(([id, l]) => `<button class="chip ${g === id ? 'on' : ''}" data-a="group" data-g="${id}">${l} (${c[id] || 0})</button>`).join('')}
      </div>
      ${S.msgs.length ? S.msgs.map((m) => `<div class="msg" data-id="${m.id}">
        <header>${isDraft || isSched || g === 'failed' ? `<input type="checkbox" class="pick" style="width:auto" ${isDraft || isSched ? 'checked' : ''} aria-label="Select message">` : ''}
          <span class="who">${esc(m.parent_name || 'Parent')} <span class="muted" style="font-weight:400">for ${esc(m.student_name || '')}${m.class_name ? ', ' + esc(m.class_name) : ''}</span></span>
          <span class="pill ${m.channel === 'sms' ? 'sms' : 'wa'}">${m.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>
          ${!isDraft ? `<span class="pill ${m.status === 'scheduled' ? 'queued' : m.status}">${m.status === 'scheduled' ? 'Sends ' + esc(String(m.scheduled_wat).slice(0, 16)) : m.status}</span>` : ''}
          ${m.reminder_of ? '<span class="pill">Reminder</span>' : ''}${m.ai ? '<span class="pill">AI draft</span>' : ''}
          ${(isDraft || g === 'failed') && m.approval_requested_at ? `<span class="pill queued" title="${esc(m.approval_by ? 'Asked by ' + m.approval_by : '')}">Waiting for approval</span>${isAdmin && m.approval_by ? `<span class="small muted">asked by ${esc(m.approval_by)}</span>` : ''}` : ''}
          <span class="spacer"></span><span class="small muted">+${esc(m.phone)}</span></header>
        ${isDraft || g === 'failed' ? `<textarea>${esc(m.body)}</textarea>` : `<div style="white-space:pre-wrap">${esc(m.body)}</div>`}
        ${m.error ? `<div class="${m.status === 'failed' || m.status === 'skipped' ? 'err' : 'small muted'}" style="margin-top:6px">${esc(m.error)}</div>` : ''}
        <footer>${isDraft || g === 'failed' ? `<span class="small muted count">${counter(m, m.body)}</span><span class="spacer"></span>
          ${g === 'failed' && m.status === 'failed' ? (needAppr ? `<button class="btn ghost" data-a="ask-approval-one">Ask for approval</button>` : `<button class="btn ghost" data-a="retry">Retry</button>`) : ''}
          <button class="btn danger" data-a="discard">Discard</button>` : isSched ? `<span class="spacer"></span><button class="btn ghost" data-a="unschedule-one">${m.reminder_of ? 'Remove reminder' : 'Cancel schedule'}</button>` : `<span class="small muted">${esc(m.sent_at || '')}</span>`}</footer></div>`).join('')
      : `<div class="card empty">${isDraft ? 'No drafts waiting. Start from Compose.' : isSched ? 'Nothing is scheduled.' : g === 'sent' ? 'Nothing sent yet.' : 'Nothing needs attention.'}</div>`}`;
    clearInterval(S.poll);
    if (g === 'sent' && S.msgs.some((m) => m.status === 'queued' || m.status === 'sent')) {
      S.poll = setInterval(async () => { await refreshCounts(); if (S.view === 'messages' && S.group === 'sent') viewMessages(); else clearInterval(S.poll); }, 4000);
    }
  }
  const tickedParents = () => [...document.querySelectorAll('.cpick')].filter((c) => c.checked).map((c) => +c.closest('tr').dataset.id);
  const selectedIds = () => [...document.querySelectorAll('.msg')].filter((el) => $('.pick', el)?.checked).map((el) => +el.dataset.id);
  const send = guard(async (ids) => {
    ids = ids || selectedIds();
    if (!ids.length) return toast('Select at least one message', true);
    if (!confirm(`Send ${ids.length} message${ids.length > 1 ? 's' : ''} to parents now?`)) return;
    const r = await api('/messages/send', { method: 'POST', body: { ids } });
    if (r.quiet) return toast(`Not sent: quiet hours (${r.quiet.start} to ${r.quiet.end}, Nigerian time). The messages stay in Drafts.`, true);
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
  const askApproval = guard(async (ids) => {
    ids = ids || selectedIds();
    if (!ids.length) return toast('Select at least one message', true);
    const r = await api('/messages/request-approval', { method: 'POST', body: { ids } });
    toast(`${r.requested} message${r.requested === 1 ? '' : 's'} sent to an administrator for approval`);
    await refreshCounts(); setView('messages');
  });
  const schedule = guard(async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('Select at least one message', true);
    const at = $('#schedAt').value;
    if (!at) return toast('Choose a date and time', true);
    const r = await api('/messages/schedule', { method: 'POST', body: { ids, at, remind: !!$('#remind')?.checked } });
    toast(`${r.scheduled} message${r.scheduled === 1 ? '' : 's'} scheduled for ${r.at_wat} (Nigerian time).${r.reminders ? ` Plus ${r.reminders} reminder${r.reminders === 1 ? '' : 's'} the day before.` : ''}${r.reminderNote ? ' ' + r.reminderNote : ''}`);
    S.group = 'scheduled'; await refreshCounts(); setView('messages');
  });
  const unschedule = guard(async (ids) => {
    if (!ids.length) return toast('Select at least one message', true);
    const r = await api('/messages/unschedule', { method: 'POST', body: { ids } });
    const parts = [];
    if (r.cancelled || !r.removedReminders) parts.push(`${r.cancelled} message${r.cancelled === 1 ? '' : 's'} back in Drafts`);
    if (r.removedReminders) parts.push(`${r.removedReminders} reminder${r.removedReminders === 1 ? '' : 's'} removed`);
    toast(parts.join('. '));
    S.group = r.cancelled ? 'draft' : 'scheduled'; await refreshCounts(); setView('messages');
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
  // Delivery by batch: what happened to each group of messages, with the failed ones listed and a button to send them again.
  function batchCard(h) {
    const list = h.batches || [];
    if (!list.length) return '';
    const canRetry = !(S.me.school.require_approval && S.me.user.role !== 'admin');
    const rows = list.map((b) => {
      const open = h.openId === b.id && h.detail;
      return `<tr><td class="small" style="white-space:nowrap">${esc(String(b.at).slice(0, 16))}</td><td>${esc(b.kind_label)}<div class="small muted">${esc(b.by_name || '')}</div></td>
        <td>${b.total}</td><td>${b.sent}</td><td>${b.delivered}</td><td>${b.failed ? `<b style="color:#b42318">${b.failed}</b>` : 0}</td><td>${b.skipped}</td><td>${b.waiting}</td>
        <td style="text-align:right">${b.failed || b.skipped ? `<button class="btn ghost" data-a="batch-open" data-id="${b.id}">${open ? 'Hide' : 'Details'}</button>` : ''}</td></tr>
        ${open ? `<tr><td colspan="9" style="background:#faf7ee">${h.detail.problems.map((p) => `<div class="small" style="margin:3px 0"><span class="pill ${p.status === 'failed' ? 'failed' : 'queued'}">${p.status === 'failed' ? 'Failed' : 'Held back'}</span> ${esc(p.parent_name || 'Parent')} for ${esc(p.student_name || '')}${p.class_name ? ', ' + esc(p.class_name) : ''} · +${esc(p.phone)}<div class="muted">${esc(p.error || '')}</div></div>`).join('')}
          ${b.failed ? (canRetry ? `<button class="btn" style="margin-top:8px" data-a="batch-retry" data-id="${b.id}">Send the ${b.failed} failed again</button>` : '<p class="small muted">Ask an administrator to send these again.</p>') : ''}</td></tr>` : ''}`;
    }).join('');
    return `<div class="card"><h3>Delivery by batch</h3>
      <p class="small muted" style="margin:6px 0 10px">The last ${list.length} batches. <b>Sent</b> includes messages confirmed <b>Delivered</b>. <b>Held back</b> means the parent opted out or has no consent recorded. Automatic absence and late alerts are not part of a batch.</p>
      <div class="tablewrap"><table><thead><tr><th>When</th><th>Type</th><th>Total</th><th>Sent</th><th>Delivered</th><th>Failed</th><th>Held back</th><th>Waiting</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
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
 ${batchCard(h)}
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
      const [sum, list, batches] = await Promise.all([api('/messages/summary?month=' + h.month), api('/messages/history?' + histQuery(h.applied, { limit: 100, offset: 0 })), api('/batches').catch(() => [])]);
      h.sum = sum; h.rows = list.rows; h.total = list.total; h.batches = batches;
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
  const consentOptions = (sel) => `<option value="">Not recorded</option>${CONSENT_OPTS.map(([v, l]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`).join('')}${sel === 'imported' ? '<option value="imported" selected>Imported list</option>' : ''}${sel === 'parent_online' ? '<option value="parent_online" selected>Parent confirmed online</option>' : ''}`;
  const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  // ---------- import check (what a CSV file would do, before anything is saved)
  function importPreview(r) {
    const n = r.add + r.update;
    const list = (items, fn) => `<ul class="small" style="margin:4px 0 0 18px">${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>`;
    const more = (total, shown) => (total > shown ? `<div class="small muted">…and ${total - shown} more.</div>` : '');
    return `<div class="card" style="margin-top:12px;border:2px solid #f4b400"><h3>Check before importing</h3>
      <p style="margin:8px 0"><b>${r.total}</b> rows in the file: <b>${r.add}</b> new parent${r.add === 1 ? '' : 's'}, <b>${r.update}</b> already in your list (updated)${r.repeatedTotal ? `, <b>${r.repeatedTotal}</b> repeated` : ''}, <b>${r.skippedTotal}</b> with a problem (left out).</p>
      ${r.skippedTotal ? `<p class="small" style="margin:8px 0 0"><b>Left out, fix these rows in your file:</b></p>${list(r.skipped, (x) => `Row ${x.row}: ${esc(x.reason)}`)}${more(r.skippedTotal, r.skipped.length)}` : ''}
      ${r.noClassTotal ? `<p class="small" style="margin:10px 0 0"><b>${r.noClassTotal} row${r.noClassTotal === 1 ? ' has' : 's have'} no class.</b> They will be imported, but Compose can only reach them through "Whole school".</p>${list(r.noClass, (x) => `Row ${x.row}: ${esc(x.student)}`)}${more(r.noClassTotal, r.noClass.length)}` : ''}
      ${r.repeatedTotal ? `<p class="small" style="margin:10px 0 0"><b>${r.repeatedTotal} row${r.repeatedTotal === 1 ? ' repeats' : 's repeat'} an earlier row</b> (same child and phone). They are not counted twice, and the later row's details win.</p>${list(r.repeated, (x) => `Row ${x.row} repeats row ${x.first} (${esc(x.student)})`)}${more(r.repeatedTotal, r.repeated.length)}` : ''}
      ${r.sharedPhones ? `<p class="small muted" style="margin:10px 0 0">${r.sharedPhones} phone number${r.sharedPhones === 1 ? ' is' : 's are'} used for more than one child (brothers and sisters). That is normal.</p>` : ''}
      <p class="small" style="margin:10px 0 4px"><b>Classes in the file</b></p>
      <div class="chips">${r.classes.map((c) => `<span class="chip">${esc(c.name)} (${c.count})${c.isNew ? ' <span class="pill queued">new class</span>' : ''}${c.similar.length ? ` <span class="pill failed">looks like ${esc(c.similar.join(', '))}</span>` : ''}</span>`).join('') || '<span class="muted small">None</span>'}</div>
      ${r.classes.some((c) => c.similar.length) ? '<p class="small muted" style="margin:6px 0 0">A class that "looks like" another may be a typing difference (for example JSS1A and JSS 1A). Correct the file if so, so one class does not become two.</p>' : ''}
      <div class="row" style="margin-top:14px">${n ? `<button class="btn" data-a="import-go">Import ${n} parent${n === 1 ? '' : 's'}</button>` : ''}<button class="btn ghost" data-a="import-cancel">${n ? 'Cancel' : 'Close'}</button></div></div>`;
  }

  // ---------- history of one parent
  function parentHistory(d) {
    const c = d.contact, items = [
      ...d.messages.map((m) => ({ at: m.at, t: 'm', m })),
      ...d.replies.map((r) => ({ at: r.at, t: 'r', r })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return `<div class="card" style="border:2px solid #f4b400"><div class="row"><h3>${esc(c.student_name)}${c.class_name ? ', ' + esc(c.class_name) : ''}</h3><span class="spacer"></span><button class="btn ghost" data-a="chist-close">Close</button></div>
      <p class="small muted" style="margin:6px 0 8px">${esc(c.parent_name || 'Parent')} · +${esc(c.phone)} · ${c.channel === 'sms' ? 'SMS' : 'WhatsApp'}${c.opted_out ? ' · opted out' : ''}${c.consent_at ? ' · consent recorded ' + esc(c.consent_at) : ' · no consent recorded'}${d.groups.length ? ' · groups: ' + esc(d.groups.join(', ')) : ''}</p>
      ${items.length ? items.map((x) => x.t === 'm'
        ? `<div class="msg"><header><span class="pill ${x.m.channel === 'sms' ? 'sms' : 'wa'}">${x.m.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span><span class="pill ${x.m.status === 'scheduled' ? 'queued' : x.m.status}">${esc(x.m.status)}</span>${x.m.kind && S.me.kinds[x.m.kind] ? `<span class="pill">${esc(S.me.kinds[x.m.kind])}</span>` : ''}<span class="spacer"></span><span class="small muted">${esc(String(x.at).slice(0, 16))}</span></header><div style="white-space:pre-wrap">${esc(x.m.body)}</div>${x.m.error ? `<div class="small muted" style="margin-top:6px">${esc(x.m.error)}</div>` : ''}</div>`
        : `<div class="msg" style="border-left:4px solid #f4b400"><header><span class="pill sent">Parent replied</span><span class="spacer"></span><span class="small muted">${esc(String(x.at).slice(0, 16))}</span></header><div style="white-space:pre-wrap">${esc(x.r.body)}</div></div>`).join('')
        : '<p class="muted">Nothing has been sent to this parent yet.</p>'}</div>`;
  }

  async function viewParents(q = '') {
    S.groups = await api('/groups');
    if (S.pgroup && !S.groups.some((g) => g.id === S.pgroup)) S.pgroup = 0;
    S.contacts = await api('/contacts?q=' + encodeURIComponent(q) + (S.pgroup ? '&group=' + S.pgroup : ''));
    S.classes = await api('/classes');
    const optPend = S.me.user.role === 'admin' ? await api('/optin/pending').catch(() => null) : null;
    const optCard = optPend && optPend.list.length ? `<div class="card"><h3>Pending opt-ins (${optPend.total})</h3>
        <p class="small muted" style="margin:6px 0 10px">Parents who used your opt-in link but did not match your list exactly. Approve only if you know the parent.</p>
        <table><thead><tr><th>Child</th><th>Parent</th><th>Phone</th><th>Why it is waiting</th><th></th></tr></thead><tbody>
        ${optPend.list.map((p) => `<tr><td>${esc(p.student_name)}</td><td>${esc(p.parent_name || '')}</td><td>${esc(p.phone)}</td><td class="small muted">${esc(p.note || '')}<br>${esc(p.at)}</td>
          <td><button class="btn" data-a="optin-approve" data-id="${p.id}">Approve</button> <button class="btn ghost" data-a="optin-ignore" data-id="${p.id}">Ignore</button></td></tr>`).join('')}
        </tbody></table></div>` : '';
    const totalParents = S.classes.reduce((n, c) => n + c.total, 0), withConsent = S.classes.reduce((n, c) => n + (c.with_consent || 0), 0);
    $('#view').innerHTML = `
      <div class="head"><div><h1>Parents</h1><p class="muted">One row per child and parent/guardian. Numbers like 0803… are converted to +234 automatically.</p></div></div>
      ${optCard}
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
        <input type="file" id="csv" accept=".csv,text/csv"><div id="importBox"></div></div>
      <div class="card"><h3>Parent consent</h3>
        <p class="small muted" style="margin:6px 0 10px">Consent is recorded for <b>${withConsent}</b> of <b>${totalParents}</b> parents. Note where each parent agreed to receive messages (admission form or verbal). ${S.me.school.require_consent ? 'Messages are only sent to parents with consent recorded.' : 'You can make consent required in Settings.'}</p>
        ${S.me.user.role === 'admin' ? `<div class="grid"><label>Class<select id="bkClass"><option value="*">All classes</option>${S.classes.map((c) => `<option value="${esc(c.name)}">${esc(c.name || 'No class')}</option>`).join('')}</select></label>
          <label>Consent came from<select id="bkSource">${CONSENT_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label>Date<input type="date" id="bkDate" value="${todayLocal()}" max="${todayLocal()}"></label>
          <div style="align-self:end"><button class="btn" data-a="bulkconsent">Mark consent obtained</button></div></div>
        <p class="small muted" style="margin:8px 0 0">Only parents with no record yet are updated. Use this only when the school really holds those parents' consent.</p>` : ''}</div>
      <div class="card"><h3>Groups</h3>
        <p class="small muted" style="margin:6px 0 10px">Tick parents in the list below, then add them to a group, for example a club, a bus route or fee reminders. In Compose each group appears next to the classes.</p>
        <div class="row"><select id="grpSel" aria-label="Group"><option value="">Choose a group…</option>${S.groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.total})</option>`).join('')}</select>
          <input id="grpName" placeholder="or type a new group name" maxlength="40" style="max-width:240px"><button class="btn" data-a="grp-add">Add ticked parents to group</button></div>
        ${S.groups.length ? `<div class="chips" style="margin-top:12px">${S.groups.map((g) => `<span class="chip" data-gid="${g.id}">${esc(g.name)} (${g.total}) <button class="link" data-a="grp-del" data-id="${g.id}" aria-label="Delete group ${esc(g.name)}">Delete</button></span>`).join('')}</div>` : ''}</div>
      <div id="chistBox"></div>
      <div class="row" style="margin-bottom:10px"><input id="q" placeholder="Search name, class, phone…" value="${esc(q)}" style="max-width:320px">
        ${S.groups.length ? `<select id="grpFilter" aria-label="Show group" style="max-width:220px"><option value="0">All parents</option>${S.groups.map((g) => `<option value="${g.id}" ${S.pgroup === g.id ? 'selected' : ''}>Group: ${esc(g.name)}</option>`).join('')}</select>` : ''}
        ${S.pgroup ? '<button class="btn ghost" data-a="grp-remove">Remove ticked parents from this group</button>' : ''}<span class="muted small">${S.contacts.length} shown</span></div>
      ${S.contacts.length ? `<div class="card tablewrap" style="padding:6px 12px"><table><thead><tr><th style="width:28px"><input type="checkbox" data-a="cpick-all" aria-label="Tick all shown" style="width:auto"></th><th>Student</th><th>Class</th><th>Parent</th><th>Phone</th><th>Channel</th><th>Consent</th><th></th></tr></thead><tbody>
        ${S.contacts.map((c) => `<tr data-id="${c.id}"><td><input type="checkbox" class="cpick" aria-label="Tick parent" style="width:auto"></td><td>${esc(c.student_name)}<div class="small muted">${esc(c.admission_no)}</div></td><td>${esc(c.class_name)}</td><td>${esc(c.parent_name)}</td><td>+${esc(c.phone)}</td>
          <td><span class="pill ${c.channel === 'sms' ? 'sms' : 'wa'}">${c.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>${c.opted_out ? ' <span class="pill failed">opted out</span>' : ''}</td>
          <td><select class="consent-sel" aria-label="Consent">${consentOptions(c.consent_source || '')}</select>${c.consent_at ? `<div class="small muted">${esc(c.consent_at)}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn ghost" data-a="chist">History</button> <button class="btn ghost" data-a="optout">${c.opted_out ? 'Opt in' : 'Opt out'}</button> <button class="btn danger" data-a="delcontact">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : `<div class="card empty">No parents found.</div>`}`;
    $('#addForm').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      await api('/contacts', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Parent added'); S.classes = await api('/classes'); viewParents();
    }));
    $('#csv').addEventListener('change', guard(async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = csvToRows(await f.text());
      e.target.value = '';
      if (!rows.length) return toast('The file has no parents in it', true);
      S.importRows = rows;
      const check = await api('/contacts/import-check', { method: 'POST', body: { rows } });
      $('#importBox').innerHTML = importPreview(check);
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
    const usage = admin ? await api('/sms/usage').catch(() => null) : null;
    const clsInfo = admin ? await api('/staff-classes').catch(() => null) : null;
    const optin = admin ? await api('/optin').catch(() => null) : null;
    const clsCard = () => `<div class="card"><h3>Class assignments</h3>
        <p class="small muted" style="margin:6px 0 10px">Tick the classes each teacher looks after. A teacher with classes ticked sees and messages only those classes. A teacher with none ticked sees every class. Administrators always see everything.</p>
        ${clsInfo.teachers.length ? clsInfo.teachers.map((t) => `<div style="border-top:1px solid #e6e8e1;padding:10px 0"><strong>${esc(t.name)}</strong>
          <div class="chips" style="margin-top:6px">${clsInfo.classes.map((c) => `<label style="display:inline-flex;gap:4px;align-items:center;margin-right:12px"><input type="checkbox" class="cls cls-${t.id}" value="${esc(c)}" ${t.classes.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('') || '<span class="small muted">No classes in your parent list yet.</span>'}</div>
          <button class="btn ghost" style="margin-top:8px" data-a="cls-save" data-uid="${t.id}">Save classes</button></div>`).join('') : '<p class="small muted">No teachers yet.</p>'}</div>`;
    const optinCard = () => `<div class="card"><h3>Parent opt-in link</h3>
        <p class="small muted" style="margin:6px 0 10px">Give parents a link where they type their child's name and phone number and agree to receive messages. When it matches a parent in your list, their consent is recorded with the date. Anything else waits on the Parents page for you to approve. Anyone with the link can use it, so share it only with parents.</p>
        ${optin.link ? `<p><code id="optinUrl">${esc(optin.link)}</code></p><div class="row"><button class="btn" data-a="optin-copy">Copy link</button> <button class="btn ghost" data-a="optin-new">Make a new link</button> <button class="btn ghost" data-a="optin-off">Turn off</button></div>`
          : `<button class="btn" data-a="optin-on">Turn on</button>`}
        <p class="small muted" style="margin:10px 0 0">This records consent. It is not legal advice; check your wording with your data protection adviser.</p></div>`;
    const usageCard = () => {
      const [cur, prev] = usage.months, price = usage.price;
      const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const ml = (m) => MN[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
      const naira = (n) => '\u20A6' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
      const row = (label, f) => `<tr><td>${label}</td><td>${f(cur)}</td><td>${f(prev)}</td></tr>`;
      return `<div class="card"><h3>SMS usage</h3>
        <p class="small muted" style="margin:6px 0 10px">A long message is sent as several SMS parts, and each part uses credit. This is counted from your sent messages, so check your real balance in your Termii account.</p>
        <table><thead><tr><th></th><th>${esc(ml(cur.month))}</th><th>${esc(ml(prev.month))}</th></tr></thead><tbody>
          ${row('SMS messages sent', (u) => u.messages)}${row('SMS parts used', (u) => `<strong>${u.parts}</strong>`)}
          ${price == null ? '' : row('Estimated cost', (u) => naira(u.parts * price))}
          ${row('SMS that failed (no credit used)', (u) => u.failed)}${row('Test messages (not really sent)', (u) => u.test)}${row('WhatsApp messages sent', (u) => u.whatsapp)}
        </tbody></table>
        ${cur.by_kind.length ? `<p class="small muted" style="margin:12px 0 4px">${esc(ml(cur.month))} by message type</p>
          <table><tbody>${cur.by_kind.map((k) => `<tr><td>${esc(k.label)}</td><td>${k.messages} messages</td><td>${k.parts} parts</td></tr>`).join('')}</tbody></table>` : ''}
        <div class="row" style="margin-top:12px"><label>Price of one SMS part (naira, optional)<input id="smsPrice" inputmode="decimal" value="${price == null ? '' : price}" placeholder="for example 4"></label><button class="btn ghost" data-a="sms-price">Save price</button></div>
        <p class="small muted" style="margin:6px 0 0">Leave it empty to show counts only. Use the price in your Termii account; it can change.</p></div>`;
    };
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
      ${usage ? usageCard() : ''}
      ${clsInfo ? clsCard() : ''}
      ${optin ? optinCard() : ''}
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
        <label class="check" style="align-self:end"><input type="checkbox" name="require_approval" ${school.require_approval ? 'checked' : ''}> Teachers need approval before sending (an administrator reviews and sends)</label>
        <label class="check" style="align-self:end"><input type="checkbox" name="quiet_on" ${school.quiet_start && school.quiet_end ? 'checked' : ''}> Quiet hours: do not send between</label>
        <label>From (Nigerian time)<input type="time" name="quiet_start" value="${esc(school.quiet_start || '21:00')}"></label>
        <label>Until (Nigerian time)<input type="time" name="quiet_end" value="${esc(school.quiet_end || '06:00')}"></label>
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
      const b = Object.fromEntries(new FormData(e.target)); b.auto_send_absence = !!b.auto_send_absence; b.require_consent = !!b.require_consent; b.require_approval = !!b.require_approval; b.quiet_on = !!b.quiet_on;
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
      if (c === '*') { S.picked = new Set(['*']); S.pickedG = new Set(); }
      else { S.picked.delete('*'); S.picked.has(c) ? S.picked.delete(c) : S.picked.add(c); if (!S.picked.size && !S.pickedG.size) S.picked.add('*'); }
      keepCompose();
    }
    else if (a === 'pick-group') {
      const g = +el.dataset.g;
      S.picked.delete('*'); S.pickedG.has(g) ? S.pickedG.delete(g) : S.pickedG.add(g);
      if (!S.picked.size && !S.pickedG.size) S.picked.add('*');
      keepCompose();
    }
    else if (a === 'rfilter') { S.rfilter = el.dataset.f; await viewReplies(); }
    else if (a === 'reply-handle') {
      const h = el.dataset.h === '1';
      await api('/replies/handle', { method: 'POST', body: { ids: [+el.dataset.id], handled: h } });
      toast(h ? 'Marked handled' : 'Open again'); renderShell();
    }
    else if (a === 'act-more') {
      const x = S.act, d = await api('/activity?limit=50&offset=' + x.rows.length + (x.user ? '&user=' + x.user : ''));
      x.rows = x.rows.concat(d.rows); x.total = d.total; renderActivity();
    }
    else if (a === 'reply-read') { await api('/replies/read', { method: 'POST', body: { ids: [+el.dataset.id] } }); renderShell(); }
    else if (a === 'reply-read-all') { await api('/replies/read', { method: 'POST', body: { all: true } }); renderShell(); }
    else if (a === 'sms-price') {
      const r = await api('/sms/price', { method: 'PUT', body: { price: $('#smsPrice').value } });
      toast(r.price == null ? 'Price cleared. Counts only.' : 'Price saved'); viewSettings();
    }
    else if (a === 'tpl-use') {
      const t = chosenTpl(); if (!t) throw new Error('Choose a template first');
      $('#kind').value = t.kind; if (t.tone) $('#tone').value = t.tone; if (t.language) $('#language').value = t.language;
      $('#facts').value = t.facts; $('#kind').dispatchEvent(new Event('change'));
      toast(t.starter ? 'Template added. Fill in the [brackets], then draft.' : 'Template added. Check it, then draft.');
    }
    else if (a === 'tpl-save') {
      const facts = $('#facts').value.trim(); if (facts.length < 3 && !['progress', 'absence', 'late'].includes($('#kind').value)) throw new Error('Write the key facts first, then save them as a template');
      const cur = chosenTpl(); const name = prompt('Name this template (for example: Fee reminder, Term 2):', cur ? cur.title : ''); if (name === null || !name.trim()) return;
      const body = { title: name, kind: $('#kind').value, facts, tone: $('#tone').value, language: $('#language').value };
      const same = S.tpls.find((t) => t.title.toLowerCase() === name.trim().replace(/\s+/g, ' ').toLowerCase());
      let r;
      if (same) { if (!confirm('A template called "' + same.title + '" already exists. Replace it?')) return; r = await api('/templates/' + same.id, { method: 'PUT', body }); }
      else r = await api('/templates', { method: 'POST', body });
      await loadTpls('u:' + r.template.id); toast(same ? 'Template replaced' : 'Template saved');
    }
    else if (a === 'tpl-del') {
      const t = chosenTpl(); if (!t || t.starter) throw new Error('Choose one of your saved templates to delete. Starter templates cannot be deleted');
      if (!confirm('Delete the template "' + t.title + '"?')) return;
      await api('/templates/' + t.id, { method: 'DELETE' }); await loadTpls(); toast('Template deleted');
    }
    else if (a === 'draft') await draft();
    else if (a === 'group') { S.group = el.dataset.g; await refreshCounts(); viewMessages(); }
    else if (a === 'toggle-all') document.querySelectorAll('.msg .pick').forEach((c) => (c.checked = el.checked));
    else if (a === 'send') await send();
    else if (a === 'retry') await send([+msgEl.dataset.id]);
    else if (a === 'ask-approval') await askApproval();
    else if (a === 'ask-approval-one') await askApproval([+msgEl.dataset.id]);
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
    else if (a === 'cls-save') {
      const list = [...document.querySelectorAll('.cls-' + el.dataset.uid)].filter((x) => x.checked).map((x) => x.value);
      await api('/staff-classes/' + el.dataset.uid, { method: 'PUT', body: { classes: list } });
      toast(list.length ? 'Classes saved' : 'Saved: this teacher now sees every class'); await viewSettings();
    }
    else if (a === 'optin-on' || a === 'optin-new') {
      if (a === 'optin-new' && !confirm('Make a new link? The old link will stop working.')) return;
      await api('/optin/enable', { method: 'POST' }); toast('Link ready'); await viewSettings();
    }
    else if (a === 'optin-off') {
      if (!confirm('Turn off the opt-in link? Parents will no longer be able to use it.')) return;
      await api('/optin', { method: 'DELETE' }); toast('Link turned off'); await viewSettings();
    }
    else if (a === 'optin-copy') {
      const t = ($('#optinUrl') || {}).textContent || '';
      try { await navigator.clipboard.writeText(t); toast('Link copied'); } catch { toast('Select the link and copy it (Ctrl + C)', true); }
    }
    else if (a === 'optin-ignore') { await api('/optin/' + el.dataset.id + '/ignore', { method: 'POST' }); toast('Ignored'); await viewParents(); }
    else if (a === 'optin-approve') {
      try { await api('/optin/' + el.dataset.id + '/approve', { method: 'POST', body: {} }); }
      catch (e) {
        if (!/Type a class/.test(e.message)) throw e;
        const cls = (prompt('No parent has this phone number yet. Type the class to add this child to:', '') || '').trim();
        if (!cls) return;
        await api('/optin/' + el.dataset.id + '/approve', { method: 'POST', body: { class_name: cls } });
      }
      toast('Consent recorded'); await viewParents();
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
    else if (a === 'import-go') {
      const rows = S.importRows || []; if (!rows.length) return toast('Choose the file again', true);
      const r = await api('/contacts/import', { method: 'POST', body: { rows } }); S.importRows = null;
      toast(`${r.added} added, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped (row ${r.skipped[0].row}: ${r.skipped[0].reason})` : ''}`, !!r.skipped.length);
      S.classes = await api('/classes'); viewParents();
    }
    else if (a === 'import-cancel') { S.importRows = null; $('#importBox').innerHTML = ''; }
    else if (a === 'chist') { const d = await api('/contacts/' + rowEl.dataset.id + '/history'); $('#chistBox').innerHTML = parentHistory(d); }
    else if (a === 'chist-close') $('#chistBox').innerHTML = '';
    else if (a === 'batch-open') {
      const h = S.hist, id = +el.dataset.id;
      if (h.openId === id) { h.openId = null; h.detail = null; return renderHistory(); }
      h.detail = await api('/batches/' + id); h.openId = id; renderHistory();
    }
    else if (a === 'batch-retry') {
      if (!confirm('Send the failed messages of this batch again?')) return;
      const r = await api('/batches/' + el.dataset.id + '/retry', { method: 'POST' });
      if (r.quiet) return toast(`Not sent: quiet hours (${r.quiet.start} to ${r.quiet.end}, Nigerian time).`, true);
      toast(r.heldBack ? `Sending ${r.queued}. ${r.heldBack} held back by the daily limit of ${r.dailyLimit}.` : `Sending ${r.queued} message${r.queued === 1 ? '' : 's'} again…`, !!r.heldBack);
      await new Promise((ok) => setTimeout(ok, 1500)); S.hist.openId = null; S.hist.detail = null; await viewHistory();
    }
    else if (a === 'cpick-all') document.querySelectorAll('.cpick').forEach((c) => (c.checked = el.checked));
    else if (a === 'grp-add') {
      const ids = tickedParents(); if (!ids.length) return toast('Tick at least one parent first', true);
      const gid = +($('#grpSel').value || 0), name = ($('#grpName').value || '').trim();
      if (gid && name) return toast('Choose a group or type a new name, not both', true);
      if (!gid && !name) return toast('Choose a group or type a name for a new one', true);
      const r = await api('/groups/add', { method: 'POST', body: { contactIds: ids, ...(gid ? { groupId: gid } : { name }) } });
      toast(`${r.added} added to "${r.group.name}"${r.already ? `, ${r.already} already in it` : ''}`); viewParents($('#q').value);
    }
    else if (a === 'grp-remove') {
      const ids = tickedParents(); if (!ids.length) return toast('Tick at least one parent first', true);
      const r = await api('/groups/remove', { method: 'POST', body: { groupId: S.pgroup, contactIds: ids } });
      toast(`${r.removed} removed from the group`); viewParents($('#q').value);
    }
    else if (a === 'grp-del') {
      const g = S.groups.find((x) => x.id === +el.dataset.id);
      if (confirm(`Delete the group "${g ? g.name : ''}"? The parents themselves are not deleted.`)) {
        await api('/groups/' + el.dataset.id, { method: 'DELETE' });
        S.pickedG.delete(+el.dataset.id); if (S.pgroup === +el.dataset.id) S.pgroup = 0; viewParents($('#q').value);
      }
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
    if (e.target.closest('#actUser')) { S.act.user = +e.target.value || 0; await viewActivity(); return; }
    const as = e.target.closest('select.assign-sel');
    if (as) {
      const r = await api('/replies/assign', { method: 'POST', body: { id: +as.dataset.id, userId: as.value ? +as.value : null } });
      toast(r.assigned ? 'Given to ' + r.assigned : 'No longer given to anyone'); renderShell(); return;
    }
    if (e.target.closest('#grpFilter')) { S.pgroup = +e.target.value || 0; await viewParents($('#q').value); return; }
    const cs = e.target.closest('select.consent-sel');
    if (cs) {
      await api('/contacts/' + cs.closest('tr').dataset.id, { method: 'PUT', body: { consent_source: cs.value } });
      toast(cs.value ? 'Consent recorded' : 'Consent record cleared');
      viewParents($('#q').value);
      return;
    }
    const ta = e.target.closest('.msg textarea'); if (!ta) return;
    const id = +ta.closest('.msg').dataset.id;
    const saved = await api('/messages/' + id, { method: 'PUT', body: { body: ta.value } });
    const m = S.msgs.find((x) => x.id === id); if (m) { m.body = ta.value; m.ai = 0; }
    if (saved.approvalReset) { if (m) { m.approval_requested_at = null; m.approval_by = null; } await refreshCounts(); toast('Saved. You changed the text, so ask for approval again.'); viewMessages(); return; }
    toast('Saved');
  }));

  window.PCB = { toast, me: () => S.me, goto: (v) => setView(v), refresh: async () => { S.classes = await api('/classes'); await refreshCounts(); renderShell(); }, showDrafts: async () => { S.group = 'draft'; S.classes = await api('/classes'); await refreshCounts(); setView('messages'); } }; /* SM-CONNECTION */
  boot();
})();
