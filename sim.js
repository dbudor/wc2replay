// Wrapper around build/sim.wasm for the viewer (browser and node). One SimSession = one fresh wasm instance
// booted from a .w2r; a seek backwards discards the session and boots a new one (bit-exact by construction:
// nothing carries over between instances). JS only ever READS the arena.
//
// Exports used (sim/src/wasm/rt.c): w2w_init, w2w_malloc, w2w_load_exe, w2w_vfs_add, w2w_replay_open,
// w2w_replay_pud_size, w2w_replay_boot, w2w_replay_step, w2w_replay_turn, w2w_replay_hash, w2w_tick_count,
// w2w_arena_base, w2w_hook_ring/size/head/tail, w2w_vfs_log_misses/misses_len, w2w_fixtx/w2w_fixtx_stats.

const dec = new TextDecoder('latin1');

export async function compileSim(bytes) { return WebAssembly.compile(bytes); }

// Header of a .w2r without booting (PUD name and size; size 0 = built-in map loaded via rez\fileflt2.tbl).
export async function replayInfo(module, replay) {
  const s = await SimSession._instance(module);
  const p = s.put(replay);
  const np = s.X.w2w_replay_open(p, replay.length);
  if (!np) throw new Error('not a .w2r replay');
  return { pudName: s.cstr(np, 600), pudSize: s.X.w2w_replay_pud_size() };
}

// The -fixtx pass of a converted capture (pcap.js convertCapture), in a throwaway instance: replays `raw`,
// moves the recording peer's commands to their UI frame and stamps every turn's hash (src/core/fixtx.c, the
// code `w2test replay -fixtx` runs). opts: { module, exe, files, raw, pud }. Returns { w2r, stats }.
const FIXTX_FIELDS = ['status', 'turns', 'ticks', 'moved', 'hashBad', 'tickBad', 'txBad', 'txSent', 'lastStatus', 'pudSize'];
export async function fixtx(opts) {
  for (let cap = opts.raw.length + 65536; ; cap *= 2) {
    const s = await SimSession._instance(opts.module), X = s.X;
    X.w2w_init();
    const rc = X.w2w_load_exe(s.put(opts.exe), opts.exe.length);
    if (rc) throw new Error(`w2w_load_exe failed (${rc}): not Warcraft II BNE 2.02?`);
    for (const [name, data] of opts.files) X.w2w_vfs_add(s.putStr(name), s.put(data), data.length);
    const inP = s.put(opts.raw), pudP = opts.pud ? s.put(opts.pud) : 0, outP = X.w2w_malloc(cap);
    const n = X.w2w_fixtx(inP, opts.raw.length, pudP, opts.pud ? opts.pud.length : 0, outP, cap) >>> 0;
    const v = new Int32Array(X.memory.buffer, X.w2w_fixtx_stats(), FIXTX_FIELDS.length), stats = {};
    FIXTX_FIELDS.forEach((k, i) => { stats[k] = i ? v[i] >>> 0 : v[i]; });
    if (!n) throw new Error(['', 'fixtx: not a .w2r', 'fixtx: the custom map is missing or does not match', 'fixtx: lobby boot failed'][-stats.status] || `fixtx failed (${stats.status})`);
    if (n <= cap) return { w2r: new Uint8Array(X.memory.buffer, outP, n).slice(), stats };
  }
}

// The -fixtx pass turn by turn (livecap.js LiveRecorder), in its own instance. create({ module, exe, files, head, pud }):
// head = the raw .w2r's header chunks (MTCH, PUD). turn(chunk) runs one raw TURN chunk and returns its status
// (0 ok; anything else: the game is over, feed no more); end(nturns) writes the turns held back and END;
// take() returns the fixed file's bytes made since the last take.
export class LiveFixtx {
  static async create({ module, exe, files, head, pud }) {
    const s = await SimSession._instance(module), X = s.X, f = new LiveFixtx();
    X.w2w_init();
    const rc = X.w2w_load_exe(s.put(exe), exe.length);
    if (rc) throw new Error(`w2w_load_exe failed (${rc}): not Warcraft II BNE 2.02?`);
    for (const [name, data] of files) X.w2w_vfs_add(s.putStr(name), s.put(data), data.length);
    f.s = s; f.X = X; f.cap = 1 << 20; f.outP = X.w2w_malloc(f.cap); f.inCap = 1 << 16; f.inP = X.w2w_malloc(f.inCap);
    const st = X.w2w_lfx_begin(s.put(head), head.length, pud ? s.put(pud) : 0, pud ? pud.length : 0, f.outP, f.cap);
    if (st) throw new Error(['', 'fixtx: not a .w2r', 'fixtx: the custom map is missing or does not match', 'fixtx: lobby boot failed'][-st] || `fixtx failed (${st})`);
    return f;
  }
  turn(chunk) {
    if (chunk.length > this.inCap) throw new Error(`a turn of ${chunk.length} bytes`);
    new Uint8Array(this.X.memory.buffer).set(chunk, this.inP);
    return this.X.w2w_lfx_turn(this.inP, chunk.length);
  }
  end(nturns) { this.X.w2w_lfx_end(nturns); }
  take() {
    const n = this.X.w2w_lfx_take() >>> 0;
    if (n > this.cap) throw new Error(`fixtx: ${n} bytes in one go`);
    return new Uint8Array(this.X.memory.buffer, this.outP, n).slice();
  }
  stats() {
    const v = new Int32Array(this.X.memory.buffer, this.X.w2w_lfx_stats(), FIXTX_FIELDS.length), o = {};
    FIXTX_FIELDS.forEach((k, i) => { o[k] = i ? v[i] >>> 0 : v[i]; });
    return o;
  }
}

