import * as THREE from 'three';
import { clamp, smoothstep } from '@/util/Noise';
import type { Surface } from '@/entities/materials/Surface';

/**
 * Procedural part kit shared by units and structures.
 *
 * Everything in the game is assembled from chamfered convex primitives. Sharp
 * 90° edges read as untextured boxes under any lighting, so every primitive
 * here carries a chamfer: the small facets are what catch the key light and
 * give a silhouette its machined-metal read.
 *
 * The builder accumulates non-indexed triangles with flat normals plus the
 * per-vertex surface attributes the entity shader consumes, then bakes
 * ambient occlusion and convex-edge wear from a voxelised occupancy field
 * before handing back a single BufferGeometry. One geometry per entity kind =
 * one draw call per entity.
 *
 * Convention: forward is +Z, up is +Y, so `Object3D.lookAt` and
 * `rotation.y = atan2(dx, dz)` both point a rig the right way.
 */

export type Vec2 = [number, number];

interface PrimRange {
  start: number;
  end: number;
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Regular n-gon in the XY plane, used for tubes, wheels, radomes. */
export function ngon(radius: number, segments: number, phase = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = phase + (i / segments) * Math.PI * 2;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return out;
}

/** Axis-aligned rectangle polygon. */
export function rect(w: number, h: number, cx = 0, cy = 0): Vec2[] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

/**
 * Trapezoid — the workhorse for sloped armour, glacis plates and Nod's
 * predatory wedges. Width at -Y is `wBottom`, at +Y is `wTop`.
 */
export function trap(wBottom: number, wTop: number, h: number, skew = 0): Vec2[] {
  return [
    [-wBottom / 2, -h / 2],
    [wBottom / 2, -h / 2],
    [wTop / 2 + skew, h / 2],
    [-wTop / 2 + skew, h / 2],
  ];
}

export class PartBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private srf: number[] = [];
  private msc: number[] = [];
  private bix: number[] = [];
  /** Per-vertex wear responsiveness, captured from the surface at emit time. */
  private wearAt: number[] = [];

  private ranges: PrimRange[] = [];
  private stack: THREE.Matrix4[] = [];
  private m = new THREE.Matrix4();
  private nmat = new THREE.Matrix3();

  private cur: Surface;
  private curBone = 0;

  /** 0 = far LOD (silhouette only), 1 = full detail. */
  readonly detail: number;

  private tmpColor = new THREE.Color();

  constructor(defaultSurface: Surface, detail = 1) {
    this.cur = defaultSurface;
    this.detail = detail;
  }

  // ---------------------------------------------------------------- transform

  push(): this {
    this.stack.push(this.m.clone());
    return this;
  }

  pop(): this {
    const m = this.stack.pop();
    if (m) this.m.copy(m);
    return this;
  }

  identity(): this {
    this.m.identity();
    return this;
  }

  move(x: number, y: number, z: number): this {
    this.m.multiply(_tmpM.makeTranslation(x, y, z));
    return this;
  }

  rotX(a: number): this {
    this.m.multiply(_tmpM.makeRotationX(a));
    return this;
  }

  rotY(a: number): this {
    this.m.multiply(_tmpM.makeRotationY(a));
    return this;
  }

  rotZ(a: number): this {
    this.m.multiply(_tmpM.makeRotationZ(a));
    return this;
  }

  /** Mirrors subsequent geometry across X. Winding is corrected automatically. */
  mirrorX(): this {
    this.m.multiply(_tmpM.makeScale(-1, 1, 1));
    return this;
  }

  // ------------------------------------------------------------------ surface

  use(s: Surface): this {
    this.cur = s;
    return this;
  }

  bone(i: number): this {
    this.curBone = i;
    return this;
  }

  get surface(): Surface {
    return this.cur;
  }

  /** True when the current build is the full-detail LOD. */
  get fine(): boolean {
    return this.detail > 0;
  }

  // --------------------------------------------------------------- primitives

