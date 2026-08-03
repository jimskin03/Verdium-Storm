import * as THREE from 'three';
import { clamp, hash2, smoothstep } from '@/util/Noise';

/**
 * Every texture the prop stream uses, synthesised at boot. Nothing is fetched;
 * the project's constraint is that art is code.
 *
 * Three PBR sets are produced — rock, concrete and battered painted steel —
 * each as albedo + tangent-space normal + a packed ORM map (R = ambient
 * occlusion, G = roughness, B = metalness). Packing the three scalar channels
 * into one image is what lets a whole wreck, with its bare metal, flaking paint
 * and rust, render from a single `MeshStandardMaterial` and therefore a single
 * draw call: the material response varies across the *texture* rather than
 * across a set of materials.
 *
 * Everything tiles. The two noise primitives below are wrapped by construction
 * rather than by the cross-fade trick, which is both faster and exactly
 * seamless: a lattice indexed modulo its own size cannot have a seam.
 */

/* ------------------------------------------------------------------ noise -- */

/** Tileable value-noise pyramid. Each octave is its own wrapped lattice. */
class Lattice {
  private readonly grids: Float32Array[] = [];
  private readonly sizes: number[] = [];

  constructor(base: number, octaves: number, seed: number) {
    for (let o = 0; o < octaves; o++) {
      const n = base * (1 << o);
      const g = new Float32Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) g[y * n + x] = hash2(x, y, seed + o * 7919);
      }
      this.grids.push(g);
      this.sizes.push(n);
    }
  }

  /** One octave. `u`/`v` in [0,1); result 0..1. */
  octave(o: number, u: number, v: number): number {
    const n = this.sizes[o];
    const g = this.grids[o];
    const x = u * n;
    const y = v * n;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    const x0 = ((xi % n) + n) % n;
    const y0 = ((yi % n) + n) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = g[y0 * n + x0];
    const b = g[y0 * n + x1];
    const c = g[y1 * n + x0];
    const d = g[y1 * n + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  }

  /** fBm across every octave; result 0..1. */
  fbm(u: number, v: number, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < this.grids.length; o++) {
      sum += amp * this.octave(o, u, v);
      norm += amp;
      amp *= gain;
    }
    return sum / norm;
  }
}

/**
 * Tileable Worley cells. Feature points are baked once per grid, so the inner
 * loop is nine distance tests and no hashing — the difference between a texture
 * set that costs 80 ms and one that costs a second.
 */
class Cells {
  private readonly px: Float32Array;
  private readonly py: Float32Array;

  constructor(private readonly n: number, seed: number, jitter = 1) {
    this.px = new Float32Array(n * n);
    this.py = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        this.px[i] = x + 0.5 + (hash2(x, y, seed) - 0.5) * jitter;
        this.py[i] = y + 0.5 + (hash2(x, y, seed + 4523) - 0.5) * jitter;
      }
    }
  }

  /** Nearest and second-nearest feature distances, in cell units. */
  sample(u: number, v: number, out: Float32Array): Float32Array {
    const n = this.n;
    const x = u * n;
    const y = v * n;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = 1e9;
    let f2 = 1e9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = xi + ox;
        const cy = yi + oy;
        const wx = ((cx % n) + n) % n;
        const wy = ((cy % n) + n) % n;
        const i = wy * n + wx;
        const dx = this.px[i] + (cx - wx) - x;
        const dy = this.py[i] + (cy - wy) - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    out[0] = f1;
    out[1] = f2;
    return out;
  }
}

/* --------------------------------------------------------------- uploads -- */

function albedoTexture(data: Uint8Array, size: number, aniso: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  configure(tex, aniso);
  return tex;
}

function dataTexture(data: Uint8Array, size: number, aniso: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  configure(tex, aniso);
  return tex;
}

function configure(tex: THREE.DataTexture, aniso: number): void {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
}

