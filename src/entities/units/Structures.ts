import type { BuildingType, Faction } from '@/entities/Types';
import { PALETTES, surf, type Palette } from '@/entities/materials/Surface';
import { ngon, PartBuilder, rect, trap, type Vec2 } from './Kit';
import { emptyRig, RigBuilder, type RigDef } from './RigDef';

/**
 * Structure geometry.
 *
 * Every building is three layers: a poured apron that grounds it on sloping
 * terrain, a superstructure hung off the `riser` bone so the build-up animation
 * can drive it out of the ground, and the moving parts (turret, dish, shutter)
 * on their own bones.
 *
 * GDI structures are orthogonal and bolted — rectangular pads, bar armour,
 * external stairs and gantries. Nod structures are raked and predatory —
 * hexagonal pads, wedge walls, spires and slit vents. The two silhouettes have
 * to be distinguishable at a glance from the RTS camera, so the differences are
 * in massing, not just colour.
 */

export interface StructureBuild {
  builder: PartBuilder;
  def: RigDef;
}

const K = (pal: Palette) => ({
  wall: surf('paint', { color: pal.primary, uvScale: 0.22 }),
  wall2: surf('paint', { color: pal.secondary, uvScale: 0.22 }),
  dark: surf('paintDark', { color: pal.dark, uvScale: 0.24 }),
  armour: surf('armour', { color: pal.secondary, uvScale: 0.2 }),
  trim: surf('paintTrim', { color: pal.accent }),
  metal: surf('metal', { color: pal.metal }),
  steel: surf('steel'),
  dmetal: surf('darkMetal'),
  concrete: surf('concrete'),
  concreteDark: surf('concrete', { color: 0x6a6862, grunge: 1 }),
  asphalt: surf('asphalt'),
  glass: surf('glass'),
  rust: surf('rust'),
  team: surf('team'),
  teamLight: surf('team', { emissive: 5.0, roughness: 0.35 }),
  lamp: surf('lamp'),
  amber: surf('lampAmber'),
  red: surf('lampRed'),
  glow: surf('lamp', { color: pal.glow, emissive: 3.4 }),
  crystal: surf('crystal'),
});

type Kit = ReturnType<typeof K>;

/* ------------------------------------------------------------------ apron */

/**
 * The poured pad. It reaches well below the origin so a structure sited on a
 * grade still meets the ground on every side instead of hovering on its
 * downhill corner — the single most common "it's floating" tell.
 */
function apron(b: PartBuilder, k: Kit, s: number, nod: boolean, detail: number): void {
  const outer: Vec2[] = nod ? ngon(s * 0.72, 6, Math.PI / 6) : rect(s * 1.06, s * 1.06);
  const inner: Vec2[] = nod ? ngon(s * 0.63, 6, Math.PI / 6) : rect(s * 0.92, s * 0.92);

  b.use(k.concreteDark);
  b.prismY(outer, 3.4, 0.34, 0, -1.35, 0);
  b.use(k.concrete);
  b.prismY(inner, 0.7, 0.22, 0, 0.5, 0);

  if (detail > 0) {
    // Kerb blocks and bollards read as poured-in-place concrete at any zoom.
    b.use(k.concreteDark);
    const corner = s * (nod ? 0.56 : 0.46);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.box(sx * corner, 0.85, sz * corner, 1.1, 1.5, 1.1, 0.14);
        b.use(k.trim);
        b.box(sx * corner, 1.66, sz * corner, 0.95, 0.16, 0.95, 0.05);
        b.use(k.concreteDark);
      }
    }
    // Hazard chevrons on the approach face, painted straight onto the pad.
    b.use(k.trim);
    for (let i = 0; i < 5; i++) {
      b.decal((i - 2) * s * 0.15, 0.87, s * 0.4, s * 0.09, s * 0.16, 0.6);
    }
    b.use(k.asphalt);
    b.decal(0, 0.86, -s * 0.28, s * 0.6, s * 0.3, 0);
  }
}

/** Lattice mast — cheap vertical interest that keeps a base skyline busy. */
function mast(b: PartBuilder, k: Kit, x: number, y: number, z: number, h: number, r: number, detail: number): void {
  b.use(k.dmetal);
  const legs = 3;
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * Math.PI * 2;
    b.push();
    b.move(x + Math.cos(a) * r, y + h / 2, z + Math.sin(a) * r);
    b.rotZ(Math.cos(a) * (r / h) * 1.4);
    b.rotX(-Math.sin(a) * (r / h) * 1.4);
    b.box(0, 0, 0, 0.22, h, 0.22, 0.05);
    b.pop();
  }
  if (detail > 0) {
    const rungs = Math.max(3, Math.round(h / 2.2));
    for (let i = 1; i <= rungs; i++) {
      const t = i / (rungs + 1);
      const rr = r * (1 - t * 0.25);
      b.use(k.dmetal);
      b.prismY(ngon(rr, legs, 0) as Vec2[], 0.14, 0.04, x, y + t * h, z, false);
    }
  }
  b.use(k.red);
  b.box(x, y + h + 0.2, z, 0.34, 0.34, 0.34, 0.08);
}

