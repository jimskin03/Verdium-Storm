import type {
  ArmourClass,
  BuildingStats,
  BuildingType,
  UnitStats,
  UnitType,
  WeaponStats,
} from '@/entities/Types';

/**
 * The balance table. Everything the simulation needs to know about a unit or a
 * structure lives here, plus the derived lookup tables the hot loops use
 * (integer type ids, flattened armour multiplier arrays, weapon registry).
 *
 * Balance intent — a three-way counter triangle plus a siege wildcard:
 *
 *   rocketeer  → beats heavy armour (tanks, harvesters), dies to anything
 *                that splashes.
 *   aa (flak)  → beats flesh (infantry) and is the only air answer, folds to
 *                cannon fire.
 *   tank       → beats light armour (aa, artillery, scouts), can barely
 *                scratch infantry.
 *   artillery  → outranges every direct-fire weapon by 2x and shreds infantry
 *                and structures, but is light-armoured and slow to cycle.
 *
 * Costs are tuned against a harvester earning ~17 credits/second, so a single
 * refinery sustains roughly one tank per 45 seconds.
 */

export const UNIT_TYPES: readonly UnitType[] = [
  'rifleman', 'rocketeer', 'engineer', 'scout', 'tank', 'artillery', 'aa', 'harvester',
];

export const BUILDING_TYPES: readonly BuildingType[] = [
  'hq', 'power', 'refinery', 'barracks', 'factory', 'turret', 'sam', 'radar', 'lab',
];

export const ARMOUR_CLASSES: readonly ArmourClass[] = ['flesh', 'light', 'heavy', 'structure'];

function vs(flesh: number, light: number, heavy: number, structure: number): Record<ArmourClass, number> {
  return { flesh, light, heavy, structure };
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  rifleman: {
    type: 'rifleman', label: 'Rifleman', cost: 120, buildTime: 4.5, hp: 140,
    armour: 'flesh', locomotion: 'infantry', speed: 8.5, turnRate: 6.5, radius: 1.5, sight: 92,
    requires: 'barracks',
    weapon: {
      weaponClass: 'bullet', damage: 13, range: 33, cooldown: 1.0, burst: 3, burstDelay: 0.1,
      projectileSpeed: 0, splash: 0, canTargetAir: true, canTargetGround: true,
      vs: vs(1.0, 0.55, 0.2, 0.3),
    },
  },
  rocketeer: {
    type: 'rocketeer', label: 'Rocketeer', cost: 280, buildTime: 7, hp: 115,
    armour: 'flesh', locomotion: 'infantry', speed: 7.4, turnRate: 5.5, radius: 1.5, sight: 104,
    requires: 'barracks',
    weapon: {
      weaponClass: 'rocket', damage: 58, range: 54, cooldown: 2.6, burst: 2, burstDelay: 0.36,
      projectileSpeed: 62, splash: 4.5, canTargetAir: true, canTargetGround: true,
      vs: vs(0.5, 1.3, 1.55, 0.95),
    },
  },
  engineer: {
    type: 'engineer', label: 'Engineer', cost: 320, buildTime: 8, hp: 95,
    armour: 'flesh', locomotion: 'infantry', speed: 7.8, turnRate: 6.0, radius: 1.5, sight: 74,
    requires: 'barracks',
  },
  scout: {
    type: 'scout', label: 'Scout Buggy', cost: 360, buildTime: 8, hp: 210,
    armour: 'light', locomotion: 'wheeled', speed: 23, turnRate: 3.1, radius: 2.3, sight: 152,
    requires: 'factory',
    weapon: {
      weaponClass: 'bullet', damage: 10, range: 35, cooldown: 0.4, burst: 1,
      projectileSpeed: 0, splash: 0, canTargetAir: true, canTargetGround: true,
      vs: vs(1.15, 0.6, 0.14, 0.18),
    },
  },
  tank: {
    type: 'tank', label: 'Battle Tank', cost: 850, buildTime: 14, hp: 640,
    armour: 'heavy', locomotion: 'tracked', speed: 11.5, turnRate: 1.45, radius: 3.3, sight: 112,
    requires: 'factory',
    weapon: {
      weaponClass: 'cannon', damage: 84, range: 49, cooldown: 2.7, burst: 1,
      projectileSpeed: 170, splash: 3.5, canTargetAir: false, canTargetGround: true,
      vs: vs(0.65, 1.2, 1.0, 1.15),
    },
  },
  artillery: {
    type: 'artillery', label: 'Siege Gun', cost: 1050, buildTime: 18, hp: 270,
    armour: 'light', locomotion: 'tracked', speed: 8.2, turnRate: 1.15, radius: 3.1, sight: 124,
    requires: 'lab',
    weapon: {
      weaponClass: 'cannon', damage: 115, range: 112, cooldown: 5.2, burst: 1,
      projectileSpeed: 78, splash: 13, canTargetAir: false, canTargetGround: true,
      vs: vs(1.6, 1.0, 0.55, 1.4),
    },
  },
  aa: {
    type: 'aa', label: 'Flak Track', cost: 620, buildTime: 11, hp: 350,
    armour: 'light', locomotion: 'wheeled', speed: 14.5, turnRate: 2.5, radius: 2.7, sight: 132,
    requires: 'factory',
    weapon: {
      weaponClass: 'flak', damage: 23, range: 45, cooldown: 0.6, burst: 4, burstDelay: 0.08,
      projectileSpeed: 240, splash: 2.5, canTargetAir: true, canTargetGround: true,
      vs: vs(1.5, 0.8, 0.3, 0.25),
    },
  },
  harvester: {
    type: 'harvester', label: 'Harvester', cost: 900, buildTime: 16, hp: 820,
    armour: 'heavy', locomotion: 'tracked', speed: 10.5, turnRate: 1.35, radius: 3.6, sight: 84,
    cargo: 600, requires: 'refinery',
  },
};

