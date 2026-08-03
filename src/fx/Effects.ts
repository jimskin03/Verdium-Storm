import * as THREE from 'three';
import { provide, tryGet, type EffectsService } from '@/engine/Services';
import { Phase, type EngineContext, type QualityTier, type System } from '@/engine/System';
import { WATER_LEVEL, heightAt, isWater } from '@/world/Heightfield';
import { clamp, makeRng } from '@/util/Noise';
import { PFLAG, ParticleSystem } from './ParticleSystem';
import { RAMP, SPRITE, createGroundTexture, createRampTexture, createSpriteArray } from './FxTextures';

/**
 * The combat effects system: every explosion, muzzle flash, tracer, impact,
 * plume, ember and heat shimmer in the game.
 *
 * Everything is authored as *stages* rather than as a single sprite burst. A
 * shell landing is a white flash with real light emission, a fireball that
 * cools white → yellow → orange → soot, a shock ring that scours outward across
 * the ground it is expanding over, a low dust skirt, ballistic debris that
 * bounces and settles, and a smoke column that keeps drifting downwind long
 * after the bang. That layering is what separates a detonation from a decal.
 *
 * Cost control has three levers, in order of how often they bite:
 *
 *  1. `density` — a flat per-tier multiplier on every particle count.
 *  2. `headroom` — a live feedback term. When the pool is filling up, new
 *     effects are thinned rather than allowed to saturate it, so the effect the
 *     player is looking at never gets evicted by the twenty behind it.
 *  3. Pool capacity — a hard ceiling on instances, so a runaway caller costs
 *     draw time, never memory.
 *
 * Point lights are pre-allocated at init and never added or removed, only
 * re-aimed and faded. Adding a light to a three.js scene invalidates every
 * lit program in it; doing that per explosion would stall the frame for longer
 * than the explosion lasts.
 */

type ExplosionKind = 'shell' | 'rocket' | 'vehicle' | 'building' | 'nuke';
type ImpactKind = 'dirt' | 'metal' | 'stone' | 'water';

/** Particle count multiplier per tier. */
const DENSITY: Record<QualityTier, number> = { low: 0.24, medium: 0.5, high: 1.0, ultra: 1.3 };

/** Hard instance ceiling per tier — bounds memory and worst-case fill. */
const POOL: Record<QualityTier, number> = { low: 2200, medium: 5000, high: 9000, ultra: 13000 };

/** Live count the headroom governor aims to stay under. */
const SOFT_CAP: Record<QualityTier, number> = { low: 320, medium: 800, high: 1700, ultra: 2400 };

/** Dynamic point lights. Constant cost, so it stays small. */
const LIGHTS: Record<QualityTier, number> = { low: 0, medium: 2, high: 4, ultra: 4 };

/** Simultaneous lingering emitters (smoke columns, burning wrecks). */
const EMITTERS: Record<QualityTier, number> = { low: 4, medium: 10, high: 20, ultra: 26 };

/**
 * Per-kind detonation recipe. Counts are pre-density; `radius` scales the whole
 * event off the caller's `scale`, which the simulation derives from splash
 * radius or hull size.
 */
interface Profile {
  radius: number;
  flash: number;
  flashBright: number;
  fire: number;
  fireLife: number;
  fireRamp: number;
  smoke: number;
  smokeLife: number;
  smokeRamp: number;
  /** Ground-hugging dust skirt. */
  dust: number;
  dustRamp: number;
  debris: number;
  debrisRamp: number;
  sparks: number;
  embers: number;
  /** Shock ring radius multiplier; 0 disables the ring. */
  ring: number;
  /** Delayed cook-off detonations. */
  secondaries: number;
  /** Seconds of lingering smoke column left behind. */
  column: number;
  /** Seconds of burning wreckage (fire tongues, oily smoke, shimmer). */
  burn: number;
  light: number;
  lightColor: number;
}

const PROFILES: Record<ExplosionKind, Profile> = {
  shell: {
    radius: 1.0,
    flash: 2, flashBright: 16,
    fire: 9, fireLife: 0.62, fireRamp: RAMP.FIRE_HOT,
    smoke: 9, smokeLife: 3.4, smokeRamp: RAMP.SMOKE_DARK,
    dust: 10, dustRamp: RAMP.DUST,
    debris: 8, debrisRamp: RAMP.ROCK,
    sparks: 14, embers: 5,
    ring: 3.4, secondaries: 0, column: 1.1, burn: 0,
    light: 900, lightColor: 0xffb066,
  },
  rocket: {
    radius: 1.25,
    flash: 3, flashBright: 20,
    fire: 15, fireLife: 0.85, fireRamp: RAMP.FIRE_HOT,
    smoke: 14, smokeLife: 4.6, smokeRamp: RAMP.SMOKE_DARK,
    dust: 13, dustRamp: RAMP.DUST,
    debris: 10, debrisRamp: RAMP.ROCK,
    sparks: 20, embers: 9,
    ring: 4.2, secondaries: 1, column: 2.2, burn: 0,
    light: 1500, lightColor: 0xffa050,
  },
  vehicle: {
    radius: 1.45,
    flash: 3, flashBright: 22,
    fire: 18, fireLife: 1.05, fireRamp: RAMP.FIRE_HOT,
    smoke: 16, smokeLife: 6.0, smokeRamp: RAMP.OIL_SMOKE,
    dust: 12, dustRamp: RAMP.DUST,
    debris: 14, debrisRamp: RAMP.METAL,
    sparks: 26, embers: 14,
    ring: 4.6, secondaries: 3, column: 3.0, burn: 11,
    light: 2600, lightColor: 0xff9840,
  },
  building: {
    radius: 1.9,
    flash: 4, flashBright: 20,
    fire: 20, fireLife: 1.3, fireRamp: RAMP.FIRE_SOFT,
    smoke: 24, smokeLife: 8.5, smokeRamp: RAMP.SMOKE_DARK,
    dust: 26, dustRamp: RAMP.CONCRETE,
    debris: 22, debrisRamp: RAMP.CONCRETE,
    sparks: 18, embers: 16,
    ring: 6.0, secondaries: 4, column: 6.5, burn: 16,
    light: 4200, lightColor: 0xffa858,
  },
  nuke: {
    radius: 3.4,
    flash: 6, flashBright: 42,
    fire: 30, fireLife: 2.1, fireRamp: RAMP.FIRE_HOT,
    smoke: 34, smokeLife: 13.0, smokeRamp: RAMP.SMOKE_DARK,
    dust: 34, dustRamp: RAMP.DUST,
    debris: 26, debrisRamp: RAMP.ROCK,
    sparks: 34, embers: 26,
    ring: 11.0, secondaries: 6, column: 14.0, burn: 20,
    light: 16000, lightColor: 0xfff0cc,
  },
};

interface Emitter {
  kind: 'plume' | 'wreck' | 'ground';
  x: number;
  y: number;
  z: number;
  scale: number;
  until: number;
  span: number;
  /** Fractional emission accumulator; particles are whole, time is not. */
  acc: number;
  rate: number;
}

const scratchDir = new THREE.Vector3();
const TAU = Math.PI * 2;

export class Effects implements System, EffectsService {
  readonly name = 'effects';
  readonly phase = Phase.EFFECTS;

  private particles!: ParticleSystem;
  private sprites!: THREE.DataArrayTexture;
  private rampTex!: THREE.DataTexture;
  private groundTex!: THREE.DataTexture;

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;

  private density = 1;
  private softCap = 1700;
  private now = 0;

  private readonly rng = makeRng(0x7e51f0);

  private lights: THREE.PointLight[] = [];
  private lightT0: Float32Array = new Float32Array(0);
  private lightDur: Float32Array = new Float32Array(0);
  private lightPeak: Float32Array = new Float32Array(0);

  private emitters: Emitter[] = [];
  private emitterCap = 20;

  /** Deterministic self-firing demo loop; see `setShowcase`. */
  private showcase = false;
  private showcaseClock = 0;
  private showcaseStep = 0;
  private showcaseOrigin = new THREE.Vector3(0, 0, 0);
  private waterSpot: THREE.Vector3 | null = null;
  private rockets: Array<{ p: THREE.Vector3; v: THREE.Vector3; life: number }> = [];

