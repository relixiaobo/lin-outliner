# Local Data Compatibility and Recovery

## Scope

The local data lifecycle establishes a supported baseline without clearing
userData. It owns physical format inspection, migration admission, verified
local backups, interrupted-operation recovery, and historical execution fences.
Multi-device identity and causal history are preserved, but there is no network
sync transport, account system, device enrollment, or distributed task scheduler.

The first release containing this complete capability is the supported baseline.
An unversioned pre-baseline database is admitted only when its schema exactly
matches the registered source. Unsupported formats remain intact for recovery.
Future schema changes include their migration or retained reader and populated
upgrade/restore fixtures in the same feature. The historical wipe/no-reader rule
from pre-release plans no longer governs supported datasets.

## Ownership and admission

`DataLifecycleCoordinator` supplies data availability to the existing Desktop
lifecycle. It does not replace the lifecycle's window, retry, or quit owner.
The minimal window and startup transport exist before data admission so failure
and progress remain visible. Physical format issues fence their domain; a
compatible Outline remains available through a scoped Agent failure.

`DataStoreRegistry` has one adapter per physical database. The Thread catalog and
Projects share `agent/state.sqlite`; Goal and Tool Task owners share
`agent/goals.sqlite`. Constructors and read-only inspection use the same
colocated schema declarations. The Agent databases use application version 1;
ContentStore retains its independent schema version 2. Exact unversioned source
schemas are annotated transactionally during baseline adoption.

Ordinary startup checks versions and schema structure without scanning every
historical payload or blob. Adoption and maintenance additionally check database
integrity and foreign keys. Domain owners retain their decoding, reconciliation,
quarantine, resource-availability, and provenance checks. A physical schema
version does not assert that every historical conversation is readable.

An established database or workspace file going missing is a recovery issue,
not permission to initialize an empty replacement. Journal-proven partially
created empty databases can finish their original initialization. A scoped
retry can inspect repaired data without replacing an unrelated healthy Host.
It does not run a format migration while normal writers are open.
Every Agent construction loads the durable restoration authority, including
construction after a scoped Retry. A completed inspection milestone never
substitutes for that load. Backup and repair preserve established Store
expectations; operation completion requires every registered Store to exist.

Settings may open during data preparation. Its preference and shortcut reads
wait for configuration admission before exposing editable values. Mutations,
theme/language persistence, update preferences, and public configuration file
creation wait on the same domain while retaining the JSON write guard. A failed
admission rejects queued requests without changing the source. Configuration
recovery refreshes an already-open Settings window independently of Agent
readiness; data recovery controls remain available throughout preparation.
Provider configuration recovery also publishes a `models` change after its
readiness boundary, so an already-open Models pane retries its provider catalog
without requiring a tab switch or a new Settings window.

Main does not import Core or Runtime storage implementation. Outline inspection
runs in the Runtime executable's read-only `--inspect-data` mode and returns a
bounded identity/error report. `runtimeLock` is the shared process-ownership
mechanism; document storage remains inside Runtime.

## Writer barrier

Maintenance authenticates and retires the exact existing Runtime, checks Task
process evidence, and acquires the actual Runtime writer lock. Runtime checks
the lifecycle journal before and after lock acquisition, so racing CLI starts
cannot enter a pending operation. Task supervisors likewise check lifecycle and
restoration admission before opening their output or launching a process.

Known live or unverifiable producers block maintenance. If the Task database is
damaged, independently retained configuration, identity, receipt, and process
evidence can establish quiescence without opening normal Task writers.
Startup configuration is ephemeral: retained process identities and terminal
receipts remain authoritative when that configuration is gone. A proven-dead
Runtime descriptor is reclaimed by the real writer lock without starting a
replacement writer during maintenance.

A private, operation-bound permit allows a temporary Runtime to finish an empty
workspace's initialization. This Runtime admits only status and lifecycle
control, disables ordinary requests and idle GC, and exits before the parent
reacquires the writer lock. Normal Hosts open after the manifest and completion
receipt are durable.

The Desktop keeps configuration JSON writes behind data admission, including
early presentation reads and failed-start teardown. Durable flushes and safe
quit remain with their existing owners. A quit during maintenance pauses at a
recoverable checkpoint before releasing authority.

## Manifest and journals

`data-manifest.json` records the manifest version, baseline release, observed
physical Store versions, existing workspace/document identity references, and
verification time. It is device-local metadata. It is not a shared document or
a replacement for logical payload and future sync-protocol compatibility.

`data-lifecycle/operation.json` contains a checksummed operation with immutable
identity, target storage-contract digest, application version, source/retention
backup IDs, phase, installed roots, and any restoration generation. Its previous
valid generation is retained before replacement. Unknown journal versions or
target contracts preserve data and require a compatible application.

Directory creation, file contents, rename, and directory entries are synced in
dependency order. Intent is durable before an active path changes; completion
follows installed-data validation. Restart observes both journal and file state
because a rename may have succeeded before its receipt was persisted.

A user-selected verified restore can supersede a failed operation of the known
contract. The predecessor journal and retained data remain under its operation
directory. Such a replacement cannot be cancelled into an unfenced partial
dataset; it must finish or be replaced by another explicit recovery.

