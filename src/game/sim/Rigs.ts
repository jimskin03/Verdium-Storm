import * as THREE from 'three';
import {
  TEAM_COLORS,
  type BuildingRig,
  type BuildingType,
  type DamageState,
  type Faction,
  type ModelCatalog,
  type Team,
  type UnitRig,
  type UnitType,
} from '@/entities/Types';

/**
 * Fallback mesh factory. The model stream owns the real catalogue; until it
 * registers, the simulation still needs something of the correct size, with a
 * working turret pivot and muzzle point, so the game is playable and legible.
 *
 * Everything here is instanced: one InstancedMesh per (archetype, team) for the
 * body and one for the turret. A two-hundred unit battle therefore costs on the
 * order of thirty draw calls rather than a thousand. Part colours are baked
 * into vertex colours at build time so a single material covers every piece.
 */

const MAX_PER_GROUP = 220;

/* ---------- geometry assembly ---------- */

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  sx?: number; sy?: number; sz?: number;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const CONE = new THREE.ConeGeometry(0.5, 1, 12);
const SPH = new THREE.SphereGeometry(0.5, 12, 8);

const tmpMat = new THREE.Matrix4();
const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

/** Bakes a part list into one non-indexed geometry with vertex colours. */
function mergeParts(parts: Part[]): THREE.BufferGeometry {
  let total = 0;
  const sources: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    sources.push(g);
    total += g.attributes.position.count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);

  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const g = sources[i];
    const src = g.attributes.position as THREE.BufferAttribute;
    const srcN = g.attributes.normal as THREE.BufferAttribute;
    tmpEuler.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
    tmpQuat.setFromEuler(tmpEuler);
    tmpVec.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    tmpScale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
    tmpMat.compose(tmpVec, tmpQuat, tmpScale);
    const nm = new THREE.Matrix3().getNormalMatrix(tmpMat);
    tmpColor.setHex(p.color).convertSRGBToLinear();

    for (let v = 0; v < src.count; v++) {
      tmpVec.set(src.getX(v), src.getY(v), src.getZ(v)).applyMatrix4(tmpMat);
      const o = (offset + v) * 3;
      position[o] = tmpVec.x;
      position[o + 1] = tmpVec.y;
      position[o + 2] = tmpVec.z;
      tmpVec.set(srcN.getX(v), srcN.getY(v), srcN.getZ(v)).applyMatrix3(nm).normalize();
      normal[o] = tmpVec.x;
      normal[o + 1] = tmpVec.y;
      normal[o + 2] = tmpVec.z;
      color[o] = tmpColor.r;
      color[o + 1] = tmpColor.g;
      color[o + 2] = tmpColor.b;
    }
    offset += src.count;
    if (g !== p.geo) g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}

/* ---------- palette ---------- */

interface Palette {
  hull: number;
  hullDark: number;
  metal: number;
  track: number;
  glass: number;
  team: number;
  concrete: number;
  concreteDark: number;
}

function paletteFor(faction: Faction, team: Team): Palette {
  const teamHex = TEAM_COLORS[team];
  return faction === 'gdi'
    ? {
        hull: 0x9a9781, hullDark: 0x6d6b59, metal: 0x8f9298, track: 0x2a2926,
        glass: 0x1d2b33, team: teamHex, concrete: 0x9d9a8d, concreteDark: 0x6a6860,
      }
    : {
        hull: 0x54514c, hullDark: 0x393733, metal: 0x7d7a75, track: 0x232120,
        glass: 0x2b1a18, team: teamHex, concrete: 0x63605a, concreteDark: 0x413f3b,
      };
}

/* ---------- archetype builders ---------- */

interface Archetype {
  body: THREE.BufferGeometry;
  turret: THREE.BufferGeometry | null;
  /** Local pivot height of the turret above the root. */
  turretY: number;
  /** Muzzle offset in turret space. */
  muzzle: THREE.Vector3;
  /** Half-height used to lift the mesh clear of the ground. */
  lift: number;
  wheels: boolean;
  legs: boolean;
}

