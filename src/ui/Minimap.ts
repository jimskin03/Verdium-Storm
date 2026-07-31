import * as THREE from 'three';
import type { GameStateService } from '@/game/GameState';
import { HALF_WORLD, WATER_LEVEL, WORLD_SIZE, heightAt } from '@/world/Heightfield';
import { div, setText } from './dom';
import { brackets, caption, plate } from './Widgets';
import type { FactionTheme } from './Theme';

/**
 * Tactical map.
 *
 * Three layers, redrawn on very different schedules:
 *
 *   1. **Terrain** — a hillshaded heightfield render sampled once from
 *      `heightAt()` into an offscreen canvas. It never changes, so it is blitted
 *      rather than recomputed; sampling it per frame would cost ~50k noise
 *      evaluations every 16 ms.
 *   2. **Fog** — `fogGrids()` painted into a small `ImageData` at the grid's own
 *      resolution and scaled up with smoothing, so the fog edge is soft instead
 *      of a staircase. Rebuilt only when the composite refreshes.
 *   3. **Blips and frustum** — cheap vector work, drawn on every composite.
 *
 * The composite runs at ~22 Hz. Nothing on the minimap moves fast enough to
 * need more, and it keeps a full-screen canvas repaint off the frame budget.
 */

/** Backing resolution. Displayed around 300 CSS px, so this is ~1.15x. */
const MAP_PX = 224;
const REFRESH = 1 / 22;

/** Sea, shallow, sand, grass, rock, alpine — matched to the terrain shader's ramp. */
const RAMP: Array<[number, number, number, number]> = [
  [-40, 8, 18, 30],
  [-2, 22, 48, 62],
  [3, 78, 70, 50],
  [26, 61, 82, 45],
  [64, 82, 78, 68],
  [120, 128, 124, 112],
];

function rampAt(h: number, out: [number, number, number]): void {
  let i = 0;
  while (i < RAMP.length - 2 && h > RAMP[i + 1][0]) i++;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  const t = Math.max(0, Math.min(1, (h - a[0]) / (b[0] - a[0] || 1)));
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
  out[2] = a[3] + (b[3] - a[3]) * t;
}

export class Minimap {
  readonly root: HTMLDivElement;

  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private terrain: HTMLCanvasElement | null = null;
  private fog: HTMLCanvasElement | null = null;
  private fogG: CanvasRenderingContext2D | null = null;
  private fogImage: ImageData | null = null;

  private gridText: HTMLElement;
  private zoomText: HTMLElement;

  private accum = REFRESH;
  private dragging = false;
  private theme: FactionTheme;

  private readonly corners = [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ];
  private readonly scratch = new THREE.Vector3();

