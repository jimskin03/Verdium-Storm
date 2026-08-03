import { RESOURCE_FIELDS } from '@/world/Heightfield';
import { makeRng } from '@/util/Noise';
import type { BuildingType, UnitType } from '@/entities/Types';
import {
  BUILDING_ID,
  BUILDING_LIST,
  UNIT_ARMOUR,
  UNIT_ID,
  UNIT_IS_CIVILIAN,
  UNIT_LIST,
  UNIT_VALUE,
  UNIT_WEAPON,
  WEAPONS,
  WEAPON_VS,
} from './Stats';
import { MAX_UNITS, NO_REF, Order, Stance } from './Entities';
import { UNIT_CAP, type Sim } from './Sim';

/**
 * The commander: one instance drives one team's economy, base layout, army
 * composition and offensives. Both sides run one, so a match plays itself; the
 * human's commander stands down the moment a real order is issued.
 *
 * Structure of a think tick (four per second, staggered per team so the two
 * commanders never do their expensive passes on the same frame):
 *
 *   1. census      — what do I have, what can I see of the enemy
 *   2. construction— keep the build order moving, place anything that is ready
 *   3. production  — harvesters to saturation, then a counter-composition army
 *   4. command     — defend a base under fire, else stage, else press an attack
 *
 * Everything is driven off integer censuses that the simulation already
 * maintains, so a think tick costs a couple of passes over the live entity
 * lists and nothing else. No allocation happens on this path.
 */

const THINK_PERIOD = 0.25;
/** Seconds a unit keeps its current order before the commander may reissue. */
const ORDER_HOLD = 4.5;
/** How long a base stays "under attack" after the last hit landed. */
const DEFEND_MEMORY = 9;

export interface CommanderConfig {
  /** 0.6 = turtles, 1 = standard, 1.5 = rushes. Scales wave size and timing. */
  aggression: number;
  /** Harvesters per refinery the commander saturates to. */
  harvestersPerRefinery: number;
  /** Upper bound on structures it will attempt, so it does not sprawl forever. */
  maxStructures: number;
}

export const DEFAULT_CONFIG: CommanderConfig = {
  aggression: 1,
  harvestersPerRefinery: 3,
  maxStructures: 26,
};

/** Combat roster in the order the commander considers it. */
const COMBAT_TYPES: UnitType[] = ['rifleman', 'rocketeer', 'scout', 'aa', 'tank', 'artillery'];

export class Commander {
  enabled = true;
  /** Set false when a human takes over; the commander then only observes. */
  private standDown = false;

  private rng: () => number;
  private think = 0;
  private elapsed = 0;

  /** Per-unit cooldown before this commander re-issues an order. */
  private orderTimer = new Float32Array(MAX_UNITS);
  /** Normalised armour mix of everything we can currently see of the enemy. */
  private enemyShare = new Float32Array(4);

  private waveActive = false;
  private waveCount = 0;
  private waveTimer = 0;
  private attackX = 0;
  private attackZ = 0;

  private defendX = 0;
  private defendZ = 0;
  private defendUntil = -1;

  private scoutTimer = 12;
  private stageX = 0;
  private stageZ = 0;

  /** Cached census, refreshed once per think. */
  private armyValue = 0;
  private armyCount = 0;
  private structures = 0;

  constructor(
    private sim: Sim,
    readonly team: number,
    seed: number,
    readonly config: CommanderConfig = DEFAULT_CONFIG,
  ) {
    this.rng = makeRng(seed >>> 0);
    // Stagger the two commanders half a think apart.
    this.think = team * THINK_PERIOD * 0.5;
    const me = sim.teams[team];
    const foe = sim.teams[1 - team];
    this.stageX = me.baseX + (foe.baseX - me.baseX) * 0.3;
    this.stageZ = me.baseZ + (foe.baseZ - me.baseZ) * 0.3;
    this.attackX = foe.baseX;
    this.attackZ = foe.baseZ;
  }

  /** Called when the human issues a command; the commander releases the team. */
  release(): void {
    this.standDown = true;
  }

  get active(): boolean {
    return this.enabled && !this.standDown;
  }

  update(dt: number): void {
    this.elapsed += dt;
    for (let i = 0; i < MAX_UNITS; i++) if (this.orderTimer[i] > 0) this.orderTimer[i] -= dt;
    if (this.waveTimer > 0) this.waveTimer -= dt;
    this.scoutTimer -= dt;

    this.think -= dt;
    if (this.think > 0) return;
    this.think += THINK_PERIOD;
    if (!this.active) return;

    this.census();
    this.assessEnemy();
    this.manageConstruction();
    this.manageProduction();
    this.manageArmy();
  }

