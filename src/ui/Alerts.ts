import type { Alert, GameStateService } from '@/game/GameState';
import { glyph } from './Icons';
import { div, setClass, setText, shieldInput } from './dom';
import { icon, setIcon } from './Widgets';

/**
 * The event feed.
 *
 * Rows are recycled: the list is short and changes often, so rebuilding the
 * nodes would restart the entry animation on every unrelated event. Each row
 * keeps its identity while the alert underneath it keeps its identity, and only
 * the age readout is rewritten per refresh.
 *
 * A `baseUnderAttack` alert also drives the two screen treatments — a red
 * vignette pulse and a warning band — because that is the one event a player
 * must never miss while looking somewhere else on the map.
 */

const MAX_ROWS = 6;

interface Row {
  root: HTMLDivElement;
  ico: HTMLDivElement;
  msg: HTMLElement;
  age: HTMLElement;
  key: string;
  kind: string;
}

const TINT: Record<string, string> = {
  insufficientFunds: '#ffb02e',
  lowPower: '#ffb02e',
  baseUnderAttack: '#ff3b2a',
  unitLost: '#ff7a5c',
  harvesterLost: '#ff7a5c',
  buildingComplete: '#63e08a',
  unitReady: '#63e08a',
  newTech: '#6fc9ff',
};

export class AlertFeed {
  readonly root: HTMLDivElement;

  private rows: Row[] = [];
  private flash: HTMLDivElement;
  private band: HTMLDivElement;
  private bandText: HTMLElement;
  private lastAttack = -1;

  constructor(parent: HTMLElement, private readonly gameOf: () => GameStateService) {
    this.flash = div('vs-flash', parent);
    this.band = div('vs-warnband', parent);
    this.bandText = document.createElement('span');
    this.band.appendChild(this.bandText);

    this.root = div('vs-alerts', parent);
    shieldInput(this.root);
  }

  update(game: GameStateService): void {
    const alerts = game.alerts.slice(0, MAX_ROWS);

    while (this.rows.length < alerts.length) this.rows.push(this.makeRow());
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const alert = alerts[i];
      if (!alert) {
        row.root.style.display = 'none';
        row.key = '';
        continue;
      }
      row.root.style.display = '';
      const key = `${alert.kind}|${alert.message}`;
      if (key !== row.key) {
        row.key = key;
        if (row.kind) row.root.classList.remove(`k-${row.kind}`);
        row.kind = alert.kind;
        row.root.classList.add(`k-${alert.kind}`);
        setIcon(row.ico, glyph(alert.kind, TINT[alert.kind] ?? '#ffb42a', 30));
        setText(row.msg, alert.message.toUpperCase());
        // Restart the entry animation only for a genuinely new row.
        row.root.style.animation = 'none';
        void row.root.offsetWidth;
        row.root.style.animation = '';
      }
      setText(row.age, alert.age < 1 ? 'NOW' : `${Math.floor(alert.age)}S`);
      setClass(row.root, 'stale', alert.age > 10);
      row.root.style.opacity = alert.age > 11 ? '0.55' : '1';
    }

    this.updateSiren(alerts);
  }

  /** Fires the screen treatments once per distinct attack warning. */
  private updateSiren(alerts: Alert[]): void {
    const attack = alerts.find((a) => a.kind === 'baseUnderAttack');
    if (!attack) {
      this.lastAttack = -1;
      return;
    }
    // `age` counts up, so a smaller age than last frame means a fresh warning.
    if (this.lastAttack >= 0 && attack.age >= this.lastAttack) {
      this.lastAttack = attack.age;
      return;
    }
    this.lastAttack = attack.age;
    this.bandText.textContent = 'BASE UNDER ATTACK';
    restart(this.flash, 'on');
    restart(this.band, 'on');
  }

  private makeRow(): Row {
    const root = div('vs-alert', this.root);
    const ico = icon('ico', root, '');
    const msg = div('msg', root);
    const age = div('age', root);
    const row: Row = { root, ico, msg, age, key: '', kind: '' };

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const index = this.rows.indexOf(row);
      const game = this.gameOf();
      const alert = game.alerts[index];
      if (!alert) return;
      if (e.button === 2) {
        game.dismissAlert(index);
        return;
      }
      if (alert.position) game.focusOn(alert.position);
    });
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    return row;
  }
}

/** Re-triggers a CSS animation by taking the class off for one layout tick. */
function restart(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
