import * as THREE from 'three';
import { tryGet } from '@/engine/Services';
import {
  BASE_POSITIONS,
  HALF_WORLD,
  RESOURCE_FIELDS,
  heightAt,
  isBuildable,
} from '@/world/Heightfield';
import { clamp, makeRng } from '@/util/Noise';
import {
  damageStateFor,
  type BuildingType,
  type DamageState,
  type Faction,
  type ModelCatalog,
  type Team,
  type UnitType,
} from '@/entities/Types';
import type { Alert, AlertKind } from '@/game/GameState';
import {
  ARMOUR_STRUCTURE,
  BUILDING_ID,
  BUILDING_LIST,
  BUILDING_TYPES,
  BUILDING_WEAPON,
  PROJ_BALLISTIC,
  PROJ_DIRECT,
  PROJ_HITSCAN,
  PROJ_HOMING,
  PROJ_KIND,
  UNIT_ARMOUR,
  UNIT_ID,
  UNIT_IS_CIVILIAN,
  UNIT_LIST,
  UNIT_PRODUCER,
  UNIT_TYPES,
  UNIT_WEAPON,
  WEAPONS,
  WEAPON_VS,
} from './Stats';
import {
  BuildingStore,
  KIND_BUILDING,
  KIND_UNIT,
  MAX_PROJECTILES,
  NO_REF,
  Order,
  ProjectileStore,
  Stance,
  UState,
  UnitStore,
  refKind,
  refSlot,
} from './Entities';
import { FlowFieldCache, NAV_CELL, NavGrid, SpatialHash, cellX, cellZ } from './Nav';
import { FogOfWar } from './Fog';
import { SimVfx } from './Vfx';
import { PlaceholderCatalog } from './Rigs';
import { ResourceMap, TeamState } from './Economy';

export const SIM_STEP = 1 / 30;
export const UNIT_CAP = 110;

/** Shell gravity. Tuned so the siege gun's arc peaks well above the terrain. */
const GRAVITY = 40;
const FIELD_BUDGET = 26000;
const RETARGET_PERIOD = 0.45;
const MINE_RATE = 95;
const UNLOAD_RATE = 420;
const MAX_ALERTS = 8;

export interface SimOptions {
  playerTeam: Team;
  playerFaction: Faction;
  enemyFaction: Faction;
  seed: number;
  /** Runs a commander for the human team too, so the match plays itself. */
  autoPlayer: boolean;
}

interface Corpse {
  rig: { root: THREE.Object3D; dispose?(): void };
  timer: number;
}

const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchC = new THREE.Vector3();
const scratchQ = new THREE.Quaternion();
const scratchQ2 = new THREE.Quaternion();
const scratchN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

export class Sim {
  readonly units = new UnitStore();
  readonly buildings = new BuildingStore();
  readonly projectiles = new ProjectileStore();
  readonly nav = new NavGrid();
  readonly flow: FlowFieldCache;
  readonly resources = new ResourceMap();
  readonly teams: [TeamState, TeamState];
  readonly alerts: Alert[] = [];

  fog!: FogOfWar;
  vfx!: SimVfx;

  readonly entityRoot = new THREE.Group();
  private placeholder!: PlaceholderCatalog;
  private unitHash = new SpatialHash(12, UnitStore.prototype.capacity ?? 512);
  private neighbours = new Int32Array(96);
  private corpses: Corpse[] = [];

  private rng = makeRng(1);
  matchTime = 0;
  tickCount = 0;
  paused = false;
  /** Frame-local interpolation factor between the last two ticks. */
  private accumulator = 0;

  /** Rolling cost of the movement + pathing pass, in milliseconds. */
  pathMs = 0;
  simMs = 0;

  private navScratch = new Float32Array(2);
  private dirScratch = new Float32Array(2);
  private normalScratch = new Float32Array(3);

  constructor(private scene: THREE.Object3D, readonly options: SimOptions) {
    this.rng = makeRng(options.seed);
    this.flow = new FlowFieldCache(this.nav);
    this.teams = [
      new TeamState(0, options.playerTeam === 0 ? options.playerFaction : options.enemyFaction),
      new TeamState(1, options.playerTeam === 1 ? options.playerFaction : options.enemyFaction),
    ];
    this.teams[0].baseX = BASE_POSITIONS.player.x;
    this.teams[0].baseZ = BASE_POSITIONS.player.z;
    this.teams[1].baseX = BASE_POSITIONS.enemy.x;
    this.teams[1].baseZ = BASE_POSITIONS.enemy.z;
  }

  /* ================================================================== *
   * Construction
   * ================================================================== */

  build(): void {
    this.entityRoot.name = 'battlefield';
    this.scene.add(this.entityRoot);
    this.nav.build();
    this.placeholder = new PlaceholderCatalog(this.entityRoot, (t) => BUILDING_LIST[BUILDING_ID[t]].footprint * NAV_CELL);
    this.fog = new FogOfWar(this.scene, this.options.playerTeam);
    this.vfx = new SimVfx(this.scene);
    this.seedMatch();
    this.recomputePower();
    this.updateFog();
    this.vfx.updateFields(this.resources.fraction);
  }

  private factionOf(team: number): Faction {
    return this.teams[team].faction;
  }

  /* ================================================================== *
   * Spawning
   * ================================================================== */

  private models(): ModelCatalog | undefined {
    return tryGet('models');
  }

  spawnUnit(typeId: number, team: number, x: number, z: number, yaw: number): number {
    const stats = UNIT_LIST[typeId];
    const slot = this.units.alloc();
    if (slot < 0) return -1;
    const u = this.units;
    u.type[slot] = typeId;
    u.team[slot] = team;
    u.state[slot] = UState.Idle;
    u.stance[slot] = Stance.Aggressive;
    u.px[slot] = x;
    u.pz[slot] = z;
    u.py[slot] = heightAt(x, z);
    u.prevX[slot] = x;
    u.prevZ[slot] = z;
    u.prevY[slot] = u.py[slot];
    u.yaw[slot] = yaw;
    u.prevYaw[slot] = yaw;
    u.spd[slot] = 0;
    u.turn[slot] = 0;
    u.hp[slot] = stats.hp;
    u.maxHp[slot] = stats.hp;
    u.cooldown[slot] = this.rng() * 0.5;
    u.burstLeft[slot] = 0;
    u.retarget[slot] = this.rng() * RETARGET_PERIOD;
    u.repathTimer[slot] = this.rng() * 2;
    u.arriveRadius[slot] = stats.radius * 1.6;
    u.nx[slot] = 0;
    u.ny[slot] = 1;
    u.nz[slot] = 0;
    u.clearOrders(slot);
    this.units.markDirty();

    const models = this.models();
    const faction = this.factionOf(team);
    let rig;
    try {
      rig = models
        ? models.createUnit(stats.type, faction, team as Team)
        : this.placeholder.createUnit(stats.type, faction, team as Team);
    } catch {
      rig = this.placeholder.createUnit(stats.type, faction, team as Team);
    }
    u.rigs[slot] = rig;
    rig.root.position.set(x, u.py[slot], z);
    rig.root.rotation.set(0, yaw, 0);
    this.entityRoot.add(rig.root);

    this.teams[team].units[typeId]++;
    return slot;
  }

  /** Places a structure. `instant` skips the on-site erection animation. */
  spawnBuilding(typeId: number, team: number, x: number, z: number, instant: boolean): number {
    const stats = BUILDING_LIST[typeId];
    const slot = this.buildings.alloc();
    if (slot < 0) return -1;
    const b = this.buildings;
    b.type[slot] = typeId;
    b.team[slot] = team;
    b.px[slot] = x;
    b.pz[slot] = z;
    b.py[slot] = this.footprintHeight(x, z, stats.footprint);
    b.yaw[slot] = team === 0 ? Math.PI * 0.25 : Math.PI * 1.25;
    b.hp[slot] = instant ? stats.hp : stats.hp * 0.35;
    b.maxHp[slot] = stats.hp;
    b.buildProgress[slot] = instant ? 1 : 0;
    b.cooldown[slot] = this.rng() * 0.5;
    b.burstLeft[slot] = 0;
    b.retarget[slot] = this.rng() * RETARGET_PERIOD;
    b.rallyX[slot] = x;
    b.rallyZ[slot] = z;
    b.hasRally[slot] = 0;
    this.buildings.markDirty();

    this.nav.setFootprint(x, z, stats.footprint, true);

    const models = this.models();
    const faction = this.factionOf(team);
    let rig;
    try {
      rig = models
        ? models.createBuilding(stats.type, faction, team as Team)
        : this.placeholder.createBuilding(stats.type, faction, team as Team);
    } catch {
      rig = this.placeholder.createBuilding(stats.type, faction, team as Team);
    }
    b.rigs[slot] = rig;
    rig.root.position.set(x, b.py[slot], z);
    rig.root.rotation.set(0, b.yaw[slot], 0);
    rig.setBuildProgress?.(instant ? 1 : 0);
    this.entityRoot.add(rig.root);

    this.teams[team].pending[typeId]++;
    if (instant) this.completeBuilding(slot);
    return slot;
  }

