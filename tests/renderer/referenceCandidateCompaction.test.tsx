import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection, NodeProjection, ProjectionUpdate } from '../../src/core/types';
import {
  useProjectionStore,
  useUiState,
  type ProjectionStore,
  type ProjectionStoreOptions,
} from '../../src/renderer/state/document';
import { queryReferenceCandidateIndex } from '../../src/renderer/state/referenceCandidateIndex';

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

  test('cannot be starved by a continuous delta stream and retains in-flight edits', async () => {
    let markBuildStarted: () => void = () => undefined;
    const buildStarted = new Promise<void>((resolve) => { markBuildStarted = resolve; });
    let releaseBuild: () => void = () => undefined;
    const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    let firstYield = true;
    const rendered = renderProjectionStore({
      candidateCompactionYieldControl: async () => {
        if (!firstYield) return;
        firstYield = false;
        markBuildStarted();
        await buildGate;
      },
    });
    const base = candidateProjection();
    act(() => {
      rendered.store().applyProjectionUpdate({
        kind: 'full',
        revision: 1,
        projection: base,
      });
    });
    const candidates = base.nodes.filter((candidate) => candidate.id.startsWith('candidate-'));
    act(() => {
      rendered.store().applyProjectionUpdate({
        kind: 'delta',
        revision: 2,
        todayId: base.todayId,
        changedNodes: candidates.slice(0, 24).map((candidate, index) => ({
          ...candidate,
          content: { ...candidate.content, text: `Initial ${index}` },
          updatedAt: 100 + index,
        })),
        removedIds: [],
      });
    });
    expect(rendered.pendingCount()).toBe(24);

    const streamingCandidate = candidates[0]!;
    for (let revision = 3; revision <= 10; revision += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
        rendered.store().applyProjectionUpdate({
          kind: 'delta',
          revision,
          todayId: base.todayId,
          changedNodes: [{
            ...streamingCandidate,
            content: { ...streamingCandidate.content, text: `Streaming ${revision}` },
            updatedAt: 200 + revision,
          }],
          removedIds: [],
        });
      });
    }

    // Every gap stayed below the 150 ms idle delay. The build starting before
    // another idle window proves the independent max-age timer cannot starve.
    await act(async () => { await buildStarted; });
    expect(rendered.pendingCount()).toBe(24);
    act(() => {
      rendered.store().applyProjectionUpdate({
        kind: 'delta',
        revision: 11,
        todayId: base.todayId,
        changedNodes: [{
          ...streamingCandidate,
          content: { ...streamingCandidate.content, text: 'Streaming 11' },
          updatedAt: 211,
        }],
        removedIds: [],
      });
    });
    await act(async () => {
      releaseBuild();
      await waitUntil(() => rendered.pendingCount() < 24);
    });

    const index = rendered.store().index!;
    expect(queryReferenceCandidateIndex({
      index: index.referenceCandidates,
      query: 'Streaming 11',
      untitledLabel: 'Untitled',
      includeFileNodes: true,
      limit: 24,
    }).map((candidate) => candidate.id)).toEqual(['candidate-0']);
  });
});

function renderProjectionStore(options?: ProjectionStoreOptions): {
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
      options,
    );
    currentStore = store;
    return <span data-pending>{store.index?.referenceCandidates.pending.size ?? -1}</span>;
  }

  act(() => { root.render(<Harness />); });
  cleanups.push(() => act(() => root.unmount()));
  return {
    pendingCount: () => currentStore?.indexStore?.getCurrent()
      .referenceCandidates.pending.size
      ?? Number(document.querySelector('[data-pending]')?.textContent ?? -1),
    store: () => {
      if (!currentStore) throw new Error('Projection store is unavailable');
      return currentStore;
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for candidate compaction');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
