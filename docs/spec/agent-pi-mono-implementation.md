# Agent Implementation With pi-mono

This document describes how Lin Outliner should implement the local agent
runtime using pi-mono as the agent core.

The goal is to reuse pi-mono for model/provider abstraction, streaming, and the
agent loop, while keeping Lin's local capabilities, document mutations, and
security boundaries in TypeScript.

## Decision

Lin should use these pi-mono packages:

- `pi-ai`: model/provider registry, message types, tool schema types, streaming,
  tool-call parsing, context overflow helpers.
- `pi-agent-core`: stateful agent loop, tool execution orchestration, steering,
  follow-up work, abort, subscriptions, and message replacement.

Lin should not directly use `pi-coding-agent` as the product agent runtime. Its
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

Lin's current product runtime is TypeScript/Electron only. Agent tools, outliner
mutation planning, outline parsing, preview rendering data, validation, undo
grouping, file access, bash execution, and web adapters should all be implemented
through TypeScript modules under Electron main and `src/core`. Do not introduce a
Rust-side parser or command bridge for the current architecture.

The pi-mono Agent should not live in the renderer once real models and tools are
enabled. The clean boundary is:

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

Install pi-mono packages as pinned dependencies. Do not use floating major or
minor versions until Lin has its own compatibility tests around the adapter.

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "0.x.y",
    "@earendil-works/pi-agent-core": "0.x.y"
  }
}
```

If pi-mono changes package ownership or names, keep the imports behind Lin's
own adapter modules so product code does not depend on package names directly.

Suggested module boundary:

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

Lin should wrap pi-agent-core inside Electron main process. Product UI talks to
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
  createSession(): Promise<AgentSession>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  resetSession(sessionId: string): Promise<void>;
  subscribe(listener: (event: LinAgentEvent) => void): () => void;
}
```

The boundary should expose Lin-owned runtime events, render projections,
attachment DTOs, debug DTOs, and UI state. Conversation content types should
reuse pi-ai block shapes where possible so Lin does not maintain a parallel,
shape-compatible copy of `TextContent` or `ImageContent`. Persisted conversation
identity, branching, tool lifecycle, approvals, and debug records are Lin-owned
event-log concepts, not pi-mono runtime state.

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
- Temperature and max token defaults.

The API key should be read at stream time through Lin's TypeScript credential path. It
should not be embedded into persisted agent messages, tool results, renderer
state, or IPC command payloads.

Lin does not need OS keychain for the first implementation. Use app-data files
owned by TypeScript:

```txt
agent-providers.json
  -> activeProviderId
  -> providers: providerId, modelId, baseUrl, enabled

agent-secrets.json
  -> providerId -> apiKey
  -> local only, private file permissions where the OS supports it
```

Renderer-facing commands may return provider configuration and `hasApiKey`, but
must not return the API key itself. Runtime provider resolution should happen
through Electron AgentRuntime or the TypeScript tool/provider gateway.

## System Prompt

Lin follows the same prompt layering principle as cc-2.1:

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
  -> transformContext can inject reminders or compact old messages
