import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { makeDraftNode, useTrailingDraftId } from '../../src/renderer/ui/outliner/draftRow';
import { isClientNodeId } from '../../src/core/nodeId';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

// Drive the hook through a tiny probe component and capture the id it returns
// on every render, plus a setter to change the inputs.
function renderHook(initialParent: NodeId, initialById: Map<NodeId, NodeProjection>) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Node: window.Node });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const ids: NodeId[] = [];
  let setInputs: (next: { parentId: NodeId; byId: Map<NodeId, NodeProjection> }) => void = () => {};

  const Probe = (props: { parentId: NodeId; byId: Map<NodeId, NodeProjection> }) => {
    const id = useTrailingDraftId(props.parentId, props.byId);
    ids.push(id);
    return null;
  };
  const Harness = () => {
    const [inputs, setState] = (require('react') as typeof import('react')).useState({
      parentId: initialParent,
      byId: initialById,
    });
    setInputs = setState;
    return <Probe parentId={inputs.parentId} byId={inputs.byId} />;
  };

  const root = createRoot(document.getElementById('root')!);
  act(() => root.render(<Harness />));
  mounted.push(() => act(() => root.unmount()));
  return {
    ids,
    rerender: (next: { parentId: NodeId; byId: Map<NodeId, NodeProjection> }) => act(() => setInputs(next)),
  };
}

describe('makeDraftNode', () => {
  test('synthesizes an empty plain node under the parent', () => {
    const node = makeDraftNode('node:00000000-0000-0000-0000-000000000000', 'parent:1');
    expect(node.parentId).toBe('parent:1');
    expect(node.type).toBeUndefined();
    expect(node.children).toEqual([]);
    expect(node.tags).toEqual([]);
    expect(node.locked).toBe(false);
    expect(node.content.text).toBe('');
  });
});

describe('useTrailingDraftId', () => {
  test('returns a stable client id across re-renders', () => {
    const byId = new Map<NodeId, NodeProjection>();
    const { ids, rerender } = renderHook('parent:1', byId);
    const first = ids[0];
    expect(isClientNodeId(first)).toBe(true);
    rerender({ parentId: 'parent:1', byId });
    expect(ids[ids.length - 1]).toBe(first);
  });

  test('mints a fresh id once the draft materializes (its id appears in byId)', () => {
    const byId = new Map<NodeId, NodeProjection>();
    const { ids, rerender } = renderHook('parent:1', byId);
    const draftId = ids[0];
    // Materialize: the projection now contains the draft id.
    const next = new Map(byId);
    next.set(draftId, makeDraftNode(draftId, 'parent:1'));
    rerender({ parentId: 'parent:1', byId: next });
    const after = ids[ids.length - 1];
    expect(after).not.toBe(draftId);
    expect(isClientNodeId(after)).toBe(true);
  });

  test('resets the id when the owning parent changes', () => {
    const byId = new Map<NodeId, NodeProjection>();
    const { ids, rerender } = renderHook('parent:1', byId);
    const first = ids[0];
    rerender({ parentId: 'parent:2', byId });
    expect(ids[ids.length - 1]).not.toBe(first);
  });
});
