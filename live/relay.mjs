// w2live relay (node, no dependencies): the recorder on the game PC (w2live.mjs) pushes each live game here once;
// viewers read it from here, so the game PC uploads one copy however many watch. Can also serve the viewer itself.
// The Cloudflare Worker (worker.js) speaks the same API.
//
//   node relay.mjs [--port 8080] [--dir live-data] [--token SECRET] [--min-delay S] [--viewer DIR] [--replays DIR]
//     --token     what the recorder must send (Authorization: Bearer ...); unset: anyone may push
//     --min-delay seconds a game is held back at least (the recorder's "delay" can only add to it)
//     --viewer    a built viewer (dist/war2-replay-viewer) to serve at /
//     --replays   finished games are also written there (<id>.w2r.gz), e.g. the viewer's replays folder
//
// API (CORS open):
//   GET  /api/live                     {games: [{id, title, map, players, started, size, done, delay, updated}]}, newest first
//   GET  /api/live/<id>?from=N&wait=1  the stream's bytes from N up to what the delay lets out; with wait=1 and
//                                      nothing new, waits up to 25 s. Headers: x-live-size (bytes out so far),
//                                      x-live-done (1: complete), x-live-ready-in (s until more is due, delay)
//   GET  /api/live/<id>/final          the finished .w2r.gz
//   POST /api/live/<id>/meta           JSON (recorder)        POST /api/live/<id>/append?offset=N   gzip body
//   POST /api/live/<id>/final          .w2r.gz                POST /api/live/<id>/done
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = +opt('--port', process.env.PORT || 8080), DIR = path.resolve(opt('--dir', 'live-data')), TOKEN = opt('--token', process.env.W2LIVE_TOKEN || '');
const MIN_DELAY = +opt('--min-delay', 0), VIEWER = opt('--viewer', null), REPLAYS = opt('--replays', null);
const ID = /^[\w.-]{1,96}$/;
fs.mkdirSync(DIR, { recursive: true });

