import * as THREE from 'three';
import type { QualitySettings } from '@/engine/System';
import { TEAM_COLORS, type DamageState, type Team } from '@/entities/Types';
import { SYNTH_FRAG, SYNTH_VERT } from '@/shaders/entity/synth.glsl';
import {
  ENTITY_AO_FRAG,
  ENTITY_COLOR_FRAG,
  ENTITY_COLOR_VERT,
  ENTITY_EMISSIVE_FRAG,
  ENTITY_FRAG_PARS,
  ENTITY_MAP_FRAG,
  ENTITY_METAL_FRAG,
  ENTITY_NORMAL_FRAG,
  ENTITY_ROUGH_FRAG,
  ENTITY_VERT_PARS,
} from '@/shaders/entity/surface.glsl';

interface LayerMaps {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
}

const DAMAGE_WEAR: Record<DamageState, number> = { pristine: 0, damaged: 0.55, critical: 1 };

/**
 * Owns the synthesised texture set, the fallback sky probe and the small family
 * of shared materials every entity mesh draws with.
 *
 * There is one material per (team × damage state) — six in total for the whole
 * game — because everything else that would normally force a material split is
 * carried per-vertex. That is what keeps a hundred-unit battle inside a sane
 * draw-call budget.
 */
export class EntityMaterials {
  private renderer: THREE.WebGLRenderer;
  private layerA!: LayerMaps;
  private layerB!: LayerMaps;

  /** Indexed [team][damageState]. */
  private variants = new Map<string, THREE.MeshStandardMaterial>();
  private all: THREE.MeshStandardMaterial[] = [];
  private shared = {
    uWear: { value: 0 },
    uNormalScale: { value: 1.15 },
    uEmissive: { value: 1 },
  };

  /** Cheap procedural sky probe so metal has something to reflect before the
   *  lighting stream publishes a real IBL. Dropped the moment one appears. */
  private fallbackEnv: THREE.Texture | null = null;
  private envAdopted = false;

  /** Holographic material used for the structure build-up effect. */
  readonly hologram: THREE.ShaderMaterial;
  /** Additive material for muzzle glow discs and damage sparks. */
  readonly glow: THREE.MeshBasicMaterial;

