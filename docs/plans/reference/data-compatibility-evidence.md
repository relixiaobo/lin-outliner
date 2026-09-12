# Data Compatibility and Real-Time Sync Evidence

## Recommendation

Tenon should combine versioned local storage with independently versioned shared
data, and reserve coordinated staging for changes that actually cross storage
boundaries. A local database upgrade, a collaborative document transformation,
and restoration of historical content are different operations. One global
format epoch and a universal copy-and-replace algorithm cannot make all three
safe.

The recommended foundation has five properties:

- Each physical SQLite database owns transactional schema migration and its
  version record. A thin lifecycle coordinator controls admission, consistent
  backup, and recovery across databases and files.
- Shared document semantics, serialized event kinds, and future synchronization
  capabilities have separate compatibility contracts. Local maintenance does
  not rewrite collaborative history or emit user edits.
- Recovery is scoped to the affected domain or document whenever its boundaries
  are known. An unavailable derived index does not justify restoring canonical
  data, and a damaged conversation does not disable healthy Outline content.
- Restoring a historical backup preserves evidence but does not restore expired
  execution authority or permission to overwrite another replica. Local rollback,
  replica repair, and an intentional shared undo have distinct entry conditions.
- Upgrade tests include failures and multiple replicas from the first supported
  baseline. Release automation consumes those tests; it does not introduce the
  first recovery coverage after migrations have already shipped.

These recommendations preserve the current TypeScript/Electron process seam,
Runtime-owned Loro document, ContentStore, and domain Stores. They do not choose
a sync hosting provider or replace existing storage with a replicated SQL
product. The executable design is maintained in the
[foundation plan](../data-compatibility-foundation.md).

## Scope and evidence quality

The comparison covers application database upgrades, backups, corruption
handling, synchronization versioning, CRDT history, and external side effects.
The primary evidence is official documentation and source code pinned to the
versions below. The examples were selected for architectural relevance; this is
not a market-share ranking or a claim that every product offers the same safety
guarantees.

| Project | Source version | Relevant observation | Limit of comparison |
| --- | --- | --- | --- |
| Joplin | v3.7.18, `ce254820` | Transactional profile migrations; separate sync-target version and exclusive upgrade lock | Item synchronization is not a model for simultaneous rich-text editing |
| Zotero | tag 10.0.2, `d9e553b6` | Separate schema and compatibility counters; protected pre-upgrade backup; targeted corruption handling | Its database and library synchronization model differs from a CRDT editor |
| Signal Desktop | v8.27.0, `1a1d6515` | Monotonic migrations, future-version rejection, transaction boundaries, separate FTS repair | Message delivery and encrypted backup have additional protocols not evaluated here |
| TriliumNext | v0.105.0, `a0908a6e` | Backup before transactional migration; different bootstrap paths for new and synchronized databases | Its synchronization policy does not establish mixed-version CRDT compatibility |
| VS Code | 1.137.0, `645f29cc` | State-database backup and in-memory fallback | Workspace UI state has a different loss tolerance from canonical notes |
| n8n | 2.38.7, `a2d0f763` | Migration transaction/lock strategy changes with deployment topology | Its single-instance SQLite assumption does not hold for Tenon's detached Runtime |
| AFFiNE / BlockSuite | v0.27.4, `b4c8548c` | Local schema migrations, document updates, block schemas, blobs, and peer clocks are distinct | Separation is observable; universal mixed-version safety is not established by these files |
| Loro | Official current docs; Tenon probe pinned to 1.10.6 | Causal update exchange, session peer identity, history-retention constraints | Current docs describe APIs newer than Tenon's declared dependency |
| Automerge / Yjs | Official current docs | Concurrent migration hazards and session identity constraints | Their concrete encodings and migration examples are not interchangeable with Loro |

Repository release records and source snapshots were inspected on 2026-09-12.
Zotero's source was pinned through its tag because a GitHub latest-release record
was unavailable; its tag commit is dated 2026-09-09. Other application snapshots
use the published releases identified in the source register. No external
application was installed or subjected to its full test suite. Source-backed
observations, isolated experiments, and Tenon-specific recommendations are
distinguished below.

