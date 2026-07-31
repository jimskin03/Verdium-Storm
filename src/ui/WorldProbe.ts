import * as THREE from 'three';
import type { Team } from '@/entities/Types';

/**
 * Optional extension the HUD duck-types onto {@link GameStateService}.
 *
 * `GameStateService` describes selections and minimap blips but carries no
 * world transform for a specific entity, so there is no contractual way to put
 * a selection decal under a unit or a health bar over it. The HUD therefore
 * probes for these methods and simply skips the in-world layer when the
 * simulation does not offer them. The mock implements the whole interface, so
 * the layer is fully exercised standalone.
 */
export interface WorldProbe {
  /** World pose of one entity; returns null when the id is gone. */
  entityPose?(id: number, out: THREE.Vector3): THREE.Vector3 | null;
  /** Bounding radius used to size the selection decal. */
  entityRadius?(id: number): number;
  /** Everything that currently deserves a floating health bar. */
  healthTargets?(): HealthTarget[];
}

export interface HealthTarget {
  id: number;
  hp: number;
  maxHp: number;
  team: Team;
  /** Height above ground at which the bar should float. */
  height: number;
  position: THREE.Vector3;
  selected: boolean;
}

export function asProbe(service: unknown): WorldProbe {
  return (service ?? {}) as WorldProbe;
}

/* ------------------------------------------------------------------------- *
 * Simulation-backed probe
 * ------------------------------------------------------------------------- */

/**
 * Structure-of-arrays entity store, as the simulation stream happens to lay it
 * out. Described structurally rather than imported: the workstream contract
 * forbids depending on another stream's concrete classes, and the HUD must keep
 * working if this shape ever changes — {@link simProbe} returns null instead.
 */
interface StoreLike {
  live: Int32Array;
  liveCount: number;
  refreshLive(): void;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  hp: Float32Array;
  maxHp: Float32Array;
  team: Uint8Array;
  type: Uint8Array;
  visible: Uint8Array;
  selected: Uint8Array;
  rigs?: Array<{ root?: THREE.Object3D } | null>;
}

function isStore(value: unknown): value is StoreLike {
  const s = value as Partial<StoreLike> | undefined;
  return (
    !!s &&
    s.live instanceof Int32Array &&
    typeof s.liveCount === 'number' &&
    typeof s.refreshLive === 'function' &&
    s.px instanceof Float32Array &&
    s.hp instanceof Float32Array &&
    s.maxHp instanceof Float32Array &&
    s.visible instanceof Uint8Array &&
    s.selected instanceof Uint8Array
  );
}

/** Ids are namespaced so a unit slot and a building slot never collide. */
const BUILDING_ID_BASE = 1 << 20;

/**
 * Builds a probe over a live simulation.
 *
 * `GameStateService` deliberately carries no per-entity transforms, but a HUD
 * without floating health bars fails the visual bar, so the layer is fed from
 * the simulation's own stores when their shape is recognisable. Everything read
 * here is read-only, and any mismatch degrades to "no in-world layer" rather
 * than an exception.
 */
export function simProbe(service: unknown): WorldProbe | null {
  const sim = (service as { sim?: { units?: unknown; buildings?: unknown } } | undefined)?.sim;
  if (!sim || !isStore(sim.units) || !isStore(sim.buildings)) return null;
  const units = sim.units;
  const buildings = sim.buildings;

  const targets: HealthTarget[] = [];
  const pool: THREE.Vector3[] = [];
  // Bar height is measured off the first rig seen for each type, so a tank's
  // bar floats over its turret and a construction yard's clears the roof.
  const unitHeights = new Map<number, number>();
  const buildingHeights = new Map<number, number>();
  const box = new THREE.Box3();

  const heightOf = (store: StoreLike, slot: number, cache: Map<number, number>, fallback: number): number => {
    const type = store.type ? store.type[slot] : 0;
    const known = cache.get(type);
    if (known !== undefined) return known;
    let height = fallback;
    const root = store.rigs?.[slot]?.root;
    if (root) {
      try {
        box.setFromObject(root);
        if (Number.isFinite(box.max.y) && Number.isFinite(box.min.y)) {
          height = Math.max(fallback * 0.5, box.max.y - store.py[slot] + fallback * 0.32);
        }
      } catch {
        height = fallback;
      }
    }
    cache.set(type, height);
    return height;
  };

  const collect = (store: StoreLike, base: number, cache: Map<number, number>, fallback: number): void => {
    store.refreshLive();
    for (let n = 0; n < store.liveCount; n++) {
      const i = store.live[n];
      if (!store.visible[i]) continue;
      const selected = store.selected[i] === 1;
      const max = store.maxHp[i];
      if (!selected && (max <= 0 || store.hp[i] > max * 0.995)) continue;
      const index = targets.length;
      let position = pool[index];
      if (!position) {
        position = new THREE.Vector3();
        pool[index] = position;
      }
      position.set(store.px[i], store.py[i], store.pz[i]);
      targets.push({
        id: base + i,
        hp: store.hp[i],
        maxHp: max,
        team: (store.team[i] & 1) as Team,
        height: heightOf(store, i, cache, fallback),
        position,
        selected,
      });
    }
  };

  return {
    healthTargets(): HealthTarget[] {
      targets.length = 0;
      collect(units, 0, unitHeights, 5.5);
      collect(buildings, BUILDING_ID_BASE, buildingHeights, 13);
      return targets;
    },
    entityRadius(id: number): number {
      return id >= BUILDING_ID_BASE ? 9 : 4;
    },
  };
}
