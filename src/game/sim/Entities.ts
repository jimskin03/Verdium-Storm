import type { BuildingRig, UnitRig } from '@/entities/Types';

/**
 * Pooled, data-oriented entity storage. Every hot field is a typed array
 * indexed by slot; the only object arrays hold rig references and production
 * queues, which are touched at command rate rather than per frame.
 *
 * Handles ("refs") are a single number packing kind, generation and slot, so a
 * dangling target reference is detected by a generation mismatch instead of a
 * null check.
 */

export const MAX_UNITS = 512;
export const MAX_BUILDINGS = 128;
export const MAX_PROJECTILES = 512;
export const ORDER_CAP = 8;

export const KIND_UNIT = 0;
export const KIND_BUILDING = 1;

export const NO_REF = 0;

export function makeRef(kind: number, gen: number, slot: number): number {
  // Slot is offset by one so a valid ref is never zero.
  return (kind << 30) | ((gen & 0x3fff) << 16) | ((slot + 1) & 0xffff);
}

export function refKind(ref: number): number {
  return (ref >>> 30) & 1;
}

export function refGen(ref: number): number {
  return (ref >>> 16) & 0x3fff;
}

export function refSlot(ref: number): number {
  return (ref & 0xffff) - 1;
}

/** Unit activity. Drives which per-tick behaviour runs. */
export const UState = {
  Idle: 0,
  Move: 1,
  AttackMove: 2,
  Attack: 3,
  HarvestSeek: 4,
  HarvestMine: 5,
  HarvestReturn: 6,
  HarvestUnload: 7,
  Repair: 8,
  Capture: 9,
  Guard: 10,
} as const;

/** Queued player/AI orders. */
export const Order = {
  None: 0,
  Move: 1,
  AttackMove: 2,
  Attack: 3,
  Harvest: 4,
  Repair: 5,
  Capture: 6,
  Guard: 7,
} as const;

export const Stance = { Aggressive: 0, Guard: 1, HoldFire: 2 } as const;

export class UnitStore {
  readonly capacity = MAX_UNITS;
  count = 0;

  readonly alive = new Uint8Array(MAX_UNITS);
  readonly gen = new Int32Array(MAX_UNITS);
  readonly type = new Uint8Array(MAX_UNITS);
  readonly team = new Uint8Array(MAX_UNITS);
  readonly state = new Uint8Array(MAX_UNITS);
  readonly stance = new Uint8Array(MAX_UNITS);

  readonly px = new Float32Array(MAX_UNITS);
  readonly py = new Float32Array(MAX_UNITS);
  readonly pz = new Float32Array(MAX_UNITS);
  readonly prevX = new Float32Array(MAX_UNITS);
  readonly prevY = new Float32Array(MAX_UNITS);
  readonly prevZ = new Float32Array(MAX_UNITS);
  readonly yaw = new Float32Array(MAX_UNITS);
  readonly prevYaw = new Float32Array(MAX_UNITS);
  /** Ground normal, sampled once per tick and reused by the render pass. */
  readonly nx = new Float32Array(MAX_UNITS);
  readonly ny = new Float32Array(MAX_UNITS);
  readonly nz = new Float32Array(MAX_UNITS);

  /** Signed forward speed and the yaw rate actually applied last tick. */
  readonly spd = new Float32Array(MAX_UNITS);
  readonly turn = new Float32Array(MAX_UNITS);
  /** Positional correction accumulated by collision resolution. */
  readonly pushX = new Float32Array(MAX_UNITS);
  readonly pushZ = new Float32Array(MAX_UNITS);

  readonly hp = new Float32Array(MAX_UNITS);
  readonly maxHp = new Float32Array(MAX_UNITS);

  readonly cooldown = new Float32Array(MAX_UNITS);
  readonly burstLeft = new Int8Array(MAX_UNITS);
  readonly burstTimer = new Float32Array(MAX_UNITS);
  readonly targetRef = new Int32Array(MAX_UNITS);
  readonly retarget = new Float32Array(MAX_UNITS);

  /** Current navigation goal and the formation offset applied to it. */
  readonly goalX = new Float32Array(MAX_UNITS);
  readonly goalZ = new Float32Array(MAX_UNITS);
  readonly fieldId = new Int32Array(MAX_UNITS);
  readonly hasGoal = new Uint8Array(MAX_UNITS);
  readonly arriveRadius = new Float32Array(MAX_UNITS);
  readonly stuck = new Float32Array(MAX_UNITS);
  readonly repathTimer = new Float32Array(MAX_UNITS);

  /** Economy state. */
  readonly cargo = new Float32Array(MAX_UNITS);
  readonly resourceField = new Int8Array(MAX_UNITS);
  readonly mineX = new Float32Array(MAX_UNITS);
  readonly mineZ = new Float32Array(MAX_UNITS);
  readonly homeRef = new Int32Array(MAX_UNITS);
  readonly workTimer = new Float32Array(MAX_UNITS);

