import type { Faction } from '@/entities/Types';

/**
 * Faction visual identity. The HUD re-themes wholesale when the player picks a
 * side: accent hue, panel tint, bevel colour, crest and copy all come from here
 * so nothing is hard-coded to one faction.
 */
export interface FactionTheme {
  id: Faction;
  /** Three-letter mark used on the crest. */
  mark: string;
  name: string;
  motto: string;
  doctrine: string;
  /** Primary accent — frames, active states, headings. */
  accent: string;
  accentSoft: string;
  accentDeep: string;
  /** Secondary accent used for informational chrome. */
  cool: string;
  /** Panel gradient stops, dark → slightly lighter. */
  panelLo: string;
  panelHi: string;
  /** Hairline frame colour. */
  edge: string;
  edgeHot: string;
  /** Colour of the in-world selection reticle for the player's team. */
  reticle: number;
  traits: Array<{ label: string; value: number }>;
}

export const FACTIONS: Record<Faction, FactionTheme> = {
  gdi: {
    id: 'gdi',
    mark: 'GDI',
    name: 'GROUND DEFENCE INITIATIVE',
    motto: 'ORDER THROUGH STRENGTH',
    doctrine:
      'Armoured line doctrine. Heavier hulls, superior sustained fire and orbital support. Slower to field, near impossible to dislodge.',
    accent: '#ffb42a',
    accentSoft: '#ffd98a',
    accentDeep: '#8a5c07',
    cool: '#6fc9ff',
    panelLo: '#070c10',
    panelHi: '#16212a',
    edge: 'rgba(255, 180, 42, 0.34)',
    edgeHot: 'rgba(255, 208, 120, 0.95)',
    reticle: 0x4fd2ff,
    traits: [
      { label: 'ARMOUR', value: 0.9 },
      { label: 'FIREPOWER', value: 0.78 },
      { label: 'MOBILITY', value: 0.42 },
      { label: 'TECH', value: 0.7 },
    ],
  },
  nod: {
    id: 'nod',
    mark: 'NOD',
    name: 'NIGHT ORDER DOMINION',
    motto: 'ASCENSION THROUGH FIRE',
    doctrine:
      'Asymmetric strike doctrine. Cheap swarms, stealth infiltration and incendiary weapons. Fragile in the open, lethal from the dark.',
    accent: '#ff4326',
    accentSoft: '#ff9d7a',
    accentDeep: '#7d1405',
    cool: '#ff8a4a',
    panelLo: '#0b0507',
    panelHi: '#241115',
    edge: 'rgba(255, 67, 38, 0.36)',
    edgeHot: 'rgba(255, 140, 110, 0.95)',
    reticle: 0xff6a3c,
    traits: [
      { label: 'ARMOUR', value: 0.44 },
      { label: 'FIREPOWER', value: 0.86 },
      { label: 'MOBILITY', value: 0.92 },
      { label: 'TECH', value: 0.62 },
    ],
  },
};

/** Non-faction palette constants shared by every theme. */
export const PALETTE = {
  credit: '#66ffae',
  creditDim: '#1d6f47',
  power: '#54c8ff',
  powerWarn: '#ffb02e',
  powerBad: '#ff4633',
  danger: '#ff3b2a',
  ok: '#63e08a',
  ink: '#d6e4ec',
  inkDim: '#7f95a2',
  inkMute: '#4c5f6b',
  teamAlly: '#3fa9ff',
  teamEnemy: '#ff5a3c',
  neutral: '#9aa7ad',
};

export function applyTheme(root: HTMLElement, theme: FactionTheme): void {
  const s = root.style;
  s.setProperty('--accent', theme.accent);
  s.setProperty('--accent-soft', theme.accentSoft);
  s.setProperty('--accent-deep', theme.accentDeep);
  s.setProperty('--cool', theme.cool);
  s.setProperty('--panel-lo', theme.panelLo);
  s.setProperty('--panel-hi', theme.panelHi);
  s.setProperty('--edge', theme.edge);
  s.setProperty('--edge-hot', theme.edgeHot);
  root.dataset.faction = theme.id;
}
