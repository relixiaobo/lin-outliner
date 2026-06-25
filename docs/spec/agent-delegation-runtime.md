# Agent Delegation Runtime (child runs)

> **Run unification (2026-06-11):** the "child run" entity is dissolved — a
> delegated (child) run is an ordinary Run with its OWN `runs/<runId>/` ledger
> (own seq space, replayed alone), kind `delegation`, joined to the parent by
> `parentRunId`/`parentToolCallId`. Transcript payload snapshots, the
> `runId:message:N` codec, the positional Dream watermark, and the
> snapshot-rewrite compaction are deleted; child compaction is event-sourced
> like a conversation's. Vocabulary below was rewritten accordingly; cc-2.1
> references describe the SOURCE system's wording, not ours.

> **Goal-run update — same-agent run tree (2026-06-25, `agent-goal`).**
> The current model-facing delegation tool is `spawn`, not `Agent`. There is
> exactly one agent, **Neva**; delegation creates same-agent child Runs, never a
> different persona. The tool schema carries no `agent_type`; `contextMode` is
> now `full` / `brief` / `none` (`fork` remains only as a persisted legacy value).
> `spawn` defaults to verified execution: criteria are required unless
> `verify:false`, parents verify child results through read-only verifier Runs,
> and failed verification triggers bounded retry before `blocked` /
> `budget_exhausted`. `/research` and isolated skills are same-agent child Runs;
> runtime Dream uses the protected Dream channel's restricted top-level run
> profile instead. Read the old "fresh" / by-name agent material below as
> historical design context, not current behavior.

This document is the design and implementation baseline for Tenon's delegation
runtime. It records both the cc-2.1 source references used for alignment and the
Lin-specific choices made while implementing the current same-conversation child run
runtime.

## Local Source References

Lin worktree used for this planning pass:

```text
/Users/lixiaobo/Documents/lin-outliner/tmp/worktrees/agent-skill
```

Reference implementation reviewed for behavior and edge cases:

```text
/Users/lixiaobo/Coding/.research-repos/cc-2.1
```

This local cc-2.1 directory is a source snapshot, not a git repository. Refresh
it before future source-alignment passes if a newer cc-2.1 snapshot is available.

The cc-2.1 references are source references only. Lin should not copy cc-2.1's
product terminology, legacy paths, or historical compatibility layers. Lin's
runtime should use `.agents/*` paths and Lin-owned event store semantics.

## Decision

Lin does not introduce Team, Swarm, or Delegate as first-class model-facing
concepts for the same-conversation child-run runtime.

The model-facing concept should be the same mature concept used by cc-2.1's core
child run path:

```text
main agent conversation
  -> spawn tool
      -> child run
          -> pi-mono Agent instance
          -> sidechain transcript
          -> status/progress/result notification
```

Child runs are conversation-scoped execution units. The main agent remains the
coordinator. Multiple child runs run in parallel when the model emits multiple
`spawn` tool calls in the same turn.

Child run is therefore Lin's isolated cognition and task execution unit. It is not
a team member, a code-editing sandbox, or a cross-conversation messaging peer.

## Reference Implementation Findings

cc-2.1 contains two layers:

- Core child run layer: mature and worth reproducing.
- Team/swarm layer: useful for cc-2.1's teammate workflow, but not part of Lin's
  initial child-run runtime.

| cc-2.1 source | Behavior to study | Lin decision |
| --- | --- | --- |
| `src/tools/AgentTool/constants.ts` | Tool name is `Agent`; legacy alias is `Task`. | Historical source reference only; Lin's current model-facing tool is `spawn`. |
| `src/tools/AgentTool/AgentTool.tsx` | Launches fresh/fork agents, async/background agents, teammate variants, worktree/remote variants, result mapping. | Reuse the core child-run path. Omit teammate, team, worktree, and remote branches. |
| `src/tools/AgentTool/prompt.ts` | Teaches when to use child runs, how to brief fresh agents, how to launch multiple agents in one turn, and how fork differs from fresh. | Reuse the guidance style and parallelism rules, with Lin terminology. |
| `src/tools/AgentTool/forkSubagent.ts` | Fork gate, implicit fork by omitting `agent_type`, cache-stable fork directive, recursive fork guard. | Reuse cache-stable context copying, but expose Lin-owned `context` modes and bounded recursive `spawn`. |
| `src/tools/AgentTool/runAgent.ts` | Builds isolated child run context, system prompt, tool pool, sidechain transcript, skill preload, cleanup, and query loop. | Reuse the execution shape with pi-mono `Agent`; defer hooks and agent-specific MCP. |
| `src/utils/forkedAgent.ts` | Creates isolated tool-use context, cloned read state, cloned content replacement state, child abort behavior, cache-safe fork helpers. | Reuse the isolation and cache-stability ideas in Lin-owned runtime context types. |
| `src/tools/AgentTool/loadAgentsDir.ts` | Loads agent definitions from markdown and JSON, including tools, model, effort, permission mode, max turns, skills, background, hooks, MCP, memory, isolation. | Implement `.agents/agents` definitions. Support the core fields now; defer hooks, MCP, memory, and isolation. |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | Registers background agent tasks, tracks status/progress, supports completion/failure/killed notifications and queued messages. | Reuse lifecycle states, but persist through Lin event store and child-run runtime state. |
| `src/tools/AgentTool/resumeAgent.ts` | Reconstructs sidechain transcript, appends a new user prompt, rebuilds replacement state, resumes in background. | Implement `run_steer` for same-conversation child run continuation. |
| `src/tools/TaskOutputTool/TaskOutputTool.tsx` | Reads background task output and can block until completion; deprecated in favor of reading output file path. | Do not add a TaskOutput clone. Prefer completion notifications plus output references readable with `file_read`; keep `run_status` only for explicit status/wait checks. |
| `src/tools/TaskStopTool/TaskStopTool.ts` | Stops a running background task by id. | Implement `run_stop` for child run ids/names. |
| `src/tools/TeamCreateTool/*` | Creates team config, team task list, leader state, teammate workflow. | Do not copy for initial child runs. |
| `src/tools/SendMessageTool/*` | Mixes teammate mailbox, background-agent resume, broadcast, shutdown/plan protocol, and cross-session routes. | Do not copy as one tool. Use `run_steer` only for same-conversation child run continuation. Future global messaging gets separate tools. |

