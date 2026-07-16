# Sync Readiness Foundation

## Goal

Prepare Tenon's local persistence model for future multi-device synchronization
without adding accounts, Cloudflare resources, network transport, or sync UI.

The foundation is complete when portable workspace facts and device-local state
are structurally separate, two persisted Loro replicas converge after offline
concurrent edits and restart, syncable blobs have content hashes, and Agent/Issue
deletion has durable tombstone semantics. Future Cloudflare work should then be
a transport, authorization, retention, and coordination feature rather than a
rewrite of local product truth.

## Non-goals

- No account, login, session, device pairing, collaboration, or ACL UI.
- No Workers, Wrangler, D1, R2, Durable Objects, HTTP, WebSocket, hosted service,
  production `SyncBackend`, outbox, cursor, retry loop, presence, or sync status.
- No cross-device Agent execution or resume. That requires server leases and
  fencing.
- No syncing of credentials, OAuth tokens, permission grants, cookies, local
  paths, diagnostics, caches, indexes, active processes, or transient buffers.
- No multi-workspace/multi-document UI; the identity model only leaves room for
  it.
- No legacy persistence reader. This is pre-release; reset isolated development
  `userData` after format changes.
- No empty provider abstractions. Every new contract must be consumed by current
  local persistence, integrity checks, tombstones, or the reference-relay tests.

## Shape

This plan is shape (b), a set of independent complete features:

1. Replica-safe workspace and Loro document persistence.
2. Content-hash identity for Outliner assets.
3. Portable Agent ledger catalogs and deletion tombstones.
4. Event-sourced Issue persistence with entity tombstones.

The units are independently shippable. Unit 1 lands first because the identity
and persistence boundary is the mechanism the later units build beside. None
contains Cloudflare-specific code.

## Collision Result

- `gh pr list` reports no open sync or cloud-infrastructure claim.
- `docs/plans/nodex-parity-decisions.md` already reserves sync as a separate
  large plan; this document owns that local-foundation design.
- Agent Issue execution preflight landed in PR #398. The implementation branch
  starts from the containing `main`, so that former Core/Agent-store collision is
  resolved.
- Open Draft PR #401 currently contains only the Agent capability-permissions
  plan and claims a different security surface. Re-run its file-level scope check
  before Units 3 or 4 begin.
- The unclaimed `asset-gc` board item is adjacent to Unit 2 and may later touch
  `AssetService`. Unit 2 owns only content hashing and integrity; it does not take
  over asset indexing, garbage collection, Finder ingest, or alt-text editing.
- Unit 2 touches infrastructure-owned `src/core/types.ts`; its Draft PR must
  explicitly claim that surface.
- This plan does not edit main-owned `docs/TASKS.md` or `CHANGELOG.md`.

## Design

### Ownership Classes

| Class | Meaning | Examples |
| --- | --- | --- |
| shared workspace | portable facts replicas converge on | Loro document, source assets, Issues |
| private workspace | durable history for the owning user | Agent conversations, Runs, referenced payloads |
| device local | meaning tied to one installation | replica identity, undo history, window state, paths, permissions |
| derived/ephemeral | rebuildable or valid only while running | indexes, checkpoints, previews, token buffers, processes |

Secrets are prohibited from normal sync. A future cross-device secret vault is a
separate end-to-end encryption and recovery feature.

Electron main owns persistence identity and future transport. Core owns
deterministic document replication. Renderer mutations continue through preload
commands; the renderer never receives replica credentials or raw sync records.

### Identity And Persistence

| Identity | Scope | Shared later? |
| --- | --- | --- |
| `installationId` | one Electron `userData` installation | no |
| `workspaceId` | durable data and future authorization boundary | yes |
| `documentId` | one Loro document | yes |
| `replicaId` | one local copy of one document | no |
| `loroPeerId` | Loro operation author for that replica | no |
| future `userId` / `deviceId` | account/server authorization | not created now |

The structural `WORKSPACE_ID = 'workspace'` node constant is not a globally
unique workspace identity and must never be reused as one.

Keep local saves atomic with one versioned envelope whose sections are explicit:

```ts
interface WorkspacePersistenceEnvelopeV3 {
  kind: 'tenon-workspace';
  schemaVersion: 3;
  shared: { workspaceId: string; documentId: string; document: SharedLoroDocumentState };
  local: { replicaId: string; loroPeerId: string; operationHistory: OperationHistoryEntry[] };
}
```

