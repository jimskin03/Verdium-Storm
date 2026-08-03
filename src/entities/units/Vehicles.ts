import type { Faction } from '@/entities/Types';
import { PALETTES, surf, type Palette } from '@/entities/materials/Surface';
import { ngon, PartBuilder, rect, trap, type Vec2 } from './Kit';
import { emptyRig, RigBuilder, TrackPath, type RigDef } from './RigDef';

/**
 * Vehicle geometry. Every chassis is built from chamfered plate so the
 * silhouette is broken by real bevels, then loaded with the greebles that make
 * a machine read as heavy: stowage bins, spare track links, tow shackles,
 * mudguards, grilles, sensor masts and running lights.
 *
 * GDI reads boxy and bolted — orthogonal plate, thick fenders, bar armour.
 * Nod reads predatory — trapezoids, forward-raked prows, sharp shoulder lines.
 */

export interface VehicleBuild {
  builder: PartBuilder;
  def: RigDef;
}

const T = (pal: Palette) => ({
  paint: surf('paint', { color: pal.primary }),
  paint2: surf('paint', { color: pal.secondary }),
  dark: surf('paintDark', { color: pal.dark }),
  armour: surf('armour', { color: pal.secondary }),
  trim: surf('paintTrim', { color: pal.accent }),
  metal: surf('metal', { color: pal.metal }),
  steel: surf('steel'),
  dmetal: surf('darkMetal'),
  rubber: surf('rubber'),
  tread: surf('tread'),
  glass: surf('glass'),
  team: surf('team'),
  teamLight: surf('team', { emissive: 5.5, roughness: 0.35 }),
  lamp: surf('lamp'),
  amber: surf('lampAmber'),
  glow: surf('lamp', { color: pal.glow, emissive: 4.0 }),
  rust: surf('rust'),
});

type Kit = ReturnType<typeof T>;

// --------------------------------------------------------------------- parts

interface TrackOpts {
  zRear: number;
  zFront: number;
  y: number;
  radius: number;
  width: number;
  x: number;
  links: number;
  wheels: number;
}

/**
 * One complete running gear: drive sprocket, idler, road wheels on visible
 * swing arms, return rollers and a closed loop of individually bonded track
 * plates. The plates walk the loop at runtime, which is what sells a tracked
 * vehicle in motion far better than a scrolling texture.
 */
function runningGear(
  b: PartBuilder,
  rig: RigBuilder,
  def: RigDef,
  parent: number,
  k: Kit,
  o: TrackOpts,
  detail: number,
): void {
  const path = new TrackPath(o.zRear, o.zFront, o.y, o.radius, detail > 0 ? 7 : 4);
  const linkBones: number[] = [];
  const p = { y: 0, z: 0, angle: 0 };

  // Track plates.
  b.use(k.tread);
  const linkLen = (path.total / o.links) * 1.06;
  for (let i = 0; i < o.links; i++) {
    path.at((i / o.links) * path.total, p);
    const bone = rig.add(`trk${o.x > 0 ? 'R' : 'L'}${i}`, parent, o.x, p.y, p.z, [p.angle, 0, 0]);
    linkBones.push(bone);
    b.bone(bone);
    b.push();
    b.move(o.x, p.y, p.z);
    b.rotX(p.angle);
    b.slab(0, 0, 0, o.width, 0.16, linkLen);
    b.slab(0, -0.13, 0, o.width * 0.34, 0.14, linkLen * 0.55);
    if (detail > 0) b.slab(0, 0.11, 0, o.width * 0.86, 0.08, linkLen * 0.3);
    b.pop();
  }
  def.tracks.push({ bones: linkBones, path, dir: 1 });
  b.bone(parent);

  // Sprocket, idler and road wheels.
  const wheelR = o.radius * 0.82;
  b.use(k.dmetal);
  for (const [z, r, name] of [
    [o.zFront, o.radius * 0.94, 'sprk'],
    [o.zRear, o.radius * 0.9, 'idlr'],
  ] as Array<[number, number, string]>) {
    const bone = rig.add(`${name}${o.x > 0 ? 'R' : 'L'}`, parent, o.x, o.y, z);
    def.wheels.push({ bone, radius: r });
    b.bone(bone);
    b.push();
    b.move(o.x, o.y, z);
    b.rotZ(Math.PI / 2);
    b.tube(0, 0, 0, r, r, o.width * 0.72, detail > 0 ? 12 : 8);
    b.use(k.metal);
    b.tube(0, 0, 0, r * 0.34, r * 0.34, o.width * 0.95, 8);
    if (detail > 0) {
      b.use(k.dmetal);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        b.slab(Math.cos(a) * r * 0.92, 0, Math.sin(a) * r * 0.92, 0.16, o.width * 0.8, 0.16);
      }
    }
    b.pop();
    b.use(k.dmetal);
  }

  b.use(k.rubber);
  for (let i = 0; i < o.wheels; i++) {
    const t = (i + 0.5) / o.wheels;
    const z = o.zRear + (o.zFront - o.zRear) * t;
    const bone = rig.add(`whl${o.x > 0 ? 'R' : 'L'}${i}`, parent, o.x, o.y, z);
    def.wheels.push({ bone, radius: wheelR });
    b.bone(bone);
    b.push();
    b.move(o.x, o.y, z);
    b.rotZ(Math.PI / 2);
    b.use(k.rubber);
    b.tube(0, 0, 0, wheelR, wheelR, o.width * 0.66, detail > 0 ? 11 : 7);
    b.use(k.metal);
    b.tube(0, 0, 0, wheelR * 0.45, wheelR * 0.45, o.width * 0.75, 7);
    b.pop();
    b.bone(parent);
    if (detail > 0) {
      // Swing arm back to the hull.
      b.use(k.dmetal);
      b.box(o.x - Math.sign(o.x) * o.width * 0.42, o.y + 0.25, z, 0.14, 0.5, 0.36, 0.04);
    }
  }
  b.bone(parent);

  if (detail > 0) {
    b.use(k.dmetal);
    for (let i = 0; i < 2; i++) {
      const z = o.zRear + (o.zFront - o.zRear) * (0.32 + i * 0.36);
      b.tube(o.x, o.y + o.radius * 0.86, z, o.radius * 0.3, o.radius * 0.3, o.width * 0.5, 8);
    }
  }
}

