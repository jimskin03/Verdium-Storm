import * as THREE from 'three';

/**
 * Placement store + LOD instancer.
 *
 * Scattering is decided once at boot and stored in flat typed arrays. Every
 * frame the instancer walks only the grid cells near the camera, frustum-culls
 * whole cells at a time, and refills the instance buffers of whichever LOD each
 * object lands in. Nothing allocates on the per-frame path.
 */

export class ScatterSet {
  private cap: number;
  count = 0;

  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  scale: Float32Array;
  variant: Uint8Array;
  tint: Float32Array;

  readonly cellSize: number;
  private grid = new Map<number, number[]>();
  private cellY = new Map<number, number>();

  constructor(capacity: number, cellSize = 48) {
    this.cap = capacity;
    this.cellSize = cellSize;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.qx = new Float32Array(capacity);
    this.qy = new Float32Array(capacity);
    this.qz = new Float32Array(capacity);
    this.qw = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.variant = new Uint8Array(capacity);
    this.tint = new Float32Array(capacity);
  }

  add(pos: THREE.Vector3, quat: THREE.Quaternion, scale: number, variant: number, tint: number): void {
    if (this.count >= this.cap) return;
    const i = this.count++;
    this.px[i] = pos.x;
    this.py[i] = pos.y;
    this.pz[i] = pos.z;
    this.qx[i] = quat.x;
    this.qy[i] = quat.y;
    this.qz[i] = quat.z;
    this.qw[i] = quat.w;
    this.scale[i] = scale;
    this.variant[i] = variant;
    this.tint[i] = tint;
  }

  /** Buckets placements into a uniform grid; call once after the last `add`. */
  finish(): void {
    this.grid.clear();
    this.cellY.clear();
    const sums = new Map<number, [number, number]>();
    for (let i = 0; i < this.count; i++) {
      const key = this.key(this.px[i], this.pz[i]);
      let list = this.grid.get(key);
      if (!list) {
        list = [];
        this.grid.set(key, list);
      }
      list.push(i);
      const s = sums.get(key) ?? [0, 0];
      s[0] += this.py[i];
      s[1]++;
      sums.set(key, s);
    }
    for (const [key, [sum, n]] of sums) this.cellY.set(key, sum / n);
  }

  private key(x: number, z: number): number {
    const cx = Math.floor(x / this.cellSize) + 1024;
    const cz = Math.floor(z / this.cellSize) + 1024;
    return cx * 4096 + cz;
  }

  /**
   * Visits every placement in cells overlapping the radius, skipping whole
   * cells that fall outside the frustum.
   */
  query(
    cx: number,
    cz: number,
    radius: number,
    frustum: THREE.Frustum | null,
    cellHeight: number,
    visit: (i: number) => void,
  ): void {
    const s = this.cellSize;
    const i0 = Math.floor((cx - radius) / s);
    const i1 = Math.floor((cx + radius) / s);
    const j0 = Math.floor((cz - radius) / s);
    const j1 = Math.floor((cz + radius) / s);
    const sphere = _sphere;
    const cellRadius = s * 0.7072 + cellHeight;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = (i + 1024) * 4096 + (j + 1024);
        const list = this.grid.get(key);
        if (!list) continue;
        if (frustum) {
          sphere.center.set((i + 0.5) * s, (this.cellY.get(key) ?? 0) + cellHeight * 0.4, (j + 0.5) * s);
          sphere.radius = cellRadius;
          if (!frustum.intersectsSphere(sphere)) continue;
        }
        for (const idx of list) visit(idx);
      }
    }
  }
}

const _sphere = new THREE.Sphere();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _color = new THREE.Color();
const _projScreen = new THREE.Matrix4();

export interface LodLevel {
  /** Objects closer than this (world units) use this level. */
  distance: number;
  /**
   * Per variant, the instanced meshes that share one instance matrix — a tree
   * is bark plus foliage, so both get the same transform. An empty group drops
   * that variant from this level.
   */
  meshes: Array<THREE.InstancedMesh[]>;
  /** Per-instance tinting via `instanceColor`. */
  tintA?: THREE.Color;
  tintB?: THREE.Color;
}

/**
 * Fills a set of LOD instance buffers from a `ScatterSet` each frame. The
 * refill is skipped entirely while the camera is still, which is most frames in
 * an RTS.
 */
