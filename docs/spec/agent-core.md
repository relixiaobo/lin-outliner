# Agent Core

Agent Core is Tenon's single execution model. Product code, IPC, persistence,
renderer state, and user-visible language use the same four concepts:
`Thread`, `Turn`, `ThreadItem`, and `ThreadGoal`.

## Domain Model

A `Thread` is the durable container for ordered work history and configuration.
It owns stable UUIDv7 identity, lineage, source, model provider, working
directory, timestamps, status, and optional loaded Turns. `sessionId` groups a
root Thread with its descendants; it is only a grouping key.

A `Turn` is one accepted input and its resulting ordered Items. At most one Turn
is active per Thread. A Turn is either `inProgress`, `completed`, `failed`, or
`interrupted`. Terminal Turns are immutable.

A `ThreadItem` is the smallest persisted history fact. Canonical Item kinds are:

- `userMessage`, `agentMessage`, and `reasoning`
- `commandExecution`, `fileChange`, `mcpToolCall`, and `dynamicToolCall`
- `collabAgentToolCall` and `subAgentActivity`
- `webSearch` and `imageView`
- `contextEvidence`, `contextReset`, and `contextCompaction`

Items with execution status start as `inProgress` and complete with a terminal
status. A new `turn/started` event atomically carries its already-complete initial
evidence and user Items. Later streamed and executable Items use `item/started`,
optional `item/delta`, and exactly one `item/completed`; later already-complete facts
use one `items/completed` event, which may publish one or more Items in canonical
order. No initial or completion event accepts an `inProgress` executable Item.
Completed Items and terminal Turns are immutable.

Every tool Item carries one immutable `modelCall` envelope in addition to its
type-specific audit and presentation fields. The envelope is the sole authority for
provider tool-call history and has exactly one disposition: `replayable` stores the
exact admitted canonical identity, provider-visible name, model arguments, and schema
digest; `redactedReplay` freezes the same provider name and digest with a
structure-preserving redacted value plus RFC 6901 paths; and `evidenceOnly` stores a
bounded redacted summary, stable reason, and correction without a replayable call.
The digest is audit evidence, not future admission authority. Historical projection
never consults the current registry or schema to rewrite or erase an admitted exchange;
only a missing or corrupt persisted argument/result dependency degrades the pair to
typed evidence.
The runtime preserves the first non-empty unused provider call ID and replaces empty or
repeated IDs with fresh Turn-local UUIDv7 values before admission. Only the resulting
canonical ID identifies the Item, execution causation, paired result, and replay.
Command text, file changes, MCP/dynamic display arguments, Agent-task summaries,
results, and host execution metadata never reconstruct model arguments. In particular,
`commandExecution.cwd` is the Thread's host-resolved working directory and is not part
of the `bash` model call. During the active Turn only, a transient raw-call overlay lets
the next provider boundary observe the exact just-executed arguments. It is not durable;
later Turns, restart, fork, and compaction use only the frozen envelope.
The envelope is required at the codec boundary. Pre-envelope tool Items are not
decoded, migrated, reconstructed, or routed through an alternate reader; pre-release
userData is reset when this storage format lands.

Every `userMessage` stores its admission-time `acceptedAt`. The initial Item uses
the Turn start instant; steering records one instant for both Item persistence and
recorder completion. Replay and forks preserve that timestamp instead of substituting
the current clock.

Context Items are the canonical protocol for hidden model input. `contextEvidence`
names one semantic kind and a content-addressed payload; `contextReset` names an exact
cleared-through cursor; and `contextCompaction` names its trigger, covered range,
preserved tail, summary, reducer checkpoint, and optional active instructions.
Context cursors are exact Turn/Item pairs. Full Thread decoding rejects unreachable or
reversed ranges.

Context payload schema version 1 is an exact-key discriminated union, not arbitrary
JSON. It covers environment, user view, additional context, referenced resources,
Skill/Role catalog journals, Skill invocation, tool-output projection, inherited
context, the three compaction payloads, and exact large `toolCallArguments` values.
Unknown kinds, versions, and fields fail
closed. Each content reference carries its payload kind, and the owning evidence or
compaction Item validates the exact expected kind. Individual context payloads are
limited to 16 MiB. Text entries carry source, authority, and purpose; untrusted text cannot claim
instruction authority, and an inline Skill cannot carry model, effort, or tool
overrides. A compaction reducer checkpoint includes catalog state, active Skill payloads,
the user-view baseline, and active file/Node observations. Each observation retains a
stable key, tool identity, untrusted subject, complete output reference, and frozen
projection reference; it stores neither scratch paths nor another copy of observed
text. Inherited context accepts only complete terminal Turns and requires its
covered-through cursor to resolve inside that snapshot. The canonical projector
consumes admitted environment, user-view, additional-context, referenced-resource,
Skill/Role, inherited-context, tool-output, and compaction evidence at every provider
boundary. Skill and Role reducers record one catalog baseline per context epoch, append
only changed entries, restore validated compaction checkpoints, and start a new baseline
after `contextReset`. A newly discovered Skill or Role can therefore join an existing
Thread without rebuilding or rewriting its earlier provider prefix.
Path-triggered Skill observation reads the bounded path already carried by successful
Core file Items; it never decodes historical argument payloads at Turn acceptance,
resume, or runtime preparation.

