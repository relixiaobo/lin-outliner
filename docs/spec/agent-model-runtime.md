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
Direct privileged and renderer entries are Turn-local events and always project for
their admitted input. Extension contributions form a complete Thread-state snapshot:
the first value and later changes project as `set`, unchanged entries emit nothing, and
removal emits an explicit `cleared` tombstone. When the registry contains at least one
Thread-context contributor, ordinary host admission records its complete snapshot even
when every registered contributor is currently inactive; this preserves the empty state
needed to clear a prior value. A registry with no Thread-context contributors emits no
Thread-state payload, and `null` remains the payload representation for execution modes
where Thread state was not evaluated. Compaction checkpoints the latest complete snapshot
by typed payload reference, restores only its Thread-state entries, and never replays
Turn-local events from the same payload.

The stable system prompt is composed in three deterministic layers: universal
framework firmware (L0), modules selected from the effective canonical tool
catalog (L1), and root Neva or child Role identity/instructions (L2). Current
time, view state, resources, additional context, and Skill discovery never enter
that prefix. The composer exposes byte fingerprints for each layer and the
complete prompt; logically identical configurations therefore produce identical
prompt bytes across Turns and restarts.

L1 capability selection matches exact Core canonical tool keys. A namespaced extension
or provider-encoded tool whose local name resembles a built-in never enables built-in
filesystem, Outliner, Memory, Skill, or Agent-orchestration guidance.

The stable modules retain the established operational contract: renderer-safe
deliverables use `[[file:Display name^/absolute/path]]`; Memory lookup searches and
reads the `#d-memory`/`#d-episode`/`#d-belief` family; a Skill's declared dependency
is verified and installed or enabled before an approximation is considered; and Agents
explicitly account for shared files, processes, ports, credentials, application state,
and services. Tool-owned syntax such as generated-image placement remains on the owning
tool description/result rather than being duplicated in the prompt.

Fresh Agent startup is a separate composition mode, not a parent-history
projection. `general-purpose` and configured Roles receive their own system
identity, the exact delegated prompt, repository instructions, the session-start
git-status snapshot and, only when `skill` survives the effective runtime tool
set, an available-Skill catalog and complete eligible Role-preloaded Skill
content. `explore` and `plan` receive their specialized prompt and small
environment envelope without repository/status or catalog blocks; when `skill`
remains effective, eligible inline Role preloads may still contribute their
complete content independently of the omitted catalog. Skill runtime construction,
direct invocation routing, preload, and catalog evidence all require `skill` in
the effective Thread configuration. The L1 Skill module independently requires
`skill` to survive final runtime tool assembly. No Agent
receives parent messages, reasoning, calls/results, read-file residue,
parent-only Skill content, Memory prompt/data, or address roster. A resume then
projects the Agent's own canonical history under its recorded configuration and
the startup snapshot persisted with its execution. That snapshot is supplied on
the current Turn of every generation, including steering continuation,
`agent_message` resume, user-authored resume, and restart recovery; it is not a
generation-one-only overlay.
The complete matrix is specified in
[`agent-subagent-threads.md`](agent-subagent-threads.md).

Every provider request, including requests after tools and steering, passes
through `CanonicalContextProjector` at the native kernel's projection port. The
projector ignores the kernel transcript as history input and rebuilds provider
messages from prior canonical Turns plus the active `ItemRecorder`. The awaited
event subscriber makes completed assistant and tool Items durable before the
next provider request can begin. Tool calls and results remain paired, and
provider-visible timestamps come from persisted `acceptedAt`/`Turn.startedAt`
rather than terminalization time or the current clock. Unsigned canonical
`reasoning` Items never become assistant text. Within the active Turn only, the
runtime retains provider-signed thinking in memory and re-attaches it to the
assistant message that canonical projection already produced for the same
canonical Item. The retention key is the Turn ID plus provider, API, and model;
an identity mismatch omits thinking and continues without failing the Turn. If
a matching provider cannot prepare a payload from an unrecognised signature,
the gateway retries payload preparation once with signed thinking removed. The
fallback is provider-neutral and is available only before payload preparation;
provider, transport, and post-preparation failures remain unchanged. Retention
cannot add a message, tool call, tool result, or ordering, so the kernel
transcript cannot become a second history authority. Internal Memory Turns do
not install that projection port or overflow recovery; they send a top-level
snapshot of their raw in-memory transcript, which already preserves
same-execution provider parts without canonical re-projection.

Tool history is projected only from each Item's `modelCall` envelope. Admission freezes
the canonical identity, exact provider-visible name, arguments, and schema digest.
Projection loads that frozen inline or Thread-owned value and preflights its complete
argument/result dependencies before emitting the call/result pair. It never resolves
the call through the current registry or validates it against a later schema; tool
retirement, provider-name changes, and schema evolution cannot retroactively erase an
exchange. The digest remains immutable audit evidence. Corrupt or missing argument or
output payloads and missing image snapshots degrade the entire pair to bounded typed
evidence on this runtime user path; they never throw the Turn, emit an orphan result, or
derive replacement arguments from presentation fields. Evidence bounds its argument and
outcome fields independently, so call identity, reason, and correction always survive.
If a frozen output projection is unavailable, evidence explicitly marks that result
unavailable and never substitutes mutable Item output text. An unreadable duplicate does
not poison a later valid projection for the same output; the later valid payload heals
that transient state. Two readable projections with conflicting content remain
unavailable for the whole projection and cannot be healed by a third duplicate.

Redacted replay compatibility is decided against the admission schema. A compatible
copy freezes `redactedReplay` and later emits one indivisible marker/call/result unit;
the marker states that placeholders were not executed values and must not be copied or
retried. An incompatible redacted copy freezes executed `evidenceOnly`: the validated
source call still executes, but later history emits only typed evidence with the visible
outcome. Other rejected `evidenceOnly` calls never execute and project correction
evidence without a tool call or result. Replayable calls from one provider assistant
batch remain in one assistant message, their results follow in call order, and any typed
evidence from rejected members is appended after that complete batch. Projection never
splits the assistant message around evidence, so the batch's unmodified signed-thinking
blocks are attached exactly once.