  /** Highest ground under the footprint, so nothing sinks into a slope. */
  private footprintHeight(x: number, z: number, cells: number): number {
    const h = cells * NAV_CELL * 0.5 - 1;
    let m = heightAt(x, z);
    m = Math.max(m, heightAt(x - h, z - h), heightAt(x + h, z - h), heightAt(x - h, z + h), heightAt(x + h, z + h));
    return m;
  }

  private completeBuilding(slot: number): void {
    const b = this.buildings;
    const typeId = b.type[slot];
    const team = b.team[slot];
    b.buildProgress[slot] = 1;
    b.rigs[slot]?.setBuildProgress?.(1);
    const state = this.teams[team];
    state.buildings[typeId]++;
    state.pending[typeId]--;
    this.recomputePower();
    if (team === this.options.playerTeam) {
      this.pushAlert('buildingComplete', `${BUILDING_LIST[typeId].label} online`, b.px[slot], b.pz[slot]);
    }
    // A new refinery arrives with its own harvester, as is traditional.
    if (typeId === BUILDING_ID.refinery) {
      const a = b.yaw[slot];
      this.spawnUnit(UNIT_ID.harvester, team, b.px[slot] + Math.sin(a) * 16, b.pz[slot] + Math.cos(a) * 16, a);
    }
  }

