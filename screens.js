// Pre-game lobby and post-game victory/defeat screens, drawn with the game's own menu art from the user's MPQ
// (presentation only: everything here READS the .w2r and the arena, nothing is written back).
//
// Art and layout (all from War2Dat.mpq / War2Patch.mpq; nothing is bundled):
//   - PCX (8-bit RLE + 256-colour palette at the end): art\chat_ipx.pcx (IPX chat room), art\hwinglu.pcx /
//     owinglu.pcx / hlosglu.pcx / olosglu.pcx (stats screen per race and outcome: Dlg_MissionStatsHandler
//     0x4315e0 picks table 0x4a0cc8[(race != human) + (state != 6 ? 2 : 0)]).
//   - Dialog .bin (control list, 86-byte records: next, rect, text, flags, id, type): rez\chat_mj.bin (the Classic
//     chat room ChatRoom_Run 0x413f80 creates; chat_p2.bin = Enhanced) and rez\msnstat2/4/6/msnstats.bin
//     (MsnStats_Run 0x4313e0: by g_StatsRowCount < 3 / < 5 / < 7 / else). Positions and captions come from there.
//   - FONT (Art\font*.fnt: "FONT", first, last, max w, max h, u32 glyph offsets; glyph = w, h, x, y, then
//     bytes skip << 3 | colour, Gfx_DecodeRleRow 0x401ee0). The colour ramps are ours (the game's are runtime
//     tables); font12x = menu text, font32 = HugeText (stats screen), font10x small.
//   - rez\rank_txt.tbl (u16 count, u16 offsets, strings): rank names; thresholds 0x4a0b98 (19 x u32) and the
//     text ids 0x4a0be4 (u16, + race) are read from the exe image in the arena (Ui_StatsTitleHandler 0x4311a0).
//
// Outcome per player (outcome()): mirrors Game_VictoryCheckMultiplayer 0x458660 (g_VictoryCheckFn in every
// multiplayer game, run by Game_VictoryTick every 200 ticks) with the viewed player in place of g_LocalPlayer:
//   wiped(p) = units - flyers - transports - tankers == 0 && buildings == 0           (player_wiped)
//   defeat   if wiped(v) (or v left: turn packet 0x10 = quit, 4 = dropped; NET_TURNS.md §8)
//   victory  if no computer is alive and v is the only human alive, or every alive human is mutually allied
//            with allied victory on (g_AlliedVictoryMask) -- alive(i) = !wiped(i) && (type != human || in chat)
//   else     the replay ended with v still in a contested game: "undecided" (shown neutrally, no winner made up).
// A player in `left` counts as gone even when the sim never saw it leave: the recording player's own quit ends the
// replay before its packet (QUIT chunk), and the survivors' next victory check would have given them the game.
// The original shows the screen only to its local player (state 6 -> MsnStats_Run with the win art, 7 -> lose);
// a player that quit through the menu (state 2/4) sees no screen at all, a Ctrl-F1 abort sees "defeat".

const dec = new TextDecoder('latin1');

// ---------------------------------------------------------------- PCX
export function decodePCX(b) {
  if (!b || b.length < 128 + 769 || b[0] !== 10 || b[3] !== 8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const x0 = dv.getUint16(4, true), y0 = dv.getUint16(6, true), x1 = dv.getUint16(8, true), y1 = dv.getUint16(10, true);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, bpl = dv.getUint16(66, true), planes = b[65];
  if (planes !== 1) return null;
  const pix = new Uint8Array(w * h);
  let o = 128;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < bpl;) {
      let v = b[o++], n = 1;
      if ((v & 0xc0) === 0xc0) { n = v & 0x3f; v = b[o++]; }
      for (; n-- > 0; x++) if (x < w) pix[y * w + x] = v;
    }
  }
  const pal = b.subarray(b.length - 768);
  return { w, h, pix, pal: new Uint8Array(pal) };
}

// ---------------------------------------------------------------- dialog .bin
export function parseDialogBin(b) {
  if (!b || b.length < 86) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cs = o => { if (!o || o >= b.length) return ''; let e = o; while (e < b.length && b[e]) e++; return dec.decode(b.subarray(o, e)); };
  const ctrls = [];
  const rd = o => ({
    l: dv.getInt16(o + 4, true), t: dv.getInt16(o + 6, true), r: dv.getInt16(o + 8, true), b: dv.getInt16(o + 10, true),
    text: cs(dv.getUint32(o + 0x14, true)), flags: dv.getUint32(o + 0x18, true), id: dv.getInt16(o + 0x20, true), type: dv.getUint16(o + 0x22, true),
  });
  const dlg = rd(0);
  for (let o = 86, k = 0; o + 86 <= b.length && k < 400; k++) {
    ctrls.push(rd(o));
    const next = dv.getUint32(o, true);
    if (!next || next <= o) break;
    o = next;
  }
  const byId = id => ctrls.find(c => c.id === id);
  return { dlg, ctrls, byId };
}

