import * as THREE from 'three';
import { provide } from '@/engine/Services';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { RESOURCE_FIELDS } from '@/world/Heightfield';
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

/**
 * The match. Owns the simulation, the two commanders and the player's input
 * controller, and implements the read/command surface the HUD consumes.
 *
 * Both sides are driven by a commander from the first frame, so the game is
 * always a running battle rather than an empty map waiting for orders. The
 * player's commander stands down the instant a human issues a command.
 *
 * Determinism: everything advances on the fixed simulation step inside `Sim`,
 * driven only by the `dt` the engine hands us. No wall clock, no unseeded
 * randomness — `window.VS.step(n)` reproduces a match exactly.
 */

const PLAYER_TEAM: Team = 0;
const PLAYER_FACTION: Faction = 'gdi';
const ENEMY_FACTION: Faction = 'nod';
const MATCH_SEED = 0x5eed_0731;

export class Battlefield implements System, GameStateService {
  readonly name = 'battlefield';
  readonly phase = Phase.SIMULATION;

  private sim!: Sim;
  private player!: PlayerController;
  private commanders: Commander[] = [];
  private camera!: THREE.PerspectiveCamera;
  private started = false;

  private listeners: Array<() => void> = [];
  private signature = '';

  private economySnapshot: EconomySnapshot = {
    credits: 0, income: 0, powerProduced: 0, powerConsumed: 0, powerRatio: 1,
  };
  private options: BuildOption[] = [];
  private blips: MinimapBlip[] = [];

  readonly team: Team = PLAYER_TEAM;
  readonly faction: Faction = PLAYER_FACTION;
  readonly unitCap = UNIT_CAP;

  /* ================================================================== *
   * Lifecycle
   * ================================================================== */

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;

    this.sim = new Sim(ctx.scene, {
      playerTeam: PLAYER_TEAM,
      playerFaction: PLAYER_FACTION,
      enemyFaction: ENEMY_FACTION,
      seed: MATCH_SEED,
      autoPlayer: true,
    });
    this.sim.build();

    this.player = new PlayerController(this.sim, PLAYER_TEAM);
    this.player.init(ctx);

    this.commanders = [
      new Commander(this.sim, 0, MATCH_SEED ^ 0x11, DEFAULT_CONFIG),
      new Commander(this.sim, 1, MATCH_SEED ^ 0x22, { ...DEFAULT_CONFIG, aggression: 1.15 }),
    ];
    // A human taking control releases their own commander but not the enemy's.
    this.player.onFirstCommand = () => this.commanders[PLAYER_TEAM].release();

    // Lower tiers cannot afford the shroud overlay's fill cost on top of the
    // terrain; the grids stay live either way so the minimap is unaffected.
    if (ctx.quality.tier === 'low') this.sim.fog.setEnabled(false);

