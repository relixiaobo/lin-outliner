# Agent Run Graph Cleanup

## Goal

Move the agent execution model to the clean terminal architecture: an
event-sourced Run graph. A sub-run is only a Run with `parentRunId`; task,
child-run, delegation detail, verifier, and background task are views, policies,
or metadata over Run, not separate domain entities.

Fold task-specific specialization into the same model as **Run profiles**, not
agent identities. The persisted field name is `runProfile`. Neva remains the
only agent identity; different work can run with profiles such as default,
research, verify, browser, coding, writing, or dream. A Run profile changes
prompt framing, tool scope, context policy, model override, approval behavior,
and UI labeling for one Run. It does not create a new memory owner,
conversation member, or speaker.

The user-facing result is a simpler and more coherent Work/Runs surface: users
see Runs, nested sub-runs, verification, blocked work, and background work as one
tree. The model-facing result is a smaller tool vocabulary centered on creating
and controlling Runs. The implementation result is one durable Run index plus
per-Run ledgers, with no parallel child-run record shape that can drift from
Run metadata.

## Non-goals

- Do not change the one-Neva invariant. Sub-runs are Neva continuing in an
  isolated context, not other agents or peers.
- Do not use Run profiles as hidden agent identities. They are execution policy
  presets for one Run, not principals, members, memory owners, or speakers.
- Do not reintroduce Task as a persisted domain object.
- Do not reintroduce Team, Swarm, Delegate, multi-agent rosters, or cross-agent
  messaging.
- Do not remove verified execution. Parent-verifies-child remains structural.
- Do not change the event-sourced ledger architecture.
- Do not keep pre-release legacy aliases or old readers. On incompatible agent
  data changes, wipe dev data and delete the old shape.
- Do not make this a single risky rewrite. Each PR must ship a complete,
  independently verifiable cleanup step.

## Shape

This plan is shape (b): a set of independent complete features that converge on
one terminal architecture. Each PR removes a real layer of duplicated concept or
renames one complete seam. No PR should be only scaffolding for a later PR.

## Collision Result

- Open PR #362 claims obsolete outliner Settings root removal. No overlap.
- Open PR #363 claims renderer-only agent tool icon/status presentation and
  activity classification. This plan will eventually touch agent tool
  presentation naming, but the first implementation PR should start in the data
  model/runtime seams and avoid blocking #363.
- `docs/spec/agent-architecture.md`, `docs/spec/agent-delegation-runtime.md`,
  `docs/spec/agent-event-log-rendering.md`, `src/core/agentEventLog.ts`, and
  `src/core/agentTypes.ts` are protocol/shared surfaces. Any implementation PR
  touching them needs a narrow scope and coordinated review.
- `docs/TASKS.md` is main-agent-owned and is intentionally not edited by this
  plan draft.

## Design

### Code-Grounded Diagnosis

The current code is halfway to the terminal model:

- The storage layer already has per-Run ledgers and
  `AgentRunMetaProjection` (`src/main/agentEventStore.ts`). `agent_list_runs`
  already reads run metadata through `listConversationRunMetaProjections`, so
  the Work/Runs first level is mostly Run-centered.
- `AgentRunLedger.runStarted` already writes `run.started` into the Run ledger
  with objective metadata and `parentRunId`, so the durable execution truth is
  already a Run ledger.
- The remaining duplicate entity is the conversation-level child-run feed:
  `child_run.started` / `child_run.updated` in `src/core/agentEventLog.ts` and
  `src/main/agentRuntime.ts`. It duplicates Run metadata and terminal result
  state into the conversation log.
- The code already has profile-like behavior, but it is scattered:
  verifier Runs use `purpose: verify` plus read-only tools and `context: none`;
  `/research` is `readOnlyIsolated`; Dream uses a protected Dream-only run
  profile. These should become one explicit `runProfile` field and resolver.
- `AgentRenderProjection` still exposes `childRunIds` and
  `entities.childRuns`, and transcript rows still have `kind: 'child-run'`.
  That makes the renderer depend on a child-run entity even though Work/Runs can
  already list Runs from the Run index.
- `AgentChatPanel` opens Work/Runs from `agent_list_runs`, but the detail view
  looks up the selected run in `childRuns[selectedRunId]`. A Run can be present
  in the Run index but absent from the active conversation projection, which is
  the wrong dependency direction.
- `AgentChildRunDetailsPanel`, `AgentTranscriptMessageList`,
  `agentTurnProjection`, `AgentProcessTimeline`, and `AgentToolCallBlock` all
  accept `AgentRenderChildRunEntity` or `childRunsByParentToolCallId`. The clean
  UI seam is `AgentRenderRunEntity` / `subRunsByParentToolCallId`.
