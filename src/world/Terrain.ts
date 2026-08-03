import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { provide, type TerrainService } from '@/engine/Services';
import {
  HALF_WORLD,
  WATER_LEVEL,
  heightAt,
  isWater,
  normalAt,
  raycastHeightfield,
  slopeAt,
} from './Heightfield';
import {
  FIELD_FAR_EXTENT,
  FIELD_NEAR_EXTENT,
  bakeTerrainField,
  synthesizeTerrainTextures,
  type TerrainFieldSet,
  type TerrainTextureSet,
} from './TerrainTextures';
import { createTerrainMaterial, type TerrainMaterialHandle } from './TerrainMaterial';

/**
 * Terrain renderer.
 *
 * The ground is a CDLOD quadtree: one instanced unit grid is re-used for every
 * node, and each frame the tree is walked from the camera to pick a node set
 * whose screen-space triangle density is roughly constant. The vertex shader
 * morphs each node's odd vertices onto its parent's grid across the top of the
 * node's range, so the joins are watertight and nothing pops when the selection
 * changes; a downward skirt ring covers the seams that remain when neighbouring
 * nodes differ by more than one level.
 *
 * The tree's root spans FIELD_FAR_EXTENT, far outside the 1024-unit playable
 * area, so the world reads as continuous landmass out to the horizon rather
 * than ending at a visible edge.
 */

/** Vertices per node edge. 32 keeps each node a single small draw's worth. */
const GRID_RES = 32;
/** Node used between size*K and size*2K from the camera. */
const LOD_FACTOR = 2.0;
const MAX_NODES = 2048;
const SKIRT_DEPTH = 2.5;

interface NodeInstance {
  x: number;
  z: number;
  size: number;
  morphStart: number;
  morphEnd: number;
}

export class Terrain implements System {
  readonly name = 'terrain';
  readonly phase = Phase.ENVIRONMENT;

  mesh!: THREE.Mesh;
  private geometry!: THREE.InstancedBufferGeometry;
  private fields!: TerrainFieldSet;
  private textures!: TerrainTextureSet;
  private handle!: TerrainMaterialHandle;

  private aNode!: THREE.InstancedBufferAttribute;
  private aMorph!: THREE.InstancedBufferAttribute;
  private nodeData!: Float32Array;
  private morphData!: Float32Array;

  private camera!: THREE.PerspectiveCamera;
  private minNodeSize = 16;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly heightRange = { min: 0, max: 0 };
  private selected: NodeInstance[] = [];
  private overflowReported = false;

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.minNodeSize = 16 * Math.max(0.5, ctx.quality.terrainLodBias);

    this.fields = bakeTerrainField(ctx.quality);
    this.textures = synthesizeTerrainTextures(ctx.renderer, ctx.quality, FIELD_NEAR_EXTENT * 2);

    this.geometry = buildNodeGeometry(GRID_RES);
    this.nodeData = new Float32Array(MAX_NODES * 3);
    this.morphData = new Float32Array(MAX_NODES * 2);
    this.aNode = new THREE.InstancedBufferAttribute(this.nodeData, 3);
    this.aMorph = new THREE.InstancedBufferAttribute(this.morphData, 2);
    this.aNode.setUsage(THREE.DynamicDrawUsage);
    this.aMorph.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aNode', this.aNode);
    this.geometry.setAttribute('aMorph', this.aMorph);
    this.geometry.instanceCount = 0;