Persist `installationId` separately under `userData`. Shared state never contains
the Loro peer id. Local reload restores its peer; bootstrap from shared state
always mints fresh replica and peer ids. Shared import cannot replace local
identity, undo history, secrets, paths, permissions, or UI state.

### Loro Replication Kernel

`LoroOutlinerDocument` gains cohesive operations to export a peer-free shared
snapshot, read a version vector, export an update from a version vector, import
bounded update batches, subscribe to committed local updates, and invalidate all
mappings/caches after import.

The complete acceptance harness uses two isolated persisted replicas and an
in-memory relay. It proves:

- shared bootstrap creates distinct replica and peer ids;
- concurrent command-driven edits converge after normal, reversed, duplicate,
  and paginated delivery;
- remote imports are not echoed as local updates; and
- both replicas restart, edit again, exchange updates, and still converge.

The app remains local-only. `DocumentService` uses the new envelope but starts no
queue or network loop. A future sync plan adds a system-owned Core command for
remote import through the existing mutation boundary. Because a Loro snapshot
contains the oplog, initial cloud enablement can upload a complete snapshot;
outbox semantics need only be introduced with a real acknowledgement protocol.

### Binary Integrity

Outliner assets remain logically addressed by stable `assetId`, but ingest also
computes and persists SHA-256. Portable reads verify digest and byte length.
Agent payloads already have this minimum contract. Source assets are portable;
reproducible previews and thumbnails are derived.

This plan does not upload, globally deduplicate, or garbage-collect blobs. A
future object store uses `{workspaceId, sha256}` for idempotency and introduces
reference retention together with deletion tombstones. R2 is the expected first
implementation, but the local contract is provider-neutral.

### Data Catalog

| Data | Future scope | Portable | Excluded/derived |
| --- | --- | --- | --- |
| Outliner | shared workspace | nodes, hierarchy, rich text, fields, tags, references, Trash | projections, search index, undo history |
| Assets | shared workspace | source bytes, metadata, logical id, hash | reproducible previews/thumbnails |
| Agent conversations/Runs | private workspace | canonical events, identity, lifecycle, retained payload refs | indexes, checkpoints, cursors, live state |
| Agent payloads | private workspace | referenced `source`, `preview`, `text_extract`, retained `tool_output` | temp data; `debug`/`approval` by default |
| Agent definitions | future account-private | persona and non-secret behavior | credentials and device probes |
| Issues/recurring Issues | shared workspace | definitions, operations, Activity, outcomes, tombstones | timers, locks, execution handles |
| Skills/preferences | future account-private, opt-in | validated user text/resources; selected preferences | built-ins, executable files until re-approved, device layout |
| Security/diagnostics | never | none | credentials, OAuth, cookies, permission grants, env, logs |

Agent history stays private if collaboration arrives later. Sharing a
conversation or payload requires an explicit product action outside this plan.

### Agent And Issue Portability

Agent conversation and Run logs already have stable `eventId` values; payloads
already have SHA-256. Add a portable catalog that enumerates canonical streams
and referenced payloads while excluding indexes, checkpoints, cursors, secrets,
permissions, and temp files. Local per-stream `seq` remains replay order, not a
global multi-device sequence. Future transport deduplicates by `eventId` and may
allocate a separate server sequence.

Before physical conversation or Run cleanup, append a versioned workspace-level
tombstone containing the entity id, deletion id, actor, timestamp, and last-known
event identity. Catalog rebuild and stale-merge tests prove deleted data cannot
reappear.

Replace mutable whole-file `issue-manager.json` truth with versioned append-only
Issue operations and a rebuildable projection. Operations cover Issue and
recurring-Issue changes, lifecycle/archive/delete, Agent Session bindings and
stop intents, Activity, terminal delivery, and schedule materialization. Existing
validation and lifecycle rules remain unchanged.

Portable history does not authorize execution. Active Runs, scheduler ownership,
and terminal-delivery claims remain local until a later strongly consistent
lease with fencing exists.

### Future Cloud Boundary

The later online feature adds an Electron-main coordinator without importing
Cloudflare SDK types into Core or durable stores. Expected responsibilities are:

- Workers: authenticated API and authorization boundary;
- D1: account/workspace/device metadata, cursors, record and object indexes;
- R2: Loro snapshots/updates and content-addressed assets/payloads; and
- Durable Objects: stream ordering, Run/scheduler leases, fencing, deduplicated
  delivery, and optional realtime connections.

