// Live capture -> .w2r (node and browser): the same file pcap.js convertCapture + the -fixtx pass make from a whole
// capture, built while the capture is still being recorded (tools/live/w2live.mjs runs it on a game PC, fed by
// dumpcap). A turn is written as soon as what decides it is known: every remote peer's packet of that turn (or that
// it left) and our next few packets; the -fixtx pass then holds W2_FIXTX_NB turns back (a command can move that far).
//
//   PcapStream       pcapng / pcap bytes in, as they arrive -> frames {ts, lt, f, iface (pcapng)}
//   LiveConverter    War2 datagrams in -> the raw .w2r's header and TURN chunks (convertCapture's), CamRec packets
//   LiveRecorder     LiveConverter + LiveFixtx (sim.js): the live stream and, at the end, the finished .w2r
//
// Live stream: the .w2r's chunks in the order they become known: "W2R1" + version, MTCH, PUD, then TURN chunks
// (fixed, hash-stamped) with 'CAMP' chunks between them (CamRec packets as .w2c records {u16 len, packet}, no file
// header), then END and QUIT. Its readers skip chunks they do not know; camrec.js reads CAMP as it reads CAMR.
// The finished file is the one the viewer's conversion makes: TURNs, END, QUIT, one CAMR chunk.
import { frameUdp, war2Packet, packetsInfo, peerAddrs, streamAdd, gameStart, gameEnd, w2rHead, TurnWriter, pokeChunks, OUTSTANDING, CaptureError, Bytes, cat } from './pcap.js';
import { CAM_PORT, isCamPacket, w2cImage } from './camrec.js';

export const GAME_PORT = 34754;

// ---------------------------------------------------------------- pcapng / pcap, incrementally
export class PcapStream {
  constructor() { this.buf = new Uint8Array(0); this.off = 0; this.fmt = null; this.le = true; this.linktypes = []; this.tsres = []; }
  // the frames the bytes so far complete (each f a copy)
  push(bytes) {
    if (this.off && this.off === this.buf.length) { this.buf = new Uint8Array(0); this.off = 0; }
    this.buf = this.off ? cat(this.buf.subarray(this.off), bytes) : cat(this.buf, bytes); this.off = 0;
    const d = this.buf, dv = new DataView(d.buffer, d.byteOffset, d.byteLength), out = [];
    const u32 = (o, le = this.le) => dv.getUint32(o, le), u16 = (o, le = this.le) => dv.getUint16(o, le);
    if (!this.fmt) {
      if (d.length < 4) return out;
      if (d[0] === 0x0a && d[1] === 0x0d && d[2] === 0x0d && d[3] === 0x0a) this.fmt = 'ng';
      else {
        if (d.length < 24) return out;
        const magic = u32(0, false);
        if (![0xd4c3b2a1, 0x4d3cb2a1, 0xa1b2c3d4, 0xa1b23c4d].includes(magic)) throw new CaptureError('not a pcap or pcapng capture');
        this.fmt = 'pcap'; this.le = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1; this.nano = magic === 0x4d3cb2a1 || magic === 0xa1b23c4d;
        this.lt = u32(20); this.off = 24;
      }
    }
    let off = this.off;
    if (this.fmt === 'pcap') {
      while (off + 16 <= d.length) {
        const s = u32(off), us = u32(off + 4), cl = u32(off + 8);
        if (off + 16 + cl > d.length) break;
        out.push({ ts: s + us * (this.nano ? 1e-9 : 1e-6), lt: this.lt, f: d.slice(off + 16, off + 16 + cl) });
        off += 16 + cl;
      }
    } else {
      while (off + 12 <= d.length) {
        let btype = u32(off), blen = u32(off + 4);
        if (d[off] === 0x0a && d[off + 1] === 0x0d && d[off + 2] === 0x0d && d[off + 3] === 0x0a) {
          this.le = u32(off + 8, true) === 0x1a2b3c4d; btype = 0x0a0d0d0a; blen = u32(off + 4);
        }
        if (blen < 12) throw new CaptureError('corrupt pcapng block');
        if (off + blen > d.length) break;
        if (btype === 0x0a0d0d0a) { this.linktypes = []; this.tsres = []; }
        else if (btype === 1) {
          this.linktypes.push(u16(off + 8)); let res = 1e-6;
          for (let o = off + 16; o + 4 <= off + blen - 4;) {
            const code = u16(o), ln = u16(o + 2);
            if (code === 0) break;
            if (code === 9) { const v = d[o + 4]; res = v & 0x80 ? 2 ** -(v & 0x7f) : Number('1e-' + v); }
            o += 4 + ((ln + 3) & ~3);
          }
          this.tsres.push(res);
        } else if (btype === 6) {
          const iface = u32(off + 8), th = u32(off + 12), tl = u32(off + 16), caplen = u32(off + 20);
          if (iface < this.linktypes.length) out.push({ ts: (th * 4294967296 + tl) * this.tsres[iface], lt: this.linktypes[iface], f: d.slice(off + 28, off + 28 + caplen), iface });
        } else if (btype === 3) {
          if (this.linktypes.length) out.push({ ts: 0.0, lt: this.linktypes[0], f: d.slice(off + 12, off + 12 + blen - 16) });
        }
        off += blen;
      }
    }
    this.off = off;
    return out;
  }
  // a frame's UDP datagram (frameUdp), or null
  udp(fr) { return frameUdp(fr.ts, fr.lt, fr.f); }
  // the UDP datagrams of the frames the bytes complete
  datagrams(bytes) {
    const out = [];
    for (const fr of this.push(bytes)) { const u = this.udp(fr); if (u) out.push(u); }
    return out;
  }
}