The active Turn alone keeps a transient raw-call overlay for admitted executable calls,
so an immediate follow-up provider request observes the exact value that executed. The
overlay is never persisted and is unavailable to later Turns, restart, fork, or
compaction. Once cancellation is observed, sequential and parallel batch loops stop
before admitting any remaining call; no Item or argument payload is created for those
unadmitted calls, while already admitted calls settle as interrupted results.
Fork and child inheritance copy payload-backed tool arguments when available. A missing
argument payload is recoverable inspection data rather than a hard dependency: the
canonical reference survives, and later provider projection emits
`argumentPayloadUnavailable` evidence instead of failing the user operation.

Direct slash and natural-language inline Skill routing run during the same admission
boundary only when the canonical `skill` tool survives effective runtime
assembly. Inline Skills are side-effect-free by contract; shell expansion and all
execution overrides require isolated execution through the canonical `skill` tool.
Validated inline guidance is persisted as `skillInvocation` evidence immediately before
the unchanged canonical `userMessage`. Model-tool invocation persists the same payload
after its complete tool Item. Every provider boundary therefore receives Skill guidance
only through canonical projection; no direct-prompt overlay, generic prompt builder,
private steering message, or reminder parser is a second history authority.

For every ordinary input, main records `turnEnvironment` evidence containing the
accepted UTC instant, local date/time, IANA timezone and offset, locale, working
directory, execution/conversation mode, reply identity, and Today Node identity/title.
The Today Node ID is application-owned; its document-authored title projects through a
separate untrusted evidence block.
The first environment payload in an epoch projects a complete snapshot. Later payloads
project only changed fields; the accepted instant is normally the only mandatory delta,
while stable timezone, locale, working-directory, mode, identity, and Today values do
not consume repeated provider tokens. Reset or compaction starts a new baseline.
Stateless provider calls still resend the retained historical messages. Those earlier
reminder bytes are an unchanged cacheable prefix; they are not regenerated as new
current-Turn evidence. "No repeat" in this contract means that a later Turn appends only
its delta rather than appending another copy of unchanged state.
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
Projection emits a complete first snapshot and deterministic later field-level diffs.
An unchanged snapshot emits no reminder block; changed nullable fields and removed
panels emit explicit tombstones. Replaying the same canonical payload sequence
reconstructs the same snapshot/delta bytes.
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
Messages become assistant content, while canonical reasoning contributes no
provider message because canonical history does not retain provider-private
reasoning signatures. The runtime never substitutes `[Reasoning]` or another
text marker. Command, file, MCP, dynamic,
Agent-task, and web Items become paired provider tool-call and tool-result
messages using the frozen projection recorded for each complete output. Dynamic tool
results retain their ordered text, JSON, and actual image content at the provider
boundary. Each image is preceded by a stable identity marker derived from its alt text
and canonical source filename or path, plus immutable snapshot MIME and byte length;
images no longer degrade to filename-only text. Plans and context
reset Items select context state rather than becoming user prose. The assistant channel
is a few-shot demonstration of the model's own prose, so a marker Tenon authors into it
teaches the model to write more of the same: the former `[Subagent ...]` line was
observed teaching a Thread to invent lifecycle kinds that do not exist and render a
hallucinated delegation to its user. Subagent activity and viewed image Items therefore
contribute no provider content, and because an Item that contributes no content must not
act as a boundary either, they are skipped before the pending-user and tool flushes
rather than closing an assistant message that a Subagent spawn recorded mid-batch. The
model still learns what it delegated from the `agent`/`skill` tool call and result, and
learns each terminal transition from the task notification, or for an isolated Skill from
the awaited `skill` result; the Item itself exists for the parent-visible row. The one
authored line that remains in this channel is the redacted-replay notice, which names the
argument paths a completed tool call no longer replays and is required to stay atomic
with that call rather than degrade to separate evidence.
A compaction serializes its lossy summary, uses
its validated reducer checkpoint to restore complete Skill/Role catalogs, inline Skill
instructions, user view, Thread state, file/Node observations, and optional durable
instructions, then continues with its declared preserved tail. Checkpoint hashes and
payload references remain canonical state and are not sent as model guidance. The covered
raw range is not sent as a second copy.

At each canonical tail position, all contiguous text evidence is serialized into ordered
`<context-evidence>` children inside one provider-facing `<system-reminder>`. A referenced
image flushes the accumulated text bundle before its bytes, so text/image/user-content order
is never changed; later text starts another bundle only when that ordering requires it. The
wrapper is only a serialization boundary: typed canonical evidence and host-assigned
`kind`/`authority`/`purpose` metadata remain authoritative. Skill and Role catalog payloads
retain their hashes, identities, sources, and change records for reduction and audit, while
their provider projection contains only mode, meaningful delta state, names, distinct
display names, descriptions, and usage guidance. Skill invocation similarly omits storage
identity, content hash, resource root, and admission timestamps from model-visible prose.
Literal user-authored `<system-reminder>` or `<context-evidence>` text is never parsed or
upgraded, and there is no compatibility parser for those wrappers. The active provider
supplies message metadata. No hidden provider transcript is stored or used as a history
authority.

## User Content And Attachments

`ThreadService` resolves user content at admission before it records the
`userMessage` Item. The same normalized content is persisted and passed to the
provider for initial input, steering, and later history reconstruction.
When structured input contains attachments or Node references but no non-empty user
text, the provider serializer adds one deterministic request to review the attached
files, attached images, and/or referenced Outliner Nodes. That text is derived only at
the provider boundary; canonical user content continues to record exactly what the user
submitted.
Every attachment projects as a `[[file:<label>^<provider-readable-path>]]` marker at the
same structured position where the user placed its composer atom. Every Node reference
projects as `[[node:<label>^<node-id>]]` at its original position. The serializer joins
those markers with the surrounding text into one user narrative, preserving whitespace
and position. It then appends one independent attachment block per file in attachment
order: name, MIME type, source byte length, readable path, file/directory tool guidance,
and any bounded extracted text. An image attachment block reports its stable artifact
id, source and observation dimensions, both scale factors, and the full
observation-to-source matrix, then includes only its immutable observation bytes. The
inline marker and the independent resource block are both
required: the marker preserves what the user wrote and where, while the resource block
describes what the model can inspect. Multiple files, Nodes, and images therefore retain
one model-visible identity grammar and exact user order without parsing markers back
into canonical state. Resolved canonical input requires every image to carry an
immutable `artifactRef`, requires its artifact original to match the attachment source,
and forbids an artifact on non-images. Admission rejects an invalid shape before
publishing the user Item. If corrupt canonical history violates the invariant or an
admitted observation later becomes unavailable, projection emits an explicit textual
marker and continues; it never falls back to mutable original-path bytes. Failure to
materialize a readable artifact path is weaker than rendition loss: projection records
the error, labels only the path as unavailable, and still includes retained observation
bytes.

