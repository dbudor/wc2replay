// Match statistics for the Stats window (K): what every player made, researched and killed so far, and their
// economy and units' value over game time. Presentation only: read from the arena after each turn and from the sim's
// hook events.
//
// Everything is kept as logs keyed by what happened (a unit's serial and type, a kill's tick and victim serial, a
// research's tick, player and id, a sample's index on the SAMPLE_MS grid), so seeking back (a fresh boot or a state
// dump) only meets entries it already has, and a query filters by the current tick: nothing goes into the state
// dumps. A new replay (or rules) resets it.
//   made      a unit when first seen alive (every turn), a building when first seen finished; an upgraded hall or
//             tower counts again as its new type, and so does a unit the game converts in place (archers to rangers,
//             knights to paladins...: same serial, new type), as the game's units stat counts them; such a converted
//             one (conv) is left out of the units' value (unitValue), its cost already counted. Corpses, rubble,
//             mines, critters and the like are not counted.
//   research  HK_RESEARCH: Prod_CompleteUpgrade / Prod_CompleteSpell finished (upgrade / spell id, UPGRADE_NAMES).
//   deaths    a counted unit or building gone (scan; serial -> tick, owner, type): what was lost, killed or not
//             (demolition squads, kills by neutral units).
//   kills     killing blows of Unit_ApplyDamage (HK_KILL; Peon2k caster kills) and the kills the stats credit without
//             a killer unit (HK_KILL_CREDIT: Peon2k's units inside a razed building / a sunk transport, rune kills),
//             as the game's kills / razings stats, but own and allied victims included; neutral ones (critters) not.
//   samples   per player: gold / lumber / oil held, harvested (g_StatGoldMined, g_StatLumberHarvested,
//             g_StatOilHarvested), score (g_StatScore), and the cost and points of the units alive. Got = what the player started with + harvested; spent = got - held.
// Costs: g_UnitTypeGoldCost / LumberCost / OilCost (u8 x 10), g_UpgradeGoldCost / LumberCost / OilCost (u16), as the
// rules loaded them; a unit type's points: g_UnitTypePointValue (u16, what killing one adds to the score).
import { A } from './gamestate.js';
import { HK } from './audio.js';

export const SAMPLE_MS = 2000;
const COST = [0x4ce8ec, 0x4cec3c, 0x4cedac], POINTS = 0x4cf190, UPG_COST = [0x4d0138, 0x4d0208, 0x4d01a0];
export const UPGRADE_ICON = 0x4cff60;
const SKIP = new Set([0x39, 0x5c, 0x5d, 0x5e, 0x5f, 0x64, 0x65, 0x66, 0x69, 0x6a, 0x6b, 0x6c, 0x6d]);
const F = { gold: 0, lumber: 1, oil: 2, hg: 3, hl: 4, ho: 5, score: 6, aliveGold: 7, aliveLumber: 8, aliveOil: 9, alivePoints: 10,
  ncGold: 11, ncLumber: 12, ncOil: 13, ncPoints: 14 }, NF = 15;
// noncombat: workers, tankers, transports, flying machines / zeppelins and buildings other than towers
const NONCOMBAT = new Set([2, 3, 26, 27, 28, 29, 40, 41]), TOWER = new Set([64, 65, 96, 97, 98, 99]);
export const combat = (m, t) => isBuilding(m, t) ? TOWER.has(t) : !NONCOMBAT.has(t);
// an upgraded building's type costs only the upgrade: what stands is worth the whole chain
const UPGRADED = { 88: 74, 89: 75, 90: 88, 91: 89, 96: 64, 97: 65, 98: 64, 99: 65 };
export const isBuilding = (m, t) => !!(m.r32(A.TypeFlags + 4 * t) & 0x20);
export const cost = (m, t) => COST.map(a => 10 * m.r8(a + t));
export const points = (m, t) => m.r16(POINTS + 2 * t);
export const standingCost = (m, t) => { const c = cost(m, t); for (let b = UPGRADED[t]; b !== undefined; b = UPGRADED[b]) cost(m, b).forEach((x, k) => { c[k] += x; }); return c; };
export const upgradeCost = (m, id) => UPG_COST.map(a => m.r16(a + 2 * id));

