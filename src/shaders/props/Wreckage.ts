import * as THREE from 'three';
import { makeRng } from '@/util/Noise';
import {
  MeshBuf,
  addBox,
  addCylinder,
  addExtrusion,
  finishProp,
  type BuiltProp,
  type SurfaceOpts,
} from './PropGeo';

/**
 * The man-made props: burnt-out hulls, cast-concrete barriers, broken walls and
 * fencing.
 *
 * These are the storytelling layer. A battlefield with nothing but rocks on it
 * reads as a landscape render; the same ground with a barrier line dragged
 * across the approach and a hull rusting where it stopped reads as a place
 * something happened. They are placed sparsely and deliberately — a wreck every
 * hundred metres is a story, a wreck every ten is a scrapyard.
 *
 * Every piece is assembled from chamfered boxes, cylinders and swept profiles
 * into a single buffer, so a whole vehicle is one geometry and one instanced
 * draw. Colour is per-vertex over the shared painted-steel texture, whose paint
 * is deliberately near-white: the tint here is what makes one hull faded olive
 * and the next one soot black without a second material.
 */

/* ---------------------------------------------------------------- palette -- */

/** Linear multipliers over the synthesised albedo. */
const C = {
  olive: new THREE.Color(0.40, 0.40, 0.29),
  sand: new THREE.Color(0.52, 0.47, 0.35),
  gunmetal: new THREE.Color(0.27, 0.28, 0.30),
  soot: new THREE.Color(0.085, 0.082, 0.078),
  charred: new THREE.Color(0.15, 0.13, 0.115),
  rust: new THREE.Color(0.36, 0.21, 0.115),
  rubber: new THREE.Color(0.055, 0.055, 0.058),
  glass: new THREE.Color(0.045, 0.062, 0.068),
  steel: new THREE.Color(0.62, 0.63, 0.64),
  concrete: new THREE.Color(1.0, 1.0, 1.0),
  concreteDirty: new THREE.Color(0.78, 0.76, 0.70),
  rebar: new THREE.Color(0.40, 0.24, 0.13),
};

const METAL_UV = 0.6;
const CONCRETE_UV = 0.55;

function surf(color: THREE.Color, uvScale: number, underShade = 0.34): SurfaceOpts {
  return { color, uvScale, underShade };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _half = new THREE.Vector3();

/** Composes a part transform: position, XYZ euler, uniform scale 1. */
function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  _p.set(x, y, z);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(1, 1, 1);
  return _m.compose(_p, _q, _s).clone();
}

function box(
  b: MeshBuf, x: number, y: number, z: number,
  hx: number, hy: number, hz: number,
  rx: number, ry: number, rz: number,
  chamfer: number, opt: SurfaceOpts,
): void {
  _half.set(hx, hy, hz);
  addBox(b, at(x, y, z, rx, ry, rz), _half, chamfer, opt);
}

function cyl(
  b: MeshBuf, x: number, y: number, z: number,
  r0: number, r1: number, len: number, seg: number,
  rx: number, ry: number, rz: number,
  opt: SurfaceOpts,
): void {
  addCylinder(b, at(x, y, z, rx, ry, rz), r0, r1, len, seg, opt);
}

/* ------------------------------------------------------------- vehicles -- */

/**
 * Main battle tank, gutted. The turret was blown off its ring and lies beside
 * the hull with the barrel driven into the ground — the single most legible
 * silhouette for "this was killed here", and it doubles the footprint so the
 * wreck occupies a space rather than sitting on a point.
 */
