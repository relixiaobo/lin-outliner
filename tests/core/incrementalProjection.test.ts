import { beforeAll, describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { LIBRARY_ID, replaceAllRichTextPatch, plainText } from '../../src/core/types';

// The projection is served from an incrementally-patched cache (only touched
// nodes are re-projected per mutation). These tests pin the invariant that the
// cache always equals a full rebuild: after each command, `core.projection()`
// must deep-equal the projection of a fresh Core re-hydrated from the same
// serialized state (an independent from-scratch build). LIN_VERIFY_CACHE also
// makes Core self-check cached-vs-rebuild after every mutation, so a missing
// `touchNode` throws inside the failing command.
beforeAll(() => {
  process.env.LIN_VERIFY_CACHE = '1';
});

function newId(outcome: { focus?: { nodeId: string } }): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

// Independent oracle: rebuild a Core from the serialized snapshot (fresh caches)
// and compare its projection to the live, incrementally-cached one.
function expectProjectionMatchesRebuild(core: Core) {
  const rebuilt = Core.fromState(Core.deserializeState(core.serializeState()));
  expect(core.projection()).toEqual(rebuilt.projection());
}

describe('incremental projection cache equals a full rebuild', () => {
  test('across the common single-node mutation commands', () => {
    const core = Core.new();

    const a = newId(core.createNode(LIBRARY_ID, null, 'Alpha'));
    const b = newId(core.createNode(LIBRARY_ID, null, 'Bravo'));
    const c = newId(core.createNode(a, null, 'Charlie'));
    expectProjectionMatchesRebuild(core);

    core.applyNodeTextPatch(a, replaceAllRichTextPatch(plainText('Alpha edited')));
    core.updateNodeDescription(b, 'a description');
    expectProjectionMatchesRebuild(core);

    // Structural moves change parent child-lists on both sides.
    core.moveNode(c, b, null);
    core.indentNode(b);
    core.outdentNode(b);
    expectProjectionMatchesRebuild(core);

    core.toggleDone(a);
    expectProjectionMatchesRebuild(core);
  });

  test('across tags, trash, restore and delete', () => {
    const core = Core.new();
    const node = newId(core.createNode(LIBRARY_ID, null, 'Tagged row'));
    const tag = newId(core.createTag('project'));
    core.applyTag(node, tag);
    expectProjectionMatchesRebuild(core);

    const doomed = newId(core.createNode(LIBRARY_ID, null, 'Doomed'));
    core.trashNode(doomed);
    expectProjectionMatchesRebuild(core);

    core.restoreNode(doomed);
    expectProjectionMatchesRebuild(core);

    core.deleteNode(doomed);
    expectProjectionMatchesRebuild(core);
  });

  test('after undo and redo (a whole-tree rewrite the cache cannot patch)', () => {
    const core = Core.new();
    const node = newId(core.createNode(LIBRARY_ID, null, 'Undo me'));
    core.applyNodeTextPatch(node, replaceAllRichTextPatch(plainText('typed')));
    expectProjectionMatchesRebuild(core);

    core.operationHistory({ action: 'undo', origin: 'user' });
    expectProjectionMatchesRebuild(core);

    core.operationHistory({ action: 'redo', origin: 'user' });
    expectProjectionMatchesRebuild(core);
  });

  test('inside a transaction (intermediate reads stay fresh) and after commit', async () => {
    const core = Core.new();
    let created = '';
    await core.transaction('user', async () => {
      created = newId(core.createNode(LIBRARY_ID, null, 'Batched'));
      // A read mid-transaction must already see the just-created node.
      expect(core.projection().nodes.some((n) => n.id === created)).toBe(true);
      core.applyNodeTextPatch(created, replaceAllRichTextPatch(plainText('batched edit')));
    });
    expect(created).not.toBe('');
    expectProjectionMatchesRebuild(core);
  });
});
