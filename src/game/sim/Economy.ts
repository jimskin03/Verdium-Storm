import type { Faction } from '@/entities/Types';
import { RESOURCE_FIELDS } from '@/world/Heightfield';
import { BUILDING_ID, BUILDING_LIST, UNIT_LIST } from './Stats';
import type { BuildQueue } from './Entities';

/**
 * Per-team economic state: credits, the power grid, structure/unit censuses and
 * the construction queue that feeds base building.
 *
 * Power is a soft constraint rather than a hard one — running a deficit does
 * not switch structures off, it slows every production line proportionally.
 * That reads better in play than a binary blackout and still punishes players
 * who neglect their grid.
 */

export const MIN_BROWNOUT_SPEED = 0.35;

export class TeamState {
  credits = 3000;
  powerProduced = 0;
  powerConsumed = 0;

  /** Completed structures per building type id. */
  readonly buildings = new Int32Array(BUILDING_LIST.length);
  /** Structures queued, awaiting placement, or still under construction. */
  readonly pending = new Int32Array(BUILDING_LIST.length);
  /** Live units per unit type id. */
  readonly units = new Int32Array(UNIT_LIST.length);

  /** The construction yard's queue. Holds building type ids. */
  readonly construction: BuildQueue = { items: [], progress: 0, spent: 0 };
  /** Finished structure awaiting a placement click; -1 when none. */
  readyBuilding = -1;

  kills = 0;
  losses = 0;
  harvested = 0;

  /** Smoothed credits per minute for the HUD readout. */
  income = 0;
  private incomeAccum = 0;
  private incomeTimer = 0;

  baseX = 0;
  baseZ = 0;

  constructor(readonly team: number, readonly faction: Faction) {}

  get powerRatio(): number {
    if (this.powerConsumed <= 0) return 1;
    const r = this.powerProduced / this.powerConsumed;
    return r > 1 ? 1 : r < 0 ? 0 : r;
  }

  /** Production rate multiplier under the current grid load. */
  get buildSpeed(): number {
    const r = this.powerRatio;
    return r >= 1 ? 1 : MIN_BROWNOUT_SPEED + (1 - MIN_BROWNOUT_SPEED) * r;
  }

  has(buildingId: number): boolean {
    return this.buildings[buildingId] > 0;
  }

  get hasHq(): boolean {
    return this.buildings[BUILDING_ID.hq] > 0;
  }

  earn(amount: number): void {
    this.credits += amount;
    this.harvested += amount;
    this.incomeAccum += amount;
  }

  tickIncome(dt: number): void {
    this.incomeTimer += dt;
    if (this.incomeTimer < 2) return;
    const rate = (this.incomeAccum / this.incomeTimer) * 60;
    this.income += (rate - this.income) * 0.5;
    this.incomeAccum = 0;
    this.incomeTimer = 0;
  }
}

/**
 * Verdium deposits. Amounts come from the shared heightfield definition; the
 * simulation owns how fast they drain.
 */
export class ResourceMap {
  readonly amount = new Float32Array(RESOURCE_FIELDS.length);
  readonly max = new Float32Array(RESOURCE_FIELDS.length);
  readonly fraction = new Float32Array(RESOURCE_FIELDS.length);
  /** Harvesters currently assigned, so they spread across deposits. */
  readonly claims = new Int32Array(RESOURCE_FIELDS.length);

  constructor() {
    for (let i = 0; i < RESOURCE_FIELDS.length; i++) {
      this.amount[i] = RESOURCE_FIELDS[i].amount;
      this.max[i] = RESOURCE_FIELDS[i].amount;
      this.fraction[i] = 1;
    }
  }

  /** Removes up to `want` from a deposit, returning what was actually taken. */
  take(field: number, want: number): number {
    if (field < 0 || field >= this.amount.length) return 0;
    const got = Math.min(want, this.amount[field]);
    this.amount[field] -= got;
    this.fraction[field] = this.amount[field] / this.max[field];
    return got;
  }

  /** Nearest deposit with ore left, penalised by how many harvesters it already has. */
  best(x: number, z: number, avoid = -1): number {
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < RESOURCE_FIELDS.length; i++) {
      if (this.amount[i] <= 1 || i === avoid) continue;
      const f = RESOURCE_FIELDS[i];
      const d = Math.hypot(f.x - x, f.z - z);
      const score = d + this.claims[i] * 34;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}
