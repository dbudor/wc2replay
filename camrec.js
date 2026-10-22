// CamRec (plugins/camrec, camrec.w2p): each player's viewport and mouse during the game, recorded by the plugin and
// shown by the viewer (presentation only, the sim never sees it).
//
// Sources, all carrying the same packets (format: plugins/camrec/README.md):
//   - a capture: the plugin's UDP broadcasts to port 34755 (every player that ran it);
//   - camrec\*.w2c files the plugin writes ("W2CF", u32 version, records {u16 len, packet});
//   - a converted .w2r: a 'CAMR' chunk after 'END ' holding a .w2c image (the sim's readers stop at END).
// Packet: "W2CM", u8 version 1, u8 kind (1 start, 2 samples, 3 end), u8 player, u8 peer, u32 session, u16 seq, u16 0.
//   start: +16 local IPX address[16], u16 map size, u8 extended, u8 multiplayer, u16 tiles w, h, s16 map rect[4],
//          s16 minimap rect[4], u32 SyncRng, u16 time[6], char map[32]
//   samples: +16 u16 n, u16 0, n x {u32 tick, u16 ms since that tick began, u8 view x, u8 view y, s16 mouse x, y}
//   end: +16 u32 tick
// Tick = g_TickCount, the same counter the replay advances, so a sample belongs at tick + ms / tickMs.
import { udpDatagrams } from './pcap.js';

export const CAM_PORT = 34755;
const MAGIC = [0x57, 0x32, 0x43, 0x4d];      // W2CM
const FILE_MAGIC = [0x57, 0x32, 0x43, 0x46]; // W2CF
const dec = new TextDecoder('latin1');
const isPacket = p => p.length >= 16 && MAGIC.every((c, i) => p[i] === c) && p[4] === 1;

export function camPacketsFromCapture(bytes) {
  const out = [];
  for (const d of udpDatagrams(bytes)) if (d.dp === CAM_PORT && isPacket(d.pl)) out.push(d.pl.slice());
  return out;
}
export function isW2c(b) { return b.length >= 8 && FILE_MAGIC.every((c, i) => b[i] === c); }
export function camPacketsFromW2c(b) {
  if (!isW2c(b)) return [];
  const out = [];
  for (let i = 8; i + 2 <= b.length;) {
    const n = b[i] | b[i + 1] << 8; i += 2;
    if (i + n > b.length) break;
    const p = b.subarray(i, i + n); i += n;
    if (isPacket(p)) out.push(p.slice());
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
  const c = chunks(w2r).find(c => c.tag === 'CAMR');
  return c ? camPacketsFromW2c(c.data) : [];
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
  } else if (d.kind === 3 && p.length >= 20) d.endTick = dv.getUint32(16, true);
  return d;
}

// One track per player: the session with the most samples (a capture or folder may hold several games).
// track = { player, session, start, endTick, tick: Uint32Array, ms, vx, vy, mx, my (sorted by time), n }
export function buildTracks(packets) {
  const by = new Map();
  for (const raw of packets) {
    const d = parsePacket(raw), k = `${d.player}:${d.session}`;
    let s = by.get(k); if (!s) by.set(k, s = { player: d.player, session: d.session, peer: d.peer, start: null, endTick: null, seqs: new Set(), samples: [] });
    if (s.seqs.has(d.seq)) continue;
    s.seqs.add(d.seq);
    if (d.start) s.start = d.start;
    if (d.samples) s.samples.push(...d.samples);
    if (d.endTick != null) s.endTick = d.endTick;
  }
  const tracks = new Map();
  for (const s of by.values()) {
    const cur = tracks.get(s.player);
    if (!cur || s.samples.length > cur.n) {
      s.samples.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const n = s.samples.length, col = j => Uint32Array.from(s.samples, x => x[j]);
      tracks.set(s.player, { player: s.player, peer: s.peer, session: s.session, start: s.start, endTick: s.endTick, n,
        tick: col(0), ms: col(1), vx: col(2), vy: col(3), mx: Int16Array.from(s.samples, x => x[4]), my: Int16Array.from(s.samples, x => x[5]) });
    }
  }
  return tracks;
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
