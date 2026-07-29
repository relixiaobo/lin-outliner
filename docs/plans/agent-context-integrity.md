# Agent Context Integrity

## Goal

Restore the complete model-context contract lost in the Agent Core rewrite without
restoring the retired runtime or creating a second history authority.

The target architecture is:

> Canonical Items plus Thread-owned payloads are the evidence. One deterministic
> context planner projects that evidence into provider messages. Provider transcripts,
> scratch paths, and `system-reminder` text are execution caches or serialization
> details only.

This restores and unifies all context-bearing behavior:

- the root Neva persona, capability instructions, environment, Outliner Today, and
  bounded user-view context;
- ordinary attachments and explicitly referenced Node/file/image resources;
- trusted application context versus untrusted document and renderer data;
- Skill discovery, inline instruction loading, restart, and compaction restore;
- full tool-output references, deterministic context budgeting, automatic and manual
  compaction, and `/clear`;
- faithful Subagent `fork_turns` inheritance; and
- provider runtime settings and prompt-cache boundaries.

This plan has shape **(b): a set of complete features**, delivered as three complete
PRs. The first PR is the repository-mandated shared-interface-first contract change;
the second replaces context composition and admission end to end; the third completes
the remaining runtime as one atomic feature. Budgeting, context controls, Subagent
inheritance, Role discovery, provider policy, and prompt-cache integration are internal
build stages of PR 3, never separate releases. No PR is a scaffold that requires a
later PR to become useful.

## Non-goals

- Do not revive the pre-Core `Agent.messages` store, retired event model, mutable
  context manager, or any compatibility reader.
- Do not persist provider SDK DTOs, base64 images, observation paths, or a provider
  transcript as product history.
- Do not make hidden context visible as ordinary user or assistant messages.
- Do not infer trust by recognizing XML-like text. A user may type a
  `system-reminder` wrapper literally and it remains user text.
- Do not turn context compaction into Memory. A compaction summary is lossy routing
  context, never source evidence for Dream or durable Memory claims.
- Do not copy ordinary path-backed attachments into Thread storage. Their existing
  live-path contract remains; this plan snapshots only managed inputs and resources
  reached through an explicit Outliner Node reference.
- Do not copy complete Skill bundles into Thread storage. Invocation instructions are
  canonical evidence; support files remain live resources until ordinary tools observe
  them and freeze the resulting tool output.
- Do not add migration or legacy fallback. This is a pre-release format change; dev
  data is wiped when the interface PR lands.
- Do not change document, tool, Skill, Role, or provider capability authority. Context
  construction can describe effective authority but cannot widen it.

## Design

### Purpose, evidence, options, and decision summary

The Core rewrite correctly made Turns and Items canonical, but the old runtime also
held unstated context state in long-lived objects. The rewrite moved provider history
reconstruction to Items without moving every input to that reconstruction into
canonical evidence. The resulting omissions share one root cause:

| Surface | Current failure | Required invariant |
| --- | --- | --- |
| Stable prompt | One minimal Tenon prompt replaces the layered Neva prompt; dynamic system fragments are mixed into it | One L0/L1/L2 composer; volatile data never enters the cacheable prefix |
| Turn input | `additionalContext` is execution-only and steering bypasses prompt preparation | Initial input and steering use one admission and projection path |
| User view | Renderer no longer supplies the active Outliner/selection snapshot | Renderer supplies bounded IDs; main resolves authoritative content |
| Node resources | `nodeReference` becomes only an ID label | Explicit file/image Nodes receive a durable resource snapshot and model-visible identity |
| Skills | Runtime queues private steering text and later parses reminder strings to recover state | Invocation identity and exact instructions are structured evidence |
| Tool output | Full `outputRef` exists but history replay uses only the bounded Item projection | The planner selects full content, bounded content, or an addressable observation explicitly |
| Compaction | `contextCompaction` is an empty marker and no global budget planner exists | A summary names its covered range, preserved tail, trigger, and payload |
| Clear | The previously shipped context boundary disappeared | `/clear` appends a canonical epoch boundary without deleting visible history |
| Subagents | `fork_turns` flattens text, drops tools/resources/images, then cuts at 50,000 characters | A provider-neutral structured snapshot preserves valid history and owned payloads |
| Provider execution | Ordinary Turns omit parts of configured retry/timeout/cache policy | Every request applies the resolved provider settings; overflow has its own path |
| Discovery | `agent_type` accepts Role names but the model has no bounded Role catalog | Spawn-capable Turns receive the effective Role catalog |

The old reminder stack maps into the new contract without retaining its string-based
state machine:

| Previous source | Canonical destination |
| --- | --- |
| local time/date, timezone, UTC offset, locale | `turnEnvironment` evidence |
| direct-conversation topology and reply identity | `turnEnvironment` plus root/child prompt mode |
| Outliner Today/current outline context | main-resolved `turnEnvironment` identity/title plus `userView` evidence |
| focused panels, visible outline, selection, explicit Node references | bounded `userView` snapshot |
| attachment marker and referenced-file reminder | structured user content plus `referencedResources` evidence |
| available and invoked Skill reminders | `skillCatalog` and `skillInvocation` evidence |
| available Agent listing | effective `roleCatalog` evidence |
| Memory, Automation, and other extension reminders | typed `additionalContext` evidence with source/authority |
| compact restore reminder | `contextCompaction` plus reduction of retained evidence |

The comparison baseline is the code immediately before the Core replacement:
`59c7e1cf^` for `agentRuntime.ts`, `agentSystemPrompt.ts`,
`agentToolOutputSlimming.ts`, and `agentProviderCacheBreakpoints.ts`, plus
`4230a975^` for `agentSkills.ts`. The replacement audit is explicit:

| Removed mechanism | Property that must survive | New owner |
| --- | --- | --- |
| `buildUserPromptMessage` and trailing `systemReminder` assembly | context stays at the current tail and off the stable prefix | evidence admission plus provider serializer |
| `AgentUserViewContextReminderTracker` | first snapshot, then bounded deterministic diffs | canonical `userView` snapshots plus planner reducer |
| referenced-asset materialization | a named Node/file identity accompanies readable bytes and vision input | `referencedResources` plus Thread-owned resources |
| `SkillListingState.reserve/release/restore` | old conversations see only new or changed Skills without repeating the catalog | durable `skillCatalog` baseline/delta journal |
| invoked-Skill reminder parsing | exact invoked instructions survive restart and compaction | `skillInvocation` payloads plus compaction restore state |
| `modelFacingContent` and monotonic slimming state | an old tool result never changes representation on a later request | `toolOutputProjection` evidence |
| `createPostCompactRestoredFilesReminder` and recent file-read tracking | the latest still-active file/Node observations remain addressable after compaction without rereading mutable files into history | `compactionRestoredState.activeObservations` with frozen projection and full-output references |
| Neva L0/L1/L2 composer and Anthropic L0 split | stable firmware and execution prompt remain reusable cache prefixes | stable composer plus provider cache adapter |
| context-manager compaction and clear state | replacement is explicit without deleting source evidence | `contextCompaction` and `contextReset` Items |
| Subagent character-tail flattener | inheritance preserves complete semantic units and owned bytes | structured `inheritedContext` payload |

