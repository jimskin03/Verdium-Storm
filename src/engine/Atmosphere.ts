import * as THREE from 'three';
import { Phase, type EngineContext, type System } from './System';
import { provide, type EnvironmentService } from './Services';
import { SkyRenderer } from '@/shaders/sky/SkyRenderer';
import { GroundOcclusion } from '@/shaders/sky/GroundOcclusion';
import { evaluateSky } from '@/shaders/sky/skyCpu';
import {
  detectSoftwareRenderer,
  excludeFromPatching,
  installChunkOverrides,
  patchScene,
  shaderConfig,
  skyState,
  skyUniforms,
} from '@/shaders/sky/SceneShaders';

/**
 * Atmosphere: sky, sun, aerial perspective and image-based lighting.
 *
 * The heavy lifting lives in `src/shaders/sky` — this class is the engine-side
 * conductor. Per frame it does almost nothing: scroll the cloud deck, park the
 * dome on the camera, and walk the scene once to splice the shared atmosphere
 * uniforms into any material another stream has just created.
 *
 * Everything expensive is keyed off sun movement instead of off the frame:
 *
 *   sun moves ~1°   → scattering LUTs re-rendered (three small fullscreen passes)
 *   sun moves ~2°   → terrain sun-visibility field re-marched
 *   sun moves ~6°   → sky re-filtered through PMREM into `scene.environment`
 *
 * With a static sun the steady-state cost is one dome draw call.
 *
 * ## What other streams get
 *
 * `EnvironmentService` (sun direction/colour/intensity, time of day, horizon
 * tint) plus two global side effects every lit surface picks up for free:
 * `scene.environment`, so PBR materials finally have ambient specular, and the
 * material patch in `SceneShaders`, which adds height-layered aerial
 * perspective and routes the sun's shadow lookups through the cascades that
 * `Lighting` fits.
 */

/** Sun elevation at local noon. Below vertical so shadows always have length. */
const NOON_ELEVATION = 1.082; // 62°
/** Time of day at which the sun crosses the horizon, rising and setting. */
const SUNRISE_T = 0.235;
const SUNSET_T = 0.805;

/** Reference camera altitude for the sky model, in kilometres. */
const BASE_ALTITUDE_KM = 0.06;

/**
 * Scene radiance scale.
 *
 * The scattering model works in units where solar irradiance at the top of the
 * atmosphere is 1, which puts a clear zenith around 0.025 — far too dark for a
 * renderer tone mapping at exposure 1.0. This is the single stop that lifts sun,
 * sky, aerial perspective and IBL together, so their ratios stay physical.
 * Tone mapping itself belongs to the post stack; this is scene-referred gain.
 */
const SCENE_EXPOSURE = 5.2;

/** Direction the cloud deck drifts, and how fast, in world units per second. */
const WIND = new THREE.Vector2(0.82, 0.57).normalize();
const WIND_SPEED = 11;

const V_EAST = new THREE.Vector3(1, 0, 0);

export class Atmosphere implements System, EnvironmentService {
  readonly name = 'atmosphere';
  readonly phase = Phase.ENVIRONMENT;

  // --- EnvironmentService -------------------------------------------------
  readonly sunDirection = new THREE.Vector3(0.42, 0.62, 0.35).normalize();
  readonly sunColor = new THREE.Color(1, 0.94, 0.86);
  readonly horizonColor = new THREE.Color(0x9fb6c4);
  sunIntensity = 4.6;
  timeOfDay = 0.36;

  /**
   * Real seconds for one full day. 0 freezes the clock, which is the default:
   * the review harness compares screenshots across runs, and that only means
   * anything if the sun is where it was last time. `?day=<minutes>` starts it.
   */
  dayLengthSeconds = 0;

  private ctx!: EngineContext;
  private sky!: SkyRenderer;
  private ground!: GroundOcclusion;
  private fog!: THREE.FogExp2;

  private readonly moonDirection = new THREE.Vector3(0, -1, 0);
  /** Sun direction at the last full environment (PMREM) refresh. */
  private readonly envSunDir = new THREE.Vector3(0, -1, 0);
  private readonly tmpColor = new THREE.Color();

