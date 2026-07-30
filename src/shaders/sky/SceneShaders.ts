import * as THREE from 'three';
import { GLSL_ATMOSPHERE, GLSL_CLOUDS, GLSL_NOISE, GLSL_SKYVIEW } from './atmosphereCommon';

/**
 * The bridge between the atmosphere and every other material in the scene.
 *
 * Three.js gives materials a single 'fogColor'/'fogDensity' pair, which cannot
 * express aerial perspective (per-channel extinction, height falloff, sky-tinted
 * inscatter, light shafts) or cascaded shadows. So this module owns one set of
 * uniform objects and splices them — by reference, so a single write updates
 * every material — into whatever the other work streams put in the scene:
 *
 *  - '#include <project_vertex>'      + world position varying
 *  - '#include <tonemapping_fragment>'+ aerial perspective, in linear space,
 *                                       before tone mapping (three's own fog
 *                                       runs after it, which is too late)
 *  - 'ShaderChunk.lights_fragment_begin' is overridden once, globally, so the
 *    sun's directional lights become shadow cascades. The override is inert
 *    unless a material carries the 'VS_CSM' define, so unpatched materials —
 *    including any created by another stream between two patch passes — keep
 *    stock three.js behaviour.
 */

// ---------------------------------------------------------------------------
// Shared uniform block
// ---------------------------------------------------------------------------

function whiteGroundTexture(): THREE.DataTexture {
  // r = sun visibility, g = sky visibility, b = terrain height (normalised)
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

export const skyUniforms = {
  uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.35).normalize() },
  uMoonDir: { value: new THREE.Vector3(-0.4, -0.6, -0.35).normalize() },
  uMoonColor: { value: new THREE.Color(0.62, 0.66, 0.82) },
  /** Radiance of the solar disc, already tinted by atmospheric transmittance. */
  uSunRadiance: { value: new THREE.Vector3(1, 1, 1) },
  uCameraPos: { value: new THREE.Vector3() },

  uSkyView: { value: null as THREE.Texture | null },
  uTransmittance: { value: null as THREE.Texture | null },
  uCloudTex: { value: null as THREE.Texture | null },
  uGroundTex: { value: whiteGroundTexture() as THREE.Texture },

  /** x: sky radiance gain, y: camera altitude (km), z: time, w: star gain. */
  uSkyParams: { value: new THREE.Vector4(1, 0.06, 0, 0) },
  /** x: sun disc gain, y: aureole gain, z: cloud lighting gain, w: unused. */
  uDomeParams: { value: new THREE.Vector4(28, 0.6, 1, 0) },
  /** x: ridge height (rad), y: contrast, z: rock/sky ratio, w: unused. */
  uRidge: { value: new THREE.Vector4(0.055, 0.55, 0.82, 0) },

  /** x: world units per cloud tile, y: coverage, z: altitude, w: thickness. */
  uCloudParams: { value: new THREE.Vector4(2400, 0.52, 900, 260) },
  /** xy: wind offset in tile space, z: shadow strength, w: density gain. */
  uCloudWind: { value: new THREE.Vector4(0, 0, 0.55, 1) },

  /** x: 1/worldSize, y: unused, z: sky-AO strength, w: terrain height scale. */
  uGroundParams: { value: new THREE.Vector4(1 / 1024, 0, 0.85, 300) },

  /** x: haze density, y: haze falloff, z: mist density, w: mist falloff. */
  uFogA: { value: new THREE.Vector4(0.0016, 1 / 260, 0.0042, 1 / 26) },
  /** Per-channel extinction tint — the blue shift of distance. */
  uFogExt: { value: new THREE.Vector3(0.78, 0.95, 1.35) },
  /** x: inscatter gain, y: boundary haze start, z: boundary boost, w: shafts. */
  uFogB: { value: new THREE.Vector4(1, 330, 3.2, 0.85) },

  /** Far distance of each shadow cascade, view space. */
  uCsmSplits: { value: new THREE.Vector4(30, 90, 260, 900) },
  /** World extent covered by each cascade's shadow map. */
  uCsmExtent: { value: new THREE.Vector4(60, 180, 520, 1800) },
  /** Ortho depth range of each cascade, for PCSS blocker distances. */
  uCsmDepth: { value: new THREE.Vector4(1000, 1000, 1000, 1000) },
  /** x: cascade fade band, y: max PCF radius (texels), z: sun angular size. */
  uCsmParams: { value: new THREE.Vector3(0.12, 3.0, 0.022) },
};