The historical `systemReminder()` call sites are classified by semantics, not by
their wrapper spelling:

| Historical reminder use | Decision |
| --- | --- |
| turn environment, Outliner/view state, referenced resources, Memory/Automation context, Skill/Role discovery, and invoked Skill guidance | retain as typed canonical context evidence |
| compact summary, catalog/invocation restore, recent file observations, and child follow-ups | retain as typed compaction summary, reducer checkpoint, active-Turn canonical user input, and preserved tail |
| child completion delivery, amendments, controller directives, and other still-supported collaboration transitions | represent through canonical collaboration/feature Items or typed context owned by that feature; never recover state from prose |
| retired Issue delivery and Dream hidden-anchor prompts | do not restore with the retired runtimes; any future equivalent must define a current canonical contract |
| literal user/model text containing `<system-reminder>` | preserve as ordinary untrusted text with no parsing or authority upgrade |

This inventory prevents two opposite regressions: silently losing state merely because
it used the old wrapper, and reviving obsolete control planes merely because they once
called the same helper.

The old Skill listing reservation mutated memory before the provider call and rolled
back on request failure; restart recovered it by scanning reminder prose. The new
transaction publishes payload bytes and the catalog Item before provider exposure.
An agent-authored Skill is appended only after complete-bundle validation; an external
Skill is appended at the next admission. Both cases add a delta at the current tail,
so the complete previous provider request remains a byte-identical cache prefix.

Three implementation strategies are possible:

1. Restore the retired runtime state. This recreates two histories and makes restart,
   rollback, and fork behavior dependent on reconstruction order.
2. Patch each current message builder. This keeps initial input, steering, replay,
   Skills, and Subagents divergent and will repeat the same regression.
3. Persist context evidence and project it through one planner. This makes every
   provider request reproducible from one authority and is the selected design.

### Functional and non-functional requirements

The implementation must enforce these invariants at module boundaries:

- **NFR-01: One history authority.** Reachable canonical Turns, Items, and their Thread-owned
   payloads are the only durable context evidence.
- **NFR-02: One projection entry.** Initial requests, later tool loops, steering, restart,
   history replay, compaction retry, and child inheritance call the same planner.
- **NFR-03: Stable prefix, volatile tail.** Time, environment, view state, catalogs, attached
   resources, and additional context cannot enter the stable system prompt.
- **NFR-04: Authority is metadata.** Provider-visible text carries host-assigned authority and
   purpose; tag spelling never changes authority.
- **NFR-05: No silent loss.** Every omitted or reduced block is represented by a summary,
   explicit unavailability record, or readable observation reference.
- **NFR-06: Valid tool history.** A tool call and its result are an indivisible budget unit.
   The planner never emits an orphaned call or result.
- **NFR-07: Immutable evidence, replaceable projection.** Compaction changes what the model
   sees, not the Items or payloads it summarizes.
- **NFR-08: Configuration is Turn-stable.** No inline operation changes model, effort, or tool
   catalog after Turn admission.
- **NFR-09: Thread ownership.** A fork or child can resolve every inherited managed payload
   after its source Thread is deleted.
- **NFR-10: Explicit failure.** If mandatory stable prompt, tools, current input, active Skill
    instructions, and protected tail cannot fit, the Turn fails with a bounded context
    capacity error instead of dropping required input.
- **NFR-11: Monotonic cache projection.** After an Item first reaches a provider, its
   model-facing bytes, order, and resource identifiers remain unchanged until a
   canonical compaction or reset starts a new context branch. New volatile context is
   appended; it never rewrites an earlier request prefix.

### Canonical context evidence

Add three canonical Item kinds:

```ts
type ContextEvidenceKind =
  | 'turnEnvironment'
  | 'userView'
  | 'additionalContext'
  | 'referencedResources'
  | 'skillCatalog'
  | 'skillInvocation'
  | 'roleCatalog'
  | 'toolOutputProjection'
  | 'inheritedContext';

interface ContextEvidenceThreadItem extends ThreadItemBase {
  readonly type: 'contextEvidence';
  readonly kind: ContextEvidenceKind;
  readonly payloadRef: ThreadContextPayloadReference;
  readonly summary: string;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
}

interface ContextResetThreadItem extends ThreadItemBase {
  readonly type: 'contextReset';
  readonly clearedThrough: ContextCursor;
}

interface ContextCompactionThreadItem extends ThreadItemBase {
  readonly type: 'contextCompaction';
  readonly trigger: 'automaticPreflight' | 'providerOverflow' | 'manual';
  readonly coveredFrom: ContextCursor;
  readonly coveredThrough: ContextCursor;
  readonly preservedFrom: ContextCursor | null;
  readonly summaryRef: ThreadContextPayloadReference;
  readonly restoredStateRef: ThreadContextPayloadReference;
  readonly instructionsRef: ThreadContextPayloadReference | null;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
}
```

`UserMessageThreadItem` also gains a canonical `acceptedAt` timestamp. Initial input
and every steering input serialize that stored value; replay never substitutes the
current clock. Provider-visible timestamps and ordering metadata must derive only from
persisted Turn/Item facts.

`ContextCursor` identifies an exact `turnId`/`itemId` boundary. The initial context
epoch is derived from Thread identity; every later epoch is identified by its latest
reachable `contextReset` Item. No mutable `currentEpoch` field is stored.

`ThreadContextPayloadReference` is a lowercase SHA-256 content reference with MIME
type, byte length, schema version, and payload kind. Evidence and compaction Items
validate the exact kind they require before publication. One context payload is capped
at 16 MiB and also uses the existing aggregate Thread quota, safe-path, digest
verification, copy-on-write, reconciliation, and delete rules. Context payload codecs
are exact-key discriminated unions, not arbitrary JSON bags. Unknown versions or kinds
fail closed.

Schema version 1 has one exact codec for each evidence kind plus
`compactionSummary`, `compactionRestoredState`, and `compactionInstructions`.
Environment and user-view payloads retain structured snapshots; additional-context
entries carry source/authority/purpose; resource payloads carry typed availability;
Skill and Role catalogs carry baseline/delta hashes; Skill invocation carries exact
instruction bytes and validated constraints; tool-output projection freezes one
representation; inherited context carries terminal canonical Turns; and compaction
payloads retain the lossy summary, reducer checkpoint, and active instructions. The
reducer checkpoint includes catalogs, active Skills, the user-view baseline, and
`activeObservations`. Each active observation has a stable semantic key, tool identity,
untrusted subject, complete `outputRef`, and frozen `toolOutputProjection` reference.
It deliberately stores neither a scratch path nor another copy of file text.
`untrusted/instruction` is invalid. An inline Skill payload with model, effort, or tool
overrides is invalid.

