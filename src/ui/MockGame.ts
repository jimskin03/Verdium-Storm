import * as THREE from 'three';
import type {
  Alert, AlertKind, BuildOption, BuildableId, EconomySnapshot, GameStateService, MinimapBlip,
  SelectionSummary,
} from '@/game/GameState';
import type { BuildingType, Faction, Team, UnitType } from '@/entities/Types';
import { BASE_POSITIONS, HALF_WORLD, RESOURCE_FIELDS, heightAt } from '@/world/Heightfield';
import type { HealthTarget, WorldProbe } from './WorldProbe';

/**
 * A complete stand-in for the simulation's `GameStateService`.
 *
 * The battlefield stream owns the real one and may not have landed yet, so the
 * HUD ships with this: a small deterministic skirmish that produces every state
 * the interface can express — production queues, brownouts, tech locks, ready-
 * to-place structures, alerts of every kind, fog of war, moving blips, damaged
 * units and changing selections. Without it none of the HUD's states could be
 * developed or reviewed, and half of them would never be seen in a screenshot.
 *
 * It is seeded, so a given match time always produces the same frame.
 */

const UNITS: Array<{ id: UnitType; label: string; cost: number; time: number; hp: number; requires?: BuildingType }> = [
  { id: 'rifleman', label: 'RIFLEMAN', cost: 120, time: 5, hp: 120, requires: 'barracks' },
  { id: 'rocketeer', label: 'ROCKETEER', cost: 320, time: 9, hp: 110, requires: 'barracks' },
  { id: 'engineer', label: 'ENGINEER', cost: 500, time: 12, hp: 90, requires: 'barracks' },
  { id: 'scout', label: 'RECON BUGGY', cost: 400, time: 10, hp: 260, requires: 'factory' },
  { id: 'tank', label: 'BATTLE TANK', cost: 900, time: 20, hp: 900, requires: 'factory' },
  { id: 'artillery', label: 'SIEGE GUN', cost: 1200, time: 26, hp: 520, requires: 'lab' },
  { id: 'aa', label: 'FLAK TRACK', cost: 700, time: 15, hp: 480, requires: 'factory' },
  { id: 'harvester', label: 'HARVESTER', cost: 1400, time: 24, hp: 1000, requires: 'refinery' },
];

const BUILDINGS: Array<{ id: BuildingType; label: string; cost: number; time: number; hp: number; power: number; requires?: BuildingType }> = [
  { id: 'power', label: 'POWER PLANT', cost: 300, time: 9, hp: 900, power: 100 },
  { id: 'refinery', label: 'REFINERY', cost: 1600, time: 24, hp: 1400, power: -30 },
  { id: 'barracks', label: 'BARRACKS', cost: 500, time: 12, hp: 1000, power: -20 },
  { id: 'factory', label: 'WAR FACTORY', cost: 2000, time: 30, hp: 1600, power: -50, requires: 'refinery' },
  { id: 'turret', label: 'GUN TURRET', cost: 600, time: 11, hp: 800, power: -25, requires: 'barracks' },
  { id: 'sam', label: 'SAM BATTERY', cost: 800, time: 14, hp: 700, power: -35, requires: 'radar' },
  { id: 'radar', label: 'RADAR ARRAY', cost: 1000, time: 18, hp: 1000, power: -60, requires: 'refinery' },
  { id: 'lab', label: 'TECH LAB', cost: 2200, time: 34, hp: 1200, power: -80, requires: 'radar' },
  { id: 'hq', label: 'CONSTRUCTION YARD', cost: 3000, time: 40, hp: 2500, power: -20, requires: 'lab' },
];

const LABELS = new Map<BuildableId, string>([
  ...UNITS.map((u) => [u.id, u.label] as [BuildableId, string]),
  ...BUILDINGS.map((b) => [b.id, b.label] as [BuildableId, string]),
]);

export function labelFor(id: BuildableId): string {
  return LABELS.get(id) ?? String(id).toUpperCase();
}

interface Entity {
  id: number;
  type: BuildableId;
  kind: 'unit' | 'building';
  team: Team;
  pos: THREE.Vector3;
  hp: number;
  maxHp: number;
  radius: number;
  height: number;
  cargo?: number;
  cargoMax?: number;
  buildProgress?: number;
  /** Patrol path parameters; buildings simply do not move. */
  orbitR: number;
  orbitPhase: number;
  orbitSpeed: number;
  home: THREE.Vector2;
}

