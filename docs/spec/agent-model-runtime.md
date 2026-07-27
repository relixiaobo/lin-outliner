# Agent Model Runtime

The model runtime adapts provider streaming into canonical Turn and Item facts.
Provider state is never a second product history.

## Execution Boundary

`PiTurnExecutor` receives an immutable `TurnExecutionContext` containing the
Thread, accepted Turn, prior history, effective configuration, additional
context, cancellation signal, and `ItemRecorder`.

Trusted application entries in `additionalContext` are authored only by main.
In particular, scheduled Turns receive `automation_info` from the canonical
Automation dispatcher; renderer input cannot create or replace it. Its schedule,
routing, and provenance semantics are owned by
[`agent-automations.md`](agent-automations.md).

Before the first provider request it resolves the configured model, builds
system context, restores prior model messages from canonical Items, and assembles
the final model-tool registry. Provider messages remain in memory only for the
duration of execution.

The current adapter still has separate first-prompt, steering, and history
construction paths. It places volatile `systemContext` and Skill listing text in the
system prompt and does not yet consume canonical context payloads. The context Item
and payload protocol exists so the unified planner can replace these paths without an
interim private format; stable L0/L1/L2 composition, append-only cache projection, and
structured Skill reduction are not current runtime behavior yet.

For every ordinary Turn, main adds one trusted environment fragment containing
the current local calendar date, the exact UTC instant at execution start, and
the runtime-resolved IANA timezone. Relative schedules therefore never require
shell commands to discover host time. Hidden internal Memory Turns remain
isolated from this fragment together with other ordinary extension context.

The same runtime also implements auxiliary Thread naming after the first user
Turn becomes terminal. It resolves that Thread's current provider/model,
requests the lowest supported reasoning level, disables prompt-cache retention,
and bounds the request to 64 output tokens. Only normalized plain text returns
to `ThreadService`; provider content is never persisted as a message, Item, or
second history authority. The request has its own abort signal and is awaited on
orderly shutdown.

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
messages using the bounded text already stored on each Item. Plans and context
evidence/reset Items are omitted; Subagent activity and viewed images become textual
context, and compaction becomes a marker. The active provider supplies message
metadata. No hidden provider transcript is stored or used as a history authority.

## User Content And Attachments

`ThreadService` resolves user content at admission before it records the
`userMessage` Item. The same normalized content is persisted and passed to the
provider for initial input, steering, and later history reconstruction.

Attachment sources are reference-only. `localFile` records a canonical live
path; `threadPayload` records a lowercase SHA-256 digest, MIME type, byte length,
and safe display filename. Neither source carries base64 or an unbounded byte
array. A path-backed regular file is canonicalized without being copied and has
no shared source-size ceiling. A pathless browser `File` crosses preload in
1 MiB chunks into staged Thread storage, with a 2 GiB per-resource budget and an
8 GiB per-Thread quota. Completion hashes and atomically publishes the payload;
failure, cancellation, startup recovery, draft removal, and unreferenced-resource
reconciliation reclaim incomplete or orphaned data.

Non-image provider input describes a readable path and directs the model to
`file_read`. A `localFile` uses its live canonical user path; a `threadPayload`
uses an independent Turn-scoped copy under Agent scratch. The runtime removes
that observation when execution ends, and model or tool writes to it cannot
modify the private content-addressed payload. Images are decoded in main from a
source of at most 256 MiB, orientation-normalized by the native image pipeline,
bounded to 2,000 px, and persisted as an immutable prompt snapshot of at most
4.5 MiB.
All native image observations share one main-process queue, so attachment
admission and parallel `file_read` calls cannot aggregate decode and resize work.
The canonical attachment retains the original resource reference plus the
snapshot reference. Initial execution, steering, history replay, and forks use
that same snapshot. Only the provider boundary converts its bytes to base64;
renderer state, IPC, rollouts, and canonical Items never do.

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

OpenAI Responses requests use the provider's detailed reasoning-summary mode.
The runtime preserves every delivered summary part in the canonical `reasoning`
Item; the renderer never substitutes the first line for the expanded body.

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
requested Thread/Turn/Item/ref tuple, MIME-selected file, byte length, and SHA-256
digest before returning text.
Forked Items retain origin provenance while copying referenced payloads under
the fork's own Thread directory. Managed resource copies use copy-on-write when
available but always receive a distinct inode. Payload reads resolve through the
requested Thread, so deleting or corrupting the source Thread cannot invalidate
inherited text or image results. Payload reads never become provider history
authority. The current history adapter replays the bounded Item result; selecting full
content or an addressable observation is reserved for canonical
`toolOutputProjection` evidence and the unified planner.

Binary image output never enters rollout JSON, SQLite projection, or IPC as a
data URL. Existing readable outputs such as `file_read` and generated-image
files retain a typed `localFile` source. Other provider images are written to the
owning Thread's managed resource store and the Item keeps a content-addressed
`threadPayload` reference.
Base64 length is validated before decoding, with independent per-image and
per-tool-call byte budgets. Invalid, oversized, over-count, and over-total image
outputs produce one structured omission summary instead of bytes or unbounded
Item entries. Forking copies Thread-owned image bytes under the target Thread while
preserving the same reference; external readable file paths remain unchanged. A
Thread-scoped preview resolves managed images to disposable scratch copies rather than
exposing canonical resource paths. Deleting a Thread deletes only that Thread's payload
directory.

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

The Core contract represents compaction with exact covered/preserved cursors and
Thread-owned summary, restored-state, and optional instruction payloads. It also
represents `/clear` with `contextReset`. The current executor does not perform this
reduction: it ignores context evidence/reset and serializes an existing compaction Item
only as a marker. The restored-state schema can checkpoint active file/Node observations
through complete-output and frozen-projection references, but the executor does not yet
restore or serialize them. Automatic/manual planning, epoch selection, Skill and
observation checkpoint restore are subsequent consumers of this protocol, never
reminder-text parsers.

## Provider Independence

Provider-specific names, message shapes, cache behavior, and stop reasons are
normalized at this boundary. Core codecs, persistence, and renderer components
never depend on a provider SDK DTO.

Retryable provider request/stream failures use bounded Codex-style backoff. The
executor emits `turn/providerRetry/changed` only as transient notification state
and clears it on recovery or terminalization; reconnect attempts do not create
Items or persist as transcript history.