export const BUILDING_STATS: Record<BuildingType, BuildingStats> = {
  hq: {
    type: 'hq', label: 'Construction Yard', cost: 2500, buildTime: 30, hp: 3200,
    footprint: 5, power: -8, sight: 132,
  },
  power: {
    type: 'power', label: 'Power Plant', cost: 400, buildTime: 8, hp: 720,
    footprint: 3, power: 50, sight: 62,
  },
  refinery: {
    type: 'refinery', label: 'Verdium Refinery', cost: 1500, buildTime: 18, hp: 1450,
    footprint: 4, power: -20, sight: 94, requires: 'power',
  },
  barracks: {
    type: 'barracks', label: 'Barracks', cost: 500, buildTime: 10, hp: 900,
    footprint: 3, power: -15, sight: 82, requires: 'power',
    produces: ['rifleman', 'rocketeer', 'engineer'],
  },
  factory: {
    type: 'factory', label: 'War Factory', cost: 2000, buildTime: 22, hp: 1550,
    footprint: 4, power: -30, sight: 92, requires: 'refinery',
    produces: ['harvester', 'scout', 'aa', 'tank', 'artillery'],
  },
  turret: {
    type: 'turret', label: 'Gun Turret', cost: 700, buildTime: 10, hp: 950,
    footprint: 2, power: -12, sight: 104, requires: 'barracks',
    weapon: {
      weaponClass: 'cannon', damage: 62, range: 64, cooldown: 2.2, burst: 1,
      projectileSpeed: 200, splash: 3, canTargetAir: false, canTargetGround: true,
      vs: vs(0.85, 1.2, 1.0, 0.6),
    },
  },
  sam: {
    type: 'sam', label: 'SAM Nest', cost: 800, buildTime: 11, hp: 740,
    footprint: 2, power: -15, sight: 124, requires: 'radar',
    weapon: {
      weaponClass: 'rocket', damage: 46, range: 80, cooldown: 1.5, burst: 2, burstDelay: 0.28,
      projectileSpeed: 96, splash: 3, canTargetAir: true, canTargetGround: true,
      vs: vs(1.35, 1.0, 0.4, 0.2),
    },
  },
  radar: {
    type: 'radar', label: 'Radar Array', cost: 1000, buildTime: 14, hp: 820,
    footprint: 3, power: -25, sight: 224, requires: 'refinery',
  },
  lab: {
    type: 'lab', label: 'Tech Lab', cost: 1800, buildTime: 20, hp: 1050,
    footprint: 3, power: -40, sight: 94, requires: 'radar',
  },
};

/* ------------------------------------------------------------------ *
 * Derived lookup tables. The simulation works in integer type ids so the
 * hot loops never touch a string or a hash map.
 * ------------------------------------------------------------------ */

