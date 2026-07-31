import * as THREE from 'three';
import { clamp, makeRng } from '@/util/Noise';
import { GeoBuilder, addCard, addTube } from './GeoBuilder';
import type { AtlasCell, LeafAtlas } from './Textures';
import { WIND_GLSL, sunUniforms, windUniforms } from './Wind';

/**
 * Procedural trees.
 *
 * Each species is grown once at boot from a recursive limb generator: real
 * tapered branches with radial bark relief, and foliage as alpha-cut leaf-cluster
 * cards pinned to the branch tips. Cards get their shading normal blended
 * toward the canopy's outward direction, which is the difference between a tree
 * that lights like a tree and one that lights like a stack of postcards.
 *
 * Three levels of detail are produced: full geometry, a simplified build, and a
 * billboard imposter baked from the full mesh into a shared atlas so an entire
 * distant forest costs one draw call per species.
 */

export type TreeKind = 'pine' | 'oak' | 'birch' | 'dead';

export interface BuiltTree {
  bark: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry | null;
  height: number;
  radius: number;
}

export interface TreeSpecies {
  kind: TreeKind;
  /** [0] full detail, [1] simplified; `dead` only provides [0]. */
  lods: BuiltTree[];
  height: number;
  radius: number;
  barkColor: number;
  /** Wind sway amplitude in world units at full gust for a unit-scale tree. */
  sway: number;
}

/* ------------------------------------------------------------- geometry -- */

const UP = new THREE.Vector3(0, 1, 0);

interface LimbResult {
  points: THREE.Vector3[];
  dirs: THREE.Vector3[];
}

/** Walks a branch outward, curving under gravity and a little noise. */
function growLimb(
  start: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  segments: number,
  gravity: number,
  wander: number,
  rng: () => number,
): LimbResult {
  const points: THREE.Vector3[] = [start.clone()];
  const dirs: THREE.Vector3[] = [];
  const d = dir.clone().normalize();
  const step = length / segments;
  const jitter = new THREE.Vector3();
  for (let i = 0; i < segments; i++) {
    dirs.push(d.clone());
    const p = points[points.length - 1].clone().addScaledVector(d, step);
    points.push(p);
    d.y -= gravity * step * 0.1;
    jitter.set(rng() - 0.5, (rng() - 0.5) * 0.5, rng() - 0.5).multiplyScalar(wander);
    d.add(jitter).normalize();
  }
  dirs.push(d.clone());
  return { points, dirs };
}

function windWeight(p: THREE.Vector3, height: number, radius: number, depth: number): number {
  const vertical = clamp(p.y / Math.max(height, 0.01), 0, 1);
  const lateral = clamp(Math.hypot(p.x, p.z) / Math.max(radius, 0.01), 0, 1);
  return clamp(Math.pow(vertical, 1.35) * 0.62 + lateral * 0.3 + depth * 0.12, 0, 1.3);
}

/**
 * Vertex colour on every builder in this stream is a *modulation* of the bound
 * albedo map, not a colour in its own right — it averages to roughly one, so
 * enabling `vertexColors` adds crevice occlusion and canopy depth without
 * darkening the material's overall tone.
 */
interface BarkStyle {
  /** Modulation on a ridge crest and at the bottom of a crevice. */
  crest: number;
  crevice: number;
  /** Per-channel hue push at the crest, around 1. */
  tint: THREE.Color;
  /** Horizontal lenticel banding, for birch. */
  banding: number;
}

function limbColorFn(style: BarkStyle, height: number, rng: () => number) {
  const scratch = new THREE.Color();
  const seedA = rng() * 100;
  return (yAt: (t: number) => number) =>
    (t: number, angle: number, ridge: number): THREE.Color => {
      const y = yAt(t);
      let k = 0.5 + ridge * 3.4;
      // Ambient occlusion into the root flare and toward the crown interior.
      k *= 0.62 + 0.38 * clamp(y / (height * 0.35), 0, 1);
      scratch.copy(style.tint).multiplyScalar(
        style.crevice + (style.crest - style.crevice) * clamp(k, 0, 1),
      );
      if (style.banding > 0) {
        const band = Math.sin(y * 2.6 + Math.sin(angle * 3.0 + seedA) * 0.9 + seedA);
        if (band > 0.72) scratch.multiplyScalar(0.34);
        else if (band > 0.55) scratch.multiplyScalar(0.72);
      }
      return scratch;
    };
}

