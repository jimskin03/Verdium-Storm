import type { Engine } from '@/engine/Engine';
import type { AgentCommand, AgentControlService } from './AgentTypes';

function enabled(): boolean {
  const params = new URLSearchParams(location.search);
  return import.meta.env.VITE_ENABLE_AGENT_API === 'true' && params.get('agent') === '1';
}

/** Installs the deliberately narrow, serialisable agent surface. */
export function installAgentBridge(engine: Engine): void {
  if (!enabled()) return;
  const game = engine.get('battlefield') as unknown as AgentControlService | undefined;
  if (!game) return;
  const bridge = {
    version: 1,
    ready: true,
    observe: () => game.agentObserve(),
    command: (requestId: string, action: AgentCommand) => game.agentCommand(requestId, action),
    events: (afterEventId = 0, limit = 200) => game.agentEvents(afterEventId, limit),
    start: () => game.agentStart(),
    step: (ticks: number) => {
      const count = Math.max(0, Math.min(10_000, Math.floor(ticks)));
      engine.stop();
      for (let i = 0; i < count; i++) engine.stepManual(game.agentFrameDt());
    },
  };
  (window as unknown as Record<string, unknown>).VS_AGENT = bridge;
  window.dispatchEvent(new CustomEvent('vs-agent-ready'));
}
