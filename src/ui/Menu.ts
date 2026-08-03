import type { Faction } from '@/entities/Types';
import { crest } from './Icons';
import { FACTIONS, type FactionTheme } from './Theme';
import { div, el, setClass, setText, shieldInput } from './dom';
import { brackets, caption, plate } from './Widgets';
import { drawDisplayText, measureDisplayText } from './Typeface';

/**
 * Front end: wordmark, faction select and the deployment sequence.
 *
 * The wordmark is rasterised from the display typeface's own outlines rather
 * than set as DOM text, because it needs a bevel, a gradient fill and an outer
 * glow taken from one shared path — three effects no amount of `text-shadow`
 * will fake convincingly at that size.
 *
 * The loading sequence is short and honest: the engine is already up by the
 * time this screen is interactive, so the bar tracks a fixed reveal rather than
 * pretending to measure work that has already happened.
 */

const LOG_LINES = [
  'ESTABLISHING TACTICAL UPLINK',
  'SYNTHESISING TERRAIN HEIGHTFIELD',
  'COMPILING SURFACE SHADERS',
  'SEEDING VERDIUM DEPOSITS',
  'DEPLOYING CONSTRUCTION YARD',
  'CALIBRATING SATELLITE IMAGERY',
  'FIELD COMMAND ONLINE',
];

export interface MenuOptions {
  healthBars: boolean;
  fogOfWar: boolean;
}

export class Menu {
  readonly root: HTMLDivElement;

  private stage: HTMLDivElement;
  private load: HTMLDivElement;
  private loadPct: HTMLElement;
  private loadBar: HTMLElement;
  private loadLog: HTMLDivElement;
  private cards = new Map<Faction, HTMLDivElement>();
  private selected: Faction = 'gdi';
  private progress = -1;
  private logIndex = 0;

  readonly options: MenuOptions = { healthBars: true, fogOfWar: true };

  constructor(
    parent: HTMLElement,
    private readonly onDeploy: (faction: Faction) => void,
    private readonly onPreview: (faction: Faction) => void,
    private readonly onOption: (key: keyof MenuOptions, value: boolean) => void,
  ) {
    this.root = div('vs-menu', parent);
    shieldInput(this.root);
    div('bgfx', this.root);
    div('sweep2', this.root);
    div('vig', this.root);

    this.stage = div('stage', this.root);

    const wordmark = wordmarkCanvas('VERDIUM STORM', '#ffd98a', '#ffb42a');
    wordmark.className = 'wordmark';
    this.stage.appendChild(wordmark);

    const tagline = div('tagline', this.stage);
    tagline.textContent = 'TACTICAL WARFARE ENGINE';
    div('divider', this.stage);

    const cards = div('vs-cards', this.stage);
    for (const theme of Object.values(FACTIONS)) this.cards.set(theme.id, this.makeCard(cards, theme));

    div('divider', this.stage);

    const optrow = div('vs-optrow', this.stage);
    this.toggle(optrow, 'TACTICAL OVERLAY', 'healthBars');
    this.toggle(optrow, 'FOG OF WAR', 'fogOfWar');

    const buttons = div('vs-mbtns', this.stage);
    const deploy = div('vs-mbtn primary', buttons);
    deploy.textContent = 'DEPLOY';
    deploy.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.beginDeploy();
    });

    const foot = div('foot', this.root);
    const left = el('span', '', foot);
    left.textContent = 'BUILD 2.0 · PROCEDURAL ASSETS · NO EXTERNAL TEXTURES';
    const right = el('span', '', foot);
    right.textContent = 'SELECT A FACTION TO BEGIN';

    // Deployment overlay, stacked above the stage inside the same backdrop.
    this.load = div('vs-load', this.root);
    this.loadPct = div('pct', this.load);
    const barwrap = div('barwrap', this.load);
    caption(barwrap, 'DEPLOYING FIELD COMMAND', 'STANDBY');
    const bar = div('bar', barwrap);
    this.loadBar = el('i', '', bar);
    div('segs', bar);
    this.loadLog = div('log', this.load);

    this.select('gdi');
  }

  private makeCard(parent: HTMLElement, theme: FactionTheme): HTMLDivElement {
    const card = plate('cut-tl-br', parent, 'vs-card');
    card.style.setProperty('--c-accent', theme.accent);
    card.style.setProperty('--panel-hi', theme.panelHi);
    card.style.setProperty('--panel-lo', theme.panelLo);
    card.style.setProperty('--edge', theme.edge);
    card.style.setProperty('--edge-hot', theme.edgeHot);
    brackets(card, ['tl', 'br']);

    const inner = div('in', card);
    const crestNode = div('crest', inner);
    crestNode.style.backgroundImage = `url(${crest(theme.mark, theme.accent, 192)})`;
    crestNode.style.color = theme.accent;
    const mark = div('mark', inner);
    mark.textContent = theme.mark;
    const name = div('name', inner);
    name.textContent = theme.name;
    const doc = div('doc', inner);
    doc.textContent = theme.doctrine;

    const traits = div('traits', inner);
    for (const t of theme.traits) {
      const row = div('trait', traits);
      const label = el('b', '', row);
      label.textContent = t.label;
      const track = div('t', row);
      const fill = el('i', '', track);
      fill.style.width = `${Math.round(t.value * 100)}%`;
    }

    card.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(theme.id);
    });
    return card;
  }

  private toggle(parent: HTMLElement, label: string, key: keyof MenuOptions): void {
    const g = div('g', parent);
    const b = el('b', '', g);
    b.textContent = label;
    const seg = div('vs-seg', g);
    const on = div('o', seg);
    on.textContent = 'ON';
    const off = div('o', seg);
    off.textContent = 'OFF';
    const apply = (value: boolean): void => {
      this.options[key] = value;
      setClass(on, 'on', value);
      setClass(off, 'on', !value);
      this.onOption(key, value);
    };
    on.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); apply(true); });
    off.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); apply(false); });
    setClass(on, 'on', this.options[key]);
    setClass(off, 'on', !this.options[key]);
  }

  private select(faction: Faction): void {
    this.selected = faction;
    for (const [id, node] of this.cards) setClass(node, 'on', id === faction);
    this.onPreview(faction);
  }

  private beginDeploy(): void {
    if (this.progress >= 0) return;
    this.progress = 0;
    this.logIndex = 0;
    this.loadLog.textContent = '';
    this.stage.style.display = 'none';
    setClass(this.load, 'on', true);
    setText(this.loadPct, '0');
    this.loadBar.style.width = '0%';
  }

  show(): void {
    setClass(this.root, 'on', true);
    this.stage.style.display = '';
    setClass(this.load, 'on', false);
    this.progress = -1;
  }

  hide(): void {
    setClass(this.root, 'on', false);
  }

  get faction(): Faction {
    return this.selected;
  }

  /** Advances the deployment sequence. No-op outside it. */
  update(dt: number): void {
    if (this.progress < 0) return;
    this.progress = Math.min(1, this.progress + dt * 0.55);
    const pct = Math.round(this.progress * 100);
    setText(this.loadPct, String(pct));
    this.loadBar.style.width = `${pct}%`;

    const wanted = Math.min(LOG_LINES.length, Math.floor(this.progress * LOG_LINES.length) + 1);
    while (this.logIndex < wanted) {
      const line = div('', this.loadLog);
      line.textContent = LOG_LINES[this.logIndex];
      this.logIndex++;
      while (this.loadLog.childElementCount > 6) this.loadLog.removeChild(this.loadLog.firstChild!);
    }

    if (this.progress >= 1) {
      this.progress = -1;
      this.hide();
      this.onDeploy(this.selected);
    }
  }
}

