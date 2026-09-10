import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createVerdiumServer } from './index.mjs';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'storm-passphrase';
let app;
let baseUrl;
const sockets = new Set();

beforeEach(async () => {
  app = createVerdiumServer({
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [ORIGIN],
    heartbeatIntervalMs: 0,
    roomTtlMs: 60_000,
  });
  await app.listen();
  const address = app.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await app.close();
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  return { response, body };
}

async function createRoom(password = PASSWORD) {
  const { response, body } = await request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 201);
  return body;
}

function nextMessage(socket, predicate = () => true, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before expected message'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

async function connect(session, origin = ORIGIN) {
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`, { origin });
  sockets.add(socket);
  await once(socket, 'open');
  const snapshotPromise = nextMessage(socket, (message) => message.type === 'room_snapshot');
  socket.send(JSON.stringify({
    type: 'authenticate',
    protocolVersion: 1,
    roomCode: session.roomCode,
    sessionToken: session.sessionToken,
  }));
  const snapshot = await snapshotPromise;
  return { socket, snapshot };
}

async function launchRoom(hostSocket, guestSocket) {
  const hostLaunch = nextMessage(hostSocket, (message) => message.type === 'room_snapshot' && message.state === 'launched');
  const guestLaunch = nextMessage(guestSocket, (message) => message.type === 'room_snapshot' && message.state === 'launched');
  hostSocket.send(JSON.stringify({ type: 'launch', requestId: 'launch-1' }));
  await Promise.all([hostLaunch, guestLaunch]);
}

test('health endpoint reports readiness without exposing room details', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', protocolVersion: 1 });
});

test('creates, joins, launches, and relays one validated sequenced action', async () => {
  const hostSession = await createRoom();
  assert.match(hostSession.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(hostSession.team, 0);
  assert.equal(hostSession.isHost, true);
  assert.equal(typeof hostSession.seed, 'number');
  assert.match(hostSession.sessionToken, /^[A-Za-z0-9_-]{40,}$/);

  const host = await connect(hostSession);
  assert.equal(host.snapshot.state, 'waiting');
  assert.equal(host.snapshot.connectedPlayers, 1);

  const { response, body: guestSession } = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  assert.equal(guestSession.team, 1);
  assert.equal(guestSession.seed, hostSession.seed);

  const hostReady = nextMessage(host.socket, (message) => message.type === 'room_snapshot' && message.state === 'ready');
  const guest = await connect(guestSession);
  assert.equal(guest.snapshot.state, 'ready');
  assert.equal(guest.snapshot.connectedPlayers, 2);
  assert.equal((await hostReady).connectedPlayers, 2);

  const guestDenied = nextMessage(guest.socket, (message) => message.type === 'error');
  guest.socket.send(JSON.stringify({ type: 'launch', requestId: 'guest-launch' }));
  assert.equal((await guestDenied).code, 'HOST_ONLY');

  await launchRoom(host.socket, guest.socket);

  const action = { type: 'orders', orders: [{ ref: 65537, order: 1, x: 12, z: -8, target: 0, queued: false }], rally: [] };
  const ackPromise = nextMessage(host.socket, (message) => message.type === 'action_ack');
  const relayPromise = nextMessage(guest.socket, (message) => message.type === 'action');
  host.socket.send(JSON.stringify({ type: 'action', requestId: 'action-1', clientSequence: 1, action }));
  const [ack, relay] = await Promise.all([ackPromise, relayPromise]);
  assert.deepEqual(ack, { type: 'action_ack', requestId: 'action-1', serverSequence: 1, duplicate: false });
  assert.deepEqual(relay, { type: 'action', requestId: 'action-1', serverSequence: 1, action });

  const duplicateAck = nextMessage(host.socket, (message) => message.type === 'action_ack' && message.requestId === 'action-1');
  host.socket.send(JSON.stringify({ type: 'action', requestId: 'action-1', clientSequence: 1, action }));
  assert.equal((await duplicateAck).duplicate, true);
});

test('rejects weak or incorrect passwords, full rooms, malformed actions, and bad origins', async () => {
  const weak = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ password: 'short' }) });
  assert.equal(weak.response.status, 400);
  assert.equal(weak.body.error, 'PASSWORD_INVALID');

  const hostSession = await createRoom();
  const wrong = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(wrong.response.status, 403);
  assert.deepEqual(wrong.body, { error: 'ROOM_UNAVAILABLE', message: 'Room unavailable or password incorrect.' });

  const guest = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(guest.response.status, 200);
  const full = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(full.response.status, 403);
  assert.deepEqual(full.body, wrong.body);

  const host = await connect(hostSession);
  const hostReady = nextMessage(host.socket, (message) => message.type === 'room_snapshot' && message.state === 'ready');
  const joined = await connect(guest.body);
  await hostReady;
  await launchRoom(host.socket, joined.socket);

  const malformed = nextMessage(host.socket, (message) => message.type === 'error');
  host.socket.send(JSON.stringify({
    type: 'action', requestId: 'bad-action', clientSequence: 1,
    action: { type: 'place-building', x: 9_999, z: 0 },
  }));
  assert.equal((await malformed).code, 'ACTION_INVALID');

  const recoveredRelay = nextMessage(joined.socket, (message) => message.type === 'action');
  host.socket.send(JSON.stringify({
    type: 'action', requestId: 'recovered-action', clientSequence: 2,
    action: { type: 'queue-build', id: 'rifleman' },
  }));
  assert.equal((await recoveredRelay).action.id, 'rifleman');

  const rejected = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`, { origin: 'https://attacker.invalid' });
  rejected.on('error', () => {});
  const [, response] = await once(rejected, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.destroy();
});

