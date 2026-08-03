import * as THREE from 'three';
import { HALF_WORLD, PLATEAUS, RESOURCE_FIELDS, WATER_LEVEL, WORLD_SIZE, heightAt } from '@/world/Heightfield';
import { clamp, fbm2, smoothstep, worley2 } from '@/util/Noise';

/**
 * A baked, GPU-readable snapshot of the heightfield plus the ecological masks
 * derived from it.
 *
 * Grass is placed entirely on the GPU — the vertex shader looks the ground up
 * in these textures — which is what keeps a million-blade carpet at two draw
 * calls and zero per-frame CPU cost. Trees, rocks and props reuse the same
 * arrays on the CPU so scattering never pays for a fresh `heightAt` storm.
 *
 * Sampling grid: texel `i` sits at world `-HALF + (i + 0.5) * step`, which is
 * exactly the addressing a `texture2D` with `u = (x + HALF) / WORLD` performs,
 * so a bilinear GPU fetch and `heightAtFast` on the CPU agree to the bit.
 */

const HRES = 512; // 2 world units per texel — matches the terrain tessellation
const MRES = 256; // 4 world units per texel — masks are low frequency by design

export interface GroundSample {
  height: number;
  slope: number;
  normalX: number;
  normalZ: number;
  grass: number;
  moisture: number;
  variation: number;
  rock: number;
}

export class TerrainData {
  readonly hstep = WORLD_SIZE / HRES;
  readonly mstep = WORLD_SIZE / MRES;

  /** RGBA per texel: height, normal.x, normal.z, slope. */
  private readonly hfield = new Float32Array(HRES * HRES * 4);
  /** RGBA per texel: grass, moisture, variation, rock — all 0..1. */
  private readonly mfield = new Float32Array(MRES * MRES * 4);

  readonly heightTex: THREE.DataTexture;
  readonly maskTex: THREE.DataTexture;

  /** Squared distance from each plateau/resource centre, for exclusion tests. */
  private readonly keepClear: Array<{ x: number; z: number; r: number }> = [];

