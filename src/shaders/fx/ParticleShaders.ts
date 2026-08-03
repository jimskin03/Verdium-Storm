/**
 * GLSL for the FX particle pipeline.
 *
 * Particles are simulated entirely in the vertex shader from a per-particle
 * spawn state that the CPU writes exactly once. Position is the closed-form
 * solution of `dv/dt = -k(v - v_terminal)`, so a puff of smoke costs the CPU
 * nothing after the frame it was born on. Ballistic debris takes a second
 * branch that solves for its ground impacts analytically and bounces.
 *
 * Two materials share this vertex shader:
 *   - EMISSIVE_FRAGMENT — unlit, HDR, additive. Fire, flash, sparks, tracers.
 *   - LIT_FRAGMENT      — sun/sky lit with a spherical billboard normal
 *                         perturbed by the sprite's baked normal map, so smoke
 *                         has real volume and a lit side. Premultiplied alpha.
 *
 * Both fade against a baked ground-height texture (the "soft particle" term).
 * Sampling the heightfield instead of a scene depth buffer keeps the whole
 * effect off the critical path — no depth prepass, no framebuffer round trip —
 * and it is exactly the intersection that betrays a billboard: the hard line
 * where a puff of smoke slices into the terrain.
 *
 * Note that three.js compiles every non-raw ShaderMaterial as `#version 300 es`
 * with GLSL1 compatibility defines, which is why `sampler2DArray` is legal here
 * while the rest of the source reads as GLSL1.
 */

/** Bit flags packed into the particle's `aO.z` slot. */
export const PFLAG = {
  /** Snap Y to the terrain every frame — ground-hugging dust and shock rings. */
  HUG: 1,
  /** Lay the quad flat in the XZ plane instead of billboarding to the camera. */
  FLAT: 2,
  /** Ballistic integration with analytic ground bounces. */
  BOUNCE: 4,
  /** Skip the soft-particle ground fade (for sprites that must stay crisp). */
  NO_SOFT: 8,
  /** High-frequency brightness flicker — embers, arc sparks. */
  FLICKER: 16,
} as const;

const COMMON = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uWind;
uniform sampler2D uGround;
/** x: 1 / worldSize, y: unused. */
uniform vec2 uGroundParam;

varying vec3 vUvLayer;
varying vec2 vRamp;
varying vec3 vTint;
varying vec3 vWorld;
varying vec2 vLocal;
/** x: brightness, y: soft distance, z: seed, w: age. */
varying vec4 vP;

float groundAt(vec2 xz) {
  return texture2D(uGround, xz * uGroundParam.x + 0.5).r;
}
`;

export const PARTICLE_VERTEX = /* glsl */ `
${COMMON}

attribute vec4 aP; // position.xyz, birth time
attribute vec4 aV; // velocity.xyz, lifetime
attribute vec4 aS; // size0, size1, sizeExponent, spin
attribute vec4 aC; // drag, gravity, turbulence, stretch
attribute vec4 aM; // rampRow, atlasLayer, brightness, seed
attribute vec4 aO; // packedTint, softDistance, flags, windFactor

uniform float uRampRows;

vec3 unpackTint(float p) {
  float r = floor(p / 65536.0);
  float g = floor(mod(p, 65536.0) / 256.0);
  float b = mod(p, 256.0);
  return vec3(r, g, b) * (1.0 / 255.0);
}