// Capture -> .w2r under the first of `candidates` (War2Combat plugin rule bits, e.g. [0, 0x100, 0x200]) with which
// the game replays clean: after fixtx, no TX (sync byte) / hash / tick mismatch and the game runs to the capture's
// last turn (wrong rules desync or reach "game over" early). fixtx's own TX count is no measure: it runs the
// commands before they are moved. Else the candidate that stays in sync longest. convert(rules) -> pcap.js
// convertCapture result. Returns { rules, w2r, info, stats, clean, reached, tried: [{ rules, clean, reached }] }.
export async function convertDetectRules({ module, exe, files, pud, convert, candidates, onTry }) {
  let best = null; const tried = [];
  for (const rules of candidates) {
    if (onTry) onTry(rules);
    const raw = convert(rules);
    const { w2r, stats } = await fixtx({ module, exe, files, raw: raw.w2r, pud });
    const total = w2rTurnCount(w2r);
    const s = await SimSession.boot({ module, exe, files, replay: w2r, pud });
    while (!s.ended && !s.mismatch) s.step();
    const reached = s.mismatch ? s.mismatch.turn : s.turn, clean = !s.mismatch && s.lastStatus !== 5 && s.turn >= total;
    const r = { rules, w2r, info: raw.info, stats, clean, reached };
    tried.push({ rules, clean, reached });
    if (!best || (clean && !best.clean) || (!best.clean && reached > best.reached)) best = r;
    if (clean) break;
  }
  return { ...best, tried };
}
// Game tick after each turn of a .w2r (TURN chunks' tick_count), or null when they are not stamped (all 0).
export function w2rTurnTicks(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [];
  let any = false;
  for (let o = 8; o + 8 <= b.length;) {
    const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), len = dv.getUint32(o + 4, true);
    if (tag === 'TURN' && len >= 24) { const t = dv.getUint32(o + 8 + 16, true); out.push(t); if (t) any = true; }
    if (tag === 'END ') break;
    o += 8 + len;
  }
  return any ? Uint32Array.from(out) : null;
}
// Length of a .w2r's header (up to its first TURN / END chunk); 0 while the stream does not have all of it.
export function w2rHeadLength(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 8; o + 8 <= b.length;) {
    const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), len = dv.getUint32(o + 4, true);
    if (tag === 'TURN' || tag === 'END ') return o;
    if (tag !== 'MTCH' && tag !== 'PUD ' && tag !== 'POKE') return o;
    o += 8 + len;
    if (o > b.length) return 0;
  }
  return 0;
}
// Turn count of a .w2r ("W2R1", u32 version, chunks {u32 tag, u32 len, data}; END = u32 turn count).
export function w2rTurnCount(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 8; o + 8 <= b.length;) {
    const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), len = dv.getUint32(o + 4, true);
    if (tag === 'END ' && len >= 4) return dv.getUint32(o + 8, true);
    o += 8 + len;
  }
  return 0;
}

const PAGE_WORDS = 16384;   // 64 KB wasm pages
function pageHash(v, p) {
  let x = 0x811c9dc5 | 0, y = 0;
  for (let i = p * PAGE_WORDS, e = i + PAGE_WORDS; i < e; i++) { const w = v[i]; x = Math.imul(x ^ w, 16777619); y = (y + w) | 0; }
  return [x >>> 0, y >>> 0];
}

