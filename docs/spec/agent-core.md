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

Every tool Item also owns a `resourceRefs` manifest for ordinary files produced by
that exact execution. New Items write the field explicitly, including `[]` at start;
the codec defaults the field to `[]` only for otherwise-valid history written before
tool artifact ownership existed. A completed Item receives only the validated,
deduplicated host-only manifest returned by its tool. The manifest is never copied into
the provider `ToolResultMessage` and is independent of `outputRef`, which remains the
complete textual/JSON result.

Every `userMessage` stores its admission-time `acceptedAt` and one required semantic
`ThreadInputAuthor`. The author is exactly `reader`, `agent(threadId)`, `host`, or
`feature(feature, optional ref)`; there is no unclassified variant. `userMessage`
continues to mean provider role, while author names who is accountable for the input's
words. `ItemProvenance` remains physical copy lineage and `TurnTrigger` remains the
reason a Turn began. No consumer infers one of these four facts from another.

Main is the author authority. Renderer start and steer requests carry no author and
their dedicated lifecycle paths mint `reader`. Privileged start and steer requests
must supply an explicit non-reader author: Agent messages name the source Thread,
host framing uses `host`, and Automation, Goal, Memory, and other generated prompts
name their feature and an existing stable reference when available. The common Item
constructor has no default. Rerun replays each source Item's exact author, and fork
copies it with the rest of the canonical Item.

The initial Item uses the Turn start instant for `acceptedAt`; steering records one
instant for both Item persistence and recorder completion. Replay and forks preserve
that timestamp instead of substituting the current clock.

`ThreadReferenceContent` is a canonical structured user-content part containing only a
same-profile UUIDv7 Thread ID. Its textual form is `[[thread://UUIDv7]]`; the current
Thread title is mutable resolver-owned presentation and never stored in the URI or used
for equality. The reference is weak: archive preserves it, deletion invalidates it, and
the containing Thread neither copies nor retains the referenced transcript. The shared
reference-URI codec admits the `thread` scheme only for Agent consumers. Outline's
`ReferenceTarget` and default Node/file marker parser remain unchanged.

Context Items are the canonical protocol for hidden model input. `contextEvidence`
names one semantic kind and a content-addressed payload; `contextReset` names an exact
cleared-through cursor; and `contextCompaction` names its trigger, covered range,
preserved tail, summary, reducer checkpoint, and optional active instructions.
Context cursors are exact Turn/Item pairs. Full Thread decoding rejects unreachable or
reversed ranges.

Context payload schema version 1 is an exact-key discriminated union, not arbitrary
JSON. It covers environment, user view, additional context, referenced resources,
Skill/Role catalog journals, Skill invocation, tool-output projection, inherited
context, the three compaction payloads, and large `toolCallArguments` skeletons with
private internal-text bindings.
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

