// Tileset decoding, exactly as the game draws the map (verified against the decompile):
//
//  .ppl  256 x {r,g,b} 6-bit (768 bytes). File_LoadPalette 0x463420 stores {r<<2, g<<2, b<<2, 0} at 0x4ae844
//        (the viewer checks the arena copy equals the file).
//  .vr4  minitiles: 8x8 palette indices, 64 bytes each, row-major (g_MinitileGfx).
//  .vx4  megatiles: 16 x u16 minitile refs each (32 bytes), 4x4 row-major (g_Megatiles). Gfx_DrawMegatile
//        0x411400 masks the megatile index with 0x7ff and draws ref k at (k&3)*8, (k>>2)*8.
//        Ref bits (Gfx_DrawMinitileToMapBuf 0x4012d0): minitile = ref >> 2 (byte offset (ref & 0xfffc)*16);
//        bit 1 (2) = horizontal flip (each row's 8 bytes reversed), bit 0 (1) = vertical flip (rows 7..0).
//  .cv4  21 u16 per PUD tile group: Map_BuildTileFlags 0x421640 replaces each PUD MTXM value t by
//        cv4[(t>>4)*21 + (t&15)] at boot, so the arena layer g_MapTiles (*0x4ad5cc, u16 per cell, row-major,
//        g_MapSize 0x4acbdc wide) holds megatile indices directly; tree chopping / wall and rock destruction
//        (Map_ForestTileClearCb 0x44dfe0 etc.) rewrite it in place, and Gfx_RedrawMapRect 0x411560 draws
//        straight from it. The viewer therefore never needs the .cv4 (it is listed for completeness).
//
// The tileset file names come from the game's descriptor table 0x496e04 (7 name pointers per tileset,
// 28 bytes: ppl, vx4, vr4, cv4, *_wall.bin, *_tree.bin, *_rock.bin), read from the arena.

export class Tileset {
  constructor({ ppl, vx4, vr4, names }) {
    this.names = names;
    this.palette = new Uint32Array(256);   // ABGR (little-endian RGBA bytes) for ImageData / PNG
    this.rgb = [];
    for (let i = 0; i < 256; i++) {
      const r = ppl[3 * i] << 2, g = ppl[3 * i + 1] << 2, b = ppl[3 * i + 2] << 2;
      this.palette[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      this.rgb.push([r, g, b]);
    }
    this.vx4 = new Uint16Array(vx4.buffer.slice(vx4.byteOffset, vx4.byteOffset + (vx4.length & ~1)));
    this.vr4 = vr4;
    this.nMega = this.vx4.length >> 4;
    this.nMini = vr4.length >> 6;
    this.cache = new Map();   // megatile index -> Uint32Array(1024) of palette-resolved pixels
  }
  // 32x32 palette indices of megatile `m` (index masked like Gfx_DrawMegatile), or null when out of range.
  megatileIdx(m) {
    m &= 0x7ff;
    if (!this.icache) this.icache = new Map();
    let px = this.icache.get(m);
    if (px !== undefined) return px;
    px = null;
    if (m < this.nMega) {
      px = new Uint8Array(1024);
      for (let k = 0; k < 16; k++) {
        const ref = this.vx4[16 * m + k], src = (ref >> 2) * 64;
        const hf = ref & 2, vf = ref & 1, ox = (k & 3) * 8, oy = (k >> 2) * 8;
        for (let y = 0; y < 8; y++) {
          const sy = vf ? 7 - y : y;
          for (let x = 0; x < 8; x++) px[(oy + y) * 32 + ox + x] = this.vr4[src + sy * 8 + (hf ? 7 - x : x)] ?? 0;
        }
      }
    }
    this.icache.set(m, px);
    return px;
  }
  // 32x32 pixels of megatile `m` with the file palette (no cycling), as Uint32 ABGR.
  megatile(m) {
    m &= 0x7ff;
    let px = this.cache.get(m);
    if (px) return px;
    px = new Uint32Array(1024);
    const ix = this.megatileIdx(m);
    if (ix) for (let i = 0; i < 1024; i++) px[i] = this.palette[ix[i]];
    else px.fill(0xffff00ff);   // out of range: magenta
    this.cache.set(m, px);
    return px;
  }
  // Average colour of a megatile (minimap).
  megatileColor(m) {
    m &= 0x7ff;
    if (!this.avg) this.avg = new Map();
    let c = this.avg.get(m);
    if (c !== undefined) return c;
    const px = this.megatile(m); let r = 0, g = 0, b = 0;
    for (const p of px) { r += p & 0xff; g += (p >> 8) & 0xff; b += (p >> 16) & 0xff; }
    c = (0xff000000 | ((b >> 10) << 16) | ((g >> 10) << 8) | (r >> 10)) >>> 0;
    this.avg.set(m, c);
    return c;
  }
}

// Load the tileset the booted game uses. getFile(name) -> Uint8Array|null; mem = SimSession.mem().
export function loadTileset(getFile, mem) {
  const ts = mem.r16(0x4acc10);   // g_Tileset
  const names = [];
  for (let i = 0; i < 7; i++) names.push(mem.cstr(mem.r32(0x496e04 + 28 * ts + 4 * i), 64));
  const [ppl, vx4, vr4] = names.slice(0, 3).map(n => { const d = getFile(n); if (!d) throw new Error('missing ' + n); return d; });
  const t = new Tileset({ ppl, vx4, vr4, names });
  t.index = ts;
  // cross-check with the palette the game loaded into the arena (0x4ae844, 4 bytes per entry)
  let diff = 0;
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) if (mem.r8(0x4ae844 + 4 * i + c) !== t.rgb[i][c]) diff++;
  t.paletteDiff = diff;
  return t;
}

