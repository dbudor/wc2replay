// Click-to-inspect: the unit / building under the pointer and its stats, read from the arena (presentation only).
//
// What the game's status panel shows (Ui_StatusPanel per-type table 0x4a3d58 {u16 icon, u16 frame, fn redraw,
// fn info}; labels rez\stat_txt.tbl 411..434), with every value as the sim computes it, for any owner (the game
// shows the full panel only for g_LocalPlayer's units):
//   units (Ui_StatusShowUnitInfo2 0x445ba0; archers 0x446b80, ships 0x447840 differ only in the upgrade used):
//     Armor   g_UnitTypeArmor 0x4cf974 (+ armor lvl x 2, ships: ship armor lvl x 5; Unit_GetArmor 0x418250)
//     Damage  basic 0x4cf6dc / piercing 0x4ceb5c shown as max(0,(basic-30)/2)+(piercing+1)/2 - basic+piercing,
//             + the upgrade bonus (Unit_GetBasicDamage 0x4180d0 / Unit_GetPiercingDamage 0x4181b0 without
//             bloodlust: melee x 2, missile x 1, ship x 5, siege x 15; marksmanship moves basic into piercing)
//     Range   g_UnitTypeAttackRange 0x4cfef0 (+1 longbow: Unit_GetSightRange 0x453480)
//     Sight   index of g_UnitTypeSightFn 0x4cf7bc in Fog_RevealSight 0x496920 (scouting: 9, Unit_GetSightFn 0x453430)
//     Speed   0x4bb824[type]; Magic = mana (+0x26) of casters (UTF_Caster)
//   gold mine / oil patch, platform (0x448250 / 0x44a3c0): Gold Left / Oil Left = +0x82 x 100
//   farm (0x447d30): Food Usage, Grown = food supply (capped 200 in Enhanced), Used = units - summoned (0x4adefc)
//   town hall .. castle (0x448830): Production Gold 100 (+10 keep, +20 castle), Lumber 100 (+25 mill),
//     Oil 100 (+25 refinery) -- Unit_DepositResources 0x424350
//   construction (flags & 0x80 clear; Unit_UpdateConstruction 0x452730): "% Complete" = +0x26 / 255,
//     counter +0x84 to (build time 0x4cfe80 x 3 + 3) x 4 ticks
//   production (+0x1c & 0x10; Unit_ProductionTick 0x40e1e0): kind +0x6c (0 train, 1 spell, 2 upgrade, 3 building
//     upgrade), id +0x6d, progress +0x6e of time +0x70 steps; the production order runs on the building's anim
//     wait (+0x07), one step per 5 ticks (4 and 6 alternating; measured on game1, test_unitinfo.mjs)
//   timers: invisibility +0x44, unholy armour +0x46, bloodlust +0x48, haste (>0) / slow (<0) +0x4a, flame
//     shield +0x4e (ticks); workers' load +0x75 (0x20 carrying: 0x80 gold, 0x40 lumber; tankers: oil); transport
//     cargo +0x70 u16[6] unit ids (-1 empty).
import { A, UNIT_NAMES } from './gamestate.js';

const T = { Armor: 0x4cf974, Basic: 0x4cf6dc, Pierce: 0x4ceb5c, Range: 0x4cfef0, Speed: 0x4bb824, BuildTime: 0x4cfe80,
  WeaponsUpg: 0x4ce9d0, ArmorUpg: 0x4cebcc };
const UPG = { Melee: 0x4ace54, Missile: 0x4abd40, Armor: 0x4abee8, ShipWeapon: 0x4ace44, ShipArmor: 0x4abb30, Siege: 0x4abd18,
  Longbow: 0x4ab968, Scouting: 0x4acb8c, Marksmanship: 0x4acc14 };
const MULT = { Missile: 0x4958d8, Melee: 0x4958d9, Armor: 0x4958da, ShipWeapon: 0x4958db, ShipArmor: 0x4958dc, Siege: 0x4958de };
const CNT = { LumberMill: 0x4ad9fc, Castle: 0x4adc7c, Keep: 0x4ade9c, Summoned: 0x4adefc, Refinery: 0x4adf3c };
const UTF = { Siege: 4, Naval: 8, Building: 0x20, Worker: 0x100, Tanker: 0x200, Transport: 0x400, OilPlatform: 0x800,
  Caster: 0x20000, OilPatch: 0x200000, GoldMine: 0x400000 };