Every nested context payload, private internal text, managed resource, or complete tool
output named by a context payload is also an explicit dependency on its owning context
Item through `contextRefs`, `internalTextRefs`, `resourceRefs`, or `outputRefs`.
Every `contextEvidence` and `contextCompaction` Item writes all four manifests explicitly,
including `internalTextRefs: []`; the codec rejects pre-manifest Items instead of defaulting
the field. This pre-release storage-format change requires a clean userData reset and has no
compatibility reader.
Lifecycle operations use that canonical dependency graph instead of parsing
payload-private JSON. Context, internal-text, diagnostics, and complete-output
dependencies remain Thread-owned payloads. Resource dependencies instead link an
opaque Agent reference into the Thread working set; fork, rollback, deletion, and
startup reconciliation add or remove links and ContentStore retention anchors without
copying exact bytes. A tool Item whose canonical
arguments exceed the 32 KiB inline bound owns its `toolCallArguments` reference and
deduplicated `internalTextRefs` directly; those references participate in the same
reachability, fork-copy, rollback, quota, deletion, and startup reconciliation graph.
The context payload stores a JSON skeleton plus a canonical, non-overlapping RFC 6901
binding list. Every selected location is `null` in the skeleton; each binding names one
content-addressed, strict UTF-8 internal-text dependency. Binding references must equal
the Item-declared dependency set exactly. Missing, corrupt, extra, duplicate, or
mismatched dependencies make the complete argument value unavailable rather than
yielding a partial reconstruction.
Tool Item `resourceRefs` enter the canonical Agent reference graph directly, including
when nested inside inherited-context payloads. A public reference contains only an
opaque `resource:<uuid>` identity plus MIME type, byte length, and safe display name.
Digest, anchor, source scope, source locator, and ContentStore paths remain Host-private.
Tool-owned `image/*` files are ordinary references rather than a distinct file class.
Every admitted image has one immutable `ThreadImageArtifactReference`. The reference
contains a stable artifact id, creation time, retention class, optional original source,
mandatory exact observation reference, and geometry mapping observation pixels to the
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
or inherited context. A fork links the same canonical references and exact ContentStore
revisions; it never copies a rendition or rewrites the immutable artifact reference.
Unavailable bytes degrade at runtime through the same inspection-payload policy above.

Generic tool-output images are admitted as bounded provider-visible snapshots: at most
16 images, 10 MiB of source data per image, and 20 MiB of source data per call, with
strict base64 and image-MIME validation at the tool-result boundary. Each accepted image
then passes through the common 2,000 px / 4.5 MiB observation normalizer and is admitted
as an exact revision in the shared ContentStore. The persistence boundary verifies that
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
`src/main/agent/runtime/kernel/`. Thread coordination is split into six owned
modules under `src/main/agent/thread/`:

- `ThreadCore` owns the stores, canonical reads, notification bus, admission
  barriers, and the single shared Thread mutex.
- `ThreadResourceOps` owns attachments, Thread resources, payload references,
  observations, and admission content resolution.
- `ThreadCatalogOps` owns Thread creation, resume, fork, rollback, naming,
  archival, deletion, configuration, and subtree stop.
- `ThreadHistoryReferenceService` owns same-profile reference resolution and bounded,
  read-only historical search/read projection. Its search data is rebuildable and has no
  identity, authorization, retention, deletion, resume, fork, or Turn-creation authority.
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
root snapshot or completed Turns. The snapshot holds canonical tool keys
verbatim and is never re-resolved, so renaming or retiring a canonical tool key
strands every Thread created before the rename: the tool matches nothing in that
Thread's allow-list and is absent from its Turns. Pre-release this is settled by
wiping the affected `userData` and stating it in the release note, never by a
compatibility reader in the catalog.

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

An ordinary renderer-created root receives a Host-managed workspace at
`<userData>/agent/workspaces/<root-thread-id>`; the renderer does not submit a
`cwd`. Descendants inherit the root binding unless an explicit worktree overlay is
active. Explicit project and automation roots remain supported and are registered as
separate source scopes. Deleting a managed root drains descendants and pending citation
capture before removing only that workspace container. An explicit-cwd root never owns
that directory, so Thread deletion leaves it untouched. Workspace cleanup happens after
the metadata commit; a cleanup failure is logged for maintenance and does not turn the
already-committed deletion into a failed user action. Exact revisions retained by other
links and user-managed external sources survive.

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

The renderer sends non-command user input through `turn/submit`; it never chooses
`turn/start` versus `turn/steer` from a cached Turn snapshot. Main serializes
submissions per Thread and re-evaluates canonical ownership until the input is
admitted exactly once: an idle Thread starts a user Turn, an active Turn that is
still accepting input is steered, and a finishing Turn is awaited before the
same `clientUserMessageId` is retried. Internal notification admission may win
the same race, but it cannot surface `ThreadBusyError` to the user: the input is
then steered into that Turn or starts immediately after it settles. Archived,
stopping, quarantined, unavailable, and shutting-down Threads remain real
rejection states. Shutdown drains already-entered renderer submissions before
closing their persistence stores; queued retries cannot admit after shutdown begins.
The strict `turn/start` and `turn/steer` methods remain available for callers
that already own an exact lifecycle precondition.

