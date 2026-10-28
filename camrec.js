// CamRec (plugins/camrec, camrec.w2p): each player's viewport and mouse during the game, recorded by the plugin and
// shown by the viewer (presentation only, the sim never sees it).
//
// Sources, all carrying the same packets (format: plugins/camrec/README.md):
//   - a capture: the plugin's UDP broadcasts to port 34755 (every player that ran it);
//   - camrec\*.w2c files the plugin writes ("W2CF", u32 version, records {u16 len, packet});
//   - a converted .w2r: a 'CAMR' chunk after 'END ' holding a .w2c image (the sim's readers stop at END);
//   - a live stream (livecap.js): 'CAMP' chunks between the turns, each some .w2c records (no file header).
// Packet: "W2CM", u8 version 1, u8 kind (1 start, 2 samples, 3 end), u8 player, u8 peer, u32 session, u16 seq, u16 0.
//   start: +16 local IPX address[16], u16 map size, u8 extended, u8 multiplayer, u16 tiles w, h, s16 map rect[4],
//          s16 minimap rect[4], u32 SyncRng, u16 time[6], char map[32]
//   samples: +16 u16 n, u16 0, n x {u32 tick, u16 ms since that tick began, u8 view x, u8 view y, s16 mouse x, y}
//   end: +16 u32 tick
//   micinfo (4): +16 u8 state, u8 codec (1 = IMA ADPCM), u16 rate, u16 block samples, u16 flags (1 gate, 2 broadcast,
//          4 silent), u32 peak level, u32 blocks, u32 dropped, char device[32]
//   audio (5): +16 u32 tick, u16 ms, u16 flags (1 speech starts, 2 speech ends), u32 sample index (the plugin's
//          microphone clock), u16 n, s16 ADPCM predictor, u8 step index, u8 0, u16 0, then (n + 1) / 2 bytes of 4-bit
//          IMA ADPCM, first sample in the low nibble. Each block decodes alone (its own start state).
//   input (6): +16 u16 n, u16 0, n x {u32 tick, u16 ms, u8 type, u8 mods (Shift 2, Ctrl 4, Alt 8), u16 a, u16 b}:
//          type 0 key down / 2 key up (a = virtual key, b = typed character), 4 left down, 5 left up, 6 left double,
//          7 right down, 8 right up, 9 right double (a, b = s16 screen point), 32 drag box up (a, b = where it
//          started; mods 2 = Shift: adds to the selection), 33 drag box down (a, b = the mouse)
// Tick = g_TickCount, the same counter the replay advances, so a sample belongs at tick + ms / tickMs.
import { udpDatagrams } from './pcap.js';

export const CAM_PORT = 34755;
const MAGIC = [0x57, 0x32, 0x43, 0x4d];      // W2CM
const FILE_MAGIC = [0x57, 0x32, 0x43, 0x46]; // W2CF
const dec = new TextDecoder('latin1');
export const isCamPacket = p => p.length >= 16 && MAGIC.every((c, i) => p[i] === c) && p[4] === 1;

