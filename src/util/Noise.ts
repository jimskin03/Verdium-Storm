/**
 * Deterministic noise primitives shared by terrain, vegetation scattering,
 * texture synthesis and VFX. Everything here is seedable and allocation-free so
 * it can be called inside tight generation loops.
 */

export function hash2(x: number, y: number, seed = 0): number {
  let h = x * 374761393 + y * 668265263 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Value noise in [-1, 1]. */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

/** Gradient (Perlin-style) noise in roughly [-1, 1]; smoother than value noise. */
export function gradNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const grad = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash2(ix, iy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  return lerp(
    lerp(grad(xi, yi, xf, yf), grad(xi + 1, yi, xf - 1, yf), u),
    lerp(grad(xi, yi + 1, xf, yf - 1), grad(xi + 1, yi + 1, xf - 1, yf - 1), u),
    v,
  );
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number;
}

export function fbm2(x: number, y: number, opts: FbmOptions = {}): number {
  const { octaves = 5, lacunarity = 2.02, gain = 0.5, seed = 0 } = opts;
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * gradNoise2(x * freq, y * freq, seed + i * 71);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — produces mountain ridges and canyon walls. */
export function ridged2(x: number, y: number, opts: FbmOptions = {}): number {
  const { octaves = 5, lacunarity = 2.02, gain = 0.5, seed = 0 } = opts;
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(gradNoise2(x * freq, y * freq, seed + i * 131));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Worley/cellular noise. Returns distance to the nearest feature point. */
export function worley2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 977);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Small, fast, seedable PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mix = lerp;