### Source-Level Design Anchors

The decisions in this document are based on the current cc-2.1 source snapshot
at `/Users/lixiaobo/Coding/.research-repos/cc-2.1`, not on prior memory of the
design.
Key anchors:

- `src/tools/AgentTool/AgentTool.tsx:81-88`: the source `Agent` input schema is
  `description`, `prompt`, `agent_type`, `model`, and `run_in_background`.
  Lin's current `spawn` schema keeps the useful task/background shape but
  replaces it with `objective`, `criteria`, `verify`, `context`, `scope`, and
  `budget`.
- `src/tools/AgentTool/AgentTool.tsx:90-101`: `name`, `team_name`, `mode`,
  `isolation`, and `cwd` are added on top of the core schema for teammate,
  team, and isolation behavior. Lin keeps only `name` as a same-conversation alias
  and omits the rest in the first version.
- `src/tools/AgentTool/AgentTool.tsx:318-335`: source fresh/fork routing is
  controlled by `agent_type`. Lin removed model-facing agent selection and uses
  the explicit `context` field for inherited-context behavior.
- `src/tools/AgentTool/AgentTool.tsx:483-540`: fork children inherit the parent
  system prompt and use `buildForkedMessages`; fresh agents build their own agent
  system prompt and receive a single user prompt. Lin mirrors this split.
- `src/tools/AgentTool/AgentTool.tsx:603-633`: fork passes the parent's exact
  tools, parent messages, and `useExactTools` for cache-stable API prefixes.
  Lin's fork path must preserve the same cache-sensitive shape where pi-mono
  exposes the needed state.
- `src/tools/AgentTool/AgentTool.tsx:686-765`: async/background child runs are
  registered with an id, run detached, and return `async_launched` metadata.
  Lin's background lifecycle follows this state machine, but not the cc UI/output
  file details.
- `src/tools/AgentTool/AgentTool.tsx:1327-1373`: cc maps async and completed
  results differently, with continuation hints for resumable agents. Lin keeps
  the result distinction but routes continuation through `run_steer`.
- `src/tools/AgentTool/runAgent.ts:368-379`: fork context messages are merged
  into initial messages and read-file state is cloned. Lin must preserve this
  separation between inherited context and child-local mutable state.
- `src/tools/AgentTool/runAgent.ts:412-498`: agent permission mode, prompt
  avoidance for async agents, allowed tools, and effort are derived per child run.
  Lin implements a smaller policy, but the runtime must still resolve these per
  child run rather than relying on the parent agent's live state.
- `src/tools/AgentTool/runAgent.ts:500-529`: `useExactTools` bypasses normal tool
  resolution and async agents get an unlinked abort controller. Lin should keep
  the same distinction between cache-sensitive fork tools and normal fresh-agent
  tool profiles.
- `src/tools/AgentTool/runAgent.ts:577-645`: skills from agent frontmatter are
  preloaded into the child run's initial messages. Lin keeps `skills` as a first
  version agent-definition field.
- `src/tools/AgentTool/runAgent.ts:666-714`: child run options disable thinking
  for regular child runs, inherit thinking for `useExactTools` fork children, and
  create an isolated child run tool-use context. Lin maps this to pi-mono
  `Agent` state, `transformContext`, and tool profiles.
- `src/tools/AgentTool/runAgent.ts:732-805`: initial and subsequent child run
  messages are recorded into a sidechain transcript. Lin's parent conversation must
  not inline child tool noise.
- `src/tools/AgentTool/runAgent.ts:816-859`: cleanup tears down agent-specific
  resources, clears cloned state, and kills child-owned background shell tasks.
  Lin needs equivalent cleanup for pi-mono runs and Lin-owned tool processes.
- `src/utils/forkedAgent.ts:306-461`: `createSubagentContext` clones mutable
  context, stubs mutation callbacks, preserves root task writes, isolates denial
  tracking, clones tool-output replacement state, and creates a new query chain.
  This is the main source for Lin's child run context isolation design.
- `src/tools/AgentTool/resumeAgent.ts:63-79`: resume loads sidechain transcript
  and reconstructs tool-output replacement state. `run_steer` must do the same.
- `src/tools/AgentTool/resumeAgent.ts:99-195`: resume restores fork vs fresh
  agent type, parent system prompt for resumed forks, exact tools for resumed
  forks, and appends the new user message. Lin's `run_steer` follows this.
- `src/tools/AgentTool/loadAgentsDir.ts:73-99` and `541-747`: agent definition
  parsing supports `description`, `tools`, `disallowedTools`, `model`, `effort`,
  `permissionMode`, `maxTurns`, `skills`, `background`, plus deferred fields.
  Lin's frontmatter list is intentionally copied from this split.
- `src/tools/AgentTool/prompt.ts:80-113` and `255-272`: model guidance teaches
  when to fork, how to brief fresh agents, background behavior, continuation, and
  parallel multi-agent calls. Lin should reproduce this guidance in Lin terms.
- `src/utils/attachments.ts:1477-1556`: agent listings were moved out of the tool
  schema into `agent_listing_delta` attachments for prompt-cache stability. Lin
  should inject agent listings as turn state/reminders rather than mutating the
  `spawn` tool schema.

## External Open-Source Research

These projects are secondary references. cc-2.1 remains the behavioral source of
truth for Lin's first child-run runtime. The external research is useful for
validating guardrails, naming boundaries, concurrency behavior, and the features
that should stay out of the first version.

### Projects Reviewed

