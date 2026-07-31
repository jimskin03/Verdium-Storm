import * as THREE from 'three';

/**
 * The static description of an animated model: its bone layout plus the
 * semantic slots the runtime rig drives (turret, barrel, road wheels, track
 * loops, limbs, blow-off panels). Geometry is authored in the bind pose and
 * shared between every instance; only the skeleton is per-instance.
 */

export interface BoneSpec {
  name: string;
  parent: number;
  pos: [number, number, number];
  rot?: [number, number, number];
}

export class RigBuilder {
  readonly bones: BoneSpec[] = [];

  add(name: string, parent: number, x: number, y: number, z: number, rot?: [number, number, number]): number {
    this.bones.push({ name, parent, pos: [x, y, z], rot });
    return this.bones.length - 1;
  }

  /**
   * Bind-pose position of a bone in model space.
   *
   * Geometry is authored in the bind pose, so a part attached to bone `i` has to
   * be emitted around this point for the skin to deform about the right pivot.
   * Only translations accumulate here: every bone whose bind rotation is
   * non-zero (track links) is a leaf, so there is nothing below it to rotate.
   */
  world(i: number): [number, number, number] {
    let x = 0;
    let y = 0;
    let z = 0;
    let cursor = i;
    let guard = 0;
    while (cursor >= 0 && guard++ < 64) {
      const b = this.bones[cursor];
      if (!b) break;
      x += b.pos[0];
      y += b.pos[1];
      z += b.pos[2];
      cursor = b.parent;
    }
    return [x, y, z];
  }
}

/**
 * The closed loop a set of track links travels around. A capsule through the
 * drive sprocket and idler — the same shape a real running gear describes.
 */
export class TrackPath {
  private ys: number[] = [];
  private zs: number[] = [];
  private cum: number[] = [];
  readonly total: number;

  constructor(zRear: number, zFront: number, yCentre: number, radius: number, arcSteps = 8) {
    const push = (z: number, y: number): void => {
      this.zs.push(z);
      this.ys.push(y);
    };
    push(zRear, yCentre - radius);
    push(zFront, yCentre - radius);
    for (let i = 1; i <= arcSteps; i++) {
      const t = (i / arcSteps) * Math.PI;
      push(zFront + Math.sin(t) * radius, yCentre - Math.cos(t) * radius);
    }
    for (let i = 1; i <= arcSteps; i++) {
      const t = (i / arcSteps) * Math.PI;
      push(zRear - Math.sin(t) * radius, yCentre + Math.cos(t) * radius);
    }

    let acc = 0;
    this.cum.push(0);
    const n = this.zs.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      acc += Math.hypot(this.zs[j] - this.zs[i], this.ys[j] - this.ys[i]);
      this.cum.push(acc);
    }
    this.total = acc;
  }

  /** Position and tilt at arc-length `s`; wraps automatically. */
  at(s: number, out: { y: number; z: number; angle: number }): void {
    let t = s % this.total;
    if (t < 0) t += this.total;
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1] < t) i++;
    const seg = Math.max(1e-5, this.cum[i + 1] - this.cum[i]);
    const f = (t - this.cum[i]) / seg;
    const n = this.zs.length;
    const j = (i + 1) % n;
    const dz = this.zs[j] - this.zs[i];
    const dy = this.ys[j] - this.ys[i];
    out.z = this.zs[i] + dz * f;
    out.y = this.ys[i] + dy * f;
    out.angle = Math.atan2(-dy, dz);
  }
}

export interface WheelSlot {
  bone: number;
  radius: number;
  /** Steering wheels swing about Y with the turn rate. */
  steers?: boolean;
}

export interface TrackSlot {
  bones: number[];
  path: TrackPath;
  /** +1 or -1; mirrored sides must scroll the same way. */
  dir: number;
}

export interface LimbSlot {
  hip: number;
  knee: number;
  ankle: number;
  /** -1 left, +1 right. */
  side: number;
}

export interface ArmSlot {
  shoulder: number;
  elbow: number;
  side: number;
  /** True when this arm holds the weapon and should track the aim. */
  weapon?: boolean;
}

export interface RigDef {
  bones: BoneSpec[];
  locomotion: 'infantry' | 'wheeled' | 'tracked' | 'hover';
  /** Chassis bone; suspension pitch/roll is applied here. */
  hull: number;
  turret?: number;
  /** Barrel bone; elevation about X and recoil travel along -Z. */
  barrel?: number;
  muzzle?: [number, number, number];
  recoilTravel: number;
  turretRate: number;
  /** Gun elevation limits in radians; negative depresses below horizontal. */
  elevMin: number;
  elevMax: number;
  /**
   * Structures only. Everything above the poured apron hangs off this bone so
   * the build-up animation can drive the superstructure out of the ground while
   * the pad stays put.
   */
  riser?: number;
  /** Height the riser sinks by at zero build progress. */
  riseDepth: number;
  /** Sliding door/shutter driven by `setActive`. */
  door?: { bone: number; travel: [number, number, number]; rate: number };
  wheels: WheelSlot[];
  tracks: TrackSlot[];
  legs: LimbSlot[];
  arms: ArmSlot[];
  spine?: number;
  head?: number;
  /** Bones that swing loose or vanish as damage accumulates. */
  panels: number[];
  /** Bones that spin constantly (radar dishes, cooling fans). */
  spinners: { bone: number; rate: number; axis: 'x' | 'y' | 'z' }[];
  /** Emissive/light bones that pulse when active. */
  height: number;
  radius: number;
  /** Vertical offset from the rig origin to the ground contact point. */
  groundOffset: number;
}

export function emptyRig(locomotion: RigDef['locomotion']): RigDef {
  return {
    bones: [],
    locomotion,
    hull: 0,
    recoilTravel: 0.35,
    turretRate: 1.9,
    elevMin: -0.14,
    elevMax: 0.4,
    riseDepth: 0,
    wheels: [],
    tracks: [],
    legs: [],
    arms: [],
    panels: [],
    spinners: [],
    height: 3,
    radius: 2,
    groundOffset: 0,
  };
}

export interface SkeletonInstance {
  bones: THREE.Bone[];
  root: THREE.Bone;
  skeleton: THREE.Skeleton;
}

/** Materialises a bone hierarchy from a spec and binds a skeleton to it. */
export function instantiateSkeleton(spec: BoneSpec[]): SkeletonInstance {
  const bones: THREE.Bone[] = [];
  for (const s of spec) {
    const b = new THREE.Bone();
    b.name = s.name;
    b.position.set(s.pos[0], s.pos[1], s.pos[2]);
    if (s.rot) b.rotation.set(s.rot[0], s.rot[1], s.rot[2]);
    bones.push(b);
  }
  for (let i = 0; i < spec.length; i++) {
    const p = spec[i].parent;
    if (p >= 0 && p < bones.length && p !== i) bones[p].add(bones[i]);
  }
  const root = bones[0];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { bones, root, skeleton };
}