function trackedChassis(p: Palette, w: number, h: number, l: number, out: Part[]): void {
  out.push({ geo: BOX, color: p.track, sx: w * 0.34, sy: h * 0.72, sz: l * 1.02, x: -w * 0.44, y: h * 0.38 });
  out.push({ geo: BOX, color: p.track, sx: w * 0.34, sy: h * 0.72, sz: l * 1.02, x: w * 0.44, y: h * 0.38 });
  out.push({ geo: BOX, color: p.hull, sx: w, sy: h, sz: l, y: h * 0.55 + 0.18 });
  out.push({ geo: BOX, color: p.hullDark, sx: w * 0.88, sy: h * 0.34, sz: l * 0.66, y: h * 1.12 + 0.18 });
  // Team stripes along the sponsons, readable from the RTS camera.
  out.push({ geo: BOX, color: p.team, sx: w * 1.02, sy: h * 0.16, sz: l * 0.3, y: h * 0.9, z: -l * 0.18 });
}

function wheeledChassis(p: Palette, w: number, h: number, l: number, pairs: number, out: Part[]): void {
  const r = h * 0.55;
  for (let i = 0; i < pairs; i++) {
    const z = -l * 0.34 + (l * 0.68 * i) / Math.max(1, pairs - 1);
    for (const s of [-1, 1]) {
      out.push({
        geo: CYL, color: p.track, sx: r * 2, sy: w * 0.16, sz: r * 2,
        x: s * w * 0.5, y: r, z, rz: Math.PI / 2,
      });
    }
  }
  out.push({ geo: BOX, color: p.hull, sx: w, sy: h, sz: l, y: h * 0.62 + r * 0.5 });
  out.push({ geo: BOX, color: p.glass, sx: w * 0.62, sy: h * 0.42, sz: l * 0.24, y: h * 1.1 + r * 0.5, z: l * 0.16 });
  out.push({ geo: BOX, color: p.team, sx: w * 1.03, sy: h * 0.2, sz: l * 0.24, y: h * 0.75 + r * 0.5, z: -l * 0.24 });
}

