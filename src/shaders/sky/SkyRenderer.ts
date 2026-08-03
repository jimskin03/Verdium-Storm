import * as THREE from 'three';
import {
  ATMOSPHERE,
  GLSL_ATMOSPHERE,
  GLSL_CLOUDS,
  GLSL_NOISE,
  GLSL_SKYVIEW,
  LUT_SIZE,
} from './atmosphereCommon';
import { skyUniforms } from './SceneShaders';

/**
 * Everything that produces sky radiance: the three scattering LUTs, the baked
 * cloud field, the dome material and the PMREM environment probe.
 *
 * Per-frame cost is one dome draw call. The LUTs are re-rendered only when the
 * sun has moved far enough to matter, and the environment probe only when the
 * LUTs changed — so a static sun costs nothing beyond the dome.
 */

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function fullscreenMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
}

/** Transmittance LUT: optical depth from an altitude/angle pair to space. */
const TRANSMITTANCE_FRAG = /* glsl */ `
${GLSL_ATMOSPHERE}
varying vec2 vUv;

vec3 computeTransmittance(float r, float mu) {
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(vsSafeSqrt(1.0 - mu * mu), mu, 0.0);
  float t = vsRaySphereFar(ro, rd, VS_TOP_R);
  const int N = 40;
  float dt = t / float(N);
  vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    vec3 sR; float sM; vec3 ext;
    vsSampleMedium(length(p) - VS_GROUND_R, sR, sM, ext);
    od += ext * dt;
  }
  return exp(-od);
}

void main() {
  float r, mu;
  vsTransmittanceParams(vUv, r, mu);
  gl_FragColor = vec4(computeTransmittance(r, mu), 1.0);
}
`;

/**
 * Second-order (and beyond) scattering, folded into a single isotropic term.
 * This is the difference between a sky that dies at dusk and one that keeps a
 * luminous blue vault while the horizon burns.
 */
const MULTISCATTER_FRAG = /* glsl */ `
${GLSL_ATMOSPHERE}
uniform sampler2D uTransmittance;
varying vec2 vUv;

#define MS_DIRS 24
#define MS_STEPS 14

vec3 trLookup(float r, float mu) {
  return texture2D(uTransmittance, vsTransmittanceUv(r, mu)).rgb;
}

void main() {
  float cosSun = vUv.x * 2.0 - 1.0;
  float r = VS_GROUND_R + vUv.y * (VS_TOP_R - VS_GROUND_R);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunDir = normalize(vec3(vsSafeSqrt(1.0 - cosSun * cosSun), cosSun, 0.0));

  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);
  const float uniformPhase = 1.0 / (4.0 * VS_PI);

  for (int d = 0; d < MS_DIRS; d++) {
    // Fibonacci sphere so a small direction count still covers evenly.
    float k = (float(d) + 0.5) / float(MS_DIRS);
    float cz = 1.0 - 2.0 * k;
    float sz = vsSafeSqrt(1.0 - cz * cz);
    float phi = float(d) * 2.399963229728653;
    vec3 rd = vec3(sz * cos(phi), cz, sz * sin(phi));

    float tGround = vsRaySphereNear(ro, rd, VS_GROUND_R);
    float tMax = tGround > 0.0 ? tGround : vsRaySphereFar(ro, rd, VS_TOP_R);
    float dt = tMax / float(MS_STEPS);

    vec3 lum = vec3(0.0);
    vec3 fms = vec3(0.0);
    vec3 tr = vec3(1.0);

    for (int i = 0; i < MS_STEPS; i++) {
      vec3 p = ro + rd * ((float(i) + 0.5) * dt);
      float pr = length(p);
      vec3 sR; float sM; vec3 ext;
      vsSampleMedium(pr - VS_GROUND_R, sR, sM, ext);
      vec3 stepTr = exp(-ext * dt);
      vec3 scatter = sR + vec3(sM);
      float sunCos = dot(p / pr, sunDir);
      float shadow = vsRaySphereNear(p, sunDir, VS_GROUND_R) < 0.0 ? 1.0 : 0.0;
      vec3 trSun = trLookup(pr, sunCos);

      vec3 S = scatter * uniformPhase * trSun * shadow;
      vec3 invExt = 1.0 / max(ext, vec3(1e-7));
      lum += tr * (S - S * stepTr) * invExt;
      fms += tr * (scatter * uniformPhase * 4.0 * VS_PI * uniformPhase - scatter * uniformPhase * 4.0 * VS_PI * uniformPhase * stepTr) * invExt;
      tr *= stepTr;
    }

    if (tGround > 0.0) {
      vec3 p = ro + rd * tGround;
      vec3 n = p / length(p);
      float ndl = max(dot(n, sunDir), 0.0);
      lum += tr * VS_GROUND_ALBEDO / VS_PI * ndl * trLookup(VS_GROUND_R, dot(n, sunDir));
    }

    lumTotal += lum;
    fmsTotal += fms;
  }

  lumTotal /= float(MS_DIRS);
  fmsTotal /= float(MS_DIRS);
  // Infinite scattering series: L * 1/(1 - f).
  vec3 psi = lumTotal / max(1.0 - fmsTotal, vec3(1e-4));
  gl_FragColor = vec4(psi, 1.0);
}
`;

