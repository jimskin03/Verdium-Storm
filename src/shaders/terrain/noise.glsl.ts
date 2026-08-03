/**
 * Tileable GLSL noise primitives used by the terrain material synthesiser.
 *
 * Every generator takes an explicit *period* so the result wraps exactly at the
 * tile boundary — a synthesised layer that does not wrap shows a hard seam every
 * few metres, which is the fastest way to make procedural ground look fake.
 * Frequencies are therefore always supplied as integer 'vec2's.
 *
 * Value noise is used rather than gradient noise throughout: it needs no
 * trigonometry, which matters because these shaders run a few million pixels of
 * multi-octave work at boot.
 */
export const TERRAIN_NOISE_GLSL = /* glsl */ `

float vsHash(vec2 c, float seed) {
  vec3 p3 = fract(vec3(c.x, c.y, c.x) * 0.1031 + seed * 0.0731);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 vsHash2(vec2 c, float seed) {
  vec3 p3 = fract(vec3(c.x, c.y, c.x) * vec3(0.1031, 0.1030, 0.0973) + seed * 0.0731);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Periodic value noise, [0,1]. 'p' is in lattice units, 'period' the wrap. */
float vsValue(vec2 p, vec2 period, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vsHash(mod(i, period), seed);
  float b = vsHash(mod(i + vec2(1.0, 0.0), period), seed);
  float c = vsHash(mod(i + vec2(0.0, 1.0), period), seed);
  float d = vsHash(mod(i + vec2(1.0, 1.0), period), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Value noise addressed by unit uv and an integer frequency. */
float vsNoise(vec2 uv, vec2 freq, float seed) {
  return vsValue(uv * freq, freq, seed);
}

/** Multi-octave value fbm, [0,1]. Frequency doubles, period follows it. */
float vsFbm(vec2 uv, vec2 freq, int octaves, float gain, float seed) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  vec2 f = freq;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vsValue(uv * f, f, seed + float(i) * 17.13);
    norm += amp;
    amp *= gain;
    f *= 2.0;
  }
  return sum / norm;
}

/** Ridged fbm — creases and crack lines rather than blobs. */
float vsRidge(vec2 uv, vec2 freq, int octaves, float gain, float seed) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  vec2 f = freq;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(vsValue(uv * f, f, seed + float(i) * 23.7) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    f *= 2.0;
  }
  return sum / norm;
}

/**
 * Periodic Worley. Returns (F1, F2, cellId) with F1/F2 in lattice units.
 * F2 - F1 gives the cell borders, which is what cracks and pebble gaps use.
 */
vec3 vsWorley(vec2 uv, vec2 freq, float seed) {
  vec2 p = uv * freq;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 9.0;
  float f2 = 9.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, freq);
      vec2 o = vsHash2(c, seed);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = vsHash(c, seed + 41.7);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

/**
 * Low-frequency domain warp. Keeps the result tileable (the offset field is
 * itself periodic) while letting fine anisotropic detail flow in curved
 * directions instead of running dead straight along the texture axes.
 */
vec2 vsWarp(vec2 uv, vec2 freq, float amount, float seed) {
  float a = vsFbm(uv, freq, 3, 0.5, seed);
  float b = vsFbm(uv, freq, 3, 0.5, seed + 91.4);
  return uv + (vec2(a, b) - 0.5) * amount;
}

/** Non-periodic value noise for world-scale (non-tiling) masks. */
float vsOpenValue(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vsHash(i, seed);
  float b = vsHash(i + vec2(1.0, 0.0), seed);
  float c = vsHash(i + vec2(0.0, 1.0), seed);
  float d = vsHash(i + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float vsOpenFbm(vec2 p, int octaves, float gain, float seed) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vsOpenValue(p, seed + float(i) * 19.3);
    norm += amp;
    amp *= gain;
    p *= 2.03;
  }
  return sum / norm;
}
`;
