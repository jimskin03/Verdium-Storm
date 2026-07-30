import type { Faction, UnitType } from '@/entities/Types';
import { PALETTES, surf, type Palette } from '@/entities/materials/Surface';
import { PartBuilder, trap, type Vec2 } from './Kit';
import { emptyRig, RigBuilder, type RigDef } from './RigDef';
import type { VehicleBuild } from './Vehicles';

/**
 * Infantry are built as skinned figures with a proper bone hierarchy — pelvis,
 * spine, head, two arms and two legs — so they walk instead of sliding. A
 * sliding capsule is the single fastest way to make an RTS look like a demo.
 *
 * Everything is still one draw call: the limbs are rigidly bound plate, so the
 * whole soldier is one SkinnedMesh sharing the global entity material.
 */

const kitOf = (pal: Palette, faction: Faction) => ({
  fatigue: surf('fabric', { color: faction === 'gdi' ? 0x6b6a4a : 0x33343a }),
  fatigueDark: surf('fabric', { color: faction === 'gdi' ? 0x4b4a34 : 0x212227 }),
  armour: surf('paint', { color: pal.primary, roughness: 0.5 }),
  armourDark: surf('paintDark', { color: pal.dark }),
  helmet: surf('paint', { color: pal.secondary, roughness: 0.46 }),
  visor: surf('glass', { color: faction === 'gdi' ? 0x11333a : 0x2a0a08 }),
  gear: surf('paintDark', { color: 0x2c2e2c, uvScale: 0.8 }),
  metal: surf('darkMetal', { uvScale: 0.9 }),
  boots: surf('rubber', { uvScale: 1.0 }),
  skin: surf('skin'),
  team: surf('team', { uvScale: 0.9 }),
  teamLight: surf('team', { emissive: 4.5, uvScale: 0.9 }),
  glow: surf('lamp', { color: pal.glow, emissive: 4.0, uvScale: 1.0 }),
  amber: surf('lampAmber', { uvScale: 1.0 }),
});

type Kit = ReturnType<typeof kitOf>;

/** Weapon props. Each is authored in the right-hand bone's bind space. */
function rifle(b: PartBuilder, k: Kit, detail: number): void {
  b.use(k.gear);
  b.box(0, 0, 0.16, 0.09, 0.16, 0.86, 0.03);
  b.use(k.metal);
  b.box(0, 0.02, 0.62, 0.045, 0.05, 0.46, 0.015);
  b.use(k.gear);
  b.box(0, -0.13, -0.05, 0.08, 0.22, 0.2, 0.03);
  if (detail > 0) {
    b.use(k.metal);
    b.box(0, 0.11, 0.2, 0.05, 0.08, 0.3, 0.02);
    b.use(k.gear);
    b.box(0, -0.14, 0.3, 0.07, 0.18, 0.13, 0.03);
  }
}

function launcher(b: PartBuilder, k: Kit, detail: number): void {
  b.use(k.gear);
  b.push();
  b.rotX(Math.PI / 2);
  b.tube(0, 0.15, 0, 0.15, 0.15, 1.5, detail > 0 ? 10 : 6, false, false);
  b.pop();
  b.use(k.metal);
  b.box(0, 0.16, 0.2, 0.09, 0.12, 0.5, 0.03);
  b.use(k.armourDark);
  b.box(0, -0.14, 0.1, 0.08, 0.2, 0.18, 0.03);
  if (detail > 0) {
    b.use(k.metal);
    b.push();
    b.rotX(Math.PI / 2);
    b.tube(0, 0.86, 0, 0.2, 0.17, 0.14, 10, false, false);
    b.pop();
  }
}

function toolkit(b: PartBuilder, k: Kit, detail: number): void {
  b.use(k.amber);
  b.box(0, -0.18, 0.12, 0.26, 0.2, 0.4, 0.04);
  b.use(k.metal);
  b.box(0, -0.06, 0.12, 0.22, 0.05, 0.36, 0.02);
  if (detail > 0) {
    b.use(k.gear);
    b.box(0, -0.3, 0.12, 0.28, 0.06, 0.42, 0.02);
  }
}