Any nested context payload, managed resource, or full tool output named by a context
payload is also listed in the owning Item's `contextRefs`, `resourceRefs`, or
`outputRefs`. Payload dependency discovery never parses private JSON: startup
reconciliation, rollback, fork, child copy, and deletion operate from the canonical
Item graph. Forking rewrites local cursors and copies every payload and dependency
before the source Thread can be deleted. Text-output reads and copies verify the
reference MIME type, byte length, and digest rather than selecting a file by digest
alone.

Dynamic tool images use a typed source: a live readable file remains `localFile`, while
provider image bytes are admitted as a content-addressed `threadPayload` resource.
Managed image references inside inherited Turns are repeated in the owning context
Item's `resourceRefs`, so lifecycle code copies the dependency without opening or
rewriting the inherited payload. The same resource reference is valid under the target
Thread's ownership; fork therefore preserves the context payload bytes, digest, and
provider cache identity instead of creating a path-dependent payload variant. Preview
resolves a referenced image through the current Thread into a disposable scratch copy;
the canonical managed path never enters rollout JSON or renderer state. Add to outline
uses a main-renderer-only `(threadId, resourceRef)` asset-ingest seam that reauthorizes
the Item-graph reference and buffer-ingests verified bytes under the existing 20 MiB
non-truncating cap, preserving the action without accepting or returning a managed path.

Every provider-visible text leaf inside a payload is classified as:

- `application/instruction`: host-selected Role, Skill, or execution guidance;
- `application/observation`: host-derived time, topology, identity, or availability;
- `untrusted/observation`: renderer text, document content, filenames, extracted
  content, inherited model output, or any external source.

Renderer IPC may author only `untrusted/observation`. Main owns every application
classification. A payload may contain both application metadata and untrusted document
values, but the two become separate blocks at projection time.

Context evidence is hidden from the ordinary message transcript. Turn Diagnostics and
exports expose its bounded summary, kind, source, hash, and availability for audit;
full untrusted payload text is loaded only through an explicit details action. Reset and
compaction Items retain dedicated visible boundary rows.

### Core flow: admission and ordering

`ThreadService` assembles evidence before a model can observe an input:

1. Normalize structured user content and renderer-authored hints.
2. Ask extensions for typed context contributions under the existing admission
   barrier.
3. Resolve environment, user view, catalogs, Node identities, and managed resources in
   main.
4. Publish payloads, then append the resulting `contextEvidence` Items immediately
   before their `userMessage` Item. Initial admission uses one `turn/started` event;
   steering uses one `items/completed` event.
5. Return acceptance only after the user Item and all required evidence are durable.
6. Start or notify the executor.

The same sequence applies to steering. `turn/steer` persists its evidence and
`userMessage` before waking the live Agent. Queued and immediately delivered steering
therefore have identical history. Execution-generated evidence, such as an invoked
Skill, is appended immediately after the completed initiating tool Item and before that
tool returns control to the next provider request.

The provider serializer renders every attachment with the shared file-reference marker
at its structured user-content position. Node references use the shared Node marker;
images place their file marker immediately before the immutable prompt snapshot.
Canonical state never parses those provider strings. Admission rejects an image without a
Thread-owned prompt snapshot and rejects a non-image carrying one; projection never
reinterprets either invalid shape as an ordinary file.

Each immediate group is one rollout event and one projection transaction. Recorder state
changes only after that publication succeeds, so admission failure cannot leave a client
binding, evidence Item, user Item, or orphaned payload. Renderer listeners and extension
observers run after canonical commit and are best-effort delivery; their failures are
logged without rolling history back or reporting a false admission failure. Streaming
and executable Items retain the normal `item/started` / `item/completed` lifecycle.
Post-commit status bookkeeping and steering delivery follow the same acceptance
boundary: a failure terminalizes the already-accepted Turn instead of rejecting the
input. Steering delivery is serialized, and terminalization closes admission before it
freezes the final Item list.

`clientUserMessageId` remains a Thread-scoped idempotency key across initial and
steering admission. Once its canonical `userMessage` exists, a response-loss retry
returns the original acceptance even after Turn terminalization or process restart;
the sidecar is only a rebuildable index. A missing or unresolved binding is recovered
by scanning reachable canonical Turns and then re-indexed; sidecar state can neither
grant acceptance without the exact Item nor permit duplicate canonical admission.

An unavailable referenced Node asset is valid evidence with a typed reason such as
`missing`, `corrupt`, `unsupported`, or `quotaExceeded`; it is never represented as if
the model inspected the bytes. Failure to publish mandatory input payloads rejects
admission before provider side effects.

### One context planner

Add a context module with one public provider-request entry point and four internal
stages:

```text
composeStablePrompt(configuration, capabilities)
        +
projectCanonicalHistory(reachable Items, active epoch, latest compaction)
        +
planContextBudget(model limits, tools, current evidence, projected history)
        +
serializeProviderContext(provider/model)
        = one provider request context
```

`PiTurnExecutor` installs this entry at the stream boundary, so every provider request
in the Agent loop is planned, not only the first `prompt()` call. Before another
provider request, the recorder must have durably completed the preceding assistant and
tool Items. The in-memory pi Agent transcript remains a scheduling cache and may be
validated in tests, but it is not accepted as history input by the planner.

The current `preparePrompt`, direct steering `modelUserMessage`, independent
`historyMessages`, Skill steering queue, and Subagent text flattener are removed.
`CanonicalContextProjector` owns provider serialization for both complete Turns and
newly admitted steering Items; none of the removed message builders remains as a
compatibility path.

The provider-neutral projection preserves semantic event order:

- user content and context evidence become adjacent context/user blocks;
- assistant text and reasoning remain assistant content with explicit provenance;
- every tool Item becomes a paired call/result unit;
- reset selects the epoch and is not sent as conversational prose;
- the selected compaction contributes its summary plus the preserved tail; and
- deterministic summaries are labelled as lossy derived context, never facts.

Budgeting may choose a representation only for a new unit that no provider has seen.
Once exposed, the persisted evidence and any `toolOutputProjection` decision freeze its
provider-neutral bytes. Growing context cannot cause the planner to re-render, remove,
or re-expand an older unit opportunistically; older history changes resolution only
through a recorded compaction boundary.

### Stable prompt and cache discipline

Restore the previously ratified layered composer for every execution kind:

```text
STABLE SYSTEM PREFIX
  L0 framework firmware   -> universal, framework-owned, non-removable
  L1 capability modules   -> selected from the effective tool/capability catalog
  L2 identity/instructions -> root Neva persona or child Role instructions
TOOLS                     -> stable for the admitted Turn
FROZEN HISTORY            -> prior model-facing bytes replay verbatim
APPENDED UNCACHED TAIL    -> environment, catalog deltas, view, resources, current input
```

L0 contains the cross-agent floor only: truthful action reporting, prompt-injection
handling, authority interpretation, read-before-act for resources, native tool failure
semantics, destructive/outward-action discipline, and the requirement to load a
matching Skill before acting. Tool syntax remains on tool descriptions.

L1 contains only cross-tool framing with a real capability consumer, including files,
Outliner, Memory, Skills, and collaboration. A capability absent from the effective
catalog contributes no module. The files module preserves Full Access/native-denial
semantics, read-before-rely, and the rule that a user-facing deliverable is placed under
the Thread working directory and referenced through the renderer-safe absolute-file affordance.
Tool-specific syntax, including generated-image placement, remains on the owning tool
description/result instead of being duplicated in the prompt.

L2 restores the previously shipped `NEVA_AGENT_PERSONA` verbatim as the single root
product persona while keeping Tenon as the product name; this work does not rewrite
persona copy. Root Profile developer instructions follow the Neva persona. A child is
a headless execution of a Role: it receives L0, applicable L1 modules,
headless-worker framing, and Role developer instructions, but does not duplicate the
conversational root persona. This preserves one user-facing Neva without pretending
each child is a second identity.

The composer returns structured stable blocks and their byte fingerprints. Anthropic
requests place a cache breakpoint after L0 where cross-agent reuse is useful and after
the complete stable per-execution prompt. Existing last-tool and last-user breakpoints
remain within the provider limit. Non-Anthropic serializers do not receive Anthropic
metadata. Provider-payload golden tests, rather than live cache-hit rates, are the
correctness surface.

Provider session/cache affinity is derived deterministically from the Thread identity
and current context epoch, never from a Turn-random value. Tool definitions use a
canonical order and deterministic schema/prompt serialization. A logically unchanged
tool registry therefore produces identical bytes across Turns, restarts, and steering;
an actual configuration or epoch change produces an intentional new affinity branch.

Cache topology is append-only within one context epoch:

| Segment | Change rule | Cache consequence |
| --- | --- | --- |
| L0 | changes only with framework firmware | reusable across compatible root/child requests |
| L1/L2 | changes only with the persisted execution configuration/persona | reusable for every Turn under that configuration |
| tools | fixed for one admitted Turn; Skill invocation never mutates it | the last-tool breakpoint remains reusable during the tool loop |
| prior history | byte-frozen after first provider exposure | the previous request remains an exact prefix of the next request |
| current context/input | appended after history as one or more user blocks | time, view, new Skills, and steering invalidate only the new suffix |
| compaction/reset | explicit canonical branch point | the miss is intentional once; later requests reuse the new branch |

Dynamic application context must not be inserted into a native system/developer block
ahead of tools or history. Doing so would preserve only the short system prefix and
invalidate the expensive conversation prefix whenever time, view, or a Skill changes.
The L0 firmware gives host-appended evidence blocks their interpretation; canonical
evidence, not provider role or wrapper spelling, remains the application trust source.

No current time, locale instant, Thread roster, view data, Skill/Role catalog, resource
path, or Memory briefing may be interpolated into L0-L2. Stable prompt tests compare
the exact fingerprint across Turns whose only differences are volatile evidence. A
second request with unchanged configuration must share the first request byte-for-byte
through all prior history; only its newly appended tail may differ.

### Environment and user view

The renderer sends bounded structural hints, never a textual prompt:

- active and focused panel identity;
- panel root Node IDs;
- focused and selected Node IDs;
- visible row IDs and expansion state; and
- explicit Node IDs already referenced by structured composer content.

Main validates those IDs against the current authoritative document projection and
creates a complete bounded `userView` snapshot. The historical bounds remain the floor:
at most 6 breadcrumb Nodes, 80 visible Nodes, depth 5, and 50 selected Nodes, with an
explicit total serialized-byte limit. Document titles, breadcrumbs, outline text,
selection content, and filenames remain untrusted observations. Application-owned
projection/interaction modes remain application observations. Panel, focus, selection,
visibility, Node-label, and truncation state is derived from renderer/document input and
remains an untrusted observation even after main validates IDs and resolves content.

Canonical evidence always stores a snapshot. The planner emits the first snapshot in
an epoch and deterministic field-level diffs against later snapshots. An unchanged
snapshot emits no provider block; nullable state and panel removal use explicit
tombstones. This recovers compact
snapshot/diff behavior without a runtime view tracker. A reset naturally removes the
baseline; restart, rollback, compaction, and fork derive the same baseline from Items.
Headless, Automation, and Memory Turns record an explicit non-interactive view mode and
never reuse stale renderer state.

`turnEnvironment` records the execution-start UTC instant, local date/time, resolved
IANA timezone, UTC offset, locale, working directory, conversation/execution mode,
reply identity, and current Today Node identity/title when available. The ID remains
application authority while the document-authored title is emitted as untrusted
evidence. It is generated per
accepted input. The first payload in an epoch projects a complete snapshot; later
payloads append only changed fields, normally the accepted instant and clock values.
Stable environment fields are not repeated in each new `system-reminder`.
Every stateless provider request still includes retained historical reminder messages as
the byte-identical cacheable prefix. Delta projection governs only newly appended
current-Turn evidence; it never removes or regenerates an earlier reminder in place.

### Attachments and referenced Node resources

Keep the current `ThreadUserContent` attachment contract:

- a path-backed local attachment remains a canonical live path;
- a pathless upload remains a Thread-owned content-addressed resource;
- image prompt snapshots remain normalized and bounded; and
- provider projection uses `formatFileReferenceMarker` and
  `formatNodeReferenceMarker` at the original structured part positions;
- the surrounding text and markers form one position-faithful user narrative, followed
  by independent attachment identity/read-path blocks and image bytes in attachment
  order; neither representation replaces the other;
- directories retain explicit directory identity, while stable instructions define
  percent-decoding and route directories to `file_glob` and files to `file_read`;
  inline extracted text retains truncation metadata; and
- provider conversion occurs only at the request boundary.

Expand explicit `nodeReference` admission in main:

1. Resolve the Node ID against the authoritative projection.
2. Snapshot its identity, bounded breadcrumb, visible outline/content, and resource
   availability into context evidence.
3. For an attachment or image Node, copy the referenced asset into the owning Thread's
   payload area using content-addressed copy-on-write semantics and a distinct inode.
4. Record only the stable resource reference in the evidence payload.
5. Materialize a deterministic Thread-scoped observation path derived from Thread ID,
   digest, and safe filename. Verify or repair its bytes before a Turn uses it; delete
   the observation with the Thread or during stale-scratch reconciliation.