/** Steered/driven road wheel with a visible rim and tyre shoulder. */
function roadWheel(
  b: PartBuilder,
  rig: RigBuilder,
  def: RigDef,
  parent: number,
  k: Kit,
  x: number,
  y: number,
  z: number,
  r: number,
  w: number,
  steers: boolean,
  detail: number,
): void {
  const bone = rig.add(`w${x > 0 ? 'R' : 'L'}${z > 0 ? 'F' : 'B'}`, parent, x, y, z);
  def.wheels.push({ bone, radius: r, steers });
  b.bone(bone);
  b.push();
  b.move(x, y, z);
  b.rotZ(Math.PI / 2);
  b.use(k.rubber);
  b.tube(0, 0, 0, r, r, w, detail > 0 ? 14 : 8);
  b.tube(0, 0, 0, r * 0.93, r * 0.93, w * 1.16, detail > 0 ? 14 : 8);
  b.use(k.metal);
  b.tube(0, w * 0.1, 0, r * 0.56, r * 0.56, w * 1.02, detail > 0 ? 12 : 8);
  if (detail > 0) {
    b.use(k.dmetal);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.slab(Math.cos(a) * r * 0.36, w * 0.5, Math.sin(a) * r * 0.36, 0.15, 0.08, 0.15);
    }
  }
  b.pop();
  b.bone(parent);
}

/** Gun tube with fume extractor and a slotted muzzle brake. */
function gunBarrel(
  b: PartBuilder,
  k: Kit,
  len: number,
  r: number,
  brake: boolean,
  detail: number,
): void {
  b.push();
  b.rotX(Math.PI / 2);
  b.use(k.dmetal);
  b.tube(0, len * 0.5, 0, r * 0.86, r, len, detail > 0 ? 12 : 7);
  if (detail > 0) {
    b.use(k.metal);
    b.tube(0, len * 0.44, 0, r * 1.55, r * 1.55, len * 0.2, 12);
    b.use(k.dmetal);
  }
  if (brake) {
    b.use(k.steel);
    b.tube(0, len * 0.94, 0, r * 1.5, r * 1.45, len * 0.14, detail > 0 ? 12 : 7);
    if (detail > 0) {
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 1 : -1;
        b.slab(s * r * 1.5, len * 0.94, 0, r * 0.5, len * 0.07, r * 2.4);
      }
    }
  }
  b.pop();
}

/** Whip antenna — a tall thin spike that keeps a vehicle readable at distance. */
function antenna(b: PartBuilder, k: Kit, x: number, y: number, z: number, h: number, detail: number): void {
  if (detail < 1) return;
  b.use(k.dmetal);
  b.tube(x, y + h * 0.5, z, 0.02, 0.055, h, 5);
  b.use(k.amber);
  b.slab(x, y + h, z, 0.09, 0.09, 0.09);
}

/** Stowage: bins, jerry cans, rolled tarpaulin. Reads as a machine in service. */
function stowage(b: PartBuilder, k: Kit, x: number, y: number, z: number, detail: number): void {
  if (detail < 1) return;
  b.use(k.paint2);
  b.box(x, y, z, 0.7, 0.42, 1.1, 0.05);
  b.use(k.dmetal);
  b.box(x, y + 0.24, z, 0.6, 0.06, 0.95, 0.02);
  b.use(k.rust);
  b.box(x, y + 0.12, z - 0.72, 0.34, 0.62, 0.3, 0.05);
}