export function camPacketsFromCapture(bytes) {
  const out = [];
  for (const d of udpDatagrams(bytes)) if (d.dp === CAM_PORT && isCamPacket(d.pl)) out.push(d.pl.slice());
  return out;
}
export function isW2c(b) { return b.length >= 8 && FILE_MAGIC.every((c, i) => b[i] === c); }
export function camPacketsFromW2c(b) {
  if (!isW2c(b)) return [];
  return camRecords(b, 8);
}
// .w2c records {u16 len, packet} from offset i (a .w2c after its header; a live stream's CAMP chunk: livecap.js)
function camRecords(b, i = 0) {
  const out = [];
  for (; i + 2 <= b.length;) {
    const n = b[i] | b[i + 1] << 8; i += 2;
    if (i + n > b.length) break;
    const p = b.subarray(i, i + n); i += n;
    if (isCamPacket(p)) out.push(p.slice());
  }
  return out;
}
// The packets as a .w2c image (duplicates dropped: a capture can hold a broadcast twice).
export function w2cImage(packets) {
  const seen = new Set(), keep = [];
  for (const p of packets) { const k = p.join(','); if (!seen.has(k)) { seen.add(k); keep.push(p); } }
  let n = 8; for (const p of keep) n += 2 + p.length;
  const o = new Uint8Array(n); o.set([...FILE_MAGIC, 1, 0, 0, 0]); n = 8;
  for (const p of keep) { o[n] = p.length & 0xff; o[n + 1] = p.length >> 8; o.set(p, n + 2); n += 2 + p.length; }
  return o;
}
// .w2r chunks
function chunks(w2r) {
  const dv = new DataView(w2r.buffer, w2r.byteOffset, w2r.byteLength), out = [];
  for (let o = 8; o + 8 <= w2r.length;) {
    const len = dv.getUint32(o + 4, true);
    out.push({ tag: String.fromCharCode(...w2r.subarray(o, o + 4)), at: o, data: w2r.subarray(o + 8, o + 8 + len) });
    o += 8 + len;
  }
  return out;
}
export function camPacketsFromW2r(w2r) {
  const out = [];
  for (const c of chunks(w2r)) {
    if (c.tag === 'CAMR') out.push(...camPacketsFromW2c(c.data));
    else if (c.tag === 'CAMP') out.push(...camRecords(c.data));   // a live stream's pieces (livecap.js)
  }
  return out;
}
// w2r with its CAMR chunk replaced by these packets (none: removed).
export function withCamChunk(w2r, packets) {
  const old = chunks(w2r).find(c => c.tag === 'CAMR');
  const base = old ? w2r.subarray(0, old.at) : w2r;
  if (!packets.length) return base.slice();
  const img = w2cImage(packets), o = new Uint8Array(base.length + 8 + img.length);
  o.set(base); o.set([0x43, 0x41, 0x4d, 0x52], base.length);
  new DataView(o.buffer).setUint32(base.length + 4, img.length, true);
  o.set(img, base.length + 8);
  return o;
}

export function parsePacket(p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const d = { kind: p[5], player: p[6], peer: p[7], session: dv.getUint32(8, true), seq: dv.getUint16(12, true) };
  if (d.kind === 1 && p.length >= 104) {
    const s16 = o => dv.getInt16(o, true);
    d.start = { node: p.slice(20, 26), mapSize: dv.getUint16(32, true), extended: p[34], multiplayer: p[35],
      tiles: [dv.getUint16(36, true), dv.getUint16(38, true)],
      mapRect: [s16(40), s16(42), s16(44), s16(46)], miniRect: [s16(48), s16(50), s16(52), s16(54)],
      rng: dv.getUint32(56, true), time: [60, 62, 64, 66, 68, 70].map(o => dv.getUint16(o, true)),
      map: dec.decode(p.subarray(72, 104)).replace(/\0.*$/s, '') };
  } else if (d.kind === 2 && p.length >= 20) {
    const n = Math.min(dv.getUint16(16, true), Math.floor((p.length - 20) / 12));
    d.samples = [];
    for (let i = 0, o = 20; i < n; i++, o += 12)
      d.samples.push([dv.getUint32(o, true), dv.getUint16(o + 4, true), p[o + 6], p[o + 7], dv.getInt16(o + 8, true), dv.getInt16(o + 10, true)]);
  } else if (d.kind === 6 && p.length >= 20) {
    const n = Math.min(dv.getUint16(16, true), Math.floor((p.length - 20) / 12));
    d.input = [];
    for (let i = 0, o = 20; i < n; i++, o += 12) {
      const type = p[o + 6], key = type === 0 || type === 2;
      d.input.push([dv.getUint32(o, true), dv.getUint16(o + 4, true), type, p[o + 7],
        key ? dv.getUint16(o + 8, true) : dv.getInt16(o + 8, true), key ? dv.getUint16(o + 10, true) : dv.getInt16(o + 10, true)]);
    }
  } else if (d.kind === 3 && p.length >= 20) d.endTick = dv.getUint32(16, true);
  else if (d.kind === 4 && p.length >= 68)
    d.mic = { state: p[16], codec: p[17], rate: dv.getUint16(18, true), block: dv.getUint16(20, true), flags: dv.getUint16(22, true),
      peak: dv.getUint32(24, true), blocks: dv.getUint32(28, true), drops: dv.getUint32(32, true), device: dec.decode(p.subarray(36, 68)).replace(/\0.*$/s, '') };
  else if (d.kind === 5 && p.length >= 36) {
    const n = dv.getUint16(28, true), flags = dv.getUint16(22, true);
    d.audio = { tick: dv.getUint32(16, true), ms: dv.getUint16(20, true), start: !!(flags & 1), end: !!(flags & 2),
      sample: dv.getUint32(24, true), n, pred: dv.getInt16(30, true), index: Math.min(88, p[32]), data: p.subarray(36, 36 + ((n + 1) >> 1)) };
  }
  return d;
}