## Physical storage guarantees

### Transactions are the default unit for one database

SQLite provides atomic transactions inside one database. Application schema
changes and the application's schema-version update should commit together;
otherwise a crash can leave a version marker that describes data which never
committed. SQLite's internal `schema_version` is not an application migration
ledger. Signal uses `user_version`, while Joplin and Zotero use application
tables. The important property is ownership and transactional coupling, not the
choice of an integer field name.[^1][^6][^9][^11][^28]

This supports a simpler design than staging every database for every change.
A migration containing only transactional changes to one physical database can
run through its owner after a verified backup. Operations which leave that
database, rewrite logs, alter published files, or require nontransactional steps
need an explicit broader protocol. The existing sharing of `goals.sqlite` by
Goal and Tool Task owners, and `state.sqlite` by catalog and Project owners,
means the migration unit cannot simply be one adapter per TypeScript class.

### WAL-aware backup is necessary but not globally consistent by itself

Committed pages may exist only in a SQLite WAL. Copying the main database file
while writers remain active is not a complete backup. SQLite's backup API and
`VACUUM INTO` can produce consistent database snapshots, but each snapshot
describes its own observation point. Sequentially snapshotting several databases
while a task continues to update them does not establish a common application
checkpoint.[^2][^3][^4]

`ATTACH` is not a shortcut to atomicity across Tenon's current WAL databases.
SQLite explicitly limits cross-database crash atomicity when WAL is in use:
individual databases remain atomic, but a host crash can leave only some of a
multi-database transaction committed.[^5] Tenon therefore needs a writer fence
covering all participating owners and a dataset-level recovery record when a
change spans them.

SQLite's current `VACUUM INTO` documentation specifies output flushing when the
source connection uses `synchronous=NORMAL` or `FULL`; interruption during the
operation can still leave incomplete output.[^4] Completion of a database
snapshot also does not make a surrounding JSON inventory, directory rename, or
backup-completion marker durable. Those records need their own persistence
ordering and validation.

### Replacement includes journals, handles, and directory entries

Zotero's recovery code explicitly handles `-wal`, `-journal`, and `-shm` alongside
database replacement. Its comments explain that a journal is associated with a
database filename and may be replayed against the wrong replacement file. Its
compaction path closes the connection and abandons the swap if writes occurred
after the snapshot began.[^10]

The consequence for Tenon is concrete: a staged database must be validated and
closed, source journals must remain associated with their retained source,
active paths must be free of stale source journals, and the installation intent
must be durable before the rename. Normal owners cannot reopen during the swap.
An atomic rename alone is insufficient; SQLite's durability discussion also
distinguishes file flushing from directory-entry persistence.[^1]

## Application implementation findings

### Joplin: separate local and shared compatibility

`JoplinDatabase.upgradeDatabase` follows a numbered migration sequence, appends
the version-table update to the query batch, and executes that batch
transactionally. An unrecognized newer profile version produces an upgrade
message. Some historical FTS migrations have an explicit fallback that permits
operation without the index; those are narrow exceptions, not a general policy
to ignore canonical migration failure.[^6]

`MigrationHandler` independently checks the synchronization target's version.
It rejects both a client that cannot understand a newer target and a target
requiring upgrade. Target migration obtains an exclusive lock, refreshes it,
and checks for loss of that lock. The synchronization specification separately
describes `info.json`, `appMinVersion`, item data, and per-target synchronization
tracking.[^7][^8]

Tenon should adopt the separation of compatibility domains. It should not copy
Joplin's exact remote-file locking scheme or require a global synchronized
upgrade for every additive document field. Joplin's periodic item synchronization
also does not prove that its conflict policy is suitable for concurrent
outliner operations.

### Zotero: compatibility gates and preservation of the last useful backup

`Zotero.Schema.updateSchema` distinguishes the last applied `userdata` migration
from a `compatibility` counter that explicitly marks incompatibility with older
applications. It records the last compatible application version for a useful
error message. Before certain updates it tracks the backup's target state so
repeated failed starts do not rotate the pre-update backup out of retention.[^9]

