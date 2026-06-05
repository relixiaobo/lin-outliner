---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

# Incremental Projection Protocol (perf P1 keystone)

Scope: the `core → IPC → renderer` projection data flow. This is the **P1
keystone** of `docs/plans/performance-optimization.md`. It touches the protocol
surface (`src/core/types.ts`, the IPC command result + document event), so per
`AGENTS.md` it lands **interface-first** (a behavior-preserving contract PR),
then the optimization on top.

## Goal

Make the renderer's per-edit cost scale with the **change set**, not the document
size. Today every committed mutation ships the entire projection across IPC and
the renderer re-derives "what changed" by `JSON.stringify`-ing every node. Core
already knows the change set (`revisionDelta().changedNodeIds`); deliver it
instead of making the renderer rediscover it in O(N).

Target: eliminate, per keystroke, (a) the O(N) projection assemble + structure-clone
in main, (b) the O(N) `new Map(projection.nodes)` rebuild, (c) the O(N)
`nodeSignatures` JSON.stringify pass, and (d) the O(N) `buildReverseEdges` rebuild
in the renderer. Replace with O(changed).

## Non-goals

- No change to the Loro model, the command set, or core's internal `CommandOutcome`
  shape. The delta is built at the **main process boundary** from existing core
  APIs (`revisionDelta`, `projectionNodesFor`) — core stays untouched.
- No field-level patching. Granularity is **node-level**: a changed node ships its
  whole `NodeProjection` (matches the projection cache's unit; field-level is a
  later, separate optimization if ever needed).
- Not the outliner virtualization (P2-1) or agent streaming delta (P2-2) — separate.

## Current data flow (verified)

Two paths feed the renderer's `setProjection`, both carrying a **full** projection,
both per-edit:

1. **Local user commands (the typing hot path):** `run()` → `lin:invoke` → core
   command → `CommandOutcome { projection: DocumentProjection; focus? }`
   (`types.ts:569`); renderer `useCommandRunner` does `setProjection(result.projection)`
   (`shared.ts:118`).
2. **Agent/system mutations:** `documentService.emitProjectionChanged`
   (`documentService.ts:723`) builds `DocumentProjectionChangedEvent { projection }`
   (`types.ts:525`) → `webContents.send` (`main.ts:133`) → renderer `onDocumentEvent`
   → `setProjection(event.projection)` (`App.tsx:128-140`).

Both land in `App.tsx:36` `projection` state → `useRenderIndex` (`document.ts:53`)
→ `buildIndex` `new Map(projection.nodes…)` + `nodeSignatures` + `buildReverseEdges`.

Core already exposes everything needed:
- `revisionDelta(): { revision, changedNodeIds, requiresFullSearchRebuild }`
  (`core.ts:269`). `requiresFullSearchRebuild` is set true exactly on whole-tree
  rewrites (undo/redo/import/load: `bumpRevision([], true)` + `invalidateProjectionCache`,
  `core.ts:2140-2143`) — i.e. it is precisely the "renderer must take a full
  projection" signal.
- `projectionNodesFor(ids)` / `projectionNodesByIds(ids)` (`core.ts:277,253`):
  O(ids) projection of specific nodes from the incremental cache.
- **Proven template:** `refreshTextSearchIndexFromCoreDelta` (`documentService.ts:567-622`)
  already consumes `revisionDelta` to incrementally update an index, with a clean
  full-rebuild fallback on `requiresFullSearchRebuild` / revision discontinuity.
  The projection delta builder mirrors it exactly.

## Design

### Wire type (the protocol surface — `src/core/types.ts`)

```ts
export type ProjectionUpdate =
  | { kind: 'full';  revision: number; projection: DocumentProjection }
  | { kind: 'delta'; revision: number; todayId: NodeId;
      changedNodes: NodeProjection[]; removedIds: NodeId[] };
```

- `revision` lets the renderer assert continuity (a `delta` must be `prev + 1`).
- `todayId` is the one envelope pointer that can change post-init (daily-note
  rollover); the other system ids are immutable, so a delta omits them.
- `full` carries the existing `DocumentProjection` verbatim — used for init,
  resync, and whole-tree rewrites.

Both renderer-facing payloads carry it:
- `CommandOutcome` → renderer-facing result gains `update: ProjectionUpdate`
  (replacing `projection`). Core's internal command methods are unchanged; the
  `lin:invoke` handler in main swaps the full projection for an `update`.
- `DocumentProjectionChangedEvent.projection` → `.update: ProjectionUpdate`.

### Main-boundary builder

One shared helper in `documentService` (mirrors the text-search delta logic):

