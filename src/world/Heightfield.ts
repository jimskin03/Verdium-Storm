import * as THREE from 'three';
import { clamp, fbm2, ridged2, smoothstep, valueNoise2 } from '@/util/Noise';

/**
 * The canonical definition of the battlefield's shape. Terrain rendering, water,
 * vegetation scattering, pathfinding and building placement all sample this —
 * it is the single source of truth for "where is the ground".
 *
 * The map is a square centred on the origin. Height is authored in world units;
 * `WATER_LEVEL` is the sea plane, and buildable ground sits above it.
 */

export const WORLD_SIZE = 1024;
export const HALF_WORLD = WORLD_SIZE / 2;
export const WATER_LEVEL = 0;

/** Flat pads carved into the terrain so bases and choke points read clearly. */
interface Plateau {
  x: number;
  z: number;
  radius: number;
  falloff: number;
  height: number;
}

const PLATEAUS: Plateau[] = [
  { x: -300, z: -300, radius: 105, falloff: 95, height: 15 },
  { x: 300, z: 300, radius: 105, falloff: 95, height: 15 },
  { x: 0, z: 0, radius: 130, falloff: 110, height: 9 },
  { x: -320, z: 300, radius: 78, falloff: 70, height: 21 },
  { x: 320, z: -300, radius: 78, falloff: 70, height: 21 },
];

/** Ridge lines that break line of sight and force flanking routes. */
const RIDGES: Array<{ x: number; z: number; radius: number; height: number }> = [
  { x: -80, z: 210, radius: 130, height: 46 },
  { x: 90, z: -215, radius: 130, height: 46 },
  { x: 330, z: 40, radius: 105, height: 38 },
  { x: -330, z: -40, radius: 105, height: 38 },
];

const SEED = 20260730;

/** Raw procedural terrain before plateau flattening. */
function baseHeight(x: number, z: number): number {
  const nx = x / 620;
  const nz = z / 620;

  // Continental shape — large, slow undulation that defines the basin.
  const continental = fbm2(nx * 0.85, nz * 0.85, { octaves: 4, gain: 0.52, seed: SEED }) * 46;

  // Mountain ridges, masked so they hug the map edges and named ridge lines.
  const ridgeMask = smoothstep(0.32, 0.95, Math.max(Math.abs(x), Math.abs(z)) / HALF_WORLD);
  const ridges = ridged2(nx * 2.1, nz * 2.1, { octaves: 5, gain: 0.5, seed: SEED + 401 });
  const mountains = ridges * ridges * 168 * ridgeMask;

  // Mid-frequency rolling hills.
  const hills = fbm2(nx * 3.4, nz * 3.4, { octaves: 4, gain: 0.48, seed: SEED + 77 }) * 13;

  // Fine detail; kept small so silhouettes stay readable from the RTS camera.
  const detail = fbm2(nx * 12.5, nz * 12.5, { octaves: 3, gain: 0.45, seed: SEED + 913 }) * 2.4;

  let h = 16 + continental + mountains + hills + detail;

  for (const r of RIDGES) {
    const d = Math.hypot(x - r.x, z - r.z);
    const t = 1 - smoothstep(0, r.radius, d);
    h += r.height * t * t;
  }

  // Central river basin cut diagonally across the map.
  const river = Math.abs((x + z) * 0.7071 + valueNoise2(x / 210, z / 210, SEED + 55) * 46);
  h -= (1 - smoothstep(26, 108, river)) * 34;

  return h;
}

function plateauBlend(x: number, z: number, h: number): number {
  let out = h;
  for (const p of PLATEAUS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d > p.radius + p.falloff) continue;
    const t = 1 - smoothstep(p.radius, p.radius + p.falloff, d);
    // Ease into the pad so the edge reads as a graded slope, not a cliff.
    const w = t * t * (3 - 2 * t);
    out = out * (1 - w) + p.height * w;
  }
  return out;
}

/** Falls away to the sea at the map boundary so there is no visible edge. */
function boundaryFalloff(x: number, z: number, h: number): number {
  const edge = Math.max(Math.abs(x), Math.abs(z)) / HALF_WORLD;
  const t = smoothstep(0.86, 1.02, edge);
  return h * (1 - t) + (WATER_LEVEL - 30) * t;
}

export function heightAt(x: number, z: number): number {
  return boundaryFalloff(x, z, plateauBlend(x, z, baseHeight(x, z)));
}

const EPS = 0.75;

export function normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const hl = heightAt(x - EPS, z);
  const hr = heightAt(x + EPS, z);
  const hd = heightAt(x, z - EPS);
  const hu = heightAt(x, z + EPS);
  return out.set(hl - hr, 2 * EPS, hd - hu).normalize();
}

const tmpNormal = new THREE.Vector3();

/** 0 = flat ground, 1 = vertical wall. */
export function slopeAt(x: number, z: number): number {
  normalAt(x, z, tmpNormal);
  return clamp(1 - tmpNormal.y, 0, 1);
}

export function isWater(x: number, z: number): boolean {
  return heightAt(x, z) < WATER_LEVEL;
}

/** True where a structure can legally be placed: dry, flat, inside the map. */
export function isBuildable(x: number, z: number): boolean {
  if (Math.abs(x) > HALF_WORLD - 40 || Math.abs(z) > HALF_WORLD - 40) return false;
  const h = heightAt(x, z);
  if (h < WATER_LEVEL + 2.5) return false;
  return slopeAt(x, z) < 0.28;
}

/**
 * Marches a ray against the heightfield. Coarse steps with a binary refinement,
 * which is accurate enough for cursor picking at RTS camera distances.
 */
export function raycastHeightfield(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  out: THREE.Vector3,
  maxDistance = 4000,
): THREE.Vector3 | null {
  let t = 0;
  let prevT = 0;
  let prevDelta = origin.y - heightAt(origin.x, origin.z);
  if (prevDelta < 0) return null; // starting underground

  const step = 4;
  while (t < maxDistance) {
    t += step * (1 + t * 0.012); // widen steps with distance
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const delta = py - heightAt(px, pz);
    if (delta <= 0) {
      // Bisect between the last two samples for a tight hit point.
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) * 0.5;
        const mx = origin.x + dir.x * mid;
        const my = origin.y + dir.y * mid;
        const mz = origin.z + dir.z * mid;
        if (my - heightAt(mx, mz) > 0) lo = mid;
        else hi = mid;
      }
      const ft = (lo + hi) * 0.5;
      return out.set(origin.x + dir.x * ft, origin.y + dir.y * ft, origin.z + dir.z * ft);
    }
    prevT = t;
    prevDelta = delta;
  }
  return null;
}

export const BASE_POSITIONS = {
  player: new THREE.Vector3(-300, 0, -300),
  enemy: new THREE.Vector3(300, 0, 300),
};

/** Verdium crystal deposits — the economy's resource nodes. */
export const RESOURCE_FIELDS: Array<{ x: number; z: number; radius: number; amount: number }> = [
  { x: -210, z: -320, radius: 46, amount: 12000 },
  { x: -330, z: -180, radius: 42, amount: 10000 },
  { x: 210, z: 320, radius: 46, amount: 12000 },
  { x: 330, z: 180, radius: 42, amount: 10000 },
  { x: -60, z: 90, radius: 54, amount: 16000 },
  { x: 60, z: -90, radius: 54, amount: 16000 },
  { x: -350, z: 355, radius: 38, amount: 9000 },
  { x: 350, z: -355, radius: 38, amount: 9000 },
];

export { PLATEAUS };