A plain Node copies no asset bytes. An available attachment/image Node emits both an
application-authority readable path and the same untrusted-label file marker used by
composer attachments; an image Node also emits an image block when
the provider supports vision, so the model never receives
anonymous pixels. A non-vision provider receives the identity, explicit limitation, and
file marker. Missing, corrupt, unsupported, or over-budget resources emit
typed unavailability; no path or image claim is fabricated.

Replay, steering, compaction expansion, and child inheritance resolve the same immutable
resource bytes. The original document asset may later change or disappear without
rewriting what the historical model input referenced.

### Additional context serialization

Replace anonymous `systemContext: string[]` and execution-only `additionalContext` with
typed evidence contributions. Existing keys such as `automation_info` retain their
source and host-assigned authority. Renderer keys cannot shadow a reserved application
key. Contribution merge order and duplicate handling are deterministic and tested.

Every entry has one explicit lifetime. Direct privileged or renderer
`additionalContext` is a Turn-local event and is projected whenever that input is
admitted, even when its bytes match an earlier event. Extension contributions form one
complete Thread-state snapshot: the first value and later changes project as `set`, an
unchanged value emits nothing, and an inactive contributor produces a `cleared`
tombstone. The registry retains empty snapshots for registered inactive contributors so
ordinary host admission can clear the last active value. A registry with no Thread-context
contributors emits no empty payload; `null` remains reserved for modes where state was not
evaluated. Reset starts a fresh baseline.
Compaction checkpoints the latest complete Thread-state snapshot and restores only that
state; Turn-local entries in the same payload remain historical events and are not
replayed.

The provider serializer appends every volatile contribution as one or more hidden user
content blocks at its canonical tail position. Admission contributions coalesce with
the current user message; a Skill or catalog change discovered after a tool result
becomes a new hidden user block after that complete tool pair. No volatile contribution
rewrites the system prompt, tool list, or an older message.

An escaped `<context-evidence>` envelope inside the provider-facing `<system-reminder>`
convention labels serialized context after the planner has assigned authority. The
outer wrapper is only a convention explained by L0; tag spelling itself grants no
authority. The serializer identifies source/purpose and never scans model or user text
for tags.
There is no `unwrapSystemReminder`, `parseLoadedSkillFromText`, or equivalent recovery
path. A literal user-authored wrapper remains ordinary untrusted user content. The
authority field protects host behavior and reconstruction; L0 explains the hidden
block convention to the model without pretending XML is a cryptographic trust channel.

### Skill execution integrity

Skill discovery remains configuration-selected. The built-in Profile uses `*` to
preserve the complete discovered registry; explicit names form a hard allow-list and
an empty list disables Skills. Child Roles may narrow but never widen that ceiling.
`skillCatalog` is a versioned,
append-only announcement journal rather than a catalog repeated every Turn:

- the first model-visible Turn in an epoch records one bounded `baseline` with catalog
  hash, Skill identity, content hash, and compact description;
- an unchanged registry records nothing and adds no provider tokens;
- a later valid registry change records a `delta` with previous/current hashes and only
  added, changed, and removed entries; and
- `/clear` starts a new epoch, so the next Turn writes a new baseline.

The discovery service recomputes path-conditional availability at admission and after
a relevant completed file change. A Skill created by the agent is announced only after
the complete bundle validates and registry refresh succeeds; partial multi-file writes
do not expose a transient Skill. An externally added Skill appears at the next Turn
admission. In an existing conversation, either case appends a catalog delta to the
current tail and leaves every older byte untouched. The planner reads the latest
evidence and never rescans the current filesystem.

Before inline Skill instructions can affect the model, the Skill runtime publishes a
`skillInvocation` payload containing:

- canonical name, source, display-safe identity, resource root, and content hash;
- exact instruction bytes and invocation arguments;
- execution mode and invocation source; and
- the configuration constraints validated at load time.

The tool completes only after this evidence is durable. The invocation block is
appended immediately after the completed Skill tool result, so the next provider
request sees the exact instruction snapshot at the new tail while retaining the whole
previous request as its prefix. It does not mutate L0-L2, tools, or prior messages and
does not enqueue a private steering message. Once exposed, that instruction block is a
frozen cached suffix.

The latest invoked version remains active for the current context epoch, survives
restart and compaction, and ends at `/clear`. Editing or rediscovering the same Skill
announces a changed catalog hash but does not mutate already loaded guidance. An
explicit invocation of the new hash appends a new instruction block and supersedes the
old active version from that point forward; old evidence is never rebound to current
file bytes.

One Turn cannot observe two execution configurations. Therefore:

- inline Skills may add instructions only;
- `model`, `effort`, and `allowed-tools` are valid only for isolated Skills;
- an inline Skill declaring any of those fields fails validation instead of silently
  applying, ignoring, or partially applying them; and
- isolated Skills continue to intersect every capability with the parent ceiling.

`contextCompaction.restoredStateRef` checkpoints the effective catalog hash and
announced entries, active Skill payload references, Role catalog state, and user-view
diff baseline derived at the covered cursor. Summary plus restore state serialize once
at the compaction boundary and form the new cache branch; they are not regenerated as
new reminders every Turn. This replaces the current spec claim that compaction restores
Skills by parsing structured reminder text.

### Context budget and tool-output observations

Replace fixed character slicing and time-based microcompaction with one deterministic
budget planner. It uses provider/model token counting where available and a conservative
fallback estimate otherwise. It reserves output capacity and provider overhead before
planning input.

Budget priority is:

1. L0-L2, current tool schemas, and required provider framing;
2. current user input and the active complete tool exchange;
3. active Skill instructions and explicitly referenced current resources;
4. current environment/additional context and the latest effective user view;
5. the protected recent complete-Turn tail; and
6. older history or its latest valid compaction summary.

Priority affects representation and compaction eligibility, not semantic event order.
Required blocks that still do not fit cause an explicit capacity failure.

Every textual tool result continues to persist its full normalized `outputRef`. Before
the first provider request that can observe a completed result or parallel result batch,
the budget planner records one `toolOutputProjection` decision per result:

- full inline content when it fits;
- the bounded canonical Item projection with explicit omitted-byte metadata; or
- the bounded projection plus a deterministic scratch observation path whose full
  bytes can be read with `file_read`.

The choice is durable and monotonic: replay uses the same representation and byte
fingerprint, and later budget pressure cannot re-slim or re-expand it. Older history is
reduced only by compaction. The full result remains canonical and readable from
`outputRef` regardless of the model projection.

