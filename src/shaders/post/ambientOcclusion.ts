import { POST_COMMON } from './common';

/**
 * Ground Truth Ambient Occlusion (Jimenez et al. 2016).
 *
 * Per slice the shader sweeps both directions collecting the maximum horizon
 * angle, then evaluates the closed-form arc integral against the normal
 * projected into the slice plane. That analytic integral is the reason GTAO
 * produces tight contact darkening where geometry meets the ground instead of
 * the uniform grey wash a hemisphere-sampling SSAO gives you.
 *
 * Two slices per frame is enough because the slice angle is rotated by frame
 * index — TAA downstream accumulates them into an effectively 30+ slice
 * estimate while the camera is still.
 *
 * Runs at half resolution against the full resolution depth buffer.
 */
export const GTAO_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tDepth;
uniform mat4 uProjInverse;
uniform vec2 uDepthTexel;   // 1 / full resolution
uniform vec2 uAoTexel;      // 1 / AO resolution
uniform float uNear;
uniform float uFar;
uniform float uRadius;      // world units
uniform float uProjScale;   // 0.5 * fullHeight * projectionMatrix[1][1]
uniform float uMaxRadiusPx;
uniform float uIntensity;
uniform float uPower;
uniform float uThickness;
uniform float uFrame;

varying vec2 vUv;

void main() {
  float rawDepth = texture2D(tDepth, vUv).r;
  if (rawDepth >= 0.999999) { gl_FragColor = vec4(1.0); return; }

  vec3 P = viewPositionFromDepth(vUv, rawDepth, uProjInverse);
  vec3 V = normalize(-P);
  vec3 N = reconstructViewNormal(tDepth, vUv, P, uDepthTexel, uProjInverse);

  // Screen-space projection of the world-space sampling radius.
  float radiusPx = uRadius * uProjScale / max(-P.z, 1e-3);
  radiusPx = min(radiusPx, uMaxRadiusPx);
  if (radiusPx < 2.0) { gl_FragColor = vec4(1.0); return; }

  // Rotating the slice direction and the step offset per frame turns the
  // spatial noise into something TAA can integrate away.
  vec2 pixel = vUv / uAoTexel;
  float noiseDir = interleavedGradientNoise(pixel + vec2(uFrame * 5.588238, uFrame * 3.141593));
  float noiseStep = hash12(pixel + vec2(uFrame * 17.13, uFrame * 9.71));

  float visibility = 0.0;

  for (int s = 0; s < AO_SLICES; s++) {
    float phi = (float(s) + noiseDir) * (PI / float(AO_SLICES));
    vec2 dir = vec2(cos(phi), sin(phi));

    vec3 sliceDir = vec3(dir, 0.0);
    vec3 axis = cross(sliceDir, V);
    float axisLen = length(axis);
    if (axisLen < 1e-5) continue;
    axis /= axisLen;

    // Normal projected into the slice plane, and its signed angle from V.
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = length(projN);
    if (projNLen < 1e-4) continue;
    vec3 nrm = projN / projNLen;
    vec3 tangent = cross(V, axis);
    float n = acos(clamp(dot(nrm, V), -1.0, 1.0)) * sign(dot(nrm, tangent));

    float cosH1 = -1.0;
    float cosH2 = -1.0;

    for (int t = 0; t < AO_STEPS; t++) {
      // Quadratic step distribution: dense near the shading point where
      // contact occlusion lives, sparse further out where it is low frequency.
      float s01 = (float(t) + noiseStep) / float(AO_STEPS);
      float distPx = max(1.0, s01 * s01 * radiusPx);
      vec2 offset = dir * distPx * uDepthTexel;

      vec2 uvA = vUv - offset;
      vec2 uvB = vUv + offset;

      vec3 dA = viewPositionFromDepth(uvA, texture2D(tDepth, uvA).r, uProjInverse) - P;
      vec3 dB = viewPositionFromDepth(uvB, texture2D(tDepth, uvB).r, uProjInverse) - P;

      float lA = length(dA);
      float lB = length(dB);

      // Attenuate distant occluders so the term stays a contact effect rather
      // than a global darkening; the thickness term stops thin geometry from
      // over-occluding everything behind it.
      float fA = saturate((uRadius - lA) * uThickness / uRadius);
      float fB = saturate((uRadius - lB) * uThickness / uRadius);

      float cA = lA > 1e-5 ? dot(dA / lA, V) : -1.0;
      float cB = lB > 1e-5 ? dot(dB / lB, V) : -1.0;

      cosH1 = max(cosH1, mix(-1.0, cA, fA));
      cosH2 = max(cosH2, mix(-1.0, cB, fB));
    }

    float h1 = -acos(clamp(cosH1, -1.0, 1.0));
    float h2 =  acos(clamp(cosH2, -1.0, 1.0));

    // Clamp each horizon into the hemisphere around the projected normal.
    h1 = n + max(h1 - n, -HALF_PI);
    h2 = n + min(h2 - n,  HALF_PI);

    float sinN = sin(n);
    float cosN = cos(n);
    float arc = 0.25 * (-cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN)
              + 0.25 * (-cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN);

    visibility += projNLen * arc;
  }

  visibility = saturate(visibility / float(AO_SLICES));
  float ao = pow(visibility, uPower);
  ao = mix(1.0, ao, uIntensity);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

/**
 * Depth-aware cross-bilateral blur for the AO buffer. The weight falls off with
 * view-space depth difference so occlusion never bleeds across a silhouette,
 * which is what turns AO into a halo around foreground objects.
 */
export const AO_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
${POST_COMMON}

uniform sampler2D tAo;
uniform sampler2D tDepth;
uniform vec2 uTexel;       // 1 / AO resolution
uniform vec2 uDirection;   // (1,0) or (0,1) in AO texels
uniform float uNear;
uniform float uFar;
uniform float uDepthSigma;

varying vec2 vUv;

void main() {
  float centerDepth = texture2D(tDepth, vUv).r;
  float centerZ = perspectiveDepthToViewZ(centerDepth, uNear, uFar);
  // Tolerance scales with distance: a 20cm depth step matters up close and is
  // noise at 400 units out.
  float sigma = max(1e-3, uDepthSigma * abs(centerZ));

  float sum = texture2D(tAo, vUv).r * 0.2270270270;
  float weightSum = 0.2270270270;

  // Five-tap Gaussian, one side unrolled and mirrored.
  for (int i = 1; i <= 4; i++) {
    float w = i == 1 ? 0.1945945946 : (i == 2 ? 0.1216216216 : (i == 3 ? 0.0540540541 : 0.0162162162));
    vec2 offset = uDirection * uTexel * float(i);

    vec2 uvA = vUv - offset;
    vec2 uvB = vUv + offset;

    float zA = perspectiveDepthToViewZ(texture2D(tDepth, uvA).r, uNear, uFar);
    float zB = perspectiveDepthToViewZ(texture2D(tDepth, uvB).r, uNear, uFar);

    float wA = w * exp(-abs(zA - centerZ) / sigma);
    float wB = w * exp(-abs(zB - centerZ) / sigma);

    sum += texture2D(tAo, uvA).r * wA + texture2D(tAo, uvB).r * wB;
    weightSum += wA + wB;
  }

  float ao = sum / max(weightSum, 1e-4);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;