Attachment sources are reference-only. `localFile` records a canonical live
path; `threadPayload` records a lowercase SHA-256 digest, MIME type, byte length,
and safe display filename. Neither source carries base64 or an unbounded byte
array. A path-backed regular file is canonicalized without being copied and has
no shared source-size ceiling. A pathless browser `File` crosses preload in
1 MiB chunks into staged Thread storage, with a 2 GiB per-resource budget and an
8 GiB per-Thread quota. Completion hashes and atomically publishes the payload;
failure, cancellation, startup recovery, draft removal, and unreferenced-resource
reconciliation reclaim incomplete or orphaned data.

Non-image provider input exposes the readable path through both the file marker and its
independent attachment block; stable instructions define percent-decoding plus
`file_read` for files and `file_glob` for directories. A `localFile`
uses its live canonical user path; a `threadPayload` uses an execution-lifetime copy at
a deterministic Thread/digest/filename path under Agent scratch. Reprojection across
Turns and restart therefore preserves the marker bytes and cache prefix. The runtime
removes that observation when execution ends, and model or tool writes to it cannot
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
supported images add the verified Thread-owned bytes at the provider boundary. An
available Node resource exposes both an application-authority `readable_path` and the
same untrusted-label file marker grammar used by composer attachments. The
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
- `agent`, `agent_message`, and `task_stop` produce Agent-task Items
- web and image activity use their canonical Item kinds

OpenAI Responses requests use the provider's detailed reasoning-summary mode.
The runtime preserves every delivered summary part in the canonical `reasoning`
Item; the renderer never substitutes the first line for the expanded body.

Every top-level function tool in an `openai-responses`,
`openai-codex-responses`, or `azure-openai-responses` payload carries an explicit
boolean `strict`. The payload hook preserves an existing boolean and normalizes an
absent value or the Codex adapter's `null` sentinel to `false`. A different value is a
local payload defect and fails before network I/O. This is a wire-level declaration of
Tenon's current non-strict optional-property semantics, not a schema rewrite or a claim
that the endpoint supports strict constrained sampling. Function parameters and every
non-function tool record remain unchanged. The rule applies equally to official OpenAI,
custom relay, Codex, and Azure Responses paths.

Only custom OpenAI Responses endpoints install the resilient SSE fetch. Non-SSE
responses pass through unchanged. Each SSE frame is buffered only through its blank-line
boundary; ordinary, terminal, comment, event, multi-line-data, malformed-JSON, and
`[DONE]` frames retain their original bytes. A frame carrying a non-empty top-level
`error` is dropped only when its `type` is not `response.completed`, `response.failed`,
or `response.incomplete`; `null`, blank, and empty-container error values pass through.
The dropped value is secret-scanned and bounded before its type and snippet enter
diagnostics; raw frame bytes are never persisted. At most 64 noise frames per response
are scanned and reported. Further matching frames are dropped without diagnostic work.
A clean close after such a dropped frame surfaces the first sanitized snippet in the
terminal error.
The wrapper aborts a stream that delivers no chunk for 300,000 ms. This fixed idle
timeout matches the long silent gaps valid at high reasoning effort and is separate from
the configurable whole-request timeout. Official `api.openai.com`, Azure Responses, and
non-Responses adapters do not use this wrapper.

An execution or streamed Item is recorded with `item/started`, optional typed deltas,
and one terminal `item/completed`. Initial evidence and user facts are complete inside
the atomic `turn/started` event. Subagent activity already queued while the Thread was
idle is admitted before that evidence and the trailing user message, so it settles into
prior canonical history without breaking the active user boundary; it contributes no
provider content of its own once there. Later steering evidence and
input use `items/completed`. Neither path synthesizes a streaming lifecycle.
The recorder applies every delta to its current decoded Item before the next provider
event can observe it. Core may coalesce adjacent string deltas for the same Thread,
Turn, Item, and delta type into one equivalent 40 ms downstream write; a lifecycle
boundary or a different Item/type flushes the group first. Dynamic-tool output values
remain discrete. Item completion therefore carries the exact chunk-current final Item
even though durability, projection, IPC, and renderer work run at the lower coalesced
rate. A failed downstream delta group is reported and dropped without blocking later
deltas or lifecycle; the terminal Item snapshot remains the canonical repair boundary.
The recorder validates local provenance and rejects completion before start. A raw
provider call first resolves canonical identity, runs the resolved tool's
`prepareArguments` once when present, and checks the resulting value with Tenon's
TypeBox compiler without `Value.Convert` or any generic coercion. The exact prepared JSON
then supplies redaction, canonical admission, capability evaluation, and execution. The
kernel persists one admission decision and emits `tool_call_admission`; only admitted
calls may emit `tool_execution_start` and reach capability evaluation or execution.
Unknown tools, malformed or provider-truncated arguments, and argument-persistence
failure complete a failed Item from `evidenceOnly` without a capability decision.
Presentation arguments and visible results use bounded projections with explicit
truncation metadata. Tool-result details pass through the shared persistence slimmer
before entering an Item. Dynamic image result lists also have a fixed maximum length.

