# Verdium Storm — Full Human and Agent Playability Proposal

Status: proposed

Related foundation: [`AGENT_FRIENDLY_PLAN.md`](./AGENT_FRIENDLY_PLAN.md)

## 1. Decision and outcome

Adopt the attached report's central recommendation: make every important game rule, state transition, command result, and match-lifecycle action explicit to both humans and agents.

This should be an incremental extension of the current architecture, not a second game implementation. Verdium Storm already has the difficult foundation: a deterministic 30 Hz simulation, stable entity references, a renderer-independent `VS_AGENT` runtime, fog-filtered observations, a bounded event journal, deliberate pacing, multiplayer rooms, and spectator connections.

The implementation should produce one game that can be completed end to end through either the normal UI or the agent API. The renderer remains optional; the rules and simulation do not.

Success means a new human or a new agent can independently answer these questions without inspecting source code:

1. What is the objective and how can the match end?
2. What can I build now, what does it cost, and what prerequisite is missing?
3. What is each selected unit doing, and why did it stop?
4. Was my command rejected, scheduled, executed, or later unable to complete?
5. What information is current, remembered, private, or public?
6. How do I surrender, reconnect, observe, replay, or request another match?

## 2. Current baseline and actual gaps

| Area | Already present | Remaining gap |
| --- | --- | --- |
| Simulation | Seeded fixed-step simulation and stable opaque refs | No first-class match mode or structured terminal result |
| Agent startup | `?agent=1&render=none`, WebGL-free runtime, `VS_AGENT` v2 | Dynamic state is still too shallow for reliable long-horizon play |
| Commands | Typed actions, validation, request IDs, immediate acknowledgements | An accepted command has no guaranteed later execution outcome |
| Economy | Credits, income, power, cargo, resource fields, production data | Harvester intent, destination, unload progress, and failure reasons are not exposed consistently |
| Rules | Short command/objective summary in the menu; stats exist in `Stats.ts` | No complete human rules view or generated machine-readable rules contract |
| Events | Bounded public/team journal with cursors | Economy, command lifecycle, harvesting, and match lifecycle need richer typed events |
| Multiplayer | Password rooms, sequenced actions, manual launch, basic spectators | No explicit leave control, participant identity/presence roster, readiness handshake, automatic start, resumable session, surrender, rematch, AFK, or terminal room state |
| Automation | Playwright smoke runners and deterministic stepping | `step()` returns no result; no tutorial/scenario completion harness or replay contract |

The most important product gap is not missing content. It is missing explanations at state-transition boundaries. A harvester that silently becomes idle and an accepted order that never produces a correlated outcome are ambiguous to a human and unusable to an agent.

## 3. Architecture decisions

### 3.1 One command path

Human controls, built-in AI, remote multiplayer, and `VS_AGENT` must all enter the simulation through one `CommandGateway`.

```text
HUD / keyboard ─┐
Built-in AI ────┼──> CommandGateway ──> Sim ──> EventJournal
VS_AGENT ───────┤          │                         │
Multiplayer ────┘          └── receipt              ├──> human alerts
                                                    ├──> agent events
                                                    └──> replay evidence
```

No surface may directly mutate entity stores, production queues, credits, objectives, or match state.

### 3.2 Separate static rules from dynamic observations

Unit statistics, prerequisites, weapon ranges, build times, and victory rules change rarely and should not be repeated in every observation. Publish them once through `getRules()` and generate both the human rules panel and the machine guide from the same registry.

`observe()` remains the compact, team-safe answer to "what is true now?". `events()` answers "what changed since my cursor?".

### 3.3 Acknowledgement is not completion

An immediate receipt means only that a command was understood and accepted or scheduled. Every accepted command must later reach one of these terminal outcomes:

- `command_executed`
- `command_completed`
- `command_failed`
- `command_cancelled`

Each outcome carries the original `requestId`. Long-running orders may emit both `command_executed` and a later completion/failure event.

### 3.4 Make clock ownership explicit

Support three modes:

- `live`: time advances from the match clock. All multiplayer matches use this mode.
- `manual`: offline/headless simulation advances only through positive `step()` calls.
- `replay`: a read-only runtime reconstructs the match from seed, configuration, and scheduled command log.

Manual stepping must be rejected after joining or launching a live multiplayer room. Rewind must rebuild a replay runtime from a checkpoint; negative simulation steps are not permitted.

### 3.5 Preserve fog and authority boundaries

All observations and strategic queries are derived for an authenticated team before serialisation. Queries must not inspect hidden enemies and then merely hide fields in the UI.

The current room service sequences commands but does not run the authoritative game simulation. Therefore:

- the server may authoritatively accept surrender and disconnect forfeits;
- a normal victory result should be finalized only when both clients report the same terminal result and digest;
- mismatched client results become `result_disputed`, not a server-declared winner; and
- strong anti-cheat, authoritative fog secrecy, and ranked play remain dependent on a future server-side simulation.

## 4. Proposed contracts

The examples below define intent. Exact names can change during the contract PR, but the semantics should not.

### 4.1 Rules contract

```ts
interface GameRules {
  schemaVersion: 1;
  simulationHz: 30;
  map: {
    bounds: MapBounds;
    buildGridSize: number;
    resourceFieldRules: ResourceFieldRule[];
  };
  economy: {
    startingCredits: number;
    lowPowerThreshold: number;
    harvesting: HarvestRule;
  };
  victory: VictoryRule[];
  units: Record<UnitType, UnitRule>;
  buildings: Record<BuildingType, BuildingRule>;
  commands: Record<GameCommandType, CommandRule>;
  eventTypes: EventRule[];
}
```

`UnitRule` and `BuildingRule` should be projected from the existing simulation stats, including costs, build times, HP, armour, movement, sight, weapons, producer, power, prerequisites, and command capabilities. Do not maintain a second hand-written balance table.

Deliver the same data in three forms:

- `VS_AGENT.getRules()` for browser agents;
- a generated `public/agent-guide.json` for discovery before a match boots; and
- a human Rules/How to Play panel that reads the same registry.

### 4.2 Observation v2

```ts
interface AgentObservationV2 {
  schemaVersion: 2;
  match: {
    id: string;
    seed: number;
    mode: 'live' | 'manual' | 'replay';
    phase: 'opening' | 'active' | 'ended';
    result: MatchResult | null;
    tick: number;
    matchTime: number;
    pacing: PacingId;
  };
  commander: {
    team: 0 | 1 | 2;
    role: 'commander' | 'spectator';
    connected: boolean;
  };
  economy: EconomyObservation;
  own: ObservedEntityV2[];
  visibleEnemies: ObservedEntityV2[];
  rememberedEnemies: RememberedContact[];
  resources: ObservedResourceField[];
  production: ObservedProduction;
  objectives: ObservedObjective[];
  limits: { unitCount: number; unitCap: number };
  availableCommands: AvailableCommand[];
  lastEventId: number;
  observationDigest: string;
}
```

Important entity additions:

```ts
interface ObservedEntityV2 {
  id: number;                 // stable opaque ref; 0 remains NO_REF
  team: 0 | 1;
  kind: 'unit' | 'building';
  type: string;
  position: { x: number; z: number };
  hp: { current: number; max: number; fraction: number };
  activity: string;
  stance?: string;
  capabilities: string[];
  destination?: { x: number; z: number };
  targetId?: number;
  cargo?: { current: number; capacity: number; resourceFieldId?: number };
  homeRefineryId?: number;
  queueDepth?: number;
  buildProgress?: number;
  lastFailure?: { code: string; tick: number };
}
```

For harvesters, `activity` must distinguish `idle`, `seeking`, `mining`, `returning`, and `unloading`. A missing refinery, depleted field, unreachable field, destroyed refinery, or full/empty cargo transition must be explicit rather than inferred from movement.

Remembered enemies contain only fields that were previously observed, with `lastSeenTick` and confidence/age. They never include live hidden HP, target, production, path, or position updates.

