import * as THREE from 'three';
import { clamp } from '@/util/Noise';
import { MeshBuf } from './PropGeo';
import { GROUND_CELL, type GroundCellName } from './PropTextures';

/**
 * Ground marks: the collar of dirt where a mass meets the soil, gravel spills,
 * scorch under a burnt hull, and the wheel ruts worn into the routes between
 * the plateaus.
 *
 * These are not decals in the usual sense — there is no projection and no
 * runtime pool. Props never move, so every mark is baked once into a single
 * world-space mesh whose vertices are dropped onto the heightfield. That buys
 * two things a projected quad cannot: exact conformance over a curved surface
 * at any size, and the entire level's ground detail in one draw call.
 *
 * Grounding is the axis that catches more amateur work than any other, and it
 * is mostly won here: a boulder with a dirt collar and a gravel apron reads as
 * bedded even before its shadow lands.
 */

export interface GroundSampler {
  height(x: number, z: number): number;
  slope(x: number, z: number): number;
}

/** Texels of inset applied to each atlas cell, as a fraction of the atlas. */
const CELL_INSET = 0.004;

export class GroundMarks {
  private readonly buf = new MeshBuf();
  private readonly tmp = new THREE.Color();

  constructor(
    private readonly sampler: GroundSampler,
    /** Lift above the surface, in world units, to clear the terrain's own LOD. */
    private readonly lift = 0.16,
  ) {}

  get triangleCount(): number {
    return this.buf.triangleCount;
  }

  private cellUv(cell: GroundCellName, u: number, v: number, out: THREE.Vector2): THREE.Vector2 {
    const [cx, cy] = GROUND_CELL[cell];
    const lo = CELL_INSET;
    const hi = 0.5 - CELL_INSET;
    return out.set(cx * 0.5 + lo + u * (hi - lo), cy * 0.5 + lo + v * (hi - lo));
  }

  /**
   * A terrain-conforming square patch. `grid` trades triangles for how closely
   * the mark follows a curved surface; 4 is enough for anything under ~8 units
   * across at this terrain's curvature.
   */
  patch(
    cell: GroundCellName,
    x: number,
    z: number,
    radius: number,
    rotation: number,
    tint: THREE.Color,
    grid = 4,
  ): void {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const uv = new THREE.Vector2();
    const base = (this.buf as MeshBuf).vertexCount;

    for (let j = 0; j <= grid; j++) {
      for (let i = 0; i <= grid; i++) {
        const su = i / grid;
        const sv = j / grid;
        const lx = (su - 0.5) * 2 * radius;
        const lz = (sv - 0.5) * 2 * radius;
        const wx = x + lx * cos - lz * sin;
        const wz = z + lx * sin + lz * cos;
        this.cellUv(cell, su, sv, uv);
        this.buf.vertex(
          wx, this.sampler.height(wx, wz) + this.lift, wz,
          0, 1, 0,
          uv.x, uv.y,
          tint.r, tint.g, tint.b,
        );
      }
    }
    const stride = grid + 1;
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const a = base + j * stride + i;
        this.buf.quad(a, a + 1, a + stride + 1, a + stride);
      }
    }
  }

  /**
   * A ribbon of marks following a ground path — wheel ruts, drag scars, the
   * gravel washed out of a gully. Each segment carries exactly one copy of the
   * cell so the texture tiles along the run without ever leaving its cell.
   */
  ribbon(path: THREE.Vector3[], halfWidth: number, cell: GroundCellName, tint: THREE.Color, widthJitter = 0.22): void {
    if (path.length < 2) return;
    const uv = new THREE.Vector2();
    const dir = new THREE.Vector3();

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const c = path[i + 1];
      dir.subVectors(c, a);
      const len = Math.hypot(dir.x, dir.z);
      if (len < 0.4) continue;
      const nx = -dir.z / len;
      const nz = dir.x / len;

      // A slow width wobble keeps the run from reading as an extruded rectangle.
      const w0 = halfWidth * (1 + widthJitter * Math.sin(i * 1.7));
      const w1 = halfWidth * (1 + widthJitter * Math.sin((i + 1) * 1.7));

      const corners: Array<[number, number, number, number]> = [
        [a.x - nx * w0, a.z - nz * w0, 0, 0],
        [a.x + nx * w0, a.z + nz * w0, 1, 0],
        [c.x + nx * w1, c.z + nz * w1, 1, 1],
        [c.x - nx * w1, c.z - nz * w1, 0, 1],
      ];
      const ids: number[] = [];
      for (const [wx, wz, su, sv] of corners) {
        this.cellUv(cell, su, sv, uv);
        ids.push(this.buf.vertex(
          wx, this.sampler.height(wx, wz) + this.lift, wz,
          0, 1, 0,
          uv.x, uv.y,
          tint.r, tint.g, tint.b,
        ));
      }
      this.buf.quad(ids[0], ids[1], ids[2], ids[3]);
    }
  }

  /** Dirt collar plus a looser gravel apron — the standard treatment under stone. */
  bedRock(x: number, z: number, radius: number, rotation: number, strength: number): void {
    this.tmp.setRGB(0.92 * strength, 0.88 * strength, 0.80 * strength);
    this.patch('contact', x, z, radius * 1.5, rotation, this.tmp, radius > 2 ? 3 : 2);
    if (radius > 1.6) {
      this.tmp.setRGB(0.86, 0.84, 0.79);
      this.patch('scree', x, z, radius * 2.4, rotation + 0.9, this.tmp, 3);
    }
  }

  build(): THREE.BufferGeometry {
    return this.buf.build('prop-ground-marks');
  }
}

