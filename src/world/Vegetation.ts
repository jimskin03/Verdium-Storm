import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { clamp, fbm2, makeRng, smoothstep } from '@/util/Noise';
import { HALF_WORLD, WATER_LEVEL, heightAt, normalAt } from '@/world/Heightfield';
import { getTerrainData, type TerrainData } from '@/shaders/foliage/TerrainData';
import { GrassLayer } from '@/shaders/foliage/Grass';
import { makeBarkTextures, makeLeafAtlas, type LeafAtlas } from '@/shaders/foliage/Textures';
import {
  ScatterInstancer,
  ScatterSet,
  groundQuaternion,
  jitteredScatter,
  type LodLevel,
} from '@/shaders/foliage/Scatter';
import {
  bakeImposterAtlas,
  buildTree,
  makeFoliageDepthMaterial,
  makeImposterMaterial,
  patchFoliageMaterial,
  type BuiltTree,
  type TreeKind,
} from '@/shaders/foliage/Trees';
import { buildBush, buildDeadBranch, buildFern, buildTuft } from '@/shaders/foliage/GroundCover';
import { updateWind } from '@/shaders/foliage/Wind';

/**
 * Vegetation: the grass carpet, the forests and everything growing at their
 * feet.
 *
 * Placement is decided once at boot from the baked terrain masks — slope,
 * altitude, moisture and a multi-scale forest noise — and stored in flat
 * scatter sets. Per frame the system re-centres the GPU grass rings on the
 * camera's ground focus and refills the tree/ground-cover instance buffers for
 * whichever LOD each object falls into. Nothing here allocates while running.
 *
 * Draw-call budget: 2 grass rings, 7 near-tree meshes, 6 mid-tree meshes,
 * 4 imposter billboards and 4 ground-cover meshes.
 */

const SPECIES: TreeKind[] = ['pine', 'oak', 'birch', 'dead'];

interface SpeciesRuntime {
  kind: TreeKind;
  lods: BuiltTree[];
  barkColor: number;
  meshes: THREE.InstancedMesh[][]; // [lod][0]=bark, [1]=foliage
  imposter: THREE.InstancedMesh | null;
}

export class Vegetation implements System {
  readonly name = 'vegetation';
  readonly phase = Phase.ENVIRONMENT;

  private ctx!: EngineContext;
  private terrain!: TerrainData;
  private group = new THREE.Group();

  private grass: GrassLayer[] = [];
  private species: SpeciesRuntime[] = [];
  private treeInstancer!: ScatterInstancer;
  private coverInstancer!: ScatterInstancer;
  private disposables: Array<{ dispose(): void }> = [];

  private readonly focus = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private viewDistance = 90;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.terrain = getTerrainData();
    this.group.name = 'vegetation';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    const atlas = makeLeafAtlas(ctx.quality.tier === 'low' ? 512 : 1024);
    const bark = makeBarkTextures(ctx.quality.tier === 'low' ? 64 : 128);
    this.disposables.push(atlas.texture, bark.map, bark.normalMap);