/** Cooling stack with a flared cap. */
function stack(b: PartBuilder, k: Kit, x: number, z: number, y0: number, h: number, r: number, detail: number): void {
  b.use(k.dmetal);
  b.tube(x, y0 + h / 2, z, r * 0.86, r, h, detail > 0 ? 12 : 7);
  b.use(k.steel);
  b.tube(x, y0 + h, z, r * 1.22, r * 0.94, r * 0.55, detail > 0 ? 12 : 7);
  b.use(k.rust);
  b.tube(x, y0 + h * 0.42, z, r * 1.1, r * 1.1, 0.35, detail > 0 ? 12 : 7);
}

/** Pipe run with elbows — the industrial connective tissue. */
function plumbing(b: PartBuilder, k: Kit, x0: number, z0: number, x1: number, z1: number, y: number, r: number): void {
  b.use(k.metal);
  b.pipe(x0, y, z0, x1, y, z0, r, 8);
  b.pipe(x1, y, z0, x1, y, z1, r, 8);
  b.use(k.dmetal);
  b.tube(x1, y, z0, r * 1.5, r * 1.5, r * 2.2, 8);
}

/** Team banner: a small vertical panel plus a lamp. Never a whole-wall tint. */
function banner(b: PartBuilder, k: Kit, x: number, y: number, z: number, w: number, h: number, faceZ: number): void {
  b.use(k.team);
  b.box(x, y, z, w, h, 0.22, 0.05);
  b.use(k.dmetal);
  b.box(x, y + h * 0.5 + 0.16, z, w * 1.12, 0.2, 0.3, 0.05);
  b.box(x, y - h * 0.5 - 0.16, z, w * 1.12, 0.2, 0.3, 0.05);
  b.use(k.teamLight);
  b.box(x, y, z + faceZ * 0.15, w * 0.44, h * 0.16, 0.1, 0.03);
}

/* --------------------------------------------------------------- buildings */

interface Ctx {
  b: PartBuilder;
  k: Kit;
  rig: RigBuilder;
  def: RigDef;
  root: number;
  riser: number;
  s: number;
  nod: boolean;
  detail: number;
}

function begin(faction: Faction, size: number, detail: number): Ctx {
  const pal = PALETTES[faction];
  const k = K(pal);
  const b = new PartBuilder(k.wall, detail);
  const rig = new RigBuilder();
  const def = emptyRig('tracked');
  const root = rig.add('root', -1, 0, 0, 0);
  const riser = rig.add('riser', root, 0, 0, 0);
  def.hull = root;
  def.riser = riser;
  def.radius = size * 0.5;
  const nod = faction === 'nod';
  b.bone(root);
  apron(b, k, size, nod, detail);
  b.bone(riser);
  return { b, k, rig, def, root, riser, s: size, nod, detail };
}

/* ---- construction yard ---- */

function hq(c: Ctx): void {
  const { b, k, s, nod, detail } = c;
  c.def.height = 26;
  c.def.riseDepth = 24;

  if (nod) {
    // Stepped ziggurat under a crimson spire.
    b.use(k.wall);
    b.prismY(ngon(s * 0.5, 6, Math.PI / 6) as Vec2[], 6.5, 0.5, 0, 4.1, 0);
    b.use(k.wall2);
    b.prismY(ngon(s * 0.38, 6, Math.PI / 6) as Vec2[], 5.0, 0.42, 0, 9.6, 0);
    b.use(k.dark);
    b.prismY(ngon(s * 0.26, 6, Math.PI / 6) as Vec2[], 4.0, 0.34, 0, 13.8, 0);
    b.use(k.metal);
    b.prismY(ngon(1.4, 6, Math.PI / 6) as Vec2[], 9.0, 0.3, 0, 19.5, 0);
    b.use(k.glow);
    b.dome(0, 24.0, 0, 1.5, 10, 3, 1.3);
    // Raked buttresses.
    b.use(k.armour);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      b.push();
      b.move(Math.cos(a) * s * 0.44, 4.2, Math.sin(a) * s * 0.44);
      b.rotY(-a);
      b.prism(trap(3.4, 1.1, 8.0) as Vec2[], 1.5, 0.18);
      b.pop();
    }
    b.use(k.glow);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.box(Math.cos(a) * s * 0.3, 12.2, Math.sin(a) * s * 0.3, 0.5, 1.6, 0.5, 0.1);
    }
  } else {
    // Hangar block, control tower, external gantry.
    b.use(k.wall);
    b.box(-s * 0.12, 5.2, 0, s * 0.72, 9.0, s * 0.86, 0.4);
    b.use(k.wall2);
    b.box(-s * 0.12, 10.2, 0, s * 0.76, 1.2, s * 0.9, 0.24);
    b.use(k.dark);
    b.box(s * 0.3, 8.0, -s * 0.2, s * 0.34, 14.4, s * 0.34, 0.32);
    b.use(k.glass);
    b.box(s * 0.3, 13.6, -s * 0.2, s * 0.36, 2.4, s * 0.36, 0.12);
    b.use(k.wall2);
    b.box(s * 0.3, 15.4, -s * 0.2, s * 0.4, 0.8, s * 0.4, 0.16);
    // Roof plant and bar armour.
    b.use(k.dmetal);
    b.vents(-s * 0.12, 11.0, s * 0.2, s * 0.5, s * 0.3, 7);
    b.use(k.armour);
    for (let i = 0; i < 5; i++) {
      b.box(-s * 0.12, 3.0 + i * 1.7, s * 0.44, s * 0.7, 0.3, 0.34, 0.07);
    }
    if (detail > 0) {
      b.ladder(-s * 0.42, 1.0, s * 0.45, 9.0);
      b.railing(-s * 0.12, 10.9, s * 0.42, s * 0.66, 0.4, 1.0);
    }
    mast(b, k, -s * 0.4, 10.9, -s * 0.32, 11.0, 0.9, detail);
  }

  // Shared: loading bay, floodlights, team banner.
  b.use(k.dark);
  b.box(0, 2.2, s * 0.42, s * 0.36, 4.0, 1.0, 0.2);
  b.use(k.amber);
  for (const sx of [-1, 1]) b.box(sx * s * 0.2, 4.4, s * 0.44, 0.5, 0.5, 0.34, 0.1);
  banner(b, k, nod ? 0 : -s * 0.12, 7.4, s * 0.46, 3.4, 4.6, 1);
  if (detail > 0) {
    b.use(k.steel);
    for (const sx of [-1, 1]) b.pipe(sx * s * 0.3, 0.9, -s * 0.4, sx * s * 0.3, 6.5, -s * 0.4, 0.22, 8);
  }
}