  recomputePower(): void {
    for (const t of this.teams) {
      t.powerProduced = 0;
      t.powerConsumed = 0;
    }
    const b = this.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.buildProgress[i] < 1) continue;
      const p = BUILDING_LIST[b.type[i]].power;
      const t = this.teams[b.team[i]];
      if (p >= 0) t.powerProduced += p;
      else t.powerConsumed -= p;
    }
  }

  /* ================================================================== *
   * Match setup
   * ================================================================== */

  private seedMatch(): void {
    this.seedBase(0, this.teams[0].baseX, this.teams[0].baseZ, 1);
    this.seedBase(1, this.teams[1].baseX, this.teams[1].baseZ, -1);
    // Two forward battle groups so a match is already in contact at the choke.
    this.seedGroup(0, -62, -62, 1);
    this.seedGroup(1, 62, 62, -1);
    this.teams[0].credits = 4200;
    this.teams[1].credits = 4200;
  }

  private seedBase(team: number, cx: number, cz: number, s: number): void {
    const layout: Array<[BuildingType, number, number]> = [
      ['hq', 0, 0],
      ['power', -30, -8],
      ['power', -30, 14],
      ['refinery', 26, -18],
      ['barracks', 2, 30],
      ['factory', 30, 16],
      ['radar', -8, -32],
      ['turret', 40, 42],
      ['turret', 44, -34],
      ['sam', -38, 32],
    ];
    for (const [type, ox, oz] of layout) {
      const id = BUILDING_ID[type];
      const spot = this.findPlacement(BUILDING_LIST[id].footprint, cx + ox * s, cz + oz * s, 60);
      if (!spot) continue;
      this.spawnBuilding(id, team, spot[0], spot[1], true);
    }

    const roster: Array<[UnitType, number]> = [
      ['harvester', 3], ['rifleman', 5], ['rocketeer', 3], ['tank', 3], ['aa', 2], ['scout', 1],
    ];
    let ring = 0;
    for (const [type, count] of roster) {
      for (let i = 0; i < count; i++) {
        const a = (ring * 0.61 + 0.2) % (Math.PI * 2);
        const r = 44 + (ring % 3) * 9;
        const x = cx + Math.cos(a) * r * s;
        const z = cz + Math.sin(a) * r * s;
        const p = this.freeSpot(x, z);
        this.spawnUnit(UNIT_ID[type], team, p[0], p[1], Math.atan2(-s, -s));
        ring++;
      }
    }
  }

  private seedGroup(team: number, cx: number, cz: number, s: number): void {
    const roster: Array<[UnitType, number]> = [['tank', 4], ['rifleman', 5], ['rocketeer', 3], ['aa', 1]];
    let n = 0;
    const slots: number[] = [];
    for (const [type, count] of roster) {
      for (let i = 0; i < count; i++) {
        const col = n % 5;
        const row = Math.floor(n / 5);
        const x = cx + (col - 2) * 9 * s;
        const z = cz + row * 9 * s;
        const p = this.freeSpot(x, z);
        const slot = this.spawnUnit(UNIT_ID[type], team, p[0], p[1], Math.atan2(-cx, -cz));
        if (slot >= 0) slots.push(slot);
        n++;
      }
    }
    // Send them at the central plateau; they meet in the middle within seconds.
    for (const slot of slots) {
      this.units.clearOrders(slot);
      this.units.pushOrder(slot, Order.AttackMove, this.rng() * 24 - 12, this.rng() * 24 - 12, NO_REF);
    }
  }

  /** Finds a legal footprint near (x, z), spiralling outward. */
  findPlacement(cells: number, x: number, z: number, maxRadius: number): [number, number] | null {
    const step = NAV_CELL * 2;
    for (let r = 0; r <= maxRadius; r += step) {
      const steps = r === 0 ? 1 : Math.max(6, Math.round((Math.PI * 2 * r) / step));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (this.footprintClear(cells, px, pz)) return [px, pz];
      }
    }
    return null;
  }

  footprintClear(cells: number, x: number, z: number): boolean {
    const half = (cells * NAV_CELL) / 2;
    if (Math.abs(x) > HALF_WORLD - 60 || Math.abs(z) > HALF_WORLD - 60) return false;
    const probes = 3;
    for (let j = 0; j < probes; j++) {
      for (let i = 0; i < probes; i++) {
        const px = x - half + (half * 2 * i) / (probes - 1);
        const pz = z - half + (half * 2 * j) / (probes - 1);
        if (!isBuildable(px, pz)) return false;
        const k = cellZ(pz) * 256 + cellX(px);
        if (this.nav.occupancy[k] > 0) return false;
      }
    }
    // Keep a corridor open around the pad so units are not walled in.
    const b = this.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const o = b.live[n];
      const oh = (BUILDING_LIST[b.type[o]].footprint * NAV_CELL) / 2;
      if (Math.abs(b.px[o] - x) < half + oh + 4 && Math.abs(b.pz[o] - z) < half + oh + 4) return false;
    }
    return true;
  }

  /** True when the point is close enough to friendly structures to build there. */
  nearFriendlyBase(team: number, x: number, z: number, range = 90): boolean {
    const b = this.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] !== team) continue;
      const dx = b.px[i] - x;
      const dz = b.pz[i] - z;
      if (dx * dx + dz * dz < range * range) return true;
    }
    return false;
  }

  private freeSpot(x: number, z: number): Float32Array {
    this.nav.nearestPassable(x, z, this.navScratch);
    return this.navScratch;
  }

  /* ================================================================== *
   * Reference helpers
   * ================================================================== */

  refValid(ref: number): boolean {
    return refKind(ref) === KIND_UNIT ? this.units.valid(ref) : this.buildings.valid(ref);
  }

  refTeam(ref: number): number {
    const s = refSlot(ref);
    return refKind(ref) === KIND_UNIT ? this.units.team[s] : this.buildings.team[s];
  }

  refPos(ref: number, out: THREE.Vector3): boolean {
    if (!this.refValid(ref)) return false;
    const s = refSlot(ref);
    if (refKind(ref) === KIND_UNIT) {
      out.set(this.units.px[s], this.units.py[s] + 1.6, this.units.pz[s]);
    } else {
      out.set(this.buildings.px[s], this.buildings.py[s] + 4, this.buildings.pz[s]);
    }
    return true;
  }

  refRadius(ref: number): number {
    const s = refSlot(ref);
    return refKind(ref) === KIND_UNIT
      ? UNIT_LIST[this.units.type[s]].radius
      : (BUILDING_LIST[this.buildings.type[s]].footprint * NAV_CELL) / 2;
  }

  refArmour(ref: number): number {
    const s = refSlot(ref);
    return refKind(ref) === KIND_UNIT ? UNIT_ARMOUR[this.units.type[s]] : ARMOUR_STRUCTURE;
  }

  /* ================================================================== *
   * Frame entry
   * ================================================================== */

  update(dt: number, camera: THREE.Camera): void {
    const t0 = performance.now();
    if (!this.paused) {
      this.accumulator += Math.min(dt, 0.25);
      let steps = 0;
      while (this.accumulator >= SIM_STEP && steps < 4) {
        this.accumulator -= SIM_STEP;
        this.tick(SIM_STEP);
        steps++;
      }
    }
    this.simMs += (performance.now() - t0 - this.simMs) * 0.1;

    const alpha = this.paused ? 1 : clamp(this.accumulator / SIM_STEP, 0, 1);
    this.syncRigs(dt, alpha);
    this.placeholder.update(dt, this.matchTime);
    this.vfx.syncProjectiles(this.projectiles, alpha, SIM_STEP);
    this.vfx.update(dt, camera);
    this.fog.updateVisuals(dt);

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.timer -= dt;
      if (c.timer <= 0) {
        c.rig.root.removeFromParent();
        c.rig.dispose?.();
        this.corpses.splice(i, 1);
      }
    }
  }

  tick(dt: number): void {
    this.tickCount++;
    this.matchTime += dt;

    this.flow.update(FIELD_BUDGET);
    this.units.refreshLive();
    this.buildings.refreshLive();
    this.unitHash.rebuild(this.units.live, this.units.liveCount, this.units.px, this.units.pz);

    for (const t of this.teams) t.tickIncome(dt);

    const p0 = performance.now();
    this.tickUnits(dt);
    this.pathMs += (performance.now() - p0 - this.pathMs) * 0.1;

    this.tickBuildings(dt);
    this.tickProjectiles(dt);
    this.reapDead();

    if (this.tickCount % 6 === 0) this.updateFog();
    if (this.tickCount % 30 === 0) this.vfx.updateFields(this.resources.fraction);

    for (let i = this.alerts.length - 1; i >= 0; i--) {
      this.alerts[i].age += dt;
      if (this.alerts[i].age > 14) this.alerts.splice(i, 1);
    }
  }

  /* ================================================================== *
   * Units
   * ================================================================== */

  private tickUnits(dt: number): void {
    const u = this.units;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      u.prevX[i] = u.px[i];
      u.prevY[i] = u.py[i];
      u.prevZ[i] = u.pz[i];
      u.prevYaw[i] = u.yaw[i];
      u.pushX[i] = 0;
      u.pushZ[i] = 0;
    }
    for (let n = 0; n < u.liveCount; n++) this.tickUnitBrain(u.live[n], dt);
    for (let n = 0; n < u.liveCount; n++) this.tickUnitMove(u.live[n], dt);
    for (let n = 0; n < u.liveCount; n++) this.tickUnitWeapon(u.live[n], dt);
  }

  /** Order interpretation and economy behaviour. */
  private tickUnitBrain(i: number, dt: number): void {
    const u = this.units;
    const typeId = u.type[i];
    const stats = UNIT_LIST[typeId];

    u.retarget[i] -= dt;
    u.repathTimer[i] -= dt;

    const head = u.peekOrder(i);
    const order = head >= 0 ? u.orderType[head] : Order.None;

    // Harvesters ignore combat orders entirely and run their own loop.
    if (stats.cargo) {
      this.tickHarvester(i, dt, order, head);
      return;
    }

    if (order === Order.Attack || order === Order.Repair || order === Order.Capture) {
      const target = u.orderRef[head];
      if (!this.refValid(target)) {
        u.popOrder(i);
        u.hasGoal[i] = 0;
        return;
      }
      if (order === Order.Attack) {
        u.targetRef[i] = target;
        this.approachTarget(i, target, stats.weapon ? stats.weapon.range : 6);
      } else {
        this.tickEngineer(i, dt, order, target);
      }
      return;
    }

    if (order === Order.Move || order === Order.AttackMove) {
      const gx = u.orderX[head];
      const gz = u.orderZ[head];
      if (order === Order.AttackMove && this.refValid(u.targetRef[i]) && this.inWeaponRange(i, u.targetRef[i])) {
        u.hasGoal[i] = 0;
        u.state[i] = UState.Attack;
      } else {
        this.setGoal(i, gx, gz);
        u.state[i] = order === Order.AttackMove ? UState.AttackMove : UState.Move;
      }
      const dx = u.px[i] - gx;
      const dz = u.pz[i] - gz;
      if (dx * dx + dz * dz < u.arriveRadius[i] * u.arriveRadius[i]) {
        u.popOrder(i);
        u.hasGoal[i] = 0;
        u.state[i] = UState.Idle;
      }
      return;
    }

    if (order === Order.Guard) {
      const gx = u.orderX[head];
      const gz = u.orderZ[head];
      const dx = u.px[i] - gx;
      const dz = u.pz[i] - gz;
      if (this.refValid(u.targetRef[i]) && this.inWeaponRange(i, u.targetRef[i])) {
        u.hasGoal[i] = 0;
      } else if (dx * dx + dz * dz > 26 * 26) {
        this.setGoal(i, gx, gz);
      } else {
        u.hasGoal[i] = 0;
      }
      u.state[i] = UState.Guard;
      return;
    }

    // No orders: hold ground, but chase a target the stance allows.
    if (this.refValid(u.targetRef[i])) {
      if (u.stance[i] === Stance.Aggressive) {
        this.approachTarget(i, u.targetRef[i], stats.weapon ? stats.weapon.range : 6);
        u.state[i] = UState.Attack;
        return;
      }
      if (this.inWeaponRange(i, u.targetRef[i])) {
        u.hasGoal[i] = 0;
        u.state[i] = UState.Attack;
        return;
      }
    }
    u.hasGoal[i] = 0;
    u.state[i] = UState.Idle;
  }

  private approachTarget(i: number, target: number, range: number): void {
    const u = this.units;
    if (this.inWeaponRange(i, target) && this.hasFireLine(i, target)) {
      u.hasGoal[i] = 0;
      return;
    }
    if (!this.refPos(target, scratchA)) return;
    // Stop short of the target so units form a firing line instead of a pile.
    const dx = scratchA.x - u.px[i];
    const dz = scratchA.z - u.pz[i];
    const d = Math.hypot(dx, dz) || 1;
    const stand = Math.max(4, range * 0.75 + this.refRadius(target));
    const gx = scratchA.x - (dx / d) * stand;
    const gz = scratchA.z - (dz / d) * stand;
    this.setGoal(i, gx, gz);
  }

  private tickEngineer(i: number, dt: number, order: number, target: number): void {
    const u = this.units;
    if (!this.refPos(target, scratchA)) return;
    const dx = scratchA.x - u.px[i];
    const dz = scratchA.z - u.pz[i];
    const reach = this.refRadius(target) + 6;
    if (dx * dx + dz * dz > reach * reach) {
      this.setGoal(i, scratchA.x, scratchA.z);
      u.state[i] = order === Order.Repair ? UState.Repair : UState.Capture;
      return;
    }
    u.hasGoal[i] = 0;
    if (refKind(target) !== KIND_BUILDING) {
      u.popOrder(i);
      return;
    }
    const b = this.buildings;
    const s = refSlot(target);
    if (order === Order.Repair) {
      const rate = b.maxHp[s] * 0.09;
      b.hp[s] = Math.min(b.maxHp[s], b.hp[s] + rate * dt);
      u.workTimer[i] += dt;
      if (b.hp[s] >= b.maxHp[s] || u.workTimer[i] > 12) {
        u.workTimer[i] = 0;
        u.popOrder(i);
      }
    } else {
      // Capture: the engineer is consumed and the structure changes hands.
      this.transferBuilding(s, u.team[i]);
      this.killUnit(i, false);
    }
  }

  private transferBuilding(slot: number, team: number): void {
    const b = this.buildings;
    const old = b.team[slot];
    if (old === team) return;
    const typeId = b.type[slot];
    if (b.buildProgress[slot] >= 1) {
      this.teams[old].buildings[typeId]--;
      this.teams[team].buildings[typeId]++;
    } else {
      this.teams[old].pending[typeId]--;
      this.teams[team].pending[typeId]++;
    }
    b.team[slot] = team;
    b.hp[slot] = Math.max(b.hp[slot], b.maxHp[slot] * 0.5);
    b.queues[slot].items.length = 0;
    b.queues[slot].progress = 0;
    // Swap the mesh so team colour is correct.
    const rig = b.rigs[slot];
    if (rig) {
      rig.root.removeFromParent();
      rig.dispose?.();
    }
    const stats = BUILDING_LIST[typeId];
    const models = this.models();
    let next;
    try {
      next = models
        ? models.createBuilding(stats.type, this.factionOf(team), team as Team)
        : this.placeholder.createBuilding(stats.type, this.factionOf(team), team as Team);
    } catch {
      next = this.placeholder.createBuilding(stats.type, this.factionOf(team), team as Team);
    }
    b.rigs[slot] = next;
    next.root.position.set(b.px[slot], b.py[slot], b.pz[slot]);
    next.root.rotation.set(0, b.yaw[slot], 0);
    next.setBuildProgress?.(b.buildProgress[slot]);
    this.entityRoot.add(next.root);
    this.recomputePower();
  }

  private tickHarvester(i: number, dt: number, order: number, head: number): void {
    const u = this.units;
    const cap = UNIT_LIST[u.type[i]].cargo ?? 0;
    const team = u.team[i];

    if (order === Order.Harvest && u.state[i] === UState.Idle) {
      const f = this.fieldNear(u.orderX[head], u.orderZ[head]);
      if (f >= 0) this.assignField(i, f);
      u.popOrder(i);
    }

    switch (u.state[i]) {
      case UState.HarvestSeek: {
        const dx = u.px[i] - u.mineX[i];
        const dz = u.pz[i] - u.mineZ[i];
        if (dx * dx + dz * dz < 90) {
          u.state[i] = UState.HarvestMine;
          u.hasGoal[i] = 0;
        } else {
          this.setGoal(i, u.mineX[i], u.mineZ[i]);
        }
        break;
      }
      case UState.HarvestMine: {
        const field = u.resourceField[i];
        const got = this.resources.take(field, MINE_RATE * dt);
        u.cargo[i] += got;
        u.hasGoal[i] = 0;
        if (u.cargo[i] >= cap || got <= 0) {
          if (u.cargo[i] <= 0.5 && got <= 0) {
            // Deposit is dry — go find another before heading home.
            const next = this.resources.best(u.px[i], u.pz[i], field);
            if (next >= 0) {
              this.assignField(i, next);
              break;
            }
          }
          u.state[i] = UState.HarvestReturn;
        }
        break;
      }
      case UState.HarvestReturn: {
        const home = this.nearestRefinery(team, u.px[i], u.pz[i]);
        if (home < 0) {
          u.state[i] = UState.Idle;
          break;
        }
        const b = this.buildings;
        const dock = (BUILDING_LIST[b.type[home]].footprint * NAV_CELL) / 2 + 7;
        const dx = u.px[i] - b.px[home];
        const dz = u.pz[i] - b.pz[home];
        if (dx * dx + dz * dz < dock * dock) {
          u.state[i] = UState.HarvestUnload;
          u.hasGoal[i] = 0;
        } else {
          this.setGoal(i, b.px[home], b.pz[home]);
          u.arriveRadius[i] = dock;
        }
        break;
      }
      case UState.HarvestUnload: {
        const give = Math.min(u.cargo[i], UNLOAD_RATE * dt);
        u.cargo[i] -= give;
        this.teams[team].earn(give);
        u.hasGoal[i] = 0;
        if (u.cargo[i] <= 0.01) {
          u.arriveRadius[i] = UNIT_LIST[u.type[i]].radius * 1.6;
          const f = this.resources.best(u.px[i], u.pz[i]);
          if (f >= 0) this.assignField(i, f);
          else u.state[i] = UState.Idle;
        }
        break;
      }
      default: {
        // Idle harvester: pick a deposit and get to work.
        const f = this.resources.best(u.px[i], u.pz[i]);
        if (f >= 0 && this.nearestRefinery(team, u.px[i], u.pz[i]) >= 0) this.assignField(i, f);
        else u.hasGoal[i] = 0;
        break;
      }
    }
  }

  private assignField(i: number, field: number): void {
    const u = this.units;
    if (u.resourceField[i] >= 0) this.resources.claims[u.resourceField[i]]--;
    u.resourceField[i] = field;
    this.resources.claims[field]++;
    const f = RESOURCE_FIELDS[field];
    // Deterministic scatter so harvesters do not all mine the same square metre.
    const a = (i * 2.399963) % (Math.PI * 2);
    const r = f.radius * (0.25 + 0.6 * ((i * 0.37) % 1));
    this.nav.nearestPassable(f.x + Math.cos(a) * r, f.z + Math.sin(a) * r, this.navScratch);
    u.mineX[i] = this.navScratch[0];
    u.mineZ[i] = this.navScratch[1];
    u.state[i] = UState.HarvestSeek;
  }

  private fieldNear(x: number, z: number): number {
    let best = -1;
    let bestD = 90 * 90;
    for (let f = 0; f < RESOURCE_FIELDS.length; f++) {
      const dx = RESOURCE_FIELDS[f].x - x;
      const dz = RESOURCE_FIELDS[f].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  nearestRefinery(team: number, x: number, z: number): number {
    const b = this.buildings;
    b.refreshLive();
    let best = -1;
    let bestD = Infinity;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] !== team || b.type[i] !== BUILDING_ID.refinery || b.buildProgress[i] < 1) continue;
      const d = (b.px[i] - x) ** 2 + (b.pz[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /* ---------------- movement ---------------- */

  private setGoal(i: number, x: number, z: number): void {
    const u = this.units;
    if (u.hasGoal[i] && Math.abs(u.goalX[i] - x) < 2 && Math.abs(u.goalZ[i] - z) < 2) {
      if (u.repathTimer[i] > 0) return;
    }
    u.goalX[i] = x;
    u.goalZ[i] = z;
    u.hasGoal[i] = 1;
    u.fieldId[i] = this.flow.request(x, z);
    u.repathTimer[i] = 2.5;
  }

  private tickUnitMove(i: number, dt: number): void {
    const u = this.units;
    const stats = UNIT_LIST[u.type[i]];
    const maxSpeed = stats.speed;

    let dirX = 0;
    let dirZ = 0;
    let want = 0;

    if (u.hasGoal[i]) {
      const dx = u.goalX[i] - u.px[i];
      const dz = u.goalZ[i] - u.pz[i];
      const dist = Math.hypot(dx, dz);
      if (dist < u.arriveRadius[i]) {
        u.hasGoal[i] = 0;
      } else {
        let ok = false;
        if (dist > 26) {
          this.flow.touch(u.fieldId[i]);
          ok = this.flow.sample(u.fieldId[i], u.px[i], u.pz[i], this.dirScratch);
          if (ok) {
            dirX = this.dirScratch[0];
            dirZ = this.dirScratch[1];
          }
        }
        if (!ok) {
          dirX = dx / dist;
          dirZ = dz / dist;
        }
        // Ease off over the last few metres so nothing arrives at full tilt.
        want = maxSpeed * clamp(dist / (maxSpeed * 0.8), 0.18, 1);
      }
    }

    // Local avoidance: separation from close neighbours plus a lateral nudge
    // around whoever is directly in front.
    let avoidX = 0;
    let avoidZ = 0;
    const r = stats.radius;
    const count = this.unitHash.query(u.px[i], u.pz[i], r + 11, this.neighbours);
    for (let n = 0; n < count; n++) {
      const j = this.neighbours[n];
      if (j === i) continue;
      const dx = u.px[i] - u.px[j];
      const dz = u.pz[i] - u.pz[j];
      const d2 = dx * dx + dz * dz;
      const rr = r + UNIT_LIST[u.type[j]].radius;
      if (d2 > (rr + 6) * (rr + 6) || d2 < 1e-5) continue;
      const d = Math.sqrt(d2);
      if (d < rr) {
        // Hard overlap: push apart positionally, splitting the correction.
        const push = (rr - d) * 0.5;
        u.pushX[i] += (dx / d) * push;
        u.pushZ[i] += (dz / d) * push;
        avoidX += (dx / d) * 1.4;
        avoidZ += (dz / d) * 1.4;
      } else if (want > 0) {
        const ahead = (-dx * dirX - dz * dirZ) / d;
        if (ahead > 0.35) {
          // Steer around rather than through: pick the side we are already on.
          const side = dirX * -dz + dirZ * dx > 0 ? 1 : -1;
          const w = ((rr + 6 - d) / 6) * ahead;
          avoidX += -dirZ * side * w;
          avoidZ += dirX * side * w;
        }
      }
    }

    if (want > 0) {
      dirX += avoidX * 0.9;
      dirZ += avoidZ * 0.9;
      const len = Math.hypot(dirX, dirZ);
      if (len > 1e-4) {
        dirX /= len;
        dirZ /= len;
      }
    } else if (this.refValid(u.targetRef[i]) && this.refPos(u.targetRef[i], scratchA)) {
      // Standing and firing: face the target with the hull.
      dirX = scratchA.x - u.px[i];
      dirZ = scratchA.z - u.pz[i];
      const len = Math.hypot(dirX, dirZ) || 1;
      dirX /= len;
      dirZ /= len;
    }

    // Finite turn rate. Tracked hulls must be nearly aligned before they roll.
    let turn = 0;
    if (dirX !== 0 || dirZ !== 0) {
      const desired = Math.atan2(dirX, dirZ);
      let delta = desired - u.yaw[i];
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const maxTurn = stats.turnRate * dt;
      turn = clamp(delta, -maxTurn, maxTurn);
      u.yaw[i] += turn;
      const align = stats.locomotion === 'infantry' ? 0.25 : 1.0;
      const err = Math.abs(delta);
      want *= clamp(1 - (err / Math.PI) * 2.2 * align, 0, 1);
    }
    u.turn[i] = turn / Math.max(dt, 1e-5);

    // Acceleration and braking.
    const accel = maxSpeed * (stats.locomotion === 'infantry' ? 6 : 2.4);
    const brake = maxSpeed * 4;
    if (want > u.spd[i]) u.spd[i] = Math.min(want, u.spd[i] + accel * dt);
    else u.spd[i] = Math.max(want, u.spd[i] - brake * dt);
    if (u.spd[i] < 0.02) u.spd[i] = 0;

    const sx = Math.sin(u.yaw[i]) * u.spd[i] * dt + u.pushX[i];
    const sz = Math.cos(u.yaw[i]) * u.spd[i] * dt + u.pushZ[i];

    let nx = u.px[i] + sx;
    let nz = u.pz[i] + sz;
    if (!this.nav.passableAt(nx, nz)) {
      // Slide along whichever axis is still open.
      if (this.nav.passableAt(nx, u.pz[i])) nz = u.pz[i];
      else if (this.nav.passableAt(u.px[i], nz)) nx = u.px[i];
      else {
        nx = u.px[i];
        nz = u.pz[i];
        u.spd[i] *= 0.4;
      }
    }
    u.px[i] = nx;
    u.pz[i] = nz;
    u.py[i] = heightAt(nx, nz);
    this.nav.sampleNormal(nx, nz, this.normalScratch);
    u.nx[i] = this.normalScratch[0];
    u.ny[i] = this.normalScratch[1];
    u.nz[i] = this.normalScratch[2];

    // Stuck detection: crawling while still far from the goal means the route
    // is blocked by traffic. Give up on the exact goal rather than shove.
    if (u.hasGoal[i]) {
      if (u.spd[i] < maxSpeed * 0.12) {
        u.stuck[i] += dt;
        if (u.stuck[i] > 2.6) {
          u.stuck[i] = 0;
          const dx = u.goalX[i] - u.px[i];
          const dz = u.goalZ[i] - u.pz[i];
          if (dx * dx + dz * dz < 40 * 40) {
            u.hasGoal[i] = 0;
            const head = u.peekOrder(i);
            if (head >= 0 && (u.orderType[head] === Order.Move || u.orderType[head] === Order.AttackMove)) {
              u.popOrder(i);
            }
          } else {
            u.repathTimer[i] = 0;
            u.fieldId[i] = this.flow.request(u.goalX[i], u.goalZ[i]);
          }
        }
      } else {
        u.stuck[i] = 0;
      }
    } else {
      u.stuck[i] = 0;
    }
  }

  /* ---------------- combat ---------------- */

  private inWeaponRange(i: number, target: number): boolean {
    const w = UNIT_WEAPON[this.units.type[i]];
    if (w < 0 || !this.refValid(target)) return false;
    const range = WEAPONS[w].range + this.refRadius(target);
    if (!this.refPos(target, scratchA)) return false;
    const dx = scratchA.x - this.units.px[i];
    const dz = scratchA.z - this.units.pz[i];
    return dx * dx + dz * dz <= range * range;
  }

  private hasFireLine(i: number, target: number): boolean {
    const w = UNIT_WEAPON[this.units.type[i]];
    if (w < 0) return false;
    if (PROJ_KIND[w] === PROJ_BALLISTIC) return true; // indirect fire arcs over
    if (!this.refPos(target, scratchA)) return false;
    return this.nav.hasLineOfSight(
      this.units.px[i], this.units.pz[i], this.units.py[i] + 2.4,
      scratchA.x, scratchA.z, scratchA.y,
    );
  }

  private tickUnitWeapon(i: number, dt: number): void {
    const u = this.units;
    const weaponId = UNIT_WEAPON[u.type[i]];
    if (weaponId < 0) return;
    const weapon = WEAPONS[weaponId];
    const rig = u.rigs[i];

    if (u.cooldown[i] > 0) u.cooldown[i] -= dt;

    if (u.stance[i] === Stance.HoldFire) {
      const head = u.peekOrder(i);
      if (!(head >= 0 && u.orderType[head] === Order.Attack)) {
        u.targetRef[i] = NO_REF;
        return;
      }
    }

    if (u.retarget[i] <= 0) {
      u.retarget[i] = RETARGET_PERIOD;
      const head = u.peekOrder(i);
      const forced = head >= 0 && u.orderType[head] === Order.Attack ? u.orderRef[head] : NO_REF;
      if (forced !== NO_REF && this.refValid(forced)) u.targetRef[i] = forced;
      else if (!this.refValid(u.targetRef[i]) || !this.inWeaponRange(i, u.targetRef[i])) {
        u.targetRef[i] = this.acquireTarget(u.px[i], u.pz[i], u.team[i], weaponId, UNIT_LIST[u.type[i]].sight);
      }
    }

    const target = u.targetRef[i];
    if (!this.refValid(target)) return;
    if (!this.refPos(target, scratchA)) return;

    rig?.aimAt?.(scratchA, dt);

    if (!this.inWeaponRange(i, target) || !this.hasFireLine(i, target)) return;

    // Aim gating: turret error from the rig when it has one, hull error when
    // it does not.
    let aimErr = rig?.aimError ? rig.aimError() : Number.NaN;
    if (!Number.isFinite(aimErr) || (rig && !rig.aimError)) {
      const desired = Math.atan2(scratchA.x - u.px[i], scratchA.z - u.pz[i]);
      let d = desired - u.yaw[i];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      aimErr = Math.abs(d);
    }
    if (aimErr > 0.16) return;

    if (u.burstLeft[i] > 0) {
      u.burstTimer[i] -= dt;
      if (u.burstTimer[i] <= 0) {
        this.fireShot(this.units.ref(i), i, KIND_UNIT, weaponId, target);
        u.burstLeft[i]--;
        u.burstTimer[i] = weapon.burstDelay ?? 0.1;
        if (u.burstLeft[i] <= 0) u.cooldown[i] = weapon.cooldown;
      }
      return;
    }
    if (u.cooldown[i] <= 0) {
      u.burstLeft[i] = Math.max(1, weapon.burst ?? 1);
      u.burstTimer[i] = 0;
      u.cooldown[i] = weapon.cooldown;
      this.fireShot(this.units.ref(i), i, KIND_UNIT, weaponId, target);
      u.burstLeft[i]--;
      u.burstTimer[i] = weapon.burstDelay ?? 0.1;
    }
  }

  /**
   * Target selection. Scores by how much the weapon actually hurts the
   * candidate, how dangerous the candidate is, and distance — so rocketeers
   * pick tanks out of a crowd and flak tracks pick infantry.
   */
  private acquireTarget(x: number, z: number, team: number, weaponId: number, sight: number): number {
    const weapon = WEAPONS[weaponId];
    const vsTable = WEAPON_VS[weaponId];
    const reach = Math.max(sight, weapon.range * 1.35);
    let best = NO_REF;
    let bestScore = 0;

    const u = this.units;
    const count = this.unitHash.query(x, z, reach, this.neighbours);
    for (let n = 0; n < count; n++) {
      const j = this.neighbours[n];
      if (u.team[j] === team || !u.alive[j]) continue;
      const dx = u.px[j] - x;
      const dz = u.pz[j] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach) continue;
      const mult = vsTable[UNIT_ARMOUR[u.type[j]]];
      if (mult < 0.05) continue;
      const threat = UNIT_IS_CIVILIAN[u.type[j]] ? 0.4 : 1.4;
      const score = (mult * threat * 1000) / (60 + Math.sqrt(d2));
      if (score > bestScore) {
        bestScore = score;
        best = this.units.ref(j);
      }
    }

    // Structures are worth shooting only when nothing softer is in reach.
    const b = this.buildings;
    for (let n = 0; n < b.liveCount; n++) {
      const j = b.live[n];
      if (b.team[j] === team) continue;
      const dx = b.px[j] - x;
      const dz = b.pz[j] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach) continue;
      const mult = vsTable[ARMOUR_STRUCTURE];
      if (mult < 0.05) continue;
      const defensive = BUILDING_WEAPON[b.type[j]] >= 0 ? 1.6 : 0.55;
      const score = (mult * defensive * 1000) / (60 + Math.sqrt(d2));
      if (score > bestScore) {
        bestScore = score;
        best = this.buildings.ref(j);
      }
    }
    return best;
  }

  private fireShot(shooter: number, slot: number, kind: number, weaponId: number, target: number): void {
    const weapon = WEAPONS[weaponId];
    const rig = kind === KIND_UNIT ? this.units.rigs[slot] : this.buildings.rigs[slot];
    const team = kind === KIND_UNIT ? this.units.team[slot] : this.buildings.team[slot];

    if (rig?.muzzle) {
      rig.muzzle(scratchB, scratchC);
    } else if (kind === KIND_UNIT) {
      scratchB.set(this.units.px[slot], this.units.py[slot] + 2.2, this.units.pz[slot]);
      scratchC.set(Math.sin(this.units.yaw[slot]), 0, Math.cos(this.units.yaw[slot]));
    } else {
      scratchB.set(this.buildings.px[slot], this.buildings.py[slot] + 6, this.buildings.pz[slot]);
      scratchC.set(0, 0, 1);
    }
    rig?.recoil?.(weapon.weaponClass === 'cannon' ? 0.9 : 0.35);

    const fx = tryGet('effects');
    const audio = tryGet('audio');
    if (fx) fx.muzzleFlash(scratchB, scratchC, weapon.weaponClass === 'cannon' ? 2.4 : 1.1);
    else this.vfx.muzzleFlash(scratchB.x, scratchB.y, scratchB.z, scratchC.x, scratchC.y, scratchC.z,
      weapon.weaponClass === 'cannon' ? 2.4 : 1.1);
    audio?.play(`weapon_${weapon.weaponClass}`, scratchB, 1, 1);

    const projKind = PROJ_KIND[weaponId];
    if (projKind === PROJ_HITSCAN) {
      if (!this.refPos(target, scratchA)) return;
      if (fx) fx.tracer(scratchB, scratchA, 0xffdca0, 900);
      else this.vfx.beam(scratchB.x, scratchB.y, scratchB.z, scratchA.x, scratchA.y, scratchA.z, 0.14);
      this.damageRef(target, weapon.damage, weaponId, team, shooter);
      if (weapon.splash > 0) {
        this.splashDamage(scratchA.x, scratchA.y, scratchA.z, weapon.splash, weapon.damage * 0.5, weaponId, team, target);
      }
      return;
    }
    this.spawnProjectile(weaponId, projKind, team, scratchB, target, shooter);
  }

  private spawnProjectile(
    weaponId: number, kind: number, team: number, from: THREE.Vector3, target: number, owner: number,
  ): void {
    const p = this.projectiles;
    const i = p.alloc();
    if (i < 0) return;
    const weapon = WEAPONS[weaponId];
    if (!this.refPos(target, scratchA)) {
      p.free(i);
      return;
    }
    p.kind[i] = kind;
    p.team[i] = team;
    p.weapon[i] = weaponId;
    p.px[i] = from.x;
    p.py[i] = from.y;
    p.pz[i] = from.z;
    p.damage[i] = weapon.damage;
    p.splash[i] = weapon.splash;
    p.targetRef[i] = target;
    p.targetX[i] = scratchA.x;
    p.targetY[i] = scratchA.y;
    p.targetZ[i] = scratchA.z;
    p.ownerRef[i] = owner;
    p.life[i] = 9;

    const dx = scratchA.x - from.x;
    const dy = scratchA.y - from.y;
    const dz = scratchA.z - from.z;
    const flat = Math.hypot(dx, dz) || 0.001;
    const speed = weapon.projectileSpeed;

    if (kind === PROJ_BALLISTIC) {
      // Solve the high-arc launch angle so the shell lobs over intervening
      // terrain rather than driving through it.
      const v2 = speed * speed;
      const disc = v2 * v2 - GRAVITY * (GRAVITY * flat * flat + 2 * dy * v2);
      const tan = disc > 0
        ? (v2 + Math.sqrt(disc)) / (GRAVITY * flat)
        : 1;
      const cos = 1 / Math.sqrt(1 + tan * tan);
      const sin = tan * cos;
      p.vx[i] = (dx / flat) * speed * cos;
      p.vz[i] = (dz / flat) * speed * cos;
      p.vy[i] = speed * sin;
    } else {
      // Lead the target a little so fast movers are not trivially dodged.
      let lead = 0;
      if (refKind(target) === KIND_UNIT) {
        const s = refSlot(target);
        lead = flat / speed;
        p.targetX[i] += Math.sin(this.units.yaw[s]) * this.units.spd[s] * lead;
        p.targetZ[i] += Math.cos(this.units.yaw[s]) * this.units.spd[s] * lead;
      }
      const ax = p.targetX[i] - from.x;
      const az = p.targetZ[i] - from.z;
      const len = Math.hypot(ax, dy, az) || 1;
      p.vx[i] = (ax / len) * speed;
      p.vy[i] = (dy / len) * speed + (kind === PROJ_HOMING ? 3 : 0);
      p.vz[i] = (az / len) * speed;
    }
  }

  private tickProjectiles(dt: number): void {
    const p = this.projectiles;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (!p.alive[i]) continue;
      p.life[i] -= dt;
      if (p.life[i] <= 0) {
        this.detonate(i, p.px[i], p.py[i], p.pz[i]);
        continue;
      }
      const kind = p.kind[i];

      if (kind === PROJ_BALLISTIC) {
        p.vy[i] -= GRAVITY * dt;
      } else if (kind === PROJ_HOMING) {
        if (this.refPos(p.targetRef[i], scratchA)) {
          p.targetX[i] = scratchA.x;
          p.targetY[i] = scratchA.y;
          p.targetZ[i] = scratchA.z;
        }
        const dx = p.targetX[i] - p.px[i];
        const dy = p.targetY[i] - p.py[i];
        const dz = p.targetZ[i] - p.pz[i];
        const d = Math.hypot(dx, dy, dz) || 1;
        const speed = Math.hypot(p.vx[i], p.vy[i], p.vz[i]) || 1;
        // Blend the velocity toward the bearing: a finite turn rate, cheaply.
        const k = Math.min(1, 5.5 * dt);
        p.vx[i] += ((dx / d) * speed - p.vx[i]) * k;
        p.vy[i] += ((dy / d) * speed - p.vy[i]) * k;
        p.vz[i] += ((dz / d) * speed - p.vz[i]) * k;
        const norm = Math.hypot(p.vx[i], p.vy[i], p.vz[i]) || 1;
        p.vx[i] = (p.vx[i] / norm) * speed;
        p.vy[i] = (p.vy[i] / norm) * speed;
        p.vz[i] = (p.vz[i] / norm) * speed;
      }

      const nx = p.px[i] + p.vx[i] * dt;
      const ny = p.py[i] + p.vy[i] * dt;
      const nz = p.pz[i] + p.vz[i] * dt;

      // Direct hit test against the intended target.
      if (this.refPos(p.targetRef[i], scratchA)) {
        const hitR = this.refRadius(p.targetRef[i]) + 1.6;
        const dx = scratchA.x - nx;
        const dy = scratchA.y - ny;
        const dz = scratchA.z - nz;
        if (dx * dx + dy * dy + dz * dz < hitR * hitR) {
          this.detonate(i, scratchA.x, scratchA.y, scratchA.z);
          continue;
        }
      }

      const ground = heightAt(nx, nz);
      if (ny <= ground) {
        this.detonate(i, nx, ground, nz);
        continue;
      }
      if (kind !== PROJ_HOMING) {
        // Overshoot check for flat trajectories.
        const toX = p.targetX[i] - nx;
        const toZ = p.targetZ[i] - nz;
        if (toX * p.vx[i] + toZ * p.vz[i] < 0) {
          this.detonate(i, p.targetX[i], Math.max(ground, p.targetY[i]), p.targetZ[i]);
          continue;
        }
      }
      p.px[i] = nx;
      p.py[i] = ny;
      p.pz[i] = nz;
    }
  }

  private detonate(i: number, x: number, y: number, z: number): void {
    const p = this.projectiles;
    const weaponId = p.weapon[i];
    const weapon = WEAPONS[weaponId];
    const team = p.team[i];
    const target = p.targetRef[i];

    if (this.refValid(target) && this.refPos(target, scratchA)) {
      const hitR = this.refRadius(target) + 2.5;
      if ((scratchA.x - x) ** 2 + (scratchA.z - z) ** 2 < hitR * hitR) {
        this.damageRef(target, p.damage[i], weaponId, team, p.ownerRef[i]);
      }
    }
    if (p.splash[i] > 0) {
      this.splashDamage(x, y, z, p.splash[i], p.damage[i] * 0.75, weaponId, team, target);
    }

    const scale = weapon.splash > 0 ? 1.2 + weapon.splash * 0.22 : 1.1;
    const fx = tryGet('effects');
    scratchB.set(x, y, z);
    if (fx) fx.explosion(scratchB, scale, weapon.weaponClass === 'rocket' ? 'rocket' : 'shell');
    else this.vfx.explosion(x, y, z, scale, 'shell');
    tryGet('decals')?.add('scorch', x, z, scale * 3.2, 0, 30);
    if (weapon.splash > 4) tryGet('decals')?.add('crater', x, z, weapon.splash * 0.9, 0, 90);
    tryGet('audio')?.play('explosion', scratchB, 1, 1);

    p.free(i);
  }

  splashDamage(
    x: number, y: number, z: number, radius: number, damage: number,
    weaponId: number, team: number, exclude: number,
  ): void {
    const u = this.units;
    const count = this.unitHash.query(x, z, radius + 4, this.neighbours);
    for (let n = 0; n < count; n++) {
      const j = this.neighbours[n];
      if (!u.alive[j] || u.team[j] === team) continue;
      const ref = this.units.ref(j);
      if (ref === exclude) continue;
      const d = Math.hypot(u.px[j] - x, u.pz[j] - z) - UNIT_LIST[u.type[j]].radius;
      if (d > radius) continue;
      const falloff = 1 - Math.max(0, d) / radius;
      this.damageRef(ref, damage * falloff * falloff, weaponId, team, NO_REF);
    }
    const b = this.buildings;
    for (let n = 0; n < b.liveCount; n++) {
      const j = b.live[n];
      if (b.team[j] === team) continue;
      const ref = this.buildings.ref(j);
      if (ref === exclude) continue;
      const half = (BUILDING_LIST[b.type[j]].footprint * NAV_CELL) / 2;
      const d = Math.hypot(b.px[j] - x, b.pz[j] - z) - half;
      if (d > radius) continue;
      const falloff = 1 - Math.max(0, d) / radius;
      this.damageRef(ref, damage * falloff * falloff, weaponId, team, NO_REF);
    }
  }

  damageRef(ref: number, amount: number, weaponId: number, team: number, source: number): void {
    if (!this.refValid(ref)) return;
    const armour = this.refArmour(ref);
    const dmg = amount * WEAPON_VS[weaponId][armour];
    if (dmg <= 0) return;
    const slot = refSlot(ref);
    if (refKind(ref) === KIND_UNIT) {
      const u = this.units;
      if (u.team[slot] === team) return;
      u.hp[slot] -= dmg;
      u.lastHit[slot] = this.matchTime;
      this.refreshDamageState(ref, slot);
      // Retaliate when idle so units are not shot in the back without reacting.
      if (source !== NO_REF && !this.refValid(u.targetRef[slot]) && u.stance[slot] !== Stance.HoldFire) {
        u.targetRef[slot] = source;
      }
      if (u.hp[slot] <= 0) {
        this.teams[team].kills++;
        this.killUnit(slot, true);
      }
    } else {
      const b = this.buildings;
      if (b.team[slot] === team) return;
      b.hp[slot] -= dmg;
      b.lastHit[slot] = this.matchTime;
      this.refreshDamageState(ref, slot);
      if (b.team[slot] === this.options.playerTeam && this.tickCount % 60 === 0) {
        this.pushAlert('baseUnderAttack', 'Base under attack', b.px[slot], b.pz[slot]);
      }
      if (b.hp[slot] <= 0) {
        this.teams[team].kills++;
        this.killBuilding(slot);
      }
    }
  }

  private refreshDamageState(ref: number, slot: number): void {
    const isUnit = refKind(ref) === KIND_UNIT;
    const hp = isUnit ? this.units.hp[slot] : this.buildings.hp[slot];
    const max = isUnit ? this.units.maxHp[slot] : this.buildings.maxHp[slot];
    const state: DamageState = damageStateFor(Math.max(0, hp), max);
    const idx = state === 'pristine' ? 0 : state === 'damaged' ? 1 : 2;
    const store = isUnit ? this.units.damageState : this.buildings.damageState;
    if (store[slot] === idx) return;
    store[slot] = idx;
    const rig = isUnit ? this.units.rigs[slot] : this.buildings.rigs[slot];
    rig?.setDamageState?.(state);
  }

  killUnit(slot: number, explode: boolean): void {
    const u = this.units;
    if (!u.alive[slot]) return;
    const typeId = u.type[slot];
    const team = u.team[slot];
    const stats = UNIT_LIST[typeId];
    if (u.resourceField[slot] >= 0) this.resources.claims[u.resourceField[slot]]--;

    if (explode) {
      const scale = stats.radius * 0.9;
      scratchB.set(u.px[slot], u.py[slot] + 1, u.pz[slot]);
      const fx = tryGet('effects');
      if (fx) fx.explosion(scratchB, scale, stats.locomotion === 'infantry' ? 'shell' : 'vehicle');
      else this.vfx.explosion(scratchB.x, scratchB.y, scratchB.z, scale, 'vehicle');
      tryGet('decals')?.add('scorch', u.px[slot], u.pz[slot], stats.radius * 2.4, 0, 45);
      tryGet('audio')?.play('unit_death', scratchB, 1, 1);
    }

    const rig = u.rigs[slot];
    if (rig) {
      const linger = rig.die?.() ?? 0;
      if (linger > 0) this.corpses.push({ rig, timer: linger });
      else {
        rig.root.removeFromParent();
        rig.dispose?.();
      }
    }

    this.teams[team].units[typeId]--;
    this.teams[team].losses++;
    if (team === this.options.playerTeam) {
      this.pushAlert(
        stats.cargo ? 'harvesterLost' : 'unitLost',
        stats.cargo ? 'Harvester lost' : `${stats.label} lost`,
        u.px[slot], u.pz[slot],
      );
    }
    u.free(slot);
  }

  killBuilding(slot: number): void {
    const b = this.buildings;
    if (!b.alive[slot]) return;
    const typeId = b.type[slot];
    const team = b.team[slot];
    const stats = BUILDING_LIST[typeId];
    const size = stats.footprint * NAV_CELL;

    scratchB.set(b.px[slot], b.py[slot] + 4, b.pz[slot]);
    const fx = tryGet('effects');
    if (fx) fx.explosion(scratchB, size * 0.32, 'building');
    else this.vfx.explosion(scratchB.x, scratchB.y, scratchB.z, size * 0.3, 'building');
    tryGet('decals')?.add('rubble', b.px[slot], b.pz[slot], size * 0.8, 0, 600);
    tryGet('audio')?.play('building_death', scratchB, 1, 1);

    this.nav.setFootprint(b.px[slot], b.pz[slot], stats.footprint, false);
    if (b.buildProgress[slot] >= 1) this.teams[team].buildings[typeId]--;
    else this.teams[team].pending[typeId]--;
    this.teams[team].losses++;

    const rig = b.rigs[slot];
    if (rig) {
      const linger = rig.die?.() ?? 0;
      if (linger > 0) this.corpses.push({ rig, timer: linger });
      else {
        rig.root.removeFromParent();
        rig.dispose?.();
      }
    }
    b.free(slot);
    this.recomputePower();
  }

  private reapDead(): void {
    // Deaths are applied immediately in damageRef; this pass only refreshes the
    // live lists so the next tick iterates a compact array.
    this.units.refreshLive();
    this.buildings.refreshLive();
  }

  /* ================================================================== *
   * Structures
   * ================================================================== */

  private tickBuildings(dt: number): void {
    const b = this.buildings;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      const typeId = b.type[i];
      const stats = BUILDING_LIST[typeId];
      const team = this.teams[b.team[i]];

      if (b.buildProgress[i] < 1) {
        const erect = Math.min(7, stats.buildTime * 0.4);
        b.buildProgress[i] = Math.min(1, b.buildProgress[i] + (dt / erect) * team.buildSpeed);
        b.hp[i] = stats.hp * (0.35 + 0.65 * b.buildProgress[i]);
        b.rigs[i]?.setBuildProgress?.(b.buildProgress[i]);
        if (b.buildProgress[i] >= 1) this.completeBuilding(i);
        continue;
      }

      if (stats.produces) this.tickProduction(i, dt);
      if (BUILDING_WEAPON[typeId] >= 0) this.tickTurret(i, dt);
    }

    this.tickConstruction(dt);
  }

  private tickProduction(i: number, dt: number): void {
    const b = this.buildings;
    const q = b.queues[i];
    b.active[i] = q.items.length > 0 ? 1 : 0;
    b.rigs[i]?.setActive?.(q.items.length > 0);
    if (q.items.length === 0) return;

    const team = this.teams[b.team[i]];
    const typeId = q.items[0];
    const stats = UNIT_LIST[typeId];
    const rate = (dt / stats.buildTime) * team.buildSpeed;
    const wantSpend = stats.cost * rate;
    if (team.credits < wantSpend) {
      if (b.team[i] === this.options.playerTeam && this.tickCount % 90 === 0) {
        this.pushAlert('insufficientFunds', 'Insufficient funds');
      }
      return;
    }
    team.credits -= wantSpend;
    q.spent += wantSpend;
    q.progress += rate;
    if (q.progress < 1) return;

    q.progress = 0;
    q.spent = 0;
    q.items.shift();

    if (this.teams[b.team[i]].units.reduce(sumInt, 0) >= UNIT_CAP) {
      team.credits += stats.cost * 0.9;
      return;
    }

    const half = (BUILDING_LIST[b.type[i]].footprint * NAV_CELL) / 2;
    const a = b.yaw[i];
    const ex = b.px[i] + Math.sin(a) * (half + 6);
    const ez = b.pz[i] + Math.cos(a) * (half + 6);
    this.nav.nearestPassable(ex, ez, this.navScratch);
    const slot = this.spawnUnit(typeId, b.team[i], this.navScratch[0], this.navScratch[1], a);
    if (slot < 0) return;
    if (b.hasRally[i]) {
      this.units.pushOrder(slot, Order.Move, b.rallyX[i], b.rallyZ[i], NO_REF);
    }
    if (b.team[i] === this.options.playerTeam) {
      this.pushAlert('unitReady', `${stats.label} ready`, b.px[i], b.pz[i]);
    }
  }

  private tickTurret(i: number, dt: number): void {
    const b = this.buildings;
    const weaponId = BUILDING_WEAPON[b.type[i]];
    const weapon = WEAPONS[weaponId];
    if (b.cooldown[i] > 0) b.cooldown[i] -= dt;
    b.retarget[i] -= dt;
    if (b.retarget[i] <= 0) {
      b.retarget[i] = RETARGET_PERIOD;
      if (!this.refValid(b.targetRef[i])) {
        b.targetRef[i] = this.acquireTarget(
          b.px[i], b.pz[i], b.team[i], weaponId, BUILDING_LIST[b.type[i]].sight,
        );
      }
    }
    const target = b.targetRef[i];
    if (!this.refValid(target) || !this.refPos(target, scratchA)) return;
    const range = weapon.range + this.refRadius(target);
    if ((scratchA.x - b.px[i]) ** 2 + (scratchA.z - b.pz[i]) ** 2 > range * range) {
      b.targetRef[i] = NO_REF;
      return;
    }
    const rig = b.rigs[i];
    rig?.aimAt?.(scratchA, dt);
    const err = rig?.aimError ? rig.aimError() : 0;
    if (err > 0.16) return;

    if (b.burstLeft[i] > 0) {
      b.burstTimer[i] -= dt;
      if (b.burstTimer[i] <= 0) {
        this.fireShot(this.buildings.ref(i), i, KIND_BUILDING, weaponId, target);
        b.burstLeft[i]--;
        b.burstTimer[i] = weapon.burstDelay ?? 0.12;
      }
      return;
    }
    if (b.cooldown[i] <= 0) {
      b.cooldown[i] = weapon.cooldown;
      b.burstLeft[i] = Math.max(1, weapon.burst ?? 1) - 1;
      b.burstTimer[i] = weapon.burstDelay ?? 0.12;
      this.fireShot(this.buildings.ref(i), i, KIND_BUILDING, weaponId, target);
    }
  }

  /** The construction yard queue: one structure at a time, per team. */
  private tickConstruction(dt: number): void {
    for (const team of this.teams) {
      const q = team.construction;
      if (q.items.length === 0 || team.readyBuilding >= 0) continue;
      if (!team.hasHq) continue;
      const typeId = q.items[0];
      const stats = BUILDING_LIST[typeId];
      const rate = (dt / stats.buildTime) * team.buildSpeed;
      const spend = stats.cost * rate;
      if (team.credits < spend) continue;
      team.credits -= spend;
      q.spent += spend;
      q.progress += rate;
      if (q.progress >= 1) {
        q.progress = 0;
        q.spent = 0;
        q.items.shift();
        team.readyBuilding = typeId;
      }
    }
  }

  /* ================================================================== *
   * Fog of war
   * ================================================================== */

  private updateFog(): void {
    for (let t = 0; t < 2; t++) this.fog.clearVisible(t);
    const u = this.units;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      this.fog.reveal(u.team[i], u.px[i], u.pz[i], UNIT_LIST[u.type[i]].sight);
    }
    const b = this.buildings;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      this.fog.reveal(b.team[i], b.px[i], b.pz[i], BUILDING_LIST[b.type[i]].sight);
    }

    // Hide what the viewing team cannot see. Structures stay drawn once
    // explored — the player remembers where a base was.
    const view = this.options.playerTeam;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      u.visible[i] = u.team[i] === view || this.fog.isVisible(view, u.px[i], u.pz[i]) ? 1 : 0;
    }
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      b.visible[i] = b.team[i] === view || this.fog.isExplored(view, b.px[i], b.pz[i]) ? 1 : 0;
    }
  }

  /* ================================================================== *
   * Presentation
   * ================================================================== */

  private syncRigs(dt: number, alpha: number): void {
    const u = this.units;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      const rig = u.rigs[i];
      if (!rig) continue;
      const x = u.prevX[i] + (u.px[i] - u.prevX[i]) * alpha;
      const y = u.prevY[i] + (u.py[i] - u.prevY[i]) * alpha;
      const z = u.prevZ[i] + (u.pz[i] - u.prevZ[i]) * alpha;
      let dy = u.yaw[i] - u.prevYaw[i];
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      rig.root.position.set(x, y, z);
      // Terrain follow: yaw about the surface normal, so hulls bank on slopes.
      scratchN.set(u.nx[i], u.ny[i], u.nz[i]);
      scratchQ.setFromUnitVectors(UP, scratchN);
      scratchQ2.setFromAxisAngle(UP, u.prevYaw[i] + dy * alpha);
      rig.root.quaternion.copy(scratchQ).multiply(scratchQ2);
      rig.root.visible = u.visible[i] === 1;
      rig.locomote?.(dt, Math.abs(u.spd[i]), u.turn[i]);
    }
    const b = this.buildings;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      const rig = b.rigs[i];
      if (rig) rig.root.visible = b.visible[i] === 1;
    }
  }

  /* ================================================================== *
   * Alerts and queries used by the HUD and the commanders
   * ================================================================== */

  pushAlert(kind: AlertKind, message: string, x?: number, z?: number): void {
    for (const a of this.alerts) {
      if (a.kind === kind && a.age < 3) return;
    }
    const alert: Alert = { kind, message, age: 0 };
    if (x !== undefined && z !== undefined) alert.position = new THREE.Vector3(x, heightAt(x, z), z);
    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS;
  }

  unitCountFor(team: number): number {
    return this.teams[team].units.reduce(sumInt, 0);
  }

  /** Producer structure with the shortest queue that can make `unitTypeId`. */
  findProducer(team: number, unitTypeId: number): number {
    const producerType = UNIT_PRODUCER[unitTypeId];
    if (producerType < 0) return -1;
    const b = this.buildings;
    b.refreshLive();
    let best = -1;
    let bestLen = Infinity;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] !== team || b.type[i] !== producerType || b.buildProgress[i] < 1) continue;
      const len = b.queues[i].items.length;
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    return best;
  }

  /** Tech and power gate for a unit type. Returns null when buildable. */
  unitLockReason(team: number, unitTypeId: number): string | null {
    const stats = UNIT_LIST[unitTypeId];
    if (this.findProducer(team, unitTypeId) < 0) {
      const producerType = UNIT_PRODUCER[unitTypeId];
      return producerType >= 0 ? `Requires ${BUILDING_LIST[producerType].label}` : 'Unavailable';
    }
    if (stats.requires && !this.teams[team].has(BUILDING_ID[stats.requires])) {
      return `Requires ${BUILDING_LIST[BUILDING_ID[stats.requires]].label}`;
    }
    return null;
  }

  buildingLockReason(team: number, buildingTypeId: number): string | null {
    const stats = BUILDING_LIST[buildingTypeId];
    const state = this.teams[team];
    if (!state.hasHq) return 'Requires Construction Yard';
    if (stats.requires && !state.has(BUILDING_ID[stats.requires])) {
      return `Requires ${BUILDING_LIST[BUILDING_ID[stats.requires]].label}`;
    }
    return null;
  }

  queueUnit(team: number, unitTypeId: number): boolean {
    if (this.unitLockReason(team, unitTypeId)) return false;
    const producer = this.findProducer(team, unitTypeId);
    if (producer < 0) return false;
    const q = this.buildings.queues[producer];
    if (q.items.length >= 9) return false;
    q.items.push(unitTypeId);
    return true;
  }

  cancelUnit(team: number, unitTypeId: number): boolean {
    const b = this.buildings;
    b.refreshLive();
    for (let n = b.liveCount - 1; n >= 0; n--) {
      const i = b.live[n];
      if (b.team[i] !== team) continue;
      const q = b.queues[i];
      const idx = q.items.lastIndexOf(unitTypeId);
      if (idx < 0) continue;
      q.items.splice(idx, 1);
      if (idx === 0) {
        this.teams[team].credits += q.spent;
        q.spent = 0;
        q.progress = 0;
      }
      return true;
    }
    return false;
  }

  queueBuilding(team: number, buildingTypeId: number): boolean {
    if (this.buildingLockReason(team, buildingTypeId)) return false;
    const q = this.teams[team].construction;
    if (q.items.length >= 6) return false;
    q.items.push(buildingTypeId);
    this.teams[team].pending[buildingTypeId]++;
    return true;
  }

  cancelBuilding(team: number, buildingTypeId: number): boolean {
    const state = this.teams[team];
    if (state.readyBuilding === buildingTypeId) {
      state.readyBuilding = -1;
      state.credits += BUILDING_LIST[buildingTypeId].cost * 0.9;
      state.pending[buildingTypeId]--;
      return true;
    }
    const q = state.construction;
    const idx = q.items.lastIndexOf(buildingTypeId);
    if (idx < 0) return false;
    q.items.splice(idx, 1);
    state.pending[buildingTypeId]--;
    if (idx === 0) {
      state.credits += q.spent;
      q.spent = 0;
      q.progress = 0;
    }
    return true;
  }

  /** Validates and commits a structure placement from the ready slot. */
  placeReadyBuilding(team: number, x: number, z: number): boolean {
    const state = this.teams[team];
    const typeId = state.readyBuilding;
    if (typeId < 0) return false;
    if (!this.canPlace(team, typeId, x, z)) return false;
    state.readyBuilding = -1;
    state.pending[typeId]--;
    this.spawnBuilding(typeId, team, x, z, false);
    return true;
  }

  canPlace(team: number, typeId: number, x: number, z: number): boolean {
    const stats = BUILDING_LIST[typeId];
    if (!this.footprintClear(stats.footprint, x, z)) return false;
    return this.nearFriendlyBase(team, x, z, 96);
  }

  /* ---------------- order issuing (shared by input and AI) ---------------- */

  issueOrder(slot: number, type: number, x: number, z: number, ref: number, queued: boolean): void {
    const u = this.units;
    if (!u.alive[slot]) return;
    if (!queued) {
      u.clearOrders(slot);
      u.hasGoal[slot] = 0;
      u.targetRef[slot] = NO_REF;
      if (UNIT_LIST[u.type[slot]].cargo && type !== Order.Harvest) u.state[slot] = UState.Idle;
      if (type === Order.Harvest) u.state[slot] = UState.Idle;
    }
    u.pushOrder(slot, type, x, z, ref);
    u.repathTimer[slot] = 0;
  }

  setStance(slot: number, stance: number): void {
    this.units.stance[slot] = stance;
  }

  debugSummary(): Record<string, number> {
    const t0 = this.teams[0];
    const t1 = this.teams[1];
    return {
      time: Math.round(this.matchTime),
      units0: this.unitCountFor(0),
      units1: this.unitCountFor(1),
      buildings0: t0.buildings.reduce(sumInt, 0),
      buildings1: t1.buildings.reduce(sumInt, 0),
      credits0: Math.round(t0.credits),
      credits1: Math.round(t1.credits),
      harvested0: Math.round(t0.harvested),
      harvested1: Math.round(t1.harvested),
      kills0: t0.kills,
      kills1: t1.kills,
      losses0: t0.losses,
      losses1: t1.losses,
      projectiles: this.projectiles.count,
      pathMs: Math.round(this.pathMs * 1000) / 1000,
      simMs: Math.round(this.simMs * 1000) / 1000,
    };
  }

  dispose(): void {
    this.fog?.dispose();
    this.vfx?.dispose();
    this.placeholder?.dispose();
    this.entityRoot.removeFromParent();
  }
}

function sumInt(a: number, b: number): number {
  return a + b;
}

export { UNIT_TYPES, BUILDING_TYPES };
