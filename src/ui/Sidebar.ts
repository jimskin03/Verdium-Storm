import type { BuildOption, BuildableId, GameStateService } from '@/game/GameState';
import type { BuildingType, UnitType } from '@/entities/Types';
import { cameo, glyph } from './Icons';
import { PALETTE, type FactionTheme } from './Theme';
import { Tween, clamp, div, el, group, setClass, setText, setVar, shieldInput } from './dom';
import { brackets, caption, icon, plate, setIcon } from './Widgets';
import type { Tooltip } from './Tooltip';
import { Minimap } from './Minimap';

/**
 * The command bar.
 *
 * `GameStateService` splits production into `unit` and `building`, but a C&C
 * sidebar splits it three ways, so infantry and vehicles are separated here from
 * the single `unit` list. The mapping is data, not a hard-coded order: anything
 * the simulation reports that is not known infantry lands in the vehicle tab, so
 * a new unit type shows up without a change here.
 */

type TabId = 'structures' | 'infantry' | 'vehicles';

const INFANTRY = new Set<string>(['rifleman', 'rocketeer', 'engineer', 'commando', 'medic', 'sniper']);

const TABS: Array<{ id: TabId; label: string; kind: 'unit' | 'building' }> = [
  { id: 'structures', label: 'BUILD', kind: 'building' },
  { id: 'infantry', label: 'INFANTRY', kind: 'unit' },
  { id: 'vehicles', label: 'VEHICLES', kind: 'unit' },
];

interface ButtonView {
  root: HTMLDivElement;
  cameo: HTMLDivElement;
  name: HTMLElement;
  costText: HTMLElement;
  sweep: HTMLElement;
  pct: HTMLElement;
  bar: HTMLElement;
  badge: HTMLElement;
  option: BuildOption;
}

export class Sidebar {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;

  private theme: FactionTheme;
  private tooltip: Tooltip;

  private crest: HTMLDivElement;
  private mark: HTMLElement;
  private sub: HTMLElement;
  private leds: HTMLElement[] = [];

  private creditsValue: HTMLElement;
  private creditsDelta: HTMLElement;
  private power: HTMLDivElement;
  private powerNum: HTMLElement;
  private powerUsed: HTMLElement;
  private powerCap: HTMLElement;

  private tabNodes = new Map<TabId, HTMLDivElement>();
  private tab: TabId = 'structures';

  private grid: HTMLDivElement;
  private rail: HTMLElement;
  private buttons = new Map<BuildableId, ButtonView>();
  private signature = '';

  private active: HTMLDivElement;
  private activeIcon: HTMLDivElement;
  private activeName: HTMLElement;
  private activeEta: HTMLElement;
  private activeId: BuildableId | null = null;

  private credits = new Tween(0, 7);
  private hovered: HTMLElement | null = null;
  private hoveredId: BuildableId | null = null;

