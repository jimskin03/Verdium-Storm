/**
 * Shared definition of the atmosphere model.
 *
 * The numbers live here once, in TypeScript, and are injected into GLSL as
 * literals so the CPU-side sky (used to colour the lights and the fog service)
 * and the GPU-side sky (LUTs, dome, aerial perspective) can never drift apart.
 *
 * Model: Hillaire 2020 — "A Scalable and Production Ready Sky and Atmosphere
 * Rendering Technique". Rayleigh + Mie single scattering raymarched into a
 * sky-view LUT, with a second-order multiple-scattering LUT that supplies the
 * energy single scattering misses (this is what keeps twilight from going
 * flat black and the zenith from going ink-blue).
 *
 * Units are kilometres, matching the coefficient tables. One world unit is one
 * metre, so world Y maps to altitude via `y * 0.001`.
 */

export const ATMOSPHERE = {
  /** Planet radius, km. */
  groundRadius: 6360,
  /** Top of atmosphere, km. */
  topRadius: 6460,
  /** Rayleigh scattering coefficient at sea level, 1/km (Bruneton). */
  rayleighScattering: [0.005802, 0.013558, 0.0331] as const,
  rayleighHeight: 8.0,
  /** Mie scattering / absorption at sea level, 1/km. */
  mieScattering: 0.003996,
  mieAbsorption: 0.0044,
  mieHeight: 1.2,
  miePhaseG: 0.78,
  /** Ozone absorption, 1/km, over a tent profile centred at 25 km. */
  ozoneAbsorption: [0.00065, 0.001881, 0.000085] as const,
  ozoneCenter: 25.0,
  ozoneWidth: 15.0,
  /** Average ground albedo seen by the atmosphere. */
  groundAlbedo: [0.24, 0.23, 0.19] as const,
  /** Angular radius of the solar disc, radians. */
  sunAngularRadius: 0.004675,
} as const;

/** LUT resolutions. Small on purpose: they are re-rendered when the sun moves. */
export const LUT_SIZE = {
  transmittance: [256, 64] as const,
  multiScatter: [32, 32] as const,
  /** Wide in azimuth, tall in elevation; elevation uses a sqrt warp so the
   *  horizon — where the gradient is steepest — gets the most texels. */
  skyView: [192, 128] as const,
  cloud: 512,
} as const;

const A = ATMOSPHERE;

function v3(c: readonly number[]): string {
  return `vec3(${c[0].toPrecision(8)}, ${c[1].toPrecision(8)}, ${c[2].toPrecision(8)})`;
}