    this.started = true;
    provide('game', this);
  }

  update(dt: number): void {
    if (!this.started) return;
    this.player.update(dt);
    if (!this.sim.paused) {
      for (const c of this.commanders) c.update(dt);
    }
    this.sim.update(dt, this.camera);
    this.refresh();
  }

  dispose(): void {
    this.player?.dispose();
    this.sim?.dispose();
    this.listeners.length = 0;
  }

  /* ================================================================== *
   * Change notification
   * ================================================================== */

  /**
   * The HUD is push-driven, but polling every value every frame would defeat
   * that. A short signature of everything a panel displays is cheap to build
   * and only fires listeners when something actually moved.
   */
  private refresh(): void {
    const state = this.sim.teams[this.team];
    this.economySnapshot.credits = Math.round(state.credits);
    this.economySnapshot.income = Math.round(state.income);
    this.economySnapshot.powerProduced = state.powerProduced;
    this.economySnapshot.powerConsumed = state.powerConsumed;
    this.economySnapshot.powerRatio = state.powerRatio;

    const sig =
      `${this.economySnapshot.credits}|${state.powerProduced}|${state.powerConsumed}` +
      `|${this.player.selectionVersion}|${this.sim.alerts.length}|${state.readyBuilding}` +
      `|${this.sim.unitCountFor(this.team)}|${state.construction.items.length}` +
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
    return this.started ? this.sim.teams[this.team].kills : 0;
  }

  get losses(): number {
    return this.started ? this.sim.teams[this.team].losses : 0;
  }

  get unitCount(): number {
    return this.started ? this.sim.unitCountFor(this.team) : 0;
  }

  get paused(): boolean {
    return this.started ? this.sim.paused : false;
  }

  buildOptions(kind: 'unit' | 'building'): BuildOption[] {
    this.options.length = 0;
    if (!this.started) return this.options;
    const state = this.sim.teams[this.team];

    if (kind === 'unit') {
      for (let id = 0; id < UNIT_LIST.length; id++) {
        const stats = UNIT_LIST[id];
        const locked = this.sim.unitLockReason(this.team, id);
        let progress = 0;
        let queued = 0;
        const b = this.sim.buildings;
        b.refreshLive();
        for (let n = 0; n < b.liveCount; n++) {
          const i = b.live[n];
          if (b.team[i] !== this.team) continue;
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
      const locked = this.sim.buildingLockReason(this.team, id);
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
      if (!this.sim.fog.isExplored(this.team, f.x, f.z)) continue;
      this.blips.push({ x: f.x, z: f.z, team: 0, kind: 'resource', size: f.radius * 0.5 });
    }

    const b = this.sim.buildings;
    b.refreshLive();
    for (let n = 0; n < b.liveCount; n++) {
      const i = b.live[n];
      if (!b.visible[i]) continue;
      this.blips.push({
        x: b.px[i], z: b.pz[i], team: b.team[i] as Team, kind: 'building',
        size: BUILDING_LIST[b.type[i]].footprint * NAV_CELL * 0.5,
      });
    }

    const u = this.sim.units;
    u.refreshLive();
    for (let n = 0; n < u.liveCount; n++) {
      const i = u.live[n];
      if (!u.visible[i]) continue;
      this.blips.push({
        x: u.px[i], z: u.pz[i], team: u.team[i] as Team, kind: 'unit',
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
    if (!this.started) return;
    if (isUnitType(id)) this.sim.queueUnit(this.team, UNIT_ID[id]);
    else if (isBuildingType(id)) this.sim.queueBuilding(this.team, BUILDING_ID[id]);
    this.takeControl();
  }

  cancelBuild(id: BuildableId): void {
    if (!this.started) return;
    if (isUnitType(id)) this.sim.cancelUnit(this.team, UNIT_ID[id]);
    else if (isBuildingType(id)) this.sim.cancelBuilding(this.team, BUILDING_ID[id]);
    this.takeControl();
  }

  beginPlacement(id: BuildingType): void {
    if (!this.started) return;
    if (this.sim.teams[this.team].readyBuilding !== BUILDING_ID[id]) return;
    this.player.beginPlacement(BUILDING_ID[id]);
    this.takeControl();
  }

  selectAll(type?: BuildableId): void {
    if (!this.started) return;
    this.player.selectAll(type);
  }

  focusOn(position: THREE.Vector3): void {
    // The camera belongs to another system; ask through the harness surface if
    // it is up, and otherwise raise an event any listener can act on. Never a
    // hard dependency — a missing camera rig must not break the HUD.
    const rig = (window as unknown as { VS?: { rig?: { setPose(p: { target: THREE.Vector3 }): void } } }).VS?.rig;
    if (rig?.setPose) rig.setPose({ target: position.clone() });
    window.dispatchEvent(new CustomEvent('vs-focus', { detail: { x: position.x, z: position.z } }));
  }

  setPaused(paused: boolean): void {
    if (!this.started) return;
    this.sim.paused = paused;
  }

  dismissAlert(index: number): void {
    if (!this.started) return;
    if (index >= 0 && index < this.sim.alerts.length) this.sim.alerts.splice(index, 1);
  }

  private takeControl(): void {
    this.commanders[PLAYER_TEAM]?.release();
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
      ai0: this.commanders[0].status(),
      ai1: this.commanders[1].status(),
    };
  }
}

export default Battlefield;
