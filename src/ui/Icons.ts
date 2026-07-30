import type { BuildingType, UnitType } from '@/entities/Types';

/**
 * Every build icon in the sidebar is drawn here. No external images are allowed
 * and the model catalogue is another stream's, so the cameos are generated as
 * miniature axonometric renders: each subject is assembled from boxes and
 * extruded prisms, lit by one shared light vector, depth-sorted per face and
 * rasterised to a canvas.
 *
 * Building them from a common primitive kit is the point. Every cameo lands on
 * the same projection, the same light, the same edge treatment and the same
 * fitted framing, so seventeen different subjects read as one icon set rather
 * than seventeen drawings.
 */

type V3 = [number, number, number];

/** Normalised key light, shared by every cameo so the set is lit consistently. */
const LIGHT: V3 = (() => {
  const v: V3 = [0.42, 0.82, 0.39];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

const COS30 = Math.cos(Math.PI / 6);

function project(p: V3): [number, number] {
  return [(p[0] - p[2]) * COS30, (p[0] + p[2]) * 0.5 - p[1]];
}

function depthOf(p: V3): number {
  return p[0] + p[1] * 0.85 + p[2];
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hex(c: string): Rgb {
  const v = parseInt(c.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function css(c: Rgb, k: number, alpha = 1): string {
  const f = (x: number): number => Math.max(0, Math.min(255, Math.round(x * k)));
  return `rgba(${f(c.r)},${f(c.g)},${f(c.b)},${alpha})`;
}

interface Face {
  pts: V3[];
  depth: number;
  fill: string;
  edge: string;
  emissive: boolean;
}

/** A single cameo's geometry buffer. */
class Cameo {
  private faces: Face[] = [];
  private minX = Infinity;
  private maxX = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;

  /** Adds one planar face with an explicit outward normal. */
  face(pts: V3[], normal: V3, color: Rgb, emissive = false): void {
    const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const d = (normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]) / nl;
    // Wrapped diffuse plus a sky term keeps upward faces bright and downward
    // faces coloured rather than black — the same trick the 3D scene uses.
    const sky = 0.5 + 0.5 * (normal[1] / nl);
    const k = emissive ? 1.35 : 0.26 + 0.62 * Math.max(0, d) + 0.2 * sky;
    let depth = 0;
    for (const p of pts) {
      depth += depthOf(p);
      const [x, y] = project(p);
      if (x < this.minX) this.minX = x;
      if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
    }
    this.faces.push({
      pts,
      depth: depth / pts.length,
      fill: css(color, k),
      edge: css(color, k * 0.34, 0.85),
      emissive,
    });
  }

  /** Axis-aligned box; (x, z) is the centre of the footprint, y its base. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: Rgb, emissive = false): void {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const y1 = y + h;
    this.face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], color, emissive);
    this.face([[x1, y, z0], [x1, y1, z0], [x1, y1, z1], [x1, y, z1]], [1, 0, 0], color, emissive);
    this.face([[x0, y, z1], [x0, y1, z1], [x1, y1, z1], [x1, y, z1]], [0, 0, 1], color, emissive);
  }

  /** Polygon in the XY plane (points wound counter-clockwise) extruded along Z. */
  prismXY(poly: Array<[number, number]>, z0: number, z1: number, color: Rgb, emissive = false): void {
    const front: V3[] = poly.map(([x, y]) => [x, y, z1]);
    this.face(front, [0, 0, 1], color, emissive);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const nx = b[1] - a[1];
      const ny = -(b[0] - a[0]);
      if (nx + ny * 0.85 <= 0.0001) continue;
      this.face(
        [[a[0], a[1], z1], [b[0], b[1], z1], [b[0], b[1], z0], [a[0], a[1], z0]],
        [nx, ny, 0], color, emissive,
      );
    }
  }

  /** Polygon in the XZ plane (ground plan) extruded upward — silos, domes, dishes. */
  prismXZ(poly: Array<[number, number]>, y0: number, y1: number, color: Rgb, emissive = false): void {
    const top: V3[] = poly.map(([x, z]) => [x, y1, z]);
    this.face(top, [0, 1, 0], color, emissive);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const nx = -(b[1] - a[1]);
      const nz = b[0] - a[0];
      if (nx + nz <= 0.0001) continue;
      this.face(
        [[a[0], y1, a[1]], [b[0], y1, b[1]], [b[0], y0, b[1]], [a[0], y0, a[1]]],
        [nx, 0, nz], color, emissive,
      );
    }
  }

  /** Regular n-gon footprint for {@link prismXZ}. */
  static ngon(cx: number, cz: number, r: number, n: number, phase = 0): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    return out;
  }

  render(ctx: CanvasRenderingContext2D, size: number, presence: number): void {
    const w = this.maxX - this.minX;
    const h = this.maxY - this.minY;
    if (!(w > 0) || !(h > 0)) return;
    const pad = size * 0.11;
    const fit = Math.min((size - pad * 2) / w, (size - pad * 2) / h);
    const scale = fit * presence;
    const ox = size / 2 - ((this.minX + this.maxX) / 2) * scale;
    const oy = size / 2 - ((this.minY + this.maxY) / 2) * scale;

    // Contact shadow: a soft ellipse under the footprint so the subject sits on
    // the plinth instead of floating in it.
    const groundY = oy + this.maxY * scale;
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.filter = 'blur(3px)';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(size / 2, groundY - h * scale * 0.06, w * scale * 0.46, h * scale * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this.faces.sort((a, b) => a.depth - b.depth);
    ctx.lineJoin = 'miter';
    ctx.lineWidth = Math.max(1, size / 90);
    for (const f of this.faces) {
      ctx.beginPath();
      for (let i = 0; i < f.pts.length; i++) {
        const [px, py] = project(f.pts[i]);
        const x = ox + px * scale;
        const y = oy + py * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = f.fill;
      ctx.fill();
      ctx.strokeStyle = f.edge;
      ctx.stroke();
      if (f.emissive) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35;
        ctx.filter = `blur(${Math.max(1, size / 40)}px)`;
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// shared material palette
// ---------------------------------------------------------------------------

const MAT = {
  hull: hex('#9fa9b0'),
  hullDark: hex('#5a656d'),
  hullLight: hex('#c3ccd2'),
  tread: hex('#333a3f'),
  rubber: hex('#2b3134'),
  gun: hex('#727d84'),
  glass: hex('#5fd0ef'),
  cloth: hex('#7c8467'),
  flesh: hex('#c9a37e'),
  concrete: hex('#a9a598'),
  concreteDark: hex('#6d6a5f'),
  roof: hex('#4c5a63'),
  energy: hex('#63ffb0'),
  warn: hex('#ffb42a'),
  hot: hex('#ff6a33'),
};

function teamRgb(team: string): Rgb {
  return hex(team);
}

// ---------------------------------------------------------------------------
// cameo definitions
// ---------------------------------------------------------------------------

/** Foot soldier used by all three infantry cameos. */
function soldier(c: Cameo, x: number, z: number, accent: Rgb, s = 1): void {
  c.box(x - 4 * s, 0, z, 7 * s, 17 * s, 7 * s, MAT.cloth);
  c.box(x + 4 * s, 0, z, 7 * s, 17 * s, 7 * s, MAT.cloth);
  c.box(x, 16 * s, z, 17 * s, 19 * s, 12 * s, MAT.cloth);
  c.box(x, 20 * s, z, 18 * s, 5 * s, 13 * s, accent);
  c.box(x, 35 * s, z, 9 * s, 8 * s, 9 * s, MAT.flesh);
  c.box(x, 41 * s, z, 14 * s, 5 * s, 14 * s, MAT.hullDark);
}

const UNIT_CAMEOS: Record<UnitType, (c: Cameo, accent: Rgb) => void> = {
  rifleman: (c, a) => {
    soldier(c, -16, 12, a, 0.92);
    soldier(c, 12, -10, a, 1);
    // Slung rifle, drawn as a thin prism so the barrel keeps a clean diagonal.
    c.prismXY([[10, 26], [34, 38], [37, 33], [13, 21]], -14, -10, MAT.gun);
    c.prismXY([[8, 22], [18, 27], [19, 24], [9, 19]], -14.5, -9.5, MAT.hullDark);
  },
  rocketeer: (c, a) => {
    soldier(c, -14, 10, a, 0.92);
    soldier(c, 12, -10, a, 1);
    c.prismXY([[4, 34], [42, 46], [44, 39], [6, 27]], -15, -9, MAT.hullDark);
    c.prismXY([[42, 46], [52, 45], [52, 39], [44, 39]], -15, -9, MAT.hot);
    c.box(0, 44, -12, 8, 5, 8, MAT.warn);
  },
  engineer: (c, a) => {
    soldier(c, 4, 0, a, 1.05);
    c.box(4, 46, 0, 16, 5, 16, MAT.warn);
    c.box(-20, 0, 14, 20, 13, 14, MAT.warn);
    c.box(-20, 13, 14, 6, 4, 6, MAT.hullDark);
    c.prismXY([[16, 18], [34, 30], [37, 25], [19, 13]], -6, -2, MAT.hull);
  },
  scout: (c, a) => {
    for (const [dx, dz] of [[-16, -12], [16, -12], [-16, 12], [16, 12]] as const) {
      c.box(dx, 0, dz, 13, 13, 9, MAT.rubber);
    }
    c.box(0, 8, 0, 46, 9, 26, MAT.hull);
    c.box(-4, 17, 0, 26, 8, 22, MAT.hullDark);
    c.box(-4, 25, 0, 24, 2, 20, a);
    c.box(20, 17, 0, 12, 6, 14, MAT.glass, true);
    c.prismXY([[2, 30], [26, 30], [26, 26], [2, 26]], -3, 3, MAT.gun);
    c.box(-2, 30, 0, 4, 12, 4, MAT.hullDark);
  },
  tank: (c, a) => {
    c.box(0, 0, -13, 54, 14, 12, MAT.tread);
    c.box(0, 0, 13, 54, 14, 12, MAT.tread);
    c.box(0, 11, 0, 50, 11, 32, MAT.hull);
    c.box(0, 22, 0, 30, 12, 24, MAT.hullDark);
    c.box(0, 33, 0, 22, 3, 18, a);
    c.prismXY([[10, 26], [46, 26], [46, 20], [10, 20]], -4, 4, MAT.gun);
    c.box(48, 22, 0, 6, 8, 8, MAT.hullDark);
    c.box(-16, 34, 0, 5, 9, 5, MAT.hullDark);
  },
  artillery: (c, a) => {
    c.box(0, 0, -13, 52, 13, 11, MAT.tread);
    c.box(0, 0, 13, 52, 13, 11, MAT.tread);
    c.box(-2, 10, 0, 46, 12, 30, MAT.hull);
    c.box(-14, 21, 0, 20, 10, 22, MAT.hullDark);
    c.box(-14, 30, 0, 16, 3, 18, a);
    // Elevated barrel: one prism keeps the diagonal crisp at 64 px.
    c.prismXY([[-6, 26], [44, 56], [48, 50], [-2, 20]], -4, 4, MAT.gun);
    c.prismXY([[44, 56], [54, 62], [57, 57], [47, 51]], -5, 5, MAT.hullDark);
    c.box(-24, 20, 0, 8, 8, 26, MAT.hullDark);
  },
  aa: (c, a) => {
    for (const [dx, dz] of [[-16, -13], [16, -13], [-16, 13], [16, 13]] as const) {
      c.box(dx, 0, dz, 14, 12, 9, MAT.rubber);
    }
    c.box(0, 9, 0, 48, 12, 30, MAT.hull);
    c.box(-6, 21, 0, 24, 9, 22, MAT.hullDark);
    c.box(-6, 30, 0, 20, 3, 18, a);
    c.prismXY([[4, 30], [40, 54], [43, 49], [7, 25]], -8, -3, MAT.gun);
    c.prismXY([[4, 30], [40, 54], [43, 49], [7, 25]], 3, 8, MAT.gun);
    c.prismXZ(Cameo.ngon(-20, 0, 11, 8), 21, 24, MAT.hullDark);
  },
  harvester: (c, a) => {
    c.box(0, 0, -15, 56, 15, 12, MAT.tread);
    c.box(0, 0, 15, 56, 15, 12, MAT.tread);
    c.box(-4, 12, 0, 46, 14, 34, MAT.hull);
    // Tapered ore hopper.
    c.prismXY([[-30, 26], [16, 26], [10, 52], [-24, 52]], -16, 16, MAT.hullDark);
    c.prismXY([[-24, 52], [10, 52], [10, 55], [-24, 55]], -14, 14, MAT.energy, true);
    c.box(-4, 26, 0, 4, 28, 36, a);
    c.box(26, 14, 0, 16, 14, 26, MAT.hullDark);
    c.box(26, 24, 0, 12, 5, 20, MAT.glass, true);
    c.prismXY([[30, 12], [54, 4], [54, -6], [30, 2]], -12, 12, MAT.gun);
  },
};

const BUILDING_CAMEOS: Record<BuildingType, (c: Cameo, accent: Rgb) => void> = {
  hq: (c, a) => {
    c.box(0, 0, 0, 76, 8, 76, MAT.concreteDark);
    c.box(-10, 8, -8, 50, 26, 46, MAT.concrete);
    c.box(-10, 34, -8, 54, 4, 50, MAT.roof);
    c.box(-10, 38, -8, 36, 3, 32, a);
    c.box(22, 8, 22, 26, 40, 26, MAT.concrete);
    c.box(22, 48, 22, 30, 4, 30, MAT.roof);
    // Gantry crane over the build pad.
    c.box(22, 52, 22, 5, 26, 5, MAT.hullDark);
    c.prismXY([[8, 74], [46, 78], [46, 72], [8, 68]], 20, 24, MAT.warn);
    c.box(-30, 8, 24, 22, 12, 22, MAT.concreteDark);
    c.box(-30, 20, 24, 8, 3, 8, MAT.energy, true);
  },
  power: (c, a) => {
    c.box(0, 0, 0, 76, 7, 76, MAT.concreteDark);
    c.box(-16, 7, -16, 40, 22, 40, MAT.concrete);
    c.box(-16, 29, -16, 44, 4, 44, MAT.roof);
    c.prismXZ(Cameo.ngon(20, 18, 17, 8, 0.4), 7, 46, MAT.concrete);
    c.prismXZ(Cameo.ngon(20, 18, 13, 8, 0.4), 46, 50, MAT.hullDark);
    c.prismXZ(Cameo.ngon(-24, 26, 11, 8, 0.4), 7, 34, MAT.concrete);
    c.box(-16, 33, -16, 26, 4, 26, a);
    c.box(6, 7, -30, 14, 20, 14, MAT.hullDark);
    c.box(6, 27, -30, 10, 4, 10, MAT.energy, true);
  },
  refinery: (c, a) => {
    c.box(0, 0, 0, 80, 7, 80, MAT.concreteDark);
    c.box(-14, 7, -12, 48, 24, 44, MAT.concrete);
    c.box(-14, 31, -12, 52, 4, 48, MAT.roof);
    c.box(-14, 35, -12, 34, 3, 30, a);
    c.prismXZ(Cameo.ngon(24, 20, 18, 10), 7, 44, MAT.hull);
    c.prismXZ(Cameo.ngon(24, 20, 20, 10), 44, 48, MAT.hullDark);
    c.prismXZ(Cameo.ngon(24, 20, 12, 10), 48, 52, MAT.energy, true);
    c.prismXY([[-6, 30], [30, 30], [30, 24], [-6, 24]], 16, 22, MAT.gun);
    c.box(-32, 7, 28, 20, 10, 20, MAT.hullDark);
    c.box(-32, 17, 28, 16, 4, 16, MAT.energy, true);
  },
  barracks: (c, a) => {
    c.box(0, 0, 0, 74, 7, 74, MAT.concreteDark);
    c.box(-4, 7, 0, 52, 26, 52, MAT.concrete);
    c.box(-4, 33, 0, 58, 5, 58, MAT.roof);
    c.box(-4, 38, 0, 40, 3, 40, a);
    c.box(26, 7, 8, 6, 18, 20, MAT.hullDark);
    c.box(30, 4, 8, 14, 3, 22, MAT.concreteDark);
    c.box(-26, 38, -22, 4, 26, 4, MAT.hullDark);
    c.prismXY([[-28, 58], [-6, 62], [-6, 50], [-28, 48]], -24, -21, a);
    c.box(-26, 7, 26, 16, 10, 16, MAT.concreteDark);
  },
  factory: (c, a) => {
    c.box(0, 0, 0, 84, 7, 78, MAT.concreteDark);
    c.box(-6, 7, 0, 58, 28, 54, MAT.concrete);
    c.box(-6, 35, 0, 62, 5, 58, MAT.roof);
    for (const dz of [-16, 0, 16]) c.box(-6, 40, dz, 46, 4, 8, MAT.hullDark);
    c.box(-6, 40, 22, 40, 3, 6, a);
    c.box(26, 7, 0, 8, 24, 34, MAT.hullDark);
    c.box(38, 2, 0, 24, 2, 34, MAT.concreteDark);
    c.box(38, 4, -14, 24, 1.5, 5, MAT.warn);
    c.box(38, 4, 14, 24, 1.5, 5, MAT.warn);
    c.box(-32, 7, -26, 14, 32, 14, MAT.concrete);
    c.box(-32, 39, -26, 8, 4, 8, MAT.energy, true);
  },
  turret: (c, a) => {
    c.box(0, 0, 0, 52, 9, 52, MAT.concreteDark);
    c.prismXZ(Cameo.ngon(0, 0, 21, 8, 0.4), 9, 24, MAT.concrete);
    c.box(0, 24, 0, 28, 13, 26, MAT.hullDark);
    c.box(0, 37, 0, 20, 3, 18, a);
    c.prismXY([[8, 30], [50, 30], [50, 25], [8, 25]], -7, -2, MAT.gun);
    c.prismXY([[8, 30], [50, 30], [50, 25], [8, 25]], 2, 7, MAT.gun);
    c.box(-16, 36, 0, 5, 8, 5, MAT.hullDark);
  },
  sam: (c, a) => {
    c.box(0, 0, 0, 56, 10, 56, MAT.concreteDark);
    c.box(0, 10, 0, 42, 14, 42, MAT.concrete);
    c.box(0, 24, 0, 32, 4, 32, a);
    c.prismXY([[-16, 28], [10, 62], [18, 57], [-8, 23]], -14, -6, MAT.hull);
    c.prismXY([[-16, 28], [10, 62], [18, 57], [-8, 23]], 6, 14, MAT.hull);
    c.prismXY([[10, 62], [18, 68], [22, 62], [18, 57]], -13, -7, MAT.hot);
    c.prismXY([[10, 62], [18, 68], [22, 62], [18, 57]], 7, 13, MAT.hot);
    c.box(-22, 10, 20, 14, 12, 14, MAT.hullDark);
  },
  radar: (c, a) => {
    c.box(0, 0, 0, 62, 8, 62, MAT.concreteDark);
    c.box(-8, 8, -6, 40, 22, 40, MAT.concrete);
    c.box(-8, 30, -6, 44, 4, 44, MAT.roof);
    c.box(-8, 34, -6, 28, 3, 26, a);
    c.box(6, 34, 6, 7, 22, 7, MAT.hullDark);
    // Dish: a shallow tapered prism tilted toward the viewer.
    c.prismXY([[-16, 52], [6, 78], [22, 74], [0, 48]], 0, 6, MAT.hull);
    c.prismXY([[-14, 54], [5, 76], [19, 72], [0, 50]], 6, 8, MAT.glass, true);
    c.box(-26, 8, 24, 16, 12, 16, MAT.concreteDark);
  },
  lab: (c, a) => {
    c.box(0, 0, 0, 68, 8, 68, MAT.concreteDark);
    c.box(0, 8, 0, 48, 20, 48, MAT.concrete);
    c.box(0, 28, 0, 52, 4, 52, MAT.roof);
    c.prismXZ(Cameo.ngon(0, 0, 20, 10), 32, 42, MAT.hull);
    c.prismXZ(Cameo.ngon(0, 0, 14, 10), 42, 48, MAT.hull);
    c.prismXZ(Cameo.ngon(0, 0, 7, 10), 48, 52, MAT.energy, true);
    c.box(0, 32, 0, 50, 3, 50, a);
    c.box(24, 8, -24, 10, 30, 10, MAT.hullDark);
    c.box(24, 38, -24, 4, 10, 4, MAT.warn, true);
    c.box(-26, 8, 22, 14, 14, 14, MAT.concreteDark);
  },
};

const PRESENCE: Partial<Record<string, number>> = {
  rifleman: 0.74,
  rocketeer: 0.76,
  engineer: 0.76,
  scout: 0.9,
  aa: 0.94,
  tank: 0.96,
  artillery: 0.96,
  harvester: 1,
};

const cache = new Map<string, string>();

/**
 * Renders a cameo and returns a data URL. Results are cached: the sidebar,
 * selection panel and tooltips all draw from the same seventeen bitmaps.
 */
export function cameo(id: UnitType | BuildingType, teamColor: string, size = 128): string {
  const key = `${id}|${teamColor}|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const c = new Cameo();
  const accent = teamRgb(teamColor);
  const unit = UNIT_CAMEOS[id as UnitType];
  if (unit) unit(c, accent);
  else BUILDING_CAMEOS[id as BuildingType]?.(c, accent);
  c.render(ctx, size, PRESENCE[id] ?? 1);

  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// ---------------------------------------------------------------------------
// flat UI glyphs — alerts, tabs, stat chips
// ---------------------------------------------------------------------------

export type GlyphId =
  | 'structures' | 'infantry' | 'vehicles' | 'lock' | 'cancel' | 'queue'
  | 'credits' | 'power' | 'time' | 'units' | 'kills' | 'losses'
  | 'insufficientFunds' | 'lowPower' | 'baseUnderAttack' | 'unitLost'
  | 'buildingComplete' | 'unitReady' | 'newTech' | 'harvesterLost'
  | 'shield' | 'target' | 'chevron' | 'pause' | 'menu';

type Path = Array<Array<[number, number]>>;

/** Glyphs are authored on a 100×100 grid as closed polygons. */
const GLYPHS: Record<GlyphId, Path> = {
  structures: [
    [[10, 86], [10, 44], [40, 26], [40, 86]],
    [[46, 86], [46, 34], [90, 34], [90, 86]],
    [[56, 44], [66, 44], [66, 54], [56, 54]],
    [[72, 44], [82, 44], [82, 54], [72, 54]],
    [[56, 62], [66, 62], [66, 72], [56, 72]],
    [[72, 62], [82, 62], [82, 72], [72, 72]],
  ],
  infantry: [
    [[42, 8], [58, 8], [58, 24], [42, 24]],
    [[34, 28], [66, 28], [66, 58], [56, 58], [56, 92], [44, 92], [44, 58], [34, 58]],
    [[26, 32], [34, 32], [34, 76], [26, 76]],
    [[66, 32], [74, 32], [74, 76], [66, 76]],
  ],
  vehicles: [
    [[12, 58], [88, 58], [88, 74], [12, 74]],
    [[24, 38], [70, 38], [70, 58], [24, 58]],
    [[52, 28], [92, 28], [92, 36], [52, 36]],
    [[14, 76], [30, 76], [30, 90], [14, 90]],
    [[42, 76], [58, 76], [58, 90], [42, 90]],
    [[70, 76], [86, 76], [86, 90], [70, 90]],
  ],
  lock: [
    [[24, 46], [76, 46], [76, 90], [24, 90]],
    [[34, 46], [34, 30], [42, 22], [58, 22], [66, 30], [66, 46], [58, 46], [58, 32], [54, 28], [46, 28], [42, 32], [42, 46]],
    [[44, 58], [56, 58], [56, 78], [44, 78]],
  ],
  cancel: [
    [[22, 32], [32, 22], [78, 68], [68, 78]],
    [[68, 22], [78, 32], [32, 78], [22, 68]],
  ],
  queue: [
    [[14, 20], [86, 20], [86, 32], [14, 32]],
    [[14, 44], [86, 44], [86, 56], [14, 56]],
    [[14, 68], [86, 68], [86, 80], [14, 80]],
  ],
  credits: [
    [[50, 8], [86, 34], [72, 78], [28, 78], [14, 34]],
    [[50, 24], [70, 38], [62, 64], [38, 64], [30, 38]],
  ],
  power: [[[56, 6], [26, 54], [46, 54], [40, 94], [76, 42], [54, 42]]],
  time: [
    [[50, 8], [88, 50], [50, 92], [12, 50]],
    [[46, 26], [54, 26], [54, 52], [76, 52], [76, 60], [46, 60]],
  ],
  units: [
    [[20, 18], [44, 18], [44, 44], [20, 44]],
    [[56, 18], [80, 18], [80, 44], [56, 44]],
    [[20, 56], [44, 56], [44, 82], [20, 82]],
    [[56, 56], [80, 56], [80, 82], [56, 82]],
  ],
  kills: [
    [[50, 10], [66, 26], [66, 58], [58, 66], [58, 88], [42, 88], [42, 66], [34, 58], [34, 26]],
    [[38, 34], [46, 34], [46, 48], [38, 48]],
    [[54, 34], [62, 34], [62, 48], [54, 48]],
  ],
  losses: [
    [[44, 8], [56, 8], [56, 40], [88, 40], [88, 52], [56, 52], [56, 92], [44, 92], [44, 52], [12, 52], [12, 40], [44, 40]],
  ],
  insufficientFunds: [
    [[50, 8], [86, 34], [72, 78], [28, 78], [14, 34]],
    [[22, 20], [30, 12], [82, 64], [74, 72]],
  ],
  lowPower: [[[56, 6], [26, 54], [46, 54], [40, 94], [76, 42], [54, 42]]],
  baseUnderAttack: [
    [[50, 6], [96, 90], [4, 90]],
    [[44, 36], [56, 36], [56, 62], [44, 62]],
    [[44, 70], [56, 70], [56, 82], [44, 82]],
  ],
  unitLost: [
    [[50, 10], [66, 26], [66, 58], [58, 66], [58, 88], [42, 88], [42, 66], [34, 58], [34, 26]],
    [[38, 34], [46, 34], [46, 48], [38, 48]],
    [[54, 34], [62, 34], [62, 48], [54, 48]],
  ],
  buildingComplete: [
    [[14, 50], [30, 34], [42, 46], [70, 18], [86, 34], [42, 78]],
  ],
  unitReady: [
    [[14, 50], [30, 34], [42, 46], [70, 18], [86, 34], [42, 78]],
  ],
  newTech: [
    [[50, 6], [62, 38], [94, 50], [62, 62], [50, 94], [38, 62], [6, 50], [38, 38]],
  ],
  harvesterLost: [
    [[12, 62], [88, 62], [88, 78], [12, 78]],
    [[26, 30], [62, 30], [70, 62], [18, 62]],
    [[22, 12], [30, 4], [82, 56], [74, 64]],
  ],
  shield: [[[50, 8], [86, 24], [82, 60], [50, 92], [18, 60], [14, 24]]],
  target: [
    [[46, 6], [54, 6], [54, 30], [46, 30]],
    [[46, 70], [54, 70], [54, 94], [46, 94]],
    [[6, 46], [30, 46], [30, 54], [6, 54]],
    [[70, 46], [94, 46], [94, 54], [70, 54]],
    [[40, 40], [60, 40], [60, 60], [40, 60]],
  ],
  chevron: [[[30, 14], [44, 14], [74, 50], [44, 86], [30, 86], [60, 50]]],
  pause: [
    [[26, 16], [44, 16], [44, 84], [26, 84]],
    [[56, 16], [74, 16], [74, 84], [56, 84]],
  ],
  menu: [
    [[14, 22], [86, 22], [86, 34], [14, 34]],
    [[14, 44], [86, 44], [86, 56], [14, 56]],
    [[14, 66], [86, 66], [86, 78], [14, 78]],
  ],
};

const glyphCache = new Map<string, string>();

/** Flat single-colour pictogram as a data URL, for CSS masks and backgrounds. */
export function glyph(id: GlyphId, color = '#ffffff', size = 48): string {
  const key = `${id}|${color}|${size}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const s = size / 100;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const poly of GLYPHS[id]) {
    ctx.moveTo(poly[0][0] * s, poly[0][1] * s);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] * s, poly[i][1] * s);
    ctx.closePath();
  }
  ctx.fill('evenodd');
  const url = canvas.toDataURL('image/png');
  glyphCache.set(key, url);
  return url;
}

/**
 * Faction crest: an angular shield with the three-letter mark cut out of it.
 * Used on the menu cards and the top bar.
 */
export function crest(mark: string, accent: string, size = 160): string {
  const key = `crest|${mark}|${accent}|${size}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const s = size / 100;

  const shield = (inset: number): void => {
    ctx.beginPath();
    ctx.moveTo(50 * s, (6 + inset) * s);
    ctx.lineTo((92 - inset) * s, (24 + inset * 0.6) * s);
    ctx.lineTo((88 - inset) * s, (58 - inset * 0.2) * s);
    ctx.lineTo(50 * s, (94 - inset) * s);
    ctx.lineTo((12 + inset) * s, (58 - inset * 0.2) * s);
    ctx.lineTo((8 + inset) * s, (24 + inset * 0.6) * s);
    ctx.closePath();
  };

  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = grad;
  shield(0);
  ctx.fill();

  ctx.globalCompositeOperation = 'destination-out';
  shield(7);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  ctx.fillStyle = accent;
  shield(12);
  ctx.fill();

  ctx.globalCompositeOperation = 'destination-out';
  ctx.font = `700 ${Math.round(size * 0.26)}px "Liberation Sans", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(mark, size / 2, size * 0.48);
  ctx.globalCompositeOperation = 'source-over';

  const url = canvas.toDataURL('image/png');
  glyphCache.set(key, url);
  return url;
}

/**
 * Tiling detail textures. Panels get real grain instead of flat fills, which is
 * the difference between a game panel and a `<div>` with a background colour.
 */
export function noiseTile(size = 96, alpha = 0.055): string {
  const key = `noise|${size}|${alpha}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(size, size);
  let seed = 1337;
  for (let i = 0; i < size * size; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = (seed >>> 24) & 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = Math.round(alpha * 255 * (0.4 + (v / 255) * 0.6));
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  glyphCache.set(key, url);
  return url;
}

/** Brushed-metal streaks, used on header plates. */
export function brushTile(w = 128, h = 64): string {
  const key = `brush|${w}|${h}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  let seed = 99;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed >>> 16) / 65536;
  };
  for (let i = 0; i < 220; i++) {
    const y = rand() * h;
    const a = 0.018 + rand() * 0.05;
    ctx.fillStyle = rand() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`;
    ctx.fillRect(0, y, w, rand() > 0.85 ? 2 : 1);
  }
  const url = canvas.toDataURL('image/png');
  glyphCache.set(key, url);
  return url;
}
