# Startup Data Fault Isolation And Recovery

## Goal

Let a person launch packaged Tenon or an isolated dev build without first
manually deleting data: explain unreadable data, preserve usable capabilities,
and offer recovery only at a boundary whose owner can prove its consequences.

**Shape:** A SET of two complete features: **A**, usable startup with scoped
failure reporting; **B**, targeted conversation recovery. A is independently
useful with Retry, source inspection, and healthy-work continuation. B consumes
A's final issue and lifecycle boundaries and adds verified rebuild/removal.
Neither release is an unused protocol scaffold.

## Non-goals

- Automatic whole-userData deletion, migration, or relaxed canonical decoders.
- Calling every decode failure corruption or version incompatibility.
- A generic repair framework, arbitrary-path reset IPC, or backup/import product.
- Editing broken events out of append-only history.
- Resetting every file under `agent/`, or separating shared blobs by directory.
- Recovering a broken Electron executable or pre-window security/transport setup.

## Design

### Overview: code evidence and constraints

The current owners provide several different recovery policies. They must not
be flattened into one Clear data button. These observations define the design
baseline; future behavior appears in the decision and requirements below.

| Data / current owner | Observed behavior | Recovery boundary |
| --- | --- | --- |
| Outline snapshots, transaction log, and recovery data: `OutlineRuntimeWorkspace.open`, `WorkspaceTransactionLog` | Runtime validates snapshots/checksums and replays logs; opening errors reject document readiness. `assertSnapshotEnvelope` combines version and structural failures into one generic message. | Authoritative workspace data. Explain the fault and retry; no single-file deletion or automatic workspace reset. |
| Shared attachment bytes and anchors: `ContentStore`, `OutlineAssetStore`, `AgentResourceStore` | Both Outline and Agent use `content/`. Store-format rejection prevents opening; physical revision corruption has its own quarantine. | Shared foundation, not Agent-private storage. A shared-store failure can block both domains; individual unavailable files keep their existing scope. |
| Conversation catalog: `ThreadMetadataStore`, `ThreadService.initialize` | `list` decodes a whole page. A malformed row throws before the per-Thread history loop; constructor/storage failures can happen earlier. | Entity isolation requires trustworthy identity/lineage. Unreadable catalog structure is an Agent-domain failure, not a guessed single-Thread deletion. |
| Conversation history and payloads: `RolloutStore`, `ThreadHistoryProjectionStore`, `ToolPayloadStore` | Complete-history checks quarantine unreadable Threads for the session and preserve bytes. Metadata-only reads can remain available; descendants may inherit unavailability. | Warn inside a usable app. Distinguish the actual failed Thread from affected descendants. Retry, verified rebuild, or confirmed removal of a proven closure. |
| History projection: `ThreadCatalogOps.reconcileThread` | Usually rebuilt from the rollout, but `restoreMissing` can reconstruct a missing rollout from the surviving projection. | Do not discard it merely because it is derived. Verify an independent complete source before replacing a projection. |
| Goals, Tool Tasks, delegation: `GoalStore`, `ToolTaskStore`, `DelegationSessionStore` | Goals and Tool Tasks share `goals.sqlite`; process claims, deliveries, and restart reconciliation are durable control state. | Not caches. Retain authority over live work; unknown process/delivery ownership prevents reset and automatic execution. |
| Automations: `AutomationStore` | One store contains user definitions plus occurrence, claim, cursor, and run state. Startup is part of Agent readiness. | Removing it loses schedules and execution evidence. Failure must fence dispatch; resetting it is a separately defined product operation. |
| Memory: `MemoryControlStore`, `TimelineMemoryStore` | Generated Memory content lives in Outline; `memories.sqlite` contains admission, modes, extraction/publication/rollback/reset state. Memory participates in initial Turn admission. | Deleting SQLite is not the existing semantic Reset. Preserve Outline content and the domain's cross-store recovery rules; unavailable admission control keeps dependent Agent work unavailable. |
| Settings, root configuration, credentials, Skills | `loadFilePreferences` preserves rejected source bytes and uses a validated last-good source/defaults. `AgentConfigurationLoader` exposes rejected sources. Managed Skill initialization retains unsupported formats; it has separate malformed-index/opt-out quarantine. | Route to the owning source/status or lifecycle action. `agent/config.json` is desired configuration, not disposable conversation state. Preserve credentials and conservative access/opt-out behavior. |
| Translation caches, ranking, grants, diagnostics | Translation cache load paths can discard a manifest/shard on any non-ENOENT failure. `NodeAccessStore` falls back to empty ranking on decode failure; startup load errors are reported. Unreadable file grants deny access. | Derived translations/ranking and authorization records need different policies. Environmental read errors are not evidence of malformed cache bytes; recovery must not grant access or erase user content. |