void main() {
  float life = max(aV.w, 1e-4);
  float age = uTime - aP.w;
  float u = age / life;

  // Dead or unborn particles collapse behind the far plane and are clipped.
  if (age < 0.0 || u > 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float f = aO.z;
  float fHug = mod(f, 2.0);      f = floor(f * 0.5);
  float fFlat = mod(f, 2.0);     f = floor(f * 0.5);
  float fBounce = mod(f, 2.0);   f = floor(f * 0.5);
  float fNoSoft = mod(f, 2.0);   f = floor(f * 0.5);
  float fFlicker = mod(f, 2.0);

  float seed = aM.w;
  vec3 pos;

  if (fBounce > 0.5) {
    // Ballistic with restitution. Each iteration solves for the next ground
    // contact in closed form, so debris arcs, bounces and settles with no
    // per-frame CPU work at all.
    float g = max(-aC.y, 0.5);
    float gh = groundAt(aP.xz);
    float t = age;
    float y = max(aP.y - gh, 0.0);
    float vy = aV.y;
    vec2 hp = aP.xz;
    vec2 hv = aV.xz;
    for (int i = 0; i < 3; i++) {
      float tHit = (vy + sqrt(max(vy * vy + 2.0 * g * y, 0.0))) / g;
      if (t <= tHit) break;
      hp += hv * tHit;
      t -= tHit;
      vy = -(vy - g * tHit) * 0.36;
      hv *= 0.48;
      y = 0.0;
    }
    hp += hv * t;
    pos = vec3(hp.x, groundAt(hp) + max(y + vy * t - 0.5 * g * t * t, 0.0), hp.y);
  } else {
    float k = aC.x;
    vec3 gravity = vec3(0.0, aC.y, 0.0);
    if (k > 1e-3) {
      // Terminal velocity is gravity balanced against drag, offset by the wind
      // the particle is entrained in; smoke therefore drifts downwind and
      // settles into a rise rate instead of accelerating forever.
      vec3 term = gravity / k + uWind * aO.w;
      float e = exp(-k * age);
      pos = aP.xyz + (aV.xyz - term) * (1.0 - e) / k + term * age;
    } else {
      pos = aP.xyz + aV.xyz * age + 0.5 * gravity * age * age;
    }

    if (aC.z > 0.0) {
      // Divergent pseudo-turbulence. Amplitude grows with age so a plume
      // breaks up as it rises rather than travelling as a rigid blob.
      float s = seed * 100.0;
      pos += aC.z * age * vec3(
        sin(age * 1.35 + s) + 0.55 * sin(age * 3.1 + s * 1.7),
        0.45 * sin(age * 1.05 + s * 2.1),
        cos(age * 1.15 + s * 1.3) + 0.55 * cos(age * 3.4 + s * 0.6));
    }
  }

  float size = mix(aS.x, aS.y, pow(u, aS.z));
  // Never pop in at full scale.
  size *= 0.4 + 0.6 * smoothstep(0.0, 0.07, u);

  if (fHug > 0.5) pos.y = groundAt(pos.xz) + 0.25 + size * 0.16;

  float rot = seed * 6.2831853 + aS.w * age;
  float cr = cos(rot);
  float sr = sin(rot);
  vec2 q = position.xy;
  vec2 corner = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr) * size;

  float bright = aM.z;
  if (fFlicker > 0.5) bright *= 0.55 + 0.45 * sin(age * 41.0 + seed * 37.0) * sin(age * 17.0 + seed * 11.0);

  vUvLayer = vec3(uv, aM.y);
  vRamp = vec2(clamp(u, 0.003, 0.997), (aM.x + 0.5) / uRampRows);
  vTint = unpackTint(aO.x);
  vLocal = q * 2.0;
  vP = vec4(bright, aO.y * (1.0 - fNoSoft), seed, age);

  if (fFlat > 0.5) {
    // Ground-aligned quad: each corner is dropped onto the terrain, so a blast
    // ring bends over the ground it is expanding across.
    vec3 wp = pos + vec3(corner.x, 0.0, corner.y);
    wp.y = groundAt(wp.xz) + 0.3;
    vWorld = wp;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
    return;
  }

  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);

  if (aC.w > 0.0) {
    // Velocity-aligned stretch for tracers and ejecta streaks. The stretch is
    // foreshortened by how much of the velocity survives projection, so a round
    // hit coming at the camera does not smear across the screen.
    vec3 vView = (modelViewMatrix * vec4(aV.xyz, 0.0)).xyz;
    float planar = length(vView.xy);
    float total = max(length(vView), 1e-4);
    if (planar > 1e-4) {
      vec2 d = vView.xy / planar;
      vec2 p2 = vec2(-d.y, d.x);
      float len = size * aC.w * (planar / total);
      corner = d * ((q.y - 0.5) * len) + p2 * (q.x * size);
    }
  }

  mv.xy += corner;
  vWorld = pos + camRight * corner.x + camUp * corner.y;
  gl_Position = projectionMatrix * mv;
}
`;

/** Shared tail of both fragment shaders: soft fade, near fade and fog. */
const FRAG_HEAD = /* glsl */ `
${COMMON}

precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
uniform sampler2D uRamp;
uniform vec3 uFogColor;
uniform float uFogDensity;
/** x: fade start, y: fade end (world units from the camera). */
uniform vec2 uNearFade;
`;

export const EMISSIVE_FRAGMENT = /* glsl */ `
${FRAG_HEAD}

void main() {
  vec4 tex = texture2D(uAtlas, vUvLayer);
  vec4 ramp = texture2D(uRamp, vRamp);
  float a = tex.a * ramp.a;
  if (a < 0.004) discard;

  vec3 col = ramp.rgb * vTint * vP.x * (tex.b * 2.0);

  if (vP.y > 0.0) {
    float gh = groundAt(vWorld.xz);
    a *= smoothstep(0.0, vP.y, vWorld.y - gh + vP.y * 0.2);
  }

  float dist = distance(vWorld, cameraPosition);
  a *= smoothstep(uNearFade.x, uNearFade.y, dist);

  // Emitted light is attenuated by the intervening air, never tinted by it.
  float fd = uFogDensity * dist;
  col *= exp(-fd * fd);

  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;

export const LIT_FRAGMENT = /* glsl */ `
${FRAG_HEAD}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundBounce;

void main() {
  vec4 tex = texture2D(uAtlas, vUvLayer);
  vec4 ramp = texture2D(uRamp, vRamp);
  float a = tex.a * ramp.a;
  if (a < 0.005) discard;

  // Treat the billboard as a sphere and perturb that normal with the sprite's
  // baked normal map. This is what turns a flat puff into a lump of cloud with
  // a lit crown and a shadowed underside.
  float r2 = min(dot(vLocal, vLocal), 0.97);
  vec3 nSphere = vec3(vLocal, sqrt(1.0 - r2));
  vec2 nBump = tex.rg * 2.0 - 1.0;
  vec3 nView = normalize(vec3(nSphere.xy * 0.85 + nBump * 0.75, nSphere.z * 0.95));

  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 n = normalize(camRight * nView.x + camUp * nView.y + camFwd * nView.z);

  // Wrapped diffuse — dense smoke scatters light well past the terminator.
  float ndl = dot(n, uSunDir);
  float wrap = clamp((ndl + 0.6) / 1.6, 0.0, 1.0);
  vec3 lit = uSunColor * pow(wrap, 1.5);
  lit += mix(uGroundBounce, uSkyColor, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));

  // Forward scattering: looking through a plume toward the sun lights it from
  // within, which is the single most convincing thing smoke can do.
  vec3 viewDir = normalize(vWorld - cameraPosition);
  float fwd = pow(max(dot(viewDir, -uSunDir), 0.0), 7.0);
  lit += uSunColor * fwd * 1.6 * (1.2 - tex.b);

  vec3 col = ramp.rgb * vTint * vP.x * lit * (0.35 + 0.85 * tex.b);

  if (vP.y > 0.0) {
    float gh = groundAt(vWorld.xz);
    a *= smoothstep(0.0, vP.y, vWorld.y - gh + vP.y * 0.2);
  }

  float dist = distance(vWorld, cameraPosition);
  a *= smoothstep(uNearFade.x, uNearFade.y, dist);

  float fd = uFogDensity * dist;
  float fog = exp(-fd * fd);
  col = mix(uFogColor, col, fog);

  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;