- IPC already exposes Run-named renderer helpers (`agentRunStatus`,
  `agentRunSteer`, `agentRunAmend`, `agentRunStop`), but the main command table
  still serves legacy `agent_child_run_*` names and the transcript API is still
  `agent_child_run_transcript`.
- Debug still reconstructs `parentToolCallId` by scanning conversation
  `child_run.started` markers. A clean Run index should carry
  `parentToolCallId` directly.

The cleanup should not fight the parts that are already right. It should move
the remaining child-run projection, detail, and UI dependencies onto the Run
index and Run ledgers.

### Reference Research

Two local reference projects support the same terminal direction:

- `cc-2.1` exposes "agent" definitions that are mostly execution-policy bundles:
  prompt overlay, allowed/disallowed tools, model, effort, permission mode,
  MCP servers, hooks, max turns, skills, background behavior, memory, and
  isolation. Its built-in `Explore` and `verification` agents are particularly
  relevant: both are ordinary subagents with narrower tools and stronger prompt
  rules, not a fundamentally different execution entity. The useful part to
  copy is the policy-bundle idea. The part to avoid is letting those bundles
  become separate identities, memories, speakers, or a second Task domain.
- `cc-2.1` also shows the cost of a separate async task layer: background
  agents are registered as `local_agent` tasks, have task output files,
  TaskOutput/TaskStop tools, notifications, and progress summaries. For this
  product, the clean terminal architecture should put that responsibility on
  Run APIs (`run_status`, `run_stop`, `agent_run_detail`) rather than creating a
  second durable Task abstraction next to Run.
- `codex-latest` has `agent role` config overlays applied at spawn time. A role
  can change model, reasoning effort, developer instructions, permissions, and
  runtime behavior. That maps closely to `runProfile` as an overlay. Codex also
  carries thread paths, nicknames, inter-agent communication, and a multi-agent
  registry; those are intentionally not copied because they would violate the
  one-Neva product model.
- `codex-latest` Guardian review is a useful verifier analogue. It builds a
  read-only review session, disables broad capabilities, asks for structured
  output, and lets program policy interpret the verdict. It also keeps review
  continuity with a reusable review session plus transcript cursors. The
  cleaner Tenon version is: every verifier attempt is a normal verifier Run
  with its own ledger, while continuity comes from a typed evidence pack built
  by `VerificationPolicy`.

Research paths checked:

- `/Users/lixiaobo/Coding/.research-repos/cc-2.1/src/tools/AgentTool/AgentTool.tsx`
- `/Users/lixiaobo/Coding/.research-repos/cc-2.1/src/tools/AgentTool/runAgent.ts`
- `/Users/lixiaobo/Coding/.research-repos/cc-2.1/src/tools/AgentTool/loadAgentsDir.ts`
- `/Users/lixiaobo/Coding/.research-repos/cc-2.1/src/tools/AgentTool/built-in/exploreAgent.ts`
- `/Users/lixiaobo/Coding/.research-repos/cc-2.1/src/tools/AgentTool/built-in/verificationAgent.ts`
- `/Users/lixiaobo/Coding/.research-repos/cc-2.1/src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `/Users/lixiaobo/Coding/.research-repos/codex-latest/codex-rs/core/src/agent/role.rs`
- `/Users/lixiaobo/Coding/.research-repos/codex-latest/codex-rs/core/src/agent/control.rs`
- `/Users/lixiaobo/Coding/.research-repos/codex-latest/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`
- `/Users/lixiaobo/Coding/.research-repos/codex-latest/codex-rs/core/src/guardian/review_session.rs`
- `/Users/lixiaobo/Coding/.research-repos/codex-latest/codex-rs/core/src/guardian/prompt.rs`

### Terminal Vocabulary

Use one domain noun:

- **Run**: the only execution entity.
- **Sub-run**: a Run whose `parentRunId` is set.
- **Root run**: a Run without `parentRunId`.
- **Verifier run**: a Run with objective `role: verifier`.
- **Run profile**: the execution policy preset for one Run. It is not an agent
  identity.
- **Detached run**: a Run with `disposition: detached`.
- **Attended run**: a Run with `disposition: attended`.

Avoid these as domain nouns:

- child-run
- child agent
- task entity
- delegation detail
- background task entity

`child` remains acceptable only in local tree algorithms, for example
`children: RunTreeNode[]`, where it describes a generic parent/child data
structure rather than an agent execution concept.

### Domain Model

The terminal model has five relevant primitives:

```text
Conversation
  communication ledger, branches, conversation membership

Run
  execution metadata, objective metadata, objective role, runProfile,
  parentRunId, parentToolCallId

