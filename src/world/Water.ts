import * as THREE from 'three';
import { Phase, type EngineContext, type QualityTier, type System } from '@/engine/System';
import { whenReady, type EnvironmentService } from '@/engine/Services';
import { WATER_LEVEL } from '@/world/Heightfield';
import { buildFloorField, type FloorField } from '@/shaders/water/FloorField';
import {
  createCausticsTexture,
  createFoamTexture,
  createWaveDetailTexture,
} from '@/shaders/water/Textures';
import { createWaterMaterial } from '@/shaders/water/WaterShader';
import {
  buildShoreGeometry,
  countShoreQuads,
  createShoreMaterial,
} from '@/shaders/water/ShoreShader';

/**
 * Water: the lakes in the river basin, and the sea that carries the world to
 * the horizon.
 *
 * The surface is one camera-anchored radial mesh rather than a bounded plane —
 * it always reaches past the far clip, so no wide shot can find its edge. The
 * ring spacing grows geometrically, which puts the triangles where the camera
 * is looking and lets a single draw cover four kilometres.
 *
 * Depth-aware shading needs the scene behind the water, and this project has no
 * depth pre-pass to borrow, so the system captures colour + depth into its own
 * target during `lateUpdate` with the water hidden. That is one extra scene
 * pass; it is skipped entirely on frames where no water is in view. If the
 * post-processing stack ever publishes a shared depth/colour buffer, this
 * capture should be dropped in favour of it — see docs/WATER.md.
 */
export class Water implements System {
  readonly name = 'water';
  readonly phase = Phase.ENVIRONMENT;

  private ctx!: EngineContext;
  private env?: EnvironmentService;

  private field!: FloorField;
  private detailTex!: THREE.DataTexture;
  private foamTex!: THREE.DataTexture;
  private causticTex!: THREE.DataTexture;

  private surface!: THREE.Mesh;
  private surfaceMat!: THREE.ShaderMaterial;
  private shore?: THREE.Mesh;
  private shoreMat?: THREE.ShaderMaterial;

  private sceneRT!: THREE.WebGLRenderTarget;
  private rtScale = 1;
  private discRadius = 4500;

  private time = 0;
  private readonly center = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly sunDir = new THREE.Vector3(0.42, 0.62, 0.35).normalize();

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    const tier = ctx.quality.tier;

    this.field = buildFloorField();

    const texSize = tier === 'low' ? 128 : 256;
    const aniso = Math.min(ctx.quality.anisotropy, 8);
    this.detailTex = createWaveDetailTexture(texSize, aniso);
    this.foamTex = createFoamTexture(texSize, aniso);
    this.causticTex = createCausticsTexture(tier === 'low' ? 128 : 256, 4);

    this.rtScale = RT_SCALE[tier];
    this.sceneRT = this.createTarget(ctx.width, ctx.height);

    // Prevailing wind, and therefore the dominant swell direction. Chosen to
    // run down the long axis of the river basin so waves reach both shores.
    const windAngle = -Math.PI * 0.25;

    this.surfaceMat = createWaterMaterial({
      waveCount: WAVE_COUNT[tier],
      ssrSteps: ctx.quality.ssr ? SSR_STEPS[tier] : 0,
      caustics: tier !== 'low',
      detail: this.detailTex,
      foam: this.foamTex,
      caustic: this.causticTex,
      floorField: this.field.texture,
      fieldUvScale: this.field.uvScale,
      windAngle,
    });
    this.surfaceMat.uniforms.uSceneColor.value = this.sceneRT.texture;
    this.surfaceMat.uniforms.uSceneDepth.value = this.sceneRT.depthTexture;

    const disc = DISC[tier];
    this.discRadius = disc.radius;
    this.surface = new THREE.Mesh(buildRadialGrid(disc.rings, disc.segments, 0.9, disc.radius), this.surfaceMat);
    this.surface.name = 'waterSurface';
    this.surface.frustumCulled = false;
    this.surface.matrixAutoUpdate = false;
    this.surface.renderOrder = 1; // after opaque terrain, so early-Z can reject
    this.surface.castShadow = false;
    this.surface.receiveShadow = false;
    ctx.scene.add(this.surface);

    this.buildShoreOverlay(tier);

