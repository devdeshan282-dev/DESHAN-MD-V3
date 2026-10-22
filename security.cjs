'use strict';
// security.cjs — zero-dependency security layer for the DESHANxMini movie-site API (pair.js router).
// CommonJS on purpose: pair.js uses require(). Replaces the earlier security.js draft.
//
// Railway variables:
//   ADMIN_PASSWORD   12+ chars, required (admin endpoints are DISABLED without it, no default)
//   PANEL_PASSWORD   12+ chars, required for /settings panel API (disabled without it)
//   ALERT_NUMBER     your personal WhatsApp number, digits only (alerts go here)
//   ALLOWED_ORIGIN   optional, comma-separated site origins. Unset = "*" like before.
//   TRUSTED_PROXY_HOPS optional, default 1 (Railway edge proxy)

const crypto = require('crypto');

// ───────────────────────── client IP (spoof-proof) ─────────────────────────
// The OLD code used the FIRST X-Forwarded-For entry, which the client controls, so any
// rate limit keyed on it could be bypassed with a fake header. The proxy APPENDS the real
// IP at the end, so we read from the right.
const HOPS = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10) || 1);
function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff[Math.max(0, xff.length - HOPS)];
  return String((req.socket && req.socket.remoteAddress) || req.ip || 'unknown').replace(/^::ffff:/, '');
}

