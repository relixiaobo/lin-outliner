import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useWorkspacePinnedNodes } from '../../src/renderer/ui/useWorkspacePinnedNodes';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

type PinnedApi = ReturnType<typeof useWorkspacePinnedNodes>;

// Drive the hook through a probe; expose its latest return so tests can call
// pinNodeAtIndex and read the resulting order.
function renderPinned(nodeIds: NodeId[]) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Node: window.Node });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const byId = new Map<NodeId, NodeProjection>();
  for (const id of nodeIds) byId.set(id, { id } as NodeProjection);

  let api: PinnedApi | null = null;
  const Probe = () => {
    api = useWorkspacePinnedNodes(byId);
    return null;
  };
  const root = createRoot(document.getElementById('root')!);
  act(() => root.render(<Probe />));
  mounted.push(() => act(() => root.unmount()));
  return {
    get pinned() { return api!.pinnedNodeIds; },
    pinAt: (nodeId: NodeId, index: number) => act(() => api!.pinNodeAtIndex(nodeId, index)),
    toggle: (nodeId: NodeId) => act(() => api!.togglePin(nodeId)),
  };
}

describe('useWorkspacePinnedNodes.pinNodeAtIndex', () => {
  test('inserts a new pin at the given index', () => {
    const h = renderPinned(['a', 'b', 'c']);
    h.toggle('a');
    h.toggle('b');
    expect(h.pinned).toEqual(['a', 'b']);
    // Insert c between a and b.
    h.pinAt('c', 1);
    expect(h.pinned).toEqual(['a', 'c', 'b']);
  });

  test('appends when the index is at or past the end', () => {
    const h = renderPinned(['a', 'b', 'c']);
    h.toggle('a');
    h.pinAt('b', 99);
    expect(h.pinned).toEqual(['a', 'b']);
  });

  test('reorders an existing pin downward (index against the current list)', () => {
    const h = renderPinned(['a', 'b', 'c']);
    h.toggle('a');
    h.toggle('b');
    h.toggle('c');
    expect(h.pinned).toEqual(['a', 'b', 'c']);
    // Move a to the slot after c (index 3 in the current list).
    h.pinAt('a', 3);
    expect(h.pinned).toEqual(['b', 'c', 'a']);
  });

  test('reorders an existing pin upward', () => {
    const h = renderPinned(['a', 'b', 'c']);
    h.toggle('a');
    h.toggle('b');
    h.toggle('c');
    h.pinAt('c', 0);
    expect(h.pinned).toEqual(['c', 'a', 'b']);
  });

  test('dropping a pin back onto its own position is a no-op', () => {
    const h = renderPinned(['a', 'b', 'c']);
    h.toggle('a');
    h.toggle('b');
    h.pinAt('a', 1); // before b == its current slot
    expect(h.pinned).toEqual(['a', 'b']);
    h.pinAt('a', 0);
    expect(h.pinned).toEqual(['a', 'b']);
  });

  test('ignores nodes that are not in the document', () => {
    const h = renderPinned(['a']);
    h.pinAt('ghost', 0);
    expect(h.pinned).toEqual([]);
  });
});
