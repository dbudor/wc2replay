// Unit / building / missile / corpse sprites, drawn the way Warcraft II BNE 2.02 draws them.
// Read-only on the sim arena. Format and formulas: SPRITES.md (same directory).
//
//   createSpriteRenderer({ getFile, mem, tileset, palette, createImage? })
//     getFile(name)  -> Uint8Array | null   (game names, backslashes, e.g. "Art\\Unit\\Human\\peon.grp")
//     mem()          -> Uint8Array arena view, index = original x86 address
//     tileset        0..3 = g_Tileset (forest, winter, wasteland, swamp); null -> read g_Tileset from the arena
//     palette        Uint8Array 768 (raw .ppl, 6-bit) or 1024 (RGBX); 6-bit values are shifted <<2 like File_LoadPalette
//     createImage(rgba, w, h) -> drawable for ctx.drawImage (default: a canvas / OffscreenCanvas)
//     updateImage(img, rgba, w, h) -> optional: repaint a drawable made by createImage (default canvas: putImageData;
//                    without it a recoloured frame gets a fresh createImage)
//   returns { drawUnit, drawBuildingFire, drawMissile, unitLayer, drawScene, drawList, setCycler, ... }
//   setCycler(c): tileset.js PaletteCycler; frames are kept as palette indices and re-coloured lazily (when drawn)
//                 if one of the entries they use changed (water/f0..f4 cycles, pause gray).
//
// Screen mapping used by every draw call: screenX = sx + mapPixelX * scale, screenY = sy + mapPixelY * scale.

