import * as THREE from 'three';
import { hash2 } from '@/util/Noise';

/**
 * Procedural, tiling textures for the water surface. Everything here is
 * generated once at boot from the shared hash — no image assets, no fetches.
 *
 * All three maps are seamless in both axes. Tiling is achieved by wrapping the
 * lattice coordinates of the underlying noise onto an integer period, so a
 * texture sampled with `RepeatWrapping` has no visible seam and no visible
 * repeat structure at the scales the water shader uses it.
 */

const smoothT = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const wrapI = (v: number, p: number): number => ((v % p) + p) % p;

/** Gradient noise on a lattice that wraps at `px` × `py` cells. */
function periodicGrad(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smoothT(xf);
  const v = smoothT(yf);
  const g = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash2(wrapI(ix, px), wrapI(iy, py), seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  return lerp(
    lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u),
    lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u),
    v,
  );
}

/** Periodic fBm. Lacunarity is fixed at 2 so the period stays integral. */
function periodicFbm(
  x: number,
  y: number,
  px: number,
  py: number,
  octaves: number,
  seed: number,
  gain = 0.5,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * periodicGrad(x * freq, y * freq, px * freq, py * freq, seed + i * 71);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/** Periodic cellular noise. Returns the two nearest feature distances. */
function periodicWorley(
  x: number,
  y: number,
  px: number,
  py: number,
  seed: number,
  out: { f1: number; f2: number },
): void {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const wx = wrapI(cx, px);
      const wy = wrapI(cy, py);
      const fx = cx + hash2(wx, wy, seed);
      const fy = cy + hash2(wx, wy, seed + 977);
      const dx = fx - x;
      const dy = fy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  out.f1 = f1;
  out.f2 = f2;
}

function makeTexture(data: Uint8Array, size: number, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const enc = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Wrapped 3×3 box blur, used to take the hard edges off cellular patterns. */
function blurWrap(src: Float32Array, size: number, passes: number): Float32Array {
  let a = src;
  let b = new Float32Array(size * size);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < size; j++) {
      const jm = ((j - 1 + size) % size) * size;
      const j0 = j * size;
      const jp = ((j + 1) % size) * size;
      for (let i = 0; i < size; i++) {
        const im = (i - 1 + size) % size;
        const ip = (i + 1) % size;
        b[j0 + i] =
          (a[jm + im] + a[jm + i] + a[jm + ip] +
            a[j0 + im] + a[j0 + i] * 2 + a[j0 + ip] +
            a[jp + im] + a[jp + i] + a[jp + ip]) / 10;
      }
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Fine surface detail. RG hold the analytic slope (∂h/∂x, ∂h/∂y) of a wind
 * ripple field, B its height and A a sharpened crest mask. Storing the slope
 * rather than a packed normal lets the shader sum three octaves of ripple by
 * simply adding the decoded gradients, which is both cheaper and correct.
 *
 * The field is stretched 3:1 so ripples are elongated across the wind, and
 * domain-warped so crests bend instead of running as parallel stripes.
 */
export function createWaveDetailTexture(size = 256, anisotropy = 8, seed = 4711): THREE.DataTexture {
  const P = 6; // lattice cells across the tile on the short axis
  const PY = P * 3;
  const h = new Float32Array(size * size);

  for (let j = 0; j < size; j++) {
    const v = (j / size) * PY;
    for (let i = 0; i < size; i++) {
      const u = (i / size) * P;
      const wx = periodicFbm(u, v, P, PY, 3, seed + 11);
      const wy = periodicFbm(u, v, P, PY, 3, seed + 29);
      // Two warped octaves plus a sharpened ridge give crests with real shape.
      const base = periodicFbm(u + wx * 0.55, v + wy * 0.55, P, PY, 5, seed, 0.55);
      const ridge = 1 - Math.abs(periodicFbm(u * 2 + wy * 0.4, v * 2 + wx * 0.4, P * 2, PY * 2, 3, seed + 313));
      h[j * size + i] = base * 0.72 + (ridge * ridge - 0.5) * 0.5;
    }
  }

  // Central differences with wrap-around, normalised so the encoding uses the
  // full byte range; the shader reapplies the physical amplitude.
  const gx = new Float32Array(size * size);
  const gy = new Float32Array(size * size);
  let maxG = 1e-6;
  for (let j = 0; j < size; j++) {
    const jm = ((j - 1 + size) % size) * size;
    const jp = ((j + 1) % size) * size;
    const j0 = j * size;
    for (let i = 0; i < size; i++) {
      const im = (i - 1 + size) % size;
      const ip = (i + 1) % size;
      const dx = (h[j0 + ip] - h[j0 + im]) * 0.5;
      const dy = (h[jp + i] - h[jm + i]) * 0.5;
      gx[j0 + i] = dx;
      gy[j0 + i] = dy;
      maxG = Math.max(maxG, Math.abs(dx), Math.abs(dy));
    }
  }

  const inv = 1 / maxG;
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const hv = h[k] * 0.5 + 0.5;
    const crest = Math.max(0, Math.min(1, (hv - 0.58) / 0.3));
    data[k * 4] = enc(gx[k] * inv * 0.5 + 0.5);
    data[k * 4 + 1] = enc(gy[k] * inv * 0.5 + 0.5);
    data[k * 4 + 2] = enc(Math.max(0, Math.min(1, hv)));
    data[k * 4 + 3] = enc(crest * crest);
  }
  return makeTexture(data, size, anisotropy);
}

/**
 * Foam. R is the coarse foam mass, G a bubble/speckle layer, B a low frequency
 * dissolve threshold (so foam eats away unevenly instead of fading uniformly)
 * and A a second, independent mass used to cross-fade the two scroll layers.
 */
export function createFoamTexture(size = 256, anisotropy = 8, seed = 9021): THREE.DataTexture {
  const P = 5;
  const mass = new Float32Array(size * size);
  const bubbles = new Float32Array(size * size);
  const alt = new Float32Array(size * size);
  const thresh = new Float32Array(size * size);
  const w = { f1: 0, f2: 0 };

  for (let j = 0; j < size; j++) {
    const v = (j / size) * P;
    for (let i = 0; i < size; i++) {
      const u = (i / size) * P;
      const wx = periodicFbm(u, v, P, P, 3, seed + 5) * 0.6;
      const wy = periodicFbm(u, v, P, P, 3, seed + 17) * 0.6;

      // Coarse clumps: warped fBm pushed to high contrast.
      const f = periodicFbm(u + wx, v + wy, P, P, 5, seed, 0.55) * 0.5 + 0.5;
      mass[j * size + i] = Math.max(0, Math.min(1, (f - 0.34) / 0.42));

      // Bubbles: cellular cores at a higher frequency.
      periodicWorley((u + wy * 0.3) * 4, (v + wx * 0.3) * 4, P * 4, P * 4, seed + 71, w);
      const b = Math.max(0, 1 - w.f1 * 1.9);
      bubbles[j * size + i] = b * b;

      const g = periodicFbm(u * 2 - wy, v * 2 - wx, P * 2, P * 2, 4, seed + 401, 0.55) * 0.5 + 0.5;
      alt[j * size + i] = Math.max(0, Math.min(1, (g - 0.32) / 0.44));

      thresh[j * size + i] = periodicFbm(u * 0.5, v * 0.5, Math.max(1, P >> 1), Math.max(1, P >> 1), 3, seed + 811) * 0.5 + 0.5;
    }
  }

  const massB = blurWrap(mass, size, 1);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = enc(Math.max(0, Math.min(1, massB[k] * 0.8 + bubbles[k] * 0.35)));
    data[k * 4 + 1] = enc(bubbles[k]);
    data[k * 4 + 2] = enc(thresh[k]);
    data[k * 4 + 3] = enc(alt[k]);
  }
  return makeTexture(data, size, anisotropy);
}

/**
 * Caustics. The bright web on a lake bed is the boundary set of the cells a
 * wavy surface focuses light into, so a cellular F2−F1 ridge is the right
 * primitive. Two scales are stored so the shader can scroll them against each
 * other and get the characteristic crawling interference.
 */
export function createCausticsTexture(size = 256, anisotropy = 4, seed = 3307): THREE.DataTexture {
  const P = 5;
  const a = new Float32Array(size * size);
  const b = new Float32Array(size * size);
  const w = { f1: 0, f2: 0 };

  for (let j = 0; j < size; j++) {
    const v = (j / size) * P;
    for (let i = 0; i < size; i++) {
      const u = (i / size) * P;
      const wx = periodicFbm(u, v, P, P, 3, seed + 13) * 0.35;
      const wy = periodicFbm(u, v, P, P, 3, seed + 37) * 0.35;

      periodicWorley(u + wx, v + wy, P, P, seed, w);
      let edge = 1 - Math.min(1, (w.f2 - w.f1) / 0.42);
      a[j * size + i] = edge * edge * edge;

      periodicWorley((u - wy) * 2, (v - wx) * 2, P * 2, P * 2, seed + 191, w);
      edge = 1 - Math.min(1, (w.f2 - w.f1) / 0.36);
      b[j * size + i] = edge * edge * edge;
    }
  }

  const ab = blurWrap(a, size, 2);
  const bb = blurWrap(b, size, 2);
  let maxA = 1e-6;
  let maxB = 1e-6;
  for (let k = 0; k < size * size; k++) {
    maxA = Math.max(maxA, ab[k]);
    maxB = Math.max(maxB, bb[k]);
  }

  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = enc(ab[k] / maxA);
    data[k * 4 + 1] = enc(bb[k] / maxB);
    data[k * 4 + 2] = enc((ab[k] / maxA) * (bb[k] / maxB));
    data[k * 4 + 3] = 255;
  }
  return makeTexture(data, size, anisotropy);
}