```

Use pi-mono's context overflow helper for detection, but keep Lin's compaction
policy separate so it can preserve outliner-specific anchors.

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

Lin should use nodex as the outliner reference and cc-2.1 as the local tool
reference. Lin should still keep its own lower snake case tool names because the
runtime, permission model, and UI are Lin-owned.

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

cc-2.1 core tools:

- `Bash`
- `Read`
- `Edit`
- `Write`
- `Glob`
- `Grep`
- `WebFetch`
- `WebSearch`
- `TodoWrite`
- `Skill`
- `AskUserQuestion`
- `Agent`
- `TaskStop`
- `EnterPlanMode`
- `ExitPlanMode`
- `ListMcpResources`
- `ReadMcpResource`

cc-2.1 is the strongest reference for tool contracts, permission checks, and
tool pool filtering. For local tools, Lin should copy the role boundaries,
descriptions, argument schemas, and model-visible action payloads as closely as
possible. Runtime details can keep Lin's common `ToolResult` envelope, but
`node_*` model-visible output should use the discriminated node protocol from
`agent-tool-design.md` rather than exposing the envelope directly:

The bridge to pi-agent-core must remain native: tool `execute` returns
`AgentToolResult` content/details only, while Lin's shared `afterToolCall`
adapter maps envelope errors (`details.ok === false`) to
`ToolResultMessage.isError = true`.

- Dedicated file tools should be preferred over shell commands.
- `Read` is the freshness prerequisite for `Edit` and existing-file `Write`.
- `Edit` is exact string replacement, not a custom patch protocol.
- `Glob` finds paths; `Grep` searches contents.
- `Bash` runs commands and can background long-running work.
- `TaskStop` only stops a background task; it is not a generic process manager.
- Large command output should be persisted and then read through the file tool.

Lin should not configure `AskUserQuestion` for v1. The assistant can ask the
user in normal chat when clarification is needed. Web access should instead be
covered by `web_search` and `web_fetch`.

## Lin Tool Registry

Lin should start with a compact, stable tool registry and add higher-risk tools
only after approval, rendering, and undo are solid.

The detailed tool contract, parameter schema, and result envelope are defined in
`docs/spec/agent-tool-design.md`. This document only describes how those tools
fit into the pi-mono runtime.

### P0 Tools

These tools should be configured first.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `node_search` | nodex `node_search`, Lin search-node outline | Yes | No | Execute a temporary or saved search node outline without mutating document state. |
| `node_read` | nodex `node_read` | Yes | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | nodex `node_create`, Lin outline parser | Yes | Usually yes | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | cc `Edit`, nodex `node_edit`, Lin outline parser | Yes | Usually yes | Edit a known node's annotated outline by exact replacement, or perform explicit move, merge, or reference replacement. |
| `node_delete` | nodex `node_delete` | Yes | Usually yes | Trash or restore nodes. |
| `operation_history` | nodex `undo`, Lin history | Yes | Depends | List, undo, or redo user and agent operations. |
| `file_read` | cc `Read` | Yes | Usually no | Read files with bounded output and freshness tracking. |
| `file_glob` | cc `Glob` | Yes | No | Find files by path pattern. |
| `file_grep` | cc `Grep` | Yes | No | Search file contents with bounded output. |
| `file_edit` | cc `Edit` | Yes | Yes | Perform exact string replacement after reading the file. |
| `file_write` | cc `Write` | Yes | Yes | Create files or rewrite whole files. |
| `bash` | cc `Bash` | Yes | Usually yes | Run local commands with timeout, approval, and output limits. |
| `task_stop` | cc `TaskStop` | Yes | Usually yes | Stop background commands created by `bash`. |
| `web_search` | cc `WebSearch`, lin-agent `WebSearch` | Optional | Depends | Search the web for current external information. |
| `web_fetch` | cc `WebFetch`, lin-agent `WebFetch` | Optional | Depends | Fetch and read a specific URL with pagination or snippet search. |

P0 intentionally follows nodex's compact outliner surface instead of exposing
one tool per UI command. Tag, field, reference, move, and merge behavior
belong inside `node_create` and `node_edit` semantics, not separate `node_tag`,
`node_field`, or `node_move` tools.

### P1 Tools

Add these once P0 is reliable.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `past_chats` | nodex `past_chats` | Yes | No | Search and read older Lin agent conversations. |

`task_stop` belongs in P0 only if Lin enables `bash.run_in_background`. If Lin
ships foreground-only `bash` first, keep `task_stop` disabled until background
commands exist.

### P2 Tools

These should wait until the product needs them.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `browser` | nodex `browser` | Yes | Usually yes | Control an embedded browser tab if Lin adds one. |
| `mcp_list_resources` | cc `ListMcpResources` | Yes | No | Discover MCP resources. |
| `mcp_read_resource` | cc `ReadMcpResource` | Yes | No | Read MCP resources. |
| `mcp_call_tool` | cc MCP tools | Yes | Depends | Call configured MCP server tools. |
| `todo_write` | cc `TodoWrite` | No | No | Maintain internal task plans if agent planning needs a tool. |
| `skill` | cc `Skill` | Partly | Depends | Load and invoke local skill folders. |
| `sub_agent` | cc `Agent` | Mixed | Depends | Spawn child agents. Not needed for Lin v1. |

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

- cc-style `Read` / `Edit` / `Write`: those names are canonical inside Claude
  Code, but Lin should make the local capability explicit.
- generic mutation tools such as `outliner_write`, `outliner_apply_patch`, or
  `node_batch`: they force the model to learn a second mini-protocol and make
  permission boundaries less clear.

The first implementation should configure only the P0 tools listed above.
Additional tools should be added by phase, not because a reference project has
them.

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
  -> AgentStore records approval row
  -> tool promise waits
  -> user approves or rejects
  -> adapter resolves tool result
  -> pi-agent-core continues
```

Rejected tools should return a normal tool result that says the user denied the
operation. The agent can then explain or propose a safer alternative.

## Event Mapping

pi-mono events should be normalized into Lin events before they reach storage,
debug, or renderer components. The canonical event-store architecture lives in
`docs/spec/agent-event-log-rendering.md`.

Lin event categories:

- `run_started`
- `message_started`
- `message_delta`
- `message_completed`
- `tool_call_started`
- `tool_call_delta`
- `tool_call_completed`
- `tool_call_failed`
- `approval_requested`
- `approval_resolved`
- `run_completed`
- `run_failed`
- `run_cancelled`

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
- Approval lifecycle.
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

Restoring a conversation should rebuild projections from the event store. When
execution starts, derive the active-path pi-ai `Message[]` through the adapter
and hydrate the underlying pi-agent-core `Agent`.

## Abort And Steering

Abort should be available whenever a run is active.

Abort behavior:

- Abort the model stream.
- Ask active tool commands to cancel if they support cancellation.
- Mark the run as cancelled.
- Keep completed messages and tool results immutable.