// One track per player: the session with the most samples (a capture or folder may hold several games).
// track = { player, session, start, endTick, tick: Uint32Array, ms, vx, vy, mx, my (sorted by time), n }
export function buildTracks(packets) {
  const by = new Map();
  for (const raw of packets) {
    const d = parsePacket(raw), k = `${d.player}:${d.session}`;
    let s = by.get(k); if (!s) by.set(k, s = { player: d.player, session: d.session, peer: d.peer, start: null, endTick: null, seqs: new Set(), samples: [], input: [] });
    if (s.seqs.has(d.seq)) continue;
    s.seqs.add(d.seq);
    if (d.start) s.start = d.start;
    if (d.samples) s.samples.push(...d.samples);
    if (d.input) s.input.push(...d.input);
    if (d.endTick != null) s.endTick = d.endTick;
  }
  const tracks = new Map();
  for (const s of by.values()) {
    const cur = tracks.get(s.player);
    if (!cur || s.samples.length > cur.n) {
      s.samples.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const n = s.samples.length, col = j => Uint32Array.from(s.samples, x => x[j]);
      tracks.set(s.player, { player: s.player, peer: s.peer, session: s.session, start: s.start, endTick: s.endTick, n,
        tick: col(0), ms: col(1), vx: col(2), vy: col(3), mx: Int16Array.from(s.samples, x => x[4]), my: Int16Array.from(s.samples, x => x[5]),
        input: inputTrack(s.input) });
    }
  }
  return tracks;
}

