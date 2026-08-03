import * as THREE from 'three';

/**
 * Geometry kit for the prop stream.
 *
 * One append-only accumulator plus a handful of primitives. Everything
 * man-made in this stream — hulls, barriers, posts, ground marks — is built by
 * pushing polygons into a `MeshBuf`, so any number of authored pieces collapse
 * into a single geometry and therefore a single draw.
 *
 * Two conventions are worth knowing:
 *
 * - **UVs are derived, never authored.** `addPoly` box-projects each polygon
 *   from its own normal at a fixed number of repeats per world unit, with V
 *   pointing up on anything vertical. Texel density is then constant across a
 *   whole wreck regardless of how its parts are sized, which is what stops
 *   procedural props from looking like a bag of mismatched decals.
 * - **Boxes are chamfered.** A hard 90° edge has no highlight and reads as
 *   untextured plastic at any distance. The chamfer costs 20 triangles and buys
 *   the edge catch that makes metal look like metal.
 */

export class MeshBuf {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uvs: number[] = [];
  private readonly col: number[] = [];
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
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.col.push(r, g, b);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export interface SurfaceOpts {
  /** Linear RGB multiplier written per vertex. */
  color: THREE.Color;
  /** Texture repeats per world unit. */
  uvScale: number;
  /** Extra darkening applied to downward-facing polygons; fakes self-occlusion. */
  underShade?: number;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/**
 * Appends one convex polygon, transformed by `m`, with its winding corrected to
 * agree with `normal` and its UVs box-projected from the transformed normal.
 */
export function addPoly(
  b: MeshBuf,
  m: THREE.Matrix4,
  pts: THREE.Vector3[],
  normal: THREE.Vector3,
  opt: SurfaceOpts,
): void {
  if (pts.length < 3) return;
  _nm.getNormalMatrix(m);
  _n.copy(normal).applyMatrix3(_nm).normalize();

  const world: THREE.Vector3[] = [];
  for (const p of pts) world.push(_p.copy(p).applyMatrix4(m).clone());

  // Winding: the polygon's own geometric normal must agree with the intended
  // one, otherwise the face is inside out after a mirroring transform.
  _e1.subVectors(world[1], world[0]);
  _e2.subVectors(world[2], world[0]);
  _cross.crossVectors(_e1, _e2);
  const flip = _cross.dot(_n) < 0;

  // Box projection: pick the dominant axis of the normal, keep Y as V wherever
  // the surface is vertical so streaks and panel lines run the right way.
  const ax = Math.abs(_n.x);
  const ay = Math.abs(_n.y);
  const az = Math.abs(_n.z);
  const s = opt.uvScale;

  const shade = opt.underShade !== undefined && _n.y < -0.35
    ? 1 - opt.underShade * Math.min(1, -_n.y)
    : 1;
  const cr = opt.color.r * shade;
  const cg = opt.color.g * shade;
  const cb = opt.color.b * shade;

  const ids: number[] = [];
  for (const w of world) {
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = w.x * s;
      v = w.z * s;
    } else if (ax >= az) {
      u = w.z * s;
      v = w.y * s;
    } else {
      u = w.x * s;
      v = w.y * s;
    }
    ids.push(b.vertex(w.x, w.y, w.z, _n.x, _n.y, _n.z, u, v, cr, cg, cb));
  }

  for (let i = 2; i < ids.length; i++) {
    if (flip) b.tri(ids[0], ids[i], ids[i - 1]);
    else b.tri(ids[0], ids[i - 1], ids[i]);
  }
}

const _v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/**
 * A chamfered box: six inset faces, twelve edge strips and eight corner
 * triangles. `chamfer` is in local units and is clamped so a thin plate stays
 * manifold.
 */
export function addBox(
  b: MeshBuf,
  m: THREE.Matrix4,
  half: THREE.Vector3,
  chamfer: number,
  opt: SurfaceOpts,
): void {
  const c = Math.min(chamfer, half.x * 0.48, half.y * 0.48, half.z * 0.48);
  const h = [half.x, half.y, half.z];
  const inner = [half.x - c, half.y - c, half.z - c];

  const make = (a0: number, s0: number, a1: number, s1: number, a2: number, s2: number, outer: number): THREE.Vector3 => {
    const out = new THREE.Vector3();
    const co = [0, 0, 0];
    co[a0] = s0 * (outer === a0 ? h[a0] : inner[a0]);
    co[a1] = s1 * (outer === a1 ? h[a1] : inner[a1]);
    co[a2] = s2 * (outer === a2 ? h[a2] : inner[a2]);
    return out.set(co[0], co[1], co[2]);
  };

  // Faces.
  for (let a = 0; a < 3; a++) {
    const t1 = (a + 1) % 3;
    const t2 = (a + 2) % 3;
    for (const s of [1, -1]) {
      const n = _v(0, 0, 0);
      n.setComponent(a, s);
      const pts = [
        make(a, s, t1, -1, t2, -1, a),
        make(a, s, t1, 1, t2, -1, a),
        make(a, s, t1, 1, t2, 1, a),
        make(a, s, t1, -1, t2, 1, a),
      ];
      addPoly(b, m, pts, n, opt);
    }
  }

  // Edge strips.
  for (let a = 0; a < 3; a++) {
    const bAx = (a + 1) % 3;
    const cAx = (a + 2) % 3;
    for (const sa of [1, -1]) {
      for (const sb of [1, -1]) {
        const n = _v(0, 0, 0);
        n.setComponent(a, sa);
        n.setComponent(bAx, sb);
        n.normalize();
        const pts = [
          make(a, sa, bAx, sb, cAx, -1, a),
          make(a, sa, bAx, sb, cAx, 1, a),
          make(a, sa, bAx, sb, cAx, 1, bAx),
          make(a, sa, bAx, sb, cAx, -1, bAx),
        ];
        addPoly(b, m, pts, n, opt);
      }
    }
  }

  // Corner triangles.
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const n = _v(sx, sy, sz).normalize();
        const pts = [
          _v(sx * h[0], sy * inner[1], sz * inner[2]),
          _v(sx * inner[0], sy * h[1], sz * inner[2]),
          _v(sx * inner[0], sy * inner[1], sz * h[2]),
        ];
        addPoly(b, m, pts, n, opt);
      }
    }
  }
}