/* ---- power plant ---- */

function power(c: Ctx): void {
  const { b, k, s, nod, detail } = c;
  c.def.height = 17;
  c.def.riseDepth = 16;

  b.use(k.wall);
  b.box(0, 3.0, s * 0.18, s * 0.78, 5.0, s * 0.48, 0.28);
  b.use(k.wall2);
  b.box(0, 5.8, s * 0.18, s * 0.82, 0.9, s * 0.52, 0.18);

  if (nod) {
    // A slotted reactor core over a heat trench.
    b.use(k.dark);
    b.prismY(ngon(s * 0.3, 6, 0) as Vec2[], 9.0, 0.35, 0, 5.0, -s * 0.2);
    b.use(k.metal);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.box(Math.cos(a) * s * 0.29, 5.0, -s * 0.2 + Math.sin(a) * s * 0.29, 0.4, 8.0, 0.4, 0.09);
    }
    b.use(k.glow);
    for (let i = 0; i < 3; i++) {
      b.prismY(ngon(s * 0.31, 6, 0) as Vec2[], 0.42, 0.08, 0, 3.2 + i * 2.6, -s * 0.2);
    }
    b.use(k.dmetal);
    b.prismY(ngon(s * 0.34, 6, 0) as Vec2[], 1.0, 0.2, 0, 9.8, -s * 0.2);
    b.use(k.steel);
    b.tube(0, 12.0, -s * 0.2, 0.5, 1.1, 3.4, detail > 0 ? 10 : 6);
    b.use(k.glow);
    b.dome(0, 13.6, -s * 0.2, 0.85, 8, 3, 1.1);
  } else {
    // Twin cooling towers with a transformer yard.
    for (const sx of [-1, 1]) {
      b.use(k.concrete);
      b.push();
      b.move(sx * s * 0.24, 0, -s * 0.22);
      b.tube(0, 4.4, 0, s * 0.19, s * 0.23, 8.8, detail > 0 ? 14 : 8, false, false);
      b.tube(0, 9.4, 0, s * 0.23, s * 0.19, 1.6, detail > 0 ? 14 : 8, false, false);
      b.use(k.dmetal);
      b.tube(0, 10.3, 0, s * 0.23, s * 0.23, 0.32, detail > 0 ? 14 : 8, false, false);
      b.pop();
    }
    b.use(k.dmetal);
    for (const sx of [-1, 1]) {
      b.box(sx * s * 0.3, 2.2, s * 0.34, 1.7, 3.2, 1.7, 0.14);
      b.use(k.steel);
      b.tube(sx * s * 0.3, 4.3, s * 0.34, 0.16, 0.16, 1.6, 6);
      b.use(k.dmetal);
    }
    plumbing(b, k, -s * 0.24, -s * 0.05, s * 0.24, -s * 0.05, 6.6, 0.4);
  }

  b.use(k.dmetal);
  b.vents(0, 5.6, s * 0.34, s * 0.62, s * 0.2, 8);
  banner(b, k, 0, 3.2, s * 0.44, 2.4, 3.2, 1);
  if (detail > 0) {
    b.use(k.amber);
    for (const sx of [-1, 1]) b.box(sx * s * 0.36, 6.2, s * 0.3, 0.36, 0.36, 0.26, 0.08);
    b.use(k.steel);
    b.railing(0, 6.3, s * 0.38, s * 0.6, 0.3, 0.8);
  }
}

/* ---- refinery ---- */

