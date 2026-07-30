import * as THREE from 'three';
import { clamp, fbm2, gradNoise2, hash2, smoothstep, valueNoise2, worley2 } from '@/util/Noise';
import { WORLD_SIZE, heightAt } from '@/world/Heightfield';

/**
 * Every pixel of VFX art in the game, synthesised at boot. No file is ever
 * fetched: sprites, gradients, decals and the ground-height lookup used by the
 * soft-particle term are all built from the shared noise primitives.
 *
 * Sprites live in a `sampler2DArray` rather than an atlas, which removes tile
 * bleed entirely and lets every layer keep a full mip chain — small distant
 * sparks stay stable instead of crawling.
 *
 * Channel layout for the sprite array:
 *   R,G — tangent-space normal XY, derived by Sobel from a per-tile thickness
 *         field. This is what gives smoke a lit crown and a shaded underside.
 *   B   — intensity/occlusion at half scale (0.5 is neutral, so 0..2 is
 *         addressable): hot cores in emissive sprites, internal creases in
 *         smoke.
 *   A   — coverage.
 */

/** Layer indices into the sprite array texture. */
export const SPRITE = {
  SMOKE_A: 0,
  SMOKE_B: 1,
  SMOKE_WISP: 2,
  BLOB: 3,
  FIRE: 4,
  SPARK: 5,
  STREAK: 6,
  FLASH: 7,
  RING: 8,
  DUST: 9,
  DEBRIS: 10,
  EMBER: 11,
  SPLASH: 12,
  PLUME: 13,
  GLOW: 14,
  SHIMMER: 15,
} as const;

export const SPRITE_LAYERS = 16;

/** Row indices into the colour-over-life ramp texture. */
export const RAMP = {
  FIRE_HOT: 0,
  FIRE_SOFT: 1,
  SMOKE_DARK: 2,
  SMOKE_LIGHT: 3,
  DUST: 4,
  SPARK: 5,
  FLASH: 6,
  SHOCK: 7,
  EMBER: 8,
  WATER: 9,
  OIL_SMOKE: 10,
  CONCRETE: 11,
  PLASMA: 12,
  ROCK: 13,
  METAL: 14,
  HAZE: 15,
} as const;

export const RAMP_ROWS = 16;

/** Layer indices into the decal array texture. */
export const DECAL_TEX = {
  CRATER: 0,
  SCORCH_A: 1,
  SCORCH_B: 2,
  BLAST_RING: 3,
  OIL: 4,
  RUBBLE: 5,
  TREAD: 6,
  CHIP: 7,
} as const;

export const DECAL_LAYERS = 8;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Normalised sprite coordinate in [-1, 1] for texel `i` of `size`. */
const coord = (i: number, size: number): number => ((i + 0.5) / size) * 2 - 1;

