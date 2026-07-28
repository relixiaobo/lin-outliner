# Agent Model Runtime

The model runtime adapts provider streaming into canonical Turn and Item facts.
Provider state is never a second product history.

## Execution Boundary

`PiTurnExecutor` receives an immutable `TurnExecutionContext` containing the
Thread, accepted Turn, prior history, effective configuration, cancellation
signal, `ItemRecorder`, and Thread-scoped context/resource readers. There is no
execution-only `systemContext` or `additionalContext` side channel.

Before provider execution, `ThreadService` admits hidden input as canonical
`contextEvidence` Items immediately before the corresponding `userMessage`.
Renderer input can contribute only bounded structural user-view hints and
`untrusted/observation` additional context. Main resolves Node content and owns
all `application` classifications. Scheduled Turns receive trusted
`automation_info` from the canonical Automation dispatcher; renderer input
cannot create it. Extension entries retain `extension:<id>` source identity.

The stable system prompt is composed in three deterministic layers: universal
framework firmware (L0), modules selected from the effective canonical tool
catalog (L1), and root Neva or child Role identity/instructions (L2). Current
time, view state, resources, additional context, and Skill discovery never enter
that prefix. The composer exposes byte fingerprints for each layer and the
complete prompt; logically identical configurations therefore produce identical
prompt bytes across Turns and restarts.

L1 capability selection matches exact Core canonical tool keys. A namespaced extension
or provider-encoded tool whose local name resembles a built-in never enables built-in
filesystem, Outliner, Memory, Skill, or collaboration guidance.

The stable modules retain the established operational contract: renderer-safe
deliverables use `[[file:Display name^/absolute/path]]`; Memory lookup searches and
reads the `#d-memory`/`#d-episode`/`#d-belief` family; a Skill's declared dependency
is verified and installed or enabled before an approximation is considered; and child
Runs explicitly account for shared files, processes, ports, credentials, application
state, and services. Tool-owned syntax such as generated-image placement remains on
the owning tool description/result rather than being duplicated in the prompt.

Every provider request, including requests after tools and steering, passes
through `CanonicalContextProjector` at the pi `transformContext` boundary. The
projector ignores the pi transcript as history input and rebuilds provider
messages from prior canonical Turns plus the active `ItemRecorder`. The awaited
event subscriber makes completed assistant and tool Items durable before the
next provider request can begin. Tool calls and results remain paired, and
provider-visible timestamps come from persisted `acceptedAt`/`Turn.startedAt`
rather than terminalization time or the current clock.

Direct slash and natural-language inline Skill routing run during the same admission
boundary. Inline Skills are side-effect-free by contract; shell expansion and all
execution overrides require isolated execution through the canonical `skill` tool.
Validated inline guidance is persisted as `skillInvocation` evidence immediately before
the unchanged canonical `userMessage`. Model-tool invocation persists the same payload
after its complete tool Item. Every provider boundary therefore receives Skill guidance
only through canonical projection; no direct-prompt overlay, generic prompt builder,
private steering message, or reminder parser is a second history authority.

For every ordinary input, main records `turnEnvironment` evidence containing the
accepted UTC instant, local date/time, IANA timezone and offset, locale, working
directory, execution/conversation mode, reply identity, and Today Node identity.
Hidden internal Memory Turns remain isolated from ordinary environment, view,
catalog, resource, and extension context.

Interactive user-view evidence starts from renderer IDs only: at most 80 visible
Nodes across all panels, depth 5, 50 selected Nodes, and 64 KiB serialized. Main
resolves titles, breadcrumbs, outline syntax, checkbox/done state, references,
descriptions, tags, file names, child counts, and Today fallback from the current
`DocumentProjection`. Expanded references contribute the same resolved target children
and depths that the Outliner renders; reference chains use cycle protection, and main
derives child counts from that resolved displayed parent. Expanded table records omit
authored field entries already represented by visible columns. Panels and text leaves
use fixed ordering and escaping.
Projection emits a complete first snapshot and deterministic later diffs; replaying
the same canonical payload sequence reconstructs the same snapshot/diff bytes.
Only the host-derived projection mode and interaction mode are application observations.
Panel/focus/selection/visibility claims originate in renderer state, while Node text is
document content; the complete resolved view body is therefore serialized as an
`untrusted/observation` block even though main validates and enriches it.

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
checks the Turn signal after provider resolution, tool assembly, canonical
projection, and Agent construction, so Stop cannot
cross an initialization boundary and still reach the provider.