/** Sky-view LUT: the full sky for the current sun position, camera at ground. */
const SKYVIEW_FRAG = /* glsl */ `
${GLSL_ATMOSPHERE}
${GLSL_SKYVIEW}
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform vec3 uSunDir;
uniform float uCameraAltitude;
varying vec2 vUv;

#define SKY_STEPS 32

vec3 trLookup(float r, float mu) {
  return texture2D(uTransmittance, vsTransmittanceUv(r, mu)).rgb;
}

vec3 msLookup(float r, float mu) {
  vec2 uv = vec2(mu * 0.5 + 0.5, clamp((r - VS_GROUND_R) / (VS_TOP_R - VS_GROUND_R), 0.0, 1.0));
  return texture2D(uMultiScatter, uv).rgb;
}

void main() {
  vec3 rd = vsSkyViewDir(vUv, uSunDir);
  vec3 ro = vec3(0.0, VS_GROUND_R + uCameraAltitude, 0.0);

  float tGround = vsRaySphereNear(ro, rd, VS_GROUND_R);
  float tMax = tGround > 0.0 ? tGround : vsRaySphereFar(ro, rd, VS_TOP_R);
  tMax = min(tMax, 400.0);

  float cosT = dot(rd, uSunDir);
  float pR = vsRayleighPhase(cosT);
  float pM = vsMiePhase(cosT, VS_MIE_G);

  vec3 L = vec3(0.0);
  vec3 tr = vec3(1.0);
  float t = 0.0;

  for (int i = 0; i < SKY_STEPS; i++) {
    // Quadratic step distribution: dense near the camera where the medium is
    // thickest, sparse out at the top of the atmosphere.
    float f0 = float(i) / float(SKY_STEPS);
    float f1 = float(i + 1) / float(SKY_STEPS);
    float tA = tMax * f0 * f0;
    float tB = tMax * f1 * f1;
    float dt = tB - tA;
    if (dt <= 0.0) continue;
    vec3 p = ro + rd * (tA + dt * 0.5);
    float pr = length(p);

    vec3 sR; float sM; vec3 ext;
    vsSampleMedium(pr - VS_GROUND_R, sR, sM, ext);
    vec3 stepTr = exp(-ext * dt);
    float sunCos = dot(p / pr, uSunDir);
    float shadow = vsRaySphereNear(p, uSunDir, VS_GROUND_R) < 0.0 ? 1.0 : 0.0;
    vec3 trSun = trLookup(pr, sunCos);

    vec3 inScatter = (sR * pR + vec3(sM) * pM) * trSun * shadow
                   + (sR + vec3(sM)) * msLookup(pr, sunCos);
    vec3 invExt = 1.0 / max(ext, vec3(1e-7));
    L += tr * (inScatter - inScatter * stepTr) * invExt;
    tr *= stepTr;
    t = tB;
  }

  if (tGround > 0.0) {
    vec3 p = ro + rd * tGround;
    vec3 n = p / length(p);
    float ndl = max(dot(n, uSunDir), 0.0);
    vec3 groundLight = VS_GROUND_ALBEDO / VS_PI * (ndl * trLookup(VS_GROUND_R, dot(n, uSunDir)) + msLookup(VS_GROUND_R, dot(n, uSunDir)) * 2.0);
    L += tr * groundLight;
  }

  // Alpha carries mean view-ray transmittance so the dome can attenuate stars.
  gl_FragColor = vec4(L, dot(tr, vec3(0.3333)));
}
`;