function bilinear(field: Float32Array, n: number, u: number, v: number): number {
  const x = clamp(u * (n - 1), 0, n - 1);
  const y = clamp(v * (n - 1), 0, n - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1);
  const y1 = Math.min(y0 + 1, n - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = field[y0 * n + x0];
  const b = field[y0 * n + x1];
  const c = field[y1 * n + x0];
  const d = field[y1 * n + x1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Scratch fields a tile generator fills: coverage, intensity, thickness. */
interface Tile {
  size: number;
  a: Float32Array;
  d: Float32Array;
  h: Float32Array;
}

function newTile(size: number): Tile {
  return {
    size,
    a: new Float32Array(size * size),
    d: new Float32Array(size * size).fill(1),
    h: new Float32Array(size * size),
  };
}

function clearTile(t: Tile): void {
  t.a.fill(0);
  t.d.fill(1);
  t.h.fill(0);
}

/**
 * Packs a finished tile into the array texture. Normals come from a Sobel of
 * the thickness field, which is why every generator bothers to fill `h`.
 */
function writeTile(out: Uint8Array, layer: number, t: Tile, bump: number): void {
  const S = t.size;
  const base = layer * S * S * 4;
  for (let j = 0; j < S; j++) {
    const jm = j > 0 ? j - 1 : 0;
    const jp = j < S - 1 ? j + 1 : S - 1;
    for (let i = 0; i < S; i++) {
      const im = i > 0 ? i - 1 : 0;
      const ip = i < S - 1 ? i + 1 : S - 1;
      const nx = (t.h[j * S + im] - t.h[j * S + ip]) * bump;
      const ny = (t.h[jm * S + i] - t.h[jp * S + i]) * bump;
      const o = base + (j * S + i) * 4;
      out[o] = clamp(nx * 0.5 + 0.5, 0, 1) * 255;
      out[o + 1] = clamp(ny * 0.5 + 0.5, 0, 1) * 255;
      out[o + 2] = clamp(t.d[j * S + i] * 0.5, 0, 1) * 255;
      out[o + 3] = clamp(t.a[j * S + i], 0, 1) * 255;
    }
  }
}

// ---------------------------------------------------------------------------
// Sprite tile generators
// ---------------------------------------------------------------------------

interface CloudOpts {
  seed: number;
  /** Noise frequency; higher reads as finer, colder smoke. */
  freq: number;
  /** Coverage threshold — raise it for wispy, lower it for dense. */
  threshold: number;
  /** How ragged the silhouette gets. */
  lobe: number;
  /** Radial tightness of the puff. */
  falloff: number;
  /** Non-uniform aspect, for plume shapes. */
  aspectY?: number;
  offsetY?: number;
}

/**
 * The workhorse behind smoke, fire, dust and plumes. A domain-warped billow
 * field (1 - |fbm|) gives the cauliflower structure real explosion smoke has;
 * the low-resolution pass is upsampled and then broken up again by a cheap
 * high-frequency octave, which is ~8x faster than evaluating fbm per texel and
 * visually indistinguishable at sprite scale.
 */
function cloudTile(t: Tile, o: CloudOpts): void {
  const S = t.size;
  const LOW = 88;
  const low = new Float32Array(LOW * LOW);
  for (let j = 0; j < LOW; j++) {
    const y = coord(j, LOW) * o.freq;
    for (let i = 0; i < LOW; i++) {
      const x = coord(i, LOW) * o.freq;
      const wx = fbm2(x + 11.2, y - 4.7, { octaves: 3, seed: o.seed });
      const wy = fbm2(x - 7.3, y + 9.1, { octaves: 3, seed: o.seed + 51 });
      const n = fbm2(x + wx * 1.15, y + wy * 1.15, { octaves: 4, gain: 0.56, seed: o.seed + 7 });
      low[j * LOW + i] = 1 - Math.abs(n);
    }
  }

  const aspectY = o.aspectY ?? 1;
  const offsetY = o.offsetY ?? 0;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      let b = bilinear(low, LOW, (i + 0.5) / S, (j + 0.5) / S);
      b += 0.14 * valueNoise2(x * 13 + o.seed, y * 13 - o.seed, o.seed + 3);
      b += 0.07 * valueNoise2(x * 31 - o.seed, y * 31 + o.seed, o.seed + 19);
      b = clamp(b, 0, 1.2);

      const yy = (y + offsetY) * aspectY;
      const r = Math.hypot(x, yy);
      const ang = Math.atan2(yy, x);
      const lobe = 1 + o.lobe * gradNoise2(Math.cos(ang) * 1.8 + o.seed, Math.sin(ang) * 1.8, o.seed + 13);
      const rr = r / Math.max(lobe, 0.35);
      const radial = 1 - smoothstep(o.falloff, 0.99, rr);

      const cover = (b * 0.74 + 0.26) * radial * 1.5;
      const a = smoothstep(o.threshold, o.threshold + 0.42, cover);
      const idx = j * S + i;
      t.a[idx] = a;
      t.h[idx] = b * radial;
      t.d[idx] = 0.5 + 0.85 * b;
    }
  }
}

function blobTile(t: Tile, power: number): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r2 = clamp(1 - (x * x + y * y), 0, 1);
      const a = Math.pow(r2, power);
      const idx = j * S + i;
      t.a[idx] = a;
      t.h[idx] = Math.pow(r2, 0.55);
      t.d[idx] = 0.7 + 0.5 * r2;
    }
  }
}

function glowTile(t: Tile, tightness: number): void {
  const S = t.size;
  const edge = Math.exp(-tightness);
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r2 = x * x + y * y;
      const g = (Math.exp(-r2 * tightness) - edge) / (1 - edge);
      const idx = j * S + i;
      t.a[idx] = clamp(g, 0, 1);
      t.h[idx] = clamp(g, 0, 1);
      t.d[idx] = 1;
    }
  }
}

