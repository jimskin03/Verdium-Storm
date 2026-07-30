/**
 * A display typeface, authored in code and compiled to a TrueType binary at
 * runtime.
 *
 * The project forbids external assets, which rules out a downloaded font — and
 * the container only ships Liberation/DejaVu, i.e. Arial and friends. Shipping
 * a HUD set in Arial is the single loudest "this is a web page" tell there is,
 * so the face is drawn here instead: a condensed, modular, chamfered military
 * grotesque on a 1000-unit em, cap-height 700, single weight, caps only.
 *
 * Two consumers share one glyph source:
 *   1. {@link installDisplayFont} compiles the outlines into a `glyf`-flavoured
 *      TTF and registers it through the FontFace API, so ordinary DOM text can
 *      use it at any size with real letter-spacing and subpixel positioning.
 *   2. {@link drawDisplayText} rasterises the same outlines straight onto a
 *      canvas for the menu wordmark, where the glyphs get bevels and gradients
 *      no font file could carry.
 *
 * Characters with no outline are simply absent from `cmap`, so the browser
 * falls through to the next family in the stack per-character. A failure to
 * compile or load degrades the whole HUD to the fallback stack and nothing else.
 */

/** Contours are flat [x0,y0,x1,y1,…] arrays in font units, y-up. */
type Contour = number[];

interface GlyphDef {
  /** Ink width; side bearings are added on top. */
  w: number;
  contours: Contour[];
}

export const EM = 1000;
export const CAP = 700;
const STROKE = 108;
const SIDE = 48;

// ---------------------------------------------------------------------------
// contour construction helpers
// ---------------------------------------------------------------------------

function signedArea(c: Contour): number {
  let a = 0;
  for (let i = 0; i < c.length; i += 2) {
    const j = (i + 2) % c.length;
    a += c[i] * c[j + 1] - c[j] * c[i + 1];
  }
  return a * 0.5;
}

function reverse(c: Contour): Contour {
  const out: Contour = [];
  for (let i = c.length - 2; i >= 0; i -= 2) out.push(c[i], c[i + 1]);
  return out;
}

/** Outer contour: TrueType fills non-zero, outer contours run clockwise (y-up). */
function outer(c: Contour): Contour {
  return signedArea(c) > 0 ? reverse(c) : c;
}

/** Hole contour: opposite winding to the shape that encloses it. */
function hole(c: Contour): Contour {
  return signedArea(c) < 0 ? reverse(c) : c;
}

/** Axis-aligned rectangle. */
function rect(x0: number, y0: number, x1: number, y1: number): Contour {
  return outer([x0, y1, x1, y1, x1, y0, x0, y0]);
}

/** Rectangle with per-corner 45° chamfers: [topLeft, topRight, botRight, botLeft]. */
function cham(
  x0: number, y0: number, x1: number, y1: number,
  tl = 0, tr = 0, br = 0, bl = 0,
): Contour {
  const p: number[] = [];
  const push = (x: number, y: number): void => {
    const n = p.length;
    if (n >= 2 && p[n - 2] === x && p[n - 1] === y) return;
    p.push(x, y);
  };
  push(x0 + tl, y1);
  push(x1 - tr, y1);
  push(x1, y1 - tr);
  push(x1, y0 + br);
  push(x1 - br, y0);
  push(x0 + bl, y0);
  push(x0, y0 + bl);
  push(x0, y1 - tl);
  if (p.length >= 4 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) p.length -= 2;
  return outer(p);
}

/**
 * The chamfered elbow where a horizontal and a vertical stroke meet at an outer
 * corner. `sx`/`sy` are ±1 and point in the directions the two strokes run from
 * the corner. Union of bars cannot subtract a chamfer, so open letterforms get
 * their cut corners from this piece and their bars simply stop short of it.
 */
function elbow(cx: number, cy: number, sx: number, sy: number, s = STROKE, k = 96): Contour {
  const p = (a: number, b: number): number[] => [cx + sx * a, cy + sy * b];
  return outer([
    ...p(0, k), ...p(k, 0), ...p(s + k, 0), ...p(s + k, s),
    ...p(s, s), ...p(s, s + k), ...p(0, s + k),
  ]);
}

/** Reach of {@link elbow} along each arm. */
const EL = STROKE + 96;

