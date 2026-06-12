# Agent Implementation With pi-mono

This document describes Tenon's current local agent runtime boundary with
pi-mono as the agent core.

The goal is to reuse pi-mono for model/provider abstraction, streaming, and the
agent loop, while keeping Tenon's local capabilities, document mutations, and
security boundaries in TypeScript.

## Decision

Tenon uses these pi-mono packages:

- `pi-ai`: model/provider registry, message types, tool schema types, streaming,
  tool-call parsing, context overflow helpers.
- `pi-agent-core`: stateful agent loop, tool execution orchestration, steering,
  follow-up work, abort, subscriptions, and message replacement.

Tenon does not directly use `pi-coding-agent` as the product agent runtime. Its
built-in terminal tools are useful implementation references, but Tenon's tools
must execute through the Electron IPC command bridge so file access, bash execution,
document mutation, undo, approval, and workspace boundaries stay under Tenon's
control.

The canonical persistence/rendering/debug model is defined in
`docs/spec/agent-event-log-rendering.md`. pi-mono remains the execution core;
Tenon's durable state is the event log plus referenced payload files.

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

Tenon Electron main process
  -> creates Agent
  -> maps pi-mono events into Tenon events and render projections
  -> exposes Tenon tools as AgentTool[]
  -> calls TypeScript tool gateway for local operations

Tenon Electron main process
  -> AgentRuntime session lifecycle
  -> API key / credential storage
  -> bash execution
  -> file operations
  -> outliner reads and mutations
  -> permissions and approval policy
  -> persistence and undo grouping

Tenon renderer
  -> Agent UI only
  -> sends prompt/stop/approve commands
  -> renders shared AgentRuntimeEvent projections
```

## Runtime Boundary

The agent dock remains a cross-tab shell feature. It owns conversation state and
rendering. The outliner owns document state and panel state.

Tenon's product runtime is TypeScript/Electron only. Agent tools, outliner
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
or directly execute model/tool logic. This keeps a future Tenon-owned agent core
possible: it only needs to implement the AgentRuntime event/command contract.

## Package Usage

pi-mono packages are pinned dependencies. Do not use floating major or minor
versions until Tenon has its own compatibility tests around the adapter.

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "0.74.0",
    "@earendil-works/pi-agent-core": "0.74.0"
  }
}
```

If pi-mono changes package ownership or names, keep the imports behind Tenon's
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
  # target-oriented agent event-log storage and payload/checkpoint layout

src/preload/index.ts
  # exposes typed command and event bridge to the renderer

src/renderer/agent/
  runtime.ts              # UI client for Electron AgentRuntime
