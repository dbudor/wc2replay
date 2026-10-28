// Capture -> .w2r converter (browser and node): a port of tools/pcap/pcapread.py + tools/pcap/pcap2w2r.py that
// produces the same bytes as the python script (before its --w2test step). The -fixtx step (move the recording
// peer's commands to their UI frame, stamp the hashes) then runs in the wasm sim: sim.js fixtx(). See
// sim/NET_TURNS.md section 9.
//
//   const cap = parseCapture(bytes)            // throws CaptureError for anything that is not a War2 IPX game
//   cap.peers, cap.host, cap.extended, cap.mapName, cap.customMap, cap.peerNames
//   const { w2r, info } = convertCapture(cap, { peer, pud, pudName, pokes })
//     peer: the player whose view the replay takes (default: the host); pud/pudName: the custom map's bytes
//     and file name (the PUD chunk names it); pokes: a test recording's .w2r whose POKE chunks are copied.
//
// Wire format (one UDP datagram = one IPX datagram, ipxwrapper framing, UDP port 34754):
//   [6] sender IPX node  [u32 provider seq]  [War2 packet: len, peer, peer/to, seq, crc16, type, sync, ...]

export class CaptureError extends Error {}

// ---------------------------------------------------------------- pcapread.py
// Frames of a pcapng or classic pcap file: [{ts, lt, f}] (ts in seconds, as the python reader computes it).
export function captureFrames(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), out = [];
  const u32 = (o, le) => dv.getUint32(o, le), u16 = (o, le) => dv.getUint16(o, le);
  if (d.length >= 4 && d[0] === 0x0a && d[1] === 0x0d && d[2] === 0x0d && d[3] === 0x0a) {
    let off = 0, le = true, linktypes = [], tsres = [];
    while (off + 12 <= d.length) {
      let btype = u32(off, le), blen = u32(off + 4, le);
      if (btype === 0x0a0d0d0a) {
        le = u32(off + 8, true) === 0x1a2b3c4d;
        btype = u32(off, le); blen = u32(off + 4, le);
        linktypes = []; tsres = [];
      } else if (btype === 1) {
        linktypes.push(u16(off + 8, le)); let res = 1e-6;
        for (let o = off + 16; o + 4 <= off + blen - 4 && o + 4 <= d.length;) {
          const code = u16(o, le), ln = u16(o + 2, le);
          if (code === 0) break;
          if (code === 9) { const v = d[o + 4]; res = v & 0x80 ? 2 ** -(v & 0x7f) : Number('1e-' + v); }
          o += 4 + ((ln + 3) & ~3);
        }
        tsres.push(res);
      } else if (btype === 6) {
        if (off + 28 > d.length) break;
        const iface = u32(off + 8, le), th = u32(off + 12, le), tl = u32(off + 16, le), caplen = u32(off + 20, le);
        if (iface < linktypes.length) out.push({ ts: (th * 4294967296 + tl) * tsres[iface], lt: linktypes[iface], f: d.subarray(off + 28, off + 28 + caplen) });
      } else if (btype === 3) {
        if (linktypes.length) out.push({ ts: 0.0, lt: linktypes[0], f: d.subarray(off + 12, off + 12 + blen - 16) });
      }
      if (blen < 12) break;               // corrupt block
      off += blen;
    }
    return out;
  }
  const magic = d.length >= 24 ? u32(0, false) : 0;
  if (![0xd4c3b2a1, 0x4d3cb2a1, 0xa1b2c3d4, 0xa1b23c4d].includes(magic)) throw new CaptureError('not a pcap or pcapng capture');
  const le = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1, nano = magic === 0x4d3cb2a1 || magic === 0xa1b23c4d;
  const lt = u32(20, le);
  for (let off = 24; off + 16 <= d.length;) {
    const s = u32(off, le), us = u32(off + 4, le), cl = u32(off + 8, le);
    out.push({ ts: s + us * (nano ? 1e-9 : 1e-6), lt, f: d.subarray(off + 16, off + 16 + cl) });
    off += 16 + cl;
  }
  return out;
}

