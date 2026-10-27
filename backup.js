'use strict';
// Automatic off-site backups to an S3-compatible bucket (Cloudflare R2). No outside packages needed.
//
// What it does, every day:  makes a consistent copy of the database while the app keeps running, checks the copy is
// healthy, compresses it (and locks it with your passphrase if you set one), uploads it, checks it arrived, and
// tidies old backups (keeps everything from the last 2 days, then one per day for 14 days, one per week for 8 weeks and
// one per month for 12 months).
//
// Nothing runs, and nothing fails loudly, until the BACKUP_S3_* settings exist (see configured()).
//
// Settings (environment variables, the same names Class Register uses):
//   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_REGION (auto)
//   BACKUP_ENCRYPTION_KEY   optional passphrase: backups are locked with it (keep it safe: without it they cannot be opened)
//   BACKUP_HOUR (2)         Lagos hour for the daily backup
//   BACKUP_INTERVAL_HOURS (24), BACKUP_KEEP_DAILY (14), BACKUP_KEEP_WEEKLY (8), BACKUP_KEEP_MONTHLY (12)

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const env = (k, d = '') => String(process.env[k] === undefined ? d : process.env[k]).trim();
const num = (k, d, min, max) => { const n = Number(env(k, String(d))); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };

function config() {
  let endpoint = env('BACKUP_S3_ENDPOINT');
  if (endpoint && !/^https?:\/\//i.test(endpoint)) endpoint = 'https://' + endpoint;   // the usual copy-paste slip
  endpoint = endpoint.replace(/\/+$/, '');
  return {
    endpoint, bucket: env('BACKUP_S3_BUCKET'), accessKey: env('BACKUP_S3_ACCESS_KEY_ID'), secret: env('BACKUP_S3_SECRET_ACCESS_KEY'),
    region: env('BACKUP_S3_REGION', 'auto') || 'auto', passphrase: env('BACKUP_ENCRYPTION_KEY'),
    hour: num('BACKUP_HOUR', 2, 0, 23), intervalHours: num('BACKUP_INTERVAL_HOURS', 24, 1, 168),
    keepDaily: num('BACKUP_KEEP_DAILY', 14, 1, 365), keepWeekly: num('BACKUP_KEEP_WEEKLY', 8, 0, 520), keepMonthly: num('BACKUP_KEEP_MONTHLY', 12, 0, 240),
  };
}
const configured = () => { const c = config(); return !!(c.endpoint && c.bucket && c.accessKey && c.secret); };

/* ================= S3 signing (AWS Signature Version 4) ================= */
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Returns the headers to send. `s3: true` = S3 rules (the path is encoded once; the body hash is sent as a header).
function signV4({ method, url, headers = {}, body = '', region, service = 's3', accessKey, secret, now = new Date(), s3 = true }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');            // 20260101T120000Z
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const h = { ...headers, host: u.host, 'x-amz-date': amzDate };
  if (s3) h['x-amz-content-sha256'] = payloadHash;
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const canonicalPath = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac('AWS4' + secret, day), kRegion = hmac(kDate, region), kService = hmac(kRegion, service), kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`, _signature: signature, _canonical: canonical, _toSign: toSign };
}

/* ================= a small S3 client (path-style: endpoint/bucket/key) ================= */
class S3Error extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
const friendly = (status, code, msg) => {
  if (code === 'SignatureDoesNotMatch') return 'The bucket did not accept the secret key. Check BACKUP_S3_SECRET_ACCESS_KEY for a typo or a stray space.';
  if (code === 'InvalidAccessKeyId') return 'The bucket does not recognise the access key. Check BACKUP_S3_ACCESS_KEY_ID.';
  if (code === 'NoSuchBucket') return 'The bucket was not found. Check BACKUP_S3_BUCKET (the name must be exactly the one you created).';
  if (code === 'AccessDenied' || status === 403) return 'The API token is not allowed to use this bucket. In Cloudflare, give the token "Object Read & Write" for this bucket.';
  return `The bucket answered with an error (${status}${code ? ' ' + code : ''})${msg ? ': ' + msg : ''}.`;
};
const xmlTag = (xml, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1] : null; };
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function s3(method, key, { query = '', body = '', contentType } = {}) {
  const c = config();
  if (!(c.endpoint && c.bucket && c.accessKey && c.secret)) throw new S3Error('Backups are not set up: the BACKUP_S3_* settings are missing.', 0, 'NotConfigured');
  try { new URL(c.endpoint); } catch (_) { throw new S3Error(`BACKUP_S3_ENDPOINT does not look like a web address: "${c.endpoint}". It should look like https://<account-id>.r2.cloudflarestorage.com`, 0, 'BadEndpoint'); }
  const url = `${c.endpoint}/${enc(c.bucket)}${key ? '/' + key.split('/').map(enc).join('/') : ''}${query ? '?' + query : ''}`;
  const hdrs = contentType ? { 'content-type': contentType } : {};
  const signed = signV4({ method, url, headers: hdrs, body, region: c.region, accessKey: c.accessKey, secret: c.secret });
  const send = Object.fromEntries(Object.entries(signed).filter(([k]) => !k.startsWith('_') && k !== 'host'));
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 120000);
  let r;
  try { r = await fetch(url, { method, headers: send, body: method === 'PUT' ? body : undefined, signal: ctrl.signal }); }
  catch (e) { throw new S3Error(e.name === 'AbortError' ? 'The bucket did not answer in time.' : `Could not reach the bucket (${e.cause && e.cause.code ? e.cause.code : e.message}). Check BACKUP_S3_ENDPOINT and the internet connection.`, 0, 'Network'); }
  finally { clearTimeout(timer); }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) { const t = buf.toString('utf8'); throw new S3Error(friendly(r.status, xmlTag(t, 'Code'), xmlTag(t, 'Message')), r.status, xmlTag(t, 'Code') || String(r.status)); }
  return { status: r.status, headers: r.headers, body: buf };
}
const put = (key, body, contentType = 'application/octet-stream') => s3('PUT', key, { body, contentType });
const head = (key) => s3('HEAD', key);
const get = async (key) => (await s3('GET', key)).body;
const del = (key) => s3('DELETE', key);
async function list(prefix) {
  const out = []; let token = null;
  for (let i = 0; i < 200; i++) {
    const q = `list-type=2&prefix=${enc(prefix)}${token ? '&continuation-token=' + enc(token) : ''}`;
    const xml = (await s3('GET', '', { query: q })).body.toString('utf8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) out.push({ key: unxml(xmlTag(m[1], 'Key')), size: Number(xmlTag(m[1], 'Size')), modified: xmlTag(m[1], 'LastModified') });
    if (xmlTag(xml, 'IsTruncated') === 'true' && xmlTag(xml, 'NextContinuationToken')) token = unxml(xmlTag(xml, 'NextContinuationToken')); else break;
  }
  return out;
}

/* ================= locking a backup with a passphrase (AES-256-GCM) ================= */
const MAGIC = Buffer.from('SCBK1');
function encrypt(buf, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, ct, c.getAuthTag()]);
}
function decrypt(buf, passphrase) {
  if (buf.subarray(0, 5).compare(MAGIC) !== 0) throw new Error('This file is not a locked backup.');
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(buf.length - 16), ct = buf.subarray(33, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(ct), d.final()]); } catch (_) { throw new Error('The passphrase is wrong, or the backup file is damaged.'); }
}

