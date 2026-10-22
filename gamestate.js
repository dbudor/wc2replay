// Read-only views of the sim state in the arena (addresses: sim/gen/w2globals.h, names/unit_struct.md).
// `m` is SimSession.mem().

export const A = {
  Units: 0x4aec44, UnitCount: 0x4ae220,            // Unit* (stride 0x98), capacity 600/1600
  Missiles: 0x4aec48, MissileCount: 0x4ae218,      // Missile* (stride 0x40), capacity 200/400
  MapTiles: 0x4ad5cc, MapSize: 0x4acbdc, Tileset: 0x4acc10,
  FogVisible: 0x4ad5b8, FogExplored: 0x4ad5e0, FogSeenMask: 0x4ad60c,   // u8* (0x4000 each, map row-major)
  LocalPlayer: 0x4acb18, TickCount: 0x4ace78, GameSpeed: 0x4d6ae8, Extended: 0x4ae21c,
  Gold: 0x4abac8, Lumber: 0x4acb1c, Oil: 0x4abbac,  // u32[16]
  PlayerType: 0x4acb5c, PlayerRace: 0x4abd28,       // u8[16] PlayerCtrl / Race
  PlayerColor: 0x4a48bc,                            // u8[16] g_Gfx_PlayerColorIdx: palette base of the 4-entry ramp
  FoodSupply: 0x4adc1c, UnitCountP: 0x4ada7c, BldgCount: 0x4ad9b4,   // u16[16]
  ChatSlots: 0x4ad740,                              // PlayerSetup[8] (0x38), by start slot after ChatRoom_RemapSlots: +0 state, +0x18 name[12]
  DefeatFlags: 0x4acc08,                            // u8[8]
  TypeSize: 0x4cee1c, TypeBox: 0x4cf36c, TypeFlags: 0x4cf524, TypeMaxHp: 0x4cfd34, TypeSightFn: 0x4cf7bc,
  SfxTables: 0x498a70,                              // per-race in-game sfx list (Snd_ResetVoiceState 0x423010)
  Palette: 0x4ae844,
};

export const UNIT_NAMES = ["Footman", "Grunt", "Peasant", "Peon", "Ballista", "Catapult", "Knight", "Ogre", "Archer", "Axethrower", "Mage", "DeathKnight", "Paladin", "OgreMage", "Dwarves", "GoblinSappers", "AttackPeasant", "AttackPeon", "Ranger", "Berserker", "Alleria", "TeronGorefiend", "KurdanSkyree", "Dentarg", "Khadgar", "GromHellscream", "HumanTanker", "OrcTanker", "HumanTransport", "OrcTransport", "ElvenDestroyer", "TrollDestroyer", "Battleship", "Juggernaught", "Unused22", "Deathwing", "Unused24", "Unused25", "GnomishSubmarine", "GiantTurtle", "GnomishFlyingMachine", "GoblinZeppelin", "GryphonRider", "Dragon", "Turalyon", "EyeOfKilrogg", "Danath", "KorgathBladefist", "Unused30", "Chogall", "Lothar", "Guldan", "UtherLightbringer", "Zuljin", "Unused36", "Skeleton", "Daemon", "Critter", "Farm", "PigFarm", "HumanBarracks", "OrcBarracks", "Church", "AltarOfStorms", "HumanScoutTower", "OrcScoutTower", "Stables", "OgreMound", "GnomishInventor", "GoblinAlchemist", "GryphonAviary", "DragonRoost", "HumanShipyard", "OrcShipyard", "TownHall", "GreatHall", "ElvenLumberMill", "TrollLumberMill", "HumanFoundry", "OrcFoundry", "MageTower", "TempleOfTheDamned", "HumanBlacksmith", "OrcBlacksmith", "HumanRefinery", "OrcRefinery", "HumanOilPlatform", "OrcOilPlatform", "Keep", "Stronghold", "Castle", "Fortress", "GoldMine", "OilPatch", "HumanStart", "OrcStart", "HumanGuardTower", "OrcGuardTower", "HumanCannonTower", "OrcCannonTower", "CircleOfPower", "DarkPortal", "Runestone", "HumanWall", "OrcWall", "DeadBody", "Rubble1x1", "Rubble2x2", "Rubble3x3", "Rubble4x4"];
export const MISSILE_NAMES = ["Lightning", "GryphonHammer", "DragonBreath", "FlameShieldBolt", "FlameShieldOrbit", "Blizzard", "DeathAndDecay", "BigCannon", "Exorcism", "HealEffect", "DeathCoil", "Rune", "Whirlwind", "CatapultRock", "BallistaBolt", "Arrow", "Axe", "SubmarineMissile", "TurtleMissile", "SmallFire", "BigFire", "BallistaImpact", "NormalSpell", "Explosion", "SmallCannon", "CannonExplosion", "CannonTowerExplosion", "DaemonFire", "GreenCross", "None"];
export const RACES = ['Human', 'Orc', 'Neutral'];
export const CTRL = ['Human', 'Computer', 'Passive', 'Nobody', 'Open computer', 'Open human', 'Rescue (passive)', 'Rescue (active)'];
export const COLOR_NAMES = ['red', 'blue', 'green', 'violet', 'orange', 'black', 'white', 'yellow'];
// Player colours can be shuffled per game: the name follows the ramp base (0xd0 + 4k, or 0x0c = yellow).
export const colorName = idx => idx === 0x0c ? 'yellow' : (idx >= 0xd0 && idx < 0xec && !(idx & 3)) ? COLOR_NAMES[(idx - 0xd0) >> 2] : '#' + idx;

