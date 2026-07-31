import * as THREE from 'three';
import { Phase, type EngineContext, type System } from '@/engine/System';
import { shaderConfig, skyState, skyUniforms } from '@/shaders/sky/SceneShaders';

/**
 * The light rig: key, fill, bounce, and the cascaded shadow maps.
 *
 * The atmosphere decides *what* the light is — it publishes direction, colour
 * and intensity for the key (sun by day, moon by night), a cool sky fill and a
 * warm ground bounce through `skyState`. This system decides *how it is cast*.
 *
 * ## Cascades
 *
 * `SceneShaders` overrides three's `lights_fragment_begin` so that the first
 * `VS_CSM_CASCADES` directional lights in the scene are treated as shadow
 * cascades rather than as separate lights: each one's contribution is scaled by
 * a cascade weight that sums to one across the set. That has two consequences
 * this file must respect.
 *
 *   1. The cascade lights must be added to the scene *before* the fill and
 *      bounce lights. Three orders its directional light list by traversal
 *      order, so a light added earlier would be mistaken for a cascade.
 *   2. Every cascade light carries the *full* key colour and intensity. The
 *      weights, not the intensities, do the blending.
 *
 * Each cascade covers a slice of the view distance and fits an orthographic
 * shadow camera to it. The fit is snapped to the shadow map's own texel grid,
 * which is what stops shadow edges from crawling as the camera pans — without
 * it, sub-texel movement of the projection makes every edge shimmer.
 */

/** Straight up; the terrain bounce shines down from here onto up-facing ground. */
const UP = new THREE.Vector3(0, 1, 0);

/** Mean ground albedo, used to tint reflected sunlight. */
const GROUND_ALBEDO = new THREE.Color(0.46, 0.40, 0.30);

/** Furthest distance that receives a shadow, in world units. */
const SHADOW_DISTANCE = 900;
/** Blend between uniform and logarithmic cascade splits; 0.75 favours near detail. */
const SPLIT_LAMBDA = 0.75;

export class Lighting implements System {
  readonly name = 'lighting';
  // After the atmosphere, so the first frame reads a sun that has been placed.
  readonly phase = Phase.ENVIRONMENT + 10;

  private ctx!: EngineContext;
  private cascades: THREE.DirectionalLight[] = [];
  private fill!: THREE.DirectionalLight;
  private bounce!: THREE.DirectionalLight;
  private terrainBounce!: THREE.DirectionalLight;
  private ambient!: THREE.HemisphereLight;

  private splits: number[] = [];
  private appliedRevision = -1;

  private readonly tmpCenter = new THREE.Vector3();
  private readonly tmpViewDir = new THREE.Vector3();
  private readonly tmpSnap = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly lightView = new THREE.Matrix4();
  private readonly lightViewInv = new THREE.Matrix4();

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    const count = Math.max(1, shaderConfig.cascades || ctx.quality.shadowCascades || 3);
    const mapSize = ctx.quality.shadowMapSize;

    this.splits = computeSplits(count, 8, SHADOW_DISTANCE, SPLIT_LAMBDA);