The database owner distinguishes canonical corruption from failures in attached,
rebuildable databases before offering canonical recovery. This is directly
relevant to Tenon's A12 rule and its recently shipped per-Thread recovery. The
same owner also implements journal-aware file replacement.[^10] These details
support scoped recovery and operation-pinned backups; they do not establish that
every Zotero backup or recovery path should be reused unchanged.

### Signal Desktop: explicit migration order and specialized repair

`updateSchema` checks that migration versions are monotonic and rejects a
database newer than its known maximum. It runs as many steps as possible in a
transaction, with explicit boundaries when a migration requires `VACUUM`.
`user_version` is updated inside the corresponding transaction.[^11]

`runCorruptionChecks` independently checks database integrity and the FTS index.
It attempts an FTS rebuild and then checks again.[^12] For Tenon, this reinforces
two rules: use a real migration ledger, and make repair policies depend on the
authority of the damaged data. Signal's implementation is not evidence that
restoring a local task ledger can undo an already executed external action.

### TriliumNext: backup before migration and sync-aware bootstrap

Trilium's migration service creates a pre-migration backup and executes its
ordered migration steps inside a database transaction. It refuses unsupported
old databases and, absent an explicit environment override, newer databases.
Some migration entries can opt into ignoring errors; this is an application
policy, not a property of transaction atomicity.[^13]

Its initialization paths distinguish creating a fresh database from creating a
database that will synchronize with an existing server. The latter deliberately
avoids seeding certain synchronized defaults that would overwrite server
values.[^14] Tenon's empty local directory must likewise not imply a new shared
workspace once multi-device provisioning exists. The shared workspace identity
and initialization history must come from the provisioning operation.

### VS Code and n8n: deployment assumptions determine the safe boundary

VS Code's state storage backs up a successfully closed database and can fall
back through a backup to an in-memory database. It also has a path to recreate
state from the in-memory map.[^15] This is useful precedent for keeping the UI
usable when expendable state storage fails. Applying that policy to Tenon's
canonical notes, conversation history, or task receipts would permit silent
loss and is inappropriate.

n8n uses per-migration transactions for SQLite and a PostgreSQL advisory lock
with one transaction-scoped connection for concurrent server migrations.[^16]
Its source explicitly assumes SQLite runs in a single instance. Tenon cannot
inherit that assumption: Electron's single-instance lock does not cover its
detached Outline Runtime, CLI starts, or task supervisors. A framework migration
runner does not remove the need to define process ownership.

### AFFiNE and BlockSuite: physical storage is not the shared document model

AFFiNE's IndexedDB schema has its own ordered migrations and stores snapshots,
updates, blobs, peer clocks, and indexing progress separately. The document
storage API exchanges Yjs binary updates and state-vector differences; blob
storage is a separate capability. BlockSuite schemas carry their own block
versions and validate block relationships.[^17][^18][^19]

This is strong evidence for separating local persistence, shared document
semantics, binary content, and synchronization bookkeeping. It is not evidence
that CRDT updates can be applied without application-level compatibility checks.
The inspected schema and storage files do not prove a general solution for
arbitrary old/new editor combinations, so Tenon still needs explicit mixed-version
acceptance scenarios.

## Real-time synchronization constraints

### Version domains and identity

At least four version domains have different purposes: local storage layout,
shared logical data, the CRDT encoding used for document history, and network
capabilities. A change to a local index may affect only the first. A new document
operation may affect shared semantics and client capabilities without changing
SQLite. A Loro dependency upgrade may change neither, or require an explicit
encoding compatibility check. An application release number identifies the
binary but does not substitute for any of these contracts.

Tenon already distinguishes shared `workspaceId` and `documentId` from local
`installationId` and `replicaId` in Core, and gives new Loro sessions fresh peers.
Those owners should remain authoritative.[^27] Loro identifies operations by
peer and counter and warns against reusing a peer without its full corresponding
local history. Yjs separately warns that duplicate live client identities can
permanently corrupt a document.[^20][^24] Device identity, logical document
identity, and editing-session identity must therefore not be collapsed into a
single manifest UUID.