/** Baked, tiling cloud density field. Regenerated only when the shape changes. */
const CLOUD_BAKE_FRAG = /* glsl */ `
${GLSL_NOISE}
uniform float uSeed;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 8.0 + uSeed;
  float period = 8.0;
  // Domain warp gives the deck its wind-sheared, non-uniform structure.
  vec2 w = vec2(vsFbm(p + 3.1, period, 3), vsFbm(p + 8.7, period, 3)) - 0.5;
  float base = vsFbmRidged(p + w * 1.4, period, 5);
  float detail = vsFbm(p * 3.0, period * 3.0, 4);
  float coverage = vsFbm(p * 0.375 + 21.0, period * 0.375, 3);
  float wisp = vsFbm(p * 6.0 + 4.0, period * 6.0, 3);
  gl_FragColor = vec4(base, detail, coverage, wisp);
}
`;

/**
 * Sky dome. One draw call, drawn before everything with no depth interaction.
 * Contains: LUT sky, sun disc with limb darkening, aureole, moon with real
 * phase, star field, the lit cloud deck, and a far mountain backdrop that gives
 * the 1 km playfield somewhere to fade into.
 */
const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Pin to the far plane: the dome never clips, whatever the camera range is.
  gl_Position.z = gl_Position.w;
}
`;

const DOME_FRAG = /* glsl */ `
${GLSL_ATMOSPHERE}
${GLSL_SKYVIEW}
${GLSL_NOISE}

uniform sampler2D uSkyView;
uniform sampler2D uTransmittance;
uniform sampler2D uCloudTex;
uniform vec4 uCloudParams;
uniform vec4 uCloudWind;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uSunRadiance;
uniform vec3 uCameraPos;
uniform vec4 uSkyParams;   // x sky gain, y camera altitude km, z night, w star gain
uniform vec4 uDomeParams;  // x sun disc gain, y aureole gain, z cloud gain, w probe flag
uniform vec4 uRidge;       // x height scale, y darkness, z haze mix, w distance km

${GLSL_CLOUDS}

varying vec3 vDir;

vec3 skyRadiance(vec3 rd, out float viewTransmittance) {
  vec4 s = texture2D(uSkyView, vsSkyViewUv(rd, uSunDir));
  viewTransmittance = s.a;
  return s.rgb;
}

/** Procedural star field with a Milky Way band; stable under camera motion. */
vec3 stars(vec3 rd) {
  if (uSkyParams.w <= 0.001) return vec3(0.0);
  float az = atan(rd.z, rd.x);
  float el = asin(clamp(rd.y, -1.0, 1.0));
  vec2 cell = vec2(az / (2.0 * VS_PI) * 380.0, el / VS_PI * 190.0);
  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float v = 0.0;
  vec3 tint = vec3(1.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = vsHash22(id + o + 3.7);
      float bright = vsHash21(id + o + 11.3);
      if (bright < 0.90) continue;
      float mag = pow((bright - 0.90) * 10.0, 3.0);
      vec2 d = o + h - f;
      float r = dot(d, d);
      float tw = 0.75 + 0.25 * sin(bright * 91.0);
      float star = exp(-r * 190.0) * mag * tw;
      // Deliberately unanimated: a twinkle that moves with the frame counter
      // makes every screenshot comparison noisy for no visual gain at this size.
      v += star;
      float temp = vsHash21(id + o + 51.9);
      tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.76, 0.85, 1.0), temp);
    }
  }
  // Milky Way: a tilted, dusty band of unresolved stars.
  vec3 band = normalize(vec3(0.34, 0.62, -0.71));
  float bandD = 1.0 - abs(dot(rd, band));
  float milky = pow(clamp(bandD, 0.0, 1.0), 26.0);
  milky *= 0.45 + 0.55 * vsFbm(vec2(az * 3.4, el * 5.0) * 2.0, 64.0, 4);
  vec3 col = v * tint + milky * vec3(0.55, 0.6, 0.78) * 0.055;
  return col * uSkyParams.w;
}