// IPv4 UDP datagrams: [{ts, src, sp, dst, dp, pl}]. Link types: 1 Ethernet (+802.1Q), 0 BSD loopback,
// 113 Linux SLL, 276 Linux SLL2, 101/228 raw IPv4.
export function udpDatagrams(d) {
  const out = [];
  for (const { ts, lt, f } of captureFrames(d)) { const u = frameUdp(ts, lt, f); if (u) out.push(u); }
  return out;
}
// One frame's IPv4 UDP datagram {ts, src, sp, dst, dp, pl}, or null.
export function frameUdp(ts, lt, f) {
  const be16 = o => f[o] << 8 | f[o + 1];
  let eth, o;
  if (lt === 1) { if (f.length < 14) return null; eth = be16(12); o = 14; }
  else if (lt === 0) { if (f.length < 4) return null; o = 4; eth = (f[0] | f[1] << 8 | f[2] << 16 | f[3] << 24) === 2 ? 0x800 : 0; }
  else if (lt === 113) { if (f.length < 16) return null; eth = be16(14); o = 16; }
  else if (lt === 276) { if (f.length < 20) return null; eth = be16(0); o = 20; }
  else if (lt === 101 || lt === 228) { eth = 0x800; o = 0; }
  else return null;
  if (eth === 0x8100) { if (f.length < o + 4) return null; eth = be16(o + 2); o += 4; }
  if (eth !== 0x800 || f.length < o + 20 || f[o + 9] !== 17) return null;
  const ihl = (f[o] & 15) * 4;
  if (f.length < o + ihl + 8) return null;
  const src = f.subarray(o + 12, o + 16).join('.'), dst = f.subarray(o + 16, o + 20).join('.');
  const sp = be16(o + ihl), dp = be16(o + ihl + 2), ul = be16(o + ihl + 4);
  return { ts, src, sp, dst, dp, pl: f.subarray(o + ihl + 8, Math.max(o + ihl + 8, o + ihl + ul)) };
}