/** Chamfered rectangular ring — a closed bowl with a counter. */
function ring(
  x0: number, y0: number, x1: number, y1: number, s: number,
  tl = 0, tr = 0, br = 0, bl = 0,
): Contour[] {
  const k = 0.5;
  return [
    cham(x0, y0, x1, y1, tl, tr, br, bl),
    hole(cham(x0 + s, y0 + s, x1 - s, y1 - s, tl * k, tr * k, br * k, bl * k)),
  ];
}

/**
 * Diagonal bar with horizontal-cut ends: spans [ax0,ax1] at `ay` and
 * [bx0,bx1] at `by`. Ends stay flush with the cap line, which is what gives
 * the face its stencil-cut look.
 */
function bar(ax0: number, ax1: number, ay: number, bx0: number, bx1: number, by: number): Contour {
  return outer([ax0, ay, ax1, ay, bx1, by, bx0, by]);
}

const T = CAP;
const S = STROKE;

// ---------------------------------------------------------------------------
// glyph set
// ---------------------------------------------------------------------------

const G: Record<string, GlyphDef> = {
  ' ': { w: 210, contours: [] },

  A: {
    w: 560,
    contours: [
      bar(0, 150, 0, 215, 345, T),
      bar(410, 560, 0, 215, 345, T),
      rect(120, 224, 440, 332),
    ],
  },
  B: {
    w: 520,
    contours: [
      ...ring(0, 296, 470, T, S, 0, 96, 96, 0),
      ...ring(0, 0, 500, 404, S, 0, 96, 96, 0),
    ],
  },
  C: {
    w: 540,
    contours: [
      outer([
        96, T, 540, T, 540, 592, 156, 592, 108, 544,
        108, 156, 156, 108, 540, 108, 540, 0, 96, 0, 0, 96, 0, 604,
      ]),
    ],
  },
  D: { w: 540, contours: ring(0, 0, 540, T, S, 0, 118, 118, 0) },
  E: {
    w: 500,
    contours: [rect(0, 0, S, T), rect(0, 592, 500, T), rect(0, 296, 420, 404), rect(0, 0, 500, S)],
  },
  F: { w: 490, contours: [rect(0, 0, S, T), rect(0, 592, 490, T), rect(0, 296, 410, 404)] },
  G: {
    w: 560,
    contours: [
      outer([
        96, T, 560, T, 560, 592, 156, 592, 108, 544,
        108, 156, 156, 108, 560, 108, 560, 0, 96, 0, 0, 96, 0, 604,
      ]),
      rect(452, 0, 560, 404),
      rect(280, 296, 560, 404),
    ],
  },
  H: { w: 560, contours: [rect(0, 0, S, T), rect(452, 0, 560, T), rect(0, 296, 560, 404)] },
  I: { w: 108, contours: [rect(0, 0, S, T)] },
  J: {
    w: 500,
    contours: [rect(392, 0, 500, T), rect(EL, 0, 392, S), elbow(0, 0, 1, 1)],
  },
  K: {
    w: 545,
    contours: [
      rect(0, 0, S, T),
      bar(84, 246, 350, 380, 545, T),
      bar(84, 246, 350, 380, 545, 0),
    ],
  },
  L: { w: 490, contours: [rect(0, 0, S, T), rect(0, 0, 490, S)] },
  M: {
    w: 660,
    contours: [
      rect(0, 0, S, T),
      rect(552, 0, 660, T),
      bar(0, 128, T, 268, 392, 300),
      bar(532, 660, T, 268, 392, 300),
    ],
  },
  N: { w: 560, contours: [rect(0, 0, S, T), rect(452, 0, 560, T), bar(0, 200, T, 360, 560, 0)] },
  O: { w: 560, contours: ring(0, 0, 560, T, S, 118, 118, 118, 118) },
  P: { w: 520, contours: [rect(0, 0, S, T), ...ring(0, 288, 500, T, S, 0, 96, 96, 0)] },
  Q: {
    w: 560,
    contours: [
      ...ring(0, 0, 560, T, S, 118, 118, 118, 118),
      bar(300, 424, 210, 444, 568, -34),
    ],
  },
  R: {
    w: 540,
    contours: [rect(0, 0, S, T), ...ring(0, 288, 500, T, S, 0, 96, 96, 0), bar(232, 372, 296, 400, 540, 0)],
  },
  S: {
    w: 520,
    contours: [
      elbow(0, T, 1, -1),
      rect(EL, 592, 520, T),
      rect(0, 404, S, T - EL),
      rect(0, 296, 520, 404),
      rect(412, EL, 520, 296),
      elbow(520, 0, -1, 1),
      rect(0, 0, 520 - EL, S),
    ],
  },
  T: { w: 520, contours: [rect(206, 0, 314, T), rect(0, 592, 520, T)] },
  U: {
    w: 560,
    contours: [
      rect(0, EL, S, T), rect(452, EL, 560, T), rect(EL, 0, 560 - EL, S),
      elbow(0, 0, 1, 1), elbow(560, 0, -1, 1),
    ],
  },
  V: { w: 560, contours: [bar(0, 160, T, 230, 330, 0), bar(400, 560, T, 230, 330, 0)] },
  W: {
    w: 760,
    contours: [
      bar(0, 140, T, 116, 226, 0),
      bar(116, 226, 0, 322, 438, T),
      bar(322, 438, T, 534, 644, 0),
      bar(534, 644, 0, 620, 760, T),
    ],
  },
  X: { w: 560, contours: [bar(0, 160, T, 400, 560, 0), bar(400, 560, T, 0, 160, 0)] },
  Y: {
    w: 560,
    contours: [bar(0, 150, T, 226, 334, 372), bar(410, 560, T, 226, 334, 372), rect(226, 0, 334, 392)],
  },
  Z: { w: 540, contours: [rect(0, 592, 540, T), rect(0, 0, 540, S), bar(370, 540, 592, 0, 170, S)] },

  '0': {
    w: 520,
    contours: [...ring(0, 0, 520, T, S, 108, 108, 108, 108), bar(150, 240, 230, 280, 370, 470)],
  },
  '1': { w: 340, contours: [rect(196, 0, 304, T), bar(70, 196, 560, 160, 196, T)] },
  '2': {
    w: 520,
    contours: [
      elbow(0, T, 1, -1), rect(EL, 592, 520 - EL, T), elbow(520, T, -1, -1),
      rect(412, 380, 520, T - EL), bar(370, 520, 404, 0, 150, S), rect(0, 0, 520, S),
    ],
  },
  '3': {
    w: 520,
    contours: [
      elbow(0, T, 1, -1), rect(EL, 592, 520 - EL, T), elbow(520, T, -1, -1),
      rect(412, 404, 520, T - EL), rect(150, 296, 520, 404), rect(412, EL, 520, 296),
      elbow(520, 0, -1, 1), rect(EL, 0, 520 - EL, S), elbow(0, 0, 1, 1),
    ],
  },
  '4': { w: 540, contours: [bar(268, 388, T, 40, 160, 216), rect(0, 216, 540, 324), rect(340, 0, 448, T)] },
  '5': {
    w: 520,
    contours: [
      rect(0, 592, 520, T), rect(0, 296, S, 592), rect(0, 296, 520 - EL, 404),
      elbow(520, 404, -1, -1), elbow(520, 0, -1, 1), rect(EL, 0, 520 - EL, S), elbow(0, 0, 1, 1),
    ],
  },
  '6': {
    w: 520,
    contours: [
      ...ring(0, 0, 520, 404, S, 96, 96, 96, 96),
      rect(0, 404, S, T - EL), elbow(0, T, 1, -1), rect(EL, 592, 520, T),
    ],
  },
  '7': { w: 500, contours: [rect(0, 592, 500, T), bar(360, 500, 592, 90, 230, 0)] },
  '8': {
    w: 520,
    contours: [...ring(0, 296, 520, T, S, 96, 96, 96, 96), ...ring(0, 0, 520, 404, S, 96, 96, 96, 96)],
  },
  '9': {
    w: 520,
    contours: [
      ...ring(0, 296, 520, T, S, 96, 96, 96, 96),
      rect(412, EL, 520, 296), elbow(520, 0, -1, 1), rect(0, 0, 520 - EL, S),
    ],
  },

  '.': { w: 130, contours: [rect(0, 0, 130, 130)] },
  ',': { w: 150, contours: [rect(20, 0, 150, 130), bar(20, 150, 0, -60, 70, -140)] },
  ':': { w: 130, contours: [rect(0, 96, 130, 226), rect(0, 440, 130, 570)] },
  '·': { w: 140, contours: [rect(10, 290, 140, 420)] },
  '-': { w: 340, contours: [rect(0, 296, 340, 404)] },
  '–': { w: 460, contours: [rect(0, 296, 460, 404)] },
  '—': { w: 620, contours: [rect(0, 296, 620, 404)] },
  '_': { w: 480, contours: [rect(0, -120, 480, -20)] },
  '/': { w: 440, contours: [bar(300, 440, T, 0, 140, -20)] },
  '\\': { w: 440, contours: [bar(0, 140, T, 300, 440, -20)] },
  '|': { w: 108, contours: [rect(0, -40, S, 740)] },
  '+': { w: 460, contours: [rect(0, 296, 460, 404), rect(176, 120, 284, 580)] },
  '=': { w: 460, contours: [rect(0, 176, 460, 284), rect(0, 416, 460, 524)] },
  '!': { w: 130, contours: [rect(0, 210, 130, T), rect(0, 0, 130, 130)] },
  '?': {
    w: 440,
    contours: [rect(0, 560, 440, T), rect(332, 340, 440, 592), rect(166, 240, 274, 372), rect(166, 0, 274, 130)],
  },
  '%': {
    w: 640,
    contours: [
      ...ring(0, 400, 260, T, 84, 40, 40, 40, 40),
      ...ring(380, 0, 640, 300, 84, 40, 40, 40, 40),
      bar(400, 520, T, 120, 240, 0),
    ],
  },
  '(': { w: 250, contours: [outer([250, T, 60, 400, 60, 300, 250, 0, 250, 120, 168, 320, 168, 380, 250, 580])] },
  ')': { w: 250, contours: [outer([0, T, 190, 400, 190, 300, 0, 0, 0, 120, 82, 320, 82, 380, 0, 580])] },
  '[': { w: 280, contours: [rect(0, 0, 108, T), rect(0, 592, 280, T), rect(0, 0, 280, S)] },
  ']': { w: 280, contours: [rect(172, 0, 280, T), rect(0, 592, 280, T), rect(0, 0, 280, S)] },
  '<': { w: 420, contours: [bar(280, 420, T, 20, 160, 380), bar(20, 160, 320, 280, 420, 0)] },
  '>': { w: 420, contours: [bar(0, 140, T, 260, 400, 380), bar(260, 400, 320, 0, 140, 0)] },
  '#': {
    w: 620,
    contours: [rect(0, 200, 620, 296), rect(0, 420, 620, 516), bar(150, 250, T, 90, 190, 0), bar(400, 500, T, 340, 440, 0)],
  },
  '*': { w: 400, contours: [rect(146, 380, 254, 700), bar(20, 74, 700, 326, 380, 420), bar(326, 380, 700, 20, 74, 420)] },
  "'": { w: 130, contours: [rect(10, 470, 118, T)] },
  '°': { w: 300, contours: ring(30, 430, 270, T, 76, 30, 30, 30, 30) },
  '×': { w: 400, contours: [bar(0, 110, 520, 290, 400, 180), bar(290, 400, 520, 0, 110, 180)] },
};

