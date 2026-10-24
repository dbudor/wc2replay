// Map/unit renderer over a Canvas2D-like context (browser canvas, or softcanvas.js under node).
//
// Terrain: drawn from the live arena layer g_MapTiles (*0x4ad5cc: u16 megatile index per cell, row-major,
// g_MapSize wide; see tileset.js). The map is kept as palette INDICES (this.terrain: Uint8Array, mapSize*32
// px square); only cells whose megatile index changed since the last frame are rewritten (trees chopped,
// walls/rocks destroyed, ...). Each frame the visible part is coloured through the cycling palette
// (tileset.js PaletteCycler, Uint32 LUT) into a view-sized ImageData, only when the palette, the tiles or
// the view changed. Zoomed out (scale < 1) it is sampled at screen resolution, so the cost is bounded by
// min(visible map pixels, screen pixels). Sprites share the cycler (sprites.js setCycler).
//
// Fog (view "as player p"):
//   visible now  = bit p of g_FogSeenMask (*0x4ad60c, u8 per cell) is CLEAR (Fog_RevealTileCb clears the
//                  revealing player's bit; the per-turn re-fog sets it again);
//   explored     = local player (g_LocalPlayer 0x4acb18, the recording peer): g_FogExplored (*0x4ad5e0) < 16;
//                  other players: accumulated by FogTracker from the visible bits of every turn played.
// Units of other players are hidden on cells the viewed player does not see (buildings: unless explored).

import { readUnits, readMissiles, A } from './gamestate.js';
import { PaletteCycler } from './tileset.js';

export const OWNER_FALLBACK = ['#c00000', '#0048cc', '#2cb494', '#9848b0', '#f88c14', '#28283c', '#e0e0e0', '#fcfc48'];

export class FogTracker {   // per-player "ever seen" masks, fed once per turn
  constructor(n) { this.n = n; this.seen = Array.from({ length: 8 }, () => new Uint8Array(n * n)); }
  update(m) {
    const fs = m.r32(A.FogSeenMask), u8 = m.u8, b = m.base + fs, n2 = this.n * this.n;
    for (let i = 0; i < n2; i++) {
      const v = ~u8[b + i] & 0xff;
      if (v) for (let p = 0; p < 8; p++) if (v & (1 << p)) this.seen[p][i] = 1;
    }
  }
}

