import * as THREE from 'three';
import { provide } from '@/engine/Services';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { HALF_WORLD, RESOURCE_FIELDS, WORLD_SIZE } from '@/world/Heightfield';
import type { BuildingType, Faction, Team, UnitType } from '@/entities/Types';
import type {
  Alert,
  BuildOption,
  BuildableId,
  EconomySnapshot,
  GameStateService,
  MinimapBlip,
  SelectionSummary,
} from '@/game/GameState';
import { Sim, UNIT_CAP } from '@/game/sim/Sim';
import { Commander, DEFAULT_CONFIG } from '@/game/sim/Ai';
import { PlayerController } from '@/game/sim/Commands';
import { MultiplayerLobby, type LobbySnapshot, type MultiplayerAction } from '@/game/Multiplayer';
import { Order, Stance, refSlot } from '@/game/sim/Entities';
import {
  BUILDING_ID,
  BUILDING_LIST,
  BUILDING_TYPES,
  CONSTRUCTABLE,
  UNIT_ID,
  UNIT_LIST,
  UNIT_TYPES,
  isBuildingType,
  isUnitType,
} from '@/game/sim/Stats';
import { NAV_CELL } from '@/game/sim/Nav';
import { EventJournal, type GameEvent } from '@/game/agent/EventJournal';
import { PACING, pacingFrom, type PacingProfile } from '@/game/agent/Pacing';
import type {
  AgentCommand,
  AgentControlService,
  AgentObservation,
  CommandAck,
  MapBounds,
  ObjectivesSummary,
  ObservedAvailableBuild,
  ObservedEntity,
  ObservedProduction,
  ObservedProductionQueueItem,
  ObservedResourceField,
  SpectatorInfo,
} from '@/game/agent/AgentTypes';

/**
 * The match. Owns the simulation, the two commanders and the player's input
 * controller, and implements the read/command surface the HUD consumes.
 *
 * Both sides are driven by a commander from the first frame, so the game is
 * always a running battle rather than an empty map waiting for orders. The
 * player's commander stands down the instant a human or agent issues a command.
 *
 * Determinism: everything advances on the fixed simulation step inside `Sim`,
 * driven only by the `dt` the engine hands us. No wall clock, no unseeded
 * randomness — `window.VS.step(n)` reproduces a match exactly.
 */

const PLAYER_TEAM: Team = 0;
const PLAYER_FACTION: Faction = 'gdi';
const ENEMY_FACTION: Faction = 'nod';
const MATCH_SEED = 0x5eed_0731;

const sumInt = (a: number, b: number) => a + b;

const ORDER_NAMES: Record<number, string> = {
  [Order.None]: 'idle',
  [Order.Move]: 'move',
  [Order.AttackMove]: 'attack-move',
  [Order.Attack]: 'attack',
  [Order.Harvest]: 'harvest',
  [Order.Repair]: 'repair',
  [Order.Capture]: 'capture',
  [Order.Guard]: 'guard',
};

const ORDER_BY_NAME: Record<string, number> = {
  idle: Order.None,
  none: Order.None,
  move: Order.Move,
  'attack-move': Order.AttackMove,
  attackmove: Order.AttackMove,
  attack: Order.Attack,
  harvest: Order.Harvest,
  repair: Order.Repair,
  capture: Order.Capture,
  guard: Order.Guard,
};

const STANCE_VALUES: Record<string, number> = {
  aggressive: Stance.Aggressive,
  guard: Stance.Guard,
  defensive: Stance.Guard,
  hold: Stance.HoldFire,
  holdfire: Stance.HoldFire,
};

function parseRef(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val >>> 0 : null;
  }
  if (typeof val === 'string') {
    const m = val.match(/(\d+)/);
    if (m) return parseInt(m[1], 10) >>> 0;
  }
  return null;
}

function parseRefs(val: unknown): number[] {
  if (Array.isArray(val)) {
    return val.map(parseRef).filter((r): r is number => r !== null);
  }
  const single = parseRef(val);
  return single !== null ? [single] : [];
}

export class Battlefield implements System, GameStateService, AgentControlService {
  readonly name = 'battlefield';
  readonly phase = Phase.SIMULATION;

  private sim!: Sim;
  private player!: PlayerController;
  private commanders: Commander[] = [];
  private camera!: THREE.PerspectiveCamera;
  private context!: EngineContext;
  private started = false;
  private multiplayer: MultiplayerLobby | null = null;
  private multiplayerUnsubscribe: (() => void) | null = null;
  private remoteActions: Array<{ action: MultiplayerAction; team?: 0 | 1 }> = [];
  private playerTeam: Team | 2 = PLAYER_TEAM;
  private playerFaction: Faction = PLAYER_FACTION;
  private pacing: PacingProfile = PACING.classic;
  private journal = new EventJournal();
  private loggedAlerts = new WeakSet<Alert>();

  private listeners: Array<() => void> = [];
  private signature = '';

  private economySnapshot: EconomySnapshot = {
    credits: 0,
    income: 0,
    powerProduced: 0,
    powerConsumed: 0,
    powerRatio: 1,
  };
  private options: BuildOption[] = [];
  private blips: MinimapBlip[] = [];

  get team(): Team | 2 {
    return this.playerTeam;
  }
  get faction(): Faction {
    return this.playerFaction;
  }
  readonly unitCap = UNIT_CAP;

  /* ================================================================== *
   * Lifecycle
   * ================================================================== */

  init(ctx: EngineContext): void {
    this.context = ctx;
    this.camera = ctx.camera;
    const search = typeof location !== 'undefined' ? location.search : '';
    const params = new URLSearchParams(search);
    const requestedPacing = params.get('pacing')
      ?? (params.get('headless') === '1' || (params.get('agent') === '1' && params.get('render') === 'none')
        ? 'deliberate'
        : null);
    this.pacing = pacingFrom(requestedPacing);
    this.resetMatch(PLAYER_FACTION, null);
    provide('game', this);
  }