    void whenReady('environment').then((env) => {
      this.env = env;
    });
  }

  private buildShoreOverlay(tier: QualityTier): void {
    if (tier === 'low') return;
    // Match the terrain tessellation where the budget allows; a coarser stride
    // still conforms, it just resolves the band edge less precisely.
    let stride = tier === 'ultra' || tier === 'high' ? 1 : 2;
    if (countShoreQuads(this.field, stride) > 60000 && stride === 1) stride = 2;

    const built = buildShoreGeometry(this.field, stride);
    if (built.triangleCount === 0) {
      built.geometry.dispose();
      return;
    }

    this.shoreMat = createShoreMaterial({ detail: this.detailTex, foam: this.foamTex });
    this.shoreMat.uniforms.uSceneColor.value = this.sceneRT.texture;
    this.shore = new THREE.Mesh(built.geometry, this.shoreMat);
    this.shore.name = 'waterShoreline';
    this.shore.matrixAutoUpdate = false;
    this.shore.updateMatrix();
    this.shore.renderOrder = 2;
    this.shore.castShadow = false;
    this.shore.receiveShadow = false;
    this.ctx.scene.add(this.shore);
  }

  private createTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const w = Math.max(2, Math.floor(width * this.rtScale));
    const h = Math.max(2, Math.floor(height * this.rtScale));

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    // Half float where the device can render it, so highlights in the captured
    // scene survive into the refraction and the reflection march.
    const gl = this.ctx.renderer.getContext();
    const canFloat = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));

    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.depthTexture = depth;
    return rt;
  }

  update(_dt: number, elapsed: number): void {
    this.time = elapsed;
  }

  lateUpdate(): void {
    const { camera, scene, renderer } = this.ctx;
    camera.updateMatrixWorld();

    this.anchorSurface(camera);

    const visible = this.waterInView(camera);
    this.surface.visible = visible;
    if (this.shore) this.shore.visible = visible;
    if (!visible) return;

    this.captureScene(renderer, scene, camera);
    this.syncUniforms(camera);
  }

  /**
   * Slides the disc so its dense centre sits where the camera is actually
   * looking, not merely underneath it. The mesh is not rotated, so the wave
   * field stays locked to the world and only the tessellation follows the view.
   */
  private anchorSurface(camera: THREE.PerspectiveCamera): void {
    camera.getWorldDirection(this.tmpDir);
    const eye = camera.position;
    let lead = 160;
    if (this.tmpDir.y < -0.02) {
      const t = (WATER_LEVEL - eye.y) / this.tmpDir.y;
      lead = Math.min(Math.max(t, 0), 520);
    }
    const fx = this.tmpDir.x;
    const fz = this.tmpDir.z;
    const fl = Math.hypot(fx, fz) || 1;
    this.center.set(eye.x + (fx / fl) * lead, WATER_LEVEL, eye.z + (fz / fl) * lead);
    this.surface.position.copy(this.center);
    this.surface.updateMatrix();
  }

  /**
   * Cheap conservative test: is any part of the water plane inside the frustum?
   * A camera tipped up at the sky sees none of it, and that frame gets to skip
   * the whole capture pass.
   */
  private waterInView(camera: THREE.PerspectiveCamera): boolean {
    const eye = camera.position;
    if (eye.y <= WATER_LEVEL + 0.5) return true;
    camera.getWorldDirection(this.tmpDir);
    // Widen the forward vector by half the vertical FOV plus a safety margin.
    const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5;
    const spread = Math.atan(Math.tan(halfFov) * Math.hypot(1, camera.aspect)) + 0.12;
    const pitch = Math.asin(THREE.MathUtils.clamp(this.tmpDir.y, -1, 1));
    return pitch - spread < 0;
  }

  /**
   * Renders the scene without the water into the private target. Shadow map
   * updates are suppressed for this pass — it reuses the maps the main pass
   * will refresh anyway, which keeps the cost to one extra geometry pass.
   */
  private captureScene(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): void {
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;

    this.surface.visible = false;
    if (this.shore) this.shore.visible = false;
    renderer.shadowMap.autoUpdate = false;

    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);

    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    this.surface.visible = true;
    if (this.shore) this.shore.visible = true;
  }

  private syncUniforms(camera: THREE.PerspectiveCamera): void {
    const u = this.surfaceMat.uniforms;
    u.uTime.value = this.time;
    u.uProjection.value.copy(camera.projectionMatrix);
    u.uInvProjection.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;

    const env = this.env;
    if (env) {
      this.sunDir.copy(env.sunDirection).normalize();
      u.uSunDir.value.copy(this.sunDir);
      u.uSunColor.value.copy(env.sunColor);
      u.uSunIntensity.value = env.sunIntensity;
      u.uHorizonColor.value.copy(env.horizonColor);
      // Zenith is not published by the contract; derive a plausible one so the
      // reflected gradient still tracks the time of day.
      u.uZenithColor.value.copy(env.horizonColor).lerp(SKY_BLUE, 0.72).multiplyScalar(0.9);
      u.uGroundColor.value.copy(env.horizonColor).multiplyScalar(0.28);
    }

    const fog = this.ctx.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density;
    } else if (fog instanceof THREE.Fog) {
      u.uFogColor.value.copy(fog.color);
      // Match the exp2 falloff to the linear range so the horizon still closes.
      u.uFogDensity.value = 1.7 / Math.max(1, fog.far);
    }

    // Calm the whole spectrum down when the camera is close enough that a
    // metre-scale swell would look absurd next to a unit.
    const height = camera.position.y - WATER_LEVEL;
    u.uWaveScale.value = THREE.MathUtils.clamp(0.55 + height * 0.006, 0.55, 1.0);

    const s = this.shoreMat;
    if (s) {
      s.uniforms.uTime.value = this.time;
      s.uniforms.uSunDir.value.copy(u.uSunDir.value);
      s.uniforms.uSunColor.value.copy(u.uSunColor.value);
      s.uniforms.uSunIntensity.value = u.uSunIntensity.value;
      s.uniforms.uSwashRange.value = u.uSwashRange.value;
    }
  }

  resize(width: number, height: number): void {
    const w = Math.max(2, Math.floor(width * this.rtScale));
    const h = Math.max(2, Math.floor(height * this.rtScale));
    this.sceneRT.setSize(w, h);
    // setSize reallocates the colour attachment but leaves the depth texture's
    // declared dimensions stale, so resize it explicitly.
    const depth = this.sceneRT.depthTexture;
    if (depth) {
      depth.image.width = w;
      depth.image.height = h;
      depth.needsUpdate = true;
    }
  }

  dispose(): void {
    this.ctx?.scene.remove(this.surface);
    this.surface?.geometry.dispose();
    this.surfaceMat?.dispose();
    if (this.shore) {
      this.ctx.scene.remove(this.shore);
      this.shore.geometry.dispose();
    }
    this.shoreMat?.dispose();
    this.sceneRT?.depthTexture?.dispose();
    this.sceneRT?.dispose();
    this.field?.texture.dispose();
    this.detailTex?.dispose();
    this.foamTex?.dispose();
    this.causticTex?.dispose();
  }
}