  readonly selected = new Uint8Array(MAX_UNITS);
  readonly visible = new Uint8Array(MAX_UNITS);
  readonly lastHit = new Float32Array(MAX_UNITS);
  readonly damageState = new Uint8Array(MAX_UNITS);

  readonly orderType = new Int8Array(MAX_UNITS * ORDER_CAP);
  readonly orderX = new Float32Array(MAX_UNITS * ORDER_CAP);
  readonly orderZ = new Float32Array(MAX_UNITS * ORDER_CAP);
  readonly orderRef = new Int32Array(MAX_UNITS * ORDER_CAP);
  readonly orderHead = new Int32Array(MAX_UNITS);
  readonly orderCount = new Int32Array(MAX_UNITS);

  readonly rigs: Array<UnitRig | null> = new Array(MAX_UNITS).fill(null);

  /** Compact list of live slots, rebuilt whenever the population changes. */
  readonly live = new Int32Array(MAX_UNITS);
  liveCount = 0;
  private liveDirty = true;

  private freeList: number[] = [];

  constructor() {
    for (let i = MAX_UNITS - 1; i >= 0; i--) this.freeList.push(i);
  }

  alloc(): number {
    const slot = this.freeList.pop();
    if (slot === undefined) return -1;
    this.alive[slot] = 1;
    this.count++;
    this.liveDirty = true;
    this.orderHead[slot] = 0;
    this.orderCount[slot] = 0;
    this.selected[slot] = 0;
    this.visible[slot] = 1;
    this.pushX[slot] = 0;
    this.pushZ[slot] = 0;
    this.stuck[slot] = 0;
    this.cargo[slot] = 0;
    this.targetRef[slot] = NO_REF;
    this.homeRef[slot] = NO_REF;
    this.fieldId[slot] = -1;
    this.resourceField[slot] = -1;
    this.hasGoal[slot] = 0;
    this.damageState[slot] = 0;
    return slot;
  }

  free(slot: number): void {
    if (!this.alive[slot]) return;
    this.alive[slot] = 0;
    this.rigs[slot] = null;
    this.gen[slot] = (this.gen[slot] + 1) & 0x3fff;
    this.count--;
    this.liveDirty = true;
    this.freeList.push(slot);
  }

  ref(slot: number): number {
    return makeRef(KIND_UNIT, this.gen[slot], slot);
  }

  valid(ref: number): boolean {
    if (ref === NO_REF || refKind(ref) !== KIND_UNIT) return false;
    const slot = refSlot(ref);
    if (slot < 0 || slot >= MAX_UNITS || !this.alive[slot]) return false;
    return this.gen[slot] === refGen(ref);
  }

  markDirty(): void {
    this.liveDirty = true;
  }

  refreshLive(): void {
    if (!this.liveDirty) return;
    let n = 0;
    for (let i = 0; i < MAX_UNITS; i++) if (this.alive[i]) this.live[n++] = i;
    this.liveCount = n;
    this.liveDirty = false;
  }

  /* Order queue -------------------------------------------------- */

  clearOrders(slot: number): void {
    this.orderCount[slot] = 0;
    this.orderHead[slot] = 0;
  }

  pushOrder(slot: number, type: number, x: number, z: number, ref: number): void {
    const count = this.orderCount[slot];
    if (count >= ORDER_CAP) return;
    const idx = (this.orderHead[slot] + count) % ORDER_CAP;
    const k = slot * ORDER_CAP + idx;
    this.orderType[k] = type;
    this.orderX[k] = x;
    this.orderZ[k] = z;
    this.orderRef[k] = ref;
    this.orderCount[slot] = count + 1;
  }

  peekOrder(slot: number): number {
    return this.orderCount[slot] > 0 ? slot * ORDER_CAP + this.orderHead[slot] : -1;
  }

  popOrder(slot: number): void {
    if (this.orderCount[slot] === 0) return;
    this.orderHead[slot] = (this.orderHead[slot] + 1) % ORDER_CAP;
    this.orderCount[slot]--;
  }
}

export interface BuildQueue {
  /** Unit type ids waiting, first is the active item. */
  items: number[];
  /** 0..1 progress of the active item. */
  progress: number;
  /** Credits already sunk into the active item, refunded on cancel. */
  spent: number;
}

export class BuildingStore {
  readonly capacity = MAX_BUILDINGS;
  count = 0;

  readonly alive = new Uint8Array(MAX_BUILDINGS);
  readonly gen = new Int32Array(MAX_BUILDINGS);
  readonly type = new Uint8Array(MAX_BUILDINGS);
  readonly team = new Uint8Array(MAX_BUILDINGS);

  readonly px = new Float32Array(MAX_BUILDINGS);
  readonly py = new Float32Array(MAX_BUILDINGS);
  readonly pz = new Float32Array(MAX_BUILDINGS);
  readonly yaw = new Float32Array(MAX_BUILDINGS);

  readonly hp = new Float32Array(MAX_BUILDINGS);
  readonly maxHp = new Float32Array(MAX_BUILDINGS);
  /** 0..1; the structure is inert and un-targetable-by-AI until it reaches 1. */
  readonly buildProgress = new Float32Array(MAX_BUILDINGS);

