import * as THREE from 'three';
import type { RenderHook } from './Engine';
import { tryGet } from './Services';
import { Phase, type EngineContext, type System } from './System';
import { COMPOSITE_FRAGMENT } from '@/shaders/post/composite';
import { FullScreenPass } from '@/shaders/post/FullScreenPass';
import { LUT_SIZE, createGradeLut, lookForSunElevation, writeGradeLut } from '@/shaders/post/grade';

/** Signature of `WebGLRenderer.render`, for the presentation interception. */
type RenderFn = (scene: THREE.Object3D, camera: THREE.Camera) => void;

/**
 * The post-processing stack. Owns presentation from the moment the scene is
 * rasterised to the pixel that reaches the display.
 *
 * The system claims the engine's render hook, draws the scene into a half-float
 * HDR target and then runs the screen-space chain over it. Nothing downstream of
 * the scene render touches the default framebuffer until the final pass, which
 * *must* draw there — the review harness reads the frame back with
 * `gl.readPixels` on framebuffer zero, so a chain that finishes in an offscreen
 * target captures as solid black.
 *
 * Everything is gated on `ctx.quality`; the chain degrades pass by pass rather
 * than switching off wholesale.
 */
export class PostFX implements System, RenderHook {
  readonly name = 'postfx';
  readonly phase = Phase.PRESENT;

  private ctx!: EngineContext;
  private renderer!: THREE.WebGLRenderer;
  private baseRender: RenderFn | null = null;
  /** True while the stack is issuing its own draws, to break the interception. */
  private inChain = false;
  private failed = false;

  private width = 1;
  private height = 1;
  private elapsed = 0;

  /** Scene render target: linear HDR colour plus a sampleable depth attachment. */
  private sceneTarget!: THREE.WebGLRenderTarget;
  private composite!: FullScreenPass;

  private lut!: THREE.DataTexture;
  private lutData!: Uint8Array;
  private lutElevation = Number.NaN;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.renderer = ctx.renderer;

    const size = this.drawingBufferSize();
    this.width = size.x;
    this.height = size.y;

    this.sceneTarget = this.createSceneTarget(this.width, this.height);

    const look = lookForSunElevation(this.sunElevation());
    this.lut = createGradeLut(look);
    this.lutData = this.lut.image.data as Uint8Array;
    this.lutElevation = this.sunElevation();

    this.composite = new FullScreenPass(COMPOSITE_FRAGMENT, {
      tColor: { value: this.sceneTarget.texture },
      tDepth: { value: this.sceneTarget.depthTexture },
      uResolution: { value: new THREE.Vector2(this.width, this.height) },
      uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      uNear: { value: ctx.camera.near },
      uFar: { value: ctx.camera.far },
      uExposure: { value: 1.35 },
      uAgx: { value: new THREE.Vector3(1.1, 1.0, 1.08) },
      uVignetteStrength: { value: 0.34 },
      uVignetteScale: { value: 1.05 },
      uChromatic: { value: 0.0035 },
      uGrain: { value: 0.016 },
      uSharpen: { value: 0.06 },
      uTime: { value: 0 },
      tLut: { value: this.lut },
      uLutParams: { value: new THREE.Vector2(LUT_SIZE, 1 / (LUT_SIZE * LUT_SIZE)) },
    });

