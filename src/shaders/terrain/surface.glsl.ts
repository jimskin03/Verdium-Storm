/**
 * Shader injections for the terrain's MeshStandardMaterial.
 *
 * The vertex half turns an instanced unit grid into a CDLOD quadtree node:
 * it looks the height up from the baked field, morphs the node's odd vertices
 * onto its parent's grid as the node approaches its LOD range, and hands three
 * a real surface normal so shadow biasing behaves.
 *
 * The fragment half does the splat: layer weights from slope / altitude /
 * curvature / a world-space macro mask, height-map blending between the two
 * dominant ground layers, triplanar rock (with parallax occlusion on the near
 * LODs), then wetness, dust and snow as post-blend modifiers.
 */

export const TERRAIN_VERTEX_PARS = /* glsl */ `
attribute vec3 aNode;    // (originX, originZ, size) of the quadtree node
attribute vec2 aMorph;   // (morphStart, morphEnd) distances for CDLOD
attribute float aSkirt;  // 1 on the downward skirt ring, 0 on the surface

uniform highp sampler2DArray uTerrainHeight;
uniform highp sampler2DArray uTerrainNormal;
uniform vec4 uFieldMap;  // (nearScale, nearOffset, farScale, farOffset)
uniform float uNearLimit;
uniform vec3 uTerrainCam;
uniform float uGridRes;
uniform float uSkirtDepth;

varying vec3 vTWorld;
varying float vTCurv;
varying float vTLayer;
varying float vTNodeSize;

vec3 vsTransformedPos;

vec2 vsFieldUv(vec2 wxz, float layer) {
  return layer < 0.5 ? wxz * uFieldMap.x + uFieldMap.y : wxz * uFieldMap.z + uFieldMap.w;
}

float vsFieldLayer(vec2 wxz) {
  return max(abs(wxz.x), abs(wxz.y)) < uNearLimit ? 0.0 : 1.0;
}

/** Height (R) and curvature (G) of the baked terrain field at a world point. */
vec2 vsFieldSample(vec2 wxz, out float layer) {
  layer = vsFieldLayer(wxz);
  return textureLod(uTerrainHeight, vec3(vsFieldUv(wxz, layer), layer), 0.0).rg;
}
`;

/** Replaces `<beginnormal_vertex>`; does the whole position solve. */
export const TERRAIN_VERTEX_MAIN = /* glsl */ `
vec2 vsGrid = position.xz;
vec2 vsWorld0 = aNode.xy + vsGrid * aNode.z;
float vsLayer0;
float vsH0 = vsFieldSample(vsWorld0, vsLayer0).r;

// CDLOD: collapse this node's odd vertices onto the parent grid as the vertex
// approaches the node's LOD range, so the join with the next coarser ring is
// watertight and nothing pops when the selection changes.
float vsDist = distance(uTerrainCam, vec3(vsWorld0.x, vsH0, vsWorld0.y));
float vsMorph = clamp((vsDist - aMorph.x) / max(aMorph.y - aMorph.x, 1.0), 0.0, 1.0);
float vsHalfRes = uGridRes * 0.5;
vec2 vsGridM = vsGrid - fract(vsGrid * vsHalfRes) / vsHalfRes * vsMorph;

vec2 vsWorld = aNode.xy + vsGridM * aNode.z;
float vsLayer;
vec2 vsField = vsFieldSample(vsWorld, vsLayer);
float vsHeight = vsField.r - aSkirt * (uSkirtDepth * aNode.z / uGridRes);

vsTransformedPos = vec3(vsWorld.x, vsHeight, vsWorld.y);
vTWorld = vec3(vsWorld.x, vsField.r, vsWorld.y);
vTCurv = vsField.g;
vTLayer = vsLayer;
vTNodeSize = aNode.z;

vec3 objectNormal = normalize(
  textureLod(uTerrainNormal, vec3(vsFieldUv(vsWorld, vsLayer), vsLayer), 0.0).xyz * 2.0 - 1.0);
`;

export const TERRAIN_FRAGMENT_PARS = /* glsl */ `
uniform highp sampler2DArray uTerrainNormal;
uniform sampler2DArray uLayerAlbedo;
uniform sampler2DArray uLayerSurface;
uniform sampler2D uMacro;
uniform vec4 uFieldMap;
uniform float uNearLimit;
uniform float uMacroScale;
uniform vec3 uLayerScale;   // (ground tile, detile tile, rock tile) in world units
uniform vec2 uDetailNormal; // (ground strength, rock strength)
uniform float uWaterLevel;
uniform vec3 uTerrainCam;
uniform float uSnowLine;
uniform float uPomScale;

varying vec3 vTWorld;
varying float vTCurv;
varying float vTLayer;
varying float vTNodeSize;

vec3 vsSplatAlbedo;
vec3 vsSplatNormal;
float vsSplatRough;
float vsSplatAO;

vec2 vsRot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

/**
 * Height-map blend factor. Rather than cross-fading two layers into mush this
 * compares their displacement values, so gravel pokes up through grass along
 * the grain of the stones instead of behind a soft gradient.
 */
float vsHeightBlend(float ha, float wa, float hb, float wb, float depth) {
  float a = wa + ha * 0.55;
  float b = wb + hb * 0.55;
  float m = max(a, b) - depth;
  float x = max(a - m, 0.0);
  float y = max(b - m, 0.0);
  return y / max(x + y, 1e-4);
}
`;

