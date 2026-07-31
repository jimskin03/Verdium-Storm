/**
 * Procedural definitions of the terrain's PBR material layers.
 *
 * Each layer exposes two entry points:
 *   `vsLayerHeight(id, uv)`   — the displacement field, [0,1]. Drives height
 *                               blending between layers, parallax occlusion on
 *                               cliffs, and (by finite difference) the normal.
 *   `vsLayerSurface(id, uv)`  — albedo / roughness / AO on top of that height.
 *
 * Albedo is authored directly in sRGB: the synthesis pass writes bytes and the
 * resulting array texture is tagged `SRGBColorSpace`, so what is written here is
 * what an artist would have picked in a paint program.
 *
 * A tile is mapped to roughly six world units by the terrain shader, so a
 * frequency of 150 is about 25 features per metre — grass blade scale.
 */
export const TERRAIN_LAYERS_GLSL = /* glsl */ `

struct VSSurface {
  vec3 albedo;
  float height;
  float rough;
  float ao;
};

const int VS_DRY_GRASS = 0;
const int VS_LUSH_GRASS = 1;
const int VS_DIRT = 2;
const int VS_MUD = 3;
const int VS_GRAVEL = 4;
const int VS_ROCK = 5;
const int VS_SCORCHED = 6;

// ---------------------------------------------------------------- dry grass

float vsHDryGrass(vec2 uv) {
  vec2 w = vsWarp(uv, vec2(6.0), 0.085, 11.0);
  vec3 cl = vsWorley(uv, vec2(11.0), 3.1);
  float clump = 1.0 - smoothstep(0.03, 0.60, cl.x);
  float blade = vsNoise(w, vec2(174.0, 33.0), 5.0) * 0.52 + vsNoise(w, vec2(29.0, 161.0), 7.0) * 0.48;
  float grain = vsFbm(uv, vec2(70.0), 3, 0.55, 9.0);
  float litter = smoothstep(0.66, 0.99, vsNoise(uv, vec2(44.0), 13.0));
  return clamp(clump * 0.44 + blade * 0.34 + grain * 0.15 + litter * 0.13, 0.0, 1.0);
}

VSSurface vsSDryGrass(vec2 uv) {
  float h = vsHDryGrass(uv);
  vec3 cl = vsWorley(uv, vec2(11.0), 3.1);
  float tone = vsFbm(uv, vec2(3.0), 4, 0.55, 21.0);
  float patchMask = vsFbm(uv, vec2(13.0), 3, 0.5, 31.0);

  vec3 straw = vec3(0.639, 0.549, 0.302);
  vec3 olive = vec3(0.376, 0.396, 0.204);
  vec3 pale = vec3(0.745, 0.686, 0.459);
  vec3 soil = vec3(0.267, 0.208, 0.145);

  float dryness = clamp(tone * 0.55 + cl.z * 0.45, 0.0, 1.0);
  vec3 c = mix(olive, straw, smoothstep(0.22, 0.82, dryness));
  c = mix(c, pale, smoothstep(0.58, 1.0, h) * 0.62);
  c = mix(soil, c, smoothstep(0.015, 0.28, h));
  c *= 0.84 + 0.30 * patchMask;

  float rough = 0.90 - 0.05 * h + 0.05 * patchMask;
  float ao = mix(0.42, 1.0, smoothstep(0.0, 0.52, h));
  return VSSurface(c, h, rough, ao);
}

// --------------------------------------------------------------- lush grass

float vsHLushGrass(vec2 uv) {
  vec2 w = vsWarp(uv, vec2(7.0), 0.070, 51.0);
  vec3 cl = vsWorley(uv, vec2(17.0), 55.0);
  float clump = 1.0 - smoothstep(0.02, 0.55, cl.x);
  float blade = vsNoise(w, vec2(206.0, 41.0), 57.0) * 0.5 + vsNoise(w, vec2(37.0, 197.0), 59.0) * 0.5;
  float broad = smoothstep(0.72, 0.97, vsFbm(uv, vec2(26.0), 2, 0.5, 61.0));
  float grain = vsFbm(uv, vec2(88.0), 3, 0.5, 63.0);
  return clamp(clump * 0.40 + blade * 0.36 + grain * 0.12 + broad * 0.20, 0.0, 1.0);
}

VSSurface vsSLushGrass(vec2 uv) {
  float h = vsHLushGrass(uv);
  vec3 cl = vsWorley(uv, vec2(17.0), 55.0);
  float tone = vsFbm(uv, vec2(4.0), 4, 0.55, 67.0);
  float wet = vsFbm(uv, vec2(9.0), 3, 0.5, 69.0);

  vec3 deep = vec3(0.157, 0.243, 0.110);
  vec3 mid = vec3(0.271, 0.373, 0.157);
  vec3 tip = vec3(0.443, 0.529, 0.243);
  vec3 dead = vec3(0.443, 0.404, 0.212);

  vec3 c = mix(deep, mid, smoothstep(0.10, 0.62, tone * 0.5 + cl.z * 0.5));
  c = mix(c, tip, smoothstep(0.52, 1.0, h) * 0.72);
  c = mix(c, dead, smoothstep(0.70, 0.98, vsNoise(uv, vec2(23.0), 71.0)) * 0.45);
  c *= 0.80 + 0.32 * wet;

  float rough = 0.86 - 0.10 * h + 0.06 * wet;
  float ao = mix(0.30, 1.0, smoothstep(0.0, 0.55, h));
  return VSSurface(c, h, rough, ao);
}

// -------------------------------------------------------------- packed dirt

float vsHDirt(vec2 uv) {
  vec3 peb = vsWorley(uv, vec2(52.0), 101.0);
  float pebble = smoothstep(0.44, 0.06, peb.x) * step(0.42, peb.z);
  vec3 crack = vsWorley(uv, vec2(9.0), 103.0);
  float cracks = smoothstep(0.10, 0.0, crack.y - crack.x);
  float grain = vsFbm(uv, vec2(120.0), 4, 0.55, 105.0);
  float blotch = vsFbm(uv, vec2(6.0), 4, 0.55, 107.0);
  float h = blotch * 0.32 + grain * 0.30 + pebble * 0.42;
  return clamp(h - cracks * 0.30, 0.0, 1.0);
}

VSSurface vsSDirt(vec2 uv) {
  float h = vsHDirt(uv);
  vec3 peb = vsWorley(uv, vec2(52.0), 101.0);
  float pebble = smoothstep(0.44, 0.06, peb.x) * step(0.42, peb.z);
  float blotch = vsFbm(uv, vec2(6.0), 4, 0.55, 107.0);
  float rust = vsFbm(uv, vec2(15.0), 3, 0.5, 109.0);

  vec3 dark = vec3(0.243, 0.180, 0.129);
  vec3 warm = vec3(0.451, 0.345, 0.235);
  vec3 ochre = vec3(0.529, 0.404, 0.243);
  vec3 stone = vec3(0.514, 0.494, 0.455);

  vec3 c = mix(dark, warm, smoothstep(0.18, 0.85, blotch));
  c = mix(c, ochre, smoothstep(0.45, 0.95, rust) * 0.55);
  c = mix(c, stone * (0.72 + 0.5 * peb.z), pebble * 0.85);
  c *= 0.86 + 0.26 * vsNoise(uv, vec2(150.0), 111.0);

  float rough = mix(0.94, 0.66, pebble) - 0.05 * blotch;
  float ao = mix(0.48, 1.0, smoothstep(0.0, 0.6, h));
  return VSSurface(c, h, rough, ao);
}

// --------------------------------------------------------------------- mud

float vsHMud(vec2 uv) {
  vec2 w = vsWarp(uv, vec2(5.0), 0.055, 151.0);
  vec3 cell = vsWorley(w, vec2(7.0), 153.0);
  float plate = smoothstep(0.0, 0.16, cell.y - cell.x);
  vec3 cell2 = vsWorley(w, vec2(15.0), 155.0);
  float plate2 = smoothstep(0.0, 0.10, cell2.y - cell2.x);
  float dome = smoothstep(0.0, 0.55, cell.x);
  float ripple = vsFbm(uv, vec2(34.0), 3, 0.5, 157.0);
  float grain = vsFbm(uv, vec2(160.0), 2, 0.5, 159.0);
  float h = 0.30 + dome * 0.22 + ripple * 0.26 + grain * 0.10;
  return clamp(h * mix(0.42, 1.0, plate) * mix(0.72, 1.0, plate2), 0.0, 1.0);
}

VSSurface vsSMud(vec2 uv) {
  float h = vsHMud(uv);
  vec2 w = vsWarp(uv, vec2(5.0), 0.055, 151.0);
  vec3 cell = vsWorley(w, vec2(7.0), 153.0);
  float pool = smoothstep(0.55, 0.15, h);
  float tone = vsFbm(uv, vec2(5.0), 4, 0.55, 161.0);

  vec3 wetDark = vec3(0.118, 0.090, 0.067);
  vec3 mudMid = vec3(0.271, 0.204, 0.141);
  vec3 dried = vec3(0.412, 0.345, 0.259);

  vec3 c = mix(mudMid, dried, smoothstep(0.30, 0.90, tone * 0.6 + cell.z * 0.4));
  c = mix(c, wetDark, pool * 0.85);
  c *= 0.88 + 0.22 * vsNoise(uv, vec2(96.0), 163.0);

  float rough = mix(0.86, 0.34, pool) - 0.06 * tone;
  float ao = mix(0.28, 1.0, smoothstep(0.0, 0.62, h));
  return VSSurface(c, h, rough, ao);
}

// ------------------------------------------------------------ sand / gravel

float vsHGravel(vec2 uv) {
  vec3 big = vsWorley(uv, vec2(26.0), 201.0);
  vec3 mid = vsWorley(uv, vec2(48.0), 203.0);
  vec3 sml = vsWorley(uv, vec2(96.0), 205.0);
  float b = smoothstep(0.40, 0.02, big.x) * step(0.55, big.z);
  float m = smoothstep(0.32, 0.02, mid.x) * step(0.34, mid.z);
  float s = smoothstep(0.30, 0.03, sml.x);
  float sand = vsFbm(uv, vec2(190.0), 3, 0.5, 207.0);
  float dune = vsFbm(uv, vec2(8.0), 3, 0.55, 209.0);
  float h = dune * 0.16 + sand * 0.16 + s * 0.18;
  h = max(h, m * 0.58);
  h = max(h, b * 0.94);
  return clamp(h, 0.0, 1.0);
}

VSSurface vsSGravel(vec2 uv) {
  float h = vsHGravel(uv);
  vec3 big = vsWorley(uv, vec2(26.0), 201.0);
  vec3 mid = vsWorley(uv, vec2(48.0), 203.0);
  float b = smoothstep(0.40, 0.02, big.x) * step(0.55, big.z);
  float m = smoothstep(0.32, 0.02, mid.x) * step(0.34, mid.z);
  float dune = vsFbm(uv, vec2(8.0), 3, 0.55, 209.0);

  vec3 sandLo = vec3(0.545, 0.482, 0.361);
  vec3 sandHi = vec3(0.706, 0.643, 0.498);
  vec3 pebA = vec3(0.494, 0.478, 0.451);
  vec3 pebB = vec3(0.404, 0.325, 0.267);
  vec3 pebC = vec3(0.639, 0.612, 0.557);

  vec3 c = mix(sandLo, sandHi, smoothstep(0.2, 0.85, dune));
  vec3 stone = mix(pebA, pebB, big.z);
  stone = mix(stone, pebC, smoothstep(0.6, 1.0, mid.z));
  c = mix(c, mix(pebA, pebC, mid.z), m * 0.8);
  c = mix(c, stone, b * 0.92);
  c *= 0.88 + 0.24 * vsNoise(uv, vec2(220.0), 211.0);

  float rough = mix(0.93, 0.52, max(b, m * 0.7));
  float ao = mix(0.46, 1.0, smoothstep(0.0, 0.55, h));
  return VSSurface(c, h, rough, ao);
}

// ------------------------------------------------------------- rock / cliff

float vsHRock(vec2 uv) {
  // Strata: integer band count along v so the pattern wraps, warped so the beds
  // undulate instead of reading as a barcode.
  float warp = vsFbm(uv, vec2(3.0), 4, 0.55, 301.0);
  float warp2 = vsFbm(uv, vec2(11.0), 3, 0.5, 303.0);
  float s = uv.y * 9.0 + warp * 2.4 + warp2 * 0.55;
  float band = abs(fract(s) - 0.5) * 2.0;
  float strata = smoothstep(0.12, 0.86, band);

  // Blocky facets — the cliff breaks along joint planes, not into blobs.
  vec3 facet = vsWorley(vsWarp(uv, vec2(4.0), 0.05, 305.0), vec2(6.0), 307.0);
  float facetH = facet.z;
  float joint = smoothstep(0.0, 0.09, facet.y - facet.x);

  // Fracture network at two scales.
  float frac1 = 1.0 - smoothstep(0.0, 0.055, abs(vsRidge(uv, vec2(7.0), 3, 0.5, 309.0) - 0.62));
  vec3 frac2 = vsWorley(uv, vec2(19.0), 311.0);
  float frac2m = smoothstep(0.0, 0.07, frac2.y - frac2.x);

  float grit = vsFbm(uv, vec2(96.0), 4, 0.55, 313.0);

  float h = 0.24 + strata * 0.30 + facetH * 0.26 + grit * 0.14;
  h *= mix(0.52, 1.0, joint);
  h *= mix(0.66, 1.0, frac2m);
  h -= frac1 * 0.22;
  return clamp(h, 0.0, 1.0);
}

VSSurface vsSRock(vec2 uv) {
  float h = vsHRock(uv);
  float warp = vsFbm(uv, vec2(3.0), 4, 0.55, 301.0);
  float s = uv.y * 9.0 + warp * 2.4;
  float bandId = vsHash(vec2(floor(s), 0.0), 317.0);
  vec3 facet = vsWorley(vsWarp(uv, vec2(4.0), 0.05, 305.0), vec2(6.0), 307.0);
  float iron = vsFbm(uv, vec2(6.0), 4, 0.55, 319.0);
  float lichen = smoothstep(0.62, 0.94, vsFbm(uv, vec2(13.0), 3, 0.5, 321.0));

  vec3 greyCool = vec3(0.404, 0.404, 0.404);
  vec3 greyWarm = vec3(0.478, 0.435, 0.380);
  vec3 dark = vec3(0.208, 0.204, 0.196);
  vec3 rust = vec3(0.451, 0.310, 0.208);
  vec3 moss = vec3(0.259, 0.294, 0.184);

  vec3 c = mix(greyCool, greyWarm, bandId);
  c = mix(c, dark, smoothstep(0.55, 0.05, h) * 0.75);
  c = mix(c, rust, smoothstep(0.55, 0.95, iron) * 0.42);
  c = mix(c, moss, lichen * smoothstep(0.30, 0.75, h) * 0.30);
  c *= 0.82 + 0.34 * facet.z;
  c *= 0.90 + 0.20 * vsNoise(uv, vec2(180.0), 323.0);

  float rough = 0.62 + 0.26 * vsFbm(uv, vec2(40.0), 3, 0.5, 325.0) - 0.10 * smoothstep(0.6, 1.0, h);
  float ao = mix(0.24, 1.0, smoothstep(0.0, 0.68, h));
  return VSSurface(c, h, rough, ao);
}

// ---------------------------------------------------------------- scorched

float vsHScorched(vec2 uv) {
  vec2 w = vsWarp(uv, vec2(4.0), 0.06, 401.0);
  vec3 cell = vsWorley(w, vec2(10.0), 403.0);
  float crack = smoothstep(0.0, 0.13, cell.y - cell.x);
  vec3 cell2 = vsWorley(w, vec2(24.0), 405.0);
  float crack2 = smoothstep(0.0, 0.08, cell2.y - cell2.x);
  float lump = smoothstep(0.36, 0.02, vsWorley(uv, vec2(44.0), 407.0).x);
  float grain = vsFbm(uv, vec2(140.0), 4, 0.55, 409.0);
  float h = 0.34 + grain * 0.26 + lump * 0.34;
  return clamp(h * mix(0.30, 1.0, crack) * mix(0.70, 1.0, crack2), 0.0, 1.0);
}

VSSurface vsSScorched(vec2 uv) {
  float h = vsHScorched(uv);
  float ash = smoothstep(0.55, 0.95, vsFbm(uv, vec2(18.0), 3, 0.5, 411.0));
  float tone = vsFbm(uv, vec2(5.0), 4, 0.55, 413.0);
  float ember = smoothstep(0.10, 0.0, h) * smoothstep(0.55, 0.9, vsFbm(uv, vec2(9.0), 3, 0.5, 415.0));

  vec3 char0 = vec3(0.082, 0.075, 0.071);
  vec3 char1 = vec3(0.192, 0.169, 0.149);
  vec3 ashCol = vec3(0.435, 0.416, 0.396);
  vec3 scorchWarm = vec3(0.278, 0.180, 0.129);

  vec3 c = mix(char0, char1, smoothstep(0.10, 0.75, tone * 0.5 + h * 0.5));
  c = mix(c, scorchWarm, ember * 0.7);
  c = mix(c, ashCol, ash * smoothstep(0.4, 0.9, h) * 0.55);
  c *= 0.86 + 0.26 * vsNoise(uv, vec2(170.0), 417.0);

  float rough = 0.94 - 0.10 * ash;
  float ao = mix(0.20, 1.0, smoothstep(0.0, 0.62, h));
  return VSSurface(c, h, rough, ao);
}

// ------------------------------------------------------------------ dispatch

float vsLayerHeight(int id, vec2 uv) {
  if (id == VS_DRY_GRASS) return vsHDryGrass(uv);
  if (id == VS_LUSH_GRASS) return vsHLushGrass(uv);
  if (id == VS_DIRT) return vsHDirt(uv);
  if (id == VS_MUD) return vsHMud(uv);
  if (id == VS_GRAVEL) return vsHGravel(uv);
  if (id == VS_ROCK) return vsHRock(uv);
  return vsHScorched(uv);
}

VSSurface vsLayerSurface(int id, vec2 uv) {
  if (id == VS_DRY_GRASS) return vsSDryGrass(uv);
  if (id == VS_LUSH_GRASS) return vsSLushGrass(uv);
  if (id == VS_DIRT) return vsSDirt(uv);
  if (id == VS_MUD) return vsSMud(uv);
  if (id == VS_GRAVEL) return vsSGravel(uv);
  if (id == VS_ROCK) return vsSRock(uv);
  return vsSScorched(uv);
}
`;
