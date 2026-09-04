import type { Team } from '@/entities/Types';
import type { BuildableId } from './GameState';

/**
 * Commands that alter simulation state and therefore have to be replayed by
 * the other commander. Selection and camera movements deliberately stay local.
 */
export type MultiplayerAction =
  | { type: 'queue-build'; id: BuildableId }
  | { type: 'cancel-build'; id: BuildableId }
  | { type: 'place-building'; x: number; z: number }
  | { type: 'orders'; orders: Array<{ ref: number; order: number; x: number; z: number; target: number; queued: boolean }>; rally: Array<{ ref: number; x: number; z: number }> }
  | { type: 'stance'; refs: number[]; stance: number }
  | { type: 'stop'; refs: number[] };

export type LobbyState = 'idle' | 'waiting' | 'joining' | 'ready' | 'launched' | 'error';

export interface LobbySnapshot {
  state: LobbyState;
  roomCode: string;
  isHost: boolean;
  team: Team;
  message: string;
}

interface MultiplayerLobbyOptions {
  serverUrl?: string;
  fetch?: typeof globalThis.fetch;
  webSocket?: (url: string) => WebSocketLike;
}

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event | MessageEvent) => void): void;
}

type SessionResponse = {
  protocolVersion: number;
  roomCode: string;
  sessionToken: string;
  isHost: boolean;
  team: Team;
  seed: number;
};

type RoomSnapshotMessage = {
  type: 'room_snapshot';
  protocolVersion: number;
  roomCode: string;
  state: 'waiting' | 'ready' | 'launched';
  isHost: boolean;
  team: Team;
  seed: number;
  connectedPlayers: number;
};

type WireMessage =
  | RoomSnapshotMessage
  | { type: 'action'; requestId: string; serverSequence: number; action: MultiplayerAction }
  | { type: 'action_ack'; requestId: string; serverSequence: number; duplicate: boolean }
  | { type: 'room_closed'; code: string; message: string }
  | { type: 'error'; code: string; message: string };

const PROTOCOL_VERSION = 1;
const PASSWORD_MIN_BYTES = 8;
const PASSWORD_MAX_BYTES = 64;
const SOCKET_OPEN = 1;

/**
 * A two-commander lobby backed by Verdium's independent room server. HTTP owns
 * room creation and password verification; an authenticated WebSocket carries
 * authoritative lobby snapshots and sequenced gameplay commands.
 */
export class MultiplayerLobby {
  private socket: WebSocketLike | null = null;
  private requestController: AbortController | null = null;
  private connectionGeneration = 0;
  private nextClientSequence = 1;
  private readonly serverUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch | null;
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | null;
  private launchHandlers: Array<() => void> = [];
  private actionHandlers: Array<(action: MultiplayerAction) => void> = [];
  private stateHandlers: Array<(snapshot: LobbySnapshot) => void> = [];

  private _state: LobbyState = 'idle';
  private _roomCode = '';
  private _isHost = false;
  private _team: Team = 0;
  private _seed = 0;
  private _message = 'Create a room or join an existing two-player room.';

  constructor(options: MultiplayerLobbyOptions = {}) {
    const configuredUrl = options.serverUrl !== undefined ? options.serverUrl : defaultServerUrl();
    this.serverUrl = normalizeServerUrl(configuredUrl);
    this.fetchImpl = options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.webSocketFactory = options.webSocket
      ?? (typeof globalThis.WebSocket === 'function' ? (url) => new globalThis.WebSocket(url) : null);
  }

  get state(): LobbyState { return this._state; }
  get roomCode(): string { return this._roomCode; }
  get isHost(): boolean { return this._isHost; }
  get team(): Team { return this._team; }
  get seed(): number { return this._seed; }
  get isReady(): boolean { return this._state === 'ready'; }
  get isLaunched(): boolean { return this._state === 'launched'; }

  snapshot(): LobbySnapshot {
    return {
      state: this._state,
      roomCode: this._roomCode,
      isHost: this._isHost,
      team: this._team,
      message: this._message,
    };
  }

  subscribe(listener: (snapshot: LobbySnapshot) => void): () => void {
    this.stateHandlers.push(listener);
    listener(this.snapshot());
    return () => {
      const index = this.stateHandlers.indexOf(listener);
      if (index >= 0) this.stateHandlers.splice(index, 1);
    };
  }

  onLaunch(listener: () => void): () => void {
    this.launchHandlers.push(listener);
    return () => {
      const index = this.launchHandlers.indexOf(listener);
      if (index >= 0) this.launchHandlers.splice(index, 1);
    };
  }

  onAction(listener: (action: MultiplayerAction) => void): () => void {
    this.actionHandlers.push(listener);
    return () => {
      const index = this.actionHandlers.indexOf(listener);
      if (index >= 0) this.actionHandlers.splice(index, 1);
    };
  }