function buildUnitArchetype(type: UnitType, p: Palette): Archetype {
  const body: Part[] = [];
  let turret: Part[] | null = null;
  let turretY = 0;
  const muzzle = new THREE.Vector3();

  switch (type) {
    case 'rifleman':
    case 'rocketeer':
    case 'engineer': {
      const coat = type === 'engineer' ? p.team : p.hullDark;
      body.push({ geo: BOX, color: p.hullDark, sx: 0.52, sy: 1.35, sz: 0.46, x: -0.26, y: 0.68 });
      body.push({ geo: BOX, color: p.hullDark, sx: 0.52, sy: 1.35, sz: 0.46, x: 0.26, y: 0.68 });
      body.push({ geo: BOX, color: coat, sx: 1.12, sy: 1.3, sz: 0.74, y: 2.0 });
      body.push({ geo: BOX, color: p.team, sx: 1.16, sy: 0.26, sz: 0.78, y: 2.2 });
      body.push({ geo: SPH, color: p.metal, sx: 0.62, sy: 0.62, sz: 0.7, y: 2.86 });
      if (type === 'rocketeer') {
        body.push({ geo: BOX, color: p.metal, sx: 0.3, sy: 0.3, sz: 2.1, x: 0.4, y: 2.42, z: 0.42 });
        body.push({ geo: BOX, color: p.hullDark, sx: 0.7, sy: 0.7, sz: 0.9, x: -0.05, y: 2.5, z: -0.5 });
      } else if (type === 'rifleman') {
        body.push({ geo: BOX, color: p.metal, sx: 0.16, sy: 0.18, sz: 1.5, x: 0.42, y: 2.1, z: 0.5 });
        body.push({ geo: BOX, color: p.hullDark, sx: 0.66, sy: 0.62, sz: 0.34, y: 2.05, z: -0.52 });
      } else {
        body.push({ geo: BOX, color: p.metal, sx: 0.66, sy: 0.5, sz: 0.4, x: 0.5, y: 1.6, z: 0.2 });
      }
      muzzle.set(0.42, 2.1, 1.4);
      return {
        body: mergeParts(body), turret: null, turretY: 0, muzzle, lift: 0, wheels: false, legs: true,
      };
    }

    case 'scout': {
      wheeledChassis(p, 4.0, 1.5, 6.0, 2, body);
      turret = [
        { geo: BOX, color: p.metal, sx: 1.5, sy: 0.7, sz: 1.5 },
        { geo: CYL, color: p.metal, sx: 0.26, sy: 2.6, sz: 0.26, z: 1.2, rx: Math.PI / 2 },
      ];
      turretY = 2.35;
      muzzle.set(0, 0, 2.5);
      break;
    }

    case 'tank': {
      trackedChassis(p, 5.6, 1.9, 8.4, body);
      turret = [
        { geo: CYL, color: p.hull, sx: 4.1, sy: 1.5, sz: 4.6 },
        { geo: BOX, color: p.hullDark, sx: 2.4, sy: 0.9, sz: 2.0, y: 0.9, z: -0.6 },
        { geo: BOX, color: p.team, sx: 4.2, sy: 0.22, sz: 1.0, y: 0.62, z: -1.2 },
        { geo: CYL, color: p.metal, sx: 0.62, sy: 5.4, sz: 0.62, z: 3.0, y: 0.1, rx: Math.PI / 2 },
        { geo: CYL, color: p.metal, sx: 0.9, sy: 1.0, sz: 0.9, z: 5.4, y: 0.1, rx: Math.PI / 2 },
      ];
      turretY = 2.5;
      muzzle.set(0, 0.1, 6.0);
      break;
    }

    case 'artillery': {
      trackedChassis(p, 5.2, 1.7, 7.6, body);
      turret = [
        { geo: BOX, color: p.hull, sx: 3.2, sy: 1.5, sz: 3.4 },
        { geo: BOX, color: p.hullDark, sx: 2.0, sy: 0.7, sz: 1.4, y: 0.9, z: -0.8 },
        { geo: CYL, color: p.metal, sx: 0.56, sy: 7.6, sz: 0.56, z: 3.4, y: 1.0, rx: Math.PI / 2 - 0.22 },
        { geo: BOX, color: p.team, sx: 3.3, sy: 0.24, sz: 0.9, y: 0.6, z: -1.4 },
      ];
      turretY = 2.35;
      muzzle.set(0, 2.6, 7.0);
      break;
    }

    case 'aa': {
      wheeledChassis(p, 4.4, 1.6, 6.4, 3, body);
      turret = [
        { geo: BOX, color: p.hull, sx: 2.6, sy: 1.2, sz: 2.6 },
        { geo: CYL, color: p.metal, sx: 0.22, sy: 3.4, sz: 0.22, x: -0.45, y: 0.5, z: 1.6, rx: Math.PI / 2 - 0.3 },
        { geo: CYL, color: p.metal, sx: 0.22, sy: 3.4, sz: 0.22, x: 0.45, y: 0.5, z: 1.6, rx: Math.PI / 2 - 0.3 },
        { geo: BOX, color: p.team, sx: 2.7, sy: 0.22, sz: 0.8, y: 0.5, z: -1.0 },
      ];
      turretY = 2.5;
      muzzle.set(0, 1.3, 3.2);
      break;
    }

    case 'harvester': {
      trackedChassis(p, 6.4, 2.6, 10.0, body);
      body.push({ geo: BOX, color: p.hullDark, sx: 5.6, sy: 2.4, sz: 4.4, y: 4.0, z: -1.6 });
      body.push({ geo: BOX, color: p.metal, sx: 6.8, sy: 2.2, sz: 2.6, y: 1.9, z: 5.4 });
      body.push({ geo: BOX, color: p.team, sx: 6.9, sy: 0.3, sz: 0.9, y: 3.1, z: 5.4 });
      body.push({ geo: BOX, color: p.glass, sx: 2.0, sy: 1.2, sz: 1.0, x: -2.0, y: 4.3, z: 1.6 });
      muzzle.set(0, 2, 5);
      return {
        body: mergeParts(body), turret: null, turretY: 0, muzzle, lift: 0, wheels: false, legs: false,
      };
    }
  }

  return {
    body: mergeParts(body),
    turret: turret ? mergeParts(turret) : null,
    turretY,
    muzzle,
    lift: 0,
    wheels: type === 'scout' || type === 'aa',
    legs: false,
  };
}

