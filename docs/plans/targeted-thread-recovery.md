# Targeted Conversation Recovery

## Goal and reader

Let a person recover an unreadable conversation by rebuilding from a verified
source, or remove an explicitly confirmed conversation closure while retaining
original evidence. Healthy work and unrelated data survive the operation.

**Shape:** ONE complete feature in one PR. Eligibility, preview/confirmation,
retention, fenced execution, interrupted-operation reconciliation, and UI
verification land together. This is the targeted recovery feature, with its
complete execution contract here. Status and selected order live in `docs/TASKS.md`.

## Non-goals

- Whole-Agent, whole-Outline, or filesystem-prefix reset; arbitrary-path IPC;
  automatic deletion; migration; historical-format import; relaxed decoders.
- Deleting broken events to make history readable, treating a derived record file
  as an original, or promising that retained evidence can be imported later.
- A second startup coordinator, source resolver, publication cleanup owner,
  process ledger, configuration source, or general repair/backup framework.
- Resetting Memory semantics by deleting its database, discarding Automation
  definitions, or changing independent Project metadata.

## Design

### Decision and constraints

DEC-1: Offer recovery only when existing owners can prove the source or exact
removal closure. An uncertain repair is an unavailable action, never permission
to widen the reset. Preserve bytes before changing active records.

