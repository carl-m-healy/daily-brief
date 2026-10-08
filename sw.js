/* The Daily Brief: service worker (scope /daily-brief/). Source: /workspace/xbrief/pwa/sw.js, copied to the
   site by publish.sh. Plain text and public: it holds no article text, password or token.

   Caches
     brief-shell-v1        manifest, icons, start page (/daily-brief/), archive, issues.json
     brief-fonts-v1        Google Fonts CSS + woff2 (CORS)
     brief-day-<date>      one per edition date in the 3-day window (today, yesterday, day before, Phoenix
                           calendar): the encrypted issue page, its media manifest, and every saved media file
                           (mp3/mp4 + timing JSON + posters), keyed by the exact manifest URL (?v=<sha12>)
     brief-parts-v1        8 MB chunks of downloads in progress (resume after an interruption)
     brief-meta-v1         settings mirrored from the page (mobile-data opt-in) + Background Fetch failures
   Any brief-day-* outside the window is deleted on every activation, app open and download pass.

   Rules
     HTML (issue pages, start page, archive): network first with If-None-Match against the cached copy (a 304 costs
       ~0 bytes), cached fallback when offline / no answer within 6 s.
     media/<date>.json, issues.json: network first, cached fallback.
     /daily-brief-media/...: cached → served from cache, with 206 Partial Content for Range requests (audio/video
       seeking). Not cached → passed straight to the network (no caching of what the player streams).
     Downloads happen only in a "pass" that the page starts (it decides Wi-Fi / mobile-data policy) or that
       Periodic Background Sync starts (Wi-Fi only, checked here). Never on its own over cellular. */
'use strict';
const VERSION = 'pwa-2026-10-08.3';
const SHELL = 'brief-shell-v1', FONTS = 'brief-fonts-v1', PARTS = 'brief-parts-v1', META = 'brief-meta-v1', DAY = 'brief-day-';
const BASE = new URL('./', self.registration.scope).pathname;          // "/daily-brief/"
const ORIGIN = self.location.origin;
const MEDIA_PATH = BASE.replace(/\/$/, '') + '-media/';                // "/daily-brief-media/"
const START = ORIGIN + BASE;
const CHUNK = 8 * 1024 * 1024;
const PASS_BUDGET_MS = 240e3;   // keep every event well under Chrome's 5-minute limit; the page starts another pass
const NAV_TIMEOUT_MS = 6000;
const TZ = 'America/Phoenix';
const SHELL_FILES = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png',
  'icons/maskable-512.png', 'icons/monochrome-512.png', 'icons/apple-180.png', 'icons/badge-96.png'].map(p => BASE + p);

// ---------- dates ----------
function ymd(d) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch (e) { return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
}
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function windowDates() { const t = ymd(new Date()); return [t, addDays(t, -1), addDays(t, -2)]; }
function inWindow(d) { return !!d && windowDates().indexOf(d) >= 0; }
function dateOf(url) {
  const p = new URL(url, ORIGIN).pathname, m = p.match(/(\d{4}-\d{2}-\d{2})(?:\.html|\.json|\/)/);
  return m ? m[1] : null;
}
function noQuery(u) { const x = new URL(u, ORIGIN); x.search = ''; x.hash = ''; return x.href; }

// ---------- lifecycle ----------
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(u => fetch(u, { cache: 'no-cache' }).then(r => r.ok && c.put(u, r)).catch(() => {})));
    await self.skipWaiting();          // the page never depends on a specific SW version; take over at once
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => /^brief-(shell|fonts|parts|meta)-v/.test(n) && ![SHELL, FONTS, PARTS, META].includes(n)).map(n => caches.delete(n)));
    await prune();
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.disable(); } catch (x) {} }
    await self.clients.claim();
  })());
});

async function prune() {
  const keep = new Set(windowDates().map(d => DAY + d)), removed = [];
  for (const n of await caches.keys()) if (n.startsWith(DAY) && !keep.has(n)) { await caches.delete(n); removed.push(n); }
  const parts = await caches.open(PARTS);
  for (const r of await parts.keys()) if (!inWindow(dateOf(r.url))) await parts.delete(r);
  return removed;
}