// ---------------------------------------------------------------- FONT
export function parseFont(b) {
  if (!b || b.length < 8 || dec.decode(b.subarray(0, 4)) !== 'FONT') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const first = b[4], last = b[5], maxW = b[6], maxH = b[7], glyphs = new Map();
  for (let c = first; c <= last; c++) {
    const off = dv.getUint32(8 + 4 * (c - first), true);
    if (!off || off + 4 > b.length) continue;
    const w = b[off], h = b[off + 1], x = b[off + 2], y = b[off + 3], px = new Uint8Array(w * h);
    for (let i = 0, o = off + 4; i < w * h && o < b.length;) { const v = b[o++]; i += v >> 3; if (i < w * h) px[i++] = v & 7; }
    glyphs.set(c, { w, h, x, y, px });
  }
  return { first, last, maxW, maxH, glyphs };
}
const glyphOf = (f, ch) => f.glyphs.get(ch) || f.glyphs.get(0x3f);
export function textWidth(f, s) {
  let w = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); if (c === 0x20) { w += (f.maxW >> 1) + 1; continue; } const g = glyphOf(f, c); if (g) w += g.x + g.w + 1; }
  return w;
}

// ---------------------------------------------------------------- RGBA surface
export class Surface {
  constructor(w, h) { this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4); }
  blitIndexed(img, pal, dx = 0, dy = 0) {
    const P = pal || img.pal, d = this.data;
    for (let y = 0; y < img.h; y++) {
      const ty = y + dy; if (ty < 0 || ty >= this.h) continue;
      for (let x = 0; x < img.w; x++) {
        const tx = x + dx; if (tx < 0 || tx >= this.w) continue;
        const v = img.pix[y * img.w + x], o = 4 * (ty * this.w + tx);
        d[o] = P[3 * v]; d[o + 1] = P[3 * v + 1]; d[o + 2] = P[3 * v + 2]; d[o + 3] = 255;
      }
    }
  }
  fill(x, y, w, h, [r, g, b], a = 1) {
    const d = this.data;
    for (let j = Math.max(0, y | 0); j < Math.min(this.h, (y + h) | 0); j++)
      for (let i = Math.max(0, x | 0); i < Math.min(this.w, (x + w) | 0); i++) {
        const o = 4 * (j * this.w + i);
        d[o] += (r - d[o]) * a; d[o + 1] += (g - d[o + 1]) * a; d[o + 2] += (b - d[o + 2]) * a; d[o + 3] = 255;
      }
  }
  // bevel frame like the game's dialog boxes: dark top/left, light bottom/right (sunken)
  bevel(x, y, w, h, sunken = true) {
    const dark = [24, 20, 12], light = [148, 132, 92];
    const [a, b] = sunken ? [dark, light] : [light, dark];
    this.fill(x, y, w, 1, a); this.fill(x, y, 1, h, a); this.fill(x, y + h - 1, w, 1, b); this.fill(x + w - 1, y, 1, h, b);
  }
  // text in a FONT; ramp[k] = rgb for glyph colour k (1..7). align: 'l' | 'c' | 'r' inside [x, x + boxW).
  text(f, s, x, y, ramp, align = 'l', boxW = 0) {
    if (!f || !s) return 0;
    const tw = textWidth(f, s);
    let cx = align === 'c' ? x + Math.round((boxW - tw) / 2) : align === 'r' ? x + boxW - tw : x;
    const d = this.data;
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c === 0x20) { cx += (f.maxW >> 1) + 1; continue; }
      const g = glyphOf(f, c); if (!g) continue;
      for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
        const k = g.px[j * g.w + i]; if (!k) continue;
        const tx = cx + g.x + i, ty = y + g.y + j; if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
        const rgb = ramp[k] || ramp[ramp.length - 1], o = 4 * (ty * this.w + tx);
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
      cx += g.x + g.w + 1;
    }
    return tw;
  }
  // cut a string with "..." so it stays within maxW
  fitText(f, s, maxW) {
    if (!f || textWidth(f, s) <= maxW) return s;
    while (s.length && textWidth(f, s + '...') > maxW) s = s.slice(0, -1);
    return s + '...';
  }
}

// ---------------------------------------------------------------- .w2r MTCH chunk (W2Match, include/match.h)
export function parseMatch(w2r) {
  const dv = new DataView(w2r.buffer, w2r.byteOffset, w2r.byteLength);
  let mt = null, pudName = '', pudSize = 0;
  for (let o = 8; o + 8 <= w2r.length;) {
    const tag = dec.decode(w2r.subarray(o, o + 4)), len = dv.getUint32(o + 4, true), p = o + 8;
    if (tag === 'MTCH') mt = w2r.subarray(p, p + len);
    else if (tag === 'PUD ') { pudSize = dv.getUint32(p, true); let e = p + 8; while (e < p + len && w2r[e]) e++; pudName = dec.decode(w2r.subarray(p + 8, e)); }
    else if (tag === 'TURN' || tag === 'END ') break;
    o = p + len;
  }
  if (!mt || mt.length < 4 + 8 + 8 + 0x30 + 8 * 0x38 + 8) return null;
  const m = new DataView(mt.buffer, mt.byteOffset, mt.byteLength);
  let o = 4;
  const r8 = () => mt[o++];
  const M = { extended: r8(), localPlayer: r8(), localPeer: r8(), hostSlot: r8(), netSpeed: r8(), maxPlayers: r8(), gameSpeed: r8(), lobbyCount: r8() };
  M.slotOrder = [...mt.subarray(o, o + 8)]; o += 8;
  const st = mt.subarray(o, o + 0x30); o += 0x30;
  M.settings = st;
  M.mapW = st[1]; M.seed = st[3];
  M.slotBits = m.getUint32(o - 0x30 + 4, true); M.options = m.getUint32(o - 0x30 + 8, true); M.mapCrc = m.getUint32(o - 0x30 + 0xc, true);
  { let e = 0x10; while (e < 0x30 && st[e]) e++; M.mapName = dec.decode(st.subarray(0x10, e)); }
  M.chat = [];
  for (let c = 0; c < 8; c++, o += 0x38) {
    const s = mt.subarray(o, o + 0x38);
    let e = 0x18; while (e < 0x38 && s[e]) e++;
    M.chat.push({ state: s[0], peer: s[1], status: s[3], caps: s[4], name: dec.decode(s.subarray(0x18, Math.min(e, 0x18 + 16))) });
  }
  M.race = [...mt.subarray(o, o + 8)];
  M.pudName = pudName; M.pudSize = pudSize;
  return M;
}