/* ----------------------------------------------------------------- paths -- */

/**
 * Routes a track between two points through a Catmull-Rom spline, then lets
 * each sample slide sideways to the flattest ground within a short search.
 *
 * A road drawn straight over a heightfield looks drawn; a road that leans into
 * the contour looks driven. The search is what does that, and it costs a few
 * hundred height lookups for the whole network.
 */
export function traceTrack(
  anchors: Array<[number, number]>,
  sampler: GroundSampler,
  step = 6,
  search = 9,
): THREE.Vector3[] {
  if (anchors.length < 2) return [];
  const pts = anchors.map(([x, z]) => new THREE.Vector2(x, z));
  const curve = new THREE.SplineCurve(pts);
  const total = curve.getLength();
  const n = Math.max(2, Math.round(total / step));
  const out: THREE.Vector3[] = [];
  const p = new THREE.Vector2();
  const t = new THREE.Vector2();

  for (let i = 0; i <= n; i++) {
    const u = i / n;
    curve.getPoint(u, p);
    curve.getTangent(u, t);
    const nx = -t.y;
    const nz = t.x;

    let bestX = p.x;
    let bestZ = p.y;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let k = -2; k <= 2; k++) {
      const off = (k / 2) * search;
      const cx = p.x + nx * off;
      const cz = p.y + nz * off;
      // Prefer flat ground, but do not wander far from the intended line.
      const cost = sampler.slope(cx, cz) * 3 + Math.abs(off) * 0.012;
      if (cost < bestCost) {
        bestCost = cost;
        bestX = cx;
        bestZ = cz;
      }
    }
    out.push(new THREE.Vector3(bestX, sampler.height(bestX, bestZ), bestZ));
  }
  return out;
}

/**
 * Splits a traced path into the runs that a vehicle could actually have driven:
 * dry, not too steep. What is left is a track that fades out at a washout and
 * picks up again on the far side, which is both correct and better looking than
 * a continuous ribbon.
 */
export function splitDrivable(
  path: THREE.Vector3[],
  sampler: GroundSampler,
  minHeight: number,
  maxSlope: number,
  minRun = 3,
): THREE.Vector3[][] {
  const runs: THREE.Vector3[][] = [];
  let current: THREE.Vector3[] = [];
  for (const p of path) {
    const ok = p.y > minHeight && sampler.slope(p.x, p.z) < maxSlope;
    if (ok) {
      current.push(p);
    } else {
      if (current.length >= minRun) runs.push(current);
      current = [];
    }
  }
  if (current.length >= minRun) runs.push(current);
  return runs;
}

