import * as THREE from 'three';
import { makeRng } from '@/util/Noise';
import { TERRAIN_DATA_GLSL, type TerrainData } from './TerrainData';
import { WIND_GLSL, sunUniforms, windUniforms } from './Wind';
import { HALF_WORLD, WORLD_SIZE } from '@/world/Heightfield';

/**
 * GPU-placed grass carpet.
 *
 * Blades live on a lattice that is fixed in world space but wrapped around the
 * camera's ground focus, so a fixed instance budget always lands where the
 * player is looking and nothing is ever spent on grass behind the horizon. The
 * vertex shader reads ground height, normal and the ecology masks straight out
 * of the baked terrain textures, so the CPU does nothing per frame beyond
 * writing four uniforms.
 *
 * Two of these make the whole world's grass: a dense near ring and a sparser,
 * larger-bladed far ring whose colour converges on the terrain albedo, which is
 * what hides the edge of the detail radius.
 */

/** A single blade: four tapering rows plus a tip. Seven triangles. */
function bladeGeometry(): THREE.BufferGeometry {
  const rows = [0.0, 0.34, 0.63, 0.85];
  const widths = [1.0, 0.9, 0.72, 0.44];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let r = 0; r < rows.length; r++) {
    pos.push(-0.5 * widths[r], rows[r], 0, 0.5 * widths[r], rows[r], 0);
    uv.push(0, rows[r], 1, rows[r]);
  }
  const tip = rows.length * 2;
  pos.push(0, 1, 0);
  uv.push(0.5, 1);

  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const last = (rows.length - 1) * 2;
  idx.push(last, last + 1, tip);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export interface GrassLayerOptions {
  count: number;
  /** Detail radius in world units at the reference camera distance. */
  radius: number;
  bladeWidth: number;
  bladeHeight: number;
  /** How strongly this ring dissolves into the terrain albedo. */
  groundBlend: number;
  seed: number;
}

export class GrassLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly opts: GrassLayerOptions;

  constructor(terrain: TerrainData, opts: GrassLayerOptions) {
    this.opts = opts;

    const base = bladeGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    geo.instanceCount = opts.count;

    const rng = makeRng(opts.seed);
    const offset = new Float32Array(opts.count * 2);
    const rand = new Float32Array(opts.count * 4);
    for (let i = 0; i < opts.count; i++) {
      // Stratified within the tile so the lattice never clumps or gaps.
      offset[i * 2] = rng();
      offset[i * 2 + 1] = rng();
      rand[i * 4] = rng();
      rand[i * 4 + 1] = rng();
      rand[i * 4 + 2] = rng();
      rand[i * 4 + 3] = rng();
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offset, 2));
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uHeightTex: { value: terrain.heightTex },
      uMaskTex: { value: terrain.maskTex },
      uWorldSize: { value: WORLD_SIZE },
      uHalfWorld: { value: HALF_WORLD },
      uCenter: { value: new THREE.Vector2() },
      uTile: { value: opts.radius * 2.45 },
      uRadius: { value: opts.radius },
      uBlade: { value: new THREE.Vector2(opts.bladeWidth, opts.bladeHeight) },
      uGroundBlend: { value: opts.groundBlend },
      uGlobalFade: { value: 1 },
      ...windUniforms,
      ...sunUniforms,
    };

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0,
      side: THREE.DoubleSide,
      dithering: true,
    });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = patchVertex(shader.vertexShader);
      shader.fragmentShader = patchFragment(shader.fragmentShader);
    };
    this.material.customProgramCacheKey = () => 'verdium-grass';

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = `grass-${opts.seed}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1;
    this.mesh.updateMatrix();
  }

  /**
   * Re-centres the ring on the camera's ground focus and rescales it with view
   * distance, so zooming out thins the carpet instead of exploding the budget.
   */
  setFocus(x: number, z: number, viewDistance: number): void {
    const scale = THREE.MathUtils.clamp(viewDistance / 70, 0.62, 3.1);
    const radius = this.opts.radius * scale;
    this.uniforms.uCenter.value.set(x, z);
    this.uniforms.uRadius.value = radius;
    this.uniforms.uTile.value = radius * 2.45;
    // Blades widen slightly as the ring grows so they never fall below a pixel
    // and shimmer; height grows less so the field does not look coarse.
    (this.uniforms.uBlade.value as THREE.Vector2).set(
      this.opts.bladeWidth * (0.85 + scale * 0.42),
      this.opts.bladeHeight * (0.9 + scale * 0.12),
    );
    this.uniforms.uGlobalFade.value = 1 - THREE.MathUtils.smoothstep(viewDistance, 300, 460);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------- shaders --- */

const VERTEX_DECLS = /* glsl */ `
attribute vec2 aOffset;
attribute vec4 aRand;