  update(dt: number): void {
    if (!this.started) return;
    this.applyRemoteActions();
    this.player.update(dt);
    const simDt = dt * this.pacing.simulationRate;
    if (!this.sim.paused) {
      for (const c of this.commanders) c.update(simDt);
    }
    this.sim.update(simDt, this.camera);
    for (const alert of this.sim.alerts) {
      if (this.loggedAlerts.has(alert)) continue;
      this.loggedAlerts.add(alert);
      const alertTeam: 0 | 1 | undefined = this.team < 2 ? (this.team as 0 | 1) : undefined;
      this.journal.append(
        this.sim.tickCount,
        'alert',
        'team',
        {
          kind: alert.kind,
          message: alert.message,
          ...(alert.position ? { x: Math.round(alert.position.x), z: Math.round(alert.position.z) } : {}),
        },
        alertTeam,
      );
    }
    this.refresh();
  }

  dispose(): void {
    this.multiplayerUnsubscribe?.();
    this.player?.dispose();
    this.sim?.dispose();
    this.listeners.length = 0;
  }

  /* ================================================================== *
   * Change notification
   * ================================================================== */

  private refresh(): void {
    const teamIdx = this.team < 2 ? (this.team as 0 | 1) : 0;
    const state = this.sim.teams[teamIdx];
    this.economySnapshot.credits = Math.round(state.credits);
    this.economySnapshot.income = Math.round(state.income);
    this.economySnapshot.powerProduced = state.powerProduced;
    this.economySnapshot.powerConsumed = state.powerConsumed;
    this.economySnapshot.powerRatio = state.powerRatio;

    const sig =
      `${this.economySnapshot.credits}|${state.powerProduced}|${state.powerConsumed}` +
      `|${this.player.selectionVersion}|${this.sim.alerts.length}|${state.readyBuilding}` +
      `|${this.sim.unitCountFor(teamIdx)}|${state.construction.items.length}` +
      `|${Math.floor(this.sim.matchTime)}|${state.kills}|${state.losses}`;
    if (sig === this.signature) return;
    this.signature = sig;
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /* ================================================================== *
   * Read surface
   * ================================================================== */

  get economy(): EconomySnapshot {
    return this.economySnapshot;
  }

  get selection(): SelectionSummary[] {
    return this.started ? this.player.selection() : [];
  }

  get alerts(): Alert[] {
    return this.started ? this.sim.alerts : [];
  }

  get matchTime(): number {
    return this.started ? this.sim.matchTime : 0;
  }

  get kills(): number {
    const teamIdx = this.team < 2 ? (this.team as 0 | 1) : 0;
    return this.started ? this.sim.teams[teamIdx].kills : 0;
  }

  get losses(): number {
    const teamIdx = this.team < 2 ? (this.team as 0 | 1) : 0;
    return this.started ? this.sim.teams[teamIdx].losses : 0;
  }

  get unitCount(): number {
    const teamIdx = this.team < 2 ? (this.team as 0 | 1) : 0;
    return this.started ? this.sim.unitCountFor(teamIdx) : 0;
  }

  get paused(): boolean {
    return this.started ? this.sim.paused : false;
  }

  buildOptions(kind: 'unit' | 'building'): BuildOption[] {
    this.options.length = 0;
    if (!this.started || this.team >= 2) return this.options;
    const teamIdx = this.team as 0 | 1;
    const state = this.sim.teams[teamIdx];

    if (kind === 'unit') {
      for (let id = 0; id < UNIT_LIST.length; id++) {
        const stats = UNIT_LIST[id];
        const locked = this.sim.unitLockReason(teamIdx, id);
        let progress = 0;
        let queued = 0;
        const b = this.sim.buildings;
        b.refreshLive();
        for (let n = 0; n < b.liveCount; n++) {
          const i = b.live[n];
          if (b.team[i] !== teamIdx) continue;
          const items = b.queues[i].items;
          for (let q = 0; q < items.length; q++) {
            if (items[q] !== id) continue;
            if (q === 0) progress = Math.max(progress, b.queues[i].progress);
            else queued++;
          }
        }
        this.options.push({
          id: stats.type,
          label: stats.label,
          kind: 'unit',
          cost: stats.cost,
          buildTime: stats.buildTime,
          available: locked === null,
          lockedReason: locked ?? undefined,
          progress,
          queued,
          readyToPlace: false,
        });
      }
      return this.options;
    }

    for (const id of CONSTRUCTABLE) {
      const stats = BUILDING_LIST[id];
      const locked = this.sim.buildingLockReason(teamIdx, id);
      const q = state.construction;
      const active = q.items.length > 0 && q.items[0] === id;
      let queued = 0;
      for (let i = 1; i < q.items.length; i++) if (q.items[i] === id) queued++;
      this.options.push({
        id: stats.type,
        label: stats.label,
        kind: 'building',
        cost: stats.cost,
        buildTime: stats.buildTime,
        available: locked === null,
        lockedReason: locked ?? undefined,
        progress: active ? q.progress : 0,
        queued,
        readyToPlace: state.readyBuilding === id,
      });
    }
    return this.options;
  }

  minimapBlips(): MinimapBlip[] {
    this.blips.length = 0;
    if (!this.started) return this.blips;

    for (const f of RESOURCE_FIELDS) {
      if (this.team < 2 && !this.sim.fog.isExplored(this.team, f.x, f.z)) continue;
      this.blips.push({ x: f.x, z: f.z, team: 0, kind: 'resource', size: f.radius * 0.5 });
    }

    const b = this.sim.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (!b.visible[i]) continue;
      this.blips.push({
        x: b.px[i],
        z: b.pz[i],
        team: b.team[i] as Team,
        kind: 'building',
        size: BUILDING_LIST[b.type[i]].footprint * NAV_CELL * 0.5,
      });
    }

    const u = this.sim.units;
    u.refreshLive();
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (!u.visible[i]) continue;
      this.blips.push({
        x: u.px[i],
        z: u.pz[i],
        team: u.team[i] as Team,
        kind: 'unit',
        size: UNIT_LIST[u.type[i]].radius,
      });
    }
    return this.blips;
  }

  fogGrids(): { explored: Uint8Array; visible: Uint8Array; resolution: number } | null {
    return this.started ? this.sim.fog.grids() : null;
  }

  /* ================================================================== *
   * Command surface
   * ================================================================== */

  queueBuild(id: BuildableId): void {
    if (!this.started || this.team >= 2) return;
    this.queueBuildFor(this.team as 0 | 1, id);
    this.multiplayer?.sendAction({ type: 'queue-build', id });
    this.takeControl();
  }

  cancelBuild(id: BuildableId): void {
    if (!this.started || this.team >= 2) return;
    this.cancelBuildFor(this.team as 0 | 1, id);
    this.multiplayer?.sendAction({ type: 'cancel-build', id });
    this.takeControl();
  }

  beginPlacement(id: BuildingType): void {
    if (!this.started || this.team >= 2) return;
    const teamIdx = this.team as 0 | 1;
    if (this.sim.teams[teamIdx].readyBuilding !== BUILDING_ID[id]) return;
    this.player.beginPlacement(BUILDING_ID[id]);
    this.takeControl();
  }

  selectAll(type?: BuildableId): void {
    if (!this.started) return;
    this.player.selectAll(type);
  }

  focusOn(position: THREE.Vector3): void {
    const rig = (window as unknown as { VS?: { rig?: { setPose(p: { target: THREE.Vector3 }): void } } }).VS?.rig;
    if (rig?.setPose) rig.setPose({ target: position.clone() });
    window.dispatchEvent(new CustomEvent('vs-focus', { detail: { x: position.x, z: position.z } }));
  }

  setPaused(paused: boolean): void {
    if (!this.started) return;
    if (this.multiplayer?.isLaunched && paused) return;
    this.sim.paused = paused;
  }

  dismissAlert(index: number): void {
    if (!this.started) return;
    if (index >= 0 && index < this.sim.alerts.length) this.sim.alerts.splice(index, 1);
  }

  private takeControl(): void {
    if (this.team < 2) {
      this.commanders[this.team]?.release();
    }
  }

  configureMatch(faction: Faction, lobby: MultiplayerLobby | null = null): void {
    this.resetMatch(faction, lobby);
  }

  private resetMatch(faction: Faction, lobby: MultiplayerLobby | null): void {
    this.multiplayerUnsubscribe?.();
    this.multiplayerUnsubscribe = null;
    this.player?.dispose();
    this.sim?.dispose();

    this.multiplayer = lobby;
    this.playerTeam = lobby?.team ?? PLAYER_TEAM;
    this.playerFaction = lobby ? (this.playerTeam === 1 ? 'nod' : 'gdi') : faction;
    const enemyFaction: Faction = this.playerFaction === 'gdi' ? 'nod' : 'gdi';
    const seed = lobby?.seed ?? MATCH_SEED;

    this.sim = new Sim(this.context.scene, {
      playerTeam: this.playerTeam,
      playerFaction: this.playerFaction,
      enemyFaction,
      seed,
      autoPlayer: lobby === null,
      pacing: this.pacing,
      onEvent: (event) => {
        this.journal.append(
          event.tick,
          event.type,
          event.visibility,
          event.payload,
          event.team,
        );
      },
    });
    this.sim.build();

    if (this.playerTeam >= 2) {
      this.sim.fog.setEnabled(false);
    }

    this.player = new PlayerController(this.sim, this.playerTeam);
    this.player.init(this.context);
    this.player.onAction = lobby ? (action) => lobby.sendAction(action) : null;

    if (lobby) {
      this.commanders = [];
      this.multiplayerUnsubscribe = lobby.onAction((action, team) => this.remoteActions.push({ action, team }));
    } else {
      const pacedAi = {
        ...DEFAULT_CONFIG,
        openingPeaceTicks: this.pacing.openingPeaceTicks,
        thinkTicks: this.pacing.commanderThinkTicks,
        minimumWaveTicks: this.pacing.minimumWaveTicks,
        regroupTicks: this.pacing.regroupTicks,
      };
      this.commanders = [
        new Commander(this.sim, 0, seed ^ 0x11, pacedAi),
        new Commander(this.sim, 1, seed ^ 0x22, { ...pacedAi, aggression: 1.15 }),
      ];
      this.player.onFirstCommand = () => {
        if (this.team < 2) this.commanders[this.team]?.release();
      };
    }

    if (this.context.quality.tier === 'low') this.sim.fog.setEnabled(false);

    this.remoteActions.length = 0;
    this.journal = new EventJournal();
    this.loggedAlerts = new WeakSet<Alert>();
    const startTeam: 0 | 1 | undefined = this.team < 2 ? (this.team as 0 | 1) : undefined;
    this.journal.append(this.sim.tickCount, 'match_started', 'public', { pacing: this.pacing.id, team: this.team }, startTeam);
    this.started = true;
    this.signature = '';
    this.refresh();
  }

  private queueBuildFor(team: 0 | 1, id: BuildableId): boolean {
    if (isUnitType(id)) return this.sim.queueUnit(team, UNIT_ID[id]);
    if (isBuildingType(id)) return this.sim.queueBuilding(team, BUILDING_ID[id]);
    return false;
  }

  private cancelBuildFor(team: 0 | 1, id: BuildableId): boolean {
    if (isUnitType(id)) return this.sim.cancelUnit(team, UNIT_ID[id]);
    if (isBuildingType(id)) return this.sim.cancelBuilding(team, BUILDING_ID[id]);
    return false;
  }

  /** Replays received commands as the opposing team or spectator target without touching local UI selection. */
  private applyRemoteActions(): void {
    if (!this.multiplayer || this.remoteActions.length === 0) return;
    const actions = this.remoteActions.splice(0);
    for (const item of actions) {
      const team: 0 | 1 = item.team !== undefined
        ? item.team
        : (this.team === 0 ? 1 : 0);
      const applied = this.applyActionForTeam(team, item.action);
      this.journal.append(
        this.sim.tickCount,
        applied ? 'command_applied' : 'command_rejected',
        'public',
        { action: item.action.type, team, remote: true },
      );
    }
  }

  private applyActionForTeam(team: 0 | 1, action: MultiplayerAction): boolean {
    if (action.type === 'queue-build') {
      return this.queueBuildFor(team, action.id);
    } else if (action.type === 'cancel-build') {
      return this.cancelBuildFor(team, action.id);
    } else if (action.type === 'place-building') {
      return this.sim.placeReadyBuilding(team, action.x, action.z);
    } else if (action.type === 'stance') {
      for (const ref of action.refs) {
        if (!this.sim.units.valid(ref)) continue;
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] === team) this.sim.setStance(slot, action.stance);
      }
      return true;
    } else if (action.type === 'stop') {
      for (const ref of action.refs) {
        if (!this.sim.units.valid(ref)) continue;
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) continue;
        this.sim.units.clearOrders(slot);
        this.sim.units.hasGoal[slot] = 0;
      }
      return true;
    } else if (action.type === 'orders') {
      for (const rally of action.rally) {
        if (!this.sim.buildings.valid(rally.ref)) continue;
        const slot = refSlot(rally.ref);
        if (this.sim.buildings.team[slot] !== team) continue;
        this.sim.buildings.rallyX[slot] = rally.x;
        this.sim.buildings.rallyZ[slot] = rally.z;
        this.sim.buildings.hasRally[slot] = 1;
      }
      for (const order of action.orders) {
        if (!this.sim.units.valid(order.ref)) continue;
        const slot = refSlot(order.ref);
        if (this.sim.units.team[slot] === team) {
          this.sim.issueOrder(slot, order.order, order.x, order.z, order.target, order.queued);
        }
      }
      return true;
    }
    return false;
  }

  /* ================================================================== *
   * Agent Surface
   * ================================================================== */

  getSpectatorInfo(): SpectatorInfo {
    const roomCode = this.multiplayer?.roomCode;
    const passcode = this.multiplayer?.passcode;
    const isMultiplayer = Boolean(roomCode);
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
    const url = isMultiplayer
      ? `${origin}${pathname}?spectate=${encodeURIComponent(roomCode!)}&pass=${encodeURIComponent(passcode || '')}`
      : undefined;
    const instructions = isMultiplayer
      ? `Operator can spectate this live match by opening ${url} or entering Room Code: "${roomCode}" and Passcode: "${passcode}" in the Verdium Storm SPECTATE MATCH lobby. You should communicate this to the operator or embed it in your thoughts.`
      : 'Spectator mode requires an active multiplayer match room. In local practice matches, the simulation runs locally in-memory.';
    return {
      available: isMultiplayer,
      roomCode: roomCode || undefined,
      passcode: passcode || undefined,
      url,
      instructions,
    };
  }

  onJournalEvent(listener: (event: GameEvent) => void): () => void {
    return this.journal.onAppend(listener);
  }

  agentObserve(): AgentObservation {
    const own: ObservedEntity[] = [];
    const visibleEnemies: ObservedEntity[] = [];
    const allUnits: ObservedEntity[] = [];

    const u = this.sim.units;
    u.refreshLive();
    for (let n = 0; n < u.liveCount; n++) {
      const slot = u.live[n];
      const entityTeam = u.team[slot] as 0 | 1;
      const isVisible =
        this.team >= 2 ||
        entityTeam === this.team ||
        this.sim.fog.isVisible(this.team, u.px[slot], u.pz[slot]);

      if (!isVisible) continue;

      const ref = u.ref(slot) >>> 0;
      const typeStats = UNIT_LIST[u.type[slot]];
      const orderIdx = u.peekOrder(slot);
      const currentOrder = orderIdx >= 0 ? ORDER_NAMES[u.orderType[orderIdx]] ?? 'idle' : 'idle';
      const can: string[] = ['move', 'stop', 'stance'];
      if (typeStats.weapon) can.push('attack', 'attack-move');
      if (typeStats.cargo) can.push('harvest');
      if (typeStats.type === 'engineer') can.push('repair', 'capture');

      const item: ObservedEntity = {
        id: ref,
        team: entityTeam,
        kind: 'unit',
        type: typeStats.type,
        x: Math.round(u.px[slot] * 2) / 2,
        z: Math.round(u.pz[slot] * 2) / 2,
        hp: Math.round(u.hp[slot]),
        maxHp: Math.round(u.maxHp[slot]),
        order: currentOrder,
        can,
      };

      allUnits.push(item);
      if (this.team < 2 && entityTeam === this.team) {
        own.push(item);
      } else {
        visibleEnemies.push(item);
      }
    }

    const b = this.sim.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const slot = b.live[n];
      const entityTeam = b.team[slot] as 0 | 1;
      const isVisible =
        this.team >= 2 ||
        entityTeam === this.team ||
        this.sim.fog.isExplored(this.team, b.px[slot], b.pz[slot]);

      if (!isVisible) continue;

      const ref = b.ref(slot) >>> 0;
      const typeStats = BUILDING_LIST[b.type[slot]];
      const can: string[] = [];
      if (typeStats.weapon) can.push('attack');
      if (b.type[slot] === BUILDING_ID.barracks || b.type[slot] === BUILDING_ID.factory) {
        can.push('produce', 'rally');
      }
      if (b.type[slot] === BUILDING_ID.hq) can.push('construct');
      if (b.type[slot] === BUILDING_ID.refinery) can.push('refine');

      const q = b.queues[slot];
      const buildProgress =
        q && q.items.length > 0
          ? Math.round(q.progress * 100) / 100
          : b.buildProgress[slot] < 1
          ? Math.round(b.buildProgress[slot] * 100) / 100
          : undefined;

      const item: ObservedEntity = {
        id: ref,
        team: entityTeam,
        kind: 'building',
        type: typeStats.type,
        x: Math.round(b.px[slot] * 2) / 2,
        z: Math.round(b.pz[slot] * 2) / 2,
        hp: Math.round(b.hp[slot]),
        maxHp: Math.round(b.maxHp[slot]),
        can,
        buildProgress,
        ready: b.buildProgress[slot] >= 1,
      };

      if (this.team < 2 && entityTeam === this.team) {
        own.push(item);
      } else {
        visibleEnemies.push(item);
      }
    }

    // Match status and objectives
    const b0 = this.sim.teams[0].buildings.reduce(sumInt, 0) + this.sim.teams[0].pending.reduce(sumInt, 0);
    const u0 = this.sim.unitCountFor(0);
    const b1 = this.sim.teams[1].buildings.reduce(sumInt, 0) + this.sim.teams[1].pending.reduce(sumInt, 0);
    const u1 = this.sim.unitCountFor(1);
    const t0Alive = b0 + u0 > 0;
    const t1Alive = b1 + u1 > 0;

    let status: 'opening' | 'active' | 'won' | 'lost' | 'draw' = 'active';
    const isOpening = this.pacing.openingPeaceTicks > 0 && this.sim.tickCount < this.pacing.openingPeaceTicks;
    if (!t0Alive && !t1Alive) {
      status = 'draw';
    } else if (this.team === 0) {
      if (!t0Alive) status = 'lost';
      else if (!t1Alive) status = 'won';
      else if (isOpening) status = 'opening';
      else status = 'active';
    } else if (this.team === 1) {
      if (!t1Alive) status = 'lost';
      else if (!t0Alive) status = 'won';
      else if (isOpening) status = 'opening';
      else status = 'active';
    } else {
      if (isOpening) status = 'opening';
      else status = 'active';
    }

    const peaceTicksRemaining = Math.max(0, this.pacing.openingPeaceTicks - this.sim.tickCount);
    let primaryObjective = 'Eliminate all enemy structures and units.';
    if (status === 'opening') {
      primaryObjective = `Opening peace active (${peaceTicksRemaining} ticks remaining). Construct base, harvest Verdium, and build combat units.`;
    } else if (status === 'won') {
      primaryObjective = 'Victory achieved! Enemy forces eliminated.';
    } else if (status === 'lost') {
      primaryObjective = 'Defeat. Base and forces destroyed.';
    } else if (status === 'draw') {
      primaryObjective = 'Match ended in a draw.';
    }

    const objectives: ObjectivesSummary = {
      status,
      primary: primaryObjective,
      peaceTicksRemaining,
    };

    // Resources
    const resources: ObservedResourceField[] = [];
    for (let i = 0; i < RESOURCE_FIELDS.length; i++) {
      const f = RESOURCE_FIELDS[i];
      const known = this.team >= 2 || this.sim.fog.isExplored(this.team, f.x, f.z);
      const visible = this.team >= 2 || this.sim.fog.isVisible(this.team, f.x, f.z);
      const remaining = Math.round(this.sim.resources.amount[i]);
      resources.push({
        id: i,
        x: f.x,
        z: f.z,
        radius: f.radius,
        known,
        visible,
        remaining: known ? remaining : f.amount,
        max: f.amount,
      });
    }

    // Production
    const queue: ObservedProductionQueueItem[] = [];
    const available: ObservedAvailableBuild[] = [];
    let readyToPlace: string | null = null;
    const teamIdx = this.team < 2 ? (this.team as 0 | 1) : 0;
    const teamState = this.sim.teams[teamIdx];
    if (teamState.readyBuilding >= 0) {
      readyToPlace = BUILDING_LIST[teamState.readyBuilding].type;
    }
    for (let idx = 0; idx < teamState.construction.items.length; idx++) {
      const bId = teamState.construction.items[idx];
      const stats = BUILDING_LIST[bId];
      queue.push({
        id: stats.type,
        kind: 'building',
        progress: idx === 0 ? Math.round(teamState.construction.progress * 100) / 100 : 0,
        cost: stats.cost,
      });
    }
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (b.team[i] !== teamIdx) continue;
      const bq = b.queues[i];
      for (let idx = 0; idx < bq.items.length; idx++) {
        const uId = bq.items[idx];
        const stats = UNIT_LIST[uId];
        queue.push({
          id: stats.type,
          kind: 'unit',
          progress: idx === 0 ? Math.round(bq.progress * 100) / 100 : 0,
          cost: stats.cost,
        });
      }
    }
    for (const opt of this.buildOptions('unit')) available.push({ ...opt });
    for (const opt of this.buildOptions('building')) available.push({ ...opt });

    const production: ObservedProduction = {
      queue,
      readyToPlace,
      available,
    };

    const map: MapBounds = {
      minX: -HALF_WORLD,
      maxX: HALF_WORLD,
      minZ: -HALF_WORLD,
      maxZ: HALF_WORLD,
      size: WORLD_SIZE,
    };

    const availableCommands = [
      'queue-build',
      'cancel-build',
      'place-building',
      'orders',
      'order',
      'move',
      'attack',
      'attack-move',
      'rally',
      'stance',
      'stop',
    ];

    return {
      schemaVersion: 1,
      team: this.team,
      tick: this.sim.tickCount,
      matchTime: Math.round(this.sim.matchTime * 10) / 10,
      pacing: this.pacing.id,
      status,
      economy: { ...this.economySnapshot },
      units: allUnits,
      own,
      visibleEnemies,
      resources,
      production,
      objectives,
      availableCommands,
      map,
      spectator: this.getSpectatorInfo(),
      lastEventId: this.journal.lastEventId,
    };
  }

  agentCommand(requestId: string, rawAction: AgentCommand): CommandAck {
    const currentTick = this.sim?.tickCount ?? 0;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
      return {
        requestId,
        status: 'rejected',
        code: 'REQUEST_INVALID',
        message: 'requestId must be 1-64 alphanumeric, underscore, or hyphen characters',
        tick: currentTick,
      };
    }
    if (!this.started || !this.sim) {
      return {
        requestId,
        status: 'rejected',
        code: 'MATCH_NOT_STARTED',
        message: 'The match simulation is not running',
        tick: currentTick,
      };
    }
    if (this.team >= 2) {
      return {
        requestId,
        status: 'rejected',
        code: 'SPECTATOR_READ_ONLY',
        message: 'Spectator mode is read-only; cannot issue gameplay commands',
        tick: currentTick,
      };
    }

    const commandTeam = this.team as 0 | 1;
    const norm = this.normalizeAgentAction(rawAction, commandTeam);
    if (!norm.action) {
      const ack: CommandAck = {
        requestId,
        status: 'rejected',
        code: norm.code || 'COMMAND_REJECTED',
        message: norm.message || 'Invalid command structure',
        tick: this.sim.tickCount,
      };
      this.journal.append(
        this.sim.tickCount,
        'command_rejected',
        'team',
        {
          requestId,
          action: (rawAction as { type?: string })?.type,
          code: ack.code,
          message: ack.message,
        },
        commandTeam,
        requestId,
      );
      return ack;
    }

    const applied = this.applyActionForTeam(commandTeam, norm.action);
    if (!applied) {
      const ack: CommandAck = {
        requestId,
        status: 'rejected',
        code: 'COMMAND_REJECTED',
        message: 'Command could not be executed by simulation',
        tick: this.sim.tickCount,
      };
      this.journal.append(
        this.sim.tickCount,
        'command_rejected',
        'team',
        {
          requestId,
          action: norm.action.type,
          code: ack.code,
          message: ack.message,
        },
        commandTeam,
        requestId,
      );
      return ack;
    }

    this.journal.append(
      this.sim.tickCount,
      'command_accepted',
      'team',
      { requestId, action: norm.action.type },
      commandTeam,
      requestId,
    );
    this.journal.append(
      this.sim.tickCount,
      'command_applied',
      'public',
      { action: norm.action.type, team: commandTeam },
      undefined,
      requestId,
    );
    this.multiplayer?.sendAction(norm.action);
    this.takeControl();

    return {
      requestId,
      status: 'accepted',
      tick: this.sim.tickCount,
    };
  }

  private normalizeAgentAction(
    raw: AgentCommand,
    team: 0 | 1,
  ): { action?: MultiplayerAction; code?: string; message?: string } {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
      return { code: 'INVALID_ARGUMENT', message: 'Command must be an object with a string "type"' };
    }

    const type = raw.type;

    if (type === 'queue-build') {
      const action = raw as { id?: string; unit?: string; building?: string };
      const id = (action.id || action.unit || action.building || '').toLowerCase();
      if (isUnitType(id)) {
        const unitId = UNIT_ID[id];
        const locked = this.sim.unitLockReason(team, unitId);
        if (locked) return { code: 'TECH_LOCKED', message: locked };
        const producer = this.sim.findProducer(team, unitId);
        if (producer < 0) return { code: 'NO_FACTORY', message: `Requires Barracks or Factory to train ${id}` };
        if (this.sim.buildings.queues[producer].items.length >= 9) {
          return { code: 'QUEUE_FULL', message: 'Unit production queue is full (max 9)' };
        }
        return { action: { type: 'queue-build', id } };
      }
      if (isBuildingType(id)) {
        const bldgId = BUILDING_ID[id];
        const locked = this.sim.buildingLockReason(team, bldgId);
        if (locked) return { code: 'TECH_LOCKED', message: locked };
        if (this.sim.teams[team].construction.items.length >= 6) {
          return { code: 'QUEUE_FULL', message: 'Structure construction queue is full (max 6)' };
        }
        return { action: { type: 'queue-build', id } };
      }
      return { code: 'INVALID_ARGUMENT', message: `Unknown buildable id "${id}"` };
    }

    if (type === 'cancel-build') {
      const action = raw as { id?: string; unit?: string; building?: string };
      const id = (action.id || action.unit || action.building || '').toLowerCase();
      if (!isUnitType(id) && !isBuildingType(id)) {
        return { code: 'INVALID_ARGUMENT', message: `Unknown buildable id "${id}"` };
      }
      return { action: { type: 'cancel-build', id } };
    }

    if (type === 'place-building') {
      const action = raw as { x?: number; z?: number };
      if (typeof action.x !== 'number' || typeof action.z !== 'number') {
        return { code: 'INVALID_ARGUMENT', message: 'place-building requires numeric "x" and "z" coordinates' };
      }
      if (Math.abs(action.x) > HALF_WORLD || Math.abs(action.z) > HALF_WORLD) {
        return { code: 'OUT_OF_BOUNDS', message: `Coordinates (${action.x}, ${action.z}) are outside map bounds` };
      }
      const readyId = this.sim.teams[team].readyBuilding;
      if (readyId < 0) {
        return { code: 'NO_BUILDING_READY', message: 'No structure is ready to place' };
      }
      const stats = BUILDING_LIST[readyId];
      if (!this.sim.footprintClear(stats.footprint, action.x, action.z)) {
        return { code: 'INVALID_PLACEMENT', message: 'Placement location is obstructed or unbuildable' };
      }
      if (!this.sim.nearFriendlyBase(team, action.x, action.z, 96)) {
        return { code: 'OUT_OF_BOUNDS', message: 'Structure must be placed within 96m of friendly base structures' };
      }
      return { action: { type: 'place-building', x: action.x, z: action.z } };
    }

    if (type === 'stop') {
      const action = raw as { ref?: unknown; refs?: unknown };
      const refs = parseRefs(action.ref ?? action.refs);
      if (refs.length === 0) return { code: 'INVALID_ARGUMENT', message: 'stop requires "ref" or "refs"' };
      const validRefs: number[] = [];
      for (const ref of refs) {
        if (!this.sim.units.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Unit ${ref} not found or dead` };
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Unit ${ref} belongs to opponent` };
        validRefs.push(ref);
      }
      return { action: { type: 'stop', refs: validRefs } };
    }

    if (type === 'stance') {
      const action = raw as { ref?: unknown; refs?: unknown; stance?: unknown };
      const refs = parseRefs(action.ref ?? action.refs);
      if (refs.length === 0) return { code: 'INVALID_ARGUMENT', message: 'stance requires "ref" or "refs"' };
      let stanceVal: number | undefined;
      if (typeof action.stance === 'number' && action.stance >= 0 && action.stance <= 2) {
        stanceVal = action.stance;
      } else if (typeof action.stance === 'string') {
        stanceVal = STANCE_VALUES[action.stance.toLowerCase()];
      }
      if (stanceVal === undefined) {
        return { code: 'INVALID_ARGUMENT', message: 'stance must be "aggressive", "guard", "defensive", or "hold"' };
      }
      const validRefs: number[] = [];
      for (const ref of refs) {
        if (!this.sim.units.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Unit ${ref} not found or dead` };
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Unit ${ref} belongs to opponent` };
        validRefs.push(ref);
      }
      return { action: { type: 'stance', refs: validRefs, stance: stanceVal } };
    }

    if (type === 'rally') {
      const action = raw as { ref?: unknown; x?: number; z?: number };
      const ref = parseRef(action.ref);
      if (ref === null || typeof action.x !== 'number' || typeof action.z !== 'number') {
        return { code: 'INVALID_ARGUMENT', message: 'rally requires numeric "ref", "x", and "z"' };
      }
      if (!this.sim.buildings.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Building ${ref} not found or destroyed` };
      const slot = refSlot(ref);
      if (this.sim.buildings.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Building ${ref} belongs to opponent` };
      return { action: { type: 'orders', orders: [], rally: [{ ref, x: action.x, z: action.z }] } };
    }

    if (type === 'move' || type === 'attack-move') {
      const action = raw as { ref?: unknown; refs?: unknown; x?: number; z?: number; queued?: boolean };
      const refs = parseRefs(action.ref ?? action.refs);
      if (refs.length === 0) return { code: 'INVALID_ARGUMENT', message: `${type} requires "ref" or "refs"` };
      if (typeof action.x !== 'number' || typeof action.z !== 'number') {
        return { code: 'INVALID_ARGUMENT', message: `${type} requires numeric "x" and "z"` };
      }
      if (Math.abs(action.x) > HALF_WORLD || Math.abs(action.z) > HALF_WORLD) {
        return { code: 'OUT_OF_BOUNDS', message: `Destination (${action.x}, ${action.z}) is outside map bounds` };
      }
      const orderCode = type === 'move' ? Order.Move : Order.AttackMove;
      const orders = [];
      for (const ref of refs) {
        if (!this.sim.units.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Unit ${ref} not found or dead` };
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Unit ${ref} belongs to opponent` };
        orders.push({ ref, order: orderCode, x: action.x, z: action.z, target: 0, queued: !!action.queued });
      }
      return { action: { type: 'orders', orders, rally: [] } };
    }

    if (type === 'attack') {
      const action = raw as { ref?: unknown; refs?: unknown; target?: unknown; queued?: boolean };
      const refs = parseRefs(action.ref ?? action.refs);
      if (refs.length === 0) return { code: 'INVALID_ARGUMENT', message: 'attack requires "ref" or "refs"' };
      const target = parseRef(action.target);
      if (target === null) return { code: 'INVALID_ARGUMENT', message: 'attack requires numeric target ref' };
      const targetUnit = this.sim.units.valid(target);
      const targetBldg = this.sim.buildings.valid(target);
      if (!targetUnit && !targetBldg) {
        return { code: 'TARGET_NOT_FOUND', message: `Target ${target} not found or destroyed` };
      }
      const targetX = targetUnit ? this.sim.units.px[refSlot(target)] : this.sim.buildings.px[refSlot(target)];
      const targetZ = targetUnit ? this.sim.units.pz[refSlot(target)] : this.sim.buildings.pz[refSlot(target)];
      if (!this.sim.fog.isVisible(team, targetX, targetZ)) {
        return { code: 'TARGET_NOT_VISIBLE', message: `Target ${target} is shrouded in fog of war` };
      }
      const orders = [];
      for (const ref of refs) {
        if (!this.sim.units.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Unit ${ref} not found or dead` };
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Unit ${ref} belongs to opponent` };
        orders.push({ ref, order: Order.Attack, x: 0, z: 0, target, queued: !!action.queued });
      }
      return { action: { type: 'orders', orders, rally: [] } };
    }

    if (type === 'order') {
      const action = raw as {
        ref?: unknown;
        refs?: unknown;
        order?: unknown;
        x?: number;
        z?: number;
        target?: unknown;
        queued?: boolean;
      };
      const refs = parseRefs(action.ref ?? action.refs);
      if (refs.length === 0) return { code: 'INVALID_ARGUMENT', message: 'order requires "ref" or "refs"' };
      let orderCode: number | undefined;
      if (typeof action.order === 'number' && action.order >= 0 && action.order <= 7) {
        orderCode = action.order;
      } else if (typeof action.order === 'string') {
        orderCode = ORDER_BY_NAME[action.order.toLowerCase()];
      }
      if (orderCode === undefined) {
        return { code: 'INVALID_ARGUMENT', message: `Unknown order type "${String(action.order)}"` };
      }
      const target = parseRef(action.target) ?? 0;
      const x = typeof action.x === 'number' ? action.x : 0;
      const z = typeof action.z === 'number' ? action.z : 0;
      const orders = [];
      for (const ref of refs) {
        if (!this.sim.units.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Unit ${ref} not found or dead` };
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Unit ${ref} belongs to opponent` };
        orders.push({ ref, order: orderCode, x, z, target, queued: !!action.queued });
      }
      return { action: { type: 'orders', orders, rally: [] } };
    }

    if (type === 'orders') {
      const action = raw as { orders?: unknown[]; rally?: unknown[] };
      const rawOrders = Array.isArray(action.orders) ? action.orders : [];
      const rawRally = Array.isArray(action.rally) ? action.rally : [];
      const orders: Array<{ ref: number; order: number; x: number; z: number; target: number; queued: boolean }> = [];
      const rally: Array<{ ref: number; x: number; z: number }> = [];

      for (const r of rawRally) {
        if (!r || typeof r !== 'object') continue;
        const ref = parseRef((r as { ref?: unknown }).ref);
        const x = (r as { x?: unknown }).x;
        const z = (r as { z?: unknown }).z;
        if (ref === null || typeof x !== 'number' || typeof z !== 'number') continue;
        if (!this.sim.buildings.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Building ${ref} not found` };
        const slot = refSlot(ref);
        if (this.sim.buildings.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Building ${ref} not owned` };
        rally.push({ ref, x, z });
      }

      for (const o of rawOrders) {
        if (!o || typeof o !== 'object') continue;
        const oObj = o as { ref?: unknown; order?: unknown; x?: unknown; z?: unknown; target?: unknown; queued?: unknown };
        const ref = parseRef(oObj.ref);
        if (ref === null) continue;
        if (!this.sim.units.valid(ref)) return { code: 'ENTITY_NOT_FOUND', message: `Unit ${ref} not found` };
        const slot = refSlot(ref);
        if (this.sim.units.team[slot] !== team) return { code: 'ENTITY_NOT_OWNED', message: `Unit ${ref} not owned` };

        let orderCode = typeof oObj.order === 'number' ? oObj.order : 0;
        if (typeof oObj.order === 'string') orderCode = ORDER_BY_NAME[oObj.order.toLowerCase()] ?? 0;
        const target = parseRef(oObj.target) ?? 0;
        const x = typeof oObj.x === 'number' ? oObj.x : 0;
        const z = typeof oObj.z === 'number' ? oObj.z : 0;
        const queued = Boolean(oObj.queued);
        orders.push({ ref, order: orderCode, x, z, target, queued });
      }

      if (orders.length === 0 && rally.length === 0) {
        return { code: 'INVALID_ARGUMENT', message: 'orders action contains no valid orders or rally points' };
      }
      return { action: { type: 'orders', orders, rally } };
    }

    return { code: 'UNKNOWN_COMMAND', message: `Unrecognised action type "${type}"` };
  }

  agentEvents(afterEventId = 0, limit = 200): GameEvent[] {
    return this.journal.read(this.team, afterEventId, limit);
  }

  async agentCreateRoom(password: string): Promise<LobbySnapshot> {
    this.multiplayer?.close();
    const lobby = new MultiplayerLobby();
    const connected = await lobby.create(password);
    if (!connected) return lobby.snapshot();
    this.configureMatch(this.playerFaction, lobby);
    return lobby.snapshot();
  }

  async agentJoinRoom(roomCode: string, password: string): Promise<LobbySnapshot> {
    this.multiplayer?.close();
    const lobby = new MultiplayerLobby();
    const connected = await lobby.join(roomCode, password);
    if (!connected) return lobby.snapshot();
    this.configureMatch(this.playerFaction, lobby);
    return lobby.snapshot();
  }

  async agentSpectateRoom(roomCode: string, password: string): Promise<LobbySnapshot> {
    this.multiplayer?.close();
    const lobby = new MultiplayerLobby();
    const connected = await lobby.spectate(roomCode, password);
    if (!connected) return lobby.snapshot();
    this.configureMatch(this.playerFaction, lobby);
    return lobby.snapshot();
  }

  agentRoomStatus(): LobbySnapshot {
    return this.multiplayer?.snapshot() ?? {
      state: 'idle',
      roomCode: '',
      isHost: false,
      isSpectator: false,
      passcode: '',
      team: 0,
      message: 'No multiplayer room is connected.',
    };
  }

  agentLaunchRoom(): boolean {
    return this.multiplayer?.launch() ?? false;
  }

  agentStart(): void {
    this.setPaused(false);
  }

  agentFrameDt(): number {
    return 1 / (30 * this.pacing.simulationRate);
  }

  agentStep(_ticks: number): void {
    /* installed bridge owns engine stepping */
  }

  /* ================================================================== *
   * Telemetry — used by the review harness, not by gameplay
   * ================================================================== */

  debug(): Record<string, unknown> {
    if (!this.started) return { started: 0 };
    const s = this.sim.debugSummary();
    const structures: Record<string, string> = {};
    for (const t of BUILDING_TYPES) {
      const id = BUILDING_ID[t];
      structures[t] = `${this.sim.teams[0].buildings[id]}/${this.sim.teams[1].buildings[id]}`;
    }
    const units: Record<string, string> = {};
    for (const t of UNIT_TYPES) {
      const id = UNIT_ID[t as UnitType];
      units[t] = `${this.sim.teams[0].units[id]}/${this.sim.teams[1].units[id]}`;
    }
    return {
      ...s,
      structures,
      units,
      ai0: this.commanders[0]?.status() ?? 'multiplayer',
      ai1: this.commanders[1]?.status() ?? 'multiplayer',
    };
  }
}

export default Battlefield;