Starting a Turn follows this order:

1. Resolve the Thread and reject an incompatible active state.
2. Resolve structured user content, derive the Thread's bounded initial preview
   when it is still empty, and allocate the Turn and initial user Item identities.
3. Commit extension admission snapshots under the relevant barriers.
4. Resolve main-owned environment, user view, Skill discovery, additional context,
   and explicitly referenced Node resources into canonical payloads and Agent resource
   links.
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
projecting implicitly. `turn/submit` preserves that idle-only boundary: it never steers a
reserved command into an active model Turn, and an admission race therefore remains a
real busy rejection for these commands.

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
not editable. A latest failed persistent root user Turn may instead expose
main-authorized Continue and Rerun actions; renderer never derives their eligibility
from visible Items.

`turn/recovery/read` is read-only and returns the current capabilities for one exact
source Turn. Continue is available only when that Turn is still the latest failed Turn,
the root user Thread is persistent, idle, unarchived, and not stopping, and the runtime's
canonical projector plus protocol-unit validator proves at least one complete settled
assistant/tool unit beyond accepted input. If the terminal Turn is committed while its
matching active finalizer still owns cleanup, the read waits for that completion and then
re-evaluates authoritative state instead of caching a transient unavailable result.
Projection or dependency failure degrades to `canContinue: false` and writes nothing.

`turn/continue` revalidates the same boundary under renderer-submission and root-host
admission locks. Any matching finalizer wait occurs under renderer-submission
serialization before the root-host lock is acquired; the lock-protected capability check
never waits for idle hooks that may themselves admit root work. Continue preserves the
failed source and appends an ordinary Turn whose
`continuation` trigger names the source Turn ID. The admitted host input is content-free
and renderer-hidden; a bounded application instruction says settled history is evidence,
not work to replay. Ordinary Turn admission resolves current configuration, permissions,
resources, and context, so restart observes either no continuation or one complete
`turn/started` fact. No checkpoint, Item cursor, or historical tool dispatch exists.

`turn/rerun` is the distinct whole-Turn replay operation. It reconstructs all accepted
initial and steering batches with their exact author, evidence, timestamps, client IDs,
and original trigger, then replaces the failed suffix Turn in current projection. A
settled tool makes `rerunRequiresConfirmation` true; main rejects the mutation unless
`confirmToolReplay` is explicitly true because replay may repeat effects. The replacement
is one internal `history/rerun` rollout event, so rollout audit retains the source while
current history exposes only the replacement.

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

Forked user Items retain `author` and `acceptedAt`. Context cursors are rewritten to the copied
Turn/Item identities. Every Thread-owned payload listed by the owning Item's
`contextRefs`, `internalTextRefs`, and `outputRefs` is copied into the fork before
publication, including a tool Item's canonical argument payload. Each `resourceRef` is
linked to the fork without copying its exact bytes. Failure deletes the staged fork.
The copied Thread therefore remains readable after its source is deleted. Opaque
resource references contain no Thread path and remain unchanged in copied Items and
payloads. Every
terminal Turn's diagnostics payload is copied under the fork's ownership with the same
content-addressed reference before publication, so Trajectory and audited diagnostics remain readable
after source deletion.

## Persistence

Persistent Agent Core data lives under `<userData>/agent/`:

```text
agent/
  state.sqlite
  thread_history.sqlite
  goals.sqlite
  resource_references.sqlite
  rollouts/
    <thread-id>.jsonl
  payloads/
    <thread-id>/
      <content-hash>.<ext>
      context/
        <content-hash>.json
      turn-diagnostics/
        <content-hash>.json
  workspaces/
    <root-thread-id>/
  scratch/
    uploads/
content/
thread-transcripts/
  <thread-id>.md
```