Steering should use pi-agent-core's steering support. If the user sends a new
instruction while tools are running, Lin should queue it as a steering message
instead of starting an unrelated run in the same conversation.

Examples:

- "Stop editing files, just explain the plan."
- "Use the active node instead."
- "Do not run bash."

Steering should be visible in the transcript as a user intervention.

## Context Compaction

Lin should treat compaction as a product policy, not as a library detail.

Use cases:

- Conversation grows beyond model context.
- Tool outputs are large.
- The user switches from local file work back to outliner work.

Recommended strategy:

1. Keep the latest user request and active tool results intact.
2. Keep document anchors such as node ids, titles, and paths.
3. Summarize old assistant text.
4. Replace large tool outputs with summaries and stable references.
5. Drop low-value middle turns only after summarization.

Large persisted tool outputs should follow the cc-2.1 pattern: keep the full
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

## Implementation Phases

Phase 0: nodex agent UI audit

- Clone or mount the nodex repo under `.research-repos/nodex`.
- Inventory the agent UI entry points: dock shell, header, input composer,
  transcript, message rows, tool call rows, approval rows, error rows, model/menu
  controls, and persistence hooks.
- Identify which components are pure presentation and can be reused directly.
- Identify which components assume nodex tool names, message shapes, approval
  payloads, or outliner-specific state.
- Produce a reuse map before implementation: copy, adapt, replace, or ignore.
- Do not start porting UI until the hard-coded nodex tool-contract assumptions
  are known.

Phase 1: pi-mono runtime + nodex UI shell

- Add pi-mono dependencies.
- Create Electron main-process `AgentRuntime`.
- Create the renderer agent runtime hook/store.
- Reuse or adapt nodex agent UI for the dock header, input composer, transcript
  stream, message rows, tool call cards, and error states.
- Support one provider and one model.
- Stream assistant text into the agent dock.
- Support abort.
- Persist enough conversation state to restore the UI shell.

Phase 2: web search and fetch tools

- Add `web_search` and `web_fetch`.
- Render search and fetch tool calls in the transcript.
- Add host permission and offline/private-mode checks.
- Add HTML-to-markdown extraction, pagination, and find mode for fetched pages.
- Keep long search/fetch results collapsed by default.

Phase 3: outliner node tools

- Add current UI work-context injection from system reminders.
- Add `node_search`, `node_read`, `node_create`, `node_edit`, `node_delete`, and
  `operation_history`.
- Implement Lin Outline parser, search-node outline parser, validation,
  mutation planning, and preview data.
- Render node tool previews and approval rows using Lin `ToolPreview`.
- Apply mutations through Electron IPC commands.
- Group mutations into undoable transactions.
- Keep agent state outside document projection.

Phase 4: local file and bash tools

- Added `file_read`, `file_glob`, `file_grep`, `file_edit`, and `file_write`
  through a TypeScript main-process local tool gateway.
- Expanded `file_read` with image dimensions, `.ipynb` parsing, and cc-style PDF
  page rendering through `pdfinfo`/`pdftoppm`. When `pdftotext` can extract text
  from the selected pages, the text is attached before rendered page images.
  Rendered PDF pages are still attached as image blocks because pi-agent-core
  currently supports text/image tool-result content, not native PDF document
  blocks.
- Switched `file_grep` to a ripgrep-backed implementation with cc-style output
  modes, relative paths, pagination, glob/type filters, and explicit multiline
  support.
- `file_glob` now returns local-root-relative paths to match `file_grep` and cc
  path ergonomics.
- Added `bash` with timeout, background mode, output caps, and output
  persistence under `tmp/agent-tool-outputs`. Background output files include
  task status, exit code, timestamps, stdout, and stderr.
- Added `task_stop` for background commands created by Lin's own `bash` tool.
- Remaining work: approval rendering, richer diff previews, background
  completion events, and collapsed large-output UI.

Cross-phase: persistence and compaction

- Persist conversations and run summaries once the UI shell is stable.
- Restore pi-mono messages through the adapter.
- Add context overflow detection and compaction before long-running workflows are
  enabled by default.
- Add tests around event normalization and tool result conversion.

## Testing

Unit tests:

- Tool argument validation.
- Tool result normalization.
- Event mapping from pi-mono to Lin events.
- Context builder token and size limits.
- Approval policy classification.

core tests:

- Path boundary enforcement.
- Bash timeout and output truncation.
- Outliner patch application and undo grouping.
- Document conflict handling.

Integration tests:

- User asks a question and receives streamed text.
- Agent reads active node context.
- Agent proposes an outliner edit and waits for approval.
- User rejects a tool call and agent continues gracefully.
- User aborts during model streaming.
- User aborts during a long-running bash command.
- Large tool output does not freeze the agent dock.

## Migration Risk

Using pi-mono should not make Lin dependent on pi-mono forever.

Keep these interfaces stable:

- Lin-owned `AgentEvent`.
- Lin-owned `AgentMessage`.
- Lin-owned `AgentToolDefinition`.
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