// ---------------------------------------------------------------- palette cycling
// The game animates water, shores, lava/swamp and some sprite colours by rewriting palette entries, never pixels.
//
// Records: Pal_LoadTilesetCycles 0x42b1a0 copies the tileset's table (*(0x49e1e4 + 4*g_Tileset): u16 enable
// mask, u16, then 16-byte entries {u16 period, u16 first, u16 last, u16, u32 colour table, u16 table length}
// until period 0) into g_PalCycles 0x4d64b0 (8 x 16 bytes: +0 enabled, +1 period, +2 counter, +3 first,
// +4 phase, +5 last, +8 table, +0xc table length) and enables the entries whose mask bit is set. The sim
// lifts that (and Gfx_PalCycleEnable: unit rescue 0x452c70 and victory type 0x400 turn entry 0 on), so the
// records are read from the arena; the counters/phases are not advanced by the sim and live here.
//
//   tileset    entries (period first..last [table]), * = enabled by default
//   forest     0 4 ca [red pulse x10]   1* 8 26..2f   2* 12 30..38   3* 20 f0..f4   4* 8 03 [ff0000/00ff00]
//   winter     0 4 ca [red pulse]       1* 10 28..2f  2* 12 30..36   3* 20 f0..f4   4* 20 cd..cf   5* 8 03 [..]
//   wasteland  0 4 ca [red pulse]       1* 12 26..2f  2* 8 40..46    3* 20 f0..f4   4* 8 03 [..]
//   swamp      0 4 04 [red pulse]       1* 12 26..2f  2* 8 58..5f    3* 20 f0..f4   4* 8 05..09    5* 8 03 [..]
//
// Gfx_PalCyclesUpdate 0x488d80, one call = one step (exact port in step()):
//   due = some enabled entry has counter <= 1;
//   for each enabled entry: counter--; if (counter <= 2 && due) { counter = period + 1; fire }   (u8 arithmetic)
//   fire, no table: rotate up, pal[first+1..last] = pal[first..last-1], pal[first] = old pal[last];
//   fire, table:    phase = (phase + 1) % len; pal[first + k] = table[(phase + k) % len].
//   (so entries within 2 steps of being due fire together with the one that is due).
// Clock: Game_Run 0x4209e0 calls Gfx_PaletteCycleTick 0x421350 on every main-loop spin (not per sim tick),
// which steps when GetTickCount() - g_Game_PalCycleTick > 19, while g_Game_PalCycleOn, option bit
// g_SoundOptionMask & 0x40, the game is not paused (g_TurnTimer[2] == 0) and the app is active. GetTickCount
// advances in 15.625 ms quanta on Windows, so the first value > 19 ms is 31.25 ms: 32 steps/s. The viewer
// feeds game time (wall clock x playback speed, nothing while paused) through advance().
// Pause: Cmd0C_Pause -> Gfx_PalFadeToGray 0x4892b0 replaces the palette by its gray version
// (u8 (g*0x97>>8) + (b*0x1c>>8) + (r*0x4d>>8)); Gfx_PalFadeFromGray 0x489420 (g_PalGrayLevel 0x4d6536 back to 0)
// restores g_GamePalette 0x4ae844, i.e. the *uncycled* file palette (counters and phases keep going).
export const PAL_STEP_MS = 31.25;
const PAL_CYCLES = 0x4d64b0, PAL_CYCLE_ON = 0x4ae814, TURN_TIMER2 = 0x4ae80e, GRAY_LEVEL = 0x4d6536;

