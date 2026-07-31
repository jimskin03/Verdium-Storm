import { AGX_TONEMAP, LUT_SAMPLER, POST_COMMON } from './common';

/**
 * The uber-composite. Everything from the resolved HDR buffer to the pixel that
 * reaches the display happens here, in one full-resolution pass:
 *
 *   motion blur -> contrast-adaptive sharpen -> depth of field -> chromatic
 *   aberration -> bloom -> vignette -> exposure -> AgX -> sRGB -> 3D LUT grade
 *   -> film grain -> ordered dither
 *
 * Merging them is not just a saving. Several of these are order-sensitive and
 * only make physical sense on one side of the display transform: lens effects
 * (aberration, vignette, defocus) belong in scene-referred light *before* tone
 * mapping so highlights roll off through them, while grain and the grade belong
 * in display-referred space after it. Splitting the chain into separate passes
 * would mean round-tripping the tone curve repeatedly.
 */
export const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}
${AGX_TONEMAP}
${LUT_SAMPLER}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;

uniform float uExposure;
uniform vec3 uAgx;              // x = saturation, y = slope, z = power
uniform float uVignetteStrength;
uniform float uVignetteScale;
uniform float uChromatic;
uniform float uGrain;
uniform float uSharpen;
uniform float uTime;

#ifdef USE_BLOOM
uniform sampler2D tBloom;
uniform float uBloomIntensity;
#endif

#ifdef USE_DOF
uniform sampler2D tDof;
uniform vec3 uDofNear;          // x = start, y = end, z = strength
uniform vec3 uDofFar;
#endif

#ifdef USE_MOTION_BLUR
uniform mat4 uCurrInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uMotionScale;
uniform float uMotionMax;       // clamp, in uv units
#ifdef USE_OBJECT_VELOCITY
uniform sampler2D tVelocity;
#endif
#endif

varying vec2 vUv;

/**
 * A cheap perceptual encoding for filtering. Sharpening raw HDR values weights
 * every kernel toward the brightest tap and rings around highlights; doing it
 * in a Reinhard+sqrt curve puts the kernel roughly where the eye is.
 */
vec3 toFilterSpace(vec3 c) { return sqrt(c / (1.0 + c)); }
vec3 fromFilterSpace(vec3 p) { vec3 y = p * p; return y / max(1.0 - y, 1e-4); }

/**
 * AMD's contrast-adaptive sharpening. The adaptive amplitude term is why this
 * is used instead of an unsharp mask: sharpening is scaled back wherever the
 * local neighbourhood is already near the top or bottom of the range, so TAA
 * softness is recovered without haloing every silhouette.
 */
vec3 sharpenDelta(vec2 uv, float sharpness) {
  vec3 e = toFilterSpace(max(vec3(0.0), texture2D(tColor, uv).rgb));
  vec3 b = toFilterSpace(max(vec3(0.0), texture2D(tColor, uv + vec2(0.0, -uTexel.y)).rgb));
  vec3 d = toFilterSpace(max(vec3(0.0), texture2D(tColor, uv + vec2(-uTexel.x, 0.0)).rgb));
  vec3 f = toFilterSpace(max(vec3(0.0), texture2D(tColor, uv + vec2( uTexel.x, 0.0)).rgb));
  vec3 h = toFilterSpace(max(vec3(0.0), texture2D(tColor, uv + vec2(0.0,  uTexel.y)).rgb));

  vec3 mn = min(min(min(b, d), min(f, h)), e);
  vec3 mx = max(max(max(b, d), max(f, h)), e);

  vec3 amp = sqrt(saturate(min(mn, 1.0 - mx) / max(mx, 1e-4)));
  vec3 w = -amp * sharpness;
  vec3 sharp = (b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w);

  // The encoding is asymptotic, so a filtered value that reaches 1.0 decodes to
  // infinity. Capping just below, then bounding the correction as a fraction of
  // the original, is what stops an isolated highlight — the sun disc against
  // sky — from sharpening into a firefly that then feeds the bloom chain.
  vec3 result = fromFilterSpace(clamp(sharp, vec3(0.0), vec3(0.995)));
  vec3 base = fromFilterSpace(e);
  return clamp(result - base, -base * 0.75, base * 0.75 + 0.02);
}