```

Only Electron main process agent modules should import pi-mono directly.
Renderer and preload code should depend on shared Tenon-owned DTOs from
`src/core/agentTypes.ts`, not pi-mono package types and not renderer-owned
types.

## Agent Runtime

Tenon wraps pi-agent-core inside Electron main process. Product UI talks to
Electron AgentRuntime through a renderer `useLinAgentRuntime` client, never to a raw
pi-mono Agent.

Responsibilities:

- Electron main process: create and configure the pi-mono `Agent`.
- Electron main process: set the active model, system prompt, and tool list.
- Electron main process: start conversations, route prompts, stop runs, and manage runtime lifecycle.
- Electron main process: resolve API keys at stream time.
- Electron main process: execute or reject every local tool call.
- Electron main process: subscribe to Agent events and append normalized Tenon events.
- Electron main process: derive render/debug/pi-mono projections from the event store.
- Renderer: render projections and send user intents.

Conceptual shape:

```ts
interface AgentRuntimeClient {
  restoreLatestConversation(): Promise<AgentConversation>;
  restoreConversation(conversationId: string): Promise<AgentConversation>;
  createConversation(): Promise<AgentConversation>;
  closeConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, message: string, attachments?: AgentMessageAttachmentInput[]): Promise<void>;
  editMessage(conversationId: string, nodeId: string, message: string): Promise<void>;
  regenerateMessage(conversationId: string, nodeId: string): Promise<void>;
  retryMessage(conversationId: string, nodeId: string): Promise<void>;
  switchBranch(conversationId: string, nodeId: string): Promise<void>;
  queueFollowUp(conversationId: string, message: string): Promise<{ queued: boolean }>;
  clearFollowUp(conversationId: string): Promise<void>;
  stopConversation(conversationId: string): Promise<void>;
  onEvent(listener: (event: AgentRuntimeEvent) => void): (() => void) | null;
}
```

The boundary exposes Tenon-owned runtime events, render projections,
attachment DTOs, debug DTOs, and UI state. Conversation content types should
reuse pi-ai block shapes where possible so Tenon does not maintain a parallel,
shape-compatible copy of `TextContent` or `ImageContent`. Persisted conversation
identity, branching, tool lifecycle, approvals, and debug records are Tenon-owned
event-log concepts, not pi-mono runtime state.

Session listing, rename/delete, debug history, debug payload reads, payload text
reads, reset, and provider settings are separate Electron IPC commands that use
the same Tenon-owned DTO boundary.

## Local File Mentions

The composer may insert local files, folders, and images as inline mention
atoms. The user-facing editor and transcript render these as natural `@name`
tokens. Path-backed local files and folders use structured model-facing
positional markers: `[[file:<label>^<path>]]`. The `path` value is
percent-encoded in the marker. Images also get a normal file marker; their
image bytes are sent separately as pi-ai image content blocks. Attachments
without a stable local path are staged under the agent local file root first, so
the model-facing marker still points at a path that local file tools can read.

`label` is a stable, human-readable reference for one user turn. It is derived
from the selected file name, sanitized to one line, and de-duplicated within the
turn when multiple attachments would otherwise collide. The marker value is the
local path; renderer-only attachment ids may exist for editing and deletion, but
they must not be required for model interpretation.

Normal new turns do not include hidden `<user-attachments>` JSON. The
`[[file:<label>^<path>]]` marker is the model-visible resource contract. Runtime
attachment payloads are still used internally for image content blocks,
renderer-to-main staging, materialized paths, and historical transcript replay.

When the user writes `[[file:<label>^<path>]]`, the agent should use the
percent-decoded path. Image attachments are also visible as image content
blocks. Local files and folders are available by path and should be inspected
with `file_read` or `file_glob`; the model should not assume file contents are
already present.

Clipboard images and temporary files follow the same contract: Tenon materializes
or inlines the data as needed, gives it a friendly `ref`, and records enough
hidden context for the model to resolve that `ref`.

## Model Configuration

Tenon should use `pi-ai` for known provider and model metadata, but Tenon should own
the user's provider settings.

Multimodal user turns should use pi-ai's native `ImageContent` shape:
`{ type: "image", data: base64, mimeType }`. Provider adapters then translate
the same Tenon message to Anthropic base64 image blocks, OpenAI image URLs,
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

The API key should be read at stream time through Tenon's TypeScript credential path. It
should not be embedded into persisted agent messages, tool results, renderer
state, or IPC command payloads.

Tenon currently stores provider settings and secrets in app-data files owned by
TypeScript:

```txt
agent-providers.json
  -> activeProviderId
  -> agent: runtime agent settings
  -> providers: providerId, modelId, baseUrl, enabled

agent-secrets.json
  -> credentials: providerId -> AuthCredential
       AuthCredential = { type: 'api_key'; key }
                      | ({ type: 'oauth' } & OAuthCredentials)   // refresh/access/expires
  -> local plaintext JSON with private file permissions (`0600`) where the OS
     supports it; never written to the document, renderer state, or agent logs