function sparkTile(t: Tile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r2 = x * x + y * y;
      const core = Math.exp(-r2 * 130);
      const halo = Math.exp(-r2 * 9) * 0.3;
      const idx = j * S + i;
      t.a[idx] = clamp(core + halo, 0, 1);
      t.h[idx] = core;
      // A spark's centre is far hotter than its bloom; push it above neutral.
      t.d[idx] = 0.5 + 1.5 * core;
    }
  }
}

/** A tracer streak: hot round head at v = 1, tapering tail toward v = 0. */
function streakTile(t: Tile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const v = (j + 0.5) / S;
    for (let i = 0; i < S; i++) {
      const u = (i + 0.5) / S;
      const dx = u - 0.5;
      const w = 0.055 + 0.11 * v * v;
      const body = Math.pow(v, 2.4) * Math.exp(-((dx * dx) / (w * w)) * 0.9);
      const hd = dx * dx + (v - 0.88) * (v - 0.88);
      const head = Math.exp(-hd * 260);
      const idx = j * S + i;
      t.a[idx] = clamp(body + head, 0, 1);
      t.h[idx] = clamp(body * 0.5 + head, 0, 1);
      t.d[idx] = 0.55 + 0.35 * v + 1.4 * head;
    }
  }
}

/** Muzzle/detonation flare: hot core, six spikes, soft bloom. */
function flashTile(t: Tile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const spikes =
        Math.pow(Math.abs(Math.cos(ang * 3)), 7) * 0.65 +
        Math.pow(Math.abs(Math.cos(ang * 3 + Math.PI / 3)), 22) * 0.35;
      const core = Math.exp(-r * r * 42);
      const bloom = Math.exp(-r * r * 5.5) * 0.42;
      const ray = spikes * Math.exp(-r * 3.1) * (0.7 + 0.4 * valueNoise2(ang * 3.5, 0, 91));
      const idx = j * S + i;
      t.a[idx] = clamp((core + bloom + ray) * (1 - smoothstep(0.9, 1.0, r)), 0, 1);
      t.h[idx] = core;
      t.d[idx] = 0.55 + 1.6 * core + 0.4 * ray;
    }
  }
}

/** Shock ring: a thin bright annulus with radial scouring. */
function ringTile(t: Tile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const streak = 0.62 + 0.55 * fbm2(Math.cos(ang) * 5.5, Math.sin(ang) * 5.5, { octaves: 3, seed: 313 });
      const d = r - 0.76;
      const band = Math.exp(-d * d * 150) * streak;
      const inner = Math.exp(-r * r * 2.2) * 0.09;
      const idx = j * S + i;
      t.a[idx] = clamp((band + inner) * (1 - smoothstep(0.92, 1.0, r)), 0, 1);
      t.h[idx] = clamp(band, 0, 1);
      t.d[idx] = 0.6 + 1.1 * band;
    }
  }
}

/** Irregular rock/metal chunk with a domed thickness field so it lights. */
function debrisTile(t: Tile, seed: number): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const shape =
        0.52 *
        (0.62 + 0.5 * gradNoise2(Math.cos(ang) * 2.6 + seed, Math.sin(ang) * 2.6, seed) +
          0.18 * gradNoise2(Math.cos(ang) * 6.1, Math.sin(ang) * 6.1, seed + 7));
      const a = 1 - smoothstep(shape - 0.05, shape + 0.02, r);
      const dome = Math.sqrt(clamp(1 - (r / Math.max(shape, 0.05)) ** 2, 0, 1));
      const grain = 0.82 + 0.36 * valueNoise2(x * 16 + seed, y * 16, seed + 41);
      const idx = j * S + i;
      t.a[idx] = a;
      t.h[idx] = dome * a;
      t.d[idx] = grain * (0.62 + 0.5 * dome);
    }
  }
}

/** Water crown: a fan of vertical spikes rising from a wet base. */
function splashTile(t: Tile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    const v = (j + 0.5) / S;
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const spikes = Math.pow(Math.abs(Math.cos(x * 8.5 + 0.4)), 2.6);
      const rise = smoothstep(1.0, -0.35, y) * Math.pow(clamp(1 - Math.abs(x) * 1.05, 0, 1), 0.8);
      const noise = 0.6 + 0.6 * valueNoise2(x * 9, y * 5, 77);
      const base = Math.exp(-(x * x * 5.0 + (y + 0.72) * (y + 0.72) * 26)) * 0.9;
      const idx = j * S + i;
      t.a[idx] = clamp((rise * spikes * noise * (0.35 + 0.9 * v) + base) * 1.15, 0, 1);
      t.h[idx] = clamp(rise * 0.7 + base, 0, 1);
      t.d[idx] = 0.75 + 0.6 * noise;
    }
  }
}

