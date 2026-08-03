import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { clamp, fbm2, makeRng, smoothstep } from '@/util/Noise';
import { HALF_WORLD, PLATEAUS, WATER_LEVEL, heightAt, slopeAt } from '@/world/Heightfield';
import { getTerrainData, type TerrainData } from '@/shaders/foliage/TerrainData';
import {
  ScatterInstancer,
  ScatterSet,
  groundQuaternion,
  jitteredScatter,
  type LodLevel,
} from '@/shaders/foliage/Scatter';
import type { BuiltProp } from '@/shaders/props/PropGeo';
import { MeshBuf } from '@/shaders/props/PropGeo';
import { buildDebrisCluster, buildRockLods, type RockGeometry } from '@/shaders/props/Rocks';
import {
  buildApcWreck,
  buildBrokenWall,
  buildConcreteRubble,
  buildJerseyBarrier,
  buildTankWreck,
  buildTruckWreck,
  emitFencePanel,
  emitFencePost,
  emitFenceRail,
} from '@/shaders/props/Wreckage';
import {
  GroundMarks,
  baseLift,
  fitFootprint,
  settleDepth,
  splitDrivable,
  traceTrack,
  type Footprint,
  type GroundSampler,
} from '@/shaders/props/GroundDetail';
import {
  disposeMaps,
  makeConcreteMaps,
  makeGroundAtlas,
  makeMetalMaps,
  makeRockMaps,
  makeWireTexture,
} from '@/shaders/props/PropTextures';

/**
 * Props: everything on the ground that is neither terrain nor alive.
 *
 * Two families, placed by different logic because they mean different things.
 *
 * **Stone** is geology. It goes where the map says rock should be — the foot of
 * every cliff, the crests of the ridges, the steep scree — found by reading the
 * heightfield rather than by sprinkling. A boulder is never alone: each one
 * seeds a drift of the pieces that came off it, thrown downhill, which is what
 * makes an outcrop read as weathered instead of placed.
 *
 * **Wreckage** is history. It is deliberately sparse and sits only where the
 * map creates a reason: the approach to each plateau, where a barrier line
 * would have been dragged across and where the vehicles that tried to run it
 * stopped. A dozen wrecks placed at choke points say more than a hundred
 * scattered at random, and cost a twentieth as much.
 *
 * Under both, a baked layer of ground marks — dirt collars, gravel aprons,
 * scorch, wheel ruts — welds the props to the terrain. Objects that appear to
 * hover are the most common tell of amateur work, so grounding gets the most
 * expensive treatment here: every placement fits a plane through the terrain
 * under its own footprint and settles into it.
 *
 * Draw-call budget: 14 rock meshes across three LODs, 6 structure meshes, 2 for
 * the fencing and 1 for every ground mark in the level.
 */

/* --------------------------------------------------------------- tuning -- */

const ROCK_VARIANT = { boulder: 0, monolith: 1, block: 2, shard: 3 } as const;
const SMALL_VARIANT = { stone: 0, debris: 1 } as const;
const STRUCT_VARIANT = {
  jersey: 0, wall: 1, rubble: 2, tank: 3, truck: 4, apc: 5,
} as const;

/** How strongly each kind lies back into the slope it sits on. */
const ROCK_FOLLOW = [0.78, 0.42, 0.86, 0.34];

interface Anchor {
  x: number;
  z: number;
  /** Heading of the approach, in radians about Y. */
  yaw: number;
  kind: 'checkpoint' | 'perimeter' | 'ambush';
}

export class Props implements System {
  readonly name = 'props';
  readonly phase = Phase.ENVIRONMENT;

  private ctx!: EngineContext;
  private terrain!: TerrainData;
  private readonly group = new THREE.Group();

  private rockInstancer!: ScatterInstancer;
  private smallInstancer!: ScatterInstancer;
  private structInstancer!: ScatterInstancer;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private marks!: GroundMarks;
  private sampler!: GroundSampler;

  private readonly rockSet = new ScatterSet(2600, 64);
  private readonly smallSet = new ScatterSet(14000, 40);
  private readonly structSet = new ScatterSet(420, 72);

  private readonly fenceFrame = new MeshBuf();
  private readonly fenceWire = new MeshBuf();
  private structBounds: Array<THREE.Box3 | null> = [];

  /* ------------------------------------------------------------- boot -- */

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.terrain = getTerrainData();
    this.group.name = 'props';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    // Grounding samples the *baked* field rather than the analytic heightfield,
    // and deliberately so: the terrain renderer displaces its vertices from a
    // Catmull-Rom upsample of a 2.25-unit bake of the same function, so the
    // baked field is what the ground actually looks like on screen. Matching the
    // analytic function to the centimetre would put props a few centimetres off
    // the surface that gets drawn. It is also about a hundred times cheaper,
    // which matters across the ~200k lookups a full placement pass costs.
    const td = this.terrain;
    this.sampler = {
      height: (x, z) => td.heightAtFast(x, z),
      slope: (x, z) => td.slopeAtFast(x, z),
    };
    this.marks = new GroundMarks(this.sampler, 0.22);

