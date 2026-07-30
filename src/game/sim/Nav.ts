import { HALF_WORLD, WATER_LEVEL, WORLD_SIZE, heightAt } from '@/world/Heightfield';

/**
 * Navigation. A uniform cost grid derived once from the heightfield, plus a
 * cache of Dijkstra integration fields ("flow fields") that any number of units
 * can share.
 *
 * Why flow fields rather than per-unit A*: a hundred units ordered to the same
 * place is the common case in an RTS, and one field answers all of them in O(1)
 * per unit per tick. Field construction is amortised across ticks with a node
 * budget so a fresh order can never stall a frame.
 */

export const NAV_CELL = 4;
export const NAV_DIM = WORLD_SIZE / NAV_CELL; // 256
export const NAV_CELLS = NAV_DIM * NAV_DIM;
const NAV_ORIGIN = -HALF_WORLD;

export const IMPASSABLE = 0xffff;
/** Cost units per cell for ideal ground. Keeps the integration field integral. */
const BASE_COST = 10;

export function cellX(x: number): number {
  const i = Math.floor((x - NAV_ORIGIN) / NAV_CELL);
  return i < 0 ? 0 : i >= NAV_DIM ? NAV_DIM - 1 : i;
}

export function cellZ(z: number): number {
  const j = Math.floor((z - NAV_ORIGIN) / NAV_CELL);
  return j < 0 ? 0 : j >= NAV_DIM ? NAV_DIM - 1 : j;
}

export function cellCentreX(i: number): number {
  return NAV_ORIGIN + (i + 0.5) * NAV_CELL;
}

export function cellCentreZ(j: number): number {
  return NAV_ORIGIN + (j + 0.5) * NAV_CELL;
}

const NEIGH_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGH_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NEIGH_MUL = [1, 1, 1, 1, 1.41421356, 1.41421356, 1.41421356, 1.41421356];

export class NavGrid {
  /** Terrain height sampled at every cell centre. */
  readonly height = new Float32Array(NAV_CELLS);
  /** Terrain-only traversal cost; IMPASSABLE for water, cliffs and map edge. */
  readonly terrainCost = new Uint16Array(NAV_CELLS);
  /** terrainCost plus structure footprints. This is what pathing reads. */
  readonly cost = new Uint16Array(NAV_CELLS);
  /** Number of structures occupying the cell. */
  readonly occupancy = new Uint8Array(NAV_CELLS);
  /** Cells to the nearest blocked cell, saturating at 6. Used for clearance cost. */
  readonly clearance = new Uint8Array(NAV_CELLS);
  /** Bumped whenever `cost` changes so cached fields can be invalidated. */
  version = 1;

  build(): void {
    const h = this.height;
    for (let j = 0; j < NAV_DIM; j++) {
      const z = cellCentreZ(j);
      const row = j * NAV_DIM;
      for (let i = 0; i < NAV_DIM; i++) {
        h[row + i] = heightAt(cellCentreX(i), z);
      }
    }

    // Slope from central differences of the sampled grid: five times cheaper
    // than calling slopeAt() per cell and identical to within a few centimetres
    // at this spacing.
    const inv = 1 / (2 * NAV_CELL);
    const edge = Math.ceil(28 / NAV_CELL);
    for (let j = 0; j < NAV_DIM; j++) {
      const row = j * NAV_DIM;
      for (let i = 0; i < NAV_DIM; i++) {
        const k = row + i;
        if (i < edge || j < edge || i >= NAV_DIM - edge || j >= NAV_DIM - edge) {
          this.terrainCost[k] = IMPASSABLE;
          continue;
        }
        if (h[k] < WATER_LEVEL + 1.2) {
          this.terrainCost[k] = IMPASSABLE;
          continue;
        }
        const gx = (h[k + 1] - h[k - 1]) * inv;
        const gz = (h[k + NAV_DIM] - h[k - NAV_DIM]) * inv;
        const g = Math.sqrt(gx * gx + gz * gz);
        if (g > 1.32) {
          this.terrainCost[k] = IMPASSABLE;
          continue;
        }
        // Gentle slopes are only mildly discouraged; steep ones strongly.
        this.terrainCost[k] = BASE_COST + Math.round(g * g * 26);
      }
    }

    this.computeClearance();
    this.cost.set(this.terrainCost);
    this.applyClearancePenalty();
    this.version++;
  }

