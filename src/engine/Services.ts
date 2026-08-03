import type * as THREE from 'three';

/**
 * Contracts shared between subsystems. Everything here is an interface plus a
 * registration slot, so independently developed systems can depend on each
 * other's *shape* without importing each other's implementation.
 */

/** Ground sampling. Implemented by the terrain system. */
export interface TerrainService {
  /** World-space height (Y) of the ground at (x, z). */
  heightAt(x: number, z: number): number;
  /** Unit surface normal at (x, z), written into `out`. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** 0 = flat, 1 = vertical. Cheap slope query for placement/pathing rules. */
  slopeAt(x: number, z: number): number;
  /** True when the point is under the water plane. */
  isWater(x: number, z: number): boolean;
  /** Half-extent of the playable square, in world units. */
  readonly halfSize: number;
  /** Water surface height in world units. */
  readonly waterLevel: number;
  /** Raycast a ray against the terrain heightfield. Returns null on miss. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | null;
}

/** Sun/sky state, owned by the atmosphere system. */
export interface EnvironmentService {
  /** Normalised direction *towards* the sun. */
  readonly sunDirection: THREE.Vector3;
  readonly sunColor: THREE.Color;
  readonly sunIntensity: number;
  /**
   * Exposure compensation the post stack should apply, metered on ground
   * illuminance. 1 at noon, rising as the sun drops so a low-sun landscape is
   * not crushed by a sky that is still brightly lit.
   */
  readonly sceneExposure: number;
  /** 0..1 through the day; 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  timeOfDay: number;
  /** Fog/aerial-perspective tint at the horizon, for UI and minimap matching. */
  readonly horizonColor: THREE.Color;
}

/** Decal projection (craters, scorch marks, tread trails, blast rings). */
export type DecalKind = 'crater' | 'scorch' | 'tread' | 'blast' | 'oil' | 'rubble';

export interface DecalService {
  add(kind: DecalKind, x: number, z: number, size: number, rotation?: number, life?: number): void;
}

/** Particle/explosion effects. */
export interface EffectsService {
  explosion(position: THREE.Vector3, scale: number, kind?: 'shell' | 'rocket' | 'vehicle' | 'building' | 'nuke'): void;
  muzzleFlash(position: THREE.Vector3, direction: THREE.Vector3, scale: number): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number, speed: number): void;
  impact(position: THREE.Vector3, normal: THREE.Vector3, kind: 'dirt' | 'metal' | 'stone' | 'water'): void;
  smokePlume(position: THREE.Vector3, scale: number, life: number): void;
}

export interface AudioService {
  play(id: string, position?: THREE.Vector3, volume?: number, pitch?: number): void;
  music(state: 'menu' | 'calm' | 'tension' | 'combat'): void;
  setListener(position: THREE.Vector3, forward: THREE.Vector3): void;
  readonly ready: boolean;
}

interface ServiceMap {
  terrain: TerrainService;
  /** Mesh factory for units and buildings; see src/entities/Types.ts. */
  models: import('@/entities/Types').ModelCatalog;
  /** Simulation state and commands for the HUD; see src/game/GameState.ts. */
  game: import('@/game/GameState').GameStateService;
  environment: EnvironmentService;
  decals: DecalService;
  effects: EffectsService;
  audio: AudioService;
}

const registry = new Map<keyof ServiceMap, unknown>();
const waiters = new Map<keyof ServiceMap, Array<(v: unknown) => void>>();

export function provide<K extends keyof ServiceMap>(key: K, value: ServiceMap[K]): void {
  registry.set(key, value);
  const pending = waiters.get(key);
  if (pending) {
    waiters.delete(key);
    for (const resolve of pending) resolve(value);
  }
}

/** Throws when the service has not been registered yet. */
export function require<K extends keyof ServiceMap>(key: K): ServiceMap[K] {
  const value = registry.get(key);
  if (!value) throw new Error(`Service "${key}" requested before it was provided`);
  return value as ServiceMap[K];
}

/** Returns undefined instead of throwing; for optional dependencies. */
export function tryGet<K extends keyof ServiceMap>(key: K): ServiceMap[K] | undefined {
  return registry.get(key) as ServiceMap[K] | undefined;
}

/** Resolves once the service becomes available. */
export function whenReady<K extends keyof ServiceMap>(key: K): Promise<ServiceMap[K]> {
  const existing = registry.get(key);
  if (existing) return Promise.resolve(existing as ServiceMap[K]);
  return new Promise((resolve) => {
    const list = waiters.get(key) ?? [];
    list.push(resolve as (v: unknown) => void);
    waiters.set(key, list);
  });
}

export function reset(): void {
  registry.clear();
  waiters.clear();
}