export const shaderConfig = {
  cascades: 0,
  pcfTaps: 12,
  blockerTaps: 8,
  lightShafts: true,
};

/**
 * Lighting state published by the atmosphere and consumed by the light rig.
 * Both live in this work stream, so this is a direct hand-off rather than a
 * cross-stream service: the key light is the sun by day and the moon by night,
 * and its colour is whatever the scattering model says survives the air mass.
 */
export const skyState = {
  keyDirection: new THREE.Vector3(0.4, 0.6, 0.35).normalize(),
  keyColor: new THREE.Color(1, 1, 1),
  keyIntensity: 3.5,
  /** Warm light kicked back up out of the ground, opposite the key. */
  bounceColor: new THREE.Color(0.4, 0.36, 0.26),
  bounceIntensity: 0.5,
  /** Cool sky fill used when no environment probe is available yet. */
  skyColor: new THREE.Color(0.35, 0.45, 0.6),
  /** 0 by day, 1 in full night — drives stars, moonlight and fog colour. */
  night: 0,
};

// ---------------------------------------------------------------------------
// GLSL shared by the dome and by every patched scene material
// ---------------------------------------------------------------------------

/** Uniform declarations for the aerial-perspective block. */
export const GLSL_AERIAL_UNIFORMS = /* glsl */ `
uniform vec3 uSunDir;
uniform sampler2D uSkyView;
uniform sampler2D uCloudTex;
uniform sampler2D uGroundTex;
uniform vec4 uCloudParams;
uniform vec4 uCloudWind;
uniform vec4 uGroundParams;
uniform vec4 uFogA;
uniform vec3 uFogExt;
uniform vec4 uFogB;
uniform vec4 uSkyParams;
`;

/**
 * Height-layered aerial perspective.
 *
 * Two exponential layers (a deep haze and a shallow ground mist) are integrated
 * analytically along the view ray, so fog pools in valleys and thins over
 * ridges instead of being a flat function of distance. Extinction is per
 * channel, which produces the blue shift that sells distance, and the
 * inscattered colour is read from the sky-view LUT in the *view direction* — so
 * geometry always dissolves into exactly the sky behind it, and the edge of the
 * 1 km playfield disappears instead of ending in void.
 */
export const GLSL_AERIAL = /* glsl */ `
#ifndef VS_AERIAL_INCLUDED
#define VS_AERIAL_INCLUDED

vec3 vsSkyLookup(vec3 rd) {
  return texture2D(uSkyView, vsSkyViewUv(rd, uSunDir)).rgb * uSkyParams.x * uFogB.x;
}

float vsLayerOpticalDepth(float y0, float y1, float dist, float density, float falloff) {
  if (density <= 0.0) return 0.0;
  float dy = y1 - y0;
  float e0 = exp(-falloff * y0);
  if (abs(dy) < 0.05) return density * e0 * dist;
  float e1 = exp(-falloff * y1);
  return density * dist * (e0 - e1) / (falloff * dy);
}

/** Extra haze towards the map boundary so the world edge is never a silhouette. */
float vsBoundaryHaze(vec3 p) {
  float e = max(abs(p.x), abs(p.z));
  return 1.0 + uFogB.z * smoothstep(uFogB.y, uFogB.y + 190.0, e);
}

float vsFogOpticalDepth(float camY, float worldY, float dist, vec3 worldPos) {
  float y0 = max(camY, -6.0);
  float y1 = max(worldY, -6.0);
  float od = vsLayerOpticalDepth(y0, y1, dist, uFogA.x, uFogA.y)
           + vsLayerOpticalDepth(y0, y1, dist, uFogA.z, uFogA.w);
  return od * vsBoundaryHaze(worldPos);
}

vec3 vsAerialPerspective(vec3 color, vec3 worldPos, vec3 camPos, vec3 rd, float dist) {
  float od = vsFogOpticalDepth(camPos.y, worldPos.y, dist, worldPos);
  vec3 tr = exp(-od * uFogExt);
  vec3 ins = vsSkyLookup(rd);

  #ifdef VS_LIGHT_SHAFTS
    // Volumetric shafts: the fog only glows where the sun actually reaches it,
    // so cloud gaps become visible beams in the haze.
    float lit = 0.0;
    for (int i = 0; i < 3; i++) {
      float f = (float(i) + 0.5) / 3.0;
      lit += vsCloudShadow(camPos + (worldPos - camPos) * f, uSunDir);
    }
    lit /= 3.0;
    ins *= mix(1.0, lit, uFogB.w * 0.55);
  #endif

  return color * tr + ins * (1.0 - tr);
}

vec4 vsGroundSample(vec3 worldPos) {
  return texture2D(uGroundTex, worldPos.xz * uGroundParams.x + 0.5);
}

/** Terrain self-shadowing + sky occlusion, faded out with height above ground. */
float vsTerrainShadow(vec3 worldPos, vec4 groundSample) {
  float above = worldPos.y - groundSample.b * uGroundParams.w;
  float fade = 1.0 - smoothstep(4.0, 70.0, above);
  return mix(1.0, groundSample.r, fade);
}

#endif
`;