### Convergence is weaker than semantic correctness

Automerge's modeling guide explicitly warns that two users may independently
perform the same migration and that the resulting changes may clash. Its
illustrative deterministic-change technique depends on that engine's change
identity model; copying a hard-coded actor ID into Loro would not be a justified
implementation.[^23]

Loro guarantees convergence when peers receive the same updates, regardless of
order or duplication, but its current sync guide also explains that concurrent
creation of child containers can hide one container behind a map conflict.
Newer APIs address particular modeling cases; they are not a universal schema
migration service.[^21] The isolated probe below demonstrates a simpler failure:
two individually idempotent list migrations converge to duplicated logical data.

Tenon's default should be additive shared evolution with stable logical
identities, preservation of unknown compatible fields, and separately negotiated
read/write capabilities. Destructive transformations require either a proven
convergent operation design or an explicit shared migration authority that can
fence incompatible writers. A local SQLite lock has no authority over an offline
device. A local `schemaVersion = 2` marker cannot prove that all replicas have
completed the transformation.

### History, deletion, and offline return

Loro's shallow snapshots intentionally remove older history and limit which
peers can synchronize with the resulting document. Its documentation calls for
coordination before trimming.[^22] Snapshot compaction that preserves the full
causal history and history truncation that removes dependencies must be treated
as different operations.

An offline device may return after a schema transition, a deletion, or retention
cleanup. Before admitting its uploads, the future sync layer needs to know
whether its encoding, capabilities, workspace lineage, and retained causal
frontier are still supported. Missing history cannot be repaired by labeling a
full JSON export as the original document. Any rebootstrap path must first
retain unsynchronized work and make the recovery choice explicit.

Blob retention follows the same distinction. Content bytes can be addressed by
stable identities while each device independently stores paths and cache state.
A missing local file must not become a shared deletion. Current local GC and
backup pinning do not establish a future global deletion watermark. Remote
acknowledgements, revocation, retention, and the maximum offline interval belong
to the sync retention contract.

### Replicated records do not grant execution authority

Temporal recommends idempotent Activities because activity attempts can restart,
and AWS's transactional outbox guidance still requires idempotent consumers when
messages are delivered more than once.[^25][^26] Persisting an event and a local
receipt atomically solves only the local commit problem. Restoring both to an
earlier time can erase knowledge of an external action that already occurred.

This becomes more important across devices. Synchronizing a schedule definition,
task request, result, or acknowledgement cannot authorize every receiving device
to run it. Execution needs a designated authority, a stable logical action ID,
and a lease/fencing or equivalent ownership protocol. The owner may ultimately
be a server or a chosen device; that product choice remains open. Process IDs,
worktree paths, access tokens, and local socket capabilities must not be copied
as transferable authority.

## Recovery semantics

| Operation | Safe precondition | Meaning | Admission after recovery |
| --- | --- | --- | --- |
| Immediate migration rollback | Exact pre-operation backup; all relevant writers and external publication remained fenced | Restore the dataset that preceded this local operation | Resume only after local owners and journals validate |
| Historical backup recovery | Preserve current data first; historical snapshot is independently verified | Inspect or recover an earlier dataset, possibly missing later local and remote facts | Keep automatic execution and future sync paused |
| Replica repair | Proven shared lineage; authoritative updates and unsynced local work retained | Reconstruct a local replica from causal history | Rejoin through fresh session identity and capability checks |
| Intentional shared restore | Current shared history and permissions available; explicit user-selected changes | Publish new compensating edits or import into a separate logical document | Ordinary synchronization of the newly authorized changes |

A historical backup is not a time machine for other replicas. Importing an old
Loro snapshot into a document that already has newer updates merges history; it
does not delete those newer updates. Replacing a local database and allowing it
to upload reconstructed old values as new changes can instead overwrite newer
work. Neither behavior is an acceptable implicit interpretation of Restore.

