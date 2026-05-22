# Agent Implementation With pi-mono

This document describes Lin Outliner's current local agent runtime boundary with
pi-mono as the agent core.

The goal is to reuse pi-mono for model/provider abstraction, streaming, and the
agent loop, while keeping Lin's local capabilities, document mutations, and
security boundaries in TypeScript.

## Decision

Lin uses these pi-mono packages:

- `pi-ai`: model/provider registry, message types, tool schema types, streaming,
  tool-call parsing, context overflow helpers.
- `pi-agent-core`: stateful agent loop, tool execution orchestration, steering,
  follow-up work, abort, subscriptions, and message replacement.

Lin does not directly use `pi-coding-agent` as the product agent runtime. Its
built-in terminal tools are useful implementation references, but Lin's tools
must execute through the Electron IPC command bridge so file access, bash execution,
document mutation, undo, approval, and workspace boundaries stay under Lin's
control.

The canonical persistence/rendering/debug model is defined in
`docs/spec/agent-event-log-rendering.md`. pi-mono remains the execution core;
Lin's durable state is the event log plus referenced payload files.

```txt
pi-ai
  -> provider/model abstraction
  -> streaming assistant events
  -> tool schema and tool-call parsing

pi-agent-core
  -> agent loop
  -> tool call orchestration
  -> Agent state and subscriptions
  -> steer / abort / replaceMessages

Lin Electron main process
  -> creates Agent
  -> maps pi-mono events into Lin events and render projections
  -> exposes Lin tools as AgentTool[]
  -> calls TypeScript tool gateway for local operations

Lin Electron main process
  -> AgentRuntime session lifecycle
  -> API key / credential storage
  -> bash execution
  -> file operations
  -> outliner reads and mutations
  -> permissions and approval policy
  -> persistence and undo grouping

Lin renderer
  -> Agent UI only
  -> sends prompt/stop/approve commands
  -> renders shared AgentRuntimeEvent projections
```

## Runtime Boundary

The agent dock remains a cross-tab shell feature. It owns conversation state and
rendering. The outliner owns document state and panel state.

Lin's product runtime is TypeScript/Electron only. Agent tools, outliner
mutation planning, outline parsing, preview rendering data, validation, undo
grouping, file access, bash execution, and web adapters are implemented through
TypeScript modules under Electron main and `src/core`. Do not introduce a
Rust-side parser or command bridge for the current architecture.

The pi-mono Agent does not live in the renderer. The clean boundary is:

- Renderer: Agent UI, input, transcript rendering, and approval controls.
- Electron main process: AgentRuntime, local security boundary, API key storage, persistence,
  approval enforcement, and tool gateway.
- Electron main process: pi-mono agent loop, provider streaming, context assembly,
  and tool-call orchestration.

Electron main process remains the authority for every operation that touches the
local machine, credentials, or document state. The pi-mono loop may request tool
execution, but the TypeScript tool gateway performs the operation or rejects it.

```txt
Agent input
  -> renderer agent client
  -> Electron IPC command
  -> Electron AgentRuntime
  -> pi-agent-core Agent
  -> pi-ai stream
  -> tool calls
  -> TypeScript tool gateway
  -> TypeScript core / filesystem / shell
  -> tool result
  -> pi-agent-core continues loop
  -> Electron main emits normalized event/projection
  -> renderer transcript
```

The renderer may hold transient UI state, but it must not hold provider API keys
or directly execute model/tool logic. This keeps a future Lin-owned agent core
possible: it only needs to implement the AgentRuntime event/command contract.

## Package Usage

pi-mono packages are pinned dependencies. Do not use floating major or minor
versions until Lin has its own compatibility tests around the adapter.

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "0.74.0",
    "@earendil-works/pi-agent-core": "0.74.0"
  }
}
```

If pi-mono changes package ownership or names, keep the imports behind Lin's
own adapter modules so product code does not depend on package names directly.

Current module boundary:

```txt
src/core/agentTypes.ts
  # shared AgentRuntimeEvent, event-log DTOs, render projection DTOs, and IPC event channel