function refinery(c: Ctx): void {
  const { b, k, s, nod, detail } = c;
  c.def.height = 20;
  c.def.riseDepth = 19;

  // Processing hall.
  b.use(k.wall);
  b.box(-s * 0.2, 4.2, -s * 0.06, s * 0.5, 7.4, s * 0.72, 0.32);
  b.use(k.wall2);
  b.box(-s * 0.2, 8.2, -s * 0.06, s * 0.54, 0.9, s * 0.76, 0.2);

  // Storage silo — the tall, unmistakable half of the silhouette.
  const sx0 = s * 0.24;
  b.use(k.metal);
  if (nod) {
    b.prismY(ngon(s * 0.24, 8, 0) as Vec2[], 12.0, 0.3, sx0, 6.6, -s * 0.08);
    b.use(k.dark);
    b.prismY(ngon(s * 0.26, 8, 0) as Vec2[], 1.1, 0.24, sx0, 12.9, -s * 0.08);
  } else {
    b.tube(sx0, 6.6, -s * 0.08, s * 0.24, s * 0.26, 12.0, detail > 0 ? 14 : 8);
    b.use(k.dark);
    b.dome(sx0, 12.5, -s * 0.08, s * 0.25, detail > 0 ? 14 : 8, 3, 0.5);
  }
  b.use(k.dmetal);
  for (let i = 0; i < 3; i++) {
    b.tube(sx0, 2.4 + i * 3.6, -s * 0.08, s * 0.26, s * 0.26, 0.4, detail > 0 ? 14 : 8);
  }
  if (detail > 0) b.ladder(sx0 + s * 0.24, 1.0, -s * 0.08, 11.5);

  // Docking bay: a ramped mouth on the +Z face for harvesters.
  b.use(k.concreteDark);
  b.box(-s * 0.1, 0.9, s * 0.42, s * 0.62, 1.5, s * 0.24, 0.14);
  b.use(k.dark);
  b.box(-s * 0.2, 3.4, s * 0.34, s * 0.44, 5.4, 0.5, 0.16);
  b.use(k.trim);
  for (let i = 0; i < 4; i++) b.decal(-s * 0.2 + (i - 1.5) * 1.5, 1.68, s * 0.42, 0.9, s * 0.2, 0);

  // Conveyor from the bay up into the silo.
  b.use(k.dmetal);
  b.push();
  b.move(s * 0.04, 7.2, s * 0.12);
  b.rotZ(0.62);
  b.box(0, 0, 0, 9.5, 1.0, 2.2, 0.16);
  b.pop();
  b.use(k.crystal);
  b.push();
  b.move(s * 0.04, 7.5, s * 0.12);
  b.rotZ(0.62);
  b.box(0, 0, 0, 8.4, 0.16, 1.5, 0.04);
  b.pop();

  // Flare stack and vents.
  stack(b, k, -s * 0.36, -s * 0.3, 8.0, 6.0, 0.55, detail);
  b.use(k.amber);
  b.dome(-s * 0.36, 14.2, -s * 0.3, 0.55, 8, 2, 1.4);
  b.use(k.dmetal);
  b.vents(-s * 0.2, 8.6, -s * 0.06, s * 0.4, s * 0.5, 7);
  if (detail > 0) plumbing(b, k, -s * 0.2, -s * 0.34, sx0, -s * 0.34, 5.4, 0.34);

  banner(b, k, -s * 0.42, 4.6, s * 0.1, 2.2, 3.0, 1);
}

/* ---- barracks ---- */

function barracks(c: Ctx): void {
  const { b, k, rig, def, riser, s, nod, detail } = c;
  def.height = 11;
  def.riseDepth = 10;

  b.use(k.wall);
  if (nod) {
    b.prismY(
      [[-s * 0.42, -s * 0.4], [s * 0.42, -s * 0.4], [s * 0.32, s * 0.42], [-s * 0.32, s * 0.42]] as Vec2[],
      5.6, 0.3, 0, 3.4, 0,
    );
    b.use(k.dark);
    b.push();
    b.move(0, 6.6, 0);
    b.prismY(
      [[-s * 0.3, -s * 0.3], [s * 0.3, -s * 0.3], [s * 0.2, s * 0.3], [-s * 0.2, s * 0.3]] as Vec2[],
      1.6, 0.24, 0, 0, 0,
    );
    b.pop();
  } else {
    b.box(0, 3.4, 0, s * 0.84, 5.6, s * 0.82, 0.3);
    b.use(k.wall2);
    b.box(0, 6.6, 0, s * 0.9, 1.0, s * 0.88, 0.2);
    b.use(k.dark);
    // Sawtooth roof lights.
    for (let i = 0; i < 3; i++) {
      b.push();
      b.move(0, 7.5, (i - 1) * s * 0.24);
      b.rotX(-0.5);
      b.prism(rect(s * 0.8, 1.5) as Vec2[], 0.3, 0.08);
      b.pop();
    }
  }

  // Sandbag revetment and drill markings.
  b.use(k.concreteDark);
  for (let i = 0; i < 6; i++) {
    const t = (i / 5 - 0.5) * s * 0.8;
    b.box(t, 1.2, -s * 0.5, s * 0.16, 1.1, 1.2, 0.2);
    if (detail > 0) b.box(t + s * 0.07, 2.1, -s * 0.5, s * 0.16, 0.9, 1.0, 0.2);
  }

  // Roller shutter on its own bone.
  const doorW = s * 0.34;
  const doorH = 4.4;
  const door = rig.add('door', riser, 0, doorH * 0.5 + 0.4, s * 0.41);
  def.door = { bone: door, travel: [0, doorH, 0], rate: 2.6 };
  b.use(k.dark);
  b.box(0, doorH * 0.5 + 0.4, s * 0.43, doorW + 1.4, doorH + 0.9, 0.55, 0.14);
  b.bone(door);
  b.push();
  b.move(0, doorH * 0.5 + 0.4, s * 0.41);
  b.use(k.dmetal);
  for (let i = 0; i < 7; i++) {
    b.box(0, (i / 6 - 0.5) * doorH, 0, doorW, doorH / 8, 0.4, 0.05);
  }
  b.pop();
  b.bone(riser);

  b.use(k.amber);
  for (const sx of [-1, 1]) b.box(sx * (doorW * 0.5 + 1.0), doorH + 1.1, s * 0.44, 0.34, 0.3, 0.24, 0.07);
  b.use(k.dmetal);
  b.vents(0, 7.2, -s * 0.24, s * 0.5, s * 0.2, 6);
  mast(b, k, -s * 0.38, 6.9, -s * 0.34, 6.0, 0.55, detail);
  banner(b, k, s * 0.36, 4.2, s * 0.44, 1.8, 3.4, 1);
  if (detail > 0) {
    b.use(k.trim);
    for (let i = 0; i < 3; i++) b.decal(0, 0.87, s * 0.56 + i * 1.6, doorW, 0.7, 0);
  }
}