void main() {
  vec2 uv = vUv;
  float rawDepth = texture2D(tDepth, uv).r;
  float viewZ = perspectiveDepthToViewZ(rawDepth, uNear, uFar);
  float dist = -viewZ;

  // --- base colour, optionally smeared along the per-pixel motion vector ----
  vec3 color;
#ifdef USE_MOTION_BLUR
  vec2 prevUv = reprojectStatic(uv, rawDepth, uCurrInvViewProj, uPrevViewProj);
  #ifdef USE_OBJECT_VELOCITY
    prevUv += texture2D(tVelocity, uv).xy;
  #endif
  vec2 velocity = (uv - prevUv) * uMotionScale;
  float vlen = length(velocity);
  if (vlen > uMotionMax) velocity *= uMotionMax / vlen;

  if (vlen * uResolution.y > 0.75) {
    float jitter = interleavedGradientNoise(gl_FragCoord.xy + vec2(uTime * 71.0));
    vec3 sum = vec3(0.0);
    for (int i = 0; i < MB_TAPS; i++) {
      float t = (float(i) + jitter) / float(MB_TAPS) - 0.5;
      sum += texture2D(tColor, uv + velocity * t).rgb;
    }
    color = sum / float(MB_TAPS);
  } else {
    color = texture2D(tColor, uv).rgb;
  }
#else
  color = texture2D(tColor, uv).rgb;
#endif

  // --- depth of field ------------------------------------------------------
  float coc = 0.0;
#ifdef USE_DOF
  float nearBlur = 1.0 - smoothstep(uDofNear.x, uDofNear.y, dist);
  float farBlur = smoothstep(uDofFar.x, uDofFar.y, dist);
  coc = saturate(max(nearBlur * uDofNear.z, farBlur * uDofFar.z));
#endif

  // --- sharpen -------------------------------------------------------------
  // Scaled down wherever the frame is about to be defocused; sharpening
  // something that is then blurred only produces ringing.
  color += sharpenDelta(uv, uSharpen * (1.0 - coc));

#ifdef USE_DOF
  if (coc > 0.001) color = mix(color, texture2D(tDof, uv).rgb, coc);
#endif

  // --- chromatic aberration ------------------------------------------------
  // Transverse aberration grows with the square of the image radius, so the
  // centre of the frame is untouched and only the far corners split.
  {
    vec2 d = uv - 0.5;
    vec2 offset = d * dot(d, d) * uChromatic;
    vec3 base = texture2D(tColor, uv).rgb;
    vec3 split = vec3(
      texture2D(tColor, uv + offset).r,
      base.g,
      texture2D(tColor, uv - offset).b);
    color += split - base;
  }

  // --- bloom ---------------------------------------------------------------
#ifdef USE_BLOOM
  color += texture2D(tBloom, uv).rgb * uBloomIntensity;
#endif

  // --- vignette, applied to scene-referred light ---------------------------
  {
    vec2 v = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0) * uVignetteScale;
    float r2 = dot(v, v);
    // cos^4 falloff, the natural response of a rectilinear lens.
    float fall = 1.0 / (1.0 + r2);
    fall *= fall;
    color *= mix(1.0, fall, uVignetteStrength);
  }

  // --- display transform ---------------------------------------------------
  vec3 display = tonemapAgX(max(vec3(0.0), color) * uExposure, uAgx.x, uAgx.y, uAgx.z);
  vec3 encoded = linearToSrgb(display);

  // --- creative grade ------------------------------------------------------
  encoded = applyLut(encoded);

  // --- film grain ----------------------------------------------------------
  // Peaks in the mid-tones and falls away in both the toe and the shoulder,
  // which is how film actually behaves; uniform grain reads as video noise.
  {
    float lum = vsLuminance(encoded);
    float response = 4.0 * lum * (1.0 - lum);
    float n = hash12(gl_FragCoord.xy + vec2(fract(uTime * 37.13) * 512.0, fract(uTime * 17.71) * 512.0));
    float m = hash12(gl_FragCoord.xy + vec2(fract(uTime * 11.37) * 512.0 + 91.7, fract(uTime * 23.19) * 512.0 + 13.3));
    // Two uniform samples make a triangular distribution — closer to grain than
    // a flat one, and it dithers at the same time.
    encoded += (n + m - 1.0) * uGrain * (0.18 + 0.82 * response);
  }

  // --- output dither -------------------------------------------------------
  // The sky is a smooth gradient over hundreds of pixels; without a
  // sub-quantum dither an 8-bit framebuffer bands it visibly.
  float d0 = hash12(gl_FragCoord.xy);
  float d1 = hash12(gl_FragCoord.xy + 41.7);
  encoded += (d0 + d1 - 1.0) * (1.0 / 255.0);

  gl_FragColor = vec4(saturate(encoded), 1.0);
}
`;