src/core/agentEventLog.ts
  # shared AgentEvent, payload refs, replay reducers, branch projection, and
  # pi-mono message projection

src/main/agentRuntime.ts
  # owns pi-agent-core sessions, command transport, event append, and projection
  # forwarding

src/main/agentEventStore.ts
  # per-session events.jsonl and payload/checkpoint path layout

src/preload/index.ts
  # exposes typed command and event bridge to the renderer

src/renderer/agent/
  runtime.ts              # UI client for Electron AgentRuntime
```

Only Electron main process agent modules should import pi-mono directly.
Renderer and preload code should depend on shared Lin-owned DTOs from
`src/core/agentTypes.ts`, not pi-mono package types and not renderer-owned
types.

## Agent Runtime

Lin wraps pi-agent-core inside Electron main process. Product UI talks to
Electron AgentRuntime through a renderer `useLinAgentRuntime` client, never to a raw
pi-mono Agent.

Responsibilities:

- Electron main process: create and configure the pi-mono `Agent`.
- Electron main process: set the active model, system prompt, and tool list.
- Electron main process: start sessions, route prompts, stop runs, and manage runtime lifecycle.
- Electron main process: resolve API keys at stream time.
- Electron main process: execute or reject every local tool call.
- Electron main process: subscribe to Agent events and append normalized Lin events.
- Electron main process: derive render/debug/pi-mono projections from the event store.
- Renderer: render projections and send user intents.

Conceptual shape:

```ts
interface AgentRuntimeClient {
  restoreLatestSession(): Promise<AgentSession>;
  restoreSession(sessionId: string): Promise<AgentSession>;
  createSession(): Promise<AgentSession>;
  closeSession(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string, attachments?: AgentMessageAttachmentInput[]): Promise<void>;
  editMessage(sessionId: string, nodeId: string, message: string): Promise<void>;
  regenerateMessage(sessionId: string, nodeId: string): Promise<void>;
  retryMessage(sessionId: string, nodeId: string): Promise<void>;
  switchBranch(sessionId: string, nodeId: string): Promise<void>;
  queueFollowUp(sessionId: string, message: string): Promise<{ queued: boolean }>;
  clearFollowUp(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  onEvent(listener: (event: AgentRuntimeEvent) => void): (() => void) | null;
}
```

The boundary exposes Lin-owned runtime events, render projections,
attachment DTOs, debug DTOs, and UI state. Conversation content types should
reuse pi-ai block shapes where possible so Lin does not maintain a parallel,
shape-compatible copy of `TextContent` or `ImageContent`. Persisted conversation
identity, branching, tool lifecycle, approvals, and debug records are Lin-owned
event-log concepts, not pi-mono runtime state.

Session listing, rename/delete, debug history, debug payload reads, payload text
reads, reset, and provider settings are separate Electron IPC commands that use
the same Lin-owned DTO boundary.

## Model Configuration

Lin should use `pi-ai` for known provider and model metadata, but Lin should own
the user's provider settings.

Multimodal user turns should use pi-ai's native `ImageContent` shape:
`{ type: "image", data: base64, mimeType }`. Provider adapters then translate
the same Lin message to Anthropic base64 image blocks, OpenAI image URLs,
Gemini inline data, and other upstream formats.

Model configuration should include:

- Provider id.
- Model id.
- API key reference or local secret key name.
- Optional base URL.
- Optional API protocol override for OpenAI-compatible providers.
- Reasoning level if the selected model supports it.
- Runtime agent settings: permission mode, skill toggles, compact toggle,
  additional skill/agent directories, provider timeout, provider retry count,
  provider retry-delay cap, and prompt cache retention.

The API key should be read at stream time through Lin's TypeScript credential path. It
should not be embedded into persisted agent messages, tool results, renderer
state, or IPC command payloads.

Lin currently stores provider settings and secrets in app-data files owned by
TypeScript:

```txt
agent-providers.json
  -> activeProviderId
  -> agent: runtime agent settings
  -> providers: providerId, modelId, baseUrl, enabled

agent-secrets.json
  -> providerId -> apiKey
  -> local only, private file permissions where the OS supports it
```

Renderer-facing commands may return provider configuration and `hasApiKey`, but
must not return the API key itself. Runtime provider resolution should happen
through Electron AgentRuntime or the TypeScript tool/provider gateway.

## System Prompt

Lin follows the prompt layering principle used by stable agent runtimes:

- The stable system prompt defines identity, tool boundaries, communication
  rules, and safety posture.
- Per-turn `<system-reminder>` blocks carry current outliner context,
  attachment metadata, and other dynamic state.
- Tool descriptions define exact parameter contracts and result interpretation.

The stable prompt is implemented in `src/main/agentSystemPrompt.ts`. It should
not contain current UI state, current node ids beyond generic rules, local file
paths, provider settings, or any state that changes per turn.

It states:

- Lin is a local-first outliner and local assistant.
- The agent should use the user's language unless asked otherwise.
- The agent should treat `<system-reminder>` as hidden context from Lin, not as
  user-authored text.
- Dynamic state can change because the user may edit the outliner directly, so
  exact node ids, node content, and file contents must be read with tools when
  needed.
- Outliner work should use `node_search`, `node_read`, `node_create`,
  `node_edit`, `node_delete`, and `operation_history` with narrow mutations and
  confirmed tool results.
- Local file work should prefer `file_read`, `file_glob`, `file_grep`,
  `file_edit`, and `file_write` over `bash`.
- `bash` is reserved for terminal operations, tests, builds, package managers,
  and system commands.
- Web work should use `web_search` for discovery and `web_fetch` for reading
  known URLs and verifying source details.
- File attachments require `file_read`; inline images are visible as image
  content blocks.
- The agent should not invent tool outcomes, node ids, file contents, URLs, or
  capabilities.
- Broad or destructive actions should be gated by clear user intent and the
  relevant approval/tool flow.

Avoid putting implementation details such as React component names or internal
TypeScript function names into the system prompt unless a tool needs them.

## Context Construction

Each prompt should include a compact context block built by Lin, not by pi-mono.

Default context:

- Active tab id.
- Active panel id.
- Selected node ids in the active panel.
- Visible node summary for the active panel.
- Recently edited or mentioned nodes when available.
- Current local time.
- Current permission mode for file and shell tools.

The context builder should be deterministic and bounded. It should not dump the
entire document unless the user explicitly asks for whole-document work.

```txt
User prompt
  -> context.ts builds active outliner context
  -> runtime sends messages to Agent
  -> transformContext applies tool-output budget, microcompact, and auto compact
```

Lin uses pi-mono's `transformContext` hook for request-time context shaping and
the runtime's `afterToolCall` hook for immediate large-result persistence. The
compaction policy stays in Lin so it can preserve outliner-specific anchors,
skills state, and event-log replay semantics.

## Tool Model

All tools exposed to pi-agent-core should be Lin tools. A tool is a TypeScript
adapter around a Electron IPC command.

```txt
AgentTool.execute(args)
  -> validate args
  -> check approval policy
  -> invoke Electron IPC command
  -> normalize result
  -> return AgentToolResult
```

Tool names should be stable. Tool arguments and results should be JSON-shaped
and versionable.

## Reference Tool Sets

Lin should use nodex as the outliner reference and a proven local-tool runtime
as the local tool reference. Lin should still keep its own lower snake case tool
names because the runtime, permission model, and UI are Lin-owned.

nodex tools:

- `node_create`
- `node_read`
- `node_edit`
- `node_delete`
- `node_search`
- `undo`
- `browser`
- `past_chats`

nodex is the closest outliner reference. Its important lesson is that document
tools should be domain-specific, not generic file operations. The agent edits
nodes through outliner verbs and each write is undoable as one AI operation.
Lin should keep nodex's compact `node_*` surface, but use Lin's own final
contracts from `agent-tool-design.md`: `node_create.outline`,
`node_read(...)`, and
`node_edit.old_string/new_string`. The parser is implemented in TypeScript rather than
left as prompt-only behavior. Compatibility normalization belongs in the
adapter/runtime layer and should not appear in the model-facing tool
description. Lin code should use neutral parser names such as
`lin_outline_parser`.

Reference local and agent tool roles:

- shell execution
- file read, edit, write, glob, and grep
- web fetch and web search
- task planning
- skill invocation
- user question
- subagent execution
- task stop
- plan mode
- MCP resource listing and reading

The reference runtime is useful for tool contracts, permission checks, and tool
pool filtering. For local tools, Lin should copy the role boundaries,
descriptions, argument schemas, and model-visible action payloads where they fit.
Runtime details can keep Lin's common `ToolResult` envelope, but
`node_*` model-visible output should use the discriminated node protocol from
`agent-tool-design.md` rather than exposing the envelope directly:

The bridge to pi-agent-core must remain native: tool `execute` returns
`AgentToolResult` content/details only, while Lin's shared `afterToolCall`
adapter maps envelope errors (`details.ok === false`) to
`ToolResultMessage.isError = true`.

- Dedicated file tools should be preferred over shell commands.
- `file_read` is the freshness prerequisite for `file_edit` and existing-file `file_write`.
- `file_edit` is exact string replacement, not a custom patch protocol.
- `file_glob` finds paths; `file_grep` searches contents.
- `bash` runs commands and can background long-running work.
- `task_stop` only stops a background task; it is not a generic process manager.
- Large command output should be persisted and then read through the file tool.

Lin should not configure `AskUserQuestion` for v1. The assistant can ask the
user in normal chat when clarification is needed. Web access should instead be
covered by `web_search` and `web_fetch`.

## Lin Tool Registry

Lin uses a compact, stable tool registry. Higher-risk tools should still be
added only after approval, rendering, and undo behavior are solid.

The detailed tool contract, parameter schema, and result envelope are defined in
`docs/spec/agent-tool-design.md`. This document only describes how those tools
fit into the pi-mono runtime.

### P0 Tools

These are the active core tool surface.

| Tool | Reference | TypeScript-backed? | Approval intent | Purpose |
|---|---|---:|---|---|
| `node_search` | nodex `node_search`, Lin search-node outline | Yes | No | Execute a temporary or saved search node outline without mutating document state. |
| `node_read` | nodex `node_read` | Yes | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | nodex `node_create`, Lin outline parser | Yes | Usually yes | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | nodex `node_edit`, Lin outline parser | Yes | Usually yes | Edit a known node's annotated outline by exact replacement, or perform explicit move, merge, or reference replacement. |
| `node_delete` | nodex `node_delete` | Yes | Usually yes | Trash or restore nodes. |
| `operation_history` | nodex `undo`, Lin history | Yes | Depends | List, undo, or redo user and agent operations. |
| `file_read` | local file read role | Yes | Usually no | Read files with bounded output and freshness tracking. |
| `file_glob` | local file glob role | Yes | No | Find files by path pattern. |
| `file_grep` | local file grep role | Yes | No | Search file contents with bounded output. |
| `file_edit` | local exact edit role | Yes | Yes | Perform exact string replacement after reading the file. |
| `file_write` | local file write role | Yes | Yes | Create files or rewrite whole files. |
| `bash` | shell execution role | Yes | Usually yes | Run local commands with timeout, approval, and output limits. |
| `task_stop` | background task stop role | Yes | Usually yes | Stop background commands created by `bash`. |
| `web_search` | web search role | Optional | Depends | Search the web for current external information. |
| `web_fetch` | web fetch role | Optional | Depends | Fetch and read a specific URL with pagination or snippet search. |

P0 intentionally follows nodex's compact outliner surface instead of exposing
one tool per UI command. Tag, field, reference, move, and merge behavior
belong inside `node_create` and `node_edit` semantics, not separate `node_tag`,
`node_field`, or `node_move` tools.

### P1 Tools

Add these after the active tool surface remains reliable in real workflows.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `past_chats` | nodex `past_chats` | Yes | No | Search and read older Lin agent conversations. |

`task_stop` is active because Lin's `bash` tool supports background commands.

### P2 Tools

These should wait until the product needs them.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `browser` | nodex `browser` | Yes | Usually yes | Control an embedded browser tab if Lin adds one. |
| `mcp_list_resources` | MCP resource discovery | Yes | No | Discover MCP resources. |
| `mcp_read_resource` | MCP resource reading | Yes | No | Read MCP resources. |
| `mcp_call_tool` | MCP tool calls | Yes | Depends | Call configured MCP server tools. |
| `todo_write` | task planning | No | No | Maintain internal task plans if agent planning needs a tool. |
| `skill` | skill invocation | Partly | Depends | Load and invoke local skill folders. |
| `sub_agent` | child agent execution | Mixed | Depends | Spawn child agents. Not needed for Lin v1. |

Do not configure browser, MCP, or sub-agent tools in the first release unless
there is a specific user-facing workflow. A larger tool pool increases prompt
cost and makes permission behavior harder to reason about.

## Tool Naming

Lin should use lower snake case tool names for all Lin-owned tools:

- `node_*` for document graph operations.
- `file_*` for filesystem operations.
- `bash` for shell execution.
- `task_stop` for stopping background commands created by `bash`.
- `past_chats` for conversation history.
- `web_search` / `web_fetch` for web access.

Do not use:

- legacy `Read` / `Edit` / `Write` aliases: Lin should make the local
  capability explicit with lower snake case names.
- generic mutation tools such as `outliner_write`, `outliner_apply_patch`, or
  `node_batch`: they force the model to learn a second mini-protocol and make
  permission boundaries less clear.

The current implementation configures the P0 tools listed above. Additional
tools should be added by product need, not because a reference project has them.

## TypeScript Tool Commands

Electron main handlers should be the only place where local side effects happen.

Expected command families:

```txt
agent_tool_node_search
agent_tool_node_read
agent_tool_node_create
agent_tool_node_edit
agent_tool_node_delete
agent_tool_operation_history
agent_tool_file_read
agent_tool_file_write
agent_tool_file_edit
agent_tool_file_glob
agent_tool_file_grep
agent_tool_bash
agent_tool_task_stop
agent_tool_web_search
agent_tool_web_fetch
```

Each command should receive:

- `conversationId`
- `runId`
- `toolCallId`
- normalized tool arguments
- active tab context if relevant

Each command should return:

- `ok`
- structured `data` when successful
- structured `error` when failed
- optional `preview` for UI rendering
- optional `operation` with `undoGroupId` for document mutations
- optional `requiresApproval` for deferred execution

TypeScript should validate paths, workspace boundaries, command timeouts, output size,
and mutation legality. TypeScript validation is useful for fast feedback, but it
is not the security boundary.

## Approval Flow

Some tools should be allowed immediately; others should pause the agent until
the user approves.

Likely immediate tools:

- Read outliner nodes with `node_read`.
- Search outliner content with `node_search`.
- List operation history.
- Read files under the workspace when permission mode allows it.
- Search or fetch the web when web access is enabled.

Likely approval tools:

- Node creation or edit that mutates document state.
- Node deletion.
- Undo or redo that affects user-origin operations.
- File write or edit.
- Shell command with side effects.
- Shell command outside a known safe allowlist.

Approval flow:

```txt
Tool call starts
  -> adapter asks TypeScript for preview or risk classification
  -> AgentRuntime appends approval.requested
  -> tool promise waits
  -> user approves or rejects
  -> AgentRuntime appends approval.resolved
  -> adapter resolves tool result
  -> pi-agent-core continues
```

Rejected tools should return a normal tool result that says the user denied the
operation. The agent can then explain or propose a safer alternative.

Approval events are part of the schema, but the current main branch has not
enabled the approval UI/runtime pause flow yet.

## Event Mapping

pi-mono events should be normalized into Lin events before they reach storage,
debug, or renderer components. The canonical event-store architecture lives in
`docs/spec/agent-event-log-rendering.md`.

Currently emitted event categories:

- `session.created`
- `session.renamed`
- `payload.created`
- `debug.snapshot.created`
- `branch.selected`
- `user_message.created`
- `user_message.edited`
- `assistant_message.started`
- `assistant_message.delta`
- `assistant_message.completed`
- `tool_call.started`
- `tool_call.completed`
- `tool_call.failed`
- `tool_result.created`
- `run.started`
- `run.completed`
- `run.failed`

Schema-reserved categories for the next runtime passes:

- `assistant_message.failed`
- `thinking.delta`
- `tool_call.delta`
- `approval.requested`
- `approval.resolved`
- `follow_up.queued`
- `follow_up.applied`
- `run.cancelled`
- `compaction.completed`
- `payload.derived`
- `checkpoint.created`
- `metric.recorded`

The raw pi-mono event can be kept as a payload ref for debugging, but UI
components should render from Lin's normalized render projection.

This keeps the transcript renderer independent from pi-mono and makes future
migration to a TypeScript agent core or another library possible.

## State Persistence

Agent conversations are not workspace tabs. They belong to shell-level agent
state.

Persist the Agent Session Event Store:

- Append-only normalized events.
- Payload files referenced by event payload refs.

Represent these product facts as events:

- Conversation metadata changes.
- User and assistant message lifecycle.
- Branch selection.
- Tool call and tool result lifecycle.
- Approval lifecycle when approval UI/runtime pause is enabled.
- Run status.
- Model/provider id used for each run.
- References to applied document undo groups.
- Compaction and checkpoint availability.

Do not persist:

- API keys.
- Full shell output when it is huge.
- Full file contents unless required for conversation fidelity.
- Chain-of-thought or hidden reasoning.
- Transient approval promises.

Restoring a conversation rebuilds projections from the event store. When
execution starts, derive the active-path pi-ai `Message[]` through the adapter
and hydrate the underlying pi-agent-core `Agent`.

## Abort And Steering

Abort should be available whenever a run is active.

Abort behavior:

- Abort the model stream.
- Ask active tool commands to cancel if they support cancellation.
- Mark the run as cancelled.
- Keep completed messages and tool results immutable.

Steering uses pi-agent-core's steering queue in the current runtime. If the user
sends a new instruction while the agent is streaming, Lin queues it as steer
input for the active run instead of starting an unrelated run in the same
conversation.

Examples:

- "Stop editing files, just explain the plan."
- "Use the active node instead."
- "Do not run bash."

Follow-up remains a separate queue for work that should run after the current
run stops naturally. Persisted `follow_up.*` events are reserved for a later
pass; current queued follow-up and steer state are runtime state.

## Context Compaction

Lin should treat compaction as a product policy, not as a library detail.
Compaction is active in the runtime and has three entry points:

- manual `/compact [instructions]`
- proactive auto compact before a model call when estimated context crosses the configured threshold
- reactive compact after a provider context-length error, followed by a retry

Use cases:

- Conversation grows beyond model context.
- Tool outputs are large.
- The user switches from local file work back to outliner work.

Runtime strategy:

1. Persist single large tool outputs immediately after tool execution and send the model a fixed `<persisted-output>` preview.
2. Before each model call, enforce a per-tool-batch aggregate budget for fresh tool results only.
3. Never retroactively replace already-seen unreplaced tool results; that would change a cached prefix.
4. Time-based microcompact may clear old compactable tool results when the cache is expected to be cold.
5. Auto/reactive compact uses the same no-tools summary path as manual compact.
6. If the summary request itself hits a provider context limit, retry by dropping the oldest API-round groups before giving up.
7. Reactive compact preserves the latest user/tool tail after the compact root so the retry continues from the same pending work.
8. After compacting, restore recently read full text files within a bounded budget and reset file-edit freshness to only those restored files.
9. When deduplicating restored files against the preserved reactive tail, treat `file_unchanged` results as stubs, not as visible file content.

Large persisted tool outputs should follow the stable agent-runtime pattern: keep the full
output outside the transcript, record a fixed preview/reference string in the
message, and never re-decide or silently expand that payload during resume.

After compaction, use the Agent wrapper to replace the underlying pi-mono
messages. Persist both the compacted message and enough metadata to explain that
older context was summarized.

## Error Handling

Errors should be explicit and recoverable.

Model errors:

- Authentication failure.
- Rate limit.
- Context overflow.
- Provider unsupported tool call.
- Stream interruption.

Tool errors:

- Invalid arguments.
- Permission denied.
- Approval rejected.
- Path outside workspace.
- Command timeout.
- Output truncated.
- Document conflict.

Every tool error should be returned to the model as a tool result, not thrown
past the agent loop unless the runtime itself is broken. Runtime failures should
mark the run as failed and leave the transcript readable.

## Local Security

The local agent is powerful because it can edit files, run commands, and mutate
the outliner. TypeScript must enforce the boundary.

Baseline rules:

- Restrict file tools to the configured local file root unless the user
  explicitly grants broader access.
- Normalize and canonicalize paths in TypeScript.
- Enforce command timeout and output limits.
- Redact known secret patterns from tool output where possible.
- Require approval for destructive file and shell operations.
- Group document mutations into undoable transactions.
- Never let a renderer-only check be the final permission check.

## Implementation Status

Landed in main:

- pi-mono dependencies are pinned and isolated behind Lin's Electron main
  runtime boundary.
- `AgentRuntime` owns session lifecycle, prompt routing, stop/reset/branch
  commands, pi-agent-core subscriptions, provider debug capture, event append,
  projection emission, and checkpoint writes.
- `useLinAgentRuntime` consumes Lin-owned `AgentRuntimeEvent` /
  `AgentRenderProjection` data instead of pi-mono objects.
- Agent conversations persist through the event store, not through mutable
  pi-agent-core state.
- Active-path pi-ai `Message[]` is derived from replay state when a session is
  restored or a new run starts.
- Web, outliner, file, bash, and background-task tools execute through Lin's
  TypeScript main-process gateway.
- Large tool output and provider request/response debug data use event-store
  payload refs.
- Session list, search, user-message history, debug history/totals, and
  checkpoints are derived from the event store.

Remaining runtime work:

- Approval UI/runtime pause flow for risky tools.
- Persisted follow-up events.
- Performance metrics around replay, projection, IPC payload size, and long
  transcript rendering.
- Richer lazy media previews for non-text payloads in render/debug details.
- More explicit cancellation events once pi-agent-core abort semantics are mapped
  cleanly to Lin's `run.cancelled`.

## Testing

Current coverage should stay focused on the Lin-owned boundary:

- Event schema, replay, active path, branch selection, pi-ai message derivation,
  render projection, event store append ordering, checkpoint replay, corrupt
  checkpoint recovery, index rebuild, payload refs, and large-session behavior.
- Debug projection restore from `debug.snapshot.created` events plus debug
  payload refs.
- Tool argument validation, local path boundaries, bash timeout/output caps,
  node tool behavior, web tool normalization, and tool-result envelope mapping.
- Renderer runtime hydration, projection events, branch actions, streaming view
  state, and payload-backed copy behavior.
- E2E coverage for composer controls, model/settings behavior, process/tool
  disclosure, debug panel, virtualization, and bounded large-output rendering.

Next coverage should land with the corresponding runtime features:

- Approval pause/resume/reject flow.
- Persisted follow-up events.
- Compaction events and pi-mono message replacement.
- Explicit `run.cancelled` mapping.
- Performance metric event emission and analysis views.

## Migration Risk

Using pi-mono should not make Lin dependent on pi-mono forever.

Keep these interfaces stable:

- Lin-owned `AgentEvent`.
- Lin-owned `AgentRuntimeEvent`.
- Lin-owned `AgentRenderProjection`.
- Lin-owned tool schemas and result envelopes.
- Lin-owned Electron IPC command payloads.
- Lin-owned persisted conversation schema.

If Lin later moves to a TypeScript agent core, the replacement should only need to
implement the runtime adapter contract. Document tools, Electron IPC commands,
permissions, transcript rendering, and persistence should remain mostly intact.

## Summary

pi-mono should provide the agent brain: model abstraction, streaming, agent
loop, tool-call orchestration, and steering.

Lin should provide the local body: outliner operations, file operations, bash,
permissions, approvals, undo, persistence, and UI state.

This split gives Lin a fast path to a capable local agent without giving up
control over the local-first TypeScript core.
