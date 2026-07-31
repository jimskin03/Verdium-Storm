import * as THREE from 'three';
import { clamp, makeRng, smoothstep, valueNoise2, worley2 } from '@/util/Noise';

/**
 * Every texture the vegetation and prop streams use is synthesised here at
 * boot: bark albedo/normal, the leaf-cluster atlas, stone, and the soft radial
 * sprites used for crystal glow. Nothing is fetched — the whole project's
 * constraint is that art is code.
 */

/* ------------------------------------------------------------------ noise -- */

/**
 * Value noise that tiles seamlessly over the unit square by cross-fading the
 * four period-shifted copies. `fu`/`fv` are the tile counts on each axis.
 */
function tileNoise(u: number, v: number, fu: number, fv: number, seed: number): number {
  const n = (a: number, b: number): number => valueNoise2(a * fu, b * fv, seed);
  const iu = 1 - u;
  const iv = 1 - v;
  return (
    n(u, v) * iu * iv + n(u - 1, v) * u * iv + n(u, v - 1) * iu * v + n(u - 1, v - 1) * u * v
  );
}

function tileFbm(u: number, v: number, fu: number, fv: number, seed: number, octaves = 3): number {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(u, v, fu * f, fv * f, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Sobel a height field into a tangent-space normal map. */
function heightToNormal(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)];
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
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      const k = (y * size + x) * 4;
      data[k] = Math.round((nx * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function albedoTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------- bark -- */

export interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
}

/**
 * Fibrous bark: vertical ridges of two frequencies, lumps, and deep cracks.
 * The height field feeds both the albedo ramp and a real normal map, so bark
 * catches the sun with genuine relief instead of reading as a flat brown tube.
 */
export function makeBarkTextures(size = 128, seed = 17): SurfaceTextures {
  const h = new Float32Array(size * size);
  const rgb = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const warp = tileNoise(u, v, 3, 1, seed) * 0.9;
      const warp2 = tileNoise(u, v, 7, 2, seed + 31) * 0.55;
      // Primary and secondary vertical fibres. Integer wave counts keep the
      // cylinder seam invisible where u wraps.
      let value = 0.5 + 0.5 * Math.cos(u * TAU * 9 + warp * 4.4 + v * 0.9);
      value = value * value;
      let fine = 0.5 + 0.5 * Math.cos(u * TAU * 27 + warp2 * 5.2 + v * 2.1);
      const lumps = tileFbm(u, v, 5, 2, seed + 77, 3) * 0.5 + 0.5;
      let height = value * 0.52 + fine * 0.18 + lumps * 0.42;

      // Cracks: dark, deep, following the fibre direction.
      const crack = smoothstep(0.42, 0.86, Math.abs(tileNoise(u, v, 11, 2.4, seed + 211)));
      height -= crack * 0.55;
      height = clamp(height, 0, 1);
      h[y * size + x] = height;

      // Albedo ramp: wet-dark crevice through to sun-bleached ridge.
      const t = height;
      const r = 0.128 + 0.36 * t + 0.06 * lumps;
      const g = 0.104 + 0.30 * t + 0.05 * lumps;
      const b = 0.082 + 0.21 * t + 0.03 * lumps;
      const k = (y * size + x) * 4;
      rgb[k] = Math.round(clamp(r, 0, 1) * 255);
      rgb[k + 1] = Math.round(clamp(g, 0, 1) * 255);
      rgb[k + 2] = Math.round(clamp(b, 0, 1) * 255);
      rgb[k + 3] = 255;
    }
  }

  return { map: albedoTexture(rgb, size), normalMap: heightToNormal(h, size, 2.6) };
}

/* ------------------------------------------------------------------ stone -- */