// ---------------------------------------------------------------- arena readers for the end screen
const PT = 0x4acb5c, CHAT = 0x4ad740, RES = 0x4ab98c;
const U16 = { units: 0x4ada7c, bldgs: 0x4ad9b4, lostU: 0x4ad368, lostB: 0x4acb6c, kills: 0x4ad328, razed: 0x4ace80 };
const U32 = { gold: 0x4ab9c4, lumber: 0x4ad3a8, oil: 0x4abc98, score: 0x4ace00 };

// Game_VictoryCheckMultiplayer's per-player helpers (src/lift/w2_tick_victory.c).
export function playerWiped(m, p, G) {
  const d = (m.r16(U16.units + 2 * p) - m.r16(G.flyer + 2 * p) - m.r16(G.transport + 2 * p) - m.r16(G.tanker + 2 * p)) & 0xffff;
  return d === 0 && m.r16(U16.bldgs + 2 * p) === 0;
}
// g_PlayerCnt_Flyer / g_PlayerCnt_Transport / g_PlayerTankerCount (u16[16]), g_AlliedVictoryMask (u8),
// g_Alliance (u8[16][16]), g_CheatFlags (u32): sim/gen/w2globals.h
export const VICTORY_GLOBALS = { flyer: 0x4adebc, transport: 0x4adf9c, tanker: 0x4adbfc, alliedMask: 0x4ad364, alliance: 0x4abd54, cheat: 0x4ad98c };

// `left`: Map player -> { turn, kind: 'quit' | 'dropped' | 'defeated' } recorded while stepping (viewer.js).
export function outcome(m, v, left, G = VICTORY_GLOBALS) {
  const lv = left.get(v);
  if (lv && lv.local) {      // the recording player's own quit: it decides only a game still on (not the exit from the
    const o = outcome(m, v, new Map([...left].filter(([p]) => p !== v)), G);   // stats screen after a victory/defeat)
    return o.kind === 'undecided' ? { kind: 'quit', turn: lv.turn, tick: lv.tick } : o;
  }
  if (lv) return { kind: lv.kind === 'defeated' ? 'defeat' : lv.kind, turn: lv.turn, tick: lv.tick };
  if (m.r8(PT + v) === 3) return { kind: 'gone' };
  const cheat = m.r32(G.cheat);
  if (cheat & 0x100) return { kind: 'victory', cheat: true };
  if ((cheat & 0x80) || playerWiped(m, v, G)) return { kind: 'defeat' };
  const alive = [], humans = [];
  let computers = 0;
  for (let i = 0; i < 8; i++) {
    const t = m.r8(PT + i);
    const gone = left.has(i) && (!left.get(i).local || outcome(m, i, left, G).kind === 'quit');
    const a = gone || playerWiped(m, i, G) ? 0 : t !== 0 ? 1 : m.r8(CHAT + 0x38 * i) === 1 ? 1 : 0;
    alive[i] = a;
    if (a && t === 1) computers++;
    if (a && t === 0) humans.push(i);
  }
  if (computers > 0) return { kind: 'undecided' };
  if (humans.length === 1) return { kind: 'victory' };
  const allied = humans.every(i => (m.r8(G.alliedMask) >> i & 1) && humans.every(j => m.r8(G.alliance + 16 * i + j) && m.r8(G.alliance + 16 * j + i)));
  return allied ? { kind: 'victory', allied: true } : { kind: 'undecided' };
}

export function playerStats(m, p) {
  return {
    units: m.r16(U16.units + 2 * p) + m.r16(U16.lostU + 2 * p), bldgs: m.r16(U16.bldgs + 2 * p) + m.r16(U16.lostB + 2 * p),
    gold: m.r32(U32.gold + 4 * p), lumber: m.r32(U32.lumber + 4 * p), oil: m.r32(U32.oil + 4 * p),
    kills: m.r16(U16.kills + 2 * p), razed: m.r16(U16.razed + 2 * p), score: m.r32(U32.score + 4 * p),
  };
}

