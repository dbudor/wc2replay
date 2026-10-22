// "Player view": the replay as one player saw it (presentation only; reads the arena and the hook events, writes
// nothing back). Used by viewer.js; pure enough to run under node (test_playerview.mjs).
//
// Per-player selection: g_Selection 0x4bb6d8 = Unit*[8][9], written for every player by the turn commands
// (Cmd_ExecuteLegacyPacket 0x4558c0: packet 0x1b select, 0x2b control-group recall; Classic IPX legacy layer).
// That is the selection the player's machine had broadcast, so it is what its UI showed (g_UiSelection is the
// same list, compacted; the primary unit = the first one).
//
// Sounds of the player's own clicks (UiVoices): the replay has the commands, not the clicks, so the original's
// UI-side calls are replayed from the commands, with the original pickers and per-player state:
//   - 0x1b select of exactly one unit (Classic; Enhanced: any count, first unit) -> Snd_PlaySelectVoice 0x423230
//     (Sel_SetLocalSelection 0x43e5b0 with playVoice: Ui_ClickSelect / group recall), state g_VoiceLastUnit,
//     g_VoiceIndex (annoyed counter: k = index - 2), g_VoiceTimer (same-unit clicks within 1 s are ignored; the
//     annoyed lines set 3 s), g_VoiceSelCount (critter), g_VoiceThrottle; per-type pickers 0x498c48 (audio.js
//     SELECT_VOICE) with their side effects (annoyed -> timer 30; k >= K -> index 0); building sounds and the
//     construction sound (id 3) for a site under construction; 0x2b group recall of one unit -> the same.
//   - 0x1f order / 0x28 smart order -> Snd_PlaySelectAck 0x4231a0 for the primary unit (Ui_IssueOrderAtCursor
//     0x456fc0, Ui_RightClickMap 0x43ba20); 0x1e build -> the sim's own Snd_PlaySelectAck in
//     Order_BuildForSelection (hook HK_VOICE_ACK, now emitted for every owner). Pickers 0x498aec (ACK_VOICE).
//   - LocalRng 0x4534c0 (MSVC LCG 0x41c64e6d/0x3039, value = state >> 16 & 0x7fff, pickers use (r >> 8) % n):
//     one generator per player, seeded from the game seed and the player (the real machines' LocalRng states are
//     not in the replay, so WHICH line of a group plays is the only approximate part).
//   - Snd_VoiceTimersTick 0x423870 runs on the 100 ms idle input event (Ui_GetInputEvent 0x487680, event 10):
//     here every 100 ms of game time.
//   - work complete / unit ready / attack voice of the viewed player's units: hook HK_SOUND with HKS_OTHER (now
//     emitted for every owner); the attack voice throttled per player like g_VoiceAttackTimer (0x3c = 6 s).
// Messages: chat (packet 0x23, to the players in its recipient mask), "player left" messages (0x04 / 0x10, all),
// the recording player's own status messages, and every other player's cost / placement / "cannot create" errors
// (HK_STATUS_MSG with HKM_OTHER | player, emitted where the sim shows them only to the local player).
//
// Camera (PlayerCamera): the replay has no scrolling, so this is a rule, not a recording: the 448x448 map
// viewport is centred on the selection (the centre of its bounding box when it fits on screen, else on the
// primary unit, which is the one the status panel shows), follows it as it moves, eases there with a 0.12 s time
// constant (a new selection far away is reached in ~0.3 s), is clamped to the map, holds still with nothing
// selected, and starts on the player's town hall (else its first building / unit).
//
// Frame (PlayerFrame): the Classic 640x480 in-game screen from the user's MPQ, per the original's panes:
//   Art\{h,o}_top.bmp (176,0) resource bar = rez\infobox.bin; {h,o}_btm.bmp (176,464) = rez\textbox.bin;
//   {h,o}_rgt.bmp (624,0) = rez\sidebox.bin; {h,o}_lft0.bmp (0,0) menu = rez\stat_f10.bin; {h,o}_lft1.bmp (0,24)
//   minimap frame (minimap 128x128 at (24,26), Ui_MinimapInit 0x42d8c0 / Ui_MinimapUpdate 0x42d9e0);
//   status panel (0,160) = rez\statport.bin over Art\{h,o}frame.grp frame 0..3 (raw 176x176: 0 plain / multiple,
//   1 own unit, 3 own building producing or under construction; Ui_DrawStatusPanel 0x44b420, type table
//   0x4a3d58 {u16 icon, u16 frame, fn, fn}); buttons (0,336) = rez\statbtn.bin over {h,o}_lft2.bmp.
//   Raw .bmp = u16 w, u16 h, w*h palette indices (File_LoadBmp 0x462fa0) in the game palette (= the tileset's).
//   Icons: Art\unit\Portrait\{portrait,s_port,l_port,x_port}.grp by tileset (46x38, owner colours 0xd0..0xd3
//   remapped to the VIEWED player, as Ui_DrawStatusPortraitBtn 0x445280 uses g_LocalPlayer's); resource icons
//   Art\icons.grp frames 0..2 and 4 (Ui_DrawResourceIcon 0x44c840; the counters ease like
//   Ui_AnimateResourceCounters 0x44caf0). Command buttons: tables 0x4a3998 (Ui_UpdateCommandButtons 0x44b890)
//   with their predicates run from the exe bytes (x86cond.js) for the viewed player; mixed selections use set
//   0x76 + race (Ui_CheckMixedSelection 0x44bbe0), construction sites displayType 0x75.
//   Selection boxes (render.js drawSelection): Gfx_DrawSpriteClipped_2 0x454610, colour
//   g_PlayerMinimapColor[owner] (Ui_BuildPlayerColorTable 0x453660: own 0xfa, allied 0xfb, else 0xf9).

