import * as THREE from 'three';
import { clamp, hash3, makeRng, smoothstep } from '@/util/Noise';
import { MeshBuf, icosphere } from './PropGeo';

/**
 * Procedural stone.
 *
 * A rock is a radial field over the unit sphere: an anisotropic ellipsoid,
 * displaced by several bands of noise, then **clipped by fracture planes**.
 * That last step is the whole trick. Displaced spheres give lumpy potatoes;
 * real rock breaks along cleavage planes, so the silhouette is a mix of
 * weathered curves and dead-flat faces meeting at hard edges. Clipping is
 * exact — for a plane `(n, c)` the ray at direction `d` meets it at `c/(n·d)` —
 * so the faces are genuinely planar rather than noise that happens to be flat,
 * and a soft-min blends the ones that have had time to round off.
 *
 * On top of that sit the erosion terms that give each kind its character:
 * differential weathering along bedding planes (the horizontal ledges on an
 * outcrop), vertical fluting where water runs down a steep face, and tafoni —
 * the rounded honeycomb cavities that open up on a wind-scoured boulder.
 *
 * The field is evaluated once per *unique* vertex of a shared icosphere and the
 * result expanded to faces afterwards, so a 1280-triangle boulder costs 642
 * field evaluations rather than 3840. LODs re-evaluate the same field at a
 * coarser subdivision, which keeps the silhouette across an LOD switch.
 */

/* ------------------------------------------------------------- 3D noise -- */

function vnoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const c00 = hash3(xi, yi, zi, seed) + (hash3(xi + 1, yi, zi, seed) - hash3(xi, yi, zi, seed)) * u;
  const c10 = hash3(xi, yi + 1, zi, seed) + (hash3(xi + 1, yi + 1, zi, seed) - hash3(xi, yi + 1, zi, seed)) * u;
  const c01 = hash3(xi, yi, zi + 1, seed) + (hash3(xi + 1, yi, zi + 1, seed) - hash3(xi, yi, zi + 1, seed)) * u;
  const c11 = hash3(xi, yi + 1, zi + 1, seed) + (hash3(xi + 1, yi + 1, zi + 1, seed) - hash3(xi, yi + 1, zi + 1, seed)) * u;
  const c0 = c00 + (c10 - c00) * v;
  const c1 = c01 + (c11 - c01) * v;
  return c0 + (c1 - c0) * w;
}