### 4.3 Command lifecycle

```ts
interface CommandReceipt {
  requestId: string;
  status: 'accepted' | 'scheduled' | 'rejected' | 'duplicate';
  receivedTick: number;
  applyTick?: number;
  code?: string;
  message?: string;
}
```

Rejections and failures use stable codes, including at minimum:

- `INVALID_REF`, `WRONG_TEAM`, `INVALID_TARGET`, `TARGET_NOT_VISIBLE`
- `OUT_OF_BOUNDS`, `UNREACHABLE`, `QUEUE_FULL`
- `INSUFFICIENT_CREDITS`, `LOW_POWER`, `MISSING_PREREQUISITE`
- `INVALID_PLACEMENT`, `NO_REFINERY`, `RESOURCE_DEPLETED`
- `MATCH_NOT_ACTIVE`, `SPECTATOR_READ_ONLY`, `MODE_NOT_MANUAL`

Messages remain short and useful for humans, while code is the reliable automation contract.

Example sequence:

```json
{"requestId":"harvest-17","status":"scheduled","receivedTick":840,"applyTick":843}
{"type":"command_executed","tick":843,"correlationId":"harvest-17","payload":{"refs":[65539]}}
{"type":"harvest_failed","tick":910,"correlationId":"harvest-17","payload":{"ref":65539,"code":"NO_REFINERY"}}
```

### 4.4 Step result

Change manual stepping from fire-and-forget to evidence-producing:

```ts
interface StepResult {
  fromTick: number;
  toTick: number;
  advancedTicks: number;
  events: GameEvent[];
  observation: AgentObservationV2;
  digest: string;
}

step(ticks: number, afterEventId?: number): StepResult;
```

Returning a value is compatible with existing JavaScript callers that ignore it. Bounds should prevent accidental million-tick calls, and stepping is unavailable in `live` multiplayer mode.

### 4.5 Strategic query surface

Add bounded, fog-safe helpers:

- `getRules()` — static rules and schema metadata.
- `getMap()` — known bounds, terrain/buildability metadata, and visible resources.
- `getBuildOptions()` — current availability with cost and rejection reason.
- `getValidPlacements(buildingId, area?, limit?)` — sampled candidates plus constraint failures; never an unbounded full-grid dump.
- `getPath(ref, destination)` — a preview for an owned unit using known terrain; it must not reveal hidden dynamic occupancy.
- `getThreats()` — only visible or remembered contacts, with source and age.
- `getVictoryStatus()` — objective progress and terminal result.
- `surrender()` and `requestRematch()` — lifecycle commands, not direct state mutation.

The query methods should call shared selectors used by the HUD. They are convenience views, not privileged access to `Sim`.

### 4.6 Room and match lifecycle

```ts
interface RoomSnapshotV2 {
  protocolVersion: 2;
  roomCode: string;
  state: 'waiting' | 'ready' | 'launched' | 'reconnecting' | 'ended';
  participants: Array<{
    participantId: string;
    name: string;
    nameSource: 'chosen' | 'generated';
    role: 'host' | 'commander' | 'spectator';
    team?: 0 | 1;
    connected: boolean;
    ready: boolean;
    lastSeenAt: number;
  }>;
  spectatorCount: number;
  autoStart: true;
  pacing: PacingId;
  scheduledStartTick?: number;
  reconnectDeadline?: number;
  result?: MatchResult;
  rematchVotes: Array<0 | 1>;
}
```

The room server should retain a launched room through a reconnect grace period instead of destroying it on the first commander disconnect. A resumable capability rotates on successful resume and must never appear in logs or observations.

Connection, presence, and readiness are separate states:

- `connected` means the participant currently has an authenticated room socket;
- `ready` means that client has loaded the required protocol, rules, and simulation runtime and can begin; and
- `team` identifies the occupied commander slot independently of connection status.

This lets both humans and agents check exactly who is present through `roomStatus().participants`, including which of team 0 and team 1 is connected and ready. A disconnected participant remains visible during the reconnect grace period instead of disappearing from the roster.