```ts
projectionUpdate(origin): ProjectionUpdate {
  const delta = core.revisionDelta();
  if (delta.requiresFullSearchRebuild
      || delta.revision !== core.revision()
      || delta.revision !== this.lastEmittedProjectionRevision + 1) {
    this.lastEmittedProjectionRevision = core.revision();
    return { kind: 'full', revision: core.revision(), projection: core.projection() };
  }
  const present = core.projectionNodesFor(delta.changedNodeIds); // O(changed)
  const changedNodes = [...present.values()];
  const removedIds = delta.changedNodeIds.filter((id) => !present.has(id));
  this.lastEmittedProjectionRevision = delta.revision;
  return { kind: 'delta', revision: delta.revision, todayId: core.projection-todayId,
           changedNodes, removedIds };
}
```

`lastEmittedProjectionRevision` tracks the per-window emit chain so deltas form a
clean `+1` sequence; any discontinuity (first emit, missed revision) falls back to
`full`. (Note `core.projection()` for the full case still serves the incremental
cache — cheap envelope assemble, only on the rare full path. `todayId` for the
delta case comes from a small `core.todayId()` accessor to avoid assembling the
whole projection just for one pointer.)

### Renderer ingest

`setProjection(projection)` becomes `applyProjectionUpdate(update)`, a reducer over
the held `{ projection, byId, renderRev }` index (folding `useRenderIndex` into it):

- `full` → rebuild as today (`new Map(projection.nodes)`, full `renderRev` seed).
- `delta` → **patch a copy** of the previous `byId`: `set` each `changedNodes`
  entry, `delete` each `removedIds`, update `todayId`; **preserve references for
  every unchanged node** (this is the stable-identity win that makes the P3 memo
  cluster hold across keystrokes). Then bump `renderRev` directly from
  `changedNodes`+`removedIds` + the reverse-edge closure — **deleting the
  whole-document `nodeSignatures` JSON.stringify pass** (`renderRev.ts:20-24`) and
  patching the reverse-edge maps incrementally instead of rebuilding them.

### Resync safety valve

The existing `get_projection` command now returns a `ProjectionSnapshot
{ revision, projection }` (it already round-trips through the renderer as a
no-op refresh sentinel). The renderer requests it if it ever holds a `delta` it
can't apply (no prior state, or a revision gap main didn't catch) — see
`useProjectionStore`'s `resync` fallback. In steady state — one ordered IPC
channel, main emits in commit order — this never fires; it is
belt-and-suspenders. (The agent tool host's `documentService.getProjection()`
stays returning a full `DocumentProjection`, so only the renderer-facing command
case changed.)

## Staging (PM-ratified: two PRs)

The PM ratified collapsing the contract reshape and the delta optimization into a
single PR (rather than the interface-first three-PR split), keeping the reverse-edge
pass separate:

- **PR-A — contract + delta emission + ingest (the win).** Add the `ProjectionUpdate`
  union; reshape the renderer-facing `CommandOutcome` result + `DocumentProjectionChangedEvent`
  to carry `update`; main's boundary builder returns `delta` for normal mutations
  and `full` on whole-tree rewrites / discontinuity; renderer's reducer applies
  deltas, **preserves unchanged-node identity**, and **drops the `nodeSignatures`
  JSON.stringify pass**. Add `getProjectionSnapshot` resync valve. Gate:
  `/code-review ultra` (protocol surface + the risky delta logic) + perf before/after.
- **PR-B — incremental reverse edges.** *(shipped)* The reverse-edge index
  (`ReverseEdges`) is held in `ProjectionState` and patched per delta
  (`patchReverseEdges`, copy-on-write, with a same-keys skip so a text edit touches
  nothing) instead of rebuilt from every node in `propagateDirty`. `Set`-valued
  for O(1) add/remove. Retires the last O(N) edge scan; consistency vs a full
  rebuild is asserted after every command in `projectionDeltaIntegration.test.ts`.

## Risks & correctness

- **Structural moves:** a re-parent must include both old and new parent in
  `changedNodeIds`. Verify core already does (it tracks `affectedNodeIds`); add a
  delta test asserting both parents are present.
