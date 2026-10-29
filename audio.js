// Game sound for the replay viewer: maps the sim's presentation hook events (sim/include/w2hooks.h) to the
// game's own .wav files and plays them with WebAudio the way Warcraft II BNE 2.02 does for the viewed player.
//
// Sound table: Snd_ResetVoiceState 0x423010 installs the per-race in-game list *(0x498a70 + 4*race) (8-byte
// entries {u16 flags, u16, char *name}, 351 of them; human and orc differ only in the race voices / buildings).
// A HK_SOUND id is 1-based into it (Snd_PlayUnit 0x422c70 plays index id-1). The table of the viewed player's race
// is used; the recording player's UI voices use the recorder's race. All files are in War2Dat.mpq (PKWARE or
// stored sectors, mpq.js) as RIFF PCM (8-bit unsigned / 16-bit, mono / stereo, 11-44 kHz), decoded here directly.
//
// Rules taken from the original (out/funcs):
//   Snd_PlayUnit(id, unit, positional, far) 0x422c70: positional with a unit -> silent if the unit is inside
//     something (flags 0x08) or hidden from the player (unit+0x28 & player bit); inside the viewport -> full volume,
//     else only with `far`, at low volume, never for ids 1 and 0x22..0x25 (error / tree chops); silent for unit
//     flags 0x4000. Positional without a unit, or not positional -> full volume.
//   Snd_PlayAtCell(id, cell, positional, far) 0x422e30: silent if the cell is not currently visible to the player
//     (g_FogSeenMask bit set), inside the viewport -> full, else `far` -> low.
//   Volumes: Snd_PlaySfxFullVol = g_SndVolumeTable[vol*99/100], Snd_PlaySfxLowVol = [vol*24/100]; the table
//     (0x490c88, hundredths of dB) is linear in amplitude, so low = 24% of full.
//   Snd_PlaySfxEx 0x4406b0: 8 DirectSound channels; when all 8 are busy the new sound is dropped; the same entry
//     restarts at most every 80 ms (GetTickCount + 0x4f).
//   Unit voices (HK_VOICE_SELECT / HK_VOICE_ACK, the local player's clicks): the per-type pickers of the tables
//     0x498c48 / 0x498aec are reproduced below (Snd_SelectVoice_* / Snd_AckVoice_*; LocalRng -> Math.random).
// Viewer additions: pan by screen x, off-screen sounds fade further with distance from the view.
// Music: none (Snd_PlayMusic 0x440ea0 streams CD-audio Music\*.WAV files, which the BNE install does not have).
// Volume: master -> voice bus (unit voices, the player view's spoken notices) + FX bus (everything else); the
// microphones (micplay.js) go to the master too.

export const HK = { SOUND: 1, VOICE_SELECT: 2, VOICE_ACK: 3, STATUS_MSG: 4, MSG_TIMED: 5, MUSIC: 12, STOP_SOUNDS: 13, SFX: 16, CMD: 17, KILL: 18, KILL_CREDIT: 19, RESEARCH: 20, DAMAGE: 21, RUNE: 22, CAST: 23 };
export const HKS_POSITIONAL = 1, HKS_FAR = 2, HKS_SELECT = 4, HKS_OTHER = 8, HKS_ALT = 16;
// HKS_ALT: a plugin's replacement sample (Peon2k: bloodlusted knights / paladins shout PEON2K\ajmoo.wav, which the
// plugin writes out of its DLL). Played when the viewer has that file (from the user's plugin/peon2k.w2p).
export const ALT_SOUND = 'PEON2K\\ajmoo.wav';
export const SFX_TABLES = 0x498a70;
const A_PLAYER_RACE = 0x4abd28, A_LOCAL_PLAYER = 0x4acb18, A_MAP_SIZE = 0x4acbdc, A_FOG_SEEN = 0x4ad60c, A_TILESET = 0x4acc10;
export const GAIN_FULL = 0.99, GAIN_LOW = 0.24, CHANNELS = 8, REPEAT_MS = 80;