// ───────────────────────── validators / sanitizers ─────────────────────────
// Strips control chars, bidi/zero-width tricks, @mentions and WhatsApp formatting (* _ ~ `)
const CLEAN = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩@*_~`]/g;
function cleanText(v, max = 80) {
  return String(v == null ? '' : v).replace(CLEAN, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function nameOf(v) {
  return String(v == null ? '' : v).normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} .\-‍]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}
const QUALITIES = ['SD', 'HD', 'FHD 1080p', '4K', '240p', '480p', '720p'];
function quality(v, def = 'HD') { return QUALITIES.includes(v) ? v : def; }
// Sri Lanka WhatsApp number → "94XXXXXXXXX" or null
function phone(v) {
  let p = String(v == null ? '' : v).replace(/\D/g, '');
  if (p.startsWith('0')) p = '94' + p.slice(1);
  return /^94\d{9}$/.test(p) ? p : null;
}
const YT = /^https:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{6,15}([&?#][^\s]*)?$/;
function isYoutubeUrl(u) { return YT.test(String(u || '')); }
function pickKeys(obj, allowed) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : String(v == null ? '' : v).slice(0, 500);
  }
  return out;
}

// ───────────────────────── "known URL" cache ─────────────────────────
// Remember every string the SEARCH endpoints returned; later accept only those values from
// the client. Blocks SSRF (e.g. img = http://169.254.169.254/...) and arbitrary-URL downloads.
function makeKnown(max = 5000, ttl = 30 * 60e3) {
  const m = new Map();
  const prune = () => { const now = Date.now(); for (const [k, e] of m) if (e < now) m.delete(k); };
  const add = s => {
    if (typeof s !== 'string' || !s || s.length > 700) return;
    if (m.size >= max) prune();
    if (m.size < max) m.set(s, Date.now() + ttl);
  };
  const walk = (v, d = 0) => {
    if (d > 6 || v == null) return;
    if (typeof v === 'string') return add(v);
    if (typeof v === 'object') for (const x of Object.values(v)) walk(x, d + 1);
  };
  return { addAll: walk, add, has: s => { const e = m.get(String(s)); return !!e && e > Date.now(); } };
}

// ───────────────────────── server-side catalog ─────────────────────────
// Keeps OUR copy of every search result (keyed by url). Request endpoints take the title,
// poster, year, genres... from here, never from the browser, so a tampered POST cannot put
// its own text on the group card.
function makeCatalog(max = 3000, ttl = 30 * 60e3) {
  const m = new Map();
  const prune = () => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };
  return {
    set(url, item) {
      if (typeof url !== 'string' || !url || url.length > 700 || !item) return;
      if (m.size >= max) prune();
      if (m.size < max) m.set(url, { exp: Date.now() + ttl, item });
    },
    get(url) { const v = m.get(String(url)); return v && v.exp > Date.now() ? v.item : null; },
  };
}
// Same list-finding and field-picking rules the website uses (movie-request.html: listOf / normalize)
function extractMovieItems(data) {
  const pick = (o, keys, d) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return d; };
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    for (const k of ['result', 'results', 'data', 'movies', 'items']) {
      if (Array.isArray(data[k])) { list = data[k]; break; }
      if (data[k] && Array.isArray(data[k].results)) { list = data[k].results; break; }
    }
  }
  return list.filter(it => it && typeof it === 'object').map(it => ({
    title:   String(pick(it, ['title', 'name', 'movie_title'], '')).replace(/\s*Sinhala\s*Subtitle.*$/i, '').replace(/\s*\|.*$/, '').trim() || 'Untitled',
    img:     String(pick(it, ['img', 'image', 'poster', 'thumbnail', 'thumb', 'cover'], '')),
    url:     String(pick(it, ['url', 'link', 'download_url', 'page_url', 'href'], '')),
    date:    String(pick(it, ['date', 'year', 'release_date', 'releaseYear'], '')),
    genres:  Array.isArray(it.genres) ? it.genres.join(', ') : String(pick(it, ['genres', 'genre', 'category'], '')),
    imdb:    String(pick(it, ['imdb', 'rating', 'imdb_rating'], '')),
    runtime: String(pick(it, ['runtime', 'duration'], '')),
  }));
}

// ───────────────────────── rate limiting ─────────────────────────
function makeLimiter(windowMs, max, message) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, a] of hits) { const f = a.filter(t => now - t < windowMs); f.length ? hits.set(k, f) : hits.delete(k); }
  }, windowMs).unref();
  return (req, res, next) => {
    const k = req.cip || clientIp(req), now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ success: false, message: message || 'Too many requests. පස්සේ try කරන්න.' });
    }
    arr.push(now); hits.set(k, arr); next();
  };
}
const only = (method, mw) => (req, res, next) => (req.method === method ? mw(req, res, next) : next());

// Per-phone throttle so the bot cannot be used to spam one victim's WhatsApp
const sentTo = new Map();
function allowSendToPhone(p, max = 3, windowMs = 3600e3) {
  const now = Date.now();
  const arr = (sentTo.get(p) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now); sentTo.set(p, arr); return true;
}

// ───────────────────────── CORS ─────────────────────────
function cors(req, res, next) {
  const list = String(process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!list.length) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && list.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Adult-Key,X-Admin-Password,X-Req-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ───────────────────────── password checks (fail-closed) ─────────────────────────
const fails = new Map(); // ip → { n, until }
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function checkSecret(req, res, envName, given, shape) {
  const ip = req.cip || clientIp(req);
  const reply = (code, msg) => res.status(code).json(shape === 'error' ? { error: msg } : { success: false, message: msg });
  const expected = String(process.env[envName] || '').trim();
  if (expected.length < 12) { reply(503, `Disabled: set ${envName} (12+ characters) in Railway Variables.`); return false; }
  const f = fails.get(ip);
  if (f && f.until > Date.now()) { reply(429, 'Locked. පස්සේ try කරන්න.'); return false; }
  if (crypto.timingSafeEqual(sha(given == null ? '' : given), sha(expected))) { fails.delete(ip); return true; }
  const n = ((f && f.n) || 0) + 1;
  fails.set(ip, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 3600e3 : 0 }); // 5 misses → 1 hour lock
  reportIncident(req, `${envName} attempt failed`, {}, n >= 5);
  reply(401, 'Wrong password');
  return false;
}
const adminCheck = (req, res) => checkSecret(req, res, 'ADMIN_PASSWORD', (req.body && req.body.password) || req.headers['x-admin-password'], 'msg');
const panelCheck = (req, res, given) => checkSecret(req, res, 'PANEL_PASSWORD', given, 'error');

// ───────────────────────── intrusion detection + owner alerts ─────────────────────────
let alertSender = null;
function setAlertSender(fn) { alertSender = typeof fn === 'function' ? fn : null; }

const strikes = new Map();   // ip → { n, bannedUntil }
const lastAlert = new Map(); // ip → ts
const hourly = { start: Date.now(), n: 0 };
const BAN_MS = 24 * 3600e3, MAX_STRIKES = 3;

const RULES = [
  ['NoSQL injection',      /\$(ne|gt|gte|lt|lte|in|nin|or|and|nor|where|regex|expr)\b/i],
  ['SQL injection',        /(['"]|%27)\s*(or|and)\s+['"\d]|union\s+(all\s+)?select|;\s*drop\s+table|sleep\s*\(\s*\d/i],
  ['XSS attempt',          /<\s*script|javascript:|onerror\s*=|onload\s*=|<\s*(img|svg|iframe)[^>]*>/i],
  ['Path traversal',       /\.\.[\/\\]|%2e%2e|\/etc\/passwd|\/proc\/self/i],
  ['SSRF / internal host', /https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]|metadata\.)/i],
  ['Command injection',    /(\|\||&&|;|\|)\s*(cat|ls|curl|wget|bash|sh|nc|rm|powershell|python|node)\b|\$\([^)]*\)/i],
  ['Prototype pollution',  /__proto__|constructor\s*\.\s*prototype/i],
];
const dec = s => { try { return decodeURIComponent(s); } catch (_) { return String(s); } };

function scan(value, valuesToo, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') {
    if (!valuesToo) return null;
    const s = value.length > 2000 ? value.slice(0, 2000) : value;
    for (const [name, re] of RULES) if (re.test(s) || re.test(dec(s))) return name;
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__') return 'NoSQL / prototype key';
      const hit = scan(k, valuesToo, depth + 1) || scan(v, valuesToo, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
const redact = (o, d = 0) => {
  if (d > 3 || o == null || typeof o !== 'object') return o;
  const out = Array.isArray(o) ? [] : {};
  for (const [k, v] of Object.entries(o)) out[k] = /pass|key|token|secret/i.test(k) ? '[redacted]' : redact(v, d + 1);
  return out;
};

// persistent bans (pair.js supplies a MongoDB store so bans survive redeploys)
let banStore = null;
function persist(ip, s, reason) {
  if (banStore && banStore.save) Promise.resolve().then(() => banStore.save({ ip, until: s.bannedUntil, level: s.level, reason: String(reason).slice(0, 100) })).catch(() => {});
}
function setBanStore(store) {
  banStore = store;
  const tryLoad = async () => {
    try {
      const rows = await store.loadAll();
      for (const r of rows) {
        const cur = strikes.get(r.ip) || { n: 0, last: 0 };
        strikes.set(r.ip, { n: cur.n || 0, last: cur.last || 0, bannedUntil: Math.max(cur.bannedUntil || 0, r.until || 0), level: Math.max(cur.level || 0, r.level || 0) });
      }
      console.log(`[SECURITY] loaded ${rows.length} saved IP ban(s)`);
    } catch (_) { setTimeout(tryLoad, 60e3).unref(); } // Mongo not ready yet → retry
  };
  tryLoad();
}

function sendAlert(text) {
  if (alertSender) Promise.resolve().then(() => alertSender(text)).catch(() => {});
  if (process.env.ALERT_WEBHOOK_URL && typeof fetch === 'function') {
    fetch(process.env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: String(text).slice(0, 1900) }) }).catch(() => {});
  }
}
const allowIps = () => String(process.env.ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean); // your own IPs: never struck/banned
// repeat offenders get longer bans: 24h → 7 days → 30 days (not forever: mobile carriers share IPs between many people)
const BAN_STEPS = [24 * 3600e3, 7 * 24 * 3600e3, 30 * 24 * 3600e3];
const BAN_LABEL = ['24 hours', '7 days', '30 days'];
const surge = [];
const lock = { until: 0, manual: false };
const lockdownOn = () => lock.manual || lock.until > Date.now();

function reportIncident(req, reason, data = {}, banNow = false, countStrike = true) {
  const ip = req.cip || clientIp(req);
  if (allowIps().includes(ip)) return;
  const now = Date.now();
  const s = strikes.get(ip) || { n: 0, bannedUntil: 0, last: 0, level: 0 };
  if (now - (s.last || 0) > 3600e3 && s.bannedUntil < now) s.n = 0; // old strikes expire after an hour
  if (countStrike) {
    s.n += 1; s.last = now;
    // many different IPs misbehaving at once = coordinated attack → pause the request endpoints for 10 minutes
    surge.push({ t: now, ip });
    while (surge.length && now - surge[0].t > 300e3) surge.shift();
    if (surge.length >= 40 && new Set(surge.map(x => x.ip)).size >= 8 && lock.until < now && !lock.manual) {
      lock.until = now + 10 * 60e3;
      sendAlert('🛑 AUTO LOCKDOWN: many IPs are attacking at the same time. Request endpoints are paused for 10 minutes. Check the Railway logs.');
    }
  }
  let banLabel = '';
  if (banNow || s.n >= MAX_STRIKES) {
    s.level = Math.min((s.level || 0) + 1, BAN_STEPS.length);
    s.n = 0;
    s.bannedUntil = now + BAN_STEPS[s.level - 1];
    banLabel = BAN_LABEL[s.level - 1];
    persist(ip, s, reason);
  }
  strikes.set(ip, s);

  const url = cleanText(req.originalUrl || req.url, 100);
  let snippet = '';
  try { snippet = cleanText(JSON.stringify(redact(data)), 200); } catch (_) {}
  console.warn(`[SECURITY] ${reason} | ip=${ip} | ${req.method} ${url} | strikes=${s.n}${banLabel ? ' BANNED ' + banLabel : ''}`);

  // alert throttle: normal 1 per IP / 5 min and 10 per hour; ban alerts always go out (up to 25 per hour)
  if (now - hourly.start > 3600e3) { hourly.start = now; hourly.n = 0; }
  if (banLabel ? hourly.n >= 25 : (hourly.n >= 10 || now - (lastAlert.get(ip) || 0) < 300e3)) return;
  lastAlert.set(ip, now); hourly.n += 1;

  const ua = cleanText(req.headers && req.headers['user-agent'], 100);
  const org = cleanText((req.headers && (req.headers.origin || req.headers.referer)) || '-', 80);
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' });
  sendAlert(
`🚨 SECURITY ALERT
Type: ${reason}
IP: ${ip}
Strikes: ${s.n}${banLabel ? ` → BANNED ${banLabel} (offence #${s.level})` : ''}
Request: ${req.method} ${url}
User-Agent: ${ua}
Origin: ${org}
Data: ${snippet || '-'}
Time: ${when}`);
}

// Banned clients are not told "403": we keep the connection hanging for 20 s and then cut it (tarpit),
// which wastes an attacker's time. Capped at 40 parked sockets so it can never hurt the server.
let tarpit = 0;
function banCheck(req, res, next) {
  const s = strikes.get(req.cip || clientIp(req));
  if (!(s && s.bannedUntil > Date.now())) return next();
  if (tarpit < 40 && req.socket && req.socket.once) {
    tarpit++;
    let released = false;
    const release = () => { if (!released) { released = true; tarpit--; } };
    req.socket.once('close', release);
    setTimeout(() => { try { req.socket.destroy(); } catch (_) {} release(); }, 20e3).unref();
    return;
  }
  return res.status(403).end();
}
function lockdownGuard(req, res, next) {
  if (lockdownOn() && req.method === 'POST' && /^\/request-/.test(req.path))
    return res.status(503).json({ success: false, message: 'ටිකක් busy. විනාඩි කීපයකින් ආයෙ try කරන්න.' });
  next();
}
const ADMIN_KNOWN = ['/admin/cartoon-unlock', '/admin/issue-key', '/admin/revoke-key', '/admin/unban', '/admin/lockdown', '/admin/bans'];
const notFound = new Map(); // ip → timestamps of 404s (scanners enumerate paths)
function noteNotFound(req) {
  const ip = req.cip || clientIp(req), now = Date.now();
  const a = (notFound.get(ip) || []).filter(x => now - x < 300e3);
  a.push(now); notFound.set(ip, a);
  if (a.length === 15) reportIncident(req, 'Scanning: many 404 responses in 5 minutes', {});
}

function intrusionGuard(req, res, next) {
  const valuesToo = !/^\/(api\/)?settings/.test(req.path); // owner panel text may contain anything; keys are still checked
  const hit = scan(dec(req.path), true) || scan(req.query, valuesToo) || scan(req.body, valuesToo);
  if (!hit) return next();
  reportIncident(req, hit, { query: req.query, body: req.body });
  return res.status(403).json({ success: false, message: 'Forbidden.' });
}
const HONEYPOTS = ['/admin', '/admin/login', '/administrator', '/wp-login.php', '/wp-admin', '/xmlrpc.php', '/.env',
  '/.git/config', '/phpmyadmin', '/pma', '/server-status', '/actuator/env', '/config.json', '/backup.zip', '/db.sql',
  '/debug', '/api/admin'];

setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of strikes) if (s.bannedUntil < now && now - (lastAlert.get(ip) || 0) > 3600e3 && ((s.level || 0) === 0 || now - s.bannedUntil > 30 * 24 * 3600e3)) strikes.delete(ip);
  for (const [ip, a] of notFound) if (!a.some(x => now - x < 300e3)) notFound.delete(ip);
  for (const [ip, t] of lastAlert) if (now - t > 3600e3) lastAlert.delete(ip);
  for (const [ip, f] of fails) if (f.until < now && !f.n) fails.delete(ip);
}, 30 * 60e3).unref();

// ───────────────────────── human check (stops curl / scripts) ─────────────────────────
// Mode 1: Cloudflare Turnstile (set TURNSTILE_SITEKEY + TURNSTILE_SECRET). A script cannot get a token.
// Mode 2 (fallback, no setup): signed session token bound to IP + browser, from GET /session.
// Every failed check is a strike: 3 strikes in an hour = 24h IP ban + WhatsApp alert.
const https = require('https');
function postForm(url, params, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const rq = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (rs) => {
      let d = '';
      rs.on('data', c => { d += c; if (d.length > 20000) rq.destroy(); });
      rs.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    rq.on('timeout', () => rq.destroy());
    rq.on('error', () => resolve(null));
    rq.write(body); rq.end();
  });
}
let turnstileVerify = async (token, ip) => {
  if (!token || typeof token !== 'string' || token.length > 4096) return false;
  const r = await postForm('https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { secret: process.env.TURNSTILE_SECRET, response: token, remoteip: ip || '' });
  return !!(r && r.success);
};
const turnstileOn = () => !!(process.env.TURNSTILE_SECRET && process.env.TURNSTILE_SITEKEY);

const BOOT_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'); // random per boot is fine
const uaTag = req => crypto.createHash('sha256').update(String((req.headers && req.headers['user-agent']) || '')).digest('hex').slice(0, 16);
const macOf = (ip, ua, exp) => crypto.createHmac('sha256', BOOT_SECRET).update(`${ip}|${ua}|${exp}`).digest('hex').slice(0, 40);
function issueToken(req) { const exp = Date.now() + 30 * 60e3; return `${exp}.${macOf(req.cip || clientIp(req), uaTag(req), exp)}`; }
function checkToken(req, tok) {
  const [e, m] = String(tok || '').split('.');
  const exp = Number(e);
  if (!exp || exp < Date.now() || !m) return false;
  const want = Buffer.from(macOf(req.cip || clientIp(req), uaTag(req), exp)), got = Buffer.from(m);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function sessionHandler(req, res) {
  if (turnstileOn()) return res.json({ mode: 'turnstile', sitekey: process.env.TURNSTILE_SITEKEY });
  return res.json({ mode: 'token', token: issueToken(req) });
}
async function humanCheck(req, res, next) {
  let ok = false;
  try {
    ok = turnstileOn() ? await turnstileVerify(req.body && req.body.cf_token, req.cip) : checkToken(req, req.headers['x-req-token']);
  } catch (_) {}
  if (ok) return next();
  const hadToken = !!((req.body && req.body.cf_token) || req.headers['x-req-token']);
  reportIncident(req, (hadToken ? 'Invalid / expired human-check token' : turnstileOn() ? 'Request without CAPTCHA (curl / script)' : 'Request without session token (curl / script)'),
    { hadToken }, false, !hadToken);   // no token at all = script signature = strike; a stale token is only alerted
  return res.status(403).json({ success: false, message: 'Human check fail උනා. Page එක refresh කරලා ආයෙ try කරන්න.' });
}

// ───────────────────────── mount on the router ─────────────────────────
function applySecurity(router, { express } = {}) {
  router.use((req, res, next) => {
    req.cip = clientIp(req);
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (/^\/(api\/|admin\/)/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(banCheck);
  router.use((req, res, next) => {
    res.on('finish', () => { if (res.statusCode === 404) noteNotFound(req); });
    if (/^\/admin\//.test(req.path) && !ADMIN_KNOWN.includes(req.path)) {
      reportIncident(req, 'Probing unknown admin path', { path: req.path });
      return res.status(404).send('Not found');
    }
    next();
  });
  router.use(lockdownGuard);
  router.get('/session', makeLimiter(60e3, 20), sessionHandler);

  const lim = {
    search:   makeLimiter(60e3, 30),
    episodes: makeLimiter(60e3, 20),
    request:  makeLimiter(600e3, 8, 'ගොඩක් requests. විනාඩි ටිකකින් try කරන්න.'),
    key:      makeLimiter(900e3, 10, 'Key attempts වැඩියි. පස්සේ try කරන්න.'),
    admin:    makeLimiter(900e3, 10),
    panel:    makeLimiter(900e3, 15),
    pair:     makeLimiter(600e3, 5, 'Pairing requests වැඩියි. පස්සේ try කරන්න.'),
  };
  router.use(['/movie-search', '/kdrama-search', '/cartoon-search', '/song-search', '/adult-search'], lim.search);
  router.use(['/kdrama-episodes', '/cartoon-episodes'], lim.episodes);
  router.use(['/request-movie', '/request-kdrama', '/request-cartoon', '/request-song', '/request-adult'], only('POST', lim.request));
  router.use('/verify-adult-key', only('POST', lim.key));
  router.use('/admin', only('POST', lim.admin));
  router.use('/api/settings', lim.panel);
  router.use((req, res, next) => (req.path === '/' && req.query && req.query.number ? lim.pair(req, res, next) : next()));

  if (express) {
    router.use(express.json({ limit: '50kb' }));
    router.use((err, req, res, next) => { // bad JSON / oversized body → clean 400
      if (err) return res.status(400).json({ success: false, error: 'Bad request.', message: 'Bad request.' });
      next();
    });
  }
  router.use(intrusionGuard);
  router.use(['/request-movie', '/request-kdrama', '/request-cartoon', '/request-song', '/request-adult'], only('POST', humanCheck));
  const adminOnly = fn => (req, res) => { if (adminCheck(req, res)) fn(req, res); };
  router.post('/admin/unban', adminOnly((req, res) => {
    const ip = String((req.body && req.body.ip) || '').trim().slice(0, 64);
    if (!ip) return res.status(400).json({ success: false, message: 'ip required' });
    const s = strikes.get(ip); if (s) { s.bannedUntil = 0; s.n = 0; s.level = 0; }
    if (banStore && banStore.remove) Promise.resolve().then(() => banStore.remove(ip)).catch(() => {});
    res.json({ success: true, message: `Unbanned ${ip}` });
  }));
  router.post('/admin/lockdown', adminOnly((req, res) => {
    const on = (req.body && req.body.action) === 'on';
    lock.manual = on; if (!on) lock.until = 0;
    res.json({ success: true, message: on ? 'LOCKDOWN ON: new requests are paused' : 'Lockdown off' });
  }));
  router.post('/admin/bans', adminOnly((req, res) => {
    const now = Date.now();
    const bans = [...strikes].filter(([, s]) => s.bannedUntil > now).slice(0, 50).map(([ip, s]) => ({ ip, level: s.level, until: new Date(s.bannedUntil).toISOString() }));
    res.json({ success: true, bans, lockdown: lockdownOn(), message: `${bans.length} active ban(s)${lockdownOn() ? ' · LOCKDOWN ON' : ''}` });
  }));
  router.all(HONEYPOTS, (req, res) => {
    reportIncident(req, 'Honeypot hit (scanner / attacker probing)', { query: req.query }, true);
    res.status(404).send('Not found');
  });
}

module.exports = {
  applySecurity, clientIp, cors, adminCheck, panelCheck, setAlertSender, reportIncident, banCheck, intrusionGuard,
  setBanStore, humanCheck, issueToken, checkToken, nameOf, __setTurnstileVerify: f => { turnstileVerify = f; },
  makeKnown, makeCatalog, extractMovieItems, cleanText, quality, phone, isYoutubeUrl, pickKeys, allowSendToPhone, makeLimiter,
  warn: (req, reason, data) => reportIncident(req, reason, data, false, false), // alert only, no strike
};
