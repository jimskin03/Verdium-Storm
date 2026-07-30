import * as THREE from 'three';
import { TEAM_COLORS } from '@/entities/Types';
import { RESOURCE_FIELDS, heightAt } from '@/world/Heightfield';
import { makeRng } from '@/util/Noise';
import { MAX_PROJECTILES, type ProjectileStore } from './Entities';

/**
 * The simulation's own presentation layer: things that are part of the game
 * rather than part of the art pipeline — projectiles in flight, selection
 * rings, Verdium deposits that shrink as they are mined — plus a compact
 * fallback for explosions and tracers used whenever the effects stream has not
 * registered a service yet.
 *
 * Everything is instanced and pooled. No allocation happens on the frame path.
 */

const MAX_PUFFS = 192;
const MAX_BEAMS = 96;
const MAX_RINGS = 96;

function radialTexture(sharpness: number): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(Math.max(0, 1 - d), sharpness);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

interface PuffPool {
  mesh: THREE.InstancedMesh;
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  s0: Float32Array; s1: Float32Array;
  age: Float32Array; life: Float32Array;
  r: Float32Array; g: Float32Array; b: Float32Array;
  cursor: number;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class SimVfx {
  private root = new THREE.Group();
  private fire: PuffPool;
  private smoke: PuffPool;

  private beamMesh: THREE.InstancedMesh;
  private beamAge = new Float32Array(MAX_BEAMS);
  private beamLife = new Float32Array(MAX_BEAMS);
  private beamMat = new Float32Array(MAX_BEAMS * 16);
  private beamCursor = 0;

  private projMesh: THREE.InstancedMesh;
  private ringMesh: THREE.InstancedMesh;
  private crystalMesh: THREE.InstancedMesh;
  private crystalField: Int32Array;
  private crystalBase: Float32Array;
  private crystalCount = 0;

  private softTex: THREE.DataTexture;
  private hardTex: THREE.DataTexture;
  private materials: THREE.Material[] = [];
  private rng = makeRng(0x5eed12);

  constructor(parent: THREE.Object3D) {
    this.root.name = 'sim-vfx';
    parent.add(this.root);

    this.softTex = radialTexture(1.6);
    this.hardTex = radialTexture(0.7);

    this.fire = this.makePuffPool(this.hardTex, THREE.AdditiveBlending, 4);
    this.smoke = this.makePuffPool(this.softTex, THREE.NormalBlending, 2);

    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    });
    this.materials.push(beamMat);
    const beamGeo = new THREE.BoxGeometry(1, 1, 1);
    beamGeo.translate(0, 0, 0.5);
    this.beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, MAX_BEAMS);
    this.beamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beamMesh.frustumCulled = false;
    this.beamMesh.count = 0;
    this.beamMesh.renderOrder = 6;
    this.root.add(this.beamMesh);

    const projMat = new THREE.MeshStandardMaterial({
      color: 0x2a2622, emissive: new THREE.Color(0xffb257), emissiveIntensity: 2.4,
      roughness: 0.5, metalness: 0.2, toneMapped: true,
    });
    this.materials.push(projMat);
    const projGeo = new THREE.CylinderGeometry(0.26, 0.16, 1.6, 6);
    projGeo.rotateX(Math.PI / 2);
    this.projMesh = new THREE.InstancedMesh(projGeo, projMat, MAX_PROJECTILES);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.frustumCulled = false;
    this.projMesh.castShadow = false;
    this.projMesh.count = 0;
    this.root.add(this.projMesh);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    });
    this.materials.push(ringMat);
    const ringGeo = new THREE.RingGeometry(0.86, 1.0, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS);
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 8;
    this.ringMesh.count = 0;
    this.root.add(this.ringMesh);

    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x1c5f4a, emissive: new THREE.Color(0x35d99a), emissiveIntensity: 0.55,
      roughness: 0.28, metalness: 0.1, flatShading: true,
    });
    this.materials.push(crystalMat);
    const crystalGeo = new THREE.ConeGeometry(0.62, 2.6, 5);
    crystalGeo.translate(0, 1.3, 0);
    const { mesh, fields, base, count } = this.buildCrystals(crystalGeo, crystalMat);
    this.crystalMesh = mesh;
    this.crystalField = fields;
    this.crystalBase = base;
    this.crystalCount = count;
    this.root.add(this.crystalMesh);
  }

  private makePuffPool(tex: THREE.Texture, blending: THREE.Blending, renderOrder: number): PuffPool {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending, depthWrite: false, depthTest: true,
      toneMapped: false, vertexColors: false,
    });
    this.materials.push(mat);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_PUFFS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.count = 0;
    this.root.add(mesh);
    return {
      mesh,
      x: new Float32Array(MAX_PUFFS), y: new Float32Array(MAX_PUFFS), z: new Float32Array(MAX_PUFFS),
      vx: new Float32Array(MAX_PUFFS), vy: new Float32Array(MAX_PUFFS), vz: new Float32Array(MAX_PUFFS),
      s0: new Float32Array(MAX_PUFFS), s1: new Float32Array(MAX_PUFFS),
      age: new Float32Array(MAX_PUFFS).fill(1e9), life: new Float32Array(MAX_PUFFS).fill(1),
      r: new Float32Array(MAX_PUFFS), g: new Float32Array(MAX_PUFFS), b: new Float32Array(MAX_PUFFS),
      cursor: 0,
    };
  }

  private buildCrystals(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
  ): { mesh: THREE.InstancedMesh; fields: Int32Array; base: Float32Array; count: number } {
    const rng = makeRng(0x1cea51);
    const perField = 34;
    const total = RESOURCE_FIELDS.length * perField;
    const mesh = new THREE.InstancedMesh(geo, mat, total);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const fields = new Int32Array(total);
    // x, y, z, yaw, scale per instance.
    const base = new Float32Array(total * 5);
    let n = 0;
    for (let f = 0; f < RESOURCE_FIELDS.length; f++) {
      const field = RESOURCE_FIELDS[f];
      for (let c = 0; c < perField; c++) {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * field.radius * 0.92;
        const x = field.x + Math.cos(a) * r;
        const z = field.z + Math.sin(a) * r;
        fields[n] = f;
        const o = n * 5;
        base[o] = x;
        base[o + 1] = heightAt(x, z) - 0.3;
        base[o + 2] = z;
        base[o + 3] = rng() * Math.PI * 2;
        base[o + 4] = 0.8 + rng() * 1.5;
        n++;
      }
    }
    mesh.count = n;
    return { mesh, fields, base, count: n };
  }

  /** Scales each deposit's crystals by the fraction of ore left in it. */
  updateFields(fractions: Float32Array): void {
    for (let n = 0; n < this.crystalCount; n++) {
      const f = fractions[this.crystalField[n]];
      const o = n * 5;
      const s = base01(f) * this.crystalBase[o + 4];
      tmpV.set(this.crystalBase[o], this.crystalBase[o + 1], this.crystalBase[o + 2]);
      tmpQ.setFromAxisAngle(UP, this.crystalBase[o + 3]);
      tmpS.set(s, s * (0.7 + 0.6 * f), s);
      tmpM.compose(tmpV, tmpQ, tmpS);
      this.crystalMesh.setMatrixAt(n, tmpM);
    }
    this.crystalMesh.instanceMatrix.needsUpdate = true;
  }

  /* ---------- effect spawners ---------- */

  private spawnPuff(
    pool: PuffPool, x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    s0: number, s1: number, life: number, color: number,
  ): void {
    const i = pool.cursor;
    pool.cursor = (pool.cursor + 1) % MAX_PUFFS;
    pool.x[i] = x; pool.y[i] = y; pool.z[i] = z;
    pool.vx[i] = vx; pool.vy[i] = vy; pool.vz[i] = vz;
    pool.s0[i] = s0; pool.s1[i] = s1;
    pool.age[i] = 0; pool.life[i] = life;
    tmpC.setHex(color);
    pool.r[i] = tmpC.r; pool.g[i] = tmpC.g; pool.b[i] = tmpC.b;
  }

  explosion(x: number, y: number, z: number, scale: number, kind: string): void {
    const big = kind === 'building' || kind === 'vehicle';
    this.spawnPuff(this.fire, x, y + scale * 0.3, z, 0, scale * 0.9, 0,
      scale * 1.4, scale * 4.2, 0.34, 0xfff0c0);
    this.spawnPuff(this.fire, x, y + scale * 0.5, z, 0, scale * 1.5, 0,
      scale * 2.4, scale * 6.5, 0.55, 0xff8a2a);
    for (let n = 0; n < (big ? 3 : 1); n++) {
      const a = this.rng() * Math.PI * 2;
      const sp = scale * (0.5 + this.rng());
      this.spawnPuff(this.smoke, x, y + scale * 0.4, z,
        Math.cos(a) * sp * 0.4, scale * (0.8 + this.rng() * 0.8), Math.sin(a) * sp * 0.4,
        scale * 2.0, scale * 8.0, 1.5 + this.rng(), 0x2a2520);
    }
  }

  muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, scale: number): void {
    this.spawnPuff(this.fire, x + dx * scale * 0.4, y + dy * scale * 0.4, z + dz * scale * 0.4,
      dx * 4, dy * 4 + 1, dz * 4, scale * 1.6, scale * 0.4, 0.11, 0xffd88a);
    this.spawnPuff(this.smoke, x + dx * scale, y + dy * scale, z + dz * scale,
      dx * 3, 2.2, dz * 3, scale * 0.8, scale * 3.4, 0.7, 0x6b665c);
  }

  impact(x: number, y: number, z: number, scale: number): void {
    this.spawnPuff(this.smoke, x, y + 0.4, z, 0, 3.2, 0, scale * 0.6, scale * 3.0, 0.55, 0x7d7460);
    this.spawnPuff(this.fire, x, y + 0.4, z, 0, 1.2, 0, scale * 0.9, scale * 1.8, 0.1, 0xffcc88);
  }

  /** A fading beam used for hitscan weapons. */
  beam(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, width: number): void {
    const i = this.beamCursor;
    this.beamCursor = (this.beamCursor + 1) % MAX_BEAMS;
    tmpV.set(x0, y0, z0);
    tmpV2.set(x1 - x0, y1 - y0, z1 - z0);
    const len = tmpV2.length();
    if (len < 1e-3) return;
    tmpV2.divideScalar(len);
    tmpQ.setFromUnitVectors(FORWARD, tmpV2);
    tmpS.set(width, width, len);
    tmpM.compose(tmpV, tmpQ, tmpS);
    tmpM.toArray(this.beamMat, i * 16);
    this.beamAge[i] = 0;
    this.beamLife[i] = 0.075;
  }

  /* ---------- per-frame ---------- */

  update(dt: number, camera: THREE.Camera): void {
    this.updatePuffs(this.fire, dt, camera, true);
    this.updatePuffs(this.smoke, dt, camera, false);

    let bn = 0;
    for (let i = 0; i < MAX_BEAMS; i++) {
      if (this.beamAge[i] >= this.beamLife[i]) continue;
      this.beamAge[i] += dt;
      if (this.beamAge[i] >= this.beamLife[i]) continue;
      tmpM.fromArray(this.beamMat, i * 16);
      this.beamMesh.setMatrixAt(bn++, tmpM);
      if (bn >= MAX_BEAMS) break;
    }
    this.beamMesh.count = bn;
    this.beamMesh.visible = bn > 0;
    this.beamMesh.instanceMatrix.needsUpdate = true;
  }

  private updatePuffs(pool: PuffPool, dt: number, camera: THREE.Camera, additive: boolean): void {
    let n = 0;
    const q = camera.quaternion;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (pool.age[i] >= pool.life[i]) continue;
      pool.age[i] += dt;
      if (pool.age[i] >= pool.life[i]) continue;
      const t = pool.age[i] / pool.life[i];
      pool.x[i] += pool.vx[i] * dt;
      pool.y[i] += pool.vy[i] * dt;
      pool.z[i] += pool.vz[i] * dt;
      pool.vy[i] += (additive ? 6 : 2.2) * dt;
      pool.vx[i] *= 1 - dt * 1.4;
      pool.vz[i] *= 1 - dt * 1.4;
      const size = pool.s0[i] + (pool.s1[i] - pool.s0[i]) * t;
      const fade = additive ? (1 - t) * (1 - t) : Math.sin(Math.PI * Math.min(1, t * 1.3)) * 0.55;
      tmpV.set(pool.x[i], pool.y[i], pool.z[i]);
      tmpS.set(size, size, size);
      tmpM.compose(tmpV, q, tmpS);
      pool.mesh.setMatrixAt(n, tmpM);
      tmpC.setRGB(pool.r[i] * fade, pool.g[i] * fade, pool.b[i] * fade);
      pool.mesh.setColorAt(n, tmpC);
      n++;
      if (n >= MAX_PUFFS) break;
    }
    pool.mesh.count = n;
    pool.mesh.visible = n > 0;
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
  }

  /** Writes projectile transforms straight from the simulation store. */
  syncProjectiles(store: ProjectileStore, alpha: number, dt: number): void {
    let n = 0;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (!store.alive[i]) continue;
      const ax = store.px[i] + store.vx[i] * dt * alpha;
      const ay = store.py[i] + store.vy[i] * dt * alpha;
      const az = store.pz[i] + store.vz[i] * dt * alpha;
      tmpV.set(ax, ay, az);
      tmpV2.set(store.vx[i], store.vy[i], store.vz[i]);
      const len = tmpV2.length();
      if (len < 1e-4) continue;
      tmpV2.divideScalar(len);
      tmpQ.setFromUnitVectors(FORWARD, tmpV2);
      const stretch = Math.min(3.2, 1 + len * 0.012);
      tmpS.set(1, 1, stretch);
      tmpM.compose(tmpV, tmpQ, tmpS);
      this.projMesh.setMatrixAt(n++, tmpM);
      if (n >= MAX_PROJECTILES) break;
    }
    this.projMesh.count = n;
    this.projMesh.visible = n > 0;
    this.projMesh.instanceMatrix.needsUpdate = true;
  }

  /** Places selection rings under the given world positions. */
  setSelectionRings(
    count: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, radii: Float32Array, team: number,
  ): void {
    const n = Math.min(count, MAX_RINGS);
    tmpC.setHex(TEAM_COLORS[(team === 1 ? 1 : 0) as 0 | 1]);
    for (let i = 0; i < n; i++) {
      tmpV.set(xs[i], ys[i] + 0.45, zs[i]);
      tmpQ.identity();
      const r = radii[i] * 1.6;
      tmpS.set(r, 1, r);
      tmpM.compose(tmpV, tmpQ, tmpS);
      this.ringMesh.setMatrixAt(i, tmpM);
      this.ringMesh.setColorAt(i, tmpC);
    }
    this.ringMesh.count = n;
    this.ringMesh.visible = n > 0;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.softTex.dispose();
    this.hardTex.dispose();
    this.root.removeFromParent();
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);

function base01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : 0.25 + 0.75 * v;
}
