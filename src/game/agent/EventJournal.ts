export type EventVisibility = 'public' | 'team';

export interface GameEvent<T = Record<string, unknown>> {
  schemaVersion: 1;
  eventId: number;
  tick: number;
  type: string;
  visibility: EventVisibility;
  team?: 0 | 1;
  correlationId?: string;
  payload: T;
}

/** Bounded, serialisable event feed for agents and headless evidence bundles. */
export class EventJournal {
  private events: GameEvent[] = [];
  private listeners: Array<(event: GameEvent) => void> = [];
  private nextId = 1;
  constructor(private readonly capacity = 10_000) {}

  append<T extends Record<string, unknown>>(tick: number, type: string, visibility: EventVisibility, payload: T, team?: 0 | 1, correlationId?: string): GameEvent<T> {
    const event: GameEvent<T> = { schemaVersion: 1, eventId: this.nextId++, tick, type, visibility, ...(team === undefined ? {} : { team }), ...(correlationId ? { correlationId } : {}), payload: structuredClone(payload) };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const listener of this.listeners) {
      try { listener(event); } catch (err) { console.error('EventJournal listener error:', err); }
    }
    return event;
  }

  onAppend(listener: (event: GameEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  read(team: 0 | 1 | 2, afterEventId = 0, limit = 200): GameEvent[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
    return this.events
      .filter((event) => event.eventId > afterEventId && (event.visibility === 'public' || team === 2 || event.team === team))
      .slice(0, safeLimit)
      .map((event) => structuredClone(event));
  }

  get lastEventId(): number { return this.nextId - 1; }
}