// ---------- fetch routing ----------
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') return e.respondWith(fontFetch(e, req));
  if (url.origin !== ORIGIN) return;                                   // GitHub API etc.: untouched
  const p = url.pathname;
  if (p.startsWith(MEDIA_PATH)) {
    const d = dateOf(req.url);
    if (!inWindow(d)) return;
    return e.respondWith(mediaFetch(e, req, d));
  }
  if (!p.startsWith(BASE)) return;
  if (p === BASE + 'sw.js') return;
  if (req.mode === 'navigate' || /\.html$/.test(p) || p === BASE) return e.respondWith(pageFetch(e, req));
  if (/^\/[^/]+\/media\/\d{4}-\d{2}-\d{2}\.json$/.test(p) || p === BASE + 'issues.json') return e.respondWith(jsonFetch(e, req));
  if (SHELL_FILES.includes(noQuery(req.url).slice(ORIGIN.length))) return e.respondWith(shellFetch(e, req));
});

function pageKey(url) {
  const u = new URL(url), p = u.pathname;
  if (p === BASE || p === BASE + 'index.html') return { cache: SHELL, key: START, index: true };
  const m = p.match(/\/issues\/(\d{4}-\d{2}-\d{2})\.html$/);
  if (m) return { cache: inWindow(m[1]) ? DAY + m[1] : null, key: ORIGIN + p, date: m[1] };
  return { cache: SHELL, key: ORIGIN + p };
}

function unredirect(r) {      // navigations must not receive a redirected Response
  if (!r.redirected) return r;
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

async function newestCachedIssue() {
  const ds = (await caches.keys()).filter(n => n.startsWith(DAY)).map(n => n.slice(DAY.length)).sort().reverse();
  for (const d of ds) { const r = await (await caches.open(DAY + d)).match(ORIGIN + BASE + 'issues/' + d + '.html'); if (r) return r; }
  return null;
}

// Conditional GET against the cached copy's ETag: 304 → the cached copy (≈0 bytes on the wire), 200 → store + return.
// With an event, the response is returned as soon as headers arrive and stored in the background.
async function revalidate(key, cacheName, cached, e) {
  const h = {}; const et = cached && cached.headers.get('etag'); if (et) h['If-None-Match'] = et;
  const r = await fetch(key, { headers: h, cache: 'no-store', credentials: 'same-origin', redirect: 'follow' });
  if (r.status === 304 && cached) return cached;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (cacheName) {
    const copy = r.clone(), put = caches.open(cacheName).then(c => c.put(key, copy));
    if (e) e.waitUntil(put.catch(() => {})); else await put;
  }
  return unredirect(r);
}

async function pageFetch(e, req) {
  const k = pageKey(req.url);
  const cached = k.cache ? await (await caches.open(k.cache)).match(k.key) : null;
  const net = revalidate(k.key, k.cache, cached, e);
  const fallback = async () => {
    if (k.index) { const n = await newestCachedIssue(); if (n) return n; }      // start page offline: newest saved edition
    if (cached) return cached;
    if (!k.index && !k.date) { const any = await caches.match(k.key, { ignoreSearch: true }); if (any) return any; }
    return offlinePage(k);
  };
  if (!cached && !k.index) return net.catch(fallback);
  // Online: the network answer (304 → cached, 200 → fresh). Offline / no answer in 6 s: the cached copy.
  e.waitUntil(net.catch(() => {}));
  return Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NAV_TIMEOUT_MS))]).catch(fallback);
}