function buildBuildingArchetype(type: BuildingType, p: Palette, size: number): Archetype {
  const body: Part[] = [];
  let turret: Part[] | null = null;
  let turretY = 0;
  const muzzle = new THREE.Vector3();
  const s = size;

  // Every structure sits on a poured pad; it hides the terrain seam and gives
  // the silhouette a grounded base rather than a box floating on a slope.
  body.push({ geo: BOX, color: p.concreteDark, sx: s * 1.0, sy: 1.0, sz: s * 1.0, y: 0.3 });
  body.push({ geo: BOX, color: p.concrete, sx: s * 0.94, sy: 0.5, sz: s * 0.94, y: 0.85 });

  switch (type) {
    case 'hq':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.8, sy: 9, sz: s * 0.8, y: 5.5 });
      body.push({ geo: BOX, color: p.hullDark, sx: s * 0.48, sy: 5, sz: s * 0.48, y: 12.4 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.82, sy: 0.7, sz: s * 0.82, y: 10.1 });
      body.push({ geo: CYL, color: p.metal, sx: 0.8, sy: 8, sz: 0.8, y: 18.5 });
      body.push({ geo: SPH, color: p.team, sx: 1.6, sy: 1.6, sz: 1.6, y: 22.6 });
      body.push({ geo: BOX, color: p.concrete, sx: s * 0.34, sy: 1.2, sz: s * 0.34, x: s * 0.3, y: 1.6, z: s * 0.3 });
      break;
    case 'power':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.76, sy: 6, sz: s * 0.86, y: 4.1 });
      body.push({ geo: CYL, color: p.metal, sx: 4.2, sy: 7.5, sz: 4.2, x: -s * 0.22, y: 8.4 });
      body.push({ geo: CYL, color: p.metal, sx: 4.2, sy: 7.5, sz: 4.2, x: s * 0.22, y: 8.4 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.78, sy: 0.6, sz: s * 0.88, y: 6.8 });
      break;
    case 'refinery':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.66, sy: 8, sz: s * 0.8, x: -s * 0.14, y: 5.1 });
      body.push({ geo: CYL, color: p.metal, sx: 7, sy: 11, sz: 7, x: s * 0.28, y: 6.6 });
      body.push({ geo: CONE, color: p.hullDark, sx: 7.4, sy: 2.6, sz: 7.4, x: s * 0.28, y: 13.4 });
      body.push({ geo: BOX, color: p.concreteDark, sx: s * 0.5, sy: 0.8, sz: s * 0.42, y: 1.5, z: s * 0.34 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.68, sy: 0.7, sz: s * 0.82, x: -s * 0.14, y: 8.6 });
      break;
    case 'barracks':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.82, sy: 5.4, sz: s * 0.9, y: 3.8 });
      body.push({ geo: BOX, color: p.hullDark, sx: s * 0.9, sy: 1.2, sz: s * 0.98, y: 7.0 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.3, sy: 3.2, sz: 0.6, y: 2.7, z: s * 0.46 });
      break;
    case 'factory':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.88, sy: 7, sz: s * 0.86, y: 4.6 });
      body.push({ geo: BOX, color: p.hullDark, sx: s * 0.9, sy: 1.6, sz: s * 0.5, y: 8.6 });
      body.push({ geo: BOX, color: p.metal, sx: s * 0.44, sy: 4.6, sz: 0.8, y: 3.4, z: s * 0.44 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.9, sy: 0.7, sz: s * 0.88, y: 7.6 });
      body.push({ geo: CYL, color: p.metal, sx: 1.6, sy: 4, sz: 1.6, x: -s * 0.3, y: 10.0, z: -s * 0.3 });
      break;
    case 'turret':
      body.push({ geo: CYL, color: p.concrete, sx: s * 0.68, sy: 2.6, sz: s * 0.68, y: 2.2 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.7, sy: 0.4, sz: s * 0.7, y: 3.4 });
      turret = [
        { geo: BOX, color: p.hull, sx: 3.0, sy: 1.7, sz: 3.2 },
        { geo: CYL, color: p.metal, sx: 0.5, sy: 4.6, sz: 0.5, z: 2.4, rx: Math.PI / 2 },
      ];
      turretY = 4.3;
      muzzle.set(0, 0, 4.8);
      break;
    case 'sam':
      body.push({ geo: BOX, color: p.concrete, sx: s * 0.7, sy: 2.2, sz: s * 0.7, y: 2.0 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.72, sy: 0.4, sz: s * 0.72, y: 3.1 });
      turret = [
        { geo: BOX, color: p.hull, sx: 2.4, sy: 1.2, sz: 2.4 },
        { geo: BOX, color: p.metal, sx: 1.0, sy: 1.0, sz: 4.0, x: -0.8, y: 1.2, z: 0.6, rx: -0.6 },
        { geo: BOX, color: p.metal, sx: 1.0, sy: 1.0, sz: 4.0, x: 0.8, y: 1.2, z: 0.6, rx: -0.6 },
      ];
      turretY = 3.6;
      muzzle.set(0, 2.4, 2.2);
      break;
    case 'radar':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.66, sy: 5, sz: s * 0.66, y: 3.6 });
      body.push({ geo: CYL, color: p.metal, sx: 1.2, sy: 5, sz: 1.2, y: 8.4 });
      body.push({ geo: CONE, color: p.metal, sx: 9, sy: 3.4, sz: 9, y: 12.0, rx: 1.05 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.68, sy: 0.6, sz: s * 0.68, y: 6.2 });
      break;
    case 'lab':
      body.push({ geo: BOX, color: p.hull, sx: s * 0.74, sy: 6, sz: s * 0.74, y: 4.1 });
      body.push({ geo: SPH, color: p.metal, sx: 8, sy: 6, sz: 8, y: 7.4 });
      body.push({ geo: BOX, color: p.team, sx: s * 0.76, sy: 0.6, sz: s * 0.76, y: 6.7 });
      break;
  }

  return {
    body: mergeParts(body),
    turret: turret ? mergeParts(turret) : null,
    turretY,
    muzzle,
    lift: 0,
    wheels: false,
    legs: false,
  };
}