The kernel owns a fresh deterministic-admission guard for each `runKernel` invocation.
After the second identical resolved `invalidArguments` rejection it removes that canonical
tool from later request snapshots while retaining every other tool. At eight deterministic
rejections it issues one final tool-free provider request and schedules no further provider
loop, including when that response hallucinates a tool call. `invalidArguments`,
`truncatedArguments`, and unresolved calls all count toward that ceiling; execution
exceptions, provider and persistence failures, capability outcomes, permission decisions,
and cancellation do not. `truncatedArguments` and unresolved calls never quarantine — the
first names an output-token limit rather than a defective tool, and the second has no
resolved tool to remove. Provider call IDs do not affect fingerprints. The exact tool snapshot sent in each
request is also the only registry eligible to execute calls from that response.
When a custom Responses stream is retried after it already emitted content, the kernel
emits the main-process-only `message_restart` event with the interrupted partial before
replacing the trailing provider-history message. The normalizer completes the interrupted
`agentMessage` and optional `reasoning` Items from that authoritative partial, marks the
message phase `interrupted`, clears its active pointers, and opens fresh Items for the new
stream. The interrupted Item remains visible but is excluded from final-answer readers,
Memory extraction, later provider context, signed-reasoning replay, and usage accounting.
The transcript therefore shows an interrupted segment, the existing reconnect indicator,
and a fresh segment; retry deltas never concatenate onto the interrupted Item.
`message_restart` is not a Core command, persisted notification, or renderer protocol
variant; `interrupted` is a durable Core `MessagePhase`.
Before admission, the kernel preserves the first non-empty provider call ID that is
unused in provider-visible history and the current run. An empty ID or any same-batch
or later collision is remapped to a fresh Turn-local UUIDv7. Admission, execution,
mutation causation, Item identity, result pairing, and subsequent history use only that
canonical ID; the original provider ID is transient stream-correlation data.

Every textual tool completion also writes its complete normalized result to the
Thread-owned content-addressed payload store. The Item keeps only a bounded
renderer/history projection plus an immutable `outputRef` containing digest,
MIME type, byte length, and summary. `thread/item/output/read` validates the
requested Thread/Turn/Item/ref tuple, MIME-selected file, byte length, and SHA-256
digest before returning text. Dependency equality and collection deduplication use the
complete typed reference: context payloads include digest/MIME/length/schema/kind,
resources include digest/MIME/length/file name, and outputs include
digest/MIME/length/summary. A shared digest never aliases references whose remaining
identity fields differ.
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
data URL. Every accepted dynamic-tool image stores one immutable `artifactRef`; the
artifact's Thread-owned observation is the exact bounded image exposed to the provider,
while its optional original remains available to file-oriented consumers. The adjacent
provider text identifies the artifact and reports source size, observation size, both
scale factors, and the observation-to-source affine matrix. This gives the model enough
information to relate the bounded observation to the admitted source-image pixel plane.
The runtime does not inspect, validate, convert, or rewrite later tool arguments.
Delegated-work request budgets are host-owned circuit breakers, not model tool
arguments or per-child allocations; their admission and accounting contract is
specified in [`agent-subagent-threads.md`](agent-subagent-threads.md).

A tool result that reports its OWN failure is delivered to the model as an
ordinary result, not raised as a host error: the envelope carries guidance
written for the model to act on. The host therefore requires no success-only
evidence from one — a refused Skill invocation records no invocation, because
none ran. Demanding it turned every refusal (an unknown Skill name, a disabled
one, an exhausted child budget) into a dead Turn, and the guidance never reached
the model that needed it.

An OPTIONAL string tool argument the model leaves blank means "not specified", and
is recorded as `null` rather than as an empty string: a Subagent spawn's `model`,
`reasoningEffort`, and `message`, and a file change's path, which is named
`(unknown path)` when blank exactly as when absent.

The canonical Item codec correspondingly tolerates an empty value in every Item
string a tool call can put one in. Some are not optional and cannot be `null` —
a web search's `query` and a command's `command` are required by their schemas,
and their producers write `''` when the model omits or blanks the argument, so a
decode that refuses empty could never read what the producer writes. Others are
not the model's words at all: a web result's `title` and `url` come from the
search backend, which no part of this system controls.

This is the A12 line drawn at the decode boundary: fail closed on data that would
corrupt the store, never on a blank string that means nothing either way.
Refusing one cost an entire Turn — an Item is decoded before it is recorded, so
the run died with nothing on disk to explain why. Where a blank value would leave
a user surface naming nothing, the surface falls back to its subject-less copy
rather than quoting an empty string.

Event admission, the payload store, and the canonical Item codec independently
require an image MIME type; invalid MIME metadata produces a structured omission
instead of a provider image block.
Base64 length is validated before decoding, with independent per-image and
per-tool-call byte budgets. Invalid, oversized, over-count, over-total, and Thread-quota
images produce one structured omission summary instead of failing the complete tool
result. Images within the generic source budgets pass through the common 2,000 px /
4.5 MiB normalizer before persistence. Binary `data` fields are replaced before full
textual output persistence, so neither small nor large base64 images leak into text
payloads. Forking copies each available managed rendition under the target Thread while
preserving the same artifact reference; a missing image rendition is skipped rather
than aborting the fork. This exception is based on actual artifact use, not MIME type;
an ordinary referenced `image/*` resource remains required. Inherited-context scans are
recursive, so the same distinction governs child copying and pressure retention. A
Thread-scoped preview resolves the best available rendition to
a stable disposable scratch materialization rather than exposing canonical resource
paths. Deleting a Thread deletes only that Thread's payload directory and materialized
copies; it never touches an external original.

## Tools And Causation

`ToolRuntime` exposes tools through the effective Thread configuration, Core scope,
and canonical registry identity. It compiles each runtime-provided schema before
exposure; one invalid dynamic, extension, or MCP contribution is skipped with a bounded
diagnostic while valid siblings remain available. Static catalog schemas are guarded in
the test suite. Dynamic and extension implementation mismatches degrade like malformed
runtime schemas. Core/capability mismatches, duplicate identities, and enabled
valid extension contracts with no implementation remain hard registry defects
for root Threads; child Agents skip unavailable extension handlers and retain a
bounded diagnostic under A12.