/** Team-colour chevron: three angled bars. Small, unmistakable, on both flanks. */
function chevron(b: PartBuilder, k: Kit, x: number, y: number, z: number, size: number, faceX: number): void {
  b.use(k.team);
  for (let i = 0; i < 3; i++) {
    const o = (i - 1) * size * 0.42;
    b.push();
    b.move(x + faceX * 0.02, y + o * 0.5, z + o);
    b.rotX(0.62);
    b.slab(0, 0, 0, 0.06, size * 0.26, size * 0.9);
    b.pop();
  }
}

// ------------------------------------------------------------------ chassis

function tank(b: PartBuilder, faction: Faction, detail: number): VehicleBuild {
  const pal = PALETTES[faction];
  const k = T(pal);
  const rig = new RigBuilder();
  const def = emptyRig('tracked');
  const root = rig.add('root', -1, 0, 0, 0);
  const hull = rig.add('hull', root, 0, 0, 0);
  def.hull = hull;
  def.height = 3.3;
  def.radius = 3.0;
  def.recoilTravel = 0.55;
  def.turretRate = 1.5;
  b.bone(hull);

  const nod = faction === 'nod';

  // Lower hull tub.
  b.use(k.armour);
  b.box(0, 1.05, -0.1, 4.5, 1.15, 7.4, 0.14);

  // Glacis and upper deck.
  b.push();
  b.move(0, 1.62, 3.05);
  b.rotX(nod ? -0.72 : -0.55);
  b.use(k.paint);
  b.prism(rect(4.5, nod ? 2.3 : 1.9), 0.34, 0.1);
  b.pop();

  b.use(k.paint);
  if (nod) {
    b.prismY(
      [
        [-2.25, -3.6], [2.25, -3.6], [2.25, 1.4], [1.5, 3.2], [-1.5, 3.2], [-2.25, 1.4],
      ] as Vec2[],
      0.95,
      0.14,
      0,
      2.1,
      0,
    );
  } else {
    b.box(0, 2.05, -0.5, 4.4, 0.9, 6.1, 0.13);
    b.box(0, 2.45, 1.9, 3.4, 0.35, 1.8, 0.1);
  }

  // Engine deck: raised louvred block at the rear.
  b.use(k.paint2);
  b.box(0, 2.6, -2.55, 3.5, 0.42, 2.1, 0.09);
  b.use(k.dmetal);
  b.vents(0, 2.84, -2.55, 3.1, 1.9, 7);
  if (detail > 0) {
    b.use(k.steel);
    b.tube(-1.5, 2.95, -3.5, 0.16, 0.2, 0.7, 8);
    b.tube(1.5, 2.95, -3.5, 0.16, 0.2, 0.7, 8);
  }

  // Side skirts and fenders.
  b.use(k.paint2);
  for (const s of [-1, 1]) {
    b.box(s * 2.42, 1.4, -0.2, 0.16, 1.35, 6.4, 0.05);
    b.box(s * 2.42, 2.42, 2.3, 0.2, 0.22, 2.0, 0.05);
    b.box(s * 2.42, 2.42, -2.8, 0.2, 0.22, 1.7, 0.05);
  }
  if (detail > 0) {
    b.use(k.dmetal);
    for (const s of [-1, 1]) b.rivets(s * 2.5, 2.05, -3.2, s * 2.5, 2.05, 2.9, 9, 0.06);
  }

  // Front detail: tow shackles, headlights, spare track links, splash guard.
  b.use(k.steel);
  for (const s of [-1, 1]) b.box(s * 1.5, 1.15, 3.75, 0.28, 0.3, 0.4, 0.06);
  b.use(k.dark);
  b.box(0, 2.32, 3.35, 2.2, 0.3, 0.24, 0.05);
  if (detail > 0) {
    b.use(k.tread);
    for (let i = 0; i < 4; i++) b.slab(-1.6 + i * 0.44, 2.5, 2.72, 0.38, 0.14, 0.5);
    b.use(k.lamp);
    for (const s of [-1, 1]) b.box(s * 1.85, 2.5, 3.15, 0.3, 0.24, 0.16, 0.04);
    b.use(k.dmetal);
    for (const s of [-1, 1]) b.box(s * 1.85, 2.5, 3.06, 0.4, 0.34, 0.1, 0.04);
  }

  // Running gear.
  for (const s of [-1, 1]) {
    runningGear(b, rig, def, hull, k, {
      zRear: -2.75, zFront: 2.8, y: 0.72, radius: 0.66, width: 0.86, x: s * 2.0,
      links: detail > 0 ? 13 : 8, wheels: 4,
    }, detail);
  }

  // Turret.
  const turret = rig.add('turret', hull, 0, 2.62, -0.1);
  def.turret = turret;
  def.elevMin = -0.16;
  def.elevMax = 0.34;
  b.bone(turret);
  // Turret parts are authored about the turret ring; the push puts that local
  // frame at the bone's bind position so the casting pivots where it should.
  b.push();
  b.move(...rig.world(turret));
  b.use(k.paint);
  const plan: Vec2[] = nod
    ? [[-1.75, -1.7], [1.75, -1.7], [1.45, 0.7], [0, 2.15], [-1.45, 0.7]]
    : [[-1.6, -1.85], [1.6, -1.85], [1.95, -0.5], [1.6, 1.55], [-1.6, 1.55], [-1.95, -0.5]];
  b.prismY(plan, 0.95, 0.16, 0, 0.5, 0);
  b.use(k.paint2);
  b.prismY(plan.map((p) => [p[0] * 0.78, p[1] * 0.8] as Vec2), 0.3, 0.09, 0, 1.1, 0.1);

  // Mantlet.
  b.use(k.armour);
  b.push();
  b.move(0, 0.52, nod ? 1.9 : 1.5);
  b.prismY(trap(1.5, 1.15, 1.0), 1.0, 0.14, 0, 0, 0);
  b.pop();

  // Turret greebles: cupola, hatches, smoke launchers, sight block.
  b.use(k.paint2);
  b.tube(nod ? 0.75 : -0.8, 1.18, -0.45, 0.5, 0.55, 0.42, detail > 0 ? 12 : 8);
  b.use(k.dark);
  b.tube(nod ? 0.75 : -0.8, 1.42, -0.45, 0.46, 0.5, 0.1, detail > 0 ? 12 : 8);
  b.use(k.glass);
  b.box(nod ? -0.85 : 0.85, 1.05, 0.85, 0.5, 0.24, 0.2, 0.04);
  if (detail > 0) {
    b.use(k.dmetal);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        b.push();
        b.move(s * (1.25 + i * 0.02), 0.95, -0.5 - i * 0.3);
        b.rotZ(s * -0.5);
        b.tube(0, 0, 0, 0.11, 0.11, 0.42, 6);
        b.pop();
      }
    }
    b.use(k.steel);
    b.box(0, 1.32, -1.2, 1.0, 0.14, 0.5, 0.03);
    b.use(k.metal);
    b.tube(nod ? 0.75 : -0.8, 1.6, -0.2, 0.05, 0.05, 0.8, 6);
    b.use(k.paint2);
    b.box(nod ? 0.75 : -0.8, 1.62, 0.2, 0.14, 0.12, 0.9, 0.03);
  }

  // Team colour: turret flank chevrons plus a running light on the bustle.
  for (const s of [-1, 1]) chevron(b, k, s * (nod ? 1.5 : 1.8), 0.75, -0.5, 0.62, s);
  b.use(k.teamLight);
  b.box(0, 1.36, -1.62, 0.5, 0.12, 0.1, 0.03);

  antenna(b, k, nod ? -1.3 : 1.3, 1.3, -1.4, 1.9, detail);
  b.pop();

  // Barrel.
  const barrel = rig.add('barrel', turret, 0, 0.55, nod ? 2.25 : 1.85);
  def.barrel = barrel;
  def.muzzle = [0, 0, nod ? 4.7 : 4.3];
  b.bone(barrel);
  b.push();
  b.move(...rig.world(barrel));
  gunBarrel(b, k, nod ? 4.6 : 4.2, 0.2, true, detail);
  b.pop();

  b.bone(hull);
  stowage(b, k, nod ? -1.55 : 1.55, 2.65, -2.0, detail);

  // Blow-off panel: the engine deck hatch swings loose as damage mounts.
  const panel = rig.add('panelA', hull, 0, 2.85, -1.55);
  def.panels.push(panel);
  b.bone(panel);
  b.push();
  b.move(...rig.world(panel));
  b.use(k.paint2);
  b.box(0, 0.05, -0.5, 2.6, 0.14, 1.0, 0.04);
  b.pop();
  b.bone(hull);

  // The runtime skeleton is instantiated from this table, so it has to travel
  // with the definition rather than staying local to the builder.
  def.bones = rig.bones;
  return { builder: b, def };
}