const RANGER = 0x12, BERSERKER = 0x13, FARMS = [0x3a, 0x3b], HALLS = [0x4a, 0x4b, 0x58, 0x59, 0x5a, 0x5b];
const PROD_TICKS_PER_STEP = 5;
const IS_MISSILE_INF = t => t === 8 || t === 9 || t === RANGER || t === BERSERKER;

// sim/gen/w2types.h ACT_* / UPG_*
export const ORDER_NAMES = ['Destroy', 'Dying', 'Stand', 'Move', 'Attack-move', 'Patrol', 'Follow', 'Follow & guard', 'Attack',
  'Attack unit', 'Attack position', 'Attack wall', 'Attack target', 'Stand ground', 'Tower guard', 'Stand ground (attack)',
  'Auto-attack', 'Attack ground', 'Attack ground (approach)', 'Demolish', 'Demolish target', 'Demolish ground', 'Halt',
  'Harvest', 'Return goods', 'In depot', 'Leave depot', 'Repair', 'Build', 'Unload', 'Unload (step)', 'Unload (find spot)',
  'Stand at coast', 'Idle', 'Board transport', '?', '-', 'Production', 'Holy Vision', 'Healing', '?', 'Exorcism',
  'Flame Shield', 'Fireball', 'Slow', 'Invisibility', 'Polymorph', 'Blizzard', 'Eye of Kilrogg', 'Bloodlust', 'Raise Dead',
  'Death Coil', 'Whirlwind', 'Haste', 'Unholy Armor', 'Runes', 'Death and Decay', '-', '?', 'Circle of Power', 'none'];
export const UPGRADE_NAMES = ['Swords 1', 'Swords 2', 'Axes 1', 'Axes 2', 'Arrows 1', 'Arrows 2', 'Spears 1', 'Spears 2',
  'Shields 1', 'Shields 2', 'Shields 1', 'Shields 2', 'Ship Cannons 1', 'Ship Cannons 2', 'Ship Cannons 1', 'Ship Cannons 2',
  'Ship Armor 1', 'Ship Armor 2', 'Ship Armor 1', 'Ship Armor 2', 'Catapults 1', 'Catapults 2', 'Ballistas 1', 'Ballistas 2',
  'Ranger training', 'Longbow', 'Ranger scouting', 'Marksmanship', 'Berserker training', 'Lighter axes', 'Berserker scouting',
  'Regeneration', 'Ogre Mage training', 'Paladin training', 'Holy Vision', 'Healing', 'Exorcism', 'Flame Shield', 'Fireball',
  'Slow', 'Invisibility', 'Polymorph', 'Blizzard', 'Eye of Kilrogg', 'Bloodlust', 'Raise Dead', 'Death Coil', 'Whirlwind',
  'Haste', 'Unholy Armor', 'Runes', 'Death and Decay'];

