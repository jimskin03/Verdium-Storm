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

/**
 * Illuminance a flat, up-facing surface receives at local noon, in the same
 * units `refreshLighting` accumulates. Golden-hour metering is expressed as a
 * ratio against this, so it is a measurement of the rig rather than a taste
 * constant — if the light rig changes, re-measure rather than re-tune.
 */
const NOON_GROUND_LUX = 5.5;

/** Hemisphere-light floor, mirrored from `Lighting` so metering sees the whole rig. */
const AMBIENT_FLOOR = 0.35;

/**
 * How far the key is pulled back toward the illuminant white at a horizon sun.
 * 0 records the raw beam (physically exact, renders as a monochrome red wash);
 * 1 would discard the warmth entirely.
 */
const KEY_ADAPTATION = 0.55;

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
  sceneExposure = 1;
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
    // owned by other streams read `scene.fog` directly). The density is fitted
    // so FogExp2's squared-distance curve crosses the patched materials' haze at
    // ~1 km; it has to move whenever `uFogA.x` does, or water and terrain
    // disagree about where the horizon is. FogExp2 is quadratic in distance
    // where the patched haze is linear, so it tracks `sqrt` of the density
    // change: halving `uFogA` moves this by 1/sqrt(2).
    this.fog = new THREE.FogExp2(0x93a9b8, 0.00055);
    scene.fog = this.fog;
    scene.environmentIntensity = 1.0;

    this.applyTime(true);
    patchScene(scene);

    // Diagnostic surface for tools/probe.mjs. The atmosphere's uniforms are the
    // one part of the render that cannot be reached from `window.VS` (they live
    // in a module-scope object, spliced into materials by reference), and every
    // colour question about this stream is answered by toggling them live.
    if (new URLSearchParams(location.search).has('harness')) {
      (window as unknown as Record<string, unknown>).VS_ATMO = { skyUniforms, skyState, fog: this.fog };
    }

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

    // How far into golden hour we are: 0 with the sun well up, 1 at the horizon.
    // Several terms below key off this, because a 4° sun is not merely a dimmer
    // noon — the sky takes over as the dominant source and the beam goes red.
    const lowSun = 1 - THREE.MathUtils.smoothstep(this.sunDirection.y, 0.03, 0.40);

    // Chromatic adaptation. The direct beam really is this red at 4° — but an
    // eye, and a camera's white balance, adapt to the dominant illuminant rather
    // than recording it raw. Without this the key multiplies straight through
    // albedo, and anything low in red (foliage, blue livery) goes black while
    // the sky above it stays a perfectly exposed gold.
    if (peak > 1e-4) {
      const adapt = KEY_ADAPTATION * lowSun;
      this.sunColor.setRGB(
        THREE.MathUtils.lerp(t.r / peak, 1, adapt),
        THREE.MathUtils.lerp(t.g / peak, 1, adapt),
        THREE.MathUtils.lerp(t.b / peak, 1, adapt),
      );
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
    //
    // The weight climbs as the sun drops. A hemispheric *average* understates
    // the low-sun sky badly: the bright band sits near the horizon, exactly
    // where it rakes across vertical surfaces, and with the beam contributing
    // almost nothing at grazing incidence the sky is what is actually lighting
    // the scene. Holding the noon weight here is what left golden hour black.
    skyState.fillIntensity = fillPeak * this.skyGain * Math.PI * (0.55 + 0.85 * lowSun);

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

    // Meter the frame on the ground, not on the sky.
    //
    // At a 4° sun a flat surface collects cos(86°) — about 7% — of the beam, so
    // ground illuminance falls to roughly a fifth of noon while the sky, seen
    // directly, gets *brighter*. Left alone the tone mapper is driven by the sky
    // and the landscape crushes to black. This opens the stop the way a
    // photographer metering for the subject would, partially (the 0.42 exponent)
    // so evening still reads darker than midday, and clamped so night stays night.
    const groundLux =
      sunLevel * Math.max(this.sunDirection.y, 0) +
      skyState.fillIntensity +
      skyState.bounceIntensity +
      AMBIENT_FLOOR;
    this.sceneExposure = THREE.MathUtils.clamp(
      Math.pow(NOON_GROUND_LUX / Math.max(groundLux, 0.05), 0.42),
      1,
      1.85,
    );

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
   *
   * The densities have come down twice now, and both moves were consequences of
   * fixes rather than taste changes — this term is only ever meaningful relative
   * to the two things it is measured against.
   *
   * First, against the inscatter colour. They were originally fitted while
   * aerial perspective read the sky-view LUT's below-horizon rows, which hold
   * the planet's ground albedo, so the veil was both tan and unnaturally dark. A
   * dark inscatter buys density for free — you can pile on optical depth before
   * the image looks hazy — so once `vsSkyLookup` was clamped to the horizon they
   * had to halve.
   *
   * Second, against the light reaching shaded ground. `skyCpu` was returning
   * radiances ~1e5 low, which left `fillIntensity` at 3e-5 — the sky fill light
   * was off. Shadowed terrain was therefore lit by almost nothing, and this fog
   * was the only thing in front of it, so shaded ground rendered as ~90% sky
   * inscatter: a saturated blue that read as water. With the fill restored the
   * surface is back to roughly a fifth of its sunlit value, and the veil that
   * used to sit on top of near-black now has to sit on top of that instead.
   * Halved again to keep the same veil-to-surface ratio.
   *
   * For scale: the model's own sea-level extinction is ~4.2e-5/m in blue, so
   * even at 1.5e-3 total this air is ~35x thicker than the atmosphere whose
   * radiance it inscatters. That exaggeration is deliberate — a 1 km playfield
   * needs visible depth cueing — but it is why the near field is so sensitive
   * here, and why density and inscatter brightness must be tuned as a pair.
   */
  private configureFog(): void {
    skyUniforms.uFogA.value.set(0.00032, 1 / 300, 0.0012, 1 / 34);
    skyUniforms.uFogExt.value.set(0.72, 0.94, 1.42);
    skyUniforms.uFogB.value.set(1.0, 1300, 1.7, 0.85);
  }

  private configureClouds(volumetric: boolean, software: boolean): void {
    // Tile, coverage, deck altitude, deck thickness.
    skyUniforms.uCloudParams.value.set(2600, 0.56, 1150, volumetric ? 340 : 220);
    this.cloudShadowStrength = software ? 0.42 : 0.5;
    skyUniforms.uCloudWind.value.set(0, 0, this.cloudShadowStrength, 1.0);
  }
}

export default Atmosphere;