    this.buildGrass(ctx);
    this.buildTrees(ctx, atlas, bark.map, bark.normalMap);
    this.buildGroundCover(ctx, atlas);
  }

  /* ------------------------------------------------------------- grass -- */

  private buildGrass(ctx: EngineContext): void {
    const density = clamp(ctx.quality.grassDensity, 0, 1);
    if (density <= 0.01) return;

    const near = new GrassLayer(this.terrain, {
      count: Math.round(34000 * density),
      radius: 30,
      bladeWidth: 0.17,
      bladeHeight: 1.05,
      groundBlend: 0.85,
      seed: 1337,
    });
    const far = new GrassLayer(this.terrain, {
      count: Math.round(16000 * density),
      radius: 86,
      bladeWidth: 0.42,
      bladeHeight: 1.35,
      groundBlend: 1.0,
      seed: 90210,
    });
    this.grass = [near, far];
    for (const g of this.grass) {
      this.group.add(g.mesh);
      this.disposables.push(g);
    }
  }

  /* ------------------------------------------------------------- trees -- */

  private buildTrees(ctx: EngineContext, atlas: LeafAtlas, barkMap: THREE.Texture, barkNormal: THREE.Texture): void {
    const tier = ctx.quality.tier;
    const lodCount = tier === 'low' ? 1 : 2;

    const barkTints: Record<TreeKind, number> = {
      pine: 0xa88a68,
      oak: 0xb0a189,
      birch: 0xe9e6dc,
      dead: 0x9a938a,
    };

    const barkMat = new THREE.MeshStandardMaterial({
      map: barkMap,
      normalMap: barkNormal,
      normalScale: new THREE.Vector2(1.5, 1.5),
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });
    barkNormal.repeat.set(2, 1);
    patchFoliageMaterial(barkMat, { amplitude: 0.5, flutter: 0, translucency: 0 }, 'verdium-bark');

    const leafMat = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      alphaTest: 0.42,
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.78,
      metalness: 0,
    });
    patchFoliageMaterial(leafMat, { amplitude: 1.5, flutter: 0.075, translucency: 0.09 }, 'verdium-leaf');

    const leafDepth = makeFoliageDepthMaterial(atlas.texture, 0.42, { amplitude: 1.5, flutter: 0.075, translucency: 0 }, 'verdium-leafdepth');
    const barkDepth = makeFoliageDepthMaterial(null, 0, { amplitude: 0.5, flutter: 0, translucency: 0 }, 'verdium-barkdepth');
    this.disposables.push(barkMat, leafMat, leafDepth, barkDepth);

    // Every species is a fresh mesh so bark tints stay distinct; the maps and
    // shader program are shared, so this costs nothing but a material object.
    const materialsFor = (kind: TreeKind): { bark: THREE.MeshStandardMaterial; leaf: THREE.MeshStandardMaterial } => {
      const b = barkMat.clone();
      b.color = new THREE.Color(barkTints[kind]);
      b.onBeforeCompile = barkMat.onBeforeCompile;
      b.customProgramCacheKey = barkMat.customProgramCacheKey;
      this.disposables.push(b);
      return { bark: b, leaf: leafMat };
    };

    const capsL0 = tier === 'low' ? 60 : tier === 'medium' ? 110 : 190;
    const capsL1 = tier === 'low' ? 0 : tier === 'medium' ? 420 : 780;
    const capsImp = 3200;

    for (let s = 0; s < SPECIES.length; s++) {
      const kind = SPECIES[s];
      const lods: BuiltTree[] = [];
      for (let l = 0; l < lodCount; l++) {
        if (kind === 'dead' && l > 0) break;
        lods.push(buildTree(kind, atlas, l, 7717 + s * 131 + l * 17));
      }
      const mats = materialsFor(kind);
      const meshes: THREE.InstancedMesh[][] = [];

      for (let l = 0; l < lods.length; l++) {
        const cap = l === 0 ? capsL0 : capsL1;
        if (cap === 0) {
          meshes.push([]);
          continue;
        }
        const group: THREE.InstancedMesh[] = [];
        const barkMesh = new THREE.InstancedMesh(lods[l].bark, mats.bark, cap);
        barkMesh.name = `tree-${kind}-bark-${l}`;
        barkMesh.castShadow = l === 0;
        barkMesh.receiveShadow = true;
        barkMesh.frustumCulled = false;
        barkMesh.customDepthMaterial = barkDepth;
        barkMesh.count = 0;
        group.push(barkMesh);
        if (lods[l].foliage) {
          const leafMesh = new THREE.InstancedMesh(lods[l].foliage!, mats.leaf, cap);
          leafMesh.name = `tree-${kind}-leaf-${l}`;
          leafMesh.castShadow = l === 0;
          leafMesh.receiveShadow = true;
          leafMesh.frustumCulled = false;
          leafMesh.customDepthMaterial = leafDepth;
          leafMesh.count = 0;
          group.push(leafMesh);
        }
        for (const m of group) this.group.add(m);
        meshes.push(group);
      }

      this.species.push({ kind, lods, barkColor: barkTints[kind], meshes, imposter: null });
    }

    // Billboard imposters, baked from the full-detail meshes.
    let imposterCells: ReturnType<typeof bakeImposterAtlas> | null = null;
    try {
      imposterCells = bakeImposterAtlas(
        ctx.renderer,
        this.species.map((s) => ({
          kind: s.kind,
          lods: s.lods,
          height: s.lods[0].height,
          radius: s.lods[0].radius,
          barkColor: s.barkColor,
          sway: 1,
        })),
        barkMap,
        atlas.texture,
        tier === 'low' ? 256 : 512,
      );
    } catch (err) {
      console.warn('[vegetation] imposter bake unavailable', err);
    }

    if (imposterCells) {
      this.disposables.push({ dispose: () => imposterCells!.dispose() });
      const quad = new THREE.PlaneGeometry(1, 1);
      for (let s = 0; s < this.species.length; s++) {
        const mat = makeImposterMaterial(imposterCells.texture, imposterCells.cells[s], imposterCells.size[s]);
        this.disposables.push(mat);
        const mesh = new THREE.InstancedMesh(quad, mat, capsImp);
        mesh.name = `tree-${this.species[s].kind}-imposter`;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.group.add(mesh);
        this.species[s].imposter = mesh;
      }
    }

    const set = this.scatterTrees();
    const levels: LodLevel[] = [
      { distance: 95, meshes: this.species.map((s) => s.meshes[0] ?? []) },
    ];
    if (lodCount > 1) {
      levels.push({ distance: 210, meshes: this.species.map((s) => s.meshes[1] ?? s.meshes[0] ?? []) });
    }
    levels.push({
      distance: 1150,
      meshes: this.species.map((s) => (s.imposter ? [s.imposter] : [])),
    });
    this.treeInstancer = new ScatterInstancer(set, levels, 26);
  }

  /**
   * Forests come from a two-scale noise mask, not a uniform sprinkle: broad
   * stands with ragged edges, thinning onto ridges and stopping at the water
   * line, the base pads and the crystal fields.
   */
  private scatterTrees(): ScatterSet {
    const set = new ScatterSet(9000, 56);
    const rng = makeRng(0x7ee5);
    const td = this.terrain;
    const normal = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();

    const forestAt = (x: number, z: number): number => {
      const broad = fbm2(x / 168, z / 168, { octaves: 4, seed: 4242 }) * 0.5 + 0.5;
      const stands = fbm2(x / 54, z / 54, { octaves: 3, seed: 991 }) * 0.5 + 0.5;
      return clamp(smoothstep(0.42, 0.78, broad) * (0.45 + 0.75 * stands), 0, 1);
    };

    jitteredScatter(
      HALF_WORLD - 26,
      7.2,
      rng,
      (x, z) => {
        const h = td.heightAtFast(x, z);
        if (h < WATER_LEVEL + 1.6 || h > 98) return 0;
        const slope = td.slopeAtFast(x, z);
        if (slope > 0.46) return 0;
        if (td.isReserved(x, z, 14)) return 0;
        const edge = 1 - smoothstep(0.32, 0.5, slope);
        return forestAt(x, z) * edge * 0.92;
      },
      (x, z, r) => {
        const h = heightAt(x, z);
        const moisture = td.moistureAt(x, z);
        const alt = clamp((h - WATER_LEVEL) / 70, 0, 1);

        // Species stands: conifers take the high ground, oaks the damp basin,
        // birch the mid slopes. A slow noise keeps the boundaries organic.
        const bias = fbm2(x / 94, z / 94, { octaves: 3, seed: 5150 }) * 0.5 + 0.5;
        const pineW = alt * 1.5 + bias * 0.6;
        const oakW = moisture * 1.7 + (1 - alt) * 0.7 + (1 - bias) * 0.5;
        const birchW = 0.55 + Math.abs(0.5 - alt) * 0.6 + bias * 0.35;
        let variant: number;
        const pick = r() * (pineW + oakW + birchW);
        if (pick < pineW) variant = 0;
        else if (pick < pineW + oakW) variant = 1;
        else variant = 2;
        // Deadfall clusters where the ground is dry and steep — battlefield edges.
        if (r() < 0.045 + (1 - moisture) * 0.05) variant = 3;

        normalAt(x, z, normal);
        groundQuaternion(normal, r() * Math.PI * 2, 0.22, quat);
        pos.set(x, h - 0.35, z);
        const scale = 0.68 + r() * 0.62 - alt * 0.14;
        set.add(pos, quat, Math.max(0.5, scale), variant, r());
      },
    );

    set.finish();
    return set;
  }

  /* ------------------------------------------------------ ground cover -- */

  private buildGroundCover(ctx: EngineContext, atlas: LeafAtlas): void {
    const tier = ctx.quality.tier;
    const leafMat = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      alphaTest: 0.4,
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.82,
      metalness: 0,
    });
    patchFoliageMaterial(leafMat, { amplitude: 0.22, flutter: 0.045, translucency: 0.13 }, 'verdium-cover');
    const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    patchFoliageMaterial(woodMat, { amplitude: 0, flutter: 0, translucency: 0 }, 'verdium-wood');
    this.disposables.push(leafMat, woodMat);

    const geos = [
      buildBush(atlas, 4001, tier === 'low' ? 8 : 14),
      buildFern(atlas, 4002, tier === 'low' ? 5 : 8),
      buildTuft(atlas, 4003),
      buildDeadBranch(4004),
    ];
    for (const g of geos) this.disposables.push(g);

    const caps = tier === 'low' ? [180, 160, 420, 90] : tier === 'medium' ? [420, 380, 1100, 200] : [700, 620, 1900, 320];
    const meshes: THREE.InstancedMesh[][] = [];
    for (let i = 0; i < geos.length; i++) {
      const mesh = new THREE.InstancedMesh(geos[i], i === 3 ? woodMat : leafMat, caps[i]);
      mesh.name = ['bush', 'fern', 'tuft', 'deadbranch'][i];
      mesh.castShadow = i < 2;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
      meshes.push([mesh]);
    }

    const set = this.scatterGroundCover();
    this.coverInstancer = new ScatterInstancer(
      set,
      [{ distance: tier === 'low' ? 70 : 135, meshes }],
      2.5,
    );
  }

  private scatterGroundCover(): ScatterSet {
    const set = new ScatterSet(60000, 26);
    const rng = makeRng(0xc0ffee);
    const td = this.terrain;
    const normal = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();

    jitteredScatter(
      HALF_WORLD - 24,
      3.6,
      rng,
      (x, z) => {
        const h = td.heightAtFast(x, z);
        if (h < WATER_LEVEL + 0.4 || h > 104) return 0;
        const slope = td.slopeAtFast(x, z);
        if (slope > 0.52) return 0;
        const grass = td.grassAt(x, z);
        const rock = td.rockAt(x, z);
        const shelter = fbm2(x / 21, z / 21, { octaves: 3, seed: 2323 }) * 0.5 + 0.5;
        return clamp(grass * 0.5 + rock * 0.22 + shelter * 0.25, 0, 1) * 0.42;
      },
      (x, z, r) => {
        const h = heightAt(x, z);
        const moisture = td.moistureAt(x, z);
        const rock = td.rockAt(x, z);

        // Ferns want damp shade, bushes want open scrub, deadwood wants dry
        // rocky ground; tufts fill everywhere the grass ring cannot reach.
        const fernW = moisture * 2.1;
        const bushW = 0.85 + (1 - rock) * 0.6;
        const tuftW = 2.4;
        const woodW = 0.3 + rock * 1.1;
        let variant = 2;
        const pick = r() * (fernW + bushW + tuftW + woodW);
        if (pick < fernW) variant = 1;
        else if (pick < fernW + bushW) variant = 0;
        else if (pick < fernW + bushW + tuftW) variant = 2;
        else variant = 3;

        td.normalAtFast(x, z, normal);
        groundQuaternion(normal, r() * Math.PI * 2, variant === 3 ? 0.95 : 0.55, quat);
        pos.set(x, h - (variant === 3 ? 0.06 : 0.14), z);
        set.add(pos, quat, 0.65 + r() * 0.85, variant, r());
      },
    );

    set.finish();
    return set;
  }

  /* ------------------------------------------------------------ runtime -- */

  update(_dt: number, elapsed: number): void {
    updateWind(elapsed);
    const camera = this.ctx.camera;

    // Ground focus: where the camera is actually looking. Grass rings follow
    // this rather than the camera itself so a low, distant shot still puts the
    // detail budget on screen.
    camera.getWorldDirection(this.camDir);
    let ground = this.terrain.heightAtFast(camera.position.x, camera.position.z);
    let t = 0;
    for (let i = 0; i < 4; i++) {
      t = clamp((camera.position.y - ground) / Math.max(-this.camDir.y, 0.08), 0, 2600);
      const px = camera.position.x + this.camDir.x * t;
      const pz = camera.position.z + this.camDir.z * t;
      ground = this.terrain.heightAtFast(px, pz);
    }
    this.focus.copy(camera.position).addScaledVector(this.camDir, t);
    this.focus.x = clamp(this.focus.x, -HALF_WORLD, HALF_WORLD);
    this.focus.z = clamp(this.focus.z, -HALF_WORLD, HALF_WORLD);
    this.viewDistance = camera.position.distanceTo(this.focus);

    for (const g of this.grass) g.setFocus(this.focus.x, this.focus.z, this.viewDistance);
    this.treeInstancer?.update(camera);
    this.coverInstancer?.update(camera);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const s of this.species) for (const l of s.lods) {
      l.bark.dispose();
      l.foliage?.dispose();
    }
    this.group.removeFromParent();
  }
}

export default Vegetation;
