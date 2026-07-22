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
completion before start. Tool results retain a structured `details` value and a
bounded visible text representation.

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

Interrupt aborts provider and tool work through the Turn signal. Any execution
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