function offlinePage(k) {
  const html = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="light dark">' +
    '<title>The Daily Brief — offline</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:18vh auto;padding:0 22px">' +
    '<h1 style="font:700 28px Georgia,serif">You’re offline</h1><p>This ' + (k.date ? 'issue (' + k.date + ')' : 'page') +
    ' isn’t saved on this phone. The app keeps today, yesterday and the day before once it has been opened on Wi-Fi.</p>' +
    '<p><a href="' + BASE + '">Open the latest saved issue</a></p></body>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function jsonFetch(e, req) {
  const p = new URL(req.url).pathname, d = dateOf(req.url);
  const cacheName = p.endsWith('/issues.json') ? SHELL : (inWindow(d) ? DAY + d : null);
  const key = noQuery(req.url);
  try {
    const r = await fetch(key + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok && cacheName) await (await caches.open(cacheName)).put(key, r.clone());
    if (r.ok || r.status === 404) return r;
    throw new Error('HTTP ' + r.status);
  } catch (x) {
    const c = cacheName && await (await caches.open(cacheName)).match(key);
    return c || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function shellFetch(e, req) {
  const c = await caches.open(SHELL), key = noQuery(req.url), hit = await c.match(key);
  const net = fetch(key, { cache: 'no-cache' }).then(r => { if (r.ok) e.waitUntil(c.put(key, r.clone()).catch(() => {})); return r; });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

async function fontFetch(e, req) {
  const c = await caches.open(FONTS), hit = await c.match(req.url);
  const net = fetch(req).then(r => { if (r.ok && r.type === 'cors') e.waitUntil(c.put(req.url, r.clone()).catch(() => {})); return r; });
  if (hit) { if (req.url.includes('fonts.googleapis.com')) e.waitUntil(net.catch(() => {})); return hit; }
  return net.catch(() => new Response('', { status: 504 }));
}

// ---------- media: cached → full or 206; not cached → network ----------
async function mediaFetch(e, req, d) {
  const c = await caches.open(DAY + d), hit = await c.match(req.url);
  if (hit) return rangeable(req, hit);
  // small sidecars (timing JSON, posters) are cached as they are viewed; big files only by a download pass
  if (!req.headers.get('range') && /\.(json|jpg)$/.test(new URL(req.url).pathname)) {
    try {
      const r = await fetch(req.url, { cache: 'no-cache' });
      if (r.ok && r.type !== 'opaque') e.waitUntil(c.put(req.url, r.clone()));
      return r;
    } catch (x) { return new Response('', { status: 504 }); }
  }
  return fetch(req);
}

async function rangeable(req, res) {
  const range = req.headers.get('range');
  const type = res.headers.get('content-type') || 'application/octet-stream';
  if (!range) {
    const h = new Headers(res.headers); h.set('Accept-Ranges', 'bytes');
    return new Response(res.body, { status: 200, headers: h });
  }
  const blob = await res.blob(), size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start, end;
  if (m && m[1] !== '') { start = +m[1]; end = m[2] !== '' ? Math.min(+m[2], size - 1) : size - 1; }
  else if (m && m[2] !== '') { start = Math.max(0, size - +m[2]); end = size - 1; }
  if (!m || start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(start, end + 1, type), { status: 206, statusText: 'Partial Content', headers: {
    'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
    'Accept-Ranges': 'bytes', 'X-Brief-Cache': 'hit' } });
}

// ---------- download pass ----------
let pass = null;          // {abort, started, reason}
let lastStatus = { state: 'idle' };
async function broadcast(msg) {
  lastStatus = Object.assign({ type: 'brief-sw', at: Date.now(), version: VERSION }, msg);
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(lastStatus);
}
async function getMeta(k, dflt) { const r = await (await caches.open(META)).match(ORIGIN + BASE + '__meta/' + k); return r ? r.json() : dflt; }
async function setMeta(k, v) { await (await caches.open(META)).put(ORIGIN + BASE + '__meta/' + k, new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })); }

async function loadManifest(d, online) {
  const key = ORIGIN + BASE + 'media/' + d + '.json', c = await caches.open(DAY + d);
  if (online) {
    try {
      const r = await fetch(key + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) { await c.put(key, r.clone()); return r.json(); }
      if (r.status === 404) return null;
    } catch (x) {}
  }
  const hit = await c.match(key); return hit ? hit.json() : null;
}
async function loadIssues(online) {
  const key = ORIGIN + BASE + 'issues.json', c = await caches.open(SHELL);
  if (online) { try { const r = await fetch(key + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) { await c.put(key, r.clone()); return r.json(); } } catch (x) {} }
  const hit = await c.match(key); return hit ? hit.json() : null;
}

const isTop = aid => /^a-0\d\d-/.test(aid) && aid !== 'a-005-grokbot';
const KORDER = { audio: 0, short: 1, deep: 2 };
// Plan: every READY media file in the window. Order: today's Grok Bot section (audio, short, deep), today's Top Stories
// audio, then everything else newest first (per date: Grok Bot, Top Stories audio, other audio, shorts, deep dives).
async function plan(online) {
  const win = windowDates(), today = win[0], groups = [], manifests = {};
  for (const d of win) {
    const m = await loadManifest(d, online); manifests[d] = m;
    if (!m || !m.items) continue;
    Object.keys(m.items).forEach((aid, idx) => {
      for (const kind of ['audio', 'short', 'deep']) {
        const e = m.items[aid][kind];
        if (!e || e.state !== 'ready' || !e.url || !(e.bytes > 0)) continue;
        const extras = [];
        if (e.timing) extras.push(e.timing);
        if (e.poster) extras.push(e.poster);
        const tier = d === today ? (aid === 'a-005-grokbot' ? 0 : (isTop(aid) && kind === 'audio' ? 1 : 2)) : 2;
        const sub = aid === 'a-005-grokbot' ? 0 : (isTop(aid) && kind === 'audio') ? 1 : 2 + KORDER[kind];
        groups.push({ date: d, aid, kind, url: e.url, bytes: e.bytes, extras, sort: [tier, win.indexOf(d), sub, KORDER[kind], idx] });
      }
    });
  }
  groups.sort((a, b) => { for (let i = 0; i < a.sort.length; i++) if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i]; return 0; });
  return { groups, manifests };
}