export class MatchStats {
  constructor() { this.reset(); }
  reset() {
    this.made = new Map(); this.kills = new Map(); this.deaths = new Map(); this.research = new Map(); this.samples = [];
    this.unitType = new Map();                 // unit serial -> type first made as (conversions)
    this.killPos = new Map();                  // unit serial -> [x, y] (pixels) where it was killed
    this.damage = new Map();                   // hp lost (HK_DAMAGE): key -> { tick, by, owner, type, hp, maxHp, pos }
    this.home = new Map(); this.homeTick = -1; // player -> [x, y]: the middle of what they had at the first tick seen
    this.lastTurn = -2; this.hiN = 0;
    this.clearSlots();
  }
  // the per-slot state of the scan, from the arena as it was last turn: after a jump (a seek restores a state dump)
  // it no longer applies, so it starts over (and so no death is logged for the jump)
  clearSlots() {
    this.seen = new Uint32Array(2 * 1600);     // per slot the serial and type last scanned (a cache)
    this.live = new Uint32Array(1600);         // per slot the serial of the counted unit / building in it (0: none)
    this.liveT = new Uint8Array(1600); this.liveO = new Uint8Array(1600);
  }

  // After every turn: the turn just done, the tick reached and its hook events.
  turn(m, turn, tick, ev, tickMs) {
    const seen = new Map();   // a turn's identical hits stay apart (a turn run again after a seek gives the same keys)
    for (const e of ev) {
      if (e.kind === HK.DAMAGE) {
        const owner = (e.d >> 8) & 0xff, type = e.d & 0xff; if (owner >= 8) continue;
        const base = `${e.tick}:${m.r32(e.b + 0x14)}:${e.a}:${e.c}`, n = (seen.get(base) || 0) + 1; seen.set(base, n);
        const key = `${base}:${n}`;
        if (!this.damage.has(key)) this.damage.set(key, { tick: e.tick, by: e.a, owner, type, hp: e.c, maxHp: m.r16(A.TypeMaxHp + 2 * type), pos: [m.s16(e.b), m.s16(e.b + 2)] });
        continue;
      }
      if (e.kind === HK.RESEARCH) {
        const key = `${e.tick}:${e.a}:${e.b}`;
        if (e.a < 8 && !this.research.has(key)) this.research.set(key, { tick: e.tick, owner: e.a, id: e.b });
        continue;
      }
      if (e.kind !== HK.KILL && e.kind !== HK.KILL_CREDIT || e.d >= 8) continue;
      const by = e.kind === HK.KILL ? m.r8(e.a + 0x2c) : e.a; if (by >= 8) continue;
      const serial = m.r32(e.b + 0x14), key = `${e.tick}:${serial}`, pos = [m.s16(e.b), m.s16(e.b + 2)];
      if (!this.kills.has(key)) { this.kills.set(key, { tick: e.tick, by, type: e.c, owner: e.d, pos }); this.killPos.set(serial, pos); }
    }
    if (turn !== this.lastTurn + 1) this.clearSlots();
    this.lastTurn = turn;
    this.scan(m, tick);
    const i = Math.floor(tick * tickMs / SAMPLE_MS);
    if (!this.samples[i]) this.samples[i] = { tick, v: this.read(m) };
  }
  // deaths: a counted unit or building whose slot is freed, marked dead, taken by another unit or turned into
  // something not counted (a corpse), by whatever means (killed, a demolition squad's blast, ...)
  scan(m, tick) {
    const u8 = m.u8, dv = m.dv, b = m.base, n = m.r32(A.UnitCount), seen = this.seen, live = this.live;
    const die = i => {   // where: where it was killed, else its slot's position while the slot still holds it
      const u = b + m.r32(A.Units) + 0x98 * i, same = dv.getUint32(u + 0x14, true) === live[i];
      if (!this.deaths.has(live[i])) this.deaths.set(live[i], { tick, owner: this.liveO[i], type: this.liveT[i],
        pos: this.killPos.get(live[i]) || (same ? [dv.getInt16(u, true), dv.getInt16(u + 2, true)] : null) });
      live[i] = 0;
    };
    const first = this.homeTick < 0 || this.homeTick === tick, acc = first ? new Map() : null;
    if (first) this.homeTick = tick;
    for (let i = n; i < this.hiN; i++) { if (live[i]) die(i); seen[2 * i] = 0; }
    this.hiN = n;
    for (let i = 0, u = b + m.r32(A.Units); i < n; i++, u += 0x98) {
      const f = dv.getUint16(u + 0x1e, true), k = 2 * i;
      if (f & 3) { if (live[i]) die(i); seen[k] = 0; continue; }
      const serial = dv.getUint32(u + 0x14, true), t = u8[u + 0x27];
      if (seen[k] === serial && seen[k + 1] === t + (f & 0x80)) continue;   // this slot's unit, as last looked at
      seen[k] = serial; seen[k + 1] = t + (f & 0x80);
      const p = u8[u + 0x2c], bl = isBuilding(m, t);
      const counted = p < 8 && t < 110 && !SKIP.has(t) && !(bl && !(f & 0x80));
      if (live[i] && (live[i] !== serial || !counted)) die(i);
      if (!counted) continue;
      live[i] = serial; this.liveT[i] = t; this.liveO[i] = p;
      if (acc) { const a = acc.get(p) || [0, 0, 0]; a[0] += dv.getInt16(u, true); a[1] += dv.getInt16(u + 2, true); a[2]++; acc.set(p, a); }
      const key = serial * 128 + t;
      if (this.made.has(key)) continue;
      let conv = false;
      if (!bl) { const was = this.unitType.get(serial); if (was === undefined) this.unitType.set(serial, t); else conv = was !== t; }
      this.made.set(key, { tick, owner: p, type: t, conv });
    }
    if (acc) for (const [p, a] of acc) this.home.set(p, [a[0] / a[2], a[1] / a[2]]);
  }
  // the sampled values of all 8 players now
  read(m) {
    const v = new Int32Array(8 * NF);
    for (let p = 0; p < 8; p++) {
      const o = p * NF;
      v[o] = m.r32(A.Gold + 4 * p); v[o + 1] = m.r32(A.Lumber + 4 * p); v[o + 2] = m.r32(A.Oil + 4 * p);
      v[o + 3] = m.r32(0x4ab9c4 + 4 * p); v[o + 4] = m.r32(0x4ad3a8 + 4 * p); v[o + 5] = m.r32(0x4abc98 + 4 * p);
      v[o + 6] = m.r32(0x4ace00 + 4 * p);
    }
    // the units and finished buildings alive (as counted made): their cost (of an upgraded one, with what it was
    // upgraded from) and points, combat (alive*) and noncombat (nc*)
    const u8 = m.u8, dv = m.dv, n = m.r32(A.UnitCount);
    for (let i = 0, u = m.base + m.r32(A.Units); i < n; i++, u += 0x98) {
      const f = dv.getUint16(u + 0x1e, true); if (f & 3) continue;
      const t = u8[u + 0x27], p = u8[u + 0x2c];
      if (p >= 8 || t >= 110 || SKIP.has(t) || isBuilding(m, t) && !(f & 0x80)) continue;
      const o = p * NF + (combat(m, t) ? 7 : 11), c = standingCost(m, t);
      v[o] += c[0]; v[o + 1] += c[1]; v[o + 2] += c[2]; v[o + 3] += points(m, t);
    }
    return v;
  }