`state.sqlite` is the Thread catalog and configuration snapshot.
`thread_history.sqlite` is a rebuildable pagination projection. `goals.sqlite`
owns Goal state. `resource_references.sqlite` owns Agent reference records, source
scopes, Thread links, and final-citation bindings. Each persistent Thread owns one
append-only rollout JSONL as the history source of truth. Complete textual tool outputs,
semantic context payloads, private internal text, and immutable Turn diagnostics remain
in the Thread-owned payload directory. Exact file revisions live once under the neutral
app-level `content/` store and are retained by Host-private anchors. Ordinary root
conversations use `agent/workspaces/<root-thread-id>`; children inherit that binding.
Uploads and disposable observations use `agent/scratch`; readable transcripts remain
independent rebuildable artifacts under `thread-transcripts/`.
Decoded Thread catalog records use a 256-entry in-process LRU shared by single,
batch, and list reads, so repeated notification admission does not decode or
select unchanged metadata. Every `threads` row write invalidates through one
store helper after the write succeeds. Deleting a Thread clears the complete
cache because SQLite cascades can remove cached descendants.
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

History decoding fails closed everywhere; the Thread, not the Item, is the unit that
degrades (A12). Skipping an undecodable Item is not available as a fallback: it would
change a Turn's Item count against the terminal-Turn mutation check, and the projected
rollout snapshot is what `restoreMissing` writes back before `rebuildThread` cascades
the old rows away, so omitting a row there destroys its last copy.

Admission, rollout append/read, projection apply/read/rebuild, rollout restoration,
Rerun, and fork all use the same strict Item decoder. A missing or invalid
`userMessage.author` is therefore unreadable new-format history and follows the Thread
quarantine below; no persisted decoder recognizes the superseded authorless shape,
infers an author, or rewrites rollout or projection data. Before this pre-release
cutover is verified, every Tenon process is stopped and the installed
`~/Library/Application Support/Tenon/` plus clone-scoped `~/.lin-outliner-*` stores
are reset manually. Startup never detects or deletes those stores automatically, and
fresh development and packaged stores write only required-author Items.

Startup therefore decides readability per Thread. After reconciling each Thread,
initialization pages that Thread's complete recorded history and discards it — decoding
every Turn and Item exactly as every later consumer does, without holding them all
resident — and a Thread that fails is **quarantined for the session**. The verdict is
reached *before* the Thread joins the reconciled or resumable sets, because
reconciliation decodes every Item but only the newest Turn row: a Thread can reconcile
and still fail a full read, and the payload-prune fan-out over reconciled Threads walks
`allTurns` with no guard of its own. Admitting one to either set is precisely how a
caught failure becomes an uncaught one.

A quarantined Thread is excluded from resume, from `persistentRootThreads`, and from
`thread/turns/list`, `thread/items/list`, and `thread/read` **with `includeTurns`** —
those answer `ThreadBusyError` naming the quarantine rather than leaking the codec
failure. A metadata-only `thread/read` still succeeds, since it never reaches the codec
and the Thread list must still be able to name what it cannot open. The quarantine set
is kept separate from the delegated-Agent admission quarantine, whose Threads decode
fine and were held back over a worktree.

This is what a retired Item type or a narrowed tool enum leaves behind in a userData
directory that is never wiped: history is append-only, the row is never rewritten, and
the decode fails on every launch. Quarantine is in-memory and recomputed each launch, so
the bytes stay untouched and a build that can read them again picks the Thread back up
with nothing to undo — which also means no consumer may treat a quarantined Thread's
absence as deletion. The memory orphan-admission sweep is skipped for any session with a
quarantined Thread for exactly that reason: it deletes every admission row whose Turn it
cannot enumerate, so running it against the filtered list would permanently discard that
Thread's extraction state and make a session-scoped quarantine durable. The filter and
the `hasHiddenRootThreads()` signal that guards it evaluate the same predicate rather
than two sets that could disagree. It is reported once as a `thread-history-unreadable`
persistence diagnostic naming the Thread — the only trace, since nothing durable records
it, so it is never emitted for a Thread that merely inherited quarantine from an
ancestor's subtree and was refused on availability rather than on decoding.