async function isSaved(g) {
  const r = await (await caches.open(DAY + g.date)).match(g.url);
  return !!r && +(r.headers.get('content-length') || -1) === g.bytes;
}

async function status(online) {
  const { groups, manifests } = await plan(online), win = windowDates(), days = {}, saved = [];
  let bytesSaved = 0;
  for (const d of win) days[d] = { ready: 0, saved: 0, bytesReady: 0, bytesSaved: 0, manifest: !!manifests[d] };
  for (const g of groups) {
    const s = await isSaved(g), D = days[g.date];
    D.ready++; D.bytesReady += g.bytes;
    if (s) { D.saved++; D.bytesSaved += g.bytes; bytesSaved += g.bytes; saved.push(g.url); }
  }
  const pages = {};
  for (const d of win) pages[d] = !!(await (await caches.open(DAY + d)).match(ORIGIN + BASE + 'issues/' + d + '.html'));
  return { window: win, days, saved, bytesSaved, pages, running: !!pass };
}

async function putChecked(cacheName, url, blob, type, want) {
  if (want && blob.size !== want) throw new Error('size ' + blob.size + ' != ' + want);
  await (await caches.open(cacheName)).put(url, new Response(blob, { status: 200, headers: {
    'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes', 'X-Brief-Saved': new Date().toISOString() } }));
}

async function fetchSmall(url, d, signal) {
  const c = await caches.open(DAY + d);
  if (await c.match(url)) return;
  const r = await fetch(url, { cache: 'no-cache', signal });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  const b = await r.blob();
  if (/\.json(\?|$)/.test(url)) JSON.parse(await b.text());                    // timing must parse
  await putChecked(DAY + d, url, b, r.headers.get('content-type') || '', 0);
}