// ---------------------------------------------------------------- art from the MPQs
// .tbl string table (Str_TableGet 0x409950): u16 count, u16 offsets; ids are 1-based.
export function parseTbl(b) {
  if (!b || b.length < 2) return () => '';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint16(0, true);
  return id => {
    if (!id || id > n) return '';
    const o = dv.getUint16(2 * id, true); let e = o; while (e < b.length && b[e]) e++;
    return dec.decode(b.subarray(o, e));
  };
}
export function loadScreenArt(getFile) {
  const g = n => { try { return getFile(n) || null; } catch { return null; } };
  const pcx = n => decodePCX(g(n)), bin = n => parseDialogBin(g(n)), fnt = n => parseFont(g(n));
  const art = {
    chatBg: pcx('art\\chat_ipx.pcx'),
    win: [pcx('art\\hwinglu.pcx'), pcx('art\\owinglu.pcx')],     // Dlg_MissionStatsHandler table 0x4a0cc8
    lose: [pcx('art\\hlosglu.pcx'), pcx('art\\olosglu.pcx')],
    chatDlg: [bin('rez\\chat_mj.bin'), bin('rez\\chat_p2.bin')], // ChatRoom_Run: Classic / Enhanced
    statDlg: { 2: bin('rez\\msnstat2.bin'), 4: bin('rez\\msnstat4.bin'), 6: bin('rez\\msnstat6.bin'), 8: bin('rez\\msnstats.bin') },
    font: { f10: fnt('art\\font10x.fnt'), f12: fnt('art\\font12x.fnt'), f32: fnt('art\\font32.fnt'), f50: fnt('art\\font50.fnt') },
    chatTbl: parseTbl(g('rez\\chatroom.tbl')), rankTbl: parseTbl(g('rez\\rank_txt.tbl')),
    netTbl: parseTbl(g('rez\\network.tbl')), gluTbl: parseTbl(g('rez\\gluall.tbl')),
  };
  art.lobbyOk = !!(art.chatBg && art.chatDlg[0] && art.font.f12 && art.font.f10);
  art.outroOk = !!(art.win[0] && art.win[1] && art.lose[0] && art.lose[1] && art.statDlg[2] && art.statDlg[4] && art.statDlg[6] && art.statDlg[8] && art.font.f10 && art.font.f12 && art.font.f32 && art.font.f50);
  return art;
}

// ---------------------------------------------------------------- lobby model for the intro
// M = parseMatch(w2r), m = arena right after the boot, rgbOf(colourIdx) = tileset palette rgb (in-game colour).
const PLAYER_RACE = 0x4abd28, PLAYER_COLOR = 0x4a48bc, MAP_SIZE = 0x4acbdc, GAME_SPEED = 0x4d6ae8;
export function lobbyInfo(M, m, art, rgbOf) {
  const T = art.chatTbl, opt = M.options;
  const pick = (map, v) => map[v] !== undefined ? T(map[v]) : '';
  const raceName = r => r === 0 ? T(20) : r === 1 ? T(21) : T(11);
  const mapTitle = M.mapName || (M.pudName || '').replace(/^builtin:0x[0-9a-f]+ /i, '').replace(/^.*[\\/]/, '').replace(/\.pud$/i, '');
  const sp = m.r32(GAME_SPEED);
  const L = {
    extended: !!M.extended, mapTitle, mapSize: m.r16(MAP_SIZE), builtin: !M.pudSize,
    scenarioKind: T(M.pudSize ? 2 : 1),                 // chatroom.tbl: Built-in / Custom scenario
    mode: M.extended ? 'Enhanced' : 'Classic',
    speed: art.gluTbl(82 + sp) || `speed ${sp}`,
    options: {                                         // Lobby_ApplySettings 0x4125c0
      resources: pick({ 0: 0xb, 0x1000: 0xc, 0x2000: 0xd, 0x3000: 0xe, 0x20000: 0x12 }, opt & 0x23000),
      location: T(opt & 0x400 ? 0x11 : 0x12),
      units: T(opt & 0x200 ? 0x13 : 0xb),
      fog: T(opt & 0x100 ? 0x10 : 0xf),
      tileset: pick({ 0: 0xb, 0x4000: 0x16, 0x8000: 0x17, 0xc000: 0x18, 0x14000: 0x12, 0x1c000: 0x23 }, opt & 0x1c000),
      cheats: T(opt & 0x800 ? 0x19 : 0x1a),
    },
    yourRace: raceName(M.race[M.localPlayer]),
    slots: [],
  };
  for (let k = 0; k < 8; k++) {
    const c = M.chat[k], p = M.slotOrder[k], bits = (M.slotBits >> 2 * k) & 3;
    const s = { k, p, race: m.r8(PLAYER_RACE + p), color: rgbOf(m.r8(PLAYER_COLOR + p)) };
    if (c.state === 1) Object.assign(s, { kind: 'human', name: c.name, lobbyRace: raceName(M.race[p]), host: p === M.hostSlot, recorder: p === M.localPlayer, ready: k === 0 || !!(opt & (1 << k)) });
    else Object.assign(s, { kind: bits === 1 ? 'computer' : bits === 2 ? 'closed' : 'open', name: T(bits === 1 ? 7 : bits === 2 ? 8 : 6), lobbyRace: raceName(M.race[p]),
      inGame: m.r8(PT + p) === 1 });                   // a computer slot the map has no start for is "nobody" in game
    L.slots.push(s);
  }
  return L;
}