/** Shared humanoid body; the loadout callback dresses it. */
function soldier(
  b: PartBuilder,
  faction: Faction,
  type: UnitType,
  detail: number,
): VehicleBuild {
  const pal = PALETTES[faction];
  const k = kitOf(pal, faction);
  const rig = new RigBuilder();
  const def = emptyRig('infantry');
  const nod = faction === 'nod';

  const root = rig.add('root', -1, 0, 0, 0);
  const hips = rig.add('hips', root, 0, 1.16, 0);
  const spine = rig.add('spine', hips, 0, 0.3, 0);
  const head = rig.add('head', spine, 0, 0.44, 0.02);
  def.hull = hips;
  def.spine = spine;
  def.head = head;
  def.height = 2.3;
  def.radius = 0.6;
  def.turretRate = 5.5;
  def.recoilTravel = 0.06;

  const shoulder: number[] = [];
  const elbow: number[] = [];
  for (const s of [-1, 1]) {
    const sh = rig.add(s < 0 ? 'shL' : 'shR', spine, s * 0.29, 0.31, 0);
    const el = rig.add(s < 0 ? 'elL' : 'elR', sh, 0, -0.36, 0);
    shoulder.push(sh);
    elbow.push(el);
    def.arms.push({ shoulder: sh, elbow: el, side: s, weapon: s > 0 });
  }
  for (const s of [-1, 1]) {
    const hp = rig.add(s < 0 ? 'hipL' : 'hipR', hips, s * 0.17, -0.06, 0);
    const kn = rig.add(s < 0 ? 'knL' : 'knR', hp, 0, -0.5, 0);
    const an = rig.add(s < 0 ? 'anL' : 'anR', kn, 0, -0.48, 0);
    def.legs.push({ hip: hp, knee: kn, ankle: an, side: s });
  }

  // ---- torso -------------------------------------------------------------
  b.bone(spine);
  b.use(k.fatigue);
  b.box(0, 1.6, 0, 0.5, 0.62, 0.31, 0.07);
  b.use(k.armour);
  // Plate carrier: front and back slabs with a shoulder yoke.
  b.push();
  b.move(0, 1.62, 0.17);
  b.rotX(0.06);
  b.prism(trap(0.48, 0.42, 0.56) as Vec2[], 0.1, 0.035);
  b.pop();
  b.push();
  b.move(0, 1.62, -0.17);
  b.prism(trap(0.46, 0.4, 0.54) as Vec2[], 0.09, 0.035);
  b.pop();
  b.use(k.armourDark);
  b.box(0, 1.88, 0, 0.46, 0.11, 0.36, 0.04);
  if (detail > 0) {
    b.use(k.gear);
    for (let i = 0; i < 3; i++) b.box(-0.12 + i * 0.12, 1.5, 0.24, 0.1, 0.16, 0.09, 0.025);
    b.use(k.metal);
    b.box(0, 1.36, 0, 0.5, 0.08, 0.34, 0.025);
  }
  // Backpack / radio.
  b.use(k.fatigueDark);
  b.box(0, 1.66, -0.28, 0.38, 0.5, 0.2, 0.05);
  if (detail > 0) {
    b.use(k.metal);
    b.tube(0.14, 2.06, -0.3, 0.012, 0.03, 0.6, 4);
    b.use(k.gear);
    b.box(0, 1.42, -0.3, 0.32, 0.16, 0.16, 0.04);
  }
  // Team colour: shoulder band + chest tab. Small but instantly legible.
  b.use(k.team);
  b.box(0, 1.76, 0.235, 0.17, 0.12, 0.06, 0.02);
  b.use(k.teamLight);
  b.box(0, 1.55, -0.385, 0.1, 0.07, 0.03, 0.012);

  // ---- head --------------------------------------------------------------
  b.bone(head);
  b.use(k.skin);
  b.box(0, 2.0, 0.01, 0.19, 0.22, 0.2, 0.05);
  b.use(k.helmet);
  if (nod) {
    // Angular hooded helmet with a full-face visor slit.
    b.push();
    b.move(0, 2.09, 0);
    b.prismY([[-0.15, -0.16], [0.15, -0.16], [0.12, 0.14], [0, 0.2], [-0.12, 0.14]] as Vec2[], 0.2, 0.045, 0, 0, 0);
    b.pop();
    b.use(k.visor);
    b.push();
    b.move(0, 2.03, 0.13);
    b.rotX(-0.25);
    b.prism(trap(0.24, 0.19, 0.13) as Vec2[], 0.05, 0.02);
    b.pop();
    b.use(k.glow);
    b.box(0, 2.03, 0.16, 0.15, 0.022, 0.03, 0.008);
  } else {
    b.dome(0, 2.05, 0, 0.155, 10, 3, 0.95);
    b.use(k.helmet);
    b.box(0, 2.03, 0.02, 0.3, 0.09, 0.31, 0.04);
    b.use(k.visor);
    b.box(0, 2.02, 0.15, 0.2, 0.07, 0.04, 0.015);
  }
  if (type === 'engineer') {
    b.use(k.amber);
    b.box(0, 2.1, 0.14, 0.09, 0.07, 0.06, 0.02);
  }
  b.use(k.team);
  b.box(0, 2.12, -0.01, 0.29, 0.035, 0.3, 0.012);

  // ---- arms --------------------------------------------------------------
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    b.bone(shoulder[i]);
    b.use(k.armour);
    b.box(s * 0.31, 1.86, 0, 0.19, 0.19, 0.24, 0.055);
    b.use(k.fatigue);
    b.box(s * 0.3, 1.65, 0, 0.15, 0.31, 0.16, 0.04);
    b.bone(elbow[i]);
    b.use(k.fatigue);
    b.box(s * 0.3, 1.32, 0.04, 0.13, 0.3, 0.15, 0.04);
    b.use(k.gear);
    b.box(s * 0.3, 1.14, 0.09, 0.12, 0.13, 0.15, 0.04);
  }

  // ---- legs --------------------------------------------------------------
  b.bone(hips);
  b.use(k.fatigueDark);
  b.box(0, 1.14, 0, 0.42, 0.24, 0.28, 0.06);
  b.use(k.gear);
  b.box(0, 1.2, 0, 0.46, 0.09, 0.3, 0.03);
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    const leg = def.legs[i];
    b.bone(leg.hip);
    b.use(k.fatigue);
    b.box(s * 0.17, 0.85, 0, 0.19, 0.44, 0.21, 0.05);
    if (detail > 0) {
      b.use(k.armour);
      b.box(s * 0.17, 0.86, 0.1, 0.17, 0.28, 0.06, 0.025);
    }
    b.bone(leg.knee);
    b.use(k.fatigue);
    b.box(s * 0.17, 0.38, 0, 0.16, 0.44, 0.19, 0.045);
    if (detail > 0) {
      b.use(k.armourDark);
      b.box(s * 0.17, 0.44, 0.09, 0.15, 0.24, 0.05, 0.02);
    }
    b.bone(leg.ankle);
    b.use(k.boots);
    b.box(s * 0.17, 0.09, 0.05, 0.18, 0.18, 0.34, 0.04);
  }

  // ---- loadout -----------------------------------------------------------
  const weaponBone = rig.add('weapon', elbow[1], 0.3, 1.14, 0.16);
  def.barrel = weaponBone;
  b.bone(weaponBone);
  b.push();
  b.move(0.3, 1.14, 0.16);
  if (type === 'rocketeer') {
    def.muzzle = [0, 0.15, 1.0];
    launcher(b, k, detail);
  } else if (type === 'engineer') {
    def.muzzle = [0, 0, 0.3];
    toolkit(b, k, detail);
  } else {
    def.muzzle = [0, 0.02, 0.85];
    rifle(b, k, detail);
  }
  b.pop();

  // Role-specific silhouette additions.
  b.bone(spine);
  if (type === 'rocketeer') {
    b.use(k.armourDark);
    b.box(-0.02, 1.78, -0.42, 0.4, 0.44, 0.16, 0.05);
    b.use(k.metal);
    for (const s of [-1, 1]) {
      b.push();
      b.move(s * 0.12, 1.78, -0.5);
      b.rotX(Math.PI / 2);
      b.tube(0, 0, 0, 0.09, 0.09, 0.5, 6, false, false);
      b.pop();
    }
    b.use(k.teamLight);
    b.box(0, 2.02, -0.42, 0.12, 0.05, 0.05, 0.015);
  } else if (type === 'engineer') {
    // High-visibility harness + welded frame pack.
    b.use(k.amber);
    b.box(0, 1.68, 0.235, 0.44, 0.07, 0.05, 0.02);
    b.box(0, 1.5, 0.235, 0.44, 0.07, 0.05, 0.02);
    b.use(k.metal);
    b.box(0, 1.7, -0.4, 0.44, 0.5, 0.1, 0.03);
    if (detail > 0) {
      b.use(k.gear);
      b.box(0.24, 1.5, -0.34, 0.14, 0.3, 0.16, 0.04);
      b.use(k.amber);
      b.box(-0.24, 1.86, -0.36, 0.1, 0.1, 0.1, 0.03);
    }
  } else if (detail > 0) {
    b.use(k.gear);
    b.box(-0.24, 1.44, -0.24, 0.16, 0.2, 0.14, 0.04);
  }

  return { builder: b, def };
}

export function buildInfantry(type: UnitType, faction: Faction, detail: number): VehicleBuild {
  const pal = PALETTES[faction];
  const b = new PartBuilder(surf('fabric', { color: pal.secondary }), detail);
  return soldier(b, faction, type, detail);
}