/** Moon disc with correct phase from the sun direction, plus maria. */
vec3 moon(vec3 rd) {
  float ang = acos(clamp(dot(rd, uMoonDir), -1.0, 1.0));
  float radius = VS_SUN_ANGULAR_R * 1.05;
  if (ang > radius * 1.6) return vec3(0.0);
  // Reconstruct the surface normal of the visible hemisphere.
  vec3 up = abs(uMoonDir.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tx = normalize(cross(up, uMoonDir));
  vec3 ty = cross(uMoonDir, tx);
  vec2 disc = vec2(dot(rd, tx), dot(rd, ty)) / radius;
  float r2 = dot(disc, disc);
  if (r2 > 1.0) return vec3(0.0);
  vec3 n = normalize(tx * disc.x + ty * disc.y + uMoonDir * vsSafeSqrt(1.0 - r2));
  float lit = max(dot(n, uSunDir), 0.0);
  float terminator = smoothstep(0.0, 0.14, lit);
  float surface = 0.72 + 0.28 * vsFbm(disc * 3.4 + 7.0, 64.0, 4);
  surface *= 0.82 + 0.18 * vsFbmRidged(disc * 9.0, 64.0, 3);
  float edge = 1.0 - smoothstep(0.86, 1.0, sqrt(r2));
  // Earthshine keeps the dark limb readable instead of a hard bite.
  float earthshine = 0.035;
  return uMoonColor * (terminator * surface * pow(lit, 0.55) + earthshine) * edge;
}

/** Distant range on the horizon: gives the map edge somewhere to disappear. */
vec3 ridgeline(vec3 rd, vec3 skyCol, float el) {
  if (el < -0.02 || el > 0.16) return vec3(0.0);
  float az = atan(rd.z, rd.x);
  float total = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float freq = 2.6 + fl * 4.3;
    float amp = (1.0 - fl * 0.42) * uRidge.x;
    float h = vsFbmRidged(vec2(az * freq + fl * 19.0, fl * 3.0), 512.0, 4);
    h = pow(h, 1.7) * amp * (0.55 + 0.45 * vsFbm(vec2(az * 1.1 + fl * 5.0, 0.0), 512.0, 2));
    float top = h - fl * 0.004;
    total = max(total, smoothstep(top, top - 0.0035, el) * (1.0 - fl * 0.3));
  }
  if (total <= 0.001) return vec3(0.0);
  // Nearly pure aerial perspective: the range is a value shift, not an object.
  vec3 rock = skyCol * uRidge.z;
  return (rock - skyCol) * total * uRidge.y;
}

/** Lit cloud slab. Two height samples fake parallax through the deck. */
vec4 cloudLayer(vec3 ro, vec3 rd, vec3 skyCol, float viewTr) {
  if (uDomeParams.z <= 0.0 || rd.y < 0.004) return vec4(0.0);
  vec3 center = vec3(ro.x, -VS_GROUND_R * 1000.0, ro.z);
  vec3 rel = ro - center;
  float rBase = VS_GROUND_R * 1000.0 + uCloudParams.z;
  float t0 = vsRaySphereFar(rel, rd, rBase);
  if (t0 <= 0.0) return vec4(0.0);
  vec3 hit = ro + rd * t0;

  float d = vsCloudDensityUv(vsCloudUv(hit.xz));
  #ifdef VS_CLOUD_VOLUME
    // Second slab higher in the deck, offset along the ray: cheap parallax that
    // reads as thickness when the camera turns.
    float t1 = vsRaySphereFar(rel, rd, rBase + uCloudParams.w);
    vec3 hit1 = ro + rd * t1;
    float d1 = vsCloudDensityUv(vsCloudUv(hit1.xz) + vec2(0.004, -0.002));
    d = mix(d, min(d, d1) * 0.55 + d * 0.45, 0.6);
  #endif
  if (d <= 0.001) return vec4(0.0);

  // Self-shadowing: march the density field toward the sun in tile space.
  vec2 sunStep = normalize(uSunDir.xz + vec2(1e-4)) * (uCloudParams.w / max(uSunDir.y, 0.16)) / uCloudParams.x;
  float od = 0.0;
  #ifdef VS_CLOUD_VOLUME
    const int SUN_TAPS = 4;
  #else
    const int SUN_TAPS = 2;
  #endif
  for (int i = 0; i < SUN_TAPS; i++) {
    float f = (float(i) + 0.5) / float(SUN_TAPS);
    od += vsCloudDensityUv(vsCloudUv(hit.xz) + sunStep * f * 0.6) * f;
  }
  od /= float(SUN_TAPS);

  float beer = exp(-od * 5.5);
  // Powder term: bright rims where the deck thins, dark cores.
  float powder = 1.0 - exp(-od * 9.0);
  float cosT = dot(rd, uSunDir);
  float phase = mix(vsMiePhase(cosT, 0.62), vsMiePhase(cosT, -0.28), 0.35) * 4.0;

  vec3 sunLight = uSunRadiance * (beer * (0.35 + 0.65 * powder)) * phase;
  vec3 ambient = skyCol * (1.4 + 1.6 * (1.0 - d));
  vec3 col = sunLight * uDomeParams.z + ambient * (0.55 + 0.45 * beer);

  // Clouds sit in the same haze as everything else: fade into the sky at grazing
  // angles so the deck never ends in a visible edge.
  float horizonFade = smoothstep(0.004, 0.13, rd.y);
  float alpha = clamp(d * 1.25, 0.0, 1.0) * horizonFade;
  float aerial = 1.0 - exp(-t0 * 0.00016);
  col = mix(col, skyCol, clamp(aerial, 0.0, 0.92));
  return vec4(col, alpha);
}