Threads already held back by delegated-Agent admission recovery are still probed, so a
Thread whose history also fails to decode answers the contracted refusal rather than
leaking the codec error — the read guard keys off unreadability, not off quarantine.

Reconciliation failing is deliberately *not* disqualifying on its own: a torn rollout
leaves a Thread that no longer advances but still reads out of its projection, and that
history stays browsable. The quarantine question is only whether the Thread decodes.
The reason this is a launch concern at all is that the startup fan-out over Threads —
`MemoryExtension.prepareForTurnAdmission` reading every root Thread's Turns inside
`initialize` — has no per-Thread guard, so before this an unreadable Thread ended the
process at launch even though reconciliation had already caught the same failure.
Context writes
canonicalize through the Core codec before hashing. Context and text reads/copies
verify digest and byte length, while text also selects storage by the referenced
MIME type. Managed input admission reserves quota before writing, stages chunks under
`agent/scratch/uploads`, and publishes only a complete exact revision plus opaque Agent
reference. Failed content admission immediately
removes image observations created by that attempt unless canonical history already
references them. Execution-time context publication writes the payload and its Item
under the Thread mutex; failed publication and Turn terminalization prune any context
payload not reachable from the canonical Item graph. Inline model-call arguments are
codec-bounded to 32 KiB; larger exact JSON uses the Thread-owned payload store rather
than truncation. A resolved tool may select up to 256 non-overlapping textual argument
paths in deterministic UTF-16 code-unit order for private internal-text storage, subject
to per-binding and aggregate
64 MiB UTF-8 ceilings. Admission rejects unpaired UTF-16 surrogates, scans each selected
string independently, scans the remaining skeleton structurally, writes verified text
dependencies before the context envelope, and commits the owning Item last. Canonical
provider replay rehydrates the exact durable value. Transcript, trajectory, compaction,
Turn copy, and renderer detail instead share one path-aware 32,000-character projector
that streams verified prefixes, accounts for complete pretty-JSON indentation at every
depth, and never constructs the complete bound value. The
recommended Secretlint preset plus complete private-key, legacy
`sk-`, short GitHub-token, Bearer, and JWT signatures redact known credential formats
before either the Item or payload becomes durable.
Structured fields change only when both the normalized terminal field name identifies a
credential and the value is a credential-candidate string; non-string shapes, numeric
strings, placeholders, and ambiguous free-form content pass unchanged. Ambiguous bare
`credentials` and `token` fields require at least 20 opaque characters containing both
letters and digits. Serialized JSON key inspection is limited to `args`, `arguments`,
`body`, and `payload` strings, preserves unrelated formatting, and never reinterprets
nested JSON strings. Rule exceptions, unsupported asynchronous rules, malformed JSON,
and scanner depth failures all fail open. Each structured value stages its strings in
canonical traversal order. A sufficiently large batch runs the same complete scanner on
a bounded pool of at most two lazy unreferenced Node workers; a small batch runs the
direct scanner exactly once. A pooled request starts its five-second watchdog only when
it leaves the queue for a new or idle worker. A startup timeout releases pool capacity,
and a worker that finishes starting after its request settled is terminated. A worker
error or timeout terminates that worker rather than repeating the unbounded scan on
Electron's main thread. For durable values, an off-main worker rejection preserves the
traversed JSON container and non-string scalar structure, replaces every pending string
with `[redacted]`, and records one fixed warning with no error detail or user content.
This structure-preserving fail-closed boundary was approved by the PM on 2026-08-18;
direct scanner, traversal, malformed JSON, and depth failures retain their existing
fail-open behavior. Private-key matching pre-indexes BEGIN/END
markers, and whole strings are scanned without chunking, so credential matches spanning
arbitrary distances retain identical coverage and bytes without repeated suffix scans.
Durable scanning has no character budget. Diagnostic copies separately spend one
64,000-character budget before dispatch, use an omission marker beyond it, and replace
the whole copy with the typed omission marker if their worker rejects.
The diagnostic copy never becomes Item or replay data. Redacted replay
compatibility is decided once
against the admission schema: a compatible copy becomes `redactedReplay`; an
incompatible copy becomes executed `evidenceOnly`, while the validated transient source
call may still run. Evidence provider names, corrections, and argument summaries have
independent UTF-8 bounds, and malformed redaction pointers fail at the
codec boundary. Cleanup boundaries decode canonical Turns once into resource,
context-payload, diagnostics, and text-output reference sets. Turn finalization first
takes the resource-reference snapshot and unlinks newly written resources that no
terminal Item references. It then refreshes the canonical payload-reference snapshot
once and prunes contexts and diagnostics in parallel, so canonical appends during the
resource cleanup are visible to both payload pruners. Startup rebuilds Thread links from
canonical history, releases orphan reference records and anchors, and reconciles anchor
metadata with ContentStore before collection. Link removal and orphan collection run
only after every known non-quarantined Thread has produced a readable reference
snapshot. A quarantined or unreadable Thread makes that snapshot incomplete, so startup
only adds proven-live links and conservatively retains all existing links, records, and
exact bytes for a later reconciliation.