Every participant has a room-scoped display name. A supplied name is normalized and bounded; if omitted, the server creates a non-identifying, unique callsign such as `Commander Amber-27`. Generated names are stable for that room and resume session. Names are presentation metadata only and must never be used for authentication or team ownership.

Proposed lifecycle rules:

- room creation reserves team 0 for Commander 1; the next commander occupies team 1;
- both clients send `client_ready` only after authentication and runtime initialization;
- the server automatically schedules launch when both commander teams are connected and ready;
- in the normal flow Commander 1 is already ready, so Commander 2 becoming ready triggers automatic start;
- `match_start_scheduled` includes a server sequence and shared start tick/time so both clients begin together;
- the existing manual `launchRoom()` method is deprecated in v3; its compatibility behavior is `setRoomReady(true)`, not unilateral launch;
- an explicit Disconnect/Leave action closes the caller's socket and invalidates its active session cleanly;
- leaving before launch frees team 1's slot, while the host leaving before launch closes the room;
- disconnecting after launch enters the same reconnect grace policy as an unexpected network loss; surrender remains a separate explicit action;
- explicit surrender ends the match immediately;
- commander disconnect enters `reconnecting` for a configured grace window;
- reconnect restores the existing team and command sequence;
- grace expiry becomes forfeit or room closure according to match state;
- rematch requires both commanders and creates a new seed/match ID in the same room;
- cancel is allowed while waiting, before launch;
- AFK warning is advisory initially; command silence alone must not force a loss because a player may be observing;
- inactivity draw requires agreement or a deterministic objective rule, not a client-local wall clock.

### 4.7 Agent-friendly multiplayer control

Expose room lifecycle methods directly rather than requiring an agent to find and click lobby controls:

```ts
createRoom(options: { password: string; name?: string }): Promise<RoomSnapshotV2>;
joinRoom(options: { roomCode: string; password: string; name?: string }): Promise<RoomSnapshotV2>;
setRoomReady(ready: boolean): Promise<RoomSnapshotV2>;
roomStatus(): RoomSnapshotV2;
disconnectRoom(): Promise<{ status: 'disconnected'; roomCode: string }>;
resumeRoom(resumeCapability: string): Promise<RoomSnapshotV2>;
```

The documented agent sequence is:

1. Commander 1 calls `createRoom`, records the returned room code, and calls `setRoomReady(true)` after its runtime is ready.
2. Commander 2 calls `joinRoom`, verifies that its participant record has `team: 1`, and calls `setRoomReady(true)`.
3. Both commanders wait for `match_start_scheduled` or observe room state `launched`; neither calls a separate start method.
4. At any time, `roomStatus()` reports names, teams, connection state, readiness, spectators, and reconnect deadline.
5. A deliberate departure calls `disconnectRoom()`; ending the match by concession calls `surrender()` first.

Required room events are `participant_connected`, `participant_disconnected`, `participant_named`, `participant_ready`, `match_start_scheduled`, `room_left`, and `room_closed`. Each uses the existing cursor-based event interface and contains safe participant IDs, display names, team, and state—never passwords or session/resume capabilities.

Room operations return structured codes such as `NAME_INVALID`, `TEAM_SLOT_OCCUPIED`, `ALREADY_READY`, `ROOM_NOT_WAITING`, `NOT_CONNECTED`, and `RESUME_EXPIRED`. The human lobby maps those same codes to plain-language status messages.

## 5. Human experience

### Rules and How to Play

Upgrade the current short menu summary into a layered Rules panel:

1. **Quick start:** objective, selection, movement, combat, harvesting, production, power, and placement.
2. **Reference:** every unit/building, cost, build time, prerequisite, weapon role, and available command.
3. **Match lifecycle:** fog, pacing, pause/manual restrictions, multiplayer, spectator, surrender, reconnect, and rematch.

Tooltips and selection panels should use the same terminology and failure codes as the agent contract. Human-facing text may be friendlier, but it should map one-to-one to the machine reason.