// ---------------------------------------------------------------- input (keys, mouse buttons, drag box)
export const IN = { KEY_DOWN: 0, KEY_UP: 2, L_DOWN: 4, L_UP: 5, L_DOUBLE: 6, R_DOWN: 7, R_UP: 8, R_DOUBLE: 9, DRAG_START: 32, DRAG_END: 33 };
const isAction = type => type === 0 || type === 4 || type === 6 || type === 7 || type === 9;   // what APM counts
// Sorted by time; t = tick + ms (fractional ticks once the tick length is known: tickMs set by inputAt), and the
// running count of actions (key presses and mouse presses) for APM. Null without input packets (older plugin).
function inputTrack(list) {
  if (!list.length) return null;
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = list.length, acts = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) acts[i + 1] = acts[i] + (isAction(list[i][2]) ? 1 : 0);
  return { n, tick: Uint32Array.from(list, x => x[0]), ms: Uint16Array.from(list, x => x[1]), type: Uint8Array.from(list, x => x[2]),
    mods: Uint8Array.from(list, x => x[3]), a: Int32Array.from(list, x => x[4]), b: Int32Array.from(list, x => x[5]), acts };
}
const VK_NAMES = { 0x08: 'Bksp', 0x09: 'Tab', 0x0d: 'Enter', 0x10: 'Shift', 0x11: 'Ctrl', 0x12: 'Alt', 0x13: 'Pause', 0x14: 'Caps',
  0x1b: 'Esc', 0x20: 'Space', 0x21: 'PgUp', 0x22: 'PgDn', 0x23: 'End', 0x24: 'Home', 0x25: '←', 0x26: '↑', 0x27: '→', 0x28: '↓',
  0x2c: 'PrtSc', 0x2d: 'Ins', 0x2e: 'Del', 0x6a: '*', 0x6b: '+', 0x6d: '-', 0x6e: '.', 0x6f: '/', 0xba: ';', 0xbb: '=',
  0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '`', 0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'" };
// A key press as a keycap label: "Ctrl+A", "F10", "Esc"; a vk-less press is a typed character.
export function keyLabel(vk, ch, mods) {
  let k = VK_NAMES[vk];
  if (!k) {
    if (vk >= 0x30 && vk <= 0x39 || vk >= 0x41 && vk <= 0x5a) k = String.fromCharCode(vk);
    else if (vk >= 0x60 && vk <= 0x69) k = 'Num' + (vk - 0x60);
    else if (vk >= 0x70 && vk <= 0x87) k = 'F' + (vk - 0x6f);
    else if (!vk && ch >= 0x20 && ch < 0x7f) k = String.fromCharCode(ch);
    else if (!vk && ch) k = dec.decode(Uint8Array.of(ch));
    else k = '#' + vk.toString(16);
  }
  if (vk >= 0x10 && vk <= 0x12) return k;   // a modifier alone
  return (mods & 4 ? 'Ctrl+' : '') + (mods & 8 ? 'Alt+' : '') + (mods & 2 && k.length > 1 ? 'Shift+' : '') + k;
}
// The input at game time t (fractional ticks): held buttons and keys' modifiers, the drag box (where it started),
// recent clicks and key presses (age in ticks, newest last, within `recent` ticks) and actions per minute.
export function inputAt(tr, t, tickMs, recent) {
  const I = tr && tr.input;
  if (!I) return null;
  const at = i => I.tick[i] + Math.min(0.999, I.ms[i] / tickMs);
  let lo = 0, hi = I.n - 1, last = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (at(mid) <= t) { last = mid; lo = mid + 1; } else hi = mid - 1; }
  const out = { left: false, right: false, mods: 0, drag: null, clicks: [], keys: [], apm: 0 };
  // held state: the latest event of each kind (looking back a bounded number of events)
  let gotL = false, gotR = false, gotD = false, gotM = false;
  for (let i = last; i >= 0 && last - i < 4000 && !(gotL && gotR && gotD && gotM); i--) {
    const ty = I.type[i];
    if (!gotL && ty >= 4 && ty <= 6) { gotL = true; out.left = ty !== 5; }
    else if (!gotR && ty >= 7 && ty <= 9) { gotR = true; out.right = ty !== 8; }
    else if (!gotD && (ty === 32 || ty === 33)) { gotD = true; if (ty === 32) out.drag = { x: I.a[i], y: I.b[i], shift: !!(I.mods[i] & 2), t: at(i) }; }
    if (!gotM && (ty === 0 || ty === 2)) {   // modifiers as of the last key event (its own key counted)
      gotM = true; let m = I.mods[i];
      const bit = { 0x10: 2, 0x11: 4, 0x12: 8 }[I.a[i]];
      if (bit) m = ty === 0 ? m | bit : m & ~bit;
      out.mods = m;
    }
  }
  for (let i = last; i >= 0 && t - at(i) <= recent; i--) {
    const ty = I.type[i], age = t - at(i);
    if (ty === 4 || ty === 6 || ty === 7 || ty === 9) out.clicks.unshift({ x: I.a[i], y: I.b[i], right: ty >= 7, double: ty === 6 || ty === 9, mods: I.mods[i], age, t: at(i) });
    else if (ty === 0) out.keys.unshift({ label: keyLabel(I.a[i], I.b[i], I.mods[i]), vk: I.a[i], age });
  }
  // APM: actions in the last game minute (less at the start: scaled to the time so far)
  const win = 60000 / tickMs, from = t - win;
  let j = 0; lo = 0; hi = last;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (at(mid) <= from) { j = mid + 1; lo = mid + 1; } else hi = mid - 1; }
  const n = I.acts[last + 1] - I.acts[j], span = Math.min(win, Math.max(t, 1));
  out.apm = last < 0 ? 0 : Math.round(n * win / Math.max(span, win / 6));
  return out;
}