  constructor() {
    // --- Pass 1: raw height on the sampling grid. -------------------------
    const h = new Float32Array(HRES * HRES);
    for (let j = 0; j < HRES; j++) {
      const z = -HALF_WORLD + (j + 0.5) * this.hstep;
      for (let i = 0; i < HRES; i++) {
        const x = -HALF_WORLD + (i + 0.5) * this.hstep;
        h[j * HRES + i] = heightAt(x, z);
      }
    }

    // --- Pass 2: normals and slope by central difference on that grid. ----
    const inv2d = 1 / (2 * this.hstep);
    const half = new Uint16Array(HRES * HRES * 4);
    for (let j = 0; j < HRES; j++) {
      const jm = j > 0 ? j - 1 : 0;
      const jp = j < HRES - 1 ? j + 1 : HRES - 1;
      for (let i = 0; i < HRES; i++) {
        const im = i > 0 ? i - 1 : 0;
        const ip = i < HRES - 1 ? i + 1 : HRES - 1;
        const dx = (h[j * HRES + ip] - h[j * HRES + im]) * inv2d;
        const dz = (h[jp * HRES + i] - h[jm * HRES + i]) * inv2d;
        const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
        const nx = -dx * inv;
        const ny = inv;
        const nz = -dz * inv;
        const k = (j * HRES + i) * 4;
        this.hfield[k] = h[j * HRES + i];
        this.hfield[k + 1] = nx;
        this.hfield[k + 2] = nz;
        this.hfield[k + 3] = 1 - ny;
        half[k] = THREE.DataUtils.toHalfFloat(this.hfield[k]);
        half[k + 1] = THREE.DataUtils.toHalfFloat(nx);
        half[k + 2] = THREE.DataUtils.toHalfFloat(nz);
        half[k + 3] = THREE.DataUtils.toHalfFloat(this.hfield[k + 3]);
      }
    }

    this.heightTex = new THREE.DataTexture(half, HRES, HRES, THREE.RGBAFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    // --- Pass 3: ecology masks. ------------------------------------------
    for (const p of PLATEAUS) this.keepClear.push({ x: p.x, z: p.z, r: p.radius * 0.82 });
    for (const f of RESOURCE_FIELDS) this.keepClear.push({ x: f.x, z: f.z, r: f.radius * 0.9 });

    const mbytes = new Uint8Array(MRES * MRES * 4);
    for (let j = 0; j < MRES; j++) {
      const z = -HALF_WORLD + (j + 0.5) * this.mstep;
      for (let i = 0; i < MRES; i++) {
        const x = -HALF_WORLD + (i + 0.5) * this.mstep;
        const gh = this.heightAtFast(x, z);
        const gs = this.slopeAtFast(x, z);

        // Moisture: the river basin and shorelines hold water; ridges do not.
        const basin = 1 - smoothstep(1.5, 34, gh - WATER_LEVEL);
        const regional = fbm2(x / 260, z / 260, { octaves: 3, seed: 8801 }) * 0.5 + 0.5;
        const moisture = clamp(basin * 0.72 + regional * 0.42 - 0.12, 0, 1);

        // Patchiness: overlapping scales so meadows have interior structure
        // rather than one uniform blanket.
        const patch =
          0.44 +
          0.36 * (fbm2(x / 96, z / 96, { octaves: 4, seed: 3301 }) * 0.5 + 0.5) +
          0.28 * (fbm2(x / 27, z / 27, { octaves: 3, seed: 991 }) * 0.5 + 0.5);

        let grass =
          (1 - smoothstep(0.2, 0.44, gs)) *
          smoothstep(0.15, 3.2, gh - WATER_LEVEL) *
          (1 - smoothstep(66, 104, gh)) *
          clamp(patch, 0, 1.25);
        grass *= 0.62 + 0.5 * moisture;

        // Bare cell walls left by worley noise read as animal tracks and dry
        // scrape patches once the blades thin out over them.
        const scrape = smoothstep(0.06, 0.3, worley2(x / 38, z / 38, 5507));
        grass *= 0.45 + 0.55 * scrape;

        const rock = clamp(smoothstep(0.26, 0.5, gs) * 0.85 + smoothstep(62, 108, gh) * 0.6, 0, 1);
        const variation = fbm2(x / 41, z / 41, { octaves: 3, seed: 7717 }) * 0.5 + 0.5;

        const k = (j * MRES + i) * 4;
        this.mfield[k] = clamp(grass, 0, 1);
        this.mfield[k + 1] = moisture;
        this.mfield[k + 2] = variation;
        this.mfield[k + 3] = rock;
        mbytes[k] = Math.round(this.mfield[k] * 255);
        mbytes[k + 1] = Math.round(moisture * 255);
        mbytes[k + 2] = Math.round(variation * 255);
        mbytes[k + 3] = Math.round(rock * 255);
      }
    }

    this.maskTex = new THREE.DataTexture(mbytes, MRES, MRES, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.maskTex.magFilter = THREE.LinearFilter;
    this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.wrapS = THREE.ClampToEdgeWrapping;
    this.maskTex.wrapT = THREE.ClampToEdgeWrapping;
    this.maskTex.generateMipmaps = false;
    this.maskTex.needsUpdate = true;
  }

  /** Bilinear height lookup that matches the GPU fetch exactly. */
  heightAtFast(x: number, z: number): number {
    return this.bilinear(this.hfield, HRES, this.hstep, x, z, 0);
  }

  slopeAtFast(x: number, z: number): number {
    return this.bilinear(this.hfield, HRES, this.hstep, x, z, 3);
  }

  normalAtFast(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const nx = this.bilinear(this.hfield, HRES, this.hstep, x, z, 1);
    const nz = this.bilinear(this.hfield, HRES, this.hstep, x, z, 2);
    return out.set(nx, Math.sqrt(Math.max(1e-4, 1 - nx * nx - nz * nz)), nz).normalize();
  }

  grassAt(x: number, z: number): number {
    return this.bilinear(this.mfield, MRES, this.mstep, x, z, 0);
  }

  moistureAt(x: number, z: number): number {
    return this.bilinear(this.mfield, MRES, this.mstep, x, z, 1);
  }

  variationAt(x: number, z: number): number {
    return this.bilinear(this.mfield, MRES, this.mstep, x, z, 2);
  }

  rockAt(x: number, z: number): number {
    return this.bilinear(this.mfield, MRES, this.mstep, x, z, 3);
  }

  /** True inside a base pad or a crystal field — nothing organic is scattered there. */
  isReserved(x: number, z: number, pad = 0): boolean {
    for (const c of this.keepClear) {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz < (c.r + pad) * (c.r + pad)) return true;
    }
    return false;
  }

  private bilinear(field: Float32Array, res: number, step: number, x: number, z: number, ch: number): number {
    const fx = clamp((x + HALF_WORLD) / step - 0.5, 0, res - 1.001);
    const fz = clamp((z + HALF_WORLD) / step - 0.5, 0, res - 1.001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const s = 4;
    const a = field[(j * res + i) * s + ch];
    const b = field[(j * res + i + 1) * s + ch];
    const c = field[((j + 1) * res + i) * s + ch];
    const d = field[((j + 1) * res + i + 1) * s + ch];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  dispose(): void {
    this.heightTex.dispose();
    this.maskTex.dispose();
  }
}

let cached: TerrainData | null = null;

/** Shared singleton — Vegetation and Props both pay for it exactly once. */
export function getTerrainData(): TerrainData {
  if (!cached) cached = new TerrainData();
  return cached;
}

/**
 * GLSL side of the lookup. Kept in one place so grass, ground cover and any
 * future GPU-placed detail all agree on where the ground is.
 */
export const TERRAIN_DATA_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform sampler2D uMaskTex;
uniform float uWorldSize;
uniform float uHalfWorld;

vec4 vsGround(vec2 world) {
  vec2 uv = (world + uHalfWorld) / uWorldSize;
  return texture2D(uHeightTex, uv);   // height, n.x, n.z, slope
}

vec4 vsMask(vec2 world) {
  vec2 uv = (world + uHalfWorld) / uWorldSize;
  return texture2D(uMaskTex, uv);     // grass, moisture, variation, rock
}

/**
 * Approximate terrain albedo, used to blend distant grass into the ground so
 * the edge of the detail ring never reads as a boundary.
 */
vec3 vsGroundColor(float h, float slope, float moisture) {
  vec3 shore = vec3(0.352, 0.316, 0.234);
  vec3 rock  = vec3(0.286, 0.272, 0.250);
  vec3 dry   = vec3(0.298, 0.312, 0.180);
  vec3 lush  = vec3(0.176, 0.283, 0.132);
  vec3 alp   = vec3(0.410, 0.395, 0.345);
  vec3 c = mix(dry, lush, moisture);
  c = mix(c, alp, smoothstep(66.0, 104.0, h));
  c = mix(c, rock, smoothstep(0.24, 0.5, slope));
  c = mix(shore, c, smoothstep(0.2, 3.4, h));
  return c;
}
`;

export const TERRAIN_DATA_DEFS = {
  uWorldSize: { value: WORLD_SIZE },
  uHalfWorld: { value: HALF_WORLD },
};
