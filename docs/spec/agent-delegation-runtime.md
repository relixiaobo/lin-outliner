# Agent Delegation Runtime (child runs)

> **Run unification (2026-06-11):** the "child run" entity is dissolved — a
> delegated (child) run is an ordinary Run with its OWN `runs/<runId>/` ledger
> (own seq space, replayed alone), kind `delegation`, joined to the parent by
> `parentRunId`/`parentToolCallId`. Transcript payload snapshots, the
> `runId:message:N` codec, the positional Dream watermark, and the
> snapshot-rewrite compaction are deleted; child compaction is event-sourced
> like a conversation's. Vocabulary below was rewritten accordingly; cc-2.1
> references describe the SOURCE system's wording, not ours.

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
  -> Agent tool
      -> child run
          -> pi-mono Agent instance
          -> sidechain transcript
          -> status/progress/result notification
```

Child runs are conversation-scoped execution units. The main agent remains the
coordinator. Multiple child runs run in parallel when the model emits multiple
`Agent` tool calls in the same turn.

Child run is therefore Lin's isolated cognition and task execution unit. It is not
a team member, a code-editing sandbox, or a cross-conversation messaging peer.

## Reference Implementation Findings

cc-2.1 contains two layers:

- Core child run layer: mature and worth reproducing.
- Team/swarm layer: useful for cc-2.1's teammate workflow, but not part of Lin's
  initial child-run runtime.

| cc-2.1 source | Behavior to study | Lin decision |
| --- | --- | --- |
| `src/tools/AgentTool/constants.ts` | Tool name is `Agent`; legacy alias is `Task`. | Use `Agent` as the model-facing tool. Do not introduce `delegate`. |
| `src/tools/AgentTool/AgentTool.tsx` | Launches fresh/fork agents, async/background agents, teammate variants, worktree/remote variants, result mapping. | Reuse the core Agent/child run path. Omit teammate, team, worktree, and remote branches initially. |
| `src/tools/AgentTool/prompt.ts` | Teaches when to use child runs, how to brief fresh agents, how to launch multiple agents in one turn, and how fork differs from fresh. | Reuse the guidance style and parallelism rules, with Lin terminology. |
| `src/tools/AgentTool/forkSubagent.ts` | Fork gate, implicit fork by omitting `agent_type`, cache-stable fork directive, recursive fork guard. | Reuse fork behavior. Prefer cc-compatible implicit fork rather than adding a `context` parameter. |
| `src/tools/AgentTool/runAgent.ts` | Builds isolated child run context, system prompt, tool pool, sidechain transcript, skill preload, cleanup, and query loop. | Reuse the execution shape with pi-mono `Agent`; defer hooks and agent-specific MCP. |
| `src/utils/forkedAgent.ts` | Creates isolated tool-use context, cloned read state, cloned content replacement state, child abort behavior, cache-safe fork helpers. | Reuse the isolation and cache-stability ideas in Lin-owned runtime context types. |
| `src/tools/AgentTool/loadAgentsDir.ts` | Loads agent definitions from markdown and JSON, including tools, model, effort, permission mode, max turns, skills, background, hooks, MCP, memory, isolation. | Implement `.agents/agents` definitions. Support the core fields now; defer hooks, MCP, memory, and isolation. |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | Registers background agent tasks, tracks status/progress, supports completion/failure/killed notifications and queued messages. | Reuse lifecycle states, but persist through Lin event store and child-run runtime state. |
| `src/tools/AgentTool/resumeAgent.ts` | Reconstructs sidechain transcript, appends a new user prompt, rebuilds replacement state, resumes in background. | Implement `AgentSend` for same-conversation child run continuation. |
| `src/tools/TaskOutputTool/TaskOutputTool.tsx` | Reads background task output and can block until completion; deprecated in favor of reading output file path. | Do not add a TaskOutput clone. Prefer completion notifications plus output references readable with `file_read`; keep `AgentStatus` only for explicit status/wait checks. |
| `src/tools/TaskStopTool/TaskStopTool.ts` | Stops a running background task by id. | Implement `AgentStop` for child run ids/names. |
| `src/tools/TeamCreateTool/*` | Creates team config, team task list, leader state, teammate workflow. | Do not copy for initial child runs. |
| `src/tools/SendMessageTool/*` | Mixes teammate mailbox, background-agent resume, broadcast, shutdown/plan protocol, and cross-session routes. | Do not copy as one tool. Use `AgentSend` only for same-conversation child run continuation. Future global messaging gets separate tools. |

### Source-Level Design Anchors

The decisions in this document are based on the current cc-2.1 source snapshot
at `/Users/lixiaobo/Coding/.research-repos/cc-2.1`, not on prior memory of the
design.
Key anchors:

- `src/tools/AgentTool/AgentTool.tsx:81-88`: the core `Agent` input schema is
  `description`, `prompt`, `agent_type`, `model`, and `run_in_background`.
  Lin's `Agent` tool starts from this shape.
- `src/tools/AgentTool/AgentTool.tsx:90-101`: `name`, `team_name`, `mode`,
  `isolation`, and `cwd` are added on top of the core schema for teammate,
  team, and isolation behavior. Lin keeps only `name` as a same-conversation alias
  and omits the rest in the first version.
- `src/tools/AgentTool/AgentTool.tsx:318-335`: fresh/fork routing is controlled
  by `agent_type`. When it is set, that agent definition wins. When omitted
  and fork is enabled, the path is fork. This is why Lin does not add a separate
  model-facing `context` field.
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
  the result distinction but routes continuation through `AgentSend`.
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
  and reconstructs tool-output replacement state. `AgentSend` must do the same.
- `src/tools/AgentTool/resumeAgent.ts:99-195`: resume restores fork vs fresh
  agent type, parent system prompt for resumed forks, exact tools for resumed
  forks, and appends the new user message. Lin's `AgentSend` follows this.
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
  `Agent` tool schema.

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
to `pi` when Lin can preserve the same isolation contract. Keep Lin's
`.agents/agents` search paths and model-facing `Agent` tool.

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
`AgentSend` should be a same-conversation continuation tool for an existing
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

- Keep one primary model-facing tool: `Agent`. Avoid separate Team, Delegate,
  or general Send Message tools in the first version. Multiple child runs are
  launched by multiple `Agent` tool calls in the same turn, matching cc-2.1's
  model guidance and avoiding a second orchestration abstraction.
- `Agent` must support both `fresh` and `fork`. External Pi and ECA
  implementations independently validate that this is the right split:
  fresh runs are clean specialist conversations, while fork runs inherit current
  context for isolated branch work.
- Parent context should receive only a compact child result plus a durable run
  id. Full child turns, tool calls, progress, and errors belong in sidechain
  transcript/event storage and UI replay.
- Runtime must include `max-depth`, ancestry/cycle prevention, per-conversation
  concurrency caps, and stop propagation. These are not optional polish; every
  mature implementation needs them to avoid runaway recursive delegation and
  deadlocked child work.
- Agent listing should remain prompt-cache friendly. cc-2.1 moved dynamic agent
  lists out of the tool schema; Lin should use the same shape as skills:
  stable tool schema plus listing state/reminders.
- Project-local agent definitions need trust handling through Lin's permission
  layer. Do not silently load untrusted local agent definitions from arbitrary
  directories.
- `AgentSend` is intentionally narrow: continue or message an existing
  same-conversation background child run. Cross-conversation and global agent
  messaging are future product features and should use a separate design.
- Team/DAG/coordinator/shared-memory systems are valid future workflows, but
  they solve a different problem. Adding them now would blur the boundary
  between "run an isolated helper agent" and "build a workflow engine".

## Current Concepts

### Agent Definition

An agent definition is a reusable execution profile, not a running agent.

Search paths:

```text
~/.agents/agents
<workspace>/.agents/agents
settings.additionalAgentDirectories
```

Each agent directory should contain an `AGENT.md` file.

Supported frontmatter for the first child run version:

- `name`
- `description`
- `tools`
- `disallowed-tools`
- `skills`
- `model`
- `effort`
- `permission-mode`
- `max-turns`
- `background`

Deferred frontmatter:

- `mcp-servers`
- `hooks`
- `memory`
- `isolation`

The markdown body is the child run system prompt supplement.

### Running child run

The in-memory run record (delegation runtime). The transcript is NOT part of the
durable record — it is the run's own ledger, replayed on demand; `messages` is
the live continuation context, loaded lazily on resume:

```ts
type AgentRunRecord = {
  id: string;                       // also the run ledger id (runs/<id>/)
  name?: string;
  description: string;
  prompt: string;
  agentType: string;
  contextMode: 'fresh' | 'fork';
  status: 'running' | 'completed' | 'failed' | 'stopped';
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
  messages: AgentMessage[];         // live context; empty until resume restores it
};
```

### Fresh Child run

A fresh child run starts from its own agent definition and prompt. It does not
inherit the parent transcript. The parent must brief it with complete context.
Its execution identity and memory owner are the called agent definition, not the
parent agent that invoked `Agent`.

Selection:

- `agent_type` set: use that agent definition.
- `agent_type` omitted: fork from the current conversation context.
- Callers should pass `agent_type: "general"` when they want a fresh general
  agent.

#### System prompt — one agent, headless mode (not a separate persona)

A fresh child run is the **same Tenon agent in headless mode**, not a stripped-down
persona. `buildFreshAgentSystemPrompt(definition)` composes, in order:

1. a **child-agent identity + directive** ("You are a Tenon child agent… # Child
   run rules": complete only the task, run headless / never ask the user, keep
   tool chatter out of the result, stay in scope, don't over-claim);
2. the **shared core** of the main system prompt — `LIN_CHILD_AGENT_CORE_PROMPT`, the
   `audience: 'shared'` sections of `LIN_AGENT_SYSTEM_PROMPT_SECTIONS`
   (system-context, outliner, local-tools, web, communication-and-safety) — so a
   child run carries the SAME capabilities, tool conventions, and safety rules as
   the main agent. The `audience: 'main'` sections (identity, memory) are the chat
   agent's alone and are excluded;
3. the definition's **persona body** as `# Agent instructions`, when non-empty.

So the built-in **`general`** carries an **empty body** — it is just "the base
agent, headless, zero persona" (the default fresh worker). A **user/project**
definition specializes by adding a body; its body is purely additive on top of the
shared base. This is the inverse of the earlier design where a fresh child run got
a bespoke minimal prompt that discarded the base. (Cost: a fresh child run's system
prompt grows from ~80 to ~1.2k tokens — normally provider-cached. Fork is
unaffected; see below.)

### Fork Child run

A fork child run inherits the current prepared parent context as a cache-stable
snapshot. It is used when the main agent needs isolated exploration or execution
without pulling intermediate tool output into the parent context.
Its execution identity and memory owner remain the parent agent's identity.

Selection:

- `agent_type` omitted: fork.
- `agent_type` set: fresh.

This follows cc-2.1's fork path instead of adding a new `context: "fork"` field.
The model sees fewer concepts, and the tool stays closer to the reference
implementation.

Fork requirements:

- Use the parent's already-rendered system prompt when available.
- Use the parent's exact tool definitions when possible.
- Preserve parent thinking/runtime params that affect cache keys.
- Include parent messages as the fork prefix.
- Add a short fork directive message that scopes the child task.
- The fork Dream-evidence boundary is STRUCTURAL: the ledger seeds
  `[fork context messages…, run.started, directive…]` and evidence is
  everything past the first `run.started`. Dream must not rediscover the
  boundary by scanning transcript text or counting positions — compaction and
  slimming can rewrite both.
- Prevent recursive fork from inside a forked child run.
- Store the fork transcript in the run's own ledger, not in the parent
  transcript.

### Sidechain Transcript

Every child run writes a separate transcript. The parent conversation stores only:

- the `Agent` tool call;
- launch metadata;
- status/progress notifications;
- final result summary;
- stable handle for status, send, and stop.

This is required so child runs reduce parent-context pressure rather than moving
tool noise into the main conversation.

The sidechain transcript is still durable evidence. Fresh child run transcripts
are Dream evidence for the called agent's `memoryOwnerAgentId`; fork transcripts
are Dream evidence for the parent agent. Dream reads only events past the
structural boundary (the ledger's first `run.started`), so parent history is
never reprocessed as fork evidence — and a `tool_result.replaced` that slims an
INHERITED fork-prefix result never re-enters the window (replacements are lossy
artifacts of existing messages, not new content). When a fork ledger is
compacted, the post-compact summary message is fresh ledger content past the
watermark and is Dreamed like any other evidence (§13.18).

## Model-Facing Tools

### `Agent`

Launches one child run.

Input:

```json
{
  "description": "string",
  "prompt": "string",
  "agent_type": "optional string",
  "model": "optional string",
  "run_in_background": "optional boolean",
  "name": "optional string"
}
```

Field behavior:

- `description`: short three-to-five-word task summary.
- `prompt`: complete task instruction for fresh agents, or a directive for fork
  agents.
- `agent_type`: agent definition name. If omitted, run a fork child run.
- `model`: optional model override. Agent definition model takes precedence rules
  should match Lin's model policy.
- `run_in_background`: if true, return immediately and notify the parent conversation
  when done.
- `name`: optional conversation-local alias for later `AgentSend`, `AgentStatus`, and
  `AgentStop`.

Not included:

- `team_name`
- `mode` for teammate plan mode
- `isolation`
- `cwd`
- `context`
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
  "agent_type": "string",
  "context_mode": "fresh | fork",
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
  "agent_type": "string",
  "context_mode": "fresh | fork",
  "started_at": 0,
  "updated_at": 0,
  "transcript_message_count": 0,
  "instructions": "string"
}
```

When a background run reaches `completed`, `failed`, or `stopped`, Lin appends a
hidden `<agent-task-notification>` message to the parent conversation and starts a
parent continuation when the parent agent is idle. The notification should carry
a durable output reference that can be read with `file_read`, matching
cc-2.1's preferred path for background task output. The parent agent should not
poll `AgentStatus` for ordinary result retrieval.

### `AgentStatus`

Reads or waits for same-conversation child run state. It is a status/wait tool, not the
normal result retrieval path.

Input:

```json
{
  "agent_id": "optional string",
  "name": "optional string",
  "wait": "optional boolean",
  "timeout_ms": "optional number"
}
```

Behavior:

- Requires `agent_id` or `name` and returns status metadata for that child run.
- `wait: true` waits until the selected child run leaves `running` or timeout.
- Completed output should be read from the notification/output reference with
  `file_read` unless a concise result is already included in the status metadata.

### `AgentSend`

Continues a same-conversation child run by appending a new user instruction to its
sidechain transcript and resuming it in the background.

Input:

```json
{
  "agent_id": "optional string",
  "name": "optional string",
  "message": "string"
}
```

Behavior:

- Resolves by `agent_id` first, then `name`.
- Reconstructs sidechain transcript.
- Reconstructs tool-output replacement state for cache-stable replay.
- Appends the message.
- Runs the child run in background.
- Returns launch/status metadata.

This replaces the subset of cc-2.1 `SendMessage` that resumes background agents.
It does not support teammate mailboxes, broadcast, structured shutdown messages,
or cross-conversation routes.

### `AgentStop`

Stops a running same-conversation child run.

Input:

```json
{
  "agent_id": "optional string",
  "name": "optional string"
}
```

Behavior:

- Resolves by `agent_id` first, then `name`.
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

Agent definitions are **user-authorable in-app** (the model never writes them —
the write surface is user-driven only, mirroring the closed memory-write
surface). The settings "Agent Profiles" pane exposes create / edit / duplicate /
delete:

- **Format layer** (`src/core/agentMarkdown.ts`, pure — `yaml` only, no fs):
  `serializeAgentMarkdown(AgentAuthoringInput) → AGENT.md` text and its inverses
  `parseAgentMarkdownDocument` / `parseAgentAuthoringInput`. Shared by **both**
  main (the write surface below) and the renderer (the Form⇄Raw editor toggle), so
  the AGENT.md format lives in exactly one place and the two sides cannot drift.
- **Write surface** (`src/main/agentAuthoring.ts`, pure filesystem): serialize an
  `AgentAuthoringInput` via `serializeAgentMarkdown` and atomic-write it under a
  writable agents dir. The target is forced inside `~/.agents/agents/<slug>`
  (`source: user`) or `<workspace>/.agents/agents/<slug>` (`source: project`); the
  name is slugged to a filesystem-safe segment and path containment is asserted in
  main, so a renderer-supplied name can never escape via traversal. Built-in
  agents (`rootDir === 'built-in'`) are never a write target — editing one means
  **duplicating** to a user copy.
- **Editor UI** (`AgentEditor.tsx`): **one** editor abstraction for every agent —
  built-in, user, or new — with two switchable modes behind a header
  `SegmentedControl`. **Form** = structured controls (name / description / model /
  effort / permission-mode / max-turns / background) plus on/off **toggle lists**
  for tools and skills — all-on or all-off ⇒ the agent inherits every tool (the
  `tools` field is omitted), a proper subset is stored, and any tool/skill outside
  the curated catalog is preserved so Form editing never drops it. **Raw** = the
  full `AGENT.md` text. The toggle converts losslessly through the format layer
  (`serializeAgentMarkdown` Form→Raw, `parseAgentAuthoringInput` Raw→Form). A
  **built-in** renders through this same editor but **read-only** (every control
  disabled; the mode toggle stays live so Raw is viewable; the only action is
  "Duplicate to my agents") — so opening `general` and opening a user agent look
  identical, the difference is only editability. A **new** agent seeds a
  **scaffold** (real defaults — `permission-mode: restricted`, `effort: medium`,
  `max-turns: 20`, a starter persona — plus all tools on and model inherit), so
  the Form starts populated and the Raw is a fill-in template rather than a bare
  `name: ""`. Default mode is Form.
- **Hot-reload**: `AgentDefinitionRegistry.reload()` drops the startup cache
  (`loaded` / `agents` / `seenAgentFileIds`) so the next read re-scans. After any
  authoring write `AgentRuntime` reloads **every live conversation's** registry, so a
  new/edited/deleted agent appears in the child run picker and settings list
  without an app restart. A run resolves its `AgentDefinition` at spawn, so reload
  only affects future spawns — live runs are unaffected.
- **IPC** (additive, `AGENT_COMMANDS`): `agent_create_agent_definition`,
  `agent_update_agent_definition`, `agent_delete_agent_definition`,
  `agent_duplicate_agent_definition`, `agent_reload_agent_definitions`. Each
  returns the freshly reloaded `AgentDefinitionView[]` (an `AgentDefinition` plus
  its `agentId`). `update`/`delete`/`duplicate` address an agent by `agentId`,
  which main resolves to the definition (and rejects built-ins).
- **`additionalAgentDirectories`** is editable from the same pane (comma-separated
  paths), wired to `updateAdditionalAgentDirectories` (which also invalidates the
  cache).

#### Disabling by identity

`disabledAgents` stores the full **`agentId`** (`${source}:${namespace}:${name}`,
`agentDelegationIdentity.ts`), not the bare `name`, so disabling one source's agent
no longer disables a same-named agent from another source. The spawn gate and the
listing filter both check `agentDefinitionAgentId(definition)`. (Pre-release: the
stored shape switched directly with no migration — see
`storage-format-no-backcompat-prerelease`.)

### `AgentSkillRuntime`

Skill `context: fork` calls `AgentDelegationRuntime` instead of creating pi-mono agents
directly.

The skill path should:

- load and render skill content;
- run the rendered content as a sidechain child run prompt using the skill's
  `agent` field, or the built-in `general` agent when no agent is set;
- pass `allowed-tools` as child-run preapproval metadata;
- return only the final result/summary to the parent conversation.

This mirrors the cc-2.1 `context: fork` skill path: the skill body is child-only
execution context, not parent-visible steering content.

## Event Store

The child-run runtime persists through Lin's event store. This follows cc-2.1's
sidechain transcript design in `src/tools/AgentTool/runAgent.ts:732-805`, but
uses Lin-owned parent-conversation events and payload refs rather than a separate
task output file.

Implemented parent-conversation events:

- `child_run.started`
- `child_run.updated`

`child_run.started` (the conversation marker) records stable run metadata: id,
optional same-conversation name, description, prompt, agent type, fresh/fork
context mode, execution identity, parent agent identity, parent run id, memory
owner identity, memory origin workspace, and parent tool call id.

`child_run.updated` (the conversation marker) records status transitions:
`running`, `completed`, `failed`, or `stopped`, plus final result/error. The
transcript itself never moves through conversation events — it lives in the
run's own ledger.

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

Dream raw sources address the run stream directly as
`{stream: 'run', streamId: <runId>, range: {fromSeqExclusive, throughSeq, throughEventId}}`.
The durable memory fact cites its memory episode by `{episodeId}`; the episode
keeps the gist and raw run/conversation stream sources. Evidence expansion
replays the ledger's visible transcript, so provenance stays stable across
later compactions. The Dream watermark cursor records the SCANNED TAIL seq (not
the last evidence seq) so an already-digested terminal run is skipped on later
passes from its run-meta alone, without re-reading the ledger. The parent model
only receives the `Agent` tool result projection.

## Compaction And Resume

Parent compaction should preserve:

- active child run ids/names;
- descriptions;
- statuses;
- latest summaries/progress;
- final result summaries for completed background runs that have not yet been
  acknowledged;
- enough metadata for `AgentStatus`, `AgentSend`, and `AgentStop`.

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

- on first resume (`AgentSend` to a non-live run): the host restores the ledger
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
self-describe as running forever). It can still be continued through `AgentSend`.

A delegated-run ledger uses the memory log's torn-tail policy, not the
conversation log's strict one: a half-written FINAL line (crash artifact of an
interrupted append) is dropped on read and truncated by the next append's
repair; mid-file corruption still fails loudly. Restore-time reconciliation is
contained per run — a corrupt child ledger degrades to a warning and can never
brick its parent conversation.

## Permission Layer

Child runs should be trusted enough to be useful, but scoped by tool profile.

Rules:

- `Agent` launch is allowed by default.
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
- `Agent`;
- `AgentStatus` for explicit status/wait checks;
- `AgentSend`;
- `AgentStop`.

Fresh child runs can see:

- tools allowed by their agent definition;
- skill tool if enabled for the definition;
- no `Agent` tool by default, to prevent uncontrolled nesting.

Fork child runs can see:

- the parent's exact tool set when needed for cache stability;
- a runtime guard that rejects recursive fork attempts.

Background child runs can see only tools that can run without direct UI control.
This should be implemented as a profile over Lin tools rather than a separate
tool system.

## Agent-Facing Prompt Guidance

The `Agent` prompt should teach:

- Use `Agent` for complex, multi-step, or independent work.
- Launch multiple child runs in one turn when the tasks are independent.
- Use fresh child runs when a specialized agent definition is appropriate.
- Brief fresh child runs completely; they do not see the current conversation.
- Omit `agent_type` to fork when intermediate tool output is not worth keeping
  in the main context.
- Do not read or poll background transcripts unless asked; completion
  notifications will arrive.
- Do not fabricate background results before notifications arrive.
- Use `AgentSend` only to continue an existing same-conversation child run.
- Use `AgentStatus` only for status or waiting; read completion output from the
  notification/output reference with `file_read`.
- Use `AgentStop` to stop a running child run.

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
`AgentSend`.

## Implementation Status

### Agent Definitions

Implemented in `src/main/agentDelegation.ts`.

- Loads `~/.agents/agents`, `<workspace>/.agents/agents`, and configured
  additional agent directories.
- Supports directory agents with `AGENT.md`.
- Ships a built-in `general` profile.
- Injects agent listing as turn state/reminders, not inside the `Agent` tool
  schema.

### Foreground Fresh Agent

Implemented.

- `Agent` with `agent_type` creates a fresh sidechain pi-mono `Agent`.
- The child receives its agent definition system prompt plus the supplied task.
- The child derives `executingAgentId` and `memoryOwnerAgentId` from the called
  agent definition. Its `<memory>` briefing and `recall` tool read that
  owner id, not the parent agent id. In isolated memory mode, its memory origin
  workspace is derived from the called agent definition root, not the caller's
  workspace.
- Explicit agent-definition `tools` remain an allow-list. Fresh child runs do not
  receive `recall` unless the definition allows it, either directly or by using
  an unrestricted tool profile; the hidden `<memory>` briefing is still
  owner-scoped background context.
- The parent receives only the final result or error.
- The sidechain transcript is the run's own ledger (`runs/<run-id>/`); there
  are no transcript snapshot payloads.

### Fork Agent

Implemented.

- `Agent` without `agent_type` forks from the current parent context.
- The fork uses the parent system prompt, parent messages, a fork directive, and
  placeholder results for unresolved tool calls.
- Fork runs keep the parent `executingAgentId` and `memoryOwnerAgentId`, and
  Dream treats only the persisted fork boundary plus child-side transcript as new
  agent-run evidence.
- Recursive fork attempts are rejected.
- Child tool output stays in the sidechain transcript and does not pollute the
  parent context.

### Background Lifecycle

Implemented for same-conversation background runs.

- `run_in_background` returns `async_launched` metadata immediately.
- `AgentStatus` reads or waits for a selected run.
- `AgentStop` aborts a live child agent and persists stopped state.
- Completion, failure, and stopped states are returned to the parent model
  through hidden child run notifications.
- The renderer derives current-conversation task entries from persisted
  `child_run.*` projection state; this is a UI view, not a separate task store.

### Resume

Implemented.

- `AgentSend` continues an existing same-conversation child run by id or name.
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

- Skill `context: fork` routing is implemented for model and slash skill
  entrypoints.
- Forked skill execution uses the sidechain child-run runtime, applies `agent`,
  `model`, `effort`, and `allowed-tools` to the child run, and returns only the
  child result to the parent.
- Child run sidechain compaction restores loaded skill state, preserves recent
  file context, and handles both automatic threshold compaction and reactive
  retry after context-length errors.

### UI

Implemented for the current first-class surfaces.

- `Agent` tool blocks show child run metadata and transcript access.
- The agent header exposes a Tasks button. It opens a current-conversation task
  panel derived from `child_run.*` projection data, ordered with running work
  first, and shows status, type/mode, message count, and latest update time.
- Task rows can open the existing child run details panel; running task rows can
  stop the child run through `AgentStop`.
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
  inside the `Agent` tool.
- Keep foreground fresh, fork, and background as the only first-version
  lifecycles. Do not copy team/swarm/coordinator concepts into `Agent`,
  `AgentSend`, or `AgentStatus`.
- On app restart, stale running child runs should be marked interrupted or
  recoverable from persisted sidechain transcripts. They should not silently
  remain "running" without a live process.
- Background child runs should always provide a durable output reference and a
  completion/failure/stopped notification. The parent model should not need to
  poll repeatedly to discover completion.
- Background child runs should fail closed when they need interactive permission
  and no approval channel is available. If a permission prompt can be surfaced,
  the parent should receive a clear blocked/waiting notification.
- Forked child runs should continue to preserve cache-stable parent context and
  reject recursive fork attempts, including after compaction.
- Agent-specific MCP servers and remote/worktree isolation remain deferred until
  Lin has diagnostics and recovery for the smaller same-conversation model.

## Test Matrix

Core tests:

- agent definition parsing and override order;
- invalid agent definition diagnostics;
- fresh `Agent` completes and returns a result;
- fork `Agent` sees parent context;
- fork `Agent` does not inject child tool output into parent context;
- fork recursive guard;
- background `Agent` launches and later notifies parent;
- `AgentStatus` list, get, wait, and timeout;
- `AgentSend` resumes from sidechain transcript;
- `AgentStop` aborts and stores partial result;
- parent compact preserves child run handles and summaries;
- child run compact preserves its own continuity;
- app restart can inspect/resume completed sidechain transcripts;
- app restart marks stale running child runs as interrupted or recoverable;
- background child run completion creates a durable output reference and model
  notification;
- background child run needing unavailable approval fails closed;
- skill `context: fork` uses the child-run runtime.

Reference-alignment tests:

- `agent_type` set means fresh;
- `agent_type` omitted means fork;
- explicit `agent_type: "general"` means fresh general agent;
- multiple `Agent` tool calls in one turn run independently;
- agent listing changes do not mutate the `Agent` tool schema.

## Deferred Questions

- Should `AgentStatus` ever return sidechain transcript excerpts, or should the
  transcript stay UI/payload-only?
- Should background child runs always run with lower output budgets by default?
- Which additional built-in profiles should exist besides `general`?