interface FoliageSpot {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  size: number;
  depth: number;
}

function emitCards(
  b: GeoBuilder,
  spots: FoliageSpot[],
  cells: AtlasCell[],
  tint: THREE.Color,
  height: number,
  radius: number,
  rng: () => number,
  flatten: number,
): void {
  if (spots.length === 0) return;
  const canopy = new THREE.Vector3();
  for (const s of spots) canopy.add(s.pos);
  canopy.divideScalar(spots.length);

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const soft = new THREE.Vector3();
  const color = new THREE.Color();

  for (const s of spots) {
    soft.subVectors(s.pos, canopy);
    if (soft.lengthSq() < 1e-6) soft.set(0, 1, 0);
    soft.normalize();
    soft.y = soft.y * (1 - flatten) + flatten * 0.55;
    soft.normalize();

    // Card plane: mostly facing outward from the canopy, tilted at random.
    up.set(rng() - 0.5, 1.0 + rng() * 0.6, rng() - 0.5).normalize();
    right.crossVectors(up, soft);
    if (right.lengthSq() < 1e-5) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(soft, right).normalize();

    // Interior cards are darker: cheap but very effective canopy depth.
    const depth = clamp(1 - s.pos.distanceTo(canopy) / Math.max(radius, 0.01), 0, 1);
    const shade = 0.55 + 0.45 * (1 - depth);
    const warm = 0.86 + rng() * 0.34;
    color.copy(tint).multiplyScalar(shade * warm);
    // Sun-facing top of the canopy bleaches slightly.
    color.lerp(new THREE.Color(0.72, 0.78, 0.42), clamp((s.pos.y - height * 0.55) / height, 0, 1) * 0.22);

    const cell = cells[(rng() * cells.length) | 0];
    const size = s.size * (0.78 + rng() * 0.5);
    addCard(
      b,
      s.pos,
      right,
      up,
      size,
      size * (0.85 + rng() * 0.35),
      cell,
      color,
      windWeight(s.pos, height, radius, s.depth),
      soft,
      0.72,
    );
  }
}

interface SpeciesConfig {
  height: number;
  radius: number;
  bark: BarkStyle;
  leafTint: THREE.Color;
  cells: AtlasCell[];
}

const CONFIG: Record<TreeKind, SpeciesConfig> = {
  pine: {
    height: 23,
    radius: 5.2,
    bark: { tint: new THREE.Color(1.429, 0.952, 0.619), crest: 0.21, crevice: 0.063, banding: 0 },
    leafTint: new THREE.Color(0.52, 0.68, 0.46),
    cells: [],
  },
  oak: {
    height: 17,
    radius: 7.6,
    bark: { tint: new THREE.Color(1.208, 1.013, 0.779), crest: 0.257, crevice: 0.063, banding: 0 },
    leafTint: new THREE.Color(0.74, 0.82, 0.52),
    cells: [],
  },
  birch: {
    height: 19,
    radius: 4.4,
    bark: { tint: new THREE.Color(1.024, 1.024, 0.952), crest: 0.840, crevice: 0.407, banding: 1 },
    leafTint: new THREE.Color(0.82, 0.88, 0.56),
    cells: [],
  },
  dead: {
    height: 13,
    radius: 5.4,
    bark: { tint: new THREE.Color(1.116, 1.012, 0.872), crest: 0.287, crevice: 0.090, banding: 0 },
    leafTint: new THREE.Color(0.4, 0.35, 0.25),
    cells: [],
  },
};