export function buildTankWreck(seed: number): BuiltProp {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const hull = surf(C.olive, METAL_UV);
  const burnt = surf(C.charred, METAL_UV);
  const black = surf(C.soot, METAL_UV, 0.1);
  const tyre = surf(C.rubber, METAL_UV * 1.6, 0.2);
  const steel = surf(C.rust, METAL_UV);

  // Lower hull and running gear.
  box(b, 0, 0.70, 0, 2.55, 0.52, 1.28, 0, 0, 0.02, 0.10, hull);
  // Sloped glacis.
  box(b, 2.30, 1.06, 0, 0.86, 0.36, 1.24, 0, 0, -0.62, 0.08, hull);
  // Upper deck, with the fighting compartment burnt out.
  box(b, -0.30, 1.42, 0, 1.95, 0.24, 1.20, 0, 0, 0.02, 0.07, hull);
  box(b, -1.75, 1.60, 0, 0.62, 0.10, 0.92, 0, 0, 0, 0.04, black); // engine grille
  // Turret ring, empty, with the torn lip of the blast.
  cyl(b, 0.35, 1.62, 0, 0.86, 0.80, 0.30, 12, 0, 0, 0, burnt);
  cyl(b, 0.35, 1.70, 0, 0.70, 0.74, 0.26, 12, 0, 0, 0, black);

  // Road wheels. Two are gone on the far side; the track has run off with them.
  for (let i = 0; i < 6; i++) {
    const x = -2.05 + i * 0.82;
    cyl(b, x, 0.44, 1.30, 0.40, 0.40, 0.26, 10, Math.PI / 2, 0, 0, tyre);
    if (i !== 2 && i !== 3) cyl(b, x, 0.44, -1.30, 0.40, 0.40, 0.26, 10, Math.PI / 2, 0, 0, tyre);
  }
  cyl(b, 2.42, 0.62, 1.30, 0.34, 0.34, 0.28, 8, Math.PI / 2, 0, 0, steel);
  cyl(b, -2.42, 0.62, 1.30, 0.34, 0.34, 0.28, 8, Math.PI / 2, 0, 0, steel);

  // Near-side track, still on. Far side spilled forward into a slack loop.
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    box(b, -2.3 + t * 4.6, 0.06, 1.30, 0.28, 0.06, 0.30, 0, 0, 0, 0.02, tyre);
    box(b, -2.3 + t * 4.6, 1.06, 1.30, 0.28, 0.06, 0.30, 0, 0, 0, 0.02, tyre);
  }
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const x = 2.6 + t * 2.6;
    const z = -1.2 + Math.sin(t * 2.4) * 0.9;
    box(b, x, 0.07, z, 0.30, 0.055, 0.30, 0, t * 1.1 - 0.2, 0.04, 0.02, tyre);
  }

  // Side skirt: one panel peeled outward, the rest torn away.
  box(b, -0.4, 0.98, 1.46, 1.7, 0.34, 0.05, 0.34, 0, 0, 0.02, burnt);

  // The turret, upside down where it landed.
  const tq = 2.55 + rng() * 0.25;
  const ty = 0.62 + rng() * 0.4;
  box(b, 1.0, 0.52, 3.35, 1.05, 0.40, 0.92, tq, ty, 0.2, 0.14, burnt);
  box(b, 1.0, 1.02, 3.35, 0.78, 0.14, 0.68, tq, ty, 0.2, 0.06, black);
  // Barrel, bent, ploughed into the soil.
  cyl(b, 2.35, 0.55, 3.9, 0.155, 0.135, 1.9, 8, 0.0, ty, Math.PI / 2 + 0.30, steel);
  cyl(b, 3.55, 0.16, 4.25, 0.13, 0.115, 1.2, 8, 0.0, ty + 0.2, Math.PI / 2 + 0.62, steel);

  return finishProp(b, 'wreck-tank');
}

/**
 * Supply truck, burnt to the frame. The cab is crushed and the canopy hoops are
 * bare — the tarpaulin went up first, which is exactly what a viewer reads
 * without being told.
 */
