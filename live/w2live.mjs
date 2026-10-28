// w2live: records the games played on this PC as they happen. Runs next to Warcraft II (War2Combat) on one of the
// players' PCs; never touches the game: it reads the LAN traffic through Wireshark's dumpcap (as a capture for the
// viewer is made), converts it to a .w2r while the game runs (web/viewer/livecap.js) and
//   - writes the live stream to <out>/<id>.live.w2r.gz (gzip flushed every second: any prefix reads),
//   - pushes it to a relay (web/live/relay.mjs or the Cloudflare Worker, web/live/worker.js) for viewers,
//   - writes the finished replay <out>/<id>.w2r.gz (what the viewer's conversion of the capture gives) and the
//     capture itself, <out>/<id>.pcapng (to convert again in the viewer if anything went wrong).
// The rules come from the game folder: the CRC-32 of plugin/*.w2p (viewer/plugins.js), not from trial replays.
// It runs at below-normal priority and never waits on the network: a slow relay only delays the viewers.
//
//   node w2live.mjs [--config w2live.json] [--game DIR] [--iface N ...] [--out DIR] [--relay URL --token T]
//   node w2live.mjs --pcap FILE [--speed X]     a recorded capture fed at X times its speed from the game's start
//                                              (the lobby at once; 0: all at once; tests and demos)
//   node w2live.mjs --list-ifaces
// w2live.json (next to this script, all optional): { "game": "C:\\War2Combat", "dumpcap": "...\\dumpcap.exe",
//   "iface": ["1"] (dumpcap -D numbers; none: all, keeping the first that carries the game), "out": "recordings", "peer": "host", "rules": null, "relay": { "url": "https://...", "token": "..." },
//   "delay": 0, "title": "LAN night", "keepPcap": true, "maps": ["D:\\more maps"] }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MpqArchive, MpqSet } from './lib/mpq.js';
import { bootFileNames } from './lib/files.js';
import { compileSim, LiveFixtx } from './lib/sim.js';
import { crc32 } from './lib/pcap.js';
import { PcapStream, LiveRecorder, GAME_PORT } from './lib/livecap.js';
import { CAM_PORT } from './lib/camrec.js';
import { PLUGIN_BUILDS, RULES } from './lib/plugins.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const opts = k => argv.flatMap((a, i) => a === k ? [argv[i + 1]] : []);
const cfgPath = opt('--config') || path.join(here, 'w2live.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const C = {
  game: opt('--game') || cfg.game || findGame(), dumpcap: opt('--dumpcap') || cfg.dumpcap || findDumpcap(),
  iface: opts('--iface').length ? opts('--iface') : [].concat(cfg.iface || []), out: path.resolve(here, opt('--out') || cfg.out || 'recordings'),
  peer: opt('--peer') || cfg.peer || 'host', rules: opt('--rules') !== undefined ? +opt('--rules') : cfg.rules ?? null,
  relay: opt('--relay') ? { url: opt('--relay'), token: opt('--token') || '' } : cfg.relay || null,
  maps: [...opts('--maps'), ...[].concat(cfg.maps || [])],
  delay: +(opt('--delay') ?? cfg.delay ?? 0), title: opt('--title') || cfg.title || '', keepPcap: cfg.keepPcap !== false,
  wasm: opt('--wasm') || cfg.wasm || [path.join(here, 'sim.wasm'), path.join(here, '../../build/sim.wasm')].find(f => fs.existsSync(f)),
};
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

function findGame() {
  for (const d of [process.cwd(), here, path.dirname(here), 'C:\\War2Combat', 'C:\\Games\\War2Combat', path.join(os.homedir(), 'rea-work/War2Combat')])
    if (fs.existsSync(path.join(d, 'Warcraft II BNE.exe'))) return d;
  return null;
}
function findDumpcap() {
  for (const f of ['C:\\Program Files\\Wireshark\\dumpcap.exe', 'C:\\Program Files (x86)\\Wireshark\\dumpcap.exe', '/Applications/Wireshark.app/Contents/MacOS/dumpcap', '/usr/bin/dumpcap', '/usr/local/bin/dumpcap', '/opt/homebrew/bin/dumpcap'])
    if (fs.existsSync(f)) return f;
  return 'dumpcap';
}
if (argv.includes('--list-ifaces')) { process.stdout.write(execFileSync(C.dumpcap, ['-D'], { encoding: 'utf8' })); process.exit(0); }
if (!C.game) { console.error('Warcraft II not found: set "game" in w2live.json or pass --game DIR'); process.exit(1); }
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: run as is */ }

