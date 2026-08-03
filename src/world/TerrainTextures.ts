import * as THREE from 'three';
import type { QualitySettings } from '@/engine/System';
import { WATER_LEVEL, heightAt } from '@/world/Heightfield';
import { fbm2, ridged2, smoothstep } from '@/util/Noise';
import { TERRAIN_NOISE_GLSL } from '@/shaders/terrain/noise.glsl';
import { TERRAIN_LAYERS_GLSL } from '@/shaders/terrain/layers.glsl';
import {
  SYNTH_ALBEDO_FRAGMENT,
  SYNTH_MACRO_FRAGMENT,
  SYNTH_SURFACE_FRAGMENT,
  SYNTH_VERTEX,
} from '@/shaders/terrain/synthesis.glsl';

/**
 * Runtime synthesis of the terrain's material library.
 *
 * Seven PBR layers are rendered into offscreen targets by procedural shaders,
 * read back and packed into two texture arrays:
 *
 *   albedo[i]  = RGB albedo (sRGB), A = displacement height
 *   surface[i] = RG tangent normal, B = roughness, A = ambient occlusion
 *
 * Doing it on the GPU rather than in JS keeps boot to a few hundred
 * milliseconds on real hardware, and the arrays let the terrain shader switch
 * layers per fragment with a single sampler and correct mip chains.
 */

export const TERRAIN_LAYER_COUNT = 7;

/** Index of each layer inside the arrays; mirrors the constants in layers.glsl. */
export const TerrainLayer = {
  DryGrass: 0,
  LushGrass: 1,
  Dirt: 2,
  Mud: 3,
  Gravel: 4,
  Rock: 5,
  Scorched: 6,
} as const;

/** Normal-map strength per layer — rock is carved, mud is nearly smooth. */
const LAYER_BUMP = [0.030, 0.030, 0.026, 0.020, 0.034, 0.052, 0.028];

export interface TerrainTextureSet {
  albedo: THREE.DataArrayTexture;
  surface: THREE.DataArrayTexture;
  /** World-space biome / patch / wear / luminance masks. */
  macro: THREE.Texture;
  dispose(): void;
}

function layerResolution(quality: QualitySettings): number {
  switch (quality.tier) {
    case 'low':
      return 256;
    case 'medium':
      return 384;
    default:
      return 512;
  }
}