For example, a backup contains a pending scheduled action; the action later
modifies a project; the user restores that backup. Both the pending record and
the missing completion receipt now suggest execution, but the project change
still exists. A new local recovery generation should invalidate stale execution
claims and keep restored pending work paused. Owners can reconcile verified
receipts or expose unresolved work; they must not fabricate success, silently
delete history, or relaunch an uncertain action merely because its receipt is
absent.

Recovery fences must survive restart independently of the historical data being
installed. Otherwise restoring the manifest or control database restores away
the fence itself. Backup retention must likewise protect the exact pre-operation
backup throughout retries, rather than allowing repeated attempts to evict it.

## Alternatives and tradeoffs

| Approach | Strength | Cost or gap | Fit for Tenon |
| --- | --- | --- | --- |
| Migration framework alone | Familiar ordered SQL changes and version tracking | No cross-file checkpoint, process fencing, CRDT evolution, or historical-restore semantics | Useful inside domain owners only |
| Stage and replace every Store on every upgrade | Uniform install model and retained originals | Repeated copying, WAL/handle hazards, broad downtime; still no distributed semantic guarantee | Reserve for destructive or coupled changes |
| Transaction-first local migration plus separate shared compatibility | Uses SQLite's natural boundary and preserves existing owners; supports mixed-version policy | Requires a precise registry, recovery states, and tests at the boundaries | Recommended |
| Consolidate everything into one replicated database or CRDT | Fewer apparent storage boundaries | Large rewrite; binary assets and external task effects still need separate protocols | Not justified by this compatibility requirement |

The recommendation is conditional on the present architecture, not a universal
ranking. It minimizes new coordination where a database already supplies
atomicity and introduces coordination where independent processes, files,
replicas, or side effects make that atomicity insufficient. No latency or disk
overhead advantage is claimed without measurement.

## Isolated experiments

The experiments below used disposable data only. SQLite was Python's linked
SQLite 3.53.3; this verifies storage behavior, not Electron's bundled SQLite
build or filesystem power-loss behavior. The CRDT probes were repeated against
a separately downloaded `loro-crdt@1.10.6`, matching `package.json`. The existing
`node_modules` copy was 1.12.1, so its initial results were not used as the sole
evidence for the declared dependency. Both Loro versions produced the same
observed outcomes.

| Probe | Construction | Observed result | Design consequence |
| --- | --- | --- | --- |
| Transaction rollback | In one transaction add a column, change a row, set `user_version=2`, then inject an exception before commit | Version remained 1, added column absent, original row retained | Commit data and version together |
| Main-file swap with stale WAL | Retain a committed source WAL, install a migrated standalone database at the same main-file path, reopen | Version and columns described v2, but the row came from the old WAL | Validate contents, not only version; install the whole journal-aware file set |
| Concurrent local migrations | Two replicas load one seed; each appends a record only while `schemaVersion=1`, then sets it to 2; merge updates | Both converged to two copies of the migration-created record, even though rerunning on one replica did nothing | Local idempotence is not concurrent migration safety |
| Import historical snapshot | Add a later edit, then import the original snapshot into that same history | Later edit remained | Snapshot import is not a shared rollback |

The minimal CRDT counterexample is reproducible with the declared Loro package:

```ts
const seed = new LoroDoc();
seed.getMap('meta').set('schemaVersion', 1);
seed.getList('records').push('original');
seed.commit();
const initial = seed.export({ mode: 'snapshot' });
const replicas = [new LoroDoc(), new LoroDoc()];
for (const doc of replicas) {
  doc.import(initial);
  if (doc.getMap('meta').get('schemaVersion') === 1) {
    doc.getList('records').push('migration-created-record');
    doc.getMap('meta').set('schemaVersion', 2);
    doc.commit();
  }
}
const updates = replicas.map(doc => doc.export({ mode: 'update' }));
replicas[0].import(updates[1]);
replicas[1].import(updates[0]);
// Both lists contain two migration-created records.
```

