import { beforeAll, describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import {
  LIBRARY_ID,
  plainText,
  replaceAllRichTextPatch,
  type NodeId,
  type NodeProjection,
  type ProjectionUpdate,
} from '../../src/core/types';
import { reduceProjection } from '../../src/renderer/state/document';
import { buildReverseEdges } from '../../src/renderer/state/renderRev';

// End-to-end coverage of the real delta path: a live Core produces a
// `ProjectionUpdate` exactly as `documentService.buildProjectionUpdate` does, and
// `reduceProjection` folds it into the renderer index. After every command the
// renderer's `byId` must deep-equal an independent full rebuild — this is what the
// e2e mock (full-updates only) cannot exercise, and it is the regression test for
// merge dropping live grandchildren.
beforeAll(() => {
  process.env.LIN_VERIFY_CACHE = '1';
});

function newId(outcome: { focus?: { nodeId: string } }): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

// Mirrors `documentService.buildProjectionUpdate`: a +1 delta from the change set,
// or a full reseed on whole-tree rewrite / discontinuity.
function buildUpdate(core: Core, lastEmittedRevision: number): ProjectionUpdate {
  const revision = core.revision();
  if (revision === lastEmittedRevision) {
    return { kind: 'delta', revision, todayId: core.todayId(), changedNodes: [], removedIds: [] };
  }
  const delta = core.revisionDelta();
  if (delta.requiresFullSearchRebuild || delta.revision !== revision || revision !== lastEmittedRevision + 1) {
    return { kind: 'full', revision, projection: core.projection() };
  }
  const present = core.projectionNodesFor(delta.changedNodeIds);
  return {
    kind: 'delta',
    revision,
    todayId: core.todayId(),
    changedNodes: [...present.values()],
    removedIds: delta.changedNodeIds.filter((id) => !present.has(id)),
  };
}

// Independent oracle: a Core re-hydrated from the serialized snapshot, with fresh
// caches.
function rebuiltById(core: Core): Map<NodeId, NodeProjection> {
  const rebuilt = Core.fromState(Core.deserializeState(core.serializeState()));
  return new Map(rebuilt.projection().nodes.map((node) => [node.id, node]));
}

function materializedById(byId: ReadonlyMap<NodeId, NodeProjection>): Map<NodeId, NodeProjection> {
  return new Map(byId);
}

describe('reduceProjection over real core deltas', () => {
  test('a folded delta stream stays byte-identical to a full rebuild', () => {
    const core = Core.new();
    let lastEmitted = core.revision();
    let state = reduceProjection(null, { kind: 'full', revision: lastEmitted, projection: core.projection() });
    expect(state).not.toBeNull();

    const step = (mutate: () => void) => {
      mutate();
      const update = buildUpdate(core, lastEmitted);
      lastEmitted = update.revision;
      state = reduceProjection(state, update);
      expect(state).not.toBeNull();
      // The renderer index must match an independent rebuild after every command.
      expect(materializedById(state!.index.byId)).toEqual(rebuiltById(core));
      // ...and the incrementally-patched reverse edges must match a full rebuild.
      expect(state!.reverseEdges).toEqual(buildReverseEdges(state!.index.byId));
    };

    const a = newId(core.createNode(LIBRARY_ID, null, 'Alpha'));
    let b = '';
    step(() => { b = newId(core.createNode(LIBRARY_ID, null, 'Bravo')); });
    let c = '';
    step(() => { c = newId(core.createNode(a, null, 'Charlie')); });
    step(() => core.applyNodeTextPatch(a, replaceAllRichTextPatch(plainText('Alpha edited'))));
    step(() => core.moveNode(c, b, null));
    step(() => core.indentNode(b));
    step(() => core.outdentNode(b));
    step(() => core.toggleDone(a));
    // Exercise the reverse-edge categories: a tag applied then removed, and a
    // reference node added then trashed.
    let tag = '';
    step(() => { tag = newId(core.createTag('project')); });
    step(() => core.applyTag(a, tag));   // taggers: tag -> a
    step(() => core.applyTag(c, tag));   // taggers: tag -> {a, c}
    step(() => core.removeTag(a, tag));  // taggers: tag -> {c}
    step(() => core.addReference(b, a)); // references: a -> <ref node>
    // Inline reference: convert a fresh node into an inline ref of `a`, then delete
    // it — exercises the inlineReferrers reverse-edge category add + remove paths.
    let inlineHost = '';
    step(() => { inlineHost = newId(core.createNode(LIBRARY_ID, null, 'inline host')); });
    let inlineRef = '';
    step(() => { inlineRef = newId(core.replaceNodeWithInlineReference(inlineHost, a)); }); // inlineReferrers: a -> inlineRef
    step(() => core.deleteNode(inlineRef)); // drop the inline-ref edge
    step(() => core.trashNode(b));
    step(() => core.restoreNode(b));
    step(() => core.deleteNode(b)); // hard subtree delete (b now carries c + the ref)
  });

  test('merge re-parents grandchildren without dropping them (regression for #1)', () => {
    const core = Core.new();
    // root: A(→ C(→ G1, G2)) and B.
    const a = newId(core.createNode(LIBRARY_ID, null, 'A'));
    const b = newId(core.createNode(LIBRARY_ID, null, 'B'));
    const c = newId(core.createNode(a, null, 'C'));
    const g1 = newId(core.createNode(c, null, 'G1'));
    const g2 = newId(core.createNode(c, null, 'G2'));

    let lastEmitted = core.revision();
    let state = reduceProjection(null, { kind: 'full', revision: lastEmitted, projection: core.projection() });
    expect(state).not.toBeNull();

    // Merge A into B: A's child C (with grandchildren G1/G2) re-parents under B,
    // then the emptied A is removed. Core touches {A, C, B} — NOT G1/G2 — so they
    // arrive in neither `changedNodes` nor `removedIds`. The reducer must keep them.
    core.mergeNodeInto(a, b);
    const update = buildUpdate(core, lastEmitted);
    expect(update.kind).toBe('delta'); // a plain re-parent+remove, not a full reseed
    state = reduceProjection(state, update);
    expect(state).not.toBeNull();

    const byId = state!.index.byId;
    expect(byId.has(a)).toBe(false);        // merged node gone
    expect(byId.has(g1)).toBe(true);        // grandchildren survive
    expect(byId.has(g2)).toBe(true);
    expect(byId.get(c)!.children).toEqual([g1, g2]); // C kept its children
    expect(byId.get(c)!.parentId).toBe(b);  // C re-parented under B
    expect(materializedById(byId)).toEqual(rebuiltById(core)); // and the whole index matches a rebuild
  });

  test('real date-node child-count deltas update the renderer day-note index', () => {
    const core = Core.new();
    const dayId = newId(core.ensureDateNode(2030, 1, 2));
    let lastEmitted = core.revision();
    let state = reduceProjection(null, { kind: 'full', revision: lastEmitted, projection: core.projection() });
    expect(state).not.toBeNull();
    expect(state!.index.dayNoteCounts.countsByDate.get('2030-01-02')).toBe(0);

    core.createNode(dayId, null, 'Journal entry');
    const update = buildUpdate(core, lastEmitted);
    lastEmitted = update.revision;
    state = reduceProjection(state, update);

    expect(state).not.toBeNull();
    expect(state!.index.dayNoteCounts.countsByDate.get('2030-01-02')).toBe(1);
    expect(materializedById(state!.index.byId)).toEqual(rebuiltById(core));
  });
});