export class SimSession {
  static async _instance(module) {
    const s = new SimSession();
    const env = {
      w2_fatal_js(p, n) { throw new Error('w2_fatal: ' + s.str(p, n)); },
      w2_log_js(p, n) { (s.onLog || console.warn)(s.str(p, n)); },
    };
    s.inst = await WebAssembly.instantiate(module, { env });
    s.X = s.inst.exports;
    return s;
  }
  // opts: { module, exe: Uint8Array, files: [[name, Uint8Array]...], replay: Uint8Array, pud: Uint8Array|null,
  //         rules: plugin rule bits (W2_PATCH_PEON2K_022 0x100 / _023 0x200) or null = as the .w2r's MTCH says }
  static async boot(opts) {
    const s = await SimSession._instance(opts.module);
    const X = s.X;
    X.w2w_init();
    s.missPtr = X.w2w_vfs_log_misses();
    const rc = X.w2w_load_exe(s.put(opts.exe), opts.exe.length);
    if (rc) throw new Error(`w2w_load_exe failed (${rc}): not Warcraft II BNE 2.02?`);
    for (const [name, data] of opts.files) X.w2w_vfs_add(s.putStr(name), s.put(data), data.length);
    // live (a stream still growing): only the header goes in; step() then feeds each TURN chunk from opts.source()
    // (the bytes so far) through a fixed buffer, and waits (status -2) at the end of what has arrived
    s.live = opts.source || null;
    const head = s.live ? opts.replay.subarray(0, w2rHeadLength(opts.replay)) : opts.replay;
    const np = X.w2w_replay_open(s.put(head), head.length);
    if (!np) throw new Error('not a .w2r replay');
    if (s.live) { s.feedCap = 1 << 16; s.feedP = X.w2w_malloc(s.feedCap); s.chunkAt = [head.length]; }
    s.pudName = s.cstr(np, 600);
    s.mtchRules = X.w2w_replay_rules();                       // plugin rule bits the .w2r says (W2_PATCH_PEON2K_*)
    if (opts.rules != null) X.w2w_replay_set_rules(opts.rules);
    s.rules = X.w2w_replay_rules();
    s.pudSize = X.w2w_replay_pud_size();
    const pud = s.pudSize ? opts.pud : null;
    if (s.pudSize && !pud) throw new Error(`replay needs the custom map ${s.pudName}`);
    const rb = X.w2w_replay_boot(pud ? s.put(pud) : 0, pud ? pud.length : 0);
    if (rb === -2) throw new Error(`the PUD does not match the replay (${s.pudName}, ${s.pudSize} bytes)`);
    if (rb) throw new Error(`w2w_replay_boot -> ${rb}`);
    s.base = X.w2w_arena_base();
    s.turn = 0; s.ended = false; s.lastStatus = 0;
    s.hookSeq = X.w2w_hook_tail();
    return s;
  }
  put(bytes) { const p = this.X.w2w_malloc(bytes.length || 1); new Uint8Array(this.X.memory.buffer).set(bytes, p); return p; }
  putStr(s) { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return this.put(b); }
  str(p, n) { return dec.decode(new Uint8Array(this.X.memory.buffer, p, n)); }
  cstr(p, max = 256) { const m = new Uint8Array(this.X.memory.buffer, p, max); let n = m.indexOf(0); if (n < 0) n = max; return dec.decode(m.subarray(0, n)); }
  misses() { const n = this.X.w2w_vfs_misses_len(); return n ? this.str(this.missPtr, n).split('\n').filter(Boolean) : []; }

  // Run one turn. Returns the w2w_replay_step status: 0 ok, 1 hash, 2 tick, 3 TX mismatch, 4 game over,
  // 5 not ready, -1 end of file; live, -2: the next turn has not arrived (nothing ran). The session is `ended` after 4/5/-1.
  step() {
    if (this.ended) return this.lastStatus;
    if (this.live) {
      const c = this.nextChunk();
      if (c === null) return -2;                 // not here yet
      if (c) {
        if (c.length > this.feedCap) throw new Error(`a turn of ${c.length} bytes`);
        new Uint8Array(this.X.memory.buffer).set(c, this.feedP);
        this.X.w2w_replay_feed(this.feedP, c.length);
      } else this.X.w2w_replay_feed(this.feedP, 0);   // END: the replay is over
    }
    const st = this.X.w2w_replay_step();
    this.lastStatus = st;
    if (st === -1 || st === 4 || st === 5) this.ended = true;
    if (st !== -1) this.turn++;
    if (st >= 1 && st <= 3 && !this.mismatch) this.mismatch = { turn: this.turn - 1, status: st };
    return st;
  }
  get tick() { return this.X.w2w_tick_count(); }
  // live: the TURN chunk of turn this.turn (with whatever non-TURN chunks precede it), false at END, null when it has
  // not arrived. chunkAt[k] = where the chunks before turn k's TURN start (offsets in the growing stream).
  nextChunk() {
    const b = this.live(), at = this.chunkAt;
    while (at.length <= this.turn + 1) {         // find the TURN chunk after at[last]
      let o = at[at.length - 1];
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (;;) {
        if (o + 8 > b.length) return null;
        const len = dv.getUint32(o + 4, true), tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
        if (o + 8 + len > b.length) return null;
        if (tag === 'END ') return false;
        o += 8 + len;
        if (tag === 'TURN') { at.push(o); break; }
      }
    }
    // only the TURN chunk itself (the others are CamRec data and such, the sim skips them anyway)
    const end = at[this.turn + 1], dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = at[this.turn];
    while (o < end) { const len = dv.getUint32(o + 4, true); if (b[o] === 0x54 && b[o + 1] === 0x55 && b[o + 2] === 0x52 && b[o + 3] === 0x4e) return b.subarray(o, o + 8 + len); o += 8 + len; }
    return false;
  }