  private night = 0;
  private skyGain = SCENE_EXPOSURE;
  private frame = 0;
  private appliedTime = Number.NaN;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    const { scene, renderer, quality } = ctx;

    const params = new URLSearchParams(location.search);
    const day = Number(params.get('day'));
    if (Number.isFinite(day) && day > 0) this.dayLengthSeconds = day * 60;
    const tod = Number(params.get('tod'));
    if (Number.isFinite(tod) && params.has('tod')) this.timeOfDay = tod;

    const software = detectSoftwareRenderer(renderer);

    // Shader feature set has to be settled before any material compiles: the
    // cascade count becomes a #define, and a material patched with the wrong
    // one would index past the shadow map array.
    shaderConfig.cascades = Math.max(1, Math.min(4, quality.shadowCascades));
    const taps = quality.pcssSamples > 0 ? quality.pcssSamples : 8;
    shaderConfig.pcfTaps = software ? Math.min(taps, 10) : taps;
    shaderConfig.blockerTaps = Math.max(4, Math.round(shaderConfig.pcfTaps * 0.5));
    shaderConfig.lightShafts = quality.volumetricLight;
    installChunkOverrides();

    this.sky = new SkyRenderer(renderer, { volumetricClouds: quality.volumetricClouds });
    // The dome writes its own sky; splicing aerial perspective into it would
    // fog the sky with itself, and its uniform names would collide.
    excludeFromPatching(this.sky.domeMesh.material as THREE.Material);
    this.sky.bakeStatic();
    scene.add(this.sky.domeMesh);

    this.ground = new GroundOcclusion(renderer);

    this.configureFog();
    this.configureClouds(quality.volumetricClouds, software);

    skyUniforms.uCsmParams.value.set(0.14, 3.0, 0.02);
    skyUniforms.uRidge.value.set(0.032, 0.42, 0.86, 0);
    skyUniforms.uDomeParams.value.set(26, 0.55, 1.0, 0);
    skyUniforms.uSkyParams.value.y = BASE_ALTITUDE_KM;

    // Fallback for anything this stream does not patch (raw shader materials
    // owned by other streams read `scene.fog` directly).
    this.fog = new THREE.FogExp2(0x93a9b8, 0.0011);
    scene.fog = this.fog;
    scene.environmentIntensity = 1.0;

    this.applyTime(true);
    patchScene(scene);