export function synthesizeTerrainTextures(
  renderer: THREE.WebGLRenderer,
  quality: QualitySettings,
  macroExtent: number,
): TerrainTextureSet {
  const size = layerResolution(quality);
  const macroSize = quality.tier === 'low' ? 512 : 1024;

  const quad = new THREE.PlaneGeometry(1, 1);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(quad);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const common = TERRAIN_NOISE_GLSL + TERRAIN_LAYERS_GLSL;

  const albedoMat = new THREE.ShaderMaterial({
    vertexShader: SYNTH_VERTEX,
    fragmentShader: common + SYNTH_ALBEDO_FRAGMENT,
    uniforms: { uLayer: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });
  const surfaceMat = new THREE.ShaderMaterial({
    vertexShader: SYNTH_VERTEX,
    fragmentShader: common + SYNTH_SURFACE_FRAGMENT,
    uniforms: {
      uLayer: { value: 0 },
      uTexel: { value: 1 / size },
      uBump: { value: LAYER_BUMP[0] },
    },
    depthTest: false,
    depthWrite: false,
  });

  const target = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });

  const bytesPerLayer = size * size * 4;
  const albedoData = new Uint8Array(bytesPerLayer * TERRAIN_LAYER_COUNT);
  const surfaceData = new Uint8Array(bytesPerLayer * TERRAIN_LAYER_COUNT);
  const slice = new Uint8Array(bytesPerLayer);

  const previousTarget = renderer.getRenderTarget();

  for (let layer = 0; layer < TERRAIN_LAYER_COUNT; layer++) {
    mesh.material = albedoMat;
    albedoMat.uniforms.uLayer.value = layer;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, slice);
    albedoData.set(slice, layer * bytesPerLayer);

    mesh.material = surfaceMat;
    surfaceMat.uniforms.uLayer.value = layer;
    surfaceMat.uniforms.uBump.value = LAYER_BUMP[layer];
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, slice);
    surfaceData.set(slice, layer * bytesPerLayer);
  }

  const albedo = new THREE.DataArrayTexture(albedoData, size, size, TERRAIN_LAYER_COUNT);
  albedo.format = THREE.RGBAFormat;
  albedo.type = THREE.UnsignedByteType;
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.RepeatWrapping;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.magFilter = THREE.LinearFilter;
  albedo.generateMipmaps = true;
  albedo.anisotropy = quality.anisotropy;
  albedo.needsUpdate = true;

  const surface = new THREE.DataArrayTexture(surfaceData, size, size, TERRAIN_LAYER_COUNT);
  surface.format = THREE.RGBAFormat;
  surface.type = THREE.UnsignedByteType;
  surface.colorSpace = THREE.NoColorSpace;
  surface.wrapS = THREE.RepeatWrapping;
  surface.wrapT = THREE.RepeatWrapping;
  surface.minFilter = THREE.LinearMipmapLinearFilter;
  surface.magFilter = THREE.LinearFilter;
  surface.generateMipmaps = true;
  surface.anisotropy = quality.anisotropy;
  surface.needsUpdate = true;

  // The macro mask never leaves the GPU — nothing on the CPU needs to read it.
  const macroTarget = new THREE.WebGLRenderTarget(macroSize, macroSize, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });

  const macroMat = new THREE.ShaderMaterial({
    vertexShader: SYNTH_VERTEX,
    fragmentShader: TERRAIN_NOISE_GLSL + SYNTH_MACRO_FRAGMENT,
    uniforms: { uExtent: { value: macroExtent } },
    depthTest: false,
    depthWrite: false,
  });
  mesh.material = macroMat;
  renderer.setRenderTarget(macroTarget);
  renderer.render(scene, camera);

  renderer.setRenderTarget(previousTarget);

  quad.dispose();
  albedoMat.dispose();
  surfaceMat.dispose();
  macroMat.dispose();
  target.dispose();

  return {
    albedo,
    surface,
    macro: macroTarget.texture,
    dispose() {
      albedo.dispose();
      surface.dispose();
      macroTarget.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Terrain height field
// ---------------------------------------------------------------------------

/** Half-extent of the authoritative field sampled from the shared heightfield. */
export const FIELD_NEAR_EXTENT = 576;
/** Half-extent of the surrounding scenery field. */
export const FIELD_FAR_EXTENT = 5120;
/** World max-norm at which the shader switches from the near to the far field. */
export const FIELD_NEAR_LIMIT = 545;
/** Texel resolution of each field layer. */
export const FIELD_RES = 1024;

/** Resolution of the min/max pyramid used for quadtree culling and LOD. */
const BOUNDS_RES = 512;
const BOUNDS_LEVELS = 10; // 2^0 .. 2^9

const DISTANT_SEED = 20260730;
const SEA_FLOOR = WATER_LEVEL - 30;

/**
 * Scenery beyond the playable square. The shared heightfield already flattens to
 * `SEA_FLOOR` outside 1.02 of the half-world, so this picks up from exactly that
 * value, keeps it out to 600 units, then raises an irregular coastline, foothills
 * and finally a wall of ranges tall enough to close the horizon from any camera
 * angle. Nothing here is playable or collidable — it exists to give the map a
 * sense of place instead of a void past the map edge.
 */
function distantHeight(x: number, z: number): number {
  const m = Math.max(Math.abs(x), Math.abs(z));
  if (m <= 600) return SEA_FLOOR;

  const gate = smoothstep(600, 712, m);
  const coast = fbm2(x / 780, z / 780, { octaves: 3, gain: 0.5, seed: DISTANT_SEED + 11 });
  const shore = smoothstep(680, 1180, m + coast * 300) * gate;
  if (shore <= 0) return SEA_FLOOR;

  const far = smoothstep(950, 3300, m);
  const roll = fbm2(x / 1500, z / 1500, { octaves: 3, gain: 0.5, seed: DISTANT_SEED + 31 });
  const range = ridged2(x / 1250, z / 1250, { octaves: 4, gain: 0.52, seed: DISTANT_SEED + 77 });
  const spurs = ridged2(x / 430, z / 430, { octaves: 3, gain: 0.5, seed: DISTANT_SEED + 131 });

  const land =
    16 +
    roll * 72 +
    range * range * (105 + 470 * far) +
    spurs * spurs * (16 + 74 * far) +
    far * far * 120;

  return SEA_FLOOR * (1 - shore) + land * shore;
}

/** Catmull-Rom weights; `t` is the fractional position between samples 1 and 2. */
function catmull(t: number, out: Float32Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1;
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}

/**
 * Bicubic 2x upsample. Sampling the (expensive) heightfield on a coarse grid and
 * reconstructing smoothly costs a quarter of the CPU time of a direct bake and
 * loses nothing: the shared heightfield's finest feature is a ~17 unit ridge
 * wavelength, an order of magnitude above the coarse sample spacing.
 */
function upsample2x(src: Float32Array, n: number): Float32Array {
  const n2 = n * 2;
  const row = new Float32Array(n2 * n);
  const wLo = new Float32Array(4);
  const wHi = new Float32Array(4);
  catmull(0.75, wLo);
  catmull(0.25, wHi);
  const clampI = (i: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

  // Horizontal pass.
  for (let j = 0; j < n; j++) {
    const o = j * n;
    for (let i = 0; i < n2; i++) {
      const k = i >> 1;
      const w = (i & 1) === 0 ? wLo : wHi;
      const base = (i & 1) === 0 ? k - 2 : k - 1;
      row[j * n2 + i] =
        src[o + clampI(base)] * w[0] +
        src[o + clampI(base + 1)] * w[1] +
        src[o + clampI(base + 2)] * w[2] +
        src[o + clampI(base + 3)] * w[3];
    }
  }

  // Vertical pass.
  const out = new Float32Array(n2 * n2);
  for (let j = 0; j < n2; j++) {
    const k = j >> 1;
    const w = (j & 1) === 0 ? wLo : wHi;
    const base = (j & 1) === 0 ? k - 2 : k - 1;
    const r0 = clampI(base) * n2;
    const r1 = clampI(base + 1) * n2;
    const r2 = clampI(base + 2) * n2;
    const r3 = clampI(base + 3) * n2;
    const o = j * n2;
    for (let i = 0; i < n2; i++) {
      out[o + i] = row[r0 + i] * w[0] + row[r1 + i] * w[1] + row[r2 + i] * w[2] + row[r3 + i] * w[3];
    }
  }
  return out;
}

/** Separable box blur, used to derive a cavity/occlusion term from the field. */
function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const inv = 1 / (radius * 2 + 1);
  const clampI = (i: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

  for (let j = 0; j < n; j++) {
    const o = j * n;
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += src[o + clampI(i)];
    for (let i = 0; i < n; i++) {
      tmp[o + i] = sum * inv;
      sum += src[o + clampI(i + radius + 1)] - src[o + clampI(i - radius)];
    }
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -radius; j <= radius; j++) sum += tmp[clampI(j) * n + i];
    for (let j = 0; j < n; j++) {
      out[j * n + i] = sum * inv;
      sum += tmp[clampI(j + radius + 1) * n + i] - tmp[clampI(j - radius) * n + i];
    }
  }
  return out;
}

/** Coarse min/max height pyramid over the full scenery domain. */
export class HeightBounds {
  private readonly mins: Float32Array[] = [];
  private readonly maxs: Float32Array[] = [];

  constructor(min: Float32Array, max: Float32Array) {
    // Index 0 is the finest (BOUNDS_RES); reduce down to a single cell.
    const levels: Array<{ res: number; min: Float32Array; max: Float32Array }> = [];
    let res = BOUNDS_RES;
    let curMin = min;
    let curMax = max;
    levels.push({ res, min: curMin, max: curMax });
    while (res > 1) {
      const half = res >> 1;
      const nMin = new Float32Array(half * half);
      const nMax = new Float32Array(half * half);
      for (let j = 0; j < half; j++) {
        for (let i = 0; i < half; i++) {
          const a = (j * 2) * res + i * 2;
          const b = a + 1;
          const c = a + res;
          const d = c + 1;
          nMin[j * half + i] = Math.min(curMin[a], curMin[b], curMin[c], curMin[d]);
          nMax[j * half + i] = Math.max(curMax[a], curMax[b], curMax[c], curMax[d]);
        }
      }
      res = half;
      curMin = nMin;
      curMax = nMax;
      levels.push({ res, min: curMin, max: curMax });
    }
    // Store indexed by quadtree depth: depth d has 2^d nodes per axis.
    for (let depth = 0; depth < BOUNDS_LEVELS; depth++) {
      const lvl = levels[levels.length - 1 - depth];
      this.mins.push(lvl.min);
      this.maxs.push(lvl.max);
    }
  }

  /** Height range of the quadtree node at (depth, ix, iz). */
  range(depth: number, ix: number, iz: number, out: { min: number; max: number }): void {
    const d = Math.min(depth, BOUNDS_LEVELS - 1);
    const shift = depth - d;
    const res = 1 << d;
    const x = Math.min(res - 1, Math.max(0, ix >> shift));
    const z = Math.min(res - 1, Math.max(0, iz >> shift));
    const idx = z * res + x;
    out.min = this.mins[d][idx];
    out.max = this.maxs[d][idx];
  }
}

export interface TerrainFieldSet {
  /** RG16F array: R = height, G = curvature. Layer 0 near, layer 1 far. */
  height: THREE.DataArrayTexture;
  /** RGBA8 array: RGB = surface normal, A = cavity occlusion. */
  normal: THREE.DataArrayTexture;
  bounds: HeightBounds;
  dispose(): void;
}

interface FieldLayer {
  height: Float32Array;
  normal: Uint8Array;
  curvature: Float32Array;
}

function buildLayer(
  fine: Float32Array,
  res: number,
  extent: number,
  cavityRadius: number,
): FieldLayer {
  const spacing = (extent * 2) / res;
  const normal = new Uint8Array(res * res * 4);
  const curvature = new Float32Array(res * res);
  const blurred = boxBlur(fine, res, cavityRadius);
  const cavityScale = 1 / (cavityRadius * spacing);
  const clampI = (i: number): number => (i < 0 ? 0 : i >= res ? res - 1 : i);

  for (let j = 0; j < res; j++) {
    const jm = clampI(j - 1) * res;
    const jp = clampI(j + 1) * res;
    const o = j * res;
    for (let i = 0; i < res; i++) {
      const im = clampI(i - 1);
      const ip = clampI(i + 1);
      const h = fine[o + i];
      const hl = fine[o + im];
      const hr = fine[o + ip];
      const hd = fine[jm + i];
      const hu = fine[jp + i];

      // Matches Heightfield.normalAt's convention exactly.
      let nx = hl - hr;
      let ny = 2 * spacing;
      let nz = hd - hu;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const k = (o + i) * 4;
      normal[k] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[k + 2] = Math.round((nz * 0.5 + 0.5) * 255);

      // Cavity: how far this point sits below its own neighbourhood.
      const sink = (blurred[o + i] - h) * cavityScale;
      const ao = 1 - Math.min(1, Math.max(0, (sink - 0.02) / 0.42)) * 0.55;
      normal[k + 3] = Math.round(Math.min(1, Math.max(0, ao)) * 255);

      // Curvature, positive on ridges and convex breaks.
      const lap = (4 * h - hl - hr - hd - hu) / spacing;
      curvature[o + i] = Math.min(1, Math.max(-1, lap * 1.4));
    }
  }
  return { height: fine, normal, curvature };
}

/**
 * Bakes the world's shape into GPU-sampleable fields.
 *
 * The near layer is sampled from the shared `heightAt` — it is a rendering of
 * the authoritative world shape, not a second opinion on it. The far layer is
 * pure scenery generated here.
 */
export function bakeTerrainField(quality: QualitySettings): TerrainFieldSet {
  const coarse = quality.tier === 'low' ? 256 : 512;
  const res = coarse * 2;

  const nearCoarse = new Float32Array(coarse * coarse);
  const nearStep = (FIELD_NEAR_EXTENT * 2) / coarse;
  for (let j = 0; j < coarse; j++) {
    const z = -FIELD_NEAR_EXTENT + (j + 0.5) * nearStep;
    const o = j * coarse;
    for (let i = 0; i < coarse; i++) {
      nearCoarse[o + i] = heightAt(-FIELD_NEAR_EXTENT + (i + 0.5) * nearStep, z);
    }
  }

  const farCoarse = new Float32Array(coarse * coarse);
  const farStep = (FIELD_FAR_EXTENT * 2) / coarse;
  for (let j = 0; j < coarse; j++) {
    const z = -FIELD_FAR_EXTENT + (j + 0.5) * farStep;
    const o = j * coarse;
    for (let i = 0; i < coarse; i++) {
      farCoarse[o + i] = distantHeight(-FIELD_FAR_EXTENT + (i + 0.5) * farStep, z);
    }
  }

  const near = buildLayer(upsample2x(nearCoarse, coarse), res, FIELD_NEAR_EXTENT, 12);
  const far = buildLayer(upsample2x(farCoarse, coarse), res, FIELD_FAR_EXTENT, 8);

  // Pack both layers: RG16F height/curvature, RGBA8 normal/cavity.
  const texels = res * res;
  const heightData = new Uint16Array(texels * 2 * 2);
  const normalData = new Uint8Array(texels * 4 * 2);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < texels; i++) {
    heightData[i * 2] = toHalf(near.height[i]);
    heightData[i * 2 + 1] = toHalf(near.curvature[i]);
    const o = (texels + i) * 2;
    heightData[o] = toHalf(far.height[i]);
    heightData[o + 1] = toHalf(far.curvature[i]);
  }
  normalData.set(near.normal, 0);
  normalData.set(far.normal, texels * 4);

  const height = new THREE.DataArrayTexture(heightData, res, res, 2);
  height.format = THREE.RGFormat;
  height.type = THREE.HalfFloatType;
  height.internalFormat = 'RG16F';
  height.minFilter = THREE.LinearFilter;
  height.magFilter = THREE.LinearFilter;
  height.wrapS = THREE.ClampToEdgeWrapping;
  height.wrapT = THREE.ClampToEdgeWrapping;
  height.generateMipmaps = false;
  height.needsUpdate = true;

  const normal = new THREE.DataArrayTexture(normalData, res, res, 2);
  normal.format = THREE.RGBAFormat;
  normal.type = THREE.UnsignedByteType;
  normal.colorSpace = THREE.NoColorSpace;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  normal.wrapS = THREE.ClampToEdgeWrapping;
  normal.wrapT = THREE.ClampToEdgeWrapping;
  normal.generateMipmaps = true;
  normal.anisotropy = quality.anisotropy;
  normal.needsUpdate = true;

  return {
    height,
    normal,
    bounds: buildBounds(near.height, far.height, res),
    dispose() {
      height.dispose();
      normal.dispose();
    },
  };
}

/** Rasterises both field layers into a single min/max grid over the far extent. */
function buildBounds(nearH: Float32Array, farH: Float32Array, res: number): HeightBounds {
  const cells = BOUNDS_RES * BOUNDS_RES;
  const min = new Float32Array(cells).fill(Infinity);
  const max = new Float32Array(cells).fill(-Infinity);
  const cellSize = (FIELD_FAR_EXTENT * 2) / BOUNDS_RES;

  const scatter = (x: number, z: number, h: number): void => {
    const ix = Math.min(BOUNDS_RES - 1, Math.max(0, ((x + FIELD_FAR_EXTENT) / cellSize) | 0));
    const iz = Math.min(BOUNDS_RES - 1, Math.max(0, ((z + FIELD_FAR_EXTENT) / cellSize) | 0));
    const k = iz * BOUNDS_RES + ix;
    if (h < min[k]) min[k] = h;
    if (h > max[k]) max[k] = h;
  };

  const farStep = (FIELD_FAR_EXTENT * 2) / res;
  for (let j = 0; j < res; j++) {
    const z = -FIELD_FAR_EXTENT + (j + 0.5) * farStep;
    const o = j * res;
    for (let i = 0; i < res; i++) {
      const x = -FIELD_FAR_EXTENT + (i + 0.5) * farStep;
      if (Math.max(Math.abs(x), Math.abs(z)) < FIELD_NEAR_LIMIT) continue;
      scatter(x, z, farH[o + i]);
    }
  }

  const nearStep = (FIELD_NEAR_EXTENT * 2) / res;
  for (let j = 0; j < res; j++) {
    const z = -FIELD_NEAR_EXTENT + (j + 0.5) * nearStep;
    const o = j * res;
    for (let i = 0; i < res; i++) {
      scatter(-FIELD_NEAR_EXTENT + (i + 0.5) * nearStep, z, nearH[o + i]);
    }
  }

  for (let k = 0; k < cells; k++) {
    if (min[k] === Infinity) {
      min[k] = SEA_FLOOR;
      max[k] = SEA_FLOOR;
    }
  }
  return new HeightBounds(min, max);
}
