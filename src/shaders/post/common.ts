/**
 * GLSL fragments shared by every pass in the post stack.
 *
 * Everything here targets GLSL ES 1.00 (three's default for `ShaderMaterial`)
 * so the stack compiles identically on WebGL2 desktop drivers and on the
 * SwiftShader path the review harness runs under. That rules out array
 * initialisers, `texture()` and dynamic loop bounds — every kernel below is
 * either unrolled or driven by arithmetic.
 */

/**
 * Full-screen triangle. Using a single oversized triangle instead of a quad
 * avoids the diagonal seam where two triangles meet, which shows up as a
 * one-pixel discontinuity in derivative-based effects.
 */
export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Colour space, depth reconstruction and noise helpers. */
export const POST_COMMON = /* glsl */ `
#define saturate(a) clamp(a, 0.0, 1.0)
const float PI = 3.14159265359;
const float HALF_PI = 1.57079632679;

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgbToYCoCg(vec3 c) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r            - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

vec3 yCoCgToRgb(vec3 c) {
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

/** three's convention — returns a negative view-space Z. */
float perspectiveDepthToViewZ(float depth, float near, float far) {
  return (near * far) / ((far - near) * depth - far);
}

vec3 viewPositionFromDepth(vec2 uv, float depth, mat4 projInverse) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = projInverse * clip;
  return view.xyz / view.w;
}

/**
 * Reprojects a pixel into the previous frame using the depth buffer. Exact for
 * static geometry under arbitrary camera motion; moving objects add a delta on
 * top of this from the velocity buffer.
 */
vec2 reprojectStatic(vec2 uv, float depth, mat4 currInvViewProj, mat4 prevViewProj) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = currInvViewProj * clip;
  world /= world.w;
  vec4 prevClip = prevViewProj * world;
  return (prevClip.xy / prevClip.w) * 0.5 + 0.5;
}

/** Jimenez's interleaved gradient noise — the right dither for screen-space sampling. */
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Reconstructs a view-space normal from depth, picking the closer of each
 *  neighbour pair so silhouettes stay sharp instead of smearing across the
 *  depth discontinuity. */
vec3 reconstructViewNormal(sampler2D depthTex, vec2 uv, vec3 P, vec2 texel, mat4 projInverse) {
  vec2 ux = vec2(texel.x, 0.0);
  vec2 uy = vec2(0.0, texel.y);
  vec3 l = viewPositionFromDepth(uv - ux, texture2D(depthTex, uv - ux).r, projInverse);
  vec3 r = viewPositionFromDepth(uv + ux, texture2D(depthTex, uv + ux).r, projInverse);
  vec3 d = viewPositionFromDepth(uv - uy, texture2D(depthTex, uv - uy).r, projInverse);
  vec3 u = viewPositionFromDepth(uv + uy, texture2D(depthTex, uv + uy).r, projInverse);
  vec3 dx = abs(l.z - P.z) < abs(r.z - P.z) ? (P - l) : (r - P);
  vec3 dy = abs(d.z - P.z) < abs(u.z - P.z) ? (P - d) : (u - P);
  vec3 n = cross(dx, dy);
  float len = length(n);
  return len > 1e-8 ? n / len : vec3(0.0, 0.0, 1.0);
}
`;

/**
 * AgX display transform, matching three's `AgXToneMapping` primaries and
 * sigmoid so the stack stays consistent with anything the engine renders
 * outside it, plus an exposed "look" stage (slope / power / saturation applied
 * in the log domain) which is where AgX's characteristic filmic punch comes
 * from. Neutral AgX on its own is deliberately flat.
 */
export const AGX_TONEMAP = /* glsl */ `
const mat3 AGX_INSET = mat3(
  0.856627153315983,   0.137318972929847,   0.11189821299995,
  0.0951212405381588,  0.761241990602591,   0.0767994186031903,
  0.0482516061458583,  0.101439036467562,   0.811302368396859);
const mat3 AGX_OUTSET = mat3(
   1.1271005818144368,  -0.1413297634984383,  -0.14132976349843826,
  -0.11060664309660323,  1.157823702216272,   -0.11060664309660294,
  -0.016493938717834573,-0.016493938717834257, 1.2519364065950405);
const mat3 SRGB_TO_REC2020 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0113, 0.8956);
const mat3 REC2020_TO_SRGB = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187);

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agxLook(vec3 c, float sat, float slope, float power) {
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = pow(max(vec3(0.0), c * slope), vec3(power));
  return max(vec3(0.0), luma + sat * (c - luma));
}

vec3 tonemapAgX(vec3 color, float sat, float slope, float power) {
  const float AGX_MIN_EV = -12.47393;
  const float AGX_MAX_EV = 4.026069;
  color = SRGB_TO_REC2020 * max(color, vec3(0.0));
  color = AGX_INSET * color;
  color = max(color, vec3(1e-10));
  color = log2(color);
  color = (color - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = agxLook(color, sat, slope, power);
  color = AGX_OUTSET * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

/**
 * Trilinear fetch from a colour-grading LUT stored as a horizontal strip of
 * `size` tiles (blue slices). A strip beats `sampler3D` here because sampler3D
 * does not exist in GLSL ES 1.00; the manual blue interpolation costs one extra
 * fetch and is exact.
 */
export const LUT_SAMPLER = /* glsl */ `
uniform sampler2D tLut;
uniform vec2 uLutParams; // x = tile size, y = 1 / (size * size)

vec3 applyLut(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float size = uLutParams.x;
  float sizeMinusOne = size - 1.0;
  float slice = c.b * sizeMinusOne;
  float s0 = floor(slice);
  float s1 = min(s0 + 1.0, sizeMinusOne);
  float f = slice - s0;
  // Keep the red coordinate at least half a texel inside its tile so bilinear
  // filtering never bleeds across a slice boundary.
  float xInTile = (c.r * sizeMinusOne + 0.5) * uLutParams.y;
  float y = c.g * (sizeMinusOne / size) + 0.5 / size;
  float tile = size * uLutParams.y;
  vec3 a = texture2D(tLut, vec2(s0 * tile + xInTile, y)).rgb;
  vec3 b = texture2D(tLut, vec2(s1 * tile + xInTile, y)).rgb;
  return mix(a, b, f);
}
`;

/**
 * Five-tap Catmull-Rom reconstruction. Resampling the TAA history with plain
 * bilinear filtering loses roughly one pixel of sharpness per frame, which is
 * what makes naive TAA look soft; this is the standard fix.
 */
export const CATMULL_ROM = /* glsl */ `
vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;

  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;

  vec3 result = vec3(0.0);
  float wsum = 0.0;
  float w;

  w = w12.x * w0.y;  result += texture2D(tex, vec2(texPos12.x, texPos0.y)).rgb * w;  wsum += w;
  w = w0.x * w12.y;  result += texture2D(tex, vec2(texPos0.x, texPos12.y)).rgb * w;  wsum += w;
  w = w12.x * w12.y; result += texture2D(tex, vec2(texPos12.x, texPos12.y)).rgb * w; wsum += w;
  w = w3.x * w12.y;  result += texture2D(tex, vec2(texPos3.x, texPos12.y)).rgb * w;  wsum += w;
  w = w12.x * w3.y;  result += texture2D(tex, vec2(texPos12.x, texPos3.y)).rgb * w;  wsum += w;

  return max(vec3(0.0), result / wsum);
}
`;