/** Sobel a wrapped height field into a tangent-space normal map. */
function normalFromHeight(height: Float32Array, size: number, strength: number, aniso: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const k = (y * size + x) * 4;
      data[k] = Math.round((nx * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round(inv * 255);
      data[k + 3] = 255;
    }
  }
  return dataTexture(data, size, aniso);
}

const enc = (v: number): number => Math.round(clamp(v, 0, 1) * 255);

/* ---------------------------------------------------------------- public -- */

export interface PropMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** R = ambient occlusion, G = roughness, B = metalness. */
  ormMap: THREE.Texture;
}

export function disposeMaps(m: PropMaps): void {
  m.map.dispose();
  m.normalMap.dispose();
  m.ormMap.dispose();
}

/**
 * Granite: a crystalline grain, thin fracture lines between grain clusters,
 * shallow round weathering pits (tafoni), and a warm/cool mineral banding that
 * keeps large boulders from reading as one flat grey.
 */
export function makeRockMaps(size: number, aniso: number, seed = 4801): PropMaps {
  const band = new Lattice(3, 3, seed);
  const mottle = new Lattice(6, 4, seed + 11);
  const fine = new Lattice(24, 2, seed + 23);
  const grain = new Cells(Math.max(8, size >> 4), seed + 31, 1);
  const crackCells = new Cells(9, seed + 47, 0.95);
  const pitCells = new Cells(13, seed + 59, 1);

  const h = new Float32Array(size * size);
  const rgb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const c = new Float32Array(2);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      const bedding = band.fbm(u, v);
      const blotch = mottle.fbm(u, v, 0.55);

      grain.sample(u, v, c);
      const crystal = 1 - smoothstep(0.0, 0.62, c[0]);

      crackCells.sample(u, v, c);
      // The gap between the two nearest features is near zero exactly on a cell
      // boundary, which is where a fracture runs.
      const crack = 1 - smoothstep(0.0, 0.09 + 0.05 * blotch, c[1] - c[0]);

      pitCells.sample(u, v, c);
      const pitMask = smoothstep(0.46, 0.74, blotch);
      const pit = smoothstep(0.34, 0.06, c[0]) * pitMask;

      const speck = fine.fbm(u, v);

      const height = clamp(
        0.5 + 0.20 * bedding + 0.13 * crystal + 0.08 * speck - 0.30 * pit - 0.36 * crack,
        0,
        1,
      );
      h[y * size + x] = height;

      // Albedo. Feldspar-pale and biotite-dark grains over a mineral band that
      // runs warm to cool, then bruised darker wherever the surface is broken.
      const warmth = smoothstep(0.35, 0.72, bedding);
      let r = 0.300 + 0.078 * warmth;
      let g = 0.296 + 0.048 * warmth;
      let b = 0.298 - 0.010 * warmth;

      const light = 0.72 + 0.55 * crystal + 0.30 * speck - 0.22 * blotch;
      r *= light;
      g *= light;
      b *= light;

      // Quartz flecks: sparse, bright, and only a texel or two across.
      if (speck > 0.86) {
        const f = (speck - 0.86) * 5.2;
        r += 0.20 * f;
        g += 0.20 * f;
        b += 0.19 * f;
      }

      // Iron staining seeps out of the fractures.
      const stain = clamp(crack * 0.8 + pit * 0.5, 0, 1) * smoothstep(0.4, 0.8, blotch);
      r = r * (1 - stain * 0.5) + 0.230 * stain * 0.5;
      g = g * (1 - stain * 0.5) + 0.128 * stain * 0.5;
      b = b * (1 - stain * 0.5) + 0.062 * stain * 0.5;

      const dark = 1 - 0.55 * crack - 0.34 * pit;
      const k = (y * size + x) * 4;
      rgb[k] = enc(r * dark);
      rgb[k + 1] = enc(g * dark);
      rgb[k + 2] = enc(b * dark);
      rgb[k + 3] = 255;

      // ORM. Weathered high points polish slightly; cracks and pits stay raw.
      orm[k] = enc(0.30 + 0.70 * smoothstep(0.14, 0.70, height));
      orm[k + 1] = enc(0.97 - 0.21 * smoothstep(0.48, 0.92, height) + 0.02 * crack);
      orm[k + 2] = enc(0.015 + 0.05 * crystal);
      orm[k + 3] = 255;
    }
  }

  return {
    map: albedoTexture(rgb, size, aniso),
    normalMap: normalFromHeight(h, size, size * 0.010, aniso),
    ormMap: dataTexture(orm, size, aniso),
  };
}