  /** Multi-source BFS out from blocked cells, saturating at 6. */
  private computeClearance(): void {
    const c = this.clearance;
    c.fill(255);
    const queue = new Int32Array(NAV_CELLS);
    let head = 0;
    let tail = 0;
    for (let k = 0; k < NAV_CELLS; k++) {
      if (this.terrainCost[k] === IMPASSABLE) {
        c[k] = 0;
        queue[tail++] = k;
      }
    }
    while (head < tail) {
      const k = queue[head++];
      const d = c[k];
      if (d >= 6) continue;
      const i = k % NAV_DIM;
      const j = (k - i) / NAV_DIM;
      for (let n = 0; n < 4; n++) {
        const ni = i + NEIGH_DX[n];
        const nj = j + NEIGH_DZ[n];
        if (ni < 0 || nj < 0 || ni >= NAV_DIM || nj >= NAV_DIM) continue;
        const nk = nj * NAV_DIM + ni;
        if (c[nk] <= d + 1) continue;
        c[nk] = d + 1;
        if (tail < NAV_CELLS) queue[tail++] = nk;
      }
    }
    for (let k = 0; k < NAV_CELLS; k++) if (c[k] > 6) c[k] = 6;
  }

  /** Nudges paths away from cliff edges and building walls so units do not scrape. */
  private applyClearancePenalty(): void {
    for (let k = 0; k < NAV_CELLS; k++) {
      if (this.cost[k] === IMPASSABLE) continue;
      const cl = this.clearance[k];
      if (cl < 3) this.cost[k] += (3 - cl) * 9;
    }
  }

  /** Marks or clears a square structure footprint. */
  setFootprint(cx: number, cz: number, cells: number, add: boolean): void {
    const half = cells * 0.5;
    const i0 = cellX(cx - half * NAV_CELL);
    const i1 = cellX(cx + half * NAV_CELL);
    const j0 = cellZ(cz - half * NAV_CELL);
    const j1 = cellZ(cz + half * NAV_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * NAV_DIM + i;
        if (add) this.occupancy[k]++;
        else if (this.occupancy[k] > 0) this.occupancy[k]--;
        this.cost[k] = this.occupancy[k] > 0
          ? IMPASSABLE
          : this.terrainCost[k] === IMPASSABLE
            ? IMPASSABLE
            : this.terrainCost[k] + (this.clearance[k] < 3 ? (3 - this.clearance[k]) * 9 : 0);
      }
    }
    this.version++;
  }

  passable(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= NAV_DIM || j >= NAV_DIM) return false;
    return this.cost[j * NAV_DIM + i] !== IMPASSABLE;
  }

  passableAt(x: number, z: number): boolean {
    return this.passable(cellX(x), cellZ(z));
  }

  /** Bilinear terrain height from the sampled grid — cheap, used for AI and LOS. */
  sampleHeight(x: number, z: number): number {
    const fx = (x - NAV_ORIGIN) / NAV_CELL - 0.5;
    const fz = (z - NAV_ORIGIN) / NAV_CELL - 0.5;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    if (i < 0) i = 0; else if (i > NAV_DIM - 2) i = NAV_DIM - 2;
    if (j < 0) j = 0; else if (j > NAV_DIM - 2) j = NAV_DIM - 2;
    const k = j * NAV_DIM + i;
    const h00 = this.height[k];
    const h10 = this.height[k + 1];
    const h01 = this.height[k + NAV_DIM];
    const h11 = this.height[k + NAV_DIM + 1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  /** Surface gradient from the sampled grid; written as a normal into out[0..2]. */
  sampleNormal(x: number, z: number, out: Float32Array): void {
    const i = cellX(x);
    const j = cellZ(z);
    const im = i > 0 ? i - 1 : i;
    const ip = i < NAV_DIM - 1 ? i + 1 : i;
    const jm = j > 0 ? j - 1 : j;
    const jp = j < NAV_DIM - 1 ? j + 1 : j;
    const gx = (this.height[j * NAV_DIM + ip] - this.height[j * NAV_DIM + im]) / ((ip - im) * NAV_CELL);
    const gz = (this.height[jp * NAV_DIM + i] - this.height[jm * NAV_DIM + i]) / ((jp - jm) * NAV_CELL);
    const len = Math.sqrt(gx * gx + gz * gz + 1);
    out[0] = -gx / len;
    out[1] = 1 / len;
    out[2] = -gz / len;
  }

  /**
   * Terrain line of sight between two ground points. Direct-fire weapons and
   * spotting both use it. Samples the height grid, so it costs eight array
   * reads rather than eight heightfield evaluations.
   */
  hasLineOfSight(x0: number, z0: number, y0: number, x1: number, z1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < NAV_CELL) return true;
    const steps = Math.min(24, Math.max(3, Math.round(dist / (NAV_CELL * 2))));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const h = this.sampleHeight(x0 + dx * t, z0 + dz * t);
      // Allow a little forgiveness so a pebble does not block a tank shell.
      if (h > y0 + (y1 - y0) * t + 2.2) return false;
    }
    return true;
  }

  /** Nearest passable cell centre to (x, z), searched in expanding rings. */
  nearestPassable(x: number, z: number, out: Float32Array): boolean {
    const i0 = cellX(x);
    const j0 = cellZ(z);
    if (this.passable(i0, j0)) {
      out[0] = x;
      out[1] = z;
      return true;
    }
    for (let r = 1; r <= 24; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (!this.passable(i, j)) continue;
          out[0] = cellCentreX(i);
          out[1] = cellCentreZ(j);
          return true;
        }
      }
    }
    out[0] = x;
    out[1] = z;
    return false;
  }
}

