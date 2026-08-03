import * as THREE from 'three';
import { HALF_WORLD, WORLD_SIZE, heightAt } from '@/world/Heightfield';

/**
 * Two-team fog of war.
 *
 * Each team owns an `explored` grid (sticky) and a `visible` grid (recomputed
 * from unit and structure sight radii several times a second). The player's
 * pair drives a scene overlay: a mesh that follows the terrain surface and
 * paints unexplored ground almost black and explored-but-unseen ground dim.
 *
 * The overlay is a separate mesh precisely so the terrain material — owned by
 * another stream — is never touched.
 */

export const FOG_RES = 128;
const FOG_CELL = WORLD_SIZE / FOG_RES;
const FOG_CELLS = FOG_RES * FOG_RES;

const SHROUD_ALPHA = 0.88;
const DIM_ALPHA = 0.46;

const vertexShader = /* glsl */ `
  varying vec2 vFogUv;
  uniform float uHalfWorld;
  uniform float uWorldSize;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vFogUv = (world.xz + uHalfWorld) / uWorldSize;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vFogUv;
  uniform sampler2D uFog;
  uniform vec3 uShroud;
  uniform float uShroudAlpha;
  uniform float uDimAlpha;
  void main() {
    vec2 f = texture2D(uFog, vFogUv).rg;
    float explored = f.r;
    float visible = f.g;
    float a = mix(uShroudAlpha, mix(uDimAlpha, 0.0, visible), explored);
    if (a < 0.004) discard;
    gl_FragColor = vec4(uShroud, a);
  }
`;

export class FogOfWar {
  readonly resolution = FOG_RES;
  readonly explored: [Uint8Array, Uint8Array] = [new Uint8Array(FOG_CELLS), new Uint8Array(FOG_CELLS)];
  readonly visible: [Uint8Array, Uint8Array] = [new Uint8Array(FOG_CELLS), new Uint8Array(FOG_CELLS)];

  /** RG bytes uploaded to the GPU; smoothed so reveals do not pop. */
  private readonly display = new Uint8Array(FOG_CELLS * 2);
  private texture: THREE.DataTexture;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  /** Set true by the sim after the grids change; drives the smoothing pass. */
  private dirty = true;
  enabled = true;

  constructor(parent: THREE.Object3D, public viewTeam: number) {
    this.texture = new THREE.DataTexture(this.display, FOG_RES, FOG_RES, THREE.RGFormat);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    this.geometry = this.buildSurface();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFog: { value: this.texture },
        uShroud: { value: new THREE.Color(0x05070c) },
        uShroudAlpha: { value: SHROUD_ALPHA },
        uDimAlpha: { value: DIM_ALPHA },
        uHalfWorld: { value: HALF_WORLD },
        uWorldSize: { value: WORLD_SIZE },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'fog-of-war';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    parent.add(this.mesh);
  }

  /**
   * A terrain-following sheet. Each vertex takes the maximum of a small
   * neighbourhood so the sheet never dips below the rendered surface and lets
   * bright terrain poke through the shroud.
   */
  private buildSurface(): THREE.BufferGeometry {
    const seg = 144;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE + 8, WORLD_SIZE + 8, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const step = WORLD_SIZE / seg;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let h = heightAt(x, z);
      const o = step * 0.5;
      h = Math.max(h, heightAt(x - o, z - o), heightAt(x + o, z - o), heightAt(x - o, z + o), heightAt(x + o, z + o));
      pos.setY(i, h + 0.9);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    return geo;
  }

  static index(x: number, z: number): number {
    let i = Math.floor((x + HALF_WORLD) / FOG_CELL);
    let j = Math.floor((z + HALF_WORLD) / FOG_CELL);
    if (i < 0) i = 0; else if (i >= FOG_RES) i = FOG_RES - 1;
    if (j < 0) j = 0; else if (j >= FOG_RES) j = FOG_RES - 1;
    return j * FOG_RES + i;
  }

  clearVisible(team: number): void {
    this.visible[team].fill(0);
  }

  /** Marks a circular area seen by `team`. */
  reveal(team: number, x: number, z: number, radius: number): void {
    const vis = this.visible[team];
    const exp = this.explored[team];
    const r = radius / FOG_CELL;
    const ci = (x + HALF_WORLD) / FOG_CELL;
    const cj = (z + HALF_WORLD) / FOG_CELL;
    let i0 = Math.floor(ci - r);
    let i1 = Math.ceil(ci + r);
    let j0 = Math.floor(cj - r);
    let j1 = Math.ceil(cj + r);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= FOG_RES) i1 = FOG_RES - 1;
    if (j1 >= FOG_RES) j1 = FOG_RES - 1;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dz = j + 0.5 - cj;
      const row = j * FOG_RES;
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - ci;
        if (dx * dx + dz * dz > r2) continue;
        const k = row + i;
        vis[k] = 1;
        exp[k] = 1;
      }
    }
    this.dirty = true;
  }

  isVisible(team: number, x: number, z: number): boolean {
    return this.visible[team][FogOfWar.index(x, z)] === 1;
  }

  isExplored(team: number, x: number, z: number): boolean {
    return this.explored[team][FogOfWar.index(x, z)] === 1;
  }

  /** Smooths the display grid toward the authoritative grids and uploads it. */
  updateVisuals(dt: number): void {
    if (!this.enabled) return;
    const exp = this.explored[this.viewTeam];
    const vis = this.visible[this.viewTeam];
    const d = this.display;
    // Reveal snaps on, conceal fades — matches how RTS fog reads in motion.
    const fade = 1 - Math.exp(-dt * 6);
    let changed = false;
    for (let k = 0; k < FOG_CELLS; k++) {
      const e = exp[k] ? 255 : 0;
      const o = k * 2;
      if (d[o] !== e) {
        d[o] = e;
        changed = true;
      }
      const v = vis[k] ? 255 : 0;
      const cur = d[o + 1];
      if (cur !== v) {
        const next = v > cur ? v : Math.round(cur + (v - cur) * fade);
        if (next !== cur) {
          d[o + 1] = next;
          changed = true;
        }
      }
    }
    if (changed || this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  grids(): { explored: Uint8Array; visible: Uint8Array; resolution: number } {
    return { explored: this.explored[this.viewTeam], visible: this.visible[this.viewTeam], resolution: FOG_RES };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh.visible = on;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.mesh.removeFromParent();
  }
}