These probes are counterexamples to unsafe assumptions, not a complete migration
test suite. The implementation must add process-kill injection, disk-full and
sync-failure injection, real Store fixtures, and compatibility matrices. Killing
a process alone does not simulate a machine losing buffered writes.

## Decisions that remain product-specific

The first supported release and supported upgrade window require release-policy
ratification. The default recommendation is the first release that contains the
complete foundation, with upgrade support for every published release from that
baseline. Pre-baseline data must be classified by exact known format, not guessed
from the absence of a manifest.

The first sync release must additionally settle the maximum supported offline
interval, how incompatible devices preserve and export unsynced edits, the
authority for scheduled execution, and the user-facing choice between recovering
content into a separate document and publishing a shared undo. Encryption and
key recovery influence backup portability and shared storage, but selecting a
provider or encryption scheme is not necessary for the local foundation.

The foundation should enforce identity preservation, retention of opaque
unsupported data, durable recovery fences, and future-version refusal now.
Two-replica Core fixtures can test causal preservation without shipping a
network transport. Server authorization, device enrollment, remote fencing, and
real network partitions remain acceptance requirements of the later sync
feature, not capabilities claimed by those fixtures.

## Sources

Official documentation was accessed on 2026-09-12. Source links below are pinned
to exact commits; names denote the inspected functions or documents rather than
line anchors. The application snapshots are Joplin v3.7.18 (2026-09-11), Signal
Desktop v8.27.0 (2026-09-10), TriliumNext v0.105.0 (2026-08-19), VS Code 1.137.0
(2026-09-09), n8n 2.38.7 (2026-09-11), and AFFiNE v0.27.4 (2026-08-18).