The effective context begins after the latest `contextReset`. Within that epoch, the
latest valid `contextCompaction` replaces only its exact covered range with the recorded
summary and reducer checkpoint, then preserves the declared tail. Automatic preflight
aligns that tail to a canonical complete-Turn boundary; provider-overflow recovery may
preserve only the active Turn. Successful document mutations and undo/redo invalidate
Node observation checkpoints conservatively because a read may contain dependent
descendant or reference projections. Tool output receives
one durable full-or-inline projection before the first provider request that can observe
it; later budget pressure, restart, rollback, fork, and replay reuse that decision.
Provider planning consumes only this reduced canonical Item sequence. There is no
runtime-only context state, reminder parser, or alternate message store.
Payload publication and full-Thread decode enforce exact kinds, dependencies, and
reachable compaction cursors. After admission, unavailable inspection payloads are a
runtime degradation rather than a dead Thread: reducers clear or skip only affected
state, restored checkpoints carry typed degradation entries, and projection emits a
bounded marker that tells the model to re-inspect current state.

Every nested context payload, managed resource, or complete tool output named by a
context payload is also an explicit dependency on its owning context Item through
`contextRefs`, `resourceRefs`, or `outputRefs`. Lifecycle operations use that canonical
dependency graph instead of parsing payload-private JSON. A tool Item whose canonical
arguments exceed the 32 KiB inline bound owns its `toolCallArguments` reference directly;
that reference participates in the same reachability, fork-copy, rollback, and startup
reconciliation graph.
Every admitted image has one immutable `ThreadImageArtifactReference`. The reference
contains a stable artifact id, creation time, retention class, optional original source,
mandatory Thread-owned observation, and geometry mapping observation pixels to the
admitted source plane. Image attachments keep their ordinary file source for file
semantics and add an `artifactRef`; dynamic-tool image content stores only its
`artifactRef` and optional alt text. Paths are access handles, never image identity.

The four retention classes are `external` for user/workspace-owned originals,
`durable` for Tenon-owned user uploads, `tiered` for reclaimable generated originals,
and `observationOnly` when no separate original exists. The observation is normalized
at ingress to at most 2,000 px per edge and 4.5 MiB, then content-addressed before the
image enters canonical history. Provider projection always reads that observation.
Missing original bytes fall back to the observation; missing observation bytes produce
an unavailable-image identity and do not invalidate the surrounding Item, Turn, fork,
or inherited-context copy. Available image renditions are copied into a fork without
rewriting the immutable artifact reference; absent renditions are skipped. Ordinary
managed dependencies not used exclusively as artifact renditions remain protected from
image-retention reclamation, including referenced Outliner resources whose MIME type is
`image/*`. Resource-role classification recursively reads inherited-context payloads and
treats a missing or corrupt payload's declared resources as protected. Unavailable bytes
degrade at runtime through the same inspection-payload policy above.

Generic tool-output images are admitted as bounded provider-visible snapshots: at most
16 images, 10 MiB of source data per image, and 20 MiB of source data per call, with
strict base64 and image-MIME validation at the tool-result boundary. Each accepted image
then passes through the common 2,000 px / 4.5 MiB observation normalizer and is
content-addressed in the Thread resource store. The persistence boundary verifies that
the returned MIME type and geometry match the normalized bytes.
Typed Thread quota and filesystem-capacity errors degrade to `quotaExceeded`; unrelated
storage failures retain their identity. Generated-image originals are not tool-output
snapshots and do not use the generic 10 MiB source limit: `generate_image` writes the
source bytes as a Thread resource, creates the bounded observation from those bytes, and
reuses that canonical observation when its tool result is recorded.

A `ThreadGoal` is attached one-to-one to a Thread and stored separately from
history. It carries objective, lifecycle status, optional token budget, token
usage, continuation deferrals, timestamps, and a private continuation ledger.
The ledger belongs to the Goal generation rather than to projected Turn history:
it records the admitted continuation count, budget-wrap eligibility and admission,
and any pre-admission Turn reservation. Goal updates emit canonical Goal
notifications but do not create another execution entity.

## Runtime Ownership

Canonical execution and persistence live under `src/main/agent/`. Retained
provider, filesystem, Node, Skill, import, and web capabilities live under
`src/main/agent/capabilities/`; they may contribute tools and configuration but
may not own Thread history or lifecycle state. The Tenon-owned turn loop,
runtime state, tool batching, retry policy, and transport gateway live under
`src/main/agent/runtime/kernel/`. Thread coordination is split into five owned
modules under `src/main/agent/thread/`:

- `ThreadCore` owns the stores, canonical reads, notification bus, admission
  barriers, and the single shared Thread mutex.
- `ThreadResourceOps` owns attachments, Thread resources, payload references,
  observations, and admission content resolution.
- `ThreadCatalogOps` owns Thread creation, resume, fork, rollback, naming,
  archival, deletion, configuration, and subtree stop.
- `SubagentCollaboration` owns Agent execution identity, fresh child spawning,
  direct-parent delivery, messaging, resume, stop provenance, activity queues,
  and isolated-Skill child execution.
- `TurnLifecycle` owns Turn admission, execution, steering, user input,
  compaction, client bindings, active-Turn state, Agent request-budget usage, and
  terminal notification admission.