  // ---- queries at game tick `tick` (what had happened by then), for a group of players `members` (one player, or a team)
  // Map type -> { n, by: Map player -> n }
  madeBy(tick, members) {
    const out = new Map(), inG = new Set(members);
    for (const e of this.made.values()) {
      if (e.tick > tick || !inG.has(e.owner)) continue;
      const x = out.get(e.type) || { n: 0, by: new Map() };
      x.n++; x.by.set(e.owner, (x.by.get(e.owner) || 0) + 1); out.set(e.type, x);
    }
    return out;
  }
  // [{ tick, owner, id }] by time
  researchBy(tick, members) {
    const inG = new Set(members);
    return [...this.research.values()].filter(e => e.tick <= tick && inG.has(e.owner)).sort((a, b) => a.tick - b.tick || a.id - b.id);
  }
  // what the group killed: [{ type, owner, own, n }] (owner: the victims' player when split, else -1; own: a victim of
  // the group itself or of `friends`, its team)
  killsBy(tick, members, split, friends = members) {
    const out = new Map(), inG = new Set(members), fr = new Set([...members, ...friends]);
    for (const e of this.kills.values()) {
      if (e.tick > tick || !inG.has(e.by)) continue;
      const own = fr.has(e.owner), key = split ? e.type * 16 + e.owner : e.type * 2 + own;
      const x = out.get(key) || { type: e.type, owner: split ? e.owner : -1, own, n: 0 };
      x.n++; out.set(key, x);
    }
    return [...out.values()];
  }
  // [gold, lumber, oil] of the group's units and buildings lost (deaths, killed or not; cost(type) -> [g, l, o])
  lostValue(tick, members, cost) {
    const v = [0, 0, 0], inG = new Set(members);
    for (const e of this.deaths.values()) if (e.tick <= tick && inG.has(e.owner)) { const c = cost(e.type); for (let k = 0; k < 3; k++) v[k] += c[k]; }
    return v;
  }
  // Cumulative values of the group's units (not buildings) made and lost (deaths), at each tick of t: value(type) -> [v0, v1...]
  // (as cost: [gold, lumber, oil]) gives { made: [v0[], v1[]...], lost: [...] }; noStart leaves out the starting units
  // (those made at the first tick seen)
  unitValue(t, members, cost, building, noStart = false) {
    const inG = new Set(members), t0 = noStart ? Math.min(...[...this.made.values()].map(e => e.tick)) : -1;
    const sweep = evs => {
      evs.sort((a, b) => a.tick - b.tick);
      const nk = cost(0).length, out = Array.from({ length: nk }, () => []), acc = new Array(nk).fill(0); let j = 0;
      for (const tk of t) {
        for (; j < evs.length && evs[j].tick <= tk; j++) { const c = cost(evs[j].type); for (let k = 0; k < nk; k++) acc[k] += c[k]; }
        for (let k = 0; k < nk; k++) out[k].push(acc[k]);
      }
      return out;
    };
    return {
      made: sweep([...this.made.values()].filter(e => !e.conv && e.tick > t0 && inG.has(e.owner) && !building(e.type))),
      lost: sweep([...this.deaths.values()].filter(e => inG.has(e.owner) && !building(e.type))),
    };
  }
  // Cumulative value(type) -> [v0, v1...] of what the group killed of other players than `friends` (its team), units and
  // buildings, at each tick of t: [v0[], v1[]...]
  killedValue(t, members, friends, cost) {
    const inG = new Set(members), fr = new Set([...members, ...friends]);
    const evs = [...this.kills.values()].filter(e => inG.has(e.by) && !fr.has(e.owner)).sort((a, b) => a.tick - b.tick);
    const nk = cost(0).length, out = Array.from({ length: nk }, () => []), acc = new Array(nk).fill(0); let j = 0;
    for (const tk of t) {
      for (; j < evs.length && evs[j].tick <= tk; j++) { const c = cost(evs[j].type); for (let k = 0; k < nk; k++) acc[k] += c[k]; }
      for (let k = 0; k < nk; k++) out[k].push(acc[k]);
    }
    return out;
  }
  // when it happened, up to `tick` (for the marks on the charts' time axis): the group's units of a type made and
  // lost { made: [ticks], lost: [ticks] }; what the group killed of a type and victims' player: [ticks]
  typeTimes(tick, members, type) {
    const inG = new Set(members), made = [], lost = [];
    for (const e of this.made.values()) if (e.tick <= tick && e.type === type && inG.has(e.owner)) made.push(e.tick);
    for (const e of this.deaths.values()) if (e.tick <= tick && e.type === type && inG.has(e.owner)) lost.push(e.tick);
    return { made, lost };
  }
  killTimes(tick, members, type, owner) {
    const inG = new Set(members), out = [];
    for (const e of this.kills.values()) if (e.tick <= tick && e.type === type && e.owner === owner && inG.has(e.by)) out.push(e.tick);
    return out;
  }
  // Kurčometar's aggression of one player by `tick`, from the hp lost (HK_DAMAGE; polymorph and a sunk transport's
  // cargo: all their hp): what they did to other players than `friends` (value × hp / max hp, × 2) and what they took
  // (the same of their own units), each divided by 5 − its Manhattan distance from the player's home in tiles / 64: at
  // home a fifth, 128 tiles away a third, a 128-tile map's far corner (254 tiles) about 1. value(type) -> a number
  // (cost weighed as the charts do)
  aggression(tick, p, friends, value) {
    const fr = new Set([p, ...friends]), h = this.home.get(p);
    const w = pos => !h || !pos ? 1 / 5 : 1 / (5 - (Math.abs(pos[0] - h[0]) + Math.abs(pos[1] - h[1])) / 32 / 64);
    let v = 0;
    for (const e of this.damage.values()) {
      if (e.tick > tick) continue;
      const part = value(e.type) * e.hp / Math.max(1, e.maxHp);
      if (e.by === p && !fr.has(e.owner)) v += 2 * part * w(e.pos);
      if (e.owner === p) v += part * w(e.pos);
    }
    return v;
  }
  // series of sampled values up to `tick`, plus the live state `now` (read(m)) as its last point:
  //   { t: [ticks], get(members, field) -> [values summed over the group] }, fields as F plus gotGold / gotLumber / gotOil
  //   (start + harvested) and spentGold / spentLumber / spentOil (got - held)
  series(tick, now) {
    const pts = this.samples.filter(s => s && s.tick <= tick);
    if (now) pts.push({ tick, v: now });
    const first = pts[0];
    const one = (p, field) => {
      const sp = /^(spent|got)(\w+)$/.exec(field), o = p * NF;
      if (sp) {
        const k = { Gold: 0, Lumber: 1, Oil: 2 }[sp[2]];
        const start = first ? first.v[o + k] - first.v[o + 3 + k] : 0;
        return sp[1] === 'got' ? pts.map(s => start + s.v[o + 3 + k]) : pts.map(s => Math.max(0, start + s.v[o + 3 + k] - s.v[o + k]));
      }
      return pts.map(s => s.v[o + F[field]]);
    };
    return {
      t: pts.map(s => s.tick),
      get(members, field) {
        const out = new Array(pts.length).fill(0);
        for (const p of members) one(p, field).forEach((x, i) => { out[i] += x; });
        return out;
      },
    };
  }
}

