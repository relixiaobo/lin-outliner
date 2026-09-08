# Recoverable Startup And Scoped Availability

## Goal and reader

Let a person open packaged Tenon or an isolated dev build, understand unreadable
data, and continue using healthy capabilities without first deleting data.

**Shape:** ONE complete feature in one PR. Constructor-failure capture, scoped
readiness, usable issue actions, producer fencing, and UI verification land
together. This is the startup feature from the recovery design, with its complete
execution contract here. Status and selected merge order live in `docs/TASKS.md`.

## Non-goals

- User-triggered conversation rebuild/removal, whole-domain reset, migration,
  relaxed canonical decoders, or editing broken events out of history.
- A generic repair registry, arbitrary-path reset IPC, backup/import product,
  replacement startup coordinator, or second configuration source.
- A recovery promise for a broken executable or pre-window security/transport.
- Calling every decode failure corruption or version incompatibility.

## Design

### Decision and constraints

DEC-1: Put a recovery-capable shell around the existing Host owners. Move their
fallible data opening behind the visible-window lifecycle, and report availability
per capability independently from issue severity. Preserve canonical validation.

CON-1: Keep Electron security, single-instance locking, resolved packaged/dev
userData, document durability arbitration, and the existing readiness DAG. Error
display and Copy details cannot require Agent, Outline, or writable diagnostics.

CON-2: A domain is its owner and dependency closure, not a directory prefix.
`agent/` includes public configuration and independent stores; `content/` is
shared. Unknown process or delivery ownership cannot authorize new execution.

CON-3: Retry cleans up partial construction and retries unfinished ownership
boundaries while retaining healthy services and task settlement evidence. Drain
started branches before reusing them. A successful UI action must reflect real
owner readiness; a cosmetic Retry cannot replay work or duplicate services.

CON-4: The renderer requests an owner-resolved issue/action identity, never a
storage path or deletion instruction. Native source inspection uses the existing
configuration/domain destination. Keep failure details bounded and scrubbed.

CON-5: Existing bounded cache rebuild and missing-Rollout reconciliation remain
owned where they are. This feature adds no new user-triggered destructive action
or recovery-source interpretation. It preserves the only surviving projection.
The release gate's explicit pre-release resets remain separate operations.

### Overview: ownership and evidence

The baseline opens Agent stores during `createDesktopHost` / `createAgentHost`,
before `DesktopHostLifecycle` can show a failure. `MemoryControlStore` can throw
from its constructor. A later Agent failure also makes `App` replace a healthy
Outline with its startup shell. `StartupState` cannot express partial availability.

| Owner / data | Constraint on startup failure handling |
| --- | --- |
| `OutlineRuntimeWorkspace.open`, `WorkspaceTransactionLog` | Snapshot/checksum/log validation gates document readiness. Separate confirmed version mismatch from structural failure at `assertSnapshotEnvelope`; preserve authoritative workspace bytes. |
| `ContentStore`, `OutlineAssetStore`, `AgentResourceStore` | Shared-store failure can block both domains. An individually unavailable revision keeps its existing scope; never turn it into a shared-store reset. |
| `ThreadMetadataStore`, `ThreadService.initialize` | Catalog-page decoding can fail before the per-Thread loop. Isolate an entity only with trustworthy identity/lineage; unreadable catalog structure is a broader Agent failure. Preserve Project data in the same database. |
| `RolloutStore`, `ThreadHistoryProjectionStore`, `ToolPayloadStore` | Per-Thread history quarantine preserves bytes and permits healthy work. Distinguish the failed Thread from affected descendants. A projection can be the sole surviving history source for `restoreMissing`. |
| `GoalStore`, `ToolTaskStore`, `DelegationSessionStore` | Goals and tasks share `goals.sqlite`. Leases, deliveries, and process/restart state are control authority, not caches. Preserve settlement and cancellation truth. |
| `AutomationStore` | Definitions and occurrence/claim/cursor/run state share one owner. Failure fences dispatch; it does not remove schedules. |
| `MemoryControlStore`, `TimelineMemoryStore` | SQLite owns admission and extraction/publication/rollback/reset control; generated Memory lives in Outline. Unavailable admission control blocks dependent Agent work. Deleting SQLite is not semantic Memory Reset. |
| File preferences, root configuration, credentials, Skills | Preserve rejected source bytes, validated recovery/defaults, credentials, unsupported Skill formats, and conservative access/opt-out behavior. Use each source/status or lifecycle owner. |
| Translation caches, `NodeAccessStore`, file grants, diagnostics | Cache/ranking data and authorization state have different owners. Environmental read failure is not malformed cache evidence. Unreadable grants deny access; diagnostics failure cannot hide the original issue. |

`createAgentHostLifecycle` initializes Threads/delegation before Memory workers
and Automations; `beforeInitialTurnAdmission` also prepares Memory. Catching an
exception and declaring Agent ready would bypass those obligations. Resource
initialization already pauses reclamation when unreadable Threads make its
reference snapshot incomplete; preserve that rule.

### Requirements

- **FR-1:** Catch fallible user-data opening, including constructors, behind
  the visible-window lifecycle. Clean up partial owners without closing healthy
  shared services. Keep a working failure surface when diagnostics cannot write.
- **FR-2:** Separate issues from capability readiness. Single-Thread quarantine
  leaves healthy conversations and documents usable. Agent-domain failure leaves
  a ready Outline editable but blocks new Turns, Goals, delegation, schedules,
  and dependent Memory operations. Shared Outline/ContentStore failure keeps the
  workspace surface blocked. Quiesce dependent producers through their owners.