/** Weathered granite: cellular fracture planes over broad mottling. */
export function makeStoneTextures(size = 128, seed = 91): SurfaceTextures {
  const h = new Float32Array(size * size);
  const rgb = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const broad = tileFbm(u, v, 4, 4, seed, 3) * 0.5 + 0.5;
      const grain = tileFbm(u, v, 18, 18, seed + 55, 2) * 0.5 + 0.5;
      const cells = worley2(u * 7, v * 7, seed + 313);
      const fracture = smoothstep(0.02, 0.24, cells);
      const height = clamp(broad * 0.55 + grain * 0.25 + fracture * 0.35 - 0.1, 0, 1);
      h[y * size + x] = height;

      const shade = 0.34 + 0.34 * height + 0.1 * grain;
      const warm = 0.02 * broad;
      const k = (y * size + x) * 4;
      rgb[k] = Math.round(clamp(shade + warm, 0, 1) * 255);
      rgb[k + 1] = Math.round(clamp(shade + warm * 0.6, 0, 1) * 255);
      rgb[k + 2] = Math.round(clamp(shade * 0.96, 0, 1) * 255);
      rgb[k + 3] = 255;
    }
  }

  return { map: albedoTexture(rgb, size), normalMap: heightToNormal(h, size, 2.2) };
}

/* -------------------------------------------------------- cutout uploads -- */

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LINEAR_TO_SRGB = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.round(clamp(s, 0, 1) * 255);
}

function encodeSrgb(linear: number): number {
  return LINEAR_TO_SRGB[clamp(Math.round(linear * 4095), 0, 4095)];
}

interface MipLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Floods the artwork's colour outward into its transparent margin.
 *
 * A 2D canvas leaves RGB at zero wherever nothing was painted, so every filter
 * that touches those texels — bilinear magnification at the cut-out edge, and
 * every mip reduction — averages black into the result. That is precisely why
 * alpha-cut foliage renders as a green card up close and a black silhouette at
 * distance. Pushing real colour into the margin makes the filtering harmless.
 */
function dilateColor(data: Uint8Array, w: number, h: number, rings: number): void {
  const n = w * h;
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  const queued = new Uint8Array(n);
  let frontier: number[] = [];

  const enqueueAround = (x: number, y: number): void => {
    const yLo = Math.max(0, y - 1);
    const yHi = Math.min(h - 1, y + 1);
    const xLo = Math.max(0, x - 1);
    const xHi = Math.min(w - 1, x + 1);
    for (let yy = yLo; yy <= yHi; yy++) {
      for (let xx = xLo; xx <= xHi; xx++) {
        const j = yy * w + xx;
        if (filled[j] === 1 || queued[j] === 1) continue;
        queued[j] = 1;
        frontier.push(j);
      }
    }
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (filled[y * w + x] === 1) enqueueAround(x, y);
    }
  }

  for (let ring = 0; ring < rings && frontier.length > 0; ring++) {
    const grown: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i / w) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      const yLo = Math.max(0, y - 1);
      const yHi = Math.min(h - 1, y + 1);
      const xLo = Math.max(0, x - 1);
      const xHi = Math.min(w - 1, x + 1);
      for (let yy = yLo; yy <= yHi; yy++) {
        for (let xx = xLo; xx <= xHi; xx++) {
          const j = yy * w + xx;
          if (filled[j] === 0) continue;
          r += data[j * 4];
          g += data[j * 4 + 1];
          b += data[j * 4 + 2];
          c++;
        }
      }
      if (c === 0) continue;
      data[i * 4] = (r / c) | 0;
      data[i * 4 + 1] = (g / c) | 0;
      data[i * 4 + 2] = (b / c) | 0;
      grown.push(i);
    }
    for (const i of grown) filled[i] = 1;
    frontier = [];
    for (const i of grown) enqueueAround(i % w, (i / w) | 0);
  }
}

/**
 * One mip reduction. RGB is averaged in linear light and weighted by alpha, so
 * a texel that contributes no coverage contributes no colour either; alpha is
 * averaged straight, because it is coverage and coverage is linear.
 */
function reduceLevel(src: Uint8Array, w: number, h: number): MipLevel {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2);
    const y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2);
      const x1 = Math.min(w - 1, x * 2 + 1);
      let rw = 0;
      let gw = 0;
      let bw = 0;
      let rp = 0;
      let gp = 0;
      let bp = 0;
      let aw = 0;
      for (let s = 0; s < 4; s++) {
        const j = ((s < 2 ? y0 : y1) * w + (s % 2 === 0 ? x0 : x1)) * 4;
        const a = src[j + 3] / 255;
        const r = SRGB_TO_LINEAR[src[j]];
        const g = SRGB_TO_LINEAR[src[j + 1]];
        const b = SRGB_TO_LINEAR[src[j + 2]];
        rw += r * a;
        gw += g * a;
        bw += b * a;
        rp += r;
        gp += g;
        bp += b;
        aw += a;
      }
      const k = (y * nw + x) * 4;
      if (aw > 1e-4) {
        out[k] = encodeSrgb(rw / aw);
        out[k + 1] = encodeSrgb(gw / aw);
        out[k + 2] = encodeSrgb(bw / aw);
      } else {
        out[k] = encodeSrgb(rp * 0.25);
        out[k + 1] = encodeSrgb(gp * 0.25);
        out[k + 2] = encodeSrgb(bp * 0.25);
      }
      out[k + 3] = Math.round(aw * 0.25 * 255);
    }
  }
  return { data: out, width: nw, height: nh };
}

