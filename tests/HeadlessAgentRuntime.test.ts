import { describe, expect, it } from 'vitest';
import { HeadlessAgentRuntime } from '../src/game/agent/HeadlessAgentRuntime';
import type { AgentControlService } from '../src/game/agent/AgentTypes';

describe('HeadlessAgentRuntime', () => {
  it('boots the simulation without a WebGL renderer and advances by manual steps', () => {
    const runtime = new HeadlessAgentRuntime({} as HTMLElement, {} as HTMLElement);
    try {
      const game = runtime.get<AgentControlService>('battlefield');
      expect(game).toBeDefined();
      expect(game?.agentObserve().tick).toBe(0);

      runtime.stepManual(1 / 15);
      expect(game?.agentObserve().tick).toBeGreaterThan(0);
      expect(game?.agentObserve().units.length).toBeGreaterThan(0);
    } finally {
      runtime.dispose();
    }
  });
});