    this.handle = createTerrainMaterial({
      fields: this.fields,
      textures: this.textures,
      gridRes: GRID_RES,
      skirtDepth: SKIRT_DEPTH,
      pom: ctx.quality.tier === 'high' || ctx.quality.tier === 'ultra',
      anisotropy: ctx.quality.anisotropy,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.handle.material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    // Terrain self-shadowing comes from the baked ground-occlusion field, not
    // from shadow maps: re-rendering 1.3M displaced triangles into every
    // cascade each frame costs far more than it buys, and the displacement
    // happens in the vertex shader so the depth pass needs its own program.
    this.mesh.castShadow = false;
    this.mesh.customDepthMaterial = this.handle.depthMaterial;
    // Node selection already culls; three cannot cull this correctly anyway
    // because every vertex is displaced in the shader.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    ctx.scene.add(this.mesh);

    const service: TerrainService = {
      heightAt,
      normalAt,
      slopeAt,
      isWater,
      halfSize: HALF_WORLD,
      waterLevel: WATER_LEVEL,
      raycast: (origin, dir, out) => raycastHeightfield(origin, dir, out),
    };
    provide('terrain', service);

    this.select();
  }

  update(): void {
    this.select();
    this.handle.setCamera(this.camera.position);
  }

  /** Walks the quadtree and refills the instance buffers. */
  private select(): void {
    this.camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.selected.length = 0;
    // Root spans the full far field, centred on the origin.
    this.visit(-FIELD_FAR_EXTENT, -FIELD_FAR_EXTENT, FIELD_FAR_EXTENT * 2, 0, 0, 0);

    const count = Math.min(this.selected.length, MAX_NODES);
    if (this.selected.length > MAX_NODES && !this.overflowReported) {
      this.overflowReported = true;
      console.warn(`[terrain] node selection overflowed (${this.selected.length} > ${MAX_NODES})`);
    }
    for (let i = 0; i < count; i++) {
      const n = this.selected[i];
      this.nodeData[i * 3] = n.x;
      this.nodeData[i * 3 + 1] = n.z;
      this.nodeData[i * 3 + 2] = n.size;
      this.morphData[i * 2] = n.morphStart;
      this.morphData[i * 2 + 1] = n.morphEnd;
    }
    this.aNode.needsUpdate = true;
    this.aMorph.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  private visit(x: number, z: number, size: number, depth: number, ix: number, iz: number): void {
    this.fields.bounds.range(depth, ix, iz, this.heightRange);
    this.box.min.set(x, this.heightRange.min - SKIRT_DEPTH * size / GRID_RES, z);
    this.box.max.set(x + size, this.heightRange.max, z + size);
    if (!this.frustum.intersectsBox(this.box)) return;

    const dist = this.box.distanceToPoint(this.camera.position);
    const range = size * LOD_FACTOR;

    if (size > this.minNodeSize && dist < range) {
      const half = size * 0.5;
      const d = depth + 1;
      this.visit(x, z, half, d, ix * 2, iz * 2);
      this.visit(x + half, z, half, d, ix * 2 + 1, iz * 2);
      this.visit(x, z + half, half, d, ix * 2, iz * 2 + 1);
      this.visit(x + half, z + half, half, d, ix * 2 + 1, iz * 2 + 1);
      return;
    }

    if (this.selected.length < MAX_NODES) {
      // Morph toward the parent grid across the far part of this node's band,
      // finishing just before the parent would take over.
      this.selected.push({
        x, z, size,
        morphStart: range * 1.35,
        morphEnd: range * 1.95,
      });
    }
  }

  dispose(): void {
    this.geometry?.dispose();
    this.handle?.dispose();
    this.fields?.dispose();
    this.textures?.dispose();
  }
}

/**
 * A unit grid in XZ over [0,1] plus a downward skirt around its perimeter.
 * `aSkirt` marks the skirt ring so the vertex shader can push it below the
 * surface; everything else is shared by every node in the tree.
 */
function buildNodeGeometry(res: number): THREE.InstancedBufferGeometry {
  const side = res + 1;
  const surfaceVerts = side * side;
  const perimeter = side * 4 - 4;
  const total = surfaceVerts + perimeter;

  const positions = new Float32Array(total * 3);
  const skirt = new Float32Array(total);

  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const k = (j * side + i) * 3;
      positions[k] = i / res;
      positions[k + 1] = 0;
      positions[k + 2] = j / res;
    }
  }

  // Perimeter walk, clockwise, used for both the skirt vertices and its quads.
  const ring: number[] = [];
  for (let i = 0; i < side; i++) ring.push(i);
  for (let j = 1; j < side; j++) ring.push(j * side + (side - 1));
  for (let i = side - 2; i >= 0; i--) ring.push((side - 1) * side + i);
  for (let j = side - 2; j >= 1; j--) ring.push(j * side);

  for (let r = 0; r < ring.length; r++) {
    const src = ring[r] * 3;
    const dst = (surfaceVerts + r) * 3;
    positions[dst] = positions[src];
    positions[dst + 1] = 0;
    positions[dst + 2] = positions[src + 2];
    skirt[surfaceVerts + r] = 1;
  }

  const indices: number[] = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  for (let r = 0; r < ring.length; r++) {
    const p0 = ring[r];
    const p1 = ring[(r + 1) % ring.length];
    const s0 = surfaceVerts + r;
    const s1 = surfaceVerts + ((r + 1) % ring.length);
    indices.push(p0, s0, s1, p0, s1, p1);
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));
  // A normal attribute must exist for the standard material to compile even
  // though the shader overwrites it from the baked field.
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(total * 2), 2));
  geo.setIndex(indices);
  return geo;
}
