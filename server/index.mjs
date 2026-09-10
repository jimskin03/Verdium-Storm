import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

export const PROTOCOL_VERSION = 1;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 64;
const MAX_HTTP_BODY_BYTES = 4 * 1024;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const WORLD_LIMIT = 512;
const MAX_REFS = 512;
const MAX_RALLIES = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const BUILDABLE_IDS = new Set([
  'rifleman', 'rocketeer', 'engineer', 'sniper', 'flamer',
  'scout', 'apc', 'mlrs', 'tank', 'mammoth', 'artillery', 'aa', 'harvester',
  'hq', 'power', 'refinery', 'barracks', 'factory',
  'pillbox', 'turret', 'sam', 'laser', 'repair', 'radar', 'lab',
]);
const scrypt = promisify(scryptCallback);
const DUMMY_SALT = randomBytes(16);

export function createVerdiumServer(options = {}) {
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const port = Number(options.port ?? process.env.PORT ?? 8787);
  const allowedOrigins = new Set(options.allowedOrigins ?? parseAllowedOrigins(process.env.ALLOWED_ORIGINS));
  const roomTtlMs = options.roomTtlMs ?? numberFromEnv('ROOM_TTL_MS', 2 * 60 * 60 * 1000);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? numberFromEnv('HEARTBEAT_INTERVAL_MS', 30_000);
  const authTimeoutMs = options.authTimeoutMs ?? 10_000;
  const maxHttpAttemptsPerMinute = options.maxHttpAttemptsPerMinute ?? 30;
  const sessionReservationMs = options.sessionReservationMs ?? numberFromEnv('SESSION_RESERVATION_MS', 30_000);
  const maxRooms = options.maxRooms ?? numberFromEnv('MAX_ROOMS', 100);
  const maxSockets = options.maxSockets ?? numberFromEnv('MAX_SOCKETS', maxRooms * 2 + 16);
  const maxConcurrentPasswordOps = options.maxConcurrentPasswordOps ?? numberFromEnv('MAX_CONCURRENT_PASSWORD_OPS', 4);
  const rooms = new Map();
  const httpAttempts = new Map();
  const socketState = new Map();
  let activePasswordOps = 0;
  let shuttingDown = false;

  const runPasswordOperation = async (operation) => {
    if (activePasswordOps >= maxConcurrentPasswordOps) {
      const error = new Error('Password service is busy');
      error.code = 'SERVER_BUSY';
      throw error;
    }
    activePasswordOps++;
    try {
      return await operation();
    } finally {
      activePasswordOps--;
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(response, 200, { status: 'ok', protocolVersion: PROTOCOL_VERSION });
      }

      if (!url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'NOT_FOUND' });
      const origin = request.headers.origin;
      if (!isOriginAllowed(origin, allowedOrigins)) return sendJson(response, 403, { error: 'ORIGIN_REJECTED' });
      setCorsHeaders(response, origin);
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        return response.end();
      }
      if (!consumeHttpAttempt(request.socket.remoteAddress ?? 'unknown', httpAttempts, maxHttpAttemptsPerMinute)) {
        return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many room requests. Try again shortly.' });
      }

      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJson(request);
        if (!validPassword(body.password)) {
          return sendJson(response, 400, {
            error: 'PASSWORD_INVALID',
            message: `Use a room password between ${MIN_PASSWORD_BYTES} and ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
          });
        }
        pruneExpiredReservations(rooms);
        if (rooms.size >= maxRooms) {
          return sendJson(response, 503, { error: 'SERVER_CAPACITY', message: 'The multiplayer server is at capacity. Try again shortly.' });
        }
        const code = createUniqueRoomCode(rooms);
        const passwordRecord = await runPasswordOperation(() => hashPassword(body.password));
        const hostSession = createSession('host', sessionReservationMs);
        const room = {
          code,
          seed: randomInt(0, 0x1_0000_0000),
          state: 'waiting',
          createdAt: Date.now(),
          lastActivity: Date.now(),
          nextSequence: 1,
          passwordRecord,
          destroying: false,
          players: {
            host: hostSession.player,
            guest: null,
          },
          spectators: new Map(),
        };
        rooms.set(code, room);
        return sendJson(response, 201, sessionResponse(room, 'host', hostSession.token));
      }

      const joinMatch = /^\/api\/rooms\/([A-Z0-9]{6})\/join$/.exec(url.pathname);
      if (request.method === 'POST' && joinMatch) {
        const body = await readJson(request);
        pruneExpiredReservations(rooms);
        const room = rooms.get(joinMatch[1]);
        const password = typeof body.password === 'string' ? body.password : '';
        const passwordMatches = await runPasswordOperation(() => room
          ? verifyPassword(password, room.passwordRecord)
          : consumeDummyPasswordCheck(password));
        if (!room || room.players.guest || room.state !== 'waiting' || !passwordMatches) {
          return roomUnavailable(response);
        }
        const guestSession = createSession('guest', sessionReservationMs);
        room.players.guest = guestSession.player;
        room.lastActivity = Date.now();
        return sendJson(response, 200, sessionResponse(room, 'guest', guestSession.token));
      }

      const spectateMatch = /^\/api\/rooms\/([A-Z0-9]{6})\/spectate$/.exec(url.pathname);
      if (request.method === 'POST' && spectateMatch) {
        const body = await readJson(request);
        pruneExpiredReservations(rooms);
        const room = rooms.get(spectateMatch[1]);
        const password = typeof body.password === 'string' ? body.password : '';
        const passwordMatches = await runPasswordOperation(() => room
          ? verifyPassword(password, room.passwordRecord)
          : consumeDummyPasswordCheck(password));
        if (!room || room.destroying || !passwordMatches) {
          return roomUnavailable(response);
        }
        const spectatorSession = createSession('spectator', sessionReservationMs);
        room.spectators.set(spectatorSession.token, spectatorSession.player);
        room.lastActivity = Date.now();
        return sendJson(response, 200, sessionResponse(room, 'spectator', spectatorSession.token));
      }

      return sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        return sendJson(response, 413, { error: 'PAYLOAD_TOO_LARGE' });
      }
      if (error?.code === 'SERVER_BUSY') {
        return sendJson(response, 503, { error: 'SERVER_BUSY', message: 'The multiplayer server is busy. Try again shortly.' });
      }
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'INVALID_JSON' });
      console.error('Verdium room request failed:', safeErrorMessage(error));
      return sendJson(response, 500, { error: 'INTERNAL_ERROR' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (!isOriginAllowed(request.headers.origin, allowedOrigins)) return rejectUpgrade(socket, 403, 'Forbidden');
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket) => {
    if (wss.clients.size > maxSockets) return closeSocket(socket, 1013, 'Server capacity reached');
    const state = {
      room: null,
      role: null,
      alive: true,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
      authTimer: null,
    };
    socketState.set(socket, state);
    state.authTimer = setTimeout(() => closeSocket(socket, 4003, 'Authentication timeout'), authTimeoutMs);
    state.authTimer.unref?.();

    socket.on('pong', () => { state.alive = true; });
    socket.on('error', () => {});
    socket.on('message', async (raw, isBinary) => {
      try {
        if (isBinary) return closeSocket(socket, 1003, 'Binary frames are not supported');
        if (!consumeSocketMessage(state)) return closeSocket(socket, 4008, 'Rate limit exceeded');
        const message = JSON.parse(raw.toString());
        if (!state.room) return authenticateSocket(socket, state, message, rooms);
        handleAuthenticatedMessage(socket, state, message, rooms);
      } catch (error) {
        if (error instanceof SyntaxError) {
          safeSend(socket, { type: 'error', code: 'INVALID_JSON', message: 'Message must be valid JSON.' });
        } else {
          safeSend(socket, { type: 'error', code: 'MESSAGE_REJECTED', message: 'Message could not be processed.' });
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(state.authTimer);
      socketState.delete(socket);
      if (shuttingDown || !state.room) return;
      if (state.role === 'spectator') {
        if (state.token && state.room.spectators) state.room.spectators.delete(state.token);
        return;
      }
      destroyRoom(state.room, rooms, socket, 'PEER_DISCONNECTED');
    });
  });

  const maintenanceInterval = setInterval(() => {
    const now = Date.now();
    pruneExpiredReservations(rooms, now);
    for (const room of rooms.values()) {
      if (now - room.lastActivity > roomTtlMs) destroyRoom(room, rooms, null, 'ROOM_EXPIRED');
    }
    for (const [ip, attempt] of httpAttempts) {
      if (attempt.resetAt <= now) httpAttempts.delete(ip);
    }
  }, Math.min(roomTtlMs, sessionReservationMs, 60_000));
  maintenanceInterval.unref?.();

  const heartbeatInterval = heartbeatIntervalMs > 0
    ? setInterval(() => {
      for (const socket of wss.clients) {
        const state = socketState.get(socket);
        if (!state) continue;
        if (!state.alive) {
          socket.terminate();
          continue;
        }
        state.alive = false;
        socket.ping();
      }
    }, heartbeatIntervalMs)
    : null;
  heartbeatInterval?.unref?.();

  return {
    async listen() {
      if (server.listening) return;
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
    },
    address() {
      return server.address();
    },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(maintenanceInterval);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      for (const socket of wss.clients) socket.terminate();
      rooms.clear();
      await new Promise((resolveClose) => wss.close(() => resolveClose()));
      if (server.listening) await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function authenticateSocket(socket, state, message, rooms) {
  if (!isExactObject(message, ['type', 'protocolVersion', 'roomCode', 'sessionToken'])
      || message.type !== 'authenticate'
      || message.protocolVersion !== PROTOCOL_VERSION
      || !/^[A-HJ-NP-Z2-9]{6}$/.test(message.roomCode)
      || !SESSION_TOKEN_PATTERN.test(message.sessionToken)) {
    return closeSocket(socket, 4003, 'Authentication failed');
  }
  pruneExpiredReservations(rooms);
  const room = rooms.get(message.roomCode);
  if (!room || room.destroying) return closeSocket(socket, 4003, 'Authentication failed');
  const tokenHash = hashToken(message.sessionToken);
  const role = findRole(room, tokenHash, message.sessionToken);
  if (!role) return closeSocket(socket, 4003, 'Authentication failed');
  const player = role === 'spectator' ? room.spectators.get(message.sessionToken) : room.players[role];
  if (!player) return closeSocket(socket, 4003, 'Authentication failed');
  if (player.socket && player.socket.readyState === WebSocket.OPEN) {
    return closeSocket(socket, 4003, 'Session already connected');
  }

  clearTimeout(state.authTimer);
  state.authTimer = null;
  state.room = room;
  state.role = role;
  state.token = message.sessionToken;
  player.socket = socket;
  player.reservedUntil = null;
  room.lastActivity = Date.now();
  if (room.state !== 'launched') {
    room.state = room.players.host.socket?.readyState === WebSocket.OPEN
      && room.players.guest?.socket?.readyState === WebSocket.OPEN
      ? 'ready'
      : 'waiting';
  }
  broadcastSnapshots(room);
}

function handleAuthenticatedMessage(socket, state, message, rooms) {
  const room = state.room;
  room.lastActivity = Date.now();

  if (message?.type === 'leave' && isExactObject(message, ['type'])) {
    return closeSocket(socket, 1000, state.role === 'spectator' ? 'Spectator left' : 'Commander left');
  }

  if (state.role === 'spectator') {
    return sendError(socket, 'SPECTATOR_READ_ONLY', 'Spectators cannot deploy or issue commands.');
  }

  const player = room.players[state.role];

  if (message?.type === 'launch') {
    if (!isExactObject(message, ['type', 'requestId']) || !validRequestId(message.requestId)) {
      return sendError(socket, 'MESSAGE_INVALID', 'Launch request is invalid.');
    }
    if (state.role !== 'host') return sendError(socket, 'HOST_ONLY', 'Only Commander 1 can deploy the match.');
    if (room.state !== 'ready') return sendError(socket, 'ROOM_NOT_READY', 'Both commanders must be connected before deployment.');
    room.state = 'launched';
    broadcastSnapshots(room);
    return;
  }

  if (message?.type === 'action') {
    if (room.state !== 'launched') return sendError(socket, 'MATCH_NOT_LAUNCHED', 'Deploy the match before issuing commands.');
    if (!isExactObject(message, ['type', 'requestId', 'clientSequence', 'action'])
        || !validRequestId(message.requestId)
        || !Number.isSafeInteger(message.clientSequence)
        || message.clientSequence < 1) {
      return sendError(socket, 'ACTION_INVALID', 'Command payload is invalid.');
    }
    const previousSequence = player.requests.get(message.requestId);
    if (previousSequence !== undefined) {
      if (previousSequence === 0) return sendError(socket, 'ACTION_INVALID', 'Command payload is invalid.');
      return safeSend(socket, {
        type: 'action_ack',
        requestId: message.requestId,
        serverSequence: previousSequence,
        duplicate: true,
      });
    }
    if (message.clientSequence !== player.nextClientSequence) {
      return sendError(socket, 'SEQUENCE_INVALID', `Expected client sequence ${player.nextClientSequence}.`);
    }
    if (!validateAction(message.action)) {
      player.nextClientSequence++;
      player.requests.set(message.requestId, 0);
      trimRequestHistory(player.requests);
      return sendError(socket, 'ACTION_INVALID', 'Command payload is invalid.');
    }
    const peerRole = state.role === 'host' ? 'guest' : 'host';
    const peer = room.players[peerRole];
    if (!peer?.socket || peer.socket.readyState !== WebSocket.OPEN) {
      return destroyRoom(room, rooms, socket, 'PEER_DISCONNECTED');
    }
    const serverSequence = room.nextSequence++;
    player.nextClientSequence++;
    player.requests.set(message.requestId, serverSequence);
    trimRequestHistory(player.requests);
    const team = state.role === 'host' ? 0 : 1;
    const relayed = {
      type: 'action',
      requestId: message.requestId,
      serverSequence,
      action: message.action,
    };
    if (!safeSend(peer.socket, relayed)) {
      return destroyRoom(room, rooms, socket, 'PEER_DISCONNECTED');
    }
    if (room.spectators) {
      const spectatorRelay = {
        type: 'action',
        requestId: message.requestId,
        serverSequence,
        team,
        action: message.action,
      };
      for (const spec of room.spectators.values()) {
        if (spec?.socket && spec.socket.readyState === WebSocket.OPEN) {
          safeSend(spec.socket, spectatorRelay);
        }
      }
    }
    safeSend(socket, {
      type: 'action_ack',
      requestId: message.requestId,
      serverSequence,
      duplicate: false,
    });
    return;
  }

  sendError(socket, 'MESSAGE_UNKNOWN', 'Unknown message type.');
}

function validateAction(action) {
  if (!isPlainObject(action) || typeof action.type !== 'string') return false;
  if (action.type === 'queue-build' || action.type === 'cancel-build') {
    return isExactObject(action, ['type', 'id']) && BUILDABLE_IDS.has(action.id);
  }
  if (action.type === 'place-building') {
    return isExactObject(action, ['type', 'x', 'z']) && validCoordinate(action.x) && validCoordinate(action.z);
  }
  if (action.type === 'stance') {
    return isExactObject(action, ['type', 'refs', 'stance'])
      && validRefs(action.refs)
      && Number.isInteger(action.stance)
      && action.stance >= 0
      && action.stance <= 2;
  }
  if (action.type === 'stop') {
    return isExactObject(action, ['type', 'refs']) && validRefs(action.refs);
  }
  if (action.type === 'orders') {
    if (!isExactObject(action, ['type', 'orders', 'rally'])
        || !Array.isArray(action.orders)
        || action.orders.length > MAX_REFS
        || !Array.isArray(action.rally)
        || action.rally.length > MAX_RALLIES) return false;
    return action.orders.every((order) => isExactObject(order, ['ref', 'order', 'x', 'z', 'target', 'queued'])
        && validRef(order.ref)
        && Number.isInteger(order.order)
        && order.order >= 0
        && order.order <= 7
        && validCoordinate(order.x)
        && validCoordinate(order.z)
        && validTargetRef(order.target)
        && typeof order.queued === 'boolean')
      && action.rally.every((rally) => isExactObject(rally, ['ref', 'x', 'z'])
        && validRef(rally.ref)
        && validCoordinate(rally.x)
        && validCoordinate(rally.z));
  }
  return false;
}

function createSession(role, reservationMs) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    player: {
      role,
      tokenHash: hashToken(token),
      socket: null,
      reservedUntil: Date.now() + reservationMs,
      nextClientSequence: 1,
      requests: new Map(),
    },
  };
}

function sessionResponse(room, role, token) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    roomCode: room.code,
    sessionToken: token,
    isHost: role === 'host',
    isSpectator: role === 'spectator',
    team: role === 'host' ? 0 : role === 'guest' ? 1 : 2,
    seed: room.seed,
    state: room.state,
  };
}

function broadcastSnapshots(room) {
  for (const role of ['host', 'guest']) {
    const player = room.players[role];
    if (!player?.socket || player.socket.readyState !== WebSocket.OPEN) continue;
    safeSend(player.socket, snapshotFor(room, role));
  }
  if (room.spectators) {
    for (const spec of room.spectators.values()) {
      if (!spec?.socket || spec.socket.readyState !== WebSocket.OPEN) continue;
      safeSend(spec.socket, snapshotFor(room, 'spectator'));
    }
  }
}

function snapshotFor(room, role) {
  return {
    type: 'room_snapshot',
    protocolVersion: PROTOCOL_VERSION,
    roomCode: room.code,
    state: room.state,
    isHost: role === 'host',
    isSpectator: role === 'spectator',
    team: role === 'host' ? 0 : role === 'guest' ? 1 : 2,
    seed: room.seed,
    connectedPlayers: Number(room.players.host.socket?.readyState === WebSocket.OPEN)
      + Number(room.players.guest?.socket?.readyState === WebSocket.OPEN),
  };
}

function destroyRoom(room, rooms, sourceSocket, code) {
  if (!room || room.destroying) return;
  room.destroying = true;
  rooms.delete(room.code);
  const message = code === 'ROOM_EXPIRED'
    ? { type: 'room_closed', code, message: 'The inactive room expired. Create a new room to continue.' }
    : { type: 'room_closed', code, message: 'The other commander disconnected. Create a new room to continue.' };
  for (const role of ['host', 'guest']) {
    const player = room.players[role];
    const socket = player?.socket;
    player && (player.socket = null);
    if (!socket || socket.readyState !== WebSocket.OPEN) continue;
    safeSend(socket, message);
    setTimeout(() => closeSocket(socket, 4001, message.message), 20).unref?.();
  }
  if (room.spectators) {
    for (const spec of room.spectators.values()) {
      const socket = spec?.socket;
      spec.socket = null;
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      safeSend(socket, message);
      setTimeout(() => closeSocket(socket, 4001, message.message), 20).unref?.();
    }
    room.spectators.clear();
  }
}

function pruneExpiredReservations(rooms, now = Date.now()) {
  for (const room of rooms.values()) {
    const host = room.players.host;
    if (!host.socket && host.reservedUntil !== null && host.reservedUntil <= now) {
      destroyRoom(room, rooms, null, 'ROOM_EXPIRED');
      continue;
    }
    const guest = room.players.guest;
    if (guest && !guest.socket && guest.reservedUntil !== null && guest.reservedUntil <= now) {
      room.players.guest = null;
      room.lastActivity = now;
    }
    if (room.spectators) {
      for (const [token, spec] of room.spectators.entries()) {
        if (!spec.socket && spec.reservedUntil !== null && spec.reservedUntil <= now) {
          room.spectators.delete(token);
        }
      }
    }
  }
}

function createUniqueRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let index = 0; index < ROOM_CODE_LENGTH; index++) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate a unique room code');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const verifier = await derivePassword(password, salt);
  return { salt, verifier };
}

async function verifyPassword(password, record) {
  if (!validPassword(password)) {
    await consumeDummyPasswordCheck(password);
    return false;
  }
  const candidate = await derivePassword(password, record.salt);
  return timingSafeEqual(candidate, record.verifier);
}

async function consumeDummyPasswordCheck(password) {
  await derivePassword(typeof password === 'string' ? password : '', DUMMY_SALT);
  return false;
}

function derivePassword(password, salt) {
  return scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function validPassword(password) {
  if (typeof password !== 'string') return false;
  const bytes = Buffer.byteLength(password, 'utf8');
  return bytes >= MIN_PASSWORD_BYTES && bytes <= MAX_PASSWORD_BYTES;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

function findRole(room, tokenHash, token) {
  for (const role of ['host', 'guest']) {
    const expected = room.players[role]?.tokenHash;
    if (expected && timingSafeEqual(tokenHash, expected)) return role;
  }
  if (room.spectators && token && room.spectators.has(token)) {
    return 'spectator';
  }
  return null;
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_HTTP_BODY_BYTES) {
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        rejectBody(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (length > MAX_HTTP_BODY_BYTES) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(isPlainObject(parsed) ? parsed : {});
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on('error', rejectBody);
  });
}

function safeSend(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function sendError(socket, code, message) {
  safeSend(socket, { type: 'error', code, message });
}

function closeSocket(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, reason);
}

function sendJson(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(json);
}

function roomUnavailable(response) {
  return sendJson(response, 403, {
    error: 'ROOM_UNAVAILABLE',
    message: 'Room unavailable or password incorrect.',
  });
}

function setCorsHeaders(response, origin) {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-max-age', '600');
}

function rejectUpgrade(socket, status, label) {
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== 'string') return false;
  if (allowedOrigins.has(origin)) return true;
  // Vercel creates a different HTTPS hostname for preview deployments. Keep
  // those previews usable without opening the room service to arbitrary
  // vercel.app projects or insecure origins.
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app')) return false;
    const host = url.hostname.slice(0, -'.vercel.app'.length);
    return host === 'verdiumstorm'
      || host.startsWith('verdiumstorm-')
      || host === 'verdium-storm'
      || host.startsWith('verdium-storm-');
  } catch {
    return false;
  }
}

function parseAllowedOrigins(value) {
  const origins = (value ?? 'http://localhost:5173,http://127.0.0.1:5173,https://verdiumstorm.cryptgregresearch.org,https://verdiumstorm.vercel.app')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins;
}

function consumeHttpAttempt(ip, attempts, limit) {
  const now = Date.now();
  let attempt = attempts.get(ip);
  if (!attempt || attempt.resetAt <= now) {
    attempt = { count: 0, resetAt: now + 60_000 };
    attempts.set(ip, attempt);
  }
  attempt.count++;
  return attempt.count <= limit;
}

function consumeSocketMessage(state) {
  const now = Date.now();
  if (now - state.windowStartedAt >= 1_000) {
    state.windowStartedAt = now;
    state.messagesInWindow = 0;
  }
  state.messagesInWindow++;
  return state.messagesInWindow <= 120;
}

function trimRequestHistory(requests) {
  while (requests.size > 256) requests.delete(requests.keys().next().value);
}

function validCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -WORLD_LIMIT && value <= WORLD_LIMIT;
}

function validRef(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validTargetRef(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
}

function validRefs(refs) {
  return Array.isArray(refs) && refs.length <= MAX_REFS && refs.every(validRef);
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isExactObject(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown error';
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const app = createVerdiumServer();
  await app.listen();
  const address = app.address();
  const printable = typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address);
  console.log(`Verdium Storm multiplayer server listening on ${printable}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