function fbm3(x: number, y: number, z: number, seed: number, octaves: number): number {
  let amp = 1;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise3(x * f, y * f, z * f, seed + i * 613);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

function softMin(a: number, b: number, k: number): number {
  if (k <= 1e-4) return a < b ? a : b;
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

/* -------------------------------------------------------------- profiles -- */

export type RockKind = 'boulder' | 'monolith' | 'block' | 'shard' | 'stone';

interface Profile {
  /** Ellipsoid semi-axes, sampled per shape. */
  sx: [number, number];
  sy: [number, number];
  sz: [number, number];
  /** Fracture plane count and how strongly they prefer horizontal bedding. */
  cuts: [number, number];
  bedding: number;
  cutSoft: number;
  lump: number;
  lumpFreq: number;
  strata: number;
  strataFreq: number;
  erode: number;
  detail: number;
  pit: number;
  /** Height of the flat underside, as a fraction of the vertical semi-axis. */
  baseCut: number;
  /** Texture repeats per world unit. */
  uvScale: number;
  /** Nominal world radius across, before the per-instance scale. */
  size: number;
}

const PROFILES: Record<RockKind, Profile> = {
  // Rounded, deeply weathered erratic. Few cuts, heavy tafoni.
  boulder: {
    sx: [0.95, 1.15], sy: [0.62, 0.86], sz: [0.85, 1.10],
    cuts: [2, 4], bedding: 0.5, cutSoft: 0.11,
    lump: 0.20, lumpFreq: 1.15, strata: 0.05, strataFreq: 2.4,
    erode: 0.09, detail: 0.045, pit: 0.11,
    baseCut: 0.60, uvScale: 0.26, size: 3.1,
  },
  // Angular column of fractured bedrock. Many steep cleavage planes.
  monolith: {
    sx: [0.72, 0.92], sy: [1.05, 1.50], sz: [0.70, 0.95],
    cuts: [5, 8], bedding: 0.25, cutSoft: 0.035,
    lump: 0.13, lumpFreq: 1.5, strata: 0.11, strataFreq: 3.1,
    erode: 0.13, detail: 0.04, pit: 0.05,
    baseCut: 0.70, uvScale: 0.24, size: 2.6,
  },
  // Bedded block that has slumped off a cliff. Horizontal ledges, flat top.
  block: {
    sx: [0.90, 1.20], sy: [0.52, 0.76], sz: [0.80, 1.10],
    cuts: [4, 6], bedding: 0.7, cutSoft: 0.05,
    lump: 0.14, lumpFreq: 1.7, strata: 0.15, strataFreq: 4.2,
    erode: 0.08, detail: 0.05, pit: 0.06,
    baseCut: 0.66, uvScale: 0.42, size: 1.5,
  },
  // Splinter standing on end — ridge crests and scree fields.
  shard: {
    sx: [0.42, 0.62], sy: [1.15, 1.75], sz: [0.55, 0.80],
    cuts: [4, 7], bedding: 0.15, cutSoft: 0.02,
    lump: 0.10, lumpFreq: 1.9, strata: 0.08, strataFreq: 5.0,
    erode: 0.10, detail: 0.05, pit: 0.02,
    baseCut: 0.78, uvScale: 0.45, size: 1.05,
  },
  // Loose stone, tumbled smooth.
  stone: {
    sx: [0.85, 1.20], sy: [0.55, 0.85], sz: [0.80, 1.15],
    cuts: [1, 3], bedding: 0.45, cutSoft: 0.13,
    lump: 0.22, lumpFreq: 2.2, strata: 0.0, strataFreq: 1,
    erode: 0.05, detail: 0.07, pit: 0.04,
    baseCut: 0.62, uvScale: 0.95, size: 0.52,
  },
};

/* ----------------------------------------------------------------- field -- */

interface RockField {
  radius(dx: number, dy: number, dz: number): number;
  profile: Profile;
  seed: number;
}

function makeRockField(kind: RockKind, seed: number): RockField {
  const P = PROFILES[kind];
  const rng = makeRng(seed >>> 0);
  const rr = (a: [number, number]): number => a[0] + rng() * (a[1] - a[0]);

  const ex = rr(P.sx);
  const ey = rr(P.sy);
  const ez = rr(P.sz);
  const yaw = rng() * Math.PI * 2;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);

  // Fracture planes, packed flat: nx, ny, nz, offset, softness.
  const planes: number[] = [];
  const count = Math.round(rr(P.cuts));
  for (let i = 0; i < count; i++) {
    const az = rng() * Math.PI * 2;
    let ny: number;
    if (rng() < P.bedding) {
      // A bedding plane: nearly horizontal, so the cut leaves a flat ledge.
      ny = (rng() < 0.4 ? -1 : 1) * (0.74 + 0.26 * rng());
    } else {
      ny = (rng() * 2 - 1) * 0.55;
    }
    const hz = Math.sqrt(Math.max(0, 1 - ny * ny));
    const nx = Math.cos(az) * hz;
    const nz = Math.sin(az) * hz;
    // Place the plane inside the ellipsoid's own radius in that direction, so
    // every cut actually removes material without gutting the shape.
    const qx = (nx * cy + nz * sy) / ex;
    const qy = ny / ey;
    const qz = (-nx * sy + nz * cy) / ez;
    const reach = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz);
    planes.push(nx, ny, nz, reach * (0.60 + 0.32 * rng()), P.cutSoft * (0.35 + 1.3 * rng()));
  }
  // The underside. Cut hard: this face is buried, and a crisp edge is what
  // makes the rock read as sitting *in* the ground rather than balanced on it.
  planes.push(0, -1, 0, ey * P.baseCut, 0.012);

  const radius = (dx: number, dy: number, dz: number): number => {
    const ax = dx * cy + dz * sy;
    const azc = -dx * sy + dz * cy;
    const qx = ax / ex;
    const qy = dy / ey;
    const qz = azc / ez;
    let r = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz);

    r *= 1 + P.lump * (fbm3(ax * P.lumpFreq, dy * P.lumpFreq, azc * P.lumpFreq, seed + 7, 2) - 0.5) * 2;

    if (P.strata > 0) {
      // Alternating hard and soft beds weather at different rates; the ledges
      // this leaves are the single strongest "this is sedimentary rock" cue.
      const t = dy * r * P.strataFreq + 0.55 * vnoise3(ax * 1.7, dy * 1.7, azc * 1.7, seed + 31);
      const tri = Math.abs(t - Math.floor(t) - 0.5) * 2;
      r *= 1 + P.strata * (smoothstep(0.22, 0.78, tri) - 0.5);
    }

    if (P.erode > 0) {
      const steep = 1 - Math.abs(dy);
      const flute = fbm3(ax * 4.2, dy * 1.05, azc * 4.2, seed + 53, 2);
      r *= 1 - P.erode * steep * smoothstep(0.32, 0.86, flute);
    }

    r *= 1 + P.detail * (fbm3(ax * 8.5, dy * 8.5, azc * 8.5, seed + 71, 2) - 0.5) * 2;

    if (P.pit > 0) {
      const cav = fbm3(ax * 3.3, dy * 3.3, azc * 3.3, seed + 97, 1);
      r *= 1 - P.pit * smoothstep(0.60, 0.90, cav);
    }

    for (let i = 0; i < planes.length; i += 5) {
      const d = dx * planes[i] + dy * planes[i + 1] + dz * planes[i + 2];
      if (d <= 1e-4) continue;
      r = softMin(r, planes[i + 3] / d, planes[i + 4]);
    }
    return r > 0.05 ? r : 0.05;
  };

  return { radius, profile: P, seed };
}

