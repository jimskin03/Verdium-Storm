# Verdium Storm — Agent-Friendly Game Plan

Status: phase 1 implementation in progress; renderer-independent control plane landed

Target baseline: `origin/main` at `2e3e00a`

Scope: game pacing, observable event logs, a stable command/observation API, and Playwright-driven headless Chromium automation

Implemented in this working tree: `deliberate` local pacing, a bounded public/team event journal, fog-safe observations, a renderer-independent `VS_AGENT` bridge, direct agent room lifecycle controls, and a deterministic Playwright smoke runner. Scheduled multiplayer command ticks and server-authoritative privacy remain the next protocol phase.

## 1. Outcome

Verdium Storm should support humans, scripted bots, and language-model agents through the same game rules and command validation. An agent must be able to:

1. start or join a deterministic match;
2. observe only information its commander is allowed to know;
3. consume new events without repeatedly serialising the whole simulation;
4. submit a typed command and receive a deterministic acknowledgement;
5. wait long enough to reason without the battle running away from it; and
6. complete a match in headless Chromium with a reproducible evidence bundle.

This is an interface and simulation change, not permission for agents to inspect arbitrary runtime objects. Visual automation remains useful, but `window.VS.engine` is not the game-playing API.

## 2. Current baseline

The repository already has most of the hard foundations:

- `Sim` advances at a deterministic 30 Hz fixed step (`SIM_STEP = 1 / 30`) and uses a seeded RNG.
- `window.VS.step(...)` can freeze and advance the game for reproducible visual captures.
- `tools/shoot.mjs`, `tools/probe.mjs`, and `tools/verify.mjs` already launch headless Chromium through Playwright.
- Multiplayer rooms authenticate two session capabilities and validate, sequence, acknowledge, and relay commands.
- The HUD consumes a `GameStateService` instead of importing the simulation directly.

The gaps are equally clear:

- A match opens with two large, fully developed bases, large standing armies, and two forward battle groups already moving into contact.
- Commanders think four times per simulation second and can begin a wave immediately because the seeded army already exceeds the first wave threshold.
- `Engine.timeScale` is local and affects every system. It is not a safe multiplayer pacing control.
- Multiplayer commands are applied immediately on each client rather than at a shared simulation tick.
- The room server has no observation or gameplay-event stream and deliberately omits gameplay payloads from operational logs.
- The browser harness offers camera and rendering controls, but no supported snapshot, event, reset, command, or wait contract for a game-playing agent.
- `window.VS` is currently exposed in ordinary builds, not only when harness mode is requested.

## 3. Design principles

### One simulation, one command path

Mouse input, keyboard input, built-in AI, scripted agents, and remote agents must all produce the same domain commands. No caller may mutate `Sim`, entity stores, build queues, or credits directly.

### Render fast, simulate deliberately

Camera movement, animation, audio, and UI should remain responsive at the display frame rate. A match-owned simulation clock controls only deterministic gameplay ticks. Do not slow the entire `Engine` or depend on wall-clock sleeps.

### Observability is not omniscience

An observation is derived for one authenticated team. Enemy entities are included only when currently visible; remembered contacts are explicitly marked stale and contain only previously observed fields. An agent-facing API must never turn fog of war into accidental full-map telemetry.

### Logs are data products, not console output

Gameplay events use a typed, versioned schema, monotonically increasing cursors, bounded retention, and explicit visibility. Browser console logs remain diagnostic and must not be scraped as the source of truth.

### Determinism before speed

Headless automation advances by simulation ticks and waits on events or conditions. Tests should not rely on `waitForTimeout` except for boot, rendering convergence, or genuine network deadlines.

## 4. Proposed player experience and pacing

Add a match-owned `PacingProfile`. Keep a compatibility profile for visual regression and introduce `deliberate` as the recommended human/agent profile.