[^1]: SQLite. [Atomic Commit In SQLite](https://www.sqlite.org/atomiccommit.html). Transaction, journal, file-flush, and directory-durability model.

[^2]: SQLite. [Write-Ahead Logging](https://www.sqlite.org/wal.html). WAL persistence, concurrency, and checkpoint semantics.

[^3]: SQLite. [Online Backup API](https://www.sqlite.org/backup.html). Consistent per-database snapshots and unsafe live-file copying.

[^4]: SQLite. [VACUUM](https://www.sqlite.org/lang_vacuum.html). `VACUUM INTO`, interruption, and output synchronization conditions.

[^5]: SQLite. [ATTACH DATABASE](https://www.sqlite.org/lang_attach.html). Limits of cross-database atomicity in WAL mode.

[^6]: Joplin. [JoplinDatabase.ts](https://github.com/laurent22/joplin/blob/ce254820977ea3fb2559638f722960dfc60e1cb1/packages/lib/JoplinDatabase.ts). `upgradeDatabase`, version batch updates, and FTS exceptions.

[^7]: Joplin. [MigrationHandler.ts](https://github.com/laurent22/joplin/blob/ce254820977ea3fb2559638f722960dfc60e1cb1/packages/lib/services/synchronizer/MigrationHandler.ts). `checkCanSync` and exclusive sync-target migration.

[^8]: Joplin. [Joplin synchronisation](https://github.com/laurent22/joplin/blob/ce254820977ea3fb2559638f722960dfc60e1cb1/readme/dev/spec/sync.md). Local/offline behavior, sync state, target version, and minimum client version.

[^9]: Zotero. [schema.js](https://github.com/zotero/zotero/blob/d9e553b60cf0a06aac3029e7117c5666b6cc1e6a/chrome/content/zotero/xpcom/schema.js). `updateSchema`, compatibility counter, last compatible client, and repeated-attempt backup protection.

[^10]: Zotero. [db.js](https://github.com/zotero/zotero/blob/d9e553b60cf0a06aac3029e7117c5666b6cc1e6a/chrome/content/zotero/xpcom/db.js). Scoped corruption handling, `_moveJournalFiles`, `_removeJournalFiles`, and guarded compaction swap.

[^11]: Signal Desktop. [SQL migrations](https://github.com/signalapp/Signal-Desktop/blob/1a1d65153be546836d5948cb50493d4d1d293d02/ts/sql/migrations/index.node.ts). `updateSchema` and `DBVersionFromFutureError`.

[^12]: Signal Desktop. [SQL Server](https://github.com/signalapp/Signal-Desktop/blob/1a1d65153be546836d5948cb50493d4d1d293d02/ts/sql/Server.node.ts). `runCorruptionChecks` and FTS rebuild.

[^13]: TriliumNext. [migration.ts](https://github.com/TriliumNext/Trilium/blob/a0908a6e1e1741a3c3824d803da07300183dcb0c/packages/trilium-core/src/services/migration.ts). Pre-migration backup, transaction, and version admission.

[^14]: TriliumNext. [sql_init.ts](https://github.com/TriliumNext/Trilium/blob/a0908a6e1e1741a3c3824d803da07300183dcb0c/packages/trilium-core/src/services/sql_init.ts). `createInitialDatabase` and `createDatabaseForSync`.

[^15]: VS Code. [SQLite state storage](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/base/parts/storage/node/storage.ts). Close-time backup and open/recovery fallbacks.

[^16]: n8n. [DbConnection](https://github.com/n8n-io/n8n/blob/a2d0f7638bbb7582e33a4dfa1537eeb8ff066788/packages/@n8n/db/src/connection/db-connection.ts). `migrate` and `migrateWithAdvisoryLock`.

[^17]: AFFiNE. [IndexedDB schema](https://github.com/toeverything/AFFiNE/blob/b4c8548c09da21b2898443559a5b846f0ccf5dd8/packages/common/nbstore/src/impls/idb/schema.ts). Local migration sequence, document storage, peer clocks, blobs, and indexes.

[^18]: AFFiNE. [Document storage](https://github.com/toeverything/AFFiNE/blob/b4c8548c09da21b2898443559a5b846f0ccf5dd8/packages/common/nbstore/src/storage/doc.ts) and [blob storage](https://github.com/toeverything/AFFiNE/blob/b4c8548c09da21b2898443559a5b846f0ccf5dd8/packages/common/nbstore/src/storage/blob.ts). Separate capabilities and CRDT update exchange.

[^19]: BlockSuite. [Block Schema](https://github.com/toeverything/AFFiNE/blob/b4c8548c09da21b2898443559a5b846f0ccf5dd8/blocksuite/docs-site/guide/block-schema.md) and [Schema implementation](https://github.com/toeverything/AFFiNE/blob/b4c8548c09da21b2898443559a5b846f0ccf5dd8/blocksuite/framework/store/src/schema/schema.ts). Block versions and relationship validation.

[^20]: Loro. [PeerID Management](https://loro.dev/docs/concepts/peerid_management). Operation identity and peer reuse requirements.

[^21]: Loro. [Sync](https://loro.dev/docs/tutorial/sync). Update exchange, convergence, and child-container identity limitations. Current API examples must be checked against Tenon's pinned dependency.

[^22]: Loro. [Shallow Snapshots](https://loro.dev/docs/concepts/shallow_snapshots). Truncated history and synchronization limits.

[^23]: Automerge. [Modeling Data](https://automerge.org/docs/cookbook/modeling-data/). Concurrent schema initialization/migration and old/new client compatibility; illustrative API examples include older Automerge types.

[^24]: Yjs. [FAQ](https://docs.yjs.dev/api/faq). Risks of retaining the same live ClientID across sessions.

[^25]: Temporal. [Activities](https://docs.temporal.io/activities). Idempotency recommendations and activity attempt recovery.

[^26]: AWS Prescriptive Guidance. [Transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). Dual-write coordination and duplicate-consumer handling; queue guarantees do not by themselves make arbitrary external effects exactly once.

[^27]: Tenon. [Architecture specification](../../spec/architecture.md), [Core](../../../src/core/core.ts), and [LoroDocument](../../../src/core/loroDocument.ts), inspected at `4bd4a072`. Existing identity, replication primitives, and Runtime boundary.

[^28]: SQLite. [PRAGMA statements](https://www.sqlite.org/pragma.html). Application-owned `user_version`, engine-owned `schema_version`, and synchronization settings.