function artillery(b: PartBuilder, faction: Faction, detail: number): VehicleBuild {
  const pal = PALETTES[faction];
  const k = T(pal);
  const rig = new RigBuilder();
  const def = emptyRig('tracked');
  const root = rig.add('root', -1, 0, 0, 0);
  const hull = rig.add('hull', root, 0, 0, 0);
  def.hull = hull;
  def.height = 3.6;
  def.radius = 3.2;
  def.recoilTravel = 1.15;
  def.turretRate = 0.9;
  b.bone(hull);
  const nod = faction === 'nod';

  b.use(k.armour);
  b.box(0, 1.0, -0.2, 4.2, 1.1, 7.0, 0.14);
  b.use(k.paint);
  b.box(0, 1.85, -1.1, 4.1, 0.7, 4.6, 0.12);
  // Casemate: low, wide, unmistakably not a tank turret.
  b.prismY(trap(4.0, 3.0, 3.2) as Vec2[], 1.0, 0.14, 0, 2.2, -1.3);
  b.use(k.paint2);
  b.box(0, 2.42, 1.9, 3.2, 0.5, 2.6, 0.1);

  // Rear recoil spades — the artillery tell.
  b.use(k.steel);
  for (const s of [-1, 1]) {
    b.push();
    b.move(s * 1.4, 1.05, -3.75);
    b.rotX(-0.55);
    b.prism(trap(1.1, 0.7, 1.7) as Vec2[], 0.16, 0.05);
    b.pop();
    b.use(k.dmetal);
    b.box(s * 1.4, 1.65, -3.25, 0.2, 0.2, 1.1, 0.04);
    b.use(k.steel);
  }
  b.use(k.dmetal);
  b.vents(0, 2.14, 2.4, 2.8, 1.6, 6);

  for (const s of [-1, 1]) {
    runningGear(b, rig, def, hull, k, {
      zRear: -2.5, zFront: 2.7, y: 0.7, radius: 0.62, width: 0.78, x: s * 1.9,
      links: detail > 0 ? 12 : 8, wheels: 4,
    }, detail);
  }

  const turret = rig.add('turret', hull, 0, 2.75, -1.1);
  def.turret = turret;
  def.elevMin = 0.06;
  def.elevMax = 0.92;
  b.bone(turret);
  b.push();
  b.move(...rig.world(turret));
  b.use(k.paint2);
  b.prismY(trap(2.4, 1.5, 2.2) as Vec2[], 0.9, 0.12, 0, 0.35, 0);
  b.use(k.dmetal);
  for (const s of [-1, 1]) b.box(s * 0.95, 0.8, 0.55, 0.2, 0.9, 0.9, 0.05);
  for (const s of [-1, 1]) chevron(b, k, s * 1.1, 0.5, -0.5, 0.5, s);
  b.use(k.teamLight);
  b.box(0, 1.0, -1.0, 0.44, 0.1, 0.08, 0.02);
  antenna(b, k, 1.05, 0.8, -0.9, 2.1, detail);
  b.pop();

  // Cradle + very long tube.
  const barrel = rig.add('barrel', turret, 0, 0.85, 0.5);
  def.barrel = barrel;
  def.muzzle = [0, 0, nod ? 7.6 : 7.0];
  b.bone(barrel);
  b.push();
  b.move(...rig.world(barrel));
  b.use(k.dark);
  b.box(0, 0, 0.55, 0.9, 0.75, 2.0, 0.08);
  if (detail > 0) {
    b.use(k.steel);
    for (const s of [-1, 1]) b.tube(s * 0.5, 0.28, 1.4, 0.11, 0.11, 1.9, 7);
  }
  gunBarrel(b, k, nod ? 7.4 : 6.8, 0.19, true, detail);
  b.pop();
  b.bone(hull);

  const panel = rig.add('panelA', hull, 0, 2.7, 2.0);
  def.panels.push(panel);
  b.bone(panel);
  b.push();
  b.move(...rig.world(panel));
  b.use(k.paint2);
  b.box(0, 0.05, 0, 2.4, 0.14, 1.4, 0.04);
  b.pop();
  b.bone(hull);

  // The runtime skeleton is instantiated from this table, so it has to travel
  // with the definition rather than staying local to the builder.
  def.bones = rig.bones;
  return { builder: b, def };
}