// Rates per game minute of a cumulative series v sampled at ticks t (unevenly spaced). What is there at the first
// sample (starting resources) is not counted: rates start from the first sample.
//
// smoothRate: smoothed, centred (no lag): at each sample, what came in over the intervals around it weighed by a
// Gaussian of their middles' distance (sigma SMOOTH_MS of game time, cut at 3 sigma), over their weighed length. At the
// ends it only has one side.
export const SMOOTH_MS = 20000;
export function smoothRate(t, v, tickMs, sigmaMs = SMOOTH_MS) {
  const win = 60000 / tickMs, sg = sigmaMs / tickMs, cut = 3 * sg, out = []; let lo = 1;
  for (let i = 0; i < t.length; i++) {
    let a = 0, b = 0;
    while (lo < t.length && (t[lo] + t[lo - 1]) / 2 < t[i] - cut) lo++;
    for (let k = lo; k < t.length; k++) {
      const mid = (t[k] + t[k - 1]) / 2, d = mid - t[i]; if (d > cut) break;
      const w = Math.exp(-d * d / (2 * sg * sg)); a += w * (v[k] - v[k - 1]); b += w * (t[k] - t[k - 1]);
    }
    out.push(b > 0 ? Math.max(0, Math.round(a * win / b)) : 0);
  }
  return out;
}
// minuteTotals: not smoothed: what came in during each game minute (the current one: so far), at every sample of that
// minute, so it draws as steps.
export function minuteTotals(t, v, tickMs) {
  const win = 60000 / tickMs, out = new Array(t.length).fill(0);
  for (let i = 0, prev = v[0]; i < t.length;) {
    const m = Math.floor(t[i] / win); let j = i;
    while (j + 1 < t.length && Math.floor(t[j + 1] / win) === m) j++;
    out.fill(Math.max(0, v[j] - prev), i, j + 1); prev = v[j]; i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------- HTML
const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
export const fmtNum = n => Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100000 ? 0 : 1)}k` : String(n);
const fmtT = ms => { const s = Math.round(ms / 1000), h = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`; };

