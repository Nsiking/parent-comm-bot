'use strict';
/* Forgot-your-password screens, and the "Email for password reset" status card.
   Works in Report Cards and the Parent Bot. It draws only its own screens and never changes the product's own code,
   so an update to app.js cannot switch it off. Nothing appears until the server has email set up. */
(function () {
  var opts = null, loading = false, denied = false, statusData = null, statusAt = 0, msg = null, busy = false;
  var EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19C5.6 19 2 12 2 12a18.4 18.4 0 0 1 4.1-5"/><path d="M9.9 4.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>';
  var INPUT = 'width:100%;box-sizing:border-box;padding:.62rem .7rem;border:1px solid #c9d3cd;border-radius:8px;font:inherit;background:#fff;color:inherit';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; } return d; }); });
  }
  function pwBox(id, label) {
    return '<label style="display:block;margin:.7rem 0 0"><span style="display:block;font-weight:600;font-size:.9rem;margin-bottom:.25rem">' + label + '</span><span style="position:relative;display:block"><input id="' + id + '" type="password" minlength="8" autocomplete="new-password" required style="' + INPUT + ';padding-right:46px"><button type="button" data-rseye="' + id + '" aria-label="Show password" aria-pressed="false" title="Show password" style="position:absolute;top:0;right:0;height:100%;width:44px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;padding:0;cursor:pointer;color:#5a6b62">' + EYE + '</button></span></label>';
  }
  function bindEyes(root) {
    root.querySelectorAll('[data-rseye]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        var i = document.getElementById(b.getAttribute('data-rseye')), show = i.type === 'password';
        i.type = show ? 'text' : 'password'; b.innerHTML = show ? EYE_OFF : EYE; var t = show ? 'Hide password' : 'Show password'; b.setAttribute('aria-label', t); b.title = t; b.setAttribute('aria-pressed', show ? 'true' : 'false');
        if (ev.detail !== 0) i.focus();
      });
    });
  }

  /* ---------------- the screens, drawn inside the sign-in card ---------------- */
  function card() { return document.querySelector('.loginwrap .logincard, .auth-card'); }
  function title(t) { return '<h1 style="font-size:1.4rem;margin:0 0 .4rem">' + t + '</h1>'; }
  var foot = '<p style="margin:1rem 0 0;font-size:.92rem"><a href="#" id="rsback" style="color:inherit;text-decoration:underline">Back to log in</a></p>';
  function field(id, label, type, extra) { return '<label style="display:block;margin:.7rem 0 0"><span style="display:block;font-weight:600;font-size:.9rem;margin-bottom:.25rem">' + label + '</span><input id="' + id + '" type="' + type + '" required style="' + INPUT + '" ' + (extra || '') + '></label>'; }
  function wireBack(c) { var b = c.querySelector('#rsback'); if (b) b.addEventListener('click', function (e) { e.preventDefault(); location.reload(); }); }

  function showForgot(prefill) {
    var c = card(); if (!c) return;
    c.innerHTML = title('Reset your password') + '<p style="margin:0 0 .6rem;color:#5a6b62">Enter your email address. We will email you a 6-digit code.</p><form id="rsf" novalidate>' + field('rsemail', 'Email', 'email', 'autocomplete="username" autocapitalize="none"') +
      '<p id="rserr" role="alert" hidden style="color:#b42318;margin:.6rem 0 0"></p><button class="btn" type="submit" style="margin-top:.9rem;width:100%">Send me a code</button></form>' + foot;
    wireBack(c); var inp = c.querySelector('#rsemail'); inp.value = prefill || ''; inp.focus();
    c.querySelector('#rsf').addEventListener('submit', function (e) {
      e.preventDefault(); var err = c.querySelector('#rserr'), btn = c.querySelector('button[type=submit]'); err.hidden = true; btn.disabled = true;
      var email = inp.value.trim();
      api('POST', '/api/reset/forgot', { email: email }).then(function (r) { showReset(email, r.minutes); }, function (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; });
    });
  }
  function showReset(email, minutes) {
    var c = card(); if (!c) return;
    c.innerHTML = title('Enter your code') + '<p style="margin:0 0 .6rem;color:#5a6b62">If an account matches <b>' + esc(email) + '</b>, a 6-digit code was sent. It works for ' + (minutes || 15) + ' minutes. Nothing arrived? Check the spelling and the Spam folder, wait a minute, or ask again.</p><form id="rsr" novalidate>' +
      field('rscode', '6-digit code', 'text', 'inputmode="numeric" maxlength="7" autocomplete="one-time-code"') + pwBox('rsp1', 'New password (at least 8 characters)') + pwBox('rsp2', 'New password again') +
      '<p id="rserr" role="alert" hidden style="color:#b42318;margin:.6rem 0 0"></p><button class="btn" type="submit" style="margin-top:.9rem;width:100%">Change my password</button></form><p style="margin:1rem 0 0;font-size:.92rem"><a href="#" id="rsagain" style="color:inherit;text-decoration:underline">Send a new code</a> · <a href="#" id="rsback" style="color:inherit;text-decoration:underline">Back to log in</a></p>';
    wireBack(c); bindEyes(c); c.querySelector('#rscode').style.letterSpacing = '.2em'; c.querySelector('#rscode').focus();
    c.querySelector('#rsagain').addEventListener('click', function (e) { e.preventDefault(); showForgot(email); });
    c.querySelector('#rsr').addEventListener('submit', function (e) {
      e.preventDefault(); var err = c.querySelector('#rserr'), btn = c.querySelector('button[type=submit]'); err.hidden = true;
      if (c.querySelector('#rsp1').value !== c.querySelector('#rsp2').value) { err.textContent = 'The two passwords are not the same'; err.hidden = false; return; }
      btn.disabled = true;
      api('POST', '/api/reset/confirm', { email: email, code: c.querySelector('#rscode').value, new_password: c.querySelector('#rsp1').value }).then(function () { showDone(); }, function (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; });
    });
  }
  function showDone() {
    var c = card(); if (!c) return;
    c.innerHTML = title('Password changed') + '<p style="margin:0 0 1rem">Your password was changed. Log in with the new password.</p><button class="btn" id="rsgo" type="button" style="width:100%">Log in</button>';
    c.querySelector('#rsgo').addEventListener('click', function () { location.reload(); });
  }

  /* ---------------- the "Forgot your password?" link on the sign-in form ---------------- */
  function loadOpts() {
    if (loading || opts !== null) return; loading = true;
    api('GET', '/api/reset/options').then(function (o) { opts = o || {}; }, function () { opts = {}; }).then(function () { loading = false; schedule(); });
  }
  function injectLink() {
    var f = document.getElementById('loginForm') || document.getElementById('authForm');
    if (!f || f.querySelector('input[name=schoolName]') || document.getElementById('fplink')) return;
    if (opts === null) return loadOpts();
    if (!opts.email) return;
    var who = document.getElementById('loginForm') ? 'Head Teacher' : 'school administrator';
    var p = document.createElement('p'); p.id = 'fplink'; p.style.cssText = 'margin:.8rem 0 0;font-size:.92rem'; p.innerHTML = 'Forgot your password? <a href="#" id="fpgo" style="color:inherit;font-weight:600;text-decoration:underline">Get a code by email</a>, or ask your ' + who + ' to reset it.';
    f.insertAdjacentElement('afterend', p);
    // the product's own "Forgot your password? Ask your ... to reset it." line is now covered by this one, so show it only once
    document.querySelectorAll('.loginwrap p, .auth-card p').forEach(function (q) { if (q !== p && /Forgot your password\?/.test(q.textContent)) q.style.display = 'none'; });
    p.querySelector('#fpgo').addEventListener('click', function (e) { e.preventDefault(); var em = f.querySelector('input[name=email]'); showForgot(em ? em.value : ''); });
  }

  /* ---------------- the status card for the person who runs the server's settings ---------------- */
  function place() {
    if (window.PCB && window.PCB.me && window.PCB.me()) {                                   // Parent Bot: the owner, on Settings
      var v = document.getElementById('view'), h = v && v.querySelector('h1');
      return h && h.textContent.trim() === 'Settings' ? { host: v, cls: 'card', h: 'h3' } : null;
    }
    if (typeof A !== 'undefined' && A && A.view) {                                          // Report Cards: the platform admin
      var m = document.getElementById('main');
      return A.view === 'platform' && A.me && A.me.role === 'super_admin' && m ? { host: m, cls: 'panel', h: 'h2' } : null;
    }
    return null;
  }
  function pill(text, colour) { var c = { green: '52,168,83', amber: '230,150,20' }[colour]; return '<span style="display:inline-block;padding:.1rem .6rem;border-radius:999px;border:1px solid rgba(' + c + ',.7);background:rgba(' + c + ',.16);font-size:.85em;font-weight:600">' + text + '</span>'; }
  function statusHTML(p, d) {
    var e = d.email, out = '<' + p.h + ' style="margin-top:0">Email for password reset</' + p.h + '>';
    out += '<p style="margin:.4rem 0">' + (e.ready ? pill('Ready', 'green') : pill('Not set up', 'amber')) + '</p>';
    if (!e.ready) return out + '<p style="margin:.4rem 0">Password reset by email is off. In the server settings (Render, Environment) these are missing: <b>' + e.missing.map(esc).join(', ') + '</b>. The guide is in <b>PASSWORD_RESET.md</b>.</p>';
    out += '<p style="margin:.4rem 0">Provider: <b>' + esc(e.provider) + '</b> · Sending address: <b>' + esc(e.from) + '</b></p>';
    out += '<form id="rstest" style="margin:.6rem 0 0"><label style="display:block"><span style="display:block;font-weight:600;font-size:.9rem;margin-bottom:.25rem">Send a test email to</span><input id="rstestto" type="email" value="' + esc(d.you || '') + '" style="' + INPUT + '"></label><div style="margin-top:.6rem"><button class="btn" type="submit"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Sending…' : 'Send test email') + '</button></div></form>';
    if (msg) out += '<p style="margin:.6rem 0 0;font-weight:600;color:' + (msg.bad ? '#b42318' : '#17805f') + '">' + esc(msg.text) + '</p>';
    return out;
  }
  function paintStatus() {
    var p = place(); if (!p || denied || !statusData) return;
    var el = document.getElementById('rscard'), inner = statusHTML(p, statusData);
    if (!el) { el = document.createElement('div'); el.id = 'rscard'; el.className = p.cls; el.style.marginTop = '1rem'; p.host.appendChild(el); } else if (el.getAttribute('data-sig') === inner) return;
    el.setAttribute('data-sig', inner); el.innerHTML = inner;
    var f = document.getElementById('rstest');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault(); busy = true; msg = null; var to = document.getElementById('rstestto').value.trim(); paintStatus();
      api('POST', '/api/reset/test-email', { to: to }).then(function (r) { msg = { text: 'Sent to ' + r.to + '. Check the inbox (and Spam). It usually takes under a minute.' }; }, function (x) { msg = { text: x.message, bad: true }; }).then(function () { busy = false; paintStatus(); });
    });
  }
  function refreshStatus() {
    if (denied || !place() || document.getElementById('rscard')) return;
    if (statusData && Date.now() - statusAt < 60000) return paintStatus();
    api('GET', '/api/reset/status').then(function (d) { statusData = d; statusAt = Date.now(); paintStatus(); }, function (e) { if (e.status === 401 || e.status === 403 || e.status === 404) denied = true; });
  }

  var pending = false;
  function schedule() { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; try { injectLink(); refreshStatus(); } catch (e) { /* the page is still starting */ } }); }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
