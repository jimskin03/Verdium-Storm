import * as THREE from 'three';

/**
 * A tiny append-only geometry accumulator.
 *
 * Everything organic in this stream — trunks, branches, leaf cards, rock
 * facets, crystal shards, wrecks — is built by pushing vertices into one of
 * these and calling `build()`. Keeping a single vertex layout (position,
 * normal, uv, colour, wind weight) means any two builders can be merged, which
 * is how dozens of authored props collapse into a handful of draw calls.
 */
export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uvs: number[] = [];
  private readonly col: number[] = [];
  private readonly wnd: number[] = [];
  private readonly idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vertex(
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r: number, g: number, b: number,
    wind: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.col.push(r, g, b);
    this.wnd.push(wind);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Appends another builder's contents, optionally transformed. */
  append(other: GeoBuilder, matrix?: THREE.Matrix4): void {
    const base = this.pos.length / 3;
    if (matrix) {
      const nm = new THREE.Matrix3().getNormalMatrix(matrix);
      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let i = 0; i < other.pos.length; i += 3) {
        p.set(other.pos[i], other.pos[i + 1], other.pos[i + 2]).applyMatrix4(matrix);
        n.set(other.nrm[i], other.nrm[i + 1], other.nrm[i + 2]).applyMatrix3(nm).normalize();
        this.pos.push(p.x, p.y, p.z);
        this.nrm.push(n.x, n.y, n.z);
      }
    } else {
      this.pos.push(...other.pos);
      this.nrm.push(...other.nrm);
    }
    this.uvs.push(...other.uvs);
    this.col.push(...other.col);
    this.wnd.push(...other.wnd);
    for (const i of other.idx) this.idx.push(i + base);
  }

  build(name = ''): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wnd, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * A flat card. Used for every leaf cluster, frond and weed tuft: cheap, and
 * with a decent alpha cut-out it beats blobby geometry for silhouette.
 *
 * `normalBlend` pulls the vertex normals away from the card plane toward
 * `softNormal` (usually the canopy's outward direction), which is what stops a
 * tree from shading like a pile of cardboard.
 */
export function addCard(
  b: GeoBuilder,
  center: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  halfWidth: number,
  halfHeight: number,
  cell: { u0: number; v0: number; u1: number; v1: number },
  color: THREE.Color,
  wind: number,
  softNormal?: THREE.Vector3,
  normalBlend = 0.75,
  pivotAtBase = false,
): void {
  _u.copy(right).multiplyScalar(halfWidth);
  _v.copy(up).multiplyScalar(halfHeight);
  _n.crossVectors(right, up).normalize();

  const yOff = pivotAtBase ? 1 : 0;
  const corners: Array<[number, number, number, number]> = [
    [-1, -1 + yOff, cell.u0, cell.v0],
    [1, -1 + yOff, cell.u1, cell.v0],
    [1, 1 + yOff, cell.u1, cell.v1],
    [-1, 1 + yOff, cell.u0, cell.v1],
  ];

  const ids: number[] = [];
  for (const [sx, sy, u, v] of corners) {
    const px = center.x + _u.x * sx + _v.x * sy;
    const py = center.y + _u.y * sx + _v.y * sy;
    const pz = center.z + _u.z * sx + _v.z * sy;
    let nx = _n.x;
    let ny = _n.y;
    let nz = _n.z;
    if (softNormal) {
      nx = nx * (1 - normalBlend) + softNormal.x * normalBlend;
      ny = ny * (1 - normalBlend) + softNormal.y * normalBlend;
      nz = nz * (1 - normalBlend) + softNormal.z * normalBlend;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
    }
    // Cards near the tip of the card sway more than at the attachment point.
    const w = wind * (pivotAtBase ? (sy - yOff + 1) * 0.5 : 1);
    ids.push(b.vertex(px, py, pz, nx, ny, nz, u, v, color.r, color.g, color.b, w));
  }
  // A single quad: the card material is double sided, and three flips the
  // shading normal for back faces, so both sides light correctly.
  b.quad(ids[0], ids[1], ids[2], ids[3]);
}

/**
 * Sweeps a tapered tube along a poly-line with parallel-transport frames.
 * `ridge` adds per-vertex radial noise, which is what gives trunks real bark
 * relief in silhouette rather than a smooth cylinder with a texture on it.
 */
export function addTube(
  b: GeoBuilder,
  points: THREE.Vector3[],
  radii: number[],
  radial: number,
  color: (t: number, angle: number, ridge: number) => THREE.Color,
  wind: (t: number) => number,
  uvScale: [number, number],
  ridge: (t: number, angle: number) => number,
  closeTip = true,
): void {
  const n = points.length;
  if (n < 2) return;

  // Parallel-transport an initial frame along the curve so the tube does not
  // twist where the direction turns.
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const c = points[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(c, a).normalize());
  }
  let normal = new THREE.Vector3(1, 0, 0);
  if (Math.abs(tangents[0].dot(normal)) > 0.9) normal.set(0, 0, 1);
  normal.crossVectors(tangents[0], normal).normalize();

  const rings: number[][] = [];
  let vAccum = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(tangents[i - 1], tangents[i]);
      const len = axis.length();
      if (len > 1e-5) {
        const angle = Math.atan2(len, tangents[i - 1].dot(tangents[i]));
        normal = normal.clone().applyAxisAngle(axis.divideScalar(len), angle).normalize();
      }
      vAccum += points[i].distanceTo(points[i - 1]);
    }
    const binormal = new THREE.Vector3().crossVectors(tangents[i], normal).normalize();
    const t = i / (n - 1);
    const ring: number[] = [];
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const rg = ridge(t, a);
      const r = radii[i] * (1 + rg);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = normal.x * ca + binormal.x * sa;
      const dy = normal.y * ca + binormal.y * sa;
      const dz = normal.z * ca + binormal.z * sa;
      const c = color(t, a, rg);
      ring.push(
        b.vertex(
          points[i].x + dx * r, points[i].y + dy * r, points[i].z + dz * r,
          dx, dy, dz,
          (k / radial) * uvScale[0], vAccum * uvScale[1],
          c.r, c.g, c.b,
          wind(t),
        ),
      );
    }
    rings.push(ring);
  }

  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      b.quad(rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]);
    }
  }

  if (closeTip) {
    const tip = points[n - 1];
    const c = color(1, 0, 0);
    const tipId = b.vertex(
      tip.x, tip.y, tip.z,
      tangents[n - 1].x, tangents[n - 1].y, tangents[n - 1].z,
      0.5, vAccum * uvScale[1],
      c.r, c.g, c.b,
      wind(1),
    );
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      b.tri(rings[n - 1][k], rings[n - 1][k2], tipId);
    }
  }
}

