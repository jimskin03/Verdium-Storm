export type PacingId = 'classic' | 'deliberate';

export interface PacingProfile {
  id: PacingId;
  simulationRate: number;
  openingPeaceTicks: number;
  commanderThinkTicks: number;
  minimumWaveTicks: number;
  regroupTicks: number;
  startingForce: 'showcase' | 'opening';
}

export const PACING: Record<PacingId, PacingProfile> = {
  classic: { id: 'classic', simulationRate: 1, openingPeaceTicks: 0, commanderThinkTicks: 8, minimumWaveTicks: 0, regroupTicks: 660, startingForce: 'showcase' },
  deliberate: { id: 'deliberate', simulationRate: 0.5, openingPeaceTicks: 1800, commanderThinkTicks: 30, minimumWaveTicks: 5400, regroupTicks: 1350, startingForce: 'opening' },
};

export function pacingFrom(value: string | null | undefined): PacingProfile {
  return value === 'deliberate' ? PACING.deliberate : PACING.classic;
}
