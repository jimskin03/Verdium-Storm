import * as THREE from 'three';
import { DEPTH_RANGE, OPEN_RANGE, SHORE_RANGE, SLOPE_RANGE } from './FloorField';

/**
 * The water surface material.
 *
 * Displacement is a sum of Gerstner waves: each carries its own direction,
 * wavelength and steepness, and its angular frequency follows the deep-water
 * dispersion relation ω = √(gk) so long waves genuinely outrun short ones and
 * the crest pattern never repeats into a sine hum. Each wave is also gated by
 * the local water depth, which makes swell die on approach to a beach instead
 * of sawing through it.
 *
 * Shading is a full transparency model rather than a tinted plane: the scene
 * colour and depth captured before the water draws give a Beer-Lambert
 * absorption path through the column, a normal-driven refraction offset, a
 * screen-space reflection march, and the depth difference that drives shoreline
 * foam.
 */

export interface WaveDef {
  dir: THREE.Vector2;
  amplitude: number;
  wavelength: number;
  steepness: number;
  phase: number;
}

const GRAVITY = 9.81;

/**
 * A directional spectrum: energy falls with wavelength and the direction
 * spread widens as the waves get shorter, which is what stops the surface from
 * reading as corduroy.
 */
export function buildWaveSpectrum(count: number, windAngle: number): WaveDef[] {
  const wavelengths = [152, 93, 58, 35, 21, 13, 8.2, 5.1];
  const waves: WaveDef[] = [];
  for (let i = 0; i < count; i++) {
    const l = wavelengths[Math.min(i, wavelengths.length - 1)];
    // Deterministic pseudo-random spread, widening for the shorter components.
    const t = i / Math.max(1, count - 1);
    const spread = (0.24 + t * 0.85) * (i % 2 === 0 ? 1 : -1) * (0.55 + 0.45 * Math.cos(i * 2.399));
    const a = windAngle + spread;
    waves.push({
      dir: new THREE.Vector2(Math.cos(a), Math.sin(a)),
      amplitude: 0.0215 * l,
      wavelength: l,
      steepness: 0.92 / count,
      phase: (i * 2.399) % (Math.PI * 2),
    });
  }
  return waves;
}

/** Packs the spectrum into the two vec4 arrays the vertex shader consumes. */
export function packWaves(waves: WaveDef[]): { a: THREE.Vector4[]; b: THREE.Vector4[] } {
  const a: THREE.Vector4[] = [];
  const b: THREE.Vector4[] = [];
  for (const w of waves) {
    const k = (Math.PI * 2) / w.wavelength;
    const omega = Math.sqrt(GRAVITY * k);
    // steepness is expressed as the share of the unit Jacobian this wave may
    // consume, so Q·k·A is bounded and the crests never fold into loops.
    const q = w.steepness / Math.max(1e-4, k * w.amplitude);
    a.push(new THREE.Vector4(w.dir.x, w.dir.y, w.amplitude, k));
    b.push(new THREE.Vector4(omega, q, w.phase, w.wavelength));
  }
  return { a, b };
}

const COMMON = /* glsl */ `
#define FIELD_DEPTH_RANGE ${DEPTH_RANGE.toFixed(1)}
#define FIELD_SHORE_RANGE ${SHORE_RANGE.toFixed(1)}
#define FIELD_SLOPE_RANGE ${SLOPE_RANGE.toFixed(2)}
#define FIELD_OPEN_RANGE ${OPEN_RANGE.toFixed(1)}

uniform sampler2D uFloorField;
uniform float uFieldUvScale;
uniform float uTime;

struct Floor {
  float depth;   // metres of water column
  float shore;   // signed metres to the waterline, positive on land
  float slope;   // |grad| of the bed
  float open;    // 0 sheltered, 1 open sea
};

Floor sampleFloor(vec2 world) {
  vec4 t = texture2D(uFloorField, world * uFieldUvScale + 0.5);
  Floor f;
  f.depth = t.r * FIELD_DEPTH_RANGE;
  f.shore = (t.g * 2.0 - 1.0) * FIELD_SHORE_RANGE;
  f.slope = t.b * FIELD_SLOPE_RANGE;
  f.open = t.a;
  return f;
}
`;

