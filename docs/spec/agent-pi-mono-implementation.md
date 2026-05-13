# Agent Implementation With pi-mono

This document describes how Lin Outliner should implement the local agent
runtime using pi-mono as the agent core.

The goal is to reuse pi-mono for model/provider abstraction, streaming, and the
agent loop, while keeping Lin's local capabilities, document mutations, and
security boundaries in Rust.

## Decision

Lin should use these pi-mono packages:

- `pi-ai`: model/provider registry, message types, tool schema types, streaming,
  tool-call parsing, context overflow helpers.
- `pi-agent-core`: stateful agent loop, tool execution orchestration, steering,
  follow-up work, abort, subscriptions, and message replacement.

Lin should not directly use `pi-coding-agent` as the product agent runtime. Its
built-in terminal tools are useful implementation references, but Lin's tools
must execute through the Rust command bridge so file access, bash execution,
document mutation, undo, approval, and workspace boundaries stay under Lin's
control.

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

Lin TypeScript adapter
  -> creates Agent
  -> maps pi-mono events into AgentStore
  -> exposes Lin tools as AgentTool[]
  -> invokes Rust commands for local operations

Lin Rust backend
  -> bash execution
  -> file operations
  -> outliner reads and mutations
  -> permissions and approval policy
  -> persistence and undo grouping
```

## Runtime Boundary

The agent dock remains a cross-tab shell feature. It owns conversation state and
rendering. The outliner owns document state and panel state.

The pi-mono Agent should live in the renderer-side agent runtime because Lin is
a Tauri and React application and pi-mono is TypeScript-native. This keeps
streaming events close to the agent panel and avoids introducing a second local
server.

Rust remains the authority for every operation that touches the local machine or
document state.

```txt
Agent input
  -> LinAgentRuntime.prompt()
  -> pi-agent-core Agent
  -> pi-ai stream
  -> tool calls
  -> Lin AgentTool adapter
  -> Tauri command
  -> Rust command handler
  -> lin-core / filesystem / shell
  -> tool result
  -> pi-agent-core continues loop
  -> AgentStore event log
```

The renderer may hold transient agent state, but it must not directly mutate
documents, files, or process state.

## Package Usage

Install pi-mono packages as pinned dependencies. Do not use floating major or
minor versions until Lin has its own compatibility tests around the adapter.

```json
{
  "dependencies": {
    "@mariozechner/pi-ai": "0.x.y",
    "@mariozechner/pi-agent-core": "0.x.y"
  }
}
```

If pi-mono changes package ownership or names, keep the imports behind Lin's
own adapter modules so product code does not depend on package names directly.

Suggested module boundary:

```txt
src/renderer/agent/
  runtime.ts              # owns Agent lifecycle
  piMonoAdapter.ts        # imports pi-ai / pi-agent-core
  tools.ts                # builds AgentTool[]
  events.ts               # maps pi-mono events into Lin events
  context.ts              # builds active workspace context
  store.ts                # AgentStore reducer/external store
  approvals.ts            # approval state and deferred tool resolution
```

Only `piMonoAdapter.ts` should import pi-mono directly where practical.

## Agent Runtime

Lin should wrap pi-agent-core in a small `LinAgentRuntime` class. Product UI
should talk to this wrapper instead of a raw pi-mono Agent.

Responsibilities:

- Create and configure the pi-mono `Agent`.
- Set the active model, system prompt, and tool list.
- Start prompts and continue interrupted runs.
- Abort active runs.
- Apply steering messages from the user.
- Replace messages after compaction or conversation restore.
- Subscribe to Agent events and write normalized events into `AgentStore`.

Conceptual shape:

```ts
interface LinAgentRuntime {
  prompt(input: AgentPromptInput): Promise<void>;
  continue(): Promise<void>;
  abort(): void;
  steer(message: string): void;
  setModel(modelId: string): void;
  setTools(context: LinToolContext): void;
  restoreConversation(conversation: AgentConversation): void;
}
```

The wrapper should expose Lin-owned types at the boundary. pi-mono message and
event types should not leak throughout the UI.

## Model Configuration

Lin should use `pi-ai` for known provider and model metadata, but Lin should own
the user's provider settings.

Model configuration should include:

- Provider id.
- Model id.
- API key reference or local secret key name.
- Optional base URL.
- Optional API protocol override for OpenAI-compatible providers.
- Reasoning level if the selected model supports it.
- Temperature and max token defaults.

The API key should be read at stream time through Lin's credential path. It
should not be embedded into persisted agent messages or tool results.

For the first local implementation, the renderer can call pi-ai directly with
the key resolved from Tauri. If later security requirements tighten, streaming
can move behind a Rust command or local proxy without changing the tool boundary.

## System Prompt

The system prompt should define Lin-specific behavior, not generic coding-agent
behavior.

It should state:

- Lin is a local-first outliner.
- The agent can read and edit the current workspace only through tools.
- The active tab and active panel are default context, not global truth.
- Mutations must preserve document structure and use narrow edits.
- Risky or broad mutations may require approval.
- The agent should prefer structured outliner tools for document work.
- The agent may use bash and file tools only when the user asks for local
  workspace operations or when the task clearly requires them.

Avoid putting implementation details such as React component names or internal
Rust function names into the system prompt unless a tool needs them.

## Context Construction

Each prompt should include a compact context block built by Lin, not by pi-mono.

Default context:

- Current workspace id and name.
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
  -> context.ts builds active workspace context
  -> runtime sends messages to Agent
  -> transformContext can inject reminders or compact old messages
```

Use pi-mono's context overflow helper for detection, but keep Lin's compaction
policy separate so it can preserve outliner-specific anchors.

## Tool Model

