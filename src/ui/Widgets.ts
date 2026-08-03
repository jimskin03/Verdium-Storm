import { div, el, setClass, setText, setVar } from './dom';

/**
 * Small composite widgets shared by every HUD panel.
 *
 * These exist so the angular plate treatment, the hazard-striped caption bar and
 * the segmented meter are authored once. Every panel in the sidebar is built
 * from them, which is what makes the chrome read as one instrument cluster
 * rather than a stack of unrelated cards.
 */

/** A framed plate. `shape` picks one of the chamfer masks from the stylesheet. */
export function plate(shape: string, parent?: HTMLElement, extra = ''): HTMLDivElement {
  return div(`vs-plate ${shape}${extra ? ` ${extra}` : ''}`, parent);
}

/** Corner brackets. Two opposed corners read as "instrument"; four reads as busy. */
export function brackets(node: HTMLElement, corners: readonly string[] = ['tl', 'br']): void {
  for (const c of corners) div(`vs-bracket ${c}`, node);
}

export interface Caption {
  root: HTMLDivElement;
  title: HTMLSpanElement;
  meta: HTMLSpanElement;
}

/** The slanted, hatched header strip that tops every panel group. */
export function caption(parent: HTMLElement, title: string, meta = ''): Caption {
  const root = div('vs-cap', parent);
  div('dot', root);
  const t = el('span', 't-h2', root);
  t.textContent = title;
  div('fill', root);
  const m = el('span', 'meta', root);
  m.textContent = meta;
  return { root, title: t, meta: m };
}

export interface Meter {
  root: HTMLDivElement;
  fill: HTMLElement;
  value: HTMLSpanElement;
}

/**
 * Labelled segmented bar used for health, cargo and construction. The segment
 * overlay is a repeating gradient rather than N elements, so a meter costs one
 * node and one style write per update.
 */
export function meter(parent: HTMLElement, kind: 'hp' | 'cargo' | 'build', label: string): Meter {
  const root = div(`vs-meter ${kind}`, parent);
  const head = div('head', root);
  const b = el('b', '', head);
  b.textContent = label;
  const value = el('span', '', head);
  const track = div('track', root);
  const fill = el('i', '', track);
  div('segs', track);
  return { root, fill, value };
}

/** Writes a meter without touching the DOM when nothing moved. */
export function setMeter(m: Meter, ratio: number, text: string): void {
  setVar(m.fill, 'width', `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`);
  setText(m.value, text);
}

/** Health colour band shared by the meters, the chips and the world bars. */
export function healthBand(ratio: number): 'ok' | 'mid' | 'low' {
  return ratio > 0.6 ? 'ok' : ratio > 0.3 ? 'mid' : 'low';
}

export function applyBand(node: HTMLElement, ratio: number): void {
  const band = healthBand(ratio);
  setClass(node, 'mid', band === 'mid');
  setClass(node, 'low', band === 'low');
}

/** A div whose only job is to carry a generated icon as its background. */
export function icon(className: string, parent: HTMLElement, url: string): HTMLDivElement {
  const node = div(className, parent);
  node.style.backgroundImage = `url(${url})`;
  return node;
}

export function setIcon(node: HTMLElement, url: string): void {
  const value = `url(${url})`;
  if (node.style.backgroundImage !== value) node.style.backgroundImage = value;
}