// Resumable download: 8 MB Range chunks kept in PARTS until the file is complete and its size equals the manifest bytes.
// Part keys are real paths (the Cache API ignores #fragments): /daily-brief/__parts/<date>/<offset>?u=<url>
const partKey = (g, off) => ORIGIN + BASE + '__parts/' + g.date + '/' + off + '?u=' + encodeURIComponent(g.url);
async function partOffsets(g) {
  const parts = await caches.open(PARTS), pre = ORIGIN + BASE + '__parts/' + g.date + '/', out = [];
  for (const r of await parts.keys()) {
    if (!r.url.startsWith(pre)) continue;
    const u = new URL(r.url); if (u.searchParams.get('u') !== g.url) continue;
    out.push(+u.pathname.split('/').pop());
  }
  return out.sort((a, b) => a - b);
}
async function fetchBig(g, signal, onBytes) {
  const parts = await caches.open(PARTS);
  let off = 0, type = '';
  for (const s of await partOffsets(g)) {
    const r = s === off && await parts.match(partKey(g, s)), n = r ? +(r.headers.get('content-length') || 0) : 0;
    if (!r || !n) { await parts.delete(partKey(g, s)); continue; }
    off += n; type = r.headers.get('content-type') || type;
  }
  onBytes(off);
  while (off < g.bytes) {
    const end = Math.min(off + CHUNK, g.bytes) - 1;
    let r, tries = 0;
    for (;;) {
      try { r = await fetch(g.url, { headers: { Range: 'bytes=' + off + '-' + end }, cache: 'no-store', signal }); break; }
      catch (x) { if (signal.aborted || ++tries >= 3) throw x; await new Promise(z => setTimeout(z, 2000 * tries)); }
    }
    type = r.headers.get('content-type') || type;
    if (r.status === 200 && off === 0) {           // server ignored Range: take the whole body
      const b = await r.blob(); await putChecked(DAY + g.date, g.url, b, type, g.bytes); onBytes(g.bytes); return;
    }
    const cr = /bytes (\d+)-(\d+)\/(\d+)/.exec(r.headers.get('content-range') || '');
    if (r.status !== 206 || !cr || +cr[1] !== off || +cr[3] !== g.bytes) throw new Error('bad range answer ' + r.status + ' ' + (r.headers.get('content-range') || ''));
    const b = await r.blob();
    if (b.size !== end - off + 1) throw new Error('short chunk');
    await parts.put(partKey(g, off), new Response(b, { headers: { 'Content-Type': type, 'Content-Length': String(b.size) } }));
    off += b.size; onBytes(off);
    if (signal.aborted) throw new Error('aborted');
  }
  const keys = []; for (const s of await partOffsets(g)) keys.push(partKey(g, s));
  const blobs = []; for (const k of keys) { const r = await parts.match(k); if (!r) throw new Error('missing part'); blobs.push(await r.blob()); }
  await putChecked(DAY + g.date, g.url, new Blob(blobs, { type }), type, g.bytes);
  for (const k of keys) await parts.delete(k);
}

const bfId = g => 'brief|' + g.date + '|' + g.bytes + '|' + g.url;
const BF_STALL_MS = 10 * 60e3;
async function bfFail(url, why) { const f = await getMeta('bf-failed', {}); f[url] = { at: Date.now(), why: String(why || '') }; await setMeta('bf-failed', f); }
async function tryBackgroundFetch(g, titles) {
  const bf = self.registration.backgroundFetch; if (!bf) return false;
  const existing = await bf.get(bfId(g));
  if (existing) {
    if (existing.result !== '') return false;
    // no progress for 10 min (e.g. Chrome holding the download): abort and fall back to resumable chunks
    const seen = await getMeta('bf-progress', {}), p = seen[g.url];
    if (!p || p.downloaded !== existing.downloaded) { seen[g.url] = { downloaded: existing.downloaded, at: Date.now() }; await setMeta('bf-progress', seen); return 'running'; }
    if (Date.now() - p.at < BF_STALL_MS) return 'running';
    try { await existing.abort(); } catch (x) {}
    await bfFail(g.url, 'stalled'); return false;
  }
  const failed = await getMeta('bf-failed', {});
  if (failed[g.url]) return false;
  if ((await partOffsets(g)).length) return false;   // already resuming in chunks
  // Chrome only lets a page (not the SW) start a Background Fetch: hand it back to the page, which calls
  // registration.backgroundFetch.fetch(id, ...) and reports 'bf-failed' if Chrome refuses (then: chunks).
  return 'want';
}

