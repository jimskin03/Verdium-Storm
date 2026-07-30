/**
 * GLSL for terrain-projected decals.
 *
 * Every decal is a small grid whose vertices were dropped onto the heightfield
 * when it was placed, so a scorch mark bends over a slope instead of hovering
 * as a flat card. The whole pool lives in one buffer and draws in one call;
 * lifetime and fade are evaluated per vertex from a birth stamp, which means
 * the buffer is only ever touched when a decal is *placed*, never per frame.
 *
 * Blending is a true multiply against the lit frame. That is what a mark on the
 * ground physically is — a modulation of the surface's albedo response — so a
 * scorch in shadow darkens by the same ratio as one in sunlight, and no decal
 * ever glows brighter than the light falling on it. The atlas stores the
 * multiplier at half scale, giving a 0..2 range so rubble and displaced dust
 * can lighten the ground as well as darken it.
 */

export const DECAL_VERTEX = /* glsl */ `
precision highp float;

attribute float aLayer;
/** birth, life, fadeIn, strength */
attribute vec4 aTime;
attribute vec3 aTint;

uniform float uTime;

varying vec2 vUv;
varying float vLayer;
varying vec3 vTint;
varying float vFade;
varying vec3 vWorld;

void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age > aTime.y) {
    // Retired slot: collapse behind the far plane so it costs nothing.
    vFade = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float fadeIn = smoothstep(0.0, max(aTime.z, 1e-3), age);
  float fadeOut = 1.0 - smoothstep(aTime.y * 0.55, aTime.y, age);
  vFade = aTime.w * fadeIn * fadeOut;
  vUv = uv;
  vLayer = aLayer;
  vTint = aTint;
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const DECAL_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
uniform float uFogDensity;
/** x: distance where the decal starts fading, y: where it is gone. */
uniform vec2 uDistFade;

varying vec2 vUv;
varying float vLayer;
varying vec3 vTint;
varying float vFade;
varying vec3 vWorld;

void main() {
  if (vFade <= 0.002) discard;
  vec4 t = texture2D(uAtlas, vec3(vUv, vLayer));

  float dist = distance(vWorld, cameraPosition);
  // Distance falloff mirrors the atmospheric wash so far-off decals never end
  // up multiplying the fog itself into a dirty smear.
  float fd = uFogDensity * dist;
  float k = t.a * vFade * exp(-fd * fd) * (1.0 - smoothstep(uDistFade.x, uDistFade.y, dist));
  if (k < 0.003) discard;

  vec3 modulate = mix(vec3(1.0), t.rgb * 2.0 * vTint, k);
  gl_FragColor = vec4(modulate, 1.0);
}
`;
