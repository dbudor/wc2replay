// w2live relay as a Cloudflare Worker (the same API as relay.mjs, plus WebSockets): one Durable Object per game
// holds its stream (SQLite-backed, so the free plan works), an Index object lists the games. Viewers on a WebSocket
// get each new piece pushed (a push is no request; on the free plan's 100k requests a day that matters: polling
// viewers make about one a second each); others long-poll as with relay.mjs.
//
// Deploy (web/live/): npx wrangler deploy; npx wrangler secret put TOKEN   (the recorder's relay.token)
// vars (wrangler.toml): MIN_DELAY (s), KEEP_DAYS (a game is deleted that long after it ended; default 30)
//
//   GET  /api/live                      {games: [...], ws: true}
//   GET  /api/live/<id>?from=N&wait=1   as relay.mjs (x-live-size, x-live-done, x-live-ready-in)
//   GET  /api/live/<id>/ws?from=N       WebSocket: binary messages = the stream's bytes from N on, in order;
//                                       text {"done": true, "size": n} when it is complete, {"readyIn": s} (delay)
//   GET  /api/live/<id>/final           the finished .w2r.gz
//   POST /api/live/<id>/meta | append?offset=N | final | done   (Authorization: Bearer TOKEN)
const ID = /^[\w.-]{1,96}$/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-expose-headers': 'x-live-size, x-live-done, x-live-ready-in' };
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const text = (t, status) => new Response(t, { status, headers: CORS });
const PIECE = 1 << 20;   // SQLite rows stay under its 2 MB value limit

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const m = /^\/api\/live(?:\/([^/]+)(?:\/(\w+))?)?\/?$/.exec(url.pathname);
    if (!m) return text('not found', 404);
    const index = env.INDEX.get(env.INDEX.idFromName('index'));
    if (!m[1]) {
      if (req.method !== 'GET') return text('method', 405);
      return json({ games: await (await index.fetch('https://do/list')).json(), ws: true });
    }
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return text('bad id', 400);
    if (req.method === 'POST' && env.TOKEN && req.headers.get('authorization') !== `Bearer ${env.TOKEN}`) return text('token', 401);
    return env.GAMES.get(env.GAMES.idFromName('game:' + id)).fetch(req);
  },
};