  constructor(
    parent: HTMLElement,
    theme: FactionTheme,
    tooltip: Tooltip,
    private readonly gameOf: () => GameStateService,
    seek: (x: number, z: number) => void,
  ) {
    this.theme = theme;
    this.tooltip = tooltip;
    this.root = div('vs-sidebar', parent);
    shieldInput(this.root);

    // -- faction header -----------------------------------------------------
    const head = plate('cut-l', this.root);
    const fac = div('vs-fac', head);
    this.crest = icon('crest', fac, '');
    const txt = div('txt', fac);
    this.mark = div('mark', txt);
    this.sub = div('sub', txt);
    const leds = div('leds', fac);
    for (let i = 0; i < 3; i++) this.leds.push(div('led', leds));

    // -- tactical map -------------------------------------------------------
    this.minimap = new Minimap(this.root, theme, seek);

    // -- economy ------------------------------------------------------------
    const econPlate = plate('cut-tr-bl', this.root);
    caption(econPlate, 'RESOURCES', 'LIVE');
    const econ = div('vs-econ', econPlate);
    const creditRow = div('vs-credits', econ);
    icon('ico', creditRow, glyph('credits', PALETTE.credit, 40));
    this.creditsValue = div('val', creditRow);
    this.creditsDelta = div('delta', creditRow);

    this.power = div('vs-power', econ);
    const powerRow = div('row', this.power);
    icon('ico', powerRow, glyph('power', PALETTE.power, 32));
    const powerLabel = div('lbl', powerRow);
    powerLabel.textContent = 'POWER';
    this.powerNum = div('num', powerRow);
    const bar = div('bar', this.power);
    this.powerUsed = div('used', bar);
    div('segs', bar);
    this.powerCap = div('cap', bar);

    // -- production tabs ----------------------------------------------------
    const tabs = div('vs-tabs', this.root);
    for (const t of TABS) {
      const node = div('vs-tab', tabs);
      icon('ico', node, glyph(t.id, '#dfeaf2', 34));
      const lbl = div('lbl', node);
      lbl.textContent = t.label;
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTab(t.id);
      });
      this.tabNodes.set(t.id, node);
    }

    // -- build grid ---------------------------------------------------------
    const wrap = div('vs-grid-wrap', this.root);
    const gridPlate = plate('cut-br', wrap);
    gridPlate.style.flex = '1';
    gridPlate.style.minHeight = '0';
    gridPlate.style.display = 'flex';
    brackets(gridPlate, ['tr', 'bl']);
    this.grid = div('vs-grid', gridPlate);
    const railWrap = div('vs-rail', gridPlate);
    this.rail = el('i', '', railWrap);
    this.grid.addEventListener('scroll', () => this.syncRail(), { passive: true });

    // -- active production strip -------------------------------------------
    const activePlate = plate('cut-tl-br', this.root);
    caption(activePlate, 'PRODUCTION', 'QUEUE');
    this.active = div('vs-active', activePlate);
    this.activeIcon = icon('ico', this.active, '');
    const at = div('txt', this.active);
    this.activeName = div('nm', at);
    this.activeEta = div('eta', at);
    const stop = div('stop', this.active);
    icon('', stop, glyph('cancel', '#ff9c88', 26)).style.cssText =
      'width:11px;height:11px;background-size:contain;background-repeat:no-repeat';
    stop.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.activeId) this.gameOf().cancelBuild(this.activeId);
    });

    this.setTab('structures');
  }

  setTheme(theme: FactionTheme): void {
    this.theme = theme;
    this.minimap.setTheme(theme);
    this.signature = '';
    this.buttons.clear();
    this.grid.textContent = '';
  }

  private setTab(id: TabId): void {
    this.tab = id;
    for (const [key, node] of this.tabNodes) setClass(node, 'on', key === id);
    this.signature = '';
  }

  /** The build options this tab shows, in the order the simulation reports them. */
  private options(game: GameStateService): BuildOption[] {
    const tab = TABS.find((t) => t.id === this.tab)!;
    const list = game.buildOptions(tab.kind);
    if (tab.kind === 'building') return list;
    return list.filter((o) => (this.tab === 'infantry' ? INFANTRY.has(o.id) : !INFANTRY.has(o.id)));
  }

  update(dt: number, game: GameStateService): void {
    this.updateHeader(game);
    this.updateEconomy(dt, game);
    this.updateGrid(game);
    this.updateActive(game);
  }

  private updateHeader(game: GameStateService): void {
    const t = this.theme;
    setIcon(this.crest, cameoCrest(t));
    setText(this.mark, t.mark);
    setText(this.sub, t.motto);

    const econ = game.economy;
    const attacked = game.alerts.some((a) => a.kind === 'baseUnderAttack' && a.age < 8);
    const states: Array<'on' | 'warn' | 'bad'> = [
      'on',
      econ.powerRatio < 1.02 ? 'bad' : econ.powerRatio < 1.18 ? 'warn' : 'on',
      attacked ? 'bad' : 'on',
    ];
    for (let i = 0; i < this.leds.length; i++) {
      const led = this.leds[i];
      setClass(led, 'on', states[i] === 'on');
      setClass(led, 'warn', states[i] === 'warn');
      setClass(led, 'bad', states[i] === 'bad');
    }
  }

  private updateEconomy(dt: number, game: GameStateService): void {
    const econ = game.economy;
    this.credits.set(econ.credits);
    const spending = this.credits.target < this.credits.value - 1;
    this.credits.update(dt);
    setText(this.creditsValue, group(this.credits.value));
    setClass(this.creditsValue, 'spend', spending);

    const income = Math.round(econ.income);
    setText(this.creditsDelta, `${income >= 0 ? '+' : ''}${group(income)}/MIN`);
    setClass(this.creditsDelta, 'neg', income < 0);

    const produced = Math.max(0, econ.powerProduced);
    const consumed = Math.max(0, econ.powerConsumed);
    const capacity = Math.max(1, produced, consumed);
    setVar(this.powerUsed, 'width', `${((consumed / capacity) * 100).toFixed(1)}%`);
    setVar(this.powerCap, 'left', `${((produced / capacity) * 100).toFixed(1)}%`);
    setText(this.powerNum, `${consumed} / ${produced}`);
    const ratio = econ.powerRatio;
    setClass(this.power, 'warn', ratio >= 1.0 && ratio < 1.18);
    setClass(this.power, 'bad', ratio < 1.0);
  }

  private updateGrid(game: GameStateService): void {
    const options = this.options(game);
    const signature = `${this.tab}|${options.map((o) => o.id).join(',')}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild(options);
    }

    for (const option of options) {
      const view = this.buttons.get(option.id);
      if (!view) continue;
      view.option = option;

      const building = option.progress > 0 && option.progress < 1 && !option.readyToPlace;
      setClass(view.root, 'building', building);
      setClass(view.root, 'ready', option.readyToPlace);
      setClass(view.root, 'locked', !option.available && !option.readyToPlace);
      setClass(view.root, 'queued', option.queued > 0);

      if (building) {
        setVar(view.root, '--p', option.progress.toFixed(3));
        setVar(view.bar, 'width', `${(option.progress * 100).toFixed(1)}%`);
        setText(view.pct, `${Math.round(option.progress * 100)}%`);
      }
      if (option.queued > 0) setText(view.badge, String(option.queued));
      setText(view.costText, group(option.cost));
    }

    this.syncRail();
    if (this.hoveredId !== null) this.refreshTip();
  }

  private rebuild(options: BuildOption[]): void {
    this.grid.textContent = '';
    this.buttons.clear();
    for (const option of options) this.buttons.set(option.id, this.makeButton(option));
  }

  private makeButton(option: BuildOption): ButtonView {
    const root = div('vs-btn', this.grid);
    const cameoNode = icon('cameo', root, cameo(option.id as UnitType, this.theme.accent, 128));
    div('plinth', root);
    const name = div('name', root);
    name.textContent = option.label;

    const sweep = div('sweep', root);
    const pct = div('pct', root);
    const readyflag = div('readyflag', root);
    readyflag.textContent = 'READY';
    const cost = div('cost', root);
    const chip = div('', cost);
    chip.style.cssText =
      `width:9px;height:9px;background-size:contain;background-repeat:no-repeat;background-image:url(${glyph('credits', PALETTE.credit, 24)})`;
    const costText = el('span', '', cost);
    const badge = div('badge', root);
    icon('lock', root, glyph('lock', '#ff9c88', 26));
    const pbar = div('pbar', root);
    const bar = el('i', '', pbar);
    div('frame', root);

    const view: ButtonView = { root, cameo: cameoNode, name, costText, sweep, pct, bar, badge, option };

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const game = this.gameOf();
      const current = view.option;
      if (e.button === 2) {
        game.cancelBuild(current.id);
        return;
      }
      if (current.readyToPlace) game.beginPlacement(current.id as BuildingType);
      else if (current.available) game.queueBuild(current.id);
    });
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.gameOf().cancelBuild(view.option.id);
    });
    root.addEventListener('pointerenter', () => {
      this.hovered = root;
      this.hoveredId = option.id;
      this.refreshTip();
    });
    root.addEventListener('pointerleave', () => {
      if (this.hoveredId !== option.id) return;
      this.hovered = null;
      this.hoveredId = null;
      this.tooltip.hide(root);
    });

    return view;
  }

  private refreshTip(): void {
    const anchor = this.hovered;
    const id = this.hoveredId;
    if (!anchor || id === null) return;
    const view = this.buttons.get(id);
    if (!view) return;
    const o = view.option;
    this.tooltip.show(anchor, {
      title: o.label,
      stats: [
        { label: 'COST', value: group(o.cost), credit: true },
        { label: 'BUILD', value: `${Math.round(o.buildTime)}S` },
        { label: 'QUEUED', value: String(o.queued) },
      ],
      why: o.readyToPlace ? 'READY — CLICK TO PLACE' : o.lockedReason,
    });
  }

  private updateActive(game: GameStateService): void {
    // Prefer whatever the visible tab is producing; fall back to the other
    // queue so the strip is never dead while something is being built.
    const pools = [this.options(game), game.buildOptions(this.tab === 'structures' ? 'unit' : 'building')];
    let chosen: BuildOption | null = null;
    for (const pool of pools) {
      for (const o of pool) {
        if (o.readyToPlace) { chosen = o; break; }
        if (o.progress > 0 && (!chosen || o.progress > chosen.progress)) chosen = o;
      }
      if (chosen) break;
    }

    setClass(this.active, 'idle', !chosen);
    if (!chosen) {
      this.activeId = null;
      setIcon(this.activeIcon, glyph('queue', '#43606e', 40));
      setText(this.activeName, 'NO ACTIVE ORDER');
      setText(this.activeEta, 'SELECT A STRUCTURE OR UNIT');
      return;
    }

    this.activeId = chosen.id;
    setIcon(this.activeIcon, cameo(chosen.id as UnitType, this.theme.accent, 96));
    setText(this.activeName, chosen.label);
    const remaining = Math.max(0, chosen.buildTime * (1 - chosen.progress));
    setText(
      this.activeEta,
      chosen.readyToPlace
        ? 'READY — AWAITING PLACEMENT'
        : `${Math.round(chosen.progress * 100)}% · ${remaining.toFixed(0)}S REMAINING${chosen.queued ? ` · +${chosen.queued}` : ''}`,
    );
  }

  private syncRail(): void {
    const grid = this.grid;
    const visible = grid.clientHeight;
    const total = grid.scrollHeight;
    if (total <= visible + 1) {
      setVar(this.rail, 'height', '0%');
      setVar(this.rail, 'top', '0%');
      return;
    }
    const size = clamp(visible / total, 0.08, 1);
    const pos = clamp(grid.scrollTop / (total - visible), 0, 1) * (1 - size);
    setVar(this.rail, 'height', `${(size * 100).toFixed(1)}%`);
    setVar(this.rail, 'top', `${(pos * 100).toFixed(1)}%`);
  }
}

/** Cached crest bitmap keyed by the theme, so re-theming is one lookup. */
const crestCache = new Map<string, string>();
function cameoCrest(theme: FactionTheme): string {
  const key = `${theme.mark}|${theme.accent}`;
  let url = crestCache.get(key);
  if (!url) {
    url = crestOf(theme);
    crestCache.set(key, url);
  }
  return url;
}

function crestOf(theme: FactionTheme): string {
  // Imported lazily through a local binding to keep the icon module's cache the
  // single owner of generated bitmaps.
  return crestImpl(theme.mark, theme.accent, 96);
}

import { crest as crestImpl } from './Icons';