// ---------------------------------------------------------------- the raw .w2r, turn by turn
// opts: { peer: 'host' | n (whose view; the default, as the viewer's conversion), rules (MTCH plugin rule bits),
//         pud(cap) -> { bytes, name } | null (a custom map's file; null: missing), dropLead (turns the other peers
//         get ahead of a silent peer before it counts as dropped), lookahead (our packets known past the next) }
// Callbacks: onHead(bytes, cap, info), onTurn(k, bytes), onCam(packet).
// push(datagram) every UDP datagram of the capture in order; finish() at its end (or the game's): writes the turns
// left with the whole-capture rules (gameEnd) and returns { nturns, localQuit, leave, mismatch } (mismatch: a peer
// that left differently from what the live turns assumed: those turns differ from the whole capture's).
export class LiveConverter {
  constructor(opts = {}) {
    this.o = { peer: 'host', rules: 0, pud: () => null, dropLead: 10, lookahead: 3, ...opts };
    this.P = []; this.state = 'lobby'; this.k = 0; this.cams = 0;
  }
  push(d) {
    if (d.dp === CAM_PORT) { if (isCamPacket(d.pl)) { this.cams++; this.o.onCam?.(d.pl.slice()); } return; }
    if (d.sp !== GAME_PORT && d.dp !== GAME_PORT) return;
    const p = war2Packet(d); if (!p) return;
    p.pkt = p.pkt.slice(); p.node = p.node.slice();
    const i = this.P.push(p) - 1;
    if (this.state === 'lobby') {
      const w = p.pkt;
      if (w[6] === 0x15 && w[1] === w[2] && w[2] < 8) this.started();
      return;
    }
    this.add(i);
    if (this.state === 'game') this.pump();
  }
  // the start packet: the lobby's settings from the packets so far; turn streams from the start of the capture
  started() {
    const cap = this.cap = packetsInfo(this.P);
    this.local = this.o.peer === null || this.o.peer === undefined || this.o.peer === 'host' ? cap.host : +this.o.peer;
    if (!cap.peers.includes(this.local)) throw new CaptureError(`peer ${this.local} is not in the capture (peers: ${cap.peers.join(', ')})`);
    this.stream = new Map(cap.peers.map(pe => [pe, []])); this.tsOf = new Map(cap.peers.map(pe => [pe, []]));
    this.first = new Map(); this.prev = new Map();
    this.state = 'start';
    for (let i = 0; i < this.P.length; i++) this.add(i);
    if (this.state === 'game') this.pump();
  }
  add(i) {
    const p = this.P[i], pe = this.cap.peerOf.get(p.src);
    if (pe === undefined || !streamAdd(this.stream.get(pe), p.pkt, pe)) return;
    if (this.state === 'game') { this.grew(pe, p.pkt); return; }
    // the prologue pad: the first packet after the start packet that follows a pause > 0.5 s
    const j = this.stream.get(pe).length - 1, prev = this.prev.get(pe);
    if (!this.first.has(pe)) {
      if (i > this.cap.si && prev !== undefined && p.ts - prev > 0.5) this.first.set(pe, j);
      else this.prev.set(pe, p.ts);
    }
    if (this.first.size === this.cap.peers.length) this.begin();
  }
  begin() {
    const cap = this.cap, { S0, turnsOf } = gameStart(cap.peers, this.stream, this.first);
    this.S0 = S0; this.turnsOf = turnsOf; this.leave = new Map(); this.quit = new Map();
    for (const [pe, t] of turnsOf) t.forEach((w, k) => { if (w[6] === 0x10 && !this.quit.has(pe)) this.quit.set(pe, k); });
    const pud = this.o.pud(cap) || null;   // a custom map's file (the caller decides, as the viewer: when cap.customMap)
    if (cap.customMap && !pud) throw new CaptureError(`the custom map ${cap.mapName} is missing`);
    this.pudFile = pud;
    this.addr = peerAddrs(cap);
    let head = w2rHead(cap, this.addr, this.local, S0, turnsOf.get(this.local).slice(0, OUTSTANDING), this.o.rules, pud && pud.bytes, pud ? pud.name : 'map.pud');
    if (this.o.pokes) head = cat(head, pokeChunks(this.o.pokes));   // test recordings (as convertCapture's pokes)
    this.tw = new TurnWriter(cap.peers, this.local, turnsOf, this.leave, this.addr, S0, cap.extended);
    this.state = 'game';
    this.o.onHead?.(head, cap, { local: this.local, S0, pud });
  }
  grew(pe, w) {
    const t = this.turnsOf.get(pe); t.push(w);
    if (w[6] === 0x10 && !this.quit.has(pe)) this.quit.set(pe, t.length - 1);
  }
  // live leave decisions (finish() checks them against gameEnd's)
  decide() {
    const { local } = this, peers = this.cap.peers;
    let longest = 0; for (const pe of peers) if (pe !== local) longest = Math.max(longest, this.turnsOf.get(pe).length);
    for (const pe of peers) {
      if (pe === local || this.leave.has(pe)) continue;
      if (this.quit.has(pe)) this.leave.set(pe, ['quit', this.quit.get(pe)]);
      else if (longest > this.turnsOf.get(pe).length + this.o.dropLead) this.leave.set(pe, ['drop', this.turnsOf.get(pe).length]);
    }
  }
  ready(k) {
    const { local } = this, mine = this.turnsOf.get(local), ql = this.quit.get(local);
    if (ql !== undefined) { if (k >= ql - 1) return false; }
    else if (k >= mine.length - 1 || mine.length <= OUTSTANDING + this.tw.sent + this.o.lookahead) return false;
    for (const pe of this.cap.peers) if (pe !== local && !this.leave.has(pe) && this.turnsOf.get(pe).length <= k) return false;
    return true;
  }
  pump() {
    this.decide();
    while (this.ready(this.k)) { const k = this.k++; this.o.onTurn?.(k, this.tw.turn(k)); }
  }
  get started_() { return this.state === 'game'; }
  finish() {
    if (this.state !== 'game') return null;
    const { leave, nturns, ql } = gameEnd(this.cap.peers, this.local, this.turnsOf);
    let mismatch = null;
    for (const [pe, v] of this.leave) { const f = leave.get(pe); if (!f || f[0] !== v[0] || f[1] !== v[1]) { mismatch = { peer: pe, live: v, final: f || null }; break; } }
    if (!mismatch && this.k > Math.max(0, nturns)) mismatch = { turns: this.k, final: nturns };
    this.leave.clear(); for (const [pe, v] of leave) this.leave.set(pe, v);
    while (this.k < nturns) { const k = this.k++; this.o.onTurn?.(k, this.tw.turn(k)); }
    this.state = 'done';
    return { nturns: Math.max(0, nturns), localQuit: ql !== null ? { peer: this.local, turn: nturns } : null, leave: Object.fromEntries(leave), mismatch };
  }
  // the time of the last War2 packet
  get lastTs() { return this.P.length ? this.P[this.P.length - 1].ts : 0; }
}