// Sight function pointer (g_UnitTypeSightFn, after Data_UnitTypeIdxToFnPtrs) -> pattern size (Fog_RevealSightN: 2N+1).
const SIGHT_FN = { 0x42ceb0: 3, 0x42d030: 5, 0x42d0b0: 7, 0x42d130: 9, 0x42d1b0: 11, 0x42d230: 13, 0x42d2b0: 15, 0x42d330: 17, 0x42d3b0: 19 };

// Unit flags (+0x1e): 1 free slot, 2 dead/dying, 8 contained (inside a transport / building / mine).
export const UF_FREE = 1, UF_DEAD = 2, UF_CONTAINED = 8, UF_BUILT = 0x80;

export function readUnits(m) {
  const base = m.r32(A.Units), n = m.r32(A.UnitCount), out = [];
  for (let i = 0; i < n; i++) {
    const u = base + 0x98 * i, f = m.r16(u + 0x1e);
    if (f & (UF_FREE | UF_DEAD | UF_CONTAINED)) continue;
    const type = m.r8(u + 0x27);
    out.push({
      addr: u, id: i, type, flags: f,
      x: m.s16(u), y: m.s16(u + 2), tx: m.r16(u + 0x18), ty: m.r16(u + 0x1a),
      hp: m.r16(u + 0x22), maxHp: m.r16(A.TypeMaxHp + 2 * type), mana: m.r8(u + 0x26),
      owner: m.r8(u + 0x2c), order: m.r8(u + 0x2e), facing: m.r8(u + 0x0a), frame: m.r8(u + 9),
      w: m.r16(A.TypeSize + 4 * type), h: m.r16(A.TypeSize + 4 * type + 2),
      boxW: m.r16(A.TypeBox + 4 * type), boxH: m.r16(A.TypeBox + 4 * type + 2),
      tflags: m.r32(A.TypeFlags + 4 * type),
      sight: SIGHT_FN[m.r32(A.TypeSightFn + 4 * type)] || 0,
      hiddenMask: m.r8(u + 0x28), visibleMask: m.r8(u + 0x29),
    });
  }
  return out;
}

export function readMissiles(m) {
  const base = m.r32(A.Missiles), n = m.r32(A.MissileCount), out = [];
  for (let i = 0; i < n; i++) {
    const p = base + 0x40 * i;
    if (m.r8(p + 0x35) & 1) continue;
    const type = m.r8(p + 0x36);
    if (type >= 0x1d) continue;
    out.push({ addr: p, id: i, type, x: m.s16(p), y: m.s16(p + 2) });
  }
  return out;
}

export function readPlayers(m, units) {
  const players = [];
  for (let p = 0; p < 8; p++) {
    const ctrl = m.r8(A.PlayerType + p);
    if (ctrl === 3) continue;   // nobody
    const own = units ? units.filter(u => u.owner === p) : [];
    const cs = A.ChatSlots + 0x38 * p;
    players.push({
      id: p, ctrl, ctrlName: CTRL[ctrl] || ctrl,
      name: m.r8(cs) === 1 ? m.cstr(cs + 0x18, 12) : '',
      race: m.r8(A.PlayerRace + p), raceName: RACES[m.r8(A.PlayerRace + p)] || '?',
      colorIdx: m.r8(A.PlayerColor + p), colorName: colorName(m.r8(A.PlayerColor + p)),
      gold: m.r32(A.Gold + 4 * p), lumber: m.r32(A.Lumber + 4 * p), oil: m.r32(A.Oil + 4 * p),
      food: m.r16(A.UnitCountP + 2 * p), foodMax: Math.min(200, m.r16(A.FoodSupply + 2 * p)),
      unitCount: m.r16(A.UnitCountP + 2 * p), bldgCount: m.r16(A.BldgCount + 2 * p),
      liveUnits: own.filter(u => !(u.tflags & 0x20)).length, liveBldgs: own.filter(u => u.tflags & 0x20).length,
      defeated: !!m.r8(A.DefeatFlags + p),
    });
  }
  return players;
}

// Milliseconds per sim tick at 1x, as Game_TimedFrame paces frames (one tick per frame):
//  Classic: g_Game_FrameSkipTbl 0x4908f0[3*speed + phase] with speed = Game_GetSpeed() = 0x496914[g_GameSpeed],
//           a 3-phase cycle (speed 5 "fastest": 20,30,30 -> 26.67 ms/tick = 37.5 ticks/s);
//  Enhanced: 0x490908[g_GameSpeed].
export function tickMs(m) {
  const sp = m.r32(A.GameSpeed);
  if (m.r32(A.Extended)) return m.r8(0x490908 + sp) || 40;
  const s = m.r8(0x496914 + sp);
  const t = [0, 1, 2].map(i => m.r8(0x4908f0 + 3 * s + i));
  return (t[0] + t[1] + t[2]) / 3 || 40;
}

// In-game sound names: the list Snd_SetSfxTable 0x4403c0 installs for the local race ({u16 flags, u16, u32 name}
// entries from *(0x498a70 + 4*race), sfx index = position). HK_SOUND ids are 1-based (Snd_PlayUnit: id-1).
export function soundNames(m) {
  const race = m.r8(A.PlayerRace + m.r8(A.LocalPlayer));
  const tab = m.r32(A.SfxTables + 4 * (race > 1 ? 0 : race)), names = [];
  if (!tab) return names;
  for (let e = tab; names.length < 1000; e += 8) {
    const np = m.r32(e + 4);
    if (!np) break;
    names.push(m.cstr(np, 64));
  }
  return names;
}