/* ------------------------------------------------------------------ */

const FIELD_INF = 1e9;

class FlowField {
  readonly integration = new Float32Array(NAV_CELLS);
  goalCell = -1;
  ready = false;
  lastUsed = 0;
  gridVersion = 0;
  /** Ring buffer of cells awaiting relaxation. */
  private queue = new Int32Array(NAV_CELLS * 4);
  private head = 0;
  private tail = 0;
  private inQueue = new Uint8Array(NAV_CELLS);

  reset(goalCell: number, gridVersion: number): void {
    this.integration.fill(FIELD_INF);
    this.inQueue.fill(0);
    this.goalCell = goalCell;
    this.gridVersion = gridVersion;
    this.ready = false;
    this.head = 0;
    this.tail = 0;
    this.integration[goalCell] = 0;
    this.push(goalCell);
  }

  private push(cell: number): void {
    if (this.inQueue[cell]) return;
    this.inQueue[cell] = 1;
    this.queue[this.tail] = cell;
    this.tail = (this.tail + 1) % this.queue.length;
  }

  /**
   * Relaxes up to `budget` cells. Returns true once the field is complete.
   * A label-correcting sweep rather than a heap: with only a handful of
   * distinct edge costs it converges in roughly one pass and needs no
   * priority queue bookkeeping.
   */
  step(grid: NavGrid, budget: number): boolean {
    const cost = grid.cost;
    const integ = this.integration;
    let processed = 0;
    while (this.head !== this.tail && processed < budget) {
      const k = this.queue[this.head];
      this.head = (this.head + 1) % this.queue.length;
      this.inQueue[k] = 0;
      processed++;
      const base = integ[k];
      const i = k % NAV_DIM;
      const j = (k - i) / NAV_DIM;
      for (let n = 0; n < 8; n++) {
        const ni = i + NEIGH_DX[n];
        const nj = j + NEIGH_DZ[n];
        if (ni < 0 || nj < 0 || ni >= NAV_DIM || nj >= NAV_DIM) continue;
        const nk = nj * NAV_DIM + ni;
        const c = cost[nk];
        if (c === IMPASSABLE) continue;
        if (n >= 4) {
          // No corner cutting: both orthogonal neighbours must be open.
          if (cost[j * NAV_DIM + ni] === IMPASSABLE || cost[nj * NAV_DIM + i] === IMPASSABLE) continue;
        }
        const nc = base + c * NEIGH_MUL[n];
        if (nc + 1e-3 < integ[nk]) {
          integ[nk] = nc;
          this.push(nk);
        }
      }
    }
    if (this.head === this.tail) {
      this.ready = true;
      return true;
    }
    return false;
  }
}