function aa(b: PartBuilder, faction: Faction, detail: number): VehicleBuild {
  const pal = PALETTES[faction];
  const k = T(pal);
  const rig = new RigBuilder();
  const def = emptyRig('tracked');
  const root = rig.add('root', -1, 0, 0, 0);
  const hull = rig.add('hull', root, 0, 0, 0);
  def.hull = hull;
  def.height = 3.9;
  def.radius = 2.7;
  def.recoilTravel = 0.22;
  def.turretRate = 2.6;
  b.bone(hull);
  const nod = faction === 'nod';

  b.use(k.armour);
  b.box(0, 0.95, 0, 3.9, 1.05, 6.2, 0.13);
  b.use(k.paint);
  b.push();
  b.move(0, 1.5, 2.6);
  b.rotX(-0.5);
  b.prism(rect(3.9, 1.6), 0.3, 0.09);
  b.pop();
  b.box(0, 1.85, -0.4, 3.8, 0.8, 4.6, 0.12);
  b.use(k.paint2);
  b.box(0, 2.35, -2.1, 3.0, 0.4, 1.7, 0.09);
  b.use(k.dmetal);
  b.vents(0, 2.57, -2.1, 2.6, 1.5, 6);

  for (const s of [-1, 1]) {
    b.use(k.paint2);
    b.box(s * 2.1, 1.3, 0, 0.15, 1.15, 5.4, 0.05);
    runningGear(b, rig, def, hull, k, {
      zRear: -2.2, zFront: 2.35, y: 0.66, radius: 0.58, width: 0.74, x: s * 1.72,
      links: detail > 0 ? 11 : 7, wheels: 3,
    }, detail);
  }

  const turret = rig.add('turret', hull, 0, 2.3, -0.2);
  def.turret = turret;
  def.elevMin = -0.05;
  def.elevMax = 1.25;
  b.bone(turret);
  b.push();
  b.move(...rig.world(turret));

  if (nod) {
    // Nod: an angular boxed missile cell bank.
    b.use(k.paint);
    b.prismY(trap(2.4, 1.9, 1.9) as Vec2[], 0.55, 0.1, 0, 0.28, 0);
    b.use(k.dark);
    b.box(0, 0.85, 0.05, 2.3, 0.9, 1.5, 0.1);
  } else {
    b.use(k.paint);
    b.prismY(ngon(1.35, 8) as Vec2[], 0.62, 0.12, 0, 0.31, 0);
    b.use(k.paint2);
    b.prismY(ngon(1.0, 8) as Vec2[], 0.35, 0.08, 0, 0.78, 0);
  }
  b.pop();

  // Search radar — small, spinning, on a mast: the AA read.
  const dish = rig.add('radar', turret, nod ? -1.05 : 1.05, 1.0, -0.85);
  def.spinners.push({ bone: dish, rate: 2.2, axis: 'y' });
  b.bone(dish);
  b.push();
  b.move(...rig.world(dish));
  b.use(k.dmetal);
  b.tube(0, 0.3, 0, 0.09, 0.11, 0.6, 6);
  b.use(k.metal);
  b.push();
  b.move(0, 0.72, 0);
  b.rotX(-0.35);
  b.prism(trap(1.15, 0.5, 0.75) as Vec2[], 0.08, 0.03);
  b.pop();
  b.pop();

  b.bone(turret);
  b.push();
  b.move(...rig.world(turret));
  for (const s of [-1, 1]) chevron(b, k, s * (nod ? 1.2 : 1.3), 0.35, -0.35, 0.46, s);
  b.use(k.teamLight);
  b.box(0, 0.62, -1.15, 0.4, 0.1, 0.08, 0.02);
  b.pop();

  const barrel = rig.add('barrel', turret, 0, nod ? 0.85 : 0.62, 0.5);
  def.barrel = barrel;
  def.muzzle = [0, 0, nod ? 1.6 : 3.4];
  b.bone(barrel);
  b.push();
  b.move(...rig.world(barrel));
  if (nod) {
    // Four launch tubes in a 2x2 block.
    b.use(k.dark);
    b.box(0, 0, 0.1, 2.1, 0.95, 1.9, 0.09);
    b.use(k.dmetal);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        b.push();
        b.move(sx * 0.52, sy * 0.24, 1.0);
        b.rotX(Math.PI / 2);
        b.tube(0, 0.1, 0, 0.34, 0.34, 0.3, 8, false, true);
        b.pop();
      }
    b.use(k.glow);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) b.slab(sx * 0.52, sy * 0.24, 1.16, 0.4, 0.4, 0.03);
  } else {
    // Twin long autocannon.
    b.use(k.dark);
    b.box(0, 0, 0.15, 1.15, 0.55, 1.3, 0.07);
    for (const s of [-1, 1]) {
      b.push();
      b.move(s * 0.38, 0, 0);
      gunBarrel(b, k, 3.2, 0.11, true, detail);
      b.pop();
    }
  }
  b.bone(hull);
  antenna(b, k, -1.55, 2.3, -2.6, 1.8, detail);

  // The runtime skeleton is instantiated from this table, so it has to travel
  // with the definition rather than staying local to the builder.
  def.bones = rig.bones;
  return { builder: b, def };
}

