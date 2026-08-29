import { describe, expect, test } from 'bun:test';
import type { Dispatch, SetStateAction } from 'react';
import { plainText, type NodeProjection } from '../../src/renderer/api/types';
import type { UiState } from '../../src/renderer/state/document';
import {
  nodeWithPendingPatch,
  optimisticTagPatch,
  pendingNodePatch,
  startOptimisticNodePatch,
} from '../../src/renderer/ui/outliner/optimisticNodePatch';

function node(id: string): NodeProjection {
  return {
    id,
    children: [],
    content: plainText('Original'),
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
  };
}

function uiState(): UiState {
  return {
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    trailingDraftPlacement: null,
    pendingStructuralChanges: [],
    pendingNodePatches: new Map(),
    pendingRemovalIds: new Set(),
    expanded: new Set(),
    expandedHiddenFields: new Set(),
    editingDescriptionId: null,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  };
}

function stateHarness() {
  let current = uiState();
  const setUi: Dispatch<SetStateAction<UiState>> = (update) => {
    current = typeof update === 'function' ? update(current) : update;
  };
  return {
    get current() {
      return current;
    },
    setUi,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('optimistic node patches', () => {
  test('overlays content, tags, and completedAt without mutating Projection', () => {
    const projected = node('target');
    const completed = nodeWithPendingPatch(projected, pendingNodePatch('target', {
      content: plainText('Pending'),
      tags: ['tag:pending'],
      completedAt: 42,
    }));
    const hidden = nodeWithPendingPatch(completed, pendingNodePatch('target', {
      completedAt: null,
    }));

    expect(completed.content.text).toBe('Pending');
    expect(completed.tags).toEqual(['tag:pending']);
    expect(completed.completedAt).toBe(42);
    expect(hidden.completedAt).toBeUndefined();
    expect(projected.content.text).toBe('Original');
    expect(projected.tags).toEqual([]);
    expect(projected.completedAt).toBeUndefined();
  });

  test('composes tag additions and removals with pending tag definitions', () => {
    const projected = node('target');
    projected.tags = ['tag:existing'];
    const state = uiState();
    const added = optimisticTagPatch({
      node: projected,
      ui: state,
      tagId: 'tag:new',
      action: 'add',
      pendingTagName: 'new',
    });
    state.pendingNodePatches.set(projected.id, added);
    const removed = optimisticTagPatch({
      node: projected,
      ui: state,
      tagId: 'tag:existing',
      action: 'remove',
    });

    expect(added.tags).toEqual(['tag:existing', 'tag:new']);
    expect(added.pendingTagNames).toEqual({ 'tag:new': 'new' });
    expect(removed.tags).toEqual(['tag:new']);
    expect(removed.pendingTagNames).toEqual({ 'tag:new': 'new' });
    expect(projected.tags).toEqual(['tag:existing']);
  });

  test('serializes same-node commands and an older settlement cannot clear its successor', async () => {
    const state = stateHarness();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const order: string[] = [];
    const firstPatch = pendingNodePatch('target', { content: plainText('First') });
    const first = startOptimisticNodePatch({
      currentUi: state.current,
      setUi: state.setUi,
      patch: firstPatch,
      command: async () => {
        order.push('first:start');
        await firstGate.promise;
        order.push('first:end');
        return {};
      },
    });
    const secondPatch = pendingNodePatch('target', { content: plainText('Second') });
    const second = startOptimisticNodePatch({
      currentUi: state.current,
      setUi: state.setUi,
      patch: secondPatch,
      command: async () => {
        order.push('second:start');
        await secondGate.promise;
        order.push('second:end');
        return {};
      },
    });

    expect(state.current.pendingNodePatches.get('target')).toBe(secondPatch);
    expect(order).toEqual(['first:start']);

    firstGate.resolve();
    await first;
    await Promise.resolve();
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(state.current.pendingNodePatches.get('target')).toBe(secondPatch);

    secondGate.resolve();
    await second;
    expect(state.current.pendingNodePatches.has('target')).toBe(false);
  });

  test('clears rejected and failed patches through their distinct callbacks', async () => {
    const rejectedState = stateHarness();
    let rejected = 0;
    const rejectedSettlement = startOptimisticNodePatch({
      currentUi: rejectedState.current,
      setUi: rejectedState.setUi,
      patch: pendingNodePatch('target', { completedAt: 0 }),
      command: async () => null,
      onRejected: () => {
        rejected += 1;
      },
    });

    await expect(rejectedSettlement).resolves.toBe(false);
    expect(rejected).toBe(1);
    expect(rejectedState.current.pendingNodePatches.has('target')).toBe(false);

    const failedState = stateHarness();
    let failed = 0;
    const failedSettlement = startOptimisticNodePatch({
      currentUi: failedState.current,
      setUi: failedState.setUi,
      patch: pendingNodePatch('target', { completedAt: 0 }),
      command: async () => {
        throw new Error('runtime failed');
      },
      onFailed: () => {
        failed += 1;
      },
    });

    await expect(failedSettlement).rejects.toThrow('runtime failed');
    expect(failed).toBe(1);
    expect(failedState.current.pendingNodePatches.has('target')).toBe(false);
  });
});
