# Memory Operations For People And Agents

## Goal

Complete Unit E1 of [File-First Settings](settings-control-plane.md) in one PR:
people and root Agents can inspect Memory, open the real Memory Nodes, change
one persistent root user Thread's mode, and request the same confirmed Reset.
Ship the owner, human and Agent routes, recovery, tests, and spec changes
together. No follow-up PR is required to make this feature usable.

## Non-goals

- No Settings/Configuration CLI, universal settings tool, or private-store edits.
- No Memory-content tools: retrieval, remember, edit, and forget remain ordinary
  Outline operations. Management cannot bypass Memory provenance or admission.
- No new global preference writer. `agent.memory.enabled` remains file-backed;
  per-Thread mode remains Thread-scoped state owned by Memory.
- No new extraction model, admission policy, document format, migration reader,
  Memory dashboard, or redesign of the full Settings shell.
- No implementation of the other E features, configurable shortcuts, or G.

## Design

### Ownership And Operations

Keep `MemoryExtension`, `MemoryControlStore`, and `TimelineMemoryStore` as the
owners of admission, worker state, canonical Nodes, Reset, and recovery. Extract
operation orchestration from `handleMemoryCommand` into a Memory-owned Host
facade consumed by renderer transport and Agent tools. Each adapter validates
its real caller; an Agent request never impersonates a Settings window.

| Intent | Route | Completion evidence |
| --- | --- | --- |
| Global enable/disable | Edit `agent.memory.enabled`; existing UI edits the same file | Current Host configuration status and effective mode |
| Inspect Memory or a Thread mode | `memory_inspect` | Bounded status, exact requested Thread, application boundary |
| Open Memory | `memory_manage`, operation `open` | Saved `#d-memory` search target and separate navigation outcome |
| Set one Thread's mode | `memory_manage`, operation `set_thread_mode` | Exact Thread, resulting mode/revision, subsequent-admission boundary |
| Reset Memory | `memory_manage`, operation `reset` | Native decision, existing durable Reset operation identity and resulting epoch, or explicit non-success |

These proposed tools are canonical root-only domain contributions. Object-rooted
schemas reject unknown fields and illegal operation/argument combinations;
complete bounded output schemas use the canonical Tenon result envelope.
Inspection and management have separate action descriptors. Reset additionally
honors `outline.delete`; Open Memory honors `outline.edit` when ensuring the
saved search. Static exposure must not require destructive authority merely to
inspect Memory or change a Thread mode.

Inspection returns worker freshness, bounded redacted errors, pending and stray
counts, effective global mode, and relevant generations. It exposes no Memory
prose, private paths, SQLite rows, or Node inventory, and uses owner/index metadata
rather than adding full-content scans or model work. Global desired/accepted
state stays in configuration status, not a duplicate Memory settings object.

An explicit canonical Thread ID is required to manage another Thread. Omission
can refer only to the caller's persistent root user Thread, never a recently
focused Thread. UI uses the Thread Details target. Reject missing, deleted,
hidden, ephemeral, child, or non-user targets rather than synthesizing an enabled
mode. Revalidate target identity and an observed mode revision under the existing
Thread admission/write gates. Inspection distinguishes an ineligible provenance
from the desired mode; changing the mode cannot override provenance exclusions
or rewrite frozen Turn admissions.

### Authority And Settlement

Enforce root-only scope, current tool selection, global tool disablement,
operation-specific blocks, and caller lifetime at invocation and again after
human interaction or gate waits before side effects. Descendants cannot obtain
the facade through dynamic factories or supplied root identities. No `approved`
argument, reusable approval token, or `request_user_input` replaces confirmation.

Global disable retains its existing privacy boundary and interruption of active
root Turns. The calling Agent may therefore be unable to finish verification:
neither a file-write receipt nor a terminated Turn proves application. Thread
disable applies to later admissions and retains the publication write gate.
Re-enable never makes previously excluded activity eligible.

Open Memory reuses the saved tag search and normal main-window navigation.
Search creation and acknowledged navigation have separate outcomes. Missing
renderer acknowledgement is unknown navigation, not successful opening and not
a reason to repeat a committed search mutation.

Reset retains [Agent Memory](../spec/agent-memory.md) semantics: purge canonical
Memory containers and all descendants, including ordinary notes; retain stray
and outside content, protected definitions, and modes; exclude active Turns and
learn only from future admissions. It neither clears Thread history nor
interrupts user Turns or reverses their external effects.

Prepare a bounded native review from the exact container/descendant fingerprints
and reset epoch, explicitly including ordinary descendants in the scope. No raw
Memory prose enters model output. Hold no admission, publication, or document
lock while awaiting the person. Cancel, unavailable window, caller loss, or
shutdown before durable admission creates no reset intent or deletion.

After confirmation, revalidate authority and the reviewed target under Memory's
gates and the main document mutation queue. Changed targets require fresh
review; never expand the reviewed set. Runtime revision and exact-Diff checks
remain the cross-process write boundary. Retain the reviewed fingerprints in the
existing Reset publication payload so retry/restart cannot purge a changed
subtree. No new receipt ledger or global pause coordinator is introduced.

