import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { provide, type TerrainService } from '@/engine/Services';
import {
  HALF_WORLD,
  WATER_LEVEL,
  WORLD_SIZE,
  heightAt,
  isWater,
  normalAt,
  raycastHeightfield,
  slopeAt,
} from './Heightfield';

/**
 * BASELINE terrain renderer — a single tessellated plane displaced by the
 * heightfield. This exists so the engine always has ground to stand on; the
 * production renderer (clipmap LOD, splat-mapped PBR, parallax occlusion) lives
 * in TerrainRenderer.ts and takes over when present.
 */
export class Terrain implements System {
  readonly name = 'terrain';
  readonly phase = Phase.ENVIRONMENT;

  mesh!: THREE.Mesh;
  private geometry!: THREE.PlaneGeometry;
  private material!: THREE.MeshStandardMaterial;

  init(ctx: EngineContext): void {
    const segments = ctx.quality.tier === 'low' ? 256 : 512;
    this.geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
    this.geometry.rotateX(-Math.PI / 2);

    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const color = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);

      const slope = slopeAt(x, z);
      if (h < WATER_LEVEL + 3) color.setHex(0x6b6146);
      else if (slope > 0.42) color.setHex(0x5b5750);
      else if (h > 78) color.setHex(0x7a7566);
      else color.setHex(0x455c33);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    pos.needsUpdate = true;
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.computeVertexNormals();

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
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
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