/* ================= which backups to keep ================= */
const STAMP = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/;
function stampOf(key) { const m = STAMP.exec(key); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null; }
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dn); const y = t.getUTCFullYear(); return `${y}-W${String(Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`; };
// keys = the backups of this product only. Returns the keys to keep: everything from the last 2 days, then the last one of each
// day, week and month, within the limits.
function chooseKeep(keys, { keepDaily, keepWeekly, keepMonthly }) {
  const items = keys.map((k) => ({ k, d: stampOf(k) })).filter((x) => x.d).sort((a, b) => b.d - a.d);   // newest first
  const keep = new Set(items.length ? [items[0].k] : []);                                                  // the newest is never removed
  for (const it of items) if (items[0].d - it.d <= 48 * 3600000) keep.add(it.k);                            // everything from the last two days stays (so a "back up now" before a risky change is never lost at once)
  for (const [limit, label] of [[keepDaily, (d) => d.toISOString().slice(0, 10)], [keepWeekly, isoWeek], [keepMonthly, (d) => d.toISOString().slice(0, 7)]]) {
    const seen = new Set();
    for (const it of items) { const b = label(it.d); if (seen.has(b)) continue; if (seen.size >= limit) break; seen.add(b); keep.add(it.k); }
  }
  return keep;
}

/* ================= the product plugs in here ================= */
let P = null;   // { slug, label, dbPath, snapshot(file), verify(file) }
const status = { running: false, lastRunAt: null, lastSuccessAt: null, lastError: null, lastKey: null, lastSizeBytes: null, history: [] };
const statusFile = () => (P && P.dbPath ? P.dbPath + '.backup-status.json' : null);
function saveStatus() { try { const f = statusFile(); if (f) fs.writeFileSync(f, JSON.stringify({ ...status, running: false })); } catch (_) { /* best effort */ } }
function loadStatus() { try { const f = statusFile(); if (f && fs.existsSync(f)) Object.assign(status, JSON.parse(fs.readFileSync(f, 'utf8')), { running: false }); } catch (_) { /* start fresh */ } }
const prefixOf = () => `${P.slug}-backups/`;
function init(product) { P = product; loadStatus(); return module.exports; }

