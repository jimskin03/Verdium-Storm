import * as THREE from 'three';
import { Phase, type EngineContext, type QualitySettings, type System } from './System';

export interface RenderHook {
  /** Replaces the default forward render. Return true if the frame was drawn. */
  render(dt: number): boolean;
}

/**
 * Owns the WebGL device, the frame loop and system lifecycle. Systems register
 * themselves and are ticked in `phase` order; a single system may optionally
 * take over presentation via {@link setRenderHook} (the post-processing stack
 * does exactly that).
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly viewport: HTMLElement;
  readonly uiRoot: HTMLElement;
  readonly quality: QualitySettings;

  private systems: System[] = [];
  private renderHook: RenderHook | null = null;
  private running = false;
  private lastTime = 0;
  private frameHandle = 0;

  /** Seconds of wall clock consumed by the simulation, excluding pauses. */
  elapsed = 0;
  paused = false;
  timeScale = 1;

  /** Rolling frame time in milliseconds, exposed for the HUD and harness. */
  frameMs = 0;
  frameCount = 0;

  constructor(viewport: HTMLElement, uiRoot: HTMLElement, quality: QualitySettings) {
    this.viewport = viewport;
    this.uiRoot = uiRoot;
    this.quality = quality;

    const canvas = document.createElement('canvas');
    viewport.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // resolved by SMAA/TAA in the post stack
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // needed for screenshot capture
      logarithmicDepthBuffer: false,
    });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, this.aspect, 1.5, 6000);
    this.camera.position.set(0, 120, 150);
    this.camera.lookAt(0, 0, 0);

    window.addEventListener('resize', this.handleResize);
  }

  get aspect(): number {
    return Math.max(1e-3, this.viewport.clientWidth / Math.max(1, this.viewport.clientHeight));
  }

  get context(): EngineContext {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      viewport: this.viewport,
      uiRoot: this.uiRoot,
      quality: this.quality,
      width: size.x,
      height: size.y,
    };
  }

  add(system: System): void {
    this.systems.push(system);
    this.systems.sort((a, b) => (a.phase ?? Phase.SIMULATION) - (b.phase ?? Phase.SIMULATION));
  }

  get<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  async initSystems(onProgress?: (name: string, index: number, total: number) => void): Promise<void> {
    const ctx = this.context;
    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i];
      onProgress?.(system.name, i, this.systems.length);
      // A system that cannot initialise is disabled rather than allowed to
      // abort boot — losing one feature beats losing the whole game.
      try {
        await system.init?.(ctx);
      } catch (err) {
        this.fault(system, 'init', err);
      }
    }
  }

  setRenderHook(hook: RenderHook | null): void {
    this.renderHook = hook;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.tick);

    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp so a stalled tab (or a devtools pause) cannot teleport the sim.
    const dt = this.paused ? 0 : Math.min(rawDt, 1 / 15) * this.timeScale;
    this.elapsed += dt;
    this.frameCount++;

    const start = performance.now();
    this.renderer.info.reset();

    this.runSystems(dt);

    const ms = performance.now() - start;
    this.frameMs += (ms - this.frameMs) * 0.1;
  };

  /** Runs one full frame synchronously; used by the deterministic screenshot harness. */
  stepManual(dt: number): void {
    this.elapsed += dt;
    this.frameCount++;
    this.runSystems(dt);
  }

  /**
   * Ticks every system and presents the frame.
   *
   * Systems are isolated from each other: a throwing system is reported once
   * and then skipped for the rest of the session. Without this, one bad update
   * aborts the loop before `render()` runs and the game goes black — which is a
   * very expensive way to find out that an unrelated subsystem has a bug.
   */
  private runSystems(dt: number): void {
    for (const system of this.systems) {
      if (this.faulted.has(system.name)) continue;
      try {
        system.update?.(dt, this.elapsed);
      } catch (err) {
        this.fault(system, 'update', err);
      }
    }
    for (const system of this.systems) {
      if (this.faulted.has(system.name)) continue;
      try {
        system.lateUpdate?.(dt, this.elapsed);
      } catch (err) {
        this.fault(system, 'lateUpdate', err);
      }
    }

    try {
      if (this.renderHook?.render(dt)) return;
    } catch (err) {
      console.error('[VerdiumStorm] render hook failed; falling back to forward rendering', err);
      this.renderHook = null;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private fault(system: System, hook: string, err: unknown): void {
    this.faulted.add(system.name);
    console.error(`[VerdiumStorm] system "${system.name}" threw in ${hook} and has been disabled`, err);
  }

  /** Names of systems disabled after throwing; surfaced by the harness. */
  readonly faulted = new Set<string>();

  private handleResize = (): void => {
    const w = this.viewport.clientWidth;
    const h = this.viewport.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const system of this.systems) system.resize?.(size.x, size.y);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    for (const system of this.systems) system.dispose?.();
    this.renderer.dispose();
  }
}