A history rollback reclaims contexts, Turn diagnostics, tool text outputs, and tool
artifacts against surviving history. Managed resources referenced by removed
`userMessage` Items are the exception: Edit and Rerun re-send that exact user content,
so its attachments remain temporarily reachable through the admission that follows.
Tool output and generated context are not re-sent; once their Item owner is removed,
their links are removed immediately. A reference with no surviving Thread link is
garbage no canonical history can reach: its record is deleted, its anchor is released,
and ContentStore collection may reclaim the physical revision. External sources are
never deleted. Source resolution revalidates the registered scope, canonical root,
relative path, symlinks, entry kind, and requested read/edit/reveal capability at each
use. Exact resolution validates the private anchor and revision metadata in
ContentStore. A failure marks only the representation unavailable.

Canonical ContentStore and source paths remain private to main. Consumers that need a
filesystem path receive a disposable scratch observation. Provider execution owns a
Turn-scoped observation directory; Preview/Open uses an exact-revision observation,
while Reveal/Edit Source resolves the current source locator and never substitutes the
exact observation. A materialization error during provider projection is recorded and
degrades only the readable-path hint; available image bytes and the surrounding Turn
still project.

First-party tools persist ordinary artifacts through one `ToolArtifactSink`. It admits
canonical MIME/file-name metadata and at most 64 MiB per file, rejects symlinks and a
source whose opened identity or metadata changes during the read, verifies the returned
opaque reference metadata, and then requests a Turn-scoped readable materialization. A
successful canonical write with failed materialization returns the stable reference and
a null path; admission or storage failure omits the artifact from the owning manifest
without killing an otherwise useful tool operation. Storage errors are logged with their
live cause but cross the tool boundary as stable quota-or-storage messages, so private
ContentStore paths cannot enter model-visible or retained text.

Exact Agent resources have an 8 GiB per-Thread linked-byte hard budget; browser uploads
also retain the 2 GiB per-resource admission ceiling. Admission reserves capacity before
publishing a reference. ContentStore deduplicates physical revisions by digest, while
logical quota and reachability operate on opaque references and Thread links rather than
digest equality. There is no image-specific soft-watermark or age-based Agent resource
collector. Ephemeral Threads keep history in memory but use the same canonical resource
records while alive; close/delete removes their links. Startup and rollback remove stale
uploads plus resource links, context payloads, Turn diagnostics, and complete text
outputs absent from reconciled canonical history. Forks copy only Thread-owned payloads
referenced by inherited Items and Turn execution; resources are shared by link. Missing
payload copies are recoverable: canonical references remain on copied Items, tool
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
  Turn/Item reads, exact full-output and context-evidence reads, authoritative
  audited diagnostics reads, and Trajectory projection/detail/export reads
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
this audit method. It refuses raw `toolCallArguments` envelopes.

