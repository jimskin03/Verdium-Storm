import type * as THREE from 'three';

/**
 * Shared entity vocabulary. The model stream builds meshes for these types; the
 * simulation stream drives them. Both import this file and neither imports the
 * other.
 */

export type Faction = 'gdi' | 'nod';
export type Team = 0 | 1;

export type UnitType =
  | 'rifleman'      // basic infantry
  | 'rocketeer'     // anti-armour infantry
  | 'engineer'      // capture / repair
  | 'scout'         // fast recon buggy
  | 'tank'          // main battle tank
  | 'artillery'     // long range siege
  | 'aa'            // anti-air vehicle
  | 'harvester';    // resource collection

export type BuildingType =
  | 'hq'            // construction yard
  | 'power'         // power plant
  | 'refinery'      // resource processing
  | 'barracks'      // infantry production
  | 'factory'       // vehicle production
  | 'turret'        // base defence
  | 'sam'           // anti-air defence
  | 'radar'         // vision + minimap
  | 'lab';          // tech unlock

export type Locomotion = 'infantry' | 'wheeled' | 'tracked' | 'hover';
export type ArmourClass = 'flesh' | 'light' | 'heavy' | 'structure';
export type WeaponClass = 'bullet' | 'cannon' | 'rocket' | 'laser' | 'flak';

export interface UnitStats {
  type: UnitType;
  label: string;
  cost: number;
  buildTime: number;
  hp: number;
  armour: ArmourClass;
  locomotion: Locomotion;
  /** World units per second at full speed. */
  speed: number;
  /** Radians per second the hull can yaw. */
  turnRate: number;
  /** Collision/among-units spacing radius in world units. */
  radius: number;
  sight: number;
  weapon?: WeaponStats;
  /** Capacity for harvesters, 0 otherwise. */
  cargo?: number;
  /** Which structure must exist before this can be produced. */
  requires?: BuildingType;
}

export interface WeaponStats {
  weaponClass: WeaponClass;
  damage: number;
  range: number;
  /** Seconds between shots. */
  cooldown: number;
  /** Shots fired per trigger pull. */
  burst?: number;
  /** Seconds between shots inside a burst. */
  burstDelay?: number;
  /** Projectile travel speed; 0 = hitscan. */
  projectileSpeed: number;
  /** Splash radius in world units, 0 for single target. */
  splash: number;
  canTargetAir: boolean;
  canTargetGround: boolean;
  /** Damage multiplier per target armour class. */
  vs: Record<ArmourClass, number>;
}

export interface BuildingStats {
  type: BuildingType;
  label: string;
  cost: number;
  buildTime: number;
  hp: number;
  /** Footprint in grid cells (square). */
  footprint: number;
  /** Positive = generates, negative = consumes. */
  power: number;
  sight: number;
  weapon?: WeaponStats;
  /** Unit types this structure can produce. */
  produces?: UnitType[];
  requires?: BuildingType;
}

/** Damage tiers drive which visual damage state a mesh displays. */
export type DamageState = 'pristine' | 'damaged' | 'critical';

export function damageStateFor(hp: number, maxHp: number): DamageState {
  const f = hp / maxHp;
  return f > 0.66 ? 'pristine' : f > 0.33 ? 'damaged' : 'critical';
}

/**
 * The animation surface a unit mesh exposes to the simulation. The model stream
 * decides how each is realised; the sim stream only sets these values.
 */
export interface UnitRig {
  root: THREE.Object3D;
  /** Aim the turret at a world point. Ignored by units without one. */
  aimAt?(target: THREE.Vector3, dt: number): void;
  /** Current turret facing error in radians; sim gates firing on this. */
  aimError?(): number;
  /** Muzzle world position + direction for VFX, written into the outputs. */
  muzzle?(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  /** Drive locomotion animation. `speed` is world units/sec, `turn` is rad/sec. */
  locomote?(dt: number, speed: number, turn: number): void;
  /** Visual recoil impulse when the weapon fires. */
  recoil?(strength: number): void;
  /** Swap damage visuals: scorching, smoke emitters, missing panels. */
  setDamageState?(state: DamageState): void;
  /** Death animation entry; returns seconds until the mesh can be removed. */
  die?(): number;
  dispose?(): void;
}

export interface BuildingRig {
  root: THREE.Object3D;
  /** 0..1 construction progress; drives the build-up animation. */
  setBuildProgress?(t: number): void;
  aimAt?(target: THREE.Vector3, dt: number): void;
  aimError?(): number;
  muzzle?(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  recoil?(strength: number): void;
  setDamageState?(state: DamageState): void;
  /** Signals production activity so the mesh can animate doors, lights, cranes. */
  setActive?(active: boolean): void;
  die?(): number;
  dispose?(): void;
}

/** Implemented by the model stream, consumed by the simulation stream. */
export interface ModelCatalog {
  createUnit(type: UnitType, faction: Faction, team: Team): UnitRig;
  createBuilding(type: BuildingType, faction: Faction, team: Team): BuildingRig;
  /** Called once per frame so shared materials can animate. */
  update(dt: number, elapsed: number): void;
}

export const TEAM_COLORS: Record<Team, number> = {
  0: 0x3fa9ff,
  1: 0xff5a3c,
};
