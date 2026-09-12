# Durable Data Compatibility Foundation

## Goal

Make Tenon's local userData a durable product contract for existing and future
users. A newer release must either open and migrate a supported data set, or
stop before mutation with a clear recovery path. It must never silently wipe,
partially upgrade, overwrite, or reinterpret user data.

The target covers packaged Tenon data and isolated development data. The first
supported baseline is the release that ships this plan. Data created before the
baseline is classified explicitly during bootstrap; it is never assumed to be
compatible merely because the files exist.

**Shape:** a set of three independently complete features delivered in dependency
order. Each feature is useful and verifiable on its own; the later features
consume the contracts established by the earlier ones.

## Non-goals

- Cloud sync, remote backup, multi-device merge, or account-level recovery.
- Downgrading a data set to an older application version.
- Replacing the existing domain Stores with one universal database.
- Importing arbitrary historical or corrupted formats.
- Automatically deleting data when a migration is unavailable or fails.
- Treating targeted Thread recovery as a substitute for schema migration.
- Making derived indexes or caches durable sources of user truth.

## Objective, constraints, and decisions

- **OBJ-1:** Users can upgrade Tenon without losing local conversations,
  Outline content, Profile data, Memory, tasks, schedules, delegation state,
  attachments, or recovery receipts.
- **OBJ-2:** A failed upgrade leaves the previous data set intact and gives the
  user a bounded way to retry or restore.
- **Minimum acceptable outcome:** every supported release-to-release upgrade is
  tested from a real populated userData fixture; an unsupported or failed
  upgrade enters a safe recovery state without opening normal writers.
- **CON-1 hard:** The existing process seam remains: main owns filesystem,
  SQLite, migration and backup work; renderer receives typed startup state and
  recovery actions through preload.
- **CON-2 hard:** Canonical user data must remain recoverable before any
  destructive or format-changing write.
- **CON-3 hard:** All migration targets stay inside resolved userData. A
  renderer or configuration file cannot select an arbitrary migration or backup
  path.
- **CON-4 legacy:** Current Stores open their own SQLite files during
  composition and use `CREATE TABLE IF NOT EXISTS`. The coordinator must become
  the gate before those constructors run; it must not require a simultaneous
  rewrite of every domain owner.
- **CON-5 resolvable:** The current pre-release rule permits clearing userData
  instead of migrating. This plan replaces that rule for the first supported
  baseline and updates the working contract in `AGENTS.md` in the same rollout.

### Selected target

Use one `DataLifecycleCoordinator` at the main-process boundary, one durable
manifest and migration journal, per-domain Store adapters, and a shared local
backup/restore owner.

The coordinator owns ordering, compatibility decisions, backup, staging,
commit/recovery state and safe failure. Domain Stores own their schema,
semantic validation and migration code. Derived data is rebuilt after canonical
data is valid.

Do not make the coordinator understand Memory semantics, Task settlement or
Profile authorship. It calls typed Store adapters and records their outcomes.

## Design

## Current data inventory

The implementation must begin with an executable inventory derived from the
paths in `agentCorePaths`, `createAgentHost`, `createOutlineDesktopHost`, and
the existing configuration/resource owners.

### Canonical user data

| Domain | Current owner | Current storage | Required treatment |
| --- | --- | --- | --- |
| Outline content | Outline Runtime / ContentStore | `content/`, `outline-runtime/` | Snapshot and validate before upgrade; preserve exact revisions and anchors. |
| Thread catalog and Projects | `ThreadMetadataStore`, `ProjectCatalogStore` | `agent/state.sqlite` | Version and migrate transactionally; validate lineage, memberships, and receipts. |
| Thread events | `RolloutStore` | `agent/rollouts/` | Preserve original event bytes; migrate through staged logs or retain versioned readers. |
| Thread projection | `ThreadHistoryProjectionStore` | `agent/thread_history.sqlite` | Treat as rebuildable from Rollout where complete; retain it because it may be the only recovery source. |
| Profile | `ProfileFileStore` | `agent/profile-control.sqlite`, Profile files | Version control metadata; preserve public file bytes and provenance. |
| Memory control | `MemoryControlStore` | `agent/memories.sqlite` | Migrate admissions, lineage, publications, invalidations, jobs, and reset state. |
| Goal and Tool Task state | `GoalStore`, `ToolTaskStore` | `agent/goals.sqlite` | Migrate leases, receipts, delivery batches, continuations, and terminal facts. |
| Delegation | `DelegationSessionStore` | `agent/delegation.sqlite` | Migrate sessions, messages, settlements, and worktree ownership. |
| Scheduled tasks | `AutomationStore` | `agent/scheduled-tasks.sqlite` | Migrate definitions, cursors, runs, receipts, acknowledgements, and missed occurrences. |
| Resources | `AgentResourceStore`, ContentStore | `agent/resource_references.sqlite`, `content/` | Migrate links/anchors; preserve bytes and shared references. |

### Derived or disposable data

- Thread record files and the record index.
- Search and access indexes.
- Translation caches and other preview caches.
- Status snapshots, generated schemas, and last-applied display state.
- Rebuildable projections whose canonical source is verified and retained.