export class PaletteCycler {
  // tileset: Tileset (base palette = the .ppl, == g_GamePalette); m: arena (gamestate-style r8/r16/r32), optional
  constructor(tileset, m = null) {
    this.base = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) { const [r, g, b] = tileset.rgb[i]; this.base[4 * i] = r; this.base[4 * i + 1] = g; this.base[4 * i + 2] = b; }
    this.pal = this.base.slice();
    this.rgba = new Uint32Array(256);      // current colours, ABGR (ImageData byte order on little-endian)
    this.version = 1;                      // bumped whenever a colour changes
    this.changedAt = new Uint32Array(256); // version at which each entry last changed
    this.allAt = 1;                        // version of the last whole-palette change (gray on/off)
    this.cyclable = new Uint8Array(256);   // entries any record can touch
    this.clock = 0; this.steps = 0; this.gray = false; this.enabled = true;
    this.rec = [];
    if (m) this.load(m);
    this._emit(0, 255);
  }
  load(m) {
    this.rec = [];
    this.cyclable.fill(0);
    for (let i = 0; i < 8; i++) {
      const a = PAL_CYCLES + 16 * i, tab = m.r32(a + 8), len = m.r8(a + 0xc);
      const r = { period: m.r8(a + 1), counter: m.r8(a + 2), first: m.r8(a + 3), phase: m.r8(a + 4), last: m.r8(a + 5), tab: null, len };
      if (tab && len) { r.tab = new Uint8Array(4 * len); for (let k = 0; k < 4 * len; k++) r.tab[k] = m.r8(tab + k); }
      if (r.period || r.first || r.last) for (let k = r.first; k <= r.last; k++) this.cyclable[k] = 1;
      this.rec.push(r);
    }
  }
  _emit(first, last) {
    const p = this.pal;
    for (let i = first; i <= last; i++) {
      let r = p[4 * i], g = p[4 * i + 1], b = p[4 * i + 2];
      if (this.gray) r = g = b = (((g * 0x97) >> 8) + ((b * 0x1c) >> 8) + ((r * 0x4d) >> 8)) & 0xff;
      this.rgba[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      this.changedAt[i] = this.version;
    }
  }
  // One Gfx_PalCyclesUpdate. enabled(i): the arena's enable byte.
  step(m) {
    const en = i => (m ? m.r8(PAL_CYCLES + 16 * i) : 1) !== 0, R = this.rec;
    let due = false;
    for (let i = 0; i < R.length; i++) if (en(i) && R[i].counter <= 1) { due = true; break; }
    let fired = false;
    for (let i = 0; i < R.length; i++) {
      const r = R[i]; if (!en(i)) continue;
      r.counter = (r.counter - 1) & 0xff;
      if (r.counter > 2 || !due) continue;
      r.counter = (r.period + 1) & 0xff;
      if (!fired) { fired = true; this.version++; }
      const p = this.pal;
      if (!r.tab) {
        if (r.first < r.last) { const s = p.slice(4 * r.last, 4 * r.last + 4); p.copyWithin(4 * r.first + 4, 4 * r.first, 4 * r.last); p.set(s, 4 * r.first); }
      } else {
        r.phase = (r.phase + 1) & 0xff; if (r.phase === r.len) r.phase = 0;
        for (let k = r.first, ph = r.phase; k <= r.last; k++) { p.set(r.tab.subarray(4 * ph, 4 * ph + 4), 4 * k); if (++ph === r.len) ph = 0; }
      }
      if (r.first <= r.last) this._emit(r.first, r.last);
    }
    this.steps++;
  }
  // Gray (pause) state from the arena; call before drawing.
  sync(m) {
    const gray = m.r8(GRAY_LEVEL) !== 0;
    if (gray === this.gray) return;
    this.gray = gray;
    if (!gray) this.pal.set(this.base);   // Gfx_PalFadeFromGray fades to g_GamePalette
    this.version++; this.allAt = this.version;
    this._emit(0, 255);
  }
  // The option bit g_SoundOptionMask & 0x40 is the viewing machine's preference (registry); the sim boots
  // with 0 there, so the viewer has its own switch (this.enabled, default on) instead.
  running(m) { return this.enabled && m.r16(PAL_CYCLE_ON) !== 0 && m.r8(TURN_TIMER2) === 0; }
  // Advance by `ms` of game time (real time at 1x). Returns true when colours changed.
  advance(ms, m) {
    const v = this.version;
    this.sync(m);
    if (!(ms > 0) || !this.running(m)) return this.version !== v;
    this.clock += ms;
    let n = Math.floor(this.clock / PAL_STEP_MS);
    this.clock -= n * PAL_STEP_MS;
    if (n > 600) n = 600;   // long jumps: the phase is arbitrary anyway
    while (n-- > 0) this.step(m);
    return this.version !== v;
  }
}