/* ---------- instanced groups ---------- */

class InstanceGroup {
  readonly bodyMesh: THREE.InstancedMesh;
  readonly turretMesh: THREE.InstancedMesh | null;
  readonly rigs: PlaceholderRig[] = [];

  constructor(arch: Archetype, material: THREE.Material, parent: THREE.Object3D) {
    this.bodyMesh = new THREE.InstancedMesh(arch.body, material, MAX_PER_GROUP);
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = true;
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.count = 0;
    parent.add(this.bodyMesh);

    if (arch.turret) {
      this.turretMesh = new THREE.InstancedMesh(arch.turret, material, MAX_PER_GROUP);
      this.turretMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.turretMesh.castShadow = true;
      this.turretMesh.receiveShadow = true;
      this.turretMesh.frustumCulled = false;
      this.turretMesh.count = 0;
      parent.add(this.turretMesh);
    } else {
      this.turretMesh = null;
    }
  }

  flush(): void {
    let n = 0;
    for (const rig of this.rigs) {
      if (!rig.root.visible) continue;
      const y = rig.root.position.y;
      rig.root.position.y = y + rig.renderYOffset;
      rig.root.updateMatrixWorld(true);
      rig.root.position.y = y;
      this.bodyMesh.setMatrixAt(n, rig.root.matrixWorld);
      if (this.turretMesh) this.turretMesh.setMatrixAt(n, rig.turret.matrixWorld);
      n++;
      if (n >= MAX_PER_GROUP) break;
    }
    this.bodyMesh.count = n;
    this.bodyMesh.visible = n > 0;
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    if (this.turretMesh) {
      this.turretMesh.count = n;
      this.turretMesh.visible = n > 0;
      this.turretMesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.bodyMesh.geometry.dispose();
    this.bodyMesh.removeFromParent();
    if (this.turretMesh) {
      this.turretMesh.geometry.dispose();
      this.turretMesh.removeFromParent();
    }
  }
}

const TURRET_RATE = 2.2;

class PlaceholderRig {
  readonly root = new THREE.Object3D();
  readonly turret = new THREE.Object3D();
  /** Vertical offset the instance flush adds: stride bob plus death slump. */
  renderYOffset = 0;

  private aimDelta = 0;
  private recoilAmount = 0;
  private phase = 0;
  private bob = 0;
  private deathDrop = 0;
  private dyingFor = -1;
  private readonly muzzleLocal: THREE.Vector3;
  private readonly hasTurret: boolean;
  private readonly walker: boolean;

  constructor(arch: Archetype, private group: InstanceGroup, private catalog: PlaceholderCatalog) {
    this.turret.position.y = arch.turretY;
    this.root.add(this.turret);
    this.muzzleLocal = arch.muzzle.clone();
    this.hasTurret = arch.turret !== null;
    this.walker = arch.legs;
    group.rigs.push(this);
  }

  private rootYaw(): number {
    this.root.updateMatrixWorld(true);
    tmpVec.set(0, 0, 1).transformDirection(this.root.matrixWorld);
    return Math.atan2(tmpVec.x, tmpVec.z);
  }

  aimAt(target: THREE.Vector3, dt: number): void {
    if (!this.hasTurret) return;
    const dx = target.x - this.root.position.x;
    const dz = target.z - this.root.position.z;
    let delta = Math.atan2(dx, dz) - this.rootYaw() - this.turret.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const step = TURRET_RATE * dt;
    const applied = Math.max(-step, Math.min(step, delta));
    this.turret.rotation.y += applied;
    this.aimDelta = delta - applied;
  }