// Acknowledge voice per unit type (0x498aec): [base, n]: id = base + random(n); n = 0: constant; -1: critter.
export const ACK_VOICE = [
  [18, 4], [18, 4], [236, 4], [18, 4], [253, 0], [253, 0], [150, 4], [176, 3], [115, 4], [211, 3],
  [221, 3], [93, 3], [162, 4], [187, 3], [102, 5], [134, 4], [236, 4], [18, 4], [115, 4], [211, 3],
  [260, 3], [341, 3], [287, 3], [314, 3], [278, 3], [323, 3], [54, 0], [197, 3], [197, 3], [197, 3],
  [197, 3], [197, 3], [197, 3], [197, 3], [0, 0], [305, 3], [0, 0], [0, 0], [197, 3], [197, 3],
  [125, 0], [141, 0], [245, 2], [242, 2], [296, 3], [347, 0], [269, 3], [332, 3], [0, 0], [187, 3],
  [150, 4], [93, 3], [162, 4], [211, 3], [0, 0], [351, 0], [38, 0], [0, -1],
];
// Selection voice per unit type (0x498c48), called with k = max(0, clicks on the same unit - 2):
// [K, off, base, n]: 0 < k < K -> off + k ("annoyed" sequence), else base + random(n) (n = 0: constant base).
export const SELECT_VOICE = [
  [8, 9, 4, 6], [8, 9, 4, 6], [8, 224, 232, 4], [8, 9, 4, 6], [0, 0, 38, 0], [0, 0, 38, 0], [4, 141, 146, 4], [6, 165, 172, 4],
  [4, 106, 111, 4], [4, 203, 208, 3], [4, 213, 218, 3], [4, 86, 91, 2], [4, 153, 158, 4], [4, 178, 183, 4], [4, 95, 100, 2],
  [4, 125, 130, 4], [8, 224, 232, 4], [8, 9, 4, 6], [4, 106, 111, 4], [4, 203, 208, 3], [4, 253, 257, 3], [4, 334, 338, 3],
  [4, 280, 284, 3], [4, 307, 311, 3], [4, 271, 275, 3], [4, 316, 320, 3], [4, 189, 194, 3], [4, 189, 194, 3], [4, 189, 194, 3],
  [4, 189, 194, 3], [4, 189, 194, 3], [4, 189, 194, 3], [4, 189, 194, 3], [4, 189, 194, 3], [0, 0, 0, 0], [4, 298, 302, 3],
  [0, 0, 0, 0], [0, 0, 0, 0], [4, 189, 194, 3], [5, 199, 4, 6], [6, 118, 38, 0], [3, 137, 38, 0], [0, 0, 244, 0], [0, 0, 241, 0],
  [4, 289, 293, 3], [0, 0, 38, 0], [4, 262, 266, 3], [4, 325, 329, 3], [0, 0, 0, 0], [4, 178, 183, 4], [4, 141, 146, 4],
  [4, 86, 91, 2], [4, 153, 158, 4], [4, 203, 208, 3], [0, 0, 0, 0], [0, 0, 38, 0], [0, 0, 38, 0], [-1, 0, 0, 0],
];
const rnd = n => Math.floor(Math.random() * n);
// Snd_AckVoice_Critter 0x422310: sheep / seal / pig / warthog by tileset.
export function ackVoice(type, tileset, r = rnd) {
  const v = ACK_VOICE[type];
  if (!v) return 0;
  if (v[1] < 0) return tileset === 3 ? 0x158 : 2 * tileset + 0xf7;
  return v[1] ? v[0] + r(v[1]) : v[0];
}
// Snd_SelectVoice_Critter 0x422900: k == 1 -> the annoyed variant, else the plain one.
export function selectVoice(type, k, tileset, r = rnd) {
  const v = SELECT_VOICE[type];
  if (!v) return 0;
  if (v[0] < 0) return tileset === 3 ? (k === 1 ? 0x159 : 0x158) : 2 * tileset + (k === 1 ? 0xf8 : 0xf7);
  if (k > 0 && k < v[0]) return v[1] + k;
  return v[3] ? v[2] + r(v[3]) : v[2];
}
// Every id a voice event can produce (node test).
export function voiceVariants(kind, type, k, tileset) {
  const s = new Set();
  for (let i = 0; i < 8; i++) { const r = n => i % n; s.add(kind === HK.VOICE_ACK ? ackVoice(type, tileset, r) : selectVoice(type, k, tileset, r)); }
  s.delete(0);
  return [...s];
}