interface Production {
  id: BuildableId;
  progress: number;
  queued: number;
  ready: boolean;
}

const FOG_RES = 128;

/** Deterministic RNG so a given match time always renders the same frame. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class MockGame implements GameStateService, WorldProbe {
  readonly isMock = true;
  faction: Faction = 'gdi';
  readonly team: Team = 0;

  economy: EconomySnapshot = {
    credits: 4250,
    income: 980,
    powerProduced: 300,
    powerConsumed: 205,
    powerRatio: 1,
  };

  selection: SelectionSummary[] = [];
  alerts: Alert[] = [];
  matchTime = 0;
  kills = 0;
  losses = 0;
  unitCount = 0;
  unitCap = 80;
  paused = false;

  /** Set by the HUD so `focusOn` actually drives the camera rig. */
  onFocus: ((p: THREE.Vector3) => void) | null = null;

  private listeners = new Set<() => void>();
  private entities: Entity[] = [];
  private nextId = 1;
  private production = new Map<'unit' | 'building', Production | null>([
    ['unit', null],
    ['building', null],
  ]);
  private queues = new Map<BuildableId, number>();
  private built = new Set<BuildingType>(['power', 'refinery', 'barracks', 'factory', 'radar']);
  private explored = new Uint8Array(FOG_RES * FOG_RES);
  private visible = new Uint8Array(FOG_RES * FOG_RES);
  private fogTimer = 0;
  private scriptTimer = 0;
  private scriptStep = 0;
  private selectionTimer = 0;
  private brownoutTimer = 0;
  private rand = rng(0x5eed);
  private dirty = true;

  constructor() {
    this.spawnBase(0, BASE_POSITIONS.player);
    this.spawnBase(1, BASE_POSITIONS.enemy);
    this.spawnSkirmish();
    this.seedFog();
    this.startProduction('unit', 'tank');
    this.startProduction('building', 'turret');
    this.queues.set('rifleman', 3);
    this.queues.set('tank', 2);
    this.unitCount = this.entities.filter((e) => e.kind === 'unit' && e.team === 0).length;
    this.cycleSelection();
  }

  // -- construction ---------------------------------------------------------

  private add(
    type: BuildableId, kind: 'unit' | 'building', team: Team,
    x: number, z: number, hp: number, maxHp: number, radius: number, height: number,
  ): Entity {
    const e: Entity = {
      id: this.nextId++,
      type, kind, team,
      pos: new THREE.Vector3(x, heightAt(x, z), z),
      hp, maxHp, radius, height,
      orbitR: 0, orbitPhase: this.rand() * Math.PI * 2, orbitSpeed: 0,
      home: new THREE.Vector2(x, z),
    };
    this.entities.push(e);
    return e;
  }

  private spawnBase(team: Team, centre: THREE.Vector3): void {
    const layout: Array<[BuildingType, number, number]> = [
      ['hq', 0, 0], ['power', 46, -18], ['power', 46, 12], ['refinery', -34, 34],
      ['barracks', -44, -22], ['factory', 6, 48], ['radar', 40, 46],
      ['turret', -62, 4], ['turret', 22, -56], ['sam', -8, -62],
    ];
    for (const [type, dx, dz] of layout) {
      const def = BUILDINGS.find((b) => b.id === type);
      const hp = def?.hp ?? 1000;
      const damage = this.rand() < 0.25 ? 0.35 + this.rand() * 0.45 : 1;
      this.add(type, 'building', team, centre.x + dx, centre.z + dz, hp * damage, hp, 12, 16);
    }

    const squad: Array<[UnitType, number]> = [
      ['tank', 4], ['rifleman', 6], ['rocketeer', 3], ['harvester', 2], ['scout', 2], ['aa', 1],
    ];
    for (const [type, count] of squad) {
      const def = UNITS.find((u) => u.id === type);
      for (let i = 0; i < count; i++) {
        const a = this.rand() * Math.PI * 2;
        const r = 40 + this.rand() * 55;
        const e = this.add(
          type, 'unit', team,
          centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r,
          (def?.hp ?? 200) * (0.45 + this.rand() * 0.55), def?.hp ?? 200,
          type === 'rifleman' || type === 'rocketeer' ? 2.2 : 4.5,
          type === 'rifleman' || type === 'rocketeer' ? 4.5 : 6.5,
        );
        e.orbitR = 18 + this.rand() * 34;
        e.orbitSpeed = (0.1 + this.rand() * 0.24) * (this.rand() < 0.5 ? -1 : 1);
        if (type === 'harvester') {
          e.cargoMax = 700;
          e.cargo = Math.round(this.rand() * 700);
        }
      }
    }
  }

  /** A contested pocket at mid-map so the 'battle' shot preset has content. */
  private spawnSkirmish(): void {
    for (let i = 0; i < 14; i++) {
      const team: Team = i % 2 === 0 ? 0 : 1;
      const a = (i / 14) * Math.PI * 2;
      const r = 26 + this.rand() * 46;
      const type: UnitType = i % 5 === 0 ? 'artillery' : i % 3 === 0 ? 'rifleman' : 'tank';
      const def = UNITS.find((u) => u.id === type);
      const e = this.add(
        type, 'unit', team,
        Math.cos(a) * r + (team === 0 ? -26 : 26), Math.sin(a) * r,
        (def?.hp ?? 400) * (0.25 + this.rand() * 0.6), def?.hp ?? 400,
        type === 'rifleman' ? 2.2 : 4.5, type === 'rifleman' ? 4.5 : 6.5,
      );
      e.orbitR = 10 + this.rand() * 20;
      e.orbitSpeed = (0.2 + this.rand() * 0.3) * (this.rand() < 0.5 ? -1 : 1);
    }
  }

  private seedFog(): void {
    const cell = (HALF_WORLD * 2) / FOG_RES;
    for (const e of this.entities) {
      if (e.team !== 0) continue;
      const gx = Math.floor((e.pos.x + HALF_WORLD) / cell);
      const gz = Math.floor((e.pos.z + HALF_WORLD) / cell);
      const r = e.kind === 'building' ? 9 : 7;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r) continue;
          const x = gx + dx;
          const z = gz + dz;
          if (x < 0 || z < 0 || x >= FOG_RES || z >= FOG_RES) continue;
          this.explored[z * FOG_RES + x] = 255;
        }
      }
    }
    // A scouted corridor toward the contested middle.
    for (let t = 0; t <= 1; t += 0.004) {
      const x = THREE.MathUtils.lerp(BASE_POSITIONS.player.x, 40, t);
      const z = THREE.MathUtils.lerp(BASE_POSITIONS.player.z, 30, t);
      const gx = Math.floor((x + HALF_WORLD) / cell);
      const gz = Math.floor((z + HALF_WORLD) / cell);
      for (let dz = -5; dz <= 5; dz++) {
        for (let dx = -5; dx <= 5; dx++) {
          if (dx * dx + dz * dz > 25) continue;
          const px = gx + dx;
          const pz = gz + dz;
          if (px < 0 || pz < 0 || px >= FOG_RES || pz >= FOG_RES) continue;
          this.explored[pz * FOG_RES + px] = 255;
        }
      }
    }
    this.updateVisibility();
  }

  private updateVisibility(): void {
    this.visible.fill(0);
    const cell = (HALF_WORLD * 2) / FOG_RES;
    for (const e of this.entities) {
      if (e.team !== 0) continue;
      const gx = Math.floor((e.pos.x + HALF_WORLD) / cell);
      const gz = Math.floor((e.pos.z + HALF_WORLD) / cell);
      const r = e.kind === 'building' ? 8 : 6;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r) continue;
          const x = gx + dx;
          const z = gz + dz;
          if (x < 0 || z < 0 || x >= FOG_RES || z >= FOG_RES) continue;
          this.visible[z * FOG_RES + x] = 255;
          this.explored[z * FOG_RES + x] = 255;
        }
      }
    }
  }

  // -- production -----------------------------------------------------------

  private startProduction(kind: 'unit' | 'building', id: BuildableId): void {
    this.production.set(kind, { id, progress: 0, queued: this.queues.get(id) ?? 0, ready: false });
  }

  private buildTime(id: BuildableId): number {
    return UNITS.find((u) => u.id === id)?.time ?? BUILDINGS.find((b) => b.id === id)?.time ?? 12;
  }

  private costOf(id: BuildableId): number {
    return UNITS.find((u) => u.id === id)?.cost ?? BUILDINGS.find((b) => b.id === id)?.cost ?? 100;
  }

  buildOptions(kind: 'unit' | 'building'): BuildOption[] {
    const active = this.production.get(kind) ?? null;
    const list = kind === 'unit' ? UNITS : BUILDINGS;
    return list.map((def) => {
      const requires = def.requires;
      const techOk = !requires || this.built.has(requires);
      const powerOk = this.economy.powerRatio > 0.55 || def.cost < 400;
      const funded = this.economy.credits >= def.cost * 0.35;
      let lockedReason: string | undefined;
      if (!techOk) lockedReason = `REQUIRES ${labelFor(requires as BuildableId)}`;
      else if (!powerOk) lockedReason = 'INSUFFICIENT POWER — RESTORE THE GRID';
      else if (!funded) lockedReason = 'INSUFFICIENT CREDITS';
      const isActive = active?.id === def.id;
      return {
        id: def.id as BuildableId,
        label: def.label,
        kind,
        cost: def.cost,
        buildTime: def.time,
        available: !lockedReason,
        lockedReason,
        progress: isActive ? active.progress : 0,
        queued: this.queues.get(def.id as BuildableId) ?? 0,
        readyToPlace: isActive ? active.ready : false,
      };
    });
  }

  queueBuild(id: BuildableId): void {
    const kind: 'unit' | 'building' = UNITS.some((u) => u.id === id) ? 'unit' : 'building';
    const active = this.production.get(kind);
    if (active && active.id === id) {
      this.queues.set(id, (this.queues.get(id) ?? 0) + 1);
    } else if (!active) {
      this.startProduction(kind, id);
    } else {
      this.queues.set(id, (this.queues.get(id) ?? 0) + 1);
    }
    this.economy.credits = Math.max(0, this.economy.credits - this.costOf(id) * 0.25);
    this.touch();
  }

  cancelBuild(id: BuildableId): void {
    const queued = this.queues.get(id) ?? 0;
    if (queued > 0) {
      this.queues.set(id, queued - 1);
      this.economy.credits += this.costOf(id) * 0.25;
    } else {
      for (const [kind, active] of this.production) {
        if (active?.id === id) {
          this.economy.credits += this.costOf(id) * active.progress * 0.9;
          this.production.set(kind, null);
        }
      }
    }
    this.touch();
  }

  beginPlacement(id: BuildingType): void {
    const active = this.production.get('building');
    if (active?.id === id && active.ready) {
      this.production.set('building', null);
      this.built.add(id);
      this.raise('buildingComplete', `${labelFor(id)} DEPLOYED`, BASE_POSITIONS.player);
    }
    this.touch();
  }

  // -- selection ------------------------------------------------------------

  private selectedIds: number[] = [];

  private summarise(e: Entity): SelectionSummary {
    return {
      id: e.id,
      label: labelFor(e.type),
      kind: e.kind,
      type: e.type,
      hp: Math.round(e.hp),
      maxHp: e.maxHp,
      cargo: e.cargo,
      cargoMax: e.cargoMax,
      buildProgress: e.buildProgress,
    };
  }

  private cycleSelection(): void {
    const mine = this.entities.filter((e) => e.team === 0);
    const roll = this.rand();
    if (roll < 0.34) {
      // Single unit — exercises the detailed readout.
      const pool = mine.filter((e) => e.kind === 'unit');
      const pick = pool[Math.floor(this.rand() * pool.length)];
      this.selectedIds = pick ? [pick.id] : [];
    } else if (roll < 0.5) {
      const pool = mine.filter((e) => e.kind === 'building');
      const pick = pool[Math.floor(this.rand() * pool.length)];
      this.selectedIds = pick ? [pick.id] : [];
    } else {
      const pool = mine.filter((e) => e.kind === 'unit');
      const centre = pool[Math.floor(this.rand() * pool.length)];
      if (!centre) {
        this.selectedIds = [];
      } else {
        this.selectedIds = pool
          .filter((e) => e.pos.distanceTo(centre.pos) < 90)
          .slice(0, 12)
          .map((e) => e.id);
      }
    }
    this.refreshSelection();
  }

  private refreshSelection(): void {
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    this.selection = this.selectedIds
      .map((id) => byId.get(id))
      .filter((e): e is Entity => !!e)
      .map((e) => this.summarise(e));
  }

  selectAll(type?: BuildableId): void {
    const pool = this.entities.filter((e) => e.team === 0 && (!type || e.type === type) && e.kind === 'unit');
    this.selectedIds = pool.slice(0, 24).map((e) => e.id);
    this.refreshSelection();
    this.touch();
  }

  focusOn(position: THREE.Vector3): void {
    this.onFocus?.(position);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.touch();
  }

  dismissAlert(index: number): void {
    this.alerts.splice(index, 1);
    this.touch();
  }

  // -- minimap --------------------------------------------------------------

  minimapBlips(): MinimapBlip[] {
    const out: MinimapBlip[] = [];
    for (const f of RESOURCE_FIELDS) {
      out.push({ x: f.x, z: f.z, team: 0, kind: 'resource', size: f.radius * 0.55 });
    }
    for (const e of this.entities) {
      out.push({
        x: e.pos.x,
        z: e.pos.z,
        team: e.team,
        kind: e.kind,
        size: e.kind === 'building' ? 9 : e.radius > 3 ? 5 : 3.4,
      });
    }
    return out;
  }

  fogGrids(): { explored: Uint8Array; visible: Uint8Array; resolution: number } | null {
    return { explored: this.explored, visible: this.visible, resolution: FOG_RES };
  }

  // -- world probe ----------------------------------------------------------

  entityPose(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const e = this.entities.find((x) => x.id === id);
    return e ? out.copy(e.pos) : null;
  }

  entityRadius(id: number): number {
    return this.entities.find((x) => x.id === id)?.radius ?? 4;
  }

  healthTargets(): HealthTarget[] {
    const selected = new Set(this.selectedIds);
    const out: HealthTarget[] = [];
    for (const e of this.entities) {
      const hurt = e.hp < e.maxHp * 0.995;
      if (!hurt && !selected.has(e.id)) continue;
      out.push({
        id: e.id,
        hp: e.hp,
        maxHp: e.maxHp,
        team: e.team,
        height: e.height,
        position: e.pos,
        selected: selected.has(e.id),
      });
    }
    return out;
  }

  // -- events ---------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private touch(): void {
    this.dirty = true;
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const l of this.listeners) l();
  }

  private raise(kind: AlertKind, message: string, position?: THREE.Vector3): void {
    this.alerts.unshift({ kind, message, age: 0, position: position?.clone() });
    if (this.alerts.length > 7) this.alerts.length = 7;
    this.touch();
  }

  /** Scripted beats so every alert treatment shows up within a minute. */
  private readonly script: Array<[number, () => void]> = [
    [4, () => this.raise('unitReady', 'BATTLE TANK READY', BASE_POSITIONS.player)],
    [7, () => this.raise('newTech', 'TECH LAB BLUEPRINTS ACQUIRED')],
    [11, () => {
      this.raise('baseUnderAttack', 'BASE UNDER ATTACK — NORTH PERIMETER', new THREE.Vector3(-238, 0, -352));
      this.losses += 1;
    }],
    [15, () => this.raise('unitLost', 'RIFLEMAN SQUAD LOST', new THREE.Vector3(-238, 0, -352))],
    [19, () => { this.brownoutTimer = 16; this.raise('lowPower', 'POWER GRID OVERLOADED'); }],
    [24, () => this.raise('insufficientFunds', 'INSUFFICIENT CREDITS')],
    [29, () => this.raise('harvesterLost', 'HARVESTER LOST', new THREE.Vector3(-210, 0, -320))],
    [34, () => this.raise('buildingComplete', 'GUN TURRET ONLINE', BASE_POSITIONS.player)],
    [40, () => { this.kills += 3; this.raise('unitReady', 'HARVESTER READY', BASE_POSITIONS.player); }],
  ];

  // -- tick -----------------------------------------------------------------

  update(dt: number): void {
    if (this.paused || dt <= 0) return;
    this.matchTime += dt;

    // Economy. Credits drift with income, harvester deliveries and spending.
    const brownout = this.brownoutTimer > 0;
    if (brownout) this.brownoutTimer -= dt;
    this.economy.powerProduced = brownout ? 190 : 300 + Math.round(Math.sin(this.matchTime * 0.11) * 8);
    this.economy.powerConsumed = 205 + Math.round(Math.sin(this.matchTime * 0.17) * 24);
    this.economy.powerRatio = Math.min(1.6, this.economy.powerProduced / Math.max(1, this.economy.powerConsumed));

    const rate = this.economy.income / 60;
    this.economy.credits = Math.max(0, this.economy.credits + rate * dt * (brownout ? 0.6 : 1));
    this.economy.income = 900 + Math.sin(this.matchTime * 0.07) * 260 + (brownout ? -220 : 0);

    // Production, slowed by a brownout exactly like the real rules describe.
    for (const [kind, active] of this.production) {
      if (!active) {
        const list = kind === 'unit' ? UNITS : BUILDINGS;
        const pick = list[Math.floor(this.rand() * list.length)];
        this.startProduction(kind, pick.id as BuildableId);
        continue;
      }
      if (active.ready) continue;
      const speed = Math.min(1, this.economy.powerRatio) * (this.economy.credits > 60 ? 1 : 0.25);
      active.progress += (dt / this.buildTime(active.id)) * speed;
      if (active.progress >= 1) {
        active.progress = 1;
        this.economy.credits = Math.max(0, this.economy.credits - this.costOf(active.id) * 0.55);
        if (kind === 'building') {
          active.ready = true;
        } else {
          const queued = this.queues.get(active.id) ?? 0;
          this.unitCount = Math.min(this.unitCap, this.unitCount + 1);
          this.raise('unitReady', `${labelFor(active.id)} READY`, BASE_POSITIONS.player);
          if (queued > 0) {
            this.queues.set(active.id, queued - 1);
            active.progress = 0;
          } else {
            this.production.set(kind, null);
          }
        }
      }
      this.touch();
    }

    // Ready structures wait a while for a placement order, then auto-deploy.
    const readyBuilding = this.production.get('building');
    if (readyBuilding?.ready) {
      readyBuilding.progress = 1;
      if (this.matchTime % 60 > 55) this.beginPlacement(readyBuilding.id as BuildingType);
    }

    // Movement: gentle patrols keep the minimap and in-world overlay alive.
    for (const e of this.entities) {
      if (e.kind !== 'unit') continue;
      e.orbitPhase += e.orbitSpeed * dt;
      const x = e.home.x + Math.cos(e.orbitPhase) * e.orbitR;
      const z = e.home.y + Math.sin(e.orbitPhase * 0.8) * e.orbitR;
      e.pos.set(x, heightAt(x, z), z);
      if (e.cargoMax) {
        e.cargo = (e.cargo ?? 0) + dt * 26;
        if (e.cargo > e.cargoMax) e.cargo = 0;
      }
      // Slow attrition and repair so health bars keep changing.
      const drift = Math.sin(this.matchTime * 0.6 + e.id) * 0.5 + 0.5;
      e.hp = Math.max(e.maxHp * 0.12, Math.min(e.maxHp, e.hp + (drift - 0.52) * e.maxHp * 0.05 * dt));
    }

    this.fogTimer += dt;
    if (this.fogTimer > 0.4) {
      this.fogTimer = 0;
      this.updateVisibility();
      this.touch();
    }

    this.selectionTimer += dt;
    if (this.selectionTimer > 9) {
      this.selectionTimer = 0;
      this.cycleSelection();
      this.touch();
    } else {
      this.refreshSelection();
    }

    for (const a of this.alerts) a.age += dt;
    while (this.alerts.length && this.alerts[this.alerts.length - 1].age > 26) {
      this.alerts.pop();
      this.touch();
    }

    this.scriptTimer += dt;
    if (this.scriptStep < this.script.length && this.scriptTimer >= this.script[this.scriptStep][0]) {
      this.script[this.scriptStep][1]();
      this.scriptStep++;
    }
    if (this.scriptStep >= this.script.length && this.scriptTimer > 52) {
      this.scriptTimer = 0;
      this.scriptStep = 0;
    }

    this.unitCount = this.entities.filter((e) => e.kind === 'unit' && e.team === 0).length;
    this.flush();
  }

  /** Lets the faction-select screen re-skin the mock match. */
  setFaction(f: Faction): void {
    this.faction = f;
    this.touch();
  }

  /** Used by the harness so screenshots land on a known-interesting frame. */
  fastForward(seconds: number): void {
    const step = 1 / 30;
    for (let t = 0; t < seconds; t += step) this.update(step);
  }
}