/**
 * Least-squares plane through the terrain under a footprint.
 *
 * Returns the height at the centre, the surface normal of the fitted plane, and
 * the worst amount by which the real ground rises above it. Sinking an object
 * by that residual is what guarantees no part of the terrain pokes through a
 * flat underside, which is the failure that reads instantly as floating.
 */
export interface Footprint {
  height: number;
  normal: THREE.Vector3;
  /** Highest terrain sample above the fitted plane. */
  rise: number;
  /** Lowest terrain sample in the footprint. */
  low: number;
}

const _fpNormal = new THREE.Vector3();

export function fitFootprint(
  sampler: GroundSampler,
  x: number,
  z: number,
  radius: number,
  samples = 8,
  out?: Footprint,
): Footprint {
  const result = out ?? { height: 0, normal: new THREE.Vector3(0, 1, 0), rise: 0, low: 0 };
  const h0 = sampler.height(x, z);
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxh = 0;
  let szh = 0;
  let sh = h0;
  let count = 1;
  let low = h0;

  const px: number[] = [0];
  const pz: number[] = [0];
  const ph: number[] = [h0];

  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const dx = Math.cos(a) * radius;
    const dz = Math.sin(a) * radius;
    const h = sampler.height(x + dx, z + dz);
    px.push(dx);
    pz.push(dz);
    ph.push(h);
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
    sxh += dx * h;
    szh += dz * h;
    sh += h;
    count++;
    if (h < low) low = h;
  }

  // Solve for the plane h = a*x + b*z + c. The ring is symmetric so the
  // cross term is ~0, but solve it properly anyway.
  const meanH = sh / count;
  const det = sxx * szz - sxz * sxz;
  let ga = 0;
  let gb = 0;
  if (Math.abs(det) > 1e-6) {
    const chx = sxh - 0;
    const chz = szh - 0;
    ga = (chx * szz - chz * sxz) / det;
    gb = (chz * sxx - chx * sxz) / det;
  }
  const c = meanH;

  let rise = 0;
  for (let i = 0; i < ph.length; i++) {
    const planeH = ga * px[i] + gb * pz[i] + c;
    const d = ph[i] - planeH;
    if (d > rise) rise = d;
  }

  result.height = c;
  result.normal.copy(_fpNormal.set(-ga, 1, -gb)).normalize();
  result.rise = rise;
  result.low = low;
  return result;
}

/**
 * How far below the fitted plane an object has to sit before nothing can poke
 * through it.
 *
 * Two terms. `rise` covers the ground that stands above the fitted plane inside
 * the footprint. The tilt term covers the rest: an object that only *partly*
 * follows the slope keeps a base plane at an angle to the ground, and the
 * mismatch grows with both the radius and the gradient. An upright object on a
 * 30° slope needs to bury half its width, which is exactly what a real boulder
 * on a scree slope does.
 */
export function settleDepth(radius: number, fp: Footprint, follow: number, extra: number): number {
  const gradient = Math.hypot(fp.normal.x, fp.normal.z) / Math.max(fp.normal.y, 1e-3);
  const tilt = radius * (1 - follow) * gradient * 0.85;
  return clamp(fp.rise + tilt + extra * radius, 0, radius * 0.85);
}

const _corner = new THREE.Vector3();

/**
 * Lift needed to keep a rotated shape's lowest point on its own base plane.
 *
 * Used for the props that are deliberately not the right way up — a barrier
 * shoved onto its side, a hull rolled over. Their geometry pivots at the
 * original base, so without this they would rotate straight into the ground.
 */
export function baseLift(bbox: THREE.Box3, rotation: THREE.Quaternion): number {
  let minY = 0;
  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? bbox.max.x : bbox.min.x,
      i & 2 ? bbox.max.y : bbox.min.y,
      i & 4 ? bbox.max.z : bbox.min.z,
    ).applyQuaternion(rotation);
    if (_corner.y < minY) minY = _corner.y;
  }
  return -minY;
}