Child tool assembly also applies the persisted execution policy, not just the
current configuration. Role `tools: ['*']` is stored as a null requested ceiling
and inherits the resolved parent pool; an explicit empty Role list is a zero-tool
configuration defect and refuses before provider I/O. The isolated-Skill parser
normalizes omitted `allowed-tools` to an explicit empty runtime ceiling, which
remains intentionally tool-free. Agent Role catalog
evidence is emitted only when the effective runtime contains an executable
`agent` tool. For a child, that requires persisted nesting permission, a non-leaf
Agent kind, and a requested ceiling that admits `agent`.

Specialized execution is fail-closed at the argument-dependent boundary.
`explore` and `plan` may execute Bash only when capability classification proves
every action is repository inspection. They may execute an extension or MCP tool
only when every classified action kind is read-only; an empty, unknown,
mixed-write, or new classification yields a structured unavailable result. A
worktree policy likewise rejects live-outline import commits, and all descendant
file and shell writes use the persisted worktree path as their containment root.

The kernel freezes a schema-valid canonical call
before `ToolRuntime` evaluates argument-dependent capability blocks. A valid blocked
call therefore retains its call/result pair and structured `operation_unavailable`
audit; an invalid call never reaches capability evaluation. Admission starts the
canonical Item, and every admission receives a terminal Item, including rejection,
native unavailable, cancellation, or a thrown result.

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

Every descendant Turn feeds a live in-flight tally from
`PiEventNormalizer.completeAssistant`, immediately after the normalizer accumulates each
assistant message's `totalTokens`. Diagnostics capture is inspection-only and cannot drop
or duplicate accounting. Non-user descendant Turns also expose a live budget port
(`remaining`, `used`, `total`) to the native kernel. Each read resolves the authoritative
ancestor pool, re-reads persisted usage, and includes every active Turn's observed usage,
including the current Turn. When a per-child contribution cap has less remaining, the
same port reports that tighter binding constraint.

The executor passes the port through without overlaying its normalizer total. The kernel
uses `remaining` directly and never subtracts snapshots, so a switch between pool and cap
denominations cannot falsely interrupt a healthy Turn or bypass an exhausted cap. An
uncapped top-level spawner that holds the pool is outside it; an explicitly capped child
that anchors a pool remains a covered member. Explicit covered descendant user Turns omit
the port and warning callback while their usage remains in the sibling tally and accrues
on completion. While a descendant is uncovered, the observer retains its usage locally
and the port returns `null`; if an ancestor pool appears mid-Turn, that contribution joins
the live pool tally immediately. The first model call is never blocked. At every later
model-call boundary, before draining steering or emitting the next `turn_start`,
`remaining <= 0` interrupts only genuinely outstanding model work, such as completed
tool calls. A terminal assistant answer stays completed even when exhausted and racing
steering remains queued and undelivered. Thus every emitted `turn_start` still has its
matching `turn_end`.

The first 80% crossing of the binding constraint requests one host-generated budget
notice carrying its actual `used` and `total`. The notice uses the same
canonical steering admission and diagnostics path as external steering, so it is a
durable `userMessage` rather than a private runtime message. Warning delivery is
advisory: failure is logged and execution continues. Steering diagnostics become
consumed only when the native queue is drained into a later provider context; queue
acceptance alone does not mark delivery.

Background Agent completion is host-pushed, never model-polled. Once the child
Turn and transcript append settle, a persisted `{agentId, generation}` event
materializes at the direct parent's next idle admission boundary as canonical
input with a typed non-user notification prefix. Foreground execution instead
returns once through its original `agent` tool result and emits no notification.
The output scanner runs exactly once before either boundary. Pending completion
events are idempotent across restart and cannot overtake already-admitted genuine
user input. Nested delivery advances one parent edge at a time so only a parent's
synthesized result reaches its own parent.

Completion notifications and Agent-to-`main` message envelopes remain durable
queued work while either endpoint has an undelivered row. Catalog projection uses
that durable fact to protect terminal descendants from finished-item deletion.
One missing or corrupt child Turn rolls back only that delivery claim and the
pass continues with its siblings; it cannot permanently block unrelated results.

Agent steering and stop resolve only reachable `collaboration` Threads and reject
self-targets. Unified `task_stop` checks both the caller-owned shell registry and
the reachable Agent registry; an identity collision is an error rather than a
dispatch guess. Shell success and expected failure are returned as structured
local-tool results so the canonical Item keeps error code, recovery guidance, and
metrics rather than collapsing them into a generic thrown-error string.

Interrupt aborts provider and tool work through the Turn signal, including
provider and tool initialization before `prompt()`. Any execution
Item still `inProgress` is completed as `interrupted`; unexpected executor
failure completes it as `failed`. The terminal Turn records the corresponding
status and error.

If cancellation arrives after a schema-valid call is prepared, the runtime preserves
its admitted envelope and records an explicit aborted outcome while skipping the tool
side effect. Cancellation is never relabeled as `invalidArguments`. Every raw call in
the returned assistant batch still receives an admission decision, so the live
no-projection kernel path cannot retain an unsanitized trailing tool call.

Orderly service shutdown is a bounded cancellation boundary. Active Turn
completion, collaboration settlement, and transcript append chains share one
deadline. Work that settles inside it is flushed; expiry records degraded
shutdown diagnostics and proceeds with canonical and orchestration rows intact
for startup recovery, rather than waiting indefinitely for a re-registering Turn
or wedged inspection-only transcript write.

## Context Planning And Compaction

Every provider boundary, including post-tool requests and steering, runs one global
budget plan over the stable prompt, canonical tool schemas, reduced history, current
evidence, images, and the active Turn. The input limit reserves provider framing plus up
to one quarter of the model context window for output, capped by the model output limit.
The active Turn is mandatory. Assistant tool calls and their complete result set form one
indivisible unit; a `redactedReplay` marker/call/result triple is one distinct
indivisible unit. An orphan, duplicate, incomplete exchange, or marker separated from
its redacted call fails closed. If the
stable prompt, tools, and active Turn alone cannot fit, the Turn fails with an explicit
capacity error rather than dropping the current request.

A child Turn's leading `inheritedContext` Item is historical context even though it is
stored before the task in that same Turn. Its protected boundary begins at the first
following current-admission Item. Budget recovery may compact the inherited Item with an
exact item cursor, but it cannot compact the current admission evidence or task.