const SKY_BLUE = new THREE.Color(0x2f6ea8);

const WAVE_COUNT: Record<QualityTier, number> = { low: 3, medium: 4, high: 6, ultra: 6 };
const SSR_STEPS: Record<QualityTier, number> = { low: 0, medium: 14, high: 22, ultra: 28 };
const RT_SCALE: Record<QualityTier, number> = { low: 0.45, medium: 0.6, high: 1, ultra: 1 };
const DISC: Record<QualityTier, { rings: number; segments: number; radius: number }> = {
  low: { rings: 96, segments: 96, radius: 4200 },
  medium: { rings: 144, segments: 128, radius: 4400 },
  high: { rings: 192, segments: 168, radius: 4500 },
  ultra: { rings: 224, segments: 192, radius: 4500 },
};

/**
 * A radial grid with geometrically increasing ring spacing. Sample density
 * near the centre resolves individual crests; out at the horizon a ring is
 * hundreds of metres deep, which is exactly where nothing but the fog colour
 * survives anyway.
 */
function buildRadialGrid(rings: number, segments: number, rMin: number, rMax: number): THREE.BufferGeometry {
  const vertexCount = rings * segments + 1;
  const positions = new Float32Array(vertexCount * 3);

  // Centre vertex.
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;

  const growth = Math.pow(rMax / rMin, 1 / (rings - 1));
  let p = 3;
  for (let r = 0; r < rings; r++) {
    const radius = rMin * Math.pow(growth, r);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      positions[p++] = Math.cos(a) * radius;
      positions[p++] = 0;
      positions[p++] = Math.sin(a) * radius;
    }
  }

  const indices: number[] = [];
  // Fan from the centre to the first ring.
  for (let s = 0; s < segments; s++) {
    indices.push(0, 1 + s, 1 + ((s + 1) % segments));
  }
  for (let r = 0; r < rings - 1; r++) {
    const a0 = 1 + r * segments;
    const a1 = 1 + (r + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const sn = (s + 1) % segments;
      indices.push(a0 + s, a1 + s, a0 + sn);
      indices.push(a0 + sn, a1 + s, a1 + sn);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax * 1.2);
  return geometry;
}

export default Water;