/** A tapered cylinder along local Y, centred on the origin. `cap` closes the ends. */
export function addCylinder(
  b: MeshBuf,
  m: THREE.Matrix4,
  rBottom: number,
  rTop: number,
  height: number,
  segments: number,
  opt: SurfaceOpts,
  cap = true,
): void {
  const hy = height * 0.5;
  const slope = (rBottom - rTop) / Math.max(height, 1e-4);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const nm = _v((c0 + c1) * 0.5, slope, (s0 + s1) * 0.5).normalize();
    addPoly(b, m, [
      _v(c0 * rBottom, -hy, s0 * rBottom),
      _v(c1 * rBottom, -hy, s1 * rBottom),
      _v(c1 * rTop, hy, s1 * rTop),
      _v(c0 * rTop, hy, s0 * rTop),
    ], nm, opt);
  }
  if (!cap) return;
  const top: THREE.Vector3[] = [];
  const bot: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    top.push(_v(Math.cos(a) * rTop, hy, Math.sin(a) * rTop));
    bot.push(_v(Math.cos(-a) * rBottom, -hy, Math.sin(-a) * rBottom));
  }
  if (rTop > 1e-4) addPoly(b, m, top, _v(0, 1, 0), opt);
  if (rBottom > 1e-4) addPoly(b, m, bot, _v(0, -1, 0), opt);
}

/**
 * Extrudes a closed 2D outline (XY) along local Z. The outline must be
 * star-convex about its centroid, which every profile in this stream is.
 */