  readonly cooldown = new Float32Array(MAX_BUILDINGS);
  readonly burstLeft = new Int8Array(MAX_BUILDINGS);
  readonly burstTimer = new Float32Array(MAX_BUILDINGS);
  readonly targetRef = new Int32Array(MAX_BUILDINGS);
  readonly retarget = new Float32Array(MAX_BUILDINGS);

  readonly rallyX = new Float32Array(MAX_BUILDINGS);
  readonly rallyZ = new Float32Array(MAX_BUILDINGS);
  readonly hasRally = new Uint8Array(MAX_BUILDINGS);

  readonly selected = new Uint8Array(MAX_BUILDINGS);
  readonly visible = new Uint8Array(MAX_BUILDINGS);
  readonly lastHit = new Float32Array(MAX_BUILDINGS);
  readonly damageState = new Uint8Array(MAX_BUILDINGS);
  readonly active = new Uint8Array(MAX_BUILDINGS);

  readonly queues: BuildQueue[] = new Array(MAX_BUILDINGS);
  readonly rigs: Array<BuildingRig | null> = new Array(MAX_BUILDINGS).fill(null);

  readonly live = new Int32Array(MAX_BUILDINGS);
  liveCount = 0;
  private liveDirty = true;

  private freeList: number[] = [];

  constructor() {
    for (let i = MAX_BUILDINGS - 1; i >= 0; i--) this.freeList.push(i);
    for (let i = 0; i < MAX_BUILDINGS; i++) this.queues[i] = { items: [], progress: 0, spent: 0 };
  }

  alloc(): number {
    const slot = this.freeList.pop();
    if (slot === undefined) return -1;
    this.alive[slot] = 1;
    this.count++;
    this.liveDirty = true;
    const q = this.queues[slot];
    q.items.length = 0;
    q.progress = 0;
    q.spent = 0;
    this.selected[slot] = 0;
    this.visible[slot] = 1;
    this.hasRally[slot] = 0;
    this.targetRef[slot] = NO_REF;
    this.damageState[slot] = 0;
    this.active[slot] = 0;
    return slot;
  }

  free(slot: number): void {
    if (!this.alive[slot]) return;
    this.alive[slot] = 0;
    this.rigs[slot] = null;
    this.gen[slot] = (this.gen[slot] + 1) & 0x3fff;
    this.count--;
    this.liveDirty = true;
    this.freeList.push(slot);
  }

  ref(slot: number): number {
    return makeRef(KIND_BUILDING, this.gen[slot], slot);
  }

  valid(ref: number): boolean {
    if (ref === NO_REF || refKind(ref) !== KIND_BUILDING) return false;
    const slot = refSlot(ref);
    if (slot < 0 || slot >= MAX_BUILDINGS || !this.alive[slot]) return false;
    return this.gen[slot] === refGen(ref);
  }

  markDirty(): void {
    this.liveDirty = true;
  }

  refreshLive(): void {
    if (!this.liveDirty) return;
    let n = 0;
    for (let i = 0; i < MAX_BUILDINGS; i++) if (this.alive[i]) this.live[n++] = i;
    this.liveCount = n;
    this.liveDirty = false;
  }
}

export class ProjectileStore {
  readonly alive = new Uint8Array(MAX_PROJECTILES);
  readonly kind = new Uint8Array(MAX_PROJECTILES);
  readonly team = new Uint8Array(MAX_PROJECTILES);
  readonly weapon = new Int16Array(MAX_PROJECTILES);

  readonly px = new Float32Array(MAX_PROJECTILES);
  readonly py = new Float32Array(MAX_PROJECTILES);
  readonly pz = new Float32Array(MAX_PROJECTILES);
  readonly vx = new Float32Array(MAX_PROJECTILES);
  readonly vy = new Float32Array(MAX_PROJECTILES);
  readonly vz = new Float32Array(MAX_PROJECTILES);

  readonly damage = new Float32Array(MAX_PROJECTILES);
  readonly splash = new Float32Array(MAX_PROJECTILES);
  readonly targetRef = new Int32Array(MAX_PROJECTILES);
  readonly targetX = new Float32Array(MAX_PROJECTILES);
  readonly targetY = new Float32Array(MAX_PROJECTILES);
  readonly targetZ = new Float32Array(MAX_PROJECTILES);
  readonly life = new Float32Array(MAX_PROJECTILES);
  readonly ownerRef = new Int32Array(MAX_PROJECTILES);

  count = 0;
  private cursor = 0;

  alloc(): number {
    for (let n = 0; n < MAX_PROJECTILES; n++) {
      const i = (this.cursor + n) % MAX_PROJECTILES;
      if (!this.alive[i]) {
        this.cursor = (i + 1) % MAX_PROJECTILES;
        this.alive[i] = 1;
        this.count++;
        return i;
      }
    }
    return -1;
  }

  free(i: number): void {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.count--;
  }
}