  async create(password: string): Promise<boolean> {
    if (!validPassword(password)) {
      this.setState('error', `Use a room password between ${PASSWORD_MIN_BYTES} and ${PASSWORD_MAX_BYTES} UTF-8 bytes.`);
      return false;
    }
    if (!this.hasNetworkTransport()) return false;
    this.resetConnection();
    const generation = this.connectionGeneration;
    const controller = new AbortController();
    this.requestController = controller;
    this.setState('joining', 'Creating secure network room…');
    const session = await this.roomRequest('/api/rooms', password, controller.signal);
    if (generation !== this.connectionGeneration) return false;
    this.requestController = null;
    if (!session) return false;
    return this.connect(session, generation);
  }

  async join(roomCode: string, password: string): Promise<boolean> {
    const normalizedRoom = roomCode.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalizedRoom)) {
      this.setState('error', 'Enter the six-character room code from the host.');
      return false;
    }
    if (!validPassword(password)) {
      this.setState('error', `Enter the room password (${PASSWORD_MIN_BYTES}–${PASSWORD_MAX_BYTES} UTF-8 bytes).`);
      return false;
    }
    if (!this.hasNetworkTransport()) return false;
    this.resetConnection();
    const generation = this.connectionGeneration;
    const controller = new AbortController();
    this.requestController = controller;
    this.setState('joining', `Connecting to room ${normalizedRoom}…`);
    const session = await this.roomRequest(`/api/rooms/${normalizedRoom}/join`, password, controller.signal);
    if (generation !== this.connectionGeneration) return false;
    this.requestController = null;
    if (!session) return false;
    return this.connect(session, generation);
  }

  /** Only the room creator can launch once both command slots are occupied. */
  launch(): boolean {
    if (!this._isHost || !this.isReady) return false;
    return this.send({ type: 'launch', requestId: makeId(20) });
  }

  sendAction(action: MultiplayerAction): void {
    if (!this.isLaunched) return;
    const sent = this.send({
      type: 'action',
      requestId: makeId(20),
      clientSequence: this.nextClientSequence,
      action,
    });
    if (sent) this.nextClientSequence++;
  }

  close(): void {
    if (this.socket?.readyState === SOCKET_OPEN) this.send({ type: 'leave' });
    this.resetConnection();
    this.setState('idle', 'Create a room or join an existing two-player room.');
  }

  private hasNetworkTransport(): boolean {
    if (!this.serverUrl) {
      this.setState('error', 'Remote multiplayer is not configured for this deployment.');
      return false;
    }
    if (!this.fetchImpl || !this.webSocketFactory) {
      this.setState('error', 'This browser cannot establish the multiplayer network link.');
      return false;
    }
    return true;
  }

  private async roomRequest(path: string, password: string, signal: AbortSignal): Promise<SessionResponse | null> {
    try {
      const response = await this.fetchImpl!(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
        signal,
      });
      const body = await response.json() as Partial<SessionResponse> & { message?: string };
      if (!response.ok) {
        this.setState('error', body.message ?? 'Unable to reach the multiplayer room.');
        return null;
      }
      if (!validSession(body)) throw new Error('Room server returned an invalid session');
      return body;
    } catch (error) {
      if (signal.aborted) return null;
      console.warn('Verdium multiplayer room request failed:', safeErrorMessage(error));
      this.setState('error', 'Unable to reach the Verdium multiplayer server. It may be waking up; try again shortly.');
      return null;
    }
  }

  private connect(session: SessionResponse, generation: number): Promise<boolean> {
    if (generation !== this.connectionGeneration) return Promise.resolve(false);
    this._roomCode = session.roomCode;
    this._isHost = session.isHost;
    this._team = session.team;
    this._seed = session.seed;
    this.nextClientSequence = 1;
    return new Promise((resolve) => {
      let settled = false;
      let socket: WebSocketLike;
      try {
        socket = this.webSocketFactory!(webSocketUrl(this.serverUrl));
      } catch (error) {
        console.warn('Verdium multiplayer socket creation failed:', safeErrorMessage(error));
        this.setState('error', 'Unable to open the multiplayer network link.');
        resolve(false);
        return;
      }
      this.socket = socket;
      const finish = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(success);
      };
      const timeout = globalThis.setTimeout(() => {
        if (generation !== this.connectionGeneration) return;
        this.setState('error', 'The multiplayer server did not respond in time.');
        socket.close(4000, 'Connection timeout');
        finish(false);
      }, 12_000);

      socket.addEventListener('open', () => {
        if (generation !== this.connectionGeneration) return;
        socket.send(JSON.stringify({
          type: 'authenticate',
          protocolVersion: PROTOCOL_VERSION,
          roomCode: session.roomCode,
          sessionToken: session.sessionToken,
        }));
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.connectionGeneration || !('data' in event)) return;
        const message = parseWireMessage(event.data);
        if (!message) return;
        if (message.type === 'room_snapshot') finish(true);
        this.handleMessage(message);
      });
      socket.addEventListener('error', () => {
        if (generation !== this.connectionGeneration) return;
        if (!settled) {
          this.setState('error', 'Unable to establish the multiplayer network link.');
          finish(false);
        }
      });
      socket.addEventListener('close', () => {
        if (generation !== this.connectionGeneration) return;
        this.socket = null;
        if (this._state !== 'idle' && this._state !== 'error') {
          this.setState('error', 'The multiplayer connection closed. Create a new room to continue.');
        }
        finish(false);
      });
    });
  }

  private handleMessage(message: WireMessage): void {
    if (message.type === 'room_snapshot') {
      if (!validRoomSnapshot(message) || message.roomCode !== this._roomCode) return;
      this._isHost = message.isHost;
      this._team = message.team;
      this._seed = message.seed;
      if (message.state === 'waiting') {
        this.setState('waiting', `Room ${this._roomCode} is online. Waiting for Commander 2.`);
      } else if (message.state === 'ready') {
        this.setState('ready', this._isHost
          ? 'Commander 2 connected. Select DEPLOY to start the match.'
          : 'Connected as Commander 2. Awaiting host deployment order.');
      } else if (this._state !== 'launched') {
        this.launchLocal();
      }
      return;
    }
    if (message.type === 'action' && this.isLaunched && validServerAction(message)) {
      for (const handler of this.actionHandlers) handler(message.action);
      return;
    }
    if (message.type === 'room_closed') {
      this.setState('error', message.message);
      return;
    }
    if (message.type === 'error') {
      if (this.isLaunched) console.warn(`Verdium multiplayer command rejected (${message.code}): ${message.message}`);
      else this.setState('error', message.message);
    }
  }

  private send(message: object): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private resetConnection(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.connectionGeneration++;
    this.socket?.close(1000, 'Lobby reset');
    this.socket = null;
    this._roomCode = '';
    this._isHost = false;
    this._team = 0;
    this._seed = 0;
    this.nextClientSequence = 1;
  }

  private launchLocal(): void {
    this.setState('launched', 'Match link established. Command your faction.');
    for (const handler of this.launchHandlers) handler();
  }

  private setState(state: LobbyState, message: string): void {
    this._state = state;
    this._message = message;
    const snapshot = this.snapshot();
    for (const handler of this.stateHandlers) handler(snapshot);
  }
}

