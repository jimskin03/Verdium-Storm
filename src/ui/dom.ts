/**
 * Minimal DOM helpers for the HUD. The HUD is built from real elements rather
 * than a virtual DOM: the node graph is created once and mutated in place, so a
 * frame update touches only the handful of properties that actually changed.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

export function div(className = '', parent?: HTMLElement): HTMLDivElement {
  return el('div', className, parent);
}

/** Writes text only when it differs — avoids needless layout invalidation. */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function setClass(node: HTMLElement, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

/** Writes a custom property only when it differs. */
export function setVar(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** 1 234 567 → "1,234,567" */
export function group(n: number): string {
  const v = Math.abs(Math.round(n));
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** Zero-padded integer. */
export function pad(n: number, width: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

export function clockString(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(sec, 2)}` : `${pad(m, 2)}:${pad(sec, 2)}`;
}

/**
 * A value that eases toward a target and reports whether it is still moving.
 * Used for every numeric readout so credits and power never snap.
 */
export class Tween {
  value: number;
  target: number;
  /** Approach rate; higher settles faster. */
  rate: number;

  constructor(value = 0, rate = 6) {
    this.value = value;
    this.target = value;
    this.rate = rate;
  }

  set(target: number): void {
    this.target = target;
  }

  snap(v: number): void {
    this.value = v;
    this.target = v;
  }

  /** Returns true while the value is still visibly changing. */
  update(dt: number): boolean {
    const delta = this.target - this.value;
    if (Math.abs(delta) < 0.01) {
      if (this.value !== this.target) {
        this.value = this.target;
        return true;
      }
      return false;
    }
    // A floor on the approach speed keeps large jumps from crawling at the end
    // and makes the credit counter tick with a satisfying constant cadence.
    const step = delta * (1 - Math.exp(-this.rate * dt));
    const floor = Math.sign(delta) * Math.min(Math.abs(delta), Math.abs(this.target) * 0.9 * dt + 1.2);
    this.value += Math.abs(step) > Math.abs(floor) ? step : floor;
    return true;
  }
}

/** Attaches a pointer handler that also swallows the event from the 3D view. */
export function onPress(node: HTMLElement, handler: (e: PointerEvent) => void): void {
  node.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handler(e);
  });
}

/** Stops wheel/context events reaching the camera rig while over a panel. */
export function shieldInput(node: HTMLElement): void {
  node.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
  node.addEventListener('pointerdown', (e) => e.stopPropagation());
  node.addEventListener('pointermove', (e) => e.stopPropagation());
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}