/**
 * Cast concrete: plywood form-board lines, spalled patches with the aggregate
 * showing through, shrinkage cracks and rust bleed running down from the rebar.
 */
export function makeConcreteMaps(size: number, aniso: number, seed = 9107): PropMaps {
  const broad = new Lattice(4, 3, seed);
  const grime = new Lattice(10, 3, seed + 17);
  const fine = new Lattice(32, 2, seed + 29);
  const aggregate = new Cells(Math.max(10, size >> 4), seed + 37, 1);
  const crackCells = new Cells(6, seed + 53, 0.9);

  const h = new Float32Array(size * size);
  const rgb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const c = new Float32Array(2);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      const patch = broad.fbm(u, v);
      const dirt = grime.fbm(u, v, 0.58);
      const speck = fine.fbm(u, v);

      // Board marks: the horizontal joints of the shuttering, softened and
      // wandering slightly so they do not read as a ruled line.
      const boardV = v * 7 + 0.08 * patch;
      const board = Math.abs(boardV - Math.floor(boardV) - 0.5) * 2;
      const boardLine = (1 - smoothstep(0.80, 1.0, board)) * 0.5;

      aggregate.sample(u, v, c);
      const stone = 1 - smoothstep(0.10, 0.52, c[0]);

      crackCells.sample(u, v, c);
      const crack = 1 - smoothstep(0.0, 0.055, c[1] - c[0]);

      // Where the skin has spalled off, the aggregate is proud of the surface.
      const spall = smoothstep(0.58, 0.80, patch);
      const height = clamp(
        0.62 + 0.10 * patch + 0.16 * stone * spall - 0.10 * spall - boardLine * 0.18
          - 0.30 * crack + 0.04 * speck,
        0,
        1,
      );
      h[y * size + x] = height;

      // Concrete is genuinely bright — dropping it into mid grey is the classic
      // tell that a surface was guessed at rather than measured.
      let l = 0.575 + 0.085 * patch + 0.05 * speck - 0.10 * dirt - 0.13 * spall;
      l -= boardLine * 0.10;
      let r = l * 1.015;
      let g = l * 1.0;
      let b = l * 0.955;

      // Aggregate stones are a shade darker and cooler than the cement paste.
      const agg = stone * spall;
      r = r * (1 - agg * 0.6) + 0.300 * agg * 0.6;
      g = g * (1 - agg * 0.6) + 0.296 * agg * 0.6;
      b = b * (1 - agg * 0.6) + 0.288 * agg * 0.6;

      // Rust bleed: vertical streaks, gated by a slow horizontal noise so only
      // some columns weep.
      const column = smoothstep(0.56, 0.86, grime.octave(1, u, v * 0.12));
      const streak = column * smoothstep(0.35, 0.85, fine.octave(0, u, v * 0.25)) * (0.35 + 0.65 * v);
      r = r * (1 - streak * 0.55) + 0.245 * streak * 0.55;
      g = g * (1 - streak * 0.55) + 0.135 * streak * 0.55;
      b = b * (1 - streak * 0.55) + 0.070 * streak * 0.55;

      const dark = 1 - 0.42 * crack;
      const k = (y * size + x) * 4;
      rgb[k] = enc(r * dark);
      rgb[k + 1] = enc(g * dark);
      rgb[k + 2] = enc(b * dark);
      rgb[k + 3] = 255;

      orm[k] = enc(0.34 + 0.66 * smoothstep(0.18, 0.78, height));
      orm[k + 1] = enc(0.90 + 0.08 * spall - 0.06 * dirt);
      orm[k + 2] = 0;
      orm[k + 3] = 255;
    }
  }

  return {
    map: albedoTexture(rgb, size, aniso),
    normalMap: normalFromHeight(h, size, size * 0.007, aniso),
    ormMap: dataTexture(orm, size, aniso),
  };
}