function getStatus() {
  const c = config();
  return {
    product: P ? P.slug : null, label: P ? P.label : null, configured: configured(), encrypted: !!c.passphrase, bucket: c.bucket || null, prefix: P ? prefixOf() : null,
    running: status.running, lastRunAt: status.lastRunAt, lastSuccessAt: status.lastSuccessAt, lastError: status.lastError, lastKey: status.lastKey, lastSizeBytes: status.lastSizeBytes,
    hourAgo: status.lastSuccessAt ? Math.round((Date.now() - Date.parse(status.lastSuccessAt)) / 3600000) : null, hour: c.hour,
    retention: { daily: c.keepDaily, weekly: c.keepWeekly, monthly: c.keepMonthly },
  };
}

async function prune() {
  const c = config();
  const mine = (await list(prefixOf())).filter((o) => new RegExp(`^${prefixOf()}${P.slug}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\.db\\.gz(\\.enc)?$`).test(o.key));
  const keep = chooseKeep(mine.map((o) => o.key), c);
  let removed = 0;
  for (const o of mine) if (!keep.has(o.key)) { await del(o.key); removed++; }
  return removed;
}

async function runBackup({ reason = 'manual' } = {}) {
  if (!P) throw new Error('Backups are not initialised.');
  if (!configured()) { status.lastError = 'Backups are not set up: the BACKUP_S3_* settings are missing.'; throw new Error(status.lastError); }
  if (status.running) throw new Error('A backup is already running.');
  status.running = true; status.lastRunAt = new Date().toISOString();
  const tmp = path.join(os.tmpdir(), `${P.slug}-${process.pid}-${Date.now()}.db`);
  try {
    await P.snapshot(tmp);                                         // a consistent copy, safe while the app keeps running
    await P.verify(tmp);                                           // never upload a damaged copy
    let body = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    const c = config();
    if (c.passphrase) body = encrypt(body, c.passphrase);
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    const key = `${prefixOf()}${P.slug}-${stamp}.db.gz${c.passphrase ? '.enc' : ''}`;
    await put(key, body, 'application/octet-stream');
    const h = await head(key);                                     // did it really arrive, in full?
    if (Number(h.headers.get('content-length')) !== body.length) throw new Error(`The upload did not arrive in full (${h.headers.get('content-length')} of ${body.length} bytes).`);
    let removed = 0; try { removed = await prune(); } catch (e) { console.error('Backup tidy-up failed (the backup itself is safe):', e.message); }
    status.lastSuccessAt = new Date().toISOString(); status.lastError = null; status.lastKey = key; status.lastSizeBytes = body.length;
    status.history = [{ at: status.lastSuccessAt, key, size: body.length, reason }, ...status.history].slice(0, 10);
    saveStatus();
    return { key, sizeBytes: body.length, removed, encrypted: !!c.passphrase };
  } catch (e) {
    status.lastError = e.message || String(e); saveStatus(); throw e;
  } finally {
    status.running = false;
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch (_) { /* nothing to clean */ } }
  }
}

async function listBackups() {
  if (!configured()) return [];
  return (await list(prefixOf())).filter((o) => stampOf(o.key)).sort((a, b) => (a.key < b.key ? 1 : -1)).map((o) => ({ key: o.key, size: o.size, at: stampOf(o.key).toISOString(), locked: o.key.endsWith('.enc') }));
}

