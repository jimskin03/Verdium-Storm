import { CATMULL_ROM, POST_COMMON } from './common';

/**
 * Temporal resolve: applies ambient occlusion and screen-space reflections to
 * the freshly rendered HDR frame, then blends it against reprojected history.
 *
 * Why AO and SSR live inside this pass rather than in their own: both are noisy
 * by construction (2 rotating GTAO slices, one jittered SSR ray), and folding
 * them in here means the temporal filter integrates that noise away for free
 * instead of a separate full-resolution modulate pass paying for the privilege.
 * The neighbourhood is built from the *modulated* samples so the clip box stays
 * consistent with what history actually holds.
 *
 * The temporal filter itself is the standard modern arrangement:
 *   - history fetched with a 5-tap Catmull-Rom so repeated resampling does not
 *     bleed sharpness away frame over frame,
 *   - variance clipping in YCoCg (mean +/- gamma * sigma, intersected with the
 *     hard min/max box) rather than a plain AABB clamp, which is what keeps
 *     moving silhouettes from ghosting,
 *   - Karis luminance weighting on the final blend so a firefly cannot survive
 *     into history,
 *   - a feedback weight that starts as a true running average (n/(n+1)) after a
 *     camera cut and only then settles to its steady-state ceiling. That is
 *     what turns a still camera into free supersampling: 26 held frames become
 *     an unweighted 26-sample average of the jitter sequence.
 */
export const RESOLVE_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}
${CATMULL_ROM}

uniform sampler2D tCurrent;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform vec2 uTexel;

#ifdef USE_TAA
uniform sampler2D tHistory;
uniform mat4 uCurrInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uHistoryRamp;      // n/(n+1) since the last history reset
uniform float uFeedbackStill;
uniform float uFeedbackMoving;
uniform float uClipGamma;
#endif

#ifdef USE_OBJECT_VELOCITY
uniform sampler2D tVelocity;
#endif

#ifdef USE_AO
uniform sampler2D tAo;
uniform float uAoStrength;
#endif

#ifdef USE_SSR
uniform sampler2D tSsr;
uniform vec2 uSsrTexel;
uniform float uSsrIntensity;
#endif

varying vec2 vUv;

#ifdef USE_AO
/**
 * Jimenez's GTAO multi-bounce fit. Straight multiplicative AO drains colour out
 * of shadowed areas and reads as grey dirt; this pushes the occluded value back
 * toward the surface's own albedo so creases stay chromatic. The lit colour is
 * used as an albedo stand-in, which is close enough at these AO strengths.
 */
vec3 aoMultiBounce(float ao, vec3 albedo) {
  vec3 a =  2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c =  2.7552 * albedo + 0.6903;
  return clamp(((ao * a + b) * ao + c) * ao, vec3(ao), vec3(1.0));
}
#endif