export const WATER_VERTEX = /* glsl */ `
${COMMON}

uniform vec4 uWaveA[WAVE_COUNT];  // dir.xy, amplitude, k
uniform vec4 uWaveB[WAVE_COUNT];  // omega, steepness, phase, wavelength
uniform float uWaveScale;

varying vec3 vWorldPos;
varying vec3 vViewPos;
varying vec3 vWaveNormal;
varying vec4 vClip;
varying float vCrestFoam;
varying float vWaveHeight;
varying float vDepth;
varying float vShore;
varying float vOpen;
varying vec2 vShoreDir;

void main() {
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  Floor fl = sampleFloor(base.xz);

  // Shore direction: gradient of the baked distance field, pointing inland.
  // Foam and swash are advected along it so they always run up the beach.
  float e = 3.0;
  float sxp = sampleFloor(base.xz + vec2(e, 0.0)).shore;
  float sxn = sampleFloor(base.xz - vec2(e, 0.0)).shore;
  float szp = sampleFloor(base.xz + vec2(0.0, e)).shore;
  float szn = sampleFloor(base.xz - vec2(0.0, e)).shore;
  vec2 sdir = vec2(sxp - sxn, szp - szn);
  vShoreDir = length(sdir) > 1e-4 ? normalize(sdir) : vec2(0.0, 1.0);

  // Sheltered water carries less energy than open sea.
  float energy = mix(0.42, 1.0, fl.open) * uWaveScale;

  vec3 disp = vec3(0.0);
  vec3 tanX = vec3(1.0, 0.0, 0.0);
  vec3 tanZ = vec3(0.0, 0.0, 1.0);
  float jxx = 0.0;
  float jzz = 0.0;
  float jxz = 0.0;

  for (int i = 0; i < WAVE_COUNT; i++) {
    vec2 d = uWaveA[i].xy;
    float k = uWaveA[i].w;
    float lambda = uWaveB[i].w;
    // Shoaling gate: a wave feels the bed at roughly half its wavelength and
    // is gone by the time the column is a fraction of it.
    float gate = smoothstep(0.0, lambda * 0.30, fl.depth);
    float amp = uWaveA[i].z * energy * gate;
    float q = uWaveB[i].y;
    float f = k * dot(d, base.xz) - uWaveB[i].x * uTime + uWaveB[i].z;
    float s = sin(f);
    float c = cos(f);

    disp.xz += q * amp * d * c;
    disp.y += amp * s;

    float ka = k * amp;
    float qka = q * ka;
    tanX += vec3(-qka * d.x * d.x * s, ka * d.x * c, -qka * d.x * d.y * s);
    tanZ += vec3(-qka * d.x * d.y * s, ka * d.y * c, -qka * d.y * d.y * s);
    jxx += qka * d.x * d.x * s;
    jzz += qka * d.y * d.y * s;
    jxz += qka * d.x * d.y * s;
  }

  vec3 world = base + disp;
  // Never let a crest climb above the sand it is breaking against.
  float ceiling = -fl.shore * 0.06;
  world.y = min(world.y, max(ceiling, 0.0) + 0.4);

  vWaveNormal = normalize(cross(tanZ, tanX));
  // Jacobian below one means the surface is folding — that is where a real
  // wave throws whitecap.
  float jac = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
  vCrestFoam = clamp((0.72 - jac) * 2.6, 0.0, 1.0);
  vWaveHeight = disp.y;
  vDepth = fl.depth;
  vShore = fl.shore;
  vOpen = fl.open;

  vWorldPos = world;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewPos = mv.xyz;
  vClip = projectionMatrix * mv;
  gl_Position = vClip;
}
`;