Run ledger
  assistant deltas, thinking, tool calls, tool results, permissions, widgets

Run index
  one durable metadata projection per Run

Run projections
  UI/model/read API shapes derived from Run index plus run-ledger replay
```

There is no persisted `ChildRunRecord`, `DelegationDetail`, or Task table. The
Run index is the single durable metadata record used for lists, restoration,
notifications, and tree projection.

### Run Metadata Shape

The clean Run metadata separates process state from objective state:

```ts
type RunObjectiveRole = 'controller' | 'worker' | 'verifier';

interface RunMeta {
  id: string;
  conversationId: string;
  agentId: AgentId;

  parentRunId?: string;
  parentToolCallId?: string;

  trigger: RunTrigger;
  disposition: 'attended' | 'detached';
  context: 'full' | 'brief' | 'none';
  runProfile: RunProfileId;

  execution: {
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
    usage?: Usage;
    error?: string;
  };

  objective?: {
    text: string;
    criteria: string[];
    role: RunObjectiveRole;
    status:
      | 'active'
      | 'verifying'
      | 'verified'
      | 'blocked'
      | 'budget_exhausted'
      | 'stopped';
    scope?: RunScope;
    budget?: RunBudget;
    blockedReason?: string;
    latestVerifierGap?: string;
    latestSubmissionSeq?: number;
  };
}
```

`agentId` answers "who is acting?" and remains Neva. `runProfile` answers "how is
this Run acting?" and is local to the Run. `objective.role` answers "how should
the program orchestrate this objective?" and is explicit because controller,
worker, and verifier behavior must not be inferred from incidental facts such as
whether a Run currently has sub-runs.

`parentToolCallId` belongs in the Run index, not only in conversation markers.
It is needed by turn folding, debug, trace reveal, and detail navigation.

The current split between `status` and `objectiveStatus` is conceptually right.
The cleanup makes that split explicit in type shape, transition rules, and UI
labels. A process can be `completed` while its objective is `blocked` because an
independent verifier rejected the result. That combination should be deliberate,
documented, and tested rather than implicit runtime folklore.

### Run Profiles

Run profile is the specialization mechanism that replaces "different agents for
different jobs" without violating the one-Neva model.

```ts
type RunProfileId =
  | 'default'
  | 'research'
  | 'verify'
  | 'browser'
  | 'coding'
  | 'writing'
  | 'dream';

interface RunProfile {
  id: RunProfileId;
  label: string;
  systemOverlay?: string;
  defaultContext: 'full' | 'brief' | 'none';
  defaultObjectiveRole?: RunObjectiveRole;
  defaultDisposition?: 'attended' | 'detached';
  allowedActionKinds?: string[];
  disallowedActionKinds?: string[];
  defaultSkills?: string[];
  modelOverride?: string;
  effortOverride?: string;
  unattended?: boolean;
  modelSelectable?: boolean;
  internalOnly?: boolean;
  hiddenFromWorkRuns?: boolean;
}
```

Run profiles are resolved at Run creation:

```text
requested runProfile
  -> built-in RunProfile registry
  -> explicit spawn scope/budget/context overrides
  -> parent scope/budget narrowing
  -> permission gate and hard safety floor
  -> concrete tool catalog + prompt overlay for this Run