/** Grows one tree of the given kind at the given level of detail. */
export function buildTree(kind: TreeKind, atlas: LeafAtlas, lod: number, seed: number): BuiltTree {
  const cfg = CONFIG[kind];
  const rng = makeRng(seed);
  const bark = new GeoBuilder();
  const foliage = new GeoBuilder();
  const spots: FoliageSpot[] = [];

  const H = cfg.height;
  const R = cfg.radius;
  const simple = lod > 0;
  const colorOf = limbColorFn(cfg.bark, H, rng);
  const cells =
    kind === 'pine' ? atlas.needle : kind === 'birch' ? atlas.birch : atlas.broadleaf;

  const ridgeFor = (scale: number) => (t: number, angle: number): number =>
    (Math.sin(angle * 5.0 + t * 9.0) * 0.5 + Math.sin(angle * 11.0 - t * 4.0) * 0.28) * scale;

  const tube = (
    points: THREE.Vector3[],
    r0: number,
    r1: number,
    radial: number,
    depth: number,
    ridgeScale: number,
  ): void => {
    const radii = points.map((_, i) => {
      const t = i / (points.length - 1);
      return r0 + (r1 - r0) * Math.pow(t, 0.75);
    });
    const yAt = (t: number): number => points[Math.round(t * (points.length - 1))].y;
    addTube(
      bark,
      points,
      radii,
      radial,
      colorOf(yAt),
      (t) => windWeight(points[Math.round(t * (points.length - 1))], H, R, depth),
      [1, 0.14],
      ridgeFor(ridgeScale),
      depth > 0,
    );
  };

  if (kind === 'pine') {
    const trunkSegs = simple ? 5 : 9;
    const trunk = growLimb(new THREE.Vector3(0, -0.6, 0), new THREE.Vector3(0.02, 1, 0.01), H + 0.6, trunkSegs, 0, 0.03, rng);
    tube(trunk.points, 0.52, 0.05, simple ? 5 : 7, 0, 0.05);

    const whorls = simple ? 7 : 12;
    for (let w = 0; w < whorls; w++) {
      const t = 0.18 + (w / (whorls - 1)) * 0.8;
      const y = t * H;
      const spread = Math.pow(1 - t, 0.72);
      const len = 0.6 + spread * (R - 0.6);
      const count = simple ? 3 : 5;
      const base = w * 2.399 + rng() * 0.4;
      for (let i = 0; i < count; i++) {
        const a = base + (i / count) * Math.PI * 2;
        const droop = -0.05 - 0.34 * spread;
        const dir = new THREE.Vector3(Math.cos(a), droop, Math.sin(a)).normalize();
        const limb = growLimb(new THREE.Vector3(0, y, 0), dir, len, simple ? 2 : 3, 0.5, 0.06, rng);
        if (len > 1.5 && !simple) tube(limb.points, 0.12 * spread + 0.03, 0.02, 4, 1, 0.03);
        const cards = simple ? 2 : 3;
        for (let c = 0; c < cards; c++) {
          const ct = 0.34 + (c / cards) * 0.66;
          const p = limb.points[Math.min(limb.points.length - 1, Math.round(ct * (limb.points.length - 1)))].clone();
          p.x += (rng() - 0.5) * 0.4;
          p.z += (rng() - 0.5) * 0.4;
          p.y += (rng() - 0.5) * 0.3;
          spots.push({ pos: p, dir, size: 0.55 + len * 0.26, depth: 1 });
        }
      }
    }
    // A dense tuft at the leader so the crown does not read as a bald spike.
    for (let i = 0; i < (simple ? 3 : 6); i++) {
      spots.push({
        pos: new THREE.Vector3((rng() - 0.5) * 0.7, H * (0.9 + rng() * 0.12), (rng() - 0.5) * 0.7),
        dir: UP,
        size: 0.6,
        depth: 1,
      });
    }
  } else if (kind === 'birch') {
    const trunkSegs = simple ? 5 : 9;
    const trunk = growLimb(new THREE.Vector3(0, -0.6, 0), new THREE.Vector3(0.05, 1, 0.03), H + 0.6, trunkSegs, 0, 0.055, rng);
    tube(trunk.points, 0.40, 0.06, simple ? 5 : 8, 0, 0.028);

    const branches = simple ? 8 : 15;
    for (let i = 0; i < branches; i++) {
      const t = 0.34 + (i / branches) * 0.62 + rng() * 0.04;
      const anchor = trunk.points[Math.round(t * (trunk.points.length - 1))].clone();
      const a = rng() * Math.PI * 2;
      const up = 0.55 + rng() * 0.75;
      const dir = new THREE.Vector3(Math.cos(a), up, Math.sin(a)).normalize();
      const len = (1 - t) * R * 1.5 + 1.0;
      const limb = growLimb(anchor, dir, len, simple ? 2 : 3, -0.35, 0.09, rng);
      if (!simple) tube(limb.points, 0.11, 0.02, 4, 1, 0.02);
      const cards = simple ? 3 : 5;
      for (let c = 0; c < cards; c++) {
        const ct = 0.3 + (c / cards) * 0.7;
        const p = limb.points[Math.min(limb.points.length - 1, Math.round(ct * (limb.points.length - 1)))].clone();
        p.x += (rng() - 0.5) * 0.9;
        p.z += (rng() - 0.5) * 0.9;
        p.y += (rng() - 0.5) * 0.6;
        spots.push({ pos: p, dir, size: 0.85 + rng() * 0.5, depth: 1 });
      }
    }
  } else {
    // Oak and the dead tree share a forking hardwood skeleton.
    const isDead = kind === 'dead';
    const trunkTop = isDead ? 0.5 : 0.44;
    const trunkSegs = simple ? 4 : 6;
    const trunk = growLimb(
      new THREE.Vector3(0, -0.7, 0),
      new THREE.Vector3(rng() * 0.14 - 0.07, 1, rng() * 0.14 - 0.07),
      H * trunkTop + 0.7,
      trunkSegs,
      0,
      0.05,
      rng,
    );
    tube(trunk.points, isDead ? 0.72 : 0.92, isDead ? 0.42 : 0.56, simple ? 6 : 9, 0, 0.075);

    const top = trunk.points[trunk.points.length - 1];
    const primaries = simple ? 3 : 4;
    const maxDepth = simple ? 2 : 3;

    const fork = (from: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number): void => {
      const limb = growLimb(from, dir, len, depth >= maxDepth ? 2 : 3, 0.16 * depth, 0.08, rng);
      const radial = Math.max(3, (simple ? 5 : 7) - depth * 1);
      tube(limb.points, rad, rad * 0.5, radial, depth, 0.05 / (depth + 1));

      if (depth >= maxDepth) {
        if (isDead) return;
        const cards = simple ? 5 : 9;
        for (let c = 0; c < cards; c++) {
          const ct = 0.28 + rng() * 0.72;
          const p = limb.points[Math.min(limb.points.length - 1, Math.round(ct * (limb.points.length - 1)))].clone();
          p.x += (rng() - 0.5) * 1.9;
          p.z += (rng() - 0.5) * 1.9;
          p.y += (rng() - 0.5) * 1.4;
          spots.push({ pos: p, dir, size: 1.15 + rng() * 0.7, depth });
        }
        return;
      }

      const end = limb.points[limb.points.length - 1];
      const children = depth === 0 ? (simple ? 2 : 3) : 2;
      for (let i = 0; i < children; i++) {
        const a = rng() * Math.PI * 2;
        const spread = 0.5 + rng() * 0.55;
        const d = dir
          .clone()
          .multiplyScalar(1.1)
          .add(new THREE.Vector3(Math.cos(a) * spread, (isDead ? 0.15 : 0.42) + rng() * 0.3, Math.sin(a) * spread))
          .normalize();
        fork(end, d, len * (0.58 + rng() * 0.16), rad * 0.58, depth + 1);
      }
    };

    for (let i = 0; i < primaries; i++) {
      const a = (i / primaries) * Math.PI * 2 + rng() * 0.7;
      const spread = 0.62 + rng() * 0.4;
      const dir = new THREE.Vector3(Math.cos(a) * spread, 0.92 + rng() * 0.3, Math.sin(a) * spread).normalize();
      fork(top, dir, H * (isDead ? 0.3 : 0.34), isDead ? 0.3 : 0.4, 0);
    }

    if (isDead) {
      // Snapped stubs read as battle damage far better than tidy taper.
      for (let i = 0; i < 3; i++) {
        const t = 0.2 + rng() * 0.5;
        const anchor = trunk.points[Math.round(t * (trunk.points.length - 1))].clone();
        const a = rng() * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), 0.5 + rng() * 0.5, Math.sin(a)).normalize();
        const limb = growLimb(anchor, dir, 1.2 + rng() * 1.6, 2, 0.4, 0.1, rng);
        tube(limb.points, 0.22, 0.12, 4, 1, 0.05);
      }
    }
  }

  emitCards(foliage, spots, cells, cfg.leafTint, H, R, rng, kind === 'pine' ? 0.15 : 0.4);

  const barkGeo = bark.build(`${kind}-bark-${lod}`);
  const foliageGeo = foliage.triangleCount > 0 ? foliage.build(`${kind}-foliage-${lod}`) : null;

  const box = new THREE.Box3().setFromBufferAttribute(barkGeo.getAttribute('position') as THREE.BufferAttribute);
  if (foliageGeo) box.union(new THREE.Box3().setFromBufferAttribute(foliageGeo.getAttribute('position') as THREE.BufferAttribute));

  return {
    bark: barkGeo,
    foliage: foliageGeo,
    height: box.max.y,
    radius: Math.max(box.max.x, box.max.z, -box.min.x, -box.min.z),
  };
}