  /** Live counters, surfaced through `debugStats` for the review harness. */
  private spent = { explosions: 0, flashes: 0, tracers: 0, impacts: 0, plumes: 0 };

  init(ctx: EngineContext): void {
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    const tier = ctx.quality.tier;
    this.density = DENSITY[tier] ?? 1;
    this.softCap = SOFT_CAP[tier] ?? 1700;
    this.emitterCap = EMITTERS[tier] ?? 20;

    // 256² sprites keep a full mip chain worth having; the low tiers cannot
    // afford the synthesis time or the memory and never see them large anyway.
    const spriteSize = tier === 'low' || tier === 'medium' ? 128 : 256;
    this.sprites = createSpriteArray(spriteSize);
    this.rampTex = createRampTexture(128);
    this.groundTex = createGroundTexture(256);

    this.particles = new ParticleSystem({
      maxParticles: Math.min(ctx.quality.maxParticles, POOL[tier] ?? 9000),
      spriteArray: this.sprites,
      ramp: this.rampTex,
      ground: this.groundTex,
    });
    this.particles.addTo(ctx.scene);
    this.particles.wind.set(2.1, 0, -1.35);
    this.particles.setNearFade(1.6, 7.0);
    this.syncFog();

    this.buildLights(LIGHTS[tier] ?? 0);

    if (new URLSearchParams(location.search).get('showcase') === 'vfx') this.setShowcase(true);

    provide('effects', this);
  }

  update(dt: number, elapsed: number): void {
    this.now = elapsed;
    this.particles.time = elapsed;

    this.syncEnvironment();
    if ((elapsed * 4) % 1 < dt * 4) this.syncFog();

    if (this.showcase) this.runShowcase(dt);

    this.updateEmitters(dt);
    this.updateLights();
    this.particles.update(elapsed);
  }

  dispose(): void {
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    this.particles?.lit.mesh.removeFromParent();
    this.particles?.emissive.mesh.removeFromParent();
    this.particles?.dispose();
    this.sprites?.dispose();
    this.rampTex?.dispose();
    this.groundTex?.dispose();
  }

  /* ==================================================================== *
   * EffectsService
   * ==================================================================== */

  explosion(position: THREE.Vector3, scale: number, kind: ExplosionKind = 'shell'): void {
    const profile = PROFILES[kind] ?? PROFILES.shell;
    const s = clamp(scale, 0.4, 16) * profile.radius;
    const x = position.x;
    const z = position.z;
    const gh = heightAt(x, z);
    const waterLevel = tryGet('terrain')?.waterLevel ?? WATER_LEVEL;
    // Keep the seat of the blast out of the ground: a detonation reported at a
    // unit's centre would otherwise bury half its fireball.
    const y = Math.max(position.y, gh + s * 0.22);

    if (isWater(x, z) && y < waterLevel + s * 0.9) {
      this.waterBurst(x, waterLevel, z, s * 1.5, true);
      this.flashStage(x, waterLevel + s * 0.4, z, s, 1, profile.flashBright * 0.4, RAMP.FLASH);
      this.addLight(x, waterLevel + s, z, profile.light * 0.35, 0xbfe2ff, 0.5, s * 9);
      this.spent.explosions++;
      return;
    }

    const head = this.headroom();
    const n = (base: number): number => Math.max(1, Math.round(base * this.density * head));
    const height = y - gh;
    const grounded = height < s * 1.5;

    this.flashStage(x, y, z, s, n(profile.flash), profile.flashBright, RAMP.FLASH);
    this.fireballStage(x, y, z, s, n(profile.fire), profile.fireLife, profile.fireRamp);
    this.sparkStage(x, y, z, s, n(profile.sparks), kind === 'vehicle' ? RAMP.METAL : RAMP.SPARK);
    this.emberStage(x, y, z, s, n(profile.embers));
    this.debrisStage(x, y, z, s, n(profile.debris), profile.debrisRamp);
    this.smokeStage(x, y, z, s, n(profile.smoke), profile.smokeLife, profile.smokeRamp);

    if (grounded) {
      if (profile.ring > 0) this.shockRing(x, gh, z, s * profile.ring, kind === 'nuke');
      this.dustSkirt(x, gh, z, s, n(profile.dust), profile.dustRamp);
    }

    // Cook-off. Each secondary is a small, delayed, offset fireball — the thing
    // that makes a burning vehicle keep detonating for a couple of seconds.
    const secondaries = Math.min(profile.secondaries, Math.round(profile.secondaries * head + 0.2));
    for (let i = 0; i < secondaries; i++) {
      const delay = 0.14 + this.rng() * (kind === 'nuke' ? 1.6 : 0.75);
      const a = this.rng() * TAU;
      const r = s * (0.25 + this.rng() * 0.85);
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      const sy = Math.max(heightAt(sx, sz) + s * 0.3, y + (this.rng() - 0.3) * s);
      this.delayedBurst(sx, sy, sz, s * (0.3 + this.rng() * 0.3), delay, profile.fireRamp);
    }

    if (profile.column > 0) {
      this.addEmitter('plume', x, gh + s * 0.3, z, s * 0.85, profile.column, 5.5);
    }
    if (profile.burn > 0) {
      this.addEmitter('wreck', x, gh + s * 0.15, z, s * 0.7, profile.burn, 7);
    }

    // Nukes get their own mushroom: a delayed cap that rises out of the stem
    // and then rolls over on itself.
    if (kind === 'nuke') this.mushroom(x, gh, z, s);

    this.addLight(x, y + s * 0.35, z, profile.light * (0.7 + s * 0.06), profile.lightColor,
      kind === 'nuke' ? 2.2 : 0.55, s * 14);
    this.spent.explosions++;
  }

  muzzleFlash(position: THREE.Vector3, direction: THREE.Vector3, scale: number): void {
    const s = clamp(scale, 0.3, 6);
    const head = this.headroom();
    const d = scratchDir.copy(direction);
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
    d.normalize();
    const x = position.x + d.x * s * 0.2;
    const y = position.y + d.y * s * 0.2;
    const z = position.z + d.z * s * 0.2;

    // The flare itself: a very short, very bright star that never survives long
    // enough to be examined, plus a hot core behind it.
    const p = this.particles;
    p.hot().at(x, y, z)
      .vel(d.x * s * 1.5, d.y * s * 1.5, d.z * s * 1.5)
      .life(0.07 + s * 0.012).size(s * 1.5, s * 3.4, 0.45).spin((this.rng() - 0.5) * 4)
      .physics(9, 0, 0).look(RAMP.FLASH, SPRITE.FLASH, 13 + s * 4, 0xfff0d2)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    p.hot().at(x + d.x * s * 0.5, y + d.y * s * 0.5, z + d.z * s * 0.5)
      .vel(d.x * s * 4, d.y * s * 4, d.z * s * 4)
      .life(0.1).size(s * 0.9, s * 2.2, 0.6)
      .physics(11, 0, 0).look(RAMP.FIRE_HOT, SPRITE.FIRE, 7 + s * 2, 0xffd9a0)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    // Unburnt propellant thrown down the bore.
    const sparks = Math.max(1, Math.round(3 * s * this.density * head));
    for (let i = 0; i < sparks; i++) {
      const spread = 0.34;
      const vx = d.x + (this.rng() - 0.5) * spread;
      const vy = d.y + (this.rng() - 0.5) * spread + 0.1;
      const vz = d.z + (this.rng() - 0.5) * spread;
      const speed = s * (10 + this.rng() * 22);
      p.hot().at(x, y, z).vel(vx * speed, vy * speed, vz * speed)
        .life(0.14 + this.rng() * 0.22).size(s * 0.16, s * 0.05, 1)
        .physics(2.4, -9, 0).stretch(5).look(RAMP.SPARK, SPRITE.SPARK, 6, 0xffd2a0)
        .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0).emit();
    }