// groups: [{ name, sub, rgb, members: [player ids] }] (one watched player, or the two teams)
// o: { icon(type, player | -1), upIcon(id, player) -> data URL | null, name(type), upName(id), building(type),
//      cost(type), upCost(id) -> [g, l, o], playerName(id), playerRgb(id), clock(tick) -> text }
// n: the count (bottom right) or null; top: a second count above it (top right) or null
// mk: what the tile stands for, for the marks on the charts when pointed at (data-mk)
function tile(src, nm, n, extra = '', cls = '', top = null, mk = '') {
  return `<div class="stTile${cls}"${mk ? ` data-mk="${mk}"` : ''} title="${esc(nm)}${extra ? ' · ' + esc(extra) : ''}">` +
    (src ? `<img src="${src}" alt="">` : `<span class="stNoIcon">${esc(nm)}</span>`) +
    (top !== null ? `<b class="top">${top}</b>` : '') + (n !== null ? `<b>${n}</b>` : '') + `</div>`;
}
const head = (g, right = '') => `<div class="stHead"><i style="background:rgb(${g.rgb})"></i><span class="stName">${esc(g.name)}</span><span class="stRace">${esc(g.sub)}</span>${right}</div>`;
const resSum = v => `<span class="stRes"><span class="g">${fmtNum(v[0])}</span><span class="l">${fmtNum(v[1])}</span><span class="o">${fmtNum(v[2])}</span></span>`;
const row = (label, tiles, rgb = null, extra = '') => tiles ? `<div class="stRow"><span class="stLbl">${rgb ? `<i style="background:rgb(${rgb})"></i>` : ''}<span>${esc(label)}</span>${extra}</span><div class="stTiles">${tiles}</div></div>` : '';
const most = by => [...by].sort((a, b) => b[1] - a[1])[0][0];
const byText = (o, by) => by.size > 1 ? [...by].map(([p, n]) => `${o.playerName(p)} ${n}`).join(', ') : '';