/* ---- war factory ---- */

function factory(c: Ctx): void {
  const { b, k, rig, def, riser, s, nod, detail } = c;
  def.height = 14;
  def.riseDepth = 13;

  b.use(k.wall);
  b.box(0, 4.3, -s * 0.06, s * 0.86, 7.6, s * 0.76, 0.36);
  b.use(k.wall2);
  if (nod) {
    b.push();
    b.move(0, 8.6, -s * 0.06);
    b.prismY(trap(s * 0.9, s * 0.5, s * 0.8) as Vec2[], 1.6, 0.26, 0, 0, 0);
    b.pop();
  } else {
    // Barrel-vault roof over the assembly hall.
    b.push();
    b.move(0, 8.1, -s * 0.06);
    b.prism(ngon(s * 0.44, 10, Math.PI / 10).filter((p) => p[1] > -0.01) as Vec2[], s * 0.76, 0.2);
    b.pop();
  }

  // Gantry crane on rails across the roof.
  b.use(k.dmetal);
  for (const sx of [-1, 1]) b.box(sx * s * 0.44, 9.9, -s * 0.06, 0.4, 0.35, s * 0.8, 0.08);
  b.use(k.steel);
  b.box(0, 10.6, s * 0.14, s * 0.94, 0.5, 0.7, 0.1);
  b.use(k.amber);
  b.box(s * 0.3, 10.6, s * 0.14, 1.1, 0.8, 1.0, 0.16);
  if (detail > 0) {
    b.use(k.dmetal);
    b.box(0, 9.9, s * 0.14, 0.35, 1.0, 0.35, 0.07);
  }

  // Vehicle door: two shutter leaves parting sideways.
  const doorW = s * 0.44;
  const door = rig.add('door', riser, 0, 3.1, s * 0.4);
  def.door = { bone: door, travel: [0, 5.2, 0], rate: 2.2 };
  b.use(k.dark);
  b.box(0, 3.3, s * 0.42, doorW + 2.0, 6.4, 0.6, 0.16);
  b.bone(door);
  b.push();
  b.move(0, 3.1, s * 0.4);
  b.use(k.dmetal);
  for (let i = 0; i < 8; i++) b.box(0, (i / 7 - 0.5) * 5.0, 0, doorW, 0.5, 0.42, 0.06);
  b.use(k.trim);
  b.box(0, -2.4, 0.12, doorW, 0.35, 0.2, 0.05);
  b.pop();
  b.bone(riser);

  // Exhaust stacks, radiators, spare-track rack.
  for (const sx of [-1, 1]) stack(b, k, sx * s * 0.3, -s * 0.36, 8.2, 4.6, 0.5, detail);
  b.use(k.dmetal);
  b.vents(0, 8.0, -s * 0.34, s * 0.5, s * 0.16, 8);
  if (detail > 0) {
    b.use(k.rust);
    for (let i = 0; i < 4; i++) b.box(-s * 0.46, 2.0 + i * 0.55, s * 0.1, 0.4, 0.4, 2.6, 0.06);
  }
  b.use(k.amber);
  for (const sx of [-1, 1]) b.box(sx * (doorW * 0.5 + 1.4), 6.6, s * 0.44, 0.4, 0.34, 0.28, 0.08);
  banner(b, k, -s * 0.38, 5.0, s * 0.44, 2.0, 3.6, 1);
  if (detail > 0) {
    b.use(k.trim);
    for (let i = 0; i < 4; i++) b.decal(0, 0.87, s * 0.58 + i * 2.0, doorW * 1.1, 0.9, 0);
  }
}

/* ---- gun turret ---- */

