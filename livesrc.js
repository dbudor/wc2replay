// A live game from a w2live relay (web/live/relay.mjs or worker.js): the .w2r stream as it grows (livecap.js
// writes it on the game PC). `bytes` ends at the last whole chunk, so every .w2r reader can take it as it is.
// A WebSocket when the relay has them (worker.js), else long polling (relay.mjs).
//   const src = new LiveSource(relayUrl, id); src.onData = () => ...; src.start(); ... src.stop()
//   listLive(relayUrl) -> [{ id, title, map, players, started, size, done, delay, relay }]
const TURN = [0x54, 0x55, 0x52, 0x4e], END = [0x45, 0x4e, 0x44, 0x20];
const is = (b, o, t) => b[o] === t[0] && b[o + 1] === t[1] && b[o + 2] === t[2] && b[o + 3] === t[3];
export const relayBase = u => u.replace(/\/+$/, '').replace(/\/api\/live$/, '');

export async function listLive(relay) {
  const r = await fetch(`${relayBase(relay)}/api/live`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${relay}: ${r.status}`);
  const j = await r.json();
  return (j.games || []).map(g => ({ ...g, relay: relayBase(relay) }));
}

export class LiveSource {
  constructor(relay, id) {
    this.url = `${relayBase(relay)}/api/live/${encodeURIComponent(id)}`; this.id = id;
    this.buf = new Uint8Array(1 << 20); this.len = 0; this.whole = 0;   // received; end of the last whole chunk
    this.turns = 0; this.ended = false;     // TURN chunks in the whole part; END seen
    this.done = false; this.running = false; this.error = null; this.readyIn = null; this.onData = null;
  }
  get bytes() { return this.buf.subarray(0, this.whole); }
  get headReady() { return this.turns > 0 || this.ended; }
  append(b) {
    if (this.len + b.length > this.buf.length) { const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + b.length)); n.set(this.buf.subarray(0, this.len)); this.buf = n; }
    this.buf.set(b, this.len); this.len += b.length;
    const d = this.buf, dv = new DataView(d.buffer);
    let o = this.whole || 8;
    if (this.len < 8) return;
    while (o + 8 <= this.len) {
      const n = dv.getUint32(o + 4, true);
      if (o + 8 + n > this.len) break;
      if (is(d, o, TURN)) this.turns++; else if (is(d, o, END)) this.ended = true;
      o += 8 + n;
    }
    this.whole = o;
  }
  start() {
    if (this.running) return;
    this.running = true;
    if (typeof WebSocket !== 'undefined' && this.wsOk !== false) this.startWs(); else this.startPoll();
  }
  // WebSocket (worker.js): the relay pushes each piece; reconnects from what came; never opened: polling instead
  startWs() {
    const u = this.url.replace(/^http/, 'ws') + `/ws?from=${this.len}`;
    let ws, opened = false;
    try { ws = new WebSocket(u); } catch { this.wsOk = false; this.startPoll(); return; }
    ws.binaryType = 'arraybuffer'; this.ws = ws;
    ws.onopen = () => { opened = true; this.wsOk = true; this.error = null; };
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        let j = {}; try { j = JSON.parse(e.data); } catch { /* ignore */ }
        if (j.readyIn !== undefined) this.readyIn = String(j.readyIn);
        if (j.done && this.len >= j.size) { this.done = true; this.running = false; try { ws.close(); } catch { /* closed */ } }
      } else this.append(new Uint8Array(e.data));
      if (this.onData) this.onData();
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.running || this.done) return;
      if (!opened && this.wsOk === undefined) { this.wsOk = false; this.startPoll(); return; }   // not a WebSocket relay
      this.error = 'connection lost, reconnecting';
      if (this.onData) this.onData();
      setTimeout(() => { if (this.running && !this.done) this.startWs(); }, 2000);
    };
  }
  startPoll() {
    (async () => {
      let wait = 1000;
      while (this.running && !this.done) {
        try {
          const r = await fetch(`${this.url}?from=${this.len}&wait=1`, { cache: 'no-store' });
          if (r.status === 404) throw Object.assign(new Error('this live game is not on the relay (any more)'), { fatal: true });
          if (!r.ok) throw new Error(`relay: ${r.status}`);
          const b = new Uint8Array(await r.arrayBuffer());
          this.readyIn = r.headers.get('x-live-ready-in');
          if (b.length) { this.append(b); this.error = null; if (this.onData) this.onData(); }
          if (r.headers.get('x-live-done') === '1' && this.len >= +(r.headers.get('x-live-size') || 0)) { this.done = true; if (this.onData) this.onData(); }
          wait = 1000;
        } catch (e) {
          this.error = e.message;
          if (e.fatal) { this.running = false; if (this.onData) this.onData(); return; }
          await new Promise(ok => setTimeout(ok, wait)); wait = Math.min(15000, wait * 2);
        }
      }
      this.running = false;
    })();
  }
  stop() { this.running = false; if (this.ws) try { this.ws.close(); } catch { /* closed */ } }
  // resolves when the header and the first turn are here
  async ready(timeoutMs = 60000) {
    const t0 = Date.now();
    while (!this.headReady) {
      if (!this.running && !this.done) throw new Error(this.error || 'the live stream stopped');
      if (Date.now() - t0 > timeoutMs) throw new Error(this.error ? `relay: ${this.error}` : 'no data from the relay yet (the game may not have started)');
      await new Promise(ok => setTimeout(ok, 200));
    }
  }
}