const centerY = (f, c) => c.t + Math.max(0, Math.round((c.b - c.t + 1 - f.maxH) / 2));

// ---- text colours, as the game picks them
// A glyph pixel k (1..5) is drawn with palette index table[k] of the screen's own palette (Gfx_DecodeRleRow:
// g_FontColorCur[k]). The tables are 4 bytes each, followed in memory by the next table, so k = 4, 5 read the next one:
//   g_FontColorRemap 0x4d4ff0 + g_Font_ColorQuad4  (Gfx_FontSetColor 2: normal text)
//   g_Font_ColorQuad 0x4d4fd0 + g_Font_ColorQuad3   (4: labels with flag 0x8000 / control flag 0x80)
//   g_Font_ColorQuad2 0x4d4fb8 + g_Font_ColorSet7   (5: disabled, control flag 2)
// Menus (stats screen): Pal_SetupMenuPalette 0x437190 makes them the identity, k -> index k (stats PCX: 1 white ..
// 4 grey, 5 black outline). Chat room: Title_RunIpxChatLoop 0x44f540 calls Pal_ResetThunk = Pal_SetupGamePalette(1)
// 0x437040 after loading art\Chat_IPX.pcx with its palette (Ui_PaneLoad -> SBmpLoadImage into g_GamePalette, full
// 256 entries, 8-bit, then Gfx_PalFadeIn to it; gamma g_GammaPercent defaults to 100 = none).
const COLOR_SETS = {
  chat: { 2: [0, 200, 199, 197, 0xc0, 0xef], 4: [0, 0xf6, 0xf6, 0x6c, 0x68, 0xef], 5: [0, 0x6c, 0x6c, 0x69, 0x66, 0xef] },
  menu: { 2: [0, 1, 2, 3, 4, 5], 4: [0, 1, 2, 3, 4, 5], 5: [0, 0, 0, 0, 0, 0] },
};
const rampOf = (pal, idx) => idx.map(i => [pal[3 * i], pal[3 * i + 1], pal[3 * i + 2]]);
// Ui_CtrlDrawText 0x4061a0: font = font6 (flag 0x400) / font12x (0x800) / the dialog font g_FontSmall = font10x;
// colour set = 5 if flag 2, else 4 if flag 0x80 or (label types 9/10/11 with flag 0x8000), else 2.
const ctrlFont = (F, c) => (c.flags & 0x800 ? F.f12 : F.f10) || F.f12;
const ctrlSet = c => c.flags & 2 ? 5 : (c.flags & 0x80) || (c.type >= 9 && c.type <= 11 && (c.flags & 0x8000)) ? 4 : 2;

function box(s, c, pal) {
  const w = c.r - c.l + 1, h = c.b - c.t + 1, at = i => [pal[3 * i], pal[3 * i + 1], pal[3 * i + 2]];
  s.fill(c.l, c.t, w, h, [0, 0, 0], 0.55);
  const dark = at(0xef), light = at(0x6c);
  s.fill(c.l, c.t, w, 1, dark); s.fill(c.l, c.t, 1, h, dark); s.fill(c.l, c.t + h - 1, w, 1, light); s.fill(c.l + w - 1, c.t, 1, h, light);
}
function button(s, f, c, label, ramp, pal) {   // the game's red menu button (its art is not in the MPQs: a dark red bevel)
  const w = c.r - c.l + 1, h = c.b - c.t + 1;
  s.fill(c.l, c.t, w, h, [112, 12, 8]);
  s.fill(c.l + 2, c.t + 2, w - 4, h - 4, [84, 4, 4]);
  const dark = [36, 0, 0], light = [176, 44, 28];
  s.fill(c.l, c.t, w, 1, light); s.fill(c.l, c.t, 1, h, light); s.fill(c.l, c.t + h - 1, w, 1, dark); s.fill(c.l + w - 1, c.t, 1, h, dark);
  s.text(f, label, c.l, centerY(f, c), ramp, 'c', w);
}