// ---- game files, plugins
const gameFile = n => { const f = fs.readdirSync(C.game).find(x => x.toLowerCase() === n.toLowerCase()); return f ? path.join(C.game, f) : null; };
const exe = fs.readFileSync(gameFile('Warcraft II BNE.exe'));
const mpqs = ['War2Patch.mpq', 'War2Dat.mpq'].map(gameFile).filter(Boolean).map(f => new MpqArchive(fs.readFileSync(f)));
const mpq = new MpqSet(mpqs), files = bootFileNames(mpq).filter(n => mpq.has(n)).map(n => [n, mpq.read(n)]);
const module = await compileSim(fs.readFileSync(C.wasm));
let rules = C.rules;
{
  const dir = ['plugin', 'Plugin', 'PLUGIN'].map(d => path.join(C.game, d)).find(d => fs.existsSync(d));
  const found = [];
  for (const f of dir ? fs.readdirSync(dir).filter(f => /\.w2p$/i.test(f)) : []) {
    const b = fs.readFileSync(path.join(dir, f)), c = crc32(b), bits = PLUGIN_BUILDS[c];
    if (bits !== undefined) found.push([f, bits]);
    else if (/peon2k/i.test(f)) log(`plugin/${f}: not a released Peon2k build (CRC-32 ${c.toString(16)}): its rules are unknown`);
  }
  if (rules === null) {
    if (found.length > 1) log(`several Peon2k builds in plugin/: ${found.map(([f]) => f).join(', ')}; using ${found[0][0]}`);
    rules = found.length ? found[0][1] : 0;
  }
  log(`game: ${C.game}; rules: ${RULES[rules] || `bits ${rules}`}${found.length ? ` (plugin/${found[0][0]})` : ''}`);
}
// custom maps: by name under the game folder (Maps\, subfolders) and the "maps" folders, else by CRC-32
const pudIndex = () => {
  const out = [], walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory() && depth < 4) walk(f, depth + 1); else if (/\.pud$/i.test(e.name)) out.push(f); } };
  for (const d of [C.game, ...C.maps]) try { walk(d, 0); } catch { /* unreadable folder */ }
  return out;
};
function findPud(cap) {
  if (!cap.customMap) return null;
  const all = pudIndex(), want = cap.mapName.toLowerCase().replace(/\.pud$/, '') + '.pud';
  let f = all.find(x => path.basename(x).toLowerCase() === want);
  if (!f) f = all.find(x => crc32(fs.readFileSync(x)) === cap.mapCrc);
  if (!f) { log(`custom map ${cap.mapName}: no ${want} in ${C.game}`); return null; }
  return { bytes: new Uint8Array(fs.readFileSync(f)), name: path.basename(f) };
}

// ---- relay: one copy of the stream goes up (a request every UPLOAD_MS at most); viewers read it there
const UPLOAD_MS = 1500;
class Uploader {
  constructor(id, meta) { this.id = id; this.meta = meta; this.buf = []; this.len = 0; this.sent = 0; this.busy = false; this.done = false; this.wait = 1000; this.final = null; this.closed = false; }
  write(b) { this.buf.push(b); this.len += b.length; this.kick(); }
  url(p) { return `${C.relay.url.replace(/\/$/, '')}/api/live/${encodeURIComponent(this.id)}${p}`; }
  async req(p, body, type) {
    const r = await fetch(this.url(p), { method: 'POST', headers: { authorization: `Bearer ${C.relay.token || ''}`, 'content-type': type }, body });
    if (!r.ok && r.status !== 409) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim());
    return r;
  }
  kick() { if (!this.busy && !this.closed) { this.busy = true; this.run().finally(() => { this.busy = false; }); } }
  async run() {
    for (;;) {
      try {
        if (!this.metaSent) { await this.req('/meta', JSON.stringify(this.meta), 'application/json'); this.metaSent = true; }
        if (this.sent < this.len) {
          const due = (this.last || 0) + UPLOAD_MS - Date.now(); if (due > 0 && !this.done) await new Promise(r => setTimeout(r, due));   // one request per UPLOAD_MS
          this.last = Date.now();
          const all = Buffer.concat(this.buf); this.buf = [all];
          const piece = all.subarray(this.sent, Math.min(this.len, this.sent + (4 << 20)));
          const r = await this.req(`/append?offset=${this.sent}`, zlib.gzipSync(piece), 'application/x-w2r-gzip');
          const j = await r.json(); this.sent = j.size;
          this.wait = 1000; continue;
        }
        if (this.done && !this.doneSent) {
          if (this.final) await this.req('/final', this.final, 'application/gzip');
          await this.req('/done', JSON.stringify({ size: this.len }), 'application/json'); this.doneSent = true; log(`relay: ${this.id} complete`);
        }
        return;
      } catch (e) {
        log(`relay: ${e.message}; again in ${this.wait / 1000} s`);
        await new Promise(r => setTimeout(r, this.wait)); this.wait = Math.min(30000, this.wait * 2);
      }
    }
  }
  finish(final) { this.done = true; this.final = final; this.kick(); }
}