CON-1: Consume the shipped [startup fault isolation](../spec/architecture.md#desktop-host-lifecycle)
issue/action identity and capability readiness. Use the exact-source resolution,
recovered-history provenance, and publication invalidation mechanisms from
[published conversation records](../spec/agent-core.md#published-conversation-records). These are required
predecessor contracts, not implementation details to reconstruct from an archive.

The selected order also consumes
[profile files and direct learning](memory-agent-profile.md#implementation-ownership-and-complete-delivery-units)
before this feature. Bind closure inspection to its final accepted file revisions,
admission, provenance, pending-work and retained-source contracts. A source Thread
becoming unavailable does not itself forget an accepted user-wide preference;
explicit forgetting, correction and rollback retain their distinct invalidation
semantics. Optional views, temporal enhancements and narrower Node Reset are
outside this predecessor boundary.

Coordinate with [scheduled-work redesign](scheduled-work-redesign.md) through
the existing Automation, Turn and Tool Task owners. Whichever feature lands
later must cover the earlier feature's final assignment/run associations,
durable request identities, pending delivery continuations and retained-resource
references. Removal must not strand a continuation or allow a stale request to
become a new execution after its association is removed. This is a shared-owner
handoff, not an unconditional ordering edge; the board selects live collisions.

CON-2: Source resolution and completeness validation are distinct. A retained
value being readable does not prove a complete reconstructable history. A
reconstructed projection remains usable with its recovery provenance, but does
not become an uninterrupted original event trace or recreate missing payloads.

CON-3: Coordinate live writers/processes and retained dependencies through their
owners. Existing completion, cancellation, delivery, Project deletion, and
resource retention truth remain authoritative. Unknown ownership blocks recovery.

The same closure consumes the existing
[question settlement](../spec/agent-core.md#structured-input-lifecycle): fence the
exact pending request/deadline through its owner. The existing
[Task responsibility contract](../spec/agent-tool-design.md) likewise owns
operation receipts and event disposition; retain or invalidate those references
through that owner.
A late timer, answer or process event cannot revive removed execution. Renderer
answer drafts follow their Thread-local lifetime; they are not a new durable
recovery source. [Conversation work folders](conversation-work-folders.md) retain
independent Project metadata and already admitted Task addresses. The board
selects integration order; whichever consumer lands later covers the earlier
feature's final closure without creating another owner.

CON-4: All targets derive from resolved packaged/dev userData. The renderer
supplies an issue/action identity and observed scope revision, not a storage path
or deletion instruction. Retained originals cannot depend on writable diagnostics.

### Overview: ownership and recovery evidence

`ThreadCatalogOps.reconcileThread` normally rebuilds projection from Rollout,
but `RolloutStore.restoreMissing` can reconstruct a missing Rollout from surviving
projection. The projection therefore cannot be discarded just because it is
derived. Existing quarantine may keep metadata and healthy conversations usable
without providing a readable history for the failed Thread.

| Owner | Recovery obligation |
| --- | --- |
| `ThreadMetadataStore` / Thread catalog | Enumerate trustworthy identities and lineage without decoding broken history. Preserve Project catalog/membership data sharing this database and unrelated Threads. Catalog structure failure can make targeted action unavailable. |
| `RolloutStore`, `ThreadHistoryProjectionStore`, `ToolPayloadStore` | Retain original events, projection, payloads and dependency identity before replacement/removal. Validate a complete retained source before rebuild; never heal original evidence from leftover publication files. |
| `GoalStore`, `ToolTaskStore`, `DelegationSessionStore` | Goals/tasks share `goals.sqlite`. Reconcile process, lease, continuation, cancellation and delivery ownership; include actual blocking work in the preview. Compact execution truth is not a cache. |
| `AutomationStore` | Preserve definitions and occurrence/claim/run evidence outside the proven scope. Fence affected dispatch/continuity through the existing owner rather than guessing from Thread files. |
| `MemoryControlStore`, `TimelineMemoryStore` | Include affected admission, extraction, publication, rollback and reset control in the closure. Preserve generated Outline Memory Nodes and unrelated control state; respect cross-store recovery. |
| Profile file and learning owner | Preserve accepted `USER.md`, explicit identity/style, attributable revisions and source provenance. Reconcile affected learning/publication jobs and source availability through the owner without treating conversation removal as profile Reset. |
| `AgentResourceStore`, ContentStore, Outline assets | Preserve required bytes and anchors before unlinking. Keep shared attachments and every independently retained reference. Incomplete ownership evidence must not enable garbage collection. |
| Configuration, credentials, Skills, Outline | Preserve these categories; neither `agent/` nor `content/` defines a removable domain. Outline reset has no recovery action here. |
| Unified record publisher | Fence, invalidate/drain, and remove affected derived entries through its existing lifecycle owner; rebuild only from retained originals. Publishing/navigation do not adopt historical originals into another Thread. |

### Requirements

- **FR-5:** For a history/projection issue, offer rebuild only after validating
  a complete retained canonical source. Stage and verify replacement with normal
  readers before swapping under the owner lock. If rebuild is unavailable, permit
  removal only when catalog/lineage, execution, Automation, Memory, and resource
  owners can enumerate the exact closure without decoding broken history.
  Enumeration failure never expands the action to a whole domain.
- **FR-6:** Preview conversation scope, affected descendants, resource effects,
  preserved categories, blocking work, and retained-original destination. Bind
  native confirmation to that observation and revalidate immediately before
  mutation. Changed scope or new work requires a refreshed preview. Retain and
  verify original owner data and dependency bytes/anchors before removing active
  records. Healthy Threads, independent completed forks, configuration, Outline
  Memory Nodes and shared attachments survive unless explicitly in the proven
  scope. Retained bytes preserve evidence, not an old-format import promise.
- **FR-7:** Rebuild/removal uses a durable idempotent operation fence. Coordinate
  writers and processes before copying/swapping; an open SQLite main file alone
  is not a backup of its WAL-backed state. Reconcile interruption before admission
  or garbage collection and never expand scope. Backup failure preserves active
  data. Unknown ownership blocks the operation. Duplicate confirmation cannot
  create another operation or repeat side effects.

### User flow and failure states

FLOW-1: From an unavailable conversation's existing issue detail, the person
requests recovery. Owner scope/source inspection is pending, then exposes a
verified rebuild, eligible removal preview, or a specific unavailable reason.
Healthy work retains startup's capability boundaries during inspection.

FLOW-2: The preview shows affected conversations, descendants, blockers,
preserved categories, resource consequences and retained-original destination.
Cancel changes nothing. Native confirmation applies to the exact observed scope;
stale scope or newly active work returns to inspection/preview rather than
silently confirming a different operation.

FLOW-3: Confirmed recovery reports progress through its one durable operation.
Retention/staging failure leaves active data intact. After mutations begin,
partial failure reports the pending operation and retained evidence. Restart
resumes that same operation before admitting work or collecting dependencies.

FLOW-4: Only verified completion reveals retained originals and re-enters the
owning readiness path. Removal never reports a successful empty list while
reconciliation is pending. Rebuild publishes reconstructed-source provenance
and exact missing-payload states, not fabricated original-event coverage.

### Implementation ownership and handoff

Primary scope is `ThreadCatalogOps`, `ThreadService`, `ThreadCore`, Rollout/history
and catalog stores, Goal/Tool Task/delegation/Automation/Memory/resource owners,
and a narrow Host recovery coordinator consuming existing lifecycle entry points.
The coordinator binds one confirmed operation across owners; it does not own a
new interpretation of sources, task results, startup availability, or publication.
Issue preview/progress UI, preload requests, localized copy, and restart/retention
fixtures belong to this same complete feature.

Consume unified record source coordinates, availability and recovery provenance.
Keep validation at write/decode/admission boundaries; an inspection failure
reports unavailable scope rather than killing healthy user work. Apply the
publisher's fence to queued writes before removal so a late write cannot recreate
deleted history. Rebuild invalidates only affected publication generations.

Recovery consumes the final generic Tool Task, process-isolation, context and
artifact contracts. Native Git and verification workflows use ordinary commands;
there are no private check/attempt or Git-review manifest owners to recover.
Fixtures cover retained/expired outputs, current process settlement, referenced
artifacts and interrupted native-command outcomes without replaying mutations.
Readable records follow the reader's Item retention even when the original source
Thread is in the confirmed recovery scope.

Fold the final behavior into architecture, Agent Core, Thread rendering and error
observability specs, plus the affected domain lifecycle specs. Keep the existing
pre-release manual reset gate separate. At claim time use the predecessors'
merged contracts and recheck actual Thread/runtime/Host overlaps on the board.

### Acceptance criteria and verification

- **AC-5:** If a projection is the only surviving readable history, rebuild
  shall not discard it. Replacement shall preserve the original until normal
  startup readers verify the staged result. Recovered history carries its source
  provenance and cannot claim unavailable original event order or payloads.
- **AC-6:** Cancellation, stale preview, blocking work, unknown ownership or
  retention failure shall preserve active data. Successful removal shall affect
  only the confirmed closure and retain unrelated configuration, Projects,
  conversations, Memory Nodes and shared files. Restart at every mutation boundary
  shall resume the same operation without widening it or duplicating effects.
- **AC-7:** Packaged/dev recovery shall stay within its resolved root, use the
  existing issue surface with keyboard/light/dark/accessibility support, and
  reopen capability admission only after verified owner readiness. The renderer
  cannot choose an arbitrary backup or deletion target.
- **AC-8:** When recovery invalidates or removes a Thread, delayed publication
  shall not resurrect its tree. A separately retained reader's image/PDF
  observation shall replay after source removal and restart, while the source
  resource and derived copies follow their own cleanup rules.

Use temporary production stores/readers. Preserve the existing `restores a
missing rollout from projection and keeps future ordinals contiguous` fixture.
Add incomplete-source, catalog failure, independent-fork, shared-Project/resource,
Memory/Automation dependency, live/ambiguous-process, WAL snapshot, disk-full,
stale-confirmation and duplicate-submit cases. Crash after each retained-copy,
staging, swap, domain-removal and publication-cleanup boundary; reopen production
owners to verify no loss of protected data or duplicate admission/collection.

Include accepted profile entries whose source Thread is removed, a pending
profile update during recovery, and an explicitly invalidated or forgotten
source. Verify that ordinary source removal preserves accepted independent
profile content with unavailable evidence, while invalidated work cannot replay
through an old file snapshot. Interrupted recovery must settle through the final
profile owner without duplicate writes or a new learning/admission authority.

Run typecheck, relevant Core/renderer suites, focused Electron recovery smoke,
docs/diff checks, and light/dark/accessibility verification. No fixture reads or
deletes real userData. Stored source coordinates and real reopening, not UI copy
alone, prove completion.

## Open questions

None inside the selected recovery scope. Whole-domain resets, historical-format
support, and backup/import need separate product contracts. When source or closure
validation cannot establish safety, the specified result is an unavailable action.

## Implementation checklist

- [ ] Bind source/closure inspection to existing issues and original owners (FR-5, CON-1, CON-2; AC-5, AC-6).
- [ ] Complete preview, native confirmation and revalidation (FR-6; AC-6, AC-7).
- [ ] Retain originals and execute one restartable owner-fenced operation (FR-7; AC-5, AC-6).
- [ ] Integrate publication invalidation, verified readiness and reader retention (CON-3, CON-4; AC-7, AC-8).
- [ ] Fold specs and pass source/closure, crash-boundary and complete UI fixtures (AC-5 through AC-8).