/** Welds coincident vertices and reindexes. Keeps custom attributes intact. */
export function weld(geometry: THREE.BufferGeometry, tolerance = 1e-4): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const attrs = Object.keys(geometry.attributes);
  const map = new Map<string, number>();
  const remap = new Int32Array(pos.count);
  const inv = 1 / tolerance;
  const out: Record<string, number[]> = {};
  for (const a of attrs) out[a] = [];
  let next = 0;

  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * inv)},${Math.round(pos.getY(i) * inv)},${Math.round(pos.getZ(i) * inv)}`;
    const found = map.get(key);
    if (found !== undefined) {
      remap[i] = found;
      continue;
    }
    map.set(key, next);
    remap[i] = next;
    next++;
    for (const a of attrs) {
      const attr = geometry.getAttribute(a) as THREE.BufferAttribute;
      for (let c = 0; c < attr.itemSize; c++) out[a].push(attr.array[i * attr.itemSize + c] as number);
    }
  }

  const index = geometry.getIndex();
  const newIndex: number[] = [];
  if (index) {
    for (let i = 0; i < index.count; i++) newIndex.push(remap[index.getX(i)]);
  } else {
    for (let i = 0; i < pos.count; i++) newIndex.push(remap[i]);
  }

  const g = new THREE.BufferGeometry();
  for (const a of attrs) {
    const attr = geometry.getAttribute(a) as THREE.BufferAttribute;
    g.setAttribute(a, new THREE.Float32BufferAttribute(out[a], attr.itemSize));
  }
  g.setIndex(newIndex);
  return g;
}