// Lowercase renders as caps: the face is a caps-only display face and this keeps
// a stray un-uppercased string from falling out of the family mid-word.
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
for (let i = 0; i < LOWER.length; i++) G[LOWER[i]] = G[LOWER[i].toUpperCase()];

export const DISPLAY_FAMILY = 'Verdium Display';

// ---------------------------------------------------------------------------
// TrueType compiler
// ---------------------------------------------------------------------------

class Writer {
  private buf = new Uint8Array(4096);
  len = 0;

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.need(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v: number): void {
    this.need(2);
    this.buf[this.len++] = (v >> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  i16(v: number): void {
    this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v: number): void {
    this.need(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  tag(s: string): void {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i));
  }
  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  align4(): void {
    while (this.len & 3) this.u8(0);
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

interface CompiledGlyph {
  code: number;
  advance: number;
  lsb: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  data: Uint8Array;
  points: number;
  contours: number;
}

function compileGlyph(def: GlyphDef, code: number): CompiledGlyph {
  const contours = def.contours.filter((c) => c.length >= 6);
  const advance = def.w + SIDE * 2;
  if (contours.length === 0) {
    return {
      code, advance, lsb: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0,
      data: new Uint8Array(0), points: 0, contours: 0,
    };
  }

  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  const xs: number[] = [];
  const ys: number[] = [];
  const ends: number[] = [];

  for (const c of contours) {
    for (let i = 0; i < c.length; i += 2) {
      const x = Math.round(c[i] + SIDE);
      const y = Math.round(c[i + 1]);
      xs.push(x);
      ys.push(y);
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    ends.push(xs.length - 1);
  }

  const w = new Writer();
  w.i16(contours.length);
  w.i16(xMin);
  w.i16(yMin);
  w.i16(xMax);
  w.i16(yMax);
  for (const e of ends) w.u16(e);
  w.u16(0); // instructionLength
  // Every point is on-curve and encoded with a 16-bit delta: flag 0x01 only.
  for (let i = 0; i < xs.length; i++) w.u8(0x01);
  let prev = 0;
  for (const x of xs) {
    w.i16(x - prev);
    prev = x;
  }
  prev = 0;
  for (const y of ys) {
    w.i16(y - prev);
    prev = y;
  }
  w.align4();

  return {
    code, advance, lsb: xMin, xMin, yMin, xMax, yMax,
    data: w.done(), points: xs.length, contours: contours.length,
  };
}

function checksum(bytes: Uint8Array, offset: number, length: number): number {
  let sum = 0;
  const end = offset + ((length + 3) & ~3);
  for (let i = offset; i < end; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

function nameTable(): Uint8Array {
  const records: Array<[number, string]> = [
    [0, 'Generated at runtime for Verdium Storm. No external assets.'],
    [1, DISPLAY_FAMILY],
    [2, 'Regular'],
    [3, `VerdiumDisplay-Regular-${EM}`],
    [4, DISPLAY_FAMILY],
    [5, 'Version 1.000'],
    [6, 'VerdiumDisplay-Regular'],
  ];
  const strings: Uint8Array[] = [];
  let stringLen = 0;
  for (const [, value] of records) {
    const b = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      b[i * 2] = (c >> 8) & 0xff;
      b[i * 2 + 1] = c & 0xff;
    }
    strings.push(b);
    stringLen += b.length;
  }

  const w = new Writer();
  w.u16(0); // format
  w.u16(records.length);
  w.u16(6 + records.length * 12); // stringOffset
  let offset = 0;
  for (let i = 0; i < records.length; i++) {
    w.u16(3); // platformID: Windows
    w.u16(1); // encodingID: UCS-2
    w.u16(0x0409); // languageID: en-US
    w.u16(records[i][0]);
    w.u16(strings[i].length);
    w.u16(offset);
    offset += strings[i].length;
  }
  for (const s of strings) w.bytes(s);
  void stringLen;
  return w.done();
}

function cmapTable(glyphs: CompiledGlyph[]): Uint8Array {
  // Segments merge runs where code and glyph index advance together, which is
  // what lets the lowercase→caps aliasing collapse into a single segment.
  const map = glyphs
    .map((g, i) => ({ code: g.code, index: i }))
    .filter((e) => e.index > 0)
    .sort((a, b) => a.code - b.code);

  const segs: Array<{ start: number; end: number; delta: number }> = [];
  for (const entry of map) {
    const delta = (entry.index - entry.code) & 0xffff;
    const last = segs[segs.length - 1];
    if (last && last.delta === delta && entry.code === last.end + 1) last.end = entry.code;
    else segs.push({ start: entry.code, end: entry.code, delta });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segs.length;
  const sub = new Writer();
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  sub.u16(4);
  sub.u16(16 + segCount * 8);
  sub.u16(0);
  sub.u16(segCount * 2);
  sub.u16(searchRange);
  sub.u16(entrySelector);
  sub.u16(segCount * 2 - searchRange);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.u16(s.delta);
  for (let i = 0; i < segCount; i++) sub.u16(0);
  const subBytes = sub.done();

  const w = new Writer();
  w.u16(0); // version
  w.u16(2); // numTables
  w.u16(3); w.u16(1); w.u32(20); // Windows UCS-2
  w.u16(0); w.u16(3); w.u32(20); // Unicode BMP
  w.bytes(subBytes);
  return w.done();
}

function buildFontBinary(): Uint8Array {
  const notdef: CompiledGlyph = {
    code: 0, advance: 400, lsb: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0,
    data: new Uint8Array(0), points: 0, contours: 0,
  };
  const codes = Object.keys(G)
    .map((ch) => ({ ch, code: ch.codePointAt(0) ?? 32 }))
    .sort((a, b) => a.code - b.code);
  const glyphs: CompiledGlyph[] = [notdef, ...codes.map(({ ch, code }) => compileGlyph(G[ch], code))];

  // glyf + loca
  const glyf = new Writer();
  const loca: number[] = [];
  for (const g of glyphs) {
    loca.push(glyf.len);
    glyf.bytes(g.data);
  }
  loca.push(glyf.len);
  const glyfBytes = glyf.done();
  const locaW = new Writer();
  for (const o of loca) locaW.u32(o);
  const locaBytes = locaW.done();

  const maxPoints = glyphs.reduce((m, g) => Math.max(m, g.points), 0);
  const maxContours = glyphs.reduce((m, g) => Math.max(m, g.contours), 0);
  const advanceMax = glyphs.reduce((m, g) => Math.max(m, g.advance), 0);
  const xMinAll = glyphs.reduce((m, g) => Math.min(m, g.xMin), 0);
  const yMinAll = glyphs.reduce((m, g) => Math.min(m, g.yMin), 0);
  const xMaxAll = glyphs.reduce((m, g) => Math.max(m, g.xMax), 0);
  const yMaxAll = glyphs.reduce((m, g) => Math.max(m, g.yMax), 0);

  const head = new Writer();
  head.u32(0x00010000);
  head.u32(0x00010000);
  head.u32(0); // checkSumAdjustment, patched below
  head.u32(0x5f0f3cf5);
  head.u16(0x000b); // flags
  head.u16(EM);
  head.u32(0); head.u32(0x00000000); // created
  head.u32(0); head.u32(0x00000000); // modified
  head.i16(xMinAll); head.i16(yMinAll); head.i16(xMaxAll); head.i16(yMaxAll);
  head.u16(0); // macStyle
  head.u16(8); // lowestRecPPEM
  head.i16(2); // fontDirectionHint
  head.i16(1); // indexToLocFormat: long
  head.i16(0); // glyphDataFormat

  const hhea = new Writer();
  hhea.u32(0x00010000);
  hhea.i16(760); hhea.i16(-200); hhea.i16(90);
  hhea.u16(advanceMax);
  hhea.i16(xMinAll); hhea.i16(0); hhea.i16(xMaxAll);
  hhea.i16(1); hhea.i16(0); hhea.i16(0);
  hhea.i16(0); hhea.i16(0); hhea.i16(0); hhea.i16(0);
  hhea.i16(0);
  hhea.u16(glyphs.length);

  const hmtx = new Writer();
  for (const g of glyphs) {
    hmtx.u16(g.advance);
    hmtx.i16(g.lsb);
  }

  const maxp = new Writer();
  maxp.u32(0x00010000);
  maxp.u16(glyphs.length);
  maxp.u16(maxPoints); maxp.u16(maxContours);
  maxp.u16(0); maxp.u16(0);
  maxp.u16(2); maxp.u16(0);
  maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0);
  maxp.u16(0); maxp.u16(0);

  const os2 = new Writer();
  os2.u16(4);
  os2.i16(560); // xAvgCharWidth
  os2.u16(700); // usWeightClass
  os2.u16(3); // usWidthClass: condensed
  os2.u16(0); // fsType: installable
  os2.i16(650); os2.i16(140); os2.i16(0); os2.i16(0); // subscript
  os2.i16(650); os2.i16(140); os2.i16(0); os2.i16(350); // superscript
  os2.i16(60); os2.i16(400); // strikeout
  os2.i16(0); // sFamilyClass
  for (const p of [2, 11, 8, 6, 3, 0, 0, 0, 0, 0]) os2.u8(p); // panose
  os2.u32(1); os2.u32(0); os2.u32(0); os2.u32(0); // unicode ranges
  os2.tag('VRDM');
  os2.u16(0x00c0); // fsSelection: regular
  os2.u16(0x0020);
  os2.u16(0x00d7);
  os2.i16(700); os2.i16(-200); os2.i16(90);
  os2.u16(760); os2.u16(200);
  os2.u32(1); os2.u32(0);
  os2.i16(520); os2.i16(CAP);
  os2.u16(32); os2.u16(32); os2.u16(2);

  const post = new Writer();
  post.u32(0x00030000);
  post.u32(0);
  post.i16(-120); post.i16(60);
  post.u32(0);
  post.u32(0); post.u32(0); post.u32(0); post.u32(0);

  const tables: Array<[string, Uint8Array]> = [
    ['OS/2', os2.done()],
    ['cmap', cmapTable(glyphs)],
    ['glyf', glyfBytes],
    ['head', head.done()],
    ['hhea', hhea.done()],
    ['hmtx', hmtx.done()],
    ['loca', locaBytes],
    ['maxp', maxp.done()],
    ['name', nameTable()],
    ['post', post.done()],
  ];
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const numTables = tables.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  const out = new Writer();
  out.u32(0x00010000);
  out.u16(numTables);
  out.u16(searchRange);
  out.u16(entrySelector);
  out.u16(numTables * 16 - searchRange);

  let offset = 12 + numTables * 16;
  const dirOffsets: number[] = [];
  for (const [tag, data] of tables) {
    out.tag(tag);
    dirOffsets.push(out.len);
    out.u32(0); // checksum, patched
    out.u32(offset);
    out.u32(data.length);
    offset += (data.length + 3) & ~3;
  }
  let headOffset = 0;
  for (const [tag, data] of tables) {
    if (tag === 'head') headOffset = out.len;
    out.bytes(data);
    out.align4();
  }

  const bytes = out.done();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 12 + numTables * 16;
  for (let i = 0; i < tables.length; i++) {
    const len = tables[i][1].length;
    view.setUint32(dirOffsets[i], checksum(bytes, cursor, len));
    cursor += (len + 3) & ~3;
  }
  const total = checksum(bytes, 0, bytes.length);
  view.setUint32(headOffset + 8, (0xb1b0afba - total) >>> 0);
  return bytes;
}

let installed: Promise<boolean> | null = null;

/**
 * Compiles and registers the display face. Resolves false when the browser
 * rejects the binary, in which case callers keep the fallback stack.
 */
export function installDisplayFont(): Promise<boolean> {
  if (installed) return installed;
  installed = (async () => {
    try {
      const bytes = buildFontBinary();
      const face = new FontFace(DISPLAY_FAMILY, bytes.buffer as ArrayBuffer, {
        weight: '400',
        style: 'normal',
        display: 'block',
      });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch (err) {
      console.warn('[hud] display face unavailable, falling back to the system stack', err);
      return false;
    }
  })();
  return installed;
}

// ---------------------------------------------------------------------------
// canvas rasterisation — used for the wordmark, which needs per-glyph shading
// ---------------------------------------------------------------------------

export interface TextMetricsLite {
  width: number;
  /** Per-glyph advance origins, in the same units as `width`. */
  origins: number[];
}

/** Advance width of `text` at the given pixel size, including tracking. */
export function measureDisplayText(text: string, size: number, tracking = 0): TextMetricsLite {
  const scale = size / EM;
  const origins: number[] = [];
  let x = 0;
  for (const ch of text) {
    origins.push(x);
    const def = G[ch] ?? G[' '];
    x += (def.w + SIDE * 2) * scale + tracking;
  }
  return { width: Math.max(0, x - tracking), origins };
}

/**
 * Traces `text` into the current canvas path with the baseline at (x, y).
 * Callers fill/stroke it themselves, which is how the wordmark gets its bevel,
 * gradient fill and outer glow from one shared outline.
 */
export function traceDisplayText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  tracking = 0,
): void {
  const scale = size / EM;
  let cursor = x;
  for (const ch of text) {
    const def = G[ch] ?? G[' '];
    for (const c of def.contours) {
      if (c.length < 6) continue;
      ctx.moveTo(cursor + (c[0] + SIDE) * scale, y - c[1] * scale);
      for (let i = 2; i < c.length; i += 2) {
        ctx.lineTo(cursor + (c[i] + SIDE) * scale, y - c[i + 1] * scale);
      }
      ctx.closePath();
    }
    cursor += (def.w + SIDE * 2) * scale + tracking;
  }
}

/** Convenience wrapper: begins a path, traces and fills. */
export function drawDisplayText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  tracking = 0,
): void {
  ctx.beginPath();
  traceDisplayText(ctx, text, x, y, size, tracking);
  ctx.fill('nonzero');
}
