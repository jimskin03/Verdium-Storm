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

type WireMessage = {
  kind: 'join-request' | 'join-accepted' | 'join-rejected' | 'match-start' | 'action' | 'leave';
  from: string;
  to?: string;
  passwordHash?: string;
  seed?: number;
  action?: MultiplayerAction;
};

const CHANNEL_PREFIX = 'verdium-storm-room:';

/**
 * A compact two-commanders lobby for the static build. BroadcastChannel keeps
 * the feature dependency-free: open the same deployment in a second browser
 * tab/window, then share the room code and password. A relay can replace this
 * transport later without changing the menu or match command contract.
 */
export class MultiplayerLobby {
  private channel: BroadcastChannel | null = null;
  private readonly clientId = makeId(12);
  private passwordHash = '';
  private peerId = '';
  private launchHandlers: Array<() => void> = [];
  private actionHandlers: Array<(action: MultiplayerAction) => void> = [];
  private stateHandlers: Array<(snapshot: LobbySnapshot) => void> = [];

  private _state: LobbyState = 'idle';
  private _roomCode = '';
  private _isHost = false;
  private _team: Team = 0;
  private _seed = 0;
  private _message = 'Create a room or join an existing two-player room.';

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
      this.setState('error', 'Use a room password with at least 4 characters.');
      return false;
    }
    this.closeChannel();
    this._roomCode = makeRoomCode();
    this._isHost = true;
    this._team = 0;
    this._seed = randomUint32();
    this.passwordHash = await digest(password);
    if (!this.openChannel()) return false;
    this.setState('waiting', `Room ${this._roomCode} is secure. Waiting for Commander 2.`);
    return true;
  }

  async join(roomCode: string, password: string): Promise<boolean> {
    const normalizedRoom = roomCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalizedRoom)) {
      this.setState('error', 'Enter the six-character room code from the host.');
      return false;
    }
    if (!validPassword(password)) {
      this.setState('error', 'Enter the room password (at least 4 characters).');
      return false;
    }
    this.closeChannel();
    this._roomCode = normalizedRoom;
    this._isHost = false;
    this._team = 1;
    this.passwordHash = await digest(password);
    if (!this.openChannel()) return false;
    this.send({ kind: 'join-request', passwordHash: this.passwordHash });
    this.setState('joining', `Searching for room ${this._roomCode}…`);
    return true;
  }

  /** Only the room creator can launch once both command slots are occupied. */
  launch(): boolean {
    if (!this._isHost || !this.isReady) return false;
    this.send({ kind: 'match-start', seed: this._seed });
    this.launchLocal();
    return true;
  }

  sendAction(action: MultiplayerAction): void {
    if (!this.isLaunched || !this.peerId) return;
    this.send({ kind: 'action', action });
  }

  close(): void {
    if (this.channel && this.peerId) this.send({ kind: 'leave' });
    this.closeChannel();
    this.peerId = '';
    this._roomCode = '';
    this._isHost = false;
    this._team = 0;
    this._seed = 0;
    this.setState('idle', 'Create a room or join an existing two-player room.');
  }

  private openChannel(): boolean {
    if (typeof BroadcastChannel === 'undefined') {
      this.setState('error', 'This browser does not support local multiplayer rooms.');
      return false;
    }
    this.channel = new BroadcastChannel(`${CHANNEL_PREFIX}${this._roomCode}`);
    this.channel.addEventListener('message', this.onMessage);
    return true;
  }

  private closeChannel(): void {
    this.channel?.removeEventListener('message', this.onMessage);
    this.channel?.close();
    this.channel = null;
  }

  private send(message: Omit<WireMessage, 'from'>): void {
    this.channel?.postMessage({ ...message, from: this.clientId } satisfies WireMessage);
  }

  private onMessage = (event: MessageEvent<WireMessage>): void => {
    const message = event.data;
    if (!message || message.from === this.clientId || (message.to && message.to !== this.clientId)) return;

    if (message.kind === 'join-request' && this._isHost) {
      if (this.peerId) {
        this.send({ kind: 'join-rejected', to: message.from });
      } else if (message.passwordHash !== this.passwordHash) {
        this.send({ kind: 'join-rejected', to: message.from });
      } else {
        this.peerId = message.from;
        this.send({ kind: 'join-accepted', to: message.from, seed: this._seed });
        this.setState('ready', 'Commander 2 connected. Select DEPLOY when both players are ready.');
      }
      return;
    }

    if (message.kind === 'join-accepted' && !this._isHost && this._state === 'joining' && typeof message.seed === 'number') {
      this.peerId = message.from;
      this._seed = message.seed;
      this.setState('ready', 'Connected as Commander 2. Awaiting host deployment order.');
      return;
    }

    if (message.kind === 'join-rejected' && !this._isHost && this._state === 'joining') {
      this.setState('error', 'Room unavailable or password incorrect.');
      return;
    }

    if (message.kind === 'match-start' && !this._isHost && this.isReady && typeof message.seed === 'number') {
      this._seed = message.seed;
      this.launchLocal();
      return;
    }

    if (message.kind === 'action' && this.isLaunched && message.action) {
      for (const handler of this.actionHandlers) handler(message.action);
      return;
    }

    if (message.kind === 'leave' && message.from === this.peerId) {
      this.peerId = '';
      this.setState('error', 'The other commander left the room. Return to the main menu to create a new room.');
    }
  };

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
  return password.trim().length >= 4;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // A compatibility fallback only; passwords are never persisted or displayed.
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16);
}

function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[randomUint32() % alphabet.length];
  return code;
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