/**
 * Battered painted steel. The albedo stays near white where the paint survives
 * so a per-vertex tint can colour it — olive for a hull, galvanised grey for a
 * fence post — while the worn and rusted regions hold their own colour and
 * ignore the tint. Roughness and metalness follow the same masks, so one
 * material covers gloss paint, scoured bare metal and dead matte rust.
 */
export function makeMetalMaps(size: number, aniso: number, seed = 2213): PropMaps {
  const broad = new Lattice(4, 3, seed);
  const rustN = new Lattice(8, 4, seed + 13);
  const fine = new Lattice(28, 2, seed + 41);
  const blister = new Cells(Math.max(12, size >> 3), seed + 61, 1);

  const h = new Float32Array(size * size);
  const rgb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const c = new Float32Array(2);

  // Panel grid: unequal spacing reads as engineering, an even grid as a pattern.
  const panelU = [0.0, 0.21, 0.5, 0.62, 0.85];
  const panelV = [0.0, 0.34, 0.55, 0.78];
  const lineTo = (t: number, lines: number[]): number => {
    let best = 1;
    for (const l of lines) {
      let d = Math.abs(t - l);
      d = Math.min(d, 1 - d);
      if (d < best) best = d;
    }
    return best;
  };

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      const dents = broad.fbm(u, v, 0.6);
      const rustField = rustN.fbm(u, v, 0.55);
      const speck = fine.fbm(u, v);

      const du = lineTo(u + 0.006 * dents, panelU);
      const dv = lineTo(v + 0.006 * dents, panelV);
      const seam = Math.min(du, dv);
      const panelLine = 1 - smoothstep(0.0, 0.010, seam);

      // Rivets march along the panel seams at a fixed pitch.
      const rivetT = (du < dv ? v : u) * 26;
      const rivetPhase = Math.abs(rivetT - Math.floor(rivetT) - 0.5) * 2;
      const rivet =
        (1 - smoothstep(0.0, 0.014, seam)) * (1 - smoothstep(0.55, 0.95, rivetPhase));

      blister.sample(u, v, c);
      const scab = 1 - smoothstep(0.18, 0.60, c[0]);

      const rust = clamp(smoothstep(0.50, 0.80, rustField) + 0.35 * scab * smoothstep(0.40, 0.62, rustField), 0, 1);
      const bare = clamp(smoothstep(0.42, 0.60, rustField) * 0.8 + smoothstep(0.72, 0.95, speck) * 0.5, 0, 1) * (1 - rust * 0.5);

      const height = clamp(
        0.58 + 0.12 * dents - 0.34 * panelLine + 0.20 * rivet + 0.16 * rust * scab
          + 0.05 * speck - 0.10 * rust,
        0,
        1,
      );
      h[y * size + x] = height;

      // Paint: near-white so the vertex tint owns the hue. Chalked by the sun,
      // dirtier in the recesses.
      const chalk = 0.80 + 0.20 * dents - 0.24 * panelLine + 0.06 * speck;
      let r = chalk;
      let g = chalk;
      let b = chalk;

      // Bare metal shows through where the paint is scoured off.
      r = r * (1 - bare) + 0.360 * bare;
      g = g * (1 - bare) + 0.372 * bare;
      b = b * (1 - bare) + 0.385 * bare;

      // Rust. Two tones — dark iron oxide in the pits, bright orange scale on
      // top — because one flat orange is what makes procedural rust look fake.
      const rustHi = rust * smoothstep(0.35, 0.85, scab + speck * 0.4);
      const rustLo = rust - rustHi * 0.5;
      r = r * (1 - rust) + (0.365 * rustHi + 0.175 * rustLo) / Math.max(rust, 1e-3) * rust;
      g = g * (1 - rust) + (0.170 * rustHi + 0.078 * rustLo) / Math.max(rust, 1e-3) * rust;
      b = b * (1 - rust) + (0.072 * rustHi + 0.040 * rustLo) / Math.max(rust, 1e-3) * rust;

      const k = (y * size + x) * 4;
      rgb[k] = enc(r);
      rgb[k + 1] = enc(g);
      rgb[k + 2] = enc(b);
      rgb[k + 3] = 255;

      orm[k] = enc(0.36 + 0.64 * smoothstep(0.16, 0.80, height));
      // Paint 0.52, scoured metal 0.34, rust 0.95.
      orm[k + 1] = enc(0.52 - 0.18 * bare + 0.43 * rust - 0.05 * dents);
      // Paint is a dielectric film over metal; rust is not conductive at all.
      orm[k + 2] = enc(0.14 + 0.80 * bare - 0.13 * rust);
      orm[k + 3] = 255;
    }
  }

  return {
    map: albedoTexture(rgb, size, aniso),
    normalMap: normalFromHeight(h, size, size * 0.009, aniso),
    ormMap: dataTexture(orm, size, aniso),
  };
}