// The Classic (chat_mj.bin) / Enhanced (chat_p2.bin) chat room as it looked when the host started the game.
export function renderLobby(art, L) {
  const s = new Surface(640, 480), F = art.font, pal = art.chatBg.pal;
  s.blitIndexed(art.chatBg);
  const R = { 2: rampOf(pal, COLOR_SETS.chat[2]), 4: rampOf(pal, COLOR_SETS.chat[4]), 5: rampOf(pal, COLOR_SETS.chat[5]) };
  const D = (L.extended && art.chatDlg[1]) || art.chatDlg[0];
  const by = id => D.byId(id);
  const put = (c, t, opts = {}) => {   // a control's text, drawn the way Ui_CtrlDrawText would
    if (!c || !t) return;
    const f = opts.font || ctrlFont(F, c), w = c.r - c.l + 1, pad = opts.pad ?? 0;
    s.text(f, s.fitText(f, t, w - 2 * pad), c.l + pad, opts.y ?? centerY(f, c), R[opts.set || ctrlSet(c)], opts.align || (c.type === 10 ? 'c' : 'l'), w - 2 * pad);
  };
  for (const c of D.ctrls) {
    if (!c.text || !(c.id === -1 || /^Ready/.test(c.text))) continue;
    put(c, /^Ready/.test(c.text) ? 'Recorded game: press Play (or Start replay) to start' : c.text);
  }
  for (const sl of L.slots) {
    const nameC = by(20 + sl.k), infoC = by(12 + sl.k), colC = by(43 + sl.k);
    const occupied = sl.kind === 'human' || (sl.kind === 'computer' && sl.inGame);
    if (nameC) put(nameC, sl.name, { pad: 4, set: 4 });   // as the game: names and "Available" in the label white, on the parchment
    if (infoC) {
      let t = '';
      if (occupied) {
        const actual = sl.race === 1 ? 'Orc' : 'Human';
        t = sl.lobbyRace === actual ? actual : `${sl.lobbyRace} (${actual})`;
        const rec = [sl.mic && 'mic', sl.cam && 'camera'].filter(Boolean).join(', ');   // CamRec recordings (set by the viewer)
        t += sl.kind === 'human' ? (rec ? `  -  ${rec}` : '') : '  -  computer';
      }
      put(infoC, t, { pad: 4 });
    }
    if (colC && occupied) { s.fill(colC.l, colC.t + 1, colC.r - colC.l + 1, colC.b - colC.t - 1, sl.color); s.bevel(colC.l, colC.t + 1, colC.r - colC.l + 1, colC.b - colC.t - 1); }
  }
  const val = (id, t) => { const c = by(id); if (!c) return; put(c, t, { pad: 4, set: 2 }); };
  val(10, L.yourRace);
  val(4, L.options.resources); val(5, L.options.location); val(6, L.options.units);
  val(7, L.options.fog); val(8, L.options.tileset);
  val(9, L.extended ? L.speed : L.options.cheats);
  const sc = by(11);
  if (sc) {
    const f = ctrlFont(F, sc);
    [`${L.scenarioKind}: ${L.mapTitle}`, `Map ${L.mapSize}x${L.mapSize}, ${L.mode}, speed ${L.speed}`, L.rules && `Rules: ${L.rules}`].filter(Boolean)
      .forEach((t, i) => put(sc, t, { y: sc.t + 2 + i * (f.maxH + 4), set: 4 }));
  }
  const lv = by(1);
  if (lv) button(s, ctrlFont(F, lv), lv, 'Start replay', R[2], pal);
  return s;
}
// where the lobby's "Start replay" button is (640x480 screen coordinates)
export function lobbyStartButton(art, L) {
  const D = (L.extended && art.chatDlg[1]) || art.chatDlg[0], c = D && D.byId(1);
  return c ? { x: c.l, y: c.t, w: c.r - c.l + 1, h: c.b - c.t + 1 } : null;
}

// ---------------------------------------------------------------- outro (MsnStats_Run 0x4313e0)
const STATS_COLS = ['units', 'bldgs', 'gold', 'lumber', 'oil', 'kills', 'razed'];
export const OUTCOME_TEXT = { victory: 'Victory!', defeat: 'Defeat!', quit: 'Defeat!', dropped: 'Disconnect!', gone: 'Defeat!', undecided: 'Undecided' };