    // Claimed last so a stack that threw while building never leaves the engine
    // hooked to a half-constructed chain.
    this.claimPresentation();
  }

  update(_dt: number, elapsed: number): void {
    this.elapsed = elapsed;
    this.syncGrade();
  }

  /** {@link RenderHook}. Returning false hands the frame back to the engine. */
  render(_dt: number): boolean {
    if (this.failed) return false;
    try {
      this.inChain = true;
      this.drawFrame();
      return true;
    } catch (err) {
      // Never let this escape: the engine's fallback calls `renderer.render`
      // without rebinding the target, so an exception raised mid-chain would
      // leave every later forward frame drawing into an offscreen buffer.
      this.failed = true;
      this.renderer.setRenderTarget(null);
      console.error('[postfx] pass chain failed; reverting to forward rendering', err);
      return false;
    } finally {
      this.inChain = false;
    }
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.sceneTarget.setSize(this.width, this.height);

    const u = this.composite.uniforms;
    (u.uResolution.value as THREE.Vector2).set(this.width, this.height);
    (u.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
  }

  dispose(): void {
    this.releasePresentation();
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.composite?.dispose();
    this.lut?.dispose();
  }

  // --- presentation ----------------------------------------------------------

  /**
   * Takes over the frame.
   *
   * The documented route is `engine.setRenderHook`, but `EngineContext` carries
   * no reference to the engine and importing the module would make the graph
   * circular, so the handle is taken from whichever surface exposes it. When
   * none does, the engine's own presentation call is intercepted at the renderer
   * instead: `runSystems` ends with exactly one `renderer.render(scene, camera)`
   * against the default framebuffer, and that is the call this replaces.
   *
   * The two compose rather than conflict — with the hook installed the engine
   * returns before it ever reaches its fallback, so the interception never
   * fires; without it, the interception is the only thing that runs.
   */
  private claimPresentation(): void {
    this.findEngine()?.setRenderHook(this);

    const renderer = this.renderer;
    const base = renderer.render.bind(renderer) as RenderFn;
    this.baseRender = base;

    renderer.render = ((scene: THREE.Object3D, camera: THREE.Camera): void => {
      const isPresentation =
        !this.inChain &&
        !this.failed &&
        scene === this.ctx.scene &&
        camera === this.ctx.camera &&
        renderer.getRenderTarget() === null;

      if (isPresentation && this.render(0)) return;
      base(scene, camera);
    }) as THREE.WebGLRenderer['render'];
  }

  private releasePresentation(): void {
    this.findEngine()?.setRenderHook(null);
    if (this.baseRender) {
      this.renderer.render = this.baseRender as THREE.WebGLRenderer['render'];
      this.baseRender = null;
    }
  }

  private findEngine(): { setRenderHook(hook: RenderHook | null): void } | null {
    const fromContext = (this.ctx as unknown as { engine?: unknown }).engine;
    const fromHarness = (globalThis as unknown as { VS?: { engine?: unknown } }).VS?.engine;
    const candidate = (fromContext ?? fromHarness) as
      | { setRenderHook?: (hook: RenderHook | null) => void }
      | undefined;
    return typeof candidate?.setRenderHook === 'function'
      ? (candidate as { setRenderHook(hook: RenderHook | null): void })
      : null;
  }

  // --- frame -----------------------------------------------------------------

  private drawFrame(): void {
    const { scene, camera } = this.ctx;
    const renderer = this.renderer;

    this.syncSize();

    const u = this.composite.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uTime.value = this.elapsed;

    renderer.setRenderTarget(this.sceneTarget);
    this.baseRender!(scene, camera);

    // The chain always ends on framebuffer zero. See the class comment.
    this.composite.render(renderer, null);
  }

  /** Keeps every target locked to the drawing buffer, including DPR changes. */
  private syncSize(): void {
    const size = this.drawingBufferSize();
    if (size.x !== this.width || size.y !== this.height) this.resize(size.x, size.y);
  }

  private drawingBufferSize(): THREE.Vector2 {
    return this.renderer.getDrawingBufferSize(new THREE.Vector2());
  }

  private createSceneTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const depth = new THREE.DepthTexture(width, height);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: depth,
    });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return target;
  }

  // --- grade -----------------------------------------------------------------

  /** Direction-to-sun elevation, or a sensible daylight default. */
  private sunElevation(): number {
    return tryGet('environment')?.sunDirection.y ?? 0.7;
  }

  /**
   * Rebakes the grading table when the sun has moved far enough to matter.
   * 32^3 samples is a few milliseconds of CPU, so this guard is what keeps the
   * bake off the per-frame path.
   */
  private syncGrade(): void {
    const elevation = this.sunElevation();
    if (Math.abs(elevation - this.lutElevation) < 0.012) return;
    this.lutElevation = elevation;
    writeGradeLut(this.lutData, lookForSunElevation(elevation));
    this.lut.needsUpdate = true;
  }
}

export default PostFX;