When older history prevents the protected tail from fitting, preflight aligns its
retained provider-message suffix to the next canonical Turn boundary. It stages that
compaction, reprojects the exact summary/restored state and protected tail, and commits it
only if the resulting request fits. Otherwise it discards the staged payloads and advances
monotonically through later complete Turn boundaries, ending at the active admission.
Staged payload cleanup re-enters the Thread mutation mutex before it computes live
references and prunes, so it cannot race a steering or execution-time evidence write.
Only the first fitting candidate becomes one canonical `automaticPreflight` Item; failed
candidates are neither history nor diagnostics. The active Turn is never a compaction
candidate. Provider-overflow recovery may compact all prior Turns and preserve only the
active Turn. Manual `/compact
[instructions]` may compact the current epoch while the Thread is idle. Both forms store
exact covered/preserved cursors, a `source=deterministic` bounded lossy summary, and a reducer
checkpoint for the Skill and Role catalog journals, active inline Skill invocations,
latest user-view baseline, and non-invalidated file/Node observations. Observation
checkpoints reference the existing frozen projection and complete output instead of
copying tool text. Optional manual instructions remain typed application guidance after
the summary; they are not parsed from reminder text. A compaction with no eligible
content is an idempotent no-op. If the deterministic summary itself exceeds its character
budget, it retains the newest complete summarized Turn suffix. Only a single Turn that
cannot fit alone is truncated internally, with explicit omission markers and both its
leading and trailing context retained. An `inheritedContext` evidence Item is summarized
from its validated typed payload recursively; its display summary is a heading, never a
replacement for the inherited parent Turns.

Reducers recursively evaluate typed inherited context and treat an earlier compaction
checkpoint as authoritative state at that point in the effective history. Consequently,
compacting a child or fork after deleting its source Thread preserves inherited
catalogs, active Skill instructions, the latest view baseline, and active observations;
compacting that result again preserves the same state until later canonical Items change
or invalidate it. Every nested context/output dependency is validated before the new
checkpoint is admitted.
If a previously admitted inspection payload later becomes unavailable or disagrees with
its checkpoint, reduction records a typed degradation entry and clears or skips only the
affected catalog, baseline, or observation. Projection renders the deduplicated marker;
compaction, fork, and delegation remain usable. Strict dependency rejection remains at
payload publication and Thread decode, not on the provider-request path.

A successful non-preview `node_create`, `node_edit`, or `node_delete` invalidates all
active Node observations because one bounded `node_read` can project descendants,
references, and definition-dependent content that cannot be reconstructed from mutation
arguments alone. Successful `outline_undo_stack` undo/redo has the same effect; list,
preview, failed, and interrupted calls do not. File observations remain path-keyed and
invalidate after a completed mutation of that path. The reducer resolves canonical
arguments once per Item. A structured `evidenceOnly` summary may identify a conservative
invalidation target, but it never creates a new observation. When a successful Node or
file mutation's argument payload is unavailable, the reducer clears every observation
in that domain rather than checkpointing a snapshot that may already be stale.

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

Tenon owns the turn loop, runtime state reduction, tool batching, retry policy,
and model-error taxonomy under `src/main/agent/runtime/kernel/`.
`@earendil-works/pi-ai` is transport-only behind `ModelGateway`; provider
failures cross that port as complete terminal assistant messages, while
`ModelError` is only a derived classification used for policy decisions.
Tenon consumes `pi-ai` directly and does not use `pi-agent-core`: the native
kernel remains the sole owner of Turns, tools, projection, retries, and durable
history.

`piModels` owns one provider collection. Authentication capability comes from
each provider's `auth` definition rather than a parallel OAuth registry. OAuth
sign-in and sign-out run through `Models.login()` / `Models.logout()`; main maps
the provider-neutral `AuthInteraction` to the renderer event union while keeping
credentials in main. Flow cancellation aborts the whole interaction, and a
provider may independently abort one prompt when a callback race completes.
After a successful login, main creates the provider connection row and refreshes
that provider's dynamic catalog before returning settings. OAuth providers that
also accept a normal pasted API key expose that fallback; GitHub Copilot does
not, because its alternate token is an ambient integration credential rather
than a key-entry workflow. Request dispatch leaves stored OAuth credentials with
`Models.applyAuth()` so provider-derived headers and per-credential endpoints are
preserved; explicit `apiKey` overrides are reserved for an unsaved form key and
the model-specific CC Switch boundary.

The injected credential store persists one type-tagged credential per provider
in `agent-secrets.json`. Its serialized `modify()` operation is the only write
path, so concurrent OAuth resolutions share one rotated token; `list()` returns
only provider IDs and credential types. A separate `agent-model-catalogs.json`
store persists validated dynamic text catalogs. Startup restores these catalogs
without network access before Thread and Automation initialization; settings and
runtime-config reads await the same memoized restore as a defensive boundary.
Saving a pasted key and login best-effort fetch and persist only the target
provider's current catalog; a catalog warm failure does not turn a successful
credential write into a failed save. The explicit provider refresh command still
reports failures. Connection validation uses an isolated provider collection and
in-memory catalog store, so testing an unsaved key cannot mutate live model
choices or durable state. Refreshability is provider-level metadata even while
the model list is empty; capability rows list only models that actually exist.

Provider auth resolution is provider-scoped. Custom OpenAI-compatible local and
remote endpoints use separate internal provider identities, so registering a
localhost validation probe cannot leave a later remote request on the inert
`local-endpoint` sentinel. CC Switch remains the model-specific exception at the
application boundary: main resolves the selected registry model's source key
immediately before dispatch and supplies it as an explicit request override;
without that override its pi provider reports unconfigured. Neither the pi
provider resolver nor renderer receives the registry key. Provider-specific
endpoint materialization, including Cloudflare account and Gateway placeholders,
occurs inside provider dispatch after auth environment values have resolved.