// Everything the end screen shows for viewed player v. `players`: who took part (type human/computer at the
// start), M: parseMatch, left: Map p -> {turn, tick, kind}, elim: Map p -> tick at which the victory check first
// marked p defeated (g_PlayerGameResult 0 -> 2), tickMs for times.
export function outroData(art, m, M, v, players, left, elim, tickMs) {
  const oc = outcome(m, v, left);
  if (oc.kind === 'defeat' && oc.tick === undefined && elim.has(v)) oc.tick = elim.get(v);
  const raceOf = p => m.r8(PLAYER_RACE + p) === 1 ? 1 : 0;
  const nameOf = p => { const k = M.slotOrder.indexOf(p); return k >= 0 && M.chat[k].state === 1 ? M.chat[k].name : ''; };
  const raceText = p => art.netTbl(m.r16(0x4a0c48 + 2 * (m.r8(PLAYER_RACE + p) + 2 * p)));   // race_text (computers)
  const label = p => p === v ? nameOf(p) || raceText(p)
    : `${nameOf(p) || raceText(p)} - ${art.netTbl(m.r8(VICTORY_GLOBALS.alliance + 16 * v + p) ? 0x24 : 0x23)}`;
  const order = [v, ...players.filter(p => p !== v)];
  const rows = order.map(p => ({ p, label: label(p), stats: playerStats(m, p), bar: m.r8(0x4a0c38 + p) }));   // g_Stats_BarColors
  const score = playerStats(m, v).score + (oc.kind === 'victory' ? 500 : 0);   // Stats_AddPlayerScore: +500 in state 6
  let i = 0; while (i < 19 && score >= m.r32(0x4a0b98 + 4 * i)) i++;       // Ui_StatsTitleHandler
  if (i === 19) i = 18;
  const rankId = m.r8(0x4b48d6) ? 0x27 : m.r16(0x4a0be4 + 2 * i) + raceOf(v);
  const at = oc.tick !== undefined ? fmtClock(oc.tick * tickMs) : '';
  const sub = { quit: `left the game at ${at}`, dropped: `was dropped at ${at}`, gone: 'left the game',
    undecided: 'no winner: game not finished', victory: oc.allied ? 'allied victory' : '', defeat: at ? `eliminated at ${at}` : 'eliminated' }[oc.kind] || '';
  return { v, name: nameOf(v) || `Player ${v + 1}`, race: raceOf(v), outcome: oc, title: OUTCOME_TEXT[oc.kind], sub,
    rank: art.rankTbl(rankId), score, rows };
}
export const fmtClock = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// t = seconds since the screen appeared (the numbers count up like the original's, ~1.2 s).
// Palette = the background PCX's own (Dlg_MissionStatsHandler: File_LoadBmp(pcx, .., g_GamePalette), then
// Pal_SetupMenuPalette, Gfx_PalSetFadeTarget(0, 0x100, g_GamePalette), Gfx_PalFadeIn): text, bar frames (5, 0xfb)
// and bar colours (g_Stats_BarColors -> 240..247) are all indices into it.
export function renderOutro(art, O, t = 99, footer = '') {
  const s = new Surface(640, 480), F = art.font;
  const k = O.outcome.kind, bg = k === 'victory' ? art.win[O.race] : k === 'undecided' ? art.chatBg : art.lose[O.race];
  s.blitIndexed(bg);
  // "Undecided" has no screen of its own in the game: the neutral chat-room parchment, dimmed, with the stats
  // screen's palette for text and bars.
  const pal = k === 'undecided' ? art.win[O.race].pal : bg.pal;
  if (k === 'undecided') s.fill(0, 0, 640, 480, [0, 0, 0], 0.35);
  const R = rampOf(pal, COLOR_SETS.menu[2]), at = i => [pal[3 * i], pal[3 * i + 1], pal[3 * i + 2]];
  const n = O.rows.length, D = art.statDlg[n < 3 ? 2 : n < 5 ? 4 : n < 7 ? 6 : 8], by = id => D.byId(id);
  const grow = Math.max(0, Math.min(1, (t - 0.3) / 1.2));
  for (const c of D.ctrls)
    if (c.id >= 68 && c.id <= 77 && c.text) { const f = ctrlFont(F, c); s.text(f, c.text, c.l, centerY(f, c), R, 'c', c.r - c.l + 1); }
  const oc = by(1);
  if (oc) {   // Ui_StatsContinueHandler: HugeText_DrawCtrl50, font32 if it does not fit
    const w = oc.r - oc.l + 1, f = textWidth(F.f50, O.title) <= w ? F.f50 : F.f32;
    s.text(f, O.title, oc.l, oc.t, R, 'c', w);
    if (O.sub) s.text(F.f10, s.fitText(F.f10, O.sub, w), oc.l, oc.b - 6, R, 'c', w);
  }
  const rk = by(2); if (rk) s.text(F.f32, s.fitText(F.f32, O.rank, rk.r - rk.l + 1), rk.l, rk.t, R, 'c', rk.r - rk.l + 1);
  const scC = by(3); if (scC) s.text(F.f32, String(Math.round(O.score * grow)), scC.l, scC.t, R, 'c', scC.r - scC.l + 1);
  const max = STATS_COLS.map(col => Math.max(1, ...O.rows.map(r => r.stats[col])));
  O.rows.forEach((r, i) => {
    const nc = by(4 + i);
    if (nc) {   // Ui_StatsSetPlayerRow: HugeText_DrawCtrl32 when fewer than 5 rows
      const f = n < 5 ? F.f32 : ctrlFont(F, nc), w = nc.r - nc.l + 1;
      s.text(f, s.fitText(f, r.label, w), nc.l, n < 5 ? nc.t : centerY(f, nc), R, 'c', w);
    }
    STATS_COLS.forEach((col, j) => {
      const c = by(12 + i + 8 * j); if (!c) return;
      const x = c.l, y = c.t, w = c.r - c.l + 1, h = c.b - c.t + 1, val = Math.round(r.stats[col] * grow);
      s.fill(x, y, w, h, at(5));                                       // Ui_DrawBevelBox_2: outlines 5, 0xfb, 5
      s.fill(x + 1, y + 1, w - 2, h - 2, at(0xfb));
      s.fill(x + 2, y + 2, w - 4, h - 4, at(5));
      const bw = Math.round((w - 6) * Math.min(1, val / max[j]));    // Ui_DrawProgressBar(bar colour, 5)
      if (bw > 0) s.fill(x + 3, y + 3, bw, h - 6, at(r.bar));
      const f = ctrlFont(F, c);                                         // Ui_StatsBarDraw*: "%ld", centred
      s.text(f, String(val), x, y + Math.max(0, Math.round((h - f.maxH) / 2)), R, 'c', w);
    });
  });
  const cont = by(-2), st = outroStatsButton(art, O), sc = { l: st.x, t: st.y, r: st.x + st.w - 1, b: st.y + st.h - 1, flags: cont ? cont.flags : 0 };
  if (cont) button(s, ctrlFont(F, cont), cont, cont.text || 'Continue', R, pal);
  button(s, ctrlFont(F, sc), sc, 'Stats', R, pal);
  if (footer) s.text(F.f10, s.fitText(F.f10, footer, st.x - 12), 6, 464, R);
  return s;
}

