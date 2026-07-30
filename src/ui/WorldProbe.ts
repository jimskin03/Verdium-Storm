import type * as THREE from 'three';
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