uniform vec2  uCenter;
uniform float uTile;
uniform float uRadius;
uniform vec2  uBlade;
uniform float uGlobalFade;

varying float vV;
varying float vRand;
varying float vMask;
varying float vMoist;
varying float vVar;
varying float vGust;
varying float vBlend;
varying vec3  vWorld;

vec3 gPos;
vec3 gNrm;

${TERRAIN_DATA_GLSL}
${WIND_GLSL}

void vsGrassSetup() {
  vec2 tileOff = aOffset * uTile;
  vec2 d = uCenter - tileOff;
  vec2 base = uCenter - mod(d + uTile * 0.5, uTile) + uTile * 0.5;

  float dist = length(base - uCenter);
  float r = uRadius * (0.78 + 0.42 * aRand.w);
  float fade = 1.0 - smoothstep(r * 0.6, r, dist);
  fade *= uGlobalFade;

  vec4 g = vsGround(base);
  vec4 m = vsMask(base);

  // Per-blade threshold against the density mask: gives a naturally dithered
  // edge to every meadow instead of a hard cut.
  float alive = step(aRand.z * 0.9 + 0.04, m.r) * step(0.004, fade);
  float grow = alive * fade;

  float height = uBlade.y * (0.5 + 0.95 * aRand.y) * (0.5 + 0.75 * m.r) * grow;
  float width = uBlade.x * (0.62 + 0.7 * aRand.z) * (0.75 + 0.4 * m.r);

  float yaw = aRand.x * 6.28318;
  vec3 side = vec3(cos(yaw), 0.0, sin(yaw));
  vec3 face = vec3(-sin(yaw), 0.0, cos(yaw));

  float v = uv.y;
  float t = v * v;

  vec3 wind = vsWind(base, 7.0 + aRand.x * 5.0);
  // Downhill lean plus a fixed per-blade lean, then the gust on top.
  vec2 lean = vec2(g.y, g.z) * 0.55 + face.xz * (aRand.w - 0.5) * 0.34;
  vec2 sway = (lean + wind.xy * 0.42) * height * t;

  vec3 world = vec3(base.x, g.x - 0.08, base.y);
  world += side * ((uv.x - 0.5) * width * (1.0 - t * 0.35));
  world.y += v * height;
  world.xz += sway;
  // Keep the blade roughly inextensible: bending shortens its vertical reach.
  world.y -= dot(sway, sway) / max(height, 0.02) * 0.5;

  gPos = world;
  gNrm = normalize(face + side * (uv.x - 0.5) * 1.5 + vec3(0.0, 0.22, 0.0));

  vV = v;
  vRand = aRand.y;
  vMask = m.r;
  vMoist = m.g;
  vVar = m.b;
  vGust = wind.z;
  vWorld = world;

  float camDist = distance(cameraPosition, world);
  vBlend = smoothstep(uRadius * 0.35, uRadius * 1.05, dist) * 0.85
         + smoothstep(120.0, 340.0, camDist) * 0.5;
  vBlend = clamp(vBlend, 0.0, 0.95);
}
`;

function patchVertex(src: string): string {
  return src
    .replace('#include <common>', `#include <common>\n${VERTEX_DECLS}`)
    .replace('#include <beginnormal_vertex>', 'vsGrassSetup();\nvec3 objectNormal = gNrm;')
    .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
}