/* ---------------------------------------------------------------- colour -- */

const SOIL = new THREE.Color(0.60, 0.51, 0.40);
const LICHEN = new THREE.Color(1.14, 1.20, 0.80);

/**
 * Evaluates one rock shape into a mesh buffer, transformed by `m`.
 *
 * Vertex colour carries three things a texture cannot: cavity occlusion derived
 * from the shape itself, the soil line where the rock disappears into the
 * ground, and lichen that only grows on surfaces facing the sky.
 */
function emitRock(
  b: MeshBuf,
  field: RockField,
  subdiv: number,
  worldRadius: number,
  m: THREE.Matrix4 | null,
  uvScale: number,
): { height: number; radius: number } {
  const ico = icosphere(subdiv);
  const n = ico.count;
  const dir = ico.dir;
  const index = ico.index;

  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rad[i] = field.radius(dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2]);
  }

  // Smoothed radius over the 1-ring, iterated so the comparison sees a broad
  // neighbourhood rather than a single triangle. The signed difference is a
  // usable cavity term: negative in the grooves, positive on the ribs.
  let smooth = Float32Array.from(rad);
  const acc = new Float32Array(n);
  const cnt = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    acc.fill(0);
    cnt.fill(0);
    for (let f = 0; f < index.length; f += 3) {
      for (let e = 0; e < 3; e++) {
        const a = index[f + e];
        const c = index[f + ((e + 1) % 3)];
        acc[a] += smooth[c];
        cnt[a]++;
        acc[c] += smooth[a];
        cnt[c]++;
      }
    }
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) next[i] = cnt[i] > 0 ? acc[i] / cnt[i] : smooth[i];
    smooth = next;
  }

  // Positions, normalised so the shape's horizontal radius is `worldRadius`.
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pz = new Float32Array(n);
  let maxXZ = 1e-4;
  let minY = 1e9;
  let maxY = -1e9;
  for (let i = 0; i < n; i++) {
    const r = rad[i];
    const x = dir[i * 3] * r;
    const y = dir[i * 3 + 1] * r;
    const z = dir[i * 3 + 2] * r;
    px[i] = x;
    py[i] = y;
    pz[i] = z;
    const h = Math.hypot(x, z);
    if (h > maxXZ) maxXZ = h;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const k = worldRadius / maxXZ;
  for (let i = 0; i < n; i++) {
    px[i] *= k;
    py[i] = (py[i] - minY) * k;
    pz[i] *= k;
  }
  const height = (maxY - minY) * k;

  // Smooth normals, area weighted.
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  const faceN = new Float32Array(index.length);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f];
    const c = index[f + 1];
    const d = index[f + 2];
    const e1x = px[c] - px[a];
    const e1y = py[c] - py[a];
    const e1z = pz[c] - pz[a];
    const e2x = px[d] - px[a];
    const e2y = py[d] - py[a];
    const e2z = pz[d] - pz[a];
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    faceN[f] = fx;
    faceN[f + 1] = fy;
    faceN[f + 2] = fz;
    nx[a] += fx; ny[a] += fy; nz[a] += fz;
    nx[c] += fx; ny[c] += fy; nz[c] += fz;
    nx[d] += fx; ny[d] += fy; nz[d] += fz;
  }
  for (let i = 0; i < n; i++) {
    const inv = 1 / Math.max(1e-9, Math.hypot(nx[i], ny[i], nz[i]));
    nx[i] *= inv;
    ny[i] *= inv;
    nz[i] *= inv;
  }

  // Vertex colour.
  const cr = new Float32Array(n);
  const cg = new Float32Array(n);
  const cb = new Float32Array(n);
  const dirtTop = Math.max(0.12, height * 0.26);
  for (let i = 0; i < n; i++) {
    const cav = (rad[i] - smooth[i]) / Math.max(smooth[i], 1e-3);
    const ao = clamp(0.80 + 2.3 * cav, 0.36, 1.08);
    const soil = 1 - smoothstep(0.0, dirtTop, py[i]) * 0.92;
    const lich =
      smoothstep(0.18, 0.66, ny[i]) *
      smoothstep(0.50, 0.80, fbm3(px[i] * 0.55, py[i] * 0.55, pz[i] * 0.55, field.seed + 3, 2));
    let r = ao;
    let g = ao;
    let bl = ao;
    r = r * (1 - soil) + r * SOIL.r * soil;
    g = g * (1 - soil) + g * SOIL.g * soil;
    bl = bl * (1 - soil) + bl * SOIL.b * soil;
    const w = lich * 0.62;
    cr[i] = r * (1 - w) + r * LICHEN.r * w;
    cg[i] = g * (1 - w) + g * LICHEN.g * w;
    cb[i] = bl * (1 - w) + bl * LICHEN.b * w;
  }

  // Expand to faces. Per-corner normals fall back to the flat face normal
  // wherever the surface creases, which is what keeps a fracture plane sharp
  // while the weathered curves between them stay smooth. UVs are box-projected
  // per face so no seam or pole distortion can appear.
  const wp = new THREE.Vector3();
  const wn = new THREE.Vector3();
  for (let f = 0; f < index.length; f += 3) {
    const fInv = 1 / Math.max(1e-9, Math.hypot(faceN[f], faceN[f + 1], faceN[f + 2]));
    const fx = faceN[f] * fInv;
    const fy = faceN[f + 1] * fInv;
    const fz = faceN[f + 2] * fInv;

    // Dominant axis of the (possibly transformed) face normal.
    wn.set(fx, fy, fz);
    if (m) wn.transformDirection(m);
    const ax = Math.abs(wn.x);
    const ay = Math.abs(wn.y);
    const az = Math.abs(wn.z);

    const ids: number[] = [];
    for (let e = 0; e < 3; e++) {
      const i = index[f + e];
      let vx = nx[i];
      let vy = ny[i];
      let vz = nz[i];
      const dot = vx * fx + vy * fy + vz * fz;
      const w = smoothstep(0.95, 0.74, dot);
      vx = vx * (1 - w) + fx * w;
      vy = vy * (1 - w) + fy * w;
      vz = vz * (1 - w) + fz * w;
      const vInv = 1 / Math.max(1e-9, Math.hypot(vx, vy, vz));
      vx *= vInv; vy *= vInv; vz *= vInv;

      wp.set(px[i], py[i], pz[i]);
      if (m) {
        wp.applyMatrix4(m);
        const t = new THREE.Vector3(vx, vy, vz).transformDirection(m);
        vx = t.x; vy = t.y; vz = t.z;
      }
      const u = ay >= ax && ay >= az ? wp.x * uvScale : ax >= az ? wp.z * uvScale : wp.x * uvScale;
      const v = ay >= ax && ay >= az ? wp.z * uvScale : wp.y * uvScale;
      ids.push(b.vertex(wp.x, wp.y, wp.z, vx, vy, vz, u, v, cr[i], cg[i], cb[i]));
    }
    b.tri(ids[0], ids[1], ids[2]);
  }

  return { height, radius: worldRadius };
}