`thread/item/arguments/read` authorizes only the enclosing `(threadId, turnId, itemId)`
identity. It returns `{ arguments }`, where the value is already bounded by main or is
`null` when any canonical dependency is unavailable. Inline arguments do not use this
route. The renderer cannot request a context digest, internal-text digest, or binding
path directly.

Main retains canonical `Thread`, `Turn`, and `ThreadItem` values. Before main-window IPC,
one exhaustive response/notification projector recursively replaces only payload-backed
model-call arguments with `{ storage: 'itemBound' }`; inline arguments cross unchanged.
The projection includes Turns nested in renderer-readable inherited-context payloads.
Preload decodes distinct renderer projection types and rejects `storage: 'payload'` plus
its private references at canonical model-call slots, without interpreting matching keys
inside arbitrary inline JSON. Every Agent Core method and notification variant appears in
an exhaustive switch, so a new carrier cannot silently bypass the privacy boundary.

`thread/turn/details/read` resolves one reachable full Turn and its Thread-owned
diagnostics reference. A Turn without a reference returns `diagnostics: null`; a Turn
with a reference must return the exact matching payload or fail. Missing bytes,
digest/length corruption, a mismatched reference, unknown diagnostics fields, and an
invalid payload version fail closed. Renderer code cannot read diagnostics by digest
alone. This is an audited raw evidence reader, not the product workspace route.

`thread/trajectory/read` builds a Thread-wide, inspection-only projection from
canonical Turns plus retained evidence. It returns only `threadId`, a summary, an
ordered record window, `olderCursor` / `newerCursor` plus `hasOlder` /
`hasNewer`, and the selected record. Cursors are stable keyset cursors over
record identity, not mutable array offsets. Reads locate the bounded Turn window
before diagnostics payload reads and cap diagnostics read concurrency. They may
materialize one predecessor Turn to recover the stable-prompt and tool-catalog
fingerprints at the window boundary; predecessor evidence never enters the
returned window. The
summary uses lightweight whole-Thread Turn/Item/timing/usage facts and must not
force diagnostics materialization outside the requested window. Record kinds are
`input`, `context`, `assistant`, `tool`, `retry`, `compaction`, and
`delegation`. Assistant records use provider-call evidence as their primary
identity; tool and runtime records use diagnostic activities when retained and
degrade to canonical Item evidence when not. While a Turn is active and has no
final diagnostics reference, the projection may consume a bounded, best-effort
in-memory diagnostics snapshot; inspection failure cannot affect execution. With
no explicit focus, the read returns `selectedRecordId: null`; opening the
Thread-wide workspace must not manufacture a selection merely because records
exist.

Record order is represented by an opaque fixed-width `orderKey` derived from
stable canonical Turn/activity/call/item coordinates, not by the number of
records currently projected. `turnIndex` and `stepIndex` are explicit display
coordinates. A response's `replacementRange` is an inclusive pair of order keys.
Typed record labels carry semantic values only; renderer owns localization and
main does not encode UI titles into the protocol.

Every record carries exactly one typed `primaryEvidence` reference. A Provider
Call is addressed by `(threadId, turnId, callIndex)`. One execution inside a
tool batch is addressed by `(threadId, turnId, activityIndex, callId)`; the batch
activity alone is not unique evidence for any one of its calls. The record ID is
stable projection identity for paging and selection, not evidence authority.
Detail resolution never parses an evidence coordinate from that string.

