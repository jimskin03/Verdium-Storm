import * as THREE from 'three';
import { HALF_WORLD } from '@/world/Heightfield';
import type { FloorField } from './FloorField';

/**
 * The wet-sand strip.
 *
 * A shoreline only reads correctly when the *land* responds to the water: sand
 * that the swash has just covered is darker, glossier and holds a little foam
 * residue. The terrain material belongs to another stream, so this is a thin
 * conforming overlay built from the same heightfield samples the terrain mesh
 * uses — identical vertex positions, lifted a hair along the normal — which
 * composites over the terrain instead of replacing it.
 *
 * It samples the same pre-water scene colour the refraction uses, so it can
 * both darken and add a specular sheen; a plain multiply blend could only ever
 * darken.
 */

/** Band extents in metres of horizontal distance from the waterline. */
const BAND_INLAND = 26;
const BAND_SEAWARD = 12;
/** Lift along the surface normal that keeps the overlay off the terrain. */
const LIFT = 0.14;

export interface ShoreBuild {
  geometry: THREE.BufferGeometry;
  vertexCount: number;
  triangleCount: number;
}

/**
 * Extracts the shoreline band from the baked field as a conforming mesh.
 * `stride` steps the grid; 1 matches the terrain tessellation exactly.
 */
export function buildShoreGeometry(field: FloorField, stride: number): ShoreBuild {
  const { res, step, half, heights, shore, gradX, gradZ } = field;

  // Only the playable square has terrain under it; the disc handles the rest.
  const lo = Math.ceil((half - HALF_WORLD) / step);
  const hi = res - 1 - lo;

  const inBand = (idx: number): boolean => shore[idx] > -BAND_SEAWARD && shore[idx] < BAND_INLAND;

  const remap = new Int32Array(res * res).fill(-1);
  const positions: number[] = [];
  const normals: number[] = [];
  const shoreAttr: number[] = [];
  const slopeAttr: number[] = [];
  const indices: number[] = [];

  const vertexFor = (i: number, j: number): number => {
    const idx = j * res + i;
    const existing = remap[idx];
    if (existing >= 0) return existing;
    const gx = gradX[idx];
    const gz = gradZ[idx];
    const inv = 1 / Math.hypot(gx, 1, gz);
    const nx = -gx * inv;
    const ny = inv;
    const nz = -gz * inv;
    const v = positions.length / 3;
    positions.push(
      -half + i * step + nx * LIFT,
      heights[idx] + ny * LIFT,
      -half + j * step + nz * LIFT,
    );
    normals.push(nx, ny, nz);
    shoreAttr.push(shore[idx]);
    slopeAttr.push(Math.hypot(gx, gz));
    remap[idx] = v;
    return v;
  };

  for (let j = lo; j + stride <= hi; j += stride) {
    for (let i = lo; i + stride <= hi; i += stride) {
      const a = j * res + i;
      const b = j * res + i + stride;
      const c = (j + stride) * res + i;
      const d = (j + stride) * res + i + stride;
      if (!inBand(a) && !inBand(b) && !inBand(c) && !inBand(d)) continue;
      const va = vertexFor(i, j);
      const vb = vertexFor(i + stride, j);
      const vc = vertexFor(i, j + stride);
      const vd = vertexFor(i + stride, j + stride);
      indices.push(va, vc, vb, vb, vc, vd);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aShore', new THREE.Float32BufferAttribute(shoreAttr, 1));
  geometry.setAttribute('aSlope', new THREE.Float32BufferAttribute(slopeAttr, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return {
    geometry,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** Counts band quads without building anything, so stride can be chosen first. */
export function countShoreQuads(field: FloorField, stride: number): number {
  const { res, step, half, shore } = field;
  const lo = Math.ceil((half - HALF_WORLD) / step);
  const hi = res - 1 - lo;
  let count = 0;
  for (let j = lo; j + stride <= hi; j += stride) {
    for (let i = lo; i + stride <= hi; i += stride) {
      const a = shore[j * res + i];
      const d = shore[(j + stride) * res + i + stride];
      if ((a > -BAND_SEAWARD && a < BAND_INLAND) || (d > -BAND_SEAWARD && d < BAND_INLAND)) count++;
    }
  }
  return count;
}

const SHORE_VERTEX = /* glsl */ `
attribute float aShore;
attribute float aSlope;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec4 vClip;
varying float vShore;
varying float vSlope;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalMatrix * normal;
  vShore = aShore;
  vSlope = aSlope;
  vClip = projectionMatrix * viewMatrix * world;
  gl_Position = vClip;
}
`;

const SHORE_FRAGMENT = /* glsl */ `
uniform sampler2D uSceneColor;
uniform sampler2D uDetail;
uniform sampler2D uFoam;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
/** Multiplier applied to the dry ground, not a colour: wet sand is the same
 *  sand at roughly half the albedo with a touch more saturation. */
uniform vec3 uWetTint;
uniform vec3 uFoamColor;
uniform float uSwashRange;
uniform float uWetWidth;
uniform float uStrength;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec4 vClip;
varying float vShore;
varying float vSlope;

float sat(float x) { return clamp(x, 0.0, 1.0); }

void main() {
  vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
  vec3 scene = texture2D(uSceneColor, suv).rgb;

  vec3 N = normalize(vNormal);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(cameraPosition - vWorldPos);

  // Identical swash phase to the water surface, so the wet line and the foam
  // line are the same line rather than two effects drifting past each other.
  float shorePhase = uTime * 0.55
    - vShore * 0.045
    + dot(vWorldPos.xz, vec2(0.011, -0.008))
    + texture2D(uDetail, vWorldPos.xz * 0.0021).b * 6.2;
  float swash = sin(shorePhase);
  float runup = swash * uSwashRange;
  float sd = vShore - runup;

  // A band that stays damp between swashes, plus the sharp edge of the sheet
  // of water currently running up the sand.
  float damp = 1.0 - smoothstep(0.0, uWetWidth, vShore - uSwashRange * 0.4);
  float sheet = 1.0 - smoothstep(-1.2, 2.4, sd);
  float wet = max(damp * 0.78, sheet);

  // Cliffs do not hold a wet band; only shallow sand does.
  wet *= 1.0 - smoothstep(0.5, 1.15, vSlope);
  // Break the band up so it is not a clean stripe around the lake.
  wet *= 0.72 + 0.56 * texture2D(uDetail, vWorldPos.xz * 0.013).b;
  wet = sat(wet) * uStrength;

  vec3 wetCol = scene * uWetTint;

  // Wet sand is glossy: a broad low-roughness lobe over the terrain normal.
  vec3 H = normalize(L + V);
  float NoH = sat(dot(N, H));
  float NoL = sat(dot(N, L));
  float NoV = sat(dot(N, V));
  float rough = 0.30;
  float a2 = rough * rough * rough * rough;
  float dgg = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / max(1e-6, 3.14159265 * dgg * dgg);
  float fres = 0.03 + 0.32 * pow(1.0 - NoV, 5.0);
  wetCol += uSunColor * uSunIntensity * min(D * fres * NoL * 0.9, 6.0);

  // Residue: foam that the last swash left stranded, drying out unevenly.
  vec4 ft = texture2D(uFoam, vWorldPos.xz * 0.09 + vec2(0.13, 0.61));
  float residueAmount = sat(sheet * 1.1 - sat(sd * 0.22)) * sat(swash * 0.5 + 0.5);
  float residue = smoothstep(1.0 - residueAmount - 0.10, 1.0 - residueAmount + 0.16, ft.r * 0.7 + ft.a * 0.3);
  residue *= sat(1.0 - smoothstep(0.45, 0.95, vSlope));
  vec3 foamLit = uFoamColor * (0.34 + 0.66 * sat(L.y * 0.6 + 0.5)) * (uSunColor * 0.5 + 0.5);
  wetCol = mix(wetCol, foamLit * uSunIntensity * 0.24, residue * 0.85);

  float alpha = sat(wet + residue * 0.9);
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(wetCol, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface ShoreMaterialOptions {
  detail: THREE.Texture;
  foam: THREE.Texture;
}

export function createShoreMaterial(opts: ShoreMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSceneColor: { value: null },
      uDetail: { value: opts.detail },
      uFoam: { value: opts.foam },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.42, 0.62, 0.35).normalize() },
      uSunColor: { value: new THREE.Color(0xffe6c2) },
      uSunIntensity: { value: 1 },
      uWetTint: { value: new THREE.Vector3(0.50, 0.45, 0.41) },
      uFoamColor: { value: new THREE.Color(0xe6f2f4) },
      uSwashRange: { value: 4.2 },
      uWetWidth: { value: 9.0 },
      uStrength: { value: 1.0 },
    },
    vertexShader: SHORE_VERTEX,
    fragmentShader: SHORE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
    lights: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}