That future plan must retrieve current Cloudflare limits/APIs and define auth,
outbox, pull, compaction, retention, recovery, quotas, and observability. These
local contracts must also permit PowerSync/Postgres or self-hosted Loro protocol
without changing product semantics.

### Invariants

- Sync-disabled startup and mutation cost remain equivalent to local-only Tenon;
  no unused queue grows.
- Portable records are versioned and idempotent; binaries are hash/length checked.
- Derived files can be removed and rebuilt without losing facts.
- Hard deletion writes a tombstone before bytes are reclaimed.
- An offline replica cannot resurrect tombstoned data.
- Credentials and permission grants are absent from manifests, tests, and errors.
- Tests use isolated temporary data roots, never production or another clone's
  `userData`.

## Files And Ownership

| Unit | Primary files |
| --- | --- |
| document replica | `src/core/loroDocument.ts`, `src/core/core.ts`, `src/main/documentService.ts`, new identity/persistence helpers, focused core/persistence tests, `docs/spec/architecture.md` |
| asset hash | `src/core/types.ts`, `src/main/assetService.ts`, asset tests, `docs/spec/architecture.md` |
| Agent portability | `src/main/agentEventStore.ts`, `src/main/appendOnlySeqLog.ts`, Agent event-store tests, `docs/spec/agent-event-log-rendering.md` |
| Issue events | `src/core/agentIssue.ts`, `src/main/agentIssueStore.ts`, Issue/runtime tests, Agent architecture/delegation/event-log specs |

`src/core/commands.ts` is not changed here; the online plan owns its coordinated
remote-import command. No unit changes dependencies, build config,
`docs/TASKS.md`, or `CHANGELOG.md`.

## Risks

- **Premature abstraction:** allow only contracts exercised by local persistence,
  integrity, tombstones, or convergence tests.
- **Peer collision:** enforce shared/local separation and fresh-peer clone tests.
- **Atomicity:** keep one workspace envelope; store installation identity
  separately because its lifecycle is independent.
- **Issue regression:** replay existing behavior fixtures before deleting the
  whole-file implementation; ship no compatibility reader.
- **Privacy:** exclude debug/approval payloads by default and test manifests for
  secret/path leakage.
- **Collision:** re-run open-PR scopes before every unit; Unit 2 stays disjoint
  from the board's broader `asset-gc` work.

## Open Questions

1. Is the first online release same-user only (recommended), or collaborative?
2. Is shared data end-to-end encrypted? This changes server compaction, search,
   recovery, and cloud Agent execution.
3. Does future authorization use accounts or a workspace recovery/pairing secret?
4. Are any Agent `debug` or `approval` payloads opt-in portable?
5. Do account preferences and user Skills join the first online release or follow
   document/history sync?

## Execution Units

### Unit 1: Replica-safe document persistence

- [ ] Add shared/local identities and the atomic v3 envelope; remove the old
  reader.
- [ ] Add snapshot, version-vector, update, import, and local-update primitives.
- [ ] Prove two-replica convergence, restart, no echo, and fresh-peer bootstrap.
- [ ] Update architecture docs; run typecheck, core tests, and docs check.

### Unit 2: Asset content integrity

- [ ] Add SHA-256 to every Outliner asset ingest and metadata path.
- [ ] Test digest/length verification and stable logical asset identity.
- [ ] Document source/derived ownership; run typecheck, relevant tests, and docs
  check.

### Unit 3: Agent ledger portability

- [ ] Build the canonical stream/payload catalog with explicit exclusions.
- [ ] Add conversation/Run deletion tombstones before physical cleanup.
- [ ] Prove deterministic rebuild, replay, and stale non-resurrection.
- [ ] Update Agent event-log docs; run typecheck, Agent tests, and docs check.

### Unit 4: Event-sourced Issue persistence

- [ ] Define versioned Issue, Session, Activity, delivery, and schedule operations.
- [ ] Replace whole-file mutation with append plus deterministic projection.
- [ ] Preserve lifecycle, validation, scope, delivery, and scheduling fixtures.
- [ ] Prove tombstone non-resurrection; update Agent specs and run required checks.

### Future online sync entry criteria

- [ ] Required local units have landed.
- [ ] Same-user/collaboration, E2EE, and account/pairing decisions are ratified.
- [ ] A fresh collision check and current Cloudflare docs retrieval are complete.
- [ ] One complete online plan covers auth, transport, outbox, cursor, compaction,
  retention, recovery, quotas, observability, leases, and user-visible sync UX.