### Multiplayer room controls

The room panel should show a stable roster rather than only a connected-player count:

- Commander 1 / team 0: display name, connected/disconnected, and ready/not ready;
- Commander 2 / team 1: display name, connected/disconnected, and ready/not ready;
- current spectator count;
- the local commander's team and display name; and
- reconnect countdown or scheduled-start countdown when applicable.

Allow an optional name during create/join and show the server-generated callsign when left blank. Add an explicit **Disconnect** button. Before launch it leaves the lobby; after launch it warns that the match will enter reconnect grace and offers **Surrender and Disconnect** as a distinct choice.

Replace the host-only Start button with readiness status and the message: “The match starts automatically when both commanders are connected and ready.” The UI may mark a client ready automatically once its runtime is initialized, but it must visibly report that transition.

### Economy and harvester telemetry

For each selected harvester show:

- cargo current/capacity;
- current activity;
- assigned field and remaining resource when known;
- target refinery;
- delivery/unload progress; and
- the most recent blocked/failure reason.

The economy panel should distinguish instantaneous delivery events from the smoothed credits-per-minute figure already calculated by `TeamState`.

### Tutorials

Use deterministic scenarios, not pop-up text over a full battle:

- Human tutorial: select, move, harvest, construct power, queue a unit, attack, and complete an objective.
- Agent tutorial: call `getRules`, inspect state, issue the same domain commands, consume correlated events, and finish the same objective without WebGL.

Both tutorials should be driven by scenario objectives and journal events so completion rules cannot drift between UI and agent automation.

## 6. Implementation work packages

| Package | Main repository changes | Exit condition |
| --- | --- | --- |
| A. Contracts and rules | Add `src/game/rules/GameRules.ts`; extract transport-neutral commands to `src/game/commands/GameCommand.ts`; add `CommandGateway.ts`; define versioned schemas in `src/game/agent/AgentTypes.ts`; add canonical wire constants in `shared/protocol.mjs` plus declarations | Human panel, agent guide, browser API, and server agree on versions and identifiers |
| B. Economy observability | Extend `src/game/sim/Sim.ts`, `Economy.ts`, and entity selectors; emit harvester state/delivery/failure events; expose cargo, assignment, destination, refinery, and income samples | No harvester becomes idle or abandons work without an observable reason |
| C. Command outcomes | Route `Battlefield`, UI input, built-in AI, agent bridge, and multiplayer actions through `CommandGateway`; correlate execution events; make request IDs idempotent | Every accepted command has a traceable execution or terminal failure |
| D. Observation and queries | Add observation v2 projection, remembered contacts, rules/build/path/placement/threat selectors, deterministic sorting and caps | An agent can plan without raw engine access or hidden information |
| E. Modes and scenarios | Add a match-owned clock mode, `StepResult`, scenario definitions, objective evaluator, and replay recorder/checkpoints | Offline manual and headless runs are deterministic; live multiplayer rejects stepping |
| F. Human onboarding | Add Rules panel, richer selection/economy UI, shared reason-message catalog, and tutorial flow in `src/ui` | A first-time human can complete the tutorial without source/docs |
| G. Multiplayer lifecycle | Extend `server/index.mjs` and `src/game/Multiplayer.ts` for named participant/team snapshots, explicit disconnect, readiness and automatic launch, reconnect/resume, surrender, terminal claims, rematch, and spectators | Humans and agents can identify both commander slots, become ready, auto-start, leave cleanly, and converge on room state |
| H. Automation and evidence | Expand `tools/agent-play.mjs`; add tutorial, no-WebGL, two-agent, reconnect, fog-leak, and replay smoke runners | CI proves complete gameplay paths rather than merely successful boot |

Suggested new modules are boundaries, not mandatory file names. The important constraint is that rules, validation, observation, and lifecycle logic each have one owner.

## 7. Delivery sequence

### Phase 0 — Contract freeze and instrumentation

