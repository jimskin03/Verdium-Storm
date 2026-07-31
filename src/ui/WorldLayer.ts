import * as THREE from 'three';
import type { Team } from '@/entities/Types';
import { div, setClass } from './dom';
import type { HealthTarget, WorldProbe } from './WorldProbe';

/**
 * The in-world overlay: floating health bars and selection reticles.
 *
 * DOM rather than sprites, deliberately — these elements must stay pixel-crisp
 * and unaffected by the post chain's bloom and grade, exactly like the bars in
 * the reference games. The cost is one transform write per visible subject, so
 * the layer is budgeted: subjects are distance-sorted, the nearest `MAX_BARS`
 * are drawn and the rest are dropped rather than queued.
 *
 * Nodes are pooled and keyed by entity id, so a bar keeps its identity between
 * frames and CSS transitions on the fill actually mean something.
 */

const MAX_BARS = 72;
/** Beyond this the bars would be sub-pixel noise, so they are not drawn. */
const FAR_CULL = 620;

interface Bar {
  root: HTMLDivElement;
  fill: HTMLElement;
  band: string;
  team: Team;
  used: boolean;
}

interface Reticle {
  root: HTMLDivElement;
  used: boolean;
}

export class WorldLayer {
  readonly root: HTMLDivElement;

  private bars = new Map<number, Bar>();
  private reticles = new Map<number, Reticle>();
  private barPool: Bar[] = [];
  private reticlePool: Reticle[] = [];
  private width = 1920;
  private height = 1080;

  private readonly scratch = new THREE.Vector3();
  private readonly sorted: Array<{ t: HealthTarget; dist: number }> = [];

  /**
   * @param decals draw selection reticles here. Off when the simulation already
   * projects its own selection rings into the scene, which look better because
   * they follow the ground.
   */
  constructor(parent: HTMLElement, private decals: boolean) {
    this.root = div('vs-world', parent);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  setDecals(on: boolean): void {
    this.decals = on;
    if (!on) {
      for (const r of this.reticles.values()) r.root.style.display = 'none';
    }
  }

  update(camera: THREE.PerspectiveCamera, probe: WorldProbe, playerTeam: Team): void {
    const targets = probe.healthTargets?.();
    if (!targets || targets.length === 0) {
      this.hideAll();
      return;
    }

    this.sorted.length = 0;
    for (const t of targets) {
      const dist = camera.position.distanceTo(t.position);
      if (dist > FAR_CULL) continue;
      this.sorted.push({ t, dist });
    }
    this.sorted.sort((a, b) => a.dist - b.dist);
    if (this.sorted.length > MAX_BARS) this.sorted.length = MAX_BARS;

    for (const bar of this.bars.values()) bar.used = false;
    for (const r of this.reticles.values()) r.used = false;

    for (const { t, dist } of this.sorted) {
      const v = this.scratch.set(t.position.x, t.position.y + t.height, t.position.z).project(camera);
      if (v.z > 1 || v.z < -1) continue;
      const x = (v.x * 0.5 + 0.5) * this.width;
      const y = (-v.y * 0.5 + 0.5) * this.height;
      if (x < -60 || y < -40 || x > this.width + 60 || y > this.height + 40) continue;

      // Bars shrink with distance but never below legibility.
      const scale = clamp(190 / Math.max(1, dist), 0.62, 1.35);
      const ratio = t.maxHp > 0 ? clamp(t.hp / t.maxHp, 0, 1) : 0;
      const bar = this.bar(t.id);
      bar.used = true;
      bar.root.style.display = '';
      bar.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(2)})`;
      bar.fill.style.width = `${(ratio * 100).toFixed(0)}%`;

      const band = ratio > 0.6 ? '' : ratio > 0.3 ? 'mid' : 'low';
      if (band !== bar.band) {
        setClass(bar.root, 'mid', band === 'mid');
        setClass(bar.root, 'low', band === 'low');
        bar.band = band;
      }
      if (bar.team !== t.team) {
        bar.team = t.team;
        setClass(bar.root, 'enemy', t.team !== playerTeam);
      }
      setClass(bar.root, 'sel', t.selected);

      if (this.decals && t.selected) {
        const radius = probe.entityRadius?.(t.id) ?? 4;
        const size = clamp((radius * 2.4 * this.height) / Math.max(1, dist * 0.62), 22, 140);
        const ret = this.reticle(t.id);
        ret.used = true;
        const groundV = this.scratch.set(t.position.x, t.position.y, t.position.z).project(camera);
        const gx = (groundV.x * 0.5 + 0.5) * this.width;
        const gy = (-groundV.y * 0.5 + 0.5) * this.height;
        ret.root.style.display = '';
        ret.root.style.transform = `translate3d(${gx.toFixed(1)}px, ${gy.toFixed(1)}px, 0)`;
        ret.root.style.width = `${size.toFixed(0)}px`;
        ret.root.style.height = `${(size * 0.52).toFixed(0)}px`;
      }
    }

    for (const [id, bar] of this.bars) {
      if (bar.used) continue;
      bar.root.style.display = 'none';
      this.bars.delete(id);
      this.barPool.push(bar);
    }
    for (const [id, ret] of this.reticles) {
      if (ret.used) continue;
      ret.root.style.display = 'none';
      this.reticles.delete(id);
      this.reticlePool.push(ret);
    }
  }

  private hideAll(): void {
    for (const [id, bar] of this.bars) {
      bar.root.style.display = 'none';
      this.barPool.push(bar);
      this.bars.delete(id);
    }
    for (const [id, ret] of this.reticles) {
      ret.root.style.display = 'none';
      this.reticlePool.push(ret);
      this.reticles.delete(id);
    }
  }

  private bar(id: number): Bar {
    let bar = this.bars.get(id);
    if (bar) return bar;
    bar = this.barPool.pop();
    if (!bar) {
      const root = div('vs-hpbar', this.root);
      const fill = document.createElement('i');
      root.appendChild(fill);
      div('seg', root);
      bar = { root, fill, band: '', team: 0, used: true };
    }
    this.bars.set(id, bar);
    return bar;
  }

  private reticle(id: number): Reticle {
    let ret = this.reticles.get(id);
    if (ret) return ret;
    ret = this.reticlePool.pop();
    if (!ret) {
      const root = div('vs-reticle', this.root);
      for (const c of ['tl', 'tr', 'bl', 'br']) div(`c ${c}`, root);
      div('ring', root);
      ret = { root, used: true };
    }
    this.reticles.set(id, ret);
    return ret;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