The reducer also tracks addressable observations created by file/Node reads. At a
compaction boundary it selects the latest observation for each stable semantic key that
has not been invalidated by a later write, move, delete, or contradictory read. The
checkpoint references the existing complete `outputRef` and its frozen projection; the
owning compaction Item lists those dependencies in `outputRefs` and `contextRefs`.
This replaces the old root/child fixed limits of five files, 20,000 characters per
file, and 200,000 characters total with the one global token budget. A restored observation is
explicitly a historical snapshot: if the underlying file or Node may have changed, the
model must read it again before relying on current content.

Observation path strings are deterministic within the Thread and never contain a
Turn-random directory. The host verifies or rematerializes the disposable copy from
`outputRef` before each Turn that may expose it, using the same path string, so restart
and replay preserve the prompt prefix while model writes cannot change the private
payload. The model always sees full byte length, digest identity, summary, and the fact
that inline text is incomplete. Tool calls and results are sized and sealed as one
unit. Image lists follow their existing count/byte bounds and stable payload references.

### Compaction and context epochs

Automatic compaction runs when preflight planning cannot retain the configured recent
tail with the model's reserved output budget. It selects the oldest eligible sequence
of complete Turns or complete current-Turn tool units, never a partial tool pair. A
deterministic bounded transcript projection produces a lossy summary plus exact covered
and preserved cursors. It also derives and persists `restoredStateRef` from the effective
catalogs, active Skill versions, view baseline, Thread-state extension context, and
still-active file/Node observations at that exact boundary. Child follow-ups are
canonical user input in the child Thread: automatic compaction preserves the active
admission and manual idle compaction summarizes completed follow-up Turns.
`compactionInstructions` is reserved for explicit manual `/compact` guidance. Summary
and restore blocks receive fixed provider-neutral fingerprints. Only a successful append
changes later projection, and that one explicit cache-branch change is never rebuilt
from current files or runtime trackers.

If the provider reports context overflow despite preflight, the runtime reduces the
target, records a `providerOverflow` compaction, and retries the provider request once.
Normal transient retry counters do not consume or hide this retry. A second overflow
fails explicitly, preventing retry/compaction loops.

`/compact [instructions]` is a reserved host command handled before Skill routing. It
is accepted only while the Thread has no active Turn and creates a completed
feature-triggered Turn (`feature: 'context.compact'`) containing the manual compaction
Item. Instructions remain typed application guidance after the deterministic summary
and do not change source coverage. With no eligible content it returns a no-op result
and creates no phantom boundary.

`/clear` is also a reserved host command and requires an idle Thread. It creates a
completed feature-triggered Turn (`feature: 'context.clear'`) containing
`contextReset`; the renderer shows `Context cleared.` as a boundary. Earlier history
remains visible, pageable, searchable, exportable, and eligible for explicit
Memory/past-history tools, but the default planner starts after the latest reset. A
consecutive clear with no intervening model-visible content is a no-op.

Reset affects only implicit model context: active Skill guidance, view-diff baseline,
tool-output budget state, prior compaction, and inherited context all end at the
boundary. It does not delete history, document state, Memory, Thread configuration,
Goals, Automations, child Threads, or external effects. Editing, naming, pagination,
rollback, Goal continuation, and Thread-terminal logic must explicitly distinguish
these feature Turns from user Turns.

### Subagent inherited context

Keep `Continue in new chat` as the existing canonical history fork. Replace only the
collaboration `fork_turns` text flattener.

At child admission, select effective parent context after the latest reset:

- `none`: inherit no parent model history;
- a positive integer: select the last N eligible conversational Turns; and
- `all`: select the complete current epoch.

If spawn occurs inside an active parent Turn, its immutable completed prefix through
the content immediately preceding the spawn call counts as the newest Turn. The
snapshot excludes the in-progress spawn call itself, incomplete tool units, transient
Plan state, and retry notifications. This preserves the current user request without
creating a dangling provider tool result.

Encode the selection as provider-neutral structured history: user parts, attachments,
images, context evidence, assistant text, reasoning summaries, complete tool pairs,
resource references, and compaction/reset semantics. Store it as one
`inheritedContext` payload in the child before the child's task `userMessage`.
Inherited history is model context but not duplicated as visible child transcript rows.
Child Turn Diagnostics expose the parent Thread ID, exact source cursor, selected Turn count,
and payload hash.

Copy every referenced managed payload into the child's ownership using the existing
copy-on-write path before acceptance. Content-addressed references remain byte-stable;
only local Turn/Item cursors are rewritten. Character-tail truncation is forbidden. The
normal budget planner may compact the structured inherited segment, but must retain
pairing, resource identity, and the source cursor. Parent deletion or corruption after
child admission cannot invalidate the child.

### Provider controls and Role discovery

Resolve the ordinary Turn's provider runtime settings once at execution start and apply
them to every main, compaction, and retry request as appropriate:

- request timeout;
- maximum transient retries and retry delay/backoff;
- configured cache retention, including the existing custom-endpoint exception;
- model context/output limits; and
- normalized reasoning options.

Transient retry notifications remain ephemeral. Context overflow is classified before
generic retry and enters the bounded compaction path. Auxiliary naming keeps its own
small no-cache contract.

When collaboration spawn is available, `roleCatalog` uses the same baseline/delta
journal as Skills for built-in and effective project/user Roles. An unchanged catalog
adds no tokens; a Role created during an old conversation is appended at the next
admission without changing prior history. The `spawn_agent` tool still validates Role
identity and capability ceilings; the catalog only makes accepted values discoverable.

### Turn Diagnostics

Replace the partial post-rewrite diagnostics view with one complete Turn-scoped audit
surface. `PiTurnExecutor` records two authoritative request boundaries rather than asking
the renderer to reconstruct either one. The pre-adapter boundary records the actual
provider `Context` passed to the stream: exact system instructions, canonical-sorted tool
definitions, and the ordered message/content-part window after projection, budgeting,
and compaction. The post-adapter boundary records the final provider payload after local
compatibility, reasoning-summary, and cache-breakpoint policies. It also records the
effective configuration, layered stable prompt and fingerprints, resolved provider
settings, context epoch, cache affinity, planned budget, request fingerprint,
cache-breakpoint paths, HTTP status and request identity, normalized assistant response,
usage, and stop/error facts. Transport diagnostics retain only an allowlisted provider
request ID rather than arbitrary response headers.

Repeated prepared messages form one content-fingerprint pool shared by all Provider
Calls in the Turn. The complete image-sanitized post-adapter request remains
reconstructable: its top-level field insertion order is retained as a payload
serialization fact, never presented as model context order, while repetition-heavy
system, instruction, tool, prompt, and message fields reference an ordered
content-addressed fragment pool. Binary and image bytes become typed omission markers.
This preserves every request value and array/content-part position while keeping
repeated stable prefixes bounded. Diagnostics remain observational and leave outbound
bytes and cache topology untouched.