export function buildTruckWreck(seed: number): BuiltProp {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const body = surf(C.sand, METAL_UV);
  const burnt = surf(C.charred, METAL_UV);
  const black = surf(C.soot, METAL_UV, 0.1);
  const tyre = surf(C.rubber, METAL_UV * 1.6, 0.2);
  const steel = surf(C.rust, METAL_UV);
  const glass = surf(C.glass, METAL_UV, 0);

  // Chassis rails.
  box(b, 0, 0.66, 0.62, 2.75, 0.08, 0.09, 0, 0, 0, 0.03, steel);
  box(b, 0, 0.66, -0.62, 2.75, 0.08, 0.09, 0, 0, 0, 0.03, steel);
  box(b, -2.4, 0.66, 0, 0.28, 0.07, 0.70, 0, 0, 0, 0.03, steel);

  // Cab: sides intact, roof collapsed onto the seats.
  box(b, 1.55, 1.30, 0, 0.80, 0.56, 0.96, 0, 0, 0.02, 0.08, body);
  box(b, 1.42, 1.86, 0, 0.72, 0.09, 0.90, 0, 0, 0.26, 0.05, burnt);
  box(b, 2.30, 1.52, 0, 0.05, 0.36, 0.82, 0, 0, -0.30, 0.03, glass);
  box(b, 2.72, 1.06, 0, 0.52, 0.30, 0.88, 0, 0, 0.05, 0.07, body);
  box(b, 3.22, 0.90, 0, 0.10, 0.26, 0.92, 0, 0, 0, 0.04, steel); // bumper

  // Flatbed with its ribs standing bare.
  box(b, -1.15, 0.80, 0, 1.62, 0.06, 1.00, 0, 0, 0, 0.03, burnt);
  box(b, -1.15, 1.06, 1.02, 1.62, 0.24, 0.05, 0.28, 0, 0, 0.02, burnt);
  box(b, -1.15, 1.00, -1.02, 1.10, 0.20, 0.05, 0, 0, 0, 0.02, burnt);
  for (let i = 0; i < 3; i++) {
    const x = -0.1 - i * 1.0;
    const lean = (rng() - 0.5) * 0.5;
    box(b, x, 1.35, 0.96, 0.04, 0.52, 0.04, 0, 0, lean * 0.4, 0.015, steel);
    box(b, x, 1.35, -0.96, 0.04, 0.52, 0.04, 0, 0, lean * 0.4, 0.015, steel);
    if (i !== 1) box(b, x + lean * 0.3, 1.86, 0, 0.04, 0.04, 0.98, 0, 0, 0, 0.015, steel);
  }

  // Wheels: one blown off, one burnt down to the rim.
  const wheel = (x: number, z: number, flat: boolean): void => {
    cyl(b, x, flat ? 0.34 : 0.52, z, flat ? 0.30 : 0.52, flat ? 0.30 : 0.52,
      flat ? 0.42 : 0.34, 10, Math.PI / 2, 0, 0, flat ? steel : tyre);
  };
  wheel(1.85, 0.86, false);
  wheel(1.85, -0.86, true);
  wheel(-1.35, 0.86, false);
  wheel(-1.35, -0.86, false);
  wheel(-2.05, 0.86, false);

  // A drum thrown clear.
  cyl(b, -3.1, 0.34, 1.5, 0.34, 0.34, 0.90, 12, 0, 0.6, Math.PI / 2, black);

  return finishProp(b, 'wreck-truck');
}

/**
 * Wheeled APC, rolled onto its side. Tipped hulls are worth having in the set
 * because they break the horizon line that upright vehicles all share, and the
 * exposed belly plate gives the light something completely different to do.
 */
export function buildApcWreck(seed: number): BuiltProp {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const body = surf(C.gunmetal, METAL_UV);
  const burnt = surf(C.charred, METAL_UV);
  const black = surf(C.soot, METAL_UV, 0.1);
  const tyre = surf(C.rubber, METAL_UV * 1.6, 0.2);
  const steel = surf(C.rust, METAL_UV);

  // Roll about the long axis, plus a little nose-down.
  const roll = 1.42 + rng() * 0.16;
  const parts = new MeshBuf();

  // Hull, built upright then tipped as a whole.
  box(parts, 0, 1.05, 0, 2.55, 0.62, 1.20, 0, 0, 0, 0.12, body);
  box(parts, 2.05, 1.72, 0, 0.72, 0.30, 1.05, 0, 0, -0.42, 0.08, body);
  box(parts, -0.4, 1.80, 0, 1.85, 0.16, 1.02, 0, 0, 0, 0.06, body);
  box(parts, 0.5, 2.02, 0.2, 0.44, 0.22, 0.44, 0, 0.3, 0, 0.06, burnt); // cupola
  box(parts, -2.55, 1.05, 0, 0.10, 0.55, 1.05, 0, 0, 0, 0.04, burnt);   // rear ramp, dropped
  box(parts, -3.05, 0.44, 0, 0.52, 0.06, 1.00, 0, 0, 0.42, 0.03, burnt);
  for (let i = 0; i < 3; i++) {
    const x = -1.6 + i * 1.7;
    cyl(parts, x, 0.62, 1.28, 0.60, 0.60, 0.36, 10, Math.PI / 2, 0, 0, tyre);
    cyl(parts, x, 0.62, -1.28, 0.60, 0.60, 0.36, 10, Math.PI / 2, 0, 0, i === 1 ? steel : tyre);
  }

  // Re-emit the whole assembly through the roll transform.
  const geo = parts.build('apc-upright');
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const idx = geo.getIndex()!;
  const tip = new THREE.Matrix4().makeRotationX(roll);
  const nm = new THREE.Matrix3().getNormalMatrix(tip);
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(tip);
    nv.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
    b.vertex(v.x, v.y, v.z, nv.x, nv.y, nv.z, uv.getX(i), uv.getY(i), col.getX(i), col.getY(i), col.getZ(i));
  }
  for (let i = 0; i < idx.count; i += 3) b.tri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
  geo.dispose();

  // Scatter around the hull: a hatch and a wheel that came off.
  box(b, 2.4, 0.06, -1.9, 0.42, 0.05, 0.38, 0, 0.8, 0.06, 0.03, black);
  cyl(b, -2.6, 0.18, 2.1, 0.58, 0.58, 0.36, 10, 0.1, 0, 0.06, tyre);

  return finishProp(b, 'wreck-apc');
}