// ---- static tables (exe .data; the renderer reads them from the arena, these are only fallbacks) ----
const A = {
  units: 0x4aec44, unitCap: 0x4ae220, missiles: 0x4aec48, missileCap: 0x4ae218,
  sortedByY: 0x4bf188, ghostUnits: 0x4be278, nGhost: 0x19,
  tileset: 0x4acc10,
  typeFlags: 0x4cf524, typeSize: 0x4cee1c,
  facingToFrame: 0x4a4874, playerColorIdx: 0x4a48bc, fireYByHeight: 0x4a486c,
  gfxBase: 0x4cf26c,        // g_UdtaObsolete1: u16[127] gfx resource ids, all tilesets
  gfxTilesetTables: 0x49b914, // 4 ptrs -> u16[127] per-tileset overrides (0xffff = keep base)
  missileGfxNames: 0x49b924,  // 29 ptrs -> "Art\\Unit\\Other\\*.grp"
  shadowName: 0x49d7ec,
  typeBox: 0x4cf36c,         // u16 w, h per type (selection box)
  charmX: 0x4a48e0,          // s32[5]: x offset of each spell icon
};
// Default UDTA gfx tables (g_UdtaObsolete1 0x4cf26c and the 4 tileset overrides its pointers name), as the
// default unit data loads them.  A PUD with its own UDTA skips them (Data_LoadUnitTables / FUN_004206d0) and the
// game keeps the copy it loaded at startup; the sim boots straight into the replay, so there they stay all zero.
const DEFAULT_GFX_TABLES = {
  0x4cf26c: [1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1058,33819,33820,1033,1034,33815,33816,33821,33822,33821,33826,1035,33820,33823,33814,1059,1060,1039,1040,1061,1062,1041,1042,65535,1036,65535,65535,65535,65535,1038,1063,33803,33804,33819,1037,33813,1046,65535,33820,33819,33826,33819,33822,65535,1069,1070,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1164,1165,65535,65535,65535,65535,65535,65535,65535,65535,65535,1120,65535,65535,65535,65535,1122,1123,1124,1125,1126,1127,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535],
  0x4cecac: [65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1043,1044,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1064,1092,1093,1094,1095,1096,1097,1098,1099,1104,1105,1090,1091,1088,1089,1108,1109,1100,1101,1102,1103,1110,1111,1084,1085,1106,1107,1112,1113,1114,1115,1086,1087,1116,1117,1119,1118,65535,65535,1080,1081,1082,1083,1166,1167,1181,1168,1168,65535,1188,1121,33889,33889,65535,65535,65535,65535,65535,65535,1252,1253,1254,1255,1256,1257,1258,1259,1260,1261,1261],
  0x4ce7ec: [65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1043,1044,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1066,1134,1135,1136,1137,1138,1139,1140,1141,1146,1147,1132,1133,1130,1131,1150,1151,1142,1143,1144,1145,1152,1153,1160,1161,1148,1149,1154,1155,1156,1157,1128,1129,1158,1159,1162,1118,65535,65535,1169,1170,1171,1172,1166,1184,1186,1273,1273,65535,1189,1163,33931,33931,65535,65535,65535,65535,65535,65535,1262,1263,1264,1265,1266,1267,1268,1269,1270,1275,1275],
  0x4cfac4: [65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1182,1183,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1065,1173,1174,1094,1095,1096,1097,1098,1099,1104,1105,1090,1091,1088,1089,1108,1109,1100,1101,1175,1176,1110,1111,1084,1085,1106,1107,1112,1113,1177,1178,1086,1087,1116,1117,1179,1180,65535,65535,1080,1081,1082,1083,1166,1185,1181,1274,1274,65535,1190,1191,33959,33959,65535,65535,65535,65535,65535,65535,1252,1253,1254,1271,1272,1257,1258,1259,1260,1276,1276],
  0x4cfc34: [65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1526,1527,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,65535,1470,1479,1480,1481,1482,1483,1484,1485,1486,1491,1492,1477,1478,1475,1476,1495,1496,1487,1488,1489,1490,1497,1498,1505,1506,1493,1494,1499,1500,1501,1502,1473,1474,1503,1504,1511,1515,65535,65535,1507,1508,1509,1510,1525,1513,1514,1274,1274,65535,1524,1512,34280,34280,65535,65535,65535,65535,65535,65535,1252,1516,1517,1518,1519,1520,1521,1522,1523,1276,1276],
};
const CHARMS = 'Art\\unit\\other\\charms.grp';
export const FACING_TO_FRAME = [0, 1, 2, 3, 4, 3, 2, 1];
export const PLAYER_COLOR_IDX = [0xd0, 0xd4, 0xd8, 0xdc, 0xe0, 0xe4, 0xe8, 0x0c, 0xd0, 0xd0, 0xd0, 0xd0, 0xd0, 0xd0, 0xd0, 0x0c];
const FIRE_Y_BY_HEIGHT = [0, 0, -24, -20, -26, 0, 0, 0];
const UTF_BUILDING = 0x20;
export const N_GFX = 127, N_MISSILE_GFX = 29;

// ---- GRP format ----
// u16 count, u16 boxW, u16 boxH; count x { u8 x, u8 y, u8 w, u8 h, u32 dataOffset }.
// Frame data: u16 rowOffset[h] (relative to dataOffset), then per row a byte stream until w pixels:
//   b & 0x80: skip (b & 0x7f) transparent; b & 0x40: run of (b & 0x3f) x next byte; else: b literal bytes.
export function parseGrp(bytes) {
  if (!bytes || bytes.length < 6) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(0, true), w = dv.getUint16(2, true), h = dv.getUint16(4, true);
  const frames = [];
  for (let i = 0; i < count && 6 + 8 * i + 8 <= bytes.length; i++) {
    const o = 6 + 8 * i;
    frames.push({ x: bytes[o], y: bytes[o + 1], w: bytes[o + 2], h: bytes[o + 3], off: dv.getUint32(o + 4, true) });
  }
  return { bytes, count, w, h, frames };
}

