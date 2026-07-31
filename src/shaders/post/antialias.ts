/**
 * Spatial anti-aliasing fallback for tiers where the temporal path is off.
 *
 * FXAA 3.x in its console/PC form: a luminance edge test, a gradient direction
 * estimated from the four diagonal neighbours, then two averages along that
 * direction — a narrow one that is always safe and a wide one that is used only
 * when its luminance still sits inside the local range. That last test is the
 * whole trick; it is what stops the wide filter from smearing thin geometry.
 *
 * This runs on the graded, display-referred image, which is where FXAA's
 * luminance thresholds were tuned to operate.
 */
export const FXAA_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D tColor;
uniform vec2 uTexel;

varying vec2 vUv;

float fxaaLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbM  = texture2D(tColor, vUv).rgb;
  vec3 rgbNW = texture2D(tColor, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tColor, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tColor, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tColor, vUv + vec2( 1.0,  1.0) * uTexel).rgb;

  float lM  = fxaaLuma(rgbM);
  float lNW = fxaaLuma(rgbNW);
  float lNE = fxaaLuma(rgbNE);
  float lSW = fxaaLuma(rgbSW);
  float lSE = fxaaLuma(rgbSE);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  // Relative threshold so dark areas are not filtered on sensor-level noise.
  if (lMax - lMin < max(0.0312, lMax * 0.125)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE)));

  // Bias the direction away from degenerate cases on near-flat edges.
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D(tColor, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tColor, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);

  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(tColor, vUv + dir * -0.5).rgb +
    texture2D(tColor, vUv + dir *  0.5).rgb);

  float lB = fxaaLuma(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;