export function addExtrusion(
  b: MeshBuf,
  m: THREE.Matrix4,
  outline: Array<[number, number]>,
  length: number,
  opt: SurfaceOpts,
): void {
  const hz = length * 0.5;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    const ex = x1 - x0;
    const ey = y1 - y0;
    const len = Math.hypot(ex, ey);
    if (len < 1e-5) continue;
    const nm = _v(ey / len, -ex / len, 0);
    addPoly(b, m, [
      _v(x0, y0, -hz),
      _v(x1, y1, -hz),
      _v(x1, y1, hz),
      _v(x0, y0, hz),
    ], nm, opt);
  }
  // Caps are fanned from the centroid rather than from a corner: these profiles
  // are star-convex about their centre but not about any one vertex, and a
  // corner fan would spill triangles outside the outline.
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outline) {
    cx += x / n;
    cy += y / n;
  }
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    addPoly(b, m, [_v(cx, cy, hz), _v(x0, y0, hz), _v(x1, y1, hz)], _v(0, 0, 1), opt);
    addPoly(b, m, [_v(cx, cy, -hz), _v(x0, y0, -hz), _v(x1, y1, -hz)], _v(0, 0, -1), opt);
  }
}

export interface BuiltProp {
  geometry: THREE.BufferGeometry;
  /** World height with the base at y = 0. */
  height: number;
  /** Horizontal radius, for footprint sampling and cell culling. */
  radius: number;
}

/**
 * Closes a buffer into a prop: the shape is dropped so its lowest point sits at
 * y = 0, which is what lets placement treat the instance origin as the ground
 * contact point and sink from there.
 */
export function finishProp(b: MeshBuf, name: string): BuiltProp {
  const geometry = b.build(name);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  geometry.translate(0, -bb.min.y, 0);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return {
    geometry,
    height: bb.max.y - bb.min.y,
    radius: Math.max(
      Math.abs(bb.min.x), Math.abs(bb.max.x),
      Math.abs(bb.min.z), Math.abs(bb.max.z),
    ),
  };
}

/* --------------------------------------------------------------- sphere -- */

export interface Icosphere {
  /** Unit directions, one per unique vertex. */
  dir: Float32Array;
  index: Uint32Array;
  count: number;
}

const ICO_CACHE = new Map<number, Icosphere>();

/**
 * A subdivided icosahedron with shared vertices. Rock shapes are radial fields
 * of direction, so evaluating them on the *unique* vertices and expanding to
 * faces afterwards costs a sixth of what three's own non-indexed polyhedron
 * would.
 */
export function icosphere(subdivisions: number): Icosphere {
  const hit = ICO_CACHE.get(subdivisions);
  if (hit) return hit;

  const t = (1 + Math.sqrt(5)) * 0.5;
  const verts: number[] = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
  ];
  for (let i = 0; i < verts.length; i += 3) {
    const inv = 1 / Math.hypot(verts[i], verts[i + 1], verts[i + 2]);
    verts[i] *= inv;
    verts[i + 1] *= inv;
    verts[i + 2] *= inv;
  }
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>();
    const next: number[] = [];
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      const seen = cache.get(key);
      if (seen !== undefined) return seen;
      const mx = (verts[a * 3] + verts[b * 3]) * 0.5;
      const my = (verts[a * 3 + 1] + verts[b * 3 + 1]) * 0.5;
      const mz = (verts[a * 3 + 2] + verts[b * 3 + 2]) * 0.5;
      const inv = 1 / Math.hypot(mx, my, mz);
      const id = verts.length / 3;
      verts.push(mx * inv, my * inv, mz * inv);
      cache.set(key, id);
      return id;
    };
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f];
      const b = faces[f + 1];
      const c = faces[f + 2];
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }

  const sphere: Icosphere = {
    dir: new Float32Array(verts),
    index: new Uint32Array(faces),
    count: verts.length / 3,
  };
  ICO_CACHE.set(subdivisions, sphere);
  return sphere;
}
