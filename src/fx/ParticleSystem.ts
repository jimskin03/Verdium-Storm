import * as THREE from 'three';
import { WORLD_SIZE } from '@/world/Heightfield';
import { EMISSIVE_FRAGMENT, LIT_FRAGMENT, PARTICLE_VERTEX, PFLAG } from '@/shaders/fx/ParticleShaders';
import { RAMP_ROWS } from './FxTextures';

export { PFLAG };

/** Floats per particle in the interleaved instance buffer. */
const STRIDE = 24;

/**
 * A pool of particles sharing one material and one draw call.
 *
 * The CPU writes a particle's 24 floats exactly once, when it is born, and
 * never touches it again — the vertex shader evaluates the whole trajectory
 * from that spawn state. The only per-frame CPU work is retiring expired
 * particles by swapping the tail down over the hole, which keeps the live set
 * packed at the front of the buffer so `instanceCount` can shrink to zero when
 * nothing is burning.
 */
export class ParticleGroup {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly capacity: number;

  private readonly data: Float32Array;
  private readonly death: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private live = 0;
  private evictCursor = 0;
  private dirtyEnd = 0;
  private dirty = false;

  /** Particles refused this frame because the pool was saturated. */
  overflow = 0;

  constructor(capacity: number, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, additive: boolean) {
    this.capacity = Math.max(64, capacity | 0);
    this.data = new Float32Array(this.capacity * STRIDE);
    this.death = new Float32Array(this.capacity);

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.attributes.position);
    this.geometry.setAttribute('uv', quad.attributes.uv);
    this.geometry.instanceCount = 0;
    // The shader places every vertex; a bounding volume would only ever be a
    // lie, so culling is disabled outright.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    const names = ['aP', 'aV', 'aS', 'aC', 'aM', 'aO'];
    for (let i = 0; i < names.length; i++) {
      this.geometry.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4, false));
    }

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PARTICLE_VERTEX,
      fragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      // Both paths output premultiplied colour; additive simply skips the
      // destination attenuation so hot cores stack instead of occluding.
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = additive ? 11 : 10;
    this.mesh.name = additive ? 'fx-emissive' : 'fx-lit';
  }

  get count(): number {
    return this.live;
  }

  /** Writes one particle. `slot` values are the raw 24-float spawn state. */
  emit(slot: Float32Array, birth: number, life: number): void {
    let index: number;
    if (this.live < this.capacity) {
      index = this.live++;
    } else {
      // Saturated: recycle round-robin so a fresh burst still reads, rather
      // than silently dropping the effect the player is looking at.
      this.overflow++;
      index = this.evictCursor;
      this.evictCursor = (this.evictCursor + 1) % this.capacity;
    }
    this.data.set(slot, index * STRIDE);
    this.death[index] = birth + life;
    this.dirtyEnd = Math.max(this.dirtyEnd, index + 1);
    this.dirty = true;
  }

  update(time: number): void {
    let n = this.live;
    for (let i = 0; i < n; ) {
      if (this.death[i] <= time) {
        n--;
        if (i !== n) {
          this.data.copyWithin(i * STRIDE, n * STRIDE, n * STRIDE + STRIDE);
          this.death[i] = this.death[n];
          this.dirtyEnd = Math.max(this.dirtyEnd, i + 1);
          this.dirty = true;
        }
      } else {
        i++;
      }
    }
    this.live = n;
    this.geometry.instanceCount = n;
    if (this.dirty) {
      const end = Math.min(this.dirtyEnd, this.capacity);
      this.buffer.addUpdateRange(0, end * STRIDE);
      this.buffer.needsUpdate = true;
      this.dirty = false;
      this.dirtyEnd = 0;
    }
  }

  clear(): void {
    this.live = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Fluent, allocation-free spawn descriptor. Callers mutate the single scratch
 * instance owned by {@link ParticleSystem} and terminate with `.emit()`, so a
 * thousand-particle explosion allocates nothing at all.
 */
export class ParticleSpawn {
  private readonly slot = new Float32Array(STRIDE);
  private system: ParticleSystem;
  private additive = false;
  private birthDelay = 0;

  constructor(system: ParticleSystem) {
    this.system = system;
  }

  reset(additive: boolean): this {
    this.slot.fill(0);
    this.additive = additive;
    this.birthDelay = 0;
    // Sensible neutral defaults; anything not set explicitly still renders.
    this.slot[7] = 1; // life
    this.slot[8] = 1; // size0
    this.slot[9] = 1; // size1
    this.slot[10] = 1; // size exponent
    this.slot[18] = 1; // brightness
    this.slot[20] = 0xffffff; // tint
    this.slot[21] = 2.5; // soft distance
    this.slot[23] = 1; // wind factor
    this.slot[17] = 0; // atlas layer
    return this;
  }

  at(x: number, y: number, z: number): this {
    this.slot[0] = x;
    this.slot[1] = y;
    this.slot[2] = z;
    return this;
  }

  vel(x: number, y: number, z: number): this {
    this.slot[4] = x;
    this.slot[5] = y;
    this.slot[6] = z;
    return this;
  }

  life(seconds: number): this {
    this.slot[7] = seconds;
    return this;
  }

  /** `exponent` < 1 expands fast then eases; > 1 holds small then blooms. */
  size(from: number, to: number, exponent = 1): this {
    this.slot[8] = from;
    this.slot[9] = to;
    this.slot[10] = exponent;
    return this;
  }

  spin(radiansPerSecond: number): this {
    this.slot[11] = radiansPerSecond;
    return this;
  }

  /** `gravity` is signed: negative falls, positive is buoyancy. */
  physics(drag: number, gravity: number, turbulence = 0): this {
    this.slot[12] = drag;
    this.slot[13] = gravity;
    this.slot[14] = turbulence;
    return this;
  }

  /** Multiple of the sprite's size to smear along the velocity vector. */
  stretch(amount: number): this {
    this.slot[15] = amount;
    return this;
  }

  look(ramp: number, layer: number, brightness = 1, tint = 0xffffff): this {
    this.slot[16] = ramp;
    this.slot[17] = layer;
    this.slot[18] = brightness;
    this.slot[20] = tint & 0xffffff;
    return this;
  }

  /** Distance in world units over which the sprite dissolves into the ground. */
  soft(distance: number): this {
    this.slot[21] = distance;
    return this;
  }

  flags(bits: number): this {
    this.slot[22] = bits;
    return this;
  }

  /** 0 ignores wind entirely, 1 drifts with it fully. */
  wind(factor: number): this {
    this.slot[23] = factor;
    return this;
  }

  /** Staggers birth into the future — trails and secondary detonations. */
  delay(seconds: number): this {
    this.birthDelay = seconds;
    return this;
  }

  seed(value: number): this {
    this.slot[19] = value;
    return this;
  }

  emit(): void {
    const s = this.system;
    if (this.slot[19] === 0) this.slot[19] = s.nextSeed();
    const birth = s.time + this.birthDelay;
    this.slot[3] = birth;
    const group = this.additive ? s.emissive : s.lit;
    group.emit(this.slot, birth, this.slot[7]);
  }
}

export interface ParticleSystemOptions {
  maxParticles: number;
  spriteArray: THREE.DataArrayTexture;
  ramp: THREE.DataTexture;
  ground: THREE.DataTexture;
}

/** Owns both draw groups, the shared uniforms and the spawn scratch. */
export class ParticleSystem {
  readonly emissive: ParticleGroup;
  readonly lit: ParticleGroup;
  readonly wind = new THREE.Vector3(1.6, 0, -0.9);

  time = 0;

  private readonly spawnScratch: ParticleSpawn;
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly litUniforms: Record<string, THREE.IUniform>;
  private seedCursor = 1;

  constructor(opts: ParticleSystemOptions) {
    this.shared = {
      uTime: { value: 0 },
      uWind: { value: this.wind },
      uGround: { value: opts.ground },
      uGroundParam: { value: new THREE.Vector2(1 / WORLD_SIZE, 0) },
      uAtlas: { value: opts.spriteArray },
      uRamp: { value: opts.ramp },
      uRampRows: { value: RAMP_ROWS },
      uFogColor: { value: new THREE.Color(0x93a9b8) },
      uFogDensity: { value: 0.00075 },
      uNearFade: { value: new THREE.Vector2(0.5, 4.0) },
    };
    this.litUniforms = {
      ...this.shared,
      uSunDir: { value: new THREE.Vector3(0.42, 0.62, 0.35).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.9, 0.76) },
      uSkyColor: { value: new THREE.Color(0.30, 0.38, 0.48) },
      uGroundBounce: { value: new THREE.Color(0.13, 0.13, 0.10) },
    };

    // Emissive work is cheap per particle but fill-rate heavy; smoke is the
    // opposite. Roughly half the budget each has held up well in practice.
    const budget = Math.max(2000, opts.maxParticles | 0);
    this.emissive = new ParticleGroup(Math.round(budget * 0.45), EMISSIVE_FRAGMENT, this.shared, true);
    this.lit = new ParticleGroup(Math.round(budget * 0.55), LIT_FRAGMENT, this.litUniforms, false);

    this.spawnScratch = new ParticleSpawn(this);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.lit.mesh);
    scene.add(this.emissive.mesh);
  }

  /** Begins an unlit, additively blended particle: fire, sparks, flashes. */
  hot(): ParticleSpawn {
    return this.spawnScratch.reset(true);
  }

  /** Begins a sun-lit, alpha blended particle: smoke, dust, debris, water. */
  soft(): ParticleSpawn {
    return this.spawnScratch.reset(false);
  }

  nextSeed(): number {
    this.seedCursor = (this.seedCursor * 1103515245 + 12345) & 0x7fffffff;
    return (this.seedCursor % 100000) / 100000 + 1e-4;
  }

  get count(): number {
    return this.emissive.count + this.lit.count;
  }

  setEnvironment(sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, horizon: THREE.Color): void {
    (this.litUniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.litUniforms.uSunColor.value as THREE.Color)
      .copy(sunColor)
      .multiplyScalar(Math.min(sunIntensity * 0.34, 1.6));
    // Sky fill leans toward the horizon tint so smoke sits in the same air as
    // everything else in the frame.
    (this.litUniforms.uSkyColor.value as THREE.Color).copy(horizon).multiplyScalar(0.42);
    (this.litUniforms.uGroundBounce.value as THREE.Color).setRGB(0.11, 0.11, 0.085);
  }

  setFog(color: THREE.Color, density: number): void {
    (this.shared.uFogColor.value as THREE.Color).copy(color);
    this.shared.uFogDensity.value = density;
  }

  setNearFade(start: number, end: number): void {
    (this.shared.uNearFade.value as THREE.Vector2).set(start, end);
  }

  /** `time` is the engine's absolute elapsed clock, shared with the decal pool. */
  update(time: number): void {
    this.time = time;
    this.shared.uTime.value = this.time;
    this.litUniforms.uTime.value = this.time;
    this.emissive.update(this.time);
    this.lit.update(this.time);
  }

  clear(): void {
    this.emissive.clear();
    this.lit.clear();
  }

  dispose(): void {
    this.emissive.dispose();
    this.lit.dispose();
  }
}