const FRAGMENT_DECLS = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uGroundBlend;

varying float vV;
varying float vRand;
varying float vMask;
varying float vMoist;
varying float vVar;
varying float vGust;
varying float vBlend;
varying vec3  vWorld;

vec3 vsGroundColorF(float h, float slope, float moisture) {
  vec3 shore = vec3(0.352, 0.316, 0.234);
  vec3 rock  = vec3(0.286, 0.272, 0.250);
  vec3 dry   = vec3(0.298, 0.312, 0.180);
  vec3 lush  = vec3(0.176, 0.283, 0.132);
  vec3 alp   = vec3(0.410, 0.395, 0.345);
  vec3 c = mix(dry, lush, moisture);
  c = mix(c, alp, smoothstep(66.0, 104.0, h));
  c = mix(c, rock, smoothstep(0.24, 0.5, slope));
  return mix(shore, c, smoothstep(0.2, 3.4, h));
}
`;

/**
 * Diffuse albedo ceiling for a blade. Real grass sits near 0.25; this is well
 * above that so the field keeps its bite, but low enough to stay physical.
 */
const COLOR_BODY = /* glsl */ `
  #define VS_GRASS_ALBEDO_MAX 0.58

  vec3 dryC  = vec3(0.412, 0.386, 0.168);
  vec3 lushC = vec3(0.155, 0.352, 0.104);
  vec3 blade = mix(dryC, lushC, clamp(vMoist * 1.15, 0.0, 1.0));
  // Clump-scale hue drift, then a per-blade value shift.
  blade = mix(blade, blade * vec3(1.28, 1.12, 0.66), vVar * 0.55);
  blade *= 0.78 + 0.44 * vRand;

  // Root darkening: real turf is almost black where the blades interlock.
  float ao = 0.24 + 0.76 * smoothstep(0.0, 0.62, vV);
  ao *= 0.72 + 0.28 * vMask;
  vec3 tipC = blade * vec3(1.24, 1.18, 0.95);
  vec3 col = mix(blade * ao, tipC, smoothstep(0.5, 1.0, vV) * 0.65);
  // Gusts flash the paler underside of the blades as they roll over.
  col = mix(col, col * vec3(1.18, 1.2, 1.05), clamp(vGust - 0.55, 0.0, 0.6));

  // Clump drift, per-blade value, tip lightening and gust are all multipliers,
  // and a blade that draws high on every one of them lands past 1.0 — an albedo
  // that reflects more light than reaches it. Under a noon key that is what
  // bleached the whole field to white. Rescale rather than clamp per channel,
  // so an over-bright blade loses value without also shifting hue.
  float peak = max(max(col.r, col.g), col.b);
  col *= VS_GRASS_ALBEDO_MAX / max(peak, VS_GRASS_ALBEDO_MAX);

  vec3 groundC = vsGroundColorF(vWorld.y, 0.0, vMoist);
  col = mix(col, groundC, vBlend * uGroundBlend);
  diffuseColor.rgb = col;
`;

const TRANSLUCENCY_BODY = /* glsl */ `
  {
    vec3 V = normalize(cameraPosition - vWorld);
    float back = pow(clamp(dot(-normalize(uSunDir), V), 0.0, 1.0), 3.0);
    float thin = 0.25 + 0.75 * vV;
    totalEmissiveRadiance += uSunColor * diffuseColor.rgb * back * thin * uSunIntensity * 0.16;
  }
`;

function patchFragment(src: string): string {
  return src
    .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLS}`)
    .replace('#include <color_fragment>', COLOR_BODY)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${TRANSLUCENCY_BODY}`);
}