  /**
   * Chamfered box: 6 face quads, 12 edge chamfers, 8 corner triangles — 44
   * triangles that always catch a highlight along every edge.
   */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, chamfer = -1): this {
    const hx = w / 2;
    const hy = h / 2;
    const hz = d / 2;
    const c = chamfer < 0 ? Math.min(0.09 * Math.min(w, h, d), 0.16) : Math.min(chamfer, hx * 0.85, hy * 0.85, hz * 0.85);
    const start = this.pos.length / 3;

    // Three vertices per corner, one pushed out onto each of the three faces.
    const A = (sx: number, sy: number, sz: number): THREE.Vector3 =>
      new THREE.Vector3(cx + sx * hx, cy + sy * (hy - c), cz + sz * (hz - c));
    const B = (sx: number, sy: number, sz: number): THREE.Vector3 =>
      new THREE.Vector3(cx + sx * (hx - c), cy + sy * hy, cz + sz * (hz - c));
    const C = (sx: number, sy: number, sz: number): THREE.Vector3 =>
      new THREE.Vector3(cx + sx * (hx - c), cy + sy * (hy - c), cz + sz * hz);

    const centre = new THREE.Vector3(cx, cy, cz);
    const S = [-1, 1];

    for (const sx of S) this.quad([A(sx, -1, -1), A(sx, 1, -1), A(sx, 1, 1), A(sx, -1, 1)], centre);
    for (const sy of S) this.quad([B(-1, sy, -1), B(1, sy, -1), B(1, sy, 1), B(-1, sy, 1)], centre);
    for (const sz of S) this.quad([C(-1, -1, sz), C(1, -1, sz), C(1, 1, sz), C(-1, 1, sz)], centre);

    for (const sx of S)
      for (const sy of S) this.quad([A(sx, sy, -1), A(sx, sy, 1), B(sx, sy, 1), B(sx, sy, -1)], centre);
    for (const sx of S)
      for (const sz of S) this.quad([A(sx, -1, sz), A(sx, 1, sz), C(sx, 1, sz), C(sx, -1, sz)], centre);
    for (const sy of S)
      for (const sz of S) this.quad([B(-1, sy, sz), B(1, sy, sz), C(1, sy, sz), C(-1, sy, sz)], centre);

    for (const sx of S)
      for (const sy of S)
        for (const sz of S) this.tri([A(sx, sy, sz), B(sx, sy, sz), C(sx, sy, sz)], centre);

    this.closePrim(start);
    return this;
  }

  /** Plain 12-triangle box. For parts small or dark enough not to need chamfers. */
  slab(cx: number, cy: number, cz: number, w: number, h: number, d: number): this {
    const start = this.pos.length / 3;
    const centre = new THREE.Vector3(cx, cy, cz);
    const p = (sx: number, sy: number, sz: number): THREE.Vector3 =>
      new THREE.Vector3(cx + (sx * w) / 2, cy + (sy * h) / 2, cz + (sz * d) / 2);
    const S = [-1, 1];
    for (const sx of S) this.quad([p(sx, -1, -1), p(sx, 1, -1), p(sx, 1, 1), p(sx, -1, 1)], centre);
    for (const sy of S) this.quad([p(-1, sy, -1), p(1, sy, -1), p(1, sy, 1), p(-1, sy, 1)], centre);
    for (const sz of S) this.quad([p(-1, -1, sz), p(1, -1, sz), p(1, 1, sz), p(-1, 1, sz)], centre);
    this.closePrim(start);
    return this;
  }

  /**
   * Chamfered extrusion of a convex polygon along Z. This is the general case:
   * boxes, wedges, hex turrets, cylinders and cones are all polygons with a
   * chamfer, which keeps the whole model's edge treatment consistent.
   */
  prism(poly: Vec2[], depth: number, chamfer = 0.08, cx = 0, cy = 0, cz = 0, cutCorners = true): this {
    const n = poly.length;
    if (n < 3) return this;
    const hz = depth / 2;
    const c = Math.min(chamfer, hz * 0.9);
    const start = this.pos.length / 3;

    // Cut every polygon corner so the vertical edges get a chamfer facet too.
    const q: Vec2[] = [];
    if (!cutCorners) q.push(...poly);
    else for (let i = 0; i < n; i++) {
      const p = poly[i];
      const prev = poly[(i - 1 + n) % n];
      const next = poly[(i + 1) % n];
      const d0x = p[0] - prev[0];
      const d0y = p[1] - prev[1];
      const l0 = Math.hypot(d0x, d0y) || 1;
      const d1x = next[0] - p[0];
      const d1y = next[1] - p[1];
      const l1 = Math.hypot(d1x, d1y) || 1;
      const k0 = Math.min(c, l0 * 0.45);
      const k1 = Math.min(c, l1 * 0.45);
      q.push([p[0] - (d0x / l0) * k0, p[1] - (d0y / l0) * k0]);
      q.push([p[0] + (d1x / l1) * k1, p[1] + (d1y / l1) * k1]);
    }

    // Centroid-directed inset stands in for a miter offset; the polygons here
    // are convex and roughly centred, so the error is well under a millimetre
    // at model scale and never self-intersects.
    let gx = 0;
    let gy = 0;
    for (const p of q) {
      gx += p[0];
      gy += p[1];
    }
    gx /= q.length;
    gy /= q.length;

    const inset: Vec2[] = q.map((p) => {
      const dx = gx - p[0];
      const dy = gy - p[1];
      const l = Math.hypot(dx, dy) || 1;
      const k = Math.min(c, l * 0.75);
      return [p[0] + (dx / l) * k, p[1] + (dy / l) * k];
    });

    const centre = new THREE.Vector3(cx + gx, cy + gy, cz);
    const m = q.length;
    const S = (i: number, z: number): THREE.Vector3 => new THREE.Vector3(cx + q[i][0], cy + q[i][1], cz + z);
    const K = (i: number, z: number): THREE.Vector3 => new THREE.Vector3(cx + inset[i][0], cy + inset[i][1], cz + z);

    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      this.quad([S(i, -hz + c), S(j, -hz + c), S(j, hz - c), S(i, hz - c)], centre);
      this.quad([S(i, hz - c), S(j, hz - c), K(j, hz), K(i, hz)], centre);
      this.quad([S(i, -hz + c), S(j, -hz + c), K(j, -hz), K(i, -hz)], centre);
    }
    for (let i = 1; i < m - 1; i++) {
      this.tri([K(0, hz), K(i, hz), K(i + 1, hz)], centre);
      this.tri([K(0, -hz), K(i, -hz), K(i + 1, -hz)], centre);
    }

    this.closePrim(start);
    return this;
  }

  /**
   * Chamfered extrusion along +Y of a polygon given in the ground plane as
   * (x, z). Turret castings, building footprints and roof slabs all use this.
   */
  prismY(poly: Vec2[], height: number, chamfer = 0.08, cx = 0, cy = 0, cz = 0, cutCorners = true): this {
    this.push();
    this.move(cx, cy, cz);
    this.rotX(-Math.PI / 2);
    this.prism(poly.map((p) => [p[0], -p[1]] as Vec2), height, chamfer, 0, 0, 0, cutCorners);
    this.pop();
    return this;
  }

  /** Unchamfered tube along Y — cheap wheels, pipes, barrels, masts. */
  tube(
    cx: number,
    cy: number,
    cz: number,
    rTop: number,
    rBot: number,
    h: number,
    seg = 10,
    capTop = true,
    capBot = true,
  ): this {
    const start = this.pos.length / 3;
    const centre = new THREE.Vector3(cx, cy, cz);
    const top: THREE.Vector3[] = [];
    const bot: THREE.Vector3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      top.push(new THREE.Vector3(cx + Math.cos(a) * rTop, cy + h / 2, cz + Math.sin(a) * rTop));
      bot.push(new THREE.Vector3(cx + Math.cos(a) * rBot, cy - h / 2, cz + Math.sin(a) * rBot));
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      this.quad([bot[i], bot[j], top[j], top[i]], centre);
    }
    if (capTop) for (let i = 1; i < seg - 1; i++) this.tri([top[0], top[i], top[i + 1]], centre);
    if (capBot) for (let i = 1; i < seg - 1; i++) this.tri([bot[0], bot[i], bot[i + 1]], centre);
    this.closePrim(start);
    return this;
  }

  /** Hemispherical dome along +Y — radomes, reactor spheres, helmets. */
  dome(cx: number, cy: number, cz: number, r: number, seg = 12, rings = 4, squash = 1): this {
    const start = this.pos.length / 3;
    const centre = new THREE.Vector3(cx, cy, cz);
    const pt = (ri: number, si: number): THREE.Vector3 => {
      const phi = (ri / rings) * Math.PI * 0.5;
      const th = (si / seg) * Math.PI * 2;
      const rr = Math.cos(phi) * r;
      return new THREE.Vector3(cx + Math.cos(th) * rr, cy + Math.sin(phi) * r * squash, cz + Math.sin(th) * rr);
    };
    for (let ri = 0; ri < rings; ri++) {
      for (let si = 0; si < seg; si++) {
        const sj = (si + 1) % seg;
        if (ri === rings - 1) this.tri([pt(ri, si), pt(ri, sj), pt(ri + 1, 0)], centre);
        else this.quad([pt(ri, si), pt(ri, sj), pt(ri + 1, sj), pt(ri + 1, si)], centre);
      }
    }
    this.closePrim(start);
    return this;
  }

  // ------------------------------------------------------------- part helpers

  /** Row of louvre slats — engine decks, radiator grilles, wall vents. */
  vents(cx: number, cy: number, cz: number, w: number, d: number, count: number, axis: 'x' | 'z' = 'x'): this {
    if (!this.fine) return this;
    const n = Math.max(2, count);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      if (axis === 'x') this.box(cx, cy, cz + t * d, w, 0.1, (d / n) * 0.52, 0.03);
      else this.box(cx + t * w, cy, cz, (w / n) * 0.52, 0.1, d, 0.03);
    }
    return this;
  }

  /** Bolt heads along a line; the single cheapest cue that a plate is bolted on. */
  rivets(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, count: number, r = 0.055): this {
    if (!this.fine) return this;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      this.tube(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, r, r * 1.15, r * 1.5, 6);
    }
    return this;
  }

  /** Framed handrail — reads as human scale on structures. */
  railing(cx: number, cy: number, cz: number, w: number, d: number, h = 0.9): this {
    if (!this.fine) return this;
    const posts = Math.max(2, Math.round(w / 1.4));
    for (let i = 0; i < posts; i++) {
      const t = (i / (posts - 1) - 0.5) * w;
      this.box(cx + t, cy + h / 2, cz, 0.09, h, 0.09, 0.02);
    }
    this.box(cx, cy + h, cz, w, 0.08, 0.1, 0.02);
    this.box(cx, cy + h * 0.55, cz, w, 0.06, 0.07, 0.02);
    if (d > 0.2) {
      this.box(cx - w / 2, cy + h, cz + d / 2, 0.09, 0.08, d, 0.02);
      this.box(cx + w / 2, cy + h, cz + d / 2, 0.09, 0.08, d, 0.02);
    }
    return this;
  }

  /** Access ladder against a wall. */
  ladder(cx: number, cy: number, cz: number, h: number): this {
    if (!this.fine) return this;
    this.box(cx - 0.24, cy + h / 2, cz, 0.07, h, 0.07, 0.02);
    this.box(cx + 0.24, cy + h / 2, cz, 0.07, h, 0.07, 0.02);
    const rungs = Math.max(2, Math.round(h / 0.55));
    for (let i = 0; i < rungs; i++) {
      this.box(cx, cy + ((i + 0.5) / rungs) * h, cz, 0.52, 0.05, 0.05, 0.015);
    }
    return this;
  }

  /** Straight pipe run with flanges — industrial silhouette filler. */
  pipe(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, seg = 8): this {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return this;
    this.push();
    this.move((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    // Orient +Y along the run.
    const q = new THREE.Quaternion().setFromUnitVectors(
      _a.set(0, 1, 0),
      _b.set(dx / len, dy / len, dz / len),
    );
    this.m.multiply(_tmpM.makeRotationFromQuaternion(q));
    this.tube(0, 0, 0, r, r, len, seg);
    if (this.fine) {
      this.tube(0, len / 2 - r * 0.6, 0, r * 1.35, r * 1.35, r * 0.5, seg);
      this.tube(0, -len / 2 + r * 0.6, 0, r * 1.35, r * 1.35, r * 0.5, seg);
    }
    this.pop();
    return this;
  }

  /** Thin flat quad — painted markings, hazard stripes, decals on aprons. */
  decal(cx: number, cy: number, cz: number, w: number, d: number, rotY = 0): this {
    const start = this.pos.length / 3;
    const centre = new THREE.Vector3(cx, cy, cz);
    const co = Math.cos(rotY);
    const si = Math.sin(rotY);
    const p = (sx: number, sz: number): THREE.Vector3 =>
      new THREE.Vector3(
        cx + ((sx * w) / 2) * co - ((sz * d) / 2) * si,
        cy,
        cz + ((sx * w) / 2) * si + ((sz * d) / 2) * co,
      );
    // Nudged up so it never z-fights the slab it sits on.
    const up = new THREE.Vector3(0, 1, 0);
    this.quadOriented([p(-1, -1), p(1, -1), p(1, 1), p(-1, 1)], up);
    this.closePrim(start);
    void centre;
    return this;
  }

  // ------------------------------------------------------------------ emitter

  private quad(v: THREE.Vector3[], centre: THREE.Vector3): void {
    this.tri([v[0], v[1], v[2]], centre);
    this.tri([v[0], v[2], v[3]], centre);
  }

  private tri(v: THREE.Vector3[], centre: THREE.Vector3): void {
    _a.subVectors(v[1], v[0]);
    _b.subVectors(v[2], v[0]);
    _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-12) return;
    _n.normalize();
    _c.copy(v[0]).add(v[1]).add(v[2]).multiplyScalar(1 / 3).sub(centre);
    const flip = _n.dot(_c) < 0;
    if (flip) _n.negate();
    this.emit(flip ? [v[0], v[2], v[1]] : v, _n);
  }

  private quadOriented(v: THREE.Vector3[], normal: THREE.Vector3): void {
    _a.subVectors(v[1], v[0]);
    _b.subVectors(v[2], v[0]);
    if (_n.crossVectors(_a, _b).dot(normal) < 0) {
      this.emit([v[0], v[2], v[1]], normal);
      this.emit([v[0], v[3], v[2]], normal);
    } else {
      this.emit([v[0], v[1], v[2]], normal);
      this.emit([v[0], v[2], v[3]], normal);
    }
  }

  private emit(v: THREE.Vector3[], localNormal: THREE.Vector3): void {
    this.nmat.setFromMatrix4(this.m);
    _n.copy(localNormal).applyMatrix3(this.nmat).normalize();
    // A mirrored transform flips handedness; restore outward-facing winding.
    const det = this.m.determinant();
    const order = det < 0 ? [0, 2, 1] : [0, 1, 2];

    const s = this.cur;
    const cr = this.tmpColor.setHex(s.color, THREE.SRGBColorSpace);
    const r8 = Math.round(clamp(Math.pow(cr.r, 1 / 2.2), 0, 1) * 255);
    const g8 = Math.round(clamp(Math.pow(cr.g, 1 / 2.2), 0, 1) * 255);
    const b8 = Math.round(clamp(Math.pow(cr.b, 1 / 2.2), 0, 1) * 255);

    for (const k of order) {
      _v.copy(v[k]).applyMatrix4(this.m);
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(_n.x, _n.y, _n.z);

      // Dominant-axis (box) projection keeps texel density uniform across every
      // part of every model without authoring a single UV by hand.
      const ax = Math.abs(_n.x);
      const ay = Math.abs(_n.y);
      const az = Math.abs(_n.z);
      if (ay >= ax && ay >= az) this.uvs.push(_v.x, _v.z);
      else if (ax >= az) this.uvs.push(_v.z, _v.y);
      else this.uvs.push(_v.x, _v.y);

      this.col.push(r8, g8, b8);
      this.srf.push(
        Math.round(clamp(s.roughness, 0, 1) * 255),
        Math.round(clamp(s.metalness, 0, 1) * 255),
        Math.round(clamp(s.emissive / 8, 0, 1) * 255),
        Math.round(clamp(s.team, 0, 1) * 255),
      );
      this.msc.push(
        Math.round(clamp(s.grunge, 0, 1) * 255),
        Math.round(clamp(s.uvScale / 2, 0, 1) * 255),
        255,
      );
      this.bix.push(this.curBone, 0, 0, 0);
      this.wearAt.push(s.wear);
    }
  }

  private closePrim(start: number): void {
    const end = this.pos.length / 3;
    if (end > start) this.ranges.push({ start, end });
  }

  // --------------------------------------------------------------------- bake

  /**
   * Voxelises the assembled part AABBs, then samples that field per vertex for
   * two things: cavity occlusion (grime and contact darkening) and convex
   * exposure (paint worn through to bright metal on every edge and corner).
   * This is what stops the models reading as flat-shaded polygon soup when the
   * scene lighting is soft.
   */
  private bakeOcclusion(): void {
    const count = this.pos.length / 3;
    if (count === 0 || this.ranges.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = this.pos[i * 3];
      const y = this.pos[i * 3 + 1];
      const z = this.pos[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const pad = 0.6;
    minX -= pad;
    minY -= pad;
    minZ -= pad;
    maxX += pad;
    maxY += pad;
    maxZ += pad;

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    const cell = Math.max(0.16, span / 40);
    const nx = Math.max(1, Math.min(48, Math.ceil((maxX - minX) / cell)));
    const ny = Math.max(1, Math.min(48, Math.ceil((maxY - minY) / cell)));
    const nz = Math.max(1, Math.min(48, Math.ceil((maxZ - minZ) / cell)));
    const grid = new Uint8Array(nx * ny * nz);

    const idx = (ix: number, iy: number, iz: number): number => (iz * ny + iy) * nx + ix;

    for (const r of this.ranges) {
      let ax = Infinity;
      let ay = Infinity;
      let az = Infinity;
      let bx = -Infinity;
      let by = -Infinity;
      let bz = -Infinity;
      for (let i = r.start; i < r.end; i++) {
        const x = this.pos[i * 3];
        const y = this.pos[i * 3 + 1];
        const z = this.pos[i * 3 + 2];
        if (x < ax) ax = x;
        if (y < ay) ay = y;
        if (z < az) az = z;
        if (x > bx) bx = x;
        if (y > by) by = y;
        if (z > bz) bz = z;
      }
      const i0 = Math.max(0, Math.floor(((ax - minX) / (maxX - minX)) * nx));
      const i1 = Math.min(nx - 1, Math.floor(((bx - minX) / (maxX - minX)) * nx));
      const j0 = Math.max(0, Math.floor(((ay - minY) / (maxY - minY)) * ny));
      const j1 = Math.min(ny - 1, Math.floor(((by - minY) / (maxY - minY)) * ny));
      const k0 = Math.max(0, Math.floor(((az - minZ) / (maxZ - minZ)) * nz));
      const k1 = Math.min(nz - 1, Math.floor(((bz - minZ) / (maxZ - minZ)) * nz));
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) grid[idx(i, j, k)] = 1;
    }

    const sx = nx / (maxX - minX);
    const sy = ny / (maxY - minY);
    const sz = nz / (maxZ - minZ);
    const sample = (x: number, y: number, z: number): number => {
      const ix = Math.floor((x - minX) * sx);
      const iy = Math.floor((y - minY) * sy);
      const iz = Math.floor((z - minZ) * sz);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
      return grid[idx(ix, iy, iz)];
    };

    // 13 well-spread directions: axes plus cube diagonals.
    const dirs: number[][] = [];
    for (const d of [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      [1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1],
    ]) {
      const l = Math.hypot(d[0], d[1], d[2]);
      dirs.push([d[0] / l, d[1] / l, d[2] / l]);
    }

    const step = Math.max(cell, span / 42);
    for (let i = 0; i < count; i++) {
      const px = this.pos[i * 3];
      const py = this.pos[i * 3 + 1];
      const pz = this.pos[i * 3 + 2];
      const nxv = this.nrm[i * 3];
      const nyv = this.nrm[i * 3 + 1];
      const nzv = this.nrm[i * 3 + 2];

      let hemiHit = 0;
      let hemiTotal = 0;
      let sphereHit = 0;
      let sphereTotal = 0;
      for (const d of dirs) {
        const facing = d[0] * nxv + d[1] * nyv + d[2] * nzv;
        for (let t = 1; t <= 3; t++) {
          const dist = step * (t * 1.35);
          const occ = sample(px + d[0] * dist + nxv * step * 0.9, py + d[1] * dist + nyv * step * 0.9, pz + d[2] * dist + nzv * step * 0.9);
          const w = 1 / t;
          sphereHit += occ * w;
          sphereTotal += w;
          if (facing > 0.05) {
            hemiHit += occ * w * facing;
            hemiTotal += w * facing;
          }
        }
      }

      const ao = hemiTotal > 0 ? clamp(1 - (hemiHit / hemiTotal) * 1.15, 0.18, 1) : 1;
      const open = sphereTotal > 0 ? 1 - sphereHit / sphereTotal : 1;
      const wearAmt = smoothstep(0.42, 0.86, open) * this.wearAt[i];

      // Convex edges: paint thins, bare metal shows, roughness drops.
      const rough = this.srf[i * 4] / 255;
      const metal = this.srf[i * 4 + 1] / 255;
      this.srf[i * 4] = Math.round(clamp(rough * (1 - wearAmt * 0.32), 0, 1) * 255);
      this.srf[i * 4 + 1] = Math.round(clamp(metal + wearAmt * 0.6, 0, 1) * 255);
      const lift = 1 + wearAmt * 0.42;
      this.col[i * 3] = Math.min(255, Math.round(this.col[i * 3] * lift));
      this.col[i * 3 + 1] = Math.min(255, Math.round(this.col[i * 3 + 1] * lift));
      this.col[i * 3 + 2] = Math.min(255, Math.round(this.col[i * 3 + 2] * lift));

      // Cavities collect grime; that is the layer-B blend.
      const grunge = this.msc[i * 3] / 255;
      this.msc[i * 3] = Math.round(clamp(grunge + (1 - ao) * 0.55, 0, 1) * 255);
      this.msc[i * 3 + 2] = Math.round(ao * 255);
    }
  }

  build(): THREE.BufferGeometry {
    this.bakeOcclusion();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setAttribute('aSurf', new THREE.BufferAttribute(new Uint8Array(this.srf), 4, true));
    g.setAttribute('aMisc', new THREE.BufferAttribute(new Uint8Array(this.msc), 3, true));
    const n = this.pos.length / 3;
    const si = new Uint8Array(n * 4);
    const sw = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = this.bix[i * 4];
      sw[i * 4] = 255;
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4, true));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  get triangleCount(): number {
    return this.pos.length / 9;
  }
}

const _tmpM = new THREE.Matrix4();