```

Built-in Run profiles:

| Profile | Use | Defaults | Initial exposure |
|---|---|---|---|
| `default` | ordinary Neva turn or generic work Run | inherited model/effort, normal tools, context decided by caller | model-selectable |
| `research` | isolated investigation before deciding or editing | read-only tools, `context: brief` or `none`, result report, no writes | model-selectable |
| `verify` | independent acceptance check | read-only tools, `context: none`, `role: verifier`, compact JSON verdict | policy-created only |
| `browser` | browser-control work | browser tools plus strict permission gates, scoped session resources | hidden until browser tools exist |
| `coding` | file/node implementation work | file/node tools narrowed by scope paths/resources | hidden until it differs from `default` |
| `writing` | drafting/editing prose | lower tool surface, no write tools unless explicitly scoped | hidden until it differs from `default` |
| `dream` | memory consolidation | protected Dream channel, Dream-only tools, unattended, hidden from Work/Runs | policy-created only |

Only `default`, `research`, `verify`, and `dream` are current concrete Run
profiles. In the first cleanup PR, the model should only be guided to choose
`default` or `research`; `verify` and `dream` are created by runtime policy, and
`browser`, `coding`, and `writing` remain inactive until their tool and prompt
policies are materially distinct. This avoids a taxonomy that looks clean but
does not change execution.

Run profiles can choose tools and framing; they cannot:

- change `agentId` away from Neva;
- create a new `Principal`;
- own separate memory;
- speak as a different conversation member;
- widen scope beyond the parent Run;
- bypass the permission gate or hard safety floor.

This preserves useful specialization without reintroducing multi-agent identity.

### Run Graph

`parentRunId` is the graph edge. `parentToolCallId` is only provenance: it links
a sub-run back to the `spawn_run` tool call that created it when the sub-run belongs
inside a visible turn process.

Run graph rules:

- A Run can have zero or one parent.
- A Run can have many direct sub-runs.
- A verifier run is a direct sub-run of the Run it verifies.
- Replacement worker attempts are new Runs, not mutations that erase the failed
  attempt.
- Controller runs keep their own id across replanning.
- Depth and concurrency limits remain runtime policy.

### Storage

The storage endpoint is:

- conversation ledger: communication and branch events only
- run ledger: all execution events for one Run
- run index: one metadata record per Run

Conversation-level `child_run.*` events are removed in the terminal model. They
currently exist to let the conversation projection know about child runs, but
that is a derived query over Run metadata. The clean replacement is:

- `run.started` / terminal Run events update the Run index.
- The Run index stores `conversationId`, `parentRunId`, `parentToolCallId`,
  objective metadata, execution metadata, `runProfile`, `context`, and retention
  metadata.
- Conversation and Work/Runs projections read the Run index and join by
  `conversationId`, `parentRunId`, and `parentToolCallId`.
- Run detail reads the selected Run index record and lazily replays that Run's
  ledger for transcript and result.

The run ledger remains the authoritative source for execution detail. The Run
index carries only metadata needed for listing, restoration, status, tree
projection, notifications, and retention.

Terminal result text should not be copied into the conversation log. The Run
ledger should record `run.result.submitted`, and
`RunMeta.objective.latestSubmissionSeq` should point at the latest submitted
result. Run detail, verifier evidence packs, and notifications all derive from
that same event. Notifications can carry a compact derived title/body, but not a
second durable child-run record.

### Runtime Boundaries

Split the current delegation runtime responsibilities into explicit modules:

- `RunController`: create, start, stop, resume, and restore Runs.
- `RunProfileRegistry`: built-in Run profiles, labels, prompt overlays, default
  tools, default context, and default model/effort overrides.
- `RunProfileResolver`: combines requested runProfile, explicit Run parameters,
  parent narrowing, skill restrictions, and hard safety rules into one concrete
  child `Agent` setup.
- `RunContextBuilder`: assemble `full`, `brief`, and `none` context.
- `RunScopeBudgetPolicy`: admit budgets, reserve sibling slices, narrow scopes,
  settle usage, and reject widening.
- `VerificationPolicy`: start verifier runs, parse verdicts, handle gaps,
  decide controller replan versus replacement worker, and enforce livelock
  limits.
- `RunProjectionService`: build Work/Runs rows, turn-fold sub-run summaries,
  notifications, and detail payloads.

The model-facing `spawn_run` tool should become a thin adapter around
`RunController.createSubRun()`. Verification, retry, budget, and projection
policy should not be embedded directly in the tool entry point.

The current `AgentDelegationRuntime` can shrink toward a coordination wrapper:
it owns the live in-memory `Agent` instances for sub-runs, but durable state,
runProfile resolution, verification policy, budget policy, and UI projections live
behind the modules above.

### Tool Surface

The terminal model-facing vocabulary should be Run-centered:

| Tool | Purpose |
|---|---|
| `spawn_run` | Create a sub-run with objective, criteria, runProfile, scope, budget, context, and disposition. |
| `run_status` | Read a Run's current metadata and optional sub-run summary. |
| `run_steer` | Send guidance to a running or resumable detached Run. |
| `run_amend` | Hard-amend objective metadata and invalidate prior verifier conclusions. |
| `run_stop` | Stop a running Run. |

`spawn_run` is the terminal model-facing tool name; `spawn` should be deleted,
not retained as a model-facing alias. Internal code should use Run vocabulary.
Because the product has not shipped, delete legacy aliases instead of preserving
them:
`prompt`, `run_in_background`, `agent_id`, `agentType`, persisted `fork`, and
child-run-specific names.

`spawn_run.runProfile` should be optional and default to `default`; the persisted
`RunMeta.runProfile` is always required after resolution. The model should use
Run profiles for task fit, not identity:

- use `research` for read-only exploration;
- `verify` is reserved for runtime verifier Runs created by policy;
- `browser` is unavailable until browser-control tools exist;
- `coding` and `writing` are unavailable until they have distinct policies;
- use `default` when no specialization is needed.

The runtime may reject a requested runProfile when its tool capability is not
enabled yet.

IPC should converge on Run names only:

- `agent_list_runs`
- `agent_run_detail`
- `agent_run_transcript`
- `agent_run_status`
- `agent_run_steer`
- `agent_run_amend`
- `agent_run_stop`

Delete `agent_child_run_transcript`, `agent_child_run_status`,
`agent_child_run_send`, and `agent_child_run_stop` once the renderer is migrated.
The transport result should be `AgentRunActionResult`, not
`AgentChildRunActionResult`, with `runId` rather than `agent_id`.

### Verification

Verification remains a first-class policy over Runs:

1. A work Run with criteria completes its execution.
2. `VerificationPolicy` starts a verifier Run with `role: verifier`,
   `context: none`, read-only tools, a narrowed scope, and a budget that fits
   within the parent slice.
3. A passing verdict sets the work Run objective to `verified`.
4. A rejected controller Run replans in place within retry and budget limits.
5. A rejected worker attempt becomes `blocked`; a replacement worker Run starts
   when budget remains.
6. Repeated equivalent gaps trip the livelock guard and park the objective as
   `blocked`.

Verifier output is evidence, not self-declared completion. The parent policy
owns the objective transition.

Verifier Runs do not mutate objective state. They only read the evidence pack
and return a compact verdict:

```ts
type VerifierVerdict =
  | { verdict: 'pass'; notes?: string }
  | { verdict: 'fail'; gap: string; notes?: string };