### Startup boundaries that need to change

1. **The recovery window is not independent of data opening.** `main.ts` calls
   `createDesktopHost` before `app.whenReady`. That factory calls
   `createAgentHost`, which synchronously opens Memory, Thread, Goal/Tool Task,
   resource-reference, delegation, and Automation databases before creating
   `DesktopHostLifecycle`. For example, `MemoryControlStore` can throw from its
   constructor on an invalid database. This never reaches `StartupFailure`.
2. **Readiness has an unnecessarily broad visual effect.** The lifecycle lets
   Outline become ready before Agent, but `App` substitutes its startup shell
   whenever `startup.failure` is set. A later Agent error therefore hides a
   healthy document. `StartupState` contains only starting/ready/failed plus a
   step/message; it cannot describe partial availability or several issues.
3. **Thread quarantine has a narrower contract than all Thread data.** It
   handles recorded-history unreadability after catalog enumeration, not an
   arbitrary malformed catalog row or shared Tool Task record. The catalog
   failure must not be labelled as a successfully isolated conversation.
4. **Agent readiness includes control dependencies.**
   `createAgentHostLifecycle` groups Threads/delegation, then Memory workers and
   Automations. `beforeInitialTurnAdmission` calls Memory preparation. Merely
   catching an error and declaring Agent ready would bypass these obligations.
5. **Domain paths overlap.** `agent/` contains public configuration and several
   independent stores; `content/` is shared. A reset scope is a dependency closure,
   not a filesystem prefix. Resource initialization already pauses reclamation
   when unreadable Threads make the reference snapshot incomplete.

### Decision and requirements

The selected target is a small recovery-capable application shell over the
existing Host owners. It has explicit domain availability and owner-reported
issues, followed by one bounded conversation recovery capability. A universal
module reset is deferred because the current storage boundaries do not support
that promise.

- **FR-1:** Move fallible user-data opening behind the visible-window lifecycle,
  including constructor failures, with cleanup of partially opened owners.
  Keep one startup coordinator and the existing Electron security setup. Error
  display and Copy details work without Agent, Outline, or writable diagnostics.
- **FR-2:** Separate issue severity from capability readiness. A single history
  quarantine keeps healthy conversations/document work available. An Agent-domain
  failure leaves a ready Outline usable, but blocks new Turns, Goals, delegation,
  scheduled dispatch, and dependent Memory operations until their real admission
  owners are recovered. Shared Outline/ContentStore failures retain a blocking
  workspace surface. Quiesce already-started dependent producers through their
  owners; never leave them running invisibly or replay them on a cosmetic Retry.
- **FR-3:** Owners report bounded facts: affected domain/entity, operation,
  confirmed format version when available, observed category, impact, and action
  eligibility. Categories distinguish explicit format mismatch, invalid bytes,
  unavailable dependencies, permissions/space, lock contention, and unknown
  failures. Separate version checks from structure checks at affected decode
  boundaries; do not infer destructive eligibility from exception message text.
- **FR-4:** Offer only actions with working owners: Retry, Continue using healthy
  features, Copy details, open an identified configuration source, and Quit.
  Persistently mark unavailable conversations/domains and retain a discoverable
  issue detail after dismissal. A claimed success must reflect real readiness.
  Recognized cache corruption may use its existing bounded rebuild policy;
  permission, space, lock, and unknown errors never authorize deletion. Tighten
  the translation-cache load catches accordingly without changing explicit Clear.