export interface RockGeometry {
  geometry: THREE.BufferGeometry;
  /** World height of the shape, base at y = 0. */
  height: number;
  /** World radius in XZ. */
  radius: number;
}

/**
 * One rock shape at several levels of detail. Every level re-evaluates the same
 * field, so the silhouette survives an LOD switch instead of popping.
 */
export function buildRockLods(kind: RockKind, seed: number, subdivs: number[], sizeScale = 1): RockGeometry[] {
  const field = makeRockField(kind, seed);
  const P = field.profile;
  const worldRadius = P.size * sizeScale;
  const out: RockGeometry[] = [];
  for (let i = 0; i < subdivs.length; i++) {
    const b = new MeshBuf();
    const info = emitRock(b, field, subdivs[i], worldRadius, null, P.uvScale);
    out.push({
      geometry: b.build(`rock-${kind}-${i}`),
      height: info.height,
      radius: info.radius,
    });
  }
  return out;
}

/**
 * A drift of small stones and flat shale plates, merged into one geometry.
 *
 * Debris is what sells a boulder: bare ground with a single large rock on it
 * reads as placed, whereas the same rock surrounded by the pieces that spalled
 * off it reads as having been there for ten thousand years. Merging the drift
 * means all of that costs one draw call rather than twenty instances.
 */