/* ------------------------------------------------------------- concrete -- */

/** The standard tapered crash barrier, cast in one piece and chipped at the top. */
export function buildJerseyBarrier(seed: number): BuiltProp {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const opt = surf(C.concrete, CONCRETE_UV, 0.28);
  const outline: Array<[number, number]> = [
    [-0.30, 0.00], [0.30, 0.00], [0.30, 0.10], [0.155, 0.33],
    [0.115, 0.84], [0.125, 0.94], [-0.125, 0.94], [-0.115, 0.84],
    [-0.155, 0.33], [-0.30, 0.10],
  ];
  addExtrusion(b, at(0, 0, 0), outline, 2.4, opt);

  // Corner damage, and the lifting-eye recesses in the top face.
  const chip = surf(C.concreteDirty, CONCRETE_UV, 0.2);
  box(b, 0.02, 0.95, 1.12 * (rng() < 0.5 ? 1 : -1), 0.14, 0.12, 0.16, 0.4, 0.3, 0.2, 0.02, chip);
  box(b, 0, 0.90, 0.55, 0.07, 0.06, 0.10, 0, 0, 0, 0.02, chip);
  box(b, 0, 0.90, -0.55, 0.07, 0.06, 0.10, 0, 0, 0, 0.02, chip);

  return finishProp(b, 'barrier-jersey');
}

/**
 * A stretch of blast wall, broken. Built as a run of columns with independent
 * heights so the top edge is genuinely ragged in silhouette; two are missing
 * entirely and the reinforcement stands up out of the gap.
 */
export function buildBrokenWall(seed: number): BuiltProp {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const opt = surf(C.concrete, CONCRETE_UV, 0.3);
  const rebar = surf(C.rebar, CONCRETE_UV * 2, 0.2);

  const columns = 9;
  const width = 0.24;
  const gapA = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < columns; i++) {
    if (i === gapA || i === gapA + 1) continue;
    const x = (i - (columns - 1) * 0.5) * width * 2;
    const fall = Math.abs(i - gapA) / columns;
    const h = 0.55 + 1.35 * Math.min(1, fall * 2.4) * (0.75 + 0.25 * rng());
    box(b, x, h * 0.5, 0, width, h * 0.5, 0.17, 0, 0, 0, 0.035, opt);
  }
  // Footing beam, still whole.
  box(b, 0, 0.13, 0, columns * width, 0.13, 0.24, 0, 0, 0, 0.04, opt);
  // Reinforcement standing in the breach.
  for (let i = 0; i < 3; i++) {
    const x = (gapA - (columns - 1) * 0.5) * width * 2 + (i - 1) * 0.14;
    cyl(b, x, 0.55 + rng() * 0.2, (rng() - 0.5) * 0.2, 0.022, 0.020, 0.9 + rng() * 0.5, 5,
      (rng() - 0.5) * 0.5, 0, (rng() - 0.5) * 0.6, rebar);
  }
  // A toppled slab lying in front of the breach.
  box(b, 0.3, 0.10, 0.85, 0.62, 0.09, 0.42, 0.05, 0.4, 0.03, 0.03, opt);

  return finishProp(b, 'barrier-wall');
}

