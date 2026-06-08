# Agent Subagent Runtime

This document is the design and implementation baseline for Lin's subagent
runtime. It records both the cc-2.1 source references used for alignment and the
Lin-specific choices made while implementing the current same-session subagent
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
concepts for the same-session subagent runtime.

The model-facing concept should be the same mature concept used by cc-2.1's core
subagent path:

```text
main agent session
  -> Agent tool
      -> subagent run
          -> pi-mono Agent instance
          -> sidechain transcript
          -> status/progress/result notification
```

Subagents are session-scoped execution units. The main agent remains the
coordinator. Multiple subagents run in parallel when the model emits multiple
`Agent` tool calls in the same turn.

Subagent is therefore Lin's isolated cognition and task execution unit. It is not
a team member, a code-editing sandbox, or a cross-session messaging peer.

## Reference Implementation Findings

cc-2.1 contains two layers:

- Core subagent layer: mature and worth reproducing.
- Team/swarm layer: useful for cc-2.1's teammate workflow, but not part of Lin's
  initial subagent runtime.

| cc-2.1 source | Behavior to study | Lin decision |
| --- | --- | --- |
| `src/tools/AgentTool/constants.ts` | Tool name is `Agent`; legacy alias is `Task`. | Use `Agent` as the model-facing tool. Do not introduce `delegate`. |
| `src/tools/AgentTool/AgentTool.tsx` | Launches fresh/fork agents, async/background agents, teammate variants, worktree/remote variants, result mapping. | Reuse the core Agent/subagent path. Omit teammate, team, worktree, and remote branches initially. |
| `src/tools/AgentTool/prompt.ts` | Teaches when to use subagents, how to brief fresh agents, how to launch multiple agents in one turn, and how fork differs from fresh. | Reuse the guidance style and parallelism rules, with Lin terminology. |
| `src/tools/AgentTool/forkSubagent.ts` | Fork gate, implicit fork by omitting `subagent_type`, cache-stable fork directive, recursive fork guard. | Reuse fork behavior. Prefer cc-compatible implicit fork rather than adding a `context` parameter. |
| `src/tools/AgentTool/runAgent.ts` | Builds isolated subagent context, system prompt, tool pool, sidechain transcript, skill preload, cleanup, and query loop. | Reuse the execution shape with pi-mono `Agent`; defer hooks and agent-specific MCP. |
| `src/utils/forkedAgent.ts` | Creates isolated tool-use context, cloned read state, cloned content replacement state, child abort behavior, cache-safe fork helpers. | Reuse the isolation and cache-stability ideas in Lin-owned runtime context types. |
| `src/tools/AgentTool/loadAgentsDir.ts` | Loads agent definitions from markdown and JSON, including tools, model, effort, permission mode, max turns, skills, background, hooks, MCP, memory, isolation. | Implement `.agents/agents` definitions. Support the core fields now; defer hooks, MCP, memory, and isolation. |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | Registers background agent tasks, tracks status/progress, supports completion/failure/killed notifications and queued messages. | Reuse lifecycle states, but persist through Lin event store and subagent runtime state. |
| `src/tools/AgentTool/resumeAgent.ts` | Reconstructs sidechain transcript, appends a new user prompt, rebuilds replacement state, resumes in background. | Implement `AgentSend` for same-session subagent continuation. |
| `src/tools/TaskOutputTool/TaskOutputTool.tsx` | Reads background task output and can block until completion; deprecated in favor of reading output file path. | Do not add a TaskOutput clone. Prefer completion notifications plus output references readable with `file_read`; keep `AgentStatus` only for explicit status/wait checks. |
| `src/tools/TaskStopTool/TaskStopTool.ts` | Stops a running background task by id. | Implement `AgentStop` for subagent ids/names. |
| `src/tools/TeamCreateTool/*` | Creates team config, team task list, leader state, teammate workflow. | Do not copy for initial subagents. |
| `src/tools/SendMessageTool/*` | Mixes teammate mailbox, background-agent resume, broadcast, shutdown/plan protocol, and cross-session routes. | Do not copy as one tool. Use `AgentSend` only for same-session subagent continuation. Future global messaging gets separate tools. |

### Source-Level Design Anchors