/** Heat haze: a low-contrast blob with a violently warped interior. */
function shimmerTile(t: Tile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const n = fbm2(x * 3.4, y * 5.5, { octaves: 4, gain: 0.6, seed: 511 });
      const radial = 1 - smoothstep(0.15, 0.98, r);
      const idx = j * S + i;
      t.a[idx] = clamp(radial * (0.45 + 0.55 * (n * 0.5 + 0.5)), 0, 1);
      t.h[idx] = (n * 0.5 + 0.5) * radial;
      t.d[idx] = 0.85 + 0.4 * n;
    }
  }
}

// ---------------------------------------------------------------------------
// Public texture builders
// ---------------------------------------------------------------------------

export function createSpriteArray(size = 256): THREE.DataArrayTexture {
  const data = new Uint8Array(size * size * 4 * SPRITE_LAYERS);
  const t = newTile(size);

  const emit = (layer: number, bump: number): void => {
    writeTile(data, layer, t, bump);
    clearTile(t);
  };

  cloudTile(t, { seed: 101, freq: 2.3, threshold: 0.34, lobe: 0.24, falloff: 0.12 });
  emit(SPRITE.SMOKE_A, 1.35);
  cloudTile(t, { seed: 733, freq: 2.7, threshold: 0.32, lobe: 0.28, falloff: 0.1 });
  emit(SPRITE.SMOKE_B, 1.35);
  cloudTile(t, { seed: 271, freq: 3.6, threshold: 0.52, lobe: 0.34, falloff: 0.04 });
  emit(SPRITE.SMOKE_WISP, 1.1);

  blobTile(t, 1.9);
  emit(SPRITE.BLOB, 1.0);

  cloudTile(t, { seed: 907, freq: 4.1, threshold: 0.3, lobe: 0.2, falloff: 0.18 });
  emit(SPRITE.FIRE, 1.5);

  sparkTile(t);
  emit(SPRITE.SPARK, 0.6);
  streakTile(t);
  emit(SPRITE.STREAK, 0.5);
  flashTile(t);
  emit(SPRITE.FLASH, 0.4);
  ringTile(t);
  emit(SPRITE.RING, 0.6);

  cloudTile(t, { seed: 449, freq: 3.0, threshold: 0.28, lobe: 0.18, falloff: 0.08 });
  emit(SPRITE.DUST, 1.0);

  debrisTile(t, 617);
  emit(SPRITE.DEBRIS, 2.1);

  glowTile(t, 26);
  emit(SPRITE.EMBER, 0.5);

  splashTile(t);
  emit(SPRITE.SPLASH, 1.2);

  cloudTile(t, { seed: 383, freq: 3.2, threshold: 0.33, lobe: 0.22, falloff: 0.06, aspectY: 0.72, offsetY: 0.18 });
  emit(SPRITE.PLUME, 1.25);

  glowTile(t, 3.6);
  emit(SPRITE.GLOW, 0.4);

  shimmerTile(t);
  emit(SPRITE.SHIMMER, 2.6);

  const tex = new THREE.DataArrayTexture(data, size, size, SPRITE_LAYERS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

type Key = [number, number, number, number, number];

const RAMP_KEYS: Key[][] = [];
RAMP_KEYS[RAMP.FIRE_HOT] = [
  [0.0, 1.0, 0.97, 0.9, 0.0],
  [0.035, 1.0, 0.96, 0.82, 1.0],
  [0.14, 1.0, 0.8, 0.34, 1.0],
  [0.3, 0.96, 0.44, 0.1, 0.95],
  [0.5, 0.62, 0.17, 0.03, 0.72],
  [0.74, 0.22, 0.06, 0.02, 0.34],
  [1.0, 0.05, 0.02, 0.01, 0.0],
];
RAMP_KEYS[RAMP.FIRE_SOFT] = [
  [0.0, 1.0, 0.86, 0.52, 0.0],
  [0.08, 1.0, 0.72, 0.3, 0.92],
  [0.32, 0.9, 0.38, 0.08, 0.86],
  [0.62, 0.4, 0.12, 0.03, 0.5],
  [1.0, 0.06, 0.02, 0.01, 0.0],
];
RAMP_KEYS[RAMP.SMOKE_DARK] = [
  [0.0, 0.2, 0.17, 0.15, 0.0],
  [0.1, 0.25, 0.22, 0.19, 0.88],
  [0.45, 0.4, 0.38, 0.36, 0.7],
  [0.8, 0.56, 0.55, 0.54, 0.36],
  [1.0, 0.64, 0.64, 0.64, 0.0],
];
RAMP_KEYS[RAMP.SMOKE_LIGHT] = [
  [0.0, 0.68, 0.64, 0.58, 0.0],
  [0.08, 0.86, 0.83, 0.79, 0.76],
  [0.5, 0.9, 0.89, 0.88, 0.54],
  [1.0, 0.95, 0.95, 0.96, 0.0],
];
RAMP_KEYS[RAMP.DUST] = [
  [0.0, 0.56, 0.48, 0.36, 0.0],
  [0.07, 0.72, 0.63, 0.47, 0.86],
  [0.45, 0.78, 0.71, 0.58, 0.6],
  [1.0, 0.83, 0.79, 0.71, 0.0],
];
RAMP_KEYS[RAMP.SPARK] = [
  [0.0, 1.0, 0.98, 0.93, 1.0],
  [0.2, 1.0, 0.83, 0.36, 1.0],
  [0.55, 1.0, 0.42, 0.08, 0.9],
  [0.85, 0.7, 0.12, 0.02, 0.44],
  [1.0, 0.3, 0.03, 0.0, 0.0],
];
RAMP_KEYS[RAMP.FLASH] = [
  [0.0, 1.0, 1.0, 1.0, 1.0],
  [0.16, 1.0, 0.96, 0.82, 1.0],
  [0.46, 1.0, 0.72, 0.32, 0.58],
  [1.0, 0.9, 0.35, 0.08, 0.0],
];
RAMP_KEYS[RAMP.SHOCK] = [
  [0.0, 0.95, 0.98, 1.0, 0.0],
  [0.08, 1.0, 1.0, 1.0, 0.88],
  [0.4, 0.92, 0.9, 0.85, 0.4],
  [1.0, 0.8, 0.78, 0.74, 0.0],
];
RAMP_KEYS[RAMP.EMBER] = [
  [0.0, 1.0, 0.72, 0.28, 0.0],
  [0.06, 1.0, 0.62, 0.18, 1.0],
  [0.55, 1.0, 0.34, 0.05, 0.8],
  [0.88, 0.6, 0.1, 0.01, 0.34],
  [1.0, 0.2, 0.02, 0.0, 0.0],
];
RAMP_KEYS[RAMP.WATER] = [
  [0.0, 0.86, 0.92, 0.95, 0.0],
  [0.07, 0.96, 0.98, 1.0, 0.92],
  [0.5, 0.88, 0.93, 0.97, 0.55],
  [1.0, 0.8, 0.87, 0.92, 0.0],
];
RAMP_KEYS[RAMP.OIL_SMOKE] = [
  [0.0, 0.05, 0.045, 0.04, 0.0],
  [0.08, 0.07, 0.065, 0.06, 0.94],
  [0.4, 0.13, 0.12, 0.115, 0.82],
  [0.75, 0.26, 0.25, 0.24, 0.44],
  [1.0, 0.4, 0.4, 0.4, 0.0],
];
RAMP_KEYS[RAMP.CONCRETE] = [
  [0.0, 0.6, 0.58, 0.54, 0.0],
  [0.06, 0.81, 0.79, 0.75, 0.92],
  [0.45, 0.86, 0.85, 0.82, 0.62],
  [1.0, 0.9, 0.9, 0.89, 0.0],
];
RAMP_KEYS[RAMP.PLASMA] = [
  [0.0, 1.0, 1.0, 1.0, 1.0],
  [0.3, 0.86, 0.95, 1.0, 0.92],
  [0.7, 0.5, 0.8, 1.0, 0.5],
  [1.0, 0.2, 0.5, 0.9, 0.0],
];
RAMP_KEYS[RAMP.ROCK] = [
  [0.0, 0.36, 0.32, 0.28, 0.0],
  [0.04, 0.4, 0.35, 0.3, 1.0],
  [0.86, 0.38, 0.34, 0.29, 1.0],
  [1.0, 0.36, 0.32, 0.28, 0.0],
];
RAMP_KEYS[RAMP.METAL] = [
  [0.0, 0.9, 0.95, 1.0, 1.0],
  [0.18, 1.0, 1.0, 0.95, 1.0],
  [0.5, 1.0, 0.7, 0.25, 0.9],
  [0.85, 0.8, 0.25, 0.04, 0.4],
  [1.0, 0.3, 0.05, 0.0, 0.0],
];
RAMP_KEYS[RAMP.HAZE] = [
  [0.0, 0.9, 0.88, 0.85, 0.0],
  [0.22, 1.0, 0.97, 0.92, 0.17],
  [0.7, 0.95, 0.93, 0.9, 0.11],
  [1.0, 0.9, 0.9, 0.9, 0.0],
];

/** Colour- and alpha-over-life LUT; one row per effect family. */
export function createRampTexture(width = 128): THREE.DataTexture {
  const data = new Uint8Array(width * RAMP_ROWS * 4);
  for (let row = 0; row < RAMP_ROWS; row++) {
    const keys = RAMP_KEYS[row];
    for (let i = 0; i < width; i++) {
      const t = i / (width - 1);
      let k = 0;
      while (k < keys.length - 2 && keys[k + 1][0] < t) k++;
      const a = keys[k];
      const b = keys[k + 1];
      const span = Math.max(b[0] - a[0], 1e-5);
      const f = clamp((t - a[0]) / span, 0, 1);
      const o = (row * width + i) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = clamp(a[c + 1] + (b[c + 1] - a[c + 1]) * f, 0, 1) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, RAMP_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Decal atlas
// ---------------------------------------------------------------------------

/**
 * Decal tiles store an albedo *multiplier* at half scale in RGB (0.5 = leave
 * the ground alone) and coverage in A, so one multiply-blended draw call can
 * both burn the ground black and dust it with pale displaced spoil.
 */
interface DecalTile {
  size: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
}

function newDecalTile(size: number): DecalTile {
  return {
    size,
    r: new Float32Array(size * size).fill(1),
    g: new Float32Array(size * size).fill(1),
    b: new Float32Array(size * size).fill(1),
    a: new Float32Array(size * size),
  };
}

function writeDecal(out: Uint8Array, layer: number, t: DecalTile): void {
  const S = t.size;
  const base = layer * S * S * 4;
  for (let i = 0; i < S * S; i++) {
    const o = base + i * 4;
    out[o] = clamp(t.r[i] * 0.5, 0, 1) * 255;
    out[o + 1] = clamp(t.g[i] * 0.5, 0, 1) * 255;
    out[o + 2] = clamp(t.b[i] * 0.5, 0, 1) * 255;
    out[o + 3] = clamp(t.a[i], 0, 1) * 255;
  }
  t.r.fill(1);
  t.g.fill(1);
  t.b.fill(1);
  t.a.fill(0);
}

function setDecal(t: DecalTile, i: number, r: number, g: number, b: number, a: number): void {
  t.r[i] = r;
  t.g[i] = g;
  t.b[i] = b;
  t.a[i] = a;
}

function craterTile(t: DecalTile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const lobe = 1 + 0.13 * gradNoise2(Math.cos(ang) * 2.4, Math.sin(ang) * 2.4, 88);
      const rr = r / lobe;
      const grain = 0.72 + 0.55 * fbm2(x * 9, y * 9, { octaves: 4, seed: 12 });
      // Excavated bowl, displaced rim, then thrown spoil streaking outward.
      const bowl = (1 - smoothstep(0.2, 0.5, rr)) * grain;
      const rim = Math.exp(-(((rr - 0.53) / 0.11) ** 2)) * grain;
      const spokes = Math.pow(clamp(0.5 + 0.5 * gradNoise2(Math.cos(ang) * 9, Math.sin(ang) * 9, 41), 0, 1), 2.2);
      const ejecta = (1 - smoothstep(0.5, 0.99, rr)) * spokes * 0.55 * grain;

      const shade = clamp(bowl * 0.95 + rim * 0.25 + ejecta * 0.3, 0, 1);
      // Scorched glass at the centre, pale pulverised spoil on the lip.
      const dark = 0.09 + 0.06 * grain;
      const rimCol = 1.32 + 0.2 * grain;
      const mixRim = clamp(rim * 1.25 + ejecta * 0.9, 0, 1) * (1 - smoothstep(0.24, 0.46, rr));
      const base = dark + (1 - dark) * (1 - clamp(bowl * 1.15, 0, 1));
      const col = base * (1 - mixRim) + rimCol * mixRim;
      const idx = j * S + i;
      setDecal(t, idx, col * 1.0, col * 0.97, col * 0.92, shade * (1 - smoothstep(0.92, 1.0, rr)));
    }
  }
}

function scorchTile(t: DecalTile, seed: number, ragged: number, core: number): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const wx = fbm2(x * 2.2 + seed, y * 2.2, { octaves: 3, seed });
      const wy = fbm2(x * 2.2, y * 2.2 + seed, { octaves: 3, seed: seed + 31 });
      const r = Math.hypot(x + wx * ragged, y + wy * ragged);
      const soot = fbm2(x * 6.5 + seed, y * 6.5, { octaves: 4, gain: 0.55, seed: seed + 5 }) * 0.5 + 0.5;
      const mask = (1 - smoothstep(core, 0.98, r)) * (0.55 + 0.7 * soot);
      const a = clamp(mask, 0, 1);
      // Soot is not uniformly black: ash streaks lighten it in places.
      const ash = clamp(soot - 0.62, 0, 1) * 2.2;
      const v = 0.14 + 0.16 * soot + ash * 0.9;
      const idx = j * S + i;
      setDecal(t, idx, v * 1.02, v * 0.96, v * 0.9, a * 0.92);
    }
  }
}