Retryable provider request/stream failures use bounded Codex-style backoff. A Responses
request has one initial request plus a default budget of five retries: recovery ordinals
are `1/5` through `5/5`, for at most six transport requests. The initial request is not
retry zero and does not consume that budget. Pre-stream classification delegates to
pi-ai's canonical `isRetryableAssistantError`, so structured transient failures such as
`rate_limit_exceeded: Concurrency limit exceeded for account, please retry later` recover
without requiring an HTTP-status wrapper, while `insufficient_quota`, authentication,
validation, and other permanent failures remain terminal.

For a custom OpenAI Responses endpoint, an error after the stream has started is retryable
only when it is a classified rate limit, server failure, transport failure, legacy
termination, or known relay/idle stream interruption. Unknown statusless `badRequest`
messages stay terminal so invalid credentials, missing models, and exhausted quota do not
resend the full context. The default stream budget is three retries; an explicit provider
retry setting still wins. A pre-stream failure belongs only to the request budget and
cannot fall through into the stream budget after exhausting it. Material text or a partial
tool call does not suppress retry for a custom endpoint, because tools execute only after
the stream settles. Any fully parsed tool call suppresses retry. Only the legacy
premature-termination allowlist may salvage a message whose every tool call completed; a
429, 5xx, or transport failure remains terminal and cannot execute a mutating tool as
successful output. Stream retries wait through the same bounded exponential delay as
request retries. Official OpenAI and Azure Responses retain their legacy one-retry
premature-termination allowlist and do not retry after material output.

The kernel retry policy is the sole retry owner for transient failures and context
overflow recovery. `PiModelGateway` calls the transport with its request retry count
disabled, so configured attempts cannot multiply. Failed intermediate attempts do not
emit a canonical Turn error. The executor emits `turn/providerRetry/changed` only as
transient notification state, including the recovery class and retry ordinal, and clears
it when replacement output begins, recovery settles, cancellation wins, or the Turn
terminalizes. Request retries and stream reconnections create neither Items nor persisted
transcript history; only the final exhausted or non-retryable failure reaches the Turn.

Timeout, maximum transient retries, maximum retry delay, and cache retention are read
once at Turn execution start and applied consistently to each provider request. Custom
OpenAI Responses endpoints retain the configured cache policy; auxiliary naming alone
uses no cache retention and keeps its separate bounded request contract.

Provider cache affinity is the lowercase SHA-256 of
`tenon-agent-cache-affinity-v1`, the Thread ID, and the current context epoch ID separated
by NUL bytes. The initial epoch ID is `initial`; only a recorded `contextReset` starts a
new affinity. Ordinary Turns, steering, restart, compaction, and changes to the Thread
tree's grouping `sessionId` retain it. Tools are sorted by exact canonical name before
Agent construction, so equivalent registries serialize identically regardless of
assembly order.
Diagnostic redaction never participates in provider serialization, cache-control
selection, request fingerprints, or affinity. Exact admitted arguments remain in the
same-Turn transient overlay, so ordinary requests and immediate tool-loop prefixes are
unchanged. On a later Turn, a recognized credential is represented only by its durable
placeholder; the provider prefix after that historical call can miss once, which is the
necessary cost of not persisting the credential.

Anthropic Messages requests use at most four cache-control breakpoints. The stable
prompt's structured blocks split it into protected L0 firmware and the remaining stable
execution prompt; the provider adapter preserves the final tool and final user
breakpoints already present in the request. If an upstream OAuth identity block would
exceed the limit, that identity breakpoint is removed before either protected stable
breakpoint. The adapter sanitizes both the payload block and the text reconstructed from
`StablePrompt.blocks` before matching, so raw or already-sanitized lone surrogates retain
the same breakpoints. It never parses textual markers and adds no Anthropic metadata to
other providers.

## Turn Diagnostics

`PiTurnExecutor` creates one `TurnDiagnosticsCollector` from the effective configuration
and resolved runtime at Turn start. Every Provider Call records two different facts. At
the pre-adapter stream boundary, the collector reads the actual provider `Context`: the
exact system prompt, canonical-sorted tool definitions, and ordered messages/content
parts after projection, budgeting, and compaction. Planned protected-boundary and token
budget facts are attached to that same call. System prompt and messages are pooled by
stable SHA-256 fingerprints, so a later tool or steering call references its unchanged
prefix instead of persisting another full copy.

`CanonicalContextProjector` emits an observational provenance sidecar aligned one-to-one
with those prepared messages and their content parts. It identifies canonical user input,
typed context evidence and its kind, compaction output, assistant history, and tool
results. The sidecar is not provider input and does not affect message bytes, ordering,
budgeting, or cache affinity. Diagnostics persists it with each prepared window, and the
codec rejects any message or part-count mismatch. The renderer uses only this typed
sidecar to label context evidence; literal user text that spells a `system-reminder` or
`context-evidence` wrapper remains a regular text part. Ephemeral same-Turn signed
thinking uses assistant-history provenance because its canonical assistant message owns
the position; that classification does not make the signature durable or available to a
later Turn. Post-adapter payload fragments have no invented provenance and are presented
according to their recorded wire shape.

Turn-wide audit facts record the exact context epoch and cache affinity, L0/L1/L2
stable-prompt source blocks and fingerprints, canonical-sorted tool schema pool,
provider/model/API/configured-base-URL/transport selection, model limits, and retry/cache
settings. Configured-base-URL diagnostics remove URL userinfo, query, and fragment data
before persistence. These audit facts explain how the call was prepared; they are not a
renderer-reconstructed request or another context authority.

