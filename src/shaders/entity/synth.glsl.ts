/**
 * Runtime texture synthesis for entity surfaces.
 *
 * One fragment program produces both material layers and all three map types.
 * It is rendered into six render targets once at boot; nothing here runs on the
 * per-frame path. All noise is lattice-periodic so the results tile seamlessly
 * — a visible repeat seam on a tank hull is an instant tell.
 *
 *   layer 0  "plate"      machined/painted armour: panel breaks, rivets,
 *                         brushed grain, scratches, chipped paint, dust
 *   layer 1  "composite"  rough industrial surface: aggregate, rust blotches,
 *                         cracks, speckle, plus a scorch mask in alpha
 *
 *   output 0  albedo (sRGB encoded)
 *   output 1  tangent-space normal
 *   output 2  ORM — R ambient occlusion, G roughness, B metalness
 */

export const SYNTH_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SYNTH_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform int uLayer;
uniform int uOutput;
uniform float uTexel;

float h21(vec2 p, float seed) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + seed * 0.0173);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Periodic value noise — lattice coordinates wrap, so the result tiles.
float vnoiseP(vec2 p, vec2 per, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = h21(mod(i, per), seed);
  float b = h21(mod(i + vec2(1.0, 0.0), per), seed);
  float c = h21(mod(i + vec2(0.0, 1.0), per), seed);
  float d = h21(mod(i + vec2(1.0, 1.0), per), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbmP(vec2 uv, vec2 per, int oct, float seed) {
  float sum = 0.0;
  float norm = 0.0;
  float amp = 0.5;
  vec2 p = per;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * vnoiseP(uv * p, p, seed + float(i) * 17.3);
    norm += amp;
    amp *= 0.52;
    p *= 2.0;
  }
  return sum / max(norm, 1e-4);
}

float fbmT(vec2 uv, float per, int oct, float seed) {
  return fbmP(uv, vec2(per), oct, seed);
}

float worleyT(vec2 uv, float per, float seed) {
  vec2 p = uv * per;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float best = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, vec2(per));
      vec2 o = vec2(h21(c, seed), h21(c, seed + 91.3));
      best = min(best, length(g + o - f));
    }
  }
  return best;
}

// Irregular plate subdivision: each grid cell splits twice at random, giving
// the uneven panel runs real armour has instead of a uniform checkerboard.
// Returns (distance to nearest panel edge, per-plate random).
vec2 panels(vec2 uv, float per, float seed) {
  vec2 c = floor(uv * per);
  vec2 f = fract(uv * per);
  vec2 lo = vec2(0.0);
  vec2 hi = vec2(1.0);
  vec2 cw = mod(c, vec2(per));
  for (int k = 0; k < 3; k++) {
    float r = h21(cw, seed + float(k) * 31.0);
    float t = 0.3 + 0.4 * h21(cw + vec2(float(k) * 5.0), seed + 71.0);
    if (r < 0.5) {
      float s = mix(lo.x, hi.x, t);
      if (f.x < s) hi.x = s; else lo.x = s;
    } else {
      float s = mix(lo.y, hi.y, t);
      if (f.y < s) hi.y = s; else lo.y = s;
    }
  }
  float d = min(min(f.x - lo.x, hi.x - f.x), min(f.y - lo.y, hi.y - f.y));
  float id = h21(cw + floor((lo + hi) * 53.0), seed + 5.0);
  return vec2(d, id);
}

// ---------------------------------------------------------------- layer A

float grooveA(vec2 uv) {
  vec2 pn = panels(uv, 4.0, 11.0);
  return 1.0 - smoothstep(0.0, 0.030, pn.x);
}

float rivetsA(vec2 uv) {
  vec2 pn = panels(uv, 4.0, 11.0);
  float near = 1.0 - smoothstep(0.030, 0.075, pn.x);
  vec2 rg = uv * 96.0;
  vec2 ri = floor(rg);
  vec2 rf = fract(rg) - 0.5;
  float pick = step(0.62, h21(mod(ri, vec2(96.0)), 3.0));
  return (1.0 - smoothstep(0.16, 0.32, length(rf))) * pick * near;
}

float scratchA(vec2 uv) {
  float a = smoothstep(0.63, 0.74, fbmP(uv, vec2(4.0, 96.0), 3, 44.0));
  float b = smoothstep(0.66, 0.76, fbmP(uv, vec2(80.0, 5.0), 3, 61.0));
  return clamp(a + b * 0.7, 0.0, 1.0);
}

float chipA(vec2 uv) {
  float w = worleyT(uv, 20.0, 9.0);
  return smoothstep(0.20, 0.05, w) * step(0.58, fbmT(uv, 6.0, 2, 77.0));
}

float heightA(vec2 uv) {
  float h = -grooveA(uv) * 0.6;
  h += rivetsA(uv) * 0.75;
  h += (fbmP(uv, vec2(150.0, 26.0), 2, 21.0) - 0.5) * 0.16;
  h += (fbmT(uv, 14.0, 4, 5.0) - 0.5) * 0.13;
  h -= scratchA(uv) * 0.14;
  h -= chipA(uv) * 0.22;
  return h;
}