```ts
export interface PacingProfile {
  id: 'classic' | 'deliberate';
  simulationRate: number;
  openingPeaceTicks: number;
  commanderThinkTicks: number;
  minimumWaveTicks: number;
  regroupTicks: number;
  startingForce: 'showcase' | 'opening';
}
```

Recommended first tuning pass:

| Control | Current behaviour | `deliberate` proposal |
| --- | --- | --- |
| Simulation rate | 1.0 local game-second per wall second | 0.5, selected in match config |
| Starting bases | Near-complete tech and defences | HQ, one power plant, one refinery, one production building |
| Starting combat force | Large mixed armies | 4 infantry, 1 scout, 1 harvester per team |
| Forward groups | Spawned in contact and ordered to attack | Disabled |
| Opening peace | None | 1800 ticks / 60 simulation seconds |
| Commander think cadence | Every 0.25 simulation seconds | Every 30 ticks / 1 simulation second |
| First offensive | Can begin immediately | Not before 5400 ticks / 180 simulation seconds |
| Regroup window | 22 simulation seconds | 45 simulation seconds |

These values are starting hypotheses, not balance law. Instrument first contact, first unit loss, first expansion, first tech unlock, and match duration. Retune until the median headless agent match has:

- no combat in the first 90 wall-clock seconds;
- a readable expansion decision before the first attack;
- at least 1.5 wall-clock seconds between ordinary decision-relevant event bursts; and
- a 20–35 minute human match at `deliberate` speed.

`classic` preserves current seeds, shot presets, and visual baselines. Visual tools should request `classic` explicitly so pacing work does not invalidate unrelated screenshots.

### Clock ownership

Offline matches may select their profile locally. A multiplayer room stores the profile and includes it in the launch snapshot. Once launched, neither commander can change it.

The server should schedule accepted commands at an `applyTick`, for example the next command window plus a small input delay. Both clients enqueue the command and apply it only when the local simulation reaches that tick. This is the minimum safe foundation for shared pacing; merely setting `Engine.timeScale` in both tabs is not sufficient.

## 5. Command contract

Extract the existing `MultiplayerAction` union into a transport-neutral domain command module. Add an envelope rather than changing every action payload:

```ts
export interface CommandEnvelope {
  protocolVersion: 2;
  requestId: string;
  clientSequence: number;
  issuedAfterTick: number;
  command: GameCommand;
}

export interface CommandAck {
  requestId: string;
  status: 'accepted' | 'rejected' | 'duplicate';
  serverSequence?: number;
  applyTick?: number;
  code?: string;
  message?: string;
}
```

Required behaviour:

- The same validator runs at the browser boundary and server boundary.
- Rejections use stable machine codes as well as short human messages.
- Acknowledgement means scheduled, not necessarily executed.
- Execution produces a separate event referencing `requestId` and `applyTick`.
- Commands are idempotent by `requestId`.
- Queue size, reference count, coordinates, and per-window command rate remain bounded.
- UI commands use the same `CommandGateway` used by agents; local UI optimism is presentation-only.

## 6. Observation contract

Expose a compact serialisable view rather than the raw engine or typed arrays:

```ts
export interface AgentObservation {
  schemaVersion: 1;
  matchId: string;
  team: 0 | 1;
  tick: number;
  pacing: 'classic' | 'deliberate';
  status: 'opening' | 'active' | 'won' | 'lost' | 'draw';
  economy: EconomySnapshot;
  own: ObservedEntity[];
  visibleEnemies: ObservedEntity[];
  rememberedEnemies: RememberedContact[];
  resources: ObservedResourceField[];
  production: ObservedProduction[];
  objectives: ObservedObjective[];
  availableCommands: AvailableCommand[];
  lastEventId: number;
  observationDigest: string;
}
```

Rules:

- Use stable opaque entity IDs. Do not expose entity-store slots, array capacity, scene objects, materials, or references to mutable data.
- Quantise positions and nonessential floating-point values to keep prompts and logs small.
- Include command availability and rejection reasons so an agent does not learn the tech tree by repeated invalid actions.
- `observationDigest` hashes only the team-safe observation. A full canonical simulation digest is available to the harness/evaluator and multiplayer divergence checks, never to an ordinary production agent.
- Snapshot generation is pull-based. Incremental events are push-based.
- Cap collection sizes and sort them deterministically.

## 7. Shared and private real-time logs

Introduce an in-memory `EventJournal` inside each match. Every event has one canonical envelope:

```ts
export interface GameEvent<T = unknown> {
  schemaVersion: 1;
  eventId: number;
  tick: number;
  type: string;
  visibility: 'public' | 'team';
  team?: 0 | 1;
  correlationId?: string;
  payload: T;
}
```

### Public/shared stream

Appropriate public events include:

- match phase and objective changes;
- command scheduled/executed metadata, without hidden target details;
- construction completed when it is publicly revealed by game rules;
- visible combat, destruction, and score changes;
- commander connected, disconnected, or timed out; and
- match result.

### Team-private stream

Appropriate private events include:

- credits, power, production progress, queue completion, and placement readiness;
- own-unit damage, losses, orders, and command failures;
- fog-respecting enemy sightings and lost-contact events;
- private alerts currently shown by the HUD; and
- private command details for that team.

In the first release, the deterministic simulation produces events locally. A team-scoped `EventView` filters them before they cross `VS_AGENT`; private data must never be placed in the DOM or returned and then hidden by UI code. Public events generated from the same seed and scheduled commands are identical in both browsers. The room server separately journals the shared facts it actually owns: connections, match configuration, scheduled commands, acknowledgements, and match termination.

This is an API privacy boundary, not a strong anti-cheat boundary, because each current client still simulates the full world. True secrecy requires the authoritative simulation to move server-side. Until that happens, team-private gameplay events must remain local and must not be uploaded to or relayed through the room service.

### Delivery and retention

- Add cursor reads to the local `EventJournal`, returning public events plus only the current team’s private events.
- Add `event_batch` WebSocket messages only for server-owned shared events, with `afterEventId` cursors. Do not accept client-authored gameplay events as authoritative.
- Retain a bounded local ring buffer per match and a smaller shared ring buffer per room; start with 10,000 events or 8 MiB locally and 2,000 events or 2 MiB on the room server.
- Coalesce high-frequency values. Emit `economy_changed` at most once per second unless a threshold is crossed.
- Support type filters, but enforce visibility before filtering and serialisation.
- If a cursor falls behind retention, return `CURSOR_EXPIRED` and require a fresh observation snapshot.
- Persist nothing by default. Headless tools may write local NDJSON artifacts after redaction.
- Never log passwords, session capabilities, raw authorization headers, model prompts, chain-of-thought, or unredacted hidden game state.

Operational server logs and gameplay journals remain separate. Production operational logs should contain room-safe identifiers, counts, latency, rejection codes, and faults, not gameplay payloads.

## 8. Renderer-independent control plane

The agent API must not depend on a successful graphics boot. `src/main.ts`
publishes a bootstrap marker before constructing `Engine`; `?agent=1&render=none`
selects `HeadlessAgentRuntime`, which creates only the simulation scene and
camera. If an explicitly requested agent run encounters a WebGL startup error,
startup falls back to the same runtime automatically.

The headless runtime uses the real `Battlefield`, `Sim`, `PlayerController`,
`MultiplayerLobby`, command validators, observations, and event journal. The
renderer is not mocked with a fake GPU: it is absent, so accidental render
dependencies fail in tests instead of silently becoming production behavior.

The bridge now exposes these control-plane capabilities:

```ts
window.VS_AGENT = {
  version: 2,
  ready: true,
  capabilities(): string[],
  createRoom(password): Promise<LobbySnapshot>,
  joinRoom(roomCode, password): Promise<LobbySnapshot>,
  spectateRoom(roomCode, password): Promise<LobbySnapshot>,
  roomStatus(): LobbySnapshot,
  launchRoom(): boolean,
  observe(), command(requestId, action), events(afterEventId, limit),
  waitFor(options), start(), step(ticks),
};
```