function turret(c: Ctx): void {
  const { b, k, rig, def, riser, s, nod, detail } = c;
  def.height = 8;
  def.riseDepth = 7;
  def.turretRate = 1.7;
  def.recoilTravel = 0.55;
  def.elevMin = -0.18;
  def.elevMax = 0.42;

  // Bunker.
  b.use(k.concrete);
  if (nod) {
    b.prismY(trap(s * 0.78, s * 0.5, s * 0.78) as Vec2[], 3.4, 0.3, 0, 2.3, 0);
  } else {
    b.prismY(rect(s * 0.76, s * 0.76) as Vec2[], 3.2, 0.3, 0, 2.2, 0);
    b.use(k.concreteDark);
    b.prismY(rect(s * 0.86, s * 0.86) as Vec2[], 0.8, 0.2, 0, 1.0, 0);
  }
  b.use(k.armour);
  for (const sx of [-1, 1]) {
    b.box(sx * s * 0.36, 2.4, 0, 0.5, 2.6, s * 0.5, 0.12);
  }
  b.use(k.dmetal);
  b.tube(0, 3.9, 0, s * 0.24, s * 0.28, 0.55, detail > 0 ? 14 : 8);
  b.use(k.team);
  b.box(0, 1.4, s * 0.4, s * 0.3, 0.5, 0.16, 0.05);
  if (detail > 0) {
    b.use(k.dmetal);
    b.rivets(-s * 0.3, 3.6, s * 0.36, s * 0.3, 3.6, s * 0.36, 6, 0.09);
    b.use(k.concreteDark);
    for (const sx of [-1, 1]) b.box(sx * s * 0.42, 1.2, -s * 0.36, 1.3, 1.6, 1.3, 0.2);
  }

  // Rotating housing.
  const tur = rig.add('turret', riser, 0, 4.4, 0);
  def.turret = tur;
  b.bone(tur);
  b.push();
  b.move(0, 4.4, 0);
  b.use(k.wall);
  const plan: Vec2[] = nod
    ? [[-1.9, -1.9], [1.9, -1.9], [1.5, 0.8], [0, 2.4], [-1.5, 0.8]]
    : [[-2.0, -2.0], [2.0, -2.0], [2.3, -0.4], [1.8, 1.9], [-1.8, 1.9], [-2.3, -0.4]];
  b.prismY(plan, 1.7, 0.24, 0, 0.85, 0);
  b.use(k.wall2);
  b.prismY(plan.map((p) => [p[0] * 0.7, p[1] * 0.7] as Vec2), 0.5, 0.14, 0, 1.85, 0);
  b.use(k.armour);
  b.push();
  b.move(0, 0.9, nod ? 2.0 : 1.7);
  b.prismY(trap(1.9, 1.4, 1.1), 1.5, 0.18, 0, 0, 0);
  b.pop();
  b.use(k.glass);
  b.box(nod ? 1.0 : -1.1, 1.5, 0.9, 0.7, 0.3, 0.24, 0.05);
  for (const sx of [-1, 1]) {
    b.use(k.team);
    b.push();
    b.move(sx * (nod ? 1.7 : 2.0), 1.0, -0.5);
    b.rotY(sx * Math.PI * 0.5);
    b.slab(0, 0, 0, 1.4, 0.5, 0.1);
    b.pop();
  }
  b.use(k.teamLight);
  b.box(0, 1.95, -1.4, 0.7, 0.14, 0.12, 0.03);
  if (detail > 0) {
    b.use(k.dmetal);
    b.tube(nod ? -1.2 : 1.2, 2.2, -1.0, 0.09, 0.09, 1.4, 5);
    b.use(k.amber);
    b.box(nod ? -1.2 : 1.2, 2.95, -1.0, 0.14, 0.14, 0.14, 0.04);
  }
  b.pop();

  const bar = rig.add('barrel', tur, 0, 0.95, nod ? 2.3 : 2.0);
  def.barrel = bar;
  def.muzzle = [0, 0, 5.6];
  b.bone(bar);
  b.push();
  b.move(0, 5.35, nod ? 2.3 : 2.0);
  b.use(k.dmetal);
  b.push();
  b.rotX(Math.PI / 2);
  b.tube(0, 2.7, 0, 0.24, 0.3, 5.4, detail > 0 ? 12 : 7);
  b.use(k.steel);
  b.tube(0, 5.2, 0, 0.44, 0.4, 0.5, detail > 0 ? 12 : 7);
  b.use(k.metal);
  b.tube(0, 1.3, 0, 0.5, 0.5, 1.0, detail > 0 ? 12 : 7);
  b.pop();
  b.pop();
  b.bone(riser);
}

/* ---- SAM nest ---- */