```

`VerificationPolicy` is the only writer of the target Run's objective state. It
parses the verifier verdict, records verifier linkage, transitions
`objective.status`, and decides whether to replan the controller, start a
replacement worker attempt, park the objective as `blocked`, or mark the budget
exhausted. A verifier cannot call `run_amend`, cannot start replacement work as
its own decision, and cannot mark the target `verified` directly.

Verification history is append-only. Every verifier attempt is its own Run with
its own ledger, terminal status, verdict output, and link to the target Run. The
target Run stores only the current summary state (`objective.status`,
`latestVerifierGap`, budget state, and latest submission pointer). It should not
persist a duplicated `verifierRunIds` list. The verifier history is derived from
the Run index by querying `parentRunId = targetRun.id` and
`runProfile = 'verify'`, then exposed in Run detail as a projection.

Retries are continuous at the policy level:

- A controller Run that fails verification replans in place. Its existing ledger
  remains intact, then `VerificationPolicy` appends the verifier gap as hidden
  guidance and resumes the same Run.
- A worker attempt that fails verification is not overwritten. It is parked as
  `blocked`, and a replacement worker Run is created with an evidence handoff
  containing the failed attempt, the verifier gap, prior equivalent gaps, and the
  original criteria.
- Each verifier Run uses `context: none` so it starts from a clean model context
  and stays an independent check. It does not remember prior verifier reasoning
  as chat context. Instead, `VerificationPolicy` builds an evidence pack with
  the current target result plus the relevant attempt history needed to avoid
  repeating the same gap. The verifier is clean in context, but not blind to the
  verification history: continuity comes from the program-provided evidence pack,
  not from verifier memory.

The evidence pack is a typed, bounded object, not an ad hoc pasted transcript:

```ts
interface VerificationEvidencePack {
  targetRunId: string;
  objective: {
    text: string;
    criteria: string[];
    role: RunObjectiveRole;
    scope?: RunScope;
  };
  latestSubmission: RunSubmissionProjection;
  relevantAttemptHistory: Array<{
    runId: string;
    role: RunObjectiveRole;
    status: AgentObjectiveStatus;
    result?: RunSubmissionProjection;
    verifierGap?: string;
  }>;
  changedArtifacts?: RunArtifactSummary[];
  toolEvidence?: RunToolEvidenceSummary[];
  limits: {
    maxTranscriptTokens: number;
    maxToolEvidenceTokens: number;
    maxPriorAttempts: number;
  };
}
```

The evidence pack should include enough information to judge the stated
criteria: objective, criteria, scope, latest submitted result, relevant prior
gaps, changed artifacts, and capped tool evidence. It should not include the
full parent conversation, hidden reasoning, unrestricted tool logs, or anything
that lets the verifier widen scope. If the pack is incomplete, the verifier can
return `fail` / `gap` explaining the missing evidence; it still cannot mutate
the target Run.

The UI should expose this as a concise Verification section: show the latest
verdict/gap first, then an expandable verifier-attempt list. Each attempt can
open its full Run transcript. The main Run row shows the current objective
status; it does not flatten or erase failed verification attempts.

### Core Render Projection

The core render projection should stop exporting child-run entities:

```ts
interface AgentRenderProjection {
  rows: AgentRenderRow[];
  transcriptRows: AgentRenderRow[];
  entities: {
    messages: Record<string, AgentRenderMessageEntity>;
    runs: Record<string, AgentRenderRunEntity>;
    compactions: Record<string, AgentRenderCompactionEntity>;
    contextClears: Record<string, AgentRenderContextClearEntity>;
    dreams: Record<string, AgentRenderDreamEntity>;
  };
  runIds: string[];
}
```

`AgentRenderRunEntity` is a compact UI projection of `RunMeta`, not a
child-run record:

```ts
interface AgentRenderRunEntity {
  id: string;
  conversationId: string;
  title: string;
  parentRunId?: string;
  parentToolCallId?: string;
  runProfile: RunProfileId;
  runProfileLabel: string;
  status: AgentRenderRunStatus;
  objectiveStatus?: AgentObjectiveStatus;
  objectiveRole?: RunObjectiveRole;
  context: 'full' | 'brief' | 'none';
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}
```

The projection builder should receive relevant Run metadata as an input rather
than reading `state.childRuns`. That keeps conversation replay about
conversation state and makes Run projection explicitly dependent on the Run
index.

Transcript row kinds should be communication/boundary concepts only:

- `message`
- `tool_result`
- `compaction`
- `context-clear`
- `dream`

There should be no `kind: 'child-run'` row. A detached parentless Run does not
become a conversation transcript entity merely because it exists. It surfaces
through Work/Runs and notifications. If a Run needs to deliver prose into a
conversation, that prose should be a normal assistant message produced by that
Run, not a synthetic child-run boundary row.

Turn folding uses `parentToolCallId`:

- `subRunsByParentToolCallId` is derived from `entities.runs`.
- A tool-call block with a matching sub-run renders the compact Run summary and
  an "Open run" action.
- Editing the parent turn prunes the tool-call block, so the folded summary
  disappears with the turn. No separate transcript boundary can orphan.

### UI Architecture

The renderer consumes Run projections, not child-run records:

- Work/Runs is a Run tree.
- Root detached Runs are top-level rows.
- Sub-runs are nested rows.
- Verifier runs render as concise verifier rows.
- Run profile labels appear only where they clarify the work type; they do not
  become speaker names or avatars.
- Turn-spawned sub-runs fold into the spawning turn's process by
  `parentToolCallId`.
- Parentless scheduled/detached Runs render in Work/Runs and notify on terminal
  outcome. They do not create transcript boundary rows.

The UI can still say "Runs" rather than exposing "sub-run" everywhere. Use
"sub-run" in technical/debug/detail text where the parent relation matters.

Clean component boundaries:

| Current surface | Terminal surface |
|---|---|
| `AgentRunsPanel` using `AgentRunListEntry[]` | Keep the Run tree first level; rename only if needed for consistency. |
| `AgentChildRunDetailsPanel` | `AgentRunDetailsPanel`, loaded from `agent_run_detail` and `agent_run_transcript`. |
| `AgentRenderChildRunEntity` | `AgentRenderRunEntity`. |
| `childRunsByParentToolCallId` | `subRunsByParentToolCallId`. |
| `AgentTurnProcessItem.childRun` | `AgentTurnProcessItem.subRun`. |
| `api.agentChildRunTranscript` | `api.agentRunTranscript`. |
| CSS classes `agent-child-run-*` | `agent-run-detail-*` / `agent-sub-run-*` as appropriate. |
| i18n namespace `agent.childRun` | `agent.runDetail` and `agent.run`. |

The Work/Runs detail view is not a second chat. It is a read-only Run detail
page with:

- header: title, status, duration, Stop when running
- Result: latest explicit Run submission or terminal error from the Run ledger
- Sub-runs / Verification: direct sub-runs from the Run index
- Activity log: the Run ledger replayed through the same transcript components
- Technical details: Run id, parent Run, parent tool call, context, objective
  role, runProfile, scope/budget summaries

Run detail should not scrape arbitrary transcript text to guess the result. The
runtime should append a structured `run.result.submitted` event whenever a work
Run submits a candidate answer for verification or completes without
verification:

```ts
interface RunSubmissionProjection {
  runId: string;
  seq: number;
  submittedAt: number;
  summary: string;
  contentRef?: PayloadRef;
  source: 'final_assistant_message' | 'structured_output' | 'tool_result';
}
```

`RunMeta.objective.latestSubmissionSeq` points to the latest submitted result.
Run detail reads that event for the Result section; Activity log still shows the
full ledger. This makes verifier input, notifications, and UI result display use
the same durable source instead of three heuristics.

The detail page should not require the selected Run to exist in the currently
loaded conversation projection. `AgentChatPanel` should keep
`selectedRunId + selectedRunConversationId`, fetch `agent_run_detail`, and render
from that detail payload. This fixes the current dependency where Work/Runs can
select a Run from the global Run index but the detail page only renders if
`childRuns[selectedRunId]` is present in the active projection.

### Visual And Copy Rules

Use Run language consistently:

- Primary UI: "Runs", "Run details", "Open run", "Stop run", "Sub-runs 2/3",
  "Verification".
- Technical detail: "Run ID", not "Agent ID" for a Run.
- Technical/detail surfaces may show "Run profile: Research" or "Profile: Browser".
  The transcript must still show Neva as the speaker.
- Avoid "Agent run" unless distinguishing the feature area from outline rows.
- Avoid "child run" in user-visible copy.
- Verifier rows display "Verifier" and hide the internal verifier prompt unless
  Technical details is open.

Keep the existing quiet Work/Runs style: checklist markers, compact tree rows,
no heavy nested cards, and no extra transcript boundary chrome.

### Migration Strategy

This project is pre-release for agent data. Prefer a clean cut over compatibility
layers:

- Remove old readers when a format changes.
- Wipe affected dev agent data roots when needed.
- Do not ship migrations for obsolete child-run/delegation shapes.
- Do not migrate old `agentType` values into pseudo-identities. Map the active
  behavior directly to `runProfile` in the new clean shape, then delete
  `agentType`.

### Implementation Units

Suggested independently shippable PRs:

1. **Run index completeness.** Add `parentToolCallId`, `runProfile`,
   `objective.role`, `latestSubmissionSeq`, context, blocked/error metadata,
   and any missing UI-safe metadata to `RunMeta`; keep Work/Runs behavior
   unchanged.
2. **Run profile registry.** Add a built-in RunProfile registry and resolver for
   `default`, `research`, `verify`, and `dream`; map existing verifier,
   `/research`, and Dream behavior through it without changing behavior.
3. **Run submission event.** Append `run.result.submitted` when a work Run
   submits a candidate result or completes without verification. Use it for
   verifier input, notifications, and the Run detail Result section.
4. **Run detail API.** Add `agent_run_detail` and `agent_run_transcript` backed
   by Run meta + Run ledger replay; delete child-run IPC names in the same
   cleanup series instead of shipping adapters.
5. **Renderer detail migration.** Replace `AgentChildRunDetailsPanel` with
   `AgentRunDetailsPanel` loaded from the Run detail API. Work/Runs selection no
   longer reads `childRuns[selectedRunId]`.
6. **Turn-fold projection migration.** Replace
   `AgentRenderChildRunEntity` / `childRunsByParentToolCallId` with
   `AgentRenderRunEntity` / `subRunsByParentToolCallId` derived from Run
   metadata.
7. **Remove transcript child-run rows.** Delete `kind: 'child-run'`,
   `childRunIds`, `entities.childRuns`, and conversation synthetic child-run
   boundary rendering. Parentless detached/scheduled Runs surface through
   Work/Runs + notifications.
8. **Delete conversation child-run events.** Remove `child_run.started` /
   `child_run.updated`; write all lifecycle metadata to the Run index and all
   execution detail to the Run ledger.
9. **State machine hardening.** Encode valid `execution.status` and
   `objective.status` transitions in one module with tests.
10. **Runtime module split.** Extract runProfile resolution, scope/budget policy,
   and verification policy from the current delegation runtime without changing
   behavior.
11. **Tool vocabulary cleanup.** Move internal code and model guidance to
    Run-centered names; replace `spawn` with `spawn_run` over the same Run API
    with optional `spawn_run.runProfile` and required resolved
    `RunMeta.runProfile`.
12. **Legacy alias and copy cleanup.** Delete unused pre-release aliases,
    obsolete persisted values, `AgentChildRun*` types, child-run IPC names,
    child-run CSS class names, and user-visible "child run" copy.

The sequence can change, but every PR must remove a concrete duplicate concept
or make one complete seam Run-centered.

## Discussion Items

These items should be discussed before implementation starts. Each recommendation
targets the clean terminal architecture, not short-term compatibility.

### 1. Initial Model-Selectable Run Profiles

Impact:

- Exposing too many profiles early gives the model labels that do not actually
  change execution.
- Exposing too few profiles leaves useful read-only specialization hidden.
- Reference systems support specialization as overlays, but both show the danger
  of identity creep once a profile becomes "an agent".

Recommendation: make only `default` and `research` model-selectable in the first
cleanup PR. Keep `verify` and `dream` policy-created only. Keep `browser`,
`coding`, and `writing` registered as inactive slots until their tool scope,
prompt overlay, and permission policy are distinct from `default`.

Decision: include the full registry shape, but only expose `default` and
`research` to the model in the first cleanup PR. Keep `browser`, `coding`, and
`writing` inactive until each has a distinct execution policy.

### 2. Removing Transcript Boundary Rows For Detached Runs

Impact:

- Removing `kind: 'child-run'` makes the transcript cleaner and prevents orphan
  boundary rows when parent turns are edited.
- The cost is discoverability: detached Runs no longer appear inline merely
  because they exist.
- Notifications and Work/Runs must therefore become the reliable discovery
  surfaces.

Recommendation: remove transcript boundary rows. A detached Run should appear in
Work/Runs and terminal notifications. If a Run intentionally reports back into a
conversation, that report should be a normal assistant message, not a synthetic
Run boundary row.

Decision: terminal notifications should include an "Open run" affordance and a
compact derived result body when one exists. The authoritative detail remains
the Run detail view.

### 3. Verifier Evidence Pack Boundary

Impact:

- Too little evidence makes verifier failures noisy and repetitive.
- Too much evidence recreates full-context verification and weakens independence.
- Ad hoc transcript pasting makes the verifier prompt unstable and hard to test.

Recommendation: use a typed `VerificationEvidencePack` with bounded transcript,
tool, artifact, and prior-attempt slices. Include objective, criteria, latest
submission, scoped artifacts, relevant prior gaps, and capped tool evidence.
Exclude hidden reasoning, unrestricted logs, and unrelated parent conversation.

Decision: use a typed bounded evidence pack. First-pass limits should be
explicit constants in `VerificationPolicy`, with separate caps for transcript
tokens, tool-evidence tokens, and prior attempts.

### 4. Controller Versus Worker Determination

Impact:

- Inferring controller/worker from tree shape or child count will break when a
  controller has no sub-runs yet, or a worker happens to spawn helper Runs.
- Verification retry behavior depends on this distinction: controllers replan in
  place; workers are parked and replaced.

Recommendation: persist `objective.role: 'controller' | 'worker' | 'verifier'`.
Set it at Run creation through `RunController` / `VerificationPolicy`; do not
derive it from UI tree state.

Decision: persist `objective.role`. Root user-facing objective Runs default to
`controller`; leaf sub-runs created for scoped execution default to `worker`;
verifier Runs are created only by `VerificationPolicy`.

### 5. RunMeta Nested Shape

Impact:

- Keeping flat `status` / `objectiveStatus` fields is a smaller edit, but leaves
  process state and objective state easy to confuse.
- The nested shape makes impossible states more visible and gives UI labels a
  stable source.
- The project is pre-release, so compatibility does not justify keeping the old
  shape.

Recommendation: make the nested `execution` / `objective` shape the actual
persisted `RunMeta`, not just a conceptual diagram. Delete old readers and wipe
dev data when needed.

Decision: make the nested `execution` / `objective` shape the real persisted
`RunMeta` in the first Run-index PR. Do not keep a flat compatibility shape.

### 6. Verifier History Indexing

Impact:

- Persisting `verifierRunIds` on the target Run duplicates the Run graph edge and
  can drift.
- Deriving attempts from the Run index is cleaner, but requires the Run index to
  support efficient child queries by `parentRunId` and `runProfile`.

Recommendation: do not persist verifier attempt ids on the target Run. Derive
them from Run index queries and expose them through `agent_run_detail` as a
projection.

Decision: do not persist `verifierRunIds`. Add the Run-index query shape needed
to derive verifier attempts by `parentRunId` and `runProfile`; use a secondary
index if the existing metadata store cannot answer that efficiently.

### 7. Run Detail Result Extraction

Impact:

- Scraping the last assistant message is brittle: verification retries,
  controller replans, tool-only outputs, and failed Runs can all make the "last
  message" misleading.
- Verifier input, notification body, and Run detail Result need one shared source.

Recommendation: append `run.result.submitted` as a structured Run-ledger event.
Point `RunMeta.objective.latestSubmissionSeq` at the latest submission. Run
detail reads that event for Result; the activity log still replays the full
ledger.

Decision: emit `run.result.submitted` for every completed work Run that has a
model-visible result, not only Runs with criteria. Runs without a meaningful
result may complete without a submission event.

### 8. Compatibility Cut

Impact:

- Removing aliases and old readers will invalidate existing dev agent data.
- Keeping compatibility would preserve the very duplicate concepts this plan is
  trying to remove.

Recommendation: no compatibility layer. The app is not released; delete legacy
aliases/readers and wipe affected dev data roots.

Decision: no compatibility layer. Delete legacy aliases/readers, and provide a
small dev-data wipe script or command note with the breaking PR so each clone can
reset affected agent data deliberately.