Prior and active provider input is rebuilt from the effective canonical Item sequence
after context-reset and compaction reduction.
Messages become assistant content, while reasoning becomes explicitly labelled
assistant text because canonical history does not retain provider-private
reasoning signatures. Command, file, MCP, dynamic,
collaboration, and web Items become paired provider tool-call and tool-result
messages using the frozen projection recorded for each complete output. Dynamic tool
results retain their ordered text, JSON, and actual image content at the provider
boundary. Each image is preceded by a stable identity marker derived from its alt text
and canonical source filename or path, plus immutable snapshot MIME and byte length;
images no longer degrade to filename-only text. Plans and context
reset Items select context state rather than becoming user prose; Subagent activity
and viewed images become textual context. A compaction serializes its lossy summary,
validated reducer checkpoint, restored inline Skill instructions and file/Node
observations, optional durable instructions, then continues with its declared preserved
tail. The covered raw range is not sent as a second copy.
Context evidence is serialized at its canonical tail position as an escaped
`<context-evidence>` envelope inside the provider-facing `<system-reminder>` convention
described by L0. The wrapper is only a serialization boundary: typed canonical evidence
and host-assigned `authority`/`purpose` metadata remain authoritative. Literal
user-authored `<system-reminder>` or `<context-evidence>` text is never parsed or
upgraded, and there is no legacy reader or compatibility fallback. The active provider supplies message
metadata. No hidden provider transcript is stored or used as a history authority.

## User Content And Attachments

`ThreadService` resolves user content at admission before it records the
`userMessage` Item. The same normalized content is persisted and passed to the
provider for initial input, steering, and later history reconstruction.
When structured input contains attachments or Node references but no non-empty user
text, the provider serializer adds one deterministic request to review the attached
files, attached images, and/or referenced Outliner Nodes. That text is derived only at
the provider boundary; canonical user content continues to record exactly what the user
submitted.
Each image is preceded by a deterministic identity block containing its name, MIME type,
and source byte length, then the immutable prompt snapshot bytes. Multiple images
therefore retain their user-visible identity and order without reviving attachment
markers or parsing provider text. Resolved canonical input requires every image to carry
a Thread-owned image `promptImage` and forbids `promptImage` on non-images. Admission
rejects an invalid shape before publishing the user Item, and projection fails closed if
corrupt canonical history violates the same invariant; an image never degrades to a
mutable file-path fallback.

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

An explicit `nodeReference` also creates a bounded, main-resolved
`referencedResources` snapshot. Every referenced Node retains authoritative
identity, title, breadcrumb, bounded outline content, and typed availability.
Attachment/image Nodes are opened as regular non-symlink files, capped at 50 MiB,
checked against stored byte length and SHA-256 metadata, and copied into the
owning Thread before the Item is published. Missing, corrupt, unsupported, and
over-budget resources remain visible as typed unavailable evidence. Up to eight
supported images add the verified Thread-owned bytes at the provider boundary. The
owning context Item declares dependencies by complete typed resource reference
(digest, MIME type, byte length, and safe filename), even when multiple references map
to one content-addressed physical file.

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

An execution or streamed Item is recorded with `item/started`, optional typed deltas,
and one terminal `item/completed`. Initial evidence and user facts are complete inside
the atomic `turn/started` event; later steering evidence and input use
`items/completed`. Neither path synthesizes a streaming lifecycle.
The recorder validates local provenance and rejects completion before start. Tool arguments and visible results use bounded
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
authority. Before the next provider boundary, the runtime records exactly one
`toolOutputProjection` for each previously unseen complete output. A result uses its full
payload when both the per-output and aggregate output shares fit; otherwise it uses a
bounded inline projection that states the complete byte length and digest. The decision
is immutable and content-addressed. Later replay, restart, compaction, fork, and child
inheritance use the same bytes while the complete `outputRef` remains available for UI
inspection and checkpoint dependencies.

Binary image output never enters rollout JSON, SQLite projection, or IPC as a
data URL. Existing readable outputs such as `file_read` and generated-image files
retain a typed `localFile` source for UI/file operations plus a Thread-owned
`promptImage` snapshot of the exact bytes exposed to the provider. Other provider
images use their content-addressed `threadPayload` source as that snapshot.
Event admission, the payload store, and the canonical Item codec independently
require an image MIME type; invalid MIME metadata produces a structured omission
instead of a provider image block.
Base64 length is validated before decoding, with independent per-image and
per-tool-call byte budgets. Invalid, oversized, over-count, over-total, and Thread-quota
images produce one structured omission summary instead of failing the complete tool
result. Binary `data` fields are replaced before full textual output persistence, so
neither small nor large base64 images leak into text payloads. Forking copies managed
sources and local-image prompt snapshots under the target Thread while preserving the
same references; external readable file paths remain unchanged. A
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

## Context Planning And Compaction