// made: per group madeBy(); alive: per group Map type -> count now; research: per group researchBy()
export function unitsHtml(o, groups, made, alive, research) {
  return groups.map((g, gi) => {
    const mm = made[gi], now = t => alive[gi].get(t) || 0, many = g.members.length > 1;
    const types = [...new Set([...mm.keys(), ...alive[gi].keys()])].sort((a, b) => a - b);
    const tiles = b => types.filter(t => o.building(t) === b).map(t => {
      const x = mm.get(t) || { n: 0, by: new Map() }, who = byText(o, x.by), owner = x.by.size ? most(x.by) : g.members[0];
      return tile(o.icon(t, owner), o.name(t), x.n, `${now(t)} now (top), ${x.n} made (bottom)${who ? ': ' + who : ''}`, now(t) ? '' : ' gone', now(t), `u:${gi}:${t}`);
    }).join('');
    const ups = research[gi].map(e => {
      const c = o.upCost(e.id);
      return tile(o.upIcon(e.id, e.owner), o.upName(e.id), null, `${many ? o.playerName(e.owner) + ', ' : ''}done at ${o.clock(e.tick)}, cost ${c[0]} gold, ${c[1]} lumber, ${c[2]} oil`, '', null, `r:${gi}:${e.tick}`);
    }).join('');
    const sum = b => types.filter(t => o.building(t) === b).reduce((a, t) => a + (mm.get(t) ? mm.get(t).n : 0), 0);
    const body = row('Units', tiles(false)) + row('Buildings', tiles(true)) + row('Upgrades', ups);
    return `<section class="stPlayer">${head(g, `<span class="stSum">${sum(false)} units · ${sum(true)} buildings made · ${research[gi].length} upgrades · counts: now over made</span>`)}` +
      (body || '<div class="stNone">nothing yet</div>') + `</section>`;
  }).join('');
}