export class MapRenderer {
  // createCanvas(w, h) -> canvas-like; tileset: Tileset; sprites: optional sprites.js renderer
  constructor({ createCanvas, tileset, sprites = null, cycler = null }) {
    this.createCanvas = createCanvas; this.tileset = tileset; this.sprites = sprites;
    this.cycler = cycler;
    this.fogPlayer = -1;   // -1: everything visible
    this.showHp = false;
    this.tilesVersion = 0;
  }
  ownerColor(m, owner) {
    const idx = m.r8(A.PlayerColor + owner), c = this.tileset.rgb[idx];
    return c ? `rgb(${c[0]},${c[1]},${c[2]})` : OWNER_FALLBACK[owner & 7];
  }
  // The palette animation (shared with sprites.js). Created on first use from the arena's cycle records.
  palette(m) {
    if (!this.cycler) this.cycler = new PaletteCycler(this.tileset, m);
    if (this.sprites && this.sprites.setCycler && this.sprites.cycler !== this.cycler) this.sprites.setCycler(this.cycler);
    return this.cycler;
  }
  // Advance the palette animation by `ms` of game time (wall clock x playback speed; 0 while paused).
  advancePalette(ms, m) { return this.palette(m).advance(ms, m); }
  // Bring the terrain index map up to date with the arena; returns the number of cells redrawn.
  updateTerrain(m) {
    const n = m.r16(A.MapSize);
    if (!this.terrain || this.n !== n) {
      this.n = n;
      this.terrain = new Uint8Array(32 * n * 32 * n);
      this.lastTiles = new Uint16Array(n * n).fill(0xffff);
      this.minimap = this.createCanvas(n, n);
      this.fogCanvas = this.createCanvas(n, n);
      this.fogImg = null; this.miniImg = null; this.tblit = null;
    }
    const tp = m.base + m.r32(A.MapTiles), dv = m.dv, T = this.terrain, W = 32 * n;
    let changed = 0;
    for (let i = 0, nn = n * n; i < nn; i++) {
      const t = dv.getUint16(tp + 2 * i, true) & 0x7ff;
      if (t === this.lastTiles[i]) continue;
      this.lastTiles[i] = t; changed++;
      const ix = this.tileset.megatileIdx(t), o = 32 * ((i / n | 0) * W + i % n);
      for (let y = 0; y < 32; y++) {
        if (ix) T.set(ix.subarray(32 * y, 32 * y + 32), o + y * W);
        else T.fill(0, o + y * W, o + y * W + 32);
      }
    }
    if (changed) this.tilesVersion++;
    this.tilesChanged = changed;
    return changed;
  }
  // Colour the visible terrain through the current palette and draw it.
  _drawTerrain(ctx, W, H, vx, vy, s, m) {
    const mapPx = 32 * this.n, cy = this.palette(m);
    const x0 = Math.max(0, Math.floor(vx)), y0 = Math.max(0, Math.floor(vy));
    const x1 = Math.min(mapPx, Math.ceil(vx + W / s)), y1 = Math.min(mapPx, Math.ceil(vy + H / s));
    if (x1 <= x0 || y1 <= y0) return;
    const k = s >= 1 ? 1 : s;                                    // buffer pixels per map pixel
    const bw = Math.max(1, Math.min(x1 - x0, Math.ceil((x1 - x0) * k))), bh = Math.max(1, Math.min(y1 - y0, Math.ceil((y1 - y0) * k)));
    let b = this.tblit;
    if (!b || b.bw !== bw || b.bh !== bh) {
      if (!b || b.canvas.width < bw || b.canvas.height < bh) {
        const c = this.createCanvas(Math.max(bw, b ? b.canvas.width : 0), Math.max(bh, b ? b.canvas.height : 0));
        b = { canvas: c, ctx: c.getContext('2d') };
      }
      b = this.tblit = { canvas: b.canvas, ctx: b.ctx, bw, bh, img: b.ctx.createImageData(bw, bh), key: '' };
    }
    const key = `${x0},${y0},${x1},${y1},${k},${cy.version},${this.tilesVersion}`;
    if (b.key !== key) {
      b.key = key;
      const out = new Uint32Array(b.img.data.buffer, b.img.data.byteOffset, bw * bh), T = this.terrain, lut = cy.rgba;
      const xs = new Int32Array(bw);
      for (let i = 0; i < bw; i++) xs[i] = Math.min(x1 - 1, x0 + Math.floor(i / k));
      for (let j = 0, o = 0; j < bh; j++) {
        const row = Math.min(y1 - 1, y0 + Math.floor(j / k)) * mapPx;
        if (k === 1) { const base = row + x0; for (let i = 0; i < bw; i++) out[o++] = lut[T[base + i]]; }
        else for (let i = 0; i < bw; i++) out[o++] = lut[T[row + xs[i]]];
      }
      b.ctx.putImageData(b.img, 0, 0);
    }
    ctx.drawImage(b.canvas, 0, 0, bw, bh, (x0 - vx) * s, (y0 - vy) * s, (k === 1 ? bw : (x1 - x0)) * s, (k === 1 ? bh : (y1 - y0)) * s);
  }
  // Per-cell fog alpha for the selected player into this.fogCanvas (n x n, drawn scaled with smoothing).
  _updateFog(m, fogTracker) {
    const p = this.fogPlayer, n = this.n, ctx = this.fogCanvas.getContext('2d');
    if (!this.fogImg) this.fogImg = ctx.createImageData(n, n);
    const d = this.fogImg.data, u8 = m.u8;
    const seen = m.base + m.r32(A.FogSeenMask), expl = m.base + m.r32(A.FogExplored), vis = m.base + m.r32(A.FogVisible);
    const local = p === m.r8(A.LocalPlayer), bit = 1 << p, ever = fogTracker ? fogTracker.seen[p] : null;
    for (let i = 0; i < n * n; i++) {
      let a;
      if (local) {   // the game's own levels for the local player: 0 = clear .. 16 = fogged
        const e = u8[expl + i], v = u8[vis + i];
        a = Math.max(0.92 * Math.min(16, e) / 16, 0.45 * Math.min(16, v) / 16);
      } else {
        a = !(u8[seen + i] & bit) ? 0 : (ever && ever[i]) ? 0.45 : 0.92;
      }
      d[4 * i] = 0; d[4 * i + 1] = 0; d[4 * i + 2] = 0; d[4 * i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(this.fogImg, 0, 0);
  }
  // Is cell (tx,ty) visible / explored for the viewed player?
  _cellVis(m, tx, ty, fogTracker) {
    if (this.fogPlayer < 0) return 2;
    const n = this.n; if (tx < 0 || ty < 0 || tx >= n || ty >= n) return 0;
    const i = ty * n + tx;
    if (!(m.u8[m.base + m.r32(A.FogSeenMask) + i] & (1 << this.fogPlayer))) return 2;
    if (this.fogPlayer === m.r8(A.LocalPlayer)) return m.u8[m.base + m.r32(A.FogExplored) + i] < 16 ? 1 : 0;
    return fogTracker && fogTracker.seen[this.fogPlayer][i] ? 1 : 0;
  }

  // Draw the view. view = {x, y, scale} (top-left in map pixels), W/H in screen pixels.
  draw(ctx, W, H, view, m, fogTracker) {
    const { x: vx, y: vy, scale: s } = view;
    this.updateTerrain(m);
    this.palette(m).sync(m);   // pause gray
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const mapPx = 32 * this.n;
    this._drawTerrain(ctx, W, H, vx, vy, s, m);

    const units = readUnits(m);
    if (this.sprites && this.sprites.drawScene) {   // sprites.js: the game's own layer order and fog rules
      const opts = this.fogPlayer >= 0 ? { player: this.fogPlayer } : {};
      this.unitsDrawn = this.sprites.drawScene(ctx, -vx * s, -vy * s, s, opts);
      if (this.showHp) for (const u of units) {
        if (u.x + 32 * u.w < vx || u.y + 32 * u.h < vy || u.x > vx + W / s || u.y > vy + H / s) continue;
        if (this.fogPlayer >= 0 && u.owner !== this.fogPlayer && !this._unitVisible(m, u.addr)) continue;
        this._hp(ctx, u, (u.x - vx) * s, (u.y - vy) * s, s);
      }
      this._drawFog(ctx, m, fogTracker, vx, vy, s, mapPx);
      return { units: units.length, missiles: readMissiles(m).length };
    }
    // placeholder boxes: buildings, then ground, then air; each sorted by y
    const layer = u => (u.tflags & 0x20) ? 0 : (u.tflags & 2) ? 2 : 1;
    units.sort((a, b) => layer(a) - layer(b) || a.y - b.y);
    let drawn = 0;
    for (const u of units) {
      const pw = 32 * u.w, ph = 32 * u.h;
      if (u.x + pw < vx || u.y + ph < vy || u.x > vx + W / s || u.y > vy + H / s) continue;
      if (this.fogPlayer >= 0 && u.owner !== this.fogPlayer) {
        const v = this._cellVis(m, u.tx, u.ty, fogTracker);
        if (v === 0 || (v === 1 && !(u.tflags & 0x20))) continue;
      }
      const sx = (u.x - vx) * s, sy = (u.y - vy) * s;
      drawn++;
      if (this.sprites && this.sprites.drawUnit(ctx, u.addr, -vx * s, -vy * s, s) !== false) { this._hp(ctx, u, sx, sy, s); continue; }
      const col = u.owner === 15 ? '#b0a070' : this.ownerColor(m, u.owner);
      ctx.globalAlpha = (u.flags & UF_BUILT_MASK) ? 0.85 : 0.5;   // unfinished buildings fainter
      ctx.fillStyle = col;
      ctx.fillRect(sx + 2 * s, sy + 2 * s, pw * s - 4 * s, ph * s - 4 * s);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, Math.round(s));
      ctx.strokeRect(sx + 2 * s, sy + 2 * s, pw * s - 4 * s, ph * s - 4 * s);
      this._hp(ctx, u, sx, sy, s);
    }
    this.unitsDrawn = drawn;

    const missiles = readMissiles(m);
    for (const p of missiles) {
      if (p.x < vx - 32 || p.y < vy - 32 || p.x > vx + W / s + 32 || p.y > vy + H / s + 32) continue;
      if (this.fogPlayer >= 0 && this._cellVis(m, p.x >> 5, p.y >> 5, fogTracker) < 2) continue;
      const sx = (p.x - vx) * s, sy = (p.y - vy) * s;
      if (this.sprites && this.sprites.drawMissile(ctx, p.addr, -vx * s, -vy * s, s) !== false) continue;
      ctx.fillStyle = '#ffe040'; ctx.beginPath(); ctx.arc(sx + 16 * s, sy + 16 * s, Math.max(2, 3 * s), 0, 2 * Math.PI); ctx.fill();
    }

    this._drawFog(ctx, m, fogTracker, vx, vy, s, mapPx);
    return { units: units.length, missiles: missiles.length };
  }
  // Unit visible to the viewed player as the game draws it (Gfx_DrawUnit 0x454a90): not fog-hidden (+0x28) and in
  // the visible mask (+0x29: also clears for invisible units the player cannot detect).
  _unitVisible(m, addr) {
    if (this.fogPlayer < 0) return true;
    const bit = 1 << this.fogPlayer;
    return !(m.r8(addr + 0x28) & bit) && !!(m.r8(addr + 0x29) & bit);
  }
  // Selection rectangles of player p's selection `sel` (unit addrs), as Gfx_DrawSpriteClipped_2 0x454610 draws
  // them: a 1-pixel outline of (boxW + 1) x (boxH + 1) around the type's selection box centred on the footprint,
  // colour g_PlayerMinimapColor[owner] from Ui_BuildPlayerColorTable 0x453660 with p as the local player:
  // 0xfa own, 0xfb allied (g_Alliance[p][owner]), 0xf9 otherwise. Only drawn when the unit itself is drawn.
  drawSelection(ctx, view, m, p, sel, W, H) {
    const { x: vx, y: vy, scale: s } = view, fp = this.fogPlayer;
    if (p >= 0) this.fogPlayer = p;
    for (const u of sel) {
      const f = m.r16(u + 0x1e);
      if (f & 0xd) continue;
      if (p >= 0 && !this._unitVisible(m, u)) continue;
      const t = m.r8(u + 0x27), owner = m.r8(u + 0x2c);
      const bw = m.r16(A.TypeBox + 4 * t), bh = m.r16(A.TypeBox + 4 * t + 2);
      const ox = 16 * m.r16(A.TypeSize + 4 * t), oy = 16 * m.r16(A.TypeSize + 4 * t + 2);
      const x0 = m.s16(u) + ox - Math.trunc(((bw << 16) >> 16) / 2) - 1, y0 = m.s16(u + 2) + oy - Math.trunc(((bh << 16) >> 16) / 2) - 1;
      const idx = p < 0 ? 0xfa : owner === p ? 0xfa : m.r8(0x4abd54 + 16 * p + owner) ? 0xfb : 0xf9;
      const c = this.tileset.rgb[idx] || [0, 255, 0];
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      const X = (x0 - vx) * s, Y = (y0 - vy) * s, w = (bw + 1) * s, h = (bh + 1) * s, l = Math.max(1, Math.round(s));
      if (X > W || Y > H || X + w < 0 || Y + h < 0) continue;
      ctx.fillRect(X, Y, w, l); ctx.fillRect(X, Y + h - l, w, l); ctx.fillRect(X, Y, l, h); ctx.fillRect(X + w - l, Y, l, h);
    }
    this.fogPlayer = fp;
  }
  _drawFog(ctx, m, fogTracker, vx, vy, s, mapPx) {
    if (this.fogPlayer < 0) return;
    this._updateFog(m, fogTracker);
    ctx.imageSmoothingEnabled = true;
    const n = this.n;
    ctx.drawImage(this.fogCanvas, 0, 0, n, n, -vx * s, -vy * s, mapPx * s, mapPx * s);
    ctx.imageSmoothingEnabled = false;
  }
  _hp(ctx, u, sx, sy, s) {
    if (!this.showHp || u.owner === 15 || !u.maxHp) return;
    const w = 32 * u.w * s - 4 * s, f = Math.max(0, Math.min(1, u.hp / u.maxHp));
    const y = sy + 32 * u.h * s - 5 * s;
    ctx.fillStyle = '#000'; ctx.fillRect(sx + 2 * s, y, w, Math.max(2, 3 * s));
    ctx.fillStyle = f > 0.5 ? '#20d020' : f > 0.25 ? '#e0d020' : '#e02020';
    ctx.fillRect(sx + 2 * s, y, w * f, Math.max(2, 3 * s));
  }

  // Minimap into its own n x n canvas: terrain average colours, units, fog. Returns the canvas.
  drawMinimap(m, fogTracker) {
    this.updateTerrain(m);
    const n = this.n, ctx = this.minimap.getContext('2d');
    if (!this.miniImg) this.miniImg = ctx.createImageData(n, n);
    const px = new Uint32Array(this.miniImg.data.buffer);
    for (let i = 0; i < n * n; i++) px[i] = this.tileset.megatileColor(this.lastTiles[i]);
    for (const u of readUnits(m)) {
      if (this.fogPlayer >= 0 && u.owner !== this.fogPlayer && this._cellVis(m, u.tx, u.ty, fogTracker) < (u.tflags & 0x20 ? 1 : 2)) continue;
      const idx = m.r8(A.PlayerColor + u.owner), c = u.owner === 15 ? 0xff70a0b0 : this.tileset.palette[idx];
      for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) { const tx = u.tx + x, ty = u.ty + y; if (tx < n && ty < n) px[ty * n + tx] = c; }
    }
    if (this.fogPlayer >= 0) {
      for (let i = 0; i < n * n; i++) {
      const v = this._cellVis(m, i % n, (i / n) | 0, fogTracker);
        if (v === 2) continue;
        const k = v === 1 ? 0.55 : 0.12, p = px[i];
        px[i] = (0xff000000 | (Math.round(((p >> 16) & 0xff) * k) << 16) | (Math.round(((p >> 8) & 0xff) * k) << 8) | Math.round((p & 0xff) * k)) >>> 0;
      }
    }
    ctx.putImageData(this.miniImg, 0, 0);
    return this.minimap;
  }
}
const UF_BUILT_MASK = 0x80;