import { SELECT_VOICE, ACK_VOICE, HK, HKS_OTHER } from './audio.js';
import { parseGrp, decodeFrameIndices } from './sprites.js';
import { parseDialogBin, parseFont, parseTbl, textWidth, Surface } from './screens.js';
import { tryPredicate } from './x86cond.js';
import { A, readUnits } from './gamestate.js';

export const G = {
  Selection: 0x4bb6d8, UiSelPrimary: 0x4bdc78, UiSelection: 0x4bdca0, UiSelCount: 0x4bdc90, LocalRace: 0x4abb2c,
  Alliance: 0x4abd54, IsMultiplayer: 0x4b497e, NetGameSeed: 0x4d40a0, StatusTable: 0x4a3d58, ButtonSets: 0x4a3998,
  UpgradeIcon: 0x4cff60, Armor: 0x4cf974, BasicDmg: 0x4cf6dc, PiercingDmg: 0x4ceb5c, AttackRange: 0x4cfef0,
  UnitCountP: 0x4ada7c, FoodSupply: 0x4adc1c,
};
export const FRAME_W = 640, FRAME_H = 480;
export const MAP_RECT = { x: 176, y: 16, w: 448, h: 448 };
export const MINI_RECT = { x: 24, y: 26, w: 128, h: 128 };
const STATUS_Y = 160, BTN_Y = 336;
const UT = { Farm: 0x3a, PigFarm: 0x3b, Church: 0x3e, AltarOfStorms: 0x3f, Stables: 0x42, OgreMound: 0x43,
  GnomishInventor: 0x44, GoblinAlchemist: 0x45, GryphonAviary: 0x46, DragonRoost: 0x47, HumanShipyard: 0x48,
  OrcShipyard: 0x49, HumanFoundry: 0x4e, OrcFoundry: 0x4f, MageTower: 0x50, TempleOfTheDamned: 0x51,
  HumanBlacksmith: 0x52, OrcBlacksmith: 0x53, HumanRefinery: 0x54, OrcRefinery: 0x55, HumanOilPlatform: 0x56,
  OrcOilPlatform: 0x57, GoldMine: 0x5c, Critter: 0x39, Peasant: 2 };
const UTF_Building = 0x20, UTF_StoresLumber = 0x1000000, UTF_Critter = 0x10;