Terminal diagnostics are a versioned content-addressed Thread payload referenced from
`Turn.execution`, copied on fork, and pruned on rollback/startup/failure when no
reachable Turn references them. Publication is best-effort and never changes the real
Turn status, response, or usage when payload validation, quota, or storage fails. One
`thread/turn/details/read` call is the read
authority and fails closed on missing, corrupt, or mismatched bytes. Turn Diagnostics
renders a user-facing Model Interactions surface: Summary, an ordered Interaction Timeline,
and one collapsed Internal diagnostics disclosure. The main timeline contains Model Calls and
the tool-execution, request/stream-retry, and automatic-preflight/provider-overflow-compaction
activities that bridge them. Accepted initial/steering input is retained as Internal
diagnostics rather than presented as provider interaction. A Model Call alone owns Request
and Response; tool batches remain sibling activities linked to their source and consuming
Calls. Request renders the content-bearing fields from the final post-adapter Provider Request
first. Inline provider parameters remain available in the Model Call information surface and
Request metadata rather than interrupting the content flow; raw JSON and copied diagnostics
retain every field. Object-key order is never numbered or used to imply model precedence. The
pre-adapter context remains available through a secondary disclosure in semantic order
(`system instructions -> tool definitions -> messages`) and is explicitly labeled as Tenon's
adapter input. There is no separate context construction account. Timeline hierarchy uses
indentation and horizontal separators without a vertical guide-line axis. Each Model Call
header keeps ordinal and status visible, exposes its model/provider/timing/usage/cost facts
through a hover/focus control, and copies the
typed request-diagnostics export, including Model Context, ordered image-sanitized Provider
Payload, runtime selection, and Request Facts, by materializing the fragment pool only when
requested. Canonical Items, prompt source blocks, configuration, and provenance mount only
after opening Internal diagnostics. Context payloads remain exact-tuple lazy reads. It does
not restore the retired event ledger,
run/round vocabulary, renderer-side history scans, inferred epochs, or compatibility
readers.

### Failure semantics

The following are explicit, user-visible failures or evidence states:

| Condition | Result |
| --- | --- |
| Context payload hash/length mismatch | Fail projection; never substitute current bytes |
| Mandatory admission payload cannot publish | Reject input before provider work |
| Referenced Node/asset missing or corrupt | Persist typed unavailable evidence and continue |
| Required prompt/current input cannot fit | Fail Turn with model-capacity guidance |
| Compaction summary request fails | Keep canonical history; use a safe projection if possible, otherwise fail |
| Provider overflows after one compact retry | Fail without another retry loop |
| Inline Skill declares execution overrides or embedded shell | Fail Skill validation |
| Inherited payload copy fails | Fail child admission and clean staged child payloads |
| Renderer listener or extension observer fails after persistence | Log delivery failure; keep the canonical admission committed |
| Post-commit status bookkeeping or steering delivery fails | Keep the admission accepted; fail the active Turn |
| Renderer attempts application authority | Reject at codec/IPC boundary |
| User text contains reminder tags | Preserve as ordinary untrusted user text |

### Delivery units

#### PR 1: canonical context contract

Introduce `contextEvidence`, `contextReset`, `acceptedAt`,
`toolOutputProjection`, the complete `contextCompaction`/restore shape, payload
references/codecs, stable cursors, rollout/pagination/fork handling, and exhaustive
renderer-hidden handling. Include payload ownership, validation, reconciliation, and
copy tests. The restore shape includes explicit active-observation dependencies so the
later compaction consumer does not need to revive restored-file reminder text. This is
the isolated shared-interface-first PR; no consumer invents a private interim shape.

Primary files:

- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- `src/main/agent/persistence/ToolPayloadStore.ts`
- `src/main/agent/persistence/RolloutStore.ts`
- canonical Item/rollout/store tests

#### PR 2: unified composer, input/resource integrity, and Skill execution integrity

Add the stable prompt composer, canonical history projector, evidence admission,
initial/steering parity, environment, bounded user view, additional context, attachment
projection, Node resource snapshots, Neva/root and child Role prompt composition, and
context audit details. Persist Skill catalog and invocation evidence, remove reminder
parsing and the private steering queue, implement baseline/delta announcements for new
Skills in existing conversations, restore inline guidance from canonical Items, make
inline execution instruction-only, retain isolated capability ceilings, and publish each
admission's evidence plus user input as one atomic rollout event. Skill bundle
support files remain live resources whose tool observations become canonical history.
Delete every alternate message builder in the paths it replaces.

Primary files:

- `src/main/agent/ThreadService.ts`
- `src/main/agent/runtime/PiTurnExecutor.ts`
- `src/main/agent/context/TurnDiagnostics.ts`
- `src/main/agent/runtime/ToolRuntime.ts`
- `src/main/agent/runtime/types.ts`
- new `src/main/agent/context/` composer, evidence, planner, and serializer modules
- `src/main/agent/capabilities/agentReferencedAssets.ts`
- `src/main/agent/capabilities/agentSkills.ts`
- `src/main/agent/AgentConfigurationLoader.ts`
- `src/main/main.ts`
- `src/renderer/ui/App.tsx`
- restored bounded renderer `userViewContext.ts`
- Thread store/view/details/composer tests

This PR must be sequenced with the active `agent-skills-authoring` plan if that plan
starts changing the same loader or spec. Authoring behavior is otherwise orthogonal.

#### PR 3: complete context runtime

Ship every remaining context-integrity consumer as one complete feature. Implement
token planning on every provider request, frozen full-output observations,
preflight/reactive/manual compaction, one overflow retry, epoch selection, `/compact`,
`/clear`, feature-triggered Turns, and transcript boundary rows. Replace the
collaboration `fork_turns` character flattener with structured snapshots, exact source
boundaries, child-owned payload copies, planner integration, and Details provenance.
Apply ordinary Turn runtime settings, separate context overflow from transient retries,
restore provider cache retention and deterministic epoch affinity, add Anthropic
L0/per-execution breakpoints, publish the versioned Role catalog tail, expose
common-prefix/cache usage diagnostics, and lock request shapes with provider contract
tests. Remove the remaining fixed character-tail and runtime-only context state that
these canonical consumers replace.

The implementation order inside this PR is foundation before consumers, but no stage
is an independently mergeable delivery:

1. global budget planner, frozen tool-output projections, active-observation reducer;
2. compaction/reset engine, reserved commands, context epochs, and boundary UI;
3. structured Subagent inheritance, child ownership, provenance, and Role discovery;
4. provider runtime policy, overflow handling, cache adapters, affinity, and diagnostics;
5. cross-feature restart, rollback, fork, deletion, cache-prefix, and E2E verification.

Primary files:

- context budget/compaction/reducer modules
- `src/main/agent/ThreadService.ts`
- `src/main/agent/runtime/PiTurnExecutor.ts`
- `src/main/agent/runtime/ToolRuntime.ts`
- `src/main/agent/capabilities/agentSettings.ts`
- `src/main/agent/AgentConfigurationLoader.ts`
- `src/main/agent/persistence/ToolPayloadStore.ts`
- collaboration capability/runtime modules
- context payload copy/projector/provider-adapter modules
- `src/renderer/agent/store/threadStore.ts`
- `src/renderer/agent/components/ThreadDock.tsx`
- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/components/ThreadComposerEditor.tsx`
- `src/renderer/agent/components/ThreadTurnDetailsPanel.tsx`
- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- budget/property, Subagent protocol/runtime/persistence, provider payload, boundary,
  and E2E tests

Every behavior PR updates the affected current specs in the same change:

- `docs/spec/agent-core.md`
- `docs/spec/agent-model-runtime.md`
- `docs/spec/agent-skills.md`
- `docs/spec/agent-subagent-threads.md`
- `docs/spec/agent-thread-rendering.md`
- `docs/spec/agent-tool-design.md`
- `docs/spec/agent-progress.md` when its integration checklist changes

The current specs already over-claim full-output history replay and structured Skill
compaction restore; those claims must be rewritten to the verified implementation in
PR 3, not left as aspirational text.

### Collision result

No open PR currently claims this file or runtime surface. Two inactive plan surfaces
need coordination if they start first:

- `agent-skills-authoring` can overlap `agentSkills.ts` and `agent-skills.md`; sequence
  its loader/spec changes around PR 3.
- `agent-generative-ui` and `unified-command-surface` may later produce additional
  context; they must emit the typed evidence contract instead of adding another prompt
  path.

`src/core/agent/protocol.ts` is an infrastructure-ownership file, so PR 1 lands and all
later branches rebase before consumer work continues. Dev branches do not edit
`docs/TASKS.md` or `CHANGELOG.md`; main owns the board claim and merge record.

## Open questions

None after ratification. Approval of this plan explicitly ratifies these directional
choices together:

- canonical context evidence rather than restoration of runtime state;
- Neva as the root persona and Tenon as the product name;
- context evidence hidden from ordinary transcript but auditable in Turn Diagnostics/export;
- `/clear` as a visible, non-destructive context epoch boundary;
- `/compact` as non-destructive summary context with exact source cursors;
- inline Skills as instruction-only, with execution overrides restricted to isolation;
- ordinary local attachments retaining their live-path semantics; and
- one bounded provider-overflow compaction retry; and
- append-only provider prefixes, with only recorded compaction/reset allowed to replace
  previously exposed model context.

## Acceptance criteria and verification checklist

- [ ] **AC-01:** Core codec round-trips every evidence payload and rejects unknown keys, kinds,
      authority escalation, invalid cursor ranges, and digest/length mismatches.
- [ ] **AC-02:** Rollout rebuild, rollback, pagination, export, fork, child copy, startup
      reconciliation, and Thread deletion preserve or reclaim every referenced payload.
- [ ] **AC-03:** Golden planner tests prove initial, steering, restart, and post-tool requests are
      equivalent for the same canonical Items.
- [ ] **AC-04:** A literal user `system-reminder` wrapper cannot load a Skill, gain application authority,
      restore state, or disappear from user history.
- [ ] **AC-05:** Stable prompt fingerprints remain identical when only time, view, Thread,
      resource, catalog, or additional context changes.
- [ ] **AC-06:** User-view tests enforce snapshot/diff equivalence, all historical bounds, reset
      baselines, authoritative Node resolution, and headless behavior.
- [ ] **AC-07:** Attachment and Node-resource tests cover local paths, managed payloads, image
      identity plus bytes, missing/corrupt assets, scratch cleanup, replay, and source
      Thread deletion. They reject missing or misplaced prompt snapshots and preserve
      every distinct typed resource dependency even when bytes and filenames match.
- [ ] **AC-08:** Skill tests cover slash and model invocation, exact content hashes, restart,
      compaction, `/clear`, changed files, path conditions, invalid inline overrides,
      and isolated ceilings.
- [ ] **AC-09:** Budget property tests never split a tool pair, exceed the computed budget silently,
      drop current input, or enter an overflow/compaction loop.
- [ ] **AC-10:** Full tool output remains readable from `outputRef` after projection, compaction,
      restart, fork, and child inheritance; compaction restores the latest non-invalidated
      file/Node observation through its frozen projection and complete-output references.
- [ ] **AC-11:** `/compact` and `/clear` preserve visible history, reject active-Turn races, handle
      no-op boundaries, and do not disturb Goals, Memory, configuration, or external
      state.
- [ ] **AC-12:** `fork_turns=none|N|all` preserves structured content, current active prefix,
      exact boundaries, tool pairs, images, attachments, reasoning summaries, and
      child-owned resources without character truncation. Deleting the source leaves a
      nested inherited tool image readable from the child without changing the context
      payload digest.
- [ ] **AC-13:** Provider tests cover timeout, retry/backoff, cache retention, overflow
      classification, Anthropic breakpoint count/order, non-Anthropic cleanliness, and
      bounded Role discovery. Session affinity remains stable for one Thread/epoch, and
      logically identical tool registries serialize to identical ordered bytes.
- [ ] **AC-14:** Renderer tests and light/dark E2E verification cover context/reset/compaction
      Details, boundary rows, composer commands, keyboard focus, and transcript history.
- [ ] **AC-15:** Each PR passes `bun run typecheck`, relevant Core/renderer/E2E suites,
      `bun run docs:check`, and `git diff --check` before it is marked ready.
- [ ] **AC-16:** Consecutive provider-payload golden tests prove that an unchanged Turn,
      a changed user view, steering, and a newly added Skill preserve the complete prior
      request as an exact byte prefix and append only new tail blocks.
- [ ] **AC-17:** Skill cache tests prove baseline-once, unchanged-noop,
      added/changed/removed deltas, same-Turn validated authoring discovery, next-Turn
      external discovery, invocation-after-tool placement, hash supersession,
      compaction checkpoint restore, and `/clear` re-baselining.
- [ ] **AC-18:** Initial and steering admission tests prove evidence plus user input commit
      as one batch, publication failure leaves no Item, binding, or payload residue, and
      post-commit renderer/extension observer failure cannot produce a false rejection.
      Deleting or corrupting the client-id sidecar before restart still deduplicates from
      the canonical user Item and rebuilds the index.
- [ ] **AC-19:** Turn Diagnostics tests prove one authoritative read exposes every ordered
      activity and Model Call Request/Response, including tool batches, retries, compaction,
      and steering; user/file/context reminder content remains in exact request order; and
      Recorded Evidence exposes stable prompt, tool
      schemas, cache facts, prepared messages, and canonical Items. Missing/corrupt or
      mismatched diagnostics fail closed; rollback, fork/source deletion, and startup
      pruning preserve the Thread-ownership contract without a legacy reader.
