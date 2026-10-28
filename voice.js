// Voice intensity (the stats window's Voice tab, the timeline's waveform): how worked up each player sounds compared with their own
// normal in this game, from their CamRec microphone (camrec.js). Per 40 ms frame of speech: the pitch (F0, by
// normalised autocorrelation) and the loudness; per point of the chart, over the 15 s around it: the median pitch in
// semitones above the player's own median so far, the median loudness in dB above theirs, and how many seconds a
// minute they spoke. Intensity = the mean of the two, each in units of that player's own spread (MAD), so a quiet
// headset or a deep voice does not count. It says how excited someone sounds, not why (no stress or lie detection:
// voice "stress" analysis does not hold up).
import { micChunks, micChunkPcm } from './camrec.js';

const IN_RATE = 16000, RATE = 4000, DEC = IN_RATE / RATE;
const N = 160, HOP = 160, FRAME_S = HOP / RATE;           // 40 ms frames at 4 kHz
const LAG_MIN = Math.floor(RATE / 450), LAG_MAX = Math.ceil(RATE / 70);   // 70..450 Hz (a peak at 400 Hz needs the lag below it)
const VOICED = 0.7;                                        // normalised autocorrelation peak of a voiced frame
// low-pass (windowed sinc, 1.6 kHz at 16 kHz) before taking every 4th sample
const TAPS = (() => {
  const n = 31, fc = 1600 / IN_RATE, h = [];
  for (let i = 0; i < n; i++) { const k = i - (n - 1) / 2; h.push((k ? Math.sin(2 * Math.PI * fc * k) / (Math.PI * k) : 2 * fc) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1)))); }
  const s = h.reduce((a, b) => a + b, 0); return Float32Array.from(h, x => x / s);
})();
function decimate(x) {
  const out = new Float32Array(Math.floor(x.length / DEC)), H = TAPS.length >> 1;
  for (let j = 0; j < out.length; j++) {
    const c = j * DEC; let s = 0;
    for (let k = 0; k < TAPS.length; k++) { const i = c + k - H; if (i >= 0 && i < x.length) s += TAPS[k] * x[i]; }
    out[j] = s;
  }
  return out;
}
// frames of one stretch of speech: [{ t (ticks), db, f0 (Hz, 0 unvoiced) }]
export function speechFrames(pcm16k, t0, tickMs) {
  const x = decimate(pcm16k), out = [];
  for (let s = 0; s + N + LAG_MAX <= x.length; s += HOP) {
    let e0 = 0; for (let n = 0; n < N; n++) e0 += x[s + n] * x[s + n];
    const db = 10 * Math.log10(e0 / N + 1e-12);
    let f0 = 0;
    if (e0 > 1e-9) {
      const r = new Float32Array(LAG_MAX + 2);
      let el = 0; for (let n = 0; n < N; n++) el += x[s + LAG_MIN + n] * x[s + LAG_MIN + n];
      let best = 0;
      for (let L = LAG_MIN; L <= LAG_MAX; L++) {
        if (L > LAG_MIN) { const a = x[s + L - 1], b = x[s + L + N - 1]; el += b * b - a * a; }
        let c = 0; for (let n = 0; n < N; n++) c += x[s + n] * x[s + n + L];
        r[L] = el > 0 ? c / Math.sqrt(e0 * el) : 0;
        if (r[L] > best) best = r[L];
      }
      if (best >= VOICED) {   // the shortest lag that is a local peak near the best (no octave-down picks)
        for (let L = LAG_MIN + 1; L < LAG_MAX; L++) if (r[L] >= 0.8 * best && r[L] >= r[L - 1] && r[L] >= r[L + 1]) {
          const a = r[L - 1], b = r[L], c = r[L + 1], d = a - 2 * b + c, off = d < 0 ? 0.5 * (a - c) / d : 0;
          f0 = RATE / (L + off); break;
        }
      }
    }
    out.push({ t: t0 + (s / RATE) * 1000 / tickMs, db, f0 });
  }
  return out;
}

