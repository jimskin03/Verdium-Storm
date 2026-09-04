import { HALF_WORLD } from '@/world/Heightfield';

/** Keep locally applied and network-relayed destinations inside the same map. */
export function clampCommandCoordinate(value: number): number {
  return Math.max(-HALF_WORLD, Math.min(HALF_WORLD, value));
}