/** Constants + small math helpers shared by every atmosphere shader. */
export const GLSL_ATMOSPHERE = /* glsl */ `
#ifndef VS_ATMO_INCLUDED
#define VS_ATMO_INCLUDED

#define VS_PI 3.141592653589793
#define VS_GROUND_R ${A.groundRadius.toFixed(1)}
#define VS_TOP_R ${A.topRadius.toFixed(1)}
#define VS_RAYLEIGH_S ${v3(A.rayleighScattering)}
#define VS_RAYLEIGH_H ${A.rayleighHeight.toFixed(4)}
#define VS_MIE_S ${A.mieScattering.toPrecision(8)}
#define VS_MIE_A ${A.mieAbsorption.toPrecision(8)}
#define VS_MIE_H ${A.mieHeight.toFixed(4)}
#define VS_MIE_G ${A.miePhaseG.toFixed(4)}
#define VS_OZONE_A ${v3(A.ozoneAbsorption)}
#define VS_OZONE_C ${A.ozoneCenter.toFixed(2)}
#define VS_OZONE_W ${A.ozoneWidth.toFixed(2)}
#define VS_GROUND_ALBEDO ${v3(A.groundAlbedo)}
#define VS_SUN_ANGULAR_R ${A.sunAngularRadius.toPrecision(6)}

float vsSafeSqrt(float x) { return sqrt(max(x, 0.0)); }

float vsRayleighPhase(float cosT) {
  return 3.0 / (16.0 * VS_PI) * (1.0 + cosT * cosT);
}

// Cornette-Shanks: better forward lobe shape than plain Henyey-Greenstein.
float vsMiePhase(float cosT, float g) {
  float g2 = g * g;
  float k = 3.0 / (8.0 * VS_PI) * (1.0 - g2) / (2.0 + g2);
  float d = 1.0 + g2 - 2.0 * g * cosT;
  return k * (1.0 + cosT * cosT) / (d * vsSafeSqrt(d));
}

/** Nearest positive hit of a ray with a sphere at the origin; -1 on miss. */
float vsRaySphereNear(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d;
  float t1 = -b + d;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}

/** Far hit; assumes the ray starts inside the sphere. */
float vsRaySphereFar(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return 0.0;
  return max(0.0, -b + sqrt(d));
}

/** Scattering / extinction of the medium at altitude h (km above ground). */
void vsSampleMedium(float h, out vec3 scatterR, out float scatterM, out vec3 extinction) {
  float dR = exp(-max(h, 0.0) / VS_RAYLEIGH_H);
  float dM = exp(-max(h, 0.0) / VS_MIE_H);
  float dO = max(0.0, 1.0 - abs(h - VS_OZONE_C) / VS_OZONE_W);
  scatterR = VS_RAYLEIGH_S * dR;
  scatterM = VS_MIE_S * dM;
  extinction = scatterR + vec3(scatterM + VS_MIE_A * dM) + VS_OZONE_A * dO;
}

/** Bruneton's transmittance LUT parameterisation (r, mu) <-> uv. */
vec2 vsTransmittanceUv(float r, float mu) {
  float H = vsSafeSqrt(VS_TOP_R * VS_TOP_R - VS_GROUND_R * VS_GROUND_R);
  float rho = vsSafeSqrt(r * r - VS_GROUND_R * VS_GROUND_R);
  float disc = r * r * (mu * mu - 1.0) + VS_TOP_R * VS_TOP_R;
  float d = max(0.0, -r * mu + vsSafeSqrt(disc));
  float dMin = VS_TOP_R - r;
  float dMax = rho + H;
  return vec2((d - dMin) / max(dMax - dMin, 1e-5), rho / max(H, 1e-5));
}

void vsTransmittanceParams(vec2 uv, out float r, out float mu) {
  float H = vsSafeSqrt(VS_TOP_R * VS_TOP_R - VS_GROUND_R * VS_GROUND_R);
  float rho = H * uv.y;
  r = vsSafeSqrt(rho * rho + VS_GROUND_R * VS_GROUND_R);
  float dMin = VS_TOP_R - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}

#endif
`;

/**
 * Sky-view LUT mapping. Azimuth is measured from the sun so the LUT stays valid
 * for the whole hemisphere with the sky's mirror symmetry; elevation uses a
 * signed sqrt warp that packs texels around the horizon, which is what keeps
 * the horizon gradient free of stair-stepping.
 */
export const GLSL_SKYVIEW = /* glsl */ `
#ifndef VS_SKYVIEW_INCLUDED
#define VS_SKYVIEW_INCLUDED

vec2 vsSunAzimuth(vec3 sunDir) {
  vec2 s = vec2(sunDir.x, sunDir.z);
  float l = length(s);
  return l < 1e-4 ? vec2(1.0, 0.0) : s / l;
}

vec2 vsSkyViewUv(vec3 rd, vec3 sunDir) {
  float t = clamp(asin(clamp(rd.y, -1.0, 1.0)) / (0.5 * VS_PI), -1.0, 1.0);
  float v = 0.5 + 0.5 * sign(t) * sqrt(abs(t));
  vec2 s = vsSunAzimuth(sunDir);
  vec2 f = vec2(rd.x, rd.z);
  float fl = length(f);
  f = fl < 1e-5 ? s : f / fl;
  float u = acos(clamp(dot(f, s), -1.0, 1.0)) / VS_PI;
  return vec2(u, v);
}

vec3 vsSkyViewDir(vec2 uv, vec3 sunDir) {
  float t = (uv.y - 0.5) * 2.0;
  float el = sign(t) * t * t * (0.5 * VS_PI);
  float a = uv.x * VS_PI;
  vec2 s = vsSunAzimuth(sunDir);
  vec2 dir = vec2(s.x * cos(a) - s.y * sin(a), s.x * sin(a) + s.y * cos(a));
  float ce = cos(el);
  return vec3(dir.x * ce, sin(el), dir.y * ce);
}

#endif
`;

