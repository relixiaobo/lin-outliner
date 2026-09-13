# Data lifecycle

The data lifecycle owner implements the local compatibility, backup, and
recovery feature from [the foundation design](../../../docs/plans/archive/data-compatibility-foundation.md).
It coordinates physical Store adapters and existing Runtime ownership. Store
owners remain responsible for schema and semantic validation; Desktop lifecycle
remains responsible for window visibility, retry, and quit.

The renderer protocol uses opaque operation and backup IDs. Recovery journals
and admission fences are outside the data they replace. Historical restoration
does not restore automatic execution authority or future sync admission.

`DataStoreRegistry` consumes the same schema declarations as normal Store
constructors and groups owners sharing a physical SQLite file. `DataBackupStore`
seals verified manifests; `DataRestoreSession` and `HistoryRepairSession` stage
and install data under `DataOperationJournal`. `DataWriterBarrier` owns process
exclusivity and delegates Outline inspection to its Runtime process.

`RestoredExecutionFence` classifies historical work before normal producers start.
Task, Goal, schedule, delegation, Profile, and Memory owners consume that policy;
the coordinator does not grant execution authority by copying data.

The current behavior is specified in [data lifecycle](../../../docs/spec/data-lifecycle.md).
Run `bun scripts/check-data-lifecycle.ts` for a disposable populated fixture
check. Focused tests are the `tests/core/dataLifecycle*.test.ts` suites and the
real-Electron `tests/smoke/data-lifecycle.smoke.ts` flow.