`thread/trajectory/detail/read` returns bounded, credential-redacted evidence for one record. It
locates the owning Turn from stable record identity and reads only that Turn's
diagnostics before materializing detail evidence. It does not return full
`Thread`, `Turn`, `ThreadItem`, or raw diagnostics payloads. It may return
bounded Turn/Item evidence, sanitized runtime facts, sanitized provider-call
request/response values, sanitized activity evidence, sanitized context payloads,
and sanitized/truncated tool output. Credential redaction is applied at renderer-facing
opaque evidence leaves; typed diagnostics control fields such as discriminators,
indexes, and enum fields are preserved so a large legal evidence string cannot
corrupt the diagnostics structure. Filesystem paths are preserved when they are
part of accepted input, prepared context, a captured provider request or
response, or model-issued tool arguments. It must not expose diagnostics payload
storage paths, digest-only read authority, raw secrets, credentials, arbitrary
response headers, or image bytes. Main resolves the record's typed
primary reference against its owning Thread and Turn, then uses only explicitly
related references for supporting evidence. Missing inspection evidence degrades
that record or detail field and cannot change canonical history or fail a
running Turn. Input detail preserves the ordered prepared-message part types;
image bytes become MIME / byte-length / digest evidence. Tool Input resolves the
canonical Item `modelCall` argument source rather than reconstructing arguments
from presentation or host execution fields. A lazy read that discovers a
missing argument payload or tool output appends the corresponding availability
fact to the detail response's record. Canonical accepted input remains Raw
evidence and never substitutes for missing prepared provider evidence in a
Trajectory preview. Assistant detail preserves the terminal provider-neutral
response as ordered text, thinking, tool-call, image-metadata, and bounded other
parts. Compaction detail reads its retained summary payload on demand. Inspector
evidence fields never fall back to the lightweight record preview.

`thread/trajectory/export` writes the same sanitized projection from main and
returns only status, file name, and byte length. The renderer never receives the
absolute export path; write failures are logged in main and return a fixed
path-free failure message.

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
Trajectory is the complete technical surface for a canonical Thread. It receives a
main-owned sanitized projection over the same canonical Turns, retained diagnostics,
context payloads, and output references used by execution. It does not recreate the
retired conversation/run/round debug projection, derive history from renderer
pagination, or introduce an alternative execution ledger. USER rows are grounded
on canonical `userMessage` Items, while their model-visible Preview comes from
captured prepared-message parts whose `userInput` provenance carries that exact
Item ID. CONTEXT rows come from captured system-context parts, stable prompt, or
provider-visible tool catalogs. Canonical user content remains accepted-input
evidence rather than a reconstruction of the provider request. REQUEST detail is
the bounded materialized post-adapter provider payload captured in diagnostics;
image bytes do not cross to renderer, while captured filesystem paths remain
exact evidence.
The exact page contract lives in
[`agent-thread-rendering.md`](agent-thread-rendering.md).

## Outliner Observation

Agent Core does not maintain a second document-belief or drift-notice subsystem.
The public `outline` CLI returns revisioned Projections and requires base
revision and target preconditions for writes. A stale Diff or changed target
therefore fails at Runtime admission without relying on replayed tool output.

Read results remain canonical shell-tool evidence in the Thread record. Runtime
Operations carry immutable origin and, for built-in Agent writes, attested
Thread/Turn/Item causation. Inspection-only document evidence may be unavailable
or stale without preventing a later Turn from starting; consequential workflows
must perform an explicit fresh read when current state matters.

## Trusted Document Transactions

Trusted features submit ordinary Runtime ChangeSets with host-issued causation
and idempotency keys. The Runtime returns only after document bytes, Operation,
recovery patch, receipt, asset delta, and Events share one durable transaction.
A feature-side control store finalizes only after resolving that receipt; retry
with the same key returns the settled Operation rather than duplicating Nodes.

Protected definitions retain host-owned identity and lifecycle. Public Changes
may apply or remove a protected tag from content but cannot mutate its
definition. Runtime validation extracts every owner, parent, target, binding,
and nested tree reference and fails closed before write admission.