    provide('environment', this);
  }

  update(dt: number, elapsed: number): void {
    if (this.dayLengthSeconds > 0 && dt > 0) {
      this.timeOfDay = (this.timeOfDay + dt / this.dayLengthSeconds) % 1;
    }
    this.applyTime(false);

    // Clouds drift in tile space; the dome and the ground shadow read the same
    // offset, so a shadow always sits under the cloud that casts it.
    const tile = skyUniforms.uCloudParams.value.x;
    const wind = skyUniforms.uCloudWind.value;
    wind.x = (WIND.x * WIND_SPEED * elapsed) / tile;
    wind.y = (WIND.y * WIND_SPEED * elapsed) / tile;

    const camera = this.ctx.camera;
    skyUniforms.uCameraPos.value.copy(camera.position);
    this.sky.setCameraPosition(camera.position);
  }

  lateUpdate(): void {
    // Other streams build meshes lazily, so the scene has to be re-walked; the
    // patch itself is a WeakSet hit for everything already seen.
    this.frame++;
    if (this.frame < 4 || this.frame % 12 === 0) patchScene(this.ctx.scene);
  }

  dispose(): void {
    this.ctx?.scene.remove(this.sky.domeMesh);
    if (this.ctx) this.ctx.scene.environment = null;
    this.sky?.dispose();
    this.ground?.dispose();
  }

  // -------------------------------------------------------------------------
  // Sun path
  // -------------------------------------------------------------------------

  /**
   * Hour angle for a time of day, 0 at sunrise and π at sunset.
   *
   * Day and night are stretched to different fractions of the cycle rather than
   * splitting it evenly. Daylight owns 57% of the clock, which puts the golden
   * hour where the shot presets expect it (0.79 is a 4° sun) and keeps `0.25 /
   * 0.5 / 0.75` reading as morning / noon / late afternoon as the service
   * contract documents.
   */
  private hourAngle(t: number): number {
    const w = ((t % 1) + 1) % 1;
    if (w >= SUNRISE_T && w <= SUNSET_T) {
      return ((w - SUNRISE_T) / (SUNSET_T - SUNRISE_T)) * Math.PI;
    }
    const nightSpan = 1 - (SUNSET_T - SUNRISE_T);
    const into = w > SUNSET_T ? w - SUNSET_T : w + (1 - SUNSET_T);
    return Math.PI + (into / nightSpan) * Math.PI;
  }

  /**
   * The sun rides a great circle through due east and due west whose midpoint
   * sits `NOON_ELEVATION` above the southern horizon — a real solar arc for a
   * mid-latitude site, which is what gives the terrain a consistent lit face
   * and a consistent shadow side all day.
   */
  private solveSunDirection(t: number): void {
    const theta = this.hourAngle(t);
    const s = Math.sin(theta);
    this.sunDirection.set(
      Math.cos(theta),
      s * Math.sin(NOON_ELEVATION),
      s * Math.cos(NOON_ELEVATION),
    );

    // The moon trails the anti-sun point, offset so it is never exactly full
    // and the dome's phase term has something to draw.
    this.moonDirection.copy(this.sunDirection).negate().applyAxisAngle(V_EAST, 0.42);
    this.moonDirection.y += 0.12;
    this.moonDirection.normalize();
  }

  // -------------------------------------------------------------------------
  // Sun-driven refresh
  // -------------------------------------------------------------------------

  private applyTime(force: boolean): void {
    if (!force && this.timeOfDay === this.appliedTime) return;
    this.appliedTime = this.timeOfDay;

    this.solveSunDirection(this.timeOfDay);
    skyUniforms.uSunDir.value.copy(this.sunDirection);
    skyUniforms.uMoonDir.value.copy(this.moonDirection);

    // Scattering LUTs first: everything below reads their model.
    const skyChanged = this.sky.updateSun(this.sunDirection, force);
    if (!skyChanged && !force) return;

    this.refreshLighting();
    this.ground.update(this.sunDirection, force);

    // The probe is the one genuinely expensive step, so it runs on a much
    // coarser threshold than the LUTs — ~6° of sun travel.
    if (force || this.envSunDir.dot(this.sunDirection) < 0.995) {
      this.envSunDir.copy(this.sunDirection);
      this.sky.updateEnvironment(this.ctx.scene);
    }
  }

  /** Derives every CPU-side light and colour from the current sun position. */
  private refreshLighting(): void {
    const sample = evaluateSky(this.sunDirection, BASE_ALTITUDE_KM);
    const t = sample.sunTransmittance;
    const peak = Math.max(t.r, t.g, t.b);

    this.night = THREE.MathUtils.smoothstep(-this.sunDirection.y, -0.045, 0.085);

    // Exposure compensation, the way a camera would: a 4° sun delivers a third
    // of the irradiance of a noon sun, and metering for it is the difference
    // between a golden hour and an underexposed one. Applied to the sky gain and
    // the key together so their ratio — and therefore the contrast — is intact.
    const comp = THREE.MathUtils.clamp(0.92 / Math.pow(Math.max(peak, 0.05), 0.55), 1, 2.9);
    this.skyGain = SCENE_EXPOSURE * comp;
    skyUniforms.uSkyParams.value.x = this.skyGain;
    skyUniforms.uSkyParams.value.z = this.night;
    skyUniforms.uSkyParams.value.w = this.night;

    // Solar radiance drives the disc, the aureole and the lit face of clouds.
    skyUniforms.uSunRadiance.value.set(t.r, t.g, t.b).multiplyScalar(this.skyGain);

    const sunLevel = peak * this.skyGain;
    if (peak > 1e-4) {
      this.sunColor.setRGB(t.r / peak, t.g / peak, t.b / peak);
    }
    this.sunIntensity = sunLevel;

    // Key light: the sun by day, the moon once the sun is properly down. The
    // handover is a lerp so nothing pops as the terminator passes.
    const moonLevel = 0.055 * this.skyGain;
    skyState.keyDirection.copy(this.sunDirection).lerp(this.moonDirection, this.night).normalize();
    skyState.keyColor.copy(this.sunColor).lerp(skyUniforms.uMoonColor.value, this.night);
    skyState.keyIntensity = THREE.MathUtils.lerp(sunLevel, moonLevel, this.night);

    // Sky fill from the anti-sun side, at the elevation where the sky is
    // brightest away from the sun. Colour is the measured hemispheric average,
    // so it is blue at noon and violet at dusk rather than a fixed tint.
    const avg = sample.average;
    const fillPeak = Math.max(avg.r, avg.g, avg.b, 1e-5);
    skyState.fillColor.setRGB(avg.r / fillPeak, avg.g / fillPeak, avg.b / fillPeak);
    skyState.fillDirection.set(-this.sunDirection.x, 0, -this.sunDirection.z);
    if (skyState.fillDirection.lengthSq() < 1e-6) skyState.fillDirection.set(0, 0, 1);
    skyState.fillDirection.normalize().multiplyScalar(0.78);
    skyState.fillDirection.y = 0.62;
    skyState.fillDirection.normalize();
    // The probe already carries most of the sky's contribution; this only fills
    // the directional bias the diffuse SH cannot express.
    skyState.fillIntensity = fillPeak * this.skyGain * Math.PI * 0.55;

    // Ground bounce: sunlight off the terrain, tinted by its albedo, arriving
    // from below. This is what keeps shadowed undersides from going flat grey.
    skyState.bounceDirection
      .set(-this.sunDirection.x * 0.55, -0.8, -this.sunDirection.z * 0.55)
      .normalize();
    skyState.bounceColor.setRGB(
      this.sunColor.r * 0.42,
      this.sunColor.g * 0.34,
      this.sunColor.b * 0.22,
    );
    const bounceScale = Math.max(this.sunDirection.y, 0) * (1 - this.night);
    skyState.bounceIntensity = sunLevel * 0.14 * bounceScale;

    skyState.skyColor.copy(skyState.fillColor);
    skyState.night = this.night;
    skyState.revision++;

    // Published colours are display referred: the HUD, the minimap and the
    // water's fallback sky all want "what the horizon looks like", not radiance.
    this.toDisplay(sample.horizon, this.horizonColor);
    this.fog.color.copy(this.horizonColor);

    // Clouds stop casting once there is no sun to block.
    skyUniforms.uCloudWind.value.z = this.cloudShadowStrength * (1 - this.night);
  }

  private cloudShadowStrength = 0.5;

  /** Reinhard + gamma: a stand-in for the grade, good enough for UI matching. */
  private toDisplay(src: THREE.Color, out: THREE.Color): THREE.Color {
    const g = this.skyGain;
    const map = (v: number): number => {
      const x = Math.max(0, v * g);
      return Math.pow(x / (1 + x), 1 / 2.2);
    };
    return out.setRGB(map(src.r), map(src.g), map(src.b));
  }

  // -------------------------------------------------------------------------
  // Static configuration
  // -------------------------------------------------------------------------

  /**
   * Aerial perspective.
   *
   * Two exponential layers: a deep haze with a 300 m scale height that does the
   * distance work, and a shallow 34 m mist that pools in the valleys. Extinction
   * is per channel and biased blue, which is what actually sells depth — the far
   * range does not just get paler, it gets bluer. Terrain now runs out to 5120
   * units while the playfield is 1024, so the boundary term adds a second dose
   * past 1300 units to make sure the outer massif reads as distance rather than
   * as painted cardboard.
   */
  private configureFog(): void {
    skyUniforms.uFogA.value.set(0.00132, 1 / 300, 0.006, 1 / 34);
    skyUniforms.uFogExt.value.set(0.72, 0.94, 1.42);
    skyUniforms.uFogB.value.set(1.0, 1300, 1.45, 0.85);
  }

  private configureClouds(volumetric: boolean, software: boolean): void {
    // Tile, coverage, deck altitude, deck thickness.
    skyUniforms.uCloudParams.value.set(2600, 0.56, 1150, volumetric ? 340 : 220);
    this.cloudShadowStrength = software ? 0.42 : 0.5;
    skyUniforms.uCloudWind.value.set(0, 0, this.cloudShadowStrength, 1.0);
  }
}

export default Atmosphere;