export class ScatterInstancer {
  private readonly counts: number[][] = [];
  private readonly frustum = new THREE.Frustum();
  private lastX = Infinity;
  private lastZ = Infinity;
  private lastYaw = Infinity;
  private lastY = Infinity;

  constructor(
    private readonly set: ScatterSet,
    private readonly levels: LodLevel[],
    /** Tallest object in the set; grows the cell bounds used for culling. */
    private readonly objectHeight: number,
  ) {
    for (const lvl of this.levels) {
      this.counts.push(new Array(lvl.meshes.length).fill(0));
      for (const group of lvl.meshes) {
        for (const mesh of group ?? []) {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
        }
      }
    }
  }

  get maxDistance(): number {
    return this.levels[this.levels.length - 1].distance;
  }

  update(camera: THREE.PerspectiveCamera, force = false): void {
    const yaw = Math.atan2(camera.matrixWorld.elements[8], camera.matrixWorld.elements[10]);
    const dx = camera.position.x - this.lastX;
    const dz = camera.position.z - this.lastZ;
    const dy = camera.position.y - this.lastY;
    if (
      !force &&
      dx * dx + dz * dz < 9 &&
      Math.abs(dy) < 3 &&
      Math.abs(yaw - this.lastYaw) < 0.012
    ) {
      return;
    }
    this.lastX = camera.position.x;
    this.lastZ = camera.position.z;
    this.lastY = camera.position.y;
    this.lastYaw = yaw;

    camera.updateMatrixWorld();
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_projScreen);

    for (const c of this.counts) c.fill(0);

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const set = this.set;
    const levels = this.levels;

    set.query(cx, cz, this.maxDistance, this.frustum, this.objectHeight, (i) => {
      const ddx = set.px[i] - cx;
      const ddy = set.py[i] + this.objectHeight * 0.4 - cy;
      const ddz = set.pz[i] - cz;
      const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      for (let l = 0; l < levels.length; l++) {
        if (d > levels[l].distance) continue;
        const v = set.variant[i];
        const group = levels[l].meshes[v];
        if (!group || group.length === 0) return;
        const slot = this.counts[l][v];
        for (const mesh of group) if (slot >= mesh.instanceMatrix.count) return;
        _pos.set(set.px[i], set.py[i], set.pz[i]);
        _quat.set(set.qx[i], set.qy[i], set.qz[i], set.qw[i]);
        _scl.setScalar(set.scale[i]);
        _mat.compose(_pos, _quat, _scl);
        const tinted = levels[l].tintA && levels[l].tintB;
        if (tinted) _color.copy(levels[l].tintA!).lerp(levels[l].tintB!, set.tint[i]);
        for (const mesh of group) {
          mesh.setMatrixAt(slot, _mat);
          if (tinted && mesh.instanceColor) mesh.setColorAt(slot, _color);
        }
        this.counts[l][v] = slot + 1;
        return;
      }
    });

    for (let l = 0; l < levels.length; l++) {
      for (let v = 0; v < levels[l].meshes.length; v++) {
        for (const mesh of levels[l].meshes[v] ?? []) {
          mesh.count = this.counts[l][v];
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }
}

/**
 * Jittered-grid (approximate Poisson) sampling over the map. Uniform random
 * scatter reads as procedural instantly; a jittered lattice with a density
 * callback gives natural clumping without clumps of doubles.
 */
export function jitteredScatter(
  halfExtent: number,
  spacing: number,
  rng: () => number,
  density: (x: number, z: number) => number,
  place: (x: number, z: number, rng: () => number) => void,
): void {
  const n = Math.ceil((halfExtent * 2) / spacing);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -halfExtent + (i + rng()) * spacing;
      const z = -halfExtent + (j + rng()) * spacing;
      if (rng() > density(x, z)) continue;
      place(x, z, rng);
    }
  }
}

/** Quaternion that stands an object on the ground, partly following the slope. */
export function groundQuaternion(
  normal: THREE.Vector3,
  yaw: number,
  follow: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _upTmp.set(0, 1, 0).lerp(normal, follow).normalize();
  out.setFromUnitVectors(_upRef, _upTmp);
  _tiltQuat.setFromAxisAngle(_upRef, yaw);
  return out.multiply(_tiltQuat);
}

const _upRef = new THREE.Vector3(0, 1, 0);
const _upTmp = new THREE.Vector3();
const _tiltQuat = new THREE.Quaternion();
