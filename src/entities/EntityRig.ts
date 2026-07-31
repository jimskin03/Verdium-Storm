import * as THREE from 'three';
import { clamp } from '@/util/Noise';
import type { BuildingRig, DamageState, Team, UnitRig } from '@/entities/Types';
import { instantiateSkeleton, type RigDef } from './units/RigDef';

/**
 * The runtime half of a model: a skeleton instantiated from a shared rig
 * definition, bound to shared geometry, plus every animation channel the
 * simulation can drive.
 *
 * Design rules that matter more than they look:
 *
 * - Nothing snaps. Turrets are a damped second-order system, so they lead,
 *   overshoot slightly and settle. Recoil is a spring. Suspension, body roll
 *   and the walk cycle all ease.
 * - Locomotion is mechanical, not a slide. Wheels turn at v/r, steer with the
 *   yaw rate and travel vertically against body roll so they stay on the
 *   ground. Track plates walk a closed loop. Infantry have a real gait with
 *   hips, knees, ankles, arm counter-swing and a stride bob.
 * - One SkinnedMesh per entity, one shared geometry and one shared material per
 *   (team, damage state). All the per-part material variety is carried in
 *   vertex attributes, so an entity is a single draw call.
 */

const IDENTITY = new THREE.Matrix4();
const _fwd = new THREE.Vector3();
const _trk = { y: 0, z: 0, angle: 0 };

const DAMAGE_T: Record<DamageState, number> = { pristine: 0, damaged: 0.55, critical: 1 };

export interface RigMaterials {
  material(team: Team, damage: DamageState): THREE.Material;
}

export interface RigAsset {
  geometry: THREE.BufferGeometry;
  def: RigDef;
  /** Bind-pose world Y of the aim pivot, used for the elevation solve. */
  pivotY: number;
}