Derived data may be invalidated by a format epoch and rebuilt. The coordinator
must record rebuild failure separately from canonical migration failure.

### Operational data

- Migration and backup journals.
- Publication receipts and pending recovery operations.
- Process/task leases and delivery state.
- Profile and Memory pending writes.

Operational data is not disposable merely because it is private. It determines
whether a side effect may be retried, settled, or suppressed.

## Data contract

### Manifest

Add a small atomic manifest at `<userData>/data-manifest.json`.

The manifest contains only bounded control metadata:

```text
formatEpoch
baselineRelease
storeVersions: { storeId: version }
state: ready | inspecting | migrating | rebuilding | recoveryRequired
operationId: string | null
backupId: string | null
lastVerifiedAt
```

The manifest is not a user-data backup and never contains conversation content.
Writes use the existing atomic JSON owner and retain the previous valid manifest
until the replacement is durable.

If the manifest is absent:

1. If no managed data exists, initialize the baseline manifest.
2. If data exists, run a read-only baseline inspection across every Store.
3. Write `formatEpoch: 1` only after all required validators pass.
4. Otherwise enter `recoveryRequired` without opening normal writers.

### Store registry

Create one registry consumed by the coordinator. Every entry declares:

- stable `storeId`;
- ownership domain;
- canonical or derived classification;
- storage paths;
- current schema version;
- read-only inspection;
- backup/snapshot method;
- migration method;
- integrity and semantic validation;
- rebuild method, when derived;
- whether the Store can be opened before migration.

The registry is code-owned. The manifest records observed versions and operation
state; it does not grant a renderer permission to select a Store.

### Version rules

- Store versions are monotonic integers.
- A newer application rejects a future store version without writing to it.
- A migration is valid only when its source version is explicitly supported.
- Migrations are idempotent and safe to resume after a process interruption.
- A migration may add a new versioned representation while retaining the old
  representation until verification completes.
- Downgrade is refused with a recovery message; it never rewrites data into an
  older shape.
- Every serialized payload kind keeps an explicit `schemaVersion` and a bounded
  decoder. Retired payload versions need either a reader or a verified rewrite
  before their reader is removed.

## Migration protocol

### Startup sequence

The main process must run this sequence after resolving userData and before
constructing `OutlineDesktopHost` or `AgentHost` Stores:

1. Acquire the existing single-instance/userData writer authority.
2. Load and validate the manifest and migration journal.
3. Recover any interrupted migration or backup operation.
4. Inspect every canonical Store without admitting normal writes.
5. Create a verified backup when migration or rebuild is required.
6. Migrate canonical Stores in a deterministic registry order.
7. Run cross-store semantic checks.
8. Rebuild derived Stores and indexes.
9. Mark the manifest `ready` only after all required checks pass.
10. Construct normal Hosts and open admission.

`DataLifecycleCoordinator` must be the only owner that transitions the manifest
to `ready`. Existing startup issue reporting and `ThreadRecoveryService` remain
available for their narrower domains after this gate.

### Backup

Create backups under a userData-owned directory with a generated operation ID.
Each backup has:

- a manifest snapshot;
- WAL-aware SQLite snapshots using `VACUUM INTO` or an equivalent owner-safe
  snapshot;
- copied canonical files and Rollout logs;
- checksums, byte lengths, and file-type metadata;
- a durable backup manifest and completion marker.

Never remove the previous verified backup until the new backup and migrated
dataset pass validation. Keep at least the last three verified backups, with a
future setting for retention policy. Backup failure blocks migration.

### SQLite migration

Each SQLite Store migration runs against a staged copy, never the only active
database:

1. Snapshot the source database with WAL contents included.
2. Open the staged copy through a migration-specific owner.
3. Apply `BEGIN IMMEDIATE` migration steps.
4. Set the Store schema version only after all steps commit.
5. Run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` where applicable.
6. Run domain validators for lineage, references, receipts, and enum values.
7. Close and fsync the staged database.
8. Record the staged checksum in the migration journal.
9. Install it through an atomic replacement protocol.

If multiple Store files are involved, the journal records each Store's
`staged`, `verified`, `installed`, and `recovered` state. A crash during the
multi-Store install either completes the exact operation or restores the
pre-migration backup before normal Hosts open.

### File and Rollout migration

Profile/configuration files use parse, validate, write-to-temp, fsync, atomic
rename, and post-write readback. Invalid user-authored text is preserved and
reported as a repairable configuration issue.

Rollout migration must preserve the original event log until the staged reader
has verified every event. A changed event envelope uses either:

- a versioned reader retained for the supported history window; or
- a staged rewrite that records the original digest, source version, and
  recovered provenance before replacing the active log.

The migration must never treat a derived Thread projection as an original
Rollout without marking the resulting history as reconstructed.

## Failure and recovery states

### `ready`

All required Stores are compatible and validated. Normal Hosts may open and
admit work.

### `recoveryRequired`

The data is unknown, too new, corrupt, or a migration failed. Normal writers
remain closed. The startup surface offers:

- retry inspection;
- retry migration;
- restore a verified backup;
- export a bounded diagnostic report;
- quit without mutation.

The UI must show which Store blocked readiness and whether the original data and
backup are intact. It must never offer “reset data” as the default recovery.

### `rebuilding`

Canonical data is valid but derived data is being rebuilt. The user can use only
surfaces whose dependencies are verified. A rebuild failure leaves canonical
data untouched and remains retryable.

### Future-version data

If any Store is newer than the application understands, the application must
refuse to write it and show the minimum application version needed. It must not
attempt a best-effort read followed by a write.

## Cross-store semantic checks

After individual migrations, validate the relationships that can cause silent
loss even when every SQLite file passes `integrity_check`:

- every catalog Thread has valid lineage and no orphan child edge;
- every Rollout event belongs to its file owner and has contiguous ordinals;
- history watermarks point to existing Rollout boundaries;
- payload/resource references either resolve or are explicitly unavailable;
- Profile source references and Memory origins preserve their ownership facts;
- Task leases and delivery batches reference existing tasks;
- Automation runs do not point to impossible new executions;
- Delegation settlements reference valid sessions and task identities;
- Project memberships reference existing Projects and Threads;
- no derived record claims more coverage than its canonical source.

Checks that fail must identify the exact Store and relationship. They must not
silently delete the offending row.

## Execution slices

### Slice A — Safe data lifecycle gate

Complete feature: an existing installation can be inspected, backed up, marked
compatible, or stopped safely before normal Hosts open.

Touch the main startup owner, manifest/journal owner, backup owner, startup
state/preload contract, and recovery UI. Add empty-data bootstrap, current-data
baseline inspection, future-version refusal, backup verification, disk-full
handling, and restart recovery for an interrupted backup/journal operation.

Acceptance:

- **AC-A1:** When userData is empty, the application creates a versioned
  baseline and starts normally.
- **AC-A2:** When a required Store is incompatible, normal writers do not open
  and the startup UI identifies the Store and preserves its bytes.
- **AC-A3:** If backup creation fails, no migration begins.
- **AC-A4:** If the process stops during backup preparation, startup resumes or
  safely discards the incomplete backup without touching canonical data.

### Slice B — Canonical Store migrations and derived rebuilds

Complete feature: the baseline can upgrade to the next released data format
through staged, validated, resumable migrations.

Implement adapters for the current SQLite Stores, Rollout files, Profile files,
configuration files, resources, and canonical Outline storage. Start with the
current baseline as version 1; do not invent migrations for formats that have no
known prior public release. Register derived rebuilders for projection, records,
indexes, caches, and status files.

Acceptance:

- **AC-B1:** A populated baseline fixture upgrades without clearing any
  canonical data.
- **AC-B2:** Each staged Store passes integrity and domain checks before install.
- **AC-B3:** A crash after every staged/install journal boundary resumes the same
  operation or restores the previous verified data set.
- **AC-B4:** Derived Stores can be deleted and rebuilt from canonical data with
  equivalent user-visible content and provenance.

### Slice C — Upgrade release gate and recovery operations

Complete feature: every release has reproducible upgrade evidence and users can
restore their last verified data set without developer intervention.

Add upgrade fixtures seeded through real application owners, a migration test
driver, crash injection at each boundary, backup restore verification, future
version refusal, downgrade refusal, and a release checklist. Integrate the
existing targeted Thread recovery surface as a domain-level recovery action,
not as the global data compatibility mechanism.

Acceptance:

- **AC-C1:** CI upgrades a fixture produced by the previous release and checks
  Threads, Outline data, Profile, Memory, Tasks, schedules, Delegation,
  Projects, resources, and attachments.
- **AC-C2:** CI verifies that failed migration leaves the original fixture
  byte-identical or restorable from the verified backup.
- **AC-C3:** A future-version fixture is rejected without writes.
- **AC-C4:** A restored backup reopens through normal production Store owners.
- **AC-C5:** The release checklist blocks publication when migration coverage or
  backup restore evidence is missing.

## Operational policy

- Tag the current baseline before enabling real user rollout.
- Do not call `rm -rf userData` in upgrade tests; use disposable fixture roots
  only for clean-install tests.
- Maintain one populated fixture per supported release.
- Keep at least three verified local backups and document their location and
  restore procedure.
- Do not ship a Store schema change without its migration and upgrade fixture.
- Do not ship a payload or event schema change without a reader, rewrite, or
  explicit supported-history policy.
- Never silently downgrade or delete incompatible data.

## Open questions

- Should the first public baseline be the current `0.8.0` train or a new
  release train after Slice A? Recommended: the first release containing Slice
  A, so the manifest and safe-failure contract ship together.
- Should backups stay only inside userData or also support a user-selected
  export location? Recommended: start with userData plus an explicit export
  command; do not introduce cloud backup in this feature.
- What is the supported upgrade window? Recommended: every published release
  from the baseline forward; older data must be imported through an explicit
  recovery/export path rather than guessed migration.
- What user-visible product name should the incompatible-data state use in
  Chinese and English? The message must say that data was preserved and that
  retry/restore is available; it must never suggest that clearing is required.