function cellCoverage(
  level: MipLevel, x0: number, y0: number, size: number, ref: number, scale: number,
): number {
  let hit = 0;
  for (let y = y0; y < y0 + size; y++) {
    const o = y * level.width;
    for (let x = x0; x < x0 + size; x++) {
      if (level.data[(o + x) * 4 + 3] * scale >= ref) hit++;
    }
  }
  return hit / (size * size);
}

/**
 * Rescales each mip level's alpha so the fraction of texels surviving the alpha
 * test matches the full-resolution artwork. Without it a box-filtered cut-out
 * loses coverage every level and a distant canopy dissolves into a wire frame —
 * the reason foliage LODs classically "thin out" as they recede. Solved per
 * atlas cell, because sparse conifer sprigs and dense broadleaf clusters need
 * very different corrections.
 */
function preserveCoverage(levels: MipLevel[], cells: number, alphaRef: number): void {
  const ref = alphaRef * 255;
  const base = levels[0];
  const baseCell = base.width / cells;
  const target: number[] = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      target.push(cellCoverage(base, cx * baseCell, cy * baseCell, baseCell, ref, 1));
    }
  }

  for (let l = 1; l < levels.length; l++) {
    const lv = levels[l];
    const size = lv.width / cells;
    if (size < 2) break;
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const want = target[cy * cells + cx];
        if (want < 0.002 || want > 0.985) continue;
        const x0 = cx * size;
        const y0 = cy * size;
        let lo = 0.35;
        let hi = 4.0;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) * 0.5;
          if (cellCoverage(lv, x0, y0, size, ref, mid) < want) lo = mid;
          else hi = mid;
        }
        const scale = (lo + hi) * 0.5;
        for (let y = y0; y < y0 + size; y++) {
          const o = y * lv.width;
          for (let x = x0; x < x0 + size; x++) {
            const k = (o + x) * 4 + 3;
            lv.data[k] = Math.min(255, Math.round(lv.data[k] * scale));
          }
        }
      }
    }
  }
}

/**
 * Uploads alpha-cut artwork as a texture with a hand-built mip chain.
 *
 * Letting the driver do it is what breaks cut-outs: `glGenerateMipmap` averages
 * RGB and A independently, which bleeds the transparent margin's colour into
 * the visible texels and erodes coverage at every level.
 */