The decisions in this document are based on the current cc-2.1 source snapshot
at `/Users/lixiaobo/Coding/.research-repos/cc-2.1`, not on prior memory of the
design.
Key anchors:

- `src/tools/AgentTool/AgentTool.tsx:81-88`: the core `Agent` input schema is
  `description`, `prompt`, `subagent_type`, `model`, and `run_in_background`.
  Lin's `Agent` tool starts from this shape.
- `src/tools/AgentTool/AgentTool.tsx:90-101`: `name`, `team_name`, `mode`,
  `isolation`, and `cwd` are added on top of the core schema for teammate,
  team, and isolation behavior. Lin keeps only `name` as a same-session alias
  and omits the rest in the first version.
- `src/tools/AgentTool/AgentTool.tsx:318-335`: fresh/fork routing is controlled
  by `subagent_type`. When it is set, that agent definition wins. When omitted
  and fork is enabled, the path is fork. This is why Lin does not add a separate
  model-facing `context` field.
- `src/tools/AgentTool/AgentTool.tsx:483-540`: fork children inherit the parent
  system prompt and use `buildForkedMessages`; fresh agents build their own agent
  system prompt and receive a single user prompt. Lin mirrors this split.
- `src/tools/AgentTool/AgentTool.tsx:603-633`: fork passes the parent's exact
  tools, parent messages, and `useExactTools` for cache-stable API prefixes.
  Lin's fork path must preserve the same cache-sensitive shape where pi-mono
  exposes the needed state.
- `src/tools/AgentTool/AgentTool.tsx:686-765`: async/background subagents are
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
  avoidance for async agents, allowed tools, and effort are derived per subagent.
  Lin implements a smaller policy, but the runtime must still resolve these per
  subagent rather than relying on the parent agent's live state.
- `src/tools/AgentTool/runAgent.ts:500-529`: `useExactTools` bypasses normal tool
  resolution and async agents get an unlinked abort controller. Lin should keep
  the same distinction between cache-sensitive fork tools and normal fresh-agent
  tool profiles.
- `src/tools/AgentTool/runAgent.ts:577-645`: skills from agent frontmatter are
  preloaded into the subagent's initial messages. Lin keeps `skills` as a first
  version agent-definition field.
- `src/tools/AgentTool/runAgent.ts:666-714`: subagent options disable thinking
  for regular subagents, inherit thinking for `useExactTools` fork children, and
  create an isolated subagent tool-use context. Lin maps this to pi-mono
  `Agent` state, `transformContext`, and tool profiles.
- `src/tools/AgentTool/runAgent.ts:732-805`: initial and subsequent subagent
  messages are recorded into a sidechain transcript. Lin's parent session must
  not inline child tool noise.
- `src/tools/AgentTool/runAgent.ts:816-859`: cleanup tears down agent-specific
  resources, clears cloned state, and kills child-owned background shell tasks.
  Lin needs equivalent cleanup for pi-mono runs and Lin-owned tool processes.
- `src/utils/forkedAgent.ts:306-461`: `createSubagentContext` clones mutable
  context, stubs mutation callbacks, preserves root task writes, isolates denial
  tracking, clones tool-output replacement state, and creates a new query chain.
  This is the main source for Lin's subagent context isolation design.
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
truth for Lin's first subagent runtime. The external research is useful for
validating guardrails, naming boundaries, concurrency behavior, and the features
that should stay out of the first version.

### Projects Reviewed