`ThreadService` constructs those owners and preserves the host, extension, and
protocol facade; it does not duplicate their state. There are no flat
`src/main/agent*.ts` implementations, forwarding wrappers, alternate runtimes,
or compatibility readers.

## Configuration Profiles And Roles

A named `ConfigurationProfile` supplies root Thread defaults. User definitions
load from `<userData>/agent/config.json`; project definitions load from
`<cwd>/.tenon/agent.json` and replace same-name user definitions. Both exact-key
JSON files may define `defaultProfile`, `profiles`, and `roles`. Invalid JSON,
unknown fields, invalid names, duplicate capability identities, and unsupported
reasoning effort values fail closed.

Root Thread creation resolves its selected Profile into one persisted
`EffectiveThreadConfiguration` snapshot. Later file edits do not rewrite that
root snapshot or completed Turns.

The built-in default Profile uses the `*` Skill ceiling so existing discovered
Skills remain available. A configured Skill list is an allow-list, while an
explicit empty list disables Skills for that Thread. A child Role may retain or
narrow the parent list but cannot widen an explicit parent ceiling.

The renderer may read or atomically replace only the execution selection of a
root user Thread: `modelProvider`, provider-qualified `model`, and
`reasoningEffort`. The host validates the provider/model pair and supported
effort before one SQLite update changes the configuration snapshot and Thread
catalog metadata. A root Thread with an active Turn rejects the change, so one
Turn cannot observe two configurations. Tools, Skills, Plugins, MCP servers,
developer instructions, and capability ceilings remain host-private. Feature
and child Threads have no renderer-editable configuration. A fork inherits the
source Thread's effective execution selection.

An `AgentRole` configures a child Thread. The model-visible built-in Agent types
are `general-purpose`, `explore`, and `plan`, backed respectively by hidden
`default`, `explorer`, and `plan` Roles. User and project Roles extend the Agent
type catalog; there is no built-in `worker`. A fresh spawn intersects its
selected Role and mode policy with the parent's tool, Skill, plugin, and MCP
ceilings, then persists the resolved definition, model, reasoning setting, and
tool policy. Resume reuses that recorded configuration and Agent history rather
than re-resolving a changed Role. The complete context and execution contract is
owned by [`agent-subagent-threads.md`](agent-subagent-threads.md).

## Identity And Provenance

Every completed Turn carries immutable `TurnProvenance`; every completed Item
carries immutable `ItemProvenance`. Newly recorded facts point to their local
Thread, Turn, and Item identities.

Forking materializes inherited Turns and Items with new local IDs while
preserving their ultimate provenance. A fork of a fork does not create a new
evidence origin. This permits Memory and audit consumers to deduplicate evidence
without sharing mutable history objects.

Every document mutation dispatched by a model tool records
`AgentMutationCausation { threadId, turnId, itemId }` in Core transaction metadata
and the operation journal. File, command, MCP, and dynamic-tool Items retain the
equivalent audit edge in Thread history.

## Lifecycle

`TurnLifecycle`, reached through the unchanged `ThreadService` facade, is the
only lifecycle coordinator. It serializes acceptance per Thread, enforces one
active Turn, and deduplicates renderer submissions by stable client message ID.

Starting a Turn follows this order:

1. Resolve the Thread and reject an incompatible active state.
2. Resolve structured user content, derive the Thread's bounded initial preview
   when it is still empty, and allocate the Turn and initial user Item identities.
3. Commit extension admission snapshots under the relevant barriers.
4. Resolve main-owned environment, user view, Skill discovery, additional context,
   and explicitly referenced Node resources into Thread-owned payloads.
5. Persist one `turn/started` event containing every already-complete evidence Item
   followed by the user Item in canonical order.
6. Return acceptance before starting model side effects.
7. Execute the Turn and persist Item events as they occur.
8. Finish every remaining open Item, persist the terminal Turn, and set the
   Thread back to `idle` — including when the Turn failed, and including a
   failure on the launch path before the Turn ever ran.

A failed Turn is recorded on the TURN: `failed` status plus its `TurnError`. The
Thread does not also carry the failure, because Thread status is what admission
and rollback gate on — `systemError` said the same thing in a field that is a
lock, nothing ever cleared it, and it persists, so a single failure ended a
conversation for good: retry refused, a new message refused, across restarts.
Nothing writes that status now, and a Thread loaded carrying one from an earlier
version is healed to `idle` alongside the `active` a lost process leaves behind.
The status remains in the protocol so persisted records stay readable, and a
child's failure is read from its latest Turn wherever it is listed.

A Turn that no longer owns its Thread writes no Thread status at all. Completion
releases ownership before its tail runs — the active Turn is dropped and the
status set — so a new Turn can be admitted while the previous one is still
finishing; a failure in that tail would otherwise name the state of a Turn that
is actually running.

`/compact [instructions]` and `/clear` are reserved renderer commands handled before
Skill routing. They require an idle Thread and create completed feature-triggered Turns
containing only a canonical `contextCompaction` or `contextReset`; they do not launch a
model Turn. A command with no new eligible boundary returns the existing boundary as an
idempotent no-op. Both commands retain the visible and auditable history they stop
projecting implicitly.

