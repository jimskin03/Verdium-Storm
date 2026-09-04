import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { MultiplayerLobby, type MultiplayerAction } from '../src/game/Multiplayer';
import { createVerdiumServer } from '../server/index.mjs';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'storm-passphrase';
let app: ReturnType<typeof createVerdiumServer>;
let baseUrl = '';
let networkRequests = 0;
const lobbies: MultiplayerLobby[] = [];

beforeEach(async () => {
  networkRequests = 0;
  app = createVerdiumServer({
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [ORIGIN],
    heartbeatIntervalMs: 0,
    roomTtlMs: 60_000,
  });
  await app.listen();
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const lobby of lobbies) lobby.close();
  lobbies.length = 0;
  await app.close();
});

function makeLobby(serverUrl = baseUrl): MultiplayerLobby {
  const lobby = new MultiplayerLobby({
    serverUrl,
    fetch: async (input, init) => {
      networkRequests++;
      const headers = new Headers(init?.headers);
      headers.set('origin', ORIGIN);
      return fetch(input, { ...init, headers });
    },
    webSocket: (url) => new WebSocket(url, { origin: ORIGIN }),
  });
  lobbies.push(lobby);
  return lobby;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for multiplayer state');
}

describe('MultiplayerLobby network transport', () => {
  test('creates and joins a server room, launches both clients, and relays actions', async () => {
    const host = makeLobby();
    const guest = makeLobby();
    const guestLaunches: number[] = [];
    const guestActions: MultiplayerAction[] = [];
    guest.onLaunch(() => guestLaunches.push(1));
    guest.onAction((action) => guestActions.push(action));

    await expect(host.create(PASSWORD)).resolves.toBe(true);
    expect(host.state).toBe('waiting');
    expect(host.isHost).toBe(true);
    expect(host.team).toBe(0);
    expect(host.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    await expect(guest.join(host.roomCode, PASSWORD)).resolves.toBe(true);
    await waitFor(() => host.isReady && guest.isReady);
    expect(guest.team).toBe(1);
    expect(guest.seed).toBe(host.seed);
    expect(networkRequests).toBe(2);

    expect(host.launch()).toBe(true);
    await waitFor(() => host.isLaunched && guest.isLaunched);
    expect(guestLaunches).toHaveLength(1);

    const action: MultiplayerAction = { type: 'queue-build', id: 'rifleman' };
    host.sendAction(action);
    await waitFor(() => guestActions.length === 1);
    expect(guestActions).toEqual([action]);
  });

  test('reports network configuration and authentication failures without retaining a local room', async () => {
    const unconfigured = makeLobby('');
    await expect(unconfigured.create(PASSWORD)).resolves.toBe(false);
    expect(unconfigured.state).toBe('error');
    expect(unconfigured.roomCode).toBe('');
    expect(unconfigured.snapshot().message).toContain('not configured');

    const host = makeLobby();
    const guest = makeLobby();
    await expect(host.create(PASSWORD)).resolves.toBe(true);
    await expect(guest.join(host.roomCode, 'incorrect-passphrase')).resolves.toBe(false);
    expect(guest.state).toBe('error');
    expect(guest.snapshot().message).toBe('Room unavailable or password incorrect.');
  });

  test('rejects insecure or credential-bearing remote server URLs before sending a password', async () => {
    const before = networkRequests;
    const insecure = makeLobby('http://multiplayer.example.invalid');
    await expect(insecure.create(PASSWORD)).resolves.toBe(false);
    expect(insecure.snapshot().message).toContain('not configured');

    const credentialed = makeLobby('https://user:secret@multiplayer.example.invalid');
    await expect(credentialed.create(PASSWORD)).resolves.toBe(false);
    expect(credentialed.snapshot().message).toContain('not configured');
    expect(networkRequests).toBe(before);
  });

  test('ignores a room response that arrives after the lobby was closed', async () => {
    let resolveRequest!: (response: Response) => void;
    let socketCreations = 0;
    const lobby = new MultiplayerLobby({
      serverUrl: baseUrl,
      fetch: () => new Promise<Response>((resolve) => { resolveRequest = resolve; }),
      webSocket: () => {
        socketCreations++;
        throw new Error('A stale response must not create a socket');
      },
    });
    lobbies.push(lobby);

    const creating = lobby.create(PASSWORD);
    await Promise.resolve();
    lobby.close();
    resolveRequest(new Response(JSON.stringify({
      protocolVersion: 1,
      roomCode: 'ABC234',
      sessionToken: 'a'.repeat(43),
      isHost: true,
      team: 0,
      seed: 42,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    await expect(creating).resolves.toBe(false);
    expect(lobby.state).toBe('idle');
    expect(lobby.roomCode).toBe('');
    expect(socketCreations).toBe(0);
  });

  test('settles create() if the lobby is closed during the WebSocket handshake', async () => {
    class PendingSocket {
      readyState = 0;
      private readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();
      send(): void {}
      close(): void {
        this.readyState = 3;
        for (const listener of this.listeners.get('close') ?? []) listener(new Event('close'));
      }
      addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event | MessageEvent) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
    }

    let socket: PendingSocket | null = null;
    const lobby = new MultiplayerLobby({
      serverUrl: baseUrl,
      fetch: async () => new Response(JSON.stringify({
        protocolVersion: 1,
        roomCode: 'ABC234',
        sessionToken: 'a'.repeat(43),
        isHost: true,
        team: 0,
        seed: 42,
      }), { status: 201, headers: { 'content-type': 'application/json' } }),
      webSocket: () => {
        socket = new PendingSocket();
        return socket;
      },
    });
    lobbies.push(lobby);

    const creating = lobby.create(PASSWORD);
    await waitFor(() => socket !== null);
    lobby.close();
    await expect(creating).resolves.toBe(false);
    expect(lobby.state).toBe('idle');
    expect(lobby.roomCode).toBe('');
  });
});
