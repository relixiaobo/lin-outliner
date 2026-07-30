import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  todayIsoLocalDate,
  type DocumentProjection,
  type NodeId,
  type NodeProjection,
} from '../../src/renderer/api/types';
import { useWorkspaceLayout } from '../../src/renderer/ui/useWorkspaceLayout';
import type { WorkspaceLayout, WorkspacePanelState } from '../../src/renderer/ui/workspaceLayoutTypes';

type LayoutApi = ReturnType<typeof useWorkspaceLayout>;

const STORAGE_KEY = 'lin-outliner:workspace-layout:v7';

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

function panel(id: string, rootId: NodeId, size = 1): WorkspacePanelState {
  return {
    id,
    type: 'workspace',
    size,
    view: { kind: 'outliner', rootId },
    backStack: [],
    forwardStack: [],
  };
}

describe('useWorkspaceLayout movePanelToIndex', () => {
  test('moves a pane to an earlier position without touching id, size, view, or active pane', () => {
    const h = renderLayout({
      activePanelId: 'panel-b',
      panels: [panel('panel-a', 'today', 0.6), panel('panel-b', 'alpha', 0.4), panel('panel-c', 'beta')],
    });
    const before = h.api.panels;

    act(() => {
      h.api.movePanelToIndex('panel-c', 0);
    });

    expect(h.api.panels.map((p) => p.id)).toEqual(['panel-c', 'panel-a', 'panel-b']);
    // Pure permutation: the moved array holds the same panel objects.
    expect(h.api.panels[0]).toBe(before[2]);
    expect(h.api.panels[1]).toBe(before[0]);
    expect(h.api.panels[2]).toBe(before[1]);
    expect(h.api.activePanelId).toBe('panel-b');
  });

  test('interprets the insertion index against the current list when moving right', () => {
    const h = renderLayout({
      activePanelId: 'panel-a',
      panels: [panel('panel-a', 'today'), panel('panel-b', 'alpha'), panel('panel-c', 'beta')],
    });

    // Insertion index 2 = the boundary between b and c; a lands between them.
    act(() => {
      h.api.movePanelToIndex('panel-a', 2);
    });

    expect(h.api.panels.map((p) => p.id)).toEqual(['panel-b', 'panel-a', 'panel-c']);
  });

  test('no-op moves and unknown panes leave the array untouched', () => {
    const h = renderLayout({
      activePanelId: 'panel-a',
      panels: [panel('panel-a', 'today'), panel('panel-b', 'alpha')],
    });
    const before = h.api.panels;

    act(() => {
      // Both boundaries around the pane's own slot are no-ops.
      h.api.movePanelToIndex('panel-a', 0);
      h.api.movePanelToIndex('panel-a', 1);
      h.api.movePanelToIndex('panel-missing', 1);
    });

    expect(h.api.panels).toBe(before);
  });

  test('clamps an out-of-range insertion index to the end and persists the new order', () => {
    const h = renderLayout({
      activePanelId: 'panel-a',
      panels: [panel('panel-a', 'today'), panel('panel-b', 'alpha'), panel('panel-c', 'beta')],
    });

    act(() => {
      h.api.movePanelToIndex('panel-a', 99);
    });

    expect(h.api.panels.map((p) => p.id)).toEqual(['panel-b', 'panel-c', 'panel-a']);
    const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY) ?? '{}') as {
      panels?: Array<{ id: string }>;
    };
    expect(persisted.panels?.map((p) => p.id)).toEqual(['panel-b', 'panel-c', 'panel-a']);
  });
});

function renderLayout(layout: WorkspaceLayout) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 7,
    localDate: todayIsoLocalDate(),
    ...layout,
  }));
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(Date.now());
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let api: LayoutApi | null = null;

  const Probe = () => {
    api = useWorkspaceLayout({
      focusNode: () => undefined,
    });
    return null;
  };

  const root = createRoot(document.getElementById('root')!);
  act(() => {
    root.render(<Probe />);
  });
  act(() => {
    api!.initializeLayout(projection());
  });
  mounted.push(() => act(() => root.unmount()));

  return {
    get api() {
      return api!;
    },
    storage,
  };
}

function projection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'library',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes: [
      node('root', { children: ['today', 'alpha', 'beta'] }),
      node('today', { parentId: 'root' }),
      node('alpha', { parentId: 'root' }),
      node('beta', { parentId: 'root' }),
      node('library'),
      node('daily-notes'),
      node('schema'),
      node('searches'),
      node('recents'),
      node('trash'),
    ],
  };
}

function node(id: NodeId, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text: '', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
