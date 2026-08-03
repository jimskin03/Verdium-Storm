import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { provide, tryGet, type DecalKind, type DecalService } from '@/engine/Services';
import { WATER_LEVEL, heightAt, slopeAt } from '@/world/Heightfield';
import { clamp, makeRng } from '@/util/Noise';
import { DECAL_TEX, createDecalArray } from './FxTextures';
import { DECAL_FRAGMENT, DECAL_VERTEX } from '@/shaders/fx/DecalShaders';

/**
 * Terrain-projected decals: craters, scorch, blast scour, oil, rubble and
 * vehicle tracks.
 *
 * Each decal is a small grid whose vertices are dropped onto the heightfield
 * when it is placed, so a mark bends over a slope and sits *in* the ground
 * rather than hovering over it as a flat card. Every slot lives in one shared
 * buffer and the whole pool draws in a single multiply-blended call.
 *
 * Fade is evaluated per vertex from a birth stamp, so once a decal is placed
 * its data is never written again. The pool is a fixed-size ring: allocation is
 * O(1) and, because slots are consumed in order, the slot the cursor lands on
 * is always the least recently used one. Decals cannot leak.
 */

/** Grid subdivisions per decal edge — the knob that trades tris for conformance. */
const GRID = 6;
const VERTS_PER_DECAL = (GRID + 1) * (GRID + 1);
const TRIS_PER_DECAL = GRID * GRID * 2;

/** Lift off the surface, in world units, to stay clear of z-fighting. */
const SURFACE_BIAS = 0.16;

interface KindConfig {
  layers: number[];
  life: number;
  fadeIn: number;
  strength: number;
  tint: [number, number, number];
  /** Random size multiplier range. */
  jitter: number;
  /** Above this slope the mark would smear, so it is faded out. */
  maxSlope: number;
}

const KINDS: Record<DecalKind, KindConfig> = {
  crater: {
    layers: [DECAL_TEX.CRATER],
    life: 120,
    fadeIn: 0.08,
    strength: 1.0,
    tint: [1.0, 0.97, 0.92],
    jitter: 0.18,
    maxSlope: 0.55,
  },
  scorch: {
    layers: [DECAL_TEX.SCORCH_A, DECAL_TEX.SCORCH_B],
    life: 85,
    fadeIn: 0.12,
    strength: 0.95,
    tint: [1.0, 0.98, 0.95],
    jitter: 0.3,
    maxSlope: 0.7,
  },
  blast: {
    layers: [DECAL_TEX.BLAST_RING],
    life: 28,
    fadeIn: 0.05,
    strength: 0.85,
    tint: [1.02, 1.0, 0.95],
    jitter: 0.15,
    maxSlope: 0.6,
  },
  oil: {
    layers: [DECAL_TEX.OIL],
    life: 95,
    fadeIn: 1.4,
    strength: 1.0,
    tint: [1.0, 1.0, 1.0],
    jitter: 0.25,
    maxSlope: 0.3,
  },
  rubble: {
    layers: [DECAL_TEX.RUBBLE],
    life: 140,
    fadeIn: 0.4,
    strength: 0.9,
    tint: [1.0, 0.98, 0.94],
    jitter: 0.22,
    maxSlope: 0.5,
  },
  tread: {
    layers: [DECAL_TEX.TREAD],
    life: 34,
    fadeIn: 0.25,
    strength: 0.7,
    tint: [1.0, 0.99, 0.96],
    jitter: 0.06,
    maxSlope: 0.65,
  },
};

function capacityFor(tier: string): number {
  switch (tier) {
    case 'low':
      return 72;
    case 'medium':
      return 160;
    case 'high':
      return 256;
    default:
      return 320;
  }
}

export class Decals implements System, DecalService {
  readonly name = 'decals';
  readonly phase = Phase.EFFECTS;

  private capacity = 256;
  private cursor = 0;
  private now = 0;

  private geometry!: THREE.BufferGeometry;
  private material!: THREE.ShaderMaterial;
  private mesh!: THREE.Mesh;
  private atlas!: THREE.DataArrayTexture;

  private position!: THREE.BufferAttribute;
  private uvAttr!: THREE.BufferAttribute;
  private layerAttr!: THREE.BufferAttribute;
  private timeAttr!: THREE.BufferAttribute;
  private tintAttr!: THREE.BufferAttribute;

  private readonly rng = makeRng(0x51d3ca1);
  private stats = { placed: 0, evicted: 0 };