/** Wrapped angular difference in (-PI, PI]. */
function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export class EntityRig implements UnitRig, BuildingRig {
  readonly root = new THREE.Group();

  private mesh: THREE.SkinnedMesh;
  private bones: THREE.Bone[];
  private skeleton: THREE.Skeleton;
  private def: RigDef;
  private asset: RigAsset;

  /** Rest transforms, so every channel can be expressed as an offset. */
  private restPos: Float32Array;

  private team: Team;
  private mats: RigMaterials;
  private damage: DamageState = 'pristine';
  private damageT = 0;

  /* turret / gun */
  private aimBone = -1;
  private turYaw = 0;
  private turVel = 0;
  private elev = 0;
  private elevVel = 0;
  private wantYaw = 0;
  private wantElev = 0;
  private aiming = 0;
  private hasAim = false;
  private lastTarget = new THREE.Vector3();
  private recoilAmt = 0;
  private recoilVel = 0;
  private kick = 0;

  /* locomotion */
  private spin: Float32Array;
  private trackOfs: Float32Array;
  private steer = 0;
  private lean = 0;
  private pitch = 0;
  private lastSpeed = 0;
  private gait = 0;
  private gaitAmp = 0;
  private bob = 0;

  /* misc channels */
  private spinAngle: Float32Array;
  private buildT = 1;
  private door = 0;
  private doorWant = 0;
  private dying = -1;
  private deathSpan = 0;
  private phase: number;
  /** Set on dispose so the catalogue can drop the rig from its tick list. */
  disposed = false;

  constructor(asset: RigAsset, team: Team, mats: RigMaterials, phase: number) {
    this.asset = asset;
    this.def = asset.def;
    this.team = team;
    this.mats = mats;
    this.phase = phase;

    const skin = instantiateSkeleton(this.def.bones);
    this.bones = skin.bones;
    this.skeleton = skin.skeleton;

    this.restPos = new Float32Array(this.bones.length * 3);
    for (let i = 0; i < this.bones.length; i++) {
      const p = this.bones[i].position;
      this.restPos[i * 3] = p.x;
      this.restPos[i * 3 + 1] = p.y;
      this.restPos[i * 3 + 2] = p.z;
    }

    this.mesh = new THREE.SkinnedMesh(asset.geometry, mats.material(team, 'pristine'));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.add(skin.root);
    this.root.add(this.mesh);
    // Bind in local space: three re-derives `bindMatrixInverse` from the mesh's
    // world matrix every frame (attached bind mode), so an identity bind matrix
    // keeps the skin in the entity's own frame no matter where the root moves.
    this.mesh.bind(this.skeleton, IDENTITY);

    this.aimBone = this.def.turret ?? this.def.spine ?? -1;
    this.spin = new Float32Array(this.def.wheels.length);
    this.trackOfs = new Float32Array(this.def.tracks.length);
    this.spinAngle = new Float32Array(this.def.spinners.length);
    // Desynchronise gaits, idle sway and radar sweeps across a squad.
    this.gait = phase * Math.PI * 2;
    for (let i = 0; i < this.spinAngle.length; i++) this.spinAngle[i] = phase * Math.PI * 2;
  }

  /* ================================================================== *
   * Aiming
   * ================================================================== */

  aimAt(target: THREE.Vector3, dt: number): void {
    this.aiming = 0.55;

    // Lead: differentiate the target point and extrapolate by roughly the
    // flight time, so a turret tracks ahead of a moving unit instead of
    // trailing it.
    let px = target.x;
    let pz = target.z;
    if (this.hasAim && dt > 1e-4) {
      const vx = (target.x - this.lastTarget.x) / dt;
      const vz = (target.z - this.lastTarget.z) / dt;
      const dist = Math.hypot(target.x - this.root.position.x, target.z - this.root.position.z);
      const lead = clamp(dist / 150, 0, 0.5);
      // Guard against the discontinuity when the sim switches target.
      if (Math.abs(vx) < 60 && Math.abs(vz) < 60) {
        px += vx * lead;
        pz += vz * lead;
      }
    }
    this.lastTarget.copy(target);
    this.hasAim = true;

    _fwd.set(0, 0, 1).applyQuaternion(this.root.quaternion);
    const rootYaw = Math.atan2(_fwd.x, _fwd.z);
    const dx = px - this.root.position.x;
    const dz = pz - this.root.position.z;
    this.wantYaw = wrap(Math.atan2(dx, dz) - rootYaw);

    const flat = Math.hypot(dx, dz);
    const dy = target.y - (this.root.position.y + this.asset.pivotY);
    this.wantElev = clamp(Math.atan2(dy, Math.max(flat, 0.5)), this.def.elevMin, this.def.elevMax);
  }

  aimError(): number {
    if (this.aimBone < 0) {
      _fwd.set(0, 0, 1).applyQuaternion(this.root.quaternion);
      return Math.abs(wrap(this.wantYaw - Math.atan2(_fwd.x, _fwd.z)));
    }
    return Math.max(Math.abs(wrap(this.wantYaw - this.turYaw)), Math.abs(this.wantElev - this.elev) * 0.6);
  }

  muzzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    const bone = this.def.barrel ?? this.aimBone;
    this.root.updateMatrixWorld(true);
    if (bone >= 0 && this.bones[bone]) {
      const m = this.bones[bone].matrixWorld;
      const o = this.def.muzzle ?? [0, 0, 1];
      outPos.set(o[0], o[1], o[2]).applyMatrix4(m);
      outDir.set(0, 0, 1).transformDirection(m).normalize();
      return;
    }
    outPos.copy(this.root.position);
    outPos.y += this.def.height * 0.6;
    outDir.set(0, 0, 1).applyQuaternion(this.root.quaternion);
  }

  /** Visual recoil impulse; the spring in `tick` returns the gun to battery. */
  recoil(strength: number): void {
    this.recoilVel -= strength * 11;
    this.kick = Math.min(1, this.kick + strength * 0.55);
  }

  /* ================================================================== *
   * Locomotion
   * ================================================================== */

  locomote(dt: number, speed: number, turn: number): void {
    if (dt <= 0) return;
    const def = this.def;

    // Wheels: spin at v/r, steer with the yaw rate, travel against body roll.
    const targetSteer = clamp(turn * 0.34, -0.5, 0.5);
    this.steer += (targetSteer - this.steer) * Math.min(1, dt * 9);
    for (let i = 0; i < def.wheels.length; i++) {
      const w = def.wheels[i];
      const bone = this.bones[w.bone];
      if (!bone) continue;
      this.spin[i] += (speed / Math.max(0.08, w.radius)) * dt;
      bone.rotation.x = this.spin[i];
      if (w.steers) bone.rotation.y = this.steer;
      bone.position.y = this.restPos[w.bone * 3 + 1] - this.restPos[w.bone * 3] * this.lean;
    }

    // Track plates walk the closed loop through the running gear.
    for (let t = 0; t < def.tracks.length; t++) {
      const track = def.tracks[t];
      this.trackOfs[t] += speed * dt * track.dir;
      const n = track.bones.length;
      const step = track.path.total / n;
      for (let j = 0; j < n; j++) {
        const bone = this.bones[track.bones[j]];
        if (!bone) continue;
        track.path.at(j * step + this.trackOfs[t], _trk);
        bone.position.y = _trk.y;
        bone.position.z = _trk.z;
        bone.rotation.x = _trk.angle;
      }
    }

    // Body attitude: pitch against acceleration, roll into the turn.
    const accel = (speed - this.lastSpeed) / dt;
    this.lastSpeed = speed;
    const wantPitch = clamp(-accel * 0.010, -0.075, 0.075) + this.kick * 0.05;
    const wantLean = clamp(turn * Math.min(speed, 14) * 0.011, -0.11, 0.11);
    const k = Math.min(1, dt * 7);
    this.pitch += (wantPitch - this.pitch) * k;
    this.lean += (wantLean - this.lean) * k;

    if (def.locomotion === 'infantry') {
      this.walk(dt, speed);
    } else {
      const body = this.bones[def.hull];
      if (body && this.dying < 0) {
        body.rotation.x = this.pitch;
        body.rotation.z = this.lean;
      }
    }
  }

  /**
   * Infantry gait. Stride frequency comes from ground speed so the feet never
   * skate; the amplitude fades to an idle sway when the soldier stops.
   */
  private walk(dt: number, speed: number): void {
    const def = this.def;
    const stride = 2.0;
    const wantAmp = clamp(speed / 7, 0, 1);
    this.gaitAmp += (wantAmp - this.gaitAmp) * Math.min(1, dt * 6);
    this.gait += (Math.max(speed, 0.35) / stride) * Math.PI * 2 * dt;

    const amp = this.gaitAmp;
    const s = Math.sin(this.gait);
    const c = Math.cos(this.gait);

    for (const leg of def.legs) {
      const side = leg.side > 0 ? 1 : -1;
      const p = this.gait + (side > 0 ? 0 : Math.PI);
      const swing = Math.sin(p);
      const lift = Math.max(0, -Math.cos(p));
      const hip = this.bones[leg.hip];
      const knee = this.bones[leg.knee];
      const ankle = this.bones[leg.ankle];
      if (hip) hip.rotation.x = swing * 0.62 * amp;
      // The knee only folds one way, and folds hardest on the recovery stroke.
      if (knee) knee.rotation.x = (lift * 1.15 + 0.06) * amp + (1 - amp) * 0.05;
      if (ankle) ankle.rotation.x = -(swing * 0.3 + lift * 0.5) * amp;
    }

    // Pelvis bobs at twice stride frequency and rolls onto the loaded leg.
    this.bob = Math.abs(c) * 0.09 * amp;
    const hips = this.bones[def.hull];
    if (hips) {
      hips.position.y = this.restPos[def.hull * 3 + 1] + this.bob - amp * 0.06;
      hips.rotation.z = -s * 0.06 * amp;
      hips.rotation.y = -s * 0.1 * amp;
    }
    const spine = def.spine !== undefined ? this.bones[def.spine] : undefined;
    if (spine) {
      spine.rotation.x = 0.06 + amp * 0.14 + this.pitch;
      spine.rotation.z = s * 0.03 * amp;
    }

    // Arms: the free arm counter-swings, the weapon arm holds a ready pose and
    // tightens into an aim when the sim is asking for a shot.
    const aim = this.aiming > 0 ? 1 : 0;
    for (const arm of def.arms) {
      const sh = this.bones[arm.shoulder];
      const el = this.bones[arm.elbow];
      if (!sh || !el) continue;
      if (arm.weapon) {
        sh.rotation.x = -0.62 - aim * 0.32;
        sh.rotation.y = -0.12;
        el.rotation.x = 0.62 + aim * 0.2;
      } else {
        const swing = -Math.sin(this.gait + (arm.side > 0 ? 0 : Math.PI));
        sh.rotation.x = aim ? -0.75 : swing * 0.5 * amp;
        sh.rotation.y = aim ? 0.34 : 0;
        el.rotation.x = aim ? 1.0 : 0.28 + Math.max(0, swing) * 0.4 * amp;
      }
    }
  }

  /* ================================================================== *
   * State
   * ================================================================== */

  setDamageState(state: DamageState): void {
    if (this.damage === state) return;
    this.damage = state;
    this.damageT = DAMAGE_T[state];
    this.mesh.material = this.mats.material(this.team, state);
    for (const p of this.def.panels) {
      const bone = this.bones[p];
      if (!bone) continue;
      bone.rotation.x = this.damageT * 0.7;
      bone.position.y = this.restPos[p * 3 + 1] - this.damageT * 0.25;
      // A critically damaged machine has simply lost the panel.
      bone.scale.setScalar(state === 'critical' ? 0.0001 : 1);
    }
  }

  setBuildProgress(t: number): void {
    this.buildT = clamp(t, 0, 1);
    const riser = this.def.riser;
    if (riser === undefined) return;
    const bone = this.bones[riser];
    if (!bone) return;
    // Ease out so the last metre of travel settles instead of stopping dead.
    const e = 1 - (1 - this.buildT) * (1 - this.buildT);
    bone.position.y = this.restPos[riser * 3 + 1] - (1 - e) * this.def.riseDepth;
  }

  setActive(active: boolean): void {
    this.doorWant = active ? 1 : 0;
  }

  die(): number {
    if (this.dying >= 0) return this.deathSpan;
    this.dying = 0;
    const inf = this.def.locomotion === 'infantry';
    this.deathSpan = this.def.riser !== undefined ? 3.2 : inf ? 2.6 : 3.0;
    return this.deathSpan;
  }

  /* ================================================================== *
   * Per-frame integration
   * ================================================================== */

  tick(dt: number): void {
    const def = this.def;

    if (this.aiming > 0) this.aiming -= dt;

    // Turret: a damped spring on the yaw, hard-limited to the mount's slew
    // rate. Slight underdamping is what produces the overshoot-and-settle.
    if (this.aimBone >= 0) {
      const bone = this.bones[this.aimBone];
      if (bone) {
        const err = wrap(this.wantYaw - this.turYaw);
        const rate = def.turretRate;
        const accel = err * rate * 5.2 - this.turVel * 3.4;
        this.turVel = clamp(this.turVel + accel * dt, -rate, rate);
        this.turYaw = wrap(this.turYaw + this.turVel * dt);
        if (def.turret !== undefined) {
          bone.rotation.y = this.turYaw;
        } else {
          // Infantry twist at the waist rather than spinning on the spot.
          bone.rotation.y = clamp(this.turYaw, -0.95, 0.95);
        }
      }
    }

    // Recoil spring plus the gun's elevation servo.
    this.recoilVel += (-this.recoilAmt * 150 - this.recoilVel * 13) * dt;
    this.recoilAmt = Math.max(0, this.recoilAmt + this.recoilVel * dt);
    this.kick *= Math.exp(-dt * 6);

    if (def.barrel !== undefined) {
      const bone = this.bones[def.barrel];
      if (bone) {
        const de = this.wantElev - this.elev;
        this.elevVel = clamp(this.elevVel + (de * 22 - this.elevVel * 7.5) * dt, -2.4, 2.4);
        this.elev = clamp(this.elev + this.elevVel * dt, def.elevMin - 0.05, def.elevMax + 0.05);
        bone.rotation.x = -this.elev;
        bone.position.z = this.restPos[def.barrel * 3 + 2] - this.recoilAmt * def.recoilTravel;
      }
    }

    for (let i = 0; i < def.spinners.length; i++) {
      const sp = def.spinners[i];
      const bone = this.bones[sp.bone];
      if (!bone || sp.rate === 0) continue;
      this.spinAngle[i] += sp.rate * dt;
      bone.rotation[sp.axis] = this.spinAngle[i];
    }

    if (def.door) {
      const d = def.door;
      const delta = this.doorWant - this.door;
      const step = d.rate * dt;
      this.door += clamp(delta, -step, step);
      const bone = this.bones[d.bone];
      if (bone) {
        const e = this.door * this.door * (3 - 2 * this.door);
        bone.position.set(
          this.restPos[d.bone * 3] + d.travel[0] * e,
          this.restPos[d.bone * 3 + 1] + d.travel[1] * e,
          this.restPos[d.bone * 3 + 2] + d.travel[2] * e,
        );
      }
    }

    if (this.dying >= 0) this.tickDeath(dt);
  }

  private tickDeath(dt: number): void {
    this.dying += dt;
    const t = clamp(this.dying / this.deathSpan, 0, 1);
    const def = this.def;

    if (def.riser !== undefined) {
      // Structures collapse into their own footprint and leave the apron.
      const bone = this.bones[def.riser];
      if (bone) {
        const drop = t * t * (def.riseDepth * 0.85);
        bone.position.y = this.restPos[def.riser * 3 + 1] - drop;
        bone.rotation.z = Math.sin(t * 4.2) * 0.05 * (1 - t);
        bone.rotation.x = t * 0.06;
      }
      return;
    }

    if (def.locomotion === 'infantry') {
      // Collapse forward: knees fold, torso pitches over, the whole figure
      // settles into the ground rather than sinking through it.
      const f = Math.min(1, t * 2.4);
      const hips = this.bones[def.hull];
      if (hips) {
        hips.rotation.x = f * 1.35;
        hips.position.y = this.restPos[def.hull * 3 + 1] - f * 0.72;
      }
      if (def.spine !== undefined) {
        const spine = this.bones[def.spine];
        if (spine) spine.rotation.x = f * 0.5;
      }
      for (const leg of def.legs) {
        const knee = this.bones[leg.knee];
        const hip = this.bones[leg.hip];
        if (hip) hip.rotation.x = -f * 0.5 * (leg.side > 0 ? 1 : 0.6);
        if (knee) knee.rotation.x = f * 1.5;
      }
      for (const arm of def.arms) {
        const sh = this.bones[arm.shoulder];
        if (sh) sh.rotation.x = -f * 0.9;
      }
      return;
    }

    // Vehicles slump onto their suspension, list to one side and burn down.
    const body = this.bones[def.hull];
    if (body) {
      const f = Math.min(1, t * 1.8);
      body.rotation.x = f * 0.16;
      body.rotation.z = f * (this.phase > 0.5 ? 0.2 : -0.2);
      body.position.y = this.restPos[def.hull * 3 + 1] - f * 0.65;
    }
    if (def.turret !== undefined) {
      const tur = this.bones[def.turret];
      if (tur) tur.rotation.y = this.turYaw + t * 0.5;
    }
    if (def.barrel !== undefined) {
      const bar = this.bones[def.barrel];
      if (bar) bar.rotation.x = 0.2 * t;
    }
  }

  /** Positions the mesh so a corpse can be culled once it is buried. */
  get deathProgress(): number {
    return this.dying < 0 ? 0 : clamp(this.dying / Math.max(0.01, this.deathSpan), 0, 1);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.skeleton.dispose();
    this.mesh.removeFromParent();
    this.root.clear();
    this.root.removeFromParent();
  }
}