// The viewer's own "Stats" button on the end screen (opens the match stats window), 640x480 screen coordinates: the
// size of "Continue", left of it on the bottom line (above it the 4 players' screen has its last name); the 8
// players' screen has no "Continue": where it would be.
const CONTINUE = { l: 456, t: 448, r: 561, b: 475 };
export function outroStatsButton(art, O) {
  const n = O.rows.length, D = art.statDlg[n < 3 ? 2 : n < 5 ? 4 : n < 7 ? 6 : 8], c = D && D.byId(-2);
  const r = c || CONTINUE, w = r.r - r.l + 1, h = r.b - r.t + 1;
  return { x: c ? c.l - w - 10 : r.l, y: r.t, w, h };
}

// ---------------------------------------------------------------- who left / was eliminated, while stepping
// Turn packets of type 0x10 (quit) in the .w2r, by sending peer; a player that leaves without one (type 4
// hello: Ctrl-F1 abort, Alt-F2 drop, desync) was dropped. NET_TURNS.md §8.
export class GameTracker {
  constructor(w2r) {
    this.quitTurn = new Map(); this.localQuit = null;
    const dv = new DataView(w2r.buffer, w2r.byteOffset, w2r.byteLength);
    for (let o = 8; o + 8 <= w2r.length;) {
      const tag = dec.decode(w2r.subarray(o, o + 4)), len = dv.getUint32(o + 4, true), p = o + 8;
      if (tag === 'TURN' && len >= 24) {
        const idx = dv.getUint32(p, true), nev = dv.getUint32(p + 20, true);
        for (let e = p + 24, i = 0; i < nev && e + 4 <= p + len; i++) {
          const kind = w2r[e], n = dv.getUint16(e + 2, true), d = e + 4;
          if (kind === 1 && n > 7 && w2r[d + 6] === 0x10 && !this.quitTurn.has(w2r[d + 1])) this.quitTurn.set(w2r[d + 1], idx);
          e = d + n;
        }
      }
      if (tag === 'QUIT' && len >= 8) this.localQuit = { peer: w2r[p], turn: dv.getUint32(p + 4, true) };   // pcap.js withLocalQuit
      o = p + len;
    }
  }
  // m = arena right after the boot
  reset(m) {
    this.left = new Map(); this.elim = new Map();
    this.types = [...m.bytes(PT, 8)]; this.res = [...m.bytes(RES, 8)];
    this.peerOf = [0, 1, 2, 3, 4, 5, 6, 7].map(p => m.r8(CHAT + 0x38 * p + 1));
    this.players = [0, 1, 2, 3, 4, 5, 6, 7].filter(p => this.types[p] === 1 || (this.types[p] === 0 && m.r8(CHAT + 0x38 * p) === 1));
  }
  // The game went on after the capture's last turn (the capturing PC surrendered first: the others stop sending
  // it turns), but the CamRec cameras, broadcast, kept coming: a player whose camera ended after the replay and
  // clearly before the last camera to end left the game then (surrender / quit). camEnds: Map player -> end tick.
  // Run once the replay has ended; marks only players still in, and only when some camera outlasted the replay.
  afterEnd(lastTick, camEnds, slack = 8) {
    const ends = [...camEnds].filter(([p, t]) => t != null && this.players.includes(p) && this.types[p] === 0);
    if (!ends.length) return;
    const latest = Math.max(...ends.map(([, t]) => t));
    if (latest <= lastTick + slack) return;
    for (const [p, t] of ends)
      if (t > lastTick && t < latest - slack && !this.left.has(p)) this.left.set(p, { turn: null, tick: t, kind: 'quit', camera: true });
  }
  // after each turn (turn = index of the turn just run)
  after(m, turn, tick) {
    for (let p = 0; p < 8; p++) {
      const t = m.r8(PT + p), r = m.r8(RES + p);
      if (t !== this.types[p] && t === 3 && this.types[p] === 0 && !this.left.has(p)) {
        const wiped = m.r16(U16.units + 2 * p) === 0 && m.r16(U16.bldgs + 2 * p) === 0;
        const q = this.quitTurn.get(this.peerOf[p]);
        this.left.set(p, { turn, tick, kind: wiped ? 'defeated' : q !== undefined && q <= turn ? 'quit' : 'dropped' });
      }
      if (r !== this.res[p] && r === 2 && this.players.includes(p) && !this.elim.has(p)) this.elim.set(p, tick);
      this.types[p] = t; this.res[p] = r;
    }
    // the recording player quit (surrender / Quit Game) right after the replay's last turn
    const q = this.localQuit;
    if (q && turn + 1 >= q.turn) for (const p of this.players)
      if (this.types[p] === 0 && this.peerOf[p] === q.peer && !this.left.has(p)) this.left.set(p, { turn: q.turn, tick, kind: 'quit', local: true });
  }
}