void main() {
  vec3 rd = normalize(vDir);
  float el = asin(clamp(rd.y, -1.0, 1.0));

  float viewTr;
  vec3 sky = skyRadiance(rd, viewTr) * uSkyParams.x;

  float ang = acos(clamp(dot(rd, uSunDir), -1.0, 1.0));
  vec3 space = stars(rd) + moon(rd);

  // Sun disc with limb darkening; the edge is antialiased against the pixel.
  if (ang < VS_SUN_ANGULAR_R * 4.0 && uSunDir.y > -0.09) {
    float d = ang / VS_SUN_ANGULAR_R;
    float mu = vsSafeSqrt(1.0 - min(d, 1.0) * min(d, 1.0));
    vec3 limb = 1.0 - vec3(0.40, 0.53, 0.66) * (1.0 - pow(vec3(mu), vec3(0.45, 0.5, 0.56)));
    float aa = max(fwidth(d), 0.02);
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    space += uSunRadiance * limb * disc * uDomeParams.x;
  }

  // Aureole — the forward-scattered halo the LUT resolution smears away.
  float aureole = exp(-ang * ang * 900.0) * 0.55 + exp(-ang * ang * 60.0) * 0.12 + exp(-ang * ang * 6.0) * 0.03;
  sky += uSunRadiance * aureole * uDomeParams.y * smoothstep(-0.12, 0.02, uSunDir.y);

  vec3 col = space * viewTr + sky;
  col += ridgeline(rd, sky, el);

  vec4 clouds = cloudLayer(uCameraPos, rd, sky, viewTr);
  col = mix(col, clouds.rgb, clouds.a);

  // Dither before the 8-bit write: the horizon gradient must never step.
  col += vsDither(gl_FragCoord.xy, 0.0016) * max(col, vec3(0.02));
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

export interface SkyRendererOptions {
  /** Adds the second density slab and the wider self-shadow march. */
  volumetricClouds: boolean;
}

export class SkyRenderer {
  readonly domeMesh: THREE.Mesh;
  private renderer: THREE.WebGLRenderer;

  private transmittanceRT: THREE.WebGLRenderTarget;
  private multiScatterRT: THREE.WebGLRenderTarget;
  private skyViewRT: THREE.WebGLRenderTarget;
  private cloudRT: THREE.WebGLRenderTarget;

  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;

  private transmittanceMat: THREE.ShaderMaterial;
  private multiScatterMat: THREE.ShaderMaterial;
  private skyViewMat: THREE.ShaderMaterial;
  private cloudMat: THREE.ShaderMaterial;

  private domeMaterial: THREE.ShaderMaterial;
  private probeScene = new THREE.Scene();
  private probeMesh: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;

  /** Sun direction the LUTs were last built for. */
  private lutSunDir = new THREE.Vector3(0, -1, 0);
  private lutsValid = false;

  constructor(renderer: THREE.WebGLRenderer, options: SkyRendererOptions) {
    this.renderer = renderer;

    const lutOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    this.transmittanceRT = new THREE.WebGLRenderTarget(LUT_SIZE.transmittance[0], LUT_SIZE.transmittance[1], lutOpts);
    this.multiScatterRT = new THREE.WebGLRenderTarget(LUT_SIZE.multiScatter[0], LUT_SIZE.multiScatter[1], lutOpts);
    this.skyViewRT = new THREE.WebGLRenderTarget(LUT_SIZE.skyView[0], LUT_SIZE.skyView[1], lutOpts);

    this.cloudRT = new THREE.WebGLRenderTarget(LUT_SIZE.cloud, LUT_SIZE.cloud, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    });

    skyUniforms.uSkyView.value = this.skyViewRT.texture;
    skyUniforms.uTransmittance.value = this.transmittanceRT.texture;
    skyUniforms.uCloudTex.value = this.cloudRT.texture;

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.transmittanceMat = fullscreenMaterial(TRANSMITTANCE_FRAG, {});
    this.multiScatterMat = fullscreenMaterial(MULTISCATTER_FRAG, {
      uTransmittance: skyUniforms.uTransmittance,
    });
    this.skyViewMat = fullscreenMaterial(SKYVIEW_FRAG, {
      uTransmittance: skyUniforms.uTransmittance,
      uMultiScatter: { value: this.multiScatterRT.texture },
      uSunDir: skyUniforms.uSunDir,
      uCameraAltitude: { value: 0.06 },
    });
    this.cloudMat = fullscreenMaterial(CLOUD_BAKE_FRAG, { uSeed: { value: 3.17 } });

    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSkyView: skyUniforms.uSkyView,
        uTransmittance: skyUniforms.uTransmittance,
        uCloudTex: skyUniforms.uCloudTex,
        uCloudParams: skyUniforms.uCloudParams,
        uCloudWind: skyUniforms.uCloudWind,
        uSunDir: skyUniforms.uSunDir,
        uMoonDir: skyUniforms.uMoonDir,
        uMoonColor: skyUniforms.uMoonColor,
        uSunRadiance: skyUniforms.uSunRadiance,
        uCameraPos: skyUniforms.uCameraPos,
        uSkyParams: skyUniforms.uSkyParams,
        uDomeParams: skyUniforms.uDomeParams,
        uRidge: skyUniforms.uRidge,
      },
      defines: options.volumetricClouds ? { VS_CLOUD_VOLUME: '' } : {},
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });

    const domeGeometry = new THREE.SphereGeometry(1, 48, 32);
    this.domeMesh = new THREE.Mesh(domeGeometry, this.domeMaterial);
    this.domeMesh.name = 'sky';
    this.domeMesh.frustumCulled = false;
    this.domeMesh.renderOrder = -1000;
    this.domeMesh.matrixAutoUpdate = false;

    // The probe renders the same dome from the origin. Scaled well clear of the
    // cube camera's near plane so no face clips its own sky.
    this.probeMesh = new THREE.Mesh(domeGeometry, this.domeMaterial);
    this.probeMesh.frustumCulled = false;
    this.probeMesh.scale.setScalar(1000);
    this.probeScene.add(this.probeMesh);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /** Camera altitude in kilometres; shifts the sky-view LUT's origin. */
  setCameraAltitude(km: number): void {
    (this.skyViewMat.uniforms.uCameraAltitude as THREE.IUniform).value = km;
  }

  /** Bakes the sun-independent LUTs and the cloud field. Call once. */
  bakeStatic(): void {
    const prev = this.renderer.getRenderTarget();
    this.renderPass(this.transmittanceMat, this.transmittanceRT);
    this.renderPass(this.cloudMat, this.cloudRT);
    this.renderer.setRenderTarget(prev);
  }

  /**
   * Re-renders the sun-dependent LUTs. `force` bypasses the movement threshold.
   * Returns true when the sky actually changed.
   */
  updateSun(sunDir: THREE.Vector3, force = false): boolean {
    if (!force && this.lutsValid && this.lutSunDir.dot(sunDir) > 0.99985) return false;
    this.lutSunDir.copy(sunDir);
    this.lutsValid = true;
    const prev = this.renderer.getRenderTarget();
    this.renderPass(this.multiScatterMat, this.multiScatterRT);
    this.renderPass(this.skyViewMat, this.skyViewRT);
    this.renderer.setRenderTarget(prev);
    return true;
  }

  /** Renders the dome into a cubemap and PMREM-filters it into scene.environment. */
  updateEnvironment(scene: THREE.Scene): void {
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.probeScene, 0, 1, 4000);
    scene.environment = this.envTarget.texture;
    previous?.dispose();
  }

  setCameraPosition(position: THREE.Vector3): void {
    this.domeMesh.position.copy(position);
    this.domeMesh.scale.setScalar(1200);
    this.domeMesh.updateMatrix();
    this.domeMesh.updateMatrixWorld(true);
  }

  private renderPass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.transmittanceRT.dispose();
    this.multiScatterRT.dispose();
    this.skyViewRT.dispose();
    this.cloudRT.dispose();
    this.transmittanceMat.dispose();
    this.multiScatterMat.dispose();
    this.skyViewMat.dispose();
    this.cloudMat.dispose();
    this.domeMaterial.dispose();
    this.domeMesh.geometry.dispose();
    this.quad.geometry.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
  }
}

export { ATMOSPHERE };