export function makeCutoutTexture(
  canvas: HTMLCanvasElement,
  alphaRef: number,
  cells: number,
): THREE.DataTexture {
  const w = canvas.width;
  const h = canvas.height;
  const src = canvas.getContext('2d')!.getImageData(0, 0, w, h);
  const base = new Uint8Array(src.data.buffer.slice(0));

  dilateColor(base, w, h, 10);

  const levels: MipLevel[] = [{ data: base, width: w, height: h }];
  while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1) {
    const prev = levels[levels.length - 1];
    const next = reduceLevel(prev.data, prev.width, prev.height);
    // Two more rings per level keeps colour ahead of the shrinking footprint,
    // so even the 4x4 tail carries canopy green rather than a black average.
    dilateColor(next.data, next.width, next.height, 2);
    levels.push(next);
  }
  preserveCoverage(levels, cells, alphaRef);

  const tex = new THREE.DataTexture(base, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------ leaf atlas -- */

export interface AtlasCell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface LeafAtlas {
  texture: THREE.Texture;
  /** Named groups of cells; pick randomly within a group per card. */
  broadleaf: AtlasCell[];
  birch: AtlasCell[];
  needle: AtlasCell[];
  autumn: AtlasCell[];
  fern: AtlasCell[];
  bush: AtlasCell[];
  tuft: AtlasCell[];
}

const ATLAS_DIM = 4; // 4x4 cells

/**
 * The alpha test every material sampling this atlas must use. Mip coverage is
 * corrected against this exact threshold, so a material that cuts somewhere
 * else would reintroduce the LOD thinning the correction exists to remove.
 */
export const LEAF_ALPHA_REF = 0.42;

function cellRect(index: number, res: number): { x: number; y: number; s: number } {
  const s = res / ATLAS_DIM;
  return { x: (index % ATLAS_DIM) * s, y: Math.floor(index / ATLAS_DIM) * s, s };
}

function cellUv(index: number): AtlasCell {
  const s = 1 / ATLAS_DIM;
  const cx = (index % ATLAS_DIM) * s;
  const cy = 1 - (Math.floor(index / ATLAS_DIM) + 1) * s;
  const inset = s * 0.012; // keeps mip bleed out of neighbouring cells
  return { u0: cx + inset, v0: cy + inset, u1: cx + s - inset, v1: cy + s - inset };
}

function leafPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  len: number,
  wid: number,
  ang: number,
  pointy: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid, -len * 0.22, wid * pointy, -len * 0.72, 0, -len);
  ctx.bezierCurveTo(-wid * pointy, -len * 0.72, -wid, -len * 0.22, 0, 0);
  ctx.closePath();
  ctx.restore();
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

interface ClusterStyle {
  count: number;
  hue: [number, number, number];
  spread: number;
  leafLen: number;
  leafWid: number;
  pointy: number;
  twigs: number;
}