/** Replaces `<map_fragment>`; produces albedo / normal / roughness / AO. */
export const TERRAIN_FRAGMENT_MAIN = /* glsl */ `
vec3 vsW = vTWorld;
vec2 vsFieldUvF = vTLayer < 0.5 ? vsW.xz * uFieldMap.x + uFieldMap.y
                                : vsW.xz * uFieldMap.z + uFieldMap.w;
vec4 vsFieldN = texture(uTerrainNormal, vec3(vsFieldUvF, vTLayer));
vec3 vsN = normalize(vsFieldN.xyz * 2.0 - 1.0);
float vsCavity = vsFieldN.w;

float vsSlope = clamp(1.0 - vsN.y, 0.0, 1.0);
float vsAlt = vsW.y - uWaterLevel;
float vsCurv = vTCurv;
float vsViewDist = distance(uTerrainCam, vsW);

vec4 vsMacro = texture(uMacro, vsW.xz * uMacroScale + 0.5);

// --- surface derivatives, shared by every projection so mip selection stays
// --- correct even where the triplanar axis choice flips.
vec3 vsDpx = dFdx(vsW);
vec3 vsDpy = dFdy(vsW);

float vsInv0 = 1.0 / uLayerScale.x;
float vsInv1 = 1.0 / uLayerScale.y;
float vsInvR = 1.0 / uLayerScale.z;

vec2 vsUv0 = vsW.xz * vsInv0;
vec2 vsG0x = vsDpx.xz * vsInv0;
vec2 vsG0y = vsDpy.xz * vsInv0;

// --------------------------------------------------------------- layer rules
// Altitude gates are tuned to the heightfield's measured distribution: 53% of
// the playable map sits between y=0 and y=40, 96% is below y=100, and only
// 0.5% clears y=130. The previous 52..132 window therefore never reached 1.0
// anywhere, leaving the highland gravel and rock contributions permanently off.
float vsHighland = smoothstep(34.0, 88.0, vsAlt);
float vsShore = smoothstep(11.0, 1.0, vsAlt);
float vsLow = smoothstep(6.5, -2.0, vsAlt);
float vsConcave = smoothstep(0.10, -0.55, vsCurv);
float vsConvex = smoothstep(-0.05, 0.55, vsCurv);

// Dry and lush are deliberately symmetric about the biome mask so it actually
// selects between them at its midpoint. They were not: dry carried a 0.62 floor
// plus a (1 - biome) boost against lush's 0.16 floor, so lush needed biome
// > 0.69 to win anywhere. Since biome is a saturating smoothstep over fbm, that
// almost never happened and the whole map rendered as one dry-grass tan.
float vsWDry = 0.30 + 1.30 * (1.0 - vsMacro.r) + 0.34 * vsHighland;
float vsWLush = 0.30 + 1.30 * vsMacro.r * (1.0 - vsHighland * 0.75) + 0.45 * vsConcave;
float vsWDirt = 0.20 + 1.10 * smoothstep(0.40, 0.86, vsMacro.g) + 0.95 * smoothstep(0.09, 0.33, vsSlope);
float vsWMud = 0.02 + 1.30 * vsLow * vsConcave + 0.55 * vsLow;
float vsWGrav = 0.06 + 1.15 * vsShore * (1.0 - vsConcave * 0.6)
              + 0.75 * smoothstep(0.58, 0.94, vsMacro.g)
              + 0.85 * vsHighland * smoothstep(0.14, 0.40, vsSlope)
              + 0.55 * vsConvex * smoothstep(0.12, 0.34, vsSlope);
float vsWScorch = 2.10 * smoothstep(0.66, 0.93, vsMacro.b);

float vsWs[6];
vsWs[0] = vsWDry;
vsWs[1] = vsWLush;
vsWs[2] = vsWDirt;
vsWs[3] = vsWMud;
vsWs[4] = vsWGrav;
vsWs[5] = vsWScorch;

int vsIdA = 0;
float vsBestA = -1.0;
for (int i = 0; i < 6; i++) {
  if (vsWs[i] > vsBestA) { vsBestA = vsWs[i]; vsIdA = i; }
}
int vsIdB = 0;
float vsBestB = -1.0;
for (int i = 0; i < 6; i++) {
  if (i != vsIdA && vsWs[i] > vsBestB) { vsBestB = vsWs[i]; vsIdB = i; }
}
// Layer 5 in the array is rock; the six ground rules map onto 0-4 and 6.
int vsMapA = vsIdA < 5 ? vsIdA : 6;
int vsMapB = vsIdB < 5 ? vsIdB : 6;

float vsSum = max(vsBestA + vsBestB, 1e-4);
float vsWa = vsBestA / vsSum;
float vsWb = vsBestB / vsSum;

// ----------------------------------------------------------- ground sampling
vec4 vsAlbA = textureGrad(uLayerAlbedo, vec3(vsUv0, float(vsMapA)), vsG0x, vsG0y);
vec4 vsSrfA = textureGrad(uLayerSurface, vec3(vsUv0, float(vsMapA)), vsG0x, vsG0y);

#ifdef VS_DETILE
{
  // A second sample at an incommensurate scale and rotation. The repeat period
  // of the pair is effectively unbounded, which is what kills the visible grid.
  vec2 uv1 = vsRot2(vsW.xz, 2.399) * vsInv1 + vec2(0.37, 0.19);
  vec2 g1x = vsRot2(vsDpx.xz, 2.399) * vsInv1;
  vec2 g1y = vsRot2(vsDpy.xz, 2.399) * vsInv1;
  float m = smoothstep(0.30, 0.70, vsMacro.a);
  vsAlbA = mix(vsAlbA, textureGrad(uLayerAlbedo, vec3(uv1, float(vsMapA)), g1x, g1y), m);
  vsSrfA = mix(vsSrfA, textureGrad(uLayerSurface, vec3(uv1, float(vsMapA)), g1x, g1y), m);
}
#endif

vec4 vsAlbG = vsAlbA;
vec4 vsSrfG = vsSrfA;
if (vsWb > 0.008) {
  vec4 albB = textureGrad(uLayerAlbedo, vec3(vsUv0, float(vsMapB)), vsG0x, vsG0y);
  vec4 srfB = textureGrad(uLayerSurface, vec3(vsUv0, float(vsMapB)), vsG0x, vsG0y);
  float t = vsHeightBlend(vsAlbA.a, vsWa, albB.a, vsWb, 0.14);
  vsAlbG = mix(vsAlbA, albB, t);
  vsSrfG = mix(vsSrfA, srfB, t);
}

// ------------------------------------------------------------- cliff / rock
float vsRock = smoothstep(0.26, 0.56, vsSlope + vsConvex * 0.10 - vsMacro.a * 0.05);
vsRock = max(vsRock, smoothstep(0.44, 0.70, vsSlope));

vec4 vsAlbR = vsAlbG;
vec4 vsSrfR = vsSrfG;

if (vsRock > 0.004) {
  vec3 an = abs(vsN);
  float wy = pow(an.y, 3.0);
  float wx = pow(an.x, 3.0);
  float wz = pow(an.z, 3.0);
  float wn = 1.0 / max(wx + wy + wz, 1e-4);
  wy *= wn;
  float lateral = 1.0 - wy;
  bool useX = an.x >= an.z;

  vec2 uvY = vsW.xz * vsInvR;
  vec2 gYx = vsDpx.xz * vsInvR;
  vec2 gYy = vsDpy.xz * vsInvR;

  vec2 uvL = (useX ? vec2(vsW.z, vsW.y) : vec2(vsW.x, vsW.y)) * vsInvR;
  vec2 gLx = (useX ? vec2(vsDpx.z, vsDpx.y) : vec2(vsDpx.x, vsDpx.y)) * vsInvR;
  vec2 gLy = (useX ? vec2(vsDpy.z, vsDpy.y) : vec2(vsDpy.x, vsDpy.y)) * vsInvR;

#ifdef VS_POM
  // Parallax occlusion on the dominant lateral face only, faded out with
  // distance — it is the difference between "painted rock" and "carved rock"
  // at the closest camera zoom and worthless past a few dozen metres.
  float pomFade = smoothstep(110.0, 45.0, vsViewDist) * smoothstep(0.35, 0.7, lateral);
  if (pomFade > 0.02) {
    vec3 viewW = normalize(uTerrainCam - vsW);
    vec3 T = normalize(vec3(1.0, 0.0, 0.0) - vsN * vsN.x);
    if (abs(vsN.x) > 0.94) T = normalize(vec3(0.0, 0.0, 1.0) - vsN * vsN.z);
    vec3 B = cross(T, vsN);
    vec3 vTS = vec3(dot(viewW, T), dot(viewW, B), max(dot(viewW, vsN), 0.15));
    vec2 step2 = (vTS.xy / vTS.z) * uPomScale * pomFade * vsInvR * 0.0625;
    float lay = 0.0;
    vec2 cur = uvL;
    float hs = textureGrad(uLayerAlbedo, vec3(cur, 5.0), gLx, gLy).a;
    for (int i = 0; i < 12; i++) {
      if (lay >= 1.0 - hs) break;
      cur -= step2;
      lay += 0.0833;
      hs = textureGrad(uLayerAlbedo, vec3(cur, 5.0), gLx, gLy).a;
    }
    uvL = cur;
  }
#endif

  vec4 aY = textureGrad(uLayerAlbedo, vec3(uvY, 5.0), gYx, gYy);
  vec4 sY = textureGrad(uLayerSurface, vec3(uvY, 5.0), gYx, gYy);
  vec4 aL = textureGrad(uLayerAlbedo, vec3(uvL, 5.0), gLx, gLy);
  vec4 sL = textureGrad(uLayerSurface, vec3(uvL, 5.0), gLx, gLy);

  vsAlbR = mix(aL, aY, wy);
  vsSrfR = mix(sL, sY, wy);
}

float vsRockT = vsRock > 0.004
  ? vsHeightBlend(vsAlbG.a, 1.0 - vsRock, vsAlbR.a, vsRock, 0.16)
  : 0.0;
vec4 vsAlb = mix(vsAlbG, vsAlbR, vsRockT);
vec4 vsSrf = mix(vsSrfG, vsSrfR, vsRockT);

// ------------------------------------------------------------ detail normal
vec3 vsDetail = vec3(vsSrf.xy * 2.0 - 1.0, 1.0);
float vsDetailAmp = mix(uDetailNormal.x, uDetailNormal.y, vsRockT);
vsDetailAmp *= smoothstep(900.0, 240.0, vsViewDist) * 0.65 + 0.35;
vsDetail.xy *= vsDetailAmp;

vec3 vsT = normalize(vec3(1.0, 0.0, 0.0) - vsN * vsN.x);
if (abs(vsN.x) > 0.94) vsT = normalize(vec3(0.0, 0.0, 1.0) - vsN * vsN.z);
vec3 vsB = cross(vsT, vsN);
vsSplatNormal = normalize(vsT * vsDetail.x + vsB * vsDetail.y + vsN * vsDetail.z);

// --------------------------------------------------------- macro + response
vec3 vsCol = vsAlb.rgb;

// Large scale colour drift so the ground never reads as one tiled swatch.
vec3 warmTint = vec3(1.09, 1.015, 0.870);
vec3 coolTint = vec3(0.885, 0.955, 1.055);
vsCol *= mix(coolTint, warmTint, vsMacro.a);
vsCol *= 0.80 + 0.40 * vsMacro.a;
vsCol *= 0.92 + 0.16 * vsMacro.r;

float vsRough = clamp(vsSrf.z, 0.05, 1.0);

// Wetness: low ground darkens and smooths towards the water line, strongest in
// hollows where run-off would actually collect.
float vsWet = clamp(smoothstep(5.0, -3.0, vsAlt) * (0.45 + 0.55 * vsConcave) * (1.0 - vsSlope * 0.7), 0.0, 1.0);
vsCol *= mix(1.0, 0.48, vsWet);
vsRough = mix(vsRough, 0.24, vsWet * 0.85);

// Wind-blown dust on flat high ground, snow on the peaks. Both are broken up by
// the macro mask so the transition is never a clean contour line.
float vsDust = smoothstep(0.20, 0.02, vsSlope) * smoothstep(0.35, 0.75, vsMacro.a) * (1.0 - vsHighland) * 0.22;
vsCol = mix(vsCol, vsCol * 0.85 + vec3(0.235, 0.208, 0.161), vsDust);

float vsSnow = smoothstep(uSnowLine, uSnowLine + 130.0, vsW.y)
             * smoothstep(0.42, 0.16, vsSlope)
             * smoothstep(0.28, 0.62, vsMacro.a * 0.6 + vsAlb.a * 0.4);
vsCol = mix(vsCol, vec3(0.80, 0.827, 0.867), vsSnow * 0.92);
vsRough = mix(vsRough, 0.42, vsSnow * 0.9);

vsSplatAlbedo = vsCol;
vsSplatRough = vsRough;
vsSplatAO = clamp(vsSrf.w * mix(1.0, vsCavity, 0.85), 0.0, 1.0);

diffuseColor.rgb *= vsSplatAlbedo;

// Hand the splat's albedo to the atmosphere's debug tap (uVsDebug.x == 7). The
// guard matters: vsDbgAlbedo is declared by the aerial-perspective prelude, so
// without it an unpatched terrain material would fail to compile.
#ifdef VS_AERIAL
  vsDbgAlbedo = diffuseColor.rgb;
#endif
`;
