import * as THREE from 'three';

/**
 * Procedural colour grading LUT.
 *
 * The display transform (AgX) decides how light *rolls off*; it deliberately
 * says nothing about what the picture should look like. Everything a colourist
 * would call "the look" — where the shadows sit on the blue/green axis, how warm
 * the sun reads, how far saturation is pushed before it clips — lives here, in a
 * 3D lookup table baked on the CPU and applied as the very last colour
 * operation. Doing it as a LUT rather than as inline shader maths is what makes
 * it cheap enough to be this elaborate: the whole grade is three texture fetches
 * regardless of how many stages it has.
 *
 * The table is stored as a horizontal strip of `size` tiles (one per blue
 * slice), matching `LUT_SAMPLER` in `common.ts`. Inputs and outputs are
 * display-referred sRGB, i.e. the grade runs *after* the tone curve, which is
 * where the film-emulation stages below actually make sense.
 */

export const LUT_SIZE = 32;

export interface GradeLook {
  /** Filmic S-curve strength, 0..1, applied around `pivot`. */
  contrast: number;
  /** Tonal value held fixed by the S-curve — mid grey after AgX. */
  pivot: number;
  /** ASC CDL, per channel. out = (in * slope + offset) ^ power. */
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  /** Colour pushed into the toe and the shoulder (split toning). */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** Falloff exponents for the two tinting weights; higher = tighter. */
  shadowRange: number;
  highlightRange: number;
  saturation: number;
  /** Extra saturation applied only to already-dull colours. */
  vibrance: number;
  /** Saturation multiplier at the black end — keeps shadows chromatic. */
  shadowSaturation: number;
  /** How far the shoulder desaturates towards `highlightWhite`. */
  highlightDesat: number;
  highlightWhite: [number, number, number];
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Daylight: warm key, cool shade, strong but not lurid saturation. */
const DAY: GradeLook = {
  contrast: 0.30,
  pivot: 0.42,
  slope: [1.020, 1.000, 0.972],
  offset: [-0.007, -0.004, 0.006],
  power: [0.982, 1.000, 1.028],
  shadowTint: [-0.014, 0.000, 0.034],
  highlightTint: [0.032, 0.012, -0.018],
  shadowRange: 2.2,
  highlightRange: 2.4,
  saturation: 1.12,
  vibrance: 0.20,
  shadowSaturation: 1.16,
  highlightDesat: 0.30,
  highlightWhite: [1.000, 0.985, 0.955],
};

/** Low sun: amber key, violet shade, the C&C "golden hour" postcard. */
const GOLDEN: GradeLook = {
  contrast: 0.35,
  pivot: 0.40,
  slope: [1.055, 1.000, 0.925],
  offset: [-0.005, -0.007, 0.010],
  power: [0.955, 1.000, 1.070],
  shadowTint: [-0.004, -0.006, 0.042],
  highlightTint: [0.058, 0.020, -0.034],
  shadowRange: 2.0,
  highlightRange: 2.0,
  saturation: 1.18,
  vibrance: 0.24,
  shadowSaturation: 1.22,
  highlightDesat: 0.22,
  highlightWhite: [1.000, 0.955, 0.895],
};

/** Night: cool and low contrast so shadow detail survives, chroma kept alive. */
const NIGHT: GradeLook = {
  contrast: 0.20,
  pivot: 0.36,
  slope: [0.960, 0.982, 1.060],
  offset: [0.004, 0.007, 0.016],
  power: [1.055, 1.020, 0.945],
  shadowTint: [-0.016, -0.002, 0.044],
  highlightTint: [-0.012, 0.004, 0.028],
  shadowRange: 1.7,
  highlightRange: 2.6,
  saturation: 0.94,
  vibrance: 0.12,
  shadowSaturation: 1.05,
  highlightDesat: 0.34,
  highlightWhite: [0.930, 0.968, 1.000],
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const lerp3 = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function blendLook(a: GradeLook, b: GradeLook, t: number): GradeLook {
  return {
    contrast: lerp(a.contrast, b.contrast, t),
    pivot: lerp(a.pivot, b.pivot, t),
    slope: lerp3(a.slope, b.slope, t),
    offset: lerp3(a.offset, b.offset, t),
    power: lerp3(a.power, b.power, t),
    shadowTint: lerp3(a.shadowTint, b.shadowTint, t),
    highlightTint: lerp3(a.highlightTint, b.highlightTint, t),
    shadowRange: lerp(a.shadowRange, b.shadowRange, t),
    highlightRange: lerp(a.highlightRange, b.highlightRange, t),
    saturation: lerp(a.saturation, b.saturation, t),
    vibrance: lerp(a.vibrance, b.vibrance, t),
    shadowSaturation: lerp(a.shadowSaturation, b.shadowSaturation, t),
    highlightDesat: lerp(a.highlightDesat, b.highlightDesat, t),
    highlightWhite: lerp3(a.highlightWhite, b.highlightWhite, t),
  };
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Picks the look for a given sun elevation (the Y component of the direction
 * towards the sun). Driving the grade off the sun rather off a clock means it
 * stays correct no matter how another system chooses to animate the day.
 */
export function lookForSunElevation(elevation: number): GradeLook {
  if (elevation >= 0.34) return DAY;
  if (elevation >= 0.03) return blendLook(GOLDEN, DAY, smoothstep(0.03, 0.34, elevation));
  return blendLook(NIGHT, GOLDEN, smoothstep(-0.16, 0.03, elevation));
}

/**
 * Evaluates one grade sample. Stage order matters: the tone shaping runs before
 * the tints so the split toning lands on final tonal positions, and the
 * saturation work runs last so it is not re-crushed by the curve.
 */
function gradeSample(out: Float32Array, r: number, g: number, b: number, look: GradeLook): void {
  // --- filmic S-curve about `pivot` ----------------------------------------
  // Re-gamma so the pivot sits at 0.5, blend towards a smoothstep, undo. This
  // keeps 0 and 1 fixed, so the curve adds contrast without clipping either end.
  const gamma = Math.log(0.5) / Math.log(Math.max(1e-3, look.pivot));
  const invGamma = 1 / gamma;
  const curve = (x: number): number => {
    const p = Math.pow(Math.max(0, x), gamma);
    const s = p * p * (3 - 2 * p);
    return Math.pow(p + (s - p) * look.contrast, invGamma);
  };
  r = curve(r);
  g = curve(g);
  b = curve(b);

  // --- ASC CDL --------------------------------------------------------------
  r = Math.pow(Math.max(0, r * look.slope[0] + look.offset[0]), look.power[0]);
  g = Math.pow(Math.max(0, g * look.slope[1] + look.offset[1]), look.power[1]);
  b = Math.pow(Math.max(0, b * look.slope[2] + look.offset[2]), look.power[2]);

  // --- split toning ---------------------------------------------------------
  let luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  const wShadow = Math.pow(1 - Math.min(1, luma), look.shadowRange);
  const wHigh = Math.pow(Math.min(1, luma), look.highlightRange);
  r += look.shadowTint[0] * wShadow + look.highlightTint[0] * wHigh;
  g += look.shadowTint[1] * wShadow + look.highlightTint[1] * wHigh;
  b += look.shadowTint[2] * wShadow + look.highlightTint[2] * wHigh;

  // --- saturation, vibrance, shadow chroma ----------------------------------
  luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  const maxC = Math.max(r, Math.max(g, b));
  const minC = Math.min(r, Math.min(g, b));
  // Current chroma, 0 for grey and 1 for a fully saturated primary.
  const chroma = maxC > 1e-4 ? (maxC - minC) / maxC : 0;
  const sat =
    look.saturation +
    look.vibrance * (1 - Math.min(1, chroma)) +
    (look.shadowSaturation - 1) * wShadow;
  r = luma + (r - luma) * sat;
  g = luma + (g - luma) * sat;
  b = luma + (b - luma) * sat;

  // --- shoulder desaturation ------------------------------------------------
  // Real film loses colour as it approaches the shoulder; without this, bright
  // sunlit surfaces stay fully saturated and read as clipped digital colour.
  const shoulder = smoothstep(0.72, 1.0, Math.max(0, luma)) * look.highlightDesat;
  r = lerp(r, look.highlightWhite[0] * Math.max(r, luma), shoulder);
  g = lerp(g, look.highlightWhite[1] * Math.max(g, luma), shoulder);
  b = lerp(b, look.highlightWhite[2] * Math.max(b, luma), shoulder);

  out[0] = Math.min(1, Math.max(0, r));
  out[1] = Math.min(1, Math.max(0, g));
  out[2] = Math.min(1, Math.max(0, b));
}

/** Fills `data` (RGBA8, size*size wide by size tall) with the graded table. */
export function writeGradeLut(data: Uint8Array, look: GradeLook, size = LUT_SIZE): void {
  const width = size * size;
  const inv = 1 / (size - 1);
  const rgb = new Float32Array(3);
  for (let bi = 0; bi < size; bi++) {
    const b = bi * inv;
    for (let gi = 0; gi < size; gi++) {
      const g = gi * inv;
      const row = gi * width;
      for (let ri = 0; ri < size; ri++) {
        gradeSample(rgb, ri * inv, g, b, look);
        const p = (row + bi * size + ri) * 4;
        data[p] = Math.round(rgb[0] * 255);
        data[p + 1] = Math.round(rgb[1] * 255);
        data[p + 2] = Math.round(rgb[2] * 255);
        data[p + 3] = 255;
      }
    }
  }
}

/**
 * Builds the strip texture. Linear filtering plus the sampler's manual blue
 * interpolation makes the fetch fully trilinear; 32 slices is enough that the
 * residual error is below the 8-bit quantum for looks this smooth.
 */
export function createGradeLut(look: GradeLook, size = LUT_SIZE): THREE.DataTexture {
  const data = new Uint8Array(size * size * size * 4);
  writeGradeLut(data, look, size);
  const texture = new THREE.DataTexture(data, size * size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // The table maps encoded values to encoded values; any colour management on
  // the way in would apply the transfer function twice.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