## Backups and restoration

Settings Data and the startup recovery surface expose backup, restore, retry,
retained-file inspection, and bounded diagnostic export. Backup and restore use
an explicit native confirmation followed by safe quit/restart. Maintenance then
runs before ordinary producers. Cancellation of an ordinary queued operation
is allowed only before installation starts.
Inspection failures allow a read-only Refresh without remounting Settings.
Recovery surfaces scroll and wrap their controls at enlarged text sizes in both
the full window and the Agent rail.

Backups cover the registered data roots: Outline workspace, ContentStore, Agent
databases and payloads, Profile files, Memory control, tasks and working
material, Projects, schedules, delegation, configuration/personal state,
conversation records/exclusions, and retained Thread recovery evidence.
Lifecycle control and Runtime locks/descriptors are outside restored payloads.

SQLite snapshots include committed WAL pages. Ordinary files are independently
copied and fingerprinted. Working-material symlinks are retained as references
without traversing their targets; manifests reject entries beneath a file or
link. Authoritative storage paths cannot be redirected through symlinks.
Completion markers bind the manifest, lengths, checksums, and root types.
Working-material files also retain their owner-executable bit. Backup copies
stay private; restored files use private read/write permissions plus that bit,
applied and synced before installation and checked after installation.
Initialization checkpoints without a complete canonical workspace are internal
evidence, even if they contain configuration files. Restore admission and staged
validation require the canonical workspace, transaction log, and shared identity.

At least three verified backups are retained, in addition to operation-pinned
backups. Repeated failed attempts cannot evict their exact pre-operation backup.
Raw originals that could not be validated remain explicitly labelled retention
evidence and are not offered as automatic restore sources. They are not pruned
as ordinary verified backups. Retained operation directories also preserve the
actual roots moved during installation.

Restoration validates a complete staged dataset before replacing active roots.
Moving whole data roots keeps source WAL/journals with the retained source, so
they cannot replay into the replacement. Each installation is restartable and
verified. Insufficient space, failed copying, or a failed sync blocks progress
without clearing original data.

## Historical execution authority

The execution fence and classified historical work live outside replaced data.
A restore creates a new generation before the first active replacement. Pending
Task IDs, scheduled occurrences, Goal generations, delegated Sessions, Profile
publications, Memory jobs, and startup Thread hooks do not inherit permission
to execute again merely because their old records reappear.

Historical facts remain inspectable. Restored Tasks cannot control processes
using old PIDs or relaunch from old supervisor configuration. Enabling future
automatic work retains the historical identity fence. A new explicit Goal
command can authorize its generation; fresh tasks and newly enqueued work have
their own admission. Startup does not reconstruct old Memory publications or
scan old Threads into new work after restoration.
Prepared Memory publication IDs remain fenced at every recovery entry point,
including a fresh job's recovery pass. Profile publication settlement checks
the same authority even when reusing an existing prepared record. Historical
Task leases remain inspectable while being excluded from active capacity and
queue activation. Newly authorized Goal generations can continue after restart
inside restored Threads without waking historical general extension hooks.

The startup surface makes the pause visible and remains dismissible when
ordinary conversations and notes are available. A restore is not an undo on
other replicas. Shared undo or replica repair needs a future explicit sync
contract, fresh local/session authority, and retained unsynchronized work.

## Derived history recovery

`ThreadProjectionRebuilder` reconstructs conversation views only from complete,
settled, owner-verified Rollout sources whose boundaries cover the retained
projection watermarks. The original projection is retained before replacement.
A truncated valid prefix is insufficient evidence. Unreadable coverage or an
unavailable canonical source requires backup or scoped conversation recovery.

Repair stages a separate physical history database, verifies it, and installs it
with its own resumable journal. It does not rewrite original events, generate
new conversation identity, or erase the original projection.

If normal Agent initialization fails after compatible composition, an
inspection-only Host can provide `ThreadRecoveryService`. It starts no normal
producers and closes without adopting or stopping unrelated persisted Task
processes. Recovery IPC uses that owner after the original startup attempt
settles; it does not require normal Agent readiness to repair the failure.

## Verification

Run `bun scripts/check-data-lifecycle.ts` for a populated current-tree adoption,
backup, restore, identity, reference, and execution-fence check. It creates
disposable source/working roots and a report under `tmp/data-lifecycle-checks/`.
It uses the exact Loro package resolved by `bun.lock` and records source revision,
dirty-tree state, application version, and package version. Development fixtures
are not represented as released-version upgrade evidence.

`--fixture <directory>` consumes a saved fixture with `fixture.json` metadata and
checks a working copy. The release owner preserves immutable fixtures generated
by each supported release. Automated publication enforcement is a separate
delivery; until then the same driver is part of manual release verification.

Focused tests cover failed sync, transactional data/version rollback, WAL-only
commits, damaged current data, lost install receipts, startup ownership, scoped
availability, source-coverage refusal, and historical execution fencing.
Existing two-replica Core tests continue to cover causal merge, duplicate/out-of-
order delivery, fresh peer identity, and restored snapshots. These local checks
do not claim a production network sync implementation or physical power-loss
certification.