// ---- one game: recorder + live file + uploader
fs.mkdirSync(C.out, { recursive: true });
const stamp = ts => { const d = new Date(ts * 1000), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
class Game {
  constructor() {
    this.rec = new LiveRecorder({ peer: C.peer, rules, pud: findPud, fixtx: (head, pud) => LiveFixtx.create({ module, exe, files, head, pud }), write: b => this.write(b) });
    this.pending = []; this.lastTurnAt = 0; this.over = null;
  }
  write(b) {
    if (!this.id) {   // the header: the game has started
      const cap = this.rec.conv.cap;
      this.id = `${stamp(this.rec.conv.lastTs || Date.now() / 1000)}-${cap.mapName.replace(/\.pud$/i, '').replace(/[^\w.-]+/g, '_') || 'game'}-${Math.random().toString(36).slice(2, 6)}`;
      this.players = cap.peers.map(pe => cap.peerNames[pe] || `peer ${pe}`);
      log(`game started: ${this.id} (${cap.mapName}, ${this.players.join(', ')})`);
      this.gz = zlib.createGzip(); this.gz.pipe(fs.createWriteStream(path.join(C.out, `${this.id}.live.w2r.gz`)));
      this.flusher = setInterval(() => this.gz.flush(zlib.constants.Z_SYNC_FLUSH), 1000);
      if (C.relay && C.relay.url) this.up = new Uploader(this.id, { title: C.title, map: cap.mapName, players: this.players, delay: C.delay, rules, started: Date.now(), host: os.hostname() });
    }
    this.gz.write(b); if (this.up) this.up.write(b);
  }
  async end(why) {
    let res = null;
    try { res = await this.rec.done(); } catch (e) { log(`game ${this.id || '(not started)'}: conversion failed: ${e.message}`); }
    if (this.flusher) clearInterval(this.flusher);
    if (this.gz) await new Promise(r => this.gz.end(r));
    if (!res) { if (this.up) this.up.finish(null); return; }
    const gz = zlib.gzipSync(res.w2r, { level: 9 }), f = path.join(C.out, `${this.id}.w2r.gz`);
    fs.writeFileSync(f, gz);
    const st = res.info.stats, m = res.info.mismatch;
    log(`game over (${why}): ${f}, ${res.info.turns} turns, ${(gz.length / 1e6).toFixed(1)} MB${res.info.gameOver ? '' : ' (no victory / defeat: a player left or the capture ended)'}${m ? `; WARNING: live leave decisions differed (${JSON.stringify(m)}): convert the .pcapng in the viewer` : ''}`);
    if (st.txBad) log(`WARNING: ${st.txBad} turns' sync bytes differ: wrong rules? convert the .pcapng in the viewer (rules auto)`);
    if (this.up) this.up.finish(gz);
  }
}

// ---- input: dumpcap (or a capture file), one game after the other
let game = new Game(), tail = null, pcapOut = null, chain = Promise.resolve(), lockIface = null;
const ps = new PcapStream();
function feed(bytes) {
  if (pcapOut) pcapOut.write(bytes);
  let frames;
  try { frames = ps.push(bytes); } catch (e) { log(`capture: ${e.message}`); return; }
  chain = chain.then(() => handle(frames)).catch(e => { log(`error: ${e.stack || e}`); game = new Game(); });
}
async function handle(frames) {
  for (const fr of frames) {
    const d = ps.udp(fr); if (!d) continue;
    const ours = d.sp === GAME_PORT || d.dp === GAME_PORT || d.dp === CAM_PORT;
    if (!ours) continue;
    if (fr.iface !== undefined) { if (lockIface === null) lockIface = fr.iface; else if (fr.iface !== lockIface) continue; }   // one interface
    if (tail) tail.push(d);
    game.rec.push(d);
    const c = game.rec.conv;
    if (c.state === 'game' && d.dp === GAME_PORT) game.lastTurnAt = d.ts;
    if (!game.over && (game.rec.gameOver || (c.quit && c.quit.has(c.local)))) { game.over = d.ts; game.overAt = Date.now(); tail = []; }   // what follows may be the next game's lobby
    // a new game's start packet after this one ended / was left, or 20 s without game traffic after it ended
    const w = d.dp === GAME_PORT && d.pl.length > 16 ? d.pl.subarray(10) : null;
    const startPkt = w && w[6] === 0x15 && w[1] === w[2] && w[2] < 8;
    if (game.over && (startPkt || d.ts - game.over > 20)) await next(game.over && startPkt ? 'next game' : 'ended');
  }
  await game.rec.drain();
}
async function next(why) {
  const old = game, replay = tail || [];
  game = new Game(); tail = null;
  await old.end(why);
  for (const d of replay) game.rec.push(d);   // the next game's lobby, from where the last one ended
  await game.rec.drain();
}
async function stop(why) { await chain; await game.end(why); if (pcapOut) pcapOut.end(); }

if (opt('--pcap')) {
  const b = fs.readFileSync(opt('--pcap')), speed = +(opt('--speed') ?? 1);
  log(`replaying ${opt('--pcap')} at ${speed || 'full'} speed`);
  // pieces of the capture as dumpcap would write them, in time: frame by frame through a second parser
  const timing = new PcapStream(); let t0 = null, w0 = Date.now(), at = 0;
  for (let o = 0; o < b.length; o += 2048) {
    const piece = b.subarray(o, o + 2048), fr = timing.push(piece);
    if (speed && game.rec.conv.state === 'lobby') await chain;   // (handled yet?)
    if (speed && fr.length && game.rec.conv.state !== 'lobby') {   // the lobby at full speed, the game in time
      const ts = fr[fr.length - 1].ts; if (t0 === null) { t0 = ts; w0 = Date.now(); }
      const due = w0 + (ts - t0) * 1000 / speed - Date.now();
      if (due > 5) await new Promise(r => setTimeout(r, due));
    }
    feed(piece); at += piece.length;
    if (!speed && o % (1 << 20) === 0) await chain;
  }
  await stop('end of capture');
} else {
  // no interfaces set: every real one dumpcap lists (the first that carries the game is kept, see handle())
  let ifaces = C.iface.map(String);
  if (!ifaces.length) {
    try {
      const skip = /loopback|bluetooth|wan miniport|etwdump|usbpcap|ciscodump|randpkt|sshdump|udpdump|wifidump|androiddump|dbus|nflog|nfqueue|bluetooth-monitor/i;
      ifaces = execFileSync(C.dumpcap, ['-D'], { encoding: 'utf8' }).split(/\r?\n/).map(l => /^(\d+)\.\s+(.*)$/.exec(l)).filter(m => m && !skip.test(m[2])).map(m => m[1]);
    } catch (e) { log(`dumpcap -D: ${e.message}`); }
    if (!ifaces.length) ifaces = ['1'];
  }
  const id = `${stamp(Date.now() / 1000)}-capture`;
  if (C.keepPcap) pcapOut = fs.createWriteStream(path.join(C.out, `${id}.pcapng`));
  const args = [...ifaces.flatMap(i => ['-i', String(i)]), '-p', '-f', `udp port ${GAME_PORT} or udp port ${CAM_PORT}`, '-w', '-', '-q'];   // -p: every peer sends to this PC, no promiscuous mode needed
  log(`capturing: ${C.dumpcap} ${args.join(' ')}${pcapOut ? ` (also ${id}.pcapng)` : ''}`);
  const dc = spawn(C.dumpcap, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(dc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* as is */ }
  dc.stdout.on('data', feed);
  setInterval(() => { chain = chain.then(() => game.over && Date.now() - game.overAt > 25000 ? next('ended') : null).catch(e => log(`error: ${e.stack || e}`)); }, 5000);   // quiet after the game
  dc.stderr.on('data', b => { const s = String(b).trim(); if (s) log(`dumpcap: ${s}`); });
  dc.on('exit', code => { log(`dumpcap exited (${code})`); stop('capture stopped').then(() => process.exit(code ? 1 : 0)); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('stopping'); dc.kill(); });
  log(C.relay && C.relay.url ? `relay: ${C.relay.url}` : 'no relay set: recording to files only');
}