function drawCluster(
  ctx: CanvasRenderingContext2D,
  cell: { x: number; y: number; s: number },
  style: ClusterStyle,
  rng: () => number,
): void {
  const { x, y, s } = cell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();

  const cx = x + s * 0.5;
  const cy = y + s * 0.56;
  const R = s * style.spread;

  // Twigs first so leaves sit on top of them.
  ctx.lineCap = 'round';
  for (let i = 0; i < style.twigs; i++) {
    const a = -Math.PI * 0.5 + (rng() - 0.5) * 2.4;
    const len = R * (0.5 + rng() * 0.7);
    ctx.strokeStyle = rgb(58 + rng() * 22, 44 + rng() * 16, 30 + rng() * 12);
    ctx.lineWidth = s * (0.008 + rng() * 0.008);
    ctx.beginPath();
    ctx.moveTo(cx, y + s * 0.97);
    ctx.quadraticCurveTo(cx + Math.cos(a) * len * 0.4, cy + Math.sin(a) * len * 0.5, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }

  interface Leaf { px: number; py: number; len: number; wid: number; ang: number; depth: number; }
  const leaves: Leaf[] = [];
  for (let i = 0; i < style.count; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng());
    const px = cx + Math.cos(a) * R * rr;
    const py = cy + Math.sin(a) * R * rr * 0.86;
    const len = s * style.leafLen * (0.62 + rng() * 0.75);
    leaves.push({
      px,
      py,
      len,
      wid: len * style.leafWid * (0.8 + rng() * 0.5),
      ang: rng() * Math.PI * 2,
      depth: rr * 0.55 + rng() * 0.45,
    });
  }
  // Back-to-front so interior leaves read as shadowed.
  leaves.sort((a, b) => b.depth - a.depth);

  for (const l of leaves) {
    const shade = 0.42 + 0.58 * (1 - l.depth);
    const jitter = 0.86 + rng() * 0.3;
    leafPath(ctx, l.px, l.py, l.len, l.wid, l.ang, style.pointy);
    ctx.fillStyle = rgb(
      style.hue[0] * shade * jitter,
      style.hue[1] * shade * jitter,
      style.hue[2] * shade * jitter,
    );
    ctx.fill();
    // Midrib.
    if (l.len > s * 0.05) {
      ctx.save();
      ctx.translate(l.px, l.py);
      ctx.rotate(l.ang);
      ctx.strokeStyle = rgb(style.hue[0] * shade * 0.62, style.hue[1] * shade * 0.62, style.hue[2] * shade * 0.62);
      ctx.lineWidth = Math.max(0.6, l.len * 0.045);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -l.len * 0.92);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawNeedleSprig(
  ctx: CanvasRenderingContext2D,
  cell: { x: number; y: number; s: number },
  hue: [number, number, number],
  rng: () => number,
): void {
  const { x, y, s } = cell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();
  ctx.lineCap = 'round';

  const stems = 5;
  for (let st = 0; st < stems; st++) {
    const baseX = x + s * (0.5 + (rng() - 0.5) * 0.18);
    const baseY = y + s * 0.99;
    const ang = -Math.PI * 0.5 + (rng() - 0.5) * 1.5;
    const len = s * (0.5 + rng() * 0.45);
    const tipX = baseX + Math.cos(ang) * len;
    const tipY = baseY + Math.sin(ang) * len;
    ctx.strokeStyle = rgb(62, 50, 34);
    ctx.lineWidth = s * 0.012;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    const needles = 34;
    for (let i = 0; i < needles; i++) {
      const t = i / needles;
      const px = baseX + (tipX - baseX) * t;
      const py = baseY + (tipY - baseY) * t;
      const side = i % 2 === 0 ? 1 : -1;
      const nl = s * (0.13 + rng() * 0.1) * (1 - t * 0.45);
      const na = ang + side * (0.75 + rng() * 0.45);
      const shade = 0.6 + rng() * 0.5;
      ctx.strokeStyle = rgb(hue[0] * shade, hue[1] * shade, hue[2] * shade);
      ctx.lineWidth = Math.max(0.9, s * 0.011);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawFrond(
  ctx: CanvasRenderingContext2D,
  cell: { x: number; y: number; s: number },
  hue: [number, number, number],
  rng: () => number,
): void {
  const { x, y, s } = cell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();

  const baseX = x + s * 0.5;
  const baseY = y + s * 0.99;
  const tipX = baseX + (rng() - 0.5) * s * 0.14;
  const tipY = y + s * 0.04;
  const bow = s * (rng() - 0.5) * 0.28;

  const pointOn = (t: number): [number, number] => {
    const mx = (baseX + tipX) * 0.5 + bow;
    const px = (1 - t) * (1 - t) * baseX + 2 * (1 - t) * t * mx + t * t * tipX;
    const py = (1 - t) * (1 - t) * baseY + 2 * (1 - t) * t * ((baseY + tipY) * 0.5) + t * t * tipY;
    return [px, py];
  };

  ctx.strokeStyle = rgb(hue[0] * 0.5, hue[1] * 0.55, hue[2] * 0.4);
  ctx.lineWidth = s * 0.016;
  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  for (let i = 1; i <= 16; i++) {
    const [px, py] = pointOn(i / 16);
    ctx.lineTo(px, py);
  }
  ctx.stroke();

  const pinnae = 26;
  for (let i = 2; i <= pinnae; i++) {
    const t = i / pinnae;
    const [px, py] = pointOn(t);
    const [px2, py2] = pointOn(Math.min(1, t + 0.02));
    const ang = Math.atan2(py2 - py, px2 - px);
    const len = s * 0.3 * Math.sin(Math.PI * Math.min(1, t * 1.25)) * (0.7 + rng() * 0.5);
    for (const side of [-1, 1]) {
      const shade = 0.62 + rng() * 0.5;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang + side * 1.05);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * 0.35, -len * 0.18, len, 0);
      ctx.quadraticCurveTo(len * 0.35, len * 0.16, 0, 0);
      ctx.closePath();
      ctx.fillStyle = rgb(hue[0] * shade, hue[1] * shade, hue[2] * shade);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawTuft(
  ctx: CanvasRenderingContext2D,
  cell: { x: number; y: number; s: number },
  hue: [number, number, number],
  rng: () => number,
): void {
  const { x, y, s } = cell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();
  for (let i = 0; i < 26; i++) {
    const bx = x + s * (0.5 + (rng() - 0.5) * 0.5);
    const by = y + s * 0.995;
    const lean = (rng() - 0.5) * 1.35;
    const len = s * (0.42 + rng() * 0.52);
    const tipX = bx + Math.sin(lean) * len * 0.75;
    const tipY = by - Math.cos(lean * 0.5) * len;
    const w = s * (0.014 + rng() * 0.016);
    const shade = 0.55 + rng() * 0.6;
    ctx.beginPath();
    ctx.moveTo(bx - w, by);
    ctx.quadraticCurveTo(bx + (tipX - bx) * 0.4 - w * 0.4, by - len * 0.55, tipX, tipY);
    ctx.quadraticCurveTo(bx + (tipX - bx) * 0.4 + w * 0.4, by - len * 0.55, bx + w, by);
    ctx.closePath();
    ctx.fillStyle = rgb(hue[0] * shade, hue[1] * shade, hue[2] * shade);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * One atlas for every alpha-tested card in the world. Sixteen 256px cells:
 * broadleaf and birch clusters, conifer sprigs, autumn litter, fern fronds,
 * bush sprigs and weed tufts.
 */
export function makeLeafAtlas(res = 1024): LeafAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, res, res);

  const rng = makeRng(0x5eed1eaf);

  const broad: ClusterStyle = { count: 46, hue: [96, 138, 58], spread: 0.34, leafLen: 0.2, leafWid: 0.36, pointy: 0.85, twigs: 4 };
  const broadDark: ClusterStyle = { ...broad, hue: [72, 112, 48], count: 54 };
  const birch: ClusterStyle = { count: 62, hue: [136, 172, 78], spread: 0.33, leafLen: 0.15, leafWid: 0.5, pointy: 0.7, twigs: 5 };
  const autumn: ClusterStyle = { count: 40, hue: [154, 108, 44], spread: 0.32, leafLen: 0.19, leafWid: 0.4, pointy: 0.8, twigs: 4 };

  drawCluster(ctx, cellRect(0, res), broad, rng);
  drawCluster(ctx, cellRect(1, res), broadDark, rng);
  drawCluster(ctx, cellRect(2, res), { ...broad, count: 38, spread: 0.3 }, rng);
  drawCluster(ctx, cellRect(3, res), { ...broadDark, count: 44, leafLen: 0.24 }, rng);
  drawCluster(ctx, cellRect(4, res), birch, rng);
  drawCluster(ctx, cellRect(5, res), { ...birch, hue: [148, 180, 92], count: 54 }, rng);
  drawNeedleSprig(ctx, cellRect(6, res), [58, 98, 62], rng);
  drawNeedleSprig(ctx, cellRect(7, res), [46, 82, 56], rng);
  drawNeedleSprig(ctx, cellRect(8, res), [66, 106, 66], rng);
  drawCluster(ctx, cellRect(9, res), autumn, rng);
  drawCluster(ctx, cellRect(10, res), { ...autumn, hue: [128, 86, 40], count: 32 }, rng);
  drawFrond(ctx, cellRect(11, res), [84, 128, 54], rng);
  drawFrond(ctx, cellRect(12, res), [96, 140, 60], rng);
  drawCluster(ctx, cellRect(13, res), { count: 52, hue: [82, 120, 52], spread: 0.36, leafLen: 0.13, leafWid: 0.62, pointy: 0.6, twigs: 6 }, rng);
  drawTuft(ctx, cellRect(14, res), [118, 138, 62], rng);
  drawTuft(ctx, cellRect(15, res), [138, 146, 74], rng);

  // Uploaded through the cut-out path, not as a CanvasTexture: driver-generated
  // mips would average the transparent margin's black into every leaf and turn
  // the whole distant forest into silhouettes.
  const texture = makeCutoutTexture(canvas, LEAF_ALPHA_REF, ATLAS_DIM);
  texture.name = 'leaf-atlas';

  return {
    texture,
    broadleaf: [0, 1, 2, 3].map(cellUv),
    birch: [4, 5].map(cellUv),
    needle: [6, 7, 8].map(cellUv),
    autumn: [9, 10].map(cellUv),
    fern: [11, 12].map(cellUv),
    bush: [13].map(cellUv),
    tuft: [14, 15].map(cellUv),
  };
}

/* ----------------------------------------------------------- glow sprite -- */

/** Soft radial falloff used for crystal ground bleed and floating motes. */
export function makeGlowSprite(res = 128, power = 2.4): THREE.Texture {
  const data = new Uint8Array(res * res * 4);
  const c = (res - 1) * 0.5;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const d = Math.min(1, Math.hypot(x - c, y - c) / c);
      const a = Math.pow(1 - d, power);
      const k = (y * res + x) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