// The frames of every player's microphone, computed in the background a slice at a time (a recording only once:
// chunks are kept by where they start; a live game's growing chunk is done again). onUpdate() after each slice.
export class VoiceAnalysis {
  constructor() { this.cache = new Map(); this.pending = []; this.busy = false; this.onUpdate = null; this.total = 0; this.done = 0; }
  // tracks: camrec.js buildMicTracks result
  update(tracks, tickMs) {
    this.tickMs = tickMs; this.want = new Map(); this.pending = [];
    for (const [p, tr] of tracks) {
      const keys = [];
      for (const c of micChunks(tr, tickMs)) {
        const k = `${p}:${c.blocks[0].sample}:${c.n}:${c.t0}`; keys.push(k);
        if (!this.cache.has(k)) this.pending.push([k, c]);
      }
      this.want.set(p, keys);
    }
    this.total = this.pending.length; this.done = 0;
    if (!this.busy && this.pending.length) this.run();
  }
  run() {
    this.busy = true;
    const t0 = performance.now();
    while (this.pending.length && performance.now() - t0 < 12) {
      const [k, c] = this.pending.shift();
      this.cache.set(k, speechFrames(micChunkPcm(c), c.t0, this.tickMs)); this.done++;
    }
    if (this.onUpdate) this.onUpdate();
    if (this.pending.length) setTimeout(() => this.run(), 0); else this.busy = false;
  }
  get ready() { return !this.pending.length; }
  frames(p) {
    const out = []; for (const k of (this.want && this.want.get(p)) || []) { const f = this.cache.get(k); if (f) out.push(...f); }
    return out.sort((a, b) => a.t - b.t);
  }
  players() { return this.want ? [...this.want.keys()] : []; }
}

const median = a => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(), m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = (a, m) => median(a.map(x => Math.abs(x - m))) * 1.4826;
// The chart's series for one player's frames, at the ticks `grid`, over what was said up to tick `now`:
// { talk (s / min), pitch (semitones over their median), loud (dB over theirs), intensity (NaN: hardly spoke) }
export const WINDOW_S = 15, MIN_VOICED_S = 0.5;
export function voiceSeries(frames, grid, now, tickMs) {
  const fr = frames.filter(f => f.t <= now), voiced = fr.filter(f => f.f0 > 0);
  const n = grid.length, out = { talk: new Array(n).fill(0), pitch: new Array(n).fill(NaN), loud: new Array(n).fill(NaN), intensity: new Array(n).fill(NaN) };
  if (!voiced.length) return out;
  // octave errors (a frame's peak at twice or half the period; quiet, noisy headsets make more): folded back
  // towards the player's median pitch
  const m0 = median(voiced.map(f => f.f0)), fold = f => f > 1.7 * m0 ? f / 2 : f < 0.6 * m0 ? f * 2 : f;
  const st = voiced.map(f => 12 * Math.log2(fold(f.f0))), db = voiced.map(f => f.db);
  const mSt = median(st), mDb = median(db), sSt = Math.max(0.5, mad(st, mSt)), sDb = Math.max(1, mad(db, mDb));
  const half = WINDOW_S / 2 * 1000 / tickMs;
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    const a = grid[i] - half, b = Math.min(now, grid[i] + half);
    while (lo < voiced.length && voiced[lo].t < a) lo++;
    if (hi < lo) hi = lo;
    while (hi < voiced.length && voiced[hi].t <= b) hi++;
    const k = hi - lo, span = Math.max(1, (b - a) * tickMs / 1000);
    out.talk[i] = k * FRAME_S / span * 60;
    if (k * FRAME_S < MIN_VOICED_S) continue;
    const p = median(st.slice(lo, hi)) - mSt, l = median(db.slice(lo, hi)) - mDb;
    out.pitch[i] = p; out.loud[i] = l; out.intensity[i] = (p / sSt + l / sDb) / 2;
  }
  return out;
}