function blastRingTile(t: DecalTile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const scour = 0.55 + 0.6 * fbm2(Math.cos(ang) * 7, Math.sin(ang) * 7, { octaves: 3, seed: 202 });
      const streak = Math.pow(clamp(scour - 0.35, 0, 1), 0.8);
      // Ground swept clean outward from the seat of the blast.
      const radial = smoothstep(0.12, 0.55, r) * (1 - smoothstep(0.62, 0.99, r));
      const a = clamp(radial * streak * 1.5, 0, 1);
      const v = 0.42 + 0.5 * scour;
      const idx = j * S + i;
      setDecal(t, idx, v * 1.05, v, v * 0.9, a * 0.75);
    }
  }
}

function oilTile(t: DecalTile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const wx = fbm2(x * 1.8 + 3, y * 1.8, { octaves: 3, seed: 606 });
      const wy = fbm2(x * 1.8, y * 1.8 + 3, { octaves: 3, seed: 660 });
      const r = Math.hypot(x + wx * 0.42, y + wy * 0.42);
      const edge = 1 - smoothstep(0.55, 0.72, r);
      const sheen = fbm2(x * 5, y * 5, { octaves: 3, seed: 99 }) * 0.5 + 0.5;
      const a = clamp(edge, 0, 1);
      // Near-black pool with a faint iridescent film at the margins.
      const v = 0.07 + 0.1 * sheen * (1 - edge * 0.6);
      const idx = j * S + i;
      setDecal(t, idx, v * 0.9, v * 1.05, v * 1.25, a);
    }
  }
}