/* ------------------------------------------------------------ materials -- */

export interface FoliageWindOptions {
  /** World-unit tip displacement at full gust for a unit-scale object. */
  amplitude: number;
  /** Per-vertex flutter amplitude; 0 for solid wood. */
  flutter: number;
  /** Sub-surface strength for backlit leaves; 0 for opaque materials. */
  translucency: number;
}

const WIND_VERTEX_DECLS = /* glsl */ `
attribute float aWind;
uniform float uWindAmp;
uniform float uFlutter;
varying vec3 vFolWorld;
${WIND_GLSL}
`;

const WIND_VERTEX_BODY = /* glsl */ `
{
  #ifdef USE_INSTANCING
    vec3 iOrigin = (modelMatrix * instanceMatrix[3]).xyz;
    mat3 im = mat3(instanceMatrix);
    float isc = max(length(im[0]), 1e-4);
    mat3 irot = mat3(im[0] / isc, im[1] / isc, im[2] / isc);
  #else
    vec3 iOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    mat3 irot = mat3(1.0);
  #endif
  vec3 gustV = vsWind(iOrigin.xz, 2.4);
  vec3 bend = transpose(irot) * vec3(gustV.x, 0.0, gustV.y);
  float k = aWind * aWind;
  transformed += bend * k * uWindAmp;
  if (uFlutter > 0.0) {
    float ph = dot(position, vec3(0.83, 1.71, 0.47)) * 2.6 + iOrigin.x * 0.21 + iOrigin.z * 0.17;
    vec3 jit = vec3(sin(uWindTime * 5.9 + ph), sin(uWindTime * 4.3 + ph * 1.6) * 0.55, cos(uWindTime * 5.1 + ph * 0.7));
    transformed += jit * uFlutter * aWind * (0.3 + 0.7 * gustV.z);
  }
  // Bending pulls the crown down, not just sideways.
  transformed.y -= k * dot(bend, bend) * uWindAmp * 0.09;
  #ifdef USE_INSTANCING
    vFolWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vFolWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
}
`;