function sam(c: Ctx): void {
  const { b, k, rig, def, riser, s, nod, detail } = c;
  def.height = 8;
  def.riseDepth = 7;
  def.turretRate = 2.4;
  def.recoilTravel = 0.12;
  def.elevMin = 0.1;
  def.elevMax = 1.15;

  b.use(k.concrete);
  b.prismY(nod ? (ngon(s * 0.42, 6, 0) as Vec2[]) : rect(s * 0.72, s * 0.72), 2.8, 0.3, 0, 2.0, 0);
  b.use(k.concreteDark);
  b.prismY(nod ? (ngon(s * 0.5, 6, 0) as Vec2[]) : rect(s * 0.86, s * 0.86), 0.8, 0.2, 0, 1.0, 0);
  b.use(k.dmetal);
  b.tube(0, 3.5, 0, s * 0.22, s * 0.26, 0.6, detail > 0 ? 12 : 8);
  b.use(k.team);
  b.box(0, 1.6, s * 0.38, s * 0.28, 0.44, 0.16, 0.05);
  if (detail > 0) {
    b.use(k.metal);
    for (const sx of [-1, 1]) b.box(sx * s * 0.34, 1.9, -s * 0.3, 0.9, 1.4, 0.9, 0.14);
  }

  const tur = rig.add('turret', riser, 0, 4.0, 0);
  def.turret = tur;
  b.bone(tur);
  b.push();
  b.move(0, 4.0, 0);
  b.use(k.wall);
  b.prismY(ngon(1.75, nod ? 6 : 8, 0) as Vec2[], 1.1, 0.18, 0, 0.55, 0);
  b.use(k.wall2);
  b.box(0, 1.35, -0.6, 2.0, 0.7, 1.2, 0.14);
  b.use(k.dmetal);
  b.box(0, 1.5, -1.3, 1.0, 0.9, 0.5, 0.1);
  b.use(k.teamLight);
  b.box(0, 1.95, -1.3, 0.6, 0.12, 0.1, 0.03);
  for (const sx of [-1, 1]) {
    b.use(k.team);
    b.push();
    b.move(sx * 1.6, 0.6, 0);
    b.rotY(sx * Math.PI * 0.5);
    b.slab(0, 0, 0, 1.1, 0.4, 0.1);
    b.pop();
  }
  b.pop();

  // Elevating launcher rails.
  const bar = rig.add('barrel', tur, 0, 1.15, 0.1);
  def.barrel = bar;
  def.muzzle = [0, 0.4, 2.6];
  b.bone(bar);
  b.push();
  b.move(0, 5.15, 0.1);
  b.use(k.dark);
  b.box(0, 0, 0, 2.6, 0.6, 1.5, 0.12);
  for (const sx of [-1, 1]) {
    b.use(k.armour);
    b.box(sx * 0.95, 0.55, 0.2, 0.8, 0.8, 3.4, 0.14);
    b.use(k.metal);
    b.push();
    b.move(sx * 0.95, 0.55, 1.5);
    b.rotX(Math.PI / 2);
    b.tube(0, 0.2, 0, 0.3, 0.34, 1.4, detail > 0 ? 10 : 6);
    b.pop();
    b.use(k.trim);
    b.box(sx * 0.95, 0.55, 2.35, 0.42, 0.42, 0.3, 0.08);
    if (detail > 0) {
      b.use(k.dmetal);
      b.box(sx * 0.95, 1.02, 0.2, 0.5, 0.16, 3.0, 0.05);
    }
  }
  b.use(k.glow);
  for (const sx of [-1, 1]) b.slab(sx * 0.95, 0.55, -1.35, 0.6, 0.6, 0.05);
  b.pop();
  b.bone(riser);
}

/* ---- radar ---- */

function radar(c: Ctx): void {
  const { b, k, rig, def, riser, s, nod, detail } = c;
  def.height = 18;
  def.riseDepth = 15;

  b.use(k.wall);
  b.box(0, 3.0, s * 0.1, s * 0.7, 5.2, s * 0.6, 0.3);
  b.use(k.wall2);
  b.box(0, 6.0, s * 0.1, s * 0.74, 0.9, s * 0.64, 0.18);
  b.use(k.glass);
  b.box(0, 4.4, s * 0.42, s * 0.4, 1.2, 0.2, 0.06);
  b.use(k.dmetal);
  b.vents(0, 6.5, s * 0.1, s * 0.4, s * 0.3, 6);

  // Tower.
  if (nod) {
    b.use(k.dark);
    b.prismY(ngon(1.5, 6, 0) as Vec2[], 8.0, 0.28, 0, 8.4, -s * 0.16);
    b.use(k.metal);
    for (let i = 0; i < 3; i++) b.prismY(ngon(1.75, 6, 0) as Vec2[], 0.4, 0.1, 0, 6.2 + i * 2.6, -s * 0.16);
  } else {
    mast(b, k, 0, 5.6, -s * 0.16, 7.6, 1.4, detail);
    b.use(k.dmetal);
    b.tube(0, 9.4, -s * 0.16, 0.5, 0.7, 8.0, 8);
  }

  // Spinning dish assembly.
  const dish = rig.add('dish', riser, 0, 13.4, -s * 0.16);
  def.spinners.push({ bone: dish, rate: 0.85, axis: 'y' });
  b.bone(dish);
  b.push();
  b.move(0, 13.4, -s * 0.16);
  b.use(k.dmetal);
  b.box(0, 0.2, 0, 2.2, 0.9, 1.4, 0.16);
  b.use(k.metal);
  b.push();
  b.move(0, 1.5, 0.5);
  b.rotX(-0.62);
  if (nod) {
    // A flat phased-array panel rather than a dish.
    b.prism(rect(7.0, 4.2) as Vec2[], 0.35, 0.1);
    b.use(k.dark);
    b.prism(rect(6.2, 3.4) as Vec2[], 0.12, 0.05, 0, 0, 0.25);
    b.use(k.glow);
    for (let i = 0; i < 4; i++) b.slab((i - 1.5) * 1.5, 0, 0.34, 1.1, 3.0, 0.05);
  } else {
    b.prism(ngon(3.6, detail > 0 ? 14 : 8) as Vec2[], 0.4, 0.14);
    b.use(k.wall2);
    b.prism(ngon(3.2, detail > 0 ? 14 : 8) as Vec2[], 0.14, 0.06, 0, 0, 0.3);
    b.use(k.steel);
    b.push();
    b.rotX(Math.PI / 2);
    b.tube(0, 1.6, 0, 0.16, 0.16, 3.2, 6);
    b.use(k.dmetal);
    b.tube(0, 3.1, 0, 0.34, 0.24, 0.6, 8);
    b.pop();
  }
  b.pop();
  b.use(k.red);
  b.box(0, 0.9, -1.0, 0.3, 0.3, 0.3, 0.07);
  b.pop();
  b.bone(riser);

  banner(b, k, s * 0.3, 3.6, s * 0.42, 1.8, 3.0, 1);
  if (detail > 0) {
    b.use(k.steel);
    b.railing(0, 6.5, s * 0.32, s * 0.6, 0.3, 0.9);
    b.ladder(-s * 0.34, 1.0, s * 0.34, 5.4);
  }
}

