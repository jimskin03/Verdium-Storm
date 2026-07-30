/**
 * Fullscreen passes that bake the procedural material layers into textures at
 * boot. Everything the terrain renders with is produced here — there is not a
 * single image file in the project.
 */

export const SYNTH_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

/** Pass A — albedo in RGB (sRGB encoded), displacement height in A. */
export const SYNTH_ALBEDO_FRAGMENT = /* glsl */ `
precision highp float;
uniform int uLayer;
varying vec2 vUv;

void main() {
  VSSurface s = vsLayerSurface(uLayer, vUv);
  gl_FragColor = vec4(clamp(s.albedo, 0.0, 1.0), clamp(s.height, 0.0, 1.0));
}
`;

/**
 * Pass B — tangent-space normal XY in RG, roughness in B, AO in A.
 * The normal comes from a forward difference of the same height field pass A
 * stored, so displacement, parallax and shading all agree.
 */
export const SYNTH_SURFACE_FRAGMENT = /* glsl */ `
precision highp float;
uniform int uLayer;
uniform float uTexel;
uniform float uBump;
varying vec2 vUv;

void main() {
  VSSurface s = vsLayerSurface(uLayer, vUv);
  float hx = vsLayerHeight(uLayer, vUv + vec2(uTexel, 0.0));
  float hy = vsLayerHeight(uLayer, vUv + vec2(0.0, uTexel));
  vec2 grad = vec2(hx - s.height, hy - s.height) / uTexel;
  vec3 n = normalize(vec3(-grad * uBump, 1.0));
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, clamp(s.rough, 0.02, 1.0), clamp(s.ao, 0.0, 1.0));
}
`;

/**
 * World-space macro mask, sampled once per fragment by the terrain shader.
 *   R  biome         dry steppe (0) to lush meadow (1)
 *   G  patch         exposed dirt / gravel scars
 *   B  wear          scorched, battle-burnt ground (sparse)
 *   A  luminance     large scale tonal + hue drift, and the de-tiling mask
 */
export const SYNTH_MACRO_FRAGMENT = /* glsl */ `
precision highp float;
uniform float uExtent;
varying vec2 vUv;

void main() {
  vec2 w = (vUv - 0.5) * (2.0 * uExtent);

  vec2 warp = vec2(vsOpenFbm(w / 640.0 + 7.0, 3, 0.5, 3.0),
                   vsOpenFbm(w / 640.0 - 4.0, 3, 0.5, 5.0)) - 0.5;
  vec2 wb = w + warp * 420.0;

  float biome = vsOpenFbm(wb / 880.0 + 11.0, 4, 0.55, 13.0);
  biome = smoothstep(0.34, 0.70, biome);
  biome = mix(biome, vsOpenFbm(wb / 210.0, 3, 0.5, 17.0), 0.28);

  float patch = vsOpenFbm(wb / 265.0 + 31.0, 4, 0.52, 19.0);
  patch = smoothstep(0.30, 0.86, patch * 0.72 + vsOpenFbm(w / 78.0, 3, 0.5, 23.0) * 0.28);

  float wear = vsOpenFbm(wb / 430.0 + 53.0, 4, 0.5, 29.0);
  wear = smoothstep(0.62, 0.93, wear) * smoothstep(0.40, 0.78, vsOpenFbm(w / 130.0, 3, 0.5, 31.0));

  float lum = vsOpenFbm(w / 1500.0 + 71.0, 3, 0.55, 37.0) * 0.45
            + vsOpenFbm(w / 380.0, 4, 0.52, 41.0) * 0.36
            + vsOpenFbm(w / 96.0, 3, 0.5, 43.0) * 0.19;

  gl_FragColor = vec4(clamp(biome, 0.0, 1.0), clamp(patch, 0.0, 1.0),
                      clamp(wear, 0.0, 1.0), clamp(lum, 0.0, 1.0));
}
`;