`tools/agent-play.mjs --render none --disableWebGL true` and the
`agent:smoke:headless` package script exercise this path. The remaining
multiplayer limitation is authority: the Render room service still sequences
commands while clients run the deterministic simulation locally. Shared tick
scheduling, state hashes, and server-side simulation are later protocol work.

## 9. Browser API

Expose a small versioned bridge only when agent mode is explicitly enabled:

```ts
window.VS_AGENT = {
  version: 2,
  ready: true,
  capabilities(): string[],
  createRoom(password): Promise<LobbySnapshot>,
  joinRoom(roomCode, password): Promise<LobbySnapshot>,
  spectateRoom(roomCode, password): Promise<LobbySnapshot>,
  roomStatus(): LobbySnapshot,
  launchRoom(): boolean,
  observe(): AgentObservation,
  command(requestId, action): CommandAck,
  events(afterEventId?: number, limit?: number): GameEvent[],
  waitFor(options: {
    afterEventId: number;
    types?: string[];
    timeoutMs?: number;
  }): Promise<GameEvent | null>,
  start(): void,
  step(ticks: number): void,
};
```

Guardrails:

- Build gate: `VITE_ENABLE_AGENT_API=true`.
- Runtime gate: `?agent=1` on loopback, or an authenticated room capability in an explicitly agent-enabled deployment.
- `reset` and `step` are offline/harness-only and fail closed in launched multiplayer rooms.
- The bridge returns structured-clone-safe data and frozen copies.
- The extended bridge does not expose `Engine`, `Sim`, Three.js, entity stores, or arbitrary evaluation hooks.
- Keep the existing visual review harness as `window.VS`, but gate it behind `?harness=1`; production play should not expose engine internals by default.

Also add stable DOM semantics for browser-level testing: landmark roles, accessible names, and `data-testid` only where role/name is insufficient. The headless agent API is preferred for play; DOM automation verifies that a human can reach the same actions.

## 10. Headless Chromium runner

Build on the repository’s existing Playwright dependency and launch flags. Add `tools/agent-play.mjs` with three modes:

```text
node tools/agent-play.mjs --scenario tests/scenarios/opening.json
node tools/agent-play.mjs --teams scripted,scripted --seed 1592592177
node tools/agent-play.mjs --url http://127.0.0.1:5173 --headed
```

The runner should:

1. start or attach to the Vite preview and room server;
2. launch one isolated browser context per team;
3. create/join/launch through supported UI or protocol paths;
4. wait on `VS_AGENT.waitFor(...)`, not tight polling;
5. submit commands through `VS_AGENT.command(...)`;
6. enforce a per-decision deadline and a per-match command budget;
7. block unexpected outbound network requests by default;
8. capture screenshots at named milestones and on failure; and
9. write an evidence bundle under a gitignored `runs/<run-id>/` directory.

Suggested bundle:

```text
runs/<run-id>/
  manifest.json
  public.ndjson
  team-0.private.ndjson
  team-1.private.ndjson
  commands.ndjson
  final-observation.team-0.json
  final-observation.team-1.json
  screenshots/
  console.log
```

Private streams must remain separate in the bundle. A combined evaluator may read both after the match, but no playing agent receives the opposing private file.

Use a declarative scenario format for deterministic regression tests:

```json
{
  "schemaVersion": 1,
  "seed": 1592592177,
  "pacing": "deliberate",
  "maxTicks": 18000,
  "teams": ["scripted-economy", "scripted-pressure"],
  "assertions": [
    { "type": "no-combat-before", "tick": 2700 },
    { "type": "state-digests-equal" },
    { "type": "no-private-event-leak" }
  ]
}
```

The first runner should use in-repository scripted policies. An LLM adapter can be added later without coupling the game to a model vendor, API key, network service, or prompt format.