Steering uses the same evidence admission path. Its evidence and user Item become
durable before the live executor is notified, so queued and immediate steering have
the same canonical history and provider projection.

`clientUserMessageId` is a Thread-scoped idempotency key for both initial and
steering admission. A retry that resolves to an existing canonical `userMessage`
returns the original Turn and Item acceptance before checking active-Turn state,
including after terminalization or process restart. A sidecar binding that no longer
resolves to that exact canonical Item is stale, is removed, and grants no acceptance.
The sidecar is a rebuildable index rather than authority: a missing or stale entry
causes a scan of reachable canonical Turns, and an exact matching user Item is
re-indexed before its original acceptance is returned.

`turn/started` is the atomic publication boundary for initial evidence plus user input;
`items/completed` provides the same boundary for later immediate Item groups such as
steering. One rollout event carries each complete ordered group; the persistent
projection applies the group in one SQLite transaction, ephemeral history applies it in
one state replacement, and the renderer merges it in one snapshot. A failed append
leaves the recorder uncommitted and admission cleanup reclaims newly published payloads. Renderer
listeners and extension notification observers run only after canonical persistence;
their failures are logged and cannot turn a committed admission into a reported failure.
`item/started` and `item/completed` remain the sole lifecycle for real streaming or
execution Items and are not a legacy compatibility path.

String-append `item/delta` notifications are serialized per Thread and coalesced for up
to 40 ms only while Turn, Item, and delta type all match. Agent-message text, reasoning
summary/content, and command output use this path; dynamic-tool output remains a sequence
of discrete content values and is never merged. Any different or non-delta notification
flushes the pending group first, preserving canonical order. Transient notifications use
the same per-Thread queue and best-effort flush an older delta before broadcast. A failed
deferred delta is reported but does not poison later groups; required lifecycle events
continue, and their complete Item snapshots repair any missing streamed state. The active
`ItemRecorder` still applies every provider chunk immediately, while rollout, projection,
extension, IPC, and renderer listeners observe the equivalent coalesced notification.

Once either admission event is durable, later status bookkeeping or live steering
delivery cannot reject that input. Such a failure aborts and fails the already-accepted
Turn. One serialized steering-delivery chain preserves admission order, and
terminalization closes steering under the Thread mutex before freezing the final Item
list.

`update_plan` is an ordinary recorded tool call. Its normalized checklist is also
published as a transient `turn/plan/updated` notification so the active-Turn pill can
update immediately, but the transient notification is not the history authority.
Recorded and transient notification types remain separate protocol subsets; rollout
decoding rejects transient notification types even if malformed storage contains one.

Initial preview selection is deterministic: first non-empty text, then an
attachment name, then a Node-reference note. Whitespace is normalized and the
result is bounded before it is stored. The write happens once for persistent and
ephemeral Threads; later Turns never rewrite an existing preview.

For an unnamed persistent root user Thread, the first terminal user Turn starts
one non-blocking automatic-name request through the current Thread model. The
request uses the lowest supported reasoning level, bounded input, at most 64
output tokens, and normalizes one plain-text name to at most 80 characters. It
does not delay `turn/completed`, enter rollout history, or count toward Goal
usage. Failure or cancellation leaves the deterministic preview in place.
Persistent internal name origin makes manual rename or clear authoritative over
an in-flight request and across restart. Rolling back the complete history
clears only an automatic name so the replacement first Turn can be named again.

Extension `turnStarted` hooks are part of the same launch boundary as executor
startup. A hook exception terminalizes the accepted Turn as failed, releases
the active-Turn lock, and cannot strand a Thread in `inProgress`.

Steering appends input only to the active Turn. Interrupt requires the exact
active Turn ID. Resume reopens a stored Thread, refreshes child Role
configuration, and lets extensions reconcile their own state; it does not create
a Turn.

When a Turn becomes idle, an active Goal may admit a continuation through the
same single-Turn coordinator. The short dynamic user message carries only the
Goal generation's continuation number, available budget usage and remainder,
and the requested next action. The objective is admitted as untrusted
Thread-state observation and the completion doctrine as an application
instruction through typed `additionalContext` evidence. Shared XML escaping is
therefore authoritative, diagnostics record the authority boundary, and the
Thread-state projector emits unchanged objective and doctrine text only once in
the effective context rather than repeating it in every continuation message.

Usage is committed before continuation admission. Crossing a token budget
changes every unfinished Goal status, including `blocked`, to `budgetLimited`;
`complete` never regresses. A successfully completed Turn that crosses the
budget also arms exactly one flagged wrap-up continuation. An interrupted or
failed Turn still accounts its usage and changes the status but does not arm a
wrap-up, so Stop cannot launch replacement work. The wrap-up starts no
substantive work and reports progress, remaining work, blockers, and the next
step. Existing hard non-user Turn admission limits, including an exhausted
Subagent request budget, remain authoritative and may refuse it.