async function runPass(opts) {
  if (pass) return { busy: true };
  const ac = new AbortController(); pass = { abort: ac, started: Date.now(), reason: opts.reason };
  const out = { done: [], failed: [], bg: [], bfWanted: [], more: false };
  try {
    await prune();
    const { groups } = await plan(true);
    const todo = []; for (const g of groups) if (!(await isSaved(g))) todo.push(g);
    const totalBytes = todo.reduce((s, g) => s + g.bytes, 0);
    let doneBytes = 0, i = 0;
    // issue pages for the window (encrypted HTML; usually a 304 / already cached)
    const iss = await loadIssues(true);
    for (const d of windowDates()) {
      if (iss && iss.dates && iss.dates.indexOf(d) < 0) continue;
      const key = ORIGIN + BASE + 'issues/' + d + '.html', c = await caches.open(DAY + d), hit = await c.match(key);
      try { await revalidate(key, DAY + d, hit); } catch (x) {}
    }
    for (const g of todo) {
      i++;
      if (ac.signal.aborted) break;
      if (Date.now() - pass.started > PASS_BUDGET_MS) { out.more = true; break; }
      await broadcast({ state: 'downloading', index: i, total: todo.length, aid: g.aid, kind: g.kind, date: g.date, bytesDone: doneBytes, bytesTotal: totalBytes, net: opts.net || '' });
      try {
        for (const x of g.extras) await fetchSmall(x, g.date, ac.signal);
        if (g.kind === 'deep' && opts.useBackgroundFetch) {
          const r = await tryBackgroundFetch(g, opts.titles);
          if (r === 'want') out.bfWanted.push({ id: bfId(g), url: g.url, bytes: g.bytes, aid: g.aid, date: g.date });
          if (r) { out.bg.push(g.url); doneBytes += g.bytes; continue; }
        }
        let last = 0;
        await fetchBig(g, ac.signal, b => {
          const now = Date.now(); if (now - last < 700) return; last = now;
          broadcast({ state: 'downloading', index: i, total: todo.length, aid: g.aid, kind: g.kind, date: g.date, bytesDone: doneBytes + b, bytesTotal: totalBytes, net: opts.net || '' });
        });
        doneBytes += g.bytes; out.done.push(g.url);
      } catch (x) {
        out.failed.push({ url: g.url, error: String(x && x.message || x) });
        if (ac.signal.aborted) break;
      }
    }
  } finally { pass = null; }
  const st = await status(false);
  await broadcast({ state: 'idle', result: out, status: st });
  return Object.assign(out, { status: st });
}