[pi-subagent](https://github.com/mjakl/pi-subagent)

Problem definition: add specialized child runs to Pi with explicit context
control.

Observed approach: registers a `child run` tool, discovers markdown agent
definitions, supports `spawn` and `fork`, can run a single task or a bounded
parallel batch, launches isolated `pi` child processes, propagates depth and
ancestry through environment variables, prevents cycles, and returns only the
final child run summary to the parent. Source files reviewed: `index.ts`,
`runner.ts`, `agents.ts`, `types.ts`, `runner-events.js`, and `render.ts`.

Lin decision: this is the highest-value external source because it is Pi-based.
Borrow spawn/fork semantics, depth and cycle guard, bounded concurrency,
project-agent trust checks, final-result-only parent content, and expandable
execution details. Prefer pi-mono in-process `Agent` instances over shelling out
to `pi` when Lin can preserve the same isolation contract. Under one-Neva, keep
the in-process run-tree shape and model-facing `spawn` tool, but do not load
project agent definitions.

[ECA](https://eca.dev/)

Problem definition: let a primary chat use focused child runs without polluting
the primary context.

Observed approach: defines `primary` and `child run` modes, exposes child runs
through a `spawn_agent` tool, creates a child chat tied to the parent tool call,
streams progress through tool metadata, stores the child transcript separately,
replays child messages in the UI, resolves model overrides from request, agent
default, then parent model, and stops the child if the parent stops. Source
files reviewed: `docs/config/agents.md`, `docs/config.json`,
`src/eca/features/tools/agent.clj`, `src/eca/features/chat.clj`,
`src/eca/features/chat/tool_calls.clj`, and
`src/eca/features/skills/builtin.clj`.

Lin decision: borrow sidechain-as-chat, deterministic child-run ids, progress
metadata, max-step guard, model resolution order, parent stop propagation, and
UI replay without parent prompt pollution. Do not copy the no-nesting rule; Lin
should use cc-2.1-style bounded nesting and cycle prevention instead.

[open-multi-agent](https://github.com/open-multi-agent/open-multi-agent)

Problem definition: turn a user goal into a multi-agent task graph and execute
independent tasks concurrently.

Observed approach: provides `runAgent`, `runTeam`, `runTasks`, and an
`AgentPool`; a coordinator decomposes a goal into a task DAG, assigns tasks,
runs independent work in parallel batches, writes successful results into shared
memory, and synthesizes a final answer. It also has a team-scoped
`delegate_to_agent` tool with cycle, depth, pool, and deadlock guards. Source
files reviewed: `src/orchestrator/orchestrator.ts`,
`src/tool/built-in/delegate.ts`, `src/agent/pool.ts`, `src/agent/runner.ts`, and
`src/tool/executor.ts`.

Lin decision: useful as a warning boundary. Team/DAG/coordinator/shared-memory
orchestration is a higher-level workflow system, not Lin's first child run
runtime. Borrow pool limits, cycle/depth/deadlock guards, and tool-output
slimming ideas. Do not introduce first-class Team, Delegate, DAG, or shared
memory for the first version.

[Agency Swarm](https://github.com/VRSEN/agency-swarm)

Problem definition: model multi-agent applications as role-based agencies with
explicit communication paths.

Observed approach: agents register child runs or communication flows, then use a
generated `send_message` tool whose recipient enum is scoped to allowed
recipients. Calls are synchronous, recipient-specific, guarded against
simultaneous messages to the same recipient, and can stream child events. Source
files reviewed: `src/agency_swarm/agency/core.py`,
`src/agency_swarm/agent/child runs.py`,
`src/agency_swarm/tools/send_message.py`, and `src/agency_swarm/context.py`.

Lin decision: good evidence that generic agent messaging needs explicit scope.
Lin should not expose general cross-agent messaging in the first version.
`run_steer` should be a same-conversation continuation tool for an existing
background child run, not a global routing primitive.

[OpenHands Agent Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation)

Problem definition: allow one coding agent to delegate a task to another agent
with a different tool or environment configuration.

Observed approach: uses SDK-level delegation between agents and emphasizes
specialized execution environments.

Lin decision: useful for later coding-heavy scenarios, but Lin's first version
should not include worktree or remote isolation.

[LangChain DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview)

Problem definition: package primitives needed for long-running deep tasks,
including planning, child runs, a filesystem-like workspace, and detailed
prompts.

Observed approach: treats child runs as one primitive inside a broader deep-task
framework.

Lin decision: confirms that child runs should stay a runtime capability and not
become a Team concept by default. Lin can borrow planning guidance later, but
the first version should avoid a filesystem/workflow framework.

[CrewAI](https://github.com/crewAIInc/crewAI),
[AutoGen](https://github.com/microsoft/autogen),
[CAMEL](https://github.com/camel-ai/camel),
[MetaGPT](https://github.com/FoundationAgents/MetaGPT),
[Agno](https://github.com/agno-agi/agno), and
[Mastra](https://github.com/mastra-ai/mastra)

Problem definition: build general multi-agent applications, often with crews,
teams, roles, workflows, graphs, memory, and application-level orchestration.

Observed approach: these projects solve broader application orchestration
problems than a single Lin conversation needs.

Lin decision: keep them as future research. Do not pull
crew/team/workflow/memory concepts into the first child run implementation.

### External Research Conclusions

- Keep one primary model-facing tool: `spawn`. Avoid separate Team, Delegate,
  or general Send Message tools in the first version. Multiple child runs are
  launched by multiple `spawn` tool calls in the same turn, matching cc-2.1's
  model guidance and avoiding a second orchestration abstraction.
- `spawn` must support explicit context modes. External Pi and ECA
  implementations validate the underlying split between clean child contexts
  and inherited-context child work; Lin exposes that as `context:'none'`,
  `context:'brief'`, and `context:'full'` instead of model-facing agent types.
- Parent context should receive only a compact child result plus a durable run
  id. Full child turns, tool calls, progress, and errors belong in sidechain
  transcript/event storage and UI replay.
- Runtime must include max depth, per-conversation concurrency caps, and stop
  propagation. These are not optional polish; every mature implementation needs
  them to avoid runaway recursive delegation and deadlocked child work.
- Agent listing should remain prompt-cache friendly. cc-2.1 moved dynamic agent
  lists out of the tool schema; Lin should use the same shape as skills:
  stable tool schema plus listing state/reminders.
- Project-local self-definition remains skills-only under the one-Neva model; do
  not silently load untrusted local agent definitions from arbitrary directories.
- `run_steer` is intentionally narrow: continue or message an existing
  same-conversation background child run without changing objective or criteria.
  Cross-conversation and global agent messaging are future product features and
  should use a separate design.
- Team/DAG/coordinator/shared-memory systems are valid future workflows, but
  they solve a different problem. Adding them now would blur the boundary
  between "run an isolated helper agent" and "build a workflow engine".

## Current Concepts

### Agent Definition

There is one loaded execution profile: the built-in Neva assistant definition.
The delegation runtime still uses the `AgentDefinition` shape internally because
the pi-mono harness expects tools, model, effort, permission mode, max turns,
and background defaults in that form. The registry does not scan
`~/.agents/agents`, project agent directories, or additional agent directories.
Specialization happens through the single editable Neva overlay and skills, not
by dispatching to another model-facing agent.

### Running child run

The in-memory run record (delegation runtime) embeds the durable
`DelegationDetail` plus live-only state. The transcript is NOT part of the
durable conversation record — it is the run's own ledger, replayed on demand;
`messages` is the live continuation context, loaded lazily on resume:

```ts
type AgentRunRecord = {
  id: string;                       // also the run ledger id (runs/<id>/)
  name?: string;
  description: string;
  prompt: string;
  objective?: string;
  criteria?: string[];
  objectiveStatus?: 'active' | 'verifying' | 'verified' | 'blocked' | 'budget_exhausted' | 'stopped';
  purpose?: 'work' | 'verify';
  scope?: AgentRunScope;
  budget?: AgentRunBudget;
  agentType: string;
  contextMode: 'full' | 'brief' | 'none' | 'fork';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  executingAgentId: string;
  parentAgentId: string;
  parentRunId?: string;             // the delegating run (run tree)
  parentToolCallId?: string;
  memoryOwnerAgentId: string;
  memoryOriginWorkspace?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  blockedReason?: string;
  messages: AgentMessage[];         // live context; empty until resume restores it
};
```

### Context Modes

Every child run uses the current Neva system prompt. The `context` field controls
only the parent transcript seed:

- `full`: clone parent messages, close unresolved parent tool calls with
  placeholder results, then append the run directive.
- `brief`: pass a compact hidden excerpt of recent parent messages, then append
  the run directive.
- `none`: append only the run directive. Verifier Runs always use this mode.

The Dream-evidence boundary remains structural: the ledger seeds
`[context messages…, run.started, directive…]` and evidence is everything past
the first `run.started`. Dream must not rediscover the boundary by scanning
transcript text or counting positions, because compaction and slimming can
rewrite both.

### Recursive Child Runs

Child Runs may call `spawn` when their narrowed tool catalog includes the
delegation capability. Recursion is controlled by a configured depth limit and a
per-conversation concurrency cap, not by a hard fork-cycle ban. A child that
needs more authority than its current scope should block or be stopped and
re-spawned with a wider still-parent-bounded scope; `run_amend` never widens
scope in place.

### Sidechain Transcript

Every child run writes a separate transcript. The parent conversation stores only:

- the `spawn` tool call;
- launch metadata;
- status/progress notifications;
- final result summary;
- stable handle for status, steer, amend, and stop.

This is required so child runs reduce parent-context pressure rather than moving
tool noise into the main conversation.

The sidechain transcript is still durable for run inspection and debug replay,
but it is no longer a separate Dream evidence stream. Runtime Dream reads member
conversation event streams; child-run work enters memory only through the
visible parent-conversation boundary, result, or summary content that survives in
that conversation stream.

## Model-Facing Tools

### `spawn`

Launches one child Run. The Run is always a same-agent child run; there is no
model-facing agent selection. Parent context is controlled by the `context`
field, and verification is on by default.

Input:

```json
{
  "objective": "string",
  "criteria": ["optional string"],
  "verify": "optional boolean",
  "scope": {
    "capabilities": ["optional tool name"],
    "resources": {
      "docs": ["optional string"],
      "paths": ["optional string"]
    }
  },
  "budget": {
    "tokens": "optional number",
    "wallClockMinutes": "optional number"
  },
  "context": "optional full|brief|none",
  "detach": "optional boolean",
  "description": "optional string",
  "prompt": "optional legacy string",
  "model": "optional string",
  "run_in_background": "optional legacy boolean",
  "name": "optional string"
}
```

Field behavior:

- `objective`: the work the child Run must pursue.
- `criteria`: acceptance criteria the parent verifies. Required unless
  `verify: false`.
- `verify`: defaults to `true`; explicit `false` is the only unverified path.
- `scope`: optional narrowed capability/resource scope. It can only reduce the
  child catalog.
- `budget`: optional run-local budget metadata. `wallClockMinutes` is enforced
  as a hard runtime backstop.
- `context`: `full` copies the parent context, `brief` provides a compact parent
  excerpt, and `none` starts clean. Verifier Runs are always `none`.
- `detach`: if true, return immediately and notify the parent conversation when
  done.
- `description`: optional short task panel summary.
- `prompt`: legacy alias for `objective`; new callers should use `objective`.
- `model`: optional per-call model override. Resolution order is request override
  → the running agent's owned model (user/project `AgentDefinition.model`, or the
  built-in assistant's settings overlay) → catalog first-ranked fallback. Provider
  rows are connection-only and never carry a model; see the resolution chain in
  `agent-pi-mono-implementation.md`.
- `run_in_background`: legacy alias for `detach`.
- `name`: optional conversation-local alias for later `run_steer`,
  `run_status`, and `run_stop`.

Not included:

- `team_name`
- `mode` for teammate plan mode
- `isolation`
- `cwd`
- per-call `effort`

`effort` is supported in agent definitions, matching cc-2.1's source shape.

Output:

Foreground completion:

```json
{
  "status": "completed",
  "agent_id": "string",
  "name": "optional string",
  "description": "string",
  "prompt": "string",
  "objective": "string",
  "criteria": ["string"],
  "objective_status": "verified",
  "purpose": "work",
  "scope": {},
  "budget": {},
  "agent_type": "string",
  "context_mode": "full|brief|none|fork",
  "result": "string",
  "started_at": 0,
  "updated_at": 0,
  "completed_at": 0,
  "transcript_message_count": 0
}
```

Background launch:

```json
{
  "status": "async_launched",
  "agent_id": "string",
  "name": "optional string",
  "description": "string",
  "prompt": "string",
  "objective": "string",
  "objective_status": "active",
  "agent_type": "string",
  "context_mode": "full|brief|none|fork",
  "started_at": 0,
  "updated_at": 0,
  "transcript_message_count": 0,
  "instructions": "string"
}
```

When a background run reaches `completed`, `failed`, or `cancelled`, Lin appends
a hidden `<agent-task-notification>` message to the parent conversation and
starts a parent continuation when the parent agent is idle. The parent agent
should not poll `run_status` for ordinary result retrieval.

### `run_status`

Reads or waits for same-conversation child run state. It is a status/wait tool, not the
normal result retrieval path.

Input:

```json
{
  "runId": "optional string",
  "agent_id": "optional legacy string",
  "name": "optional string",
  "wait": "optional boolean",
  "timeout_ms": "optional number"
}
```

Behavior:

- Requires `runId`, legacy `agent_id`, or `name` and returns status metadata for
  that child run.
- `wait: true` waits until the selected child run leaves `running` or timeout.
- Completed output should be read from the notification/output reference with
  `file_read` unless a concise result is already included in the status metadata.

### `run_steer`

Soft-steers a same-conversation child run by appending a new user instruction to
its sidechain transcript and resuming it in the background. It does not change
the objective, criteria, or verifier state.

Input:

```json
{
  "runId": "optional string",
  "agent_id": "optional legacy string",
  "name": "optional string",
  "message": "string"
}
```

Behavior:

- Resolves by `runId` first, then legacy `agent_id`, then `name`.
- Reconstructs sidechain transcript.
- Reconstructs tool-output replacement state for cache-stable replay.
- Appends the message.
- Runs the child run in background.
- Returns launch/status metadata.

This replaces the subset of cc-2.1 `SendMessage` that resumes background agents.
It does not support teammate mailboxes, broadcast, structured shutdown messages,
or cross-conversation routes.

### `run_amend`

Hard-amends a same-conversation child run's objective, criteria, or budget.

Input:

```json
{
  "runId": "optional string",
  "agent_id": "optional legacy string",
  "changes": {
    "objective": "optional string",
    "criteria": ["optional string"],
    "budget": "optional budget object"
  }
}
```

Behavior:

- Requires `runId` or legacy `agent_id`.
- Updates only objective, criteria, and budget. Scope is not widened in place.
- Resets `objectiveStatus` to `active` and clears any blocked reason; prior
  verifier conclusions are invalidated.

### `run_stop`

Stops a running same-conversation child run.

Input:

```json
{
  "runId": "optional string",
  "agent_id": "optional legacy string",
  "name": "optional string"
}
```

Behavior:

- Resolves by `runId` first, then legacy `agent_id`, then `name`.
- Aborts the running pi-mono `Agent`.
- Persists stopped state.
- Preserves partial result if available.
- Emits a parent-conversation notification.

## Runtime Architecture

### `AgentDelegationRuntime`

Owns conversation-scoped child-run state:

- active runs;
- id/name registry;
- background lifecycle;
- sidechain transcript ids;
- progress snapshots;
- completion notifications;
- resume and stop commands.

It should create and manage pi-mono `Agent` instances. It should not duplicate
pi-mono's model loop.

### `AgentRunRecord`

Owns one concrete pi-mono `Agent` instance:

- system prompt;
- initial messages;
- transform context;
- tool profile;
- permission profile;
- compact state;
- abort controller;
- event subscription;
- cleanup.

Each child run gets independent runtime state unless a field is intentionally
shared for metrics or parent notification.

### `AgentDefinitionRegistry`

Loads built-in, user, workspace, settings, and future plugin agent definitions.
The built-in Tenon assistant is a real definition with stable id
`built-in:tenon:assistant`, internal name `assistant`, display name
`Neva`, and a view-only profile body sourced from the main Tenon
system prompt. It is visible in Agent Profiles / Agent Config but is never a
write target.

Layering should follow this order:

```text
built-in
plugin/future managed definitions
user definitions
workspace definitions
settings additional directories
```

Later layers with the same `name` override earlier layers.

#### Authoring & hot-reload

The one-Neva invariant collapses authoring to a single surface: **editing the one
built-in agent, Neva, in Settings**. There is no create, duplicate, delete, or
chat-authoring path, and no `.agents/agents` file-write surface — all of those
were removed (`single-agent-finish-collapse`). Neva's edits persist to an
**editable built-in overlay** stored in settings (not an `AGENT.md` file); the
base built-in definition stays immutable and the overlay is layered on top at
load (`getBuiltInAgentProfile` / `applyBuiltInAgentProfile`).

The settings "Agent Profiles" pane lists Neva and opens the dedicated
`AgentConfigWindow`:

- **Format layer** (`src/core/agentMarkdown.ts`, pure — `yaml` only, no fs):
  `serializeAgentMarkdown(AgentAuthoringInput) → AGENT.md` text and its inverses
  `parseAgentMarkdownDocument` / `parseAgentAuthoringInput`. Shared by **both**
  main (the overlay write below) and the renderer (the Form⇄Raw editor toggle), so
  the AGENT.md format lives in exactly one place and the two sides cannot drift.
- **Editor UI** (`AgentEditor.tsx`): one editor for the one agent, with two
  switchable modes behind a header `SegmentedControl`. **Form** = structured
  controls (name / description / model / effort) plus on/off **toggle lists** for
  tools and skills — all-on or all-off ⇒ Neva inherits every tool (the `tools`
  field is omitted), a proper subset is stored, and any tool/skill outside the
  curated catalog is preserved so Form editing never drops it; other fields
  (permission-mode, max-turns, background) round-trip losslessly through Raw.
  **Raw** = the full `AGENT.md` text. The toggle converts losslessly through the
  format layer (`serializeAgentMarkdown` Form→Raw, `parseAgentAuthoringInput`
  Raw→Form). Default mode is Form; the only actions are Cancel and Save.
- **Write surface** (built-in overlay): `agent_update_agent_definition` validates
  the `AgentAuthoringInput` and persists it as Neva's editable overlay; the base
  built-in is never overwritten. `AgentRuntime` then re-composes Neva's identity
  (display name, persona, model/effort, tool/skill set) from the refreshed overlay.
- **Hot-reload**: `AgentDefinitionRegistry.reload()` drops the cached seed
  (`loaded` / `agents`) so the next read re-seeds Neva with the current overlay.
  After an edit `AgentRuntime` reloads **every live conversation's** registry, so
  the change takes effect without an app restart. A run resolves its
  `AgentDefinition` at spawn, so reload only affects future spawns — live runs are
  unaffected.
- **IPC** (`AGENT_COMMANDS`): `agent_update_agent_definition` (addresses Neva by
  `agentId` and writes her overlay) and `agent_reload_agent_definitions`. Each
  returns the freshly reloaded `AgentDefinitionView[]` (an `AgentDefinition` plus
  its `agentId`). There are no create / delete / duplicate commands — a second
  agent is structurally impossible.

#### Disabling by identity

`disabledAgents` stores the full **`agentId`** (`${source}:${namespace}:${name}`,
`agentDelegationIdentity.ts`), not the bare `name`, so disabling one source's agent
no longer disables a same-named agent from another source. The spawn gate and the
listing filter both check `agentDefinitionAgentId(definition)`. (Pre-release: the
stored shape switched directly with no migration — see
`storage-format-no-backcompat-prerelease`.)

### `AgentSkillRuntime`

Skill `execution: isolated` calls `AgentDelegationRuntime` instead of creating
pi-mono agents directly.

The skill path should:

- load and render skill content;
- run the rendered content as a sidechain same-agent child run prompt;
- pass `allowed-tools` as child-run preapproval metadata;
- return only the final result/summary to the parent conversation.

Built-in skills may carry runtime-only fork policy that is not mutable
`SKILL.md` frontmatter. The first such policy is `/research`: it has no `agent`
override and asks for a read-only isolated run of the current agent. At spawn time,
`AgentDelegationRuntime` filters the skill's declared `allowed-tools` through the
read-only catalog derived from `AgentToolActionKind`, then reuses the same
`tools` / `disallowedTools` filtering path as ordinary agent definitions. The
child request therefore lacks mutating tools (`file_write`, `file_edit`, node
mutations, `skill`, `spawn`, `run_steer`, `run_amend`, `run_stop`, shell
execution), instead of relying on prompt text or permission denial after the
model has seen them.
The same `allowed-tools` list remains run-scoped preapproval for the expected
read calls.

This mirrors the cc-2.1 isolated skill execution path while using Lin's cleaner
public skill DSL: the skill body is child-only execution context, not parent-visible steering
content. Legacy `context: fork` skill frontmatter is parsed as
`execution: isolated`.

## Event Store

The child-run runtime persists through Lin's event store. This follows cc-2.1's
sidechain transcript design in `src/tools/AgentTool/runAgent.ts:732-805`, but
uses Lin-owned parent-conversation events and payload refs rather than a separate
task output file.

Implemented parent-conversation events:

- `child_run.started`
- `child_run.updated`

`child_run.started` (the conversation marker) records stable run metadata: id,
optional same-conversation name, description, prompt, objective, criteria,
objective status, purpose, scope, budget, agent type, context mode, execution
identity, parent agent identity, parent run id, memory owner identity, memory
origin workspace, and parent tool call id.

`child_run.updated` (the conversation marker) records status transitions:
`running`, `completed`, `failed`, or `cancelled`, plus objective status, budget,
blocked reason, final result, and error. The transcript itself never moves
through conversation events — it lives in the run's own ledger.

Replay must not let a late `running` transcript update downgrade an already
terminal run. This mirrors the concurrency shape in cc-2.1, where transcript
messages and terminal task state can be written through different paths.

Do not introduce team event types in the first version.

Current storage shape:

```text
agent/
  conversations/
    <conversation-id>/
      segments/000001.jsonl
      payloads/
  runs/
    <run-id>/
      events.jsonl
      payloads/
```

The parent conversation plus its run logs remain the product source of truth for
user-visible conversation state. The sidechain transcript IS the run's own
ledger (`runs/<run-id>/events.jsonl`, its own seq space, replayed alone); the
conversation stream keeps only the slim `child_run.started/updated` markers.
This keeps the parent model context clean while still allowing status, restore,
debug, and continuation. Spawn ordering is ledger-seed first, conversation
marker second: a crash inside the spawn window leaves an invisible orphan ledger
directory, never an un-resumable phantom run in the conversation.

Dream raw sources address conversation streams through `past_chats` source
objects such as
`{stream: 'conversation', streamId: <conversationId>, range: {fromSeqExclusive, throughSeq, throughEventId}}`.
Runtime Dream writes durable memory as ordinary `#d-*` outline nodes with
`[[chat:...]]` inline citations back to the source stream range. Evidence
expansion replays the visible transcript, so provenance stays stable across
later compactions. The Dream cursor is derived from clean completed
`dream.finished.window.end` markers in the protected Dream channel; there is no
principal memory episode projection to read. The parent model only receives the
`spawn` tool result projection.

## Compaction And Resume

Parent compaction should preserve:

- active child run ids/names;
- descriptions;
- statuses;
- latest summaries/progress;
- final result summaries for completed background runs that have not yet been
  acknowledged;
- enough metadata for `run_status`, `run_steer`, `run_amend`, and `run_stop`.

Parent compaction should not inline full sidechain transcripts.

Child run compaction should use the same model-context manager concepts as the
main agent:

- tool-output slimming;
- automatic sidechain summary before a child model call crosses the context
  threshold;
- reactive sidechain summary and retry after a child context-length error;
- invoked skill restore if the child run loaded skills.
- recent full-file context restore when available in the child workspace.

App restart restores **records only** — no ledger IO on the conversation-open
path. A run's transcript is replayed from its own ledger lazily:

- on first resume (`run_steer` to a non-live run): the host restores the ledger
  writer and re-derives the continuation context. If the ledger is MISSING (a
  crash between the spawn's ledger seed and nothing else — the seed lands before
  the conversation marker, so this is a residual edge), the writer is registered
  empty and the resume's `run.started` becomes the ledger's first event; the run
  stays resumable instead of wedging.
- on drill-in (`agent_child_run_transcript`): the ledger is replayed directly,
  cached on its tail seq (one run-meta read decides freshness). The open panel
  polls this while the run is live and refetches on entity changes.

If a child run was persisted as `running` but there is no live pi-mono `Agent`
after restore, Lin marks it as failed with an interruption message — in BOTH
representations: the conversation gets `child_run.updated{failed}` and the run's
own ledger gets a mirrored `run.failed` (without it the run stream would
self-describe as running forever). It can still be continued through `run_steer`.

A delegated-run ledger uses the tolerant sidecar torn-tail policy, not the
conversation log's strict one: a half-written FINAL line (crash artifact of an
interrupted append) is dropped on read and truncated by the next append's
repair; mid-file corruption still fails loudly. Restore-time reconciliation is
contained per run — a corrupt child ledger degrades to a warning and can never
brick its parent conversation.

## Permission Layer

Child runs should be trusted enough to be useful, but scoped by tool profile.

Rules:

- `spawn` is allowed by default when the current run has
  `agent.delegate.spawn`.
- Every child run tool call still goes through Lin's permission layer.
- Agent definition `tools` and `disallowed-tools` narrow the available tool set.
- Agent definition `permission-mode` may relax or tighten behavior within Lin's
  global safety policy.
- Background child runs should avoid UI permission prompts; deny or bubble only
  when a policy requires it.
- Catastrophic commands and workspace-boundary violations remain hard denied.

Do not copy cc-2.1's full historical permission mode matrix. Implement the
smallest Lin-owned policy that supports useful child runs with clear boundaries.

## Tool Profiles

The main agent can see:

- normal Lin tools;
- `spawn`;
- `run_status` for explicit status/wait checks;
- `run_steer`;
- `run_amend`;
- `run_stop`.

Child Runs can see:

- tools allowed by the current definition/scope intersection;
- skill tool if enabled for the definition;
- `spawn` only when the child's narrowed scope includes the delegation
  capability.

Full-context child Runs can see:

- the parent's context plus placeholder results for unresolved tool calls;
- recursive `spawn` calls until the configured depth limit.

Background child runs can see only tools that can run without direct UI control.
This should be implemented as a profile over Lin tools rather than a separate
tool system.

## Agent-Facing Prompt Guidance

The delegation prompt should teach:

- Use `spawn` for complex, multi-step, or independent work.
- Launch multiple child runs in one turn when the tasks are independent.
- Provide `criteria` unless the caller explicitly sets `verify:false`.
- Choose `context` deliberately: `full` for cache-stable inherited context,
  `brief` for summarized parent context, `none` for clean verification or
  independent checks.
- Verify child results before accepting them as done; runtime verifier Runs use
  `context:'none'` and read-only tools.
- Do not read or poll background transcripts unless asked; completion
  notifications will arrive.
- Do not fabricate background results before notifications arrive.
- Use `run_steer` only to continue an existing same-conversation child run
  without changing its goal.
- Use `run_amend` only to change objective, criteria, or budget.
- Use `run_status` only for status or waiting; read completion output from the
  notification/output reference with `file_read`.
- Use `run_stop` to stop a running child run.

## Explicit Non-Goals For The First Version

Do not implement:

- Team or Swarm as model-facing concepts.
- `TeamCreate`, `TeamDelete`, `team_name`, teammate `name`, or team task lists.
- teammate mailbox, broadcast, or structured shutdown/approval protocols.
- `SendMessage` as a mixed routing tool.
- cross-conversation or global agent messaging.
- worktree isolation.
- remote isolation.
- agent-specific MCP servers.
- hooks lifecycle.
- memory/conversation-memory.
- team-level task board.
- continuous teammate loops.

Future global or cross-conversation agent messaging should be a separate
communication plane with separate tools. It must not be mixed into same-conversation
`run_steer`.

## Implementation Status

### Agent Definitions

Implemented in `src/main/agentDelegation.ts`.

- Loads `~/.agents/agents`, `<workspace>/.agents/agents`, and configured
  additional agent directories.
- Supports directory agents with `AGENT.md`.
- Does not ship a built-in generic worker profile; generic isolation is the
  same-agent child-run path.
- Injects agent listing as turn state/reminders, not inside the `spawn` tool
  schema.

### Foreground Child Run

Implemented.

- `spawn` creates a sidechain pi-mono `Agent`.
- The child receives the current agent system prompt plus a runtime directive
  containing objective, criteria, context mode, scope, and budget.
- Child runs are forks of Neva under the single-agent model. There is no
  owner-scoped `<memory>` briefing and no `recall` tool; memory retrieval remains
  pull-only through the child's allowed `node_search` / `node_read` tools, and
  raw prior chat lookup requires `past_chats`.
- Explicit agent-definition `tools` remain an allow-list. A child receives only
  the tools allowed by its definition or skill-isolated execution wrapper.
- The parent receives only the final result or error.
- The sidechain transcript is the run's own ledger (`runs/<run-id>/`); there
  are no transcript snapshot payloads.

### Fork Agent

Implemented.

- `spawn` with `context:'full'` forks from the current parent context.
- The fork uses the parent system prompt, parent messages, a run directive, and
  placeholder results for unresolved tool calls.
- `context:'brief'` passes a compact hidden parent excerpt, and `context:'none'`
  passes no parent transcript.
- Fork runs keep the parent `executingAgentId` and `memoryOwnerAgentId`; their
  ledgers are not crawled directly by Dream.
- A runtime-owned read-only isolated restriction can further narrow a child run
  catalog. `/research` uses this to keep generic investigation inside the
  current agent's DM/Channel identity while removing mutation and delegation
  tools from the child model request.
- Recursive `spawn` attempts are allowed until the configured nesting limit.
- Child tool output stays in the sidechain transcript and does not pollute the
  parent context.

### Parent Verification

Implemented.

- `spawn` defaults to verified execution and requires `criteria` unless
  `verify:false`.
- When a child work Run completes, its parent marks it `verifying`, spawns a
  read-only verifier Run with `purpose:'verify'` and `context:'none'`, then
  accepts `verified` results or retries the same worker with the verifier gap.
- The verifier receives a runtime-assembled bounded evidence pack: the worker
  result, node changes, file changes from `file_edit` / `file_write` /
  `file_delete`, and a compact tool trace. The pack deliberately excludes full
  file contents and large raw tool outputs.
- The retry guard is bounded (`DEFAULT_VERIFIER_RETRY_LIMIT`) and repeated
  same-gap verifier failures trip the livelock guard; repeated failure leaves the
  worker `blocked` or `budget_exhausted`.
- Verifier Runs are persisted as child Runs, but they are unverified themselves
  and do not receive delegation/write tools.
- Current retry semantics resume the same child run with the verifier gap. The
  stronger plan shape, where a failed worker is replaced by a fresh `runId` while
  a persistent controller run keeps the stable identity, remains an explicit
  follow-up before the design can claim full controller/worker separation.

### Background Lifecycle

Implemented for same-conversation background runs.

- `detach` (or legacy `run_in_background`) returns `async_launched` metadata
  immediately.
- `run_status` reads or waits for a selected run.
- `run_stop` aborts a live child agent and persists cancelled state with
  `objectiveStatus:'stopped'`.
- `run_amend` changes objective, criteria, or budget and invalidates prior
  verifier conclusions.
- Completion, failure, and stopped states are returned to the parent model
  through hidden child run notifications.
- The renderer derives current-conversation task entries from persisted
  `child_run.*` projection state; this is a UI view, not a separate task store.

### Resume

Implemented.

- `run_steer` continues an existing same-conversation child run by id or name.
- Continuation replays the run's OWN ledger into the live context (lazy: the
  ledger is only read when a resume or drill-in actually needs it; a missing
  ledger registers empty so the run stays resumable).
- Tool-output replacement state is reconstructed from the restored messages, so
  prior `<persisted-output>` decisions stay stable.
- Cold-restart restores child-run RECORDS only (no ledger IO on conversation
  open); still-`running` records are marked interrupted in both the
  conversation and the run's own ledger.

### Skill Integration

Implemented.

- Skill `execution: isolated` routing is implemented for model and slash skill
  entrypoints.
- Isolated skill execution uses the sidechain child-run runtime, applies
  `model`, `effort`, and `allowed-tools` to the child run, and returns only the
  child result to the parent.
- Child run sidechain compaction restores loaded skill state, preserves recent
  file context, and handles both automatic threshold compaction and reactive
  retry after context-length errors.

### UI

Implemented for the current first-class surfaces.

- `spawn` tool blocks show child run metadata and transcript access. Legacy
  `Agent` blocks remain render-compatible for persisted history.
- The agent header exposes a Tasks button. It opens a current-conversation task
  panel derived from `child_run.*` projection data, ordered with running work
  first, and shows status, type/mode, message count, and latest update time.
- Task rows can open the existing child run details panel; running task rows can
  stop the child run through `run_stop`.
- The child run details panel loads the run-ledger transcript lazily through
  `agent_child_run_transcript` (cached on the ledger tail seq; polled while the
  run is live).
- Nested child tool calls inside transcripts remain expandable.
- Running background child runs can be messaged or stopped from the details
  panel.
- Task and child run side-panel controls clear the top window chrome drag zone so
  close/open actions remain pointer-clickable in the agent rail.

Deferred UI polish:

- cross-conversation per-agent aggregation and non-child run task adapters
  (Dream, scheduled routines, background shell tasks);
- richer progress summaries for long background runs;
- metrics and diagnostics beyond sidechain transcript replay.

## Reference Review Follow-Ups

Review against cc-2.1 and OpenClaw leaves these follow-ups:

- Add `SubagentStart` and `SubagentStop` hook events (cc-2.1 vocabulary) only after Lin has a
  first-class hook registry. They should be lifecycle events, not special cases
  inside the `spawn` tool.
- Keep foreground, detached, and verifier child Runs as the only first-version
  lifecycles. Do not copy team/swarm/coordinator concepts into `spawn`,
  `run_steer`, or `run_status`.
- On app restart, stale running child runs should be marked interrupted or
  recoverable from persisted sidechain transcripts. They should not silently
  remain "running" without a live process.
- Background child runs should always provide a durable output reference and a
  completion/failure/stopped notification. The parent model should not need to
  poll repeatedly to discover completion.
- Background child runs should fail closed when they need interactive permission
  and no approval channel is available. If a permission prompt can be surfaced,
  the parent should receive a clear blocked/waiting notification.
- Full-context child runs should continue to preserve cache-stable parent
  context; recursive spawn is bounded by the configured depth limit.
- Agent-specific MCP servers and remote/worktree isolation remain deferred until
  Lin has diagnostics and recovery for the smaller same-conversation model.

## Test Matrix

Core tests:

- agent definition parsing and override order;
- invalid agent definition diagnostics;
- `spawn` completes and returns a result;
- full-context `spawn` sees parent context;
- full-context `spawn` does not inject child tool output into parent context;
- recursive `spawn` is bounded by depth;
- detached `spawn` launches and later notifies parent;
- verifier Run pass/fail, retry, and blocked/budget-exhausted paths;
- `run_status` list, get, wait, and timeout;
- `run_steer` resumes from sidechain transcript;
- `run_amend` changes objective, criteria, or budget and invalidates verdicts;
- `run_stop` aborts and stores partial result;
- parent compact preserves child run handles and summaries;
- child run compact preserves its own continuity;
- app restart can inspect/resume completed sidechain transcripts;
- app restart marks stale running child runs as interrupted or recoverable;
- background child run completion creates a durable output reference and model
  notification;
- background child run needing unavailable approval fails closed;
- skill `execution: isolated` uses the child-run runtime.
- built-in `/research` creates a same-agent fork whose child model request omits
  mutating, skill, and delegation-control tools.

Reference-alignment tests:

- `context:'full'` means inherited parent transcript;
- `context:'brief'` means compact parent excerpt;
- `context:'none'` means clean child context;
- multiple `spawn` tool calls in one turn run independently;
- agent listing changes do not mutate the `spawn` tool schema.

## Deferred Questions

- Should `run_status` ever return sidechain transcript excerpts, or should the
  transcript stay UI/payload-only?
- Should background child runs always run with lower output budgets by default?
- Should Tenon ship additional bundled profiles, or should all specialization
  beyond the built-in assistant stay in user/project `AGENT.md` definitions?