Before admission, the Goal ledger durably reserves a generated Turn ID and
continuation kind. Admission commits the count and one-shot wrap-up fact;
known refusal releases the reservation. Startup reconciles an interrupted
reservation with one indexed Turn-ID lookup: an existing Turn commits it, while
an absent Turn reuses the reservation for admission. Admission errors release
the reservation, record a diagnostic, and degrade without rejecting agent
startup, so a later real idle boundary or restart can retry. A fork copies Turn
history but not Goal state, so its new Goal starts at continuation one. History
rollback does not rewind the Goal ledger and therefore cannot duplicate a
removed wrap-up. A pre-existing `budgetLimited` Goal with no ledger row is not
retroactively armed at upgrade; a pre-existing active Goal initializes its
ledger lazily. A deferral records a lost active-Goal admission race for one idle
boundary; the next real idle boundary clears it and retries the same Goal
generation. `waitForIdle` follows the whole continuation chain, including an
admitted wrap-up, rather than returning after only its first Turn.

Archiving or deleting a Thread is a subtree operation over `parentThreadId`
lineage. `ThreadService` first fences the complete subtree against new Turn and
child admission, interrupts every active Turn and pending structured-input
request, and waits for every descendant to become idle. Archive then marks the
root and every descendant archived; unarchive restores only the explicitly
selected Thread and never revives descendants implicitly. Delete removes every
descendant Goal, history projection, rollout, catalog row, Agent execution edge,
pending notification, pending activity, request-ledger membership, and barrier state. Concurrent overlapping teardown requests
fail closed. Archived or stopping Threads cannot admit a Turn.

## History Replacement And Fork Semantics

Only the latest terminal user Turn can be edited. Edit calls
`thread/rollback { threadId, numTurns: 1 }`, then starts a replacement Turn with
fresh Turn and Item identities in the same Thread. Earlier and active Turns are
not editable. Assistant responses do not expose Retry or Regenerate.

Rollback appends a durable marker to the immutable rollout. The current history
projection, pagination, and model context omit the marker's exact terminal Turn
suffix, while audit reads retain every original Turn and Item fact. Extension
prepare hooks run before the marker; a prepare failure aborts already prepared
extensions in reverse order and leaves history unchanged. Once the marker is
durable it cannot be vetoed. Failed commit or abort hooks enter one host-scoped,
coalescing recovery queue and retry in the current process with bounded backoff;
startup replays committed markers before admitting new work.

`Continue in new chat` is the only visible fork operation. It copies terminal
history through the selected Turn into a new top-level root Thread.
Its default name uses the source name or preview plus the next numeric suffix
across the complete `forkedFromId` family. One trailing suffix is removed from a
fork-derived name before allocation, so `Title`, `Title (1)`, and `Title (2)`
remain siblings rather than forming nested suffix text. A root title such as
`Annual plan (2024)` remains intact. Explicit fork names remain authoritative.

A fork copies only terminal history within the boundary. It never calls document
undo, changes files, stops processes, reverses commands, compensates MCP calls,
or attempts to undo external effects. Any future world-state revert is a
separate explicit capability with preview, conflict detection, and its own audit
record.

Forked user Items retain `acceptedAt`. Context cursors are rewritten to the copied
Turn/Item identities. Every context payload and every dependency listed by the owning
Item's `contextRefs`, `resourceRefs`, and `outputRefs` is copied into the fork before
publication, including a tool Item's canonical argument payload; failure deletes the
staged fork. The copied Thread therefore remains
readable after its source is deleted. Content-addressed resource references do not
contain a Thread path and remain unchanged in the copied Items and payloads. Every
terminal Turn's diagnostics payload is copied under the fork's ownership with the same
content-addressed reference before publication, so Turn Diagnostics also remains readable
after source deletion.

## Persistence

Persistent Agent Core data lives under `<userData>/agent/`:

```text
agent/
  state.sqlite
  thread_history.sqlite
  goals.sqlite
  rollouts/
    <thread-id>.jsonl
  payloads/
    <thread-id>/
      <content-hash>.<ext>
      context/
        <content-hash>.json
      turn-diagnostics/
        <content-hash>.json
      resources/
        <content-hash>/
          <safe-display-name>
```

`state.sqlite` is the Thread catalog and configuration snapshot.
`thread_history.sqlite` is a rebuildable pagination projection. `goals.sqlite`
owns Goal state. Each persistent Thread owns one append-only rollout JSONL as
the history source of truth. Complete textual tool outputs, managed attachment inputs,
image-artifact renditions, semantic context payloads, and immutable Turn diagnostics live in
the Thread-owned payload directory; canonical Items and terminal Turn execution retain
typed content-addressed references.
Agent SQLite databases use WAL. The shared open policy is `synchronous=NORMAL`;
authoritative metadata, Goal, Memory, and Automation stores explicitly strengthen it to
`FULL`, while the rebuildable history projection remains `NORMAL`.

Rollout appends reuse one open handle per recently active Thread, bounded by a 16-handle
LRU. Delta lines are written immediately and group-synced within 150 ms. Every non-delta
lifecycle event is a sync barrier; LRU eviction and service flush also sync before closing.
Thread deletion cancels pending sync, closes best-effort, and unlinks even if close fails:
syncing bytes that are being discarded provides no durability. LRU maintenance failures
are reported without changing an already-successful append result. A hard crash may
therefore lose only the final group-commit window of an unfinished stream. Completed Items
and Turns cross a sync barrier, and torn-tail repair discards only a partial final JSONL line.