const FOLIAGE_FRAGMENT_DECLS = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uTranslucency;
varying vec3 vFolWorld;
`;

const FOLIAGE_TRANSLUCENCY = /* glsl */ `
  if (uTranslucency > 0.0) {
    vec3 V = normalize(cameraPosition - vFolWorld);
    float back = pow(clamp(dot(-normalize(uSunDir), V), 0.0, 1.0), 2.6);
    totalEmissiveRadiance += uSunColor * diffuseColor.rgb * back * uSunIntensity * uTranslucency;
  }
`;

/**
 * Adds the shared wind field and (for leaves) sub-surface scatter to any
 * standard material. Returns the uniform block so the caller can retune it.
 */
export function patchFoliageMaterial(
  material: THREE.Material,
  opts: FoliageWindOptions,
  cacheKey: string,
): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {
    uWindAmp: { value: opts.amplitude },
    uFlutter: { value: opts.flutter },
    uTranslucency: { value: opts.translucency },
    ...windUniforms,
    ...sunUniforms,
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_VERTEX_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERTEX_BODY}`);
    if (opts.translucency > 0) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FOLIAGE_FRAGMENT_DECLS}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FOLIAGE_TRANSLUCENCY}`);
    }
  };
  material.customProgramCacheKey = () => cacheKey;
  return uniforms;
}

/** Depth material that mirrors the wind displacement so shadows track the sway. */
export function makeFoliageDepthMaterial(
  map: THREE.Texture | null,
  alphaTest: number,
  opts: FoliageWindOptions,
  cacheKey: string,
): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (map) {
    mat.map = map;
    mat.alphaTest = alphaTest;
  }
  patchFoliageMaterial(mat, { ...opts, translucency: 0 }, cacheKey);
  return mat;
}

/* ------------------------------------------------------------ imposters -- */

export interface ImposterAtlas {
  texture: THREE.Texture;
  cells: AtlasCell[];
  /** Quad size per species: (width, height, vertical offset of the quad base). */
  size: THREE.Vector3[];
  dispose(): void;
}

/**
 * Renders each species' full mesh orthographically into one atlas so distant
 * trees can be a single camera-facing quad with the real silhouette. Baked flat
 * (albedo only) and lit at runtime, so imposters follow the sun like the
 * geometry they replace.
 */
export function bakeImposterAtlas(
  renderer: THREE.WebGLRenderer,
  species: TreeSpecies[],
  barkTex: THREE.Texture,
  leafTex: THREE.Texture,
  cellRes = 512,
): ImposterAtlas {
  const cols = 2;
  const rows = Math.ceil(species.length / cols);
  const rt = new THREE.WebGLRenderTarget(cellRes * cols, cellRes * rows, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    generateMipmaps: true,
  });
  rt.texture.name = 'tree-imposters';

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const flatBark = new THREE.MeshBasicMaterial({ map: barkTex, vertexColors: true });
  const flatLeaf = new THREE.MeshBasicMaterial({
    map: leafTex,
    vertexColors: true,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
  });
  // Force opaque alpha on everything that survives the alpha test, so the
  // imposter cut-out is crisp instead of inheriting the leaf texture's alpha.
  const opaqueA = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      'gl_FragColor = vec4( outgoingLight, 1.0 );',
    );
  };
  flatBark.onBeforeCompile = opaqueA;
  flatLeaf.onBeforeCompile = opaqueA;

  const cells: AtlasCell[] = [];
  const size: THREE.Vector3[] = [];

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;
  const prevViewport = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  const prevWind = windUniforms.uWindStrength.value;
  windUniforms.uWindStrength.value = 0;

  renderer.shadowMap.enabled = false;
  renderer.setRenderTarget(rt);
  // Clearing to a mid-canopy colour keeps mip-map bleed from darkening the
  // silhouette edge into a black fringe.
  renderer.setClearColor(0x3d4a26, 0);
  renderer.clear(true, true, false);
  renderer.autoClear = false;
  renderer.setScissorTest(true);

  for (let i = 0; i < species.length; i++) {
    const s = species[i];
    const built = s.lods[0];
    scene.clear();
    const barkMesh = new THREE.Mesh(built.bark, flatBark);
    flatBark.color = new THREE.Color(s.barkColor);
    scene.add(barkMesh);
    if (built.foliage) scene.add(new THREE.Mesh(built.foliage, flatLeaf));

    const halfW = built.radius * 1.06;
    const halfH = built.height * 0.52;
    const half = Math.max(halfW, halfH);
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.position.set(0, built.height * 0.5, 200);
    cam.lookAt(0, built.height * 0.5, 0);
    cam.updateProjectionMatrix();

    const cx = (i % cols) * cellRes;
    const cy = rt.height - (Math.floor(i / cols) + 1) * cellRes;
    renderer.setViewport(cx, cy, cellRes, cellRes);
    renderer.setScissor(cx, cy, cellRes, cellRes);
    renderer.render(scene, cam);

    const inset = 1 / (cellRes * 2);
    cells.push({
      u0: cx / rt.width + inset,
      v0: cy / rt.height + inset,
      u1: (cx + cellRes) / rt.width - inset,
      v1: (cy + cellRes) / rt.height - inset,
    });
    // The ortho box is centred on half the tree height, so the quad's base sits
    // that far below the geometry's origin.
    size.push(new THREE.Vector3(half * 2, half * 2, built.height * 0.5 - half));
  }

  renderer.setScissorTest(false);
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.shadowMap.enabled = prevShadow;
  renderer.setViewport(prevViewport);
  windUniforms.uWindStrength.value = prevWind;
  flatBark.dispose();
  flatLeaf.dispose();

  return { texture: rt.texture, cells, size, dispose: () => rt.dispose() };
}

const IMPOSTER_VERTEX_DECLS = /* glsl */ `
uniform vec4 uCell;
uniform vec3 uSize;   // width, height, vertical offset of the quad's base
varying vec2 vImpUv;
vec3 gImpNormal;
vec3 gImpRight;
`;

const IMPOSTER_NORMAL = /* glsl */ `
  gImpRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 camFwd = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  // Cylindrical fake normal: enough curvature for the canopy to shade like a
  // mass rather than a flat sheet.
  gImpNormal = normalize(camFwd * 0.68 + gImpRight * position.x * 1.35 + vec3(0.0, 0.42, 0.0));
  vec3 objectNormal = gImpNormal;