  // ---- state dumps (the viewer's seek cache). The whole state is the wasm memory (the module's only mutable global
  // is the stack pointer, back at its start between calls) plus the fields below. A dump keeps only the 64 KB pages
  // that differ from the freshly booted game (pageHashes() of a fresh boot of the same replay and rules: about 22 of
  // 2846 pages, ~1.4 MB); restore() goes into a fresh boot of it. Pages compare by two 32-bit hashes: a page that
  // changed and still matched both would make the restored game diverge, which the per-turn replay hash catches.
  pageHashes() {
    const v = new Int32Array(this.X.memory.buffer), np = v.length / PAGE_WORDS, h = new Uint32Array(2 * np);
    for (let p = 0; p < np; p++) { const [x, y] = pageHash(v, p); h[2 * p] = x; h[2 * p + 1] = y; }
    return h;
  }
  dump(base) {
    const v = new Int32Array(this.X.memory.buffer), np = v.length / PAGE_WORDS, nb = base.length / 2, pages = [];
    for (let p = 0; p < np; p++) {
      if (p < nb) { const [x, y] = pageHash(v, p); if (x === base[2 * p] && y === base[2 * p + 1]) continue; }
      pages.push([p, new Int32Array(v.subarray(p * PAGE_WORDS, (p + 1) * PAGE_WORDS))]);
    }
    return { bytes: v.byteLength, pages, turn: this.turn, ended: this.ended, lastStatus: this.lastStatus, mismatch: this.mismatch, hookSeq: this.hookSeq };
  }
  restore(d) {
    const mem = this.X.memory, more = (d.bytes - mem.buffer.byteLength) / (PAGE_WORDS * 4);
    if (more > 0) mem.grow(more);
    const v = new Int32Array(mem.buffer);
    for (const [p, words] of d.pages) v.set(words, p * PAGE_WORDS);
    Object.assign(this, { turn: d.turn, ended: d.ended, lastStatus: d.lastStatus, mismatch: d.mismatch, hookSeq: d.hookSeq, fromDump: true });
  }
  get hash() { return this.X.w2w_replay_hash() >>> 0; }

  // Arena views (re-created on every call: memory.grow detaches old ones). Address a -> u8[base + a].
  mem() {
    const buf = this.X.memory.buffer;
    if (this._buf !== buf) { this._buf = buf; this._u8 = new Uint8Array(buf); this._dv = new DataView(buf); }
    const b = this.base, u8 = this._u8, dv = this._dv;
    return {
      base: b, u8, dv,
      r8: a => u8[b + a], r16: a => dv.getUint16(b + a, true), s16: a => dv.getInt16(b + a, true),
      r32: a => dv.getUint32(b + a, true), cstr: (a, n = 64) => this.cstr(b + a, n),
      bytes: (a, n) => u8.subarray(b + a, b + a + n),
    };
  }
  // New hook events since the last call: [{tick, kind, a, b, c, d}]
  drainHooks() {
    const X = this.X, ring = X.w2w_hook_ring(), size = X.w2w_hook_ring_size(), head = X.w2w_hook_head(), tail = X.w2w_hook_tail();
    if (this.hookSeq < tail) this.hookSeq = tail;
    const v = new Uint32Array(X.memory.buffer), out = [];
    for (; this.hookSeq < head; this.hookSeq++) {
      const o = (ring >>> 2) + 6 * (this.hookSeq & (size - 1));
      out.push({ tick: v[o], kind: v[o + 1], a: v[o + 2], b: v[o + 3], c: v[o + 4], d: v[o + 5] });
    }
    return out;
  }
}