/**
 * Chain-link, as an alpha cut-out. Colour is written into every texel including
 * the fully transparent ones: a canvas leaves unpainted RGB at zero, and every
 * mip reduction and magnification filter then averages black into the wire —
 * which is exactly why cut-out geometry so often turns into a black smear at
 * distance.
 */
export function makeWireTexture(size: number, aniso: number, seed = 7717): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const rustN = new Lattice(6, 3, seed);
  const fine = new Lattice(20, 2, seed + 9);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      // Two diagonal wire families woven into diamonds.
      const a = (u + v) * 5;
      const b = (u - v) * 5;
      const da = Math.abs(a - Math.round(a));
      const db = Math.abs(b - Math.round(b));
      const w = Math.min(da, db);
      let alpha = 1 - smoothstep(0.055, 0.115, w);

      // The weave: one family passes in front of the other, alternating.
      const front = da < db ? 1 : 0.72;

      const rust = smoothstep(0.55, 0.85, rustN.fbm(u, v, 0.6));
      const grain = 0.86 + 0.14 * fine.fbm(u, v);
      let r = 0.300 * front * grain;
      let g = 0.312 * front * grain;
      let bl = 0.322 * front * grain;
      r = r * (1 - rust) + 0.245 * rust;
      g = g * (1 - rust) + 0.115 * rust;
      bl = bl * (1 - rust) + 0.058 * rust;

      // A few broken strands.
      const tear = smoothstep(0.72, 0.86, rustN.octave(0, u * 0.5, v * 0.5));
      alpha *= 1 - tear;

      const k = (y * size + x) * 4;
      data[k] = enc(r);
      data[k + 1] = enc(g);
      data[k + 2] = enc(bl);
      data[k + 3] = enc(alpha);
    }
  }

  const tex = albedoTexture(data, size, aniso);
  return tex;
}

/** Cells of the ground-detail atlas, in UV space. */
export const GROUND_CELL = {
  contact: [0, 0],
  rut: [1, 0],
  scree: [0, 1],
  scorch: [1, 1],
} as const;

export type GroundCellName = keyof typeof GROUND_CELL;

/**
 * The four ground marks props lay down where they meet the terrain, packed into
 * one 2x2 atlas so every patch, rut and scorch in the level draws together.
 *
 * `rut` is authored to tile vertically: a ribbon lays one full copy per segment,
 * so a track can run for a hundred metres without a repeat showing at the joins.
 */
