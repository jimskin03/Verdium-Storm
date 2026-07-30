import { POST_COMMON } from './common';

/**
 * Progressive dual-filter bloom, Call of Duty: Advanced Warfare / Jimenez style.
 *
 * The chain downsamples with the 13-tap filter (four overlapping 2x2 boxes plus
 * a centre box, weighted 0.125/0.125/0.125/0.125/0.5) which is stable under
 * motion, then upsamples with a 3x3 tent and *lerps* rather than accumulates.
 * Lerping is what makes it energy conserving: every mip contributes to a
 * weighted average whose weights sum to one, so widening the glow never adds
 * brightness. That is why this does not blow the frame out the way
 * `UnrealBloomPass` does — the latter sums five thresholded Gaussians with
 * hand-tuned weights and gains energy at every step.
 *
 * The prefilter uses a quadratic soft knee so highlights ramp in smoothly, plus
 * a small unthresholded "veil" term. The veil is the physically real part: a
 * real lens scatters a percentage of *all* incoming light, not just the bright
 * bits, and it is what stops the bloom from looking like a bolted-on glow.
 */

/** Threshold + first downsample, full resolution to half. */
export const BLOOM_PREFILTER_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tColor;
uniform vec2 uTexel;        // 1 / source resolution
uniform float uThreshold;
uniform float uKnee;
uniform float uVeil;
uniform float uExposure;
uniform float uClamp;

varying vec2 vUv;

vec3 fetch(vec2 uv) {
  // Ceiling on the source keeps a single blown-out texel from dumping a huge
  // amount of energy into the whole chain.
  return min(texture2D(tColor, uv).rgb, vec3(uClamp));
}

void main() {
  vec2 t = uTexel;

  vec3 a = fetch(vUv + t * vec2(-2.0,  2.0));
  vec3 b = fetch(vUv + t * vec2( 0.0,  2.0));
  vec3 c = fetch(vUv + t * vec2( 2.0,  2.0));
  vec3 d = fetch(vUv + t * vec2(-2.0,  0.0));
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + t * vec2( 2.0,  0.0));
  vec3 g = fetch(vUv + t * vec2(-2.0, -2.0));
  vec3 h = fetch(vUv + t * vec2( 0.0, -2.0));
  vec3 i = fetch(vUv + t * vec2( 2.0, -2.0));
  vec3 j = fetch(vUv + t * vec2(-1.0,  1.0));
  vec3 k = fetch(vUv + t * vec2( 1.0,  1.0));
  vec3 l = fetch(vUv + t * vec2(-1.0, -1.0));
  vec3 m = fetch(vUv + t * vec2( 1.0, -1.0));

  // Five overlapping boxes, each Karis-weighted independently.
  vec3 b0 = (j + k + l + m) * 0.25;
  vec3 b1 = (a + b + d + e) * 0.25;
  vec3 b2 = (b + c + e + f) * 0.25;
  vec3 b3 = (d + e + g + h) * 0.25;
  vec3 b4 = (e + f + h + i) * 0.25;

  float w0 = 0.5   / (1.0 + luminance(b0));
  float w1 = 0.125 / (1.0 + luminance(b1));
  float w2 = 0.125 / (1.0 + luminance(b2));
  float w3 = 0.125 / (1.0 + luminance(b3));
  float w4 = 0.125 / (1.0 + luminance(b4));

  vec3 color = (b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / (w0 + w1 + w2 + w3 + w4);

  // Soft-knee threshold, evaluated in exposed space so the threshold means
  // "about to clip the display transform" rather than an arbitrary number.
  vec3 exposed = color * uExposure;
  float brightness = max(exposed.r, max(exposed.g, exposed.b));
  float soft = brightness - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 1e-4);

  gl_FragColor = vec4(color * contribution + color * uVeil, 1.0);
}
`;

/** 13-tap downsample for the rest of the chain. */
export const BLOOM_DOWNSAMPLE_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tColor;
uniform vec2 uTexel;

varying vec2 vUv;

void main() {
  vec2 t = uTexel;

  vec3 a = texture2D(tColor, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture2D(tColor, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture2D(tColor, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture2D(tColor, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture2D(tColor, vUv).rgb;
  vec3 f = texture2D(tColor, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture2D(tColor, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(tColor, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture2D(tColor, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture2D(tColor, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture2D(tColor, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture2D(tColor, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(tColor, vUv + t * vec2( 1.0, -1.0)).rgb;

  vec3 color = e * 0.125;
  color += (a + c + g + i) * 0.03125;
  color += (b + d + f + h) * 0.0625;
  color += (j + k + l + m) * 0.125;

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * 3x3 tent upsample blended into the next-larger mip. `uBlend` is the weight of
 * the coarser level; 0.5 gives a strictly energy-preserving average.
 */
export const BLOOM_UPSAMPLE_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tCoarse;
uniform sampler2D tFine;
uniform vec2 uTexel;       // 1 / coarse resolution
uniform float uRadius;
uniform float uBlend;

varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;

  vec3 a = texture2D(tCoarse, vUv + vec2(-t.x,  t.y)).rgb;
  vec3 b = texture2D(tCoarse, vUv + vec2( 0.0,  t.y)).rgb;
  vec3 c = texture2D(tCoarse, vUv + vec2( t.x,  t.y)).rgb;
  vec3 d = texture2D(tCoarse, vUv + vec2(-t.x,  0.0)).rgb;
  vec3 e = texture2D(tCoarse, vUv).rgb;
  vec3 f = texture2D(tCoarse, vUv + vec2( t.x,  0.0)).rgb;
  vec3 g = texture2D(tCoarse, vUv + vec2(-t.x, -t.y)).rgb;
  vec3 h = texture2D(tCoarse, vUv + vec2( 0.0, -t.y)).rgb;
  vec3 i = texture2D(tCoarse, vUv + vec2( t.x, -t.y)).rgb;

  vec3 coarse = e * 0.25
              + (b + d + f + h) * 0.125
              + (a + c + g + i) * 0.0625;

  vec3 fine = texture2D(tFine, vUv).rgb;
  gl_FragColor = vec4(mix(fine, coarse, uBlend), 1.0);
}
`;