export class LiveGame {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql; this.waiters = new Set();
    this.sql.exec('CREATE TABLE IF NOT EXISTS piece (start INTEGER PRIMARY KEY, t INTEGER, data BLOB)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS final (n INTEGER PRIMARY KEY, data BLOB)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }
  get(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : null; }
  set(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, JSON.stringify(v)); }
  get size() { const r = this.sql.exec('SELECT start, length(data) AS n FROM piece ORDER BY start DESC LIMIT 1').toArray()[0]; return r ? r.start + r.n : 0; }
  delayMs() { const meta = this.get('meta') || {}; return Math.max(+this.env.MIN_DELAY || 0, +meta.delay || 0) * 1000; }
  // bytes viewers may have now (those in at least the delay ago), and ms until more are due
  avail(now = Date.now()) {
    const d = this.delayMs();
    if (!d) return { n: this.size, next: null };
    const out = this.sql.exec('SELECT start, length(data) AS n FROM piece WHERE t <= ? ORDER BY start DESC LIMIT 1', now - d).toArray()[0];
    const nx = this.sql.exec('SELECT t FROM piece WHERE t > ? ORDER BY start LIMIT 1', now - d).toArray()[0];
    return { n: out ? out.start + out.n : 0, next: nx ? nx.t + d - now : null };
  }
  bytes(a, b) {
    if (b <= a) return new Uint8Array(0);
    const rows = this.sql.exec('SELECT start, data FROM piece WHERE start < ? AND start + length(data) > ? ORDER BY start', b, a).toArray();
    const out = new Uint8Array(b - a);
    for (const r of rows) { const d = new Uint8Array(r.data), s = Math.max(a, r.start), e = Math.min(b, r.start + d.length); out.set(d.subarray(s - r.start, e - r.start), s - a); }
    return out;
  }
  done() { return !!this.get('done'); }
  async index(op, body) { await this.env.INDEX.get(this.env.INDEX.idFromName('index')).fetch(`https://do/${op}`, { method: 'POST', body: JSON.stringify(body) }); }
  // what each WebSocket has not had yet, up to what the delay lets out; reschedules itself for delayed bytes
  push() {
    const a = this.avail(), complete = this.done() && a.n === this.size;
    for (const ws of this.ctx.getWebSockets()) {
      const st = ws.deserializeAttachment() || { sent: 0 };
      try {
        for (let s = st.sent; s < a.n; s += PIECE) ws.send(this.bytes(s, Math.min(a.n, s + PIECE)));
        if (a.n > st.sent) { st.sent = a.n; ws.serializeAttachment(st); }
        if (complete && !st.toldDone) { ws.send(JSON.stringify({ done: true, size: a.n })); st.toldDone = true; ws.serializeAttachment(st); }
      } catch { /* closed */ }
    }
    for (const w of this.waiters) w(); this.waiters.clear();
    if (a.next !== null) this.ctx.storage.setAlarm(Date.now() + a.next + 20);
  }
  async alarm() {
    if (this.get('expire') && Date.now() >= this.get('expire')) { await this.ctx.storage.deleteAll(); await this.index('remove', { id: this.get('id') }); return; }
    this.push();
    const ex = this.get('expire'); if (ex && !(await this.ctx.storage.getAlarm())) this.ctx.storage.setAlarm(ex);
  }
  async fetch(req) {
    const url = new URL(req.url), act = (/^\/api\/live\/[^/]+\/(\w+)/.exec(url.pathname) || [])[1] || '';
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    if (req.method === 'GET') {
      if (!this.get('meta')) return text('no such game', 404);
      if (act === 'final') {
        const rows = this.sql.exec('SELECT data FROM final ORDER BY n').toArray();
        if (!rows.length) return text('not finished', 404);
        return new Response(new Blob(rows.map(r => r.data)), { headers: { ...CORS, 'content-type': 'application/gzip' } });
      }
      const from = Math.max(0, +url.searchParams.get('from') || 0);
      if (act === 'ws') {
        if (req.headers.get('upgrade') !== 'websocket') return text('websocket', 426);
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server); server.serializeAttachment({ sent: from });
        const a = this.avail(); if (a.next !== null) server.send(JSON.stringify({ readyIn: Math.ceil(a.next / 1000) }));
        this.push();
        return new Response(null, { status: 101, webSocket: client });
      }
      let a = this.avail();
      if (url.searchParams.get('wait') && a.n <= from && !(this.done() && a.n === this.size)) {
        await new Promise(ok => { const t = setTimeout(ok, Math.min(25000, a.next ?? 25000)); this.waiters.add(() => { clearTimeout(t); ok(); }); });
        a = this.avail();
      }
      const body = this.bytes(from, Math.max(from, a.n));
      const h = { ...CORS, 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-live-size': String(a.n),
        'x-live-done': this.done() && a.n === this.size ? '1' : '0', ...(a.next !== null ? { 'x-live-ready-in': String(Math.ceil(a.next / 1000)) } : {}) };
      if (body.length > 4096 && /\bgzip\b/.test(req.headers.get('accept-encoding') || '')) {
        return new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')), { headers: { ...h, 'content-encoding': 'gzip' }, encodeBody: 'manual' });
      }
      return new Response(body, { headers: h });
    }
    if (req.method !== 'POST') return text('method', 405);
    if (act === 'meta') {
      const meta = await req.json();
      this.set('meta', meta); this.set('id', id);
      await this.index('put', { id, meta, size: this.size, done: this.done() });
      return json({ size: this.size });
    }
    if (!this.get('meta')) return text('meta first', 404);
    if (act === 'append') {
      const off = +url.searchParams.get('offset'), size = this.size;
      if (off !== size) return json({ size }, 409);
      let raw = new Uint8Array(await req.arrayBuffer());
      if (req.headers.get('content-type') === 'application/x-w2r-gzip') raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      const t = Date.now();
      for (let o = 0; o < raw.length; o += PIECE) this.sql.exec('INSERT INTO piece (start, t, data) VALUES (?, ?, ?)', size + o, t, raw.subarray(o, Math.min(raw.length, o + PIECE)));
      this.push();
      return json({ size: size + raw.length });
    }
    if (act === 'final') {
      const b = new Uint8Array(await req.arrayBuffer());
      this.sql.exec('DELETE FROM final');
      for (let o = 0, n = 0; o < b.length; o += PIECE, n++) this.sql.exec('INSERT INTO final (n, data) VALUES (?, ?)', n, b.subarray(o, Math.min(b.length, o + PIECE)));
      return json({ size: b.length });
    }
    if (act === 'done') {
      this.set('done', true);
      const keep = (+this.env.KEEP_DAYS || 30) * 86400e3; this.set('expire', Date.now() + keep);
      await this.index('put', { id, meta: this.get('meta'), size: this.size, done: true });
      this.push();
      if (!(await this.ctx.storage.getAlarm())) this.ctx.storage.setAlarm(Date.now() + keep);
      return json({ size: this.size });
    }
    return text('not found', 404);
  }
  webSocketMessage() { /* viewers only listen */ }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* closed */ } }
}

// The list of games: put (meta, size, done) / remove from the game objects, list for GET /api/live.
export class LiveIndex {
  constructor(ctx) { this.sql = ctx.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS game (id TEXT PRIMARY KEY, started INTEGER, j TEXT)'); }
  async fetch(req) {
    const op = new URL(req.url).pathname.slice(1);
    if (op === 'list') return new Response(JSON.stringify(this.sql.exec('SELECT j FROM game ORDER BY started DESC LIMIT 50').toArray().map(r => JSON.parse(r.j))));
    const b = await req.json();
    if (op === 'put') this.sql.exec('INSERT OR REPLACE INTO game (id, started, j) VALUES (?, ?, ?)', b.id, (b.meta && b.meta.started) || Date.now(), JSON.stringify({ id: b.id, ...b.meta, size: b.size, done: b.done, updated: Date.now() }));
    if (op === 'remove') this.sql.exec('DELETE FROM game WHERE id = ?', b.id);
    return new Response('{}');
  }
}