test('allows this project\'s HTTPS Vercel preview origins but not other Vercel projects', async () => {
  const preview = createVerdiumServer({
    host: '127.0.0.1', port: 0, allowedOrigins: [], heartbeatIntervalMs: 0, roomTtlMs: 60_000,
  });
  await preview.listen();
  const address = preview.address();
  const url = `http://127.0.0.1:${address.port}/api/rooms`;
  const request = (origin) => fetch(url, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal((await request('https://verdiumstorm-git-main-jimskin03.vercel.app')).status, 201);
  assert.equal((await request('https://other-project.vercel.app')).status, 403);
  await preview.close();
});

test('disconnect destroys the ephemeral room and notifies the remaining commander', async () => {
  const hostSession = await createRoom();
  const host = await connect(hostSession);
  const guestSession = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  const hostReady = nextMessage(host.socket, (message) => message.type === 'room_snapshot' && message.state === 'ready');
  const guest = await connect(guestSession.body);
  await hostReady;

  const closed = nextMessage(host.socket, (message) => message.type === 'room_closed');
  guest.socket.close(1000, 'test disconnect');
  assert.deepEqual(await closed, {
    type: 'room_closed',
    code: 'PEER_DISCONNECTED',
    message: 'The other commander disconnected. Create a new room to continue.',
  });

  const retry = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(retry.response.status, 403);
  assert.equal(retry.body.error, 'ROOM_UNAVAILABLE');
});

test('expires unauthenticated reservations and enforces the room capacity limit', async () => {
  await app.close();
  app = createVerdiumServer({
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [ORIGIN],
    heartbeatIntervalMs: 0,
    roomTtlMs: 60_000,
    sessionReservationMs: 50,
    maxRooms: 1,
  });
  await app.listen();
  const address = app.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  const abandonedHost = await createRoom();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const expiredHost = await request(`/api/rooms/${abandonedHost.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(expiredHost.response.status, 403);

  const activeHostSession = await createRoom();
  const activeHost = await connect(activeHostSession);
  assert.equal(activeHost.snapshot.state, 'waiting');
  const abandonedGuest = await request(`/api/rooms/${activeHostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(abandonedGuest.response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const replacementGuest = await request(`/api/rooms/${activeHostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(replacementGuest.response.status, 200);

  const capacity = await request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(capacity.response.status, 503);
  assert.equal(capacity.body.error, 'SERVER_CAPACITY');
});

test('spectator joins with password, observes launch and actions with team, cannot command, and disconnects safely', async () => {
  const hostSession = await createRoom();
  const guestResponse = await request(`/api/rooms/${hostSession.roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(guestResponse.response.status, 200);

  // Spectator requests session
  const specResponse = await request(`/api/rooms/${hostSession.roomCode}/spectate`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(specResponse.response.status, 200);
  assert.equal(specResponse.body.isSpectator, true);
  assert.equal(specResponse.body.team, 2);

  const host = await connect(hostSession);
  const guest = await connect(guestResponse.body);
  const spec = await connect(specResponse.body);

  assert.equal(spec.snapshot.isSpectator, true);
  assert.equal(spec.snapshot.state, 'ready');

  // Launch match
  await launchRoom(host.socket, guest.socket);

  const specLaunch = await nextMessage(spec.socket, (m) => m.type === 'room_snapshot' && m.state === 'launched');
  assert.equal(specLaunch.state, 'launched');

  // Spectator attempts to issue a command (should be rejected as read-only)
  const specActionErrorPromise = nextMessage(spec.socket, (m) => m.type === 'error');
  spec.socket.send(JSON.stringify({
    type: 'action',
    requestId: 'spec-1',
    clientSequence: 1,
    action: { type: 'stop', refs: [1001] },
  }));
  const specError = await specActionErrorPromise;
  assert.equal(specError.code, 'SPECTATOR_READ_ONLY');

  // Host issues action; peer and spectator receive it
  const action = { type: 'queue-build', id: 'rifleman' };
  const guestActionPromise = nextMessage(guest.socket, (m) => m.type === 'action');
  const specActionPromise = nextMessage(spec.socket, (m) => m.type === 'action');

  host.socket.send(JSON.stringify({
    type: 'action',
    requestId: 'host-action-1',
    clientSequence: 1,
    action,
  }));

  const [guestRelayed, specRelayed] = await Promise.all([guestActionPromise, specActionPromise]);
  assert.equal(guestRelayed.requestId, 'host-action-1');
  assert.equal(specRelayed.requestId, 'host-action-1');
  assert.equal(specRelayed.team, 0); // Attributed to host team
  assert.deepEqual(specRelayed.action, action);

  // Spectator disconnects; room remains active for host and guest
  spec.socket.close();
  await new Promise((r) => setTimeout(r, 50));

  const guestAckPromise = nextMessage(guest.socket, (m) => m.type === 'action_ack');
  const hostActionPromise = nextMessage(host.socket, (m) => m.type === 'action');
  guest.socket.send(JSON.stringify({
    type: 'action',
    requestId: 'guest-action-1',
    clientSequence: 1,
    action: { type: 'stop', refs: [2001] },
  }));
  const [guestAck, hostRelayed] = await Promise.all([guestAckPromise, hostActionPromise]);
  assert.equal(guestAck.requestId, 'guest-action-1');
  assert.equal(hostRelayed.requestId, 'guest-action-1');
});