function rubbleTile(t: DecalTile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const cell = worley2(x * 5.5 + 20, y * 5.5 + 20, 404);
      const chunk = 1 - smoothstep(0.1, 0.26, cell);
      const lit = hash2(Math.floor(x * 5.5 + 20), Math.floor(y * 5.5 + 20), 404);
      const dusty = fbm2(x * 4, y * 4, { octaves: 3, seed: 71 }) * 0.5 + 0.5;
      const radial = 1 - smoothstep(0.25, 0.95, r);
      // Broken masonry: half the chunks catch light, half sit in their own
      // shadow, all of it sitting in a haze of pulverised dust.
      const a = clamp((chunk * 0.9 + dusty * 0.42) * radial, 0, 1);
      const v = chunk > 0.2 ? (lit > 0.5 ? 1.45 : 0.42) : 0.85 + 0.45 * dusty;
      const idx = j * S + i;
      setDecal(t, idx, v * 1.02, v * 0.99, v * 0.94, a * 0.85);
    }
  }
}

/** Vehicle track: compacted dark band, cleat blocks, displaced pale edges. */
function treadTile(t: DecalTile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const v = (j + 0.5) / S;
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const across = Math.abs(x);
      const band = 1 - smoothstep(0.52, 0.85, across);
      const cleat = 0.55 + 0.45 * Math.sign(Math.cos(v * Math.PI * 14));
      const grain = fbm2(x * 7, y * 22, { octaves: 3, seed: 808 }) * 0.5 + 0.5;
      const edge = Math.exp(-(((across - 0.72) / 0.13) ** 2));
      const a = clamp(band * (0.55 + 0.5 * cleat) * (0.6 + 0.6 * grain) + edge * 0.5, 0, 1);
      const v2 = band > 0.05 ? 0.4 + 0.28 * grain + 0.18 * cleat : 1.0;
      const col = v2 * (1 - edge) + 1.35 * edge;
      const idx = j * S + i;
      setDecal(t, idx, col * 1.02, col * 0.99, col * 0.94, a * 0.8);
    }
  }
}