The history projection keeps unfinished streamed Items in a decoded in-memory overlay
instead of rewriting `item_json` for every delta. All Turn and Item read surfaces apply
that overlay. Item completion writes the final canonical row and clears its overlay;
Turn completion, rollback, rebuild, and deletion clear the corresponding entries. At
startup, reconciliation compares the projection watermark's byte boundary with the
surviving rollout and rebuilds the Thread if an unsynced rollout tail was lost after its
projection transaction committed. Overlay transactions journal inverse mutations only for
touched keys, so SQLite rollback restores in-memory state without cloning all active
streaming Items. If the rollout is wholly absent while a projection watermark exists,
startup atomically writes a minimal replacement rollout from projected final snapshots and
then rebuilds the projection from it; projected rollback hooks are recovered before their
markers are replaced.
Context writes
canonicalize through the Core codec before hashing. Context and text reads/copies
verify digest and byte length, while text also selects storage by the referenced
MIME type. Managed input admission reserves quota before
writing, stages chunks under a non-canonical `.staging` directory, and publishes
only a complete digest-verified resource. Failed content admission immediately
removes image observations created by that attempt unless canonical history already
references them. Execution-time context publication writes the payload and its Item
under the Thread mutex; failed publication and Turn terminalization prune any context
payload not reachable from the canonical Item graph. Inline model-call arguments are
codec-bounded to 32 KiB; larger exact JSON uses the Thread-owned payload store rather
than truncation. The recommended Secretlint preset plus complete private-key, legacy
`sk-`, short GitHub-token, Bearer, and JWT signatures redact known credential formats
before either the Item or payload becomes durable.
Structured fields change only when both the normalized terminal field name identifies a
credential and the value is a credential-candidate string; non-string shapes, numeric
strings, placeholders, and ambiguous free-form content pass unchanged. Ambiguous bare
`credentials` and `token` fields require at least 20 opaque characters containing both
letters and digits. Serialized JSON key inspection is limited to `args`, `arguments`,
`body`, and `payload` strings, preserves unrelated formatting, and never reinterprets
nested JSON strings. Rule exceptions, unsupported asynchronous rules, malformed JSON,
and scanner depth failures all fail open. Durable scanning yields cooperatively;
diagnostic copies additionally have one 64,000-character budget and use an omission
marker beyond it. The diagnostic copy never becomes Item or replay data. Redacted replay
compatibility is decided once
against the admission schema: a compatible copy becomes `redactedReplay`; an
incompatible copy becomes executed `evidenceOnly`, while the validated transient source
call may still run. Evidence provider names, corrections, and argument summaries have
independent UTF-8 bounds, and malformed redaction pointers fail at the
codec boundary. A newly written tool image that
no terminal Item references is reclaimed at Turn finalization; startup reconciliation
handles crash leftovers.

A history rollback reclaims contexts, Turn diagnostics, and tool text outputs
against the surviving history, and resources against the surviving history PLUS
the Turns it removed. A rollback exists to be followed by a re-send of the
content it removed — that is what Edit and Retry do — so a payload the omitted
Turns referenced is one the next call is about to reference again, and deleting
it leaves the resent message pointing at nothing. What neither set references is
garbage no re-send can reach, and it is reclaimed here: the resource quota counts
every byte on disk while offering only surviving history as reclaim candidates,
so bytes left behind would push a Thread toward its limits with no way to free
them. Every
resource operation requires each managed path component to be a physical directory;
symbolic-link substitution
fails closed, including during quota scans, startup cleanup, and garbage
collection. Successful writes cache file identity and digest in memory. A cold
read or any inode, size, ctime, or mtime change streams SHA-256 again before the
resource is returned, so same-length replacement cannot bypass integrity checks.
Canonical managed-resource paths stay private to the payload store. Consumers
that need a filesystem path receive an independent scratch materialization: model
execution owns a Turn-scoped workspace, while Preview/Open/Reveal share a stable
detached copy per attachment, resource, or image-artifact identity. An image artifact
materializes the best available rendition in original-then-observation order at one
stable extensionless path, so reclaiming a WebP original and falling back to a PNG
observation does not change the access handle or misstate the bytes. Preview and
`file_read` determine image MIME from the rendition bytes. These reproducible copies
follow the seven-day scratch TTL; canonical originals and observations do not. A
materialization error during provider projection is recorded and degrades only the
readable-path hint; available observation bytes and the surrounding Turn still project.

Per Thread, canonical image retention has a 5 GiB target, 6 GiB soft watermark, and
8 GiB hard resource budget. Crossing the soft watermark reclaims least-recently-used,
then largest, `tiered` originals older than 30 days until the target is reached. A write
that would cross the hard budget first reclaims any remaining `tiered` originals and
then least-recently-used observations until the write fits. External originals and
`durable` originals are never automatically deleted. Resource access updates durable
atime metadata for this ordering without making a valid read fail. Canonical artifact
references remain unchanged through `FULL -> OBSERVATION_ONLY -> UNAVAILABLE`.
Retention inventory recursively includes artifacts nested in inherited-context payloads,
while generic resources and durable originals remain protected. Missing or corrupt
payloads protect their complete declared resource manifest.
Resource garbage collection uses the physical key (content hash plus safe filename),
independently of logical MIME metadata.
Ephemeral Threads remain memory-only except for temporary payload files, which
follow the same Thread deletion lifecycle and are removed when the service
closes. Startup and rollback remove stale staging data plus managed resources, context
payloads, Turn diagnostics, and complete text outputs absent from reconciled canonical
history. Forks copy only payloads referenced by inherited Items and Turn execution into
their own directory with a distinct inode, so provenance remains shared while mutation
and deletion remain Thread-local. Fork and child inheritance attempt every referenced
semantic context, compaction, managed-resource, tool-argument, and complete-output copy.
Missing copies are recoverable: canonical references remain on the copied Items, tool
dependencies become typed call/result evidence, and semantic dependencies become bounded
context-degradation markers rather than aborting the user operation.
If fork preparation fails after a transient `thread/started` notification, the
renderer reloads the authoritative Thread catalog before surfacing the error, so
the rolled-back fork does not remain visible.

