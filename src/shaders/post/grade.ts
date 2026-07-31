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
 * The stage order is a film print chain, and it is deliberate:
 *
 *   black/white point -> lift·gamma·gain -> S-curve -> printer lights ->
 *   split tone -> saturation -> highlight shoulder
 *
 * The black and white points come first because everything after them assumes a
 * signal that already fills 0..1; a curve applied to a signal occupying only the
 * middle third of the range cannot add contrast, it can only redistribute the
 * mush. Saturation runs after the tone work so the curve does not re-crush the
 * chroma it just built, and the shoulder runs last so the desaturation lands on
 * final tonal positions.
 *
 * The table is stored as a horizontal strip of `size` tiles (one per blue
 * slice), matching `LUT_SAMPLER` in `common.ts`. Inputs and outputs are
 * display-referred sRGB, i.e. the grade runs *after* the tone curve, which is
 * where the film-emulation stages below actually make sense.
 */

export const LUT_SIZE = 32;

export interface GradeLook {
  /**
   * Log2 window handed to the AgX sigmoid, in scene EV. Part of the look
   * because it *is* a creative decision: it sets how many stops the display
   * transform has to spend, and therefore how steep the picture is. It also has
   * to track the time of day, since a moonlit scene sits several stops below a
   * sunlit one and would otherwise fall off the bottom of the curve.
   */
  evWindow: [number, number];
  /** Input tonal window opened up to the full output range. */
  blackPoint: number;
  whitePoint: number;
  /**
   * Width of the quadratic toe below the black point. A hard black point
   * clips every shadow to the same value and the frame loses its darkest
   * structure; the toe keeps that structure while still reaching zero.
   */
  toe: number;
  /**
   * Width of the soft knee below the white point. Highlights roll into white
   * asymptotically over this band instead of clipping, which is what lets the
   * white point sit aggressively low without turning every sunlit surface into
   * a flat white hole.
   */
  shoulder: number;
  /** Lift / gamma / gain, per channel — the colourist's primary trio. */
  lift: [number, number, number];
  gain: [number, number, number];
  gamma: [number, number, number];
  /** Filmic S-curve strength, 0..1, applied around `pivot`. */
  contrast: number;
  /** Tonal value held fixed by the S-curve. */
  pivot: number;
  /** Per-channel exponent after the curve — the printer-light stage. */
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
  /** How far the shoulder desaturates towards `highlightWhite`, and where it starts. */
  highlightDesat: number;
  shoulderStart: number;
  highlightWhite: [number, number, number];
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/**
 * Daylight. The reference is a Tiberium Wars battlefield at mid-morning: a hot
 * amber key, ground that reads as sunlit dirt rather than khaki, and shade that
 * goes blue-teal instead of grey. The red gain over the blue gain plus the
 * opposed split tone is what separates the lit and shadowed halves of the same
 * surface into two different colours, which is the single biggest thing a flat
 * render is missing.
 */
const DAY: GradeLook = {
  evWindow: [-7.9, 0.1],
  blackPoint: 0.140,
  whitePoint: 0.860,
  toe: 0.065,
  shoulder: 0.180,
  lift: [-0.012, -0.008, 0.006],
  gain: [1.050, 0.998, 0.960],
  gamma: [1.020, 1.000, 0.988],
  contrast: 0.62,
  pivot: 0.46,
  power: [0.985, 1.000, 1.010],
  shadowTint: [0.024, 0.048, 0.086],
  highlightTint: [0.055, 0.018, -0.030],
  shadowRange: 2.4,
  highlightRange: 2.0,
  saturation: 1.16,
  vibrance: 0.12,
  shadowSaturation: 1.18,
  highlightDesat: 0.30,
  shoulderStart: 0.74,
  highlightWhite: [1.000, 0.972, 0.930],
};

/** Low sun: amber key, violet shade, the C&C "golden hour" postcard. */
const GOLDEN: GradeLook = {
  evWindow: [-8.1, 0.3],
  blackPoint: 0.130,
  whitePoint: 0.870,
  toe: 0.060,
  shoulder: 0.170,
  lift: [-0.008, -0.012, 0.012],
  gain: [1.085, 0.996, 0.918],
  gamma: [1.045, 1.000, 0.968],
  contrast: 0.66,
  pivot: 0.44,
  power: [0.972, 1.000, 1.030],
  shadowTint: [0.026, 0.044, 0.098],
  highlightTint: [0.082, 0.026, -0.046],
  shadowRange: 2.3,
  highlightRange: 1.9,
  saturation: 1.24,
  vibrance: 0.16,
  shadowSaturation: 1.26,
  highlightDesat: 0.24,
  shoulderStart: 0.76,
  highlightWhite: [1.000, 0.950, 0.880],
};

/** Night: cool and lower contrast so shadow detail survives, chroma kept alive. */
const NIGHT: GradeLook = {
  evWindow: [-10.2, -1.0],
  blackPoint: 0.070,
  whitePoint: 0.900,
  toe: 0.085,
  shoulder: 0.200,
  lift: [-0.002, 0.002, 0.022],
  gain: [0.945, 0.985, 1.050],
  gamma: [0.968, 1.000, 1.040],
  contrast: 0.46,
  pivot: 0.40,
  power: [1.040, 1.005, 0.958],
  shadowTint: [0.022, 0.042, 0.086],
  highlightTint: [-0.022, 0.006, 0.048],
  shadowRange: 2.2,
  highlightRange: 2.4,
  saturation: 1.12,
  vibrance: 0.20,
  shadowSaturation: 1.10,
  highlightDesat: 0.32,
  shoulderStart: 0.78,
  highlightWhite: [0.915, 0.960, 1.000],
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const lerp3 = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
];

function blendLook(a: GradeLook, b: GradeLook, t: number): GradeLook {
  return {
    evWindow: lerp2(a.evWindow, b.evWindow, t),
    blackPoint: lerp(a.blackPoint, b.blackPoint, t),
    whitePoint: lerp(a.whitePoint, b.whitePoint, t),
    toe: lerp(a.toe, b.toe, t),
    shoulder: lerp(a.shoulder, b.shoulder, t),
    lift: lerp3(a.lift, b.lift, t),
    gain: lerp3(a.gain, b.gain, t),
    gamma: lerp3(a.gamma, b.gamma, t),
    contrast: lerp(a.contrast, b.contrast, t),
    pivot: lerp(a.pivot, b.pivot, t),
    power: lerp3(a.power, b.power, t),
    shadowTint: lerp3(a.shadowTint, b.shadowTint, t),
    highlightTint: lerp3(a.highlightTint, b.highlightTint, t),
    shadowRange: lerp(a.shadowRange, b.shadowRange, t),
    highlightRange: lerp(a.highlightRange, b.highlightRange, t),
    saturation: lerp(a.saturation, b.saturation, t),
    vibrance: lerp(a.vibrance, b.vibrance, t),
    shadowSaturation: lerp(a.shadowSaturation, b.shadowSaturation, t),
    highlightDesat: lerp(a.highlightDesat, b.highlightDesat, t),
    shoulderStart: lerp(a.shoulderStart, b.shoulderStart, t),
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

/** Evaluates one grade sample. See the file comment for why the order is this. */
function gradeSample(out: Float32Array, r: number, g: number, b: number, look: GradeLook): void {
  // --- black and white point -----------------------------------------------
  const span = 1 / Math.max(1e-3, look.whitePoint - look.blackPoint);
  const toe = Math.max(1e-4, look.toe);
  const knee = Math.max(1e-4, look.shoulder);
  const norm = (x: number): number => {
    let v = (x - look.blackPoint) * span;
    // Quadratic toe: rolls into zero over a `toe`-wide band instead of
    // clipping, so the darkest structure in the frame survives the crush.
    v = v >= toe ? v : v > -toe ? ((v + toe) * (v + toe)) / (4 * toe) : 0;
    // Exponential knee: approaches 1 without ever reaching it, so the white
    // point can be pushed hard without producing clipped white holes.
    if (v > 1 - knee) v = 1 - knee + knee * (1 - Math.exp(-(v - (1 - knee)) / knee));
    return v;
  };
  r = norm(r);
  g = norm(g);
  b = norm(b);

  // --- lift / gamma / gain --------------------------------------------------
  const lgg = (x: number, i: 0 | 1 | 2): number => {
    const v = look.lift[i] + x * (look.gain[i] - look.lift[i]);
    return Math.pow(Math.max(0, v), 1 / look.gamma[i]);
  };
  r = lgg(r, 0);
  g = lgg(g, 1);
  b = lgg(b, 2);

  // --- filmic S-curve about `pivot` ----------------------------------------
  // Re-gamma so the pivot sits at 0.5, blend towards a smoothstep, undo. This
  // keeps 0 and 1 fixed, so the curve adds contrast without clipping either end.
  const gamma = Math.log(0.5) / Math.log(Math.max(1e-3, look.pivot));
  const invGamma = 1 / gamma;
  const curve = (x: number): number => {
    const p = Math.pow(Math.min(1, Math.max(0, x)), gamma);
    const s = p * p * (3 - 2 * p);
    return Math.pow(p + (s - p) * look.contrast, invGamma);
  };
  r = curve(r);
  g = curve(g);
  b = curve(b);

  // --- printer lights -------------------------------------------------------
  r = Math.pow(Math.max(0, r), look.power[0]);
  g = Math.pow(Math.max(0, g), look.power[1]);
  b = Math.pow(Math.max(0, b), look.power[2]);

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
  const shoulder = smoothstep(look.shoulderStart, 1.0, Math.max(0, luma)) * look.highlightDesat;
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