Every provider boundary, including post-tool requests and steering, runs one global
budget plan over the stable prompt, canonical tool schemas, reduced history, current
evidence, images, and the active Turn. The input limit reserves provider framing plus up
to one quarter of the model context window for output, capped by the model output limit.
The active Turn is mandatory. Assistant tool calls and their complete result set form one
indivisible unit; an orphan, duplicate, or incomplete exchange fails closed. If the
stable prompt, tools, and active Turn alone cannot fit, the Turn fails with an explicit
capacity error rather than dropping the current request.

A child Turn's leading `inheritedContext` Item is historical context even though it is
stored before the task in that same Turn. Its protected boundary begins at the first
following current-admission Item. Budget recovery may compact the inherited Item with an
exact item cursor, but it cannot compact the current admission evidence or task.

When older history prevents the protected tail from fitting, preflight records one
`automaticPreflight` compaction and replans. Runtime compaction covers prior canonical
history only. The planner aligns its retained provider-message suffix to the next
canonical Turn boundary, so it preserves the newest complete prior Turns that fit plus
the active Turn, never a partial prior Turn. Provider-overflow recovery may compact all
prior Turns and preserve only the active Turn. Manual `/compact
[instructions]` may compact the current epoch while the Thread is idle. Both forms store
exact covered/preserved cursors, a deterministic bounded lossy summary, and a reducer
checkpoint for the Skill and Role catalog journals, active inline Skill invocations,
latest user-view baseline, and non-invalidated file/Node observations. Observation
checkpoints reference the existing frozen projection and complete output instead of
copying tool text. Optional manual instructions remain typed application guidance after
the summary; they are not parsed from reminder text. A compaction with no eligible
content is an idempotent no-op.

Reducers recursively evaluate typed inherited context and treat an earlier compaction
checkpoint as authoritative state at that point in the effective history. Consequently,
compacting a child or fork after deleting its source Thread preserves inherited
catalogs, active Skill instructions, the latest view baseline, and active observations;
compacting that result again preserves the same state until later canonical Items change
or invalidate it. Every nested context/output dependency is validated before the new
checkpoint is admitted.

A successful non-preview `node_create`, `node_edit`, or `node_delete` invalidates all
active Node observations because one bounded `node_read` can project descendants,
references, and definition-dependent content that cannot be reconstructed from mutation
arguments alone. Successful `outline_undo_stack` undo/redo has the same effect; list,
preview, failed, and interrupted calls do not. File observations remain path-keyed and
invalidate only after a completed mutation of that path.

`/clear` records a `contextReset` in a completed feature Turn without invoking the
provider. Projection starts after the latest reset, clears the user-view diff baseline,
catalog journals, active Skill guidance, output-projection budget state, prior
compaction, and inherited context, then records fresh Skill/Role baselines on the next
ordinary admission. Earlier Turns remain visible, pageable, searchable, exportable,
forkable, and available to explicit history tools. Consecutive clears without new
model-visible content reuse the prior boundary.

A provider context-overflow error is classified before transient transport retry. The
runtime records one `providerOverflow` compaction, rebuilds the canonical request, and
retries once without consuming request/stream retry counters. A second overflow, or an
overflow with no eligible compaction range, fails explicitly. Compaction Items and their
payload dependencies are durable before retry, so restart reconstructs the same reduced
request.

## Provider Independence

Provider-specific names, message shapes, cache behavior, and stop reasons are
normalized at this boundary. Core codecs, persistence, and renderer components
never depend on a provider SDK DTO.

Retryable provider request/stream failures use bounded Codex-style backoff. The
executor emits `turn/providerRetry/changed` only as transient notification state
and clears it on recovery or terminalization; reconnect attempts do not create
Items or persist as transcript history.

Timeout, maximum transient retries, maximum retry delay, and cache retention are read
once at Turn execution start and applied consistently to each provider request. Custom
OpenAI Responses endpoints always force cache retention to `none`; auxiliary naming also
uses no cache retention and keeps its separate bounded request contract.

Provider cache affinity is the lowercase SHA-256 of
`tenon-agent-cache-affinity-v1`, the Thread ID, and the current context epoch ID separated
by NUL bytes. The initial epoch ID is `initial`; only a recorded `contextReset` starts a
new affinity. Ordinary Turns, steering, restart, compaction, and changes to the Thread
tree's grouping `sessionId` retain it. Tools are sorted by exact canonical name before
Agent construction, so equivalent registries serialize identically regardless of
assembly order.

Anthropic Messages requests use at most four cache-control breakpoints. The stable
prompt's structured blocks split it into protected L0 firmware and the remaining stable
execution prompt; the provider adapter preserves the final tool and final user
breakpoints already present in the request. If an upstream OAuth identity block would
exceed the limit, that identity breakpoint is removed before either protected stable
breakpoint. The adapter matches the sanitized provider text reconstructed from
`StablePrompt.blocks`, never parses textual markers, and adds no Anthropic metadata to
other providers.