function scout(b: PartBuilder, faction: Faction, detail: number): VehicleBuild {
  const pal = PALETTES[faction];
  const k = T(pal);
  const rig = new RigBuilder();
  const def = emptyRig('wheeled');
  const root = rig.add('root', -1, 0, 0, 0);
  const hull = rig.add('hull', root, 0, 0, 0);
  def.hull = hull;
  def.height = 2.5;
  def.radius = 1.9;
  def.recoilTravel = 0.1;
  def.turretRate = 3.4;
  b.bone(hull);
  const nod = faction === 'nod';

  // Low open-topped chassis on a visible tube frame.
  b.use(k.paint);
  b.box(0, 1.0, 0, 2.3, 0.55, 4.4, 0.09);
  b.push();
  b.move(0, 1.32, 1.9);
  b.rotX(nod ? -0.85 : -0.62);
  b.prism(trap(2.3, 1.7, 1.5) as Vec2[], 0.16, 0.06);
  b.pop();
  b.use(k.paint2);
  b.box(0, 1.42, -0.9, 2.1, 0.36, 2.0, 0.07);
  b.use(k.dark);
  b.box(0, 1.32, 0.55, 1.6, 0.3, 0.9, 0.06);
  b.use(k.glass);
  b.push();
  b.move(0, 1.62, 1.35);
  b.rotX(-0.5);
  b.prism(trap(1.9, 1.5, 0.85) as Vec2[], 0.07, 0.03);
  b.pop();

  // Roll cage.
  b.use(k.dmetal);
  for (const s of [-1, 1]) {
    b.tube(s * 1.0, 1.85, 0.6, 0.075, 0.075, 1.1, 6);
    b.tube(s * 1.0, 1.85, -1.7, 0.075, 0.075, 1.1, 6);
    b.box(s * 1.0, 2.36, -0.55, 0.14, 0.14, 2.4, 0.04);
  }
  b.box(0, 2.36, 0.6, 2.05, 0.14, 0.14, 0.04);
  b.box(0, 2.36, -1.7, 2.05, 0.14, 0.14, 0.04);

  // Fenders and bull bar.
  b.use(k.paint2);
  for (const s of [-1, 1]) {
    b.box(s * 1.28, 1.35, 1.45, 0.36, 0.16, 1.3, 0.05);
    b.box(s * 1.28, 1.35, -1.5, 0.36, 0.16, 1.3, 0.05);
  }
  b.use(k.steel);
  b.box(0, 1.0, 2.5, 1.9, 0.12, 0.12, 0.04);
  for (const s of [-1, 1]) b.box(s * 0.7, 1.22, 2.5, 0.12, 0.5, 0.12, 0.04);
  if (detail > 0) {
    b.use(k.lamp);
    for (const s of [-1, 1]) b.box(s * 0.8, 1.45, 2.42, 0.22, 0.2, 0.12, 0.04);
    b.use(k.tread);
    b.push();
    b.move(0, 1.72, -2.15);
    b.rotX(Math.PI / 2);
    b.tube(0, 0, 0, 0.62, 0.62, 0.28, 12);
    b.pop();
  }
  for (const s of [-1, 1]) chevron(b, k, s * 1.17, 1.05, -0.6, 0.42, s);
  b.use(k.teamLight);
  b.box(0, 2.42, -1.7, 0.34, 0.1, 0.08, 0.02);

  for (const s of [-1, 1]) {
    roadWheel(b, rig, def, hull, k, s * 1.28, 0.66, 1.5, 0.66, 0.44, true, detail);
    roadWheel(b, rig, def, hull, k, s * 1.28, 0.66, -1.5, 0.66, 0.44, false, detail);
  }

  // Ring-mounted machine gun.
  const turret = rig.add('turret', hull, 0, 1.78, -0.9);
  def.turret = turret;
  b.bone(turret);
  b.use(k.dmetal);
  b.tube(0, 0.05, 0, 0.42, 0.46, 0.16, 10);
  b.box(0, 0.3, 0, 0.4, 0.4, 0.4, 0.07);
  b.use(k.paint2);
  b.box(0, 0.55, -0.28, 0.85, 0.55, 0.14, 0.05);
  const barrel = rig.add('barrel', turret, 0, 0.42, 0.2);
  def.barrel = barrel;
  def.muzzle = [0, 0, 1.5];
  b.bone(barrel);
  b.use(k.dark);
  b.box(0, 0, 0.15, 0.24, 0.26, 0.7, 0.05);
  gunBarrel(b, k, 1.35, 0.075, false, detail);
  b.bone(hull);
  antenna(b, k, nod ? -0.95 : 0.95, 1.6, -2.0, 2.2, detail);

  // The runtime skeleton is instantiated from this table, so it has to travel
  // with the definition rather than staying local to the builder.
  def.bones = rig.bones;
  return { builder: b, def };
}