void main() {
  vec2 uv = vUv;

  vec3 centre = texture2D(tCurrent, uv).rgb;

  vec3 aoMul = vec3(1.0);
  #ifdef USE_AO
    float ao = texture2D(tAo, uv).r;
    ao = mix(1.0, ao, uAoStrength);
    aoMul = aoMultiBounce(ao, saturate(centre));
  #endif

  vec3 ssrAdd = vec3(0.0);
  #ifdef USE_SSR
    // Four-tap box over the quarter-resolution buffer: cheap, and enough to
    // hide the ray stepping without a dedicated blur pass.
    vec2 so = uSsrTexel * 0.75;
    vec4 s0 = texture2D(tSsr, uv + vec2( so.x,  so.y));
    vec4 s1 = texture2D(tSsr, uv + vec2(-so.x,  so.y));
    vec4 s2 = texture2D(tSsr, uv + vec2( so.x, -so.y));
    vec4 s3 = texture2D(tSsr, uv + vec2(-so.x, -so.y));
    vec4 ssr = (s0 + s1 + s2 + s3) * 0.25;
    ssrAdd = ssr.rgb * ssr.a * uSsrIntensity;
  #endif

  vec3 current = centre * aoMul + ssrAdd;

#ifndef USE_TAA
  gl_FragColor = vec4(current, 1.0);
#else
  // --- 3x3 neighbourhood, modulated to match what history holds -------------
  vec3 n0 = texture2D(tCurrent, uv + vec2(-uTexel.x, -uTexel.y)).rgb * aoMul + ssrAdd;
  vec3 n1 = texture2D(tCurrent, uv + vec2(      0.0, -uTexel.y)).rgb * aoMul + ssrAdd;
  vec3 n2 = texture2D(tCurrent, uv + vec2( uTexel.x, -uTexel.y)).rgb * aoMul + ssrAdd;
  vec3 n3 = texture2D(tCurrent, uv + vec2(-uTexel.x,       0.0)).rgb * aoMul + ssrAdd;
  vec3 n4 = current;
  vec3 n5 = texture2D(tCurrent, uv + vec2( uTexel.x,       0.0)).rgb * aoMul + ssrAdd;
  vec3 n6 = texture2D(tCurrent, uv + vec2(-uTexel.x,  uTexel.y)).rgb * aoMul + ssrAdd;
  vec3 n7 = texture2D(tCurrent, uv + vec2(      0.0,  uTexel.y)).rgb * aoMul + ssrAdd;
  vec3 n8 = texture2D(tCurrent, uv + vec2( uTexel.x,  uTexel.y)).rgb * aoMul + ssrAdd;

  vec3 y0 = rgbToYCoCg(n0), y1 = rgbToYCoCg(n1), y2 = rgbToYCoCg(n2);
  vec3 y3 = rgbToYCoCg(n3), y4 = rgbToYCoCg(n4), y5 = rgbToYCoCg(n5);
  vec3 y6 = rgbToYCoCg(n6), y7 = rgbToYCoCg(n7), y8 = rgbToYCoCg(n8);

  vec3 m1 = y0 + y1 + y2 + y3 + y4 + y5 + y6 + y7 + y8;
  vec3 m2 = y0 * y0 + y1 * y1 + y2 * y2 + y3 * y3 + y4 * y4
          + y5 * y5 + y6 * y6 + y7 * y7 + y8 * y8;

  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mean * mean));

  vec3 boxMin = min(y0, min(y1, min(y2, min(y3, min(y4, min(y5, min(y6, min(y7, y8))))))));
  vec3 boxMax = max(y0, max(y1, max(y2, max(y3, max(y4, max(y5, max(y6, max(y7, y8))))))));

  vec3 clipMin = max(mean - uClipGamma * sigma, boxMin);
  vec3 clipMax = min(mean + uClipGamma * sigma, boxMax);

  // --- reprojection --------------------------------------------------------
  float depth = texture2D(tDepth, uv).r;
  vec2 prevUv = reprojectStatic(uv, depth, uCurrInvViewProj, uPrevViewProj);
  #ifdef USE_OBJECT_VELOCITY
    prevUv += texture2D(tVelocity, uv).xy;
  #endif

  vec2 motion = uv - prevUv;
  float motionPx = length(motion * uResolution);

  float offScreen = (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) ? 0.0 : 1.0;

  vec3 history = sampleCatmullRom(tHistory, prevUv, uResolution);
  vec3 historyY = rgbToYCoCg(history);

  // Clip toward the current colour rather than clamping per-channel: clamping
  // desaturates whatever it touches, clipping preserves hue.
  vec3 curY = y4;
  vec3 centreClip = 0.5 * (clipMax + clipMin);
  vec3 extentClip = 0.5 * (clipMax - clipMin) + 1e-5;
  vec3 delta = historyY - centreClip;
  vec3 unitDelta = delta / extentClip;
  float maxUnit = max(abs(unitDelta.x), max(abs(unitDelta.y), abs(unitDelta.z)));
  if (maxUnit > 1.0) historyY = centreClip + delta / maxUnit;

  // Faster camera motion means the reprojection is less trustworthy and
  // disocclusion is more likely, so lean on the current frame.
  float feedback = mix(uFeedbackStill, uFeedbackMoving, saturate(motionPx / 20.0));
  feedback = min(feedback, uHistoryRamp) * offScreen;

  // Karis weighting in tone-mapped space: bright outliers get proportionally
  // less say in the average, which is what removes temporal fireflies.
  float wCur  = (1.0 - feedback) / (1.0 + max(0.0, curY.x));
  float wHist =        feedback  / (1.0 + max(0.0, historyY.x));

  vec3 resolvedY = (curY * wCur + historyY * wHist) / max(wCur + wHist, 1e-5);
  vec3 resolved = max(vec3(0.0), yCoCgToRgb(resolvedY));

  gl_FragColor = vec4(resolved, 1.0);
#endif
}
`;