// The state at game time t (ticks, fractional): the last sample at or before it, or null before the first.
export function camAt(tr, t, tickMs) {
  if (!tr || !tr.n) return null;
  const at = i => tr.tick[i] + Math.min(0.999, tr.ms[i] / tickMs);
  if (at(0) > t) return null;
  let lo = 0, hi = tr.n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at(mid) <= t) lo = mid; else hi = mid - 1; }
  if (tr.endTick != null && t > tr.endTick + 1) return null;
  return { vx: tr.vx[lo], vy: tr.vy[lo], mx: tr.mx[lo], my: tr.my[lo], i: lo };
}

// Map geometry of a track (the plugin's start packet; Classic 640x480 defaults).
export function trackGeometry(tr) {
  const s = tr && tr.start;
  const r = s ? s.mapRect : [176, 16, 623, 463], t = s ? s.tiles : [14, 14];
  return { mapX: r[0], mapY: r[1], mapW: r[2] - r[0] + 1, mapH: r[3] - r[1] + 1, tilesW: t[0], tilesH: t[1],
    mini: s ? { x: s.miniRect[0], y: s.miniRect[1], w: s.miniRect[2] - s.miniRect[0] + 1, h: s.miniRect[3] - s.miniRect[1] + 1 } : { x: 24, y: 26, w: 128, h: 128 } };
}
// Where the mouse points: 'map' (with map pixel), 'minimap' (with map pixel), or 'panel'.
export function mouseTarget(c, g, mapSize) {
  if (c.mx >= g.mapX && c.mx < g.mapX + g.mapW && c.my >= g.mapY && c.my < g.mapY + g.mapH)
    return { where: 'map', x: c.vx * 32 + c.mx - g.mapX, y: c.vy * 32 + c.my - g.mapY };
  const M = g.mini;
  if (c.mx >= M.x && c.mx < M.x + M.w && c.my >= M.y && c.my < M.y + M.h)
    return { where: 'minimap', x: (c.mx - M.x) / M.w * mapSize * 32, y: (c.my - M.y) / M.h * mapSize * 32 };
  return { where: 'panel' };
}

// The game's cursors (Art\h_arrow.cur / o_arrow.cur: u16 hot x, hot y, w, h, then w*h palette indices, 0 = clear).
export function loadCursor(bytes, rgb) {
  if (!bytes || bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hx = dv.getUint16(0, true), hy = dv.getUint16(2, true), w = dv.getUint16(4, true), h = dv.getUint16(6, true);
  if (!w || !h || bytes.length < 8 + w * h) return null;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = bytes[8 + i]; if (!c) continue;
    const [r, g, b] = rgb[c] || [255, 255, 255];
    px[4 * i] = r; px[4 * i + 1] = g; px[4 * i + 2] = b; px[4 * i + 3] = 255;
  }
  return { hx, hy, w, h, px };
}

// ---------------------------------------------------------------- microphone (camrec.c, micdsp.h)
export const MIC_STATES = ['off', 'starting', 'recording', 'unavailable', 'no device', 'lost', 'stopped'];
export const MIC_RATE = 16000;
const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132,
  7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