const games = new Map();   // id -> { meta, data: Buffer[] (pieces), size, times: [[end offset, ms]], done, waiters: Set }
function load(id) {
  if (games.has(id)) return games.get(id);
  const mf = path.join(DIR, `${id}.json`); if (!fs.existsSync(mf)) return null;
  const j = JSON.parse(fs.readFileSync(mf, 'utf8')), df = path.join(DIR, `${id}.w2r`);
  const data = fs.existsSync(df) ? fs.readFileSync(df) : Buffer.alloc(0);
  const g = { meta: j.meta, data: [data], size: data.length, times: j.times || [[data.length, 0]], done: j.done, waiters: new Set() };
  games.set(id, g); return g;
}
for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) load(f.slice(0, -5));
const save = (id, g) => fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ meta: g.meta, times: g.times, done: g.done }));
const delayOf = g => Math.max(MIN_DELAY, +(g.meta && g.meta.delay) || 0) * 1000;
// bytes a viewer may have now: those that came in at least delay ago
function avail(g, now = Date.now()) {
  const d = delayOf(g); if (!d) return { n: g.size, next: null };
  let n = 0, next = null;
  for (const [end, t] of g.times) { if (t + d <= now) n = end; else { next = t + d - now; break; } }
  return { n, next };
}
const bytes = (g, a, b) => { if (g.data.length > 1) g.data = [Buffer.concat(g.data)]; return g.data[0].subarray(a, b); };
function wake(g) { for (const w of g.waiters) w(); g.waiters.clear(); }

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-expose-headers': 'x-live-size, x-live-done, x-live-ready-in' };
function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...cors, ...headers }); res.end(body);
}
const json = (res, code, o) => send(res, code, JSON.stringify(o), { 'content-type': 'application/json', 'cache-control': 'no-store' });
const body = req => new Promise((ok, bad) => { const p = []; let n = 0; req.on('data', b => { n += b.length; if (n > 64 << 20) { bad(new Error('too big')); req.destroy(); } else p.push(b); }); req.on('end', () => ok(Buffer.concat(p))); req.on('error', bad); });
function gz(req, res, buf, headers) {
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && buf.length > 512) send(res, 200, zlib.gzipSync(buf, { level: 6 }), { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
  else send(res, 200, buf, headers);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip', '.pud': 'application/octet-stream', '.w2p': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
function staticFile(req, res, url) {
  if (!VIEWER) return send(res, 404, 'not found');
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.resolve(VIEWER, '.' + p);
  if (!f.startsWith(path.resolve(VIEWER)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'not found');
  send(res, 200, fs.readFileSync(f), { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const m = /^\/api\/live(?:\/([^/]+)(?:\/(\w+))?)?\/?$/.exec(url.pathname);
    if (!m) return req.method === 'GET' || req.method === 'HEAD' ? staticFile(req, res, url) : send(res, 404, 'not found');
    const id = m[1] && decodeURIComponent(m[1]), act = m[2] || '';
    if (id && !ID.test(id)) return send(res, 400, 'bad id');
    if (req.method === 'GET') {
      if (!id) {
        const list = [...games].map(([gid, g]) => ({ id: gid, ...g.meta, size: avail(g).n, done: !!g.done && avail(g).n === g.size, delay: delayOf(g) / 1000, updated: g.times.length ? g.times[g.times.length - 1][1] : 0 }));
        list.sort((a, b) => (b.started || 0) - (a.started || 0));
        return json(res, 200, { games: list.slice(0, 50) });
      }
      const g = load(id); if (!g) return send(res, 404, 'no such game');
      if (act === 'final') { const f = path.join(DIR, `${id}.final.w2r.gz`); return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), { 'content-type': 'application/gzip' }) : send(res, 404, 'not finished'); }
      const from = Math.max(0, +url.searchParams.get('from') || 0);
      let a = avail(g);
      if (url.searchParams.get('wait') && a.n <= from && !(g.done && a.n === g.size)) {
        await new Promise(ok => { const t = setTimeout(ok, Math.min(25000, a.next ?? 25000)); g.waiters.add(() => { clearTimeout(t); ok(); }); req.on('close', ok); });
        a = avail(g);
        if (a.n <= from && delayOf(g) && a.next !== null) await new Promise(ok => setTimeout(ok, Math.min(2000, a.next))), a = avail(g);
      }
      return gz(req, res, bytes(g, from, Math.max(from, a.n)), { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
        'x-live-size': String(a.n), 'x-live-done': g.done && a.n === g.size ? '1' : '0', ...(a.next !== null ? { 'x-live-ready-in': String(Math.ceil(a.next / 1000)) } : {}) });
    }
    if (req.method !== 'POST') return send(res, 405, 'method');
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, 'token');
    if (!id) return send(res, 400, 'id');
    const b = await body(req);
    let g = load(id);
    if (act === 'meta') {
      const meta = JSON.parse(b.toString('utf8'));
      if (!g) { g = { meta, data: [], size: 0, times: [], done: false, waiters: new Set() }; games.set(id, g); fs.writeFileSync(path.join(DIR, `${id}.w2r`), ''); }
      else g.meta = meta;
      save(id, g); console.log(`${id}: ${meta.map} ${(meta.players || []).join(', ')}`);
      return json(res, 200, { size: g.size });
    }
    if (!g) return send(res, 404, 'meta first');
    if (act === 'append') {
      const off = +url.searchParams.get('offset');
      if (off !== g.size) return json(res, 409, { size: g.size });
      const raw = req.headers['content-type'] === 'application/x-w2r-gzip' ? zlib.gunzipSync(b) : b;
      g.data.push(raw); g.size += raw.length; g.times.push([g.size, Date.now()]);
      fs.appendFileSync(path.join(DIR, `${id}.w2r`), raw); save(id, g); wake(g);
      if (delayOf(g)) setTimeout(() => wake(g), delayOf(g) + 50);
      return json(res, 200, { size: g.size });
    }
    if (act === 'final') {
      fs.writeFileSync(path.join(DIR, `${id}.final.w2r.gz`), b);
      if (REPLAYS) fs.writeFileSync(path.join(REPLAYS, `${id}.w2r.gz`), b);
      return json(res, 200, { size: b.length });
    }
    if (act === 'done') { g.done = true; save(id, g); wake(g); if (delayOf(g)) setTimeout(() => wake(g), delayOf(g) + 50); console.log(`${id}: done, ${g.size} bytes`); return json(res, 200, { size: g.size }); }
    return send(res, 404, 'not found');
  } catch (e) { console.error(e); try { send(res, 500, String(e.message || e)); } catch { /* gone */ } }
}).listen(PORT, () => console.log(`w2live relay on :${PORT}, data in ${DIR}${VIEWER ? `, viewer from ${VIEWER}` : ''}${TOKEN ? '' : ' (no --token: anyone may push)'}`));