/**
 * Least-recently-used cache of integration fields keyed by goal cell. Orders to
 * nearby points snap to the same cell and therefore share a field.
 */
export class FlowFieldCache {
  private fields: FlowField[] = [];
  private byGoal = new Map<number, number>();
  private tick = 0;
  private pending: number[] = [];

  constructor(private grid: NavGrid, private capacity = 14) {}

  /** Returns a field id for the goal, creating or recycling one if needed. */
  request(x: number, z: number): number {
    const goal = this.resolveGoal(x, z);
    if (goal < 0) return -1;
    const existing = this.byGoal.get(goal);
    if (existing !== undefined) {
      const f = this.fields[existing];
      if (f.gridVersion === this.grid.version) {
        f.lastUsed = this.tick;
        return existing;
      }
      // Grid changed under us: rebuild in place.
      f.reset(goal, this.grid.version);
      f.lastUsed = this.tick;
      if (!this.pending.includes(existing)) this.pending.push(existing);
      return existing;
    }

    let id: number;
    if (this.fields.length < this.capacity) {
      id = this.fields.length;
      this.fields.push(new FlowField());
    } else {
      id = 0;
      let oldest = Infinity;
      for (let i = 0; i < this.fields.length; i++) {
        if (this.fields[i].lastUsed < oldest) {
          oldest = this.fields[i].lastUsed;
          id = i;
        }
      }
      this.byGoal.delete(this.fields[id].goalCell);
    }
    const field = this.fields[id];
    field.reset(goal, this.grid.version);
    field.lastUsed = this.tick;
    this.byGoal.set(goal, id);
    this.pending.push(id);
    return id;
  }

