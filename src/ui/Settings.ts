import { div, el, onPress, setClass } from './dom';
import { brackets, caption, plate } from './Widgets';

/**
 * The settings overlay: camera controls plus the two toggles that used to
 * only exist on the pre-match screen, now reachable mid-match too (from the
 * top bar's gear icon or the pause screen) since there was previously no way
 * to change any of this once a match had started.
 */

export const CAM_SPEED_STEPS = [0.6, 1, 1.5, 2.2] as const;

export interface SettingsValues {
  edgeScroll: boolean;
  camSpeed: number;
  healthBars: boolean;
  fogOfWar: boolean;
}

type Key = keyof SettingsValues;

export class Settings {
  readonly root: HTMLDivElement;

  private boolSegs = new Map<Key, { on: HTMLDivElement; off: HTMLDivElement }>();
  private speedOpts: HTMLDivElement[] = [];

  constructor(
    parent: HTMLElement,
    private readonly values: SettingsValues,
    private readonly onChange: <K extends Key>(key: K, value: SettingsValues[K]) => void,
    private readonly onClose: () => void,
  ) {
    this.root = div('vs-settings', parent);
    const panel = plate('cut-tl-br', this.root, 'vs-setpanel');
    brackets(panel, ['tl', 'br']);
    const inner = div('in', panel);

    caption(inner, 'SETTINGS', 'CAMERA & DISPLAY');

    const rows = div('vs-setrows', inner);
    this.boolRow(rows, 'EDGE SCROLL', 'edgeScroll');
    this.speedRow(rows);
    this.boolRow(rows, 'TACTICAL OVERLAY', 'healthBars');
    this.boolRow(rows, 'FOG OF WAR', 'fogOfWar');

    const buttons = div('vs-mbtns', inner);
    const close = div('vs-mbtn primary', buttons);
    close.textContent = 'CLOSE';
    onPress(close, () => this.onClose());
  }

  private boolRow(parent: HTMLElement, label: string, key: Key): void {
    const row = div('vs-setrow', parent);
    const lbl = el('b', '', row);
    lbl.textContent = label;
    const seg = div('vs-seg', row);
    const on = div('o', seg);
    on.textContent = 'ON';
    const off = div('o', seg);
    off.textContent = 'OFF';
    const apply = (value: boolean): void => {
      (this.values[key] as boolean) = value;
      setClass(on, 'on', value);
      setClass(off, 'on', !value);
      this.onChange(key, value as SettingsValues[typeof key]);
    };
    onPress(on, () => apply(true));
    onPress(off, () => apply(false));
    this.boolSegs.set(key, { on, off });
    setClass(on, 'on', this.values[key] as boolean);
    setClass(off, 'on', !(this.values[key] as boolean));
  }

  private speedRow(parent: HTMLElement): void {
    const row = div('vs-setrow', parent);
    const lbl = el('b', '', row);
    lbl.textContent = 'CAMERA SPEED';
    const seg = div('vs-seg', row);
    this.speedOpts = CAM_SPEED_STEPS.map((step) => {
      const opt = div('o', seg);
      opt.textContent = `${step}×`;
      onPress(opt, () => {
        this.values.camSpeed = step;
        this.syncSpeed();
        this.onChange('camSpeed', step);
      });
      return opt;
    });
    this.syncSpeed();
  }

  private syncSpeed(): void {
    CAM_SPEED_STEPS.forEach((step, i) => setClass(this.speedOpts[i], 'on', step === this.values.camSpeed));
  }

  /** Refreshes every control from `values` — used when the panel is reopened. */
  sync(): void {
    for (const [key, seg] of this.boolSegs) {
      const value = this.values[key] as boolean;
      setClass(seg.on, 'on', value);
      setClass(seg.off, 'on', !value);
    }
    this.syncSpeed();
  }

  show(): void {
    this.sync();
    setClass(this.root, 'on', true);
  }

  hide(): void {
    setClass(this.root, 'on', false);
  }
}

export default Settings;