Recovery first looks up the existing operation identity/digest. A committed
operation finalizes without deleting twice. An uncommitted preparation may apply
only its still-matching target. A changed target marks that publication conflicted
and requires new review; retire its preparation and pending reset job while
retaining terminal conflict evidence and exclusions already recorded.
A definitive rejection does not advance the epoch or clear lineage. An
unavailable settlement lookup remains unresolved, not proof of non-commit.

After durable Reset intent is admitted, caller cancellation does not erase its
recovery obligations. Exact operation inspection through `memory_inspect`
distinguishes prepared, finalized, conflicted, and unknown settlement using the
existing publication/Runtime evidence. Retain terminal conflict evidence in that
owner rather than losing it when retiring a preparation. Duplicate work within
one caller invocation reuses its admitted identity. No success precedes durable
document settlement and control-store finalization; later worker/notification
failure is separate and must not make committed deletion retryable.

### Human Surface And Retirement

Keep Memory's current entry and the Thread Details switch, backed by the same
facade. Move Reset confirmation from `MemorySettingsGroup`'s renderer-only
`ConfirmDialog` into the Host native interaction used by Agents. Memory owns its
loading, errors, working, and completion state, not aggregate Settings feedback.

Replace the five-second Memory poll with narrow owner invalidation and an initial
status read. Preserve stale-read revision checks, release subscriptions on close,
and contain notification failure. Cover worker state, publication, modes, Reset,
and stray-tag reconciliation without reloading unrelated provider catalogs.
Rename Memory-only `Settings` DTO/operation symbols with their consumers, without
compatibility aliases. G still owns retirement of the enclosing category shell.

Update the configuration Skill only with file-versus-operation routing and
settlement rules. Schemas own arguments. Narrow the current spec's prohibition
on Memory-specific tools to alternate Memory-content tools; document management
separately. Neither tool becomes another content retrieval or mutation route.

### Files, Risks, And Collisions

Expected scope: `src/core/agent/memory.ts`, new domain operation schemas,
`src/core/agent/tools.ts`; Memory extension/control/pipeline/timeline modules;
`src/main/hostDomain/agentHost.ts` and a Memory facade; capability classification,
domain tool contributions and composition; `src/main/desktopHost.ts`, native
interaction and narrow preload transport; renderer API, `MemorySettingsGroup`,
`ThreadDetailsDialog`, and owning messages; the configuration Skill; corresponding
Core/renderer/smoke tests and `agent-memory`, `agent-tool-design`,
`agent-tool-permissions`, and `agent-integration` specs.

Primary risks: deleting more than reviewed, replaying a rejected Reset,
self-interruption on global disable, and treating committed work as failed after
refresh failure. Exact-target, recovery, and outcome tests are part of this PR.

PR #646 claims tool composition, capability checks, Thread execution-context
consumers, and related specs. This overlaps E1 at scope level; that Draft has no
file diff yet. Order overlapping E1 runtime edits after #646, recheck its final
diff, and preserve task-owned execution context and Skill lifecycle contracts.
Owner-local design/tests can be prepared without changing its mechanism. No edit
to `src/core/commands.ts`, `src/core/types.ts`, dependencies, build configuration,
the spec index, task board, or changelog is planned; an unexpected need requires
separate coordination, not implied permission.

## Open questions

Ratify the E1 scope, tool contracts, reviewed-target conflict/recovery behavior,
and collision order before implementation. Memory content and privacy semantics
are otherwise unchanged. E2 and E3 remain independent features under the
aggregate design, not unfinished dependencies of this PR.

## Verification

- Derive coverage from controls, Host handlers, schemas, and tests; every retained
  action has a human and Agent route, with no new configuration writer or CLI.
- Preserve tests titled `never backfills activity admitted while global or Thread Memory is disabled`,
  `linearizes Thread Memory disable with the publication write gate`, and
  `finalizes a prepared Reset with a matching receipt without deleting twice`;
  require reviewed targets in recovery fixtures.
- Cover root/descendant admission, missing/ineligible Thread, globally disabled
  inspection, stale mode revision, tool disable/block during review or gate wait,
  caller loss, and no fallback to private-store edits.
- Exercise real Memory/Runtime owners: reviewed ordinary descendants are deleted;
  new/edited/moved descendants after review survive; stray Nodes and modes survive;
  active Turns remain excluded while future eligible Turns can learn.
- Test concurrent Reset, external Outline races, failure before/after Runtime
  commit, replay with/without receipt, changed-target recovery, and no false
  success or duplicate deletion after cancellation/unknown settlement.
- Verify event-driven UI, stale reads, Thread Details target changes, native
  cancellation, light/dark mode, keyboard access, and real-Electron preload sender
  isolation using disposable test userData only.
- Run typecheck, relevant Core/renderer tests, real-Electron Memory smoke,
  packaged build/smoke where required, docs validation, and diff checks. Record
  unrelated baseline failures separately and update current specs with the code.