/** Cascaded shadows with a PCSS-style contact-hardening filter. */
function glslCascades(): string {
  const taps = Math.max(4, shaderConfig.pcfTaps);
  const blockerTaps = Math.max(4, shaderConfig.blockerTaps);
  return /* glsl */ `
#ifndef VS_CSM_INCLUDED
#define VS_CSM_INCLUDED

uniform vec4 uCsmSplits;
uniform vec4 uCsmExtent;
uniform vec4 uCsmDepth;
uniform vec3 uCsmParams;

#define VS_PCF_TAPS ${taps}
#define VS_BLOCKER_TAPS ${blockerTaps}

float vsUnpackDepth(vec4 v) {
  return dot(v, vec4(0.99609375, 0.003890991, 1.5199184e-5, 5.9604645e-8));
}

vec2 vsVogel(int i, int n, float phase) {
  float r = sqrt((float(i) + 0.5) / float(n));
  float theta = float(i) * 2.399963229728653 + phase;
  return vec2(cos(theta), sin(theta)) * r;
}

float vsCsmComponent(vec4 v, int i) {
  return i == 0 ? v.x : (i == 1 ? v.y : (i == 2 ? v.z : v.w));
}

float vsCascadeWeight(int i, float depth) {
  float lo = i == 0 ? 0.0 : vsCsmComponent(uCsmSplits, i - 1);
  float hi = vsCsmComponent(uCsmSplits, i);
  float w = 1.0;
  if (i > 0) {
    float prev = i >= 2 ? vsCsmComponent(uCsmSplits, i - 2) : 0.0;
    float fLo = uCsmParams.x * (lo - prev);
    w *= smoothstep(lo - fLo, lo, depth);
  }
  if (i < VS_CSM_CASCADES - 1) {
    float fHi = uCsmParams.x * (hi - lo);
    w *= 1.0 - smoothstep(hi - fHi, hi, depth);
  }
  return w;
}

float vsCascadeShadow(int index, sampler2D shadowMap, vec2 mapSize, float bias, vec4 coord) {
  vec3 c = coord.xyz / coord.w;
  if (c.z > 1.0 || c.z < -1.0) return 1.0;
  vec2 inside = step(vec2(0.0), c.xy) * step(c.xy, vec2(1.0));
  if (inside.x * inside.y < 0.5) return 1.0;

  float receiver = c.z + bias;
  vec2 texel = 1.0 / mapSize;
  float extent = vsCsmComponent(uCsmExtent, index);
  float depthRange = vsCsmComponent(uCsmDepth, index);
  float phase = (vsHash21(gl_FragCoord.xy) + vsHash21(gl_FragCoord.yx * 1.7)) * 3.14159265;

  // Blocker search over the largest penumbra the sun can produce here.
  float maxPenumbra = min(uCsmParams.y * texel.x * 6.0, 0.06);
  float blockerSum = 0.0;
  float blockerCount = 0.0;
  for (int i = 0; i < VS_BLOCKER_TAPS; i++) {
    vec2 o = vsVogel(i, VS_BLOCKER_TAPS, phase) * maxPenumbra;
    float d = vsUnpackDepth(texture2D(shadowMap, c.xy + o));
    if (d < receiver) {
      blockerSum += d;
      blockerCount += 1.0;
    }
  }
  if (blockerCount < 0.5) return 1.0;

  float blocker = blockerSum / blockerCount;
  // Penumbra grows with the distance between blocker and receiver: contact
  // shadows stay tight, distant ones go soft.
  float separation = max(receiver - blocker, 0.0) * depthRange;
  float radius = clamp(separation * uCsmParams.z / extent, texel.x * 0.75, maxPenumbra);

  float sum = 0.0;
  for (int i = 0; i < VS_PCF_TAPS; i++) {
    vec2 o = vsVogel(i, VS_PCF_TAPS, phase + 1.7) * radius;
    sum += step(receiver, vsUnpackDepth(texture2D(shadowMap, c.xy + o)));
  }
  return sum / float(VS_PCF_TAPS);
}

/**
 * Full sun visibility for cascade 'index': cascade blend weight, cast shadows,
 * terrain self-shadowing and the moving cloud deck.
 */
vec3 vsCascadeLight(int index, sampler2D shadowMap, vec2 mapSize, float bias, vec4 coord, float viewDepth, bool receive) {
  float w = vsCascadeWeight(index, viewDepth);
  if (w <= 0.0) return vec3(0.0);
  float s = receive ? vsCascadeShadow(index, shadowMap, mapSize, bias, coord) : 1.0;
  vec4 g = vsGroundSample(vVsWorld);
  s *= vsTerrainShadow(vVsWorld, g);
  s *= vsCloudShadow(vVsWorld, uSunDir);
  return vec3(w * s);
}

#endif
`;
}

