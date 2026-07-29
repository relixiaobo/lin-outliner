# ThreadService Decomposition — four owned modules behind an unchanged facade

Shape: **(b) a SET of four independent complete refactor PRs**, each a pure
structural move with zero behavior change, independently shippable and gated.
Ordered by coupling (least first); any can stop the series without leaving a
partial mechanism — after every PR the system is whole.

All line references are against main at `e57ad9c3` (post-#445). Re-derive
member inventories at build time (A11):
`rg -nE "^  (async |private |public |get )?[a-zA-Z]+\(" src/main/agent/ThreadService.ts`.

## Goal

`ThreadService.ts` is 4,375 lines, 107 methods, 21 state fields — the bug
factory of the 2026-07-29 incident (R1 was a cross-concern interaction inside
it; F2 was a mutex-scope leak between two of its concerns). Split it into four
modules with **explicit state ownership**, coordinated through one small shared
core, behind a **facade whose public surface does not change**: the protocol
handlers (`dispatchRequest`), host API, extension host contract, and every
caller (`main.ts`, `ToolRuntime`, extensions, tests) stay untouched.

North star: same as `native-turn-kernel` — one owner per concern. The kernel
gave the turn loop an owner; this gives each of ThreadService's remaining
concerns an owner and makes the next incident's blast radius legible.

## Non-goals

- **Zero behavior change.** No notification reordering, no mutex-scope change,
  no error-message edits. Where current behavior is odd, it moves as-is; file
  follow-ups.
- No protocol change (`src/core/` diff empty across all four PRs), no public
  method renames, no changes under `src/main/agent/runtime/` (kernel/executor)
  or to `GoalExtension`/`ExtensionRegistry`.
- No test rewrites: the existing suites (`agentThreadService.test.ts` and
  siblings, 1528 core tests) are the behavior guard and must pass **unmodified
  except import paths if a type moves**. No new test obligations — a pure move
  needs no new behavior specs.
- No new abstractions beyond the four modules + shared core. No interfaces
  "for future flexibility"; modules are concrete classes wired in the
  ThreadService constructor.

## Current state (verified facts)

- 4,375 lines; 107 methods; 21 private state fields (`ThreadService.ts:402-463`).
- Concern clusters and their state (field → line):
  - **Turn lifecycle**: `activeTurns:436`, `pendingUserInputs:438`; the
    admission→acceptance→execution chain `acceptAndLaunch:2445`,
    `launchActiveTurn:2468`, `acceptTurn:2476`, `commitAcceptedTurn:2522`,
    `executeActiveTurn:2694`, plus `startRendererTurn:1705`,
    `startContextCommand:1712`, `startPrivilegedTurn:1856`,
    `tryStartTurnIfIdle:1860`, `steerTurn:1870`,
    `enqueueSteeringDelivery:2974`, `failCommittedActiveTurn:2987`,
    `interruptTurn:1975`, `requestUserInput:1983`, `respondUserInput:2048`,
    `updateTurnPlan:2053`, `runInternalMemoryTurn:691`,
    `persistExecutionContextEvidence:2856`,
    `stageRuntimeContextCompaction:2870`, `requireActiveTurn:3477`, client
    bindings `:3435-3476`.
  - **Subagent collaboration**: `mailbox:439`, `ephemeralSpawnEdges:440`,
    `pendingSubagentActivities:446`, `collaborationActivity:452`;
    `spawnChild:2122`, `copyInheritedContextToChild:2190`,
    `spawnIsolatedSkillThread:2230`, `spawnCollaborationAgent:2249`,
    `sendCollaborationMessage:2290`, `followupCollaborationTask:2310`,
    `listCollaborationAgents:2339`, `interruptCollaborationAgent:2353`,
    `waitForCollaborationActivity:2365`, task-path/edge/descendant helpers
    `:3522-3565`, views/outcomes `:3567-3652`, `queueChildTurnActivity:3653`,
    pending-activity machinery `:3700-3735`.
  - **Catalog & lifecycle**: `pendingThreadNames:437`; `startThread:1298`,
    `resumeThread:1321`, `forkThread:1348` (+`copyForkedTurnPayloads:1403`),
    `rollbackThread:1463`, `setThreadName:1556`, `setThreadArchived:1577`,
    `deleteThread:1598`, subtree-stop machinery `:1629-1703`,
    fork-naming `:3153-3195`, automatic naming `:3196-3295`,
    `setInitialPreview:3139`, list/read surfaces `:1209-1296`.
  - **Resources & payload I/O**: `detachedResourceObservations:447`;
    attachment upload `:904-946`, thread resources `:947-1094`, observation
    paths `:1095-1153`, reference enumeration `:1154-1174`,
    `resolveAdmissionContent:1175`, `discardUnreferencedCreatedResources:1197`,
    read surfaces `readItemOutput:862`, `readContextPayload:874`,
    `readTurnDetails:887`.
  - **Shared coordination (must stay singular)**: `threadMutex:455`
    (`KeyedMutex`), `hostRootMutex:456`, `threadTreeMutex:457`, barrier state
    `:459-461`, `stoppingThreads:453`, `hiddenEphemeralThreads:451`,
    `listeners:454` + `recordNotification:3265` +
    `emitTransientNotification:3296` + `applyEphemeralNotification:3310`,
    stores (`metadata`/`history`/`rollout`/`payloads` `:402-405`),
    `ephemeral:435`, canonical reads `requireThread:3413`, `allTurns:3417`,
    `readTurn:3430`, `rollbackRecovery:458`.
- **The single-mutex invariant is load-bearing**: F2 (PR #444 review) was
  precisely a prune escaping `threadMutex`; steering, acceptance, compaction
  staging, payload pruning, and subtree stop all serialize through the SAME
  `KeyedMutex` instance. Per A12 this is a write-boundary concern: the split
  must make it structurally impossible for two modules to hold different mutex
  instances.

## Design

New directory `src/main/agent/thread/`. Five files:

### 1. `thread/ThreadCore.ts` — the shared coordination core (small, ~300 lines)

Owns exactly the "shared coordination" cluster above: the three mutexes,
barriers, stopping/hidden sets, the notification bus (`recordNotification`,
transient emit, ephemeral apply, listener set), the four stores, the ephemeral
thread map, and the canonical read surface (`requireThread`/`allTurns`/
`readTurn`/`readTurnForHost`). It is constructed once by ThreadService and
passed to every module — **one mutex instance by construction**. It contains
no domain logic: no admission, no spawning, no naming.

### 2. `thread/TurnLifecycle.ts` (~1,300 lines moved)

The admission→acceptance→execution→steering→user-input chain and its state
(`activeTurns`, `pendingUserInputs`), including
`persistExecutionContextEvidence`/`stageRuntimeContextCompaction` (they close
over the active turn) and internal-memory turns. Collaboration touchpoints in
`executeActiveTurn` (pending-activity materialization at acceptance, post-turn
flush, `queueChildTurnActivity`) call into `SubagentCollaboration` through the
narrow interface it exports — the calls move, their order does not.

### 3. `thread/SubagentCollaboration.ts` (~900 lines moved)

Spawning (collaboration + isolated-skill children), inherited-context copy,
mailbox, task paths/spawn edges, views/terminal outcomes, wait latch, pending
subagent activities. Owns its four state maps. Exposes to `TurnLifecycle`
exactly what `executeActiveTurn`/acceptance consume today (pending-activity
take/flush/materialize, child-turn activity queueing) — same call sites, same
order, same mutex discipline via `ThreadCore`.

### 4. `thread/ThreadCatalogOps.ts` (~900 lines moved)

Start/resume/fork/rollback/name/archive/delete, subtree stop (drives
admission fencing through `ThreadCore` state + interrupts through
`TurnLifecycle`), fork naming, automatic thread naming, previews, list/read
surfaces.

### 5. `ThreadService.ts` — the facade (~900 lines remaining)

Keeps: constructor/wiring, `initialize`/`close`, `dispatchRequest` and every
public method signature (delegating one-to-one), the extension-host contract,
goal-for-turn and tool-notify glue, resource/attachment public surface
(delegating to the resource module), and anything a module would otherwise
re-export. Public API is byte-compatible: callers and tests do not change.

**Resources & payload I/O** moves in PR 1 into
`thread/ThreadResourceOps.ts` (~700 lines) with the same pattern.

### Wiring rules (all PRs)

- Modules receive `ThreadCore` + the specific sibling interfaces they call;
  no module reaches into another's state maps. State moves WITH its owner;
  the ownership table above is normative.
- Every moved method keeps its name, signature, and mutex acquisition
  placement. Moves that would "naturally" merge or reorder locks are out of
  scope — file follow-ups.
- Circular imports resolved by constructor injection of narrow interfaces
  (declared in the consuming module's file), never by a shared "types" grab-bag.

## Per-PR breakdown (each independently complete)

1. **PR 1 — `ThreadResourceOps`** (least coupled): attachments, resources,
   observations, reference enumeration, prune surfaces. Facade delegates.
2. **PR 2 — `ThreadCore` + `ThreadCatalogOps`**: the shared core extraction is
   PR 2 (not PR 1) so it lands together with its first heavy consumer; catalog
   ops (incl. subtree stop) move onto it. PR 1 is rebased onto the core by the
   facade only.
3. **PR 3 — `SubagentCollaboration`**: the four collaboration state maps and
   all spawn/wait/activity machinery.
4. **PR 4 — `TurnLifecycle`**: the largest and last, when every dependency it
   calls already has an owned home.

Collision note: any concurrent PR touching `ThreadService.ts` (e.g.
`subagent-budget-propagation` PR A: spawn wiring + admission gate + views)
must land BEFORE the decomposition PR that owns those lines (PR 3/PR 4), or
rebase after it. The claiming dev re-runs the collision check per PR.

## Tripwires (every PR, mechanical)

- `git diff origin/main -- src/core/ src/main/agent/runtime/` → empty.
- Facade surface frozen:
  `rg -nE "^  (async )?[a-zA-Z]+\(" src/main/agent/ThreadService.ts | wc -l`
  public-method inventory identical before/after (extraction removes only
  `private` members from the file).
- `wc -l src/main/agent/ThreadService.ts` strictly decreases per PR; the
  four module files plus remaining facade sum to within +5% of the original
  (growth beyond that means logic was added, not moved).
- Test diffs: `git diff --stat origin/main -- tests/` shows import-path
  changes only (assert with a diff that strips import lines → empty).
- Mutex singularity: `rg "new KeyedMutex" src/main/agent/` → exactly one hit,
  in `ThreadCore.ts` (final state).

## Verification (every PR)

`bun run typecheck`; `test:core` (1528, unmodified assertions);
`test:renderer`; `docs:check`; the tripwire commands above. No new tests
required — if a move breaks an existing test, the move changed behavior and
must be redone, not the test. PR 4 additionally: one real-run smoke (steering
mid-turn + subagent spawn/wait + /clear) since it moves `executeActiveTurn`.

## Spec updates

`docs/spec/agent-core.md` Runtime Ownership: replace the "canonical execution
and persistence live under `src/main/agent/`" paragraph's implicit
single-class story with the five-module map (one sentence each), in the same
PR as each extraction lands (incremental, PR-by-PR).

## Open questions

None blocking. Deferred: whether `ThreadCore`'s notification bus should later
absorb `applyEphemeralNotification`'s projection logic into the history store
(behavior-adjacent; separate plan if wanted).

## Checklist

- [ ] PR 1: ThreadResourceOps extracted; gates + tripwires green
- [ ] PR 2: ThreadCore + ThreadCatalogOps; single-mutex tripwire green
- [ ] PR 3: SubagentCollaboration; collision check vs budget PR A re-run
- [ ] PR 4: TurnLifecycle; real-run smoke; final mutex-singularity check
- [ ] Spec map updated PR-by-PR