- **FR-3:** Owners report domain/entity, operation, observed category, confirmed
  format version when known, impact, and eligible actions. Distinguish explicit
  format mismatch, invalid bytes, dependency failure, permissions/space, lock
  contention, and unknown failures. Never infer destructive eligibility from
  exception-message text.
- **FR-4:** Offer working Retry, Continue using healthy features, Copy details,
  identified configuration-source inspection, and Quit actions. Keep unavailable
  domains/conversations marked and their issue details discoverable after
  dismissal. Tighten translation-cache load catches: only recognized corruption
  may invoke existing bounded rebuild; environmental/unknown failure preserves
  saved entries. Existing explicit Clear semantics stay unchanged.

### User flow and failure states

FLOW-1: Launch paints the shell before fallible data opening. Owners then report
readiness and issues. A workspace failure stays on the recovery surface; a healthy
Outline plus Agent failure opens the document with an unavailable Agent pane;
Thread quarantine creates a scoped notice and unavailable conversation entry.

FLOW-2: Issue detail states the unavailable capability and known cause. The person
continues with healthy work, inspects an eligible configuration source, copies
details, retries, or quits. Retry has one in-flight owner and settles as ready or
an updated issue. A dismissed notice does not erase the unavailable state.

FLOW-3: Quit uses existing document durability arbitration even after partial
startup. Cancellation or a reversible quit failure retains truthful availability
and allows another attempt without duplicating producers or losing saves.

Use copy such as “Conversations are unavailable. Your notes are ready to use.”
Claim version incompatibility only when established; otherwise report that the
conversation could not be read. Domain loading, waiting, and recovery retain their
existing semantics rather than impersonating active command progress.

### Implementation ownership and handoff

Primary scope is `main.ts`, `desktopHost.ts`, `desktopHostLifecycle.ts`,
`hostDomain/agentHost.ts`, `hostDomain/compositionLifecycle.ts`, store construction
and cleanup, `src/core/startup.ts`, preload/readiness API types, `App`, startup and
Agent issue surfaces, configuration-source routing, translation-cache error
policy, localized messages/styles, and focused Core/renderer/Electron fixtures.
Audit launcher, background delivery, schedules, Goals, delegation, Settings/domain
operations, and ordinary Turn admission against each availability boundary.

The complete feature leaves two verified mechanisms for consumers: owner-reported
issue/action identity with truthful capability availability, and lifecycle entry
points that retry or fence owners without reopening admission early. Document
their final contract in current specs; do not publish unused recovery APIs.

Use final Project/Thread, Settings/domain-routing and workbench owners. The
board orders this feature after Settings discovery and the approved workbench
series. Audit verification admission, uncertain Git publication settlement, and
interactive-process restart/cancellation against their merged owners when
establishing readiness and Retry. This selected integration order prevents
reworking those boundaries as C/D/E land; displaying a recoverable startup error
does not itself require every workbench capability.

[Unified session records](unified-session-records.md) follows this final startup
mechanism under the selected A7 order. [Targeted conversation recovery](targeted-thread-recovery.md)
consumes the shipped issue/lifecycle contract plus unified record-source and
publication contracts. This feature does not wait for either consumer.

Fold behavior into `architecture.md`, `agent-core.md`,
`agent-thread-rendering.md`, and `error-observability.md` in the implementation PR.
Specs remain current until that change. Use the board/live PR scopes for current
claims; this plan names ownership rather than freezing a list of open PRs.

### Acceptance criteria and verification

- **AC-1:** If Memory, catalog, Goal/Tool Task, resource-reference, delegation,
  or Automation construction fails, the application shall display a usable issue
  without requiring any failed store or diagnostics write.
- **AC-2:** When Agent fails after Outline readiness, notes shall remain editable
  and durably saved. Dependent producers/routes stay unavailable or settled;
  Retry starts no duplicate service/effect and Quit retains save arbitration.
- **AC-3:** When history quarantine succeeds, the UI shall distinguish its failed
  Thread from affected descendants. Catalog enumeration failure instead reports
  the broader unavailable domain while retaining bytes and Project metadata.
- **AC-4:** Version, malformed-data, permission/space, lock, and unknown fixtures
  shall produce truthful categories/actions. Non-content translation-cache read
  failure shall leave saved entries intact.
- **AC-7:** Packaged/dev recovery shall stay within its resolved data root,
  preserve keyboard/light/dark/accessibility behavior, and remain available
  before domain readiness. No claimed success precedes verified owner readiness.

Use temporary stores and production constructors/readers. Preserve tests such as
`keeps a recoverable failure visible and retries only unfinished services once`,
`quarantines authorless persisted history under the strict schema, and starts anyway`,
and `leaves an old index untouched and requires an explicit development-store reset`.
Add real Electron constructor-failure and partial-availability cases, per-owner
failure fixtures, concurrent Retry/Quit, and an entry-route admission matrix.

Run typecheck, relevant Core/renderer tests, focused Electron smoke, docs/diff
checks, and light/dark/accessibility verification. Measure first paint with delayed
or failed data opening; never bypass canonical checks to improve the measurement.

## Open questions

None for this feature. Whole-Agent or Outline reset, historical-format support,
and backup/import remain separate product decisions; no failure falls back to
those operations. Private issue types and owner-construction helpers are local
choices constrained by the availability and lifecycle requirements above.

## Implementation checklist

- [ ] Move construction and cleanup behind the existing window/lifecycle boundary (FR-1, CON-1, CON-3; AC-1, AC-7).
- [ ] Complete owner availability and all entry-route fences (FR-2, FR-3; AC-2, AC-3).
- [ ] Ship issue actions and preserve cache/source failure data (FR-4; AC-4, AC-7).
- [ ] Fold the final contracts into specs and run the complete recovery UI/quit fixtures (AC-1 through AC-4, AC-7).
