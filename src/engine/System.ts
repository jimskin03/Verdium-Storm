import type * as THREE from 'three';

/**
 * Shared engine context handed to every system on init. Systems must not reach
 * for globals — everything they need to touch lives here or on the service
 * locator (`src/engine/Services.ts`).
 */
export interface EngineContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Backing DOM element for the WebGL canvas. */
  viewport: HTMLElement;
  /** Overlay element that DOM based UI mounts into. */
  uiRoot: HTMLElement;
  quality: QualitySettings;
  /** Drawing buffer width in device pixels. */
  width: number;
  /** Drawing buffer height in device pixels. */
  height: number;
}

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  pixelRatio: number;
  shadowMapSize: number;
  shadowCascades: number;
  /** Soft shadow (PCSS) sample count; 0 disables the PCSS path. */
  pcssSamples: number;
  ssao: boolean;
  ssr: boolean;
  taa: boolean;
  bloom: boolean;
  motionBlur: boolean;
  depthOfField: boolean;
  volumetricLight: boolean;
  volumetricClouds: boolean;
  grassDensity: number;
  terrainLodBias: number;
  maxParticles: number;
  anisotropy: number;
}

/**
 * Update ordering. Lower numbers tick first. Rendering systems that consume
 * simulation state should sit in the PRESENT band.
 */
export const Phase = {
  INPUT: 100,
  SIMULATION: 200,
  ANIMATION: 300,
  ENVIRONMENT: 400,
  EFFECTS: 500,
  PRESENT: 600,
} as const;

export interface System {
  readonly name: string;
  /** Tick order; see {@link Phase}. Defaults to Phase.SIMULATION. */
  readonly phase?: number;
  init?(ctx: EngineContext): void | Promise<void>;
  /** @param dt seconds since previous frame, already clamped. */
  update?(dt: number, elapsed: number): void;
  /** Called after all updates, before the render pass. */
  lateUpdate?(dt: number, elapsed: number): void;
  resize?(width: number, height: number): void;
  dispose?(): void;
}