1. Inventory current commands, stats, objectives, events, and server messages.
2. Define `GameRules`, observation v2, receipt/outcome semantics, failure-code catalog, and room protocol v2.
3. Add golden JSON fixtures and schema compatibility tests before changing behavior.
4. Record baseline scenario digests and current agent smoke evidence.

Acceptance: every proposed field has an owner, visibility rule, size bound, and compatibility decision.

### Phase 1 — Reliability first

1. Implement harvester state/failure events and richer economy observations.
2. Introduce `CommandGateway` and correlated command outcomes.
3. Return `StepResult` and enforce `live` versus `manual` behavior.
4. Add structured local match results plus surrender.
5. Expand deterministic unit and headless tests.

Acceptance: a no-WebGL agent can start from the tutorial seed, establish income, build, fight, detect the result, and explain every rejected or failed action from structured data.

### Phase 2 — Onboarding parity

1. Build the generated rules registry and `agent-guide.json`.
2. Add the full human Rules panel and shared tooltips/reason messages.
3. Implement human and agent tutorial scenarios over the same objective engine.
4. Add UI indicators for mode, connection state, harvester activity, and command failure.

Acceptance: human and agent tutorial scripts execute the same command types and satisfy the same objective predicates.

### Phase 3 — Strategic depth and evidence

1. Add placement, path, threat, build, map, and victory query selectors.
2. Add fog-safe remembered contacts.
3. Record replay manifests containing seed, pacing/config, scheduled commands, lifecycle events, and deterministic digests.
4. Implement replay seek by checkpoint plus deterministic re-simulation.

Acceptance: a replay reaches the same periodic digests and result; strategic queries never reveal hidden enemy state.

### Phase 4 — Competitive lifecycle polish

1. Add protocol v2 participant records with team, chosen/generated name, connected state, and ready state.
2. Add explicit disconnect, server-owned readiness, and automatic scheduled launch when both commander teams are ready.
3. Add reconnect grace, surrender, terminal-result agreement/dispute, rematch, waiting-room cancel, and spectator count/state.
4. Add advisory AFK detection and explicit inactivity policy.
5. Add agent instructions plus named-roster, auto-start, disconnect, reconnect, and lifecycle browser/server smoke tests.

Acceptance: two named or auto-named commanders can identify their teams, create, join, become ready, auto-start without a host launch command, disconnect/reconnect, finish, observe the result, and rematch without creating a new room manually.

## 8. Pull-request slicing

Keep each change deployable and reviewable:

1. **Contracts:** schemas, rules registry, reason catalog, fixtures; no gameplay changes.
2. **Harvesting:** telemetry and events with unit tests.
3. **Command gateway:** unified validation, receipts, outcomes, idempotency.
4. **Observation v2:** richer projection, fog tests, `StepResult`, compatibility adapter.
5. **Tutorial and UI:** Rules panel, harvester/economy panel, deterministic tutorials.
6. **Strategic queries and replay:** bounded selectors, manifests, checkpoints, replay smoke.
7. **Room protocol v2:** named team participants, presence/readiness, explicit disconnect, automatic scheduled start, and agent instructions.
8. **Reconnect and match lifecycle:** resume tokens, reconnect grace, surrender/result handling, rematch, spectator, and AFK polish.

Do not combine the room-protocol migration with the command-gateway refactor. Either one can produce difficult desynchronisation bugs and needs isolated evidence.

## 9. Versioning and migration

- Publish the richer browser surface as `VS_AGENT.version = 3` with `AgentObservation.schemaVersion = 2`.
- Keep a v2 compatibility adapter for one tagged release or behind `?agentApi=2`.
- Changing `step()` to return a value is safe for callers that ignore it, but TypeScript interfaces and documentation still need a migration note.
- Server protocol v1 rooms remain isolated from protocol v2 rooms; do not negotiate mixed message semantics within one room.
- Reject unsupported versions with `UNSUPPORTED_PROTOCOL` and the supported version list.
- Generate example fixtures from tests and use them in both documentation and compatibility checks.