// Uncompressed frame (Gfx_BlitBitmap: charms.grp): w*h bytes at off, index 0 transparent.
export function decodeRawFrame(grp, i) {
  const f = grp.frames[i], b = grp.bytes, idx = new Uint8Array(f.w * f.h), mask = new Uint8Array(f.w * f.h);
  for (let k = 0; k < idx.length && f.off + k < b.length; k++) { idx[k] = b[f.off + k]; mask[k] = idx[k] ? 1 : 0; }
  return { w: f.w, h: f.h, idx, mask };
}
// Frame -> palette indices (Uint8Array w*h) + opacity (Uint8Array w*h, 1 = drawn). Unflipped, unremapped.
export function decodeFrameIndices(grp, i) {
  const f = grp.frames[i], b = grp.bytes;
  const idx = new Uint8Array(f.w * f.h), mask = new Uint8Array(f.w * f.h);
  for (let y = 0; y < f.h; y++) {
    let p = f.off + (b[f.off + 2 * y] | (b[f.off + 2 * y + 1] << 8)), x = 0, o = y * f.w;
    while (x < f.w && p < b.length) {
      const c = b[p++];
      if (c & 0x80) x += c & 0x7f;
      else if (c & 0x40) { const n = c & 0x3f, v = b[p++]; for (let k = 0; k < n && x < f.w; k++, x++) { idx[o + x] = v; mask[o + x] = 1; } }
      else { for (let k = 0; k < c; k++, x++) { const v = b[p++]; if (x < f.w) { idx[o + x] = v; mask[o + x] = 1; } } }
    }
  }
  return { w: f.w, h: f.h, idx, mask };
}

// g_Gfx_ColorRemap (identity table at 0x4944c0) with entries 0xd0..0xd3 replaced by the owner's 4 colours
// (Gfx_SetPlayerColorBase 0x4536b0: base = g_Gfx_PlayerColorIdx[owner], entries base..base+3).
export function playerRemap(colorBase) {
  const r = new Uint8Array(256); for (let i = 0; i < 256; i++) r[i] = i;
  if (colorBase != null) for (let k = 0; k < 4; k++) r[0xd0 + k] = (colorBase + k) & 0xff;
  return r;
}

// palette: 768 or 1024 bytes -> Uint8Array 256*3 8-bit RGB. 6-bit data (max <= 63) is shifted <<2.
export function normalizePalette(pal) {
  const st = pal.length >= 1024 ? 4 : 3, out = new Uint8Array(768);
  let mx = 0; for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) mx = Math.max(mx, pal[st * i + c] | 0);
  const sh = mx <= 63 ? 2 : 0;
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) out[3 * i + c] = ((pal[st * i + c] | 0) << sh) & 0xff;
  return out;
}

// Pure: decode frame i of a GRP to RGBA (Uint8ClampedArray w*h*4). flip mirrors horizontally like
// Gfx_DrawSpriteFlipped 0x402120. remap: 256-byte table (playerRemap). palette: normalizePalette() output.
export function frameToRGBA(grp, i, { flip = false, remap = null, palette }) {
  const { w, h, idx, mask } = decodeFrameIndices(grp, i);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * w + x; if (!mask[s]) continue;
    const v = remap ? remap[idx[s]] : idx[s], d = 4 * (y * w + (flip ? w - 1 - x : x));
    out[d] = palette[3 * v]; out[d + 1] = palette[3 * v + 1]; out[d + 2] = palette[3 * v + 2]; out[d + 3] = 255;
  }
  return { w, h, rgba: out };
}

// Gfx_DrawSpriteFrame 0x454310 placement of frame f of grp for an object at map pixel (px, py) with the
// draw offsets: xOffs/yOffs2 = g_UT_MissileOffset[type] (footprint centre, units/buildings) or 0 (missiles),
// yOffs = g_Gfx_DrawYOffs (flyer bob / shadow). Returns the frame's top-left map pixel.
export function framePos(grp, f, px, py, flip, xOffs = 0, yOffs2 = 0, yOffs = 0) {
  const hw = Math.trunc((grp.w << 16 >> 16) / 2), hh = Math.trunc((grp.h << 16 >> 16) / 2);
  const x = flip ? (px + xOffs) + hw - f.w - f.x : (px + xOffs) + f.x - hw;
  const y = py - yOffs - hh + yOffs2 + f.y;
  return { x, y };
}

