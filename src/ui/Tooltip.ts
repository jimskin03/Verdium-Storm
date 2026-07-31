import { div, el, setClass, setText } from './dom';
import { plate } from './Widgets';

export interface TipContent {
  title: string;
  stats: Array<{ label: string; value: string; credit?: boolean }>;
  why?: string;
}

/**
 * One shared tooltip node, repositioned rather than recreated.
 *
 * It anchors to the left of its trigger because every trigger lives in the
 * right-hand sidebar; flowing right would push it off screen. Vertical position
 * is clamped so a tooltip on the last row of the build grid stays on screen.
 */
export class Tooltip {
  readonly root: HTMLDivElement;
  private titleNode: HTMLElement;
  private statsNode: HTMLElement;
  private whyNode: HTMLElement;
  private rows: Array<{ root: HTMLElement; label: HTMLElement; value: HTMLElement }> = [];
  private anchor: HTMLElement | null = null;

  constructor(parent: HTMLElement) {
    this.root = plate('cut-sm', parent, 'vs-tip');
    const inner = div('in', this.root);
    this.titleNode = div('ttl', inner);
    this.statsNode = div('stats', inner);
    this.whyNode = div('why', inner);
  }

  show(anchor: HTMLElement, content: TipContent): void {
    this.anchor = anchor;
    setText(this.titleNode, content.title);

    while (this.rows.length < content.stats.length) {
      const root = div('st', this.statsNode);
      this.rows.push({ root, label: el('b', '', root), value: el('span', '', root) });
    }
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const stat = content.stats[i];
      row.root.style.display = stat ? '' : 'none';
      if (!stat) continue;
      setText(row.label, stat.label);
      setText(row.value, stat.value);
      setClass(row.value, 'credit', !!stat.credit);
    }

    this.whyNode.style.display = content.why ? '' : 'none';
    if (content.why) setText(this.whyNode, content.why);

    this.root.classList.add('on');
    this.place();
  }

  hide(node?: HTMLElement): void {
    if (node && this.anchor !== node) return;
    this.anchor = null;
    this.root.classList.remove('on');
  }

  /** Re-anchors on every frame the tip is open; the build grid scrolls. */
  reposition(): void {
    if (this.anchor) this.place();
  }

  private place(): void {
    const anchor = this.anchor;
    if (!anchor) return;
    const host = this.root.offsetParent as HTMLElement | null;
    const hostRect = host ? host.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const a = anchor.getBoundingClientRect();
    const w = this.root.offsetWidth || 250;
    const h = this.root.offsetHeight || 90;
    const left = Math.max(8, a.left - hostRect.left - w - 12);
    const top = Math.max(8, Math.min(hostRect.height - h - 8, a.top - hostRect.top + a.height / 2 - h / 2));
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
  }
}