export const WATER_FRAGMENT = /* glsl */ `
${COMMON}
#include <packing>

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uDetail;
uniform sampler2D uFoam;
uniform sampler2D uCaustics;

// three only injects the projection matrix into the vertex stage, so the
// fragment stage carries its own copy for the march and the refraction offset.
uniform mat4 uProjection;
uniform mat4 uInvProjection;
uniform mat4 uInvView;
uniform float uNear;
uniform float uFar;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;

uniform vec3 uExtinction;
uniform vec3 uScatterColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform float uRefractStrength;
uniform float uFoamWidth;
uniform float uSwashRange;
uniform float uCausticStrength;
uniform float uDetailStrength;
uniform vec2 uWindDir;

uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vWorldPos;
varying vec3 vViewPos;
varying vec3 vWaveNormal;
varying vec4 vClip;
varying float vCrestFoam;
varying float vWaveHeight;
varying float vDepth;
varying float vShore;
varying float vOpen;
varying vec2 vShoreDir;

float sat(float x) { return clamp(x, 0.0, 1.0); }

float eyeDepth(vec2 uv) {
  float raw = texture2D(uSceneDepth, uv).x;
  return -perspectiveDepthToViewZ(raw, uNear, uFar);
}

/** View-space position of a scene sample at 'uv' with linear depth 'eye'. */
vec3 viewPosAt(vec2 uv, float eye) {
  vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 v = uInvProjection * clip;
  vec3 dir = v.xyz / v.w;
  return dir * (eye / max(1e-4, -dir.z));
}

/**
 * Analytic sky used wherever the screen-space march has nothing to offer.
 * Driven from the environment service so it tracks the real sun, and pulled
 * toward the fog colour at the horizon so it meets the atmosphere cleanly.
 */
vec3 skyRadiance(vec3 d) {
  float up = d.y;
  vec3 col = mix(uHorizonColor, uZenithColor, pow(sat(up), 0.55));
  col = mix(uGroundColor, col, smoothstep(-0.28, 0.02, up));
  col = mix(uFogColor, col, smoothstep(0.0, 0.22, abs(up) + 0.02));
  float s = sat(dot(d, uSunDir));
  col += uSunColor * pow(s, 480.0) * 6.0;
  col += uSunColor * pow(s, 9.0) * 0.30;
  return col;
}

/** Interleaved gradient noise — a cheap, stable dither for the SSR march. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Sums three scrolling octaves of the ripple slope map. */
vec2 detailSlope(vec2 p, float dist, out float sparkle) {
  vec2 flow = uWindDir * uTime;
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);

  float fade1 = 1.0 - smoothstep(600.0, 2200.0, dist);
  float fade2 = 1.0 - smoothstep(150.0, 620.0, dist);
  float fade3 = 1.0 - smoothstep(38.0, 165.0, dist);

  vec2 s = vec2(0.0);
  s += (texture2D(uDetail, p * 0.0136 + flow * 0.0085).rg * 2.0 - 1.0) * (1.00 * fade1);
  s += (texture2D(uDetail, (p * 0.0392 + perp * 4.0) * vec2(1.0, -1.0) + flow * 0.0175).rg * 2.0 - 1.0) * (0.62 * fade2);
  vec4 fine = texture2D(uDetail, p * 0.1150 - flow * 0.0290 + vec2(0.37, 0.11));
  s += (fine.rg * 2.0 - 1.0) * (0.34 * fade3);
  sparkle = fine.a * fade3;
  return s * uDetailStrength;
}

#ifdef USE_SSR
/**
 * Screen-space reflection march against the pre-water depth buffer. Steps grow
 * geometrically so a short ray is precise near the surface and a long one still
 * reaches the far shore; a hit is refined by four bisections before the colour
 * is fetched. Misses fall through to the analytic sky.
 */
vec3 screenSpaceReflection(vec3 viewPos, vec3 viewNormal, float roughness, out float weight) {
  weight = 0.0;
  vec3 dir = reflect(normalize(viewPos), viewNormal);
  if (dir.z > 0.0 && viewPos.z + dir.z * 4.0 > -uNear) return vec3(0.0);

  float stepLen = max(1.2, -viewPos.z * 0.035);
  vec3 p = viewPos + viewNormal * 0.35;
  p += dir * stepLen * (0.35 + 0.65 * ign(gl_FragCoord.xy));

  vec2 hitUv = vec2(0.0);
  bool hit = false;

  for (int i = 0; i < SSR_STEPS; i++) {
    p += dir * stepLen;
    vec4 clip = uProjection * vec4(p, 1.0);
    if (clip.w <= 0.0) break;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float sceneEye = eyeDepth(uv);
    float rayEye = -p.z;
    float delta = rayEye - sceneEye;
    // Thickness test: a ray that has passed behind the surface but not by more
    // than a step plus a slack band counts as a hit, not as an occluder.
    if (delta > 0.02 && delta < stepLen * 1.9 + 2.0) {
      vec3 lo = p - dir * stepLen;
      vec3 hi = p;
      for (int j = 0; j < 4; j++) {
        vec3 mid = (lo + hi) * 0.5;
        vec4 c2 = uProjection * vec4(mid, 1.0);
        vec2 u2 = c2.xy / c2.w * 0.5 + 0.5;
        if (-mid.z > eyeDepth(u2)) hi = mid; else lo = mid;
      }
      vec4 c3 = uProjection * vec4(hi, 1.0);
      hitUv = c3.xy / c3.w * 0.5 + 0.5;
      hit = true;
      break;
    }
    stepLen *= 1.22;
  }

  if (!hit) return vec3(0.0);

  vec2 edge = min(hitUv, 1.0 - hitUv);
  float fade = smoothstep(0.0, 0.10, min(edge.x, edge.y));
  // Rough water scatters the reflection; drop SSR confidence as it roughens so
  // the sky takes over rather than smearing a sharp mirror over chop.
  fade *= 1.0 - smoothstep(0.10, 0.26, roughness);
  weight = fade;
  return texture2D(uSceneColor, hitUv).rgb;
}
#endif

void main() {
  vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
  float waterEye = -vViewPos.z;
  float dist = length(vViewPos);

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);

  // ---------------------------------------------------------------- normals
  float sparkleMask;
  vec2 slope = detailSlope(vWorldPos.xz, dist, sparkleMask);
  // Detail is suppressed in the last metre of water so ripples do not shred the
  // waterline, and boosted a little in open water where the wind has fetch.
  float detailFade = smoothstep(0.15, 2.2, vDepth) * mix(0.72, 1.15, vOpen);
  vec3 N = normalize(vWaveNormal + vec3(-slope.x, 0.0, -slope.y) * detailFade);
  vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);

  // ------------------------------------------------------------ scene depth
  float floorEye = eyeDepth(suv);
  float throughWater = max(floorEye - waterEye, 0.0);
  // No geometry behind the surface at all means open ocean, not zero depth.
  if (floorEye > uFar * 0.985) throughWater = 400.0;

  // ------------------------------------------------------------- refraction
  // Offset shrinks with the water column so a shallow edge cannot drag the
  // beach out over the shoreline, and with distance so it stays world-stable.
  float refrDepthFade = sat(throughWater * 0.55);
  vec2 refrOffset = Nv.xy * (uRefractStrength * refrDepthFade / max(waterEye, 1.0))
    * vec2(uProjection[0][0], uProjection[1][1]);
  vec2 ruv = clamp(suv + refrOffset, vec2(0.0015), vec2(0.9985));
  float rEye = eyeDepth(ruv);
  // Reject the offset if it walked onto something in front of the water.
  if (rEye < waterEye) {
    ruv = suv;
    rEye = floorEye;
  }
  float refrThrough = max(rEye - waterEye, 0.0);
  if (rEye > uFar * 0.985) refrThrough = 400.0;

  vec3 bed = texture2D(uSceneColor, ruv).rgb;

  // --------------------------------------------------------------- caustics
#ifdef USE_CAUSTICS
  vec3 bedView = viewPosAt(ruv, rEye);
  vec3 bedWorld = (uInvView * vec4(bedView, 1.0)).xyz;
  float causticDepth = max(0.0, -bedWorld.y);
  // Displace the lookup by the surface normal: the caustic web crawls with the
  // waves overhead instead of sliding independently of them.
  vec2 cp = bedWorld.xz + N.xz * causticDepth * 0.55;
  float c1 = texture2D(uCaustics, cp * 0.052 + uWindDir * uTime * 0.010).r;
  float c2 = texture2D(uCaustics, cp * 0.071 - uWindDir.yx * uTime * 0.013).g;
  float caustic = pow(min(c1, c2), 1.35);
  caustic *= exp(-causticDepth * 0.075) * sat(L.y * 1.8) * smoothstep(0.0, 1.2, causticDepth);
  bed += uSunColor * uSunIntensity * caustic * uCausticStrength;
#endif

  // ------------------------------------------------------------- absorption
  vec3 transmit = exp(-uExtinction * refrThrough);
  // The shallow tint keeps a sandy silt cast in the first couple of metres,
  // where absorption alone has barely bitten yet.
  vec3 shallowMix = mix(uShallowColor, uScatterColor, sat(refrThrough * 0.14));
  // In-scattered light is proportional to what is falling on the surface, so
  // the body colour tracks time of day instead of sitting at a fixed value.
  float ambient = (0.35 + 0.65 * sat(L.y)) * uSunIntensity * 0.5;
  vec3 underwater = bed * transmit + shallowMix * (1.0 - transmit) * ambient;

  // ------------------------------------------------------------- reflection
  float NoV = sat(dot(N, V));
  float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.35 + R.y * 0.65 + 0.02; // keep grazing rays off the ground
  vec3 reflection = skyRadiance(normalize(R));

  // Roughness rises with distance (sub-pixel wave variance) and with foam, so
  // the sun path breaks into a broad sparkling road instead of one hot blob.
  float roughness = mix(0.045, 0.20, smoothstep(60.0, 900.0, dist));
  roughness = mix(roughness, 0.42, sat(vCrestFoam));

#ifdef USE_SSR
  float ssrWeight;
  vec3 ssrColor = screenSpaceReflection(vViewPos, Nv, roughness, ssrWeight);
  reflection = mix(reflection, ssrColor, ssrWeight);
#endif

  // ------------------------------------------------------------------ foam
  // Two independent measurements of "how close is the bottom": the screen-space
  // depth difference, which is exact against whatever is actually drawn, and
  // the baked shore distance, which survives grazing angles and the far field.
  float contact = 1.0 - smoothstep(0.0, uFoamWidth, throughWater);

  // Swash: the waterline breathes up and down the beach on a long cycle that is
  // broken up spatially so the whole shore does not pulse in unison.
  float shorePhase = uTime * 0.55
    - vShore * 0.045
    + dot(vWorldPos.xz, vec2(0.011, -0.008))
    + texture2D(uDetail, vWorldPos.xz * 0.0021).b * 6.2;
  float swash = sin(shorePhase);
  float runup = swash * uSwashRange * mix(0.35, 1.4, sat(vOpen + 0.35));
  float sd = vShore - runup;

  // Gentle beaches spread their foam far further out than a steep bank does.
  float beachWiden = mix(1.0, 2.6, 1.0 - smoothstep(0.05, 0.42, sampleFloor(vWorldPos.xz).slope));
  float band = smoothstep(-uFoamWidth * 2.4 * beachWiden, -uFoamWidth * 0.15, sd);
  float shoreMask = max(contact, band);
  // Trailing edge: as the swash retreats it leaves a thinning residue.
  shoreMask *= mix(0.68, 1.0, sat(swash * 0.5 + 0.5));

  vec2 foamFlow = -vShoreDir * uTime * 0.55 + uWindDir * uTime * 0.18;
  vec4 f1 = texture2D(uFoam, vWorldPos.xz * 0.062 + foamFlow * 0.045);
  vec4 f2 = texture2D(uFoam, vWorldPos.xz * 0.158 - foamFlow * 0.030 + vec2(0.41, 0.77));
  float mass = f1.r * 0.62 + f2.a * 0.38 + f2.g * 0.22;
  float dissolveBias = (f1.b - 0.5) * 0.55;

  float crest = vCrestFoam * smoothstep(1.5, 8.0, vDepth);
  float amount = sat(max(shoreMask, crest * 0.9));
  float threshold = (1.0 - amount) + dissolveBias * amount;
  float foam = smoothstep(threshold - 0.12, threshold + 0.22, mass);
  foam = sat(foam * smoothstep(0.02, 0.18, amount));

  // A thin bright lip exactly on the contact line reads as the water edge.
  float lip = pow(1.0 - smoothstep(0.0, uFoamWidth * 0.30, throughWater), 2.0);
  foam = max(foam, lip * 0.85);
  foam *= 1.0 - smoothstep(700.0, 1800.0, dist);

  // ------------------------------------------------------------- composition
  vec3 color = mix(underwater, reflection, fresnel * (1.0 - foam * 0.92));

  // Sun specular: GGX with the distance-widened roughness.
  vec3 H = normalize(L + V);
  float NoH = sat(dot(N, H));
  float NoL = sat(dot(N, L));
  float a2 = roughness * roughness * roughness * roughness;
  float dgg = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / max(1e-6, 3.14159265 * dgg * dgg);
  float vis = 0.25 / max(1e-4, NoV * NoL + 0.05);
  float spec = min(D * vis * NoL, 26.0);
  color += uSunColor * uSunIntensity * spec * (1.0 - foam * 0.7);

  // Glitter: micro-facets the normal map cannot resolve at this distance, put
  // back as a narrow stochastic highlight along the sun path.
  float glitter = pow(sat(dot(N, H)), 380.0) * sparkleMask * 6.0
    + pow(sat(dot(N, H)), 90.0) * 0.35;
  color += uSunColor * uSunIntensity * glitter * sat(vDepth * 0.4) * (1.0 - foam);

  // Light scattering through a crest: strongest looking into a backlit wave.
  vec3 sssDir = normalize(L + N * 0.32);
  float sss = pow(sat(dot(V, -sssDir)), 4.0);
  sss *= sat(vWaveHeight * 0.55 + 0.12) * sat(vDepth * 0.25);
  color += uScatterColor * uSunColor * uSunIntensity * sss * 0.55;

  // Foam is a diffuse, self-shadowing mat, not a white decal.
  vec3 foamLit = uFoamColor * (0.34 + 0.66 * sat(L.y * 0.6 + 0.5)) * (uSunColor * 0.5 + 0.5);
  foamLit *= 0.72 + 0.28 * mass;
  color = mix(color, foamLit * uSunIntensity * 0.24, foam);

  // ------------------------------------------------------------------- fog
  float fogF = 1.0 - exp(-(dist * uFogDensity) * (dist * uFogDensity));
  color = mix(color, uFogColor, sat(fogF));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface WaterMaterialOptions {
  waveCount: number;
  ssrSteps: number;
  caustics: boolean;
  detail: THREE.Texture;
  foam: THREE.Texture;
  caustic: THREE.Texture;
  floorField: THREE.Texture;
  fieldUvScale: number;
  windAngle: number;
}

export function createWaterMaterial(opts: WaterMaterialOptions): THREE.ShaderMaterial {
  const waves = buildWaveSpectrum(opts.waveCount, opts.windAngle);
  const packed = packWaves(waves);

  const defines: Record<string, number> = { WAVE_COUNT: opts.waveCount };
  if (opts.ssrSteps > 0) {
    defines.USE_SSR = 1;
    defines.SSR_STEPS = opts.ssrSteps;
  }
  if (opts.caustics) defines.USE_CAUSTICS = 1;

  return new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uTime: { value: 0 },
      uFloorField: { value: opts.floorField },
      uFieldUvScale: { value: opts.fieldUvScale },
      uWaveA: { value: packed.a },
      uWaveB: { value: packed.b },
      uWaveScale: { value: 1 },

      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uDetail: { value: opts.detail },
      uFoam: { value: opts.foam },
      uCaustics: { value: opts.caustic },

      uProjection: { value: new THREE.Matrix4() },
      uInvProjection: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uNear: { value: 1 },
      uFar: { value: 5000 },

      uSunDir: { value: new THREE.Vector3(0.42, 0.62, 0.35).normalize() },
      uSunColor: { value: new THREE.Color(0xffe6c2) },
      uSunIntensity: { value: 1.0 },
      uZenithColor: { value: new THREE.Color(0x2f6ea8) },
      uHorizonColor: { value: new THREE.Color(0x9fb6c4) },
      uGroundColor: { value: new THREE.Color(0x2a3033) },

      uExtinction: { value: new THREE.Vector3(0.155, 0.058, 0.042) },
      uScatterColor: { value: new THREE.Color(0x1c6470) },
      uShallowColor: { value: new THREE.Color(0x4a8f7e) },
      uFoamColor: { value: new THREE.Color(0xe6f2f4) },
      uRefractStrength: { value: 34 },
      uFoamWidth: { value: 3.4 },
      uSwashRange: { value: 4.2 },
      uCausticStrength: { value: 0.09 },
      uDetailStrength: { value: 0.55 },
      uWindDir: { value: new THREE.Vector2(Math.cos(opts.windAngle), Math.sin(opts.windAngle)) },

      uFogColor: { value: new THREE.Color(0x93a9b8) },
      uFogDensity: { value: 0.00075 },
    },
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
    lights: false,
  });
}