function validPassword(password: string): boolean {
  const bytes = new TextEncoder().encode(password).byteLength;
  return bytes >= PASSWORD_MIN_BYTES && bytes <= PASSWORD_MAX_BYTES;
}

function defaultServerUrl(): string {
  const configured = import.meta.env.VITE_MULTIPLAYER_SERVER_URL?.trim();
  if (configured) return configured;
  if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    return 'http://localhost:8787';
  }
  return '';
}

function normalizeServerUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol === 'http:' && !loopback) return '';
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function webSocketUrl(serverUrl: string): string {
  const url = new URL('/ws', `${serverUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function validSession(value: Partial<SessionResponse>): value is SessionResponse {
  return value.protocolVersion === PROTOCOL_VERSION
    && typeof value.roomCode === 'string'
    && /^[A-HJ-NP-Z2-9]{6}$/.test(value.roomCode)
    && typeof value.sessionToken === 'string'
    && /^[A-Za-z0-9_-]{40,128}$/.test(value.sessionToken)
    && typeof value.isHost === 'boolean'
    && (value.team === 0 || value.team === 1)
    && Number.isInteger(value.seed)
    && value.seed! >= 0
    && value.seed! <= 0xffffffff;
}

function validRoomSnapshot(message: RoomSnapshotMessage): boolean {
  return message.protocolVersion === PROTOCOL_VERSION
    && /^[A-HJ-NP-Z2-9]{6}$/.test(message.roomCode)
    && (message.team === 0 || message.team === 1)
    && Number.isInteger(message.seed)
    && message.seed >= 0
    && message.seed <= 0xffffffff
    && Number.isInteger(message.connectedPlayers)
    && message.connectedPlayers >= 1
    && message.connectedPlayers <= 2;
}

function validServerAction(message: Extract<WireMessage, { type: 'action' }>): boolean {
  return typeof message.requestId === 'string'
    && Number.isSafeInteger(message.serverSequence)
    && message.serverSequence > 0
    && message.action !== null
    && typeof message.action === 'object'
    && typeof message.action.type === 'string';
}

function parseWireMessage(data: unknown): WireMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as Partial<WireMessage>;
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    if (value.type === 'room_snapshot' || value.type === 'action' || value.type === 'action_ack'
        || value.type === 'room_closed' || value.type === 'error') return value as WireMessage;
  } catch {
    // A malformed server frame is ignored; the socket remains available for a
    // subsequent valid authoritative snapshot.
  }
  return null;
}

function makeId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += alphabet[randomUint32() % alphabet.length];
  return result;
}

function randomUint32(): number {
  const data = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(data)[0];
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