    const tier = ctx.quality.tier;
    const texSize = tier === 'low' ? 128 : tier === 'medium' ? 256 : 384;
    const aniso = ctx.quality.anisotropy;

    const rockMaps = makeRockMaps(texSize, aniso);
    const concreteMaps = makeConcreteMaps(texSize, aniso);
    const metalMaps = makeMetalMaps(texSize, aniso);
    const wireTex = makeWireTexture(tier === 'low' ? 128 : 256, aniso);
    const groundTex = makeGroundAtlas(tier === 'low' ? 256 : 512, aniso);
    this.disposables.push(
      { dispose: () => disposeMaps(rockMaps) },
      { dispose: () => disposeMaps(concreteMaps) },
      { dispose: () => disposeMaps(metalMaps) },
      wireTex,
      groundTex,
    );

    const pbr = (maps: { map: THREE.Texture; normalMap: THREE.Texture; ormMap: THREE.Texture }, normalScale: number) => {
      const m = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap,
        normalScale: new THREE.Vector2(normalScale, normalScale),
        // The ORM map owns roughness and metalness outright; the scalars stay at
        // 1 so the texture is a value rather than a modulation of a guess.
        roughnessMap: maps.ormMap,
        metalnessMap: maps.ormMap,
        aoMap: maps.ormMap,
        aoMapIntensity: 0.85,
        roughness: 1,
        metalness: 1,
        vertexColors: true,
      });
      this.disposables.push(m);
      return m;
    };

    const rockMat = pbr(rockMaps, 1.15);
    const concreteMat = pbr(concreteMaps, 0.9);
    const metalMat = pbr(metalMaps, 1.25);

    const wireMat = new THREE.MeshStandardMaterial({
      map: wireTex,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.66,
      metalness: 0.55,
      vertexColors: true,
    });
    const groundMat = new THREE.MeshStandardMaterial({
      map: groundTex,
      transparent: true,
      depthWrite: false,
      roughness: 0.97,
      metalness: 0,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -12,
    });
    this.disposables.push(wireMat, groundMat);

    this.buildRocks(ctx, rockMat);
    this.buildStructures(ctx, concreteMat, metalMat);
    this.placeStone();
    this.placeStories();
    this.buildFence(metalMat, wireMat);
    this.buildGroundMarks(groundMat);
  }

  /* ------------------------------------------------------------ rocks -- */

  private buildRocks(ctx: EngineContext, material: THREE.Material): void {
    const tier = ctx.quality.tier;
    const lo = tier === 'low';

    // Every level of a kind is the same field re-evaluated, so the silhouette
    // holds across an LOD switch instead of popping.
    const boulder = buildRockLods('boulder', 0x51a3, lo ? [2, 1] : [3, 2, 1]);
    const monolith = buildRockLods('monolith', 0x7c11, lo ? [2, 1] : [3, 2, 1]);
    const block = buildRockLods('block', 0x2f89, lo ? [1, 1] : [2, 1]);
    const shard = buildRockLods('shard', 0x93d5, lo ? [1, 1] : [2, 1]);
    const stone = buildRockLods('stone', 0xb417, lo ? [1, 1] : [2, 1]);
    const debris = buildDebrisCluster(0xe33f, lo ? 0 : 1, 1.9);
    const debrisFar = buildDebrisCluster(0xe33f, 0, 1.9);

    this.rockSizes = [boulder[0], monolith[0], block[0], shard[0]];
    this.smallSizes = [stone[0], debris];

    const all: RockGeometry[] = [...boulder, ...monolith, ...block, ...shard, ...stone, debris, debrisFar];
    for (const r of all) this.disposables.push(r.geometry);

    const caps = {
      near: lo ? 60 : tier === 'medium' ? 110 : 180,
      mid: lo ? 160 : tier === 'medium' ? 340 : 560,
      far: lo ? 0 : 900,
      stoneNear: lo ? 200 : tier === 'medium' ? 500 : 900,
      stoneFar: lo ? 400 : tier === 'medium' ? 900 : 1500,
    };

    const mesh = (geo: THREE.BufferGeometry, name: string, cap: number, shadow: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, material, cap);
      m.name = name;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      // Pre-allocated so the instancer can tint without three lazily creating
      // the buffer mid-frame.
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      this.group.add(m);
      return m;
    };

    const nearMeshes = [
      [mesh(boulder[0].geometry, 'rock-boulder-0', caps.near, true)],
      [mesh(monolith[0].geometry, 'rock-monolith-0', caps.near, true)],
      [mesh(block[0].geometry, 'rock-block-0', caps.mid, true)],
      [mesh(shard[0].geometry, 'rock-shard-0', caps.mid, true)],
    ];
    const midMeshes = [
      [mesh(boulder[1].geometry, 'rock-boulder-1', caps.mid, false)],
      [mesh(monolith[1].geometry, 'rock-monolith-1', caps.mid, false)],
      [mesh(block[1].geometry, 'rock-block-1', caps.mid, false)],
      [mesh(shard[1].geometry, 'rock-shard-1', caps.mid, false)],
    ];
    const levels: LodLevel[] = [
      { distance: 160, meshes: nearMeshes, tintA: TINT_WARM, tintB: TINT_COOL },
      { distance: 540, meshes: midMeshes, tintA: TINT_WARM, tintB: TINT_COOL },
    ];
    if (!lo && caps.far > 0) {
      levels.push({
        distance: 1250,
        meshes: [
          [mesh(boulder[2].geometry, 'rock-boulder-2', caps.far, false)],
          [mesh(monolith[2].geometry, 'rock-monolith-2', caps.far, false)],
          [],
          [],
        ],
        tintA: TINT_WARM,
        tintB: TINT_COOL,
      });
    }
    this.rockInstancer = new ScatterInstancer(this.rockSet, levels, 9);

    const smallLevels: LodLevel[] = [
      {
        distance: 105,
        meshes: [
          [mesh(stone[0].geometry, 'rock-stone-0', caps.stoneNear, false)],
          [mesh(debris.geometry, 'rock-debris-0', caps.stoneNear, false)],
        ],
        tintA: TINT_WARM,
        tintB: TINT_COOL,
      },
      {
        distance: 300,
        meshes: [
          [mesh(stone[1].geometry, 'rock-stone-1', caps.stoneFar, false)],
          [mesh(debrisFar.geometry, 'rock-debris-1', caps.stoneFar, false)],
        ],
        tintA: TINT_WARM,
        tintB: TINT_COOL,
      },
    ];
    this.smallInstancer = new ScatterInstancer(this.smallSet, smallLevels, 2.2);
  }

  private rockSizes: RockGeometry[] = [];
  private smallSizes: RockGeometry[] = [];

  /* ------------------------------------------------------- structures -- */

  private buildStructures(ctx: EngineContext, concrete: THREE.Material, metal: THREE.Material): void {
    const pieces: Array<{ prop: BuiltProp; material: THREE.Material; cap: number }> = [
      { prop: buildJerseyBarrier(0x1a2b), material: concrete, cap: 90 },
      { prop: buildBrokenWall(0x3c4d), material: concrete, cap: 48 },
      { prop: buildConcreteRubble(0x5e6f), material: concrete, cap: 70 },
      { prop: buildTankWreck(0x7081), material: metal, cap: 14 },
      { prop: buildTruckWreck(0x92a3), material: metal, cap: 16 },
      { prop: buildApcWreck(0xb4c5), material: metal, cap: 14 },
    ];

    const meshes: THREE.InstancedMesh[][] = [];
    this.structBounds = [];
    this.structProps = [];
    for (const p of pieces) {
      const m = new THREE.InstancedMesh(p.prop.geometry, p.material, p.cap);
      m.name = p.prop.geometry.name;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
      this.disposables.push(p.prop.geometry);
      meshes.push([m]);
      p.prop.geometry.computeBoundingBox();
      this.structBounds.push(p.prop.geometry.boundingBox);
      this.structProps.push(p.prop);
    }

    // Structures never LOD: there are a few dozen in the level and each one is
    // a landmark, so losing them at distance would cost more than it saves.
    this.structInstancer = new ScatterInstancer(
      this.structSet,
      [{ distance: ctx.quality.tier === 'low' ? 620 : 1400, meshes }],
      4,
    );
  }

  private structProps: BuiltProp[] = [];

  /* ------------------------------------------------------- stone field -- */

  /**
   * Foot-of-cliff detection.
   *
   * The horizontal part of the surface normal points downhill, so stepping the
   * other way and re-reading the slope answers "is there a wall just above me".
   * Where that is true and the ground underfoot is not itself steep, material
   * has been falling for a long time — which is exactly where talus piles up.
   */
  private cliffBase(x: number, z: number): number {
    const td = this.terrain;
    td.normalAtFast(x, z, _n);
    const len = Math.hypot(_n.x, _n.z);
    if (len < 1e-4) return 0;
    const ux = -_n.x / len;
    const uz = -_n.z / len;
    let up = 0;
    for (const d of CLIFF_PROBES) {
      const s = td.slopeAtFast(x + ux * d, z + uz * d);
      if (s > up) up = s;
    }
    const own = td.slopeAtFast(x, z);
    return smoothstep(0.40, 0.72, up) * (1 - smoothstep(0.20, 0.48, own));
  }

  private placeStone(): void {
    const td = this.terrain;
    const rng = makeRng(0x51e2);
    const tier = this.ctx.quality.tier;
    const spacing = tier === 'low' ? 26 : tier === 'medium' ? 20 : 15;

    const density = (x: number, z: number): number => {
      const h = td.heightAtFast(x, z);
      if (h < WATER_LEVEL - 1.5 || h > 150) return 0;
      if (td.isReserved(x, z, 4)) return 0;
      const slope = td.slopeAtFast(x, z);
      const cliff = this.cliffBase(x, z);
      const ridge = smoothstep(48, 96, h) * smoothstep(0.10, 0.38, slope);
      const scree = smoothstep(0.32, 0.66, slope);
      const rock = td.rockAt(x, z);
      const shore = (1 - smoothstep(0.5, 5.0, Math.abs(h - WATER_LEVEL))) * 0.34;
      const field = fbm2(x / 82, z / 82, { octaves: 3, seed: 6161 }) * 0.5 + 0.5;
      const base = 0.13 * rock + 0.85 * cliff + 0.46 * ridge + 0.34 * scree + shore;
      return clamp(base * (0.26 + 1.0 * field), 0, 1);
    };

    jitteredScatter(HALF_WORLD - 14, spacing, rng, density, (x, z, r) => {
      const h = td.heightAtFast(x, z);
      const slope = td.slopeAtFast(x, z);
      const cliff = this.cliffBase(x, z);
      const alt = clamp((h - WATER_LEVEL) / 90, 0, 1);

      // Big weathered erratics collect at the foot of cliffs; columns and
      // splinters belong to the exposed high ground that shed them.
      const wBoulder = 0.45 + cliff * 2.1 + (1 - alt) * 0.3;
      const wMonolith = 0.22 + alt * 1.5 + slope * 1.1;
      const wBlock = 1.15 + cliff * 1.1;
      const wShard = 0.28 + slope * 1.9 + alt * 0.8;
      const total = wBoulder + wMonolith + wBlock + wShard;
      let variant = ROCK_VARIANT.block as number;
      const pick = r() * total;
      if (pick < wBoulder) variant = ROCK_VARIANT.boulder;
      else if (pick < wBoulder + wMonolith) variant = ROCK_VARIANT.monolith;
      else if (pick < wBoulder + wMonolith + wBlock) variant = ROCK_VARIANT.block;
      else variant = ROCK_VARIANT.shard;

      const scale = 0.68 + r() * 0.72;
      const placed = this.addRock(variant, x, z, scale, r);

      // The drift. Fragments are thrown downhill, thin out with distance, and
      // are what turn a lone boulder into an outcrop that has been eroding
      // since before anyone drew a map of it.
      const big = variant === ROCK_VARIANT.boulder || variant === ROCK_VARIANT.monolith;
      const count = big ? 4 + Math.floor(r() * 6) : r() < 0.55 ? 1 + Math.floor(r() * 3) : 0;
      if (count > 0) this.addDrift(x, z, placed, count, r);
    });

    // A sparse independent layer so the ground between outcrops is never bare.
    const looseRng = makeRng(0x9f3c);
    jitteredScatter(
      HALF_WORLD - 12,
      tier === 'low' ? 22 : tier === 'medium' ? 14 : 10,
      looseRng,
      (x, z) => {
        const h = td.heightAtFast(x, z);
        if (h < WATER_LEVEL + 0.2 || td.isReserved(x, z, 2)) return 0;
        const slope = td.slopeAtFast(x, z);
        const rock = td.rockAt(x, z);
        const field = fbm2(x / 46, z / 46, { octaves: 3, seed: 1717 }) * 0.5 + 0.5;
        return clamp(rock * 0.55 + smoothstep(0.24, 0.6, slope) * 0.5, 0, 1) * field * 0.62;
      },
      (x, z, r) => {
        const variant = r() < 0.24 ? SMALL_VARIANT.debris : SMALL_VARIANT.stone;
        this.addSmall(variant, x, z, 0.55 + r() * 1.05, r);
      },
    );

    this.rockSet.finish();
    this.smallSet.finish();
  }

  /** Places one large rock and returns the world radius it ended up with. */
  private addRock(variant: number, x: number, z: number, scale: number, r: () => number): number {
    const geo = this.rockSizes[variant];
    const radius = geo.radius * scale;
    const fp = fitFootprint(this.sampler, x, z, radius * 0.7, 8, _fp);
    const follow = ROCK_FOLLOW[variant];
    const yaw = r() * Math.PI * 2;
    groundQuaternion(fp.normal, yaw, follow, _quat);
    const sink = settleDepth(radius, fp, follow, 0.06 + 0.12 * r());
    _pos.set(x, fp.height - sink, z);
    this.rockSet.add(_pos, _quat, scale, variant, r());

    // Everything above ankle height earns a dirt collar. Below that the marks
    // would cost more than the stone they sit under.
    if (radius > 0.9) this.marks.bedRock(x, z, radius, yaw, 0.85 + 0.3 * r());
    return radius;
  }

  private addSmall(variant: number, x: number, z: number, scale: number, r: () => number): void {
    const geo = this.smallSizes[variant];
    const radius = geo.radius * scale;
    const debris = variant === SMALL_VARIANT.debris;
    const fp = fitFootprint(this.sampler, x, z, radius * 0.6, 4, _fp);
    const follow = debris ? 0.95 : 0.72;
    groundQuaternion(fp.normal, r() * Math.PI * 2, follow, _quat);
    // A debris cluster already carries its own bedding — every stone in it was
    // modelled half-buried — so settling it again would swallow the whole drift.
    const sink = debris ? fp.rise * 0.5 : settleDepth(radius, fp, follow, 0.06 + 0.14 * r());
    _pos.set(x, fp.height - sink, z);
    this.smallSet.add(_pos, _quat, scale, variant, r());
  }

  /** Fragments thrown off a parent rock, biased downhill. */
  private addDrift(x: number, z: number, parentRadius: number, count: number, r: () => number): void {
    this.terrain.normalAtFast(x, z, _n);
    const dx = _n.x;
    const dz = _n.z;
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const d = parentRadius * (1.15 + r() * 2.4);
      const fx = x + Math.cos(a) * d + dx * parentRadius * 2.2 * r();
      const fz = z + Math.sin(a) * d + dz * parentRadius * 2.2 * r();
      if (Math.abs(fx) > HALF_WORLD - 8 || Math.abs(fz) > HALF_WORLD - 8) continue;
      if (this.terrain.heightAtFast(fx, fz) < WATER_LEVEL - 0.5) continue;
      const variant = r() < 0.35 ? SMALL_VARIANT.debris : SMALL_VARIANT.stone;
      this.addSmall(variant, fx, fz, 0.5 + r() * 1.2, r);
    }
  }

  /* -------------------------------------------------- environmental story -- */

  private placeStories(): void {
    const rng = makeRng(0x2b0d);
    const anchors = this.storyAnchors();

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (a.kind === 'checkpoint') this.placeCheckpoint(a, rng);
      else if (a.kind === 'perimeter') this.placePerimeter(a, rng);
      else this.placeAmbush(a, rng);
    }

    this.buildTracks();
    this.structSet.finish();
  }

  /**
   * Where a story is worth telling: the approach to every plateau, which is
   * where the map itself forces traffic to funnel, plus the saddle between the
   * two ridges that the tracks have to thread.
   */
  private storyAnchors(): Anchor[] {
    const kinds: Array<Anchor['kind']> = ['checkpoint', 'perimeter', 'ambush'];
    const out: Anchor[] = [];
    for (let i = 0; i < PLATEAUS.length; i++) {
      const p = PLATEAUS[i];
      const len = Math.hypot(p.x, p.z);
      const dx = len > 1 ? -p.x / len : 0.78;
      const dz = len > 1 ? -p.z / len : 0.62;
      const reach = p.radius + 22;
      out.push({
        x: clamp(p.x + dx * reach, -HALF_WORLD + 40, HALF_WORLD - 40),
        z: clamp(p.z + dz * reach, -HALF_WORLD + 40, HALF_WORLD - 40),
        yaw: Math.atan2(dz, dx),
        kind: kinds[i % kinds.length],
      });
    }
    out.push({ x: -150, z: -60, yaw: Math.PI * 0.28, kind: 'ambush' });
    out.push({ x: 150, z: 60, yaw: Math.PI * 1.28, kind: 'checkpoint' });
    return out;
  }

  /**
   * Adds one structure, fitted to the ground. `roll` is an extra rotation for
   * the pieces that are deliberately not upright; the geometry pivots at its
   * own base, so the lift that keeps a toppled barrier out of the soil has to
   * be measured from its rotated bounds.
   */
  private addStruct(
    variant: number,
    x: number,
    z: number,
    yaw: number,
    scale: number,
    roll: THREE.Quaternion | null,
    r: () => number,
    follow = 0.88,
  ): boolean {
    if (Math.abs(x) > HALF_WORLD - 20 || Math.abs(z) > HALF_WORLD - 20) return false;
    const prop = this.structProps[variant];
    const radius = prop.radius * scale;
    const fp = fitFootprint(this.sampler, x, z, radius * 0.62, 8, _fp);
    if (fp.height < WATER_LEVEL + 0.6) return false;
    groundQuaternion(fp.normal, yaw, follow, _quat);
    let lift = 0;
    if (roll) {
      const bounds = this.structBounds[variant];
      if (bounds) lift = baseLift(bounds, roll) * scale;
      _quat.multiply(roll);
    }
    const sink = settleDepth(radius, fp, follow, 0.02 + 0.03 * r());
    _pos.set(x, fp.height + lift - sink, z);
    this.structSet.add(_pos, _quat, scale, variant, r());
    return true;
  }

  /** A barrier line dragged across an approach, with a gate and a casualty. */
  private placeCheckpoint(a: Anchor, rng: () => number): void {
    const across = a.yaw + Math.PI * 0.5;
    const cx = Math.cos(across);
    const cz = Math.sin(across);
    const fx = Math.cos(a.yaw);
    const fz = Math.sin(a.yaw);

    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue; // the gate
      const jitter = (rng() - 0.5) * 0.5;
      const px = a.x + cx * i * 2.75 + fx * jitter;
      const pz = a.z + cz * i * 2.75 + fz * jitter;
      const toppled = i === 2 || (i === -3 && rng() < 0.6);
      if (toppled) {
        _roll.setFromAxisAngle(_axisZ, Math.PI * (0.42 + rng() * 0.16) * (rng() < 0.5 ? 1 : -1));
        this.addStruct(STRUCT_VARIANT.jersey, px + fx * 1.6, pz + fz * 1.6,
          across + (rng() - 0.5) * 0.6, 1, _roll.clone(), rng, 0.95);
      } else {
        this.addStruct(STRUCT_VARIANT.jersey, px, pz, across + (rng() - 0.5) * 0.12, 1, null, rng);
      }
    }

    // Hard points either side of the gate.
    this.addStruct(STRUCT_VARIANT.wall, a.x + cx * 11 - fx * 3, a.z + cz * 11 - fz * 3,
      across + 0.15, 1, null, rng);
    this.addStruct(STRUCT_VARIANT.wall, a.x - cx * 11 - fx * 3.6, a.z - cz * 11 - fz * 3.6,
      across - 0.2, 0.9, null, rng);
    this.addStruct(STRUCT_VARIANT.rubble, a.x + cx * 8.4 + fx * 1.2, a.z + cz * 8.4 + fz * 1.2,
      rng() * 6.28, 1.1, null, rng);
    this.addStruct(STRUCT_VARIANT.rubble, a.x - cx * 12.5, a.z - cz * 12.5, rng() * 6.28, 0.85, null, rng);

    // Whatever tried to run the line.
    const wreckX = a.x + fx * 9 + cx * 6.5;
    const wreckZ = a.z + fz * 9 + cz * 6.5;
    if (this.addStruct(STRUCT_VARIANT.truck, wreckX, wreckZ, a.yaw + Math.PI + 0.5, 1, null, rng, 0.9)) {
      this.marks.patch('scorch', wreckX, wreckZ, 5.4, rng() * 6.28, _markTint.setRGB(1, 1, 1), 4);
    }

    // A wire stub behind the barriers, anchored to the wall.
    this.addFenceRun(
      a.x + cx * 12 - fx * 3.4, a.z + cz * 12 - fz * 3.4,
      a.x + cx * 12 - fx * 26, a.z + cz * 12 - fz * 26,
      rng, 0.5,
    );

    this.marks.patch('rut', a.x, a.z, 5.0, a.yaw, _markTint.setRGB(0.95, 0.92, 0.86), 4);
  }

  /** A wire perimeter around a plateau shoulder, breached in two places. */
  private placePerimeter(a: Anchor, rng: () => number): void {
    const across = a.yaw + Math.PI * 0.5;
    const cx = Math.cos(across);
    const cz = Math.sin(across);
    const fx = Math.cos(a.yaw);
    const fz = Math.sin(a.yaw);

    // Three spans laid end to end with a slight bow, so the line follows the
    // shoulder rather than cutting a chord across it.
    for (let s = -1; s <= 1; s++) {
      const bow = (1 - Math.abs(s)) * 4.5;
      const x0 = a.x + cx * (s * 30 - 15) - fx * bow;
      const z0 = a.z + cz * (s * 30 - 15) - fz * bow;
      const x1 = a.x + cx * (s * 30 + 15) - fx * (s === 0 ? bow : 0);
      const z1 = a.z + cz * (s * 30 + 15) - fz * (s === 0 ? bow : 0);
      this.addFenceRun(x0, z0, x1, z1, rng, s === 0 ? 0.45 : 0.2);
    }

    this.addStruct(STRUCT_VARIANT.wall, a.x + cx * 47, a.z + cz * 47, across, 1, null, rng);
    this.addStruct(STRUCT_VARIANT.wall, a.x - cx * 47, a.z - cz * 47, across + 0.1, 0.85, null, rng);
    this.addStruct(STRUCT_VARIANT.jersey, a.x - fx * 5 + cx * 3, a.z - fz * 5 + cz * 3, across, 1, null, rng);
    this.addStruct(STRUCT_VARIANT.rubble, a.x + cx * 16, a.z + cz * 16, rng() * 6.28, 1, null, rng);

    const wx = a.x + fx * 13 - cx * 9;
    const wz = a.z + fz * 13 - cz * 9;
    if (this.addStruct(STRUCT_VARIANT.apc, wx, wz, a.yaw - 0.9, 1, null, rng, 0.92)) {
      this.marks.patch('scorch', wx, wz, 5.8, rng() * 6.28, _markTint.setRGB(1, 1, 1), 4);
      this.marks.patch('rut', wx - fx * 7, wz - fz * 7, 4.4, a.yaw, _markTint.setRGB(0.9, 0.88, 0.84), 3);
    }
  }

  /** A column caught in the open: hulls strung along the line of march. */
  private placeAmbush(a: Anchor, rng: () => number): void {
    const fx = Math.cos(a.yaw);
    const fz = Math.sin(a.yaw);
    const cx = -fz;
    const cz = fx;

    const order = [STRUCT_VARIANT.tank, STRUCT_VARIANT.truck, STRUCT_VARIANT.tank];
    for (let i = 0; i < order.length; i++) {
      const along = (i - 1) * 17 + (rng() - 0.5) * 5;
      const side = (rng() - 0.5) * 9;
      const x = a.x + fx * along + cx * side;
      const z = a.z + fz * along + cz * side;
      if (!this.addStruct(order[i], x, z, a.yaw + (rng() - 0.5) * 1.5, 1, null, rng, 0.9)) continue;
      this.marks.patch('scorch', x, z, 6.2 + rng() * 2, rng() * 6.28, _markTint.setRGB(1, 1, 1), 4);
      this.addStruct(STRUCT_VARIANT.rubble, x + cx * 5 + fx * 2, z + cz * 5 + fz * 2,
        rng() * 6.28, 0.8 + rng() * 0.4, null, rng);
    }

    // The barricade that stopped them, shoved aside by whatever came through.
    for (let i = -1; i <= 1; i++) {
      _roll.setFromAxisAngle(_axisZ, i === 0 ? 0 : Math.PI * 0.46 * i);
      this.addStruct(STRUCT_VARIANT.jersey,
        a.x + fx * 26 + cx * i * 3.1, a.z + fz * 26 + cz * i * 3.1,
        a.yaw + Math.PI * 0.5 + (rng() - 0.5) * 0.4, 1,
        i === 0 ? null : _roll.clone(), rng, 0.95);
    }
  }

  /* ---------------------------------------------------------- fencing -- */

  /**
   * Posts, top rail and chain-link along a run, every piece dropped onto the
   * heightfield individually. Baking instead of instancing costs one draw call
   * for the whole level's wire and buys exact conformance: a fence that ignores
   * the ground it crosses is as bad a tell as a floating rock.
   */
  private addFenceRun(x0: number, z0: number, x1: number, z1: number, rng: () => number, breach: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 4) return;
    const spans = Math.max(2, Math.round(len / 3.2));
    const posts: THREE.Vector3[] = [];
    const standing: boolean[] = [];

    for (let i = 0; i <= spans; i++) {
      const t = i / spans;
      const x = x0 + dx * t;
      const z = z0 + dz * t;
      if (Math.abs(x) > HALF_WORLD - 12 || Math.abs(z) > HALF_WORLD - 12) {
        posts.push(_vecA.clone().set(x, -1e4, z));
        standing.push(false);
        continue;
      }
      const h = heightAt(x, z);
      posts.push(new THREE.Vector3(x, h, z));
      standing.push(h > WATER_LEVEL + 0.4 && slopeAt(x, z) < 0.5);
    }

    // A contiguous breach, so the gap reads as something having driven through
    // rather than as random missing pieces.
    const holeAt = Math.floor(rng() * spans);
    const holeLen = breach > 0 ? 1 + Math.floor(rng() * 2 + breach * 2) : 0;

    const yaw = Math.atan2(dz, dx);
    for (let i = 0; i <= spans; i++) {
      if (!standing[i]) continue;
      const inHole = i >= holeAt && i < holeAt + holeLen;
      const lean = inHole ? (rng() - 0.5) * 1.5 : (rng() - 0.5) * 0.16;
      const p = posts[i];
      const m = new THREE.Matrix4().compose(
        p,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(lean * 0.7, yaw, lean)),
        _one,
      );
      emitFencePost(this.fenceFrame, m, inHole ? 1.5 : 2.1, 0.25 + rng() * 0.6);
    }

    for (let i = 0; i < spans; i++) {
      if (!standing[i] || !standing[i + 1]) continue;
      const inHole = i >= holeAt - 1 && i < holeAt + holeLen;
      const a = posts[i];
      const b = posts[i + 1];
      if (!inHole) {
        _vecA.set(a.x, a.y + 1.82, a.z);
        _vecB.set(b.x, b.y + 1.82, b.z);
        emitFenceRail(this.fenceFrame, _vecA, _vecB, 0.028, 0.3 + rng() * 0.5);
        emitFencePanel(this.fenceWire, a, b, 0.05, 1.84, 0.02 + rng() * 0.06, _wireTint);
      } else if (rng() < 0.45) {
        // A torn flap still hanging off the last standing post.
        emitFencePanel(this.fenceWire, a, b, 0.02, 0.95, 0.35 + rng() * 0.3, _wireTintTorn);
      }
    }
  }

  private buildFence(metal: THREE.Material, wire: THREE.Material): void {
    if (this.fenceFrame.vertexCount > 0) {
      const geo = this.fenceFrame.build('prop-fence-frame');
      const mesh = new THREE.Mesh(geo, metal);
      mesh.name = 'prop-fence-frame';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.disposables.push(geo);
    }
    if (this.fenceWire.vertexCount > 0) {
      const geo = this.fenceWire.build('prop-fence-wire');
      const mesh = new THREE.Mesh(geo, wire);
      mesh.name = 'prop-fence-wire';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.disposables.push(geo);
    }
  }

  /* ------------------------------------------------------ ground marks -- */

  /** The route network: worn tracks between the bases and the centre. */
  private buildTracks(): void {
    const routes: Array<Array<[number, number]>> = [
      [[-300, -300], [-238, -252], [-166, -206], [-104, -152], [-58, -96]],
      [[300, 300], [238, 252], [166, 206], [104, 152], [58, 96]],
      [[-320, 300], [-268, 238], [-196, 172], [-124, 122], [-66, 82]],
      [[320, -300], [268, -238], [196, -172], [124, -122], [66, -82]],
      [[-300, -300], [-352, -206], [-346, -96], [-300, 6], [-322, 118]],
      [[300, 300], [352, 206], [346, 96], [300, -6], [322, -118]],
      [[-206, -318], [-128, -302], [-40, -286], [52, -300], [130, -330]],
      [[206, 318], [128, 302], [40, 286], [-52, 300], [-130, 330]],
    ];

    const tint = new THREE.Color(0.92, 0.90, 0.85);
    for (const route of routes) {
      const path = traceTrack(route, this.sampler, 6.5, 10);
      const runs = splitDrivable(path, this.sampler, WATER_LEVEL + 1.0, 0.40, 3);
      for (const run of runs) this.marks.ribbon(run, 1.85, 'rut', tint, 0.18);
    }
  }

  private buildGroundMarks(material: THREE.Material): void {
    const geo = this.marks.build();
    if (this.marks.triangleCount === 0) return;
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'prop-ground-marks';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // Sits under everything, so it must not fight the terrain for the depth
    // test and must never be sorted in front of the props it grounds.
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this.disposables.push(geo);
  }

  /* -------------------------------------------------------------- run -- */

  update(): void {
    const camera = this.ctx.camera;
    this.rockInstancer?.update(camera);
    this.smallInstancer?.update(camera);
    this.structInstancer?.update(camera);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

/* --------------------------------------------------------------- statics -- */

const CLIFF_PROBES = [7, 13, 21];
const TINT_WARM = new THREE.Color(1.06, 0.99, 0.88);
const TINT_COOL = new THREE.Color(0.86, 0.90, 0.97);

const _n = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _one = new THREE.Vector3(1, 1, 1);
const _vecA = new THREE.Vector3();
const _vecB = new THREE.Vector3();
const _markTint = new THREE.Color();
const _wireTint = new THREE.Color(0.85, 0.86, 0.88);
const _wireTintTorn = new THREE.Color(0.7, 0.66, 0.6);
const _fp: Footprint = { height: 0, normal: new THREE.Vector3(0, 1, 0), rise: 0, low: 0 };

export default Props;