```

Renderer-facing commands may return provider configuration plus an `auth`
descriptor (`authKind`, `credentialed`, `hasStoredKey`, oauth `connected` /
`expiresAt`), but must never return the API key, OAuth access/refresh token, AWS
credential, or ADC material itself. Runtime provider resolution happens through
Electron AgentRuntime or the TypeScript tool/provider gateway — see
[Provider Authentication](#provider-authentication).

## Provider Authentication

pi-ai recognizes three credential classes, and Tenon presents each correctly
instead of modeling every provider as "paste an API key":

1. **API key** — most providers. A user-pasted key persists in
   `agent-secrets.json`; `getEnvApiKey(provider)` supplies an ambient env key.
2. **OAuth sign-in** — Anthropic (Claude Pro/Max), GitHub Copilot, OpenAI Codex.
   pi-ai ships the flows (`getOAuthProvider(id)`); Tenon orchestrates them and
   stores the resulting `OAuthCredentials` (`{ refresh, access, expires }`).
3. **Managed / ambient** — Amazon Bedrock (AWS profiles/IAM) and Google Vertex
   (gcloud ADC). No key field applies; the pi-ai api client reads ambient
   credentials at request time.

`authKind` (`'api-key' | 'oauth' | 'managed'`) is classified in main from
`getOAuthProviders()` plus a small managed set, defaulting to `api-key`, and
flows to the renderer on the provider view models so the UI never hardcodes the
classification.

### Single credential resolver

`getProviderApiKey(providerId)` is the one resolution path, used at stream time
and by connection validation. It never throws — a failure resolves to "no key".
Resolution order:

1. a stored `api_key` credential (user-pasted);
2. a stored `oauth` credential → `getOAuthApiKey(...)`, which auto-refreshes and
   returns a fresh key; the rotated `OAuthCredentials` are persisted back;
3. `getEnvApiKey(provider)` (an ambient env key, or the managed sentinel for
   Bedrock/Vertex);
4. otherwise undefined — the api client falls back to ambient credentials.

The resolver is wired as pi-agent-core's per-call `getApiKey` hook, so OAuth
tokens refresh transparently across a long run.

### Login flow (main owns it)

pi-ai's loopback flow binds `http.createServer` and is intended for non-browser
environments — the Electron **main** process. Main runs
`getOAuthProvider(id).login(callbacks)`; a pure orchestration (`agentOAuth.ts`)
bridges pi-ai's callbacks to the renderer as a single `OAuthLoginEvent` union
over one push channel, correlates the reply-needed steps (`prompt` / `select` /
`manual-code`) by `requestId`, and supports cancellation via an
`AbortController`. The production composition root (`agentOAuthManager.ts`)
injects the real provider lookup and secret-store persistence, so the
orchestration carries no native dependency and is unit-testable with fakes.

IPC: `agent_oauth_login(providerId)` resolves with the updated
`AgentProviderSettingsView` after persisting credentials;
`agent_oauth_logout(providerId)` drops the stored credential;
`agent_oauth_respond(requestId, value)` answers a reply step (undefined =
cancel); `agent_oauth_cancel(providerId)` aborts an in-flight sign-in. The
interactive events are pushed renderer-bound on `lin-agent-oauth-event`.

Sign-in, sign-out, token storage, and raw key entry are runtime-owned,
user-gated paths. The agent may read auth state (`authKind`, `connected`,
`expiresAt`, health) and propose provider/model switches, but never initiates a
login, persists a credential from model-generated text, writes the secret file,
or sees a raw key / token / AWS credential / ADC material in any tool result or
event log.

### Provider detail UI states

- **api-key** — the key field + base URL. Unchanged.
- **oauth, disconnected** — a "Sign in with <Provider>" button; Anthropic also
  offers "use an API key instead" (it accepts both).
- **oauth, in progress** — device-code (code + verification URL + TTL countdown)
  or loopback ("open the sign-in page"), plus the interactive prompt / select /
  manual-code steps and a cancel control.
- **oauth, connected** — a neutral "Connected" confirmation with the relative
  renewal time, plus "Sign out" and "Re-authenticate".
- **managed** — the guidance note + docs link; no key field.

Usability (`canChooseModels`, active-provider resolution) treats oauth-connected
and managed providers as credentialed via a single `auth.credentialed` signal,
not "has a pasted key".

### Provider rows are deliberate; state cannot contradict

A row in `agent-providers.json` means the user deliberately added a provider — it
is never a side effect of saving unrelated settings. Two rules keep `configured`
(has a row) and `credentialed` (has a usable key / oauth / env key) from diverging
into the "needs a key, yet offers *Remove provider*" contradiction:

- **Row creation lives in one place.** Only the per-provider config window
  (`upsertProviderConfig`, after the credential is stored) and the OAuth login
  (`ensureProviderConfig`, after the credential is persisted) create or edit a
  provider row. The main Settings pane's Save persists only runtime settings
  (permissions / skills / agents); it never upserts a provider. An upsert has no
  auto-activation side effect — a provider becomes active only on a deliberate
  user action, or via the active-provider fallback at read time (the first
  credentialed row), which the startup reconcile below later persists.

- **Reconcile once at startup, never on the read path.** `reconcileProviderConfig`
  runs as a fire-and-forget step in `app.whenReady` (not inside
  `getProviderSettings`, which is a pure read). It prunes a *junk* row and repoints
  a now-dangling `activeProviderId`, persisting only when something changed. Two
  invariants keep a transient or ambient signal from becoming permanent data loss:

  - **Unreadable secrets => do nothing.** If the secrets file can't be read,
    reconcile prunes nothing and writes nothing; the credential picture is
    unknown. It reads via `readSecretsWithStatus` (reports `readable`), never the
    degrading `readSecretFileSafe`.
  - **Prune only on durable signals.** A row is *junk* only if it is a plain
    `api-key`-kind catalog row with **no stored secret-file credential and no
    `baseUrl`**. Managed (Bedrock/Vertex) and oauth kinds are exempt outright, and
    ambient `getEnvApiKey` is **not** consulted — a Finder/Dock launch inherits no
    shell env, so judging on env would delete a deliberate row whenever the env
    happens to be absent. `activeProviderId` is repointed only when unset or
    structurally dangling (no surviving row by that id), targeting the first row
    with a durable stored credential; read paths
    (`resolveUsableActiveProvider` / `getActiveProviderRuntimeConfig`) still fall
    back through env/managed at runtime.

  A legit keyless row (a local `baseUrl`) survives. This makes the contradiction
  structurally impossible — a junk uncredentialed row has no row after the next
  launch — rather than papering over it in the renderer, while keeping it off the
  read path so a write never races concurrent writers. Per the pre-launch
  no-migration policy this reconcile (plus a dev `userData` wipe) is the only
  cleanup; there is no versioned migration.

## System Prompt

Tenon follows the prompt layering principle used by stable agent runtimes:

- The stable system prompt defines identity, tool boundaries, communication
  rules, and safety posture.
- Per-turn `<system-reminder>` blocks carry current outliner context,
  attachment metadata, and other dynamic state.
- Tool descriptions define exact parameter contracts and result interpretation.

The stable prompt is implemented in `src/main/agentSystemPrompt.ts`. It should
not contain current UI state, current node ids beyond generic rules, local file
paths, provider settings, or any state that changes per turn.

It states:

- Tenon is a local-first outliner and local assistant.
- The agent should use the user's language unless asked otherwise.
- The agent should treat `<system-reminder>` as hidden context from Tenon, not as
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

Each prompt should include a compact context block built by Tenon, not by pi-mono.

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

Tenon uses pi-mono's `transformContext` hook for request-time context shaping and
the runtime's `afterToolCall` hook for immediate large-result persistence. The
compaction policy stays in Tenon so it can preserve outliner-specific anchors,
skills state, and event-log replay semantics.

## Tool Model

All tools exposed to pi-agent-core should be Tenon tools. A tool is a TypeScript
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

Tenon should use nodex as the outliner reference and a proven local-tool runtime
as the local tool reference. Tenon should still keep its own lower snake case tool
names because the runtime, permission model, and UI are Tenon-owned.

nodex tools:

- `node_create`
- `node_read`
- `node_edit`
- `node_delete`
- `node_search`
- `undo`
- `browser`
- conversation-history recall

nodex is the closest outliner reference. Its important lesson is that document
tools should be domain-specific, not generic file operations. The agent edits
nodes through outliner verbs and each write is undoable as one AI operation.
Tenon should keep nodex's compact `node_*` surface, but use Tenon's own final
contracts from `agent-tool-design.md`: `node_create.outline`,
`node_read(...)`, and
`node_edit.old_string/new_string`. The parser is implemented in TypeScript rather than
left as prompt-only behavior. Compatibility normalization belongs in the
adapter/runtime layer and should not appear in the model-facing tool
description. Tenon code should use neutral parser names such as
`lin_outline_parser`.

Reference local and agent tool roles:

- shell execution
- file read, edit, write, glob, and grep
- web fetch and web search
- task planning
- skill invocation
- user question
- delegated child-run execution
- task stop
- plan mode
- MCP resource listing and reading

The reference runtime is useful for tool contracts, permission checks, and tool
pool filtering. For local tools, Tenon should copy the role boundaries,
descriptions, argument schemas, and model-visible action payloads where they fit.
Runtime details can keep Tenon's common `ToolResult` envelope, but
`node_*` model-visible output should use the discriminated node protocol from
`agent-tool-design.md` rather than exposing the envelope directly:

The bridge to pi-agent-core must remain native: tool `execute` returns
`AgentToolResult` content/details only, while Tenon's shared `afterToolCall`
adapter maps envelope errors (`details.ok === false`) to
`ToolResultMessage.isError = true`.

- Dedicated file tools should be preferred over shell commands.
- `file_read` is the freshness prerequisite for `file_edit` and existing-file `file_write`.
- `file_edit` is exact string replacement, not a custom patch protocol.
- `file_glob` finds paths; `file_grep` searches contents.
- `bash` runs commands and can background long-running work.
- `task_stop` only stops a background task; it is not a generic process manager.
- Large command output should be persisted and then read through the file tool.

Tenon configures a local `ask_user_question` tool for structured clarification.
The runtime persists pending question events, exposes the pending question to the
renderer, and resumes the blocked tool call when the user submits an answer or
chooses the dedicated `discussed` outcome. Answer inputs use the same structured
node-ref, local-file-ref, and attachment model as the main composer; path-backed
answer attachments still pass through the realpath-based local-root jail and
materialization path before they are persisted in `user_question.answered`.
Web access is covered by `web_search` and `web_fetch`.

## Tenon Tool Registry

Tenon uses a compact, stable tool registry. Higher-risk tools should still be
added only after approval, rendering, and undo behavior are solid.

The detailed tool contract, parameter schema, and result envelope are defined in
`docs/spec/agent-tool-design.md`. This document only describes how those tools
fit into the pi-mono runtime.

### P0 Tools

These are the active core tool surface.

| Tool | Reference | TypeScript-backed? | Approval intent | Purpose |
|---|---|---:|---|---|
| `node_search` | nodex `node_search`, Tenon search-node outline | Yes | No | Execute a temporary or saved search node outline without mutating document state. |
| `node_read` | nodex `node_read` | Yes | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | nodex `node_create`, Tenon outline parser | Yes | Usually yes | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | nodex `node_edit`, Tenon outline parser | Yes | Usually yes | Edit a known node's annotated outline by exact replacement, or perform explicit move, merge, or reference replacement. |
| `node_delete` | nodex `node_delete` | Yes | Usually yes | Trash or restore nodes. |
| `operation_history` | nodex `undo`, Tenon history | Yes | Depends | List, undo, or redo user and agent operations. |
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

### P1 Agent Tools

These agent-level tools are active on top of the P0 local/document surface.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `recall` | Tenon agent memory store | Yes | No | Cued retrieval over active semantic memory entries, with optional nested source evidence. |
| `ask_user_question` | structured user elicitation | Yes | No | Pause a run for single-choice, multi-choice, free-text, refs/attachments, or a discuss-before-answering outcome. |
| `runtime_status` | self-observation | Yes | No | Read redacted local runtime/provider/settings status. |
| `config` | cc-2.1-style config tool | Yes | Reads no, writes yes | Read or update whitelisted runtime settings through runtime-owned paths. |
| `doctor` | self-diagnostics | Yes | No | Run read-only local agent diagnostics. |
| `dream` | Tenon agent memory Dream | Yes | Yes | Request runtime-owned memory consolidation for the current agent; cannot specify facts to save. |
| `skill` | local skill invocation | Yes | Usually no | Invoke installed or built-in skills; `/skillify` is a built-in slash-only workflow. |

`task_stop` is active because Tenon's `bash` tool supports background commands.

### P2 Tools

These should wait until the product needs them.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `browser` | nodex `browser` | Yes | Usually yes | Control an embedded browser tab if Tenon adds one. |
| `mcp_list_resources` | MCP resource discovery | Yes | No | Discover MCP resources. |
| `mcp_read_resource` | MCP resource reading | Yes | No | Read MCP resources. |
| `mcp_call_tool` | MCP tool calls | Yes | Depends | Call configured MCP server tools. |
| `todo_write` | task planning | No | No | Maintain internal task plans if agent planning needs a tool. |
| `skill` | skill invocation | Partly | Depends | Load and invoke local skill folders. |
| `sub_agent` | child agent execution | Mixed | Depends | Spawn child agents. Not needed for Tenon v1. |

Do not configure browser, MCP, or sub-agent tools in the first release unless
there is a specific user-facing workflow. A larger tool pool increases prompt
cost and makes permission behavior harder to reason about.

## Tool Naming

Tenon should use lower snake case tool names for all Tenon-owned tools:

- `node_*` for document graph operations.
- `file_*` for filesystem operations.
- `bash` for shell execution.
- `task_stop` for stopping background commands created by `bash`.
- `recall` for durable agent memory. Raw conversation-history lookup is internal
  to runtime-owned evidence expansion, Dream consolidation, and diagnostics.
- Runtime-owned Dream runs are scheduled/manual reflective runs. The automatic
  path uses the shared `date` schedule primitive plus a minimum-evidence gate;
  `/dream` forces the same no-tools path and consolidates existing memory when
  there is no new evidence. The foreground `dream` tool is trigger-only: it lets
  the model request the same runtime-owned path for the current agent, but it
  cannot pass facts to save, choose a different agent, or write memory directly.
  Dream reads raw conversation/run events since its per-conversation watermark,
  appends scoped `memory.entry_*` events with provenance, records
  `dream.completed` in the pool's memory log, and writes a principal-anchored
  reflective run meta entry (anchored to the pool the Dream maintains; the
  executing agent is recorded separately). Manual `/dream` and foreground
  `dream` tool triggers also write a conversation-side `dream.finished` marker
  so the chat stream shows running/completed feedback.
- `web_search` / `web_fetch` for web access.

Do not use:

- legacy `Read` / `Edit` / `Write` aliases: Tenon should make the local
  capability explicit with lower snake case names.
- generic mutation tools such as `outliner_write`, `outliner_apply_patch`, or
  `node_batch`: they force the model to learn a second mini-protocol and make
  permission boundaries less clear.

The current implementation configures the P0 tools and the P1 agent tools listed
above. Additional tools should be added by product need, not because a reference
project has them.

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
- Read or update explicit local agent memory with `memory`.
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

pi-mono events should be normalized into Tenon events before they reach storage,
debug, or renderer components. The canonical event-store architecture lives in
`docs/spec/agent-event-log-rendering.md`.

Currently emitted event categories:

- `conversation.created`
- `conversation.renamed`
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

The raw pi-mono event can be kept as a payload ref for debugging, but UI
components should render from Tenon's normalized render projection.

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
sends a new instruction while the agent is streaming, Tenon queues it as steer
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

Tenon should treat compaction as a product policy, not as a library detail.
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

- pi-mono dependencies are pinned and isolated behind Tenon's Electron main
  runtime boundary.
- `AgentRuntime` owns session lifecycle, prompt routing, stop/reset/branch
  commands, pi-agent-core subscriptions, provider debug capture, event append,
  projection emission, and checkpoint writes.
- `useLinAgentRuntime` consumes Tenon-owned `AgentRuntimeEvent` /
  `AgentRenderProjection` data instead of pi-mono objects.
- Agent conversations persist through the event store, not through mutable
  pi-agent-core state.
- Active-path pi-ai `Message[]` is derived from replay state when a session is
  restored or a new run starts.
- Web, outliner, file, bash, and background-task tools execute through Tenon's
  TypeScript main-process gateway.
- Large tool output and provider request/response debug data use event-store
  payload refs.
- Session list, search, user-message history, debug history/totals, and
  checkpoints are derived from the event store.
- Provider authentication spans pi-ai's three credential classes: a single
  non-throwing `getProviderApiKey` resolver (api-key / OAuth auto-refresh-persist
  / env / managed), chmod-600 local credential storage, and a main-owned OAuth
  sign-in flow (loopback + device-code) bridged to a renderer sign-in UI.

Remaining runtime work:

- Approval UI/runtime pause flow for risky tools.
- Persisted follow-up events.
- Performance metrics around replay, projection, IPC payload size, and long
  transcript rendering.
- Richer lazy media previews for non-text payloads in render/debug details.
- More explicit cancellation events once pi-agent-core abort semantics are mapped
  cleanly to Tenon's `run.cancelled`.

## Testing

Current coverage should stay focused on the Tenon-owned boundary:

- Event schema, replay, active path, branch selection, pi-ai message derivation,
  render projection, event store append ordering, checkpoint replay, corrupt
  checkpoint recovery, index rebuild, payload refs, and large-session behavior.
- Debug projection restore from `debug.snapshot.created` events plus debug
  payload refs.
- Tool argument validation, local path boundaries, bash timeout/output caps,
  node tool behavior, web tool normalization, and tool-result envelope mapping.
- Renderer runtime hydration, projection events, branch actions, streaming view
  state, and payload-backed copy behavior.
- Provider credential resolver (api-key, OAuth refresh-persist, env/managed
  fallback, never-throws, chmod-600 storage), OAuth login orchestration (callback
  bridging, reply correlation, cancel, logout), and the renderer OAuth flow
  reducer / expiry formatters.
- E2E coverage for composer controls, model/settings behavior, process/tool
  disclosure, debug panel, virtualization, bounded large-output rendering, and
  provider OAuth sign-in (device-code, loopback, connected, sign-out).

Next coverage should land with the corresponding runtime features:

- Approval pause/resume/reject flow.
- Persisted follow-up events.
- Compaction events and pi-mono message replacement.
- Explicit `run.cancelled` mapping.
- Performance metric event emission and analysis views.

## Migration Risk

Using pi-mono should not make Tenon dependent on pi-mono forever.

Keep these interfaces stable:

- Tenon-owned `AgentEvent`.
- Tenon-owned `AgentRuntimeEvent`.
- Tenon-owned `AgentRenderProjection`.
- Tenon-owned tool schemas and result envelopes.
- Tenon-owned Electron IPC command payloads.
- Tenon-owned persisted conversation schema.

If Tenon later moves to a TypeScript agent core, the replacement should only need to
implement the runtime adapter contract. Document tools, Electron IPC commands,
permissions, transcript rendering, and persistence should remain mostly intact.

## Summary

pi-mono should provide the agent brain: model abstraction, streaming, agent
loop, tool-call orchestration, and steering.

Tenon should provide the local body: outliner operations, file operations, bash,
permissions, approvals, undo, persistence, and UI state.

This split gives Tenon a fast path to a capable local agent without giving up
control over the local-first TypeScript core.