// The two race tables from the arena: [{ names: [...], flags: [...] } for human, orc].
export function readSoundTables(m) {
  const out = [];
  for (let race = 0; race < 2; race++) {
    const tab = m.r32(SFX_TABLES + 4 * race), names = [], flags = [];
    for (let e = tab; tab && names.length < 1000; e += 8) {
      const np = m.r32(e + 4);
      if (!np) break;
      names.push(m.cstr(np, 64)); flags.push(m.r16(e));
    }
    out.push({ names, flags });
  }
  return out;
}

// RIFF WAVE PCM -> { rate, channels, frames, samples: [Float32Array per channel] }.
export function parseWav(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF WAVE file');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= b.length;) {
    const id = tag(o), len = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data') data = b.subarray(body, Math.min(b.length, body + len));
    o = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAVE without fmt/data');
  if (fmt.format !== 1 || (fmt.bits !== 8 && fmt.bits !== 16) || fmt.channels < 1 || fmt.channels > 2 || !fmt.rate) throw new Error(`unsupported WAVE format ${fmt.format}/${fmt.bits} bit/${fmt.channels} ch`);
  const bps = fmt.bits / 8 * fmt.channels, frames = Math.floor(data.length / bps), samples = [];
  for (let c = 0; c < fmt.channels; c++) samples.push(new Float32Array(frames));
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) {
    samples[c][i] = fmt.bits === 8 ? (data[i * bps + c] - 128) / 128 : ddv.getInt16(i * bps + 2 * c, true) / 32768;
  }
  return { rate: fmt.rate, channels: fmt.channels, frames, samples };
}

// Event -> what the game would play for the viewed player, or null. env:
//   m          arena reader (SimSession.mem())
//   tables     readSoundTables(m)
//   player     viewed player (-1: no fog, everything audible, as the recorder)
//   view       { x, y, w, h } viewport in tiles (like g_ViewX/Y, g_ViewportTilesW/H)
//   voices     play HK_VOICE_SELECT / HK_VOICE_ACK
// Returns { id, name, gain, pan, flags, ui, voice } (ui: a sound of the recording player's own interface; voice: a
// unit voice, on the voice bus).
export function resolveEvent(e, env) {
  const { m } = env, recorder = m.r8(A_LOCAL_PLAYER), p = env.player;
  const raceOf = q => { const r = m.r8(A_PLAYER_RACE + q); return r === 1 ? 1 : 0; };
  let id, ui = false, pos = null, gain = GAIN_FULL, voice = false;
  switch (e.kind) {
    case HK.SOUND: id = e.a & 0xffff; break;
    case HK.SFX: id = e.b === 3 ? e.a : e.a + 1; ui = true; if (e.b === 2) gain = GAIN_LOW; break;   // raw index (clicks pass the 1-based id)
    // env.ownUi (player view, or a fog-of-war player picked): its UI voices and notices come from playerview.js UiVoices
    case HK.VOICE_ACK: if (!env.voices || env.ownUi || !e.d) return null; id = ackVoice(e.b, m.r8(A_TILESET)); ui = true; voice = true; break;
    case HK.VOICE_SELECT: if (!env.voices || env.ownUi) return null; id = selectVoice(e.c, e.b, m.r8(A_TILESET)); ui = true; voice = true; break;
    default: return null;
  }
  if (!id) return null;
  const flags = e.kind === HK.SOUND ? e.d : 0;
  if (e.kind === HK.SOUND) {
    if (flags & HKS_OTHER) return null;           // per-player copies for the player view (playerview.js)
    if (env.ownUi && !(flags & (HKS_POSITIONAL | HKS_FAR))) return null;   // the recorder's UI: UiVoices has every player's
    if (flags & HKS_SELECT) { if (!env.voices || env.ownUi) return null; ui = true; }   // building / unit selection sound (a click)
    // neither positional nor far: a notification the sim emits for the recorder only (ready, work complete,
    // attacked); the construction sound is FAR-only and plays for every building, like the original's option
    if (!(flags & (HKS_POSITIONAL | HKS_FAR))) ui = true;
    else if (!(flags & HKS_POSITIONAL)) { /* full volume, everywhere */ }
    else if (e.c !== 0xffffffff) {                // Snd_PlayAtCell
      const x = (e.c << 16) >> 16, y = e.c >> 16, n = m.r16(A_MAP_SIZE);
      if (p >= 0 && x >= 0 && y >= 0 && x < n && y < n && (m.u8[m.base + m.r32(A_FOG_SEEN) + y * n + x] & (1 << p))) return null;
      pos = { x, y };
    } else if (e.b) {                             // Snd_PlayUnit with a unit
      const u = e.b, uf = m.r16(u + 0x1e);
      if (uf & 8) return null;
      if (p >= 0 && (m.r8(u + 0x28) & (1 << p))) return null;
      if (uf & 0x4000) return null;
      pos = { x: m.s16(u + 0x18), y: m.s16(u + 0x1a), unit: true };
    }
  }
  if (ui && p >= 0 && p !== recorder) return null;   // only the recorder heard its own UI sounds
  const tab = env.tables[raceOf(ui || p < 0 ? recorder : p)];
  let name = tab && tab.names[id - 1];
  if (!name) return null;
  if ((flags & HKS_ALT) && env.hasAlt) name = ALT_SOUND;
  let pan = 0;
  if (pos && env.view) {
    const v = env.view, cx = v.x + v.w / 2, hw = Math.max(1, v.w / 2);
    const inView = pos.x >= Math.floor(v.x) && pos.y >= Math.floor(v.y) && pos.x <= v.x + v.w && pos.y <= v.y + v.h;
    pan = Math.max(-1, Math.min(1, (pos.x + 0.5 - cx) / hw));
    if (!inView) {
      if (!(flags & HKS_FAR)) return null;
      if (pos.unit && (id === 1 || (id >= 0x22 && id <= 0x25))) return null;
      const dx = Math.max(v.x - pos.x, 0, pos.x - (v.x + v.w)), dy = Math.max(v.y - pos.y, 0, pos.y - (v.y + v.h));
      gain = GAIN_LOW * Math.max(0.3, 1 - Math.hypot(dx, dy) / 48);
      pan *= 0.9;
    } else pan *= 0.6;
  }
  return { id, name, gain, pan, flags, ui, voice };
}

