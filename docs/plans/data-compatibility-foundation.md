# Durable Data Compatibility Foundation

## Goal

Make Tenon's local userData a durable product contract while preserving its
path to multi-device real-time synchronization. A release must open a supported
dataset, upgrade it through a verified operation, or preserve it with an
actionable recovery path. Local upgrades must not rewrite shared history,
restore stale execution authority, or require every device to upgrade together
for an unrelated local schema change.

The first supported baseline is the release containing the complete local
foundation. Pre-baseline data is admitted only by an exact known-format
inspection. An absent manifest does not establish compatibility.

**Shape:** a set of two independently complete features: (1) local compatibility,
backup, and recovery, including adapters and failure tests; (2) automated release
enforcement using that already usable driver. Future schema changes carry their
migration and compatibility fixtures in the same feature PR. There is no
standalone migration scaffold or upgrade to an unspecified format.

## Non-goals

- Implementing network transport, accounts, device enrollment, cloud hosting,
  remote backup, or a distributed execution scheduler in this foundation.
- Treating future synchronization as optional: its identity, history, and
  compatibility constraints apply to local design now.
- Replacing existing Stores with one universal database or changing CRDT
  libraries merely to obtain a migration framework.
- Downgrading data, guessing arbitrary historical formats, or automatically
  deleting incompatible data.
- Treating targeted conversation recovery as schema migration, a local restore
  as shared undo, or local task receipts as exactly-once external execution.

## Design

### Authority and policy transition