- **FR-5:** For a history/projection issue, offer rebuild only after validating a
  complete retained canonical source. Stage and verify the replacement before
  swapping it under the owner lock. Otherwise permit removal only when catalog,
  lineage, tasks, delegation, Memory, and resource owners can enumerate the exact
  affected closure without decoding the broken history. Neither option widens
  to a whole-domain reset because enumeration failed.
- **FR-6:** Removal preview lists the conversation scope, descendants and resource
  consequences, preserved data categories, blocking work, and retained-original
  destination. Native confirmation is tied to that exact observation; changed
  scope or new work requires a refreshed preview. Retain and verify original
  owner data and dependency bytes/anchors before removing active records.
  Healthy Threads, independent completed forks, configuration, Outline Memory
  Nodes, and shared attachments survive unless explicitly in the proven scope.
  Retained bytes preserve evidence; they do not promise old-format import.
- **FR-7:** Rebuild/removal runs under a durable, idempotent operation fence.
  Coordinate live writers/processes before copying or swapping; do not copy an
  open SQLite main file without its WAL/snapshot owner. Interrupted operations
  reconcile before admission or garbage collection and never expand scope.
  Backup failure preserves active data. Unknown ownership blocks the operation.
  All targets derive from the resolved packaged/dev userData authority; the
  renderer sends an issue/action identity, never a path or deletion instruction.

### User flow and failure states

Launch paints the shell, then domain owners open and report readiness/issues.
A workspace failure stays on the recovery page. A healthy workspace plus an
Agent failure enters the document with an unavailable Agent pane. A quarantined
Thread produces a scoped notice and unavailable conversation entry.

Issue detail states what is unavailable and whether the cause is known. The
person continues where safe, retries, inspects a source, copies details, quits,
or opens an eligible recovery preview. Scope discovery has a pending state;
unsupported recovery explains why it is unavailable. Cancel changes nothing.

Confirmed recovery shows progress and rejects duplicate submission. Completion
reveals retained originals and re-enters the owning readiness path. Partial
failure describes the retained operation and resumes it on restart; it never
shows a successful empty conversation list before recovery has settled.

Example localized copy:

> Conversations are unavailable. Your notes are ready to use.

> This version cannot read one conversation. It has been isolated; other
> conversations remain available.

Use the second message only when format incompatibility is actually established;
otherwise say that the conversation could not be read.

### Delivery, files, risks, and collision result

| Feature | Complete user outcome | Scope and acceptance |
| --- | --- | --- |
| A. Recoverable startup and scoped availability | Data-open failures reach the application; healthy Outline work survives Agent failure; quarantine and configuration issues are visible with usable non-destructive actions. | FR-1 through FR-4 and relevant FR-7 boundaries. `main.ts`, `desktopHost.ts`, `desktopHostLifecycle.ts`, domain construction/cleanup, `startup.ts`, preload/API types, `App`, startup/Agent issue UI, configuration source routes, translation-cache error policy, i18n/styles, and startup/renderer/real-Electron fixtures. |
| B. Targeted conversation recovery | A person rebuilds a verified projection or removes a proven conversation closure while retaining original data, with crash recovery. | A; FR-5 through FR-7. Thread catalog/history/rollout, Goal/Tool Task/delegation/Memory/resource owners, a narrow Host recovery coordinator, issue preview UI, and recovery/crash/shared-resource fixtures. No generic storage registry or per-module reset framework. |

Use the existing lifecycle, quarantine, domain deletion, and resource ownership
mechanisms; do not create alternate authorities. Retry of a partially constructed
owner must replace only that failed owner after cleanup, while preserving ready
services and existing task settlement evidence. Audit every Agent entry route,
including launcher, schedules, background delivery, and settings operations,
before claiming a usable Outline-only failure state.