// kills: per group killsBy(.., true, team); lost: per group lostValue(). A row per victims' player, the enemies first,
// each icon in their colour, by unit type; friendly kills (the group's own or its team mates') marked.
export function killsHtml(o, groups, kills, lost) {
  const value = list => list.reduce((a, k) => { const c = o.cost(k.type); return [a[0] + k.n * c[0], a[1] + k.n * c[1], a[2] + k.n * c[2]]; }, [0, 0, 0]);
  return groups.map((g, gi) => {
    const list = kills[gi].slice().sort((a, b) => a.type - b.type);
    const cnt = (b, own) => list.filter(k => o.building(k.type) === b && k.own === own).reduce((a, k) => a + k.n, 0);
    const tiles = l => l.map(k => {
      const c = o.cost(k.type).map(x => x * k.n);
      return tile(o.icon(k.type, k.owner), o.name(k.type), k.n, `${k.own ? 'friendly, ' : ''}value ${c[0]} gold, ${c[1]} lumber, ${c[2]} oil`, k.own ? ' own' : '', null, `k:${gi}:${k.type}:${k.owner}`);
    }).join('');
    const owners = [...new Set(list.map(k => k.owner))].sort((a, b) => list.find(k => k.owner === a).own - list.find(k => k.owner === b).own || a - b);
    const body = owners.map(p => {
      const l = list.filter(k => k.owner === p);
      return row(`${o.playerName(p)}${l[0].own ? ' (friendly)' : ''} · ${l.reduce((a, k) => a + k.n, 0)}`, tiles(l), o.playerRgb(p), resSum(value(l)));
    }).join('');
    const own = cnt(false, true) + cnt(true, true);
    return `<section class="stPlayer">${head(g, `<span class="stSum">${cnt(false, false)} kills · ${cnt(true, false)} razings${own ? ` · ${own} friendly` : ''} · value ${resSum(value(list.filter(k => !k.own)))} · lost ${resSum(lost[gi])}</span>`)}` +
      (body || '<div class="stNone">no kills yet</div>') + `</section>`;
  }).join('');
}

