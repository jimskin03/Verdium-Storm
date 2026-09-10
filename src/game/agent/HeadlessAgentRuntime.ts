import * as THREE from 'three';
import { Battlefield } from '@/game/Battlefield';
import type { AgentBridgeHost } from './AgentBridge';
import type { EngineContext, QualitySettings, System } from '@/engine/System';

/**
 * The control-plane runtime deliberately has no WebGL renderer. Three's scene
 * graph is still useful to the simulation for transforms and spatial objects,
 * but no canvas, GPU context, shader compilation, or presentation system is
 * constructed here.
 */
export class HeadlessAgentRuntime implements AgentBridgeHost {
  readonly battlefield: Battlefield;
  private readonly camera: THREE.PerspectiveCamera;
  private elapsed = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(viewport: HTMLElement, uiRoot: HTMLElement) {
    const scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1.5, 6000);
    this.camera.position.set(0, 120, 150);
    this.camera.lookAt(0, 0, 0);

    const context: EngineContext = {
      // Battlefield and Sim do not call renderer methods. Keeping this null in
      // the headless context makes any accidental render dependency obvious.
      renderer: null as unknown as THREE.WebGLRenderer,
      scene,
      camera: this.camera,
      viewport,
      uiRoot,
      quality: HEADLESS_QUALITY,
      width: 1,
      height: 1,
    };

    this.battlefield = new Battlefield();
    this.battlefield.init(context);
  }

  get<T extends System>(name: string): T | undefined {
    return name === 'battlefield' ? this.battlefield as unknown as T : undefined;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.stepManual(1 / 30), 1000 / 30);
    const handle = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    handle.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  stepManual(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += dt;
    this.battlefield.update(dt);
  }

  dispose(): void {
    this.stop();
    this.battlefield.dispose();
  }
}

const HEADLESS_QUALITY: QualitySettings = {
  tier: 'low',
  pixelRatio: 1,
  shadowMapSize: 1,
  shadowCascades: 0,
  pcssSamples: 0,
  ssao: false,
  ssr: false,
  taa: false,
  bloom: false,
  motionBlur: false,
  depthOfField: false,
  volumetricLight: false,
  volumetricClouds: false,
  grassDensity: 0,
  terrainLodBias: 2,
  maxParticles: 0,
  anisotropy: 1,
};