## 10. Test and evidence matrix

| Layer | Required coverage |
| --- | --- |
| Simulation unit tests | Every harvester transition; no-refinery, depleted, unreachable, and destroyed-home failures; command completion/failure; match result |
| Contract tests | Stable codes, deterministic ordering, collection caps, JSON serialisation, v2 compatibility adapter |
| Fog/privacy tests | Hidden enemy refs and live fields absent from observation, events, threats, path, placement, and replay artifacts |
| Determinism tests | Same seed/config/commands produce matching periodic digests and final result |
| UI tests | Rules data equals generated guide; tutorial objectives; human failure messages; harvester telemetry |
| Headless Chromium | WebGL disabled; agent tutorial completed; `step()` evidence; bounded `waitFor()` usage |
| Multiplayer browser | Chosen and generated names, team/presence roster, create/join/ready/auto-start, scheduled command, explicit disconnect/reconnect, spectator, surrender, result agreement, rematch |
| Server tests | Name normalization/generation, team assignment, readiness race/idempotency, single automatic launch, disconnect semantics, resume-token rotation, grace expiry, room snapshots, protocol mismatch, secret redaction, origin handling |

Evidence bundles should contain configuration, public/team-safe events, receipts, observations at checkpoints, and digests. They must not contain passwords, session/resume capabilities, authorization headers, prompts, hidden state, or chain-of-thought.

## 11. Risks and explicit non-goals

- **Client authority:** until the simulation moves server-side, multiplayer privacy is an API boundary rather than strong anti-cheat. Do not market this phase as ranked-secure.
- **Observation size:** richer data can overwhelm browser agents. Static rules are fetched separately; dynamic arrays are sorted, bounded, quantised, and cursor-driven.
- **Path and placement leakage:** queries operate only on known terrain and owned entities and never expose hidden dynamic blockers.
- **Replay cost:** rewind is checkpoint plus replay, not reverse mutation. Start with coarse checkpoints and bound retained history.
- **Failure-event noise:** emit on state change or terminal failure, not every tick. Economy samples are coalesced.
- **Protocol migration:** reconnect work begins only after command and observation contracts are covered by golden fixtures.

Deferred beyond this proposal:

- authoritative server-side simulation and ranked anti-cheat;
- public matchmaking, ladders, or tournaments;
- cloud persistence of private gameplay logs;
- balance/content expansion unrelated to clarity or playability; and
- agent access to arbitrary runtime, renderer, DOM, or scene objects.

## 12. Definition of fully playable

This proposal is complete when all of the following are true:

- A human can learn the objective, economy, power, production, combat, fog, and lifecycle from inside the game.
- An agent can obtain equivalent rules as structured data before issuing its first command.
- Renderer-free Chromium can create/join a room, play a full deterministic scenario, and identify the terminal result.
- Every command receives an immediate receipt and every accepted command produces a correlated execution or terminal failure.
- Harvester state, cargo, assignment, refinery target, delivery, and failure reason are observable in both UI and API.
- Observations and strategic queries are versioned, bounded, deterministic, serialisable, and fog-safe.
- Manual stepping returns state and events and cannot alter a live multiplayer clock.
- Public and team-private journals are cursor-based and contain no credentials or hidden-state leaks.
- Room status explicitly reports each participant's safe display name, team, connected state, and ready state to both the UI and agents.
- A participant can disconnect intentionally, with distinct pre-launch leave, post-launch reconnect-grace, and surrender behavior.
- The server schedules exactly one automatic start when both commander teams are connected and ready; no host-only launch action is required.
- A launched multiplayer room survives a temporary connection loss and has explicit surrender, forfeit, result, spectator, cancel, and rematch behavior.
- Human and agent tutorials share the same commands, scenarios, rules registry, and objective evaluator.
- Replays reproduce checkpoint digests and final results from seed, config, and command history.

The implementation priority is reliability, then discoverability, then strategic convenience, then competitive lifecycle polish. New units, balance passes, and visual effects should not pre-empt these foundations.