For migration and legacy-reader design, this plan supersedes the exclusions in
the archived [Sync Readiness Foundation](archive/sync-readiness-foundation.md#non-goals),
including its instruction to reset isolated development userData after format
changes. That archived instruction describes the earlier pre-release policy;
it is not an alternative design for the supported baseline. Existing identity,
replication, and ownership mechanisms remain governed by their current specs.

Until the complete baseline implementation lands, the current pre-release rules
in [AGENTS.md](../../AGENTS.md) and the
[architecture specification](../spec/architecture.md) still describe the running
system. Merging this design does not claim that migrations or retained readers
already exist, or authorize a data reset. Feature 1 must replace those current
no-migration/no-reader rules in the same coordinated implementation change that
establishes the supported baseline, before any supported schema upgrade ships.

### Evidence and selected approach

The [research reference](reference/data-compatibility-evidence.md) compares
SQLite, Joplin, Zotero, Signal Desktop, TriliumNext, VS Code, n8n, AFFiNE,
Loro, Automerge, and Yjs. It includes pinned sources and isolated SQLite/Loro
counterexamples. Select transaction-first local migration with independently
versioned shared data and future sync capabilities.

Use a thin main-process `DataLifecycleCoordinator` for admission, writer
ownership, verified backups, and interrupted-operation recovery. Physical Store
owners retain schema and semantic authority. Single-database changes use SQLite
transactions; destructive rewrites and coupled changes use explicit staging and
a dataset recovery journal. Derived data is rebuilt only from verified,
retained canonical sources.

The coordinator invokes typed owner capabilities rather than implementing
Memory semantics, Task settlement, Profile authorship, or CRDT merge rules.
Its admission result feeds the existing Desktop lifecycle, which continues to
own window visibility, transport, retry, and quit.

Constraints:

- Main and the standalone TypeScript Runtime own persistence. Renderer receives
  bounded typed state and opaque recovery IDs through preload.
- Preserve a verified pre-operation dataset before format-changing or destructive
  writes, and pin it through every retry and rollback.
- Managed migration, staging, and backup destinations stay under resolved
  userData. Inputs cannot authorize arbitrary paths or symlink traversal.
- Admission precedes normal constructors that create tables, reconcile data,
  or schedule writes. Recovery-only construction is a distinct capability.
- A fault blocks only its proven dependency scope. Unknown physical formats or
  interrupted cross-store installation can block the dataset; a damaged Thread
  or rebuildable index does not do so automatically.
- Change the pre-release wipe rule only when the complete baseline ships, with
  coordinated `AGENTS.md` and spec updates. This design does not authorize
  clearing installed or development data.

### Executable inventory and ownership

Derive the inventory from `agentCorePaths`, `createAgentHost`,
`createOutlineDesktopHost`, configuration owners, and ContentStore. Each
persisted path needs an owner, authority classification, format inspector, and
backup/restore policy, or an explicit disposable/external classification. A
construction inventory guard detects unregistered authoritative paths.

| Data | Existing owner and storage | Required treatment |
| --- | --- | --- |
| Outline and exact content | Outline Runtime, ContentStore; `outline-runtime/workspace/`, `content/` | Preserve shared identity, Loro history, revisions, anchors, and immutable bytes together |
| Thread catalog and Projects | `ThreadMetadataStore`, `ProjectCatalogStore`; `agent/state.sqlite` | One physical adapter; preserve lineage, memberships, and recovery operations |
| Thread events | `RolloutStore`; `agent/rollouts/` | Preserve original event identity, ordinals, and provenance; retain supported readers |
| Thread projection | `ThreadHistoryProjectionStore`; `agent/thread_history.sqlite` | Rebuild only where retained Rollout proves complete coverage; otherwise retain recovery evidence |
| Context/tool payloads | `ToolPayloadStore`; `agent/payloads/` | Preserve referenced bytes and versions; distinguish diagnostics from irreplaceable context |
| Profile | `ProfileFileStore`; `agent/profile-control.sqlite`, `agent/user/`, `agent/profiles/` | Preserve text, revisions, pending publications, and authorship |
| Memory | `MemoryControlStore`, `TimelineMemoryStore`; `agent/memories.sqlite`, Outline Nodes | Preserve control facts and associated Outline data as one recovery closure |
| Goals and Tasks | `GoalStore`, `ToolTaskStore`; `agent/goals.sqlite`, `agent/tool-tasks/` | One database adapter; retain receipts/output; classify live supervisors and authority separately |
| Delegation | `DelegationSessionStore`; `agent/delegation.sqlite` and owned working material | Preserve sessions, settlements, and worktree evidence; external directories are not portable database state |
| Schedules | `AutomationStore`; `agent/scheduled-tasks.sqlite` | Preserve definitions, occurrences, cursors, runs, and acknowledgements without replay after historical restore |
| Resources | `AgentResourceStore`; `agent/resource_references.sqlite`, ContentStore | Preserve links and bytes; missing local material is not a shared deletion |
| Configuration/personal state | Configuration, preference, credential, and ranking owners | Preserve user values and local history; the only source of ranking facts is not a rebuildable index |
| Recovery control/evidence | Thread recovery and lifecycle owners | Preserve pending operations and originals; an old backup cannot overwrite the active restore fence |

Classify both authority (`canonical`, `operational`, `derived`) and portability
(`shared logical data`, `device-local`, `external reference`). Apply this at row
or payload level when one file contains several kinds. Private receipts are not
disposable; PIDs, absolute paths, sockets, credentials, and leases are not
transferable authority simply because they matter to recovery.

Search mirrors, record indexes, preview caches, generated schemas, and display
snapshots can be derived. Published records need an explicit preservation policy
when their original source is absent. Rebuildable status names its source and
proves coverage before deletion. Backups exclude their own backup/staging trees,
live sockets, and process locks, recording those exclusions. Configuration and
credentials have owner-specific private retention policies; diagnostic export
never includes secret contents.

### Compatibility domains

Do not overload one `formatEpoch`:

| Contract | Owner | Evolution rule |
| --- | --- | --- |
| Local manifest/journal | Main lifecycle owner | Versioned decoder; unknown versions are inspection-only |
| Physical SQLite/file layout | Physical Store adapter | Ordered supported migrations; data and version commit together |
| Shared logical schema and event/payload kinds | Domain codec/command owners | Additive evolution by default; explicit read/write capabilities and retained readers |
| CRDT encoding and causal history | Core/Loro owner | Preserve operation identity/frontier; verify library compatibility separately |
| Future sync capabilities/protocol | Future sync admission owner | Negotiate before remote admission; never infer support from local database version |

Each entry declares supported versions and the minimum application release when
known. An error must not invent a release number if no mapping exists. A local
index change does not implicitly change shared or network contracts. The first
baseline may register an exact existing unversioned envelope as a known source;
this is not heuristic legacy detection, and its reader remains until a verified
replacement exists.

Retain unsupported shared records without lossy decode/re-encode. Preserve
compatible additive fields through reads and unrelated edits. Unknown semantics
that cannot safely round-trip make their document or operation read-only.
Inspection issues must not escalate into unrelated destructive recovery.

### Multi-device identity and history

Reuse Core's `persistenceIdentity` and `exportSharedState`: `workspaceId` and
`documentId` name shared data; `installationId` and `replicaId` name local
ownership; a fresh Loro session peer identifies new causal operations. The
lifecycle manifest references those owners instead of creating competing IDs.
Physical migration preserves shared and operation identities. Provisioning a
second device imports existing shared identity/history and establishes distinct
local ownership and a fresh editing-session peer.

An empty local directory being provisioned from an existing workspace must not
create a different shared workspace or reseed its defaults. Keep Core's
`exportReplicationUpdate` and `applyReplicationUpdates` within the existing
process seam. Future remote admission enters through a deliberate Runtime
capability, not direct workspace-file or Core mutation access.

A shared migration must be safe under concurrent execution, not merely when
called twice locally. Prefer compatible interpretation and stable logical keys.
A transformation requiring shared edits either proves convergence with preserved
user intent under independent migration and editing, or requires a shared
migration authority that fences incompatible writers. A local lock or version
property is not that authority. Never reuse a fixed Loro peer ID as an improvised
distributed migration ID.

Physical snapshot/log compaction preserves causal history. Truncation,
tombstone removal, and shared blob reclamation require a separate sync-retention
contract. Future rejoin must reject unsupported causal frontiers, retain unsynced
work, and offer explicit repair/rebootstrap. A missing local cache file never
implies shared deletion.

### Manifest, registry, and durable journal

Keep a bounded `<userData>/data-manifest.json`:

```text
manifestVersion
baselineRelease
storeVersions: { physicalStoreId: observedVersion }
identityReferences
operationId: string | null
lastVerifiedAt
```

Identity references point to existing owner identities. Versions are verified
observations, not permission to skip inspection. This is local control metadata,
not a shared document. Operation phases belong to the lifecycle journal; domain
availability belongs to the Desktop lifecycle. A ready manifest does not itself
authorize tasks or future synchronization.

The code-owned registry declares each physical unit, domain participants, paths,
required/optional existence rules, dependency closure, accepted formats,
inspection/validation, backup/restore, migration class, and derived rebuild.
Shared physical databases have one snapshot, version ledger, transaction, and
close owner. Dedicated read-only handles must not invoke normal constructors,
change journal mode, create schema, or reconcile content.

The journal under userData records operation kind, source/target versions,
source identities/digests, backup ID, participating paths, phase, staged digests,
installed units, and recovery generation. Its active restore record is outside
the payload set being replaced. Journal schema and operations are versioned.

Use a persistence primitive with `writeRecoveryFile`'s guarantees: private temp
file, file sync, close, atomic rename, and containing-directory sync. Preserve
the preceding valid generation until its successor is durable. The existing
`atomicWriteFile`/`writeJsonFile` helpers lack those sync guarantees and must not
be reused unchanged for lifecycle commits. SQLite lifecycle transactions need
explicit journal durability settings rather than silently inheriting ordinary
Store `synchronous=NORMAL` behavior.

Persist and sync intent before changing active paths. Sync each installed set
and directory before recording completion. Restart checks journal and observed
files because a rename may precede its receipt. Unknown journal states preserve
evidence and fence the affected scope.

### Writer authority and startup

Electron's `requestSingleInstanceLock` does not cover detached Outline Runtime,
CLI starts, task supervisors, or file publishers. Runtime owns
`OutlineRuntimeLock`; its maintenance and GC also write data. Establish a
maintenance barrier over every participating writer:

1. Close local admission and identify current Runtime, publishers, and owned
   tasks without assuming authority from a PID or path alone.
2. Authenticate the exact Runtime, freeze/drain and retire it through its
   lifecycle protocol. Settle or quiesce supervisors and publishers through
   their owners. Unknown or unquiesced writers block maintenance with an issue,
   not an arbitrary kill.
3. Acquire the actual Runtime writer authority before accessing its files, plus
   a lifecycle claim checked by participating writers. A racing CLI either owns
   the lock first or is refused. Retiring one process does not prevent another
   from starting; old executables cannot be assumed to honor a newly added lock.
4. Hold authority through snapshot, installation, recovery, and durable
   completion. A recovery-only Runtime, if needed, receives an explicit bounded
   capability under that claim while public admission, GC, and producers stay
   fenced.
5. Close temporary owners and hand authority back through checked startup.
   Runtime reacquires its writer lock and verifies lifecycle admission before
   serving. Recover a crashed claim only after verified owner death and journal
   inspection; no writer opens merely because a lock file looks stale.

Inspect a future format before modifying managed data. Ephemeral process
coordination and diagnostics do not authorize rewriting its manifest, database,
or WAL. If obtaining a consistent view requires modifying unknown data, stop.

Run the following sequence within the existing Desktop lifecycle:

1. Resolve userData and desktop exclusivity; create minimal window, startup
   transport, diagnostics, quit, and retry without normal Store writers.
2. Inspect lifecycle/physical versions. Recover an interrupted install or
   restore under maintenance authority before opening its consumers.
3. Classify known data into compatible, format error, scoped corruption, pending
   domain operation, or derived rebuild. Fresh data uses explicit initialization
   adapters and receives its baseline only after required creation/validation;
   interrupted initialization resumes its own journal.
4. For pending operations such as targeted Thread recovery, construct compatible
   recovery-only owners with producers fenced. Resume their exact journals
   before checks assume their closure is complete. Failed recovery retains a
   fence over its proven dependency scope.
5. For a real format change, acquire the complete writer barrier, verify its
   backup, execute the appropriate migration class, and validate the result.
   Preserve pending domain journals with their associated data.
6. Publish per-domain admission and construct compatible normal owners. Healthy
   Outline remains usable through a scoped Agent fault; derived rebuilds block
   only dependent surfaces.

Do not leave `ThreadRecoveryService` behind `lifecycle.ready('agent')` for the
failure it must repair. Recovery IPC resolves a compatible recovery-only owner
from startup state, checks an opaque ID and exact scope, and preserves existing
confirmation for destructive actions. Normal requests/producers still require
normal readiness. Retry/quit joins maintenance and cannot release its fence
before a safe checkpoint is durable.

### Backup and retention

A backup captures its declared consistency closure, not every file under
userData recursively. Under the writer barrier, take WAL-aware SQLite snapshots
with the backup API or `VACUUM INTO`, canonical files, Rollout/CRDT history,
required blobs, and pending operational evidence. Include identities, versions,
lengths, checksums, file types, dependency coverage, and a completion marker
written last.

Retain at least three completed verified backups plus every backup pinned by an
incomplete operation. Repeated failures cannot rotate away the exact
pre-operation backup. Estimate backup/staging/rollback disk space first; failure
or insufficient space blocks mutation. Expose bounded progress and permit
cancellation only before mutation or at an explicitly recoverable checkpoint.

Immutable blobs may use verified filesystem copy-on-write with ordinary copying
as fallback. A live reference or hard link alone is not an independent backup.
Never delete originals because an incomplete backup directory exists. Local
backup protects against upgrade failure; off-device disaster recovery is a
separate feature.

### Migration classes

#### Single physical database

For a change fully contained in one SQLite database, pin a verified backup,
record intent, open a migration-specific handle, and use `BEGIN IMMEDIATE`.
Apply schema/data changes, validate domain relationships, and write the
application version in that same transaction. Commit with the selected durable
policy, validate the result, and record completion. Failure before commit rolls
back data and version together. If commit precedes the journal receipt, inspect
the version and validated postconditions to recover.

Do not require staged replacement for ordinary transactional changes. SQL
transactions do not include files or external effects. Nontransactional steps
such as `VACUUM`, lossy transformations, and cross-store dependencies must declare
broader recovery boundaries instead of hiding inside this class.

#### Coupled databases, files, and destructive rewrites

Build a complete operation plan before mutation, stage the affected dependency
closure, preserve originals, and validate the complete staged result before
installation. `ATTACH` does not provide cross-database crash atomicity for WAL.

Checkpoint staged WAL, close handles, sync, and fingerprint the staged set.
Retain source main files and associated WAL/journals together; no source journal
may remain at a replacement's active path. Install using durable intent,
atomic path changes, directory sync, and per-unit receipts. Restart resumes the
exact operation from observed digests or restores its verified checkpoint before
normal admission. Automatic rollback requires the conditions below.

Profile/configuration adapters preserve invalid user-authored text as repairable
issues. Event/Rollout rewrites retain original digests, event identities, and
provenance. Prefer retained readers when rewriting would change shared causal
history. Mark reconstructed history explicitly; a projection never silently
becomes an original Rollout.

#### Derived rebuilds

Rebuild into a replaceable local generation from verified canonical sources.
Record failure separately from canonical migration. Retain a usable old index
until replacement verifies, or disable only the dependent surface. If source
coverage is incomplete, preserve the projection as evidence. Local indexes and
physical compaction do not create shared mutations.

### Validation and fault scope

Adapters check integrity, versions, decoding, and domain invariants. Cross-store
checks cover Thread lineage, Rollout owner/ordinal continuity, watermarks,
reference availability, Profile/Memory provenance, Task delivery ownership,
Automation accepted-run bindings, Delegation settlements, Projects, and anchors.

Checks return scope and reason: unsupported format, global inconsistency,
domain/document quarantine, pending operation, derived rebuild, or unavailable
external material. Never silently delete offending rows. Pending owner journals
explain intermediate states and resume before final semantic checks. Compatible
Stores can open for bounded repair without requiring pristine history first.

Full scans belong to adoption, migration/restore, and explicit integrity work.
Ordinary compatible startup uses bounded version/journal inspection and existing
scoped reconciliation instead of scanning every blob and event before usability.
Long operations report progress.

### Immediate rollback and historical restore

Immediate migration rollback is allowed only for the exact pinned checkpoint
while normal writers, task effects, and future sync publication remained fenced.
The journal must prove no normal admission after that checkpoint. Otherwise use
the historical-restore path.

Historical restore is a user-selected operation:

1. Show backup time/scope, retain the current dataset, and confirm replacement.
2. Persist a fresh local recovery generation and admission fence outside the
   payload set being replaced. Keep it through crash/restart; an old manifest
   or lease table cannot overwrite this authority.
3. Restore and validate with automatic Task delivery, schedules, delegated
   continuation, Profile/Memory publication, and future sync upload disabled.
   Reading restored records does not authorize execution.
4. Owners classify pending work and reconcile independently verified evidence.
   A missing receipt means uncertain outcome, not permission to retry. Retain
   unresolved tasks for explicit resolution; do not invent success or delete
   history. Re-enabling a schedule governs future occurrences and cannot replay
   restored pending occurrences.
5. Keep content readable while authority remains fenced. Resume only verified
   or newly authorized work with fresh ownership.

Future replica repair retains unsynced work and rejoins from a valid causal
frontier with fresh local/session authority. An old snapshot must not be
broadcast as new writes. A shared undo requires explicitly authorized
compensating changes against current history, or recovery into a separate
document. This foundation records/tests the boundary locally; it does not ship
remote repair or shared-undo UI.

### Recovery surface

Expose domain availability independently from operation phase (`inspecting`,
`backingUp`, `migrating`, `restoring`, `rebuilding`, `recoveryRequired`). Show
scope, retained originals, backup validity, progress, and permitted actions.
Offer only actions supported by compatible recovery owners.

Provide retry inspection, resume the exact operation, verified-backup restore
with confirmation, scoped Thread recovery, configuration repair, bounded
redacted diagnostics, and quit. Unknown formats remain intact for a compatible
binary or explicit recovery/export. No default reset or speculative success.
Renderer cannot select physical paths, Store IDs, or process identities.

### Complete delivery units

#### Feature 1: local compatibility, backup, and recovery

Deliver the complete inventory and baseline inspection/backup/restore adapters,
manifest/journal durability, writer barrier, startup recovery surface, fault
isolation, historical-restore fences, populated fixtures, failure driver, and
local two-replica checks in one feature. Same-format restore exercises staged
installation immediately; no later feature is needed to make it useful.

Admit exact baseline formats and refuse unsupported ones. Establish version
ownership without inventing a fake data change. If baseline introduction truly
changes a representation, include that real source/target transformation and
fixtures in this feature.

Implementation scope includes main/Desktop lifecycle, Outline Runtime/client
ownership, physical Store adapters/codecs, recovery owners, startup/preload/UI/
i18n, focused Core/renderer/Electron tests, and affected architecture/Agent specs.
Coordinate shared Core protocol/type files, `AGENTS.md`, and spec-index ownership
before implementation; never duplicate a protocol to avoid coordination.
Existing Task/Project/Memory contracts are dependencies to preserve, not parallel
features reserved by this plan.

#### Feature 2: automated release compatibility enforcement

Integrate Feature 1's existing fixture/restore/failure driver with the main-owned
release workflow. Preserve one immutable populated fixture per supported release
with exact application/library provenance and semantic expectations. Exercise
supported direct upgrade paths, not only the previous version, and reopen the
results with production owners.

Publish evidence as release artifacts and block publication on missing/failing
coverage. This feature adds automation, not the first migration tests or restore
capability. Before it ships, run the same driver as a mandatory manual release
check. Main owns workflow/checklist changes. Each real domain schema change
includes its migration, retained reader or rewrite, and fixtures in its own PR.

## Open questions

- Which release establishes the baseline? Recommended: the first train carrying
  all of Feature 1. Main/PM ratify the train at release freeze.
- What local upgrade window is supported? Recommended: every published release
  from that baseline. A shorter window needs an explicit bridge/export policy.
- Does the foundation include exporting backups outside userData? Recommended:
  local verified restore first; export needs a native destination choice and an
  owner-defined credential/key policy.
- Before sync ships, what offline/rejoin horizon, incompatible-client experience,
  encryption/key-recovery policy, and shared history retention are supported?
  Preserve identity and causal data now; local migrations cannot choose a
  silent retention cutoff.
- Before shared schedules ship, does a server or selected device authorize
  execution? Either choice needs stable action identity and remote fencing;
  synchronized records alone never authorize execution.

## Acceptance criteria

### Foundation and local failure coverage

- **AC-L1:** Empty initialization resumes its journal and establishes the
  baseline only after required validation. Exact populated pre-baseline fixtures
  are classified without normal constructor writes or automatic clearing.
- **AC-L2:** Future manifest/physical/payload versions preserve managed bytes
  and report scoped errors. A compatible neighboring Store cannot bypass the
  incompatible Store's fence.
- **AC-L3:** Detached Runtime and racing CLI starts cannot write, compact, or
  GC during backup/install. Unverifiable writers block maintenance; a crashed
  maintenance owner is recovered before another writer opens.
- **AC-L4:** All canonical/operational paths are covered, including WAL-only
  commits, payloads/blobs, and pending journals. Backup failure/disk-full blocks
  mutation; retries cannot evict the pinned pre-operation backup.
- **AC-L5:** Single-database rollback preserves both data and version. A database
  shared by several domain owners has one physical migration transaction owner.
- **AC-L6:** Inject failure at intent persistence, file/directory sync, database
  commit, staged validation, every path replacement, completion receipt, and
  admission handoff. Restart completes the operation or restores its checkpoint;
  old WAL cannot alter an installed database. Include process-kill and explicit
  failed/lost-write injection; process kill alone does not prove power-loss safety.
- **AC-L7:** A corrupt Thread leaves healthy Outline usable and its recovery
  reachable without normal Agent readiness. Pending targeted recovery resumes
  before final checks assume its closure is complete.
- **AC-L8:** Derived failures affect only dependent surfaces; incomplete source
  coverage prevents destructive projection rebuilding.
- **AC-L9:** Restore a backup containing a pending action that later produced an
  external effect. Across restart it does not rerun automatically, its fence
  survives, and content remains readable. Re-enabling schedules cannot replay
  restored historical occurrences.
- **AC-L10:** Restored fixtures reopen through production owners with equivalent
  content, identity, provenance, references, and receipts. Retry/cancel/quit
  cannot admit late writers or discard retained originals.

### Local tests for future synchronization constraints

Use the exact Loro version resolved by `bun.lock` and verify that the installed
package matches it before running migration experiments or two-replica tests.
Record the manifest range, lockfile revision, and resolved runtime version;
label other package versions as separate compatibility probes. Use two isolated
Core replicas, synthetic old/new capability views, and no production network
service:

- **AC-S1:** Physical migration preserves shared IDs, causal updates, and
  compatible unknown fields. A second replica has distinct local/session
  identity without reseeding shared defaults.
- **AC-S2:** Independent compatible logical migrations plus concurrent edits
  converge without duplicated logical records or erased edits. An unproven
  transformation is refused or requires future shared migration authority;
  local version markers do not supply that authority.
- **AC-S3:** Unsupported shared semantics fence their scope while preserving
  bytes and unsynced edits. Duplicate/reordered updates retain identity and
  provenance through current Core replication primitives.
- **AC-S4:** Old snapshot import cannot masquerade as shared rollback.
  Historical restore retains execution/sync fences; a stale causal frontier
  cannot be silently trimmed or relabeled as original history.
- **AC-S5:** Portability classification and serialization checks reject local
  process/path/credential authority as transferable state. Reading replicated
  Task facts cannot invoke execution, and missing local blobs cannot imply
  shared deletion.

These are foundation constraints/local simulations. Remote authorization,
transport, actual mixed-version clients, offline rebootstrap, and distributed
execution require their own end-to-end acceptance in the sync feature.

### Release enforcement

- **AC-R1:** Upgrade populated fixtures from every supported source release and
  verify Threads, Outline, Profile, Memory, Tasks, schedules, Delegation,
  Projects, resources, attachments, and recovery evidence.
- **AC-R2:** Every real schema change includes migration/reader, source fixture,
  semantic expectations, and relevant failure/restore checks in the same feature.
  Same-format reopen is not evidence for an unspecified future migration.
- **AC-R3:** CI runs the same driver, publishes exact runtime/library provenance,
  and blocks release when coverage/restore evidence is missing. No destructive
  fixture reset substitutes for an upgrade test.