// One block (IMA ADPCM, low nibble first, from its own start state) into out[off..off+n) as -1..1 floats.
export function adpcmDecode(a, out, off = 0) {
  let pred = a.pred, index = a.index;
  for (let i = 0; i < a.n; i++) {
    const byte = a.data[i >> 1] || 0, code = i & 1 ? byte >> 4 : byte & 15;
    const step = IMA_STEP[index]; let vp = step >> 3;
    if (code & 4) vp += step; if (code & 2) vp += step >> 1; if (code & 1) vp += step >> 2;
    pred += code & 8 ? -vp : vp;
    if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
    index += IMA_INDEX[code]; if (index < 0) index = 0; else if (index > 88) index = 88;
    out[off + i] = pred / 32768;
  }
}
// One microphone track per player: the session of that player's camera track when there is one (the same game),
// else the session with the most audio. track = { player, session, info (last micinfo), blocks (by sample index) }
export function buildMicTracks(packets, camTracks = new Map()) {
  const by = new Map();
  for (const raw of packets) {
    if (raw[5] !== 4 && raw[5] !== 5) continue;
    const d = parsePacket(raw), k = `${d.player}:${d.session}`;
    let s = by.get(k); if (!s) by.set(k, s = { player: d.player, session: d.session, info: null, infoSeq: -1, blocks: new Map() });
    if (d.mic && d.seq >= s.infoSeq) { s.info = d.mic; s.infoSeq = d.seq; }
    if (d.audio && d.audio.n) s.blocks.set(d.audio.sample, d.audio);
  }
  const tracks = new Map();
  for (const s of by.values()) {
    const cam = camTracks.get(s.player);
    if (cam && cam.session !== s.session) continue;
    const cur = tracks.get(s.player);
    if (!cur || s.blocks.size > cur.blocks.length)
      tracks.set(s.player, { player: s.player, session: s.session, info: s.info, blocks: [...s.blocks.values()].sort((a, b) => a.sample - b.sample) });
  }
  for (const [p, t] of tracks) if (!t.blocks.length && !t.info) tracks.delete(p);
  return tracks;
}
// The track as playable chunks: consecutive blocks on the microphone clock, starting at the game time of their
// first block (tick + ms; a lag stall's ms past the tick is clamped, so speech during a stall starts where the game
// stood) and never before the previous chunk ends. Long speech (or a recording without the voice gate) is cut
// into MIC_CHUNK_S pieces, each `cont`inuing the previous one. chunk = { t0 (ticks), dur (s), blocks, n, cont }
export const MIC_CHUNK_S = 30;
export function micChunks(track, tickMs) {
  const out = []; let cur = null;
  const T = b => b.tick + Math.min(b.ms, tickMs * 0.999) / tickMs;
  for (const b of track.blocks) {
    const contiguous = cur && b.sample === cur.end && !b.start;
    const late = cur && T(b) > cur.t0 + (b.sample - cur.sample0) / MIC_RATE * 1000 / tickMs + 300 / tickMs;   // the game ran on without audio
    if (!contiguous || late) {
      const prevEnd = cur ? cur.t0 + cur.dur * 1000 / tickMs : -Infinity;
      cur = { t0: Math.max(T(b), prevEnd), dur: 0, blocks: [], n: 0, sample0: b.sample, end: b.sample, cont: null };
      out.push(cur);
    } else if (cur.dur >= MIC_CHUNK_S) {
      const prev = cur;
      cur = { t0: prev.t0 + prev.dur * 1000 / tickMs, dur: 0, blocks: [], n: 0, sample0: b.sample, end: b.sample, cont: prev };
      out.push(cur);
    }
    cur.blocks.push(b); cur.n += b.n; cur.end = b.sample + b.n; cur.dur = cur.n / MIC_RATE;
  }
  return out;
}
// A chunk's samples (-1..1).
export function micChunkPcm(chunk) {
  const out = new Float32Array(chunk.n); let o = 0;
  for (const b of chunk.blocks) { adpcmDecode(b, out, o); o += b.n; }
  return out;
}