// ---------------------------------------------------------------------------
// Global chunk override
// ---------------------------------------------------------------------------

let chunkPatched = false;

/** Rewrites the directional-light shadow lookup to route through the cascades. */
export function installChunkOverrides(): void {
  if (chunkPatched) return;
  chunkPatched = true;

  const original = THREE.ShaderChunk.lights_fragment_begin;
  const marker = 'getShadow( directionalShadowMap[ i ]';
  const line = original.split('\n').find((l) => l.includes(marker));
  if (!line) {
    console.warn('[atmosphere] directional shadow hook not found; cascades disabled');
    shaderConfig.cascades = 0;
    return;
  }

  const replacement = `
		#if defined( VS_CSM ) && ( UNROLLED_LOOP_INDEX < VS_CSM_CASCADES )
			directLight.color *= vsCascadeLight( UNROLLED_LOOP_INDEX, directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, vDirectionalShadowCoord[ i ], - vViewPosition.z, directLight.visible && receiveShadow );
		#else
${line}
		#endif`;

  THREE.ShaderChunk.lights_fragment_begin = original.replace(line, replacement);
}

// ---------------------------------------------------------------------------
// Material patching
// ---------------------------------------------------------------------------

const patched = new WeakSet<THREE.Material>();
const shared: Record<string, THREE.IUniform> = skyUniforms as unknown as Record<string, THREE.IUniform>;

function isLitMaterial(material: THREE.Material): boolean {
  const m = material as unknown as Record<string, boolean>;
  return Boolean(
    m.isMeshStandardMaterial ||
      m.isMeshPhysicalMaterial ||
      m.isMeshPhongMaterial ||
      m.isMeshLambertMaterial ||
      m.isMeshToonMaterial ||
      ((material as THREE.ShaderMaterial).isShaderMaterial && (material as THREE.ShaderMaterial).lights),
  );
}

function injectVertex(source: string): string {
  const worldPos = /* glsl */ `
  vec4 vsWorld4 = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    vsWorld4 = batchingMatrix * vsWorld4;
  #endif
  #ifdef USE_INSTANCING
    vsWorld4 = instanceMatrix * vsWorld4;
  #endif
  vVsWorld = ( modelMatrix * vsWorld4 ).xyz;
`;
  let out = 'varying vec3 vVsWorld;\n' + source;
  if (out.includes('#include <project_vertex>')) {
    out = out.replace('#include <project_vertex>', '#include <project_vertex>\n' + worldPos);
  } else {
    out = out.replace('void main() {', 'void main() {\n  vVsWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;\n');
  }
  return out;
}

