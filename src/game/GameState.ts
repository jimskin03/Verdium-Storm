import type * as THREE from 'three';
import type { BuildingType, Faction, Team, UnitType } from '@/entities/Types';

/**
 * The read/command surface between the simulation and the HUD. The simulation
 * implements it; the UI consumes it. Neither imports the other's module.
 */

export type BuildableId = UnitType | BuildingType;

export interface BuildOption {
  id: BuildableId;
  label: string;
  kind: 'unit' | 'building';
  cost: number;
  buildTime: number;
  /** False when tech requirements or power are unmet. */
  available: boolean;
  /** Why it is unavailable, for the tooltip. */
  lockedReason?: string;
  /** 0..1 while this item is in production, otherwise 0. */
  progress: number;
  /** Number queued behind the active item. */
  queued: number;
  /** True when the item is finished and awaiting placement. */
  readyToPlace: boolean;
}

export interface SelectionSummary {
  id: number;
  label: string;
  kind: 'unit' | 'building';
  type: BuildableId;
  hp: number;
  maxHp: number;
  /** Present for harvesters. */
  cargo?: number;
  cargoMax?: number;
  /** Present for structures mid-construction. */
  buildProgress?: number;
}

export type AlertKind =
  | 'insufficientFunds' | 'lowPower' | 'baseUnderAttack' | 'unitLost'
  | 'buildingComplete' | 'unitReady' | 'newTech' | 'harvesterLost';

export interface Alert {
  kind: AlertKind;
  message: string;
  /** Seconds since the alert was raised. */
  age: number;
  /** World position to jump to when clicked, if any. */
  position?: THREE.Vector3;
}

export interface MinimapBlip {
  x: number;
  z: number;
  team: Team;
  kind: 'unit' | 'building' | 'resource';
  size: number;
}

export interface EconomySnapshot {
  credits: number;
  /** Credits per minute, smoothed, for the income readout. */
  income: number;
  powerProduced: number;
  powerConsumed: number;
  /** 0..1; below 1 means brownout and slower production. */
  powerRatio: number;
}

export interface GameStateService {
  readonly faction: Faction;
  readonly team: Team;
  readonly economy: EconomySnapshot;
  readonly selection: SelectionSummary[];
  readonly alerts: Alert[];
  /** Elapsed match time in seconds. */
  readonly matchTime: number;
  readonly kills: number;
  readonly losses: number;
  readonly unitCount: number;
  readonly unitCap: number;
  readonly paused: boolean;

  /** Production options for the current sidebar tab. */
  buildOptions(kind: 'unit' | 'building'): BuildOption[];

  /** UI → sim commands. */
  queueBuild(id: BuildableId): void;
  cancelBuild(id: BuildableId): void;
  /** Enters placement mode for a finished structure. */
  beginPlacement(id: BuildingType): void;
  selectAll(type?: BuildableId): void;
  focusOn(position: THREE.Vector3): void;
  setPaused(paused: boolean): void;
  dismissAlert(index: number): void;

  /** Minimap data. `explored` and `visible` are FOG_RES² byte grids. */
  minimapBlips(): MinimapBlip[];
  fogGrids(): { explored: Uint8Array; visible: Uint8Array; resolution: number } | null;

  /** Fires whenever any of the above changes materially. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}