/** Broken concrete and rebar, drifted into a heap. */
export function buildConcreteRubble(seed: number): BuiltProp {
  const rng = makeRng(seed >>> 0);
  const b = new MeshBuf();
  const opt = surf(C.concrete, CONCRETE_UV, 0.35);
  const dirty = surf(C.concreteDirty, CONCRETE_UV, 0.35);
  const rebar = surf(C.rebar, CONCRETE_UV * 2, 0.2);

  const count = 7 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.pow(rng(), 0.65) * 1.35;
    const sx = 0.16 + rng() * 0.30;
    const sy = 0.09 + rng() * 0.20;
    const sz = 0.14 + rng() * 0.28;
    box(b, Math.cos(a) * d, sy * (0.55 + rng() * 0.4), Math.sin(a) * d,
      sx, sy, sz, (rng() - 0.5) * 1.0, rng() * Math.PI, (rng() - 0.5) * 1.0,
      0.035, rng() < 0.4 ? dirty : opt);
  }
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2;
    cyl(b, Math.cos(a) * 0.7, 0.18 + rng() * 0.2, Math.sin(a) * 0.7,
      0.020, 0.018, 0.7 + rng() * 0.6, 5,
      Math.PI * 0.32 + rng() * 0.5, rng() * Math.PI, (rng() - 0.5) * 0.8, rebar);
  }

  return finishProp(b, 'rubble-concrete');
}

/* ---------------------------------------------------------------- fence -- */

/** A steel T-post with its ground stake, emitted into a merged world-space buffer. */
export function emitFencePost(b: MeshBuf, m: THREE.Matrix4, height: number, rusty: number): void {
  const c = new THREE.Color().copy(C.steel).lerp(C.rust, rusty);
  const opt: SurfaceOpts = { color: c, uvScale: 1.4, underShade: 0.3 };
  _half.set(0.045, height * 0.5, 0.022);
  addBox(b, new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, height * 0.5 - 0.25, 0)), _half, 0.012, opt);
  _half.set(0.016, height * 0.5, 0.055);
  addBox(b, new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, height * 0.5 - 0.25, 0)), _half, 0.010, opt);
  // Cap.
  _half.set(0.055, 0.020, 0.055);
  addBox(b, new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, height - 0.25, 0)), _half, 0.008, opt);
}

/** Top rail between two posts, as a squared-off tube. */
export function emitFenceRail(
  b: MeshBuf,
  a: THREE.Vector3,
  c: THREE.Vector3,
  radius: number,
  rusty: number,
): void {
  const dir = new THREE.Vector3().subVectors(c, a);
  const len = dir.length();
  if (len < 1e-3) return;
  const mid = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const m = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  const col = new THREE.Color().copy(C.steel).lerp(C.rust, rusty);
  addCylinder(b, m, radius, radius, len, 6, { color: col, uvScale: 1.4, underShade: 0.25 }, false);
}

/**
 * One span of chain-link, as a single quad. The wire itself is an alpha cut-out
 * whose colour is written into every texel including the transparent ones, so
 * mip reduction cannot average black into the strands and turn a distant fence
 * into a dark smear.
 */
export function emitFencePanel(
  b: MeshBuf,
  a: THREE.Vector3,
  c: THREE.Vector3,
  bottom: number,
  top: number,
  sag: number,
  tint: THREE.Color,
): void {
  const dir = new THREE.Vector3().subVectors(c, a);
  const len = Math.hypot(dir.x, dir.z);
  if (len < 1e-3) return;
  const nx = -dir.z / len;
  const nz = dir.x / len;
  const uRep = len / 0.7;
  const vRep = (top - bottom) / 0.7;

  const ay = a.y + bottom;
  const cy = c.y + bottom;
  const ids = [
    b.vertex(a.x, ay, a.z, nx, 0, nz, 0, 0, tint.r, tint.g, tint.b),
    b.vertex(c.x, cy, c.z, nx, 0, nz, uRep, 0, tint.r, tint.g, tint.b),
    b.vertex(c.x, c.y + top - sag, c.z, nx, 0, nz, uRep, vRep, tint.r, tint.g, tint.b),
    b.vertex(a.x, a.y + top - sag, a.z, nx, 0, nz, 0, vRep, tint.r, tint.g, tint.b),
  ];
  b.quad(ids[0], ids[1], ids[2], ids[3]);
}