// ---------------------------------------------------------------- pcap2w2r.py
export function crc16(w) {
  let h = 0x144;
  for (let i = 0; i < w[0]; i++) {
    const x = (h ^ (i === 4 || i === 5 ? 0 : w[i])) >>> 0;
    h = (x << 3 | x >>> 29) >>> 0;
  }
  return (h ^ (h >>> 16)) & 0xffff;
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
export function crc32(p) { let c = 0xffffffff; for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export const TRANSPORT = [2, 3, 4];   // resend request, NAK, hello
export const ADVERT = [5, 6, 9, 0xa, 0xb];
const latin1 = new TextDecoder('latin1');

// War2 packets on the ipxwrapper port: [{ts, src, node, pkt, mode}] (mode 0 Classic crc, 1 Enhanced crc ^ 0xaa55)
function loadPackets(bytes, port) {
  const out = []; let udp = 0, onPort = 0;
  for (const d of udpDatagrams(bytes)) {
    udp++;
    if (d.sp !== port && d.dp !== port) continue;
    onPort++;
    const p = war2Packet(d); if (p) out.push(p);
  }
  return { P: out, udp, onPort };
}
// A datagram on the ipxwrapper port as a War2 packet {ts, src, node, pkt, mode}, or null (bad length / crc)
export function war2Packet({ ts, src, pl }) {
  if (pl.length < 10 + 8) return null;
  const node = pl.subarray(0, 6); let w = pl.subarray(10);
  if (!(w[0] >= 8 && w[0] <= 0xd0) || w.length < w[0]) return null;
  w = w.subarray(0, w[0]);
  const got = w[4] | w[5] << 8, c = crc16(w);
  const mode = got === c ? 0 : got === (c ^ 0xaa55) ? 1 : null;
  if (mode === null) return null;
  return { ts, src, node, pkt: w, mode };
}

// Parse a capture: the War2 packets, the peers and the lobby's start packet. Throws CaptureError.
export function parseCapture(bytes, { port = 34754 } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const { P, udp, onPort } = loadPackets(bytes, port);
  const notGame = why => new CaptureError(`not a Warcraft II IPX game capture: ${why}`);
  if (!udp) throw notGame('it holds no IPv4 UDP traffic');
  if (!onPort) throw notGame(`no UDP traffic on port ${port} (IPX over UDP, ipxwrapper)`);
  if (!P.length) throw notGame(`no Warcraft II packets on UDP port ${port}`);
  return packetsInfo(P, port);
}
// The peers, the start packet and the lobby's settings of War2 packets P (war2Packet), as parseCapture returns them.
// livecap.js calls it with the packets up to the start packet.
export function packetsInfo(P, port = 34754) {
  const notGame = why => new CaptureError(`not a Warcraft II IPX game capture: ${why}`);
  let n1 = 0; for (const p of P) n1 += p.mode;
  const extended = n1 > P.length - n1 ? 1 : 0;
  const peerOf = new Map(), nodeOf = new Map();
  for (const p of P) {
    const w = p.pkt;
    if (w[1] < 8 && w[1] === w[2] && !peerOf.has(p.src)) peerOf.set(p.src, w[1]);
    if (!nodeOf.has(p.src)) nodeOf.set(p.src, p.node);
  }
  const peers = [...new Set(peerOf.values())].sort((a, b) => a - b);
  const ipOf = new Map(); for (const [k, v] of peerOf) ipOf.set(v, k);
  const si = P.findIndex(p => p.pkt[6] === 0x15 && p.pkt[1] === p.pkt[2] && p.pkt[2] < 8);
  if (si < 0) throw notGame('no game start packet (the capture must include the end of the lobby and the game)');
  const start = P[si].pkt, settings = new Uint8Array(0x30);
  settings.set(start.subarray(0x10, 0x40)); settings[3] = start[3];
  const dv = new DataView(settings.buffer);
  let mn = settings.subarray(0x10, 0x30); { const z = mn.indexOf(0); if (z >= 0) mn = mn.subarray(0, z); }
  // lobby messages before the start packet: races, caps, names
  const race = [2, 2, 2, 2, 2, 2, 2, 2];
  const caps = new Map(peers.map(pe => [pe, 0x7d])), names = new Map(peers.map(pe => [pe, new Uint8Array(0)]));
  for (let i = 0; i < si; i++) {
    const p = P[i], w = p.pkt;
    if (w[6] === 0x14 && w[1] === w[2] && w[2] < 8 && w[8] < 8) race[w[8]] = w[9];        // g_PlayerRace[w[8]] = w[9]
    if (ADVERT.includes(w[6]) && w.length >= 0x24) {                                     // advert / join: caps, name
      const pe = peerOf.get(p.src);
      if (pe !== undefined) { caps.set(pe, w[0x18]); let nm = w.subarray(0x1e, 0x2a); const z = nm.indexOf(0); if (z >= 0) nm = nm.subarray(0, z); names.set(pe, nm); }
    }
    if (w[6] === 0xd && w.length >= 0x40) {                                              // host's PlayerSetup record
      const pr = w.subarray(8, 0x40);
      if (pr[0] === 1) { let nm = pr.subarray(0x18, 0x24); const z = nm.indexOf(0); if (z >= 0) nm = nm.subarray(0, z); names.set(pr[1], nm); caps.set(pr[1], pr[4]); }
    }
  }
  const mapCrc = dv.getUint32(0xc, true);
  return {
    P, si, port, extended, peerOf, nodeOf, peers, ipOf, host: start[1], start, settings, race, caps, names,
    seed: start[3], resId: dv.getUint16(6, true), mapCrc, customMap: mapCrc !== 0, mapName: latin1.decode(mn),
    peerNames: Object.fromEntries(peers.map(pe => [pe, latin1.decode(names.get(pe))])),
  };
}

export class Bytes {   // little-endian byte builder
  constructor() { this.a = []; }
  u8(...v) { for (const x of v) this.a.push(x & 0xff); return this; }
  u16(v) { return this.u8(v, v >> 8); }
  u32(v) { return this.u8(v, v >> 8, v >> 16, v >>> 24); }
  bytes(b) { for (const x of b) this.a.push(x); return this; }
  chunk(tag, data) { for (let i = 0; i < 4; i++) this.a.push(tag.charCodeAt(i)); this.u32(data.length); return this.bytes(data); }
  get len() { return this.a.length; }
  out() { return Uint8Array.from(this.a); }
}
export const cat = (...parts) => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); n = 0; for (const p of parts) { o.set(p, n); n += p.length; } return o; };