/** Stone spall: pale dust star with a scatter of dark chips. */
function chipTile(t: DecalTile): void {
  const S = t.size;
  for (let j = 0; j < S; j++) {
    const y = coord(j, S);
    for (let i = 0; i < S; i++) {
      const x = coord(i, S);
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const rays = Math.pow(clamp(0.5 + 0.5 * gradNoise2(Math.cos(ang) * 11, Math.sin(ang) * 11, 55), 0, 1), 2.6);
      const star = (1 - smoothstep(0.05, 0.85, r)) * (0.35 + 1.1 * rays);
      const cell = worley2(x * 8 + 5, y * 8 + 5, 313);
      const chips = (1 - smoothstep(0.06, 0.13, cell)) * (1 - smoothstep(0.2, 0.7, r));
      const a = clamp(star * 0.55 + chips * 0.9, 0, 1);
      const col = chips > 0.3 ? 0.34 : 1.42;
      const idx = j * S + i;
      setDecal(t, idx, col, col * 0.99, col * 0.96, a * 0.8);
    }
  }
}

export function createDecalArray(size = 256): THREE.DataArrayTexture {
  const data = new Uint8Array(size * size * 4 * DECAL_LAYERS);
  const t = newDecalTile(size);

  craterTile(t);
  writeDecal(data, DECAL_TEX.CRATER, t);
  scorchTile(t, 141, 0.3, 0.34);
  writeDecal(data, DECAL_TEX.SCORCH_A, t);
  scorchTile(t, 917, 0.46, 0.18);
  writeDecal(data, DECAL_TEX.SCORCH_B, t);
  blastRingTile(t);
  writeDecal(data, DECAL_TEX.BLAST_RING, t);
  oilTile(t);
  writeDecal(data, DECAL_TEX.OIL, t);
  rubbleTile(t);
  writeDecal(data, DECAL_TEX.RUBBLE, t);
  treadTile(t);
  writeDecal(data, DECAL_TEX.TREAD, t);
  chipTile(t);
  writeDecal(data, DECAL_TEX.CHIP, t);

  const tex = new THREE.DataArrayTexture(data, size, size, DECAL_LAYERS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Ground height lookup
// ---------------------------------------------------------------------------

/**
 * A half-float R16 image of the heightfield covering the whole map. Both
 * particle shaders sample it: in the vertex stage to snap ground-hugging dust
 * and settle bouncing debris, and in the fragment stage for the soft-particle
 * fade. Half-float carries ~0.1% relative error, which at these heights is a
 * couple of centimetres — far below the metres-wide fade band it feeds.
 */
export function createGroundTexture(resolution = 256): THREE.DataTexture {
  const data = new Uint16Array(resolution * resolution);
  // Texel centres, so the shader's `xz / WORLD_SIZE + 0.5` lands exactly on a
  // sample rather than half a texel off.
  for (let j = 0; j < resolution; j++) {
    const z = ((j + 0.5) / resolution - 0.5) * WORLD_SIZE;
    for (let i = 0; i < resolution; i++) {
      const x = ((i + 0.5) / resolution - 0.5) * WORLD_SIZE;
      data[j * resolution + i] = THREE.DataUtils.toHalfFloat(heightAt(x, z));
    }
  }
  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