Startup reconciles catalog and history projections from rollouts. Before terminalizing
an `inProgress` Turn, startup replays its `item/started` and `item/delta` facts into each
open Item and persists one recovered row per Item. The Turn is then completed as
`interrupted`; every unfinished streamed or executable Item first receives its terminal
completion fact. Reconciliation failure is isolated to the owning Thread: it remains in
the catalog but skips payload pruning and resume for that launch, while other Threads
continue startup normally. Clean
replay then produces the same paginated Turns and Items as incremental
projection. There is one storage format and no alternate reader or dual-write
path. New tool Items always write the required envelope, and decode rejects a tool
Item that lacks it. Pre-release format changes use an explicit userData reset rather
than a compatibility reader.

## Transport

The renderer uses one request channel and one notification channel. Methods are
grouped by the concept they own:

- `thread/*`: list, read, start, resume, fork, rollback, name, archive, delete, paged
  Turn/Item reads, exact full-output and context-evidence reads, and authoritative
  Turn Diagnostics reads
- `turn/*`: start, steer, and interrupt
- `goal/*`: get, create, and update
- `userInput/respond`: resolve an active structured input request

All input and output crosses strict codecs. Unknown fields, invalid UUIDv7 IDs,
invalid state transitions, and impossible terminal facts fail closed. Thread
history mode is always paginated; renderer code does not negotiate another
shape.

`thread/context/read` authorizes the exact `(threadId, turnId, itemId, contextId)`
tuple and only returns the primary payload of that `contextEvidence` Item. A digest
alone cannot probe another Item or Thread, and nested dependencies are not exposed by
this audit method.

`thread/turn/details/read` resolves one reachable full Turn and its Thread-owned
diagnostics reference. A Turn without a reference returns `diagnostics: null`; a Turn
with a reference must return the exact matching payload or fail. Missing bytes,
digest/length corruption, a mismatched reference, unknown diagnostics fields, and an
invalid payload version fail closed. Renderer code cannot read diagnostics by digest
alone.

Recorded lifecycle notifications are the only notifications accepted by
rollout and history projection stores. `thread/name/updated`, provider-retry
state, and `turn/plan/updated` are transient renderer synchronization events;
they are never replayed from rollout history.

## Extension Boundary

`ExtensionRegistry` is the only Core extension boundary. Extensions may
contribute:

- durable admission snapshots before a Turn exists
- additional model context for a Thread
- terminal Items after execution
- lifecycle reconciliation hooks
- canonical tool contracts owned by the contributing extension

Host-wide and per-Thread admission barriers linearize configuration changes with
new root Turns. They do not interrupt an already active Turn; an extension that
needs exclusion must persist it explicitly.

Extensions do not add fields to Core entities or write Core stores directly.
They own their private state and communicate through typed extension contracts.
The host assembles extension and capability contracts into one executable
registry, validates provider-name uniqueness and runtime schemas, and fails
closed if an enabled extension contract has no runtime implementation.

Memory is the first durable extension using this boundary. Its immutable Turn
admission, terminal citation Items, history-rollback invalidation, and private
pipeline state are specified in [`agent-memory.md`](agent-memory.md); published
Memory remains ordinary document Nodes rather than a Core entity.

Automation is a feature consumer rather than a Core extension. It uses
host-only root-Thread and idle-Turn admission, then records ordinary canonical
Turns with immutable feature provenance. Schedule definitions and claims never
enter Core stores. See [`agent-automations.md`](agent-automations.md).

## Renderer Detail Surfaces

Thread Details describes the durable Thread container and its Thread-level controls.
Turn Diagnostics is the complete diagnostic surface for one canonical Turn. It receives one
main-owned snapshot containing the same Thread, full Turn, Items, and immutable
provider-boundary diagnostics used by execution. It does not recreate the retired
conversation/run/round debug projection, derive history from renderer pagination, or
introduce an alternative execution ledger. The exact page contract lives in
[`agent-thread-rendering.md`](agent-thread-rendering.md).

## Document Drift Notice

The write path is defended reactively: `node_edit` carries expected revisions, so
a stale write fails loudly. The question-answering path has no such moment — a
model can answer from a twenty-minute-old read without touching a tool — so it is
defended proactively, by checking what the model was shown against the document
as it is now.