const typeName = (t, tbl) => (tbl && tbl(t + 2)) || (UNIT_NAMES[t] || `type ${t}`).replace(/([a-z])([A-Z])/g, '$1 $2');
const fmt = (ticks, tickMs) => { const s = Math.max(0, Math.round(ticks * tickMs / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const plus = n => n > 0 ? ` +${n}` : n < 0 ? ` ${n}` : '';

// The unit under map pixel (px, py), as drawn (type box at the footprint centre, Gfx_DrawSpriteClipped_2):
// units before buildings, then the smallest box. visible(u) filters by the fog player (null: all).
export function pickUnit(m, px, py, visible = null) {
  const base = m.r32(A.Units), n = m.r32(A.UnitCount);
  let best = null, bestKey = Infinity;
  for (let i = 0; i < n; i++) {
    const u = base + 0x98 * i, f = m.r16(u + 0x1e);
    if (f & 0xd) continue;                          // free, dead, contained
    const t = m.r8(u + 0x27);
    if (t >= 110) continue;
    const bw = (m.r16(A.TypeBox + 4 * t) << 16) >> 16, bh = (m.r16(A.TypeBox + 4 * t + 2) << 16) >> 16;
    const cx = m.s16(u) + 16 * m.r16(A.TypeSize + 4 * t), cy = m.s16(u + 2) + 16 * m.r16(A.TypeSize + 4 * t + 2);
    if (Math.abs(px - cx) > bw / 2 + 2 || Math.abs(py - cy) > bh / 2 + 2) continue;
    if (visible && !visible(u)) continue;
    const key = (m.r32(A.TypeFlags + 4 * t) & UTF.Building ? 1e6 : 0) + bw * bh;
    if (key < bestKey) { bestKey = key; best = u; }
  }
  return best;
}
// a reference that notices the slot being reused: { addr, serial }
export const unitRef = (m, u) => u ? { addr: u, serial: m.r32(u + 0x14) } : null;
export function refAlive(m, r) {
  if (!r) return 'none';
  const f = m.r16(r.addr + 0x1e);
  if ((f & 1) || m.r32(r.addr + 0x14) !== r.serial) return 'gone';
  return f & 2 ? 'dead' : 'ok';
}

function sightIndex(m, fn) {
  for (let i = 0; i < 16; i++) if (m.r32(0x496920 + 4 * i) === fn) return Math.max(1, i);   // [0] and [1] are both sight 1
  return 0;
}

// Everything the panel shows. o: { tbl (stat_txt.tbl lookup), tickMs, names[player], extended }
// -> { name, owner, ownerName, hp, maxHp, rows: [[label, value]], bars: [{ label, frac, text }], notes: [] }
export function unitInfo(m, u, o = {}) {
  const t = m.r8(u + 0x27), tf = m.r32(A.TypeFlags + 4 * t), own = m.r8(u + 0x2c), f = m.r16(u + 0x1e);
  const L = (id, d) => ((o.tbl && o.tbl(id)) || d).replace(/[\x00-\x1f]/g, '').trim().replace(/:$/, '');
  const tickMs = o.tickMs || 26.67, ext = !!o.extended;
  const info = { name: typeName(t, o.tbl), type: t, owner: own, ownerName: (o.names && o.names[own]) || (own < 8 ? `Player ${own + 1}` : 'Neutral'),
    hp: m.r16(u + 0x22), maxHp: m.r16(A.TypeMaxHp + 2 * t), rows: [], bars: [], notes: [] };
  const row = (k, v) => info.rows.push([k, String(v)]);
  const lvl = (a) => m.r8(a + own);
  const building = !!(tf & UTF.Building), built = !!(f & 0x80);
  if (f & 2) info.notes.push('dead');

  // ---- combat stats (units, and buildings that fight: towers)
  const basic = m.r8(T.Basic + t), pierce = m.r8(T.Pierce + t);
  if (!building || basic + pierce > 0) {
    let armor = m.r8(T.Armor + t);
    const armorUp = m.r8(T.ArmorUpg + t) ? (tf & UTF.Naval ? lvl(UPG.ShipArmor) * m.r8(MULT.ShipArmor) : lvl(UPG.Armor) * m.r8(MULT.Armor)) : 0;
    row(L(412, 'Armor'), `${armor}${plus(armorUp)}`);
    if (basic + pierce > 0) {
      let b = basic, p = pierce;
      if (m.r8(T.WeaponsUpg + t)) {
        if (tf & UTF.Naval) b += lvl(UPG.ShipWeapon) * m.r8(MULT.ShipWeapon);
        else if (tf & UTF.Siege) b += lvl(UPG.Siege) * m.r8(MULT.Siege);
        else if (!IS_MISSILE_INF(t)) b += lvl(UPG.Melee) * m.r8(MULT.Melee);
      }
      if (IS_MISSILE_INF(t)) p += lvl(UPG.Missile) * m.r8(MULT.Missile);
      const dmin = Math.max(0, Math.trunc((basic - 30) / 2)) + Math.trunc((pierce + 1) / 2), dmax = basic + pierce;
      row(L(413, 'Damage'), `${dmin === dmax ? dmax : `${dmin}-${dmax}`}${plus(b + p - dmax)}`);
      const range = m.r8(T.Range + t), longbow = (t === RANGER || t === BERSERKER) && lvl(UPG.Longbow) ? 1 : 0;
      row(L(414, 'Range'), `${range}${plus(longbow)}`);
    }
  }
  if (!building || (built && basic + pierce > 0)) {
    const typeSight = sightIndex(m, m.r32(A.TypeSightFn + 4 * t));
    const unitSight = (t === RANGER || t === BERSERKER) && lvl(UPG.Scouting) ? 9 : typeSight;
    row(L(415, 'Sight'), `${typeSight}${plus(unitSight - typeSight)}`);
  }
  if (!building) row(L(416, 'Speed'), m.r8(T.Speed + t));
  if (tf & UTF.Caster) row(L(417, 'Magic'), m.r8(u + 0x26));

  if (!building) {
    // ---- order, load, cargo, spell timers
    const ord = m.r8(u + 0x2e);
    row('Order', ORDER_NAMES[ord] || `0x${ord.toString(16)}`);
    const tgt = m.r32(u + 0x88);
    if (tgt && !(tf & UTF.Transport) && ord !== 2 && ord !== 0x21) {
      const tt = m.r8(tgt + 0x27);
      if (tt < 110 && !(m.r16(tgt + 0x1e) & 1)) row('Target', typeName(tt, o.tbl));
    }
    const mf = m.r8(u + 0x75);
    if ((tf & UTF.Worker) && (mf & 0x20)) row('Carrying', mf & 0x80 ? '100 gold' : mf & 0x40 ? '100 lumber' : 'goods');
    if ((tf & UTF.Tanker) && (mf & 0x20)) row('Carrying', '100 oil');
    if (tf & UTF.Transport) {
      const base = m.r32(A.Units), cargo = [];
      for (let k = 0; k < 6; k++) { const id = m.r16(u + 0x70 + 2 * k); if (id !== 0xffff) cargo.push(typeName(m.r8(base + 0x98 * id + 0x27), o.tbl)); }
      row('Cargo', cargo.length ? cargo.join(', ') : 'empty');
    }
    const timer = (off, label) => { const v = m.r16(u + off); if (v) info.notes.push(`${label} ${fmt(v, tickMs)}`); };
    timer(0x44, 'invisible'); timer(0x46, 'unholy armor'); timer(0x48, 'bloodlust'); timer(0x4e, 'flame shield');
    const hs = m.s16(u + 0x4a); if (hs > 0) info.notes.push(`haste ${fmt(hs, tickMs)}`); else if (hs < 0) info.notes.push(`slow ${fmt(-hs, tickMs)}`);
    return info;
  }

  // ---- buildings
  if (!built) {
    const bt = Math.max(1, m.r8(T.BuildTime + t)), total = (bt * 3 + 3) * 4, cnt = (m.r16(u + 0x84) << 16) >> 16;
    const frac = Math.min(1, m.r8(u + 0x26) / 255);
    info.bars.push({ label: L(424, 'Building'), frac, text: `${Math.floor(frac * 100)}${L(434, '% Complete')}`, left: fmt(total - cnt, tickMs) });
  } else if (m.r8(u + 0x1c) & 0x10) {
    const kind = m.r8(u + 0x6c), id = m.r8(u + 0x6d), prog = m.r16(u + 0x6e), time = m.r16(u + 0x70) || 1;
    const what = kind === 0 || kind === 3 ? typeName(id, o.tbl) : UPGRADE_NAMES[id] || `#${id}`;
    const label = [L(422, 'Training'), L(425, 'Researching'), L(425, 'Researching'), L(423, 'Upgrading')][kind] || '?';
    info.bars.push({ label: `${label} ${what}`, frac: Math.min(1, prog / time), text: `${Math.floor(Math.min(1, prog / time) * 100)}${L(434, '% Complete')}`, left: fmt(PROD_TICKS_PER_STEP * (time - prog), tickMs) });
  }
  if (tf & UTF.GoldMine) row(L(426, 'Gold Left'), m.r16(u + 0x82) * 100);
  if (tf & (UTF.OilPatch | UTF.OilPlatform)) row(L(418, 'Oil Left'), m.r16(u + 0x82) * 100);
  if (built && FARMS.includes(t) && own < 8) {
    const grown = m.r16(A.FoodSupply + 2 * own), used = m.r16(A.UnitCountP + 2 * own) - m.r16(CNT.Summoned + 2 * own);
    row(`${L(419, 'Food Usage')}: ${L(420, 'Grown')}`, ext ? Math.min(200, grown) : grown);
    row(`${L(419, 'Food Usage')}: ${L(421, 'Used')}`, used);
  }
  if (built && HALLS.includes(t) && own < 8) {
    const c = a => m.r16(a + 2 * own);
    const gold = c(CNT.Castle) ? 20 : c(CNT.Keep) ? 10 : 0;
    row(`${L(427, 'Production')} ${L(428, 'Gold')}`, `100${plus(gold)}`);
    row(`${L(427, 'Production')} ${L(429, 'Lumber')}`, `100${plus(c(CNT.LumberMill) ? 25 : 0)}`);
    row(`${L(427, 'Production')} ${L(430, 'Oil')}`, `100${plus(c(CNT.Refinery) ? 25 : 0)}`);
  }
  return info;
}
