import type { GameStateService, SelectionSummary } from '@/game/GameState';
import type { UnitType } from '@/entities/Types';
import { cameo } from './Icons';
import { div, group, setClass, setText, shieldInput } from './dom';
import { applyBand, brackets, caption, meter, plate, setIcon, setMeter, type Caption, type Meter } from './Widgets';
import type { FactionTheme } from './Theme';

/**
 * The selection readout.
 *
 * One panel serves three very different states — nothing selected, a single
 * subject with full telemetry, and a squad — because a C&C player reads this
 * corner by shape: portrait on the left, name and bars in the middle, the squad
 * strip underneath. Swapping layouts per state would break that muscle memory,
 * so the same nodes are shown, hidden and relabelled instead.
 */

const MAX_CHIPS = 24;

interface Chip {
  root: HTMLDivElement;
  img: HTMLDivElement;
  fill: HTMLElement;
  type: string;
}

export class SelectionPanel {
  readonly root: HTMLDivElement;

  private cap: Caption;
  private portrait: HTMLDivElement;
  private name: HTMLElement;
  private kind: HTMLElement;
  private hp: Meter;
  private cargo: Meter;
  private build: Meter;
  private squad: HTMLDivElement;
  private portraitImg: HTMLDivElement;
  private chips: Chip[] = [];
  private theme: FactionTheme;
  private signature = '';

  constructor(
    parent: HTMLElement,
    theme: FactionTheme,
    private readonly gameOf: () => GameStateService,
  ) {
    this.theme = theme;
    this.root = plate('cut-tl-br', parent, 'vs-sel');
    shieldInput(this.root);
    brackets(this.root, ['tr', 'bl']);
    this.cap = caption(this.root, 'SELECTION', '');

    const body = div('body', this.root);
    this.portrait = div('vs-portrait', body);
    const img = div('img', this.portrait);
    div('scan', this.portrait);
    div('grid', this.portrait);

    const info = div('info', body);
    this.name = div('nm', info);
    this.kind = div('kd', info);
    this.hp = meter(info, 'hp', 'INTEGRITY');
    this.cargo = meter(info, 'cargo', 'CARGO');
    this.build = meter(info, 'build', 'CONSTRUCTION');

    this.squad = div('vs-squad', this.root);
    this.portraitImg = img;
  }

  setTheme(theme: FactionTheme): void {
    this.theme = theme;
    this.signature = '';
  }

  update(game: GameStateService): void {
    const selection = game.selection;
    setClass(this.root, 'on', selection.length > 0);
    if (selection.length === 0) {
      this.signature = '';
      return;
    }

    const lead = pickLead(selection);
    const signature = `${selection.length}|${selection.map((s) => `${s.id}:${s.type}`).join(',')}`;
    if (signature !== this.signature) {
      this.signature = signature;
      setIcon(this.portraitImg, cameo(lead.type as UnitType, this.theme.accent, 192));
      setText(this.name, selection.length === 1 ? lead.label.toUpperCase() : `${selection.length} SELECTED`);
      setText(this.kind, composition(selection));
      setText(this.cap.meta, selection.length === 1 ? `ID ${lead.id}` : `${selection.length} CONTACTS`);
      this.rebuildChips(selection);
    }

    // Aggregate health so a squad still reads as one condition bar.
    let hp = 0;
    let maxHp = 0;
    for (const s of selection) {
      hp += s.hp;
      maxHp += s.maxHp;
    }
    const ratio = maxHp > 0 ? hp / maxHp : 0;
    applyBand(this.hp.root, ratio);
    setMeter(this.hp, ratio, selection.length === 1
      ? `${Math.round(hp)} / ${Math.round(maxHp)}`
      : `${Math.round(ratio * 100)}%`);

    const cargoOwner = selection.find((s) => s.cargoMax !== undefined && s.cargoMax > 0);
    this.cargo.root.style.display = cargoOwner ? '' : 'none';
    if (cargoOwner) {
      const r = (cargoOwner.cargo ?? 0) / Math.max(1, cargoOwner.cargoMax ?? 1);
      setMeter(this.cargo, r, `${group(cargoOwner.cargo ?? 0)} CR`);
    }

    const building = selection.find((s) => s.buildProgress !== undefined && s.buildProgress < 1);
    this.build.root.style.display = building ? '' : 'none';
    if (building) {
      setMeter(this.build, building.buildProgress ?? 0, `${Math.round((building.buildProgress ?? 0) * 100)}%`);
    }

    this.updateChips(selection);
  }

  private rebuildChips(selection: SelectionSummary[]): void {
    const wanted = selection.length > 1 ? Math.min(selection.length, MAX_CHIPS) : 0;
    this.squad.style.display = wanted ? '' : 'none';
    while (this.chips.length < wanted) this.chips.push(this.makeChip());
    for (let i = 0; i < this.chips.length; i++) {
      const chip = this.chips[i];
      const s = selection[i];
      chip.root.style.display = i < wanted ? '' : 'none';
      if (i >= wanted || !s) continue;
      if (chip.type !== s.type) {
        chip.type = String(s.type);
        setIcon(chip.img, cameo(s.type as UnitType, this.theme.accent, 96));
      }
    }
  }

  private updateChips(selection: SelectionSummary[]): void {
    for (let i = 0; i < this.chips.length; i++) {
      const s = selection[i];
      if (!s) continue;
      const chip = this.chips[i];
      const r = s.maxHp > 0 ? s.hp / s.maxHp : 0;
      chip.fill.style.width = `${Math.round(r * 100)}%`;
      applyBand(chip.root, r);
    }
  }

  private makeChip(): Chip {
    const root = div('vs-chip', this.squad);
    const img = div('img', root);
    const hp = div('hp', root);
    const fill = document.createElement('i');
    hp.appendChild(fill);
    const chip: Chip = { root, img, fill, type: '' };
    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const index = this.chips.indexOf(chip);
      const s = this.gameOf().selection[index];
      if (s) this.gameOf().selectAll(s.type);
    });
    return chip;
  }
}

/** The subject the portrait shows: the most numerous type, buildings first. */
function pickLead(selection: SelectionSummary[]): SelectionSummary {
  const counts = new Map<string, number>();
  for (const s of selection) counts.set(String(s.type), (counts.get(String(s.type)) ?? 0) + 1);
  let best = selection[0];
  let bestScore = -1;
  for (const s of selection) {
    const score = (counts.get(String(s.type)) ?? 0) + (s.kind === 'building' ? 100 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

function composition(selection: SelectionSummary[]): string {
  if (selection.length === 1) {
    return selection[0].kind === 'building' ? 'STRUCTURE' : 'FIELD UNIT';
  }
  const counts = new Map<string, number>();
  for (const s of selection) {
    const key = s.label.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, n]) => `${n}× ${label}`)
    .join('  ·  ');
}