**A belief is the token the tool that showed the node emitted, together with
which function emitted it.** Naming the function is the correctness condition,
not bookkeeping: `node_read` emits `editableOutlineRevision`, which appends an
outline hash to `revisionOf`, so comparing it against `revisionOf` can never be
equal and turns every read into permanent false drift. Comparison recomputes the
belief's own basis, so a shape a tool emits is only ever compared with itself.
The basis is as strong as the observation was — an outline revision for a read, a
normalised timestamp for a search result — and it is **read off the token rather
than assumed from the field it arrived in**: `node_edit` writes one `revisions`
map from fifteen code paths and only the outline path emits the three-part form,
so labelling the map by its field name reproduced the same never-matching
comparison for the other thirteen. Both forms share the `${nodeId}:` prefix and
the id is known, so stripping it separates them without depending on the hash's
alphabet. `beliefsFromToolResult` is the single
extraction, used both live and when rebuilding from a persisted payload, so the
two cannot disagree.

**Trashing is checked explicitly**, because it is invisible to every token: the
trash is a subtree rather than a removal, so a trashed node stays in the
projection, and trashing does not stamp `updatedAt`. A belief therefore records
whether the node was already trashed when it was shown, and a transition into the
trash is reported as gone.

**Beliefs are checked against current state, never recomputed from a log.** That
is what makes the design free of a window, a boundary anchor, a retention limit,
and "we may have missed some" wording — none of which are answered here, because
none of them arise. A fork and a restart need no special case for the same
reason.

**Observation happens where every tool result already passes** — the Thread
service's tool-completion notification, which has the Thread and the tool name in
hand. There is no per-tool hook, so a node tool added later is covered without
remembering to call anything, and `node_search` is covered like every other even
though its arguments never say which nodes the model will see: its results are
the rendering.

**The belief set is a projection of the canonical record** and takes its bound
from the record rather than from a cap of its own. Re-observing a node replaces
its belief and moves it to the end; that order is the recency the notice's cap
spends its slots on. Deletion of a Thread forgets its beliefs.

**At admission** the beliefs are compared against the projection already in hand
— the same projection evidence admission uses, so the notice and the evidence
describe one instant. The comparison is READ-ONLY: beliefs are settled only once
the Turn carrying the notice is durably recorded, because admission can still
throw afterwards and a retry must find the same drift still there to report.

Settling UPDATES a reported node's belief to what the model was just handed
rather than dropping it. Dropping inverts the feature: the host would stop
tracking a node the moment it told the model that node's content, so a second
edit while the Thread sat idle would go unreported and the model would answer
from — or write over — the version it had been given. A node reported as gone is
the exception; there is nothing left to track. What does not fit the cap keeps
its belief and surfaces next time.

**The notice is never admitted by `steerTurn`.** Steering admits into a Turn that
is already running, and the notice's contract is that it arrives between Turns;
delivered mid-Turn it would reach a model composing an edit and tell it not to
revert changes it is itself being asked to make.

**A cold set is rebuilt from the canonical record** — the persisted tool outputs
that were the observation — which is what makes a restart and a fork need no
special case. The Turn's timestamp stands in for the Item's, which carries none;
it is monotonic with observation order, which is all attribution asks of it. A
Thread's set is released with the rest of its in-session coordination state when
the Thread stops or is deleted — the rebuild path is what makes that safe — and a
rebuild costs the next admission one pass over its payloads.

**The notice is a belief update, not a warning.** It carries the current content
of up to five drifted nodes, so the ordinary case costs no re-read round trip;
outliner nodes are small, which is what makes that affordable. A deleted node is
named as deleted — the outcome a re-read cannot recover alone. Content is
single-lined and bounded like every other authored text entering trusted context.
It closes with the instruction the coding agents include for the same situation:
these edits were deliberate, do not revert them. Without it, a model told its
reads changed can treat that as an inconsistency to repair and overwrite the
user's edit.

**Attribution is garnish, and is scoped by node AND by observation time** — an
operation that predates the observation explains nothing about drift the model
can see, and crediting it would tell the model the user personally changed
something they changed before it ever looked. The node scope says which
operations are relevant; the belief's own timestamp says which of them happened
after it was formed. It draws one distinction, the only one both load-bearing and free:
the user's own edit versus another session's, naming the causal Thread id, which
the transcript index makes resolvable. An Automation is not labelled separately;
what would matter about one is that nobody watched the result, and the record
does not know that. The journal is read without waiting on the mutation queue,
because admission must not wait. An edit older than the journal's ring is not
found and the clause is dropped.

The notice rides `additionalContext`, so "never mid-Turn" holds by construction
and the notice lands in the canonical record. A12: any failure — no projection, a
comparison that throws, a journal that cannot answer — skips the notice and never
blocks admission.

## Trusted Document Transactions

Projection-neutral system receipts and deterministic protected tag definitions
use `DocumentSystemHost`. One trusted transaction may atomically commit document
commands plus a receipt. It resolves only after the workspace bytes containing
that commit are durably flushed, so a sidecar journal cannot finalize ahead of
the receipt. System-only commits persist without emitting a Node projection
update and are excluded from user undo.

Internal projection-change delivery retains the originating operation ID, while
the public renderer event remains the canonical projection event. This lets a
cross-store extension distinguish its own committed Node transaction from a
later user edit before its private journal finalizes.

Protected tag definitions have host-owned identity and lifecycle. Public
commands may apply or remove a protected tag from content, but cannot mutate its
definition. The command classifier extracts every owner, parent, target, and
nested batch ID and fails closed for unknown commands.