// Stacked area chart as SVG, w x h px: pos layers stacked up from 0, neg layers stacked down, optional lines on their
// own scale (right axis, the same 0): line.up drawn up, line.down down. t: ticks (x). Layers and lines: { rgb,
// v: [values >= 0] }. range: { top, bottom, lineTop, lineBottom } (>= 0), shared by the charts compared. yLabels false:
// no numbers on the left axis (weighed values).
export function stackChartSvg({ title, t, pos, neg, line, range, w, h, tickMs, yLabels = true }) {
  const L = yLabels ? 52 : 12, R = line ? 50 : 12, T = 24, B = 22, W = Math.max(60, w - L - R), H = Math.max(60, h - T - B);
  const tMax = Math.max(1, t.length ? t[t.length - 1] : 1);
  const step = niceStep(Math.max(1, range.top + range.bottom) / 8);
  const top = Math.max(step, Math.ceil(range.top / step) * step), bot = Math.max(line && range.lineBottom > 0 ? step : 0, Math.ceil(range.bottom / step) * step);
  const X = k => L + W * k / tMax, Y = v => T + H * (top - v) / (top + bot);
  const out = [`<svg class="stChart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-l="${L}" data-w="${W}" data-tmax="${tMax}" data-b="${T + H}">`,
    `<text class="ttl" x="${L}" y="15">${esc(title)}</text>`];
  for (let v = -bot; v <= top + 1e-9; v += step) out.push(`<line class="grid${Math.abs(v) < 1e-9 ? ' zero' : ''}" x1="${L}" x2="${L + W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>${yLabels ? `<text class="ax" x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v < 0 ? '−' : ''}${fmtNum(Math.abs(v))}</text>` : ''}`);
  const minMs = tMax * tickMs, tStep = [30, 60, 120, 300, 600, 900, 1800].find(s => minMs / 1000 / s <= 8) || 3600;
  for (let s = 0; s * 1000 <= minMs; s += tStep) { const x = X(s * 1000 / tickMs); out.push(`<line class="grid v" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T}" y2="${T + H}"/><text class="ax" x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${fmtT(s * 1000)}</text>`); }
  const stack = (layers, sign) => {
    const base = t.map(() => 0);
    for (const ly of layers) {
      const hi = base.map((b, i) => b + sign * ly.v[i]);
      const pts = arr => arr.map((v, i) => `${X(t[i]).toFixed(1)} ${Y(v).toFixed(1)}`);
      if (t.length) out.push(`<path d="M${pts(hi).join('L')}L${pts(base).reverse().join('L')}Z" fill="rgba(${ly.rgb},${sign > 0 ? .8 : .5})" stroke="rgb(${ly.rgb})" stroke-width="1" stroke-linejoin="round"/>`);
      hi.forEach((v, i) => { base[i] = v; });
    }
  };
  stack(pos, 1); stack(neg, -1);
  if (line && t.length) {   // its own scale on the right: per px as much as both directions need to fit their half
    const up = Y(0) - T, dn = T + H - Y(0);
    const per = Math.max(1 / up, range.lineTop / up, dn > 0 ? range.lineBottom / dn : 0), ls = niceStep(per * Math.max(up, dn) / 4), LY = v => Y(0) - v / per;
    for (let v = -Math.floor(dn * per / ls) * ls; v <= up * per + 1e-9; v += ls) out.push(`<text class="ax line" x="${L + W + 6}" y="${(LY(v) + 4).toFixed(1)}">${v < 0 ? '−' : ''}${fmtNum(Math.abs(v))}</text>`);
    for (const [ln, sign] of [[line.up, 1], [line.down, -1]]) if (ln) out.push(`<path d="${ln.v.map((v, i) => `${i ? 'L' : 'M'}${X(t[i]).toFixed(1)} ${LY(sign * v).toFixed(1)}`).join('')}" fill="none" stroke="rgb(${ln.rgb})" stroke-width="2.2" stroke-linejoin="round"/>`);
  }
  out.push(`<line class="cur" x1="0" x2="0" y1="${T}" y2="${T + H}" visibility="hidden"/><g class="marks"></g></svg>`);
  return out.join('');
}
function niceStep(x) {
  const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