  aimError(): number {
    return this.hasTurret ? Math.abs(this.aimDelta) : 0;
  }

  muzzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.root.updateMatrixWorld(true);
    const src = this.hasTurret ? this.turret : this.root;
    outPos.copy(this.muzzleLocal).applyMatrix4(src.matrixWorld);
    outDir.set(0, 0, 1).transformDirection(src.matrixWorld).normalize();
  }

  locomote(dt: number, speed: number, _turn: number): void {
    this.phase += speed * dt;
    // A gentle stride bob so infantry do not slide about like decals.
    this.bob = this.walker ? Math.abs(Math.sin(this.phase * 1.7)) * Math.min(0.3, speed * 0.035) : 0;
  }

  recoil(strength: number): void {
    this.recoilAmount = Math.min(1.2, this.recoilAmount + strength);
  }

  setDamageState(_state: DamageState): void {
    // Damage visuals belong to the real model catalogue; the simulation drives
    // smoke and scorch through the effects service instead.
  }

  setBuildProgress(t: number): void {
    const s = 0.08 + 0.92 * Math.min(1, Math.max(0, t));
    this.root.scale.set(1, s, 1);
  }

  setActive(_active: boolean): void {}

  die(): number {
    if (this.dyingFor < 0) this.dyingFor = 0;
    return this.walker ? 1.1 : 1.6;
  }

  /** Called by the catalogue each frame; drives the death slump. */
  tick(dt: number): void {
    this.recoilAmount *= Math.exp(-dt * 9);
    if (this.hasTurret) this.turret.position.z = -this.recoilAmount;
    if (this.dyingFor >= 0) {
      const span = this.walker ? 1.1 : 1.6;
      this.dyingFor += dt;
      const t = Math.min(1, this.dyingFor / span);
      this.root.rotation.z = (this.walker ? 1.5 : 0.34) * t;
      this.deathDrop = t * t * (this.walker ? 0.5 : 2.2);
    }
    this.renderYOffset = this.bob - this.deathDrop;
  }

  dispose(): void {
    const i = this.group.rigs.indexOf(this);
    if (i >= 0) this.group.rigs.splice(i, 1);
    this.catalog.forget(this);
  }
}

/**
 * Fallback catalogue. Mirrors the ModelCatalog contract so the simulation can
 * use whichever implementation is registered without branching.
 */
export class PlaceholderCatalog implements ModelCatalog {
  private readonly root = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly groups = new Map<string, InstanceGroup>();
  private readonly archetypes = new Map<string, Archetype>();
  private readonly all: PlaceholderRig[] = [];

  constructor(parent: THREE.Object3D, private buildingSize: (t: BuildingType) => number) {
    this.root.name = 'placeholder-models';
    parent.add(this.root);
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.66,
      metalness: 0.24,
      envMapIntensity: 1.0,
    });
  }

  createUnit(type: UnitType, faction: Faction, team: Team): UnitRig {
    const key = `u:${type}:${team}`;
    const group = this.groupFor(key, () => buildUnitArchetype(type, paletteFor(faction, team)));
    const rig = new PlaceholderRig(this.archetypes.get(key)!, group, this);
    this.all.push(rig);
    return rig as unknown as UnitRig;
  }

  createBuilding(type: BuildingType, faction: Faction, team: Team): BuildingRig {
    const key = `b:${type}:${team}`;
    const group = this.groupFor(key, () =>
      buildBuildingArchetype(type, paletteFor(faction, team), this.buildingSize(type)),
    );
    const rig = new PlaceholderRig(this.archetypes.get(key)!, group, this);
    this.all.push(rig);
    return rig as unknown as BuildingRig;
  }

  /** Called by a rig when it disposes itself. */
  forget(rig: unknown): void {
    const i = this.all.indexOf(rig as PlaceholderRig);
    if (i >= 0) this.all.splice(i, 1);
  }

  private groupFor(key: string, make: () => Archetype): InstanceGroup {
    let group = this.groups.get(key);
    if (!group) {
      const arch = make();
      this.archetypes.set(key, arch);
      group = new InstanceGroup(arch, this.material, this.root);
      this.groups.set(key, group);
    }
    return group;
  }

  update(dt: number, _elapsed: number): void {
    for (let i = 0; i < this.all.length; i++) this.all[i].tick(dt);
    for (const group of this.groups.values()) group.flush();
  }

  dispose(): void {
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.material.dispose();
    this.root.removeFromParent();
  }
}
