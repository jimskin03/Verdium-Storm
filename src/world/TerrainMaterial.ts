import * as THREE from 'three';
import { TERRAIN_NOISE_GLSL } from '@/shaders/terrain/noise.glsl';
import { TERRAIN_LAYERS_GLSL } from '@/shaders/terrain/layers.glsl';
import {
  TERRAIN_FRAGMENT_MAIN,
  TERRAIN_FRAGMENT_PARS,
  TERRAIN_VERTEX_MAIN,
  TERRAIN_VERTEX_PARS,
} from '@/shaders/terrain/surface.glsl';
import type { TerrainFieldSet, TerrainTextureSet } from './TerrainTextures';
import { FIELD_FAR_EXTENT, FIELD_NEAR_EXTENT, FIELD_NEAR_LIMIT } from './TerrainTextures';
import { WATER_LEVEL } from './Heightfield';

export interface TerrainMaterialOptions {
  fields: TerrainFieldSet;
  textures: TerrainTextureSet;
  /** Vertices per node edge; must match the grid the renderer builds. */
  gridRes: number;
  /** How far a node's skirt hangs below the surface, in node-relative units. */
  skirtDepth: number;
  /** Enables parallax occlusion on rock. */
  pom: boolean;
  anisotropy: number;
}

export interface TerrainMaterialHandle {
  material: THREE.MeshStandardMaterial;
  /** Depth material so shadow casting matches the displaced surface. */
  depthMaterial: THREE.Material;
  /** Must be called each frame with the camera position. */
  setCamera(position: THREE.Vector3): void;
  dispose(): void;
}

/**
 * Builds the terrain's material by injecting the CDLOD displacement and splat
 * shaders into a MeshStandardMaterial.
 *
 * Going through MeshStandardMaterial rather than a raw ShaderMaterial is
 * deliberate: the terrain then inherits three's full lighting path — shadow
 * cascades, image-based lighting, fog — for free, and stays consistent with
 * every other surface in the scene as the lighting stream evolves.
 */
export function createTerrainMaterial(opts: TerrainMaterialOptions): TerrainMaterialHandle {
  const { fields, textures, gridRes, skirtDepth, pom, anisotropy } = opts;

  for (const tex of [textures.albedo, textures.surface]) {
    tex.anisotropy = anisotropy;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  }
  textures.macro.wrapS = textures.macro.wrapT = THREE.RepeatWrapping;

  // Maps world XZ into the [0,1] UV of each field layer.
  const fieldMap = new THREE.Vector4(
    0.5 / FIELD_NEAR_EXTENT, 0.5,
    0.5 / FIELD_FAR_EXTENT, 0.5,
  );

  const uniforms = {
    uTerrainHeight: { value: fields.height },
    uTerrainNormal: { value: fields.normal },
    uLayerAlbedo: { value: textures.albedo },
    uLayerSurface: { value: textures.surface },
    uMacro: { value: textures.macro },
    uFieldMap: { value: fieldMap },
    uNearLimit: { value: FIELD_NEAR_LIMIT },
    uTerrainCam: { value: new THREE.Vector3() },
    uGridRes: { value: gridRes },
    uSkirtDepth: { value: skirtDepth },
    uMacroScale: { value: 1 / (FIELD_NEAR_EXTENT * 2) },
    // Ground tiles every ~6 units, the de-tiling octave every ~37, rock ~4.
    uLayerScale: { value: new THREE.Vector3(6.0, 37.0, 4.0) },
    uDetailNormal: { value: new THREE.Vector2(1.0, 1.35) },
    uWaterLevel: { value: WATER_LEVEL },
    // Only ~0.5% of the map clears y=130, so a snow line there was unreachable.
    uSnowLine: { value: 104 },
    uPomScale: { value: pom ? 1 : 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_NOISE_GLSL}\n${TERRAIN_VERTEX_PARS}`)
      // beginnormal_vertex runs before begin_vertex, so the position solve lands
      // here and begin_vertex just consumes its result.
      .replace('#include <beginnormal_vertex>', TERRAIN_VERTEX_MAIN)
      .replace('#include <begin_vertex>', 'vec3 transformed = vsTransformedPos;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${TERRAIN_NOISE_GLSL}\n${TERRAIN_LAYERS_GLSL}\n${TERRAIN_FRAGMENT_PARS}`,
      )
      .replace('#include <map_fragment>', TERRAIN_FRAGMENT_MAIN)
      // The splat produced tangent-space-free world normals plus its own
      // roughness and AO; route them into the standard lighting inputs.
      .replace(
        '#include <normal_fragment_maps>',
        'normal = normalize(vsSplatNormal);',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = roughness * vsSplatRough;',
      )
      .replace(
        '#include <aomap_fragment>',
        'reflectedLight.indirectDiffuse *= vsSplatAO;\nreflectedLight.indirectSpecular *= vsSplatAO;',
      );
  };

  // Distinct cache key so this program is never shared with a plain standard
  // material that happens to have the same feature flags.
  material.customProgramCacheKey = () => `verdium-terrain-${pom ? 'pom' : 'flat'}`;

  // Shadows must be cast from the displaced surface, so the depth pass needs the
  // same vertex solve. Only the vertex half is required.
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_NOISE_GLSL}\n${TERRAIN_VERTEX_PARS}`)
      .replace('#include <beginnormal_vertex>', TERRAIN_VERTEX_MAIN)
      .replace('#include <begin_vertex>', 'vec3 transformed = vsTransformedPos;');
    // MeshDepthMaterial has no beginnormal_vertex chunk, so inject before
    // begin_vertex when the first replace found nothing to do.
    if (!shader.vertexShader.includes('vsTransformedPos = ')) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `${TERRAIN_VERTEX_MAIN}\nvec3 transformed = vsTransformedPos;`,
      );
    }
  };
  depthMaterial.customProgramCacheKey = () => 'verdium-terrain-depth';

  return {
    material,
    depthMaterial,
    setCamera(position) {
      uniforms.uTerrainCam.value.copy(position);
    },
    dispose() {
      material.dispose();
      depthMaterial.dispose();
    },
  };
}