function harvester(b: PartBuilder, faction: Faction, detail: number): VehicleBuild {
  const pal = PALETTES[faction];
  const k = T(pal);
  const rig = new RigBuilder();
  const def = emptyRig('tracked');
  const root = rig.add('root', -1, 0, 0, 0);
  const hull = rig.add('hull', root, 0, 0, 0);
  def.hull = hull;
  def.height = 4.6;
  def.radius = 3.6;
  def.turretRate = 1.2;
  b.bone(hull);

  // Deep, heavy chassis.
  b.use(k.armour);
  b.box(0, 1.15, -0.4, 5.4, 1.4, 8.4, 0.16);
  b.use(k.paint);
  b.box(0, 2.2, -1.0, 5.2, 0.9, 6.6, 0.14);

  // The hopper: a huge ribbed tank that dominates the silhouette.
  b.use(k.paint2);
  b.prismY(trap(5.0, 4.2, 5.4) as Vec2[], 2.5, 0.2, 0, 3.9, -1.4);
  b.use(k.dmetal);
  if (detail > 0) {
    for (let i = 0; i < 4; i++) {
      b.box(0, 2.9 + i * 0.62, -1.4, 5.15, 0.14, 5.5, 0.04);
    }
  }
  b.use(k.rust);
  b.box(0, 5.2, -1.4, 4.0, 0.35, 4.4, 0.1);
  b.use(k.dmetal);
  b.vents(0, 5.42, -1.4, 3.4, 3.8, 6);

  // Cab, offset to one side and glazed — reads as a working machine.
  b.use(k.paint);
  b.box(-1.65, 3.55, 2.5, 1.9, 1.8, 2.0, 0.12);
  b.use(k.glass);
  b.box(-1.65, 3.9, 3.55, 1.6, 1.0, 0.14, 0.05);
  b.box(-2.62, 3.9, 2.5, 0.14, 1.0, 1.5, 0.05);
  b.use(k.dark);
  b.box(-1.65, 4.55, 2.5, 2.0, 0.18, 2.1, 0.06);

  // Intake head: a wide toothed scoop on an arm. Unmistakable.
  const head = rig.add('scoop', hull, 0, 1.5, 4.0);
  def.spinners.push({ bone: head, rate: 0, axis: 'x' });
  b.bone(head);
  b.use(k.steel);
  b.prismY(trap(5.6, 4.6, 1.9) as Vec2[], 1.1, 0.12, 0, 0.55, 0.2);
  b.use(k.dmetal);
  b.box(0, 1.25, 0.1, 4.6, 0.5, 1.4, 0.08);
  b.use(k.metal);
  for (let i = 0; i < 9; i++) {
    const x = (i / 8 - 0.5) * 5.0;
    b.push();
    b.move(x, 0.32, 1.05);
    b.rotX(0.35);
    b.prism([[-0.2, -0.36], [0.2, -0.36], [0, 0.5]] as Vec2[], 0.4, 0.04);
    b.pop();
  }
  b.bone(hull);

  // Boom conveyor from the head up to the hopper.
  b.use(k.dmetal);
  b.push();
  b.move(0, 3.0, 2.0);
  b.rotX(0.62);
  b.box(0, 0, 0, 1.5, 0.55, 3.6, 0.08);
  b.pop();

  b.use(k.amber);
  for (const s of [-1, 1]) b.box(s * 2.2, 5.45, 0.9, 0.3, 0.22, 0.3, 0.05);
  b.use(k.teamLight);
  b.box(0, 5.3, -4.1, 1.4, 0.16, 0.1, 0.04);
  for (const s of [-1, 1]) chevron(b, k, s * 2.55, 3.6, -1.4, 0.9, s);

  for (const s of [-1, 1]) {
    b.use(k.paint2);
    b.box(s * 2.75, 1.5, -0.4, 0.18, 1.5, 7.6, 0.06);
    runningGear(b, rig, def, hull, k, {
      zRear: -3.3, zFront: 3.1, y: 0.82, radius: 0.78, width: 1.0, x: s * 2.3,
      links: detail > 0 ? 14 : 9, wheels: 5,
    }, detail);
  }

  antenna(b, k, 1.9, 5.4, -3.4, 2.4, detail);
  // The runtime skeleton is instantiated from this table, so it has to travel
  // with the definition rather than staying local to the builder.
  def.bones = rig.bones;
  return { builder: b, def };
}

export function buildVehicle(
  type: 'tank' | 'artillery' | 'aa' | 'scout' | 'harvester',
  faction: Faction,
  detail: number,
): VehicleBuild {
  const pal = PALETTES[faction];
  const b = new PartBuilder(surf('paint', { color: pal.primary }), detail);
  switch (type) {
    case 'tank':
      return tank(b, faction, detail);
    case 'artillery':
      return artillery(b, faction, detail);
    case 'aa':
      return aa(b, faction, detail);
    case 'scout':
      return scout(b, faction, detail);
    default:
      return harvester(b, faction, detail);
  }
}
