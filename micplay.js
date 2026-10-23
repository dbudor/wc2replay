// Players' microphones (CamRec, camrec.js buildMicTracks / micChunks) played along the replay.
// Each speech chunk starts at its game time and plays at normal speed; frame() is called every animation frame
// with the game time and schedules the chunks starting within the next LOOKAHEAD seconds on the AudioContext
// clock, starts one already under way at the right offset (after a seek or resume), and restarts one that drifted
// from the game (the replay stalled, or the tab slept). Only at 1x: other speeds stop the voices.
// Which players are heard: the one the view is linked to (focus, set by the viewer every frame), else the ones
// picked by hand (picked; none at first).
import { micChunks, micChunkPcm, MIC_RATE } from './camrec.js';

const LOOKAHEAD = 0.4;        // s
const DRIFT = 0.3;            // s: a playing chunk further than this from the game is restarted
const KEEP = 90;              // s: decoded chunks further than this from the game are dropped (memory)
const TARGET = 2500;          // speech level (mean |sample|) the per-player gain aims for

export class MicPlayer {
  constructor(audio) {
    this.audio = audio;
    this.tracks = new Map(); this.chunks = new Map();   // player -> track, player -> chunks
    this.live = new Map();                              // chunk -> { src, ctxAt (AudioContext time of the chunk's sample 0), player }
    this.picked = new Set();                            // players switched on by hand
    this.focus = -1;                                    // >= 0: only this player is heard (mic follows the view)
    this.talking = new Set();                           // players speaking at the current game time
    this.gainNode = null; this.playerGain = new Map();
    this.tickMs = 1000 / 30;
    this.onSpeech = null;                               // (player, chunk) when a chunk starts during playback
  }
  get enabled() { return this.audio.settings.mics !== false; }
  setTracks(tracks, tickMs) {
    this.stopAll();
    this.tracks = tracks; this.tickMs = tickMs; this.chunks = new Map();
    for (const [p, tr] of tracks) {
      this.chunks.set(p, micChunks(tr, tickMs));
      // even out the players' levels (headset gains differ a lot): from the loudest 20 ms frame the plugin saw
      const peak = tr.info && tr.info.peak ? tr.info.peak : TARGET;
      this.playerGain.set(p, Math.max(0.5, Math.min(4, TARGET / (0.6 * peak))));
    }
  }
  get players() { return [...this.chunks.keys()].filter(p => this.chunks.get(p).length).sort((a, b) => a - b); }
  stopAll() {
    for (const l of this.live.values()) { try { l.src.stop(); } catch { /* not started / ended */ } }
    this.live.clear();
  }
  stopPlayer(p) {
    for (const [c, l] of this.live) if (l.player === p) { try { l.src.stop(); } catch { /* ended */ } this.live.delete(c); }
  }
  audible(p) { return this.focus >= 0 ? p === this.focus : this.picked.has(p); }
  toggle(p) { if (this.picked.has(p)) this.picked.delete(p); else this.picked.add(p); }
  // env: { t (game time, ticks), active (playing at 1x, nothing in the way) }
  frame(env) {
    const tk = this.tickMs / 1000, t = env.t;
    this.talking.clear();
    for (const [p, cs] of this.chunks) {
      for (const c of this.near(cs, t)) if (t >= c.t0 && t < c.t0 + c.dur / tk) this.talking.add(p);
    }
    const a = this.audio, ctx = a.ctx;
    if (!env.active || !this.enabled || !a.running) { if (this.live.size) this.stopAll(); return; }
    if (!this.gainNode) { this.gainNode = ctx.createGain(); this.gainNode.connect(a.master); }
    this.gainNode.gain.value = (a.settings.micVolume ?? 100) / 100;
    const now = ctx.currentTime;
    for (const [c, l] of this.live) {   // ended, switched off, or no longer where the game is
      const pos = now - l.ctxAt, want = (t - c.t0) * tk;
      if (l.done || !this.audible(l.player) || pos > c.dur + 0.05 || Math.abs(pos - want) > DRIFT) { if (!l.done) { try { l.src.stop(); } catch { /* ended */ } } this.live.delete(c); }
    }
    for (const [p, cs] of this.chunks) {
      if (!this.audible(p)) continue;
      for (const c of this.near(cs, t)) {
        const startIn = (c.t0 - t) * tk, offset = -startIn;
        if (this.live.has(c) || startIn > LOOKAHEAD || offset >= c.dur - 0.02) continue;
        if (!c.buf) c.buf = this.buffer(c);
        if (!c.buf) continue;
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = c.buf; g.gain.value = this.playerGain.get(p) || 1;
        src.connect(g).connect(this.gainNode);
        const prev = c.cont && this.live.get(c.cont);   // the next piece of the same speech: right after it, gapless
        const at = prev ? Math.max(now, prev.ctxAt + c.cont.dur) : now + Math.max(0, startIn), off = prev ? 0 : Math.max(0, offset);
        const l = { src, ctxAt: at - off, player: p, done: false };
        src.onended = () => { l.done = true; };
        src.start(at, off);
        this.live.set(c, l);
        if (this.onSpeech && offset < 0.25) this.onSpeech(p, c);
      }
      for (const c of cs) if (c.buf && Math.abs((c.t0 - t) * tk) > KEEP && !this.live.has(c)) c.buf = null;
    }
  }
  // chunks overlapping [t - longest, t + lookahead] (binary search on t0; chunks are in t0 order)
  near(cs, t) {
    const tk = this.tickMs / 1000, hi = t + (LOOKAHEAD + 0.1) / tk;
    let lo = 0, h = cs.length;
    while (lo < h) { const m = (lo + h) >> 1; if (cs[m].t0 <= hi) lo = m + 1; else h = m; }
    const out = [];
    for (let i = lo - 1; i >= 0; i--) {
      const c = cs[i];
      if (c.t0 + c.dur / tk >= t) out.push(c);
      else if (t - c.t0 > 120 / tk) break;   // chunks are at most a couple of minutes long
    }
    return out;
  }
  buffer(c) {
    try {
      const pcm = micChunkPcm(c), b = this.audio.ctx.createBuffer(1, Math.max(1, pcm.length), MIC_RATE);
      b.copyToChannel(pcm, 0);
      return b;
    } catch (e) { console.warn('microphone chunk:', e.message); return null; }
  }
}