All tools exposed to pi-agent-core should be Lin tools. A tool is a TypeScript
adapter around a Tauri command.

```txt
AgentTool.execute(args)
  -> validate args
  -> check approval policy
  -> invoke Tauri command
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
For `node_*` tools, Lin should copy nodex's descriptions, parameter names, and
model-visible result payloads as closely as possible. In particular,
`node_create.text` and `node_edit.text` should use nodex's outliner text parser
contract, implemented in Rust rather than left as prompt-only behavior. Lin
should also include the outliner paste normalization layer documented in
`agent-tool-design.md`, but that compatibility behavior belongs in the
adapter/runtime layer and should not appear in the model-facing tool
description. Lin code should use neutral parser names such as
`outliner_text_parser`.

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
descriptions, argument schemas, and model-visible `data` payloads as closely as
possible. Lin should only change the public names and wrap results in its common
`ToolResult` envelope:

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

| Tool | Reference | Rust-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `node_search` | nodex `node_search` | Yes | No | Search nodes by text, tag, field, date, link, or subtree. |
| `node_read` | nodex `node_read` | Yes | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | nodex `node_create` | Yes | Usually yes | Create content trees, references, search nodes, or duplicates. |
| `node_edit` | nodex `node_edit`, Lin scoped multi-edit | Yes | Usually yes | Incrementally edit one or more known nodes: content, tags, fields, done state, position, data, or merge. |
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

| Tool | Reference | Rust-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `past_chats` | nodex `past_chats` | Yes | No | Search and read older Lin agent conversations. |

`task_stop` belongs in P0 only if Lin enables `bash.run_in_background`. If Lin
ships foreground-only `bash` first, keep `task_stop` disabled until background
commands exist.

### P2 Tools

These should wait until the product needs them.

| Tool | Reference | Rust-backed? | Approval | Purpose |
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

## Rust Tool Commands

Rust command handlers should be the only place where local side effects happen.

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
- active workspace id
- active tab context if relevant

Each command should return:

- `ok`
- structured `data` when successful
- structured `error` when failed
- optional `preview` for UI rendering
- optional `operation` with `undoGroupId` for document mutations
- optional `requiresApproval` for deferred execution

Rust should validate paths, workspace boundaries, command timeouts, output size,
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
  -> adapter asks Rust for preview or risk classification
  -> AgentStore records approval row
  -> tool promise waits
  -> user approves or rejects
  -> adapter resolves tool result
  -> pi-agent-core continues
```

Rejected tools should return a normal tool result that says the user denied the
operation. The agent can then explain or propose a safer alternative.

## Event Mapping

pi-mono events should be normalized into Lin events before they reach the
renderer components.

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

The raw pi-mono event can be kept in the run event log for debugging, but UI
components should render from Lin's normalized event model.

This keeps the transcript renderer independent from pi-mono and makes future
migration to a Rust agent core or another library possible.

## State Persistence

Agent conversations are not workspace tabs. They belong to shell-level agent
state.

Persist:

- Conversation metadata.
- User and assistant messages.
- Tool call summaries.
- Tool result summaries.
- Run status.
- Model/provider id used for each run.
- References to applied document undo groups.

Do not persist:

- API keys.
- Full shell output when it is huge.
- Full file contents unless required for conversation fidelity.
- Chain-of-thought or hidden reasoning.
- Transient approval promises.

Restoring a conversation should rebuild pi-mono messages through the adapter and
call `replaceMessages` on the underlying Agent.

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
the outliner. Rust must enforce the boundary.

Baseline rules:

- Restrict file tools to the active workspace unless the user explicitly grants
  broader access.
- Normalize and canonicalize paths in Rust.
- Enforce command timeout and output limits.
- Redact known secret patterns from tool output where possible.
- Require approval for destructive file and shell operations.
- Group document mutations into undoable transactions.
- Never let a renderer-only check be the final permission check.

## Implementation Phases

Phase 1: Runtime skeleton

- Add pi-mono dependencies.
- Create `LinAgentRuntime`.
- Create `AgentStore`.
- Support one provider and one model.
- Stream assistant text into the agent dock.
- Support abort.

Phase 2: Outliner read tools

- Add active context and node read tools.
- Build bounded context injection.
- Render tool calls in the transcript.
- Keep agent state outside document projection.

Phase 3: Outliner mutations

- Add patch preview.
- Add approval rows.
- Apply mutations through Rust commands.
- Group mutations into undoable transactions.

Phase 4: Local file and bash tools

- Add `file_read`, `file_glob`, `file_grep`, `file_edit`, and `file_write`.
- Add `bash` with timeout, background mode, output persistence, and approval
  policy.
- Add `task_stop` if background `bash` is enabled.
- Render large outputs collapsed by default.

Phase 5: Persistence and compaction

- Persist conversations and run summaries.
- Restore pi-mono messages through the adapter.
- Add context overflow detection and compaction.
- Add tests around event normalization and tool result conversion.

## Testing

Unit tests:

- Tool argument validation.
- Tool result normalization.
- Event mapping from pi-mono to Lin events.
- Context builder token and size limits.
- Approval policy classification.

Rust tests:

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
- Lin-owned Rust command payloads.
- Lin-owned persisted conversation schema.

If Lin later moves to a Rust agent core, the replacement should only need to
implement the runtime adapter contract. Document tools, Rust commands,
permissions, transcript rendering, and persistence should remain mostly intact.

## Summary

pi-mono should provide the agent brain: model abstraction, streaming, agent
loop, tool-call orchestration, and steering.

Lin should provide the local body: outliner operations, file operations, bash,
permissions, approvals, undo, persistence, and UI state.

This split gives Lin a fast path to a capable local agent without giving up
control over the local-first Rust core.
