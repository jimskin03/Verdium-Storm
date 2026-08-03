import * as THREE from 'three';
import { HALF_WORLD, WATER_LEVEL, heightAt } from '@/world/Heightfield';

/**
 * A baked description of the sea/lake bed, sampled once from the shared
 * heightfield and handed to the GPU as a single RGBA8 lookup.
 *
 * The water shader needs three things the depth buffer cannot give it:
 *   • how deep the column is at a point, so waves can shoal and die on a beach
 *     *before* the surface would clip through the sand;
 *   • how far a point is from the waterline, so the swash band and the wet-sand
 *     strip can be laid out along the shore rather than in screen space;
 *   • how open the water is, so a sheltered river bend stays calm while the sea
 *     beyond the map carries a real swell.
 *
 * Channels (all normalised into a byte):
 *   R  water depth        depth / DEPTH_RANGE, 0 on land
 *   G  signed shore dist  0.5 + clamp(sd, ±SHORE_RANGE) / (2·SHORE_RANGE); the
 *                         sign is positive on land, negative under water
 *   B  bed gradient       |∇h| / SLOPE_RANGE — gentle beaches foam much wider
 *   A  openness           a heavily blurred depth, driving swell amplitude
 *
 * The grid is deliberately aligned to the terrain tessellation (2 world units,
 * even coordinates) so the wet-sand overlay built from the same samples sits
 * exactly on the terrain surface instead of fighting it.
 */

export const FIELD_STEP = 2;
/** Half-extent of the bake. Beyond ±522 the heightfield is a flat −30 sea, so
 *  clamp-to-edge sampling gives correct open ocean for the whole disc. */
export const FIELD_HALF = 560;
export const FIELD_RES = (FIELD_HALF * 2) / FIELD_STEP + 1; // 561

export const DEPTH_RANGE = 64;
export const SHORE_RANGE = 48;
export const SLOPE_RANGE = 1.6;
export const OPEN_RANGE = 26;

export interface FloorField {
  texture: THREE.DataTexture;
  /** Bed height in world units, row-major, `res`×`res`. */
  heights: Float32Array;
  /** Signed horizontal distance to the waterline; positive on land. */
  shore: Float32Array;
  /** ∂h/∂x and ∂h/∂z per node, world units per world unit. */
  gradX: Float32Array;
  gradZ: Float32Array;
  res: number;
  step: number;
  half: number;
  /** `uv = worldXZ * uvScale + 0.5` maps world space onto texel centres. */
  uvScale: number;
}

/** Wrapped-free clamped index helper. */
const ci = (v: number, n: number): number => (v < 0 ? 0 : v > n ? n : v);

export function buildFloorField(): FloorField {
  const res = FIELD_RES;
  const n = res - 1;
  const heights = new Float32Array(res * res);

  for (let j = 0; j < res; j++) {
    const z = -FIELD_HALF + j * FIELD_STEP;
    for (let i = 0; i < res; i++) {
      heights[j * res + i] = heightAt(-FIELD_HALF + i * FIELD_STEP, z);
    }
  }

  // Gradient over a ±2 cell stencil: wide enough that the terrain's fine detail
  // octave does not dominate the beach slope estimate.
  const gradX = new Float32Array(res * res);
  const gradZ = new Float32Array(res * res);
  const span = 2 * FIELD_STEP * 2;
  for (let j = 0; j < res; j++) {
    const jm = ci(j - 2, n) * res;
    const jp = ci(j + 2, n) * res;
    const j0 = j * res;
    for (let i = 0; i < res; i++) {
      const im = ci(i - 2, n);
      const ip = ci(i + 2, n);
      gradX[j0 + i] = (heights[j0 + ip] - heights[j0 + im]) / span;
      gradZ[j0 + i] = (heights[jp + i] - heights[jm + i]) / span;
    }
  }

  // First-order distance to the h = WATER_LEVEL contour. Exact where it matters
  // (near the waterline, where the gradient is well conditioned) and saturating
  // harmlessly out in deep water or up on a plateau.
  const shore = new Float32Array(res * res);
  for (let k = 0; k < res * res; k++) {
    const g = Math.hypot(gradX[k], gradZ[k]);
    shore[k] = (heights[k] - WATER_LEVEL) / Math.max(g, 0.012);
  }

  // Openness: depth smoothed over ~90 world units. A narrow inlet averages in
  // its shallow banks and stays calm; open sea keeps its full swell.
  let open = new Float32Array(res * res);
  for (let k = 0; k < res * res; k++) open[k] = Math.max(0, WATER_LEVEL - heights[k]);
  open = boxBlurClamped(open, res, 8, 3);

  const data = new Uint8Array(res * res * 4);
  for (let k = 0; k < res * res; k++) {
    const depth = Math.max(0, WATER_LEVEL - heights[k]);
    const g = Math.hypot(gradX[k], gradZ[k]);
    data[k * 4] = byte(depth / DEPTH_RANGE);
    data[k * 4 + 1] = byte(0.5 + clampf(shore[k], -SHORE_RANGE, SHORE_RANGE) / (2 * SHORE_RANGE));
    data[k * 4 + 2] = byte(g / SLOPE_RANGE);
    data[k * 4 + 3] = byte(open[k] / OPEN_RANGE);
  }

  const texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  return {
    texture,
    heights,
    shore,
    gradX,
    gradZ,
    res,
    step: FIELD_STEP,
    half: FIELD_HALF,
    uvScale: 1 / (FIELD_STEP * res),
  };
}

/** True where the world position is inside the playable square. */
export function insidePlayable(x: number, z: number): boolean {
  return Math.abs(x) <= HALF_WORLD && Math.abs(z) <= HALF_WORLD;
}

function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function byte(v: number): number {
  const s = v * 255;
  return s < 0 ? 0 : s > 255 ? 255 : Math.round(s);
}

/** Separable box blur with clamped edges, run `passes` times. */
function boxBlurClamped(src: Float32Array, res: number, radius: number, passes: number): Float32Array {
  const n = res - 1;
  let a = src;
  let b = new Float32Array(res * res);
  const inv = 1 / (radius * 2 + 1);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < res; j++) {
      const row = j * res;
      for (let i = 0; i < res; i++) {
        let sum = 0;
        for (let o = -radius; o <= radius; o++) sum += a[row + ci(i + o, n)];
        b[row + i] = sum * inv;
      }
    }
    for (let i = 0; i < res; i++) {
      for (let j = 0; j < res; j++) {
        let sum = 0;
        for (let o = -radius; o <= radius; o++) sum += b[ci(j + o, n) * res + i];
        a[j * res + i] = sum * inv;
      }
    }
  }
  return a;
}