// ---------- messages from the page ----------
self.addEventListener('message', e => {
  const m = e.data || {}, port = e.ports && e.ports[0], reply = v => port && port.postMessage(v);
  const job = (async () => {
    switch (m.type) {
      case 'status': return reply(Object.assign(await status(!!m.online), { version: VERSION, pass: pass ? { reason: pass.reason, started: pass.started } : null, last: lastStatus,
        bf: { supported: !!self.registration.backgroundFetch, lastError: await getMeta('bf-last-error', null), failed: await getMeta('bf-failed', {}) } }));
      case 'prune': return reply({ removed: await prune(), window: windowDates() });
      case 'settings': await setMeta('settings', m.settings || {}); return reply({ ok: true });
      case 'bf-failed': await bfFail(m.url, m.error); await setMeta('bf-last-error', { at: Date.now(), error: String(m.error || '') }); return reply({ ok: true });
      case 'pause': {
        if (pass) pass.abort.abort();
        const bf = self.registration.backgroundFetch;
        if (bf) for (const id of await bf.getIds()) if (id.startsWith('brief|')) { const r = await bf.get(id); if (r) await r.abort(); }
        await broadcast({ state: 'paused', reason: m.reason || '' });
        return reply({ ok: true });
      }
      case 'sync': {                       // the page decided the network allows downloads
        if (!m.allow) {
          // on mobile data / Data Saver: stop any deep-dive Background Fetch still running from an earlier Wi-Fi session
          const bf = self.registration.backgroundFetch;
          if (bf && /cellular|saveData/.test(m.reason || '')) for (const id of await bf.getIds()) if (id.startsWith('brief|')) { const r = await bf.get(id); if (r && r.result === '') await r.abort(); }
          await prune(); const st = await status(false); await broadcast({ state: 'blocked', reason: m.reason || '', status: st }); return reply(st);
        }
        return reply(await runPass({ reason: m.reason, net: m.net, titles: m.titles, useBackgroundFetch: m.useBackgroundFetch !== false }));
      }
      case 'cache-page': {                 // first visit: store the page the browser already has (HTTP cache, no new download)
        const k = pageKey(m.url); if (!k.cache) return reply({ ok: false });
        const c = await caches.open(k.cache);
        if (!(await c.match(k.key))) { try { const r = await fetch(k.key, { cache: 'force-cache' }); if (r.ok) await c.put(k.key, r); } catch (x) {} }
        for (const u of (m.fonts || [])) { try { const fc = await caches.open(FONTS); if (!(await fc.match(u))) { const r = await fetch(u, { mode: 'cors', cache: 'force-cache' }); if (r.ok && r.type === 'cors') await fc.put(u, r); } } catch (x) {} }
        return reply({ ok: true });
      }
      case 'clear-media': {
        for (const n of await caches.keys()) if (n.startsWith(DAY) || n === PARTS) {
          if (n === PARTS) { await caches.delete(n); continue; }
          const c = await caches.open(n);
          for (const r of await c.keys()) if (new URL(r.url).pathname.startsWith(MEDIA_PATH)) await c.delete(r);
        }
        return reply(await status(false));
      }
    }
  })();
  e.waitUntil(job.catch(err => reply({ error: String(err) })));
});

// ---------- Background Fetch (deep dives keep downloading after the app is closed) ----------
async function bfStore(reg) {
  const [, date, bytes] = reg.id.split('|'); const url = reg.id.split('|').slice(3).join('|');
  const rec = await reg.match(url); if (!rec) throw new Error('no record');
  const res = await rec.responseReady; if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!inWindow(date)) return;
  await putChecked(DAY + date, url, await res.blob(), res.headers.get('content-type') || 'video/mp4', +bytes);
}
self.addEventListener('backgroundfetchsuccess', e => {
  e.waitUntil((async () => {
    try { await bfStore(e.registration); await e.updateUI({ title: 'Deep dive saved for offline' }); }
    catch (x) { await bfFail(e.registration.id.split('|').slice(3).join('|'), x && x.message); }
    await broadcast({ state: 'idle', status: await status(false) });
  })());
});
self.addEventListener('backgroundfetchfail', e => {
  e.waitUntil((async () => { await bfFail(e.registration.id.split('|').slice(3).join('|'), e.registration.failureReason); await broadcast({ state: 'idle', status: await status(false) }); })());
});
self.addEventListener('backgroundfetchclick', e => { e.waitUntil(self.clients.openWindow(BASE)); });

// ---------- Periodic Background Sync (best effort; Chrome decides when; Wi-Fi only) ----------
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'brief-prefetch') return;
  e.waitUntil((async () => {
    await prune();
    const c = self.navigator.connection, s = await getMeta('settings', {});
    const type = c && c.type, ok = c && !c.saveData && (type === 'wifi' || type === 'ethernet' || (s.mobile && type === 'cellular'));
    if (!ok) return;
    try { await revalidate(START, SHELL, await (await caches.open(SHELL)).match(START)); } catch (x) {}
    await runPass({ reason: 'periodic', net: type, useBackgroundFetch: false });   // SW can't start Background Fetch; chunks resume
  })());
});