export function makeGroundAtlas(size: number, aniso: number, seed = 3301): THREE.DataTexture {
  const half = size >> 1;
  const data = new Uint8Array(size * size * 4);

  const soft = new Lattice(4, 3, seed);
  const grit = new Lattice(16, 3, seed + 7);
  const stones = new Cells(14, seed + 19, 1);
  const c = new Float32Array(2);

  const put = (cx: number, cy: number, x: number, y: number, r: number, g: number, b: number, a: number): void => {
    const k = ((cy * half + y) * size + cx * half + x) * 4;
    data[k] = enc(r);
    data[k + 1] = enc(g);
    data[k + 2] = enc(b);
    data[k + 3] = enc(a);
  };

  for (let y = 0; y < half; y++) {
    const v = y / half;
    for (let x = 0; x < half; x++) {
      const u = x / half;
      const grain = grit.fbm(u, v);
      const lump = soft.fbm(u, v, 0.6);
      stones.sample(u, v, c);
      const pebble = 1 - smoothstep(0.12, 0.40, c[0]);

      // A hard vignette on every radial cell: the atlas is sampled with a
      // clamped wrap, so any alpha surviving to the cell border would show up
      // as a straight edge on the ground.
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r0 = Math.sqrt(dx * dx + dy * dy) * 2;
      const vignette = 1 - smoothstep(0.76, 1.0, r0);

      // --- contact: the dirt collar and occlusion where a mass meets ground.
      {
        const rad = r0 * (0.78 + 0.44 * lump);
        const core = 1 - smoothstep(0.10, 0.62, rad);
        const fringe = (1 - smoothstep(0.45, 1.0, rad)) * (0.35 + 0.5 * grain);
        const a = clamp(core * 0.86 + fringe * 0.34, 0, 1) * vignette;
        const shade = 0.34 - 0.16 * core + 0.12 * pebble * (1 - core);
        put(0, 0, x, y, shade * 1.06, shade * 0.94, shade * 0.78, a);
      }

      // --- rut: two wheel tracks with a churned crown between them.
      {
        const t1 = 1 - smoothstep(0.0, 0.115, Math.abs(u - 0.30));
        const t2 = 1 - smoothstep(0.0, 0.115, Math.abs(u - 0.70));
        const track = Math.max(t1, t2) * (0.72 + 0.28 * grain);
        const crown = (1 - smoothstep(0.0, 0.16, Math.abs(u - 0.5))) * 0.42;
        const edge = smoothstep(0.02, 0.16, u) * smoothstep(0.02, 0.16, 1 - u);
        // Tread chevrons pressed into the wet ground.
        const chev = 1 - smoothstep(0.0, 0.5, Math.abs(((v * 22 + Math.abs(u - 0.5) * 6) % 1) - 0.5) * 2);
        const a = clamp((track * 0.80 + crown * 0.30 + 0.16 * grain) * edge * (0.82 + 0.3 * lump), 0, 1);
        const wet = track * (0.55 + 0.45 * chev);
        const shade = 0.40 - 0.19 * wet + 0.10 * pebble * (1 - track);
        put(1, 0, x, y, shade * 1.10, shade * 0.95, shade * 0.74, a);
      }

      // --- scree: a spill of loose gravel, ragged at the edge.
      {
        const rad = r0 * (0.62 + 0.75 * lump);
        const body = 1 - smoothstep(0.35, 1.05, rad);
        const a = clamp(body * (0.30 + 0.70 * smoothstep(0.30, 0.72, pebble * 0.7 + grain * 0.6)), 0, 1) * vignette;
        const shade = 0.33 + 0.22 * pebble - 0.08 * grain;
        put(0, 1, x, y, shade * 1.02, shade * 0.99, shade * 0.93, a);
      }

      // --- scorch: soot with radial licks, for burnt-out hulls.
      {
        const ang = Math.atan2(dy, dx);
        const lick = 0.72 + 0.42 * soft.octave(2, (ang / (Math.PI * 2) + 0.5) % 1, 0.3);
        const rad = r0 / Math.max(lick, 0.2);
        const a = clamp((1 - smoothstep(0.18, 0.98, rad)) * (0.62 + 0.4 * grain), 0, 1) * vignette;
        const shade = 0.055 + 0.075 * grain + 0.05 * smoothstep(0.6, 1.0, rad);
        put(1, 1, x, y, shade, shade * 0.96, shade * 0.92, a);
      }
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}
