import { POST_COMMON } from './common';

/**
 * Half-resolution defocus source for the composite's depth of field.
 *
 * At an RTS camera pitch the ground plane runs from just under the lens to the
 * horizon in a single frame, so a shallow near/far falloff reads as a
 * tilt-shift: the playfield band stays razor sharp and the extreme foreground
 * and the far ridge lines soften. That is the entire effect — it must never get
 * strong enough to cost readability, so the composite caps the blend well below
 * 1 and the sharp band is deliberately wide.
 *
 * The kernel is a golden-angle spiral, which spreads taps far more evenly than
 * concentric rings and so shows no visible tap structure at this radius.
 */
export const DOF_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tColor;
uniform vec2 uTexel;      // 1 / source (full) resolution
uniform float uRadius;    // in full-resolution pixels
uniform float uFrame;

varying vec2 vUv;

void main() {
  float jitter = interleavedGradientNoise(vUv / uTexel + vec2(uFrame * 2.71828, uFrame * 1.41421));

  vec3 sum = texture2D(tColor, vUv).rgb;
  float weightSum = 1.0;

  for (int i = 0; i < DOF_TAPS; i++) {
    float fi = float(i) + jitter;
    // Golden angle: consecutive taps land 137.5 degrees apart, radius grows as
    // sqrt so the disc is uniformly covered.
    float angle = fi * 2.39996323;
    float radius = uRadius * sqrt(fi / float(DOF_TAPS));
    vec2 offset = vec2(cos(angle), sin(angle)) * radius * uTexel;

    vec3 c = texture2D(tColor, vUv + offset).rgb;
    // Weighting by 1/(1+luma) stops the sun and specular hits from producing a
    // hard bokeh donut in what is supposed to be a soft falloff.
    float w = 1.0 / (1.0 + luminance(c) * 0.25);
    sum += c * w;
    weightSum += w;
  }

  gl_FragColor = vec4(sum / weightSum, 1.0);
}
`;