// ---------------------------------------------------------------- layer B

float heightB(vec2 uv) {
  float agg = worleyT(uv, 14.0, 4.0);
  float pebble = smoothstep(0.44, 0.06, agg);
  float blot = fbmT(uv, 3.0, 5, 55.0);
  float crack = smoothstep(0.80, 0.97, 1.0 - abs(fbmT(uv, 6.0, 4, 88.0) * 2.0 - 1.0));
  float h = pebble * 0.45 + (blot - 0.5) * 0.55 - crack * 0.85;
  h += (fbmT(uv, 90.0, 2, 31.0) - 0.5) * 0.22;
  return h;
}

float height(vec2 uv) {
  return uLayer == 0 ? heightA(uv) : heightB(uv);
}

// ---------------------------------------------------------------- outputs

vec4 albedo(vec2 uv) {
  if (uLayer == 0) {
    vec2 pn = panels(uv, 4.0, 11.0);
    float groove = 1.0 - smoothstep(0.0, 0.030, pn.x);
    float grain = fbmP(uv, vec2(150.0, 26.0), 2, 21.0);
    float chip = chipA(uv);
    float scr = scratchA(uv);
    float dust = smoothstep(0.46, 0.86, fbmT(uv, 3.0, 4, 101.0));
    float riv = rivetsA(uv);

    vec3 c = vec3(1.0);
    c *= 0.90 + 0.20 * pn.y;              // plate-to-plate paint batch variance
    c *= mix(1.0, 0.40, groove);          // shadowed panel break
    c *= 0.93 + 0.14 * grain;             // brushed grain
    c *= mix(1.0, 0.74, dust);            // settled dust
    c = mix(c, vec3(1.45), chip * 0.85);  // paint chipped to bright metal
    c = mix(c, vec3(1.28), scr * 0.45);   // scuffs
    c *= 1.0 + riv * 0.10;
    return vec4(clamp(c, 0.0, 2.0), 0.0);
  }
  float agg = worleyT(uv, 14.0, 4.0);
  float pebble = smoothstep(0.44, 0.06, agg);
  float blot = fbmT(uv, 3.0, 5, 55.0);
  float crack = smoothstep(0.80, 0.97, 1.0 - abs(fbmT(uv, 6.0, 4, 88.0) * 2.0 - 1.0));
  float speck = h21(floor(uv * 220.0), 7.0);

  float v = 0.70 + 0.55 * blot + 0.22 * pebble - 0.36 * crack;
  vec3 c = vec3(v);
  // Warm shift where the blotch field peaks: reads as rust when tinted orange
  // and as water staining when tinted grey.
  c *= mix(vec3(1.0), vec3(1.20, 0.84, 0.64), smoothstep(0.52, 0.88, blot));
  c *= 0.90 + 0.20 * speck;
  float scorch = smoothstep(0.38, 0.78, fbmT(uv, 2.0, 4, 143.0));
  return vec4(clamp(c, 0.0, 2.0), scorch);
}

vec3 orm(vec2 uv) {
  if (uLayer == 0) {
    float groove = grooveA(uv);
    float chip = chipA(uv);
    float scr = scratchA(uv);
    float dust = smoothstep(0.46, 0.86, fbmT(uv, 3.0, 4, 101.0));
    float grain = fbmP(uv, vec2(150.0, 26.0), 2, 21.0);
    float ao = 1.0 - groove * 0.60;
    float rough = 0.50 + groove * 0.14 - chip * 0.20 - scr * 0.16 + (grain - 0.5) * 0.12 + dust * 0.14;
    float metal = 0.50 + chip * 0.42 + scr * 0.26 - dust * 0.14;
    return clamp(vec3(ao, rough, metal), 0.0, 1.0);
  }
  float agg = worleyT(uv, 14.0, 4.0);
  float pebble = smoothstep(0.44, 0.06, agg);
  float blot = fbmT(uv, 3.0, 5, 55.0);
  float crack = smoothstep(0.80, 0.97, 1.0 - abs(fbmT(uv, 6.0, 4, 88.0) * 2.0 - 1.0));
  float ao = 1.0 - crack * 0.55 - (1.0 - pebble) * 0.12;
  float rough = 0.68 + blot * 0.22 - pebble * 0.12;
  float metal = 0.44 + smoothstep(0.58, 0.92, blot) * 0.22;
  return clamp(vec3(ao, rough, metal), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  if (uOutput == 0) {
    vec4 a = albedo(uv);
    gl_FragColor = vec4(pow(a.rgb, vec3(1.0 / 2.2)), a.a);
  } else if (uOutput == 2) {
    gl_FragColor = vec4(orm(uv), 1.0);
  } else {
    float e = uTexel;
    float hx = height(uv + vec2(e, 0.0)) - height(uv - vec2(e, 0.0));
    float hy = height(uv + vec2(0.0, e)) - height(uv - vec2(0.0, e));
    float k = uLayer == 0 ? 0.55 : 0.75;
    vec3 n = normalize(vec3(-hx * k / (e * 2.0) * 0.02, -hy * k / (e * 2.0) * 0.02, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  }
}
`;