## 11. Proposed code map

New modules:

```text
shared/game-protocol.mjs               pure command/wire validation used by browser and server
shared/game-protocol.d.ts              TypeScript declarations for the shared validator
src/game/protocol/GameCommand.ts       domain command and acknowledgement types
src/game/protocol/GameEvent.ts         event schema and visibility rules
src/game/agent/Pacing.ts               immutable pacing profiles
src/game/agent/Observation.ts          fog-safe snapshot projection
src/game/agent/EventJournal.ts         bounded cursor-based journal
src/game/agent/CommandGateway.ts       the only UI/AI/agent command entry
src/game/agent/AgentBridge.ts          guarded window.VS_AGENT adapter
src/game/agent/HeadlessAgentRuntime.ts simulation/control plane without WebGL
src/game/sim/StateDigest.ts            canonical deterministic state hashing
server/protocol.mjs                    wire parsing built on shared/game-protocol.mjs
server/event-journal.mjs               room event retention and filtering
tools/agent-play.mjs                   headless Chromium match runner
tools/agent-multiplayer-smoke.mjs      two-browser no-WebGL room smoke test
tests/scenarios/*.json                 deterministic agent scenarios
tests/AgentBridge.test.ts
tests/Observation.test.ts
tests/Pacing.test.ts
server/agent-protocol.test.mjs
```

Focused edits:

| Existing file | Proposed change |
| --- | --- |
| `src/main.ts` | Gate `window.VS`; install `VS_AGENT` only when enabled |
| `src/game/Battlefield.ts` | Own pacing, command gateway, observation, and journal lifecycle |
| `src/game/GameState.ts` | Reuse observation-safe DTOs where appropriate |
| `src/game/sim/Sim.ts` | Emit domain events at mutation points; expose canonical digest inputs |
| `src/game/sim/Ai.ts` | Express think, opening, wave, and regroup timings in ticks/profile values |
| `src/game/sim/Commands.ts` | Convert pointer intent into `GameCommand`; remove direct mutation paths |
| `src/game/sim/Stats.ts` | Keep unit balance values stable initially; do not scatter pacing multipliers here |
| `src/game/Multiplayer.ts` | Protocol v2, scheduled commands, shared-event subscriptions, cursor handling |
| `server/index.mjs` | Store match config/tick window, route scheduled commands, and serve server-owned shared events |
| `tools/verify.mjs` | Assert the harness is absent without its gate and the agent bridge is healthy with its gate |
| `package.json` | Add `agent:smoke` and `agent:scenario` scripts; no new runtime dependency |

## 12. Delivery plan

### PR 1 — Contracts and deterministic observability

- Extract `GameCommand` and its validator.
- Add canonical state digest and fog-safe observation projection.
- Add `EventJournal`/`EventView` with visibility tests.
- Record baseline pacing metrics from seeded scripted matches.

Exit criteria: same seed plus same commands produces identical digests; team 0 observation contains no fog-hidden team 1 entities.

### PR 2 — Guarded local agent bridge

- Add `CommandGateway` and route UI commands through it.
- Add guarded `VS_AGENT.observe`, `command`, `events`, `waitFor`, `reset`, and `step`.
- Gate the existing raw visual harness.
- Add offline scripted smoke scenarios.

Exit criteria: a headless scripted agent can build, place, select, order, and finish a deterministic local scenario without page-level object mutation.

### PR 3 — Deliberate pacing

- Add match-owned pacing profiles.
- Replace the forced forward battle groups in `deliberate` mode.
- Give `Commander` explicit opening, first-wave, cadence, and regroup tick gates.
- Expose pacing metrics in the evidence bundle and tune against targets.

Exit criteria: ten fixed-seed runs meet the first-contact and event-burst targets without deadlocks or matches that cannot finish.

### PR 4 — Multiplayer protocol v2 and live logs

