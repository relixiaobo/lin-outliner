# Agent Model Runtime

The model runtime adapts provider streaming into canonical Turn and Item facts.
Provider state is never a second product history.

## Execution Boundary

`PiTurnExecutor` receives an immutable `TurnExecutionContext` containing the
Thread, accepted Turn, prior history, effective configuration, additional
context, cancellation signal, and `ItemRecorder`.

Before the first provider request it resolves the configured model, builds
system context, restores prior model messages from canonical Items, and assembles
the final model-tool registry. Provider messages remain in memory only for the
duration of execution.

Turn admission snapshots the real provider, model, and reasoning effort into
`Turn.execution`. Terminalization adds the normalized input, output, cache-read,
cache-write, total-token, and USD cost breakdown. These canonical execution
details persist with the Turn and drive renderer Details/usage surfaces; the UI
does not query a provider SDK or infer the model from current settings.

Cancellation is registered before any asynchronous initialization. The runtime
checks the Turn signal after provider resolution, tool assembly, Skill listing,
system-prompt construction, and Agent construction, so Stop cannot cross an
initialization boundary and still reach the provider.

Prior provider input is rebuilt from the complete canonical Item sequence.
Messages become assistant content, while reasoning becomes explicitly labelled
assistant text because canonical history does not retain provider-private
reasoning signatures. Command, file, MCP, dynamic,
collaboration, and web Items become paired provider tool-call and tool-result
messages; plans, Subagent activity, viewed images, and compaction remain visible
as textual context. The active provider supplies message metadata. No hidden
provider transcript is stored or used as a history authority.

## User Content And Attachments

`ThreadService` resolves user content at admission before it records the
`userMessage` Item. The same normalized content is persisted and passed to the
provider for initial input, steering, and later history reconstruction.

Inline images remain provider image input. Local-file attachments, asset-backed
attachments, and non-image inline attachments resolve to a readable local path.
Files already inside the Thread working directory or app-owned scratch retain
their real path; other regular files are copied into bounded app-owned scratch
as a stable snapshot. Assets resolve through the host asset service. External
directories, missing assets, oversized files, and unsupported file kinds fail
admission instead of producing an unreadable transcript Item.

Provider input describes a path-backed attachment with its readable path and
directs the model to `file_read`; it never relies on an asset ID or a transient
renderer selection path. Scratch attachments are ephemeral host data and use
the same pruning policy as other agent scratch artifacts.

## Stream Normalization

Provider events are converted as follows:

- assistant text becomes `agentMessage`
- thought summaries and content become `reasoning`
- shell activity becomes `commandExecution`
- patch activity becomes `fileChange`
- MCP calls become `mcpToolCall`
- configured extension tools become `dynamicToolCall`
- collaboration tools produce collaboration Items
- web and image activity use their canonical Item kinds

An execution Item is recorded with `item/started`, optional typed deltas, and one
terminal `item/completed`. The recorder validates local provenance and rejects
completion before start. Tool arguments and visible results use bounded
projections with explicit truncation metadata. Tool-result details pass through
the shared persistence slimmer before entering an Item. Dynamic image result
lists also have a fixed maximum length.

Every textual tool completion also writes its complete normalized result to the
Thread-owned content-addressed payload store. The Item keeps only a bounded
renderer/history projection plus an immutable `outputRef` containing digest,
MIME type, byte length, and summary. `thread/item/output/read` validates the
requested Thread/Turn/Item/ref tuple and byte length before returning text.
Forked Items retain origin provenance, so copied history resolves the same
immutable payload without duplicating it. Payload reads never become provider
history authority; prior model messages are rebuilt from canonical Items and
their full output references.

Binary image output never enters rollout JSON, SQLite projection, or IPC as a
data URL. Existing readable outputs such as `file_read` and generated-image
files retain their file path. Other provider images are written under the
owning Thread's payload directory and the Item stores only that file reference.
Base64 length is validated before decoding, with independent per-image and
per-tool-call byte budgets. Invalid, oversized, over-count, and over-total image
outputs produce one structured omission summary instead of bytes or unbounded
Item entries. Deleting the Thread deletes the payload directory.

## Tools And Causation

`ToolRuntime` filters tools through the effective Thread configuration, Core
scope, explicit capability blocks, and canonical registry identity. It emits the
started Item before execution and always emits a terminal Item, including native
unavailable or thrown results.

The current Item identity is bound through asynchronous execution context.
Outliner transactions and bulk imports therefore receive exact
`threadId`/`turnId`/`itemId` causation even when multiple tools overlap.

Capability audit data is attached to tool result details. It describes action
kinds, access classification, source, and unavailable reason; it is not an
authorization handshake.

## Steering And Cancellation

The executor registers one steering handler. Input accepted before registration
is queued and delivered in order. Steering is added to provider input without
rewriting persisted prior Items.

Interrupt aborts provider and tool work through the Turn signal, including
provider and tool initialization before `prompt()`. Any execution
Item still `inProgress` is completed as `interrupted`; unexpected executor
failure completes it as `failed`. The terminal Turn records the corresponding
status and error.

## Context Compaction

Compaction is represented by `contextCompaction`. It may replace provider-facing
context during one execution, but canonical rollout history remains unchanged.
Skills restore compact state through their own structured reminders.

## Provider Independence

Provider-specific names, message shapes, cache behavior, and stop reasons are
normalized at this boundary. Core codecs, persistence, and renderer components
never depend on a provider SDK DTO.

Retryable provider request/stream failures use bounded Codex-style backoff. The
executor emits `turn/providerRetry/changed` only as transient notification state
and clears it on recovery or terminalization; reconnect attempts do not create
Items or persist as transcript history.