export function buildDebrisCluster(seed: number, subdiv: number, spread = 1.9): RockGeometry {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const count = 7 + Math.floor(rng() * 4);
  let height = 0;
  for (let i = 0; i < count; i++) {
    const flat = rng() < 0.45;
    const field = makeRockField(flat ? 'block' : 'stone', (seed + i * 977) >>> 0);
    const r = (flat ? 0.26 : 0.20) * (0.55 + rng() * 1.15);
    const a = rng() * Math.PI * 2;
    const d = Math.pow(rng(), 0.6) * spread;
    e.set((rng() - 0.5) * (flat ? 0.5 : 1.5), rng() * Math.PI * 2, (rng() - 0.5) * (flat ? 0.5 : 1.5));
    q.setFromEuler(e);
    // Sunk to the waist: loose stone settles into the soil, it does not perch.
    pos.set(Math.cos(a) * d, -r * (0.18 + 0.32 * rng()), Math.sin(a) * d);
    scl.set(1, flat ? 0.42 : 0.85, 1);
    m.compose(pos, q, scl);
    const info = emitRock(b, field, subdiv, r, m, 0.95);
    height = Math.max(height, info.height * 0.6);
  }

  return { geometry: b.build('rock-debris'), height: Math.max(height, 0.25), radius: spread };
}
