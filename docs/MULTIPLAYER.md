# Verdium Storm remote multiplayer

Verdium Storm has its own two-player room service. It does not share code,
rooms, credentials, state, or infrastructure with another game.

## Topology

```text
Commander 1 browser ─┐
                     ├── HTTPS + WSS ── Verdium room server
Commander 2 browser ─┘                      │
                                           └── ephemeral in-memory room
```

The Vite frontend can remain on Vercel. The Node service under `server/` is
suitable for one free Render web service. Run one server instance: room state is
held in process memory and is not coordinated across replicas.

## Local development

```bash
npm install
npm --prefix server install
npm run server
```

In another terminal:

```bash
npm run dev
```

On localhost, the client defaults to `http://localhost:8787`. To use another
server, create an untracked `.env.local` based on `.env.example` and set
`VITE_MULTIPLAYER_SERVER_URL`.

## HTTP room lifecycle

### `POST /api/rooms`

Accepts `{ "password": string }`. The server creates a room and returns an
opaque host session capability, room code, team `0`, and match seed.

### `POST /api/rooms/:roomCode/join`

Accepts `{ "password": string }`. A valid second commander receives a distinct
opaque session capability, team `1`, and the same seed. Missing rooms, full
rooms, and incorrect passwords deliberately return the same generic response.

### `GET /healthz`

Returns service readiness and protocol version without room counts or secrets.

## WebSocket protocol

Clients connect to `/ws` and authenticate in the first message:

```json
{
  "type": "authenticate",
  "protocolVersion": 1,
  "roomCode": "ABC234",
  "sessionToken": "opaque capability"
}
```

The server then sends role-specific `room_snapshot` messages. The host can send
`launch` after two authenticated commanders are connected. Gameplay uses:

```json
{
  "type": "action",
  "requestId": "bounded-random-id",
  "clientSequence": 1,
  "action": { "type": "queue-build", "id": "rifleman" }
}
```

Accepted actions receive an `action_ack` and are delivered once to the other
commander with a monotonic server sequence. Duplicate request IDs are
acknowledged without being applied twice. Every action variant is validated for
shape, enum values, entity-array limits and world-coordinate bounds.

## Security model

- Passwords must be 8–64 UTF-8 bytes and travel only over HTTPS in production.
- The server stores a salted scrypt verifier, never the plaintext password.
- Session capabilities are random, returned only in response bodies, kept in
  memory by the client, and represented by SHA-256 hashes on the server.
- WebSocket upgrades require an exact allowed `Origin`.
- HTTP bodies and WebSocket frames are size-limited.
- Room requests and socket messages are rate-limited.
- Only the authenticated host can launch; teams and seeds are server-owned.
- Binary frames, malformed JSON, unknown messages and unexpected fields are
  rejected.
- Heartbeats remove dead sockets; slow-client backpressure is bounded.
- Logs exclude passwords, capabilities, and gameplay payloads.

Set `ALLOWED_ORIGINS` to exact comma-separated frontend origins. Add explicit
Vercel preview origins only when those previews need multiplayer access; do not
use a wildcard in production.

## MVP behavior and limitations

This release replaces browser-local `BroadcastChannel` rooms with real remote
connectivity for small private matches. It deliberately has these constraints:

- Rooms are ephemeral and disappear when the free service sleeps, restarts, or
  redeploys.
- A disconnect closes the room for both commanders. Reconnect/resume is not yet
  implemented.
- The server validates and sequences command payloads but does not run the RTS
  simulation. Existing clients still apply local commands immediately and
  receive remote commands after network latency.
- There are no state snapshots, deterministic tick scheduling, state hashes,
  anti-cheat authority, accounts, matchmaking, spectators, or match history.
- This is appropriate for cooperative testing and private matches, not ranked or
  adversarial competitive play.

Reliable competitive multiplayer is a separate phase: schedule commands on a
shared simulation tick, add periodic state hashes and resynchronization, then
move authoritative simulation rules server-side where practical.

## Deployment

1. Create the Render service from `render.yaml` and verify `/healthz`.
2. Confirm `ALLOWED_ORIGINS` contains the exact production Vercel origin.
3. Set `VITE_MULTIPLAYER_SERVER_URL` in the Vercel project to the Render HTTPS
   origin (no `/ws` suffix).
4. Redeploy the frontend so Vite embeds the public server origin.
5. Exercise create → join from two independent browser contexts, host launch,
   one action in each direction, and disconnect cleanup.