    // Smoke puff: slow, lit, and drifting off the muzzle. This is what keeps a
    // firing line from looking like a strobe.
    const puffs = Math.max(1, Math.round(2 * s * this.density * head));
    for (let i = 0; i < puffs; i++) {
      const spread = 0.5;
      const speed = s * (2.2 + this.rng() * 3.4);
      p.soft().at(x + (this.rng() - 0.5) * s * 0.3, y + (this.rng() - 0.5) * s * 0.3, z + (this.rng() - 0.5) * s * 0.3)
        .vel((d.x + (this.rng() - 0.5) * spread) * speed,
             (d.y + (this.rng() - 0.5) * spread) * speed + 0.6,
             (d.z + (this.rng() - 0.5) * spread) * speed)
        .life(0.55 + this.rng() * 0.75 + s * 0.1)
        .size(s * 0.55, s * (2.3 + this.rng()), 0.55).spin((this.rng() - 0.5) * 1.4)
        .physics(2.1, 0.5, 0.35).look(RAMP.SMOKE_LIGHT, this.rng() < 0.5 ? SPRITE.SMOKE_A : SPRITE.SMOKE_WISP,
          0.55, 0xb8b2a6)
        .soft(2.0).wind(0.8).emit();
    }

    this.addLight(x, y, z, 260 + s * 320, 0xffdca8, 0.09 + s * 0.02, 12 + s * 8);
    this.spent.flashes++;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number, speed: number): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return;
    const inv = 1 / dist;
    const v = Math.max(speed, 40);
    const life = clamp(dist / v, 0.03, 1.4);
    const p = this.particles;

    // Round: a stretched billboard whose smear is foreshortened in the shader,
    // so a shot coming at the camera reads as a dot rather than a streak.
    p.hot().at(from.x, from.y, from.z)
      .vel(dx * inv * v, dy * inv * v, dz * inv * v)
      .life(life).size(0.62, 0.5, 1)
      .stretch(11 + v * 0.006).look(RAMP.SPARK, SPRITE.STREAK, 9, color)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    // A dimmer, longer ghost behind it reads as the trail the round leaves in
    // the air; two layers is enough to sell the length.
    p.hot().at(from.x, from.y, from.z)
      .vel(dx * inv * v, dy * inv * v, dz * inv * v)
      .life(life * 1.25).size(0.42, 0.22, 1.4)
      .stretch(26).look(RAMP.SPARK, SPRITE.STREAK, 2.4, color)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    // Terminal flash at the far end, timed to arrival.
    p.hot().at(to.x, to.y, to.z).vel(0, 0.4, 0)
      .life(0.1).size(0.9, 2.4, 0.5).delay(life)
      .physics(6, 0, 0).look(RAMP.FLASH, SPRITE.FLASH, 6, color)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    this.spent.tracers++;
  }

  impact(position: THREE.Vector3, normal: THREE.Vector3, kind: ImpactKind): void {
    const nx = normal.x;
    const ny = normal.y || 1;
    const nz = normal.z;
    const len = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / len;
    const uy = ny / len;
    const uz = nz / len;
    const x = position.x;
    const y = position.y;
    const z = position.z;
    const head = this.headroom();
    const n = (base: number): number => Math.max(1, Math.round(base * this.density * head));
    const p = this.particles;

    if (kind === 'water') {
      this.waterBurst(x, y, z, 1.6, false);
      this.spent.impacts++;
      return;
    }

    // Every surface gets a hit flash; the colour is the whole tell.
    const flashTint = kind === 'metal' ? 0xd8e6ff : kind === 'stone' ? 0xfff0d8 : 0xffd8a0;
    p.hot().at(x + ux * 0.2, y + uy * 0.2, z + uz * 0.2).vel(ux * 2, uy * 2, uz * 2)
      .life(0.08).size(0.7, 1.9, 0.5).physics(8, 0, 0)
      .look(RAMP.FLASH, SPRITE.FLASH, kind === 'metal' ? 9 : 4.5, flashTint)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    if (kind === 'metal') {
      // A cone of white-hot spall that cools to red on the way down.
      for (let i = 0; i < n(14); i++) {
        const a = this.rng() * TAU;
        const spread = 0.55 + this.rng() * 0.6;
        const speed = 9 + this.rng() * 26;
        p.hot().at(x, y, z)
          .vel((ux + Math.cos(a) * spread) * speed, (uy + this.rng() * 0.5) * speed,
               (uz + Math.sin(a) * spread) * speed)
          .life(0.3 + this.rng() * 0.6).size(0.2, 0.05, 1)
          .physics(1.1, -17, 0).stretch(7).look(RAMP.METAL, SPRITE.SPARK, 7, 0xffffff)
          .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0).emit();
      }
      for (let i = 0; i < n(2); i++) {
        p.soft().at(x, y, z).vel(ux * 2.4, uy * 2.4 + 1, uz * 2.4)
          .life(0.9 + this.rng() * 0.6).size(0.5, 2.0, 0.6)
          .physics(2.0, 0.4, 0.3).look(RAMP.SMOKE_LIGHT, SPRITE.SMOKE_WISP, 0.5, 0x9c9890)
          .soft(1.6).wind(0.8).emit();
      }
    } else if (kind === 'stone') {
      for (let i = 0; i < n(5); i++) {
        const a = this.rng() * TAU;
        const spread = 0.5 + this.rng() * 0.8;
        const speed = 5 + this.rng() * 14;
        p.soft().at(x, y, z)
          .vel((ux + Math.cos(a) * spread) * speed, (uy + 0.5 + this.rng()) * speed * 0.7,
               (uz + Math.sin(a) * spread) * speed)
          .life(1.4 + this.rng() * 1.6).size(0.24 + this.rng() * 0.2, 0.2, 1)
          .spin((this.rng() - 0.5) * 12).physics(0, -20, 0)
          .look(RAMP.ROCK, SPRITE.DEBRIS, 1.0, 0xd8cfc0)
          .flags(PFLAG.BOUNCE | PFLAG.NO_SOFT).wind(0).emit();
      }
      for (let i = 0; i < n(6); i++) {
        const a = this.rng() * TAU;
        const speed = 2.5 + this.rng() * 6;
        p.soft().at(x, y, z)
          .vel((ux + Math.cos(a) * 0.7) * speed, (uy + 0.6) * speed * 0.6, (uz + Math.sin(a) * 0.7) * speed)
          .life(0.9 + this.rng() * 1.1).size(0.5, 2.6 + this.rng() * 1.4, 0.55)
          .spin((this.rng() - 0.5) * 1.6).physics(2.4, -0.4, 0.4)
          .look(RAMP.CONCRETE, SPRITE.DUST, 0.8, 0xe0dcd2).soft(1.8).wind(0.7).emit();
      }
      for (let i = 0; i < n(4); i++) {
        const a = this.rng() * TAU;
        const speed = 6 + this.rng() * 14;
        p.hot().at(x, y, z)
          .vel((ux + Math.cos(a) * 0.7) * speed, (uy + 0.4) * speed, (uz + Math.sin(a) * 0.7) * speed)
          .life(0.2 + this.rng() * 0.3).size(0.13, 0.04, 1)
          .physics(1.4, -16, 0).stretch(5).look(RAMP.SPARK, SPRITE.SPARK, 3.5, 0xffe0b0)
          .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0).emit();
      }
    } else {
      // Dirt: a short vertical plume with clods, and no sparks at all.
      for (let i = 0; i < n(9); i++) {
        const a = this.rng() * TAU;
        const spread = 0.35 + this.rng() * 0.7;
        const speed = 3.5 + this.rng() * 9;
        p.soft().at(x, y, z)
          .vel((ux + Math.cos(a) * spread) * speed, (uy + 1.1) * speed * 0.85,
               (uz + Math.sin(a) * spread) * speed)
          .life(1.1 + this.rng() * 1.3).size(0.6, 3.0 + this.rng() * 2.0, 0.5)
          .spin((this.rng() - 0.5) * 1.8).physics(2.2, -0.7, 0.45)
          .look(RAMP.DUST, this.rng() < 0.5 ? SPRITE.DUST : SPRITE.PLUME, 0.95, 0xd0b892)
          .soft(2.2).wind(0.8).emit();
      }
      for (let i = 0; i < n(4); i++) {
        const a = this.rng() * TAU;
        const speed = 4 + this.rng() * 11;
        p.soft().at(x, y, z)
          .vel(Math.cos(a) * speed * 0.6, (1.2 + this.rng()) * speed * 0.7, Math.sin(a) * speed * 0.6)
          .life(1.3 + this.rng() * 1.4).size(0.22 + this.rng() * 0.16, 0.18, 1)
          .spin((this.rng() - 0.5) * 10).physics(0, -21, 0)
          .look(RAMP.ROCK, SPRITE.DEBRIS, 0.9, 0xa08868)
          .flags(PFLAG.BOUNCE | PFLAG.NO_SOFT).wind(0).emit();
      }
    }
    this.spent.impacts++;
  }

  smokePlume(position: THREE.Vector3, scale: number, life: number): void {
    const s = clamp(scale, 0.3, 20);
    this.addEmitter('plume', position.x, position.y, position.z, s, clamp(life, 0.5, 90), 5);
    // Seed the column immediately so the first frame is not empty.
    this.plumePuff(position.x, position.y, position.z, s, 1);
    this.spent.plumes++;
  }

  /* ==================================================================== *
   * Extended API — beyond EffectsService, for callers that want it
   * ==================================================================== */

  /**
   * A continuous energy beam with a bloom-friendly core. Drawn as a run of
   * velocity-aligned billboards so it costs one draw call like everything else.
   */
  beam(from: THREE.Vector3, to: THREE.Vector3, color = 0x66ccff, width = 0.55, life = 0.16): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.6) return;
    const inv = 1 / dist;
    const ux = dx * inv;
    const uy = dy * inv;
    const uz = dz * inv;
    const segments = clamp(Math.ceil(dist / 14), 1, 14);
    const segLen = dist / segments;
    const p = this.particles;

    for (let i = 0; i < segments; i++) {
      const t = (i + 0.5) / segments;
      const cx = from.x + dx * t;
      const cy = from.y + dy * t;
      const cz = from.z + dz * t;
      // Drag this high pins the sprite in place while leaving the velocity
      // vector intact for the shader's stretch axis.
      for (let pass = 0; pass < 2; pass++) {
        const w = pass === 0 ? width : width * 3.1;
        p.hot().at(cx, cy, cz).vel(ux, uy, uz)
          .life(life * (pass === 0 ? 1 : 1.5)).size(w, w * 0.6, 1)
          .stretch(segLen / w).physics(240, 0, 0)
          .look(RAMP.PLASMA, pass === 0 ? SPRITE.STREAK : SPRITE.GLOW, pass === 0 ? 22 : 3.2, color)
          .flags(PFLAG.NO_SOFT).wind(0).emit();
      }
    }
    // Terminal bloom where the beam lands.
    p.hot().at(to.x, to.y, to.z).vel(0, 0, 0)
      .life(life * 2.2).size(width * 5, width * 11, 0.5)
      .look(RAMP.PLASMA, SPRITE.GLOW, 9, color).flags(PFLAG.NO_SOFT).wind(0).emit();
    this.addLight(to.x, to.y, to.z, 700, color, life * 2, 26);
  }

  /**
   * One frame of rocket exhaust. Intended to be called per frame by whatever
   * owns the projectile, with the motor's position and thrust axis.
   */
  exhaust(position: THREE.Vector3, direction: THREE.Vector3, scale = 1): void {
    const s = clamp(scale, 0.2, 6);
    const d = scratchDir.copy(direction);
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
    d.normalize();
    const p = this.particles;

    // Hot core straight out of the nozzle.
    p.hot().at(position.x, position.y, position.z)
      .vel(-d.x * s * 6, -d.y * s * 6, -d.z * s * 6)
      .life(0.13).size(s * 0.85, s * 0.25, 1.4)
      .physics(7, 0, 0).look(RAMP.FIRE_HOT, SPRITE.FIRE, 8, 0xffd6a0)
      .flags(PFLAG.NO_SOFT).wind(0).emit();

    // Condensing smoke that hangs in the air behind the flight path.
    p.soft().at(position.x - d.x * s * 0.6, position.y - d.y * s * 0.6, position.z - d.z * s * 0.6)
      .vel(-d.x * s * 2.2 + (this.rng() - 0.5) * 1.4, -d.y * s * 2.2 + 0.5,
           -d.z * s * 2.2 + (this.rng() - 0.5) * 1.4)
      .life(1.5 + this.rng() * 1.4).size(s * 0.7, s * (3.6 + this.rng() * 1.6), 0.5)
      .spin((this.rng() - 0.5) * 1.2).physics(1.4, 0.35, 0.4)
      .look(RAMP.SMOKE_LIGHT, this.rng() < 0.5 ? SPRITE.SMOKE_A : SPRITE.SMOKE_B, 0.7, 0xc8c2b6)
      .soft(2.4).wind(0.9).emit();

    if (this.rng() < 0.5) {
      p.hot().at(position.x, position.y, position.z)
        .vel(-d.x * s * 12 + (this.rng() - 0.5) * 6, -d.y * s * 12 + (this.rng() - 0.5) * 4,
             -d.z * s * 12 + (this.rng() - 0.5) * 6)
        .life(0.2 + this.rng() * 0.25).size(s * 0.15, s * 0.04, 1)
        .physics(1.6, -8, 0).stretch(6).look(RAMP.EMBER, SPRITE.SPARK, 4, 0xffb066)
        .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0).emit();
    }
  }

  /**
   * Dust thrown up by a moving vehicle. `speed` is the vehicle's ground speed,
   * used to scale how much is displaced.
   */
  vehicleDust(position: THREE.Vector3, heading: THREE.Vector3, speed: number, scale = 1): void {
    if (speed < 1.5) return;
    const head = this.headroom();
    if (this.rng() > 0.35 * head + 0.15) return;
    const gh = heightAt(position.x, position.z);
    const s = clamp(scale, 0.3, 4);
    const drift = clamp(speed * 0.12, 0.3, 3.2);
    this.particles.soft()
      .at(position.x + (this.rng() - 0.5) * s * 1.6, gh + 0.3, position.z + (this.rng() - 0.5) * s * 1.6)
      .vel(-heading.x * drift + (this.rng() - 0.5) * 1.2, 0.7 + this.rng() * 0.8,
           -heading.z * drift + (this.rng() - 0.5) * 1.2)
      .life(1.4 + this.rng() * 1.6).size(s * 1.1, s * (4.5 + this.rng() * 2.5), 0.55)
      .spin((this.rng() - 0.5) * 1.0).physics(1.6, -0.15, 0.3)
      .look(RAMP.DUST, SPRITE.DUST, 0.85, 0xc8b294)
      .soft(2.6).wind(0.95).emit();
  }

  /** Rising embers, for burning wreckage and forest fires. */
  embers(position: THREE.Vector3, scale = 1, count = 4): void {
    const s = clamp(scale, 0.2, 8);
    const n = Math.max(1, Math.round(count * this.density * this.headroom()));
    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      const r = this.rng() * s;
      this.particles.hot()
        .at(position.x + Math.cos(a) * r, position.y + this.rng() * s * 0.5, position.z + Math.sin(a) * r)
        .vel((this.rng() - 0.5) * 1.6, 1.6 + this.rng() * 3.4, (this.rng() - 0.5) * 1.6)
        .life(1.6 + this.rng() * 2.6).size(0.16 + this.rng() * 0.14, 0.05, 1.6)
        .physics(0.55, -0.5, 0.85).look(RAMP.EMBER, SPRITE.EMBER, 5.5, 0xffa040)
        .flags(PFLAG.FLICKER | PFLAG.NO_SOFT).wind(0.85).emit();
    }
  }

  /**
   * Heat shimmer. Without a screen-space refraction pass this is a very low
   * contrast, fast-scrolling additive haze — enough to read as rising heat over
   * a fire without pretending to be true distortion.
   */
  heatShimmer(position: THREE.Vector3, scale = 1, count = 2): void {
    const s = clamp(scale, 0.3, 10);
    const n = Math.max(1, Math.round(count * this.density * this.headroom()));
    for (let i = 0; i < n; i++) {
      this.particles.hot()
        .at(position.x + (this.rng() - 0.5) * s, position.y + this.rng() * s * 0.4,
            position.z + (this.rng() - 0.5) * s)
        .vel((this.rng() - 0.5) * 0.8, 3.4 + this.rng() * 2.6, (this.rng() - 0.5) * 0.8)
        .life(0.9 + this.rng() * 0.7).size(s * 1.2, s * 2.6, 0.7)
        .spin((this.rng() - 0.5) * 0.7).physics(1.1, 1.4, 1.1)
        .look(RAMP.HAZE, SPRITE.SHIMMER, 1.5, 0xfff2e0)
        .soft(1.5).wind(0.6).emit();
    }
  }

  /** Enables the deterministic self-firing demo loop used by the `vfx` preset. */
  setShowcase(on: boolean): void {
    this.showcase = on;
    if (!on) this.rockets.length = 0;
  }

  /** Live counts for the review harness and the HUD's debug overlay. */
  debugStats(): Record<string, number> {
    return {
      live: this.particles?.count ?? 0,
      emissive: this.particles?.emissive.count ?? 0,
      lit: this.particles?.lit.count ?? 0,
      emitters: this.emitters.length,
      lights: this.lights.length,
      ...this.spent,
    };
  }

  /* ==================================================================== *
   * Explosion stages
   * ==================================================================== */

  /** Stage 1 — the flash. Sub-tenth-of-a-second, and brighter than anything else. */
  private flashStage(x: number, y: number, z: number, s: number, count: number, bright: number, ramp: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const jitter = i === 0 ? 0 : s * 0.4;
      p.hot()
        .at(x + (this.rng() - 0.5) * jitter, y + (this.rng() - 0.5) * jitter * 0.6, z + (this.rng() - 0.5) * jitter)
        .vel(0, s * 0.6, 0)
        .life(0.075 + this.rng() * 0.07 + s * 0.008)
        .size(s * (1.1 + i * 0.5), s * (3.4 + i * 1.1), 0.42)
        .spin((this.rng() - 0.5) * 3)
        .physics(6, 0, 0)
        .look(ramp, i === 0 ? SPRITE.FLASH : SPRITE.GLOW, bright * (i === 0 ? 1 : 0.4), 0xfff4e0)
        .flags(PFLAG.NO_SOFT).wind(0).emit();
    }
  }

  /**
   * Stage 2 — the fireball. Several overlapping puffs at different sizes and
   * lifetimes, all riding the FIRE_HOT ramp, which is what carries the
   * white → yellow → orange → soot cooling.
   */
  private fireballStage(x: number, y: number, z: number, s: number, count: number, life: number, ramp: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * TAU;
      const el = (this.rng() - 0.25) * 1.1;
      const r = s * (0.1 + this.rng() * 0.7);
      const speed = s * (1.6 + this.rng() * 4.2);
      const cool = 0.55 + this.rng() * 0.6;
      p.hot()
        .at(x + Math.cos(a) * r, y + el * r * 0.7, z + Math.sin(a) * r)
        .vel(Math.cos(a) * speed, speed * (0.35 + this.rng() * 0.8), Math.sin(a) * speed)
        .life(life * cool)
        .size(s * (0.5 + this.rng() * 0.5), s * (1.7 + this.rng() * 1.6), 0.62)
        .spin((this.rng() - 0.5) * 2.2)
        .physics(2.1, s * 0.5, s * 0.16)
        .look(ramp, this.rng() < 0.6 ? SPRITE.FIRE : SPRITE.SMOKE_B, 6.5 + this.rng() * 5, 0xffffff)
        .soft(s * 0.9).wind(0.35).emit();
    }
  }

  /** Stage 3 — the shock ring: a flat, ground-conforming annulus scouring outward. */
  private shockRing(x: number, gh: number, z: number, radius: number, big: boolean): void {
    const p = this.particles;
    p.hot().at(x, gh, z).vel(0, 0, 0)
      .life(big ? 0.85 : 0.42).size(radius * 0.25, radius, 0.42)
      .physics(0, 0, 0).look(RAMP.SHOCK, SPRITE.RING, big ? 6 : 3.2, 0xffffff)
      .flags(PFLAG.FLAT | PFLAG.NO_SOFT).wind(0).emit();
    // A second, slower ring of displaced dust chasing the pressure wave out.
    p.soft().at(x, gh, z).vel(0, 0, 0)
      .life(big ? 2.4 : 1.25).size(radius * 0.3, radius * 1.25, 0.5)
      .physics(0, 0, 0).look(RAMP.DUST, SPRITE.RING, 1.1, 0xd8c4a4)
      .flags(PFLAG.FLAT | PFLAG.NO_SOFT).wind(0).emit();
  }

  /** Stage 4 — the dust skirt: heavy, ground-hugging, and slow to settle. */
  private dustSkirt(x: number, gh: number, z: number, s: number, count: number, ramp: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rng() * 0.6;
      const speed = s * (2.4 + this.rng() * 3.6);
      p.soft()
        .at(x + Math.cos(a) * s * 0.4, gh + 0.4, z + Math.sin(a) * s * 0.4)
        .vel(Math.cos(a) * speed, 0.6 + this.rng() * 1.2, Math.sin(a) * speed)
        .life(1.8 + this.rng() * 2.4 + s * 0.12)
        .size(s * 0.8, s * (2.6 + this.rng() * 2.2), 0.55)
        .spin((this.rng() - 0.5) * 1.1)
        .physics(1.35, -0.25, 0.35)
        .look(ramp, this.rng() < 0.5 ? SPRITE.DUST : SPRITE.SMOKE_A, 0.95, 0xffffff)
        .flags(PFLAG.HUG).soft(s * 0.9 + 1.5).wind(0.9).emit();
    }
  }

  /** Stage 5 — ballistic debris that arcs, bounces and settles. */
  private debrisStage(x: number, y: number, z: number, s: number, count: number, ramp: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * TAU;
      const speed = s * (2.6 + this.rng() * 6.5);
      const up = s * (4.5 + this.rng() * 9);
      p.soft().at(x, y, z)
        .vel(Math.cos(a) * speed, up, Math.sin(a) * speed)
        .life(2.2 + this.rng() * 2.8)
        .size(s * (0.09 + this.rng() * 0.14), s * (0.07 + this.rng() * 0.1), 1)
        .spin((this.rng() - 0.5) * 14)
        .physics(0, -24, 0)
        .look(ramp, SPRITE.DEBRIS, 1.0, 0xffffff)
        .flags(PFLAG.BOUNCE | PFLAG.NO_SOFT).wind(0).emit();
    }
    // A handful of the chunks come off burning.
    const hot = Math.max(1, count >> 2);
    for (let i = 0; i < hot; i++) {
      const a = this.rng() * TAU;
      const speed = s * (2.2 + this.rng() * 5);
      p.hot().at(x, y, z)
        .vel(Math.cos(a) * speed, s * (3.5 + this.rng() * 7), Math.sin(a) * speed)
        .life(1.5 + this.rng() * 1.8)
        .size(s * 0.09, s * 0.03, 1).stretch(4)
        .physics(0.35, -16, 0.2)
        .look(RAMP.EMBER, SPRITE.EMBER, 5, 0xffb060)
        .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0.2).emit();
    }
  }

  /** Stage 6 — the spark shower. */
  private sparkStage(x: number, y: number, z: number, s: number, count: number, ramp: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * TAU;
      const el = this.rng() * 1.4 - 0.25;
      const speed = s * (6 + this.rng() * 22);
      const ce = Math.cos(el);
      p.hot().at(x, y, z)
        .vel(Math.cos(a) * ce * speed, Math.sin(el) * speed, Math.sin(a) * ce * speed)
        .life(0.35 + this.rng() * 0.85)
        .size(s * 0.11, s * 0.03, 1)
        .physics(0.9, -19, 0).stretch(7)
        .look(ramp, SPRITE.SPARK, 7, 0xffffff)
        .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0).emit();
    }
  }

  private emberStage(x: number, y: number, z: number, s: number, count: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * TAU;
      const r = this.rng() * s * 0.8;
      p.hot().at(x + Math.cos(a) * r, y + this.rng() * s * 0.4, z + Math.sin(a) * r)
        .vel((this.rng() - 0.5) * s * 1.2, s * (0.9 + this.rng() * 1.8), (this.rng() - 0.5) * s * 1.2)
        .life(1.4 + this.rng() * 2.8)
        .size(s * 0.06 + 0.08, 0.04, 1.5)
        .physics(0.6, -0.8, 0.9)
        .look(RAMP.EMBER, SPRITE.EMBER, 5, 0xffa848)
        .flags(PFLAG.FLICKER | PFLAG.NO_SOFT).wind(0.8).emit();
    }
  }

  /**
   * Stage 7 — the smoke column. Buoyant, drag-limited, turbulent and wind
   * entrained, so it rises into a leaning column instead of a rigid balloon.
   */
  private smokeStage(x: number, y: number, z: number, s: number, count: number, life: number, ramp: number): void {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * TAU;
      const r = this.rng() * s * 0.9;
      const t = i / Math.max(1, count - 1);
      p.soft()
        .at(x + Math.cos(a) * r, y + this.rng() * s * 0.6, z + Math.sin(a) * r)
        .vel(Math.cos(a) * s * (0.8 + this.rng()), s * (1.4 + this.rng() * 2.6), Math.sin(a) * s * (0.8 + this.rng()))
        .life(life * (0.55 + this.rng() * 0.75))
        .size(s * (0.7 + this.rng() * 0.6), s * (2.4 + this.rng() * 2.6), 0.62)
        .spin((this.rng() - 0.5) * 0.85)
        .delay(t * 0.5 + this.rng() * 0.2)
        .physics(0.62, s * 0.22, 0.55)
        .look(ramp, this.rng() < 0.5 ? SPRITE.SMOKE_A : SPRITE.SMOKE_B, 0.95, 0xffffff)
        .soft(s * 1.1 + 1.5).wind(1).emit();
    }
  }

  /** A small delayed fireball — cook-off, secondary detonation, collapsing floor. */
  private delayedBurst(x: number, y: number, z: number, s: number, delay: number, ramp: number): void {
    const p = this.particles;
    p.hot().at(x, y, z).vel(0, s * 1.2, 0)
      .life(0.1).size(s * 1.4, s * 3.4, 0.45).delay(delay)
      .physics(6, 0, 0).look(RAMP.FLASH, SPRITE.FLASH, 11, 0xfff0d0)
      .flags(PFLAG.NO_SOFT).wind(0).emit();
    for (let i = 0; i < 4; i++) {
      const a = this.rng() * TAU;
      const speed = s * (1.4 + this.rng() * 3);
      p.hot().at(x, y, z)
        .vel(Math.cos(a) * speed, speed * 0.9, Math.sin(a) * speed)
        .life(0.45 + this.rng() * 0.4).delay(delay)
        .size(s * 0.7, s * 2.4, 0.6).spin((this.rng() - 0.5) * 2)
        .physics(2.2, s * 0.6, s * 0.2).look(ramp, SPRITE.FIRE, 6, 0xffffff)
        .soft(s).wind(0.4).emit();
    }
    for (let i = 0; i < 5; i++) {
      const a = this.rng() * TAU;
      const speed = s * (5 + this.rng() * 14);
      p.hot().at(x, y, z)
        .vel(Math.cos(a) * speed, speed * (0.6 + this.rng()), Math.sin(a) * speed)
        .life(0.3 + this.rng() * 0.5).delay(delay)
        .size(s * 0.12, s * 0.03, 1).physics(0.9, -18, 0).stretch(6)
        .look(RAMP.SPARK, SPRITE.SPARK, 6, 0xffffff)
        .flags(PFLAG.NO_SOFT | PFLAG.FLICKER).wind(0).emit();
    }
  }

  /** A nuke's cap: a delayed torus of smoke that rises out of the stem and rolls over. */
  private mushroom(x: number, gh: number, z: number, s: number): void {
    const p = this.particles;
    const ring = Math.max(6, Math.round(16 * this.density));
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU;
      const r = s * 1.1;
      p.soft()
        .at(x + Math.cos(a) * r * 0.3, gh + s * 1.5, z + Math.sin(a) * r * 0.3)
        .vel(Math.cos(a) * s * 1.5, s * 4.5, Math.sin(a) * s * 1.5)
        .life(11 + this.rng() * 6)
        .size(s * 1.4, s * (4.5 + this.rng() * 2), 0.5)
        .spin((this.rng() - 0.5) * 0.5)
        .delay(0.5 + this.rng() * 0.9)
        .physics(0.4, s * 0.5, 0.7)
        .look(RAMP.SMOKE_DARK, SPRITE.SMOKE_B, 1.0, 0xffe8cc)
        .soft(s * 1.4).wind(0.7).emit();
    }
    // The stem.
    const stem = Math.max(4, Math.round(10 * this.density));
    for (let i = 0; i < stem; i++) {
      const t = i / stem;
      p.soft().at(x + (this.rng() - 0.5) * s, gh + 0.5, z + (this.rng() - 0.5) * s)
        .vel((this.rng() - 0.5) * s * 0.5, s * (3 + this.rng() * 2), (this.rng() - 0.5) * s * 0.5)
        .life(9 + this.rng() * 4).delay(t * 1.4)
        .size(s * 1.1, s * 3.0, 0.6).spin((this.rng() - 0.5) * 0.4)
        .physics(0.5, s * 0.35, 0.5)
        .look(RAMP.DUST, SPRITE.PLUME, 1.0, 0xffffff)
        .soft(s * 1.2).wind(0.8).emit();
    }
  }

  /** Water column, crown and mist. Shared by water impacts and water bursts. */
  private waterBurst(x: number, surface: number, z: number, s: number, heavy: boolean): void {
    const p = this.particles;
    const head = this.headroom();
    const n = (base: number): number => Math.max(1, Math.round(base * this.density * head));

    // Crown: a fan of vertical sheets rising from the entry point.
    for (let i = 0; i < n(heavy ? 8 : 4); i++) {
      const a = this.rng() * TAU;
      const r = s * (0.15 + this.rng() * 0.4);
      p.soft().at(x + Math.cos(a) * r, surface, z + Math.sin(a) * r)
        .vel(Math.cos(a) * s * (0.9 + this.rng()), s * (4 + this.rng() * 5), Math.sin(a) * s * (0.9 + this.rng()))
        .life(0.55 + this.rng() * 0.5)
        .size(s * 0.9, s * (1.8 + this.rng()), 0.7)
        .physics(1.2, -7, 0.2)
        .look(RAMP.WATER, SPRITE.SPLASH, 1.5, 0xffffff)
        .flags(PFLAG.NO_SOFT).wind(0.2).emit();
    }
    // Droplets.
    for (let i = 0; i < n(heavy ? 16 : 7); i++) {
      const a = this.rng() * TAU;
      const speed = s * (2 + this.rng() * 6);
      p.soft().at(x, surface + 0.2, z)
        .vel(Math.cos(a) * speed, s * (5 + this.rng() * 8), Math.sin(a) * speed)
        .life(0.7 + this.rng() * 0.8)
        .size(s * 0.11, s * 0.05, 1).stretch(3.5)
        .physics(0.25, -20, 0)
        .look(RAMP.WATER, SPRITE.BLOB, 1.6, 0xffffff)
        .flags(PFLAG.NO_SOFT).wind(0.1).emit();
    }
    // Mist hanging over the entry, and a spreading surface ring.
    for (let i = 0; i < n(heavy ? 6 : 3); i++) {
      p.soft().at(x + (this.rng() - 0.5) * s, surface + 0.4, z + (this.rng() - 0.5) * s)
        .vel((this.rng() - 0.5) * s, s * (0.7 + this.rng()), (this.rng() - 0.5) * s)
        .life(1.6 + this.rng() * 1.6)
        .size(s * 0.8, s * (2.6 + this.rng() * 1.6), 0.55)
        .spin((this.rng() - 0.5) * 0.8)
        .physics(1.5, 0.25, 0.4)
        .look(RAMP.SMOKE_LIGHT, SPRITE.SMOKE_WISP, 0.75, 0xd8e8f0)
        .soft(1.6).wind(0.9).emit();
    }
    p.soft().at(x, surface, z).vel(0, 0, 0)
      .life(1.1).size(s * 0.6, s * 4.2, 0.55)
      .look(RAMP.WATER, SPRITE.RING, 1.1, 0xffffff)
      .flags(PFLAG.FLAT | PFLAG.NO_SOFT).wind(0).emit();
  }

  /* ==================================================================== *
   * Lingering emitters
   * ==================================================================== */

  private addEmitter(kind: Emitter['kind'], x: number, y: number, z: number,
                     scale: number, duration: number, rate: number): void {
    if (this.emitterCap <= 0) return;
    if (this.emitters.length >= this.emitterCap) {
      // Drop the one closest to finishing rather than the newest request.
      let best = 0;
      for (let i = 1; i < this.emitters.length; i++) {
        if (this.emitters[i].until < this.emitters[best].until) best = i;
      }
      this.emitters.splice(best, 1);
    }
    this.emitters.push({
      kind, x, y, z, scale,
      until: this.now + duration,
      span: duration,
      acc: 0,
      rate: rate * this.density,
    });
  }

  private updateEmitters(dt: number): void {
    const head = this.headroom();
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      if (this.now >= e.until) {
        this.emitters.splice(i, 1);
        continue;
      }
      // Emission tapers off across the emitter's life so a column thins out
      // instead of stopping dead.
      const remaining = clamp((e.until - this.now) / e.span, 0, 1);
      const fade = 0.25 + 0.75 * remaining;
      e.acc += dt * e.rate * fade * head;
      let issued = 0;
      while (e.acc >= 1 && issued < 3) {
        e.acc -= 1;
        issued++;
        if (e.kind === 'plume') this.plumePuff(e.x, e.y, e.z, e.scale, fade);
        else if (e.kind === 'wreck') this.wreckPuff(e.x, e.y, e.z, e.scale, fade);
        else this.groundPuff(e.x, e.y, e.z, e.scale, fade);
      }
      if (e.acc > 3) e.acc = 3;
    }
  }

  private plumePuff(x: number, y: number, z: number, s: number, fade: number): void {
    const a = this.rng() * TAU;
    const r = this.rng() * s * 0.55;
    this.particles.soft()
      .at(x + Math.cos(a) * r, y + this.rng() * s * 0.3, z + Math.sin(a) * r)
      .vel(Math.cos(a) * s * 0.5, s * (1.1 + this.rng() * 1.4), Math.sin(a) * s * 0.5)
      .life(3.5 + this.rng() * 4.5 + s * 0.25)
      .size(s * (0.55 + this.rng() * 0.4), s * (2.6 + this.rng() * 2.4), 0.6)
      .spin((this.rng() - 0.5) * 0.7)
      .physics(0.5, s * 0.16, 0.5)
      .look(RAMP.SMOKE_DARK, this.rng() < 0.5 ? SPRITE.SMOKE_A : SPRITE.PLUME, 0.6 + 0.4 * fade, 0xffffff)
      .soft(s * 1.1 + 1.5).wind(1).emit();
  }

  /** Burning wreckage: fire tongues at the base, oily smoke, embers, shimmer. */
  private wreckPuff(x: number, y: number, z: number, s: number, fade: number): void {
    const p = this.particles;
    const a = this.rng() * TAU;
    const r = this.rng() * s * 0.6;
    p.hot().at(x + Math.cos(a) * r, y + 0.2, z + Math.sin(a) * r)
      .vel((this.rng() - 0.5) * s * 0.6, s * (1.6 + this.rng() * 1.6), (this.rng() - 0.5) * s * 0.6)
      .life(0.45 + this.rng() * 0.45)
      .size(s * (0.5 + this.rng() * 0.4), s * (1.2 + this.rng()), 0.7)
      .spin((this.rng() - 0.5) * 1.5)
      .physics(1.6, s * 0.7, s * 0.15)
      .look(RAMP.FIRE_SOFT, SPRITE.FIRE, (3.5 + this.rng() * 3) * fade, 0xffffff)
      .soft(s * 0.8).wind(0.3).emit();

    p.soft().at(x + Math.cos(a) * r, y + s * 0.5, z + Math.sin(a) * r)
      .vel(Math.cos(a) * s * 0.4, s * (1.5 + this.rng() * 1.5), Math.sin(a) * s * 0.4)
      .life(3.2 + this.rng() * 3.5)
      .size(s * 0.7, s * (2.8 + this.rng() * 2.2), 0.6)
      .spin((this.rng() - 0.5) * 0.6)
      .physics(0.55, s * 0.2, 0.55)
      .look(RAMP.OIL_SMOKE, this.rng() < 0.5 ? SPRITE.SMOKE_B : SPRITE.PLUME, 0.85, 0xffffff)
      .soft(s * 1.1 + 1.5).wind(1).emit();

    if (this.rng() < 0.5) {
      p.hot().at(x + (this.rng() - 0.5) * s, y + s * 0.4, z + (this.rng() - 0.5) * s)
        .vel((this.rng() - 0.5) * 1.2, 2.2 + this.rng() * 3, (this.rng() - 0.5) * 1.2)
        .life(1.8 + this.rng() * 2.2).size(0.16, 0.05, 1.6)
        .physics(0.55, -0.5, 0.9).look(RAMP.EMBER, SPRITE.EMBER, 5, 0xffa040)
        .flags(PFLAG.FLICKER | PFLAG.NO_SOFT).wind(0.85).emit();
    }
    if (this.rng() < 0.35) {
      p.hot().at(x + (this.rng() - 0.5) * s, y + s * 0.3, z + (this.rng() - 0.5) * s)
        .vel((this.rng() - 0.5) * 0.6, 3.6 + this.rng() * 2.4, (this.rng() - 0.5) * 0.6)
        .life(0.9 + this.rng() * 0.6).size(s * 1.1, s * 2.4, 0.7)
        .spin((this.rng() - 0.5) * 0.6).physics(1.1, 1.5, 1.2)
        .look(RAMP.HAZE, SPRITE.SHIMMER, 1.4, 0xfff0dc)
        .soft(1.5).wind(0.6).emit();
    }
  }

  private groundPuff(x: number, y: number, z: number, s: number, fade: number): void {
    const a = this.rng() * TAU;
    this.particles.soft()
      .at(x + (this.rng() - 0.5) * s, y + 0.3, z + (this.rng() - 0.5) * s)
      .vel(Math.cos(a) * s * 0.8, 0.5 + this.rng(), Math.sin(a) * s * 0.8)
      .life(2.0 + this.rng() * 2.0)
      .size(s * 0.8, s * (2.4 + this.rng() * 1.6), 0.55)
      .spin((this.rng() - 0.5) * 0.8).physics(1.4, -0.2, 0.35)
      .look(RAMP.DUST, SPRITE.DUST, 0.85 * fade, 0xffffff)
      .flags(PFLAG.HUG).soft(s + 1.5).wind(0.95).emit();
  }

  /* ==================================================================== *
   * Dynamic lights
   * ==================================================================== */

  private buildLights(count: number): void {
    for (let i = 0; i < count; i++) {
      // decay 2 is inverse-square; `distance` bounds the influence so the light
      // never has to be considered for the whole map.
      const light = new THREE.PointLight(0xffffff, 0, 60, 2);
      light.castShadow = false;
      light.name = `fx-light-${i}`;
      this.scene.add(light);
      this.lights.push(light);
    }
    this.lightT0 = new Float32Array(count).fill(-1e6);
    this.lightDur = new Float32Array(count).fill(1);
    this.lightPeak = new Float32Array(count);
  }

  private addLight(x: number, y: number, z: number, peak: number, color: number,
                   duration: number, radius: number): void {
    const count = this.lights.length;
    if (count === 0) return;
    // Steal the slot with the least remaining energy — a dying flash is a far
    // cheaper thing to lose than the detonation the player just triggered.
    let slot = 0;
    let worst = Infinity;
    for (let i = 0; i < count; i++) {
      const k = (this.now - this.lightT0[i]) / this.lightDur[i];
      const energy = k >= 1 ? -1 : this.lightPeak[i] * (1 - k);
      if (energy < worst) {
        worst = energy;
        slot = i;
      }
      if (energy < 0) break;
    }
    if (worst > peak * 1.6) return;

    const light = this.lights[slot];
    light.position.set(x, y, z);
    light.color.setHex(color);
    light.distance = radius;
    this.lightT0[slot] = this.now;
    this.lightDur[slot] = Math.max(duration, 0.05);
    this.lightPeak[slot] = peak;
  }

  private updateLights(): void {
    for (let i = 0; i < this.lights.length; i++) {
      const k = (this.now - this.lightT0[i]) / this.lightDur[i];
      if (k >= 1 || k < 0) {
        this.lights[i].intensity = 0;
        continue;
      }
      // Near-instant attack, exponential decay: the shape of a real detonation
      // and the reason a flash reads as a flash rather than a lamp switching on.
      const attack = k < 0.09 ? k / 0.09 : 1;
      const decay = Math.exp(-k * 5.4);
      this.lights[i].intensity = this.lightPeak[i] * attack * decay;
    }
  }

  /* ==================================================================== *
   * Environment sync and budget
   * ==================================================================== */

  private syncEnvironment(): void {
    const env = tryGet('environment');
    if (!env) return;
    this.particles.setEnvironment(env.sunDirection, env.sunColor, env.sunIntensity, env.horizonColor);
  }

  private syncFog(): void {
    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) this.particles.setFog(fog.color, fog.density);
    else if (fog instanceof THREE.Fog) this.particles.setFog(fog.color, 1 / Math.max(fog.far, 1));
    else {
      const env = tryGet('environment');
      if (env) this.particles.setFog(env.horizonColor, 0.00075);
    }
  }

  /**
   * Live budget feedback in [0.12, 1]. Effects are thinned as the pool fills,
   * which keeps the most recent (and therefore most relevant) event intact
   * instead of letting an off-screen firefight evict it.
   */
  private headroom(): number {
    const t = this.particles.count / this.softCap;
    if (t < 0.55) return 1;
    if (t < 0.85) return 0.7;
    if (t < 1.1) return 0.42;
    if (t < 1.6) return 0.24;
    return 0.12;
  }

  /* ==================================================================== *
   * Showcase — a deterministic loop that fires every effect near the origin
   * ==================================================================== */

  /**
   * The review harness captures a handful of frames from a match that is only
   * seconds old, so combat is not reliably in shot. This loop fires the whole
   * catalogue on a fixed cadence around a known point, which makes the VFX
   * pass reviewable on its own terms and comparable between iterations.
   */
  private runShowcase(dt: number): void {
    const o = this.showcaseOrigin;
    if (this.showcaseStep === 0) {
      o.set(0, heightAt(0, 0), 0);
      this.waterSpot = this.findWater(o.x, o.z, 260);
    }

    this.showcaseClock += dt;
    this.updateShowcaseRockets(dt);

    const INTERVAL = 0.26;
    let guard = 0;
    while (this.showcaseClock >= INTERVAL && guard++ < 4) {
      this.showcaseClock -= INTERVAL;
      this.fireShowcaseEvent(this.showcaseStep++);
    }
  }

  private fireShowcaseEvent(step: number): void {
    const o = this.showcaseOrigin;
    const slot = step % 22;
    const a = (step * 2.399963) % TAU; // golden-angle spread, so nothing repeats in place
    const r = 22 + ((step * 7) % 26);
    const x = o.x + Math.cos(a) * r;
    const z = o.z + Math.sin(a) * r;
    const gh = heightAt(x, z);
    const pos = new THREE.Vector3(x, gh + 1.6, z);
    const up = new THREE.Vector3(0, 1, 0);

    switch (slot) {
      case 0:
      case 8:
        this.explosion(pos, 2.4, 'shell');
        break;
      case 1:
      case 12: {
        // A firing position lobbing rounds across the arena.
        const from = new THREE.Vector3(o.x + Math.cos(a) * 40, gh + 4.5, o.z + Math.sin(a) * 40);
        const to = new THREE.Vector3(o.x - Math.cos(a) * 34, heightAt(o.x - Math.cos(a) * 34, o.z - Math.sin(a) * 34) + 3, o.z - Math.sin(a) * 34);
        const dir = to.clone().sub(from).normalize();
        this.muzzleFlash(from, dir, 2.4);
        this.tracer(from, to, 0xffdca0, 260);
        break;
      }
      case 2:
        this.impact(pos, up, 'dirt');
        break;
      case 3:
        this.explosion(new THREE.Vector3(x, gh + 2.4, z), 3.2, 'vehicle');
        break;
      case 4: {
        const from = new THREE.Vector3(x, gh + 3.2, z);
        const dir = new THREE.Vector3(-Math.cos(a), 0.06, -Math.sin(a)).normalize();
        this.muzzleFlash(from, dir, 1.1);
        this.tracer(from, from.clone().addScaledVector(dir, 55), 0xfff0b0, 420);
        break;
      }
      case 5:
        this.impact(new THREE.Vector3(x, gh + 2.2, z), up, 'metal');
        break;
      case 6:
        this.explosion(new THREE.Vector3(x, gh + 3.0, z), 2.8, 'rocket');
        break;
      case 7:
        this.launchShowcaseRocket(a, r);
        break;
      case 9:
        this.impact(new THREE.Vector3(x, gh + 1.2, z), up, 'stone');
        break;
      case 10:
        this.explosion(new THREE.Vector3(x, gh + 4.0, z), 4.5, 'building');
        break;
      case 11:
        this.smokePlume(new THREE.Vector3(x, gh + 1.0, z), 3.0, 7);
        break;
      case 13: {
        const from = new THREE.Vector3(o.x + Math.cos(a) * 46, gh + 9, o.z + Math.sin(a) * 46);
        this.beam(from, new THREE.Vector3(x, gh + 1.2, z), 0x8cd8ff, 0.7, 0.3);
        this.impact(new THREE.Vector3(x, gh + 1.2, z), up, 'metal');
        break;
      }
      case 14:
        if (this.waterSpot) this.impact(this.waterSpot, up, 'water');
        else this.impact(new THREE.Vector3(x, gh + 1.0, z), up, 'dirt');
        break;
      case 15: {
        const heading = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const p = new THREE.Vector3(x, gh, z);
        for (let i = 0; i < 6; i++) {
          p.set(x - heading.x * i * 3.5, gh, z - heading.z * i * 3.5);
          this.vehicleDust(p, heading, 12, 1.4);
        }
        break;
      }
      case 16:
        this.embers(new THREE.Vector3(x, gh + 1.2, z), 2.2, 8);
        this.heatShimmer(new THREE.Vector3(x, gh + 1.4, z), 2.6, 3);
        break;
      case 17:
        this.explosion(new THREE.Vector3(x, gh + 1.6, z), 2.0, 'shell');
        break;
      case 18: {
        const from = new THREE.Vector3(x, gh + 5, z);
        const dir = new THREE.Vector3(-Math.cos(a), -0.12, -Math.sin(a)).normalize();
        this.muzzleFlash(from, dir, 2.4);
        this.tracer(from, from.clone().addScaledVector(dir, 62), 0xffc060, 300);
        break;
      }
      case 19:
        this.impact(new THREE.Vector3(x, gh + 1.4, z), up, 'stone');
        break;
      case 20:
        this.explosion(new THREE.Vector3(x, gh + 3.4, z), 3.6, 'vehicle');
        break;
      default:
        // One nuke per full cycle, offset from the ring so it does not swamp it.
        this.explosion(new THREE.Vector3(o.x + 52, heightAt(o.x + 52, o.z - 44) + 4, o.z - 44), 3.0, 'nuke');
        break;
    }
  }

  private launchShowcaseRocket(angle: number, radius: number): void {
    if (this.rockets.length > 5) return;
    const o = this.showcaseOrigin;
    const x = o.x + Math.cos(angle) * (radius + 24);
    const z = o.z + Math.sin(angle) * (radius + 24);
    const p = new THREE.Vector3(x, heightAt(x, z) + 3, z);
    const target = new THREE.Vector3(o.x, o.y + 2, o.z);
    const v = target.sub(p).normalize().multiplyScalar(34);
    v.y += 6;
    this.rockets.push({ p, v, life: 1.5 });
  }

  private updateShowcaseRockets(dt: number): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.life -= dt;
      r.p.addScaledVector(r.v, dt);
      r.v.y -= 5 * dt;
      const gh = heightAt(r.p.x, r.p.z);
      scratchDir.copy(r.v).normalize();
      this.exhaust(r.p, scratchDir, 1.1);
      if (r.life <= 0 || r.p.y <= gh + 0.8) {
        this.explosion(r.p, 2.6, 'rocket');
        this.rockets.splice(i, 1);
      }
    }
  }

  /** Finds open water near a point, for the showcase's splash. */
  private findWater(x: number, z: number, maxRadius: number): THREE.Vector3 | null {
    const waterLevel = tryGet('terrain')?.waterLevel ?? WATER_LEVEL;
    for (let ring = 1; ring <= 10; ring++) {
      const r = (ring / 10) * maxRadius;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU + ring * 0.4;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (isWater(px, pz)) return new THREE.Vector3(px, waterLevel, pz);
      }
    }
    return null;
  }
}

export default Effects;
