import * as THREE from 'three';
import type { RenderHook } from './Engine';
import { tryGet } from './Services';
import { Phase, type EngineContext, type System } from './System';
import {
  BLOOM_DOWNSAMPLE_FRAGMENT,
  BLOOM_PREFILTER_FRAGMENT,
  BLOOM_UPSAMPLE_FRAGMENT,
} from '@/shaders/post/bloom';
import { COMPOSITE_FRAGMENT } from '@/shaders/post/composite';
import { FullScreenPass } from '@/shaders/post/FullScreenPass';
import {
  LUT_SIZE,
  createGradeLut,
  lookForSunElevation,
  writeGradeLut,
} from '@/shaders/post/grade';

/** Bloom pyramid depth per quality tier. Level 0 is half the drawing buffer. */
const BLOOM_LEVELS: Record<string, number> = { low: 4, medium: 5, high: 6, ultra: 6 };

/** Exposure at noon. The atmosphere's metering scales this as the sun drops. */
const BASE_EXPOSURE = 1.35;

/** Scene-referred light, post-exposure, at which a pixel starts to bloom. */
const BLOOM_THRESHOLD = 0.90;
const BLOOM_KNEE = 0.50;
/** Fraction of *all* light the lens scatters, thresholded or not. */
const BLOOM_VEIL = 0.025;
/** Ceiling on a single source texel, so one firefly cannot flood the chain. */
const BLOOM_CLAMP = 8.0;
const BLOOM_INTENSITY = 0.55;
/** Weight of the coarser mip in each tent upsample; 0.5 is energy preserving. */
const BLOOM_BLEND = 0.5;
const BLOOM_RADIUS = 1.0;

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

  /** Bloom pyramid. `bloomDown[0]` is half resolution; `bloomUp` is the return leg. */
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private bloomPrefilter: FullScreenPass | null = null;
  private bloomDownsample: FullScreenPass | null = null;
  private bloomUpsample: FullScreenPass | null = null;
  /** Levels the tier asks for; `bloomLevels` is what the resolution allows. */
  private bloomRequested = 0;
  private bloomLevels = 0;

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

    this.bloomRequested = ctx.quality.bloom ? BLOOM_LEVELS[ctx.quality.tier] ?? 5 : 0;
    if (this.bloomRequested > 0) this.buildBloom(this.bloomRequested);

    const uniforms: Record<string, THREE.IUniform> = {
      tColor: { value: this.sceneTarget.texture },
      tDepth: { value: this.sceneTarget.depthTexture },
      uResolution: { value: new THREE.Vector2(this.width, this.height) },
      uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      uNear: { value: ctx.camera.near },
      uFar: { value: ctx.camera.far },
      uExposure: { value: BASE_EXPOSURE },
      // AgX's own look stage stays close to neutral: the creative shaping is
      // the LUT's job, and doing it twice fights itself.
      uAgx: { value: new THREE.Vector3(1.06, 1.0, 1.0) },
      uAgxEv: { value: new THREE.Vector2(look.evWindow[0], look.evWindow[1]) },
      uVignetteStrength: { value: 0.30 },
      uVignetteScale: { value: 1.05 },
      uChromatic: { value: 0.0035 },
      uGrain: { value: 0.016 },
      uSharpen: { value: 0.06 },
      uTime: { value: 0 },
      tLut: { value: this.lut },
      uLutParams: { value: new THREE.Vector2(LUT_SIZE, 1 / (LUT_SIZE * LUT_SIZE)) },
    };
    const defines: Record<string, string> = {};
    if (this.bloomLevels > 0) {
      defines.USE_BLOOM = '1';
      uniforms.tBloom = { value: this.bloomResult() };
      uniforms.uBloomIntensity = { value: BLOOM_INTENSITY };
    }

    this.composite = new FullScreenPass(COMPOSITE_FRAGMENT, uniforms, defines);

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
    // setSize reallocates the colour attachment but leaves the attached depth
    // texture's declared dimensions stale, which makes the framebuffer
    // incomplete and renders nothing at all after a resize.
    const depth = this.sceneTarget.depthTexture;
    if (depth) {
      depth.image.width = this.width;
      depth.image.height = this.height;
      depth.needsUpdate = true;
    }

    if (this.bloomRequested > 0) {
      this.disposeBloomTargets();
      this.buildBloom(this.bloomRequested);
      if (this.composite?.uniforms.tBloom) this.composite.uniforms.tBloom.value = this.bloomResult();
    }

    const u = this.composite.uniforms;
    (u.uResolution.value as THREE.Vector2).set(this.width, this.height);
    (u.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
  }

  dispose(): void {
    this.releasePresentation();
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.composite?.dispose();
    this.disposeBloomTargets();
    this.bloomPrefilter?.dispose();
    this.bloomDownsample?.dispose();
    this.bloomUpsample?.dispose();
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

    if (this.bloomLevels > 0) this.drawBloom();

    // The chain always ends on framebuffer zero. See the class comment.
    this.composite.render(renderer, null);
  }

  // --- bloom -----------------------------------------------------------------

  /**
   * Allocates the bloom pyramid.
   *
   * `bloomDown` is the descending leg — half resolution, then halving — and
   * `bloomUp` is the ascending one. Two chains rather than one because the tent
   * upsample reads the finer mip *and* the coarser result in the same pass, so
   * writing back into the mip it is reading would be undefined.
   */
  private buildBloom(requested: number): void {
    let w = Math.max(1, this.width >> 1);
    let h = Math.max(1, this.height >> 1);
    const levels: Array<[number, number]> = [];
    for (let i = 0; i < requested && w >= 8 && h >= 8; i++) {
      levels.push([w, h]);
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.bloomLevels = levels.length;
    if (this.bloomLevels === 0) return;

    this.bloomDown = levels.map(([lw, lh]) => this.createBloomTarget(lw, lh));
    // One fewer: the coarsest level is only ever read.
    this.bloomUp = levels.slice(0, -1).map(([lw, lh]) => this.createBloomTarget(lw, lh));

    this.bloomPrefilter ??= new FullScreenPass(BLOOM_PREFILTER_FRAGMENT, {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: BLOOM_THRESHOLD },
      uKnee: { value: BLOOM_KNEE },
      uVeil: { value: BLOOM_VEIL },
      uExposure: { value: BASE_EXPOSURE },
      uClamp: { value: BLOOM_CLAMP },
    });
    this.bloomDownsample ??= new FullScreenPass(BLOOM_DOWNSAMPLE_FRAGMENT, {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.bloomUpsample ??= new FullScreenPass(BLOOM_UPSAMPLE_FRAGMENT, {
      tCoarse: { value: null },
      tFine: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: BLOOM_RADIUS },
      uBlend: { value: BLOOM_BLEND },
    });
  }

  private createBloomTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    // The tent filter reaches past the edge of every mip; clamping keeps the
    // frame border from wrapping a bright corner around to the opposite side.
    target.texture.wrapS = THREE.ClampToEdgeWrapping;
    target.texture.wrapT = THREE.ClampToEdgeWrapping;
    return target;
  }

  /** Texture the composite samples: the top of the ascending leg. */
  private bloomResult(): THREE.Texture | null {
    if (this.bloomLevels === 0) return null;
    return (this.bloomUp[0] ?? this.bloomDown[0]).texture;
  }

  private drawBloom(): void {
    const renderer = this.renderer;
    const n = this.bloomLevels;

    const pre = this.bloomPrefilter!;
    pre.uniforms.tColor.value = this.sceneTarget.texture;
    (pre.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    pre.uniforms.uExposure.value = this.composite.uniforms.uExposure.value;
    pre.render(renderer, this.bloomDown[0]);

    const down = this.bloomDownsample!;
    for (let i = 1; i < n; i++) {
      const src = this.bloomDown[i - 1];
      down.uniforms.tColor.value = src.texture;
      (down.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      down.render(renderer, this.bloomDown[i]);
    }

    const up = this.bloomUpsample!;
    let coarse = this.bloomDown[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      up.uniforms.tCoarse.value = coarse.texture;
      up.uniforms.tFine.value = this.bloomDown[i].texture;
      (up.uniforms.uTexel.value as THREE.Vector2).set(1 / coarse.width, 1 / coarse.height);
      up.render(renderer, this.bloomUp[i]);
      coarse = this.bloomUp[i];
    }
  }

  private disposeBloomTargets(): void {
    for (const target of this.bloomDown) target.dispose();
    for (const target of this.bloomUp) target.dispose();
    this.bloomDown = [];
    this.bloomUp = [];
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
    // Cheap and continuous, so it sits ahead of the LUT's movement guard: the
    // stop must track the sun every frame, not only when the table is rebaked.
    this.composite.uniforms.uExposure.value =
      BASE_EXPOSURE * (tryGet('environment')?.sceneExposure ?? 1);

    const elevation = this.sunElevation();
    if (Math.abs(elevation - this.lutElevation) < 0.012) return;
    this.lutElevation = elevation;
    const look = lookForSunElevation(elevation);
    writeGradeLut(this.lutData, look);
    this.lut.needsUpdate = true;
    (this.composite.uniforms.uAgxEv.value as THREE.Vector2).set(
      look.evWindow[0],
      look.evWindow[1],
    );
  }
}

export default PostFX;