- Negotiate immutable match config at room creation.
- Schedule commands at server-assigned `applyTick` values.
- Add local public/private event batches and server-owned shared batches with cursor resume and bounded retention.
- Add state digest exchange and fail loudly on divergence.
- Keep protocol v1 isolated during migration or reject it with a clear version error.

Exit criteria: two browser contexts apply every accepted command on the same tick, produce equal canonical state digests, and cannot read the opposing private stream through any supported API.

### PR 5 — Full headless match runner

- Add two-context Playwright orchestration, scenario files, evidence bundles, request blocking, screenshots, and failure diagnostics.
- Add CI-friendly smoke scripts with low/medium graphics quality and deterministic ticks.
- Keep expensive visual capture as a separate job from simulation correctness.

Exit criteria: one command runs a complete two-agent match, returns a nonzero exit code for a protocol/privacy/determinism failure, and leaves enough evidence to reproduce it.

## 13. Tests and acceptance criteria

### Pacing

- `deliberate` does not spawn forward battle groups.
- Built-in AI cannot issue an attack-wave order before `minimumWaveTicks`.
- Pause and render frame rate do not change match tick semantics.
- Multiplayer pacing is immutable after launch.

### Commands and determinism

- Invalid, stale, oversized, out-of-bounds, unaffordable, or unauthorized commands return stable rejection codes.
- Duplicate `requestId` values never execute twice.
- Both multiplayer clients apply each command at the acknowledged tick.
- Canonical state digests match at regular checkpoints for fixed-seed scenarios.

### Privacy

- Public subscriptions contain no team-only payload fields.
- A team subscription receives only its own private events.
- Hidden enemy entities never appear in an observation or team-private sighting event.
- Cursor expiry cannot be used to retrieve older private data.
- Tokens, passwords, prompts, and authorization values are absent from artifacts and server logs.

### Headless operation

- Runs on the existing Playwright/Chromium stack without a display server.
- Uses structured waits and tick stepping rather than animation-time sleeps.
- Rejects unexpected external network requests.
- Captures console errors, page errors, final observations, event streams, commands, and failure screenshots.
- Runs at least one local and one two-browser multiplayer smoke scenario.

### Existing quality gates

Every implementation PR must continue to pass:

```bash
npm run typecheck
npm run build
npm test
node tools/verify.mjs
```

Visual work must still use the existing stable shot presets. Agent scenarios supplement the visual harness; they do not replace it.

## 14. Risks and deliberate non-goals

### Risks

- Applying commands on receipt will preserve current multiplayer drift; scheduled ticks and digests are required before trusting long agent matches.
- Event generation inside hot loops can create garbage and frame spikes. Emit compact domain events only at meaningful state transitions, then coalesce.
- A raw bridge that returns mutable objects becomes an accidental cheat/debug API. Treat serialisation boundaries as part of the security model.
- A slower simulation can make already-long headless visual runs expensive. Deterministic offline tick stepping must bypass wall-clock pacing.
- In-memory rooms lose journals on restart. That is acceptable for the first agent mode, provided artifacts are written by the runner as events arrive.

### Non-goals for the first release

- Ranked competitive anti-cheat.
- Persistent accounts, matchmaking, or replay hosting.
- A server-side authoritative Three.js simulation.
- Bundling an LLM client, API key, or vendor-specific prompt loop into the game.
- Exposing arbitrary JavaScript evaluation to agents.
- Recording model reasoning or chain-of-thought.

## 15. Decisions requested

Before implementation, confirm these product choices:

1. Make `deliberate` the normal play default while retaining `classic` for demos and visual regression.
2. Treat private logs as fog-safe commander telemetry, not as strong anti-cheat until simulation authority moves server-side.
3. Keep the first automation adapter model-agnostic and ship scripted policies first.
4. Keep match journals ephemeral on the service; durable evidence is written by the headless runner.

Recommended answer: approve all four. It produces a useful offline agent loop quickly, creates a clean migration path for multiplayer, and avoids coupling core gameplay to one automation provider.