/** Hash / value noise / fbm, tileable. Used for clouds, stars and dithering. */
export const GLSL_NOISE = /* glsl */ `
#ifndef VS_NOISE_INCLUDED
#define VS_NOISE_INCLUDED

float vsHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 vsHash22(vec2 p) {
  float n = vsHash21(p);
  return vec2(n, vsHash21(p + n));
}

float vsHash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

/** Tileable value noise with integer period. */
float vsValueNoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i, period);
  vec2 b = mod(i + vec2(1.0, 0.0), period);
  vec2 c = mod(i + vec2(0.0, 1.0), period);
  vec2 d = mod(i + vec2(1.0, 1.0), period);
  float n00 = vsHash21(a);
  float n10 = vsHash21(b);
  float n01 = vsHash21(c);
  float n11 = vsHash21(d);
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

float vsFbm(vec2 p, float period, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vsValueNoise(p, period);
    norm += amp;
    p *= 2.0;
    period *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/** Ridged variant — gives clouds their billowed tops. */
float vsFbmRidged(vec2 p, float period, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = abs(vsValueNoise(p, period) * 2.0 - 1.0);
    sum += amp * (1.0 - n);
    norm += amp;
    p *= 2.0;
    period *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/** Triangular-PDF dither, ~1 LSB. Kills 8-bit banding in smooth gradients. */
vec3 vsDither(vec2 fragCoord, float amount) {
  float r = vsHash21(fragCoord * 0.7351 + 13.71);
  float g = vsHash21(fragCoord * 0.7351 + 71.13);
  float b = vsHash21(fragCoord * 0.7351 + 31.17);
  vec3 n = vec3(r, g, b);
  float r2 = vsHash21(fragCoord * 1.3197 + 5.11);
  float g2 = vsHash21(fragCoord * 1.3197 + 17.31);
  float b2 = vsHash21(fragCoord * 1.3197 + 43.77);
  return (n - vec3(r2, g2, b2)) * amount;
}

#endif
`;

/**
 * Cloud layer. A single baked, tiling density texture is shared by the sky dome
 * (which renders it as a lit slab) and by every scene material (which samples it
 * as a moving shadow). Same texture, same wind offset — so the shadow on the
 * ground always matches the cloud that casts it.
 *
 * uCloudTex channels: r = base density, g = erosion detail, b = coverage
 * modulation, a = high-frequency wisp.
 */
export const GLSL_CLOUDS = /* glsl */ `
#ifndef VS_CLOUDS_INCLUDED
#define VS_CLOUDS_INCLUDED

// uCloudParams: x = world units per texture tile, y = coverage, z = layer
//               altitude (world units), w = layer thickness (world units)
// uCloudWind:   xy = scrolling offset in tile space, z = shadow strength,
//               w = density multiplier

vec2 vsCloudUv(vec2 worldXZ) {
  return worldXZ / uCloudParams.x + uCloudWind.xy;
}

float vsCloudDensityUv(vec2 uv) {
  vec4 c = texture2D(uCloudTex, uv);
  float base = c.r * mix(0.55, 1.0, c.b);
  float d = base + uCloudParams.y - 1.0;
  d = smoothstep(0.0, 0.22, d);
  // Erode the edges with detail so the silhouettes are not blobby.
  d *= mix(1.0, c.g, 0.55 * (1.0 - d) + 0.15);
  return clamp(d * uCloudWind.w, 0.0, 1.0);
}

/**
 * Cloud shadow at a world position: project up the sun ray to the cloud deck
 * and sample the same density field the dome draws.
 */
float vsCloudShadow(vec3 worldPos, vec3 sunDir) {
  if (uCloudWind.z <= 0.0) return 1.0;
  float dy = max(uCloudParams.z - worldPos.y, 0.0);
  float t = dy / max(sunDir.y, 0.12);
  vec2 hit = worldPos.xz + sunDir.xz * t;
  float d = vsCloudDensityUv(vsCloudUv(hit));
  return 1.0 - uCloudWind.z * d;
}

#endif
`;
