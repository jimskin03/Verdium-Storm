import type { BuildableId, EconomySnapshot } from '@/game/GameState';
import type { MultiplayerAction } from '@/game/Multiplayer';
import type { GameEvent } from './EventJournal';
import type { PacingId } from './Pacing';

export type AgentCommand = MultiplayerAction;
export interface CommandAck { requestId: string; status: 'accepted' | 'rejected'; code?: string; message?: string; tick: number; }
export interface ObservedEntity { id: string; team: 0 | 1; kind: 'unit' | 'building'; type: string; x: number; z: number; hp: number; maxHp: number; }
export interface AgentObservation { schemaVersion: 1; team: 0 | 1; tick: number; pacing: PacingId; economy: EconomySnapshot; own: ObservedEntity[]; visibleEnemies: ObservedEntity[]; lastEventId: number; }
export interface AgentControlService { agentObserve(): AgentObservation; agentCommand(requestId: string, action: AgentCommand): CommandAck; agentEvents(afterEventId?: number, limit?: number): GameEvent[]; agentStart(): void; agentFrameDt(): number; agentStep(ticks: number): void; }
