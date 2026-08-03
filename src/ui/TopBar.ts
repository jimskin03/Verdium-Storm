import type { GameStateService } from '@/game/GameState';
import { crest, glyph, type GlyphId } from './Icons';
import { clockString, div, group, setClass, setText, shieldInput } from './dom';
import { icon, setIcon } from './Widgets';
import { PALETTE, type FactionTheme } from './Theme';

/**
 * The status strip across the top of the screen.
 *
 * Everything here is a *readout*, never a control except the two system
 * buttons on the right. Groups are separated by hairlines rather than boxes and
 * the whole strip fades out toward the bottom, so it reads as an overlay etched
 * onto the frame rather than a toolbar sitting on top of it.
 */

interface Readout {
  value: HTMLElement;
  label: HTMLElement;
}

export class TopBar {
  readonly root: HTMLDivElement;

  private crestNode: HTMLDivElement;
  private markNode: HTMLElement;
  private clock: Readout;
  private forces: Readout;
  private capFill: HTMLElement;
  private kills: Readout;
  private losses: Readout;
  private pauseIcon: HTMLDivElement;
  private theme: FactionTheme;

  constructor(
    parent: HTMLElement,
    theme: FactionTheme,
    private readonly onPause: () => void,
    private readonly onMenu: () => void,
  ) {
    this.theme = theme;
    this.root = div('vs-top', parent);
    shieldInput(this.root);
    div('bg', this.root);
    div('rule', this.root);

    // Faction identity, so the strip always says whose war this is.
    const id = div('grp', this.root);
    this.crestNode = icon('ico', id, crest(theme.mark, theme.accent, 40));
    this.crestNode.style.width = '19px';
    this.crestNode.style.height = '19px';
    this.crestNode.style.opacity = '1';
    this.markNode = div('val', id);
    this.markNode.textContent = theme.mark;

    this.clock = this.group('time', 'MISSION TIME', true);
    const forcesGroup = div('grp', this.root);
    icon('ico', forcesGroup, glyph('units', '#8aa2b0', 28));
    const forcesStack = div('stack', forcesGroup);
    this.forces = {
      label: div('lbl', forcesStack),
      value: div('val', forcesStack),
    };
    this.forces.label.textContent = 'FORCES';
    const cap = div('capbar', forcesGroup);
    this.capFill = div('', cap);
    this.capFill.style.height = '100%';
    this.capFill.style.background = `linear-gradient(90deg, ${theme.cool}, ${theme.accent})`;

    this.kills = this.group('kills', 'DESTROYED');
    this.kills.value.classList.add('ok');
    this.losses = this.group('losses', 'LOSSES');
    this.losses.value.classList.add('bad');

    div('spacer', this.root);

    const pause = div('vs-sysbtn', this.root);
    this.pauseIcon = icon('', pause, glyph('pause', PALETTE.ink, 26));
    this.pauseIcon.style.cssText = 'width:13px;height:13px;background-size:contain;background-repeat:no-repeat';
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onPause();
    });

    const menu = div('vs-sysbtn', this.root);
    const menuIcon = icon('', menu, glyph('menu', PALETTE.ink, 26));
    menuIcon.style.cssText = 'width:13px;height:13px;background-size:contain;background-repeat:no-repeat';
    menu.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onMenu();
    });
  }

  private group(id: GlyphId, label: string, big = false): Readout {
    const grp = div('grp', this.root);
    icon('ico', grp, glyph(id, '#8aa2b0', 28));
    const stack = div('stack', grp);
    const lbl = div('lbl', stack);
    lbl.textContent = label;
    const val = div(big ? 'val big' : 'val', stack);
    return { label: lbl, value: val };
  }

  setTheme(theme: FactionTheme): void {
    this.theme = theme;
    setIcon(this.crestNode, crest(theme.mark, theme.accent, 40));
    setText(this.markNode, theme.mark);
    this.capFill.style.background = `linear-gradient(90deg, ${theme.cool}, ${theme.accent})`;
  }

  update(game: GameStateService): void {
    setText(this.clock.value, clockString(game.matchTime));
    const cap = Math.max(1, game.unitCap);
    const count = game.unitCount;
    setText(this.forces.value, `${count} / ${cap}`);
    this.capFill.style.width = `${Math.min(100, (count / cap) * 100).toFixed(0)}%`;
    setClass(this.forces.value, 'bad', count >= cap);
    setText(this.kills.value, group(game.kills));
    setText(this.losses.value, group(game.losses));
  }

  setPausedIcon(paused: boolean): void {
    setIcon(this.pauseIcon, glyph(paused ? 'chevron' : 'pause', paused ? this.theme.accent : PALETTE.ink, 26));
  }
}
