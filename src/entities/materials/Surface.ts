import type { Faction } from '@/entities/Types';

/**
 * A surface is everything the shader needs to know about one patch of an entity
 * mesh, packed per-vertex. There is exactly one material for all entity
 * geometry in the game; the difference between rubber, rusted steel and painted
 * armour is carried in these attributes rather than in separate materials, so a
 * whole vehicle collapses into a single draw call.
 *
 * `grunge` cross-fades between the two synthesised texture layers: layer A is
 * machined/painted plate (panel lines, rivets, brushed grain, scratches), layer
 * B is rough composite (aggregate, rust blotches, cracks, speckle).
 */
export interface Surface {
  /** sRGB hex tint multiplied over the synthesised albedo. */
  color: number;
  /** Base roughness before the texture's ±0.28 modulation. */
  roughness: number;
  /** Base metalness before the texture's ±0.3 modulation. */
  metalness: number;
  /** Emissive strength, 0..8. Team lights and running lights use this. */
  emissive: number;
  /** 0..1 blend of the vertex tint toward the owning player's team colour. */
  team: number;
  /** 0..1 blend from texture layer A (plate) to layer B (rough composite). */
  grunge: number;
  /** Texture repeats per world unit. Keeps texel density constant across parts. */
  uvScale: number;
  /** How strongly convex edges wear through to bare metal. 0 disables. */
  wear: number;
}

const DEFAULTS: Surface = {
  color: 0x8b8f92,
  roughness: 0.62,
  metalness: 0.15,
  emissive: 0,
  team: 0,
  grunge: 0.12,
  uvScale: 0.34,
  wear: 0.55,
};

export type SurfaceName =
  | 'paint' | 'paintDark' | 'paintTrim' | 'armour' | 'metal' | 'darkMetal'
  | 'steel' | 'rust' | 'rubber' | 'tread' | 'concrete' | 'asphalt' | 'glass'
  | 'team' | 'lamp' | 'lampRed' | 'lampAmber' | 'fabric' | 'skin' | 'crystal';

const PRESETS: Record<SurfaceName, Partial<Surface>> = {
  // Painted plate. `color` is overridden per faction at build time.
  paint: { color: 0x8f8a72, roughness: 0.58, metalness: 0.12, grunge: 0.14, wear: 0.85 },
  paintDark: { color: 0x3c3f42, roughness: 0.62, metalness: 0.12, grunge: 0.2, wear: 0.8 },
  paintTrim: { color: 0xb08a3c, roughness: 0.44, metalness: 0.3, grunge: 0.1, wear: 0.7 },
  // Thick armour castings — coarser, chalkier, less glossy than sheet plate.
  armour: { color: 0x6f7168, roughness: 0.72, metalness: 0.18, grunge: 0.34, wear: 0.9 },
  metal: { color: 0x9aa0a6, roughness: 0.36, metalness: 0.94, grunge: 0.1, wear: 0.9 },
  darkMetal: { color: 0x4a4e54, roughness: 0.42, metalness: 0.9, grunge: 0.16, wear: 0.9 },
  steel: { color: 0x76797d, roughness: 0.3, metalness: 1.0, grunge: 0.06, wear: 1.0 },
  rust: { color: 0x7a4526, roughness: 0.88, metalness: 0.32, grunge: 0.92, wear: 0.4 },
  rubber: { color: 0x1b1c1e, roughness: 0.95, metalness: 0.02, grunge: 0.5, wear: 0.15 },
  tread: { color: 0x232427, roughness: 0.88, metalness: 0.22, grunge: 0.62, wear: 0.55 },
  concrete: { color: 0x8d8b83, roughness: 0.93, metalness: 0.0, grunge: 1.0, uvScale: 0.16, wear: 0.25 },
  asphalt: { color: 0x3a3a38, roughness: 0.96, metalness: 0.0, grunge: 1.0, uvScale: 0.2, wear: 0.2 },
  // Armoured glass: dark, near-mirror. Reads correctly without transparency.
  glass: { color: 0x0e1a1c, roughness: 0.07, metalness: 0.85, grunge: 0.0, wear: 0.2 },
  team: { color: 0xffffff, roughness: 0.5, metalness: 0.1, team: 1, grunge: 0.08, wear: 0.6 },
  lamp: { color: 0xfff0d0, roughness: 0.3, metalness: 0.0, emissive: 4.5, grunge: 0.0, wear: 0 },
  lampRed: { color: 0xff3a24, roughness: 0.3, metalness: 0.0, emissive: 5.0, grunge: 0.0, wear: 0 },
  lampAmber: { color: 0xffa11c, roughness: 0.3, metalness: 0.0, emissive: 4.2, grunge: 0.0, wear: 0 },
  fabric: { color: 0x555c3e, roughness: 0.97, metalness: 0.0, grunge: 0.75, uvScale: 0.9, wear: 0.1 },
  skin: { color: 0x8a6247, roughness: 0.82, metalness: 0.0, grunge: 0.35, uvScale: 1.2, wear: 0 },
  crystal: { color: 0x2fe07a, roughness: 0.14, metalness: 0.35, emissive: 1.6, grunge: 0.0, wear: 0 },
};

/** Builds a surface from a preset with optional per-part overrides. */
export function surf(name: SurfaceName, over?: Partial<Surface>): Surface {
  return { ...DEFAULTS, ...PRESETS[name], ...over };
}

/**
 * Faction design language, expressed as colour. GDI reads as sand-and-olive
 * industrial military; Nod as gunmetal with crimson heat.
 */
export interface Palette {
  /** Main painted hull colour. */
  primary: number;
  /** Secondary panels, skirts, roof plate. */
  secondary: number;
  /** Deep shadow parts, recesses, underbody. */
  dark: number;
  /** Faction trim — gold for GDI, crimson for Nod. Small accents only. */
  accent: number;
  /** Exposed structural metal. */
  metal: number;
  /** Emissive faction light colour (cockpit glow, vents). */
  glow: number;
}

export const PALETTES: Record<Faction, Palette> = {
  gdi: {
    primary: 0x9a9070,
    secondary: 0x6d6a56,
    dark: 0x393b34,
    accent: 0xc2933a,
    metal: 0x8d9298,
    glow: 0x7fd8ff,
  },
  nod: {
    primary: 0x43464d,
    secondary: 0x2b2d33,
    dark: 0x17181c,
    accent: 0x9c2226,
    metal: 0x6d7076,
    glow: 0xff4326,
  },
};
