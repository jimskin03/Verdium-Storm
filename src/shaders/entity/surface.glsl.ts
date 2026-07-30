/**
 * Shader injections for the single material every unit and structure shares.
 *
 * Per-vertex attributes carry what would normally be per-material state:
 *
 *   color   vec3   albedo tint, sRGB encoded in 8 bits
 *   aSurf   vec4   x roughness, y metalness, z emissive/8, w team-colour blend
 *   aMisc   vec3   x plate→composite blend, y uvScale/2, z baked cavity AO
 *   aUv     vec2   box-projected UV in world units (scaled per-vertex)
 *
 * That collapses painted armour, bare steel, rubber, glass, concrete and
 * emissive team panels into one program and one draw call per entity.
 */

export const ENTITY_VERT_PARS = /* glsl */ `
attribute vec2 aUv;
attribute vec4 aSurf;
attribute vec3 aMisc;
varying vec2 vEntUv;
varying vec4 vSurf;
varying vec3 vMisc;
uniform vec3 uTeamColor;
`;

/** Replaces `<color_vertex>`; folds the team tint in before rasterisation. */
export const ENTITY_COLOR_VERT = /* glsl */ `
vec3 entTint = pow(color.rgb, vec3(2.2));
vColor = mix(entTint, uTeamColor, aSurf.w);
vSurf = aSurf;
vMisc = aMisc;
vEntUv = aUv * (aMisc.y * 2.0);
`;

export const ENTITY_FRAG_PARS = /* glsl */ `
uniform sampler2D tAlbA;
uniform sampler2D tNrmA;
uniform sampler2D tOrmA;
uniform sampler2D tAlbB;
uniform sampler2D tNrmB;
uniform sampler2D tOrmB;
uniform float uWear;
uniform float uNormalScale;
uniform float uEmissive;
varying vec2 vEntUv;
varying vec4 vSurf;
varying vec3 vMisc;

vec3 gAlb;
vec3 gNrm;
vec3 gOrm;
float gScorch;

mat3 entTangentFrame(vec3 eyePos, vec3 surfNorm, vec2 uv) {
  vec3 q0 = dFdx(eyePos.xyz);
  vec3 q1 = dFdy(eyePos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 N = surfNorm;
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}
`;

/** Replaces `<map_fragment>` — samples and blends both synthesised layers. */
export const ENTITY_MAP_FRAG = /* glsl */ `
float entBlend = clamp(vMisc.x + (1.0 - vMisc.z) * 0.30, 0.0, 1.0);
vec2 entUvA = vEntUv;
vec2 entUvB = vEntUv * 0.617 + vec2(0.31, 0.17);
vec4 entA = texture2D(tAlbA, entUvA);
vec4 entB = texture2D(tAlbB, entUvB);
gAlb = mix(entA.rgb, entB.rgb, entBlend);
gNrm = mix(texture2D(tNrmA, entUvA).xyz, texture2D(tNrmB, entUvB).xyz, entBlend);
gOrm = mix(texture2D(tOrmA, entUvA).xyz, texture2D(tOrmB, entUvB).xyz, entBlend);
gScorch = clamp(uWear * entB.a * 1.7 - uWear * 0.25, 0.0, 1.0);
diffuseColor.rgb *= gAlb;
`;

/** Replaces `<color_fragment>` — tint, then battle damage burn-through. */
export const ENTITY_COLOR_FRAG = /* glsl */ `
diffuseColor.rgb *= vColor;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.016, 0.013, 0.011), gScorch);
`;

export const ENTITY_ROUGH_FRAG = /* glsl */ `
float roughnessFactor = clamp(vSurf.x + (gOrm.g - 0.5) * 0.55, 0.035, 1.0);
roughnessFactor = mix(roughnessFactor, 0.94, gScorch);
`;

export const ENTITY_METAL_FRAG = /* glsl */ `
float metalnessFactor = clamp(vSurf.y + (gOrm.b - 0.5) * 0.55, 0.0, 1.0);
metalnessFactor *= 1.0 - gScorch * 0.9;
`;

export const ENTITY_NORMAL_FRAG = /* glsl */ `
vec3 entMapN = gNrm * 2.0 - 1.0;
entMapN.xy *= uNormalScale;
normal = normalize(entTangentFrame(-vViewPosition, normal, vEntUv) * entMapN);
`;

export const ENTITY_AO_FRAG = /* glsl */ `
float entAO = clamp(mix(1.0, gOrm.r, 0.75) * mix(1.0, vMisc.z, 0.9), 0.0, 1.0);
reflectedLight.indirectDiffuse *= entAO;
reflectedLight.indirectSpecular *= mix(1.0, entAO, 0.65);
`;

export const ENTITY_EMISSIVE_FRAG = /* glsl */ `
totalEmissiveRadiance = vColor * (vSurf.z * 8.0) * uEmissive * (1.0 - gScorch * 0.85);
`;