/* ================= the daily schedule ================= */
const lagosHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }).format(new Date())) % 24;
let timer = null;
function startSchedule() {
  if (!configured()) { console.log(`Automatic backups are not set up yet (BACKUP_S3_* settings missing). See BACKUPS.md.`); return; }
  const tick = () => {
    if (status.running) return;
    const c = config(), now = Date.now();
    const sinceOk = status.lastSuccessAt ? now - Date.parse(status.lastSuccessAt) : Infinity;
    const sinceTry = status.lastRunAt ? now - Date.parse(status.lastRunAt) : Infinity;
    const due = sinceOk >= c.intervalHours * 3600000 * 0.95;
    const goTime = sinceOk === Infinity || lagosHour() === c.hour || sinceOk >= c.intervalHours * 3600000 * 1.5;   // the first one straight away; then at the set hour; late ones catch up
    if (due && goTime && !(status.lastError && sinceTry < 30 * 60000)) runBackup({ reason: 'scheduled' }).then((r) => console.log(`Backup done: ${r.key} (${r.sizeBytes} bytes)`)).catch((e) => console.error('Scheduled backup failed:', e.message));
  };
  setTimeout(tick, Math.max(1000, num('BACKUP_FIRST_CHECK_SECONDS', 120, 1, 3600) * 1000)).unref();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, num('BACKUP_CHECK_MINUTES', 10, 1, 60) * 60000); timer.unref();
}

/* ================= restoring ================= */
const pendingPaths = (dbPath) => ({ flag: dbPath + '.restore-pending', file: dbPath + '.restored' });
// Called by the app BEFORE it opens its database. If a restore was staged, the old database is kept aside and the backup takes its place.
function applyPendingRestore(dbPath) {
  const { flag, file } = pendingPaths(dbPath);
  if (!fs.existsSync(flag)) return false;
  try {
    if (!fs.existsSync(file)) throw new Error('the restored file is missing');
    const fd = fs.openSync(file, 'r'); const hdr = Buffer.alloc(16); fs.readSync(fd, hdr, 0, 16, 0); fs.closeSync(fd);
    if (hdr.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('the restored file is not a database');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, `${dbPath}.before-restore-${stamp}${ext}`);
    fs.renameSync(file, dbPath);
    fs.unlinkSync(flag);
    console.log(`RESTORED the database from a backup. The previous database was kept as ${path.basename(dbPath)}.before-restore-${stamp}`);
    return true;
  } catch (e) {
    console.error('Restore could not be applied, so the current database is being used:', e.message);
    try { fs.unlinkSync(flag); } catch (_) { /* leave it */ }
    return false;
  }
}
// Used by restore-backup.js: download one backup, unlock it, check it, and leave it ready for the next start.
async function stageRestore(dbPath, which) {
  const keys = (await listBackups());
  if (!keys.length) throw new Error('There are no backups in the bucket yet.');
  const pick = which === 'latest' ? keys[0] : keys.find((k) => k.key === which || k.key.endsWith(which));
  if (!pick) throw new Error(`No backup called "${which}". Run the list command to see the names.`);
  let buf = await get(pick.key);
  if (pick.locked) { const pass = config().passphrase; if (!pass) throw new Error('This backup is locked. Set BACKUP_ENCRYPTION_KEY (the same passphrase that locked it) and try again.'); buf = decrypt(buf, pass); }
  const db = zlib.gunzipSync(buf);
  if (db.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('The downloaded file is not a database.');
  const { flag, file } = pendingPaths(dbPath);
  fs.writeFileSync(file + '.tmp', db); fs.renameSync(file + '.tmp', file);
  try { // a health check, when this Node has the built-in database
    const { DatabaseSync } = require('node:sqlite'); const t = new DatabaseSync(file, { readOnly: true });
    const r = t.prepare('PRAGMA integrity_check').all(); t.close();
    if (!r.length || r[0].integrity_check !== 'ok') throw new Error('The backup failed its health check.');
  } catch (e) { if (/health check/.test(e.message)) { fs.unlinkSync(file); throw e; } }
  fs.writeFileSync(flag, JSON.stringify({ key: pick.key, at: new Date().toISOString() }));
  return { key: pick.key, bytes: db.length };
}

module.exports = { init, configured, config, getStatus, runBackup, listBackups, startSchedule, applyPendingRestore, stageRestore, _t: { signV4, chooseKeep, encrypt, decrypt, stampOf, isoWeek, s3, put, head, get, del, list, S3Error } };