`;

const IMPOSTER_POSITION = /* glsl */ `
  vec3 iOrigin = instanceMatrix[3].xyz;
  float isc = length(instanceMatrix[0].xyz);
  vec3 transformed = iOrigin
    + gImpRight * (position.x * uSize.x * isc)
    + vec3(0.0, ((position.y + 0.5) * uSize.y + uSize.z) * isc, 0.0);
  vImpUv = uCell.xy + (position.xy + 0.5) * uCell.zw;
`;

/**
 * Camera-facing billboard, sized from the instance matrix so distant trees keep
 * the scale variation of their full-geometry counterparts. Lit at runtime, so a
 * forest of imposters still turns with the sun.
 */
export function makeImposterMaterial(
  atlas: THREE.Texture,
  cell: AtlasCell,
  size: THREE.Vector3,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    alphaTest: 0.5,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const uniforms: Record<string, THREE.IUniform> = {
    uCell: { value: new THREE.Vector4(cell.u0, cell.v0, cell.u1 - cell.u0, cell.v1 - cell.v0) },
    uSize: { value: size },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMPOSTER_VERTEX_DECLS}`)
      .replace('#include <beginnormal_vertex>', IMPOSTER_NORMAL)
      .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalize((viewMatrix * vec4(objectNormal, 0.0)).xyz);')
      .replace('#include <begin_vertex>', IMPOSTER_POSITION);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vImpUv;')
      .replace(
        '#include <map_fragment>',
        'diffuseColor *= texture2D( map, vImpUv );',
      );
  };
  mat.customProgramCacheKey = () => 'verdium-imposter';
  return mat;
}