// The raw .w2r of a parsed capture, as one peer saw it (pcap2w2r.py without --w2test).
// rules: War2Combat plugin rule bits for the MTCH (W2_PATCH_PEON2K_022 0x100 / _023 0x200; a capture cannot tell).
// livecap.js builds the same file while the capture is recorded, from the pieces below (peerAddrs, streamAdd,
// gameStart, w2rHead, TurnWriter).
export function convertCapture(cap, { peer = null, pud = null, pudName = 'map.pud', pokes = null, verbose = null, rules = 0 } = {}) {
  const { P, si, peers, peerOf, host, extended } = cap;
  if (!peers.length) throw new CaptureError('no peers found in the capture');
  const addr = peerAddrs(cap);

  // ---- turn streams: each peer's sequenced turn packets in send order (first copy of each seq)
  const stream = new Map(peers.map(pe => [pe, []])), tstart = new Map(peers.map(pe => [pe, []]));
  for (let i = 0; i < P.length; i++) {
    const pe = peerOf.get(P[i].src);
    if (pe !== undefined && streamAdd(stream.get(pe), P[i].pkt, pe)) tstart.get(pe).push(i);
  }
  // game start: each peer's prologue pad = its first packet after the start packet that follows a pause > 0.5 s
  const first = new Map();
  for (const pe of peers) {
    let prev = null; const ts = tstart.get(pe);
    for (let j = 0; j < ts.length; j++) {
      const i = ts[j];
      if (i > si && prev !== null && P[i].ts - prev > 0.5) { first.set(pe, j); break; }
      prev = P[i].ts;
    }
    if (!first.has(pe)) throw new CaptureError(`peer ${pe}: no game start found after the lobby (capture ends in the lobby?)`);
  }
  const { S0, turnsOf } = gameStart(peers, stream, first);
  // ---- end of the game (see pcap2w2r.py)
  const local = peer === null || peer === undefined || peer === 'host' ? host : +peer;
  if (!turnsOf.has(local)) throw new CaptureError(`peer ${local} is not in the capture (peers: ${peers.join(', ')})`);
  const { leave, nturns, ql } = gameEnd(peers, local, turnsOf);
  if (nturns < 0) throw new CaptureError(`peer ${local}: the capture holds no turns of the game`);

  const head = w2rHead(cap, addr, local, S0, turnsOf.get(local).slice(0, OUTSTANDING), rules, pud, pudName);

  // ---- turns
  const tw = new TurnWriter(peers, local, turnsOf, leave, addr, S0, extended), body = [];
  for (let k = 0; k < nturns; k++) body.push(tw.turn(k));
  const pk = pokes ? pokeChunks(pokes) : new Uint8Array(0);   // test recordings: copy their POKE chunks
  const w2r = cat(head, pk, ...body, endChunk(nturns));
  const info = {
    mode: extended ? 'Enhanced' : 'Classic', extended, peers, local, host, nturns, S0, seed: cap.settings[3], mapName: cap.mapName, resId: cap.resId,
    custom: !!pud, leave: Object.fromEntries(leave), localQuit: ql !== null ? { peer: local, turn: nturns } : null,
    names: cap.peerNames,
  };
  if (verbose) verbose(info);
  return { w2r, info };
}
export const OUTSTANDING = 1;
// the POKE chunks of a .w2r
export function pokeChunks(w2r) {
  const pd = new DataView(w2r.buffer, w2r.byteOffset, w2r.byteLength), parts = [];
  for (let o = 8; o + 8 <= w2r.length;) {
    const ln = pd.getUint32(o + 4, true);
    if (w2r[o] === 0x50 && w2r[o + 1] === 0x4f && w2r[o + 2] === 0x4b && w2r[o + 3] === 0x45) parts.push(w2r.subarray(o, o + 8 + ln));
    o += 8 + ln;
  }
  return cat(...parts);
}
export const endChunk = nturns => new Bytes().chunk('END ', new Bytes().u32(nturns).a).out();
// Each peer's IPX address (net from the first advert, the node its packets came from, socket 0x87c2).
export function peerAddrs(cap) {
  let net = new Uint8Array([0xef, 0xbe, 0xad, 0xde]);
  for (const p of cap.P) { const w = p.pkt; if (ADVERT.includes(w[6]) && w.length >= 0x18) { net = w.subarray(8, 12); break; } }
  return new Map(cap.peers.map(pe => [pe, cat(net, cap.nodeOf.get(cap.ipOf.get(pe)), [0x87, 0xc2, 0, 0, 0, 0])]));
}
// Adds packet w of peer pe to its turn stream s unless it is not a turn packet or a resent copy; true if added.
export function streamAdd(s, w, pe) {
  if (w[1] !== pe || w[2] !== pe || TRANSPORT.includes(w[6])) return false;
  for (let q = Math.max(0, s.length - 32); q < s.length; q++) if (s[q][3] === w[3]) return false;   // a resent copy
  s.push(w); return true;
}
// The first turn's seq S0 and each peer's turns (its stream from the packet before its prologue pad, first[pe]).
export function gameStart(peers, stream, first) {
  const s0 = peers.map(pe => (stream.get(pe)[first.get(pe)][3] - OUTSTANDING) & 0xff);
  if (new Set(s0).size !== 1) throw new CaptureError(`peers disagree on the first turn seq: ${s0.join(', ')}`);
  const S0 = s0[0], turnsOf = new Map();
  for (const pe of peers) {
    const t = stream.get(pe).slice(first.get(pe) - OUTSTANDING);
    if (t[0][3] !== S0) throw new CaptureError(`peer ${pe}: first turn seq ${t[0][3]} != ${S0}`);
    turnsOf.set(pe, t);
  }
  return { S0, turnsOf };
}
export const quitAt = t => { for (let k = 0; k < t.length; k++) if (t[k][6] === 0x10) return k; return null; };
// Who left (quit at a turn / dropped: its stream ends before the longest) and the turns of the game.
export function gameEnd(peers, local, turnsOf) {
  const ql = quitAt(turnsOf.get(local));
  const endLocal = (ql !== null ? ql : turnsOf.get(local).length) - 1;
  const longest = Math.max(0, ...peers.filter(pe => pe !== local).map(pe => turnsOf.get(pe).length));
  const leave = new Map(); let nturns = endLocal;
  for (const pe of peers) {
    if (pe === local) continue;
    const q = quitAt(turnsOf.get(pe)), len = turnsOf.get(pe).length;
    if (q !== null) leave.set(pe, ['quit', q]);
    else if (len < longest) leave.set(pe, ['drop', len]);
    else nturns = Math.min(nturns, len);
  }
  return { leave, nturns, ql };
}
// "W2R1", version, MTCH (the W2Match the lobby left), PUD (custom map: size, crc and name; built-in: res id)
export function w2rHead(cap, addr, local, S0, pending, rules, pud, pudName) {
  const { peers, host, extended, si, P, start, settings, race, caps, names } = cap, slotOrder = start.subarray(8, 16);
  const chat = Array.from({ length: 8 }, (_, i) => { const c = new Uint8Array(0x38); c[1] = i; return c; });
  for (const pe of peers) {
    const c = chat[pe]; c[0] = 1; c[1] = pe; c[2] = 0; c[3] = 4;
    new DataView(c.buffer).setUint32(4, caps.get(pe), true); c.set(addr.get(pe), 8);
    c.set(names.get(pe).subarray(0, 12), 0x18);
  }
  let speed = extended + 5;                        // ChatRoom_Run: Game_SetSpeed(5 Classic / 6 Enhanced)
  if (extended) for (let i = 0; i < si; i++) { const w = P[i].pkt; if (w[6] === 0x13 && w[1] === w[2] && w[2] === host && w.length > 8 + 0x10) speed = w[8 + 0x10]; }
  const m = new Bytes().u8(extended, local, local, host, 1, 8, speed, peers.length).bytes(slotOrder).bytes(settings);
  for (const c of chat) m.bytes(c);
  m.bytes(race);
  for (let pe = 0; pe < 8; pe++) m.u8(peers.includes(pe) ? 2 : 0);
  for (let pe = 0; pe < 8; pe++) m.u8(peers.includes(pe) ? S0 : 0);
  for (let pe = 0; pe < 8; pe++) m.bytes(addr.get(pe) || new Uint8Array(16));
  m.u8((S0 + OUTSTANDING) & 0xff, OUTSTANDING, 2, 0).u32(1 | (rules & 0xf00));   // w2_patches: WarLatency + plugin rules (W2_PATCH_PEON2K)
  m.u8(pending.length);
  for (const p of pending) { const b = new Uint8Array(8); b.set(p.subarray(0, 8)); m.bytes(b); }
  m.bytes(new Uint8Array(8 * (4 - pending.length)));
  const mt = new Bytes().u32(1).bytes(m.a).out();
  // ---- map: custom PUD (given) or built-in (res id in the slot bits)
  const { resId, mapName } = cap, enc = new TextEncoder();
  const pudc = pud
    ? new Bytes().u32(pud.length).u32(crc32(pud)).bytes(enc.encode(pudName.replace(/^.*[\\/]/, ''))).u8(0).out()
    : new Bytes().u32(0).u32(0).bytes(enc.encode(`builtin:0x${resId.toString(16)} ${mapName}`)).u8(0).out();
  return new Bytes().bytes([0x57, 0x32, 0x52, 0x31]).u32(1).chunk('MTCH', mt).chunk('PUD ', pudc).out();
}
// The TURN chunks, in order (turn(k) for k = 0, 1, ...): RX = remote peers' packet of the turn; TX = ours, by
// simulating our send pipeline. turnsOf / leave may still grow between calls (livecap.js), as long as what turn(k)
// looks at is final: each remote peer's packet k (or that it left), and our next few packets.
export class TurnWriter {
  constructor(peers, local, turnsOf, leave, addr, S0, extended) {
    Object.assign(this, { peers, local, turnsOf, leave, addr, S0, extended, sent: 0, outst: OUTSTANDING });
  }
  get mine() { return this.turnsOf.get(this.local); }   // our turns; [OUTSTANDING + sent] is the next to send
  turn(k) {
    const { peers, local, turnsOf, leave, addr, S0, extended } = this, mine = this.mine, o = OUTSTANDING;
    const evs = new Bytes(); let nev = 0;
    const ev = (kind, pe, w) => { evs.u8(kind, pe).u16(w.length).bytes(w); nev++; };
    const has = () => o + this.sent < mine.length, next = () => mine[o + this.sent];
    if (k === 0) while (this.outst < 2 && has()) { ev(2, local, next()); this.sent++; this.outst++; }
    for (const pe of peers) {
      if (pe === local) continue;
      const [how, at] = leave.get(pe) || ['', 2 ** 30], t = turnsOf.get(pe);
      if (k < t.length && (how !== 'quit' || k <= at)) ev(1, pe, t[k]);
      else if (how === 'drop' && k === at) {      // Net_LgResendHellos' hello for the dead peer
        const h = new Uint8Array(0x18); h[0] = 0x18; h[1] = h[2] = pe; h[3] = (S0 + k) & 0xff; h[6] = 4; h.set(addr.get(pe), 8);
        const c = crc16(h) ^ (extended ? 0xaa55 : 0); h[4] = c & 0xff; h[5] = c >> 8;
        ev(1, pe, h);
      }
    }
    while (has() && next()[6] !== 1 && next()[6] !== 0x10 && this.outst < 2) { ev(2, local, next()); this.sent++; this.outst++; }
    while (this.outst < 2 && has() && next()[6] === 1) { ev(2, local, next()); this.sent++; this.outst++; }
    this.outst--;
    return new Bytes().chunk('TURN', new Bytes().u32(k).u32(0).u32(0).u32(0).u32(0).u32(nev).bytes(evs.a).a).out();
  }
}
// The recording peer's own quit (info.localQuit) is not a turn of the replay (it bounds them), so the sim never
// sees it: a 'QUIT' chunk after 'END ' (u8 peer, 3 x 0, u32 turns run before it = END's count) keeps it for the end screen.
// Appended after fixtx (which writes the chunks up to END only); the sim's readers stop at END.
export function withLocalQuit(w2r, q) {
  if (!q) return w2r;
  return cat(w2r, new Bytes().chunk('QUIT', new Bytes().u8(q.peer, 0, 0, 0).u32(q.turn).a).out());
}