  init(ctx: EngineContext): void {
    this.capacity = capacityFor(ctx.quality.tier);
    this.atlas = createDecalArray(256);

    const vertCount = this.capacity * VERTS_PER_DECAL;
    this.position = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    this.uvAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 2), 2);
    this.layerAttr = new THREE.BufferAttribute(new Float32Array(vertCount), 1);
    this.timeAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 4), 4);
    this.tintAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    for (const a of [this.position, this.uvAttr, this.layerAttr, this.timeAttr, this.tintAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    // A retired slot has birth = -1e9, which the vertex shader collapses.
    for (let i = 0; i < vertCount; i++) this.timeAttr.setXYZW(i, -1e9, 1, 1, 0);

    const indices = new Uint32Array(this.capacity * TRIS_PER_DECAL * 3);
    let w = 0;
    for (let s = 0; s < this.capacity; s++) {
      const base = s * VERTS_PER_DECAL;
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const a = base + j * (GRID + 1) + i;
          const b = a + 1;
          const c = a + (GRID + 1);
          const d = c + 1;
          indices[w++] = a;
          indices[w++] = c;
          indices[w++] = b;
          indices[w++] = b;
          indices[w++] = c;
          indices[w++] = d;
        }
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('uv', this.uvAttr);
    this.geometry.setAttribute('aLayer', this.layerAttr);
    this.geometry.setAttribute('aTime', this.timeAttr);
    this.geometry.setAttribute('aTint', this.tintAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const fog = ctx.scene.fog;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: this.atlas },
        uFogDensity: { value: fog instanceof THREE.FogExp2 ? fog.density : 0.00075 },
        uDistFade: { value: new THREE.Vector2(620, 900) },
      },
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
      // A mark on the ground modulates the albedo response of the surface it
      // sits on: a true multiply, not an overlay.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'fx-decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 4;
    ctx.scene.add(this.mesh);

    provide('decals', this);
  }

  add(kind: DecalKind, x: number, z: number, size: number, rotation?: number, life?: number): void {
    const cfg = KINDS[kind] ?? KINDS.scorch;
    const terrain = tryGet('terrain');
    const waterLevel = terrain?.waterLevel ?? WATER_LEVEL;
    const centreHeight = heightAt(x, z);
    // Nothing sticks to open water.
    if (centreHeight < waterLevel + 0.25) return;

    const slope = slopeAt(x, z);
    if (slope > cfg.maxSlope) return;
    const slopeFade = 1 - clamp((slope / cfg.maxSlope) ** 2, 0, 0.75);

    const rot = rotation ?? this.rng() * Math.PI * 2;
    const scale = size * (1 + (this.rng() - 0.5) * 2 * cfg.jitter);
    const half = Math.max(scale, 0.5) * 0.5;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const base = slot * VERTS_PER_DECAL;
    const birth = this.now;
    const decalLife = life ?? cfg.life;
    const layer = cfg.layers[Math.floor(this.rng() * cfg.layers.length) % cfg.layers.length];
    const strength = cfg.strength * slopeFade;
    // A little tonal jitter stops repeated marks from reading as one stamp.
    const warm = 0.94 + this.rng() * 0.12;

    const timePeek = this.timeAttr.array as Float32Array;
    if (timePeek[base * 4] + timePeek[base * 4 + 1] > birth) this.stats.evicted++;

    const posArr = this.position.array as Float32Array;
    const uvArr = this.uvAttr.array as Float32Array;
    const layerArr = this.layerAttr.array as Float32Array;
    const timeArr = this.timeAttr.array as Float32Array;
    const tintArr = this.tintAttr.array as Float32Array;

    for (let j = 0; j <= GRID; j++) {
      const ty = j / GRID;
      const ly = (ty - 0.5) * 2 * half;
      for (let i = 0; i <= GRID; i++) {
        const tx = i / GRID;
        const lx = (tx - 0.5) * 2 * half;
        const wx = x + lx * cos - ly * sin;
        const wz = z + lx * sin + ly * cos;
        const v = base + j * (GRID + 1) + i;
        posArr[v * 3] = wx;
        posArr[v * 3 + 1] = heightAt(wx, wz) + SURFACE_BIAS;
        posArr[v * 3 + 2] = wz;
        uvArr[v * 2] = tx;
        uvArr[v * 2 + 1] = ty;
        layerArr[v] = layer;
        timeArr[v * 4] = birth;
        timeArr[v * 4 + 1] = decalLife;
        timeArr[v * 4 + 2] = cfg.fadeIn;
        timeArr[v * 4 + 3] = strength;
        tintArr[v * 3] = cfg.tint[0] * warm;
        tintArr[v * 3 + 1] = cfg.tint[1];
        tintArr[v * 3 + 2] = cfg.tint[2] / warm;
      }
    }

    for (const a of [this.position, this.uvAttr, this.layerAttr, this.timeAttr, this.tintAttr]) {
      a.addUpdateRange(base * a.itemSize, VERTS_PER_DECAL * a.itemSize);
      a.needsUpdate = true;
    }
    this.stats.placed++;
    if (timeArr[base * 4] !== birth) this.stats.evicted++;
  }

  update(_dt: number, elapsed: number): void {
    this.now = elapsed;
    this.material.uniforms.uTime.value = elapsed;
    const fog = (this.mesh.parent as THREE.Scene | null)?.fog;
    if (fog instanceof THREE.FogExp2) this.material.uniforms.uFogDensity.value = fog.density;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    this.atlas?.dispose();
  }
}

export default Decals;