function defaultCreateImage(rgba, w, h) {
  let c;
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
  else { c = document.createElement('canvas'); c.width = w; c.height = h; }
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return c;
}
function defaultUpdateImage(c, rgba, w, h) { c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); return c; }

export function createSpriteRenderer({ getFile, mem, tileset = null, palette, createImage = defaultCreateImage, updateImage = null }) {
  if (!updateImage && createImage === defaultCreateImage) updateImage = defaultUpdateImage;
  const pal = normalizePalette(palette);
  // static palette when no cycler is attached (same shape as tileset.js PaletteCycler)
  const staticLut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) staticLut[i] = (0xff000000 | (pal[3 * i + 2] << 16) | (pal[3 * i + 1] << 8) | pal[3 * i]) >>> 0;
  let cyc = { rgba: staticLut, version: 0, allAt: 0, changedAt: new Uint32Array(256), cyclable: new Uint8Array(256) };
  const grpCache = new Map();   // name -> grp | null
  const imgCache = new Map();   // name|frame|flip|colour -> { img, w, h } | null
  const nameCache = new Map();  // 'u'+id / 'm'+id -> name | null
  let cachedTileset = -1;

  let snap = null;                // arena view pinned for the duration of drawScene (mem() may allocate a view)
  const m = () => snap || mem();
  const r8 = a => m()[a];
  const r16 = a => { const b = m(); return b[a] | (b[a + 1] << 8); };
  const s16 = a => (r16(a) << 16) >> 16;
  const r32 = a => { const b = m(); return (b[a] | (b[a + 1] << 8) | (b[a + 2] << 16) | (b[a + 3] << 24)) >>> 0; };
  const cstr = a => { const b = m(); let s = ''; if (!a) return null; for (let i = 0; i < 260 && b[a + i]; i++) s += String.fromCharCode(b[a + i]); return s || null; };
  const curTileset = () => (tileset ?? r16(A.tileset)) & 3;

  // Snd_GetWavName 0x423f40: resource id -> file name pointer (tables in .data)
  function resName(id) {
    let p = 0;
    if (id > 0x408 && id < 0x4a8) p = 0x49a974 + 4 * id;
    else if (id > 0x4e3 && id < 0x4fd) p = 0x49a884 + 4 * id;
    else if (id > 0x5bd && id < 0x5f8) p = 0x49a580 + 4 * id;
    return p ? cstr(r32(p)) : null;
  }
  // Group_LoadUnitGfx 0x423ba0: g_UnitGfx[i] from the base table, then overridden by the tileset table.
  // 0x8000 = alias: same file as the nearest earlier entry of the same table with equal (id & 0x7fff).
  const tabZero = new Map();   // table address -> all zero in the arena (custom UDTA: use DEFAULT_GFX_TABLES)
  function tabEntry(tab, i) {
    let z = tabZero.get(tab);
    if (z === undefined) { z = !!DEFAULT_GFX_TABLES[tab]; for (let j = 0; z && j < 127; j++) if (r16(tab + 2 * j)) z = false; tabZero.set(tab, z); }
    return z ? DEFAULT_GFX_TABLES[tab][i] ?? 0xffff : r16(tab + 2 * i);
  }
  function tableName(tab, i, depth = 0) {
    const e = tabEntry(tab, i);
    if (e === 0xffff) return undefined;           // not in this table
    if (!(e & 0x8000)) return resName(e);
    for (let j = i - 1; j >= 0; j--) if ((tabEntry(tab, j) & 0x7fff) === (e & 0x7fff)) return depth < 8 ? (tableName(tab, j, depth + 1) ?? null) : null;
    return null;
  }
  function unitGfxName(id) {
    const ts = curTileset();
    if (ts !== cachedTileset) { nameCache.clear(); tabZero.clear(); cachedTileset = ts; }
    const k = 'u' + id; if (nameCache.has(k)) return nameCache.get(k);
    let n = null;
    if (id < N_GFX) {
      const t = tableName(r32(A.gfxTilesetTables + 4 * ts), id);
      n = t !== undefined ? t : (tableName(A.gfxBase, id) ?? null);
    }
    nameCache.set(k, n); return n;
  }
  function missileGfxName(t) {
    const k = 'm' + t; if (nameCache.has(k)) return nameCache.get(k);
    const n = t < N_MISSILE_GFX ? cstr(r32(A.missileGfxNames + 4 * t)) : null;
    nameCache.set(k, n); return n;
  }
  function grp(name) {
    if (!name) return null;
    if (grpCache.has(name)) return grpCache.get(name);
    const g = parseGrp(getFile(name)); grpCache.set(name, g); return g;
  }
  // frame -> { img, w, h, idx (remapped, flipped; 0 where transparent), mask, cyc (cyclable entries used), ver }
  function paint(e) {
    const rgba = new Uint8ClampedArray(e.w * e.h * 4), px = new Uint32Array(rgba.buffer), lut = cyc.rgba;
    for (let i = 0; i < px.length; i++) if (e.mask[i]) px[i] = lut[e.idx[i]];
    e.img = e.img && updateImage ? updateImage(e.img, rgba, e.w, e.h) || e.img : createImage(rgba, e.w, e.h);
    e.ver = cyc.version;
  }
  function image(name, g, fi, flip, colorBase) {
    const k = `${name}|${fi}|${flip ? 1 : 0}|${colorBase ?? -1}`;
    let e = imgCache.get(k);
    if (e === undefined) {
      const d = g.raw ? decodeRawFrame(g, fi) : decodeFrameIndices(g, fi), { w, h } = d;
      e = null;
      if (w && h) {
        const remap = playerRemap(colorBase), idx = new Uint8Array(w * h), mask = new Uint8Array(w * h), used = new Uint8Array(256);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const s = y * w + x; if (!d.mask[s]) continue;
          const o = y * w + (flip ? w - 1 - x : x), v = remap[d.idx[s]];
          idx[o] = v; mask[o] = 1; used[v] = 1;
        }
        const cl = []; for (let v = 0; v < 256; v++) if (used[v] && cyc.cyclable[v]) cl.push(v);
        e = { img: null, w, h, idx, mask, used, cyc: Uint8Array.from(cl), ver: -1 };
        paint(e);
      }
      imgCache.set(k, e);
    } else if (e && e.ver !== cyc.version) {
      let stale = e.ver < cyc.allAt;
      for (let i = 0; !stale && i < e.cyc.length; i++) stale = cyc.changedAt[e.cyc[i]] > e.ver;
      if (stale) paint(e); else e.ver = cyc.version;
    }
    return e;
  }
  function setCycler(c) {
    cyc = c;
    for (const e of imgCache.values()) if (e) {   // cyclable set may differ: recompute, force a repaint
      const cl = []; for (let v = 0; v < 256; v++) if (e.used[v] && c.cyclable[v]) cl.push(v);
      e.cyc = Uint8Array.from(cl); e.ver = -1;
    }
  }
  const colorOf = owner => { const v = r8(A.playerColorIdx + (owner & 15)); return v || PLAYER_COLOR_IDX[owner & 15]; };
  const typeFlags = t => r32(A.typeFlags + 4 * t);
  // g_UT_MissileOffset[type] = g_UnitTypeSize[type] << 4 (Game_InitOrLoadUnits 0x450f20): footprint centre
  const centre = t => [(r16(A.typeSize + 4 * t) << 4) << 16 >> 16, (r16(A.typeSize + 4 * t + 2) << 4) << 16 >> 16];

  // one Gfx_DrawSpriteFrame call; obj = address with pixelX/Y at +0/+2 and facing at +0xa
  function blit(ctx, name, fi, obj, sx, sy, scale, xOffs, yOffs2, yOffs, colorBase) {
    const g = grp(name); if (!g || fi >= g.count) return false;
    const f = g.frames[fi]; if (!f.w || !f.h) return false;
    const flip = r8(obj + 0xa) >= 5;           // dispatch table 0x4a487c: facings 5..7 -> flipped blitter
    const { x, y } = framePos(g, f, s16(obj), s16(obj + 2), flip, xOffs, yOffs2, yOffs);
    const e = image(name, g, fi, flip, colorBase); if (!e) return false;
    ctx.drawImage(e.img, sx + x * scale, sy + y * scale, e.w * scale, e.h * scale);
    return true;
  }

  // Draw order layer: 0 = buildings (drawn into the map buffer, under everything), 1 = land/naval units +
  // building fires, 2 = flyers (moveClass 1, second pass of Gfx_DrawUnit 0x454a90), 3 = missiles. -1 = not drawn.
  function unitLayer(u) {
    if (r16(u + 0x1e) & 0xd) return -1;        // free / ? / contained (in mine, transport, depot)
    if (typeFlags(r8(u + 0x27)) & UTF_BUILDING) return 0;
    return r8(u + 0x2a) === 1 ? 2 : 1;
  }

  // vis(u): optional local-player visibility, as the game: fogHiddenMask +0x28 and visibleMask +0x29
  function visibleTo(u, player) {
    if (player == null) return true;
    if (r8(u + 0x28) & (1 << player)) return false;
    return (r8(u + 0x29) & (1 << player)) !== 0;
  }

  // Units and buildings. Buildings: Gfx_InvalidateBuilding 0x4553f0 (frame = animFrame, no facing term).
  // Others: Gfx_DrawUnit 0x454a90 (frame = FacingToFrame[facing] + animFrame, flyer shadow first).
  function drawUnit(ctx, u, sx, sy, scale = 1, opts = {}) {
    const fl = r16(u + 0x1e); if (fl & 0xd) return false;
    const t = r8(u + 0x27), [cx, cy] = centre(t), cb = colorOf(r8(u + 0x2d));   // colour: +0x2d (origOwner)
    if (typeFlags(t) & UTF_BUILDING) {
      let fi = r8(u + 9), sp = r8(u + 0x2b);
      if (opts.player != null && (r8(u + 0x28) & (1 << opts.player))) {   // under fog: remembered frame
        fi = r8(u + 0x86); sp = r8(u + 0x87); if (fi === 0xff) return false;
      }
      return blit(ctx, unitGfxName(sp), fi, u, sx, sy, scale, cx, cy, 0, cb);
    }
    if (opts.player != null && !visibleTo(u, opts.player)) return false;
    const bob = r8(u + 0xc);                    // fidgetToggle
    if (r16(u + 0x1c) & 4)                      // flags2 & 4 (air): shadow.grp frame 2, 42 px below
      blit(ctx, cstr(A.shadowName) || 'Art\\unit\\other\\shadow.grp', 2, u, sx, sy, scale, cx, cy, -0x2a - bob, null);
    const fi = (FACING_TO_FRAME[r8(u + 0xa) & 7] + r8(u + 9)) & 0xff;
    const drawn = blit(ctx, unitGfxName(r8(u + 0x2b)), fi, u, sx, sy, scale, cx, cy, bob, cb);
    if (drawn) drawSpellIcons(ctx, u, sx, sy, scale);
    return drawn;
  }

  // Gfx_DrawUnitSpellIcons 0x454900 / Gfx_DrawEffectIcon 0x4549d0: charms.grp frames at the unit box's top-left
  // (+ s32 table 0x4a48e0[frame] in x): 0 bloodlust (+0x48), 1 haste / 2 slow (+0x4a s16 > 0 / < 0), 3 invisible
  // (+0x44), 4 unholy armour (+0x46). Only when flags & 0xf == 0; no player colour.
  const CHARM_X = [0, 16, 16, 32, 48];
  function drawSpellIcons(ctx, u, sx, sy, scale) {
    if (r16(u + 0x1e) & 0xf) return;
    const haste = s16(u + 0x4a), on = [[r16(u + 0x48), 0], [haste, haste < 0 ? 2 : 1], [r16(u + 0x44), 3], [r16(u + 0x46), 4]];
    if (!on.some(([v]) => v)) return;
    const g = grp(CHARMS); if (!g) return;
    g.raw = true;
    const t = r8(u + 0x27), [cx, cy] = centre(t);
    const x0 = s16(u) + cx - Math.trunc((r16(A.typeBox + 4 * t) << 16 >> 16) / 2) - 1;
    const y0 = s16(u + 2) + cy - Math.trunc((r16(A.typeBox + 4 * t + 2) << 16 >> 16) / 2) - 1;
    for (const [v, fi] of on) {
      if (!v || fi >= g.count) continue;
      const f = g.frames[fi], e = image(CHARMS, g, fi, false, null); if (!e) continue;
      const dx = (r32(A.charmX + 4 * fi) | 0) || CHARM_X[fi];
      ctx.drawImage(e.img, sx + (x0 + dx + f.x) * scale, sy + (y0 + f.y) * scale, e.w * scale, e.h * scale);
    }
  }

  // Burning building: missile slot 0 (small fire, mod 6 frames) or 1 (big fire, mod 10), placed per building.
  // Gfx_DrawUnit: x = pixelX + centreX, y = pixelY + centreY + s8 table 0x4a486c[height in tiles];
  // frame = (u8 +0x80 + FacingToFrame[m.facing] + m.animFrame) % mod. Layer 1, right after the building's Y slot.
  function drawBuildingFire(ctx, u, sx, sy, scale = 1, opts = {}) {
    const t = r8(u + 0x27); if (!(typeFlags(t) & UTF_BUILDING) || (r16(u + 0x1e) & 0xd)) return false;
    if (opts.player != null && !visibleTo(u, opts.player)) return false;
    const mp = r32(u + 0x7c); if (!mp) return false;
    const [cx, cy] = centre(t), h = r16(A.typeSize + 4 * t + 2);
    const fy = ((r8(A.fireYByHeight + (h & 0xffff)) << 24) >> 24) || FIRE_Y_BY_HEIGHT[h] || 0;
    const mod = mp === r32(A.missiles) ? 6 : 10;
    const fi = ((r8(u + 0x80) + FACING_TO_FRAME[r8(mp + 0xa) & 7] + r8(mp + 9)) & 0xff) % mod;
    // the game writes the position into the shared missile; we compute it and keep the arena untouched
    const g = grp(missileGfxName(r8(mp + 0x34))); if (!g || fi >= g.count) return false;
    const f = g.frames[fi], flip = r8(mp + 0xa) >= 5;
    const px = (s16(u) + cx) << 16 >> 16, py = (s16(u + 2) + cy + fy) << 16 >> 16;
    const { x, y } = framePos(g, f, px, py, flip);
    const e = image(missileGfxName(r8(mp + 0x34)), g, fi, flip, opts.missileColor ?? null); if (!e) return false;
    ctx.drawImage(e.img, sx + x * scale, sy + y * scale, e.w * scale, e.h * scale);
    return true;
  }

  // Missiles (slots >= 3; 0/1 are the shared fire overlays, 2 the local green-cross marker):
  // Gfx_DrawUnitSprite 0x454d40: grp = g_Group_MissileGfx[+0x34 type], frame = FacingToFrame[facing] + animFrame,
  // pixel x/y is the sprite centre (no type offset). The game sets no player colour here (stale remap).
  function drawMissile(ctx, mp, sx, sy, scale = 1, opts = {}) {
    if (r8(mp + 0x35) & 3) return false;
    const fi = (FACING_TO_FRAME[r8(mp + 0xa) & 7] + r8(mp + 9)) & 0xff;
    return blit(ctx, missileGfxName(r8(mp + 0x34)), fi, mp, sx, sy, scale, 0, 0, 0, opts.missileColor ?? null);
  }

  // Gfx_SortDrawListByY 0x453ae0 on a copy of g_UnitsSortedByY (insertion sort, key pixelY, 0x8000 if flags&7)
  function sortedUnits() {
    const L = [];
    for (let i = 0; i < 1601; i++) { const p = r32(A.sortedByY + 4 * i); if (!p) break; L.push(p); }
    if (!L.length) { const U = r32(A.units), N = r32(A.unitCap); for (let i = 0; i < N; i++) if (!(r16(U + 0x98 * i + 0x1e) & 1)) L.push(U + 0x98 * i); }
    const key = u => (r16(u + 0x1e) & 7) ? -0x8000 : s16(u + 2);   // (short)0x8000 = most negative
    for (let i = 1; i < L.length; i++) { const v = L[i], k = key(v); let j = i - 1; while (j >= 0 && key(L[j]) > k) { L[j + 1] = L[j]; j--; } L[j + 1] = v; }
    return L;
  }

  // The complete frame in the game's order: [{kind:'building'|'unit'|'fire'|'missile'|'ghost', addr}]
  function drawList(opts = {}) {
    const out = [], L = sortedUnits();
    if (opts.player != null) for (let i = 0; i < A.nGhost; i++) { const g = A.ghostUnits + 0x98 * i; if (r16(g + 4)) out.push({ kind: 'ghost', addr: g }); }
    for (const u of L) if (unitLayer(u) === 0) out.push({ kind: 'building', addr: u });
    for (const pass of [1, 2]) for (const u of L) {
      const l = unitLayer(u);
      if (pass === 1 && l === 0 && r32(u + 0x7c)) out.push({ kind: 'fire', addr: u });
      else if (l === pass) out.push({ kind: 'unit', addr: u });
    }
    const M = r32(A.missiles), MN = r32(A.missileCap);
    for (let i = 3; i < MN; i++) { const mp = M + 0x40 * i; if (!(r8(mp + 0x35) & 3)) out.push({ kind: 'missile', addr: mp }); }
    return out;
  }
  function drawScene(ctx, sx, sy, scale = 1, opts = {}) {
    let n = 0; snap = mem();
    try {
    for (const { kind, addr } of drawList(opts)) {
      if (kind === 'ghost') {   // Gfx_InvalidateBuilding(ghost, 1): drawn only if the slot is fogged for the player
        if (r8(addr + 0x28) & (1 << opts.player)) { const fi = r8(addr + 0x86); if (fi !== 0xff) { const t = r8(addr + 0x27), [cx, cy] = centre(t); n += blit(ctx, unitGfxName(r8(addr + 0x87)), fi, addr, sx, sy, scale, cx, cy, 0, colorOf(r8(addr + 0x2d))); } }
      } else if (kind === 'fire') n += drawBuildingFire(ctx, addr, sx, sy, scale, opts);
      else if (kind === 'missile') n += drawMissile(ctx, addr, sx, sy, scale, opts);
      else n += drawUnit(ctx, addr, sx, sy, scale, opts);
    }
    } finally { snap = null; }
    return n;
  }

  return {
    drawUnit, drawBuildingFire, drawMissile, unitLayer, drawScene, drawList, sortedUnits,
    unitGfxName, missileGfxName, grp, palette: pal, setCycler, get cycler() { return cyc; },
    clearCache() { imgCache.clear(); nameCache.clear(); tabZero.clear(); },
  };
}