  constructor(renderer: THREE.WebGLRenderer, quality: QualitySettings) {
    this.renderer = renderer;
    const size = quality.tier === 'low' ? 256 : quality.tier === 'medium' ? 384 : 512;
    this.synthesise(size);
    this.fallbackEnv = this.buildFallbackEnv();

    this.hologram = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0x6fd8ff) },
        uTime: { value: 0 },
        uProgress: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vLocal;
        varying vec3 vNrm;
        void main() {
          vLocal = position;
          vNrm = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uProgress;
        varying vec3 vLocal;
        varying vec3 vNrm;
        void main() {
          float scan = smoothstep(0.45, 0.5, fract(vLocal.y * 1.6 - uTime * 1.4));
          float grid = smoothstep(0.9, 1.0, max(
            abs(fract(vLocal.x * 0.9) - 0.5) * 2.0,
            abs(fract(vLocal.z * 0.9) - 0.5) * 2.0));
          float rim = pow(1.0 - abs(vNrm.z), 2.0);
          float band = smoothstep(uProgress + 0.10, uProgress - 0.02, vLocal.y * 0.06 + 0.5);
          float a = (0.10 + scan * 0.30 + grid * 0.35 + rim * 0.45) * band;
          gl_FragColor = vec4(uColor * (0.6 + a), a * 0.9);
        }
      `,
    });

    this.glow = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  // ------------------------------------------------------------- synthesis

  private synthesise(size: number): void {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SYNTH_VERT,
      fragmentShader: SYNTH_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uLayer: { value: 0 },
        uOutput: { value: 0 },
        uTexel: { value: 1 / size },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    scene.add(quad);

    const prevTarget = this.renderer.getRenderTarget();
    const make = (layer: number, output: number, srgb: boolean): THREE.Texture => {
      const rt = new THREE.WebGLRenderTarget(size, size, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      });
      rt.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      mat.uniforms.uLayer.value = layer;
      mat.uniforms.uOutput.value = output;
      this.renderer.setRenderTarget(rt);
      this.renderer.render(scene, cam);
      return rt.texture;
    };

    this.layerA = { albedo: make(0, 0, true), normal: make(0, 1, false), orm: make(0, 2, false) };
    this.layerB = { albedo: make(1, 0, true), normal: make(1, 1, false), orm: make(1, 2, false) };

    this.renderer.setRenderTarget(prevTarget);
    quad.geometry.dispose();
    mat.dispose();
  }

  /**
   * A three-band sky rendered to a cube and prefiltered. Small (64px) because
   * it only has to give metal a plausible gradient to reflect; the atmosphere
   * stream's real probe replaces it as soon as it exists.
   */
  private buildFallbackEnv(): THREE.Texture | null {
    try {
      const scene = new THREE.Scene();
      const geo = new THREE.SphereGeometry(10, 24, 16);
      const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: { uSun: { value: new THREE.Vector3(0.42, 0.62, 0.35).normalize() } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          varying vec3 vD;
          uniform vec3 uSun;
          void main() {
            float h = clamp(vD.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 sky = mix(vec3(0.42, 0.47, 0.44), vec3(0.30, 0.52, 0.90), smoothstep(0.5, 1.0, h));
            sky = mix(vec3(0.16, 0.15, 0.13), sky, smoothstep(0.34, 0.55, h));
            float s = pow(max(dot(normalize(vD), uSun), 0.0), 220.0);
            gl_FragColor = vec4(sky * 1.6 + vec3(6.0, 4.6, 3.2) * s, 1.0);
          }
        `,
      });
      scene.add(new THREE.Mesh(geo, mat));
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const target = pmrem.fromScene(scene, 0.04, 0.1, 60);
      pmrem.dispose();
      geo.dispose();
      mat.dispose();
      return target.texture;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- materials

  material(team: Team, damage: DamageState): THREE.MeshStandardMaterial {
    const key = `${team}:${damage}`;
    const found = this.variants.get(key);
    if (found) return found;

    const teamColor = new THREE.Color(TEAM_COLORS[team]).convertSRGBToLinear();
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
      vertexColors: true,
      envMapIntensity: 1.05,
    });
    m.envMap = this.fallbackEnv;

    const uniforms = {
      tAlbA: { value: this.layerA.albedo },
      tNrmA: { value: this.layerA.normal },
      tOrmA: { value: this.layerA.orm },
      tAlbB: { value: this.layerB.albedo },
      tNrmB: { value: this.layerB.normal },
      tOrmB: { value: this.layerB.orm },
      uTeamColor: { value: teamColor },
      uWear: { value: DAMAGE_WEAR[damage] },
      uNormalScale: this.shared.uNormalScale,
      uEmissive: this.shared.uEmissive,
    };

    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = ENTITY_VERT_PARS + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', ENTITY_COLOR_VERT);
      shader.fragmentShader = ENTITY_FRAG_PARS + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_fragment>', ENTITY_MAP_FRAG)
        .replace('#include <color_fragment>', ENTITY_COLOR_FRAG)
        .replace('#include <roughnessmap_fragment>', ENTITY_ROUGH_FRAG)
        .replace('#include <metalnessmap_fragment>', ENTITY_METAL_FRAG)
        .replace('#include <normal_fragment_maps>', ENTITY_NORMAL_FRAG)
        .replace('#include <aomap_fragment>', ENTITY_AO_FRAG)
        .replace('#include <emissivemap_fragment>', ENTITY_EMISSIVE_FRAG);
    };
    m.customProgramCacheKey = () => 'verdium-entity-v1';

    this.variants.set(key, m);
    this.all.push(m);
    return m;
  }

  /**
   * Hands presentation of reflections over to the lighting stream the instant
   * it publishes a scene environment, so entities match the world probe rather
   * than the boot-time stand-in.
   */
  syncEnvironment(scene: THREE.Scene): void {
    if (this.envAdopted) return;
    if (!scene.environment) return;
    this.envAdopted = true;
    for (const m of this.all) {
      m.envMap = null;
      m.needsUpdate = true;
    }
    this.fallbackEnv?.dispose();
    this.fallbackEnv = null;
  }

  update(elapsed: number): void {
    (this.hologram.uniforms.uTime as { value: number }).value = elapsed;
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    this.hologram.dispose();
    this.glow.dispose();
    for (const l of [this.layerA, this.layerB]) {
      l.albedo.dispose();
      l.normal.dispose();
      l.orm.dispose();
    }
    this.fallbackEnv?.dispose();
  }
}
