import { POST_COMMON } from './common';

/**
 * Screen-space reflections.
 *
 * There is no G-buffer in this renderer, so there is no per-pixel roughness or
 * metalness to drive the reflection with. What we *can* do correctly is the
 * dielectric part every surface has: a Schlick Fresnel term rising from ~4% at
 * normal incidence to 100% at grazing. That is physically the sheen you see on
 * wet ground, water and polished metal from a low RTS camera, and it is exactly
 * the angle range an RTS camera spends its life in.
 *
 * To keep it honest on surfaces that should be rough, the reflection is
 * attenuated by a local curvature estimate — bumpy geometry scatters, flat
 * geometry mirrors — and the whole term is kept low enough that a miss reads as
 * "no reflection" rather than "hole".
 *
 * Runs at quarter resolution; reflections at these roughness levels carry no
 * high-frequency detail worth paying for.
 */
export const SSR_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uProjection;
uniform mat4 uProjInverse;
uniform vec2 uDepthTexel;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uStride;      // first marching step, view units
uniform float uThickness;   // depth tolerance for a hit, view units
uniform float uMaxDistance;
uniform float uFrame;

varying vec2 vUv;

void main() {
  float rawDepth = texture2D(tDepth, vUv).r;
  if (rawDepth >= 0.999999) { gl_FragColor = vec4(0.0); return; }

  vec3 P = viewPositionFromDepth(vUv, rawDepth, uProjInverse);
  vec3 V = normalize(-P);
  vec3 N = reconstructViewNormal(tDepth, vUv, P, uDepthTexel, uProjInverse);

  float NoV = dot(N, V);
  if (NoV <= 0.02) { gl_FragColor = vec4(0.0); return; }

  // Dielectric Fresnel. F0 of 0.04 is the standard non-metal base reflectance.
  float fresnel = 0.04 + 0.96 * pow(1.0 - saturate(NoV), 5.0);

  // Curvature proxy for roughness: compare the centre normal against a normal
  // reconstructed one step out. Flat ground stays mirror-like, broken rock and
  // foliage fall away.
  vec3 Nw = reconstructViewNormal(tDepth, vUv + uDepthTexel * 2.0, P, uDepthTexel * 2.0, uProjInverse);
  float flatness = saturate(dot(N, Nw));
  flatness = pow(flatness, 8.0);

  float confidenceBase = fresnel * flatness;
  if (confidenceBase < 0.004) { gl_FragColor = vec4(0.0); return; }

  vec3 R = normalize(reflect(-V, N));

  float jitter = interleavedGradientNoise(vUv / uTexel + vec2(uFrame * 7.3, uFrame * 3.7));

  vec3 rayPos = P + N * max(0.05, -P.z * 0.0015);
  float step = uStride * (0.6 + 0.8 * jitter);
  float travelled = 0.0;

  vec2 hitUv = vec2(0.0);
  float hit = 0.0;
  float hitDepthDelta = 0.0;

  for (int i = 0; i < SSR_STEPS; i++) {
    vec3 prevPos = rayPos;
    rayPos += R * step;
    travelled += step;
    step *= 1.32; // geometric growth keeps near detail while still reaching far

    if (rayPos.z > -uNear || travelled > uMaxDistance) break;

    vec4 clip = uProjection * vec4(rayPos, 1.0);
    if (clip.w <= 0.0) break;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;

    float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, suv).r, uNear, uFar);
    float behind = sceneZ - rayPos.z; // > 0 once the ray passes behind a surface

    if (behind > 0.0 && behind < uThickness + step) {
      // Binary refine between the last two positions for a sub-step hit point.
      vec3 lo = prevPos;
      vec3 hi = rayPos;
      for (int r = 0; r < 4; r++) {
        vec3 mid = (lo + hi) * 0.5;
        vec4 mc = uProjection * vec4(mid, 1.0);
        vec2 muv = (mc.xy / mc.w) * 0.5 + 0.5;
        float mz = perspectiveDepthToViewZ(texture2D(tDepth, muv).r, uNear, uFar);
        if (mz - mid.z > 0.0) hi = mid; else lo = mid;
      }
      vec4 fc = uProjection * vec4(hi, 1.0);
      hitUv = (fc.xy / fc.w) * 0.5 + 0.5;
      hitDepthDelta = behind;
      hit = 1.0;
      break;
    }
  }

  if (hit < 0.5) { gl_FragColor = vec4(0.0); return; }

  // Fade at the screen border (there is no data outside it), with ray length,
  // and when the ray points back at the camera where SSR is least reliable.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.12), hitUv) *
              (1.0 - smoothstep(vec2(0.88), vec2(1.0), hitUv));
  float edgeFade = edge.x * edge.y;
  float distanceFade = 1.0 - saturate(travelled / uMaxDistance);
  float backFade = saturate(1.0 - R.z * 2.0);
  float thicknessFade = 1.0 - saturate(hitDepthDelta / (uThickness * 4.0));

  float confidence = confidenceBase * edgeFade * distanceFade * backFade * thicknessFade;
  vec3 reflected = texture2D(tColor, hitUv).rgb;

  // Clamp the source so a single blown-out pixel (the sun disc) cannot smear a
  // firefly across the reflection.
  reflected = min(reflected, vec3(12.0));

  gl_FragColor = vec4(reflected, confidence);
}
`;