// ---- WebAudio player ----
const STORE = 'w2viewer.audio';
function loadSettings() {
  const d = { volume: 70, voiceVolume: 100, fxVolume: 100, voices: false, mics: true, micVolume: 100 };
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && typeof s === 'object') Object.assign(d, s); } catch { /* no storage */ }
  delete d.muted; delete d.music;   // older settings
  return d;
}

export class GameAudio {
  constructor() {
    this.settings = loadSettings();
    this.ctx = null; this.master = null; this.voiceBus = null; this.fxBus = null;
    this.getFile = null; this.tables = null;
    this.cache = new Map();          // name -> AudioBuffer | null (undecodable)
    this.extra = new Map();          // name -> wav bytes not in the MPQs (plugin samples)
    this.active = [];                // { src, name, t }
    this.lastStart = new Map();      // name -> ms
    this.wasEnabled = false;
    this.ui = null;
  }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* no storage */ } }
  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  // Browsers start an AudioContext only from a user gesture.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.voiceBus = this.ctx.createGain(); this.voiceBus.connect(this.master);
        this.fxBus = this.ctx.createGain(); this.fxBus.connect(this.master);
        this.applyVolume();
        this.ctx.onstatechange = () => this.refreshUi();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().then(() => this.refreshUi(), () => {});
    } catch (e) { console.warn('audio unavailable:', e); }
    this.refreshUi();
  }
  // New replay: game files (getFile(name) -> Uint8Array|null, sync) and the arena's sound tables.
  setGame(getFile, m) {
    this.stopAll();
    if (this.getFile !== getFile) this.cache.clear();
    this.getFile = getFile;
    this.tables = readSoundTables(m);
  }
  setExtraFile(name, bytes) { this.cache.delete(name); if (bytes) this.extra.set(name, bytes); else this.extra.delete(name); }
  applyVolume() {
    const s = this.settings;
    if (this.master) this.master.gain.value = s.volume / 100;
    if (this.voiceBus) this.voiceBus.gain.value = (s.voiceVolume ?? 100) / 100;
    if (this.fxBus) this.fxBus.gain.value = (s.fxVolume ?? 100) / 100;
  }
  buffer(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let ab = null;
    try {
      const bytes = this.extra.get(name) || (this.getFile && this.getFile(name));
      if (bytes) {
        const w = parseWav(bytes);
        ab = this.ctx.createBuffer(w.channels, Math.max(1, w.frames), w.rate);
        w.samples.forEach((s, c) => ab.copyToChannel(s, c));
      }
    } catch (e) { console.warn(`sound ${name}:`, e.message); }
    this.cache.set(name, ab);
    return ab;
  }
  play(r) {
    if (!this.running) return false;
    const now = performance.now();
    this.active = this.active.filter(a => !a.done);
    if (this.active.length >= CHANNELS) return false;                       // all channels busy: dropped
    if (now - (this.lastStart.get(r.name) || -1e9) < REPEAT_MS) return false;
    const buf = this.buffer(r.name);
    if (!buf) return false;
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; g.gain.value = r.gain;
    let node = src.connect(g);
    if (ctx.createStereoPanner && r.pan) { const pn = ctx.createStereoPanner(); pn.pan.value = r.pan; node = node.connect(pn); }
    node.connect(r.voice ? this.voiceBus : this.fxBus);
    const a = { src, name: r.name, done: false };
    src.onended = () => { a.done = true; };
    src.start();
    this.active.push(a); this.lastStart.set(r.name, now);
    return true;
  }
  // A sound of player `player`'s own interface in the player view (playerview.js UiVoices): full volume, centred,
  // from that player's race table (the sound table Snd_ResetVoiceState installs for the local race).
  playUi(race, id) {
    if (!this.tables || !this.running) return false;
    const tab = this.tables[race === 1 ? 1 : 0], name = tab && tab.names[id - 1];
    return name ? this.play({ id, name, gain: GAIN_FULL, pan: 0, flags: 0, ui: true, voice: true }) : false;
  }
  stopAll() {
    for (const a of this.active) { try { a.src.stop(); } catch { /* already stopped */ } a.done = true; }
    this.active = [];
  }
  // Events of one sim turn. env: resolveEvent's env plus `enabled` (1x/2x playback, not seeking).
  handle(events, env) {
    if (env.enabled !== this.wasEnabled) { this.wasEnabled = env.enabled; if (!env.enabled) this.stopAll(); this.refreshUi(env); }
    if (!this.tables || !events.length) return;
    for (const e of events) {
      if (e.kind === HK.STOP_SOUNDS) { this.stopAll(); continue; }
      if (!env.enabled || !this.running) continue;
      const r = resolveEvent(e, { ...env, tables: this.tables, voices: this.settings.voices, hasAlt: this.extra.has(ALT_SOUND) });
      if (r) this.play(r);
    }
  }
  // Controls: { volume, voiceVolume, fxVolume: ranges 0..100, voices: checkbox }
  bindControls(el) {
    this.ui = el;
    const s = this.settings;
    el.volume.value = s.volume; el.voiceVolume.value = s.voiceVolume; el.fxVolume.value = s.fxVolume; el.voices.checked = s.voices;
    for (const k of ['volume', 'voiceVolume', 'fxVolume']) el[k].oninput = () => { this.unlock(); s[k] = +el[k].value; this.applyVolume(); this.save(); };
    el.voices.onchange = () => { s.voices = el.voices.checked; this.save(); };
    const gesture = () => { this.unlock(); if (this.running) for (const k of ['pointerdown', 'keydown', 'touchend', 'click']) window.removeEventListener(k, gesture, true); };
    for (const k of ['pointerdown', 'keydown', 'touchend', 'click']) window.addEventListener(k, gesture, true);
    this.refreshUi();
  }
  refreshUi(env) {
    const el = this.ui; if (!el) return;
    if (env) this.lastEnabled = env.enabled;
    el.volume.title = !this.running ? 'Volume. Sound starts with your first click or key press (browser autoplay rule)'
      : this.lastEnabled === false ? 'Volume (sound plays only at 1x and 2x, not while seeking)' : 'Volume';
  }
}