[pi-subagent](https://github.com/mjakl/pi-subagent)

Problem definition: add specialized subagents to Pi with explicit context
control.

Observed approach: registers a `subagent` tool, discovers markdown agent
definitions, supports `spawn` and `fork`, can run a single task or a bounded
parallel batch, launches isolated `pi` child processes, propagates depth and
ancestry through environment variables, prevents cycles, and returns only the
final subagent summary to the parent. Source files reviewed: `index.ts`,
`runner.ts`, `agents.ts`, `types.ts`, `runner-events.js`, and `render.ts`.

Lin decision: this is the highest-value external source because it is Pi-based.
Borrow spawn/fork semantics, depth and cycle guard, bounded concurrency,
project-agent trust checks, final-result-only parent content, and expandable
execution details. Prefer pi-mono in-process `Agent` instances over shelling out
to `pi` when Lin can preserve the same isolation contract. Keep Lin's
`.agents/agents` search paths and model-facing `Agent` tool.

[ECA](https://eca.dev/)

Problem definition: let a primary chat use focused subagents without polluting
the primary context.

Observed approach: defines `primary` and `subagent` modes, exposes subagents
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
orchestration is a higher-level workflow system, not Lin's first subagent
runtime. Borrow pool limits, cycle/depth/deadlock guards, and tool-output
slimming ideas. Do not introduce first-class Team, Delegate, DAG, or shared
memory for the first version.

[Agency Swarm](https://github.com/VRSEN/agency-swarm)

Problem definition: model multi-agent applications as role-based agencies with
explicit communication paths.

Observed approach: agents register subagents or communication flows, then use a
generated `send_message` tool whose recipient enum is scoped to allowed
recipients. Calls are synchronous, recipient-specific, guarded against
simultaneous messages to the same recipient, and can stream child events. Source
files reviewed: `src/agency_swarm/agency/core.py`,
`src/agency_swarm/agent/subagents.py`,
`src/agency_swarm/tools/send_message.py`, and `src/agency_swarm/context.py`.

Lin decision: good evidence that generic agent messaging needs explicit scope.
Lin should not expose general cross-agent messaging in the first version.
`AgentSend` should be a same-session continuation tool for an existing
background subagent run, not a global routing primitive.

[OpenHands Agent Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation)

Problem definition: allow one coding agent to delegate a task to another agent
with a different tool or environment configuration.

Observed approach: uses SDK-level delegation between agents and emphasizes
specialized execution environments.

Lin decision: useful for later coding-heavy scenarios, but Lin's first version
should not include worktree or remote isolation.

[LangChain DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview)

Problem definition: package primitives needed for long-running deep tasks,
including planning, subagents, a filesystem-like workspace, and detailed
prompts.

Observed approach: treats subagents as one primitive inside a broader deep-task
framework.

Lin decision: confirms that subagents should stay a runtime capability and not
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
problems than a single Lin session needs.

Lin decision: keep them as future research. Do not pull
crew/team/workflow/memory concepts into the first subagent implementation.

### External Research Conclusions

- Keep one primary model-facing tool: `Agent`. Avoid separate Team, Delegate,
  or general Send Message tools in the first version. Multiple subagents are
  launched by multiple `Agent` tool calls in the same turn, matching cc-2.1's
  model guidance and avoiding a second orchestration abstraction.
- `Agent` must support both `fresh` and `fork`. External Pi and ECA
  implementations independently validate that this is the right split:
  fresh runs are clean specialist conversations, while fork runs inherit current
  context for isolated branch work.
- Parent context should receive only a compact child result plus a durable run
  id. Full child turns, tool calls, progress, and errors belong in sidechain
  transcript/event storage and UI replay.
- Runtime must include `max-depth`, ancestry/cycle prevention, per-session
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
  same-session background subagent run. Cross-session and global agent
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

Supported frontmatter for the first subagent version:

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

The markdown body is the subagent system prompt supplement.

### Running Subagent

```ts
type AgentSubagentRun = {
  id: string;
  sessionId: string;
  name?: string;
  subagentType: string;
  description: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  contextMode: 'fresh' | 'fork';
  executingAgentId: string;
  parentAgentId: string;
  memoryOwnerAgentId: string;
  memoryOriginWorkspace?: string;
  dreamEvidenceStartMessageIndex?: number;
  transcriptPayloadId?: string;
  model?: string;
  effort?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  transcriptMessageCount: number;
  parentToolCallId?: string;
  result?: string;
  error?: string;
};
```

### Fresh Subagent

A fresh subagent starts from its own agent definition and prompt. It does not
inherit the parent transcript. The parent must brief it with complete context.
Its execution identity and memory owner are the called agent definition, not the
parent agent that invoked `Agent`.

Selection:

- `subagent_type` set: use that agent definition.
- `subagent_type` omitted: fork from the current conversation context.
- Callers should pass `subagent_type: "general"` when they want a fresh general
  agent.

### Fork Subagent

A fork subagent inherits the current prepared parent context as a cache-stable
snapshot. It is used when the main agent needs isolated exploration or execution
without pulling intermediate tool output into the parent context.
Its execution identity and memory owner remain the parent agent's identity.

Selection:

- `subagent_type` omitted: fork.
- `subagent_type` set: fresh.

This follows cc-2.1's fork path instead of adding a new `context: "fork"` field.
The model sees fewer concepts, and the tool stays closer to the reference
implementation.

Fork requirements:

- Use the parent's already-rendered system prompt when available.
- Use the parent's exact tool definitions when possible.
- Preserve parent thinking/runtime params that affect cache keys.
- Include parent messages as the fork prefix.
- Add a short fork directive message that scopes the child task.
- Persist the fork Dream evidence start index as run metadata. Dream must not
  rediscover the boundary by scanning transcript text, because compaction can
  rewrite or remove the marker text.
- Prevent recursive fork from inside a forked subagent.
- Store the fork transcript in sidechain storage, not in the parent transcript.

### Sidechain Transcript

Every subagent writes a separate transcript. The parent session stores only:

- the `Agent` tool call;
- launch metadata;
- status/progress notifications;
- final result summary;
- stable handle for status, send, and stop.

This is required so subagents reduce parent-context pressure rather than moving
tool noise into the main conversation.

The sidechain transcript is still durable evidence. Fresh subagent transcripts
are Dream evidence for the called agent's `memoryOwnerAgentId`; fork transcripts
are Dream evidence for the parent agent. Dream skips the copied parent-context
prefix of a fork transcript and starts from the fork directive plus child-side
messages, so parent history is not reprocessed as new fork evidence. If a legacy
fork transcript has no persisted boundary, Dream skips that uncertain transcript
instead of falling back to index 0. When a fork transcript is compacted, the
compaction prompt omits copied pre-fork parent context and the compacted summary
becomes the new Dream evidence start.

## Model-Facing Tools

### `Agent`

Launches one subagent.

Input:

```json
{
  "description": "string",
  "prompt": "string",
  "subagent_type": "optional string",
  "model": "optional string",
  "run_in_background": "optional boolean",
  "name": "optional string"
}
```

Field behavior:

- `description`: short three-to-five-word task summary.
- `prompt`: complete task instruction for fresh agents, or a directive for fork
  agents.
- `subagent_type`: agent definition name. If omitted, run a fork subagent.
- `model`: optional model override. Agent definition model takes precedence rules
  should match Lin's model policy.
- `run_in_background`: if true, return immediately and notify the parent session
  when done.
- `name`: optional session-local alias for later `AgentSend`, `AgentStatus`, and
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
  "subagent_type": "string",
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
  "subagent_type": "string",
  "context_mode": "fresh | fork",
  "started_at": 0,
  "updated_at": 0,
  "transcript_message_count": 0,
  "instructions": "string"
}
```

When a background run reaches `completed`, `failed`, or `stopped`, Lin appends a
hidden `<subagent-notification>` message to the parent conversation and starts a
parent continuation when the parent agent is idle. The notification should carry
a durable output reference that can be read with `file_read`, matching
cc-2.1's preferred path for background task output. The parent agent should not
poll `AgentStatus` for ordinary result retrieval.

### `AgentStatus`

Reads or waits for same-session subagent state. It is a status/wait tool, not the
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

- Requires `agent_id` or `name` and returns status metadata for that subagent.
- `wait: true` waits until the selected subagent leaves `running` or timeout.
- Completed output should be read from the notification/output reference with
  `file_read` unless a concise result is already included in the status metadata.

### `AgentSend`

Continues a same-session subagent by appending a new user instruction to its
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
- Runs the subagent in background.
- Returns launch/status metadata.

This replaces the subset of cc-2.1 `SendMessage` that resumes background agents.
It does not support teammate mailboxes, broadcast, structured shutdown messages,
or cross-session routes.

### `AgentStop`

Stops a running same-session subagent.

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
- Emits a parent-session notification.

## Runtime Architecture

### `SubagentRuntime`

Owns session-scoped subagent state:

- active runs;
- id/name registry;
- background lifecycle;
- sidechain transcript ids;
- progress snapshots;
- completion notifications;
- resume and stop commands.

It should create and manage pi-mono `Agent` instances. It should not duplicate
pi-mono's model loop.

### `SubagentRun`

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

Each subagent gets independent runtime state unless a field is intentionally
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

- **Write surface** (`src/main/agentAuthoring.ts`, pure filesystem): serialize an
  `AgentAuthoringInput` to `AGENT.md` (`serializeAgentMarkdown`, the inverse of
  `parseAgentMarkdown`) and atomic-write it under a writable agents dir. The
  target is forced inside `~/.agents/agents/<slug>` (`source: user`) or
  `<workspace>/.agents/agents/<slug>` (`source: project`); the name is slugged to
  a filesystem-safe segment and path containment is asserted in main, so a
  renderer-supplied name can never escape via traversal. Built-in agents
  (`rootDir === 'built-in'`) are never a write target — editing one means
  **duplicating** to a user copy.
- **Hot-reload**: `AgentDefinitionRegistry.reload()` drops the startup cache
  (`loaded` / `agents` / `seenAgentFileIds`) so the next read re-scans. After any
  authoring write `AgentRuntime` reloads **every live session's** registry, so a
  new/edited/deleted agent appears in the subagent picker and settings list
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
`agentSubagentIdentity.ts`), not the bare `name`, so disabling one source's agent
no longer disables a same-named agent from another source. The spawn gate and the
listing filter both check `agentDefinitionAgentId(definition)`. (Pre-release: the
stored shape switched directly with no migration — see
`storage-format-no-backcompat-prerelease`.)

### `AgentSkillRuntime`

Skill `context: fork` calls `SubagentRuntime` instead of creating pi-mono agents
directly.

The skill path should:

- load and render skill content;
- run the rendered content as a sidechain subagent prompt using the skill's
  `agent` field, or the built-in `general` agent when no agent is set;
- pass `allowed-tools` as child-run preapproval metadata;
- return only the final result/summary to the parent session.

This mirrors the cc-2.1 `context: fork` skill path: the skill body is child-only
execution context, not parent-visible steering content.

## Event Store

Subagent runtime persists through Lin's event store. This follows cc-2.1's
sidechain transcript design in `src/tools/AgentTool/runAgent.ts:732-805`, but
uses Lin-owned parent-session events and payload refs rather than a separate
task output file.

Implemented parent-session events:

- `subagent_run.started`
- `subagent_run.updated`

Implemented payload role:

- `subagent_transcript`

`subagent_run.started` records stable run metadata: id, optional same-session
name, description, prompt, subagent type, fresh/fork context mode, execution
identity, parent agent identity, memory owner identity, memory origin workspace,
Dream evidence start index, parent tool call id, transcript payload ref, and
transcript message count.

`subagent_run.updated` records status transitions and transcript movement:
`running`, `completed`, `failed`, or `stopped`, plus final result/error and the
latest transcript payload ref. It can also move the Dream evidence start index
when compaction rewrites the sidechain transcript.

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
user-visible conversation state. The sidechain transcript is stored as immutable
JSON payload snapshots and referenced by the subagent run record. This keeps the
parent model context clean while still allowing status, restore, debug, and
continuation.

Transcript payloads include the same execution and memory owner ids as the run
record plus the Dream evidence start index. Dream memory sources record the
specific transcript payload id as `source.eventId`; evidence expansion must read
that recorded payload rather than the run's latest payload, so provenance remains
stable after later compaction or transcript snapshots. The parent model only
receives the `Agent` tool result projection.

## Compaction And Resume

Parent compaction should preserve:

- active subagent ids/names;
- descriptions;
- statuses;
- latest summaries/progress;
- final result summaries for completed background runs that have not yet been
  acknowledged;
- enough metadata for `AgentStatus`, `AgentSend`, and `AgentStop`.

Parent compaction should not inline full sidechain transcripts.

Subagent compaction should use the same model-context manager concepts as the
main agent:

- tool-output slimming;
- automatic sidechain summary before a child model call crosses the context
  threshold;
- reactive sidechain summary and retry after a child context-length error;
- invoked skill restore if the subagent loaded skills.
- recent full-file context restore when available in the child workspace.

App restart restores:

- completed/stopped/failed subagent metadata;
- sidechain transcripts for `AgentStatus`;
- resumable background subagents when there is a persisted transcript.

If a subagent was persisted as `running` but there is no live pi-mono `Agent`
after restore, Lin marks it as failed with an interruption message and preserves
the transcript. It can still be continued through `AgentSend`.

## Permission Layer

Subagents should be trusted enough to be useful, but scoped by tool profile.

Rules:

- `Agent` launch is allowed by default.
- Every subagent tool call still goes through Lin's permission layer.
- Agent definition `tools` and `disallowed-tools` narrow the available tool set.
- Agent definition `permission-mode` may relax or tighten behavior within Lin's
  global safety policy.
- Background subagents should avoid UI permission prompts; deny or bubble only
  when a policy requires it.
- Catastrophic commands and workspace-boundary violations remain hard denied.

Do not copy cc-2.1's full historical permission mode matrix. Implement the
smallest Lin-owned policy that supports useful subagents with clear boundaries.

## Tool Profiles

The main agent can see:

- normal Lin tools;
- `Agent`;
- `AgentStatus` for explicit status/wait checks;
- `AgentSend`;
- `AgentStop`.

Fresh subagents can see:

- tools allowed by their agent definition;
- skill tool if enabled for the definition;
- no `Agent` tool by default, to prevent uncontrolled nesting.

Fork subagents can see:

- the parent's exact tool set when needed for cache stability;
- a runtime guard that rejects recursive fork attempts.

Background subagents can see only tools that can run without direct UI control.
This should be implemented as a profile over Lin tools rather than a separate
tool system.

## Agent-Facing Prompt Guidance

The `Agent` prompt should teach:

- Use `Agent` for complex, multi-step, or independent work.
- Launch multiple subagents in one turn when the tasks are independent.
- Use fresh subagents when a specialized agent definition is appropriate.
- Brief fresh subagents completely; they do not see the current conversation.
- Omit `subagent_type` to fork when intermediate tool output is not worth keeping
  in the main context.
- Do not read or poll background transcripts unless asked; completion
  notifications will arrive.
- Do not fabricate background results before notifications arrive.
- Use `AgentSend` only to continue an existing same-session subagent.
- Use `AgentStatus` only for status or waiting; read completion output from the
  notification/output reference with `file_read`.
- Use `AgentStop` to stop a running subagent.

## Explicit Non-Goals For The First Version

Do not implement:

- Team or Swarm as model-facing concepts.
- `TeamCreate`, `TeamDelete`, `team_name`, teammate `name`, or team task lists.
- teammate mailbox, broadcast, or structured shutdown/approval protocols.
- `SendMessage` as a mixed routing tool.
- cross-session or global agent messaging.
- worktree isolation.
- remote isolation.
- agent-specific MCP servers.
- hooks lifecycle.
- memory/session-memory.
- team-level task board.
- continuous teammate loops.

Future global or cross-session agent messaging should be a separate
communication plane with separate tools. It must not be mixed into same-session
`AgentSend`.

## Implementation Status

### Agent Definitions

Implemented in `src/main/agentSubagents.ts`.

- Loads `~/.agents/agents`, `<workspace>/.agents/agents`, and configured
  additional agent directories.
- Supports directory agents with `AGENT.md`.
- Ships a built-in `general` profile.
- Injects agent listing as turn state/reminders, not inside the `Agent` tool
  schema.

### Foreground Fresh Agent

Implemented.

- `Agent` with `subagent_type` creates a fresh sidechain pi-mono `Agent`.
- The child receives its agent definition system prompt plus the supplied task.
- The child derives `executingAgentId` and `memoryOwnerAgentId` from the called
  agent definition. Its `<agent-memory>` reminder and `recall` tool read that
  owner id, not the parent agent id. In isolated memory mode, its memory origin
  workspace is derived from the called agent definition root, not the caller's
  workspace.
- Explicit agent-definition `tools` remain an allow-list. Fresh subagents do not
  receive `recall` unless the definition allows it, either directly or by using
  an unrestricted tool profile; the hidden `<agent-memory>` reminder is still
  owner-scoped background context.
- The parent receives only the final result or error.
- Sidechain transcript snapshots are persisted as `subagent_transcript`
  payloads.

### Fork Agent

Implemented.

- `Agent` without `subagent_type` forks from the current parent context.
- The fork uses the parent system prompt, parent messages, a fork directive, and
  placeholder results for unresolved tool calls.
- Fork runs keep the parent `executingAgentId` and `memoryOwnerAgentId`, and
  Dream treats only the persisted fork boundary plus child-side transcript as new
  agent-run evidence.
- Recursive fork attempts are rejected.
- Child tool output stays in the sidechain transcript and does not pollute the
  parent context.

### Background Lifecycle

Implemented for same-session background runs.

- `run_in_background` returns `async_launched` metadata immediately.
- `AgentStatus` reads or waits for a selected run.
- `AgentStop` aborts a live child agent and persists stopped state.
- Completion, failure, and stopped states are returned to the parent model
  through hidden subagent notifications.
- The renderer derives current-conversation task entries from persisted
  `subagent_run` projection state; this is a UI view, not a separate task store.

### Resume

Implemented.

- `AgentSend` continues an existing same-session subagent by id or name.
- Continuation reconstructs the sidechain transcript from the persisted payload.
- Tool-output replacement state is reconstructed from sidechain messages, so
  prior `<persisted-output>` decisions stay stable.
- Cold-restart status restore and continuation from persisted transcript are
  supported.

### Skill Integration

Implemented.

- Skill `context: fork` routing is implemented for model and slash skill
  entrypoints.
- Forked skill execution uses the sidechain subagent runtime, applies `agent`,
  `model`, `effort`, and `allowed-tools` to the child run, and returns only the
  child result to the parent.
- Subagent sidechain compaction restores loaded skill state, preserves recent
  file context, and handles both automatic threshold compaction and reactive
  retry after context-length errors.

### UI

Implemented for the current first-class surfaces.

- `Agent` tool blocks show subagent metadata and transcript access.
- The agent header exposes a Tasks button. It opens a current-conversation task
  panel derived from `subagent_run` projection data, ordered with running work
  first, and shows status, type/mode, message count, and latest update time.
- Task rows can open the existing subagent details panel; running task rows can
  stop the subagent through `AgentStop`.
- The subagent details panel loads sidechain transcripts lazily from payload
  refs.
- Nested child tool calls inside transcripts remain expandable.
- Running background subagents can be messaged or stopped from the details
  panel.
- Task and subagent side-panel controls clear the top window chrome drag zone so
  close/open actions remain pointer-clickable in the agent rail.

Deferred UI polish:

- cross-conversation per-agent aggregation and non-subagent task adapters
  (Dream, scheduled routines, background shell tasks);
- richer progress summaries for long background runs;
- metrics and diagnostics beyond sidechain transcript replay.

## Reference Review Follow-Ups

Review against cc-2.1 and OpenClaw leaves these follow-ups:

- Add `SubagentStart` and `SubagentStop` hook events only after Lin has a
  first-class hook registry. They should be lifecycle events, not special cases
  inside the `Agent` tool.
- Keep foreground fresh, fork, and background as the only first-version
  lifecycles. Do not copy team/swarm/coordinator concepts into `Agent`,
  `AgentSend`, or `AgentStatus`.
- On app restart, stale running subagents should be marked interrupted or
  recoverable from persisted sidechain transcripts. They should not silently
  remain "running" without a live process.
- Background subagents should always provide a durable output reference and a
  completion/failure/stopped notification. The parent model should not need to
  poll repeatedly to discover completion.
- Background subagents should fail closed when they need interactive permission
  and no approval channel is available. If a permission prompt can be surfaced,
  the parent should receive a clear blocked/waiting notification.
- Forked subagents should continue to preserve cache-stable parent context and
  reject recursive fork attempts, including after compaction.
- Agent-specific MCP servers and remote/worktree isolation remain deferred until
  Lin has diagnostics and recovery for the smaller same-session model.

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
- parent compact preserves subagent handles and summaries;
- subagent compact preserves its own continuity;
- app restart can inspect/resume completed sidechain transcripts;
- app restart marks stale running subagents as interrupted or recoverable;
- background subagent completion creates a durable output reference and model
  notification;
- background subagent needing unavailable approval fails closed;
- skill `context: fork` uses subagent runtime.

Reference-alignment tests:

- `subagent_type` set means fresh;
- `subagent_type` omitted means fork;
- explicit `subagent_type: "general"` means fresh general agent;
- multiple `Agent` tool calls in one turn run independently;
- agent listing changes do not mutate the `Agent` tool schema.

## Deferred Questions

- Should `AgentStatus` ever return sidechain transcript excerpts, or should the
  transcript stay UI/payload-only?
- Should background subagents always run with lower output budgets by default?
- Which additional built-in profiles should exist besides `general`?
