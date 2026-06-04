---
status: draft
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

Add `getProjectionSnapshot(): { revision, projection }` (IPC `invoke`). The
renderer requests it if it ever holds a `delta` it can't apply (no prior state, or
a revision gap main didn't catch). In steady state — one ordered IPC channel, main
emits in commit order — this never fires; it is belt-and-suspenders.

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
- **PR-B — incremental reverse edges.** Maintain the `renderRev` reverse-edge maps
  across renders, patch from the delta (retires the last O(N) per-keystroke pass).

## Risks & correctness

- **Structural moves:** a re-parent must include both old and new parent in
  `changedNodeIds`. Verify core already does (it tracks `affectedNodeIds`); add a
  delta test asserting both parents are present.
- **Removal vs descendants:** removing a subtree — does `changedNodeIds` include
  every descendant, or just the root? The text-search consumer walks descendants
  itself (`collectDescendantIds`, `documentService.ts:606`). The renderer reducer
  must do the same: on `removedIds`, drop the node's descendants from `byId` too.
  (Open question — confirm core's `changedNodeIds` granularity on subtree delete.)
- **Whole-tree rewrites** (undo/redo/import) → `requiresFullSearchRebuild` → `full`.
  Covered.
- **`todayId` rollover** → carried on every delta.
- **Mid-transaction reads** — emit only post-commit (already the case).
- Guard with existing `renderRev.test.ts` + new delta-application unit tests
  (apply a delta sequence, assert byId identity preserved for unchanged nodes,
  removed descendants pruned, renderRev bumped for exactly the affected closure).
  Keep the `full` fallback always reachable.

## Measurement

Baseline before PR-2 with the existing probe (`renderProbe.ts` /
`measureRenderIndex` reports `index=` time): capture at a known doc size (e.g.
2k / 5k / 10k nodes), typing a character. Re-measure after. Expect `index=` to go
from O(N) to ~flat in doc size. Record numbers in the PR.

## Decisions (PM-ratified)

1. **Staging** — two PRs (PR-A combines contract + delta; PR-B reverse edges). PM
   opted to combine rather than the interface-first three-PR split.
2. **Wire shape** — the clean node-level discriminated union above (no transitional
   alongside-full variant). Pre-launch, no compat constraint.
3. **Subtree-delete granularity** — the reducer prunes descendants of any
   `removedId` from the previous `byId`, mirroring the proven text-search consumer
   (`collectDescendantIds`, `documentService.ts:606`). This is correct whether or
   not core's `changedNodeIds` already enumerates descendants, so no dependency on
   that detail — but a delta test will assert subtree-delete prunes the whole
   subtree.

## Checklist

- [ ] PR-A `ProjectionUpdate` union; `CommandOutcome`/event carry `update`; main
      boundary builder (delta + full fallback); renderer delta reducer (preserve
      unchanged-node identity, prune removed subtrees, drop `nodeSignatures`);
      `getProjectionSnapshot` resync valve; perf before/after
- [ ] PR-B incremental reverse-edge maps in `renderRev`
- [ ] delta-application unit tests (identity preserved, subtree-delete prunes,
      re-parent includes both parents); `renderRev.test.ts` still green
- [ ] fold the shipped design into `docs/spec/` (architecture / projection)