  /** Snaps a world point to the nearest passable cell index. */
  private resolveGoal(x: number, z: number): number {
    const i = cellX(x);
    const j = cellZ(z);
    if (this.grid.passable(i, j)) return j * NAV_DIM + i;
    for (let r = 1; r <= 12; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          const ni = i + di;
          const nj = j + dj;
          if (this.grid.passable(ni, nj)) return nj * NAV_DIM + ni;
        }
      }
    }
    return -1;
  }

  /** Amortised construction. Called once per simulation tick. */
  update(budget: number): void {
    this.tick++;
    if (this.pending.length === 0) return;
    let remaining = budget;
    while (this.pending.length > 0 && remaining > 0) {
      const id = this.pending[0];
      const field = this.fields[id];
      const slice = Math.min(remaining, 9000);
      const done = field.step(this.grid, slice);
      remaining -= slice;
      if (done) this.pending.shift();
    }
  }

  isReady(id: number): boolean {
    return id >= 0 && id < this.fields.length && this.fields[id].ready;
  }

  touch(id: number): void {
    if (id >= 0 && id < this.fields.length) this.fields[id].lastUsed = this.tick;
  }

  goalOf(id: number): number {
    return id >= 0 && id < this.fields.length ? this.fields[id].goalCell : -1;
  }

  /**
   * Steering direction at (x, z) for field `id`, written into out[0..1].
   * Returns false when the cell has no route to the goal.
   */
  sample(id: number, x: number, z: number, out: Float32Array): boolean {
    if (id < 0 || id >= this.fields.length) return false;
    const field = this.fields[id];
    const integ = field.integration;
    const i = cellX(x);
    const j = cellZ(z);
    const k = j * NAV_DIM + i;
    if (integ[k] >= FIELD_INF && !field.ready) return false;

    let bestCost = integ[k];
    let bestI = -1;
    let bestJ = -1;
    for (let n = 0; n < 8; n++) {
      const ni = i + NEIGH_DX[n];
      const nj = j + NEIGH_DZ[n];
      if (ni < 0 || nj < 0 || ni >= NAV_DIM || nj >= NAV_DIM) continue;
      const nk = nj * NAV_DIM + ni;
      if (this.grid.cost[nk] === IMPASSABLE) continue;
      const c = integ[nk];
      if (c < bestCost) {
        bestCost = c;
        bestI = ni;
        bestJ = nj;
      }
    }
    if (bestI < 0) return false;
    const dx = cellCentreX(bestI) - x;
    const dz = cellCentreZ(bestJ) - z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-4) return false;
    out[0] = dx / len;
    out[1] = dz / len;
    return true;
  }

  /** Path cost from (x, z) to the field goal, or Infinity when unreachable. */
  costAt(id: number, x: number, z: number): number {
    if (id < 0 || id >= this.fields.length) return Infinity;
    const v = this.fields[id].integration[cellZ(z) * NAV_DIM + cellX(x)];
    return v >= FIELD_INF ? Infinity : v;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Uniform-grid spatial hash rebuilt from scratch each tick with a counting
 * sort. No allocation, no per-entity buckets, cache-friendly iteration.
 */
export class SpatialHash {
  private readonly cell: number;
  private readonly dim: number;
  private readonly starts: Int32Array;
  private readonly cursor: Int32Array;
  private readonly items: Int32Array;
  private readonly cellOf: Int32Array;

  constructor(cellSize: number, capacity: number) {
    this.cell = cellSize;
    this.dim = Math.ceil(WORLD_SIZE / cellSize) + 2;
    this.starts = new Int32Array(this.dim * this.dim + 1);
    this.cursor = new Int32Array(this.dim * this.dim);
    this.items = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
  }

  private index(x: number, z: number): number {
    let i = Math.floor((x - NAV_ORIGIN) / this.cell) + 1;
    let j = Math.floor((z - NAV_ORIGIN) / this.cell) + 1;
    if (i < 0) i = 0; else if (i >= this.dim) i = this.dim - 1;
    if (j < 0) j = 0; else if (j >= this.dim) j = this.dim - 1;
    return j * this.dim + i;
  }

  /** `ids` holds `count` entity indices; xs/zs are the parallel position arrays. */
  rebuild(ids: Int32Array, count: number, xs: Float32Array, zs: Float32Array): void {
    const cells = this.dim * this.dim;
    if (count > this.items.length) count = this.items.length;
    this.starts.fill(0);
    for (let n = 0; n < count; n++) {
      const id = ids[n];
      const c = this.index(xs[id], zs[id]);
      this.cellOf[n] = c;
      this.starts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) {
      this.starts[c + 1] += this.starts[c];
      this.cursor[c] = this.starts[c];
    }
    for (let n = 0; n < count; n++) {
      const c = this.cellOf[n];
      this.items[this.cursor[c]++] = ids[n];
    }
  }

  /**
   * Writes neighbour ids within `radius` of (x, z) into `out`, returning the
   * count. Never allocates; the caller owns the scratch array.
   */
  query(x: number, z: number, radius: number, out: Int32Array): number {
    const r = Math.ceil(radius / this.cell);
    let i0 = Math.floor((x - NAV_ORIGIN) / this.cell) + 1 - r;
    let i1 = Math.floor((x - NAV_ORIGIN) / this.cell) + 1 + r;
    let j0 = Math.floor((z - NAV_ORIGIN) / this.cell) + 1 - r;
    let j1 = Math.floor((z - NAV_ORIGIN) / this.cell) + 1 + r;
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= this.dim) i1 = this.dim - 1;
    if (j1 >= this.dim) j1 = this.dim - 1;
    let n = 0;
    const cap = out.length;
    for (let j = j0; j <= j1; j++) {
      const row = j * this.dim;
      for (let i = i0; i <= i1; i++) {
        const c = row + i;
        const start = this.starts[c];
        const end = this.starts[c + 1];
        for (let s = start; s < end; s++) {
          if (n >= cap) return n;
          out[n++] = this.items[s];
        }
      }
    }
    return n;
  }
}