    // Cascades first — see the class comment.
    for (let i = 0; i < count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.name = `csm-${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(mapSize, mapSize);
      light.shadow.camera.near = 1;
      light.shadow.camera.far = SHADOW_DISTANCE * 2.4;
      // Slope-scaled normal bias does the heavy lifting; a large constant bias
      // would detach contact shadows from the objects casting them.
      light.shadow.bias = -0.00035;
      light.shadow.normalBias = 0.35 + i * 0.55;
      ctx.scene.add(light);
      ctx.scene.add(light.target);
      this.cascades.push(light);
    }

    this.fill = new THREE.DirectionalLight(0x8fb4e8, 0.8);
    this.fill.name = 'sky-fill';
    ctx.scene.add(this.fill, this.fill.target);

    this.bounce = new THREE.DirectionalLight(0x6b5c42, 0.5);
    this.bounce.name = 'ground-bounce';
    ctx.scene.add(this.bounce, this.bounce.target);

    // Warm bounce onto *up-facing* surfaces.
    //
    // Everything else reaching shaded ground is cool: the fill is sky-blue, the
    // hemisphere light hands up-facing normals its sky colour, and `bounce`
    // above sits below the surface shining upward, so it only catches undersides.
    // Real shaded ground is also lit by sunlight bouncing off the sunlit terrain
    // around it, and without that term a shaded valley renders as saturated blue.
    // A dim warm light pointing straight down is the standard cheap stand-in for
    // that inter-reflection.
    this.terrainBounce = new THREE.DirectionalLight(0xffd8a8, 0.0);
    this.terrainBounce.name = 'terrain-bounce';
    ctx.scene.add(this.terrainBounce, this.terrainBounce.target);

    // Floor under the IBL so nothing ever reads as pure black, and so the scene
    // is still lit before the first environment probe has been filtered.
    this.ambient = new THREE.HemisphereLight(0x9fc0e0, 0x4a4436, 0.35);
    ctx.scene.add(this.ambient);

    this.pushSplitUniforms();
    this.syncFromSky(true);
    this.fitCascades();
  }

  update(): void {
    this.syncFromSky(false);
    this.fitCascades();
  }

  /** Copies the atmosphere's published lighting state onto the rig. */
  private syncFromSky(force: boolean): void {
    if (force || skyState.revision !== this.appliedRevision) {
      this.appliedRevision = skyState.revision;

      for (const light of this.cascades) {
        light.color.copy(skyState.keyColor);
        light.intensity = skyState.keyIntensity;
      }
      this.fill.color.copy(skyState.fillColor);
      this.fill.intensity = skyState.fillIntensity;
      this.bounce.color.copy(skyState.bounceColor);
      this.bounce.intensity = skyState.bounceIntensity;

      // Bounce carries the sun's colour tinted by ground albedo, and scales with
      // how much sun the terrain is actually receiving — near-zero at night,
      // strongest at midday when there is most sunlit ground to reflect off.
      this.terrainBounce.color.copy(skyState.keyColor).multiply(GROUND_ALBEDO);
      const sunUp = Math.max(0, skyState.keyDirection.y);
      this.terrainBounce.intensity = 0.55 * sunUp * (1 - skyState.night);

      // The hemisphere floor tracks night so the world darkens without ever
      // clipping to black, which reads as broken rather than as night.
      this.ambient.color.copy(skyState.skyColor);
      this.ambient.intensity = 0.35 * (1 - skyState.night * 0.72);
    }

    // Fill and bounce follow the camera every frame regardless of sun movement,
    // so they stay centred on whatever the player is looking at.
    this.aimAlong(this.fill, skyState.fillDirection);
    this.aimAlong(this.bounce, skyState.bounceDirection);
    this.aimAlong(this.terrainBounce, UP);
  }

  /** Places a light so it shines *from* `direction` toward the camera's focus. */
  private aimAlong(light: THREE.DirectionalLight, direction: THREE.Vector3): void {
    const focus = this.ctx.camera.position;
    light.target.position.copy(focus);
    light.position.copy(focus).addScaledVector(direction, 300);
    light.target.updateMatrixWorld();
  }

  /**
   * Fits each cascade's orthographic shadow camera to its slice of the view.
   *
   * The slice is bounded by a sphere so the fit is rotation invariant: if the
   * extent changed as the camera turned, shadow resolution would visibly pulse.
   */
  private fitCascades(): void {
    const camera = this.ctx.camera;
    camera.getWorldDirection(this.tmpViewDir);
    const sun = skyState.keyDirection;
    const mapSize = this.cascades[0]?.shadow.mapSize.x ?? 2048;
    const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);

    let near = 1;
    for (let i = 0; i < this.cascades.length; i++) {
      const far = this.splits[i];
      const light = this.cascades[i];

      const mid = (near + far) * 0.5;
      this.tmpCenter.copy(camera.position).addScaledVector(this.tmpViewDir, mid);

      // Radius of the sphere bounding this slice's frustum corners.
      const halfHeight = Math.tan(halfFov) * far;
      const halfWidth = halfHeight * camera.aspect;
      const radius = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight + (far - mid) * (far - mid));

      // Snap the centre to the shadow map's texel grid, in light space, so that
      // panning never shifts the projection by a sub-texel amount.
      const texelWorld = (radius * 2) / mapSize;
      this.lightView.lookAt(this.tmpCenter, this.tmpCenter.clone().addScaledVector(sun, -1), this.tmpUp);
      this.lightViewInv.copy(this.lightView);
      this.lightView.invert();

      this.tmpSnap.copy(this.tmpCenter).applyMatrix4(this.lightView);
      this.tmpSnap.x = Math.floor(this.tmpSnap.x / texelWorld) * texelWorld;
      this.tmpSnap.y = Math.floor(this.tmpSnap.y / texelWorld) * texelWorld;
      this.tmpSnap.applyMatrix4(this.lightViewInv);

      const back = radius * 1.8 + 60;
      light.target.position.copy(this.tmpSnap);
      light.position.copy(this.tmpSnap).addScaledVector(sun, back);
      light.target.updateMatrixWorld();

      const cam = light.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 1;
      cam.far = back + radius * 1.8;
      cam.updateProjectionMatrix();

      skyUniforms.uCsmExtent.value.setComponent(i, radius * 2);
      skyUniforms.uCsmDepth.value.setComponent(i, cam.far - cam.near);
      near = far;
    }
  }

  private pushSplitUniforms(): void {
    for (let i = 0; i < 4; i++) {
      skyUniforms.uCsmSplits.value.setComponent(i, this.splits[i] ?? SHADOW_DISTANCE);
    }
  }

  dispose(): void {
    for (const light of this.cascades) {
      light.shadow.map?.dispose();
      this.ctx?.scene.remove(light, light.target);
    }
    this.ctx?.scene.remove(
      this.fill, this.fill.target,
      this.bounce, this.bounce.target,
      this.terrainBounce, this.terrainBounce.target,
      this.ambient,
    );
  }
}

export default Lighting;

/**
 * Practical split scheme: a blend of uniform and logarithmic distribution.
 * Purely logarithmic wastes the far cascades on almost nothing; purely uniform
 * starves the near one, which is where shadow quality is actually judged.
 */
function computeSplits(count: number, near: number, far: number, lambda: number): number[] {
  const splits: number[] = [];
  for (let i = 1; i <= count; i++) {
    const p = i / count;
    const log = near * Math.pow(far / near, p);
    const uniform = near + (far - near) * p;
    splits.push(lambda * log + (1 - lambda) * uniform);
  }
  splits[count - 1] = far;
  return splits;
}