// ---------------------------------------------------------------- selection
export function selectionOf(m, p) {
  const out = [];
  if (p < 0 || p > 7) return out;
  for (let k = 0; k < 9; k++) {
    const u = m.r32(G.Selection + 36 * p + 4 * k);
    if (!u) continue;
    if (m.r16(u + 0x1e) & 7) continue;           // dead / free
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------- LocalRng + voice state machine
export class LocalRng {
  constructor(seed) { this.s = seed >>> 0; }
  next() { this.s = (Math.imul(this.s, 0x41c64e6d) + 0x3039) >>> 0; return (this.s >>> 16) & 0x7fff; }
}
// A picker of 0x498c48 called with k, with the original's side effects on the state st.
export function pickSelectVoice(st, type, k, tileset) {
  const v = SELECT_VOICE[type];
  if (!v) return 0;
  if (v[0] < 0) {                                      // Snd_SelectVoice_Critter 0x422900
    if (tileset === 3) { if (k < 2) { if (k) { st.timer = 30; return k + 0x158; } } else st.index = 0; return 0x158; }
    if (k > 1) st.index = 0; else if (k) { st.timer = 30; return 2 * tileset + 0xf8; }
    return 2 * tileset + 0xf7;
  }
  const [K, off, base, n] = v;
  if (K > 0) { if (k < K) { if (k) { st.timer = 30; return off + k; } } else st.index = 0; }
  return n ? base + ((st.rng.next() >> 8) % n) : base;
}
export function pickAckVoice(st, type, tileset) {
  const v = ACK_VOICE[type];
  if (!v) return 0;
  if (v[1] < 0) return tileset === 3 ? 0x158 : 2 * tileset + 0xf7;
  return v[1] ? v[0] + ((st.rng.next() >> 8) % v[1]) : v[0];
}

export class UiVoices {
  // seed: game seed; ext: Enhanced mode; tileset: g_Tileset
  constructor({ seed = 0, ext = false, tileset = 0, multiplayer = true } = {}) {
    this.ext = ext; this.tileset = tileset; this.multiplayer = multiplayer;
    this.st = Array.from({ length: 8 }, (_, p) => ({ lastUnit: 0, index: 0, timer: 0, throttle: 0, attack: 0, selCount: 0,
      rng: new LocalRng((seed ^ Math.imul(p + 1, 0x9e3779b1)) >>> 0) }));
    this.clockMs = 0;
    this.lastCmd = null;
  }
  // Snd_VoiceTimersTick every 100 ms of game time
  advanceTo(ms) {
    if (ms < this.clockMs) { this.clockMs = ms; return; }
    let n = Math.floor(ms / 100) - Math.floor(this.clockMs / 100);
    this.clockMs = ms;
    if (n <= 0) return;
    for (const s of this.st) { s.timer = Math.max(0, s.timer - n); s.throttle = Math.max(0, s.throttle - n); s.attack = Math.max(0, s.attack - n); }
  }
  // Snd_PlaySelectVoice 0x423230 for player p (the local player of its own machine). Returns a sound id or 0.
  selectVoice(m, p, u) {
    const s = this.st[p];
    const owner = u ? m.r8(u + 0x2c) : -1;
    if (!u || (owner !== p && owner !== 15)) { s.lastUnit = 0; s.index = 0; s.selCount = 0; return 0; }
    if (s.lastUnit === u && s.timer !== 0) return 0;
    s.timer = 10;
    if (s.lastUnit !== u) { s.lastUnit = u; s.index = 0; s.selCount = 0; }
    const t = m.r8(u + 0x27), tf = m.r32(A.TypeFlags + 4 * t), bx = m.r32(u + 0x7c);
    if ((tf & UTF_Building) && bx && m.r8(bx + 0x34) === 0x14) return 0x3e;
    if (!(m.r16(u + 0x1e) & 0x80)) { s.timer = 30; s.throttle = 150; return 3; }
    if (t === UT.GoldMine) return 0x34;
    const rng = (a, b) => t >= a && t <= b;
    if (rng(UT.HumanShipyard, UT.OrcShipyard)) return 0x38;
    if (rng(UT.GryphonAviary, UT.DragonRoost)) return 0x3f;
    if (rng(UT.HumanFoundry, UT.OrcFoundry)) return 0x40;
    if (rng(UT.GnomishInventor, UT.GoblinAlchemist)) return 0x41;
    if (rng(UT.MageTower, UT.TempleOfTheDamned)) return 0x42;
    if (rng(UT.Farm, UT.PigFarm)) return 0x33;
    if (rng(UT.HumanBlacksmith, UT.OrcBlacksmith)) return 0x30;
    if (rng(UT.Church, UT.AltarOfStorms)) return 0x31;
    if (rng(UT.Stables, UT.OgreMound)) return 0x32;
    if (rng(UT.HumanOilPlatform, UT.OrcOilPlatform)) return 0x3a;
    if (rng(UT.HumanRefinery, UT.OrcRefinery)) return 0x3b;
    if (tf & UTF_StoresLumber) return 0x3c;
    if (t === UT.Critter && ++s.selCount === 10) {
      s.selCount = 0;
      // single player: the critter explodes (sim effect, never in a multiplayer replay)
      return this.tileset === 3 ? 0x158 : 2 * this.tileset + 0xf7;
    }
    if (t < UT.Farm) {
      const k = Math.max(0, s.index - 2);
      s.index++;
      return pickSelectVoice(s, t, k, this.tileset);
    }
    return 0x26;
  }
  // Snd_PlaySelectAck 0x4231a0
  ackVoice(m, p, u) {
    const s = this.st[p];
    s.lastUnit = 0;
    if (!u || m.r8(u + 0x2c) !== p) return 0;
    return pickAckVoice(s, m.r8(u + 0x27), this.tileset);
  }
  // One turn's hook events (arena m = after the turn). Returns { sounds: [{player, id, unit, kind}], messages:
  // [{to: mask of players, text, tick}] }. recorder = g_LocalPlayer of the replay (its own status messages).
  handle(events, m, tickMs, recorder, names = []) {
    const sounds = [], messages = [];
    const unitsBase = m.r32(A.Units), unitCap = m.r32(A.UnitCount);
    const unitOf = id => id < unitCap ? unitsBase + 0x98 * id : 0;
    let prev = null;
    for (const e of events) {
      this.advanceTo(e.tick * tickMs);
      switch (e.kind) {
        case HK.CMD: {
          const p = e.a & 0xff, type = (e.a >>> 8) & 0xff;
          if (p > 7) break;
          if (type === 0x1b) {                                  // select
            const n = e.c & 0xff;
            if (n === 1 || (this.ext && n > 1)) {
              const u = unitOf((e.c >>> 16) & 0xffff);
              const id = this.selectVoice(m, p, u);
              if (id) sounds.push({ player: p, id, unit: u, kind: 'select', tick: e.tick });
            }
          } else if (type === 0x2b && (e.c & 0xff) === 1) {     // control group recall (Group_RecallLocal: voice)
            const sel = selectionOf(m, p);
            if (sel.length === 1 || (this.ext && sel.length > 1)) {
              const id = this.selectVoice(m, p, sel[0]);
              if (id) sounds.push({ player: p, id, unit: sel[0], kind: 'select', tick: e.tick });
            }
          } else if (type === 0x1f || type === 0x28) {          // order at cursor / right click
            const u = m.r32(G.Selection + 36 * p);
            const id = this.ackVoice(m, p, u);
            if (id) sounds.push({ player: p, id, unit: u, kind: 'ack', tick: e.tick });
          } else if (type === 0x23) {                           // chat: [8] recipient mask, [9] colour/sender, [0xa] text
            const mask = e.c & 0xff, kind = (e.c >>> 8) & 0xff, pkt = e.b;
            if (m.r8(pkt + 6) === 0x23) {
              const text = m.cstr(pkt + 0xa, 0x80);
              const who = kind < 8 ? (names[kind] || `Player ${kind + 1}`) : '';
              messages.push({ to: mask, text: who ? `${who}: ${text}` : text, tick: e.tick, kind: 'chat' });
            }
          }
          break;
        }
        case HK.VOICE_ACK: {                                    // the sim's Snd_PlaySelectAck (build orders)
          const p = e.c & 0xff;
          if (p > 7) break;
          const id = this.ackVoice(m, p, e.a);
          if (id) sounds.push({ player: p, id, unit: e.a, kind: 'ack', tick: e.tick });
          break;
        }
        case HK.SOUND: {
          if (!(e.d & HKS_OTHER) || !e.b) break;
          const p = m.r8(e.b + 0x2c);
          if (p > 7) break;
          const id = e.a & 0xffff;
          if (id === 0x19 || id === 0x1a) {                     // attack voice, g_VoiceAttackTimer 0x3c
            if (this.st[p].attack) break;
            this.st[p].attack = 0x3c;
          }
          sounds.push({ player: p, id, unit: e.b, kind: 'notify', tick: e.tick });
          break;
        }
        case HK.STATUS_MSG: case HK.MSG_TIMED: {
          if (e.kind === HK.STATUS_MSG && (e.d & 0x100)) {   // HKM_OTHER: another player's own error message
            messages.push({ to: 1 << (e.d & 7), text: m.cstr(e.a, 120), tick: e.tick, kind: 'status' });
            break;
          }
          const pc = prev && prev.kind === HK.CMD ? (prev.a >>> 8) & 0xff : -1;
          if (pc === 0x23) break;                               // chat: produced from the packet for every recipient
          const text = m.cstr(e.a, 120);
          const toAll = pc === 0x04 || pc === 0x10;             // "player has left": everybody saw it
          messages.push({ to: toAll ? 0xff : (1 << recorder), text, tick: e.tick, kind: 'status' });
          break;
        }
        default: break;
      }
      prev = e;
    }
    return { sounds, messages };
  }
}

// ---------------------------------------------------------------- camera
export class PlayerCamera {
  constructor() { this.x = 0; this.y = 0; this.follow = true; this.placed = false; this.player = -1; }
  reset() { this.placed = false; this.follow = true; }
  // the point to look at (map pixels) or null
  target(m, p, w = MAP_RECT.w, h = MAP_RECT.h) {
    const sel = selectionOf(m, p).filter(u => !(m.r16(u + 0x1e) & 8));
    if (sel.length) {
      const box = sel.map(u => {
        const t = m.r8(u + 0x27), sw = 32 * m.r16(A.TypeSize + 4 * t), sh = 32 * m.r16(A.TypeSize + 4 * t + 2);
        const x = m.s16(u), y = m.s16(u + 2);
        return [x, y, x + sw, y + sh];
      });
      const x0 = Math.min(...box.map(b => b[0])), y0 = Math.min(...box.map(b => b[1]));
      const x1 = Math.max(...box.map(b => b[2])), y1 = Math.max(...box.map(b => b[3]));
      if (x1 - x0 <= w - 64 && y1 - y0 <= h - 64) return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      const b = box[0];
      return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
    }
    return null;
  }
  home(m, p) {
    const own = readUnits(m).filter(u => u.owner === p);
    const halls = [0x4a, 0x4b, 0x58, 0x59, 0x5a, 0x5b];
    const u = own.find(u => halls.includes(u.type)) || own.find(u => u.tflags & UTF_Building) || own[0];
    return u ? { x: u.x + 16 * u.w, y: u.y + 16 * u.h } : null;
  }
  clamp(m, w = MAP_RECT.w, h = MAP_RECT.h) {
    const M = 32 * m.r16(A.MapSize);
    this.x = Math.max(0, Math.min(Math.max(0, M - w), this.x));
    this.y = Math.max(0, Math.min(Math.max(0, M - h), this.y));
  }
  // dtMs: wall time since the last frame (0 = jump). Returns the integer viewport origin.
  update(m, p, dtMs, w = MAP_RECT.w, h = MAP_RECT.h) {
    if (p !== this.player) { this.player = p; this.placed = false; }
    let t = this.follow ? this.target(m, p, w, h) : null;
    if (!this.placed) { t = t || this.home(m, p); if (t) { this.x = t.x - w / 2; this.y = t.y - h / 2; this.placed = true; } }
    else if (t) {
      const tx = t.x - w / 2, ty = t.y - h / 2;
      const k = dtMs <= 0 ? 1 : 1 - Math.exp(-dtMs / 120);
      const dx = tx - this.x, dy = ty - this.y;
      this.x += dx * k; this.y += dy * k;
      if (Math.abs(tx - this.x) < 0.5 && Math.abs(ty - this.y) < 0.5) { this.x = tx; this.y = ty; }
    }
    this.clamp(m, w, h);
    return { x: Math.round(this.x), y: Math.round(this.y) };
  }
  centreOn(m, px, py, w = MAP_RECT.w, h = MAP_RECT.h) { this.x = px - w / 2; this.y = py - h / 2; this.placed = true; this.clamp(m, w, h); }
}

// ---------------------------------------------------------------- art
const RAW = b => b && b.length >= 4 ? { w: b[0] | b[1] << 8, h: b[2] | b[3] << 8, pix: b.subarray(4) } : null;
export function loadPlayerUiArt(getFile) {
  const g = n => { try { return getFile(n) || null; } catch { return null; } };
  const art = { race: {}, portraits: [], fonts: {} };
  for (const [r, c] of [[0, 'h'], [1, 'o']]) {
    const bmp = n => RAW(g(`art\\${c}_${n}.bmp`));
    const fr = g(`art\\${c}frame.grp`), frames = [];
    if (fr) { const grp = parseGrp(fr); for (let i = 0; i < grp.count; i++) { const f = grp.frames[i]; frames.push({ w: f.w, h: f.h, pix: fr.subarray(f.off, f.off + f.w * f.h) }); } }
    art.race[r] = { top: bmp('top'), btm: bmp('btm'), rgt: bmp('rgt'), lft0: bmp('lft0'), lft1: bmp('lft1'), lft2: bmp('lft2'), frames };
  }
  for (const n of ['portrait', 's_port', 'l_port', 'x_port']) { const b = g(`art\\unit\\portrait\\${n}.grp`); art.portraits.push(b ? parseGrp(b) : null); }
  const ic = g('art\\icons.grp'); art.resIcons = ic ? parseGrp(ic) : null;
  art.fonts = { f6: parseFont(g('art\\font6.fnt')), f10: parseFont(g('art\\font10x.fnt')), f12: parseFont(g('art\\font12x.fnt')) };
  art.statTxt = parseTbl(g('rez\\stat_txt.tbl'));
  art.dlg = { port: parseDialogBin(g('rez\\statport.bin')), btn: parseDialogBin(g('rez\\statbtn.bin')), f10: parseDialogBin(g('rez\\stat_f10.bin')),
    info: parseDialogBin(g('rez\\infobox.bin')), text: parseDialogBin(g('rez\\textbox.bin')) };
  art.ok = !!(art.race[0].top && art.race[1].top && art.race[0].frames.length && art.fonts.f10 && art.dlg.port && art.dlg.btn && art.portraits[0]);
  return art;
}

// ---------------------------------------------------------------- command buttons (Ui_UpdateCommandButtons)
export function commandButtons(m, p, sel) {
  if (!sel.length) return [];
  const prim = sel[0];
  if (m.r8(prim + 0x2c) !== p) return [];
  const race = m.r8(A.PlayerRace + p) === 1 ? 1 : 0;
  const mixed = sel.some(u => m.r8(u + 0x25) !== m.r8(prim + 0x25));
  const setType = mixed ? 0x76 + race : m.r8(prim + 0x25);
  const cnt = m.r16(G.ButtonSets + 8 * setType), tab = m.r32(G.ButtonSets + 8 * setType + 4);
  if (!cnt || !tab) return [];
  const ov = new Map();
  const put32 = (a, v) => { for (let i = 0; i < 4; i++) ov.set(a + i, (v >>> (8 * i)) & 0xff); };
  ov.set(A.LocalPlayer, p); ov.set(G.LocalRace, race); ov.set(G.UiSelCount, sel.length);
  put32(G.UiSelPrimary, prim);
  for (let k = 0; k < 9; k++) put32(G.UiSelection + 4 * k, sel[k] || 0);
  const out = [];
  let i = 0;
  for (let ctrl = 0; ctrl < 9; ctrl++) {
    while (i < cnt) {
      const e = tab + 20 * i, fn = m.r32(e + 4);
      const ok = tryPredicate(m, fn, [m.r8(e + 12)], ov);
      if (ok === null ? true : (ok & 0xff) !== 0) break;      // unknown: shown (approximation)
      i++;
    }
    if (i < cnt && m.r16(tab + 20 * i) <= ctrl) { out.push({ slot: ctrl, icon: m.r16(tab + 20 * i + 2) }); i++; }
  }
  return out;
}

// ---------------------------------------------------------------- frame renderer
const TEXT_IDX = [0, 200, 199, 197, 0xc0, 0xef];                 // Pal_SetupGamePalette text colours (set 2)
const LABEL_IDX = [0, 0xf6, 0xf6, 0x6c, 0x68, 0xef];
const stripCodes = s => s.replace(/[\x00-\x1f]/g, '');

export class PlayerFrame {
  // art: loadPlayerUiArt(); palette: 768-byte RGB (8-bit) of the tileset (st.tileset.palette-like); createCanvas(w,h)
  constructor({ art, rgb, createCanvas }) {
    this.art = art; this.rgb = rgb; this.createCanvas = createCanvas;
    this.canvas = createCanvas(FRAME_W, FRAME_H);
    this.mapCanvas = createCanvas(MAP_RECT.w, MAP_RECT.h);
    this.bgCache = new Map();
    this.iconCache = new Map();
    this.textCache = new Map();
    this.shown = null;                       // eased resource counters
    this.ramp = TEXT_IDX.map(i => rgb[i] || [255, 255, 255]);
    this.labelRamp = LABEL_IDX.map(i => rgb[i] || [200, 200, 200]);
  }
  col(i) { const c = this.rgb[i] || [0, 0, 0]; return c; }
  // static background per (race, status frame)
  background(race, frame) {
    const key = `${race}:${frame}`;
    if (this.bgCache.has(key)) return this.bgCache.get(key);
    const s = new Surface(FRAME_W, FRAME_H), R = this.art.race[race], pal = this.flatPal();
    const blit = (img, x, y) => { if (img) s.blitIndexed(img, pal, x, y); };
    blit(R.top, 176, 0); blit(R.btm, 176, 464); blit(R.rgt, 624, 0); blit(R.lft0, 0, 0); blit(R.lft1, 0, 24);
    blit(R.frames[frame] || R.frames[0], 0, STATUS_Y); blit(R.lft2, 0, BTN_Y);
    // Menu (F10) button of rez\stat_f10.bin (Classic: control id 1)
    const F = this.art.fonts, d = this.art.dlg.f10, c = d && d.byId(1);
    if (c) this.button(s, c.l, c.t, c.r - c.l + 1, c.b - c.t + 1, false), s.text(F.f10, stripCodes(c.text).replace('F10', 'F10'), c.l, c.t + 5, this.ramp, 'c', c.r - c.l + 1);
    this.bgCache.set(key, s);
    return s;
  }
  flatPal() {
    if (this._pal) return this._pal;
    const p = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { const c = this.rgb[i] || [0, 0, 0]; p[3 * i] = c[0]; p[3 * i + 1] = c[1]; p[3 * i + 2] = c[2]; }
    return (this._pal = p);
  }
  // raised bevel like the game's buttons (approximation of Ui_CtrlDrawButtonFace)
  button(s, x, y, w, h, pressed) {
    const hi = this.col(0x6c), lo = this.col(0xef), face = this.col(0x68);
    s.fill(x, y, w, h, [0, 0, 0], 0.35);
    const [a, b] = pressed ? [lo, hi] : [hi, lo];
    s.fill(x, y, w, 1, a); s.fill(x, y, 1, h, a); s.fill(x, y + h - 1, w, 1, b); s.fill(x + w - 1, y, 1, h, b);
    s.fill(x + 1, y + h - 2, w - 2, 1, face, 0.5); s.fill(x + w - 2, y + 1, 1, h - 2, face, 0.5);
  }
  icon(s, tileset, idx, x, y, colorBase) {
    const grp = this.art.portraits[tileset] || this.art.portraits[0];
    if (!grp || idx >= grp.count) return;
    const key = `${tileset}:${idx}:${colorBase}`;
    let d = this.iconCache.get(key);
    if (!d) { d = decodeFrameIndices(grp, idx); this.iconCache.set(key, d); }
    const f = grp.frames[idx], pal = this.flatPal(), out = s.data;
    for (let j = 0; j < d.h; j++) for (let i = 0; i < d.w; i++) {
      const k = j * d.w + i; if (!d.mask[k]) continue;
      let v = d.idx[k]; if (v >= 0xd0 && v <= 0xd3) v = colorBase + v - 0xd0;
      const tx = x + f.x + i, ty = y + f.y + j; if (tx < 0 || ty < 0 || tx >= s.w || ty >= s.h) continue;
      const o = 4 * (ty * s.w + tx); out[o] = pal[3 * v]; out[o + 1] = pal[3 * v + 1]; out[o + 2] = pal[3 * v + 2]; out[o + 3] = 255;
    }
  }
  // Art\icons.grp holds raw (uncompressed) 14x14 frames, blitted with colour 0 transparent (Gfx_BlitBitmapTransparent)
  resIcon(s, frame, x, y) {
    const grp = this.art.resIcons; if (!grp || frame >= grp.count) return;
    const f = grp.frames[frame], b = grp.bytes, pal = this.flatPal();
    for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
      const v = b[f.off + j * f.w + i]; if (!v) continue;
      const tx = x + f.x + i, ty = y + f.y + j, o = 4 * (ty * s.w + tx);
      s.data[o] = pal[3 * v]; s.data[o + 1] = pal[3 * v + 1]; s.data[o + 2] = pal[3 * v + 2]; s.data[o + 3] = 255;
    }
  }
  hpBar(s, x, y, w, h, f) {
    s.fill(x, y, w, h, [0, 0, 0]);
    const c = f > 0.5 ? [0, 196, 0] : f > 0.25 ? [228, 200, 0] : [228, 0, 0];
    s.fill(x + 1, y + 1, Math.max(0, Math.round((w - 2) * f)), h - 2, c);
  }
  // Ui_AnimateResourceCounters: each shown counter moves by diff/16 +-1 per UI frame
  animateCounters(vals, frames = 1) {
    if (!this.shown || frames < 0) { this.shown = vals.slice(); return; }
    for (let k = 0; k < Math.min(frames, 64); k++) for (let i = 0; i < vals.length; i++) {
      const d = vals[i] - this.shown[i];
      if (d) this.shown[i] += Math.trunc(d / 16) + (d > 0 ? 1 : -1);
    }
  }
  // Render the whole frame. o: { m, p, tileset, renderer, fog, view:{x,y}, selection, messages, nowTick, tickMs }
  render(o) {
    const { m, p } = o, art = this.art, F = art.fonts;
    const race = m.r8(A.PlayerRace + p) === 1 ? 1 : 0, tileset = m.r8(A.Tileset) & 3;
    const sel = o.selection, prim = sel[0] || 0, colorBase = m.r8(A.PlayerColor + p);
    // status frame (Ui_DrawStatusPanel): own single unit -> type table frame (3 if producing / building)
    let frame = 0;
    if (sel.length === 1 && m.r8(prim + 0x2c) === p) {
      const t = m.r8(prim + 0x27), tf = m.r32(A.TypeFlags + 4 * t);
      const idle = (tf & UTF_Building) && ((m.r8(prim + 0x1c) & 0x10) || !(m.r16(prim + 0x1e) & 0x80));
      if (idle) frame = 3;
      else { frame = t < 110 ? m.r16(G.StatusTable + 16 * t + 2) : 1; if (frame === 3 && !(m.r8(prim + 0x1c) & 0x10)) frame = 1; }
    }
    const s = this.surf || (this.surf = new Surface(FRAME_W, FRAME_H));   // reused every frame
    s.data.set(this.background(race, frame).data);

    // ---- resource bar (rez\infobox.bin at 176,0): gold, lumber, oil, food
    const vals = [m.r32(A.Gold + 4 * p), m.r32(A.Lumber + 4 * p), m.r32(A.Oil + 4 * p)];
    this.animateCounters(vals, o.counterFrames == null ? -1 : o.counterFrames);
    const info = art.dlg.info;
    if (info) for (let id = 1; id <= 4; id++) {
      const c = info.byId(id); if (!c) continue;
      const x = info.dlg.l + c.l, y = info.dlg.t + c.t;
      const ty = Math.trunc((c.t + c.b) / 2) + 2 - 5;
      this.resIcon(s, id === 4 ? 4 : id - 1, x, y + 1);
      let txt;
      if (id === 4) txt = `${m.r16(G.UnitCountP + 2 * p)}/${Math.min(200, m.r16(G.FoodSupply + 2 * p))}`;
      else { const v = this.shown[id - 1]; txt = v < 1000000 ? String(v) : '*TONS*'; }
      s.text(F.f10, txt, x + 0x12, info.dlg.t + ty, this.ramp);
    }

    // ---- status panel (rez\statport.bin at 0,160)
    const port = art.dlg.port, px = port.dlg.l, py = port.dlg.t;
    const ctrl = id => port.byId(id);
    const at = (c, f) => ({ x: px + c.l, y: py + c.t, w: c.r - c.l + 1, h: c.b - c.t + 1 });
    const iconOf = u => { const t = m.r8(u + 0x27); return t < 110 ? m.r16(G.StatusTable + 16 * t) : 0; };
    if (sel.length === 1) {
      const u = prim, t = m.r8(u + 0x27), tf = m.r32(A.TypeFlags + 4 * t), own = m.r8(u + 0x2c) === p;
      const c0 = at(ctrl(0));
      this.button(s, c0.x, c0.y, c0.w, c0.h, false);
      this.icon(s, tileset, iconOf(u), c0.x + 4, c0.y + 4, colorBase);
      const hp = m.r16(u + 0x22), mhp = m.r16(A.TypeMaxHp + 2 * t);
      const ch = ctrl(-20);
      if (ch && mhp) { const r = at(ch); this.hpBar(s, c0.x + 4, c0.y + 43, 46, 5, Math.min(1, hp / mhp)); s.text(F.f6 || F.f10, `${hp}/${mhp}`, r.x, r.y + 1, this.ramp, 'c', r.w); }
      const name = art.statTxt(t + 2) || '';   // stat_txt.tbl: unit names from id 2
      const cn = ctrl(-5); if (cn) { const r = at(cn); s.text(F.f10, s.fitText(F.f10, name, r.w), r.x, r.y + 2, this.ramp, 'c', r.w); }
      const constructing = (tf & UTF_Building) && !(m.r16(u + 0x1e) & 0x80);
      const producing = (tf & UTF_Building) && (m.r8(u + 0x1c) & 0x10);
      if (own && (constructing || producing)) {
        const cb = ctrl(-4);
        if (cb) {
          const r = at(cb), f = Math.min(1, m.r8(u + 0x26) / 255);
          s.fill(r.x + 1, r.y + 1, Math.round((r.w - 2) * f), r.h - 2, this.col(0xbe) || [0, 160, 0]);
          s.text(F.f10, stripCodes(art.statTxt(434)), r.x, r.y + 2, this.ramp, 'c', r.w);
        }
        if (producing) {
          const kind = m.r8(u + 0x6c), pid = m.r8(u + 0x6d), cp = ctrl(100);
          const icon = kind === 0 || kind === 3 ? (pid < 110 ? m.r16(G.StatusTable + 16 * pid) : 0) : m.r16(G.UpgradeIcon + 2 * pid);
          if (cp) { const r = at(cp); this.button(s, r.x, r.y, r.w, r.h, false); this.icon(s, tileset, icon, r.x + 4, r.y + 4, colorBase); }
          const lbl = art.statTxt([422, 423, 425, 423][kind] || 422);
          const c6 = ctrl(-6); if (c6) { const r = at(c6); s.text(F.f10, stripCodes(lbl), r.x, r.y + 2, this.labelRamp, 'c', r.w); }
        }
      } else if (own && !(tf & UTF_Building)) {
        // stats (Ui_StatusShowUnitInfo2 0x445ba0): Armor, Damage (min = max(0,(basic-30)/2) + (piercing+1)/2), Range, Sight, Magic
        const basic = m.r8(G.BasicDmg + t), pierce = m.r8(G.PiercingDmg + t);
        const dmin = Math.max(0, Math.trunc((basic - 30) / 2)) + Math.trunc((pierce + 1) / 2), dmax = basic + pierce;
        const rows = [[412, String(m.r8(G.Armor + t))], [413, dmin === dmax ? String(dmax) : `${dmin}-${dmax}`],
          [414, String(m.r8(G.AttackRange + t))], [415, String(sightOf(m, t))]];
        if (m.r32(A.TypeFlags + 4 * t) & 0x20000) rows.push([417, String(m.r8(u + 0x26))]);
        rows.forEach(([lid, val], i) => {
          const cl = ctrl(-8 - (i === 4 ? 5 : i)), cv = ctrl(-21 - (i === 4 ? 5 : i));
          if (cl) { const r = at(cl); s.text(F.f10, stripCodes(art.statTxt(lid)), r.x, r.y + 2, this.ramp, 'r', r.w); }
          if (cv) { const r = at(cv); s.text(F.f10, val, r.x, r.y + 2, this.ramp, 'l', r.w); }
        });
      }
    } else if (sel.length > 1) {
      sel.slice(0, 9).forEach((u, k) => {
        const c = ctrl(k); if (!c) return;
        const r = at(c), t = m.r8(u + 0x27), mhp = m.r16(A.TypeMaxHp + 2 * t);
        this.button(s, r.x, r.y, r.w, r.h, false);
        this.icon(s, tileset, iconOf(u), r.x + 4, r.y + 4, colorBase);
        if (mhp) this.hpBar(s, r.x + 4, r.y + 44, 46, 5, Math.min(1, m.r16(u + 0x22) / mhp));
      });
    }

    // ---- command buttons (rez\statbtn.bin at 0,336)
    const bd = art.dlg.btn;
    if (bd) for (const b of commandButtons(m, p, sel)) {
      const c = bd.byId(b.slot); if (!c) continue;
      const x = bd.dlg.l + c.l, y = bd.dlg.t + c.t;
      this.button(s, x, y, c.r - c.l + 1, c.b - c.t + 1, false);
      this.icon(s, tileset, b.icon, x + 4, y + 4, colorBase);
    }

    const ctx = this.canvas.getContext('2d');
    if (!this.img) this.img = ctx.createImageData(FRAME_W, FRAME_H);
    this.img.data.set(s.data);
    ctx.putImageData(this.img, 0, 0);

    // ---- map viewport, minimap
    const R = o.renderer, mc = this.mapCanvas, mctx = mc.getContext('2d');
    const showHp = R.showHp, fp = R.fogPlayer;
    R.showHp = false; R.fogPlayer = p;
    R.draw(mctx, MAP_RECT.w, MAP_RECT.h, { x: o.view.x, y: o.view.y, scale: 1 }, m, o.fog);
    R.drawSelection(mctx, { x: o.view.x, y: o.view.y, scale: 1 }, m, p, sel, MAP_RECT.w, MAP_RECT.h);
    const mini = R.drawMinimap(m, o.fog);
    R.showHp = showHp; R.fogPlayer = fp;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mc, 0, 0, MAP_RECT.w, MAP_RECT.h, MAP_RECT.x, MAP_RECT.y, MAP_RECT.w, MAP_RECT.h);
    const n = mini.width;
    ctx.drawImage(mini, 0, 0, n, n, MINI_RECT.x, MINI_RECT.y, MINI_RECT.w, MINI_RECT.h);
    // minimap view rectangle (g_UiHighlightColor)
    const k = MINI_RECT.w / (32 * n), hl = this.col(0xc8);
    ctx.fillStyle = `rgb(${hl[0]},${hl[1]},${hl[2]})`;
    const rx = MINI_RECT.x + Math.round(o.view.x * k), ry = MINI_RECT.y + Math.round(o.view.y * k);
    const rw = Math.max(2, Math.round(MAP_RECT.w * k)), rh = Math.max(2, Math.round(MAP_RECT.h * k));
    ctx.fillRect(rx, ry, rw, 1); ctx.fillRect(rx, ry + rh - 1, rw, 1); ctx.fillRect(rx, ry, 1, rh); ctx.fillRect(rx + rw - 1, ry, 1, rh);

    // ---- messages (top left of the map, newest last) as an overlay
    const msgs = o.messages || [];
    if (msgs.length) {
      const key = msgs.map(x => x.text).join('\n');
      let ov = this.textCache.get(key);
      if (!ov) {
        const os = new Surface(MAP_RECT.w, 14 * msgs.length + 4);
        msgs.forEach((x, i) => os.text(F.f10, os.fitText(F.f10, stripCodes(x.text), MAP_RECT.w - 8), 4, 2 + 14 * i, this.ramp));
        const c = this.createCanvas(os.w, os.h), cx = c.getContext('2d'), id = cx.createImageData(os.w, os.h);
        id.data.set(os.data); cx.putImageData(id, 0, 0);
        ov = c; this.textCache.clear(); this.textCache.set(key, ov);
      }
      ctx.drawImage(ov, 0, 0, ov.width, ov.height, MAP_RECT.x, MAP_RECT.y + 2, ov.width, ov.height);
    }
    return this.canvas;
  }
}
// Sight radius shown in the status panel: the index of g_UnitTypeSightFn in the Fog_RevealSight table 0x496920.
function sightOf(m, t) {
  const fn = m.r32(A.TypeSightFn + 4 * t);
  for (let i = 0; i < 16; i++) if (m.r32(0x496920 + 4 * i) === fn) return Math.max(1, i);   // [0] and [1] are both sight 1
  return 0;
}

// Messages currently up for player p (Ui_ShowStatusMessage keeps them ~7 s; the game shows the last few).
export function visibleMessages(list, p, tick, tickMs, max = 5) {
  const ms = 7000 / tickMs;
  return list.filter(x => (x.to & (1 << p)) && tick - x.tick < ms && tick >= x.tick).slice(-max);
}