// ---------------------------------------------------------------- converter + fixtx -> the live stream
// opts: LiveConverter's, plus fixtx(head, pud) -> Promise<LiveFixtx> (sim.js LiveFixtx.create bound to the game
// files), write(bytes) (the live stream, in order), camEvery (turns between CAMP chunks).
// done(): finishes the game and returns { w2r (the finished file), info } or null when no game started.
export class LiveRecorder {
  constructor(opts) {
    this.o = { camEvery: 20, write: () => {}, ...opts };
    this.fixed = []; this.camAll = []; this.camNew = []; this.camSeen = new Set(); this.queue = []; this.busy = null;
    this.status = 'lobby'; this.fedTurns = 0; this.gameOver = false; this.sinceCam = 0;
    this.conv = new LiveConverter({ ...this.o, onHead: (h, cap, info) => this.queue.push(['head', h, cap, info]),
      onTurn: (k, t) => this.queue.push(['turn', t]), onCam: p => this.cam(p) });
  }
  push(d) { this.conv.push(d); }
  cam(p) {
    let h = 0; for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p[i], 16777619);
    const key = `${p.length}:${h >>> 0}:${Array.from(p.subarray(8, 16)).join(',')}`;   // session, seq; a capture can hold a broadcast twice
    if (this.camSeen.has(key)) return;
    this.camSeen.add(key); this.camAll.push(p); this.camNew.push(p);
    if (this.status === 'lobby') return;
  }
  out(b) { if (b.length) this.o.write(b); }
  flushCam() {
    if (!this.camNew.length) return;
    const img = w2cImage(this.camNew).subarray(8); this.camNew = []; this.sinceCam = 0;
    this.out(new Bytes().chunk('CAMP', img).out());
  }
  // runs what the converter queued (fixtx is async to create); call after pushes, awaits nothing when idle
  async drain() {
    while (this.queue.length) {
      const [kind, a, cap, info] = this.queue.shift();
      if (kind === 'head') {
        this.cap = cap; this.info = info;
        this.fx = await this.o.fixtx(a, info.pud && info.pud.bytes);
        const h = this.fx.take(); this.fixed.push(h); this.out(h); this.status = 'game';
        this.flushCam();
      } else if (!this.gameOver) {
        const st = this.fx.turn(a); this.fedTurns++;
        const b = this.fx.take(); if (b.length) { this.fixed.push(b); this.out(b); }
        if (st !== 0) this.gameOver = true;
        if (++this.sinceCam >= this.o.camEvery) this.flushCam();
      }
    }
  }
  async done() {
    const end = this.conv.finish();
    await this.drain();
    if (!end || !this.fx) return null;
    this.fx.end(this.fedTurns);
    const tail = this.fx.take(); this.fixed.push(tail);
    const q = end.localQuit ? new Bytes().chunk('QUIT', new Bytes().u8(end.localQuit.peer, 0, 0, 0).u32(end.localQuit.turn).a).out() : new Uint8Array(0);
    this.flushCam(); this.out(tail); this.out(q);
    const img = this.camAll.length ? w2cImage(this.camAll) : null;
    const camr = img ? cat(new Uint8Array([0x43, 0x41, 0x4d, 0x52]), new Uint8Array(new Uint32Array([img.length]).buffer), img) : new Uint8Array(0);
    this.status = 'done';
    return { w2r: cat(...this.fixed, q, camr), info: { ...end, turns: this.fedTurns, gameOver: this.gameOver, stats: this.fx.stats(), cap: this.cap, local: this.info.local } };
  }
}