export const UNIT_LIST: UnitStats[] = UNIT_TYPES.map((t) => UNIT_STATS[t]);
export const BUILDING_LIST: BuildingStats[] = BUILDING_TYPES.map((t) => BUILDING_STATS[t]);

export const UNIT_ID: Record<UnitType, number> = {} as Record<UnitType, number>;
UNIT_TYPES.forEach((t, i) => { UNIT_ID[t] = i; });

export const BUILDING_ID: Record<BuildingType, number> = {} as Record<BuildingType, number>;
BUILDING_TYPES.forEach((t, i) => { BUILDING_ID[t] = i; });

export const ARMOUR_ID: Record<ArmourClass, number> = { flesh: 0, light: 1, heavy: 2, structure: 3 };

/** Integer armour id per unit type id, and the constant `structure` for buildings. */
export const UNIT_ARMOUR: Uint8Array = new Uint8Array(UNIT_LIST.map((s) => ARMOUR_ID[s.armour]));
export const ARMOUR_STRUCTURE = ARMOUR_ID.structure;

/**
 * Flat weapon registry. Projectiles carry an integer weapon id, which indexes
 * both the stats object and a 4-entry armour multiplier table.
 */
export const WEAPONS: WeaponStats[] = [];
export const WEAPON_VS: Float32Array[] = [];
const weaponIds = new Map<WeaponStats, number>();

function registerWeapon(w: WeaponStats | undefined): number {
  if (!w) return -1;
  const existing = weaponIds.get(w);
  if (existing !== undefined) return existing;
  const id = WEAPONS.length;
  WEAPONS.push(w);
  const table = new Float32Array(4);
  for (let i = 0; i < 4; i++) table[i] = w.vs[ARMOUR_CLASSES[i]];
  WEAPON_VS.push(table);
  weaponIds.set(w, id);
  return id;
}

/** weapon id per unit type id; -1 when unarmed. */
export const UNIT_WEAPON: Int16Array = new Int16Array(UNIT_LIST.map((s) => registerWeapon(s.weapon)));
/** weapon id per building type id; -1 when unarmed. */
export const BUILDING_WEAPON: Int16Array = new Int16Array(BUILDING_LIST.map((s) => registerWeapon(s.weapon)));

export function weaponVs(weaponId: number, armourId: number): number {
  return WEAPON_VS[weaponId][armourId];
}

/** Projectile behaviour derived from the weapon's class and speed. */
export const PROJ_HITSCAN = 0;
export const PROJ_DIRECT = 1;
export const PROJ_BALLISTIC = 2;
export const PROJ_HOMING = 3;

export function projectileKind(w: WeaponStats): number {
  if (w.projectileSpeed <= 0) return PROJ_HITSCAN;
  if (w.weaponClass === 'rocket') return PROJ_HOMING;
  // A long, slow cannon shell is a siege arc; a fast one is a flat trajectory.
  if (w.weaponClass === 'cannon' && w.range > 80) return PROJ_BALLISTIC;
  return PROJ_DIRECT;
}

export const PROJ_KIND: Int8Array = new Int8Array(WEAPONS.map((w) => projectileKind(w)));

/** Rough combat value used by the AI to weigh army strength. */
export const UNIT_VALUE: Float32Array = new Float32Array(
  UNIT_LIST.map((s) => (s.weapon ? s.cost : s.cost * 0.15)),
);

/** True for units that exist to gather, not to fight. */
export const UNIT_IS_CIVILIAN: Uint8Array = new Uint8Array(
  UNIT_LIST.map((s) => (s.type === 'harvester' || s.type === 'engineer' ? 1 : 0)),
);

export function isUnitType(id: string): id is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(id);
}

export function isBuildingType(id: string): id is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(id);
}

/** Which structure type can produce this unit type; -1 when nothing can. */
export const UNIT_PRODUCER: Int8Array = new Int8Array(UNIT_LIST.length).fill(-1);
for (let b = 0; b < BUILDING_LIST.length; b++) {
  const produces = BUILDING_LIST[b].produces;
  if (!produces) continue;
  for (const u of produces) UNIT_PRODUCER[UNIT_ID[u]] = b;
}

/** Structures the player may queue from the construction yard. */
export const CONSTRUCTABLE: number[] = BUILDING_TYPES
  .map((t, i) => (t === 'hq' ? -1 : i))
  .filter((i) => i >= 0);
