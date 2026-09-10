import type { BuildableId, EconomySnapshot } from '@/game/GameState';
import type { LobbySnapshot, MultiplayerAction } from '@/game/Multiplayer';
import type { GameEvent } from './EventJournal';
import type { PacingId } from './Pacing';

export type AgentCommand =
  | MultiplayerAction
  | {
      type: 'order';
      ref?: number | string;
      refs?: Array<number | string>;
      order: string | number;
      x?: number;
      z?: number;
      target?: number | string;
      queued?: boolean;
    }
  | {
      type: 'move';
      ref?: number | string;
      refs?: Array<number | string>;
      x: number;
      z: number;
      queued?: boolean;
    }
  | {
      type: 'attack';
      ref?: number | string;
      refs?: Array<number | string>;
      target: number | string;
      queued?: boolean;
    }
  | {
      type: 'attack-move';
      ref?: number | string;
      refs?: Array<number | string>;
      x: number;
      z: number;
      queued?: boolean;
    }
  | {
      type: 'rally';
      ref: number | string;
      x: number;
      z: number;
    }
  | {
      type: 'stance';
      ref?: number | string;
      refs?: Array<number | string>;
      stance: string | number;
    }
  | {
      type: 'stop';
      ref?: number | string;
      refs?: Array<number | string>;
    };

export interface CommandAck {
  requestId: string;
  status: 'accepted' | 'rejected';
  code?: string;
  message?: string;
  tick: number;
}

export interface ObservedEntity {
  id: number;
  team: 0 | 1;
  kind: 'unit' | 'building';
  type: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  order?: string;
  can?: string[];
  buildProgress?: number;
  ready?: boolean;
}

export interface ObservedProductionQueueItem {
  id: string;
  kind: 'unit' | 'building';
  progress: number;
  cost: number;
}

export interface ObservedAvailableBuild {
  id: string;
  label: string;
  kind: 'unit' | 'building';
  cost: number;
  buildTime: number;
  available: boolean;
  lockedReason?: string;
  progress: number;
  queued: number;
  readyToPlace: boolean;
}

export interface ObservedProduction {
  queue: ObservedProductionQueueItem[];
  readyToPlace: string | null;
  available: ObservedAvailableBuild[];
}

export interface ObservedResourceField {
  id: number;
  x: number;
  z: number;
  radius: number;
  known: boolean;
  visible: boolean;
  remaining: number;
  max: number;
}

export interface SpectatorInfo {
  available: boolean;
  roomCode?: string;
  passcode?: string;
  url?: string;
  instructions: string;
}

export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  size: number;
}

export interface ObjectivesSummary {
  status: 'opening' | 'active' | 'won' | 'lost' | 'draw';
  primary: string;
  peaceTicksRemaining: number;
}

export interface AgentObservation {
  schemaVersion: 1;
  team: 0 | 1 | 2;
  tick: number;
  matchTime: number;
  pacing: PacingId;
  status: 'opening' | 'active' | 'won' | 'lost' | 'draw';
  economy: EconomySnapshot;
  units: ObservedEntity[];
  own: ObservedEntity[];
  visibleEnemies: ObservedEntity[];
  resources: ObservedResourceField[];
  production: ObservedProduction;
  objectives: ObjectivesSummary;
  availableCommands: string[];
  map: MapBounds;
  spectator: SpectatorInfo;
  lastEventId: number;
}

export interface WaitForOptions {
  afterEventId?: number;
  types?: string[];
  maxTicks?: number;
  timeoutMs?: number;
  predicate?: (event: GameEvent) => boolean;
}

export interface AgentBridgeApi {
  version: 2;
  ready: boolean;
  capabilities: () => string[];
  observe: () => AgentObservation;
  command: (requestId: string, action: AgentCommand) => CommandAck;
  events: (afterEventId?: number, limit?: number) => GameEvent[];
  waitFor: (options?: WaitForOptions) => Promise<GameEvent | null>;
  createRoom: (password: string, name?: string) => Promise<LobbySnapshot>;
  joinRoom: (roomCode: string, password: string, name?: string) => Promise<LobbySnapshot>;
  spectateRoom: (roomCode: string, password: string) => Promise<LobbySnapshot>;
  roomStatus: () => LobbySnapshot;
  launchRoom: () => boolean;
  setRoomReady: (ready?: boolean) => boolean;
  disconnectRoom: () => void;
  getSpectatorInfo: () => SpectatorInfo;
  start: () => void;
  step: (ticks: number) => void;
}

export interface AgentControlService {
  agentObserve(): AgentObservation;
  agentCommand(requestId: string, action: AgentCommand): CommandAck;
  agentEvents(afterEventId?: number, limit?: number): GameEvent[];
  agentStart(): void;
  agentFrameDt(): number;
  agentStep(ticks: number): void;
  agentCreateRoom(password: string, name?: string): Promise<LobbySnapshot>;
  agentJoinRoom(roomCode: string, password: string, name?: string): Promise<LobbySnapshot>;
  agentSpectateRoom(roomCode: string, password: string): Promise<LobbySnapshot>;
  agentRoomStatus(): LobbySnapshot;
  agentLaunchRoom(): boolean;
  agentSetRoomReady(ready?: boolean): boolean;
  agentDisconnectRoom(): void;
  getSpectatorInfo(): SpectatorInfo;
  onJournalEvent(listener: (event: GameEvent) => void): () => void;
}