- **Removal vs descendants / merge survivors:** *(resolved — the keystone
  correctness point, caught at the gate)* The reducer deletes **exactly
  `removedIds`** — it does NOT walk the previous tree to prune descendants. Two
  facts make that complete AND correct: (a) `loro.deleteNode` touches every
  descendant of a genuine removal (`loroDocument.ts:330` `subtreeIds → touchNode`),
  and core's `patchProjectionCache` (`core.ts:310`) "reproject-present /
  delete-absent" is asserted equal to a full rebuild by `verifyCaches`
  (`LIN_VERIFY_CACHE=1`), so a removed subtree is always fully enumerated in
  `removedIds`; (b) a child re-parented OUT of a node that the *same revision* then
  removes — `merge_node_into` moves a node's children up, then drops the emptied
  node (`core.ts:3114-3118`) — arrives in `changedNodes`, not `removedIds`. An
  earlier draft pruned the stale subtree defensively; that **dropped the merge
  survivors** (their grandchildren weren't in either set). Covered by
  `projectionDeltaIntegration.test.ts` (merge-with-grandchildren).
- **Whole-tree rewrites** (undo/redo/import) → `requiresFullSearchRebuild` → `full`.
  Covered.
- **`todayId` rollover** → carried on every delta.
- **Mid-transaction reads** — emit only post-commit (already the case).
- Guard with existing `renderRev.test.ts` + new delta-application unit tests
  (apply a delta sequence, assert byId identity preserved for unchanged nodes,
  removed descendants pruned, renderRev bumped for exactly the affected closure).
  Keep the `full` fallback always reachable.

## Measurement

The probe (`renderProbe.ts` / `measureRenderIndex` reports `index=` time) is the
live in-app metric. For a reproducible before/after at the Core+reducer layer
(no Electron), `tmp/bench-projection-delta.ts` drives a single-keystroke edit at
several document sizes and measures both the main-side payload and the renderer
`index=` cost, old vs new:

| nodes | OLD main stringify | OLD payload | NEW delta cost | NEW payload | OLD index | NEW index |
|------:|-------------------:|------------:|---------------:|------------:|----------:|----------:|
|   238 |            0.16 ms |       76 kB |        0.16 ms |       361 B |   0.16 ms |   0.05 ms |
|  1038 |            0.70 ms |      338 kB |        0.33 ms |       362 B |   0.72 ms |   0.19 ms |
|  3038 |            1.98 ms |      997 kB |        0.75 ms |       362 B |   2.35 ms |   0.38 ms |
|  6038 |            4.64 ms |    1984 kB |        1.42 ms |       362 B |   7.03 ms |   1.24 ms |

The headline is the **payload**: ~2 MB → 362 B at 6k nodes (and it crosses IPC
twice per command), and the renderer `index=` pass drops from 7.0 ms → 1.2 ms
(~5.7×) by deleting the whole-document `JSON.stringify` signature pass.

**PR-B** then retires the reverse-edge rebuild inside `propagateDirty`. The held
index is patched per delta (`patchReverseEdges`, copy-on-write) instead of rebuilt
from every node. `tmp/bench-reverse-edges.ts` (edge-build + propagate, single
keystroke, ~20% of nodes tagged):

| nodes | OLD (rebuild) | NEW (patch) |
|------:|--------------:|------------:|
|  1041 |       0.22 ms |     0.07 ms |
|  3041 |       0.65 ms |     0.13 ms |
|  6041 |       1.22 ms |     0.29 ms |

OLD is clearly O(N); NEW grows far slower (its residual is the shared
`nextRevisions` + `new Map(prev.byId)`, both still O(N) — the P3 cleanup).

## Decisions (PM-ratified)

1. **Staging** — two PRs (PR-A combines contract + delta; PR-B reverse edges). PM
   opted to combine rather than the interface-first three-PR split.
2. **Wire shape** — the clean node-level discriminated union above (no transitional
   alongside-full variant). Pre-launch, no compat constraint.
3. **Subtree-delete granularity** — *(superseded by the gate)* the reducer deletes
   **exactly `removedIds`** and does not walk the previous tree. Core enumerates
   every genuinely-removed node (`loro.deleteNode` touches the whole subtree), and
   walking the stale tree instead would drop a `merge_node_into` survivor whose
   grandchildren are in `changedNodes`. See the Risks section.

## Checklist

- [x] PR-A `ProjectionUpdate` union; renderer-facing `CommandResult`/event carry
      `update`; main boundary builder (`buildProjectionUpdate`: delta + full
      fallback, per-revision cache, `lastEmittedProjectionRevision` chain);
      renderer delta reducer (`reduceProjection`: preserve unchanged-node
      identity, delete exactly `removedIds`, drop `nodeSignatures`, no-op reseed
      guard); `get_projection` → `ProjectionSnapshot` resync valve; perf captured
- [x] PR-A gate fixes: merge-survivor pruning bug, idempotent-date-ref fallback,
      no-op-sentinel full reseed, pure projection-store updater + resync guard
- [x] PR-B incremental reverse-edge maps in `renderRev` (`patchReverseEdges`,
      copy-on-write, held in `ProjectionState`); `propagateDirty` takes the index
      instead of rebuilding it
- [x] delta-application unit tests (`reduceProjection.test.ts`) +
      `patchReverseEdges` unit tests (COW immutability, same-keys skip, matches a
      full rebuild) + real-core integration (`projectionDeltaIntegration.test.ts`:
      folds a delta stream and asserts both the index AND the reverse edges equal
      an independent rebuild after each command, incl. merge-with-grandchildren and
      tag/reference churn); `renderRev.test.ts` still green
- [ ] fold the shipped design into `docs/spec/` (architecture / projection)