// Lines on a symmetric scale (±lim), NaN = gap; the same frame and data attributes as stats.js stackChartSvg, so the
// stats window's hover line and tooltip work on it. lines: [{ rgb, v }]
export function lineChartSvg({ title, t, lines, lim, w, h, tickMs, labels }) {
  const L = 52, R = 12, T = 24, B = 22, W = Math.max(60, w - L - R), H = Math.max(60, h - T - B);
  const tMax = Math.max(1, t.length ? t[t.length - 1] : 1);
  const X = k => L + W * k / tMax, Y = v => T + H * (lim - Math.max(-lim, Math.min(lim, v))) / (2 * lim);
  const esc = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`), fmtT = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const out = [`<svg class="stChart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-l="${L}" data-w="${W}" data-tmax="${tMax}" data-b="${T + H}">`,
    `<text class="ttl" x="${L}" y="15">${esc(title)}</text>`];
  for (const [v, txt] of labels) out.push(`<line class="grid${v === 0 ? ' zero' : ''}" x1="${L}" x2="${L + W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(txt)}</text>`);
  const minMs = tMax * tickMs, tStep = [30, 60, 120, 300, 600, 900, 1800].find(s => minMs / 1000 / s <= 8) || 3600;
  for (let s = 0; s * 1000 <= minMs; s += tStep) { const x = X(s * 1000 / tickMs); out.push(`<line class="grid v" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T}" y2="${T + H}"/><text class="ax" x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${fmtT(s * 1000)}</text>`); }
  for (const ln of lines) {
    let d = '', pen = false;
    ln.v.forEach((v, i) => { if (Number.isFinite(v)) { d += `${pen ? 'L' : 'M'}${X(t[i]).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; } else pen = false; });
    if (d) out.push(`<path d="${d}" fill="none" stroke="rgb(${ln.rgb})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  out.push(`<line class="cur" x1="0" x2="0" y1="${T}" y2="${T + H}" visibility="hidden"/><g class="marks"></g></svg>`);
  return out.join('');
}

// The timeline's waveform of one player (viewer.js, under the seek bar): per column between the ticks edges[i] and
// edges[i + 1], amp = the loudest speech frame there (0..1 between the player's quiet and loud ends; 0 = silent) and
// intensity as voiceSeries over everything said so far (one normal for the whole bar: an overview, not "so far").
export function voiceWave(frames, edges, now, tickMs) {
  const n = Math.max(0, edges.length - 1), amp = new Float32Array(n);
  if (!frames.length || !n) return { amp, intensity: new Float32Array(n).fill(NaN) };
  const dbs = Float64Array.from(frames, f => f.db).sort(), q = x => dbs[Math.min(dbs.length - 1, Math.floor(x * dbs.length))];
  const lo = q(0.1), hi = Math.max(lo + 6, q(0.99));
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < frames.length && frames[j].t < edges[i]) j++;
    let best = -Infinity;
    for (let k = j; k < frames.length && frames[k].t < edges[i + 1]; k++) if (frames[k].db > best) best = frames[k].db;
    if (best > -Infinity) amp[i] = Math.max(0.12, Math.min(1, (best - lo) / (hi - lo)));
  }
  const mid = Array.from({ length: n }, (_, i) => (edges[i] + edges[i + 1]) / 2);
  return { amp, intensity: Float32Array.from(voiceSeries(frames, mid, now, tickMs).intensity) };
}
// intensity -> colour: blue (calmer than usual) .. grey (their normal) .. orange .. red (+2 and more)
export function intensityRgb(v) {
  if (!Number.isFinite(v)) return [150, 158, 170];
  const x = Math.max(-1, Math.min(1, v / 2)), mix = (a, b, f) => a.map((c, i) => Math.round(c + (b[i] - c) * f));
  return x < 0 ? mix([165, 172, 185], [80, 140, 235], -x) : x < 0.5 ? mix([165, 172, 185], [240, 170, 60], x * 2) : mix([240, 170, 60], [235, 60, 45], (x - 0.5) * 2);
}
// Each frame's own intensity (the VU meter, viewer.js): its pitch and loudness against the player's normal over all
// the frames given, in units of their spread, as voiceSeries; NaN for frames without voice (silence).
export function frameIntensity(frames) {
  const out = new Float32Array(frames.length).fill(NaN), voiced = frames.filter(f => f.f0 > 0);
  if (!voiced.length) return out;
  const m0 = median(voiced.map(f => f.f0)), fold = f => f > 1.7 * m0 ? f / 2 : f < 0.6 * m0 ? f * 2 : f;
  const st = voiced.map(f => 12 * Math.log2(fold(f.f0))), db = voiced.map(f => f.db);
  const mSt = median(st), mDb = median(db), sSt = Math.max(0.5, mad(st, mSt)), sDb = Math.max(1, mad(db, mDb));
  frames.forEach((f, i) => { if (f.f0 > 0) out[i] = ((12 * Math.log2(fold(f.f0)) - mSt) / sSt + (f.db - mDb) / sDb) / 2; });
  return out;
}
