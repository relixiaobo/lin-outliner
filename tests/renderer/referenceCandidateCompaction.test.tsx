import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection, NodeProjection, ProjectionUpdate } from '../../src/core/types';
import {
  useProjectionStore,
  useUiState,
  type ProjectionStore,
} from '../../src/renderer/state/document';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('reference candidate overlay compaction', () => {
  test('runs after the projection hot path has committed', async () => {
    const rendered = renderProjectionStore();
    const base = candidateProjection();
    act(() => {
      rendered.store().applyProjectionUpdate({
        kind: 'full',
        revision: 1,
        projection: base,
      });
    });
    const changedNodes = base.nodes
      .filter((candidate) => candidate.id.startsWith('candidate-'))
      .slice(0, 24)
      .map((candidate, index) => ({
        ...candidate,
        content: { ...candidate.content, text: `Renamed ${index}` },
        updatedAt: 100 + index,
      }));
    const update: ProjectionUpdate = {
      kind: 'delta',
      revision: 2,
      todayId: base.todayId,
      changedNodes,
      removedIds: [],
    };

    act(() => { rendered.store().applyProjectionUpdate(update); });
    expect(rendered.pendingCount()).toBe(24);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(rendered.pendingCount()).toBe(0);
  });
});

function renderProjectionStore(): {
  pendingCount: () => number;
  store: () => ProjectionStore;
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  let currentStore: ProjectionStore | null = null;

  function Harness() {
    const [, setUi] = useUiState();
    const store = useProjectionStore(
      async () => { throw new Error('Unexpected resync'); },
      setUi,
    );
    currentStore = store;
    return <span data-pending>{store.index?.referenceCandidates.pending.size ?? -1}</span>;
  }

  act(() => { root.render(<Harness />); });
  cleanups.push(() => act(() => root.unmount()));
  return {
    pendingCount: () => Number(document.querySelector('[data-pending]')?.textContent ?? -1),
    store: () => {
      if (!currentStore) throw new Error('Projection store is unavailable');
      return currentStore;
    },
  };
}

function candidateProjection(): DocumentProjection {
  const candidates = Array.from({ length: 30 }, (_, index) => (
    node(`candidate-${index}`, `Candidate ${index}`, { parentId: 'root', updatedAt: index })
  ));
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'root',
    nodes: [
      node('root', 'Root', { children: [...candidates.map((candidate) => candidate.id), 'trash'] }),
      ...candidates,
      node('trash', 'Trash', { parentId: 'root' }),
    ],
  };
}

function node(id: string, text = id, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}