  constructor(parent: HTMLElement, theme: FactionTheme, seek: (x: number, z: number) => void) {
    this.theme = theme;
    this.root = plate('cut-tr', parent, 'vs-minimap');
    brackets(this.root, ['tl', 'br']);
    caption(this.root, 'TACTICAL MAP', 'SAT-LINK');

    const frame = div('frame', this.root);
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_PX;
    this.canvas.height = MAP_PX;
    frame.appendChild(this.canvas);
    div('glass', frame);
    div('vignette', frame);
    this.g = this.canvas.getContext('2d');

    const coords = div('coords', this.root);
    this.gridText = div('', coords);
    this.zoomText = div('', coords);

    // Click and drag both re-centre the camera; pointer capture keeps the drag
    // alive when the cursor leaves the small canvas.
    const seekAt = (e: PointerEvent): void => {
      const r = this.canvas.getBoundingClientRect();
      const u = (e.clientX - r.left) / Math.max(1, r.width);
      const v = (e.clientY - r.top) / Math.max(1, r.height);
      seek((u - 0.5) * WORLD_SIZE, (v - 0.5) * WORLD_SIZE);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      seekAt(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      if (this.dragging) seekAt(e);
    });
    const end = (e: PointerEvent): void => {
      this.dragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setTheme(theme: FactionTheme): void {
    this.theme = theme;
  }

  /** Builds the static terrain layer. Called once, off the frame loop. */
  prepare(): void {
    if (this.terrain) return;
    const n = MAP_PX;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const g = canvas.getContext('2d');
    if (!g) return;

    const h = new Float32Array(n * n);
    const step = WORLD_SIZE / n;
    for (let j = 0; j < n; j++) {
      const z = -HALF_WORLD + (j + 0.5) * step;
      for (let i = 0; i < n; i++) {
        h[j * n + i] = heightAt(-HALF_WORLD + (i + 0.5) * step, z);
      }
    }

    const img = g.createImageData(n, n);
    const rgb: [number, number, number] = [0, 0, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = j * n + i;
        const hh = h[p];
        rampAt(hh, rgb);

        // Hillshade from a north-west key, matching the scene's sun bearing.
        const dx = h[p + (i < n - 1 ? 1 : 0)] - h[p - (i > 0 ? 1 : 0)];
        const dz = h[p + (j < n - 1 ? n : 0)] - h[p - (j > 0 ? n : 0)];
        const shade = Math.max(0.32, Math.min(1.7, 0.92 + (-dx - dz) * 0.055));

        // Water reads as a flat sheet: no hillshade below the sea plane, and a
        // depth ramp so the basin has form instead of one blue fill.
        const under = hh < WATER_LEVEL;
        const k = under ? 1 : shade;
        const depth = under ? Math.max(0.45, 1 + hh * 0.02) : 1;

        const o = p * 4;
        img.data[o] = Math.min(255, rgb[0] * k * depth);
        img.data[o + 1] = Math.min(255, rgb[1] * k * depth);
        img.data[o + 2] = Math.min(255, rgb[2] * k * depth);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // A faint survey grid and a corner vignette: without them the map reads as a
    // photograph rather than an instrument.
    g.strokeStyle = 'rgba(160,200,190,.07)';
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const t = Math.round((i / 8) * n) + 0.5;
      g.beginPath();
      g.moveTo(t, 0); g.lineTo(t, n);
      g.moveTo(0, t); g.lineTo(n, t);
      g.stroke();
    }
    const vig = g.createRadialGradient(n / 2, n / 2, n * 0.28, n / 2, n / 2, n * 0.74);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, n, n);

    this.terrain = canvas;
  }

  update(dt: number, game: GameStateService, camera: THREE.PerspectiveCamera, distance: number, target: THREE.Vector3): void {
    // The static layer is built ahead of the rate limiter, not behind it. It is
    // a one-shot build, and putting it behind the gate means any stall in the
    // accumulator leaves the map with no terrain at all rather than a stale one.
    this.prepare();

    // Clamp before accumulating. The frame delta is derived from a rAF
    // timestamp measured against a `performance.now()` baseline, and a
    // freeze/thaw cycle — which the capture harness performs around every
    // screenshot — can hand back a large *negative* delta. Adding that to the
    // accumulator drives it hundreds of milliseconds below zero, and at
    // software-rasteriser frame rates the map then stops redrawing for tens of
    // seconds. Which is exactly what a permanently blank tactical map is.
    this.accum += Math.min(Math.max(dt, 0), REFRESH * 4);
    if (this.accum < REFRESH) return;
    this.accum = 0;

    const g = this.g;
    if (!g || !this.terrain) return;
    const n = MAP_PX;
    const s = n / WORLD_SIZE;
    const px = (x: number): number => (x + HALF_WORLD) * s;

    g.clearRect(0, 0, n, n);
    g.drawImage(this.terrain, 0, 0);

    const blips = game.minimapBlips();

    // Resource fields sit under the fog: you remember where the ore was.
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const b of blips) {
      if (b.kind !== 'resource') continue;
      const r = Math.max(3, b.size * s * 1.9);
      const grad = g.createRadialGradient(px(b.x), px(b.z), 0, px(b.x), px(b.z), r);
      grad.addColorStop(0, 'rgba(96,255,176,.62)');
      grad.addColorStop(0.55, 'rgba(52,190,124,.26)');
      grad.addColorStop(1, 'rgba(20,90,60,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(px(b.x), px(b.z), r, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    const grids = game.fogGrids();
    // A shroud that did not draw must not censor the blips either, or a map
    // with no fog data would show terrain and nothing on it.
    const fog = grids && this.drawFog(g, grids, n) ? grids : null;

    // Units and structures. Enemy contacts are suppressed outside current
    // vision, which is the whole point of having a fog layer.
    for (const b of blips) {
      if (b.kind === 'resource') continue;
      if (b.team !== game.team && fog && !this.isVisible(fog, b.x, b.z)) continue;
      const x = px(b.x);
      const y = px(b.z);
      const own = b.team === game.team;
      const color = own ? '#5fc0ff' : '#ff6a48';
      if (b.kind === 'building') {
        const r = Math.max(2.6, b.size * s * 1.5);
        g.fillStyle = 'rgba(0,0,0,.75)';
        g.fillRect(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2);
        g.fillStyle = color;
        g.fillRect(x - r, y - r, r * 2, r * 2);
        g.fillStyle = own ? 'rgba(220,245,255,.85)' : 'rgba(255,225,215,.8)';
        g.fillRect(x - r + 1, y - r + 1, r * 2 - 2, 1);
      } else {
        const r = Math.max(1.5, b.size * s * 1.7);
        g.fillStyle = 'rgba(0,0,0,.7)';
        g.beginPath();
        g.arc(x, y, r + 0.9, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = color;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }

    this.drawFrustum(g, camera, s);

    // Readouts: grid reference and orbit height, in the same register as the
    // rest of the chrome.
    setText(this.gridText, `GRID ${Math.round(target.x + HALF_WORLD)}·${Math.round(target.z + HALF_WORLD)}`);
    setText(this.zoomText, `ALT ${Math.round(distance)}M`);
  }

  private isVisible(
    fog: { explored: Uint8Array; visible: Uint8Array; resolution: number },
    x: number, z: number,
  ): boolean {
    const r = fog.resolution;
    const gx = Math.floor(((x + HALF_WORLD) / WORLD_SIZE) * r);
    const gz = Math.floor(((z + HALF_WORLD) / WORLD_SIZE) * r);
    if (gx < 0 || gz < 0 || gx >= r || gz >= r) return false;
    // Any non-zero cell counts as seen. The grids are flags, not coverage
    // fractions — see the note in drawFog.
    return fog.visible[gz * r + gx] !== 0;
  }

  /**
   * Paints the shroud.
   *
   * The two grids are **flags**, not coverage values: the simulation writes 1
   * for a revealed cell and 0 for everything else. Testing them against a
   * mid-range threshold therefore reports "unexplored" for every cell on the
   * map and buries the whole tactical map under an opaque sheet — which is
   * exactly what a solid black minimap looks like.
   *
   * Returns false when the grid is entirely unexplored. That state cannot occur
   * in a running match — a team always sees its own base — so it means the fog
   * is not being computed at all, and blanking the map would hide a working
   * minimap behind a bug somewhere else.
   */
  private drawFog(
    g: CanvasRenderingContext2D,
    fog: { explored: Uint8Array; visible: Uint8Array; resolution: number },
    n: number,
  ): boolean {
    const r = fog.resolution;
    if (!this.fog || this.fog.width !== r) {
      this.fog = document.createElement('canvas');
      this.fog.width = r;
      this.fog.height = r;
      this.fogG = this.fog.getContext('2d');
      this.fogImage = this.fogG?.createImageData(r, r) ?? null;
    }
    const fg = this.fogG;
    const img = this.fogImage;
    if (!fg || !img) return false;

    let seen = 0;
    for (let i = 0; i < r * r; i++) {
      const explored = fog.explored[i] !== 0;
      const visible = fog.visible[i] !== 0;
      if (explored) seen++;
      const o = i * 4;
      img.data[o] = 3;
      img.data[o + 1] = 6;
      img.data[o + 2] = 9;
      img.data[o + 3] = visible ? 0 : explored ? 118 : 236;
    }
    if (seen === 0) return false;
    fg.putImageData(img, 0, 0);

    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.fog, 0, 0, n, n);
    g.restore();
    return true;
  }

  /**
   * The camera's ground footprint, obtained by intersecting the four view-frustum
   * corner rays with the sea plane. Rays that escape above the horizon are
   * clamped to a long distance so the trapezoid stays closed at shallow pitches.
   */
  private drawFrustum(g: CanvasRenderingContext2D, camera: THREE.PerspectiveCamera, s: number): void {
    const ndc: Array<[number, number]> = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
    for (let i = 0; i < 4; i++) {
      const v = this.scratch.set(ndc[i][0], ndc[i][1], 0.5).unproject(camera).sub(camera.position).normalize();
      const out = this.corners[i];
      if (v.y > -1e-3) {
        out.set(camera.position.x + v.x * 2600, 0, camera.position.z + v.z * 2600);
      } else {
        const t = Math.min(2600, -camera.position.y / v.y);
        out.set(camera.position.x + v.x * t, 0, camera.position.z + v.z * t);
      }
    }

    g.save();
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const x = (this.corners[i].x + HALF_WORLD) * s;
      const y = (this.corners[i].z + HALF_WORLD) * s;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,.055)';
    g.fill();
    g.lineJoin = 'round';
    g.lineWidth = 2.4;
    g.strokeStyle = 'rgba(0,0,0,.65)';
    g.stroke();
    g.lineWidth = 1.1;
    g.strokeStyle = this.theme.accentSoft;
    g.stroke();
    g.restore();
  }
}
