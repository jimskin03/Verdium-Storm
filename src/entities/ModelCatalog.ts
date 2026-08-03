import * as THREE from 'three';
import { provide } from '@/engine/Services';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { makeRng } from '@/util/Noise';
import type {
  BuildingRig,
  BuildingType,
  DamageState,
  Faction,
  ModelCatalog as ModelCatalogContract,
  Team,
  UnitRig,
  UnitType,
} from '@/entities/Types';
import { EntityMaterials } from '@/entities/materials/EntityMaterials';
import { EntityRig, type RigAsset } from '@/entities/EntityRig';
import type { RigDef } from '@/entities/units/RigDef';
import { buildInfantry } from '@/entities/units/Infantry';
import { buildVehicle } from '@/entities/units/Vehicles';
import { buildStructure } from '@/entities/units/Structures';
import { BUILDING_STATS } from '@/game/sim/Stats';
import { NAV_CELL } from '@/game/sim/Nav';

/**
 * The mesh factory. Geometry is authored once per (archetype, faction, detail)
 * and shared by every instance; only the skeleton and the handful of animation
 * scalars are per entity. The whole game therefore runs on 26 unit/structure
 * geometries and six materials.
 *
 * Nothing here is fetched. Every vertex, every texture and every surface
 * property is generated in code at boot.
 */

const INFANTRY: ReadonlySet<UnitType> = new Set<UnitType>(['rifleman', 'rocketeer', 'engineer']);

export class ModelCatalog implements System, ModelCatalogContract {
  readonly name = 'modelCatalog';
  /**
   * Ahead of the simulation so `init` registers the catalogue before the
   * battlefield spawns its first unit; the per-frame animation pass runs in
   * `lateUpdate`, which is after every system's `update`.
   */
  readonly phase = Phase.SIMULATION - 10;

  private materials!: EntityMaterials;
  private assets = new Map<string, RigAsset>();
  private rigs: EntityRig[] = [];
  private scene!: THREE.Scene;
  private detail = 1;
  private rng = makeRng(0x5a17c0);
  private elapsed = 0;

  init(ctx: EngineContext): void {
    this.scene = ctx.scene;
    const tier = ctx.quality.tier;
    this.detail = tier === 'low' || tier === 'medium' ? 0 : 1;
    this.materials = new EntityMaterials(ctx.renderer, ctx.quality);
    provide('models', this);
  }

  /* ================================================================== *
   * Asset construction
   * ================================================================== */

  private asset(key: string, make: () => { def: RigDef; geometry: THREE.BufferGeometry }): RigAsset {
    const found = this.assets.get(key);
    if (found) return found;
    const built = make();
    const asset: RigAsset = {
      geometry: built.geometry,
      def: built.def,
      pivotY: bindWorldY(built.def, built.def.barrel ?? built.def.turret ?? built.def.spine),
    };
    // Parts swing, rise and recoil well outside the bind pose, so the shared
    // bounding sphere is padded rather than culling limbs mid-animation.
    const bs = asset.geometry.boundingSphere;
    if (bs) bs.radius *= 1.6;
    this.assets.set(key, asset);
    return asset;
  }

  private unitAsset(type: UnitType, faction: Faction): RigAsset {
    return this.asset(`u:${type}:${faction}`, () => {
      const build = INFANTRY.has(type)
        ? buildInfantry(type, faction, this.detail)
        : buildVehicle(type as 'tank' | 'artillery' | 'aa' | 'scout' | 'harvester', faction, this.detail);
      return { def: build.def, geometry: build.builder.build() };
    });
  }

  private buildingAsset(type: BuildingType, faction: Faction): RigAsset {
    return this.asset(`b:${type}:${faction}`, () => {
      const size = BUILDING_STATS[type].footprint * NAV_CELL;
      const build = buildStructure(type, faction, this.detail, size);
      return { def: build.def, geometry: build.builder.build() };
    });
  }

  /* ================================================================== *
   * ModelCatalog contract
   * ================================================================== */

  createUnit(type: UnitType, faction: Faction, team: Team): UnitRig {
    const rig = new EntityRig(this.unitAsset(type, faction), team, this, this.rng());
    this.rigs.push(rig);
    return rig;
  }

  createBuilding(type: BuildingType, faction: Faction, team: Team): BuildingRig {
    const rig = new EntityRig(this.buildingAsset(type, faction), team, this, this.rng());
    this.rigs.push(rig);
    return rig;
  }

  /** Material source for the rigs; one instance per (team, damage state). */
  material(team: Team, damage: DamageState): THREE.Material {
    return this.materials.material(team, damage);
  }

  update(dt: number, elapsed: number): void {
    this.elapsed = elapsed;
    this.materials.update(elapsed);
    this.materials.syncEnvironment(this.scene);
  }

  /**
   * Animation integration. Runs after every system update — including the
   * simulation, which is what feeds `aimAt`, `locomote` and `recoil` — so the
   * frame that is about to be drawn already reflects this tick's orders.
   */
  lateUpdate(dt: number): void {
    const rigs = this.rigs;
    for (let i = rigs.length - 1; i >= 0; i--) {
      const rig = rigs[i];
      if (rig.disposed) {
        rigs.splice(i, 1);
        continue;
      }
      rig.tick(dt);
    }
  }

  dispose(): void {
    for (const rig of this.rigs) rig.dispose();
    this.rigs.length = 0;
    for (const asset of this.assets.values()) asset.geometry.dispose();
    this.assets.clear();
    this.materials?.dispose();
  }
}

/** Accumulated bind-pose Y of a bone, used to place the elevation pivot. */
function bindWorldY(def: RigDef, bone: number | undefined): number {
  if (bone === undefined) return def.height * 0.5;
  let y = 0;
  let cursor = bone;
  let guard = 0;
  while (cursor >= 0 && guard++ < 64) {
    const spec = def.bones[cursor];
    if (!spec) break;
    y += spec.pos[1];
    cursor = spec.parent;
  }
  return y;
}

export default ModelCatalog;
