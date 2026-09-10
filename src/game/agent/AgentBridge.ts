import type { Engine } from '@/engine/Engine';
import type {
  AgentBridgeApi,
  AgentCommand,
  AgentControlService,
  WaitForOptions,
} from './AgentTypes';
import type { GameEvent } from './EventJournal';
import type { System } from '@/engine/System';

const AGENT_CAPABILITIES = [
  'observe', 'command', 'events', 'waitFor',
  'createRoom', 'joinRoom', 'spectateRoom', 'roomStatus', 'launchRoom', 'setRoomReady', 'disconnectRoom',
  'start', 'step',
];

export interface AgentBridgeHost {
  get<T extends System>(name: string): T | undefined;
  stop(): void;
  stepManual(dt: number): void;
  start?(): void;
}

function enabled(): boolean {
  if (import.meta.env.VITE_ENABLE_AGENT_API === 'false') return false;
  const search = typeof location !== 'undefined' ? location.search : '';
  const params = new URLSearchParams(search);
  return params.get('agent') === '1' || import.meta.env.VITE_ENABLE_AGENT_API === 'true';
}

function notReady(): Error {
  return new Error('VS_AGENT is still booting; wait for the vs-agent-ready event.');
}

/** Publishes a stable marker before WebGL or optional systems are touched. */
export function installAgentBootstrap(): void {
  if (!enabled()) return;
  const globalTarget = typeof window !== 'undefined' ? window : globalThis;
  const existing = (globalTarget as unknown as { VS_AGENT?: Partial<AgentBridgeApi> }).VS_AGENT;
  if (existing?.ready) return;

  const fail = (): never => { throw notReady(); };
  const bootstrap = {
    version: 2 as const,
    ready: false,
    capabilities: () => [...AGENT_CAPABILITIES],
    observe: fail,
    command: fail,
    events: fail,
    waitFor: async () => fail(),
    createRoom: async () => fail(),
    joinRoom: async () => fail(),
    spectateRoom: async () => fail(),
    roomStatus: fail,
    launchRoom: fail,
    setRoomReady: fail,
    disconnectRoom: fail,
    getSpectatorInfo: fail,
    start: fail,
    step: fail,
  } as unknown as AgentBridgeApi;
  (globalTarget as unknown as Record<string, unknown>).VS_AGENT = bootstrap;
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vs-agent-bootstrap'));
  }
}

/** Installs the rich, serialisable agent surface on window.VS_AGENT. */
export function installAgentBridge(engine: AgentBridgeHost): void {
  if (!enabled()) return;
  const game = engine.get('battlefield') as unknown as AgentControlService | undefined;
  if (!game) return;

  const bridge: AgentBridgeApi = {
    version: 2,
    ready: true,
    capabilities: () => [...AGENT_CAPABILITIES],
    observe: () => game.agentObserve(),
    command: (requestId: string, action: AgentCommand) => game.agentCommand(requestId, action),
    events: (afterEventId = 0, limit = 200) => game.agentEvents(afterEventId, limit),
    getSpectatorInfo: () => game.getSpectatorInfo(),
    waitFor: (options?: WaitForOptions): Promise<GameEvent | null> => {
      const {
        afterEventId,
        types,
        maxTicks,
        timeoutMs = 15000,
        predicate,
      } = options || {};

      const currentObservation = game.agentObserve();
      const startTick = currentObservation.tick;
      const startEventId = afterEventId !== undefined ? afterEventId : currentObservation.lastEventId;

      // Check if an existing event matches right now
      const existingEvents = game.agentEvents(startEventId, 200);
      for (const event of existingEvents) {
        if (types && !types.includes(event.type)) continue;
        if (predicate && !predicate(event)) continue;
        return Promise.resolve(event);
      }

      return new Promise<GameEvent | null>((resolve) => {
        let resolved = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;

        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          if (timer !== null) clearTimeout(timer);
          unsubscribe?.();
        };

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            cleanup();
            resolve(null);
          }, timeoutMs);
        }

        unsubscribe = game.onJournalEvent((event: GameEvent) => {
          if (resolved) return;
          if (event.eventId <= startEventId) return;

          if (maxTicks !== undefined && event.tick - startTick > maxTicks) {
            cleanup();
            resolve(null);
            return;
          }

          if (types && !types.includes(event.type)) return;
          if (predicate && !predicate(event)) return;

          cleanup();
          resolve(event);
        });
      });
    },
    createRoom: (password: string, name?: string) => game.agentCreateRoom(password, name),
    joinRoom: (roomCode: string, password: string, name?: string) => game.agentJoinRoom(roomCode, password, name),
    spectateRoom: (roomCode: string, password: string) => game.agentSpectateRoom(roomCode, password),
    roomStatus: () => game.agentRoomStatus(),
    launchRoom: () => game.agentLaunchRoom(),
    setRoomReady: (ready = true) => game.agentSetRoomReady(ready),
    disconnectRoom: () => game.agentDisconnectRoom(),
    start: () => {
      game.agentStart();
      engine.start?.();
    },
    step: (ticks: number) => {
      const count = Math.max(0, Math.min(10_000, Math.floor(ticks)));
      engine.stop();
      for (let i = 0; i < count; i++) engine.stepManual(game.agentFrameDt());
    },
  };

  const globalTarget = typeof window !== 'undefined' ? window : globalThis;
  (globalTarget as unknown as Record<string, unknown>).VS_AGENT = bridge;
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vs-agent-ready'));
  }

  console.log(
    '%c[Verdium Storm] VS_AGENT active.%c\n' +
      'Agent API bridge installed on window.VS_AGENT.\n' +
      'Methods:\n' +
      ' • VS_AGENT.capabilities()        -> List the stable control-plane methods\n' +
      ' • VS_AGENT.createRoom(password, name?) -> Create and connect a multiplayer room\n' +
      ' • VS_AGENT.joinRoom(code, pass, name?) -> Join and connect a multiplayer room\n' +
      ' • VS_AGENT.roomStatus()          -> Read both commander names, teams, connection and readiness\n' +
      ' • VS_AGENT.setRoomReady(true)    -> Signal readiness (normally automatic)\n' +
      ' • VS_AGENT.disconnectRoom()      -> Leave the room cleanly\n' +
      ' • VS_AGENT.launchRoom()          -> Legacy host launch request; ready rooms auto-start\n' +
      ' • VS_AGENT.observe()              -> Read tactical state (units, production, resources, spectator info)\n' +
      ' • VS_AGENT.command(reqId, action) -> Issue normalized player orders with granular error codes\n' +
      ' • VS_AGENT.events(afterId, limit) -> Read event journal\n' +
      ' • VS_AGENT.waitFor(options)       -> Asynchronously wait for game event(s)\n' +
      ' • VS_AGENT.getSpectatorInfo()     -> Get room code & passcode for operator to view\n' +
      ' • VS_AGENT.start() / step(ticks)  -> Control deterministic stepping',
    'color: #00ff88; font-weight: bold;',
    'color: inherit;',
  );
}