/* ---- tech lab ---- */

function lab(c: Ctx): void {
  const { b, k, s, nod, detail } = c;
  c.def.height = 15;
  c.def.riseDepth = 13;

  b.use(k.wall);
  b.box(0, 3.4, 0, s * 0.72, 5.8, s * 0.72, 0.32);
  b.use(k.wall2);
  b.box(0, 6.5, 0, s * 0.78, 0.9, s * 0.78, 0.2);

  if (nod) {
    // Obelisk of dark glass over a crystal crucible.
    b.use(k.dark);
    b.push();
    b.move(0, 10.6, 0);
    b.prismY(trap(s * 0.4, s * 0.08, s * 0.4) as Vec2[], 7.4, 0.24, 0, 0, 0);
    b.pop();
    b.use(k.glow);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      b.box(Math.cos(a) * s * 0.17, 9.4, Math.sin(a) * s * 0.17, 0.3, 4.4, 0.3, 0.06);
    }
    b.use(k.crystal);
    b.dome(0, 14.6, 0, 1.1, 8, 3, 1.6);
  } else {
    // Containment sphere in a ring of coolant pipes.
    b.use(k.metal);
    b.dome(0, 6.9, 0, s * 0.3, detail > 0 ? 16 : 9, 5, 1.0);
    b.use(k.wall2);
    b.dome(0, 6.9, 0, s * 0.3, detail > 0 ? 16 : 9, 2, -1.0);
    b.use(k.dmetal);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      b.pipe(Math.cos(a) * s * 0.32, 1.2, Math.sin(a) * s * 0.32,
        Math.cos(a) * s * 0.2, 7.4, Math.sin(a) * s * 0.2, 0.32, 7);
    }
    b.use(k.glow);
    b.tube(0, 10.6, 0, 0.5, 0.5, 1.4, detail > 0 ? 12 : 7);
    b.use(k.steel);
    b.tube(0, 11.7, 0, 0.9, 0.6, 0.8, detail > 0 ? 12 : 7);
  }

  b.use(k.crystal);
  for (const sx of [-1, 1]) b.box(sx * s * 0.33, 4.6, s * 0.36, 0.5, 2.2, 0.3, 0.07);
  b.use(k.dmetal);
  b.vents(0, 6.9, -s * 0.3, s * 0.4, s * 0.14, 6);
  mast(b, k, s * 0.36, 6.8, -s * 0.34, 6.4, 0.5, detail);
  banner(b, k, -s * 0.3, 3.8, s * 0.38, 1.8, 3.0, 1);
  if (detail > 0) {
    b.use(k.amber);
    for (const sx of [-1, 1]) b.box(sx * s * 0.3, 7.2, s * 0.3, 0.3, 0.3, 0.24, 0.07);
  }
}

/* ------------------------------------------------------------------ entry */

const BUILDERS: Record<BuildingType, (c: Ctx) => unknown> = {
  hq, power, refinery, barracks, factory, turret, sam, radar, lab,
};

export function buildStructure(
  type: BuildingType,
  faction: Faction,
  detail: number,
  footprintWorld: number,
): StructureBuild {
  const c = begin(faction, footprintWorld, detail);
  BUILDERS[type](c);

  // Every structure sheds a roof panel as it takes damage; the bone is added
  // last so it is never a parent of anything.
  const panel = c.rig.add('panelA', c.riser, 0, c.def.height * 0.62, -footprintWorld * 0.18);
  c.def.panels.push(panel);
  c.b.bone(panel);
  c.b.push();
  c.b.move(0, c.def.height * 0.62, -footprintWorld * 0.18);
  c.b.use(c.k.wall2);
  c.b.box(0, 0, 0, footprintWorld * 0.3, 0.35, footprintWorld * 0.26, 0.08);
  c.b.pop();
  c.b.bone(c.riser);

  c.def.bones = c.rig.bones;
  return { builder: c.b, def: c.def };
}