Each tool execution diagnostic records its admission disposition, canonical identity,
and schema digest when one exists. Assistant responses and tool observations pass the
same Secretlint-backed, high-confidence redaction policy before diagnostics persistence;
structured fields require both a credential name and a credential-candidate string, while
ambiguous values pass unchanged. Direct scanner failures retain the existing boundary
behavior: durable values fail open, while diagnostic copies are omitted. An off-main
durable worker rejection instead preserves the traversed JSON container and non-string
scalar structure, replaces every pending string with `[redacted]`, and emits one fixed
content-free warning. Raw recognized credentials and host credentials are not diagnostic
history.
Canonical-message snapshots and post-adapter request fragments are redacted only in the
diagnostic copy immediately before persistence. Serialized function-call arguments are
scanned only at their outer adapter boundary and nested JSON strings are left intact.
Each provider copy has a 64,000-character scan budget; text beyond it is replaced only in
diagnostics. The ordered budget is spent before one batched scan; sufficiently large
batches run the same whole-string scanner on the bounded Node worker pool, while small
batches run directly exactly once. A pooled request starts its five-second watchdog only
after leaving the queue for a new or idle worker; startup timeout releases capacity and
a late worker is terminated. A diagnostic worker error or watchdog timeout terminates
that worker and stores a typed whole-copy omission marker without a main-thread retry.
No chunk boundary can change a credential match. The live provider request and the raw
normalized value used for its fingerprint remain unchanged.
If diagnostic preparation or provenance alignment itself fails, the collector is
disabled for that Turn and `diagnosticsRef` remains null; provider transport, event
normalization, and the Turn continue.

The post-adapter provider payload is observed after compatibility, reasoning-summary,
and cache-breakpoint policy and immediately before provider transport. Diagnostics
retain the complete image-sanitized request as an ordered, reconstructable representation,
a SHA-256 fingerprint of that representation, and every cache-control path. Top-level
field insertion order is retained only to reproduce the payload; JSON object-key order
does not define model context order or precedence. Repetition-heavy `contents`, `input`, `instructions`,
`messages`, `prompt`, `system`, `systemPrompt`, and `tools` fields reference an ordered
content-addressed fragment pool, so unchanged stable prompts, tool schemas, and message
prefixes are stored once without replacing wire content with a non-reconstructable
summary. Array element order and message content-part order are never sorted or grouped.
Binary, base64 image, and image data-URL bytes are never copied into diagnostics; an
omission marker retains encoding, MIME when known, byte length, and digest. Capture is
observational only and cannot change provider request bytes, ordering, or prompt-cache
behavior.

Canonical message and request-fragment IDs are SHA-256 digests of their stable JSON
values. The main-process payload store verifies those content addresses on write, read,
and fork copy; structural codecs reject unknown fragment/message references and duplicate
activity or execution identities before the payload can reach the renderer.
Because a history fork creates new Turn and Item IDs, it also rewrites every diagnostics
accepted-input, tool-execution, and compaction Item reference through the source-to-fork
map, republishes the payload under the fork, and installs the resulting new digest/ref on
the copied Turn. A fork never retains a diagnostics payload that names source-owned Items.
Diagnostics are inspection-only: a missing, corrupt, or unpublishable diagnostics payload
is omitted from Details and the fork while canonical history and its required payloads
continue to copy normally.

The transport `onResponse` boundary records when HTTP headers arrive, the status code,
and the first non-empty provider request ID from a fixed allowlist. Arbitrary response
headers are never persisted: cookies, authorization material, and unrelated volatile
metadata therefore cannot enter Turn diagnostics. Transport response facts remain
separate from the completed assistant response because headers may exist even when body
streaming later fails. An adapter or non-HTTP transport that exposes no response hook
provides no transport facts.
Each custom Responses Provider Call also owns an ordered `streamNoiseFrames` list. Every
entry records the chunk-arrival time, bounded frame type, and bounded secret-scanned JSON
snippet for one frame the resilient fetch removed. The model-call diagnostic JSON export
includes this list beside the transport and normalized response facts. An older
diagnostics payload may omit the optional list; new calls write it even when empty. The
producer, collector, and decoder enforce a 64-entry maximum. The collector clamps a stale
or invalid arrival time to the owning request and normalizes an empty frame type to `null`,
so inspection-only relay metadata cannot invalidate the Turn's complete diagnostics.

An assistant `message_end` closes the latest open Provider Call with its provider-neutral
normalized assistant message, real usage, stop reason, error details, and receive time.
A `pending` stop reason is streaming-only; if one appears on an impossible
`message_end`, diagnostics skips it rather than widening the durable terminal
response union or failing the Turn.
A failed or retried call may legitimately have no response. The collector also appends one
typed ordered activity stream. Initial and steering admission, every Model Call, parallel
tool-execution batches, request/stream retries, and automatic-preflight/provider-overflow
compaction are recorded at their runtime boundaries. Tool executions retain call identity,
name, timing, status, and an optional canonical Item ID, so transient tools remain visible
without inventing an Item. Call identity is unique within its provider-call execution batch
because compatible providers may reuse values such as `call_0` on later requests;
non-transient Item ownership remains unique across the activity stream. Open executions
inherit the terminal Turn outcome, including `completed` for a successful Turn.
Each batch names the immediately preceding source Call and, once observed, the immediately
following Call that consumes its results. Retry and compaction activities use the same
adjacent-Call links; preflight compaction before the first Call has a null source. Renderer code
projects this activity stream and never infers causes from missing tool Items or adjacent
requests. The response itself remains the provider fact rather than a duplicate Item projection.
After provider execution returns, Thread terminalization first closes steering admission,
drains every accepted steering delivery, then republishes the collector's final state. It
canonicalizes the complete versioned diagnostics payload, writes it content-addressed
under the Thread, and stores the typed reference in `Turn.execution`. Diagnostics are an immutable audit sidecar,
not provider history and not input to future execution. Active Turns and feature Turns
that never contact a provider have no reference; the renderer never fills that absence
from current settings. Diagnostics publication is best-effort after provider execution:
payload construction, validation, quota, or storage failure leaves `diagnosticsRef: null`
and reports an internal warning, but never changes the real Turn status, response, or
usage.

Fresh projection reducers are constructed at every provider boundary so environment,
view, and additional-context deltas are replayed from canonical state. They share
Turn-scoped immutable payload read caches for context payloads and full tool outputs,
each keyed by the complete typed reference. Every provider boundary records the context
and output keys actually visited by freezing and projection, including recursive
inherited-context reads; the freeze contributes all active frozen output keys even when
projection publication fails. When the boundary ends, successful cached reads absent
from those active sets are evicted. A payload that remains reachable therefore hits
storage once per Turn, while compaction releases context and output payloads the provider
can no longer reach; a later re-entry reads and verifies them again. Missing or failed
reads are not negatively cached and can become available after a new canonical write.