function fragmentPrelude(lit: boolean): string {
  return [
    'varying vec3 vVsWorld;',
    GLSL_AERIAL_UNIFORMS,
    GLSL_ATMOSPHERE,
    GLSL_SKYVIEW,
    GLSL_NOISE,
    GLSL_CLOUDS,
    GLSL_AERIAL,
    lit && shaderConfig.cascades > 0 ? glslCascades() : '',
  ].join('\n');
}

const AERIAL_APPLY = /* glsl */ `
  {
    vec3 vsRel = vVsWorld - cameraPosition;
    float vsDist = length(vsRel);
    vec3 vsRd = vsRel / max(vsDist, 1e-4);
    gl_FragColor.rgb = vsAerialPerspective(gl_FragColor.rgb, vVsWorld, cameraPosition, vsRd, vsDist);
  }
`;

function injectFragment(source: string, lit: boolean): string {
  let out = fragmentPrelude(lit) + '\n' + source;
  if (out.includes('#include <tonemapping_fragment>')) {
    out = out.replace('#include <tonemapping_fragment>', AERIAL_APPLY + '\n\t#include <tonemapping_fragment>');
    out = out.replace('#include <fog_fragment>', '');
  } else if (out.includes('#include <fog_fragment>')) {
    out = out.replace('#include <fog_fragment>', AERIAL_APPLY);
  }
  return out;
}

/** Ambient occlusion from the terrain sky-visibility bake, applied to indirect light. */
const AO_APPLY = /* glsl */ `
  #if defined( RE_IndirectDiffuse )
  {
    vec4 vsG = vsGroundSample( vVsWorld );
    float vsAbove = vVsWorld.y - vsG.b * uGroundParams.w;
    float vsFade = 1.0 - smoothstep( 2.0, 55.0, vsAbove );
    float vsAo = mix( 1.0, mix( 1.0, vsG.g, uGroundParams.z ), vsFade );
    irradiance *= vsAo;
    iblIrradiance *= vsAo;
    #if defined( RE_IndirectSpecular )
      radiance *= mix( 1.0, vsAo, 0.6 );
    #endif
  }
  #endif
`;

function patchMaterial(material: THREE.Material): void {
  if (patched.has(material)) return;
  if ((material as THREE.RawShaderMaterial).isRawShaderMaterial) return;
  if (material.userData?.vsNoPatch) return;
  patched.add(material);

  const lit = isLitMaterial(material);
  const previous = material.onBeforeCompile;

  material.defines = material.defines ?? {};
  material.defines.VS_AERIAL = '';
  if (shaderConfig.lightShafts) material.defines.VS_LIGHT_SHAFTS = '';
  if (lit && shaderConfig.cascades > 0) {
    material.defines.VS_CSM = '';
    material.defines.VS_CSM_CASCADES = shaderConfig.cascades;
  }

  material.onBeforeCompile = function (shader, renderer) {
    previous?.call(this, shader, renderer);
    shader.vertexShader = injectVertex(shader.vertexShader);
    shader.fragmentShader = injectFragment(shader.fragmentShader, lit);
    if (lit && shader.fragmentShader.includes('#include <lights_fragment_maps>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\n' + AO_APPLY,
      );
    }
    for (const key of Object.keys(shared)) shader.uniforms[key] = shared[key];
  };
  material.needsUpdate = true;
}

/** Walks the scene and patches any material that has not been seen yet. */
export function patchScene(root: THREE.Object3D): void {
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) return;
    if (Array.isArray(material)) {
      for (const m of material) patchMaterial(m);
    } else {
      patchMaterial(material);
    }
  });
}

/** Marks a material as owned by the atmosphere itself, so it is never patched. */
export function excludeFromPatching(material: THREE.Material): void {
  material.userData = material.userData ?? {};
  material.userData.vsNoPatch = true;
  patched.add(material);
}