Each feature folds its behavior into `architecture.md`, `agent-core.md`,
`agent-thread-rendering.md`, and `error-observability.md` as applicable. Current
specs remain current until implementation. The plan does not change the existing
release gate's manual reset requirement or claim that all old formats recover.

The live open-PR check finds #651 (`project-catalog-lifecycle`) claiming Thread
metadata/grouping, Automation deletion fencing, and stale Runtime recovery.
Its Project catalog shares the Thread database, so targeted conversation recovery
must preserve Project metadata and consume its final lineage/lifecycle rules.
#652 (`configurable-shortcuts`) claims configuration source/status handling,
`desktopHost.ts`, `windowApplicationHost.ts`, Thread UI, and shared messages.
Feature A consumes their final Host, source-recovery, and UI mechanisms; B follows
#651's deletion contracts. Repeat the live claim check before implementation.
This design-only file has no conflicting claim.
No dependency/build files, Core document commands/types, spec index, board,
changelog, or agent instructions need changing for this design. A required
protected implementation change returns to its ownership gate.

Primary risks are hidden pre-window I/O, incomplete domain admission fences,
losing the only surviving history copy, orphaning live processes, and collecting
shared resources after a partial reset. These risks define the acceptance bar;
an uncertain repair is an unavailable action, not a larger reset suggestion.

### Acceptance criteria

- **AC-1 (FR-1):** If Memory, catalog, Goal/Tool Task, resource-reference,
  delegation, or Automation database opening fails, the application shall still
  display the issue without requiring those stores or diagnostic writes to work.
- **AC-2 (FR-2, FR-4):** When Agent fails after Outline becomes ready, notes shall
  remain editable and durably saved. Agent producers and dependent routes shall
  remain unavailable or properly settled until recovery; retry shall not duplicate
  services or effects. Quit shall retain document durability arbitration.
- **AC-3 (FR-2, FR-3):** When history quarantine succeeds, the UI shall identify
  the failed Thread separately from affected descendants. If catalog enumeration
  fails instead, it shall report the real broader failure and preserve bytes.
- **AC-4 (FR-3, FR-4):** Version mismatch, invalid data, permission/space, lock,
  and unknown fixtures shall yield truthful categories and eligible actions.
  Non-content translation-cache read failures shall not discard saved entries.
- **AC-5 (FR-5):** If a projection is the only surviving readable history, rebuild
  shall not discard it. A verified rebuild shall preserve the original until the
  staged replacement passes the same readers used by normal startup.
- **AC-6 (FR-6, FR-7):** Cancellation, stale preview, blocking work, or retention
  failure shall preserve active data. Successful removal shall affect only the
  confirmed closure and preserve unrelated content/configuration/shared files.
  Restart at each mutation boundary shall resume the same fenced operation.
- **AC-7 (FR-1, FR-4, FR-7):** Packaged and dev recovery shall use their own data
  roots, keep keyboard/light/dark/accessibility behavior, remain available before
  domain readiness, and never report readiness before the owner verifies it.

Verification uses temporary stores and the production constructors/readers,
not real userData. Existing foundations include `keeps a recoverable failure
visible and retries only unfinished services once`, `quarantines authorless
persisted history under the strict schema, and starts anyway`, `restores a
missing rollout from projection and keeps future ordinals contiguous`, and
`leaves an old index untouched and requires an explicit development-store reset`.
Add real Electron constructor-failure and partial-availability cases, per-owner
fault fixtures, resource-preservation and interruption tests. Run relevant Core,
renderer and smoke tests, typecheck, docs:check, and diff checks per feature.

## Open questions

A whole Agent execution-data reset needs a separate product contract for
Automation definitions/history, Memory control versus generated Nodes, surviving
configuration, live processes, and shared attachment anchors. An Outline reset
needs its own cross-store dependency closure as well. These operations are
outside the selected features; neither is offered as a fallback Clear data action.

The selected features introduce no decision to support historical formats.
Before first-user data retention, compatibility and migration policy remains a
separate explicit baseline decision.