/**
 * Rasterises the wordmark: a dark extruded body, a metal gradient face, a
 * horizontal cut line and an outer glow, all traced from one shared outline.
 */
function wordmarkCanvas(text: string, light: string, accent: string): HTMLCanvasElement {
  const size = 92;
  const tracking = 12;
  const metrics = measureDisplayText(text, size, tracking);
  const padX = 46;
  const padY = 46;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.ceil(metrics.width + padX * 2);
  const h = Math.ceil(size * 1.5 + padY);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  const baseline = size + padY * 0.42;
  const x = padX;

  // Extrusion: repeated offsets downward give the mark real thickness.
  for (let i = 8; i >= 1; i--) {
    ctx.fillStyle = `rgba(${20 + i * 3}, ${8 + i * 2}, 0, 1)`;
    drawDisplayText(ctx, text, x + i * 0.35, baseline + i * 0.9, size, tracking);
  }

  // Outer glow.
  ctx.save();
  ctx.shadowColor = accent;
  ctx.shadowBlur = 34;
  ctx.fillStyle = 'rgba(255,180,42,.45)';
  drawDisplayText(ctx, text, x, baseline, size, tracking);
  ctx.restore();

  // Face: a brushed metal ramp with a hot top edge.
  const grad = ctx.createLinearGradient(0, baseline - size, 0, baseline);
  grad.addColorStop(0, '#fff5dc');
  grad.addColorStop(0.32, light);
  grad.addColorStop(0.52, accent);
  grad.addColorStop(0.54, '#6d4405');
  grad.addColorStop(0.78, accent);
  grad.addColorStop(1, '#c07f11');
  ctx.fillStyle = grad;
  drawDisplayText(ctx, text, x, baseline, size, tracking);

  // Top highlight, clipped to the upper third of the cap height.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, baseline - size, w, size * 0.2);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,.65)';
  drawDisplayText(ctx, text, x, baseline, size, tracking);
  ctx.restore();

  // Hairline rule through the mark, the way plate lettering is scored.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(0, baseline - size * 0.47, w, 1.5);
  ctx.restore();

  return canvas;
}