  /* ================================================================== *
   * Census
   * ================================================================== */

  private census(): void {
    const u = this.sim.units;
    u.refreshLive();
    let value = 0;
    let count = 0;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (u.team[i] !== this.team || UNIT_IS_CIVILIAN[u.type[i]]) continue;
      value += UNIT_VALUE[u.type[i]] * (u.hp[i] / u.maxHp[i]);
      count++;
    }
    this.armyValue = value;
    this.armyCount = count;

    const b = this.sim.buildings;
    b.refreshLive();
    let structures = 0;
    let hitX = 0;
    let hitZ = 0;
    let hitAt = -1;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] !== this.team) continue;
      structures++;
      if (b.lastHit[i] > hitAt) {
        hitAt = b.lastHit[i];
        hitX = b.px[i];
        hitZ = b.pz[i];
      }
    }
    this.structures = structures;

    if (hitAt > 0 && this.sim.matchTime - hitAt < 2) {
      this.defendX = hitX;
      this.defendZ = hitZ;
      this.defendUntil = this.sim.matchTime + DEFEND_MEMORY;
    }
  }

  /**
   * Armour mix of the enemy force, weighted by durability and restricted to what
   * this team can actually see. A commander that has scouted nothing falls back
   * to an even spread, which produces a sane generalist army.
   */
  private assessEnemy(): void {
    const w = this.enemyShare;
    w[0] = 0;
    w[1] = 0;
    w[2] = 0;
    w[3] = 0;
    const u = this.sim.units;
    const foe = 1 - this.team;
    let total = 0;
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (u.team[i] !== foe) continue;
      if (!this.sim.fog.isVisible(this.team, u.px[i], u.pz[i])) continue;
      const weight = 1 + UNIT_LIST[u.type[i]].hp * 0.004;
      w[UNIT_ARMOUR[u.type[i]]] += weight;
      total += weight;
    }
    if (total < 0.5) {
      w[0] = 0.3;
      w[1] = 0.3;
      w[2] = 0.4;
      total = 1;
    }
    // Structures are always part of the problem, so anti-structure output is
    // never valued at zero.
    const structureWeight = total * 0.28;
    w[3] += structureWeight;
    total += structureWeight;
    for (let a = 0; a < 4; a++) w[a] /= total;
  }

  /* ================================================================== *
   * Construction
   * ================================================================== */

  private manageConstruction(): void {
    const state = this.sim.teams[this.team];
    if (!state.hasHq) return;

    // Anything finished is placed immediately; a ready structure blocks the
    // whole queue until it is sited.
    if (state.readyBuilding >= 0) {
      this.placeReady(state.readyBuilding);
      return;
    }
    if (state.construction.items.length >= 2) return;
    if (this.structures >= this.config.maxStructures) return;

    const next = this.nextBuilding();
    if (next < 0) return;
    const cost = BUILDING_LIST[next].cost;
    // Leave enough in the bank that unit production does not stall completely.
    const reserve = next === BUILDING_ID.power ? 0 : 220;
    if (state.credits < cost * 0.5 + reserve) return;
    this.sim.queueBuilding(this.team, next);
  }

  /** The build order, expressed as the first unmet requirement. */
  private nextBuilding(): number {
    const s = this.sim.teams[this.team];
    const have = (t: BuildingType): number => s.buildings[BUILDING_ID[t]] + s.pending[BUILDING_ID[t]];
    const net = s.powerProduced - s.powerConsumed;
    const rich = s.credits > 2600;

    // The grid comes first: a brownout halves every production line at once.
    if (net < 25) return BUILDING_ID.power;
    if (have('refinery') < 1) return BUILDING_ID.refinery;
    if (have('barracks') < 1) return BUILDING_ID.barracks;
    if (have('factory') < 1) return BUILDING_ID.factory;
    if (have('refinery') < 2) return BUILDING_ID.refinery;
    if (have('turret') < 2) return BUILDING_ID.turret;
    if (have('radar') < 1) return BUILDING_ID.radar;
    if (have('lab') < 1) return BUILDING_ID.lab;
    if (have('refinery') < 3 && this.unservedField() >= 0) return BUILDING_ID.refinery;
    if (have('sam') < 1) return BUILDING_ID.sam;
    if (have('factory') < 2 && rich) return BUILDING_ID.factory;
    if (have('turret') < 4) return BUILDING_ID.turret;
    if (have('barracks') < 2 && rich) return BUILDING_ID.barracks;
    if (net < 70) return BUILDING_ID.power;
    if (have('sam') < 2) return BUILDING_ID.sam;
    if (rich && have('turret') < 6) return BUILDING_ID.turret;
    return -1;
  }

  /**
   * Sites a finished structure. Economy buildings hug the rear of the base,
   * defences face the enemy, refineries creep toward the nearest deposit that
   * nothing is working yet.
   */
  private placeReady(typeId: number): void {
    const s = this.sim.teams[this.team];
    const foe = this.sim.teams[1 - this.team];
    let ax = s.baseX;
    let az = s.baseZ;

    const toFoeX = foe.baseX - s.baseX;
    const toFoeZ = foe.baseZ - s.baseZ;
    const len = Math.hypot(toFoeX, toFoeZ) || 1;
    const fx = toFoeX / len;
    const fz = toFoeZ / len;

    if (typeId === BUILDING_ID.turret || typeId === BUILDING_ID.sam) {
      // Ring the approach: alternate sides so defences spread across the front.
      const side = this.waveCount % 2 === 0 ? 1 : -1;
      const spread = 26 + this.rng() * 26;
      ax = s.baseX + fx * 58 - fz * spread * side;
      az = s.baseZ + fz * 58 + fx * spread * side;
    } else if (typeId === BUILDING_ID.refinery) {
      const field = this.unservedField();
      if (field >= 0) {
        const f = RESOURCE_FIELDS[field];
        const dx = f.x - s.baseX;
        const dz = f.z - s.baseZ;
        const d = Math.hypot(dx, dz) || 1;
        // Creep toward the deposit but stay inside the base's build radius.
        const reach = Math.min(d - f.radius * 0.6, 78);
        ax = s.baseX + (dx / d) * reach;
        az = s.baseZ + (dz / d) * reach;
      } else {
        ax = s.baseX - fx * 26;
        az = s.baseZ - fz * 26;
      }
    } else {
      // Rear of the base, behind the yard relative to the enemy.
      const jitter = (this.rng() - 0.5) * 64;
      ax = s.baseX - fx * (30 + this.rng() * 34) - fz * jitter;
      az = s.baseZ - fz * (30 + this.rng() * 34) + fx * jitter;
    }

    const spot = this.searchPlacement(typeId, ax, az);
    if (spot) {
      this.sim.placeReadyBuilding(this.team, spot[0], spot[1]);
      return;
    }
    // Nowhere near the preferred anchor: try the base centre before giving up,
    // and refund rather than deadlock the queue if that fails too.
    const fallback = this.searchPlacement(typeId, s.baseX, s.baseZ);
    if (fallback) this.sim.placeReadyBuilding(this.team, fallback[0], fallback[1]);
    else if (this.rng() < 0.02) this.sim.cancelBuilding(this.team, typeId);
  }

  private placeScratch: [number, number] = [0, 0];

  /** Spirals outward from an anchor looking for a legal, in-base footprint. */
  private searchPlacement(typeId: number, ax: number, az: number): [number, number] | null {
    for (let r = 0; r <= 108; r += 7) {
      const steps = r === 0 ? 1 : Math.max(8, Math.round((Math.PI * 2 * r) / 7));
      const phase = this.rng() * Math.PI * 2;
      for (let i = 0; i < steps; i++) {
        const a = phase + (i / steps) * Math.PI * 2;
        const x = ax + Math.cos(a) * r;
        const z = az + Math.sin(a) * r;
        if (!this.sim.canPlace(this.team, typeId, x, z)) continue;
        this.placeScratch[0] = x;
        this.placeScratch[1] = z;
        return this.placeScratch;
      }
    }
    return null;
  }

  /** Deposit with ore left that no friendly refinery is close enough to work. */
  private unservedField(): number {
    const b = this.sim.buildings;
    b.refreshLive();
    let best = -1;
    let bestScore = -Infinity;
    const s = this.sim.teams[this.team];
    for (let f = 0; f < RESOURCE_FIELDS.length; f++) {
      if (this.sim.resources.amount[f] < 900) continue;
      const field = RESOURCE_FIELDS[f];
      let served = false;
      for (let n = 0; n < b.liveCount; n++) {
        const i = b.live[n];
        if (b.type[i] !== BUILDING_ID.refinery) continue;
        if ((b.px[i] - field.x) ** 2 + (b.pz[i] - field.z) ** 2 < 150 * 150) {
          served = true;
          break;
        }
      }
      if (served) continue;
      const d = Math.hypot(field.x - s.baseX, field.z - s.baseZ);
      const score = this.sim.resources.amount[f] * 0.02 - d;
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  /* ================================================================== *
   * Production
   * ================================================================== */

  private manageProduction(): void {
    const state = this.sim.teams[this.team];
    const total = this.sim.unitCountFor(this.team);
    if (total >= UNIT_CAP - 2) return;

    // Harvester saturation comes before anything with a gun on it.
    const refineries = state.buildings[BUILDING_ID.refinery];
    if (refineries > 0) {
      const want = Math.min(9, 1 + refineries * this.config.harvestersPerRefinery);
      const have = state.units[UNIT_ID.harvester] + this.queuedUnits(UNIT_ID.harvester);
      if (have < want && state.credits > UNIT_LIST[UNIT_ID.harvester].cost * 0.75) {
        if (this.sim.queueUnit(this.team, UNIT_ID.harvester)) return;
      }
    }

    // Keep a construction reserve so the build order never starves.
    const reserve = state.construction.items.length > 0 ? 400 : 150;
    if (state.credits < reserve) return;

    const pick = this.pickCombatUnit();
    if (pick < 0) return;
    if (state.credits < UNIT_LIST[pick].cost * 0.6 + reserve) return;
    if (this.queuedUnits(pick) >= 3) return;
    this.sim.queueUnit(this.team, pick);
    this.setRallies();
  }

  private queuedUnits(typeId: number): number {
    const b = this.sim.buildings;
    b.refreshLive();
    let n = 0;
    for (let k = 0; k < b.liveCount; k++) {
      const i = b.live[k];
      if (b.team[i] !== this.team) continue;
      const items = b.queues[i].items;
      for (let q = 0; q < items.length; q++) if (items[q] === typeId) n++;
    }
    return n;
  }

  /**
   * Counter-composition. Each candidate is scored by the damage it would
   * actually land against the observed armour mix, per credit, then penalised
   * for how much of the existing army already looks like it — which is what
   * stops the commander from fielding forty identical tanks.
   */
  private pickCombatUnit(): number {
    const state = this.sim.teams[this.team];
    const myTotal = Math.max(4, this.armyCount);
    let best = -1;
    let bestScore = 0;
    for (const t of COMBAT_TYPES) {
      const id = UNIT_ID[t];
      if (this.sim.unitLockReason(this.team, id)) continue;
      const wid = UNIT_WEAPON[id];
      if (wid < 0) continue;
      const w = WEAPONS[wid];
      const stats = UNIT_LIST[id];
      const dps = (w.damage * Math.max(1, w.burst ?? 1)) / Math.max(0.25, w.cooldown);
      let eff = 0;
      for (let a = 0; a < 4; a++) eff += this.enemyShare[a] * WEAPON_VS[wid][a];
      // Durability matters as much as output: a glass cannon trades badly.
      const toughness = 0.55 + stats.hp / 700;
      let score = (dps * eff * toughness) / stats.cost;
      const share = state.units[id] / myTotal;
      score /= 1 + share * 2.4;
      score *= 0.86 + 0.28 * this.rng();
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  /** Producers rally to the staging point so reinforcements walk to the front. */
  private setRallies(): void {
    const b = this.sim.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] !== this.team || !BUILDING_LIST[b.type[i]].produces) continue;
      b.rallyX[i] = this.stageX;
      b.rallyZ[i] = this.stageZ;
      b.hasRally[i] = 1;
    }
  }

  /* ================================================================== *
   * Army command
   * ================================================================== */

  private manageArmy(): void {
    const now = this.sim.matchTime;
    const defending = now < this.defendUntil;

    if (!defending) this.updateWave();

    const u = this.sim.units;
    const enemy = 1 - this.team;
    let scouted = false;

    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (u.team[i] !== this.team) continue;
      if (UNIT_IS_CIVILIAN[u.type[i]]) continue;
      if (this.orderTimer[i] > 0) continue;

      // A unit already trading shots is left alone; pulling it out mid-fight
      // is how AI armies melt without accomplishing anything.
      if (this.sim.refValid(u.targetRef[i]) && this.sim.refTeam(u.targetRef[i]) === enemy) {
        this.orderTimer[i] = 1.2;
        continue;
      }

      let gx: number;
      let gz: number;
      let order: number = Order.AttackMove;

      if (defending) {
        gx = this.defendX;
        gz = this.defendZ;
      } else if (!scouted && this.scoutTimer <= 0 && u.type[i] === UNIT_ID.scout) {
        // One recon run at a time, aimed at whatever we know least about.
        this.pickScoutTarget();
        gx = this.attackX;
        gz = this.attackZ;
        order = Order.Move;
        scouted = true;
        this.scoutTimer = 34;
        this.sim.setStance(i, Stance.Guard);
        this.sim.issueOrder(i, order, this.scoutX, this.scoutZ, NO_REF, false);
        this.orderTimer[i] = 20;
        continue;
      } else if (this.waveActive) {
        gx = this.attackX;
        gz = this.attackZ;
      } else {
        // Staging: hold the line between base and mid-map, spread on a grid so
        // the group does not compress into one square.
        const k = n % 24;
        gx = this.stageX + ((k % 6) - 2.5) * 11;
        gz = this.stageZ + (Math.floor(k / 6) - 1.5) * 11;
        order = Order.Guard;
      }

      const dx = u.px[i] - gx;
      const dz = u.pz[i] - gz;
      const near = order === Order.Guard ? 22 : 26;
      if (dx * dx + dz * dz < near * near && u.orderCount[i] > 0) {
        this.orderTimer[i] = ORDER_HOLD;
        continue;
      }
      this.sim.setStance(i, order === Order.Guard ? Stance.Guard : Stance.Aggressive);
      this.sim.issueOrder(i, order, gx, gz, NO_REF, false);
      this.orderTimer[i] = ORDER_HOLD + this.rng() * 2;
    }
  }

  private scoutX = 0;
  private scoutZ = 0;

  private pickScoutTarget(): void {
    const foe = this.sim.teams[1 - this.team];
    // Prefer a deposit we have never seen; otherwise go look at the enemy base.
    let best = -1;
    let bestD = Infinity;
    for (let f = 0; f < RESOURCE_FIELDS.length; f++) {
      const field = RESOURCE_FIELDS[f];
      if (this.sim.fog.isExplored(this.team, field.x, field.z)) continue;
      const d = Math.hypot(field.x - this.stageX, field.z - this.stageZ);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (best >= 0) {
      this.scoutX = RESOURCE_FIELDS[best].x;
      this.scoutZ = RESOURCE_FIELDS[best].z;
    } else {
      const a = this.rng() * Math.PI * 2;
      this.scoutX = foe.baseX + Math.cos(a) * 70;
      this.scoutZ = foe.baseZ + Math.sin(a) * 70;
    }
  }

  /**
   * Wave logic. The commander gathers until its army is worth more than the
   * threshold for this wave, pushes, and gives up when the push has been
   * ground down — at which point the survivors fall back and rebuild.
   */
  private updateWave(): void {
    const threshold = (2400 + this.waveCount * 850) / this.config.aggression;
    if (!this.waveActive) {
      if (this.armyValue >= threshold && this.waveTimer <= 0) {
        this.waveActive = true;
        this.waveCount++;
        this.pickAttackTarget();
      }
      return;
    }
    if (this.armyValue < threshold * 0.3 || this.armyCount < 4) {
      // Broken push: regroup rather than feed reinforcements in one at a time.
      this.waveActive = false;
      this.waveTimer = 22;
      this.orderTimer.fill(0);
      return;
    }
    // Re-aim periodically so the wave rolls through a base instead of stalling
    // on the first wall it flattened.
    if (this.sim.tickCount % 90 === 0) this.pickAttackTarget();
  }

  private pickAttackTarget(): void {
    const foe = this.sim.teams[1 - this.team];
    const me = this.sim.teams[this.team];
    const b = this.sim.buildings;
    b.refreshLive();
    let bx = foe.baseX;
    let bz = foe.baseZ;
    let best = Infinity;
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] === this.team) continue;
      if (!this.sim.fog.isExplored(this.team, b.px[i], b.pz[i])) continue;
      const d = (b.px[i] - me.baseX) ** 2 + (b.pz[i] - me.baseZ) ** 2;
      if (d < best) {
        best = d;
        bx = b.px[i];
        bz = b.pz[i];
      }
    }
    this.attackX = bx;
    this.attackZ = bz;
  }

  /** Debug/telemetry surface. */
  status(): Record<string, number> {
    return {
      team: this.team,
      army: Math.round(this.armyValue),
      units: this.armyCount,
      structures: this.structures,
      wave: this.waveCount,
      attacking: this.waveActive ? 1 : 0,
      defending: this.sim.matchTime < this.defendUntil ? 1 : 0,
      active: this.active ? 1 : 0,
    };
  }
}
