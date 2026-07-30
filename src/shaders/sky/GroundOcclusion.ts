import * as THREE from 'three';
import { HALF_WORLD, WORLD_SIZE, heightAt } from '@/world/Heightfield';
import { skyUniforms } from './SceneShaders';

/**
 * Terrain-scale shadowing, baked into one small texture the whole scene samples.
 *
 * A 1024x1024 map's most valuable shadow is the one a ridge throws across a
 * valley — kilometre-long, soft at the far end, and completely out of reach of a
 * shadow map that has to also resolve a tank track. So the terrain is not a
 * shadow caster at all: its height field is baked once from `Heightfield` (the
 * shared source of truth, so this stays correct no matter how the terrain
 * renderer changes), then two GPU passes turn it into
 *
 *   r = sun visibility (ray-marched, penumbra widening with distance)
 *   g = sky visibility (horizon-angle ambient occlusion, static)
 *   b = terrain height, so materials know how far they float above the ground
 *
 * The sun channel is re-marched only when the sun has moved meaningfully.
 */

const HEIGHT_RES = 512;
const AO_RES = 256;
const OUT_RES = 512;

/** Height encode: stored = (h + OFFSET) / SCALE, both published to shaders. */
const HEIGHT_OFFSET = 48;
const HEIGHT_SCALE = 352;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const AO_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform vec2 uWorld; // x = world size, y = 1 / world size
varying vec2 vUv;

float terrainAt(vec2 world) {
  return texture2D(uHeight, world * uWorld.y + 0.5).r;
}

void main() {
  vec2 world = (vUv - 0.5) * uWorld.x;
  float h = terrainAt(world);
  float visible = 0.0;
  const int DIRS = 8;
  const int STEPS = 12;
  for (int d = 0; d < DIRS; d++) {
    float a = (float(d) + 0.5) / float(DIRS) * 6.283185307;
    vec2 dir = vec2(cos(a), sin(a));
    float maxSlope = 0.0;
    float t = 3.0;
    for (int i = 0; i < STEPS; i++) {
      float dh = terrainAt(world + dir * t) - h;
      maxSlope = max(maxSlope, dh / t);
      t *= 1.62;
    }
    float horizon = atan(max(maxSlope, 0.0));
    visible += 1.0 - sin(horizon);
  }
  visible /= float(DIRS);
  gl_FragColor = vec4(vec3(visible), 1.0);
}
`;

const SUN_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uAo;
uniform vec3 uSunDir;
uniform vec2 uWorld;
uniform vec2 uEncode; // x = height scale, y = height offset
uniform float uSoftness;
varying vec2 vUv;

float terrainAt(vec2 world) {
  return texture2D(uHeight, world * uWorld.y + 0.5).r;
}

void main() {
  vec2 world = (vUv - 0.5) * uWorld.x;
  float h = terrainAt(world);
  float visibility = 0.0;

  if (uSunDir.y > 0.015) {
    vec3 p = vec3(world.x, h + 0.5, world.y);
    float t = 2.5;
    float stride = 3.0;
    float soft = 1.0;
    float limit = uWorld.x * 0.5 + 8.0;
    for (int i = 0; i < 52; i++) {
      vec3 s = p + uSunDir * t;
      if (abs(s.x) > limit || abs(s.z) > limit) break;
      float d = s.y - terrainAt(s.xz);
      if (d < 0.0) { soft = 0.0; break; }
      // Penumbra: the further away the occluding ridge, the softer its edge.
      soft = min(soft, uSoftness * d / t);
      t += stride;
      stride *= 1.085;
    }
    visibility = smoothstep(0.0, 1.0, soft);
  }

  float ao = texture2D(uAo, vUv).r;
  gl_FragColor = vec4(visibility, ao, (h + uEncode.y) / uEncode.x, 1.0);
}
`;

export class GroundOcclusion {
  readonly texture: THREE.Texture;

  private renderer: THREE.WebGLRenderer;
  private heightTexture: THREE.DataTexture;
  private aoTarget: THREE.WebGLRenderTarget;
  private outTarget: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private aoMaterial: THREE.ShaderMaterial;
  private sunMaterial: THREE.ShaderMaterial;
  private lastSun = new THREE.Vector3(0, -1, 0);
  private baked = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.heightTexture = this.bakeHeightField();

    const rtOptions: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.aoTarget = new THREE.WebGLRenderTarget(AO_RES, AO_RES, rtOptions);
    this.outTarget = new THREE.WebGLRenderTarget(OUT_RES, OUT_RES, rtOptions);
    this.texture = this.outTarget.texture;

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const world = new THREE.Vector2(WORLD_SIZE, 1 / WORLD_SIZE);
    this.aoMaterial = new THREE.ShaderMaterial({
      uniforms: { uHeight: { value: this.heightTexture }, uWorld: { value: world } },
      vertexShader: QUAD_VERT,
      fragmentShader: AO_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.sunMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uHeight: { value: this.heightTexture },
        uAo: { value: this.aoTarget.texture },
        uSunDir: skyUniforms.uSunDir,
        uWorld: { value: world },
        uEncode: { value: new THREE.Vector2(HEIGHT_SCALE, HEIGHT_OFFSET) },
        uSoftness: { value: 26.0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: SUN_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    skyUniforms.uGroundTex.value = this.texture;
    skyUniforms.uGroundParams.value.set(1 / WORLD_SIZE, HEIGHT_OFFSET, 0.85, HEIGHT_SCALE);
  }

  /** Samples the shared height field into a half-float texture. */
  private bakeHeightField(): THREE.DataTexture {
    const data = new Uint16Array(HEIGHT_RES * HEIGHT_RES * 4);
    const step = WORLD_SIZE / (HEIGHT_RES - 1);
    for (let y = 0; y < HEIGHT_RES; y++) {
      const wz = -HALF_WORLD + y * step;
      for (let x = 0; x < HEIGHT_RES; x++) {
        const wx = -HALF_WORLD + x * step;
        const h = heightAt(wx, wz);
        const i = (y * HEIGHT_RES + x) * 4;
        data[i] = THREE.DataUtils.toHalfFloat(h);
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    const tex = new THREE.DataTexture(data, HEIGHT_RES, HEIGHT_RES, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /** Re-marches the sun channel if the sun moved; returns true when it did. */
  update(sunDirection: THREE.Vector3, force = false): boolean {
    if (!force && this.baked && this.lastSun.dot(sunDirection) > 0.9995) return false;
    this.lastSun.copy(sunDirection);

    const previous = this.renderer.getRenderTarget();
    if (!this.baked) {
      this.baked = true;
      this.quad.material = this.aoMaterial;
      this.renderer.setRenderTarget(this.aoTarget);
      this.renderer.render(this.quadScene, this.quadCamera);
    }
    this.quad.material = this.sunMaterial;
    this.renderer.setRenderTarget(this.outTarget);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.setRenderTarget(previous);
    return true;
  }

  dispose(): void {
    this.heightTexture.dispose();
    this.aoTarget.dispose();
    this.outTarget.dispose();
    this.aoMaterial.dispose();
    this.sunMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
