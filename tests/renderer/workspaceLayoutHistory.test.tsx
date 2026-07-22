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
import type { WorkspaceLayout } from '../../src/renderer/ui/workspaceLayoutTypes';

type LayoutApi = ReturnType<typeof useWorkspaceLayout>;

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

describe('useWorkspaceLayout history focus', () => {
  test('new file preview panes can open as file-only readers', () => {
    const h = renderLayout({
      activePanelId: 'panel-test',
      panels: [{
        id: 'panel-test',
        type: 'workspace',
        size: 1,
        view: { kind: 'outliner', rootId: 'today' },
        backStack: [],
        forwardStack: [],
      }],
    });

    act(() => {
      h.api.navigatePanelPreview('panel-test', { kind: 'asset', assetId: 'asset-alpha', label: 'reader-note.md' }, {
        newPane: true,
        nodeId: 'alpha',
        presentation: 'reader',
      });
    });

    const readerPanel = h.api.panels.find((panel) => panel.id !== 'panel-test');
    expect(readerPanel).toMatchObject({
      type: 'workspace',
      view: {
        kind: 'file-preview',
        nodeId: 'alpha',
        presentation: 'reader',
        target: { kind: 'asset', assetId: 'asset-alpha', label: 'reader-note.md' },
      },
    });
  });

  test('loose file readers do not dedupe with the same target normal preview', () => {
    const target = { kind: 'local-file' as const, path: '/tmp/report.md', entryKind: 'file' as const, label: 'report.md' };
    const h = renderLayout({
      activePanelId: 'panel-test',
      panels: [{
        id: 'panel-test',
        type: 'workspace',
        size: 1,
        view: { kind: 'outliner', rootId: 'today' },
        backStack: [],
        forwardStack: [],
      }],
    });

    act(() => {
      h.api.navigatePanelPreview('panel-test', target);
    });
    act(() => {
      h.api.navigatePanelPreview('panel-test', target, { presentation: 'reader' });
    });

    expect(h.api.panels[0]).toMatchObject({
      type: 'workspace',
      view: { kind: 'file-preview', target, presentation: 'reader' },
      backStack: [
        { kind: 'outliner', rootId: 'today' },
        { kind: 'file-preview', target },
      ],
    });

    act(() => {
      h.api.navigatePanelPreview('panel-test', target);
    });

    expect(h.api.panels[0]).toMatchObject({
      type: 'workspace',
      view: { kind: 'file-preview', target },
      backStack: [
        { kind: 'outliner', rootId: 'today' },
        { kind: 'file-preview', target },
        { kind: 'file-preview', target, presentation: 'reader' },
      ],
    });
  });

  test('loose file readers preserve presentation when restored from storage', () => {
    const target = { kind: 'local-file' as const, path: '/tmp/report.md', entryKind: 'file' as const, label: 'report.md' };
    const h = renderLayout({
      activePanelId: 'panel-test',
      panels: [{
        id: 'panel-test',
        type: 'workspace',
        size: 1,
        view: { kind: 'file-preview', target, presentation: 'reader' },
        backStack: [{ kind: 'outliner', rootId: 'today' }],
        forwardStack: [],
      }],
    });

    expect(h.api.panels[0]).toMatchObject({
      type: 'workspace',
      view: { kind: 'file-preview', target, presentation: 'reader' },
    });
  });

  test('reopening the same preview target is a layout no-op', () => {
    const target = { kind: 'local-file' as const, path: '/tmp/report.md', entryKind: 'file' as const, label: 'report.md' };
    const h = renderLayout({
      activePanelId: 'panel-test',
      panels: [{
        id: 'panel-test',
        type: 'workspace',
        size: 1,
        view: { kind: 'file-preview', target, presentation: 'reader' },
        backStack: [{ kind: 'outliner', rootId: 'today' }],
        forwardStack: [],
      }],
    });
    const beforePanels = h.api.panels;

    act(() => {
      h.api.navigatePanelPreview('panel-test', target, { presentation: 'reader' });
    });

    expect(h.api.panels).toBe(beforePanels);
    expect(h.api.panels[0]).toMatchObject({
      type: 'workspace',
      view: { kind: 'file-preview', target, presentation: 'reader' },
      backStack: [{ kind: 'outliner', rootId: 'today' }],
      forwardStack: [],
    });
  });

  test('back to a scrolled outliner view clears focus without clearing selection state', () => {
    const h = renderLayout({
      activePanelId: 'panel-test',
      panels: [{
        id: 'panel-test',
        type: 'workspace',
        size: 1,
        view: {
          kind: 'file-preview',
          target: { kind: 'url', url: 'https://example.com/file.pdf' },
        },
        backStack: [{ kind: 'outliner', rootId: 'alpha', scrollTop: 420 }],
        forwardStack: [],
      }],
    });

    let previous: ReturnType<LayoutApi['navigatePanelBack']> = null;
    act(() => {
      previous = h.api.navigatePanelBack('panel-test');
    });

    expect(previous).toEqual({ kind: 'outliner', rootId: 'alpha', scrollTop: 420 });
    expect(h.focusCalls).toEqual([null]);
    expect(h.clearFocusAndSelectionCalls).toBe(0);
  });

  test('forward to a scrolled outliner view clears focus without clearing selection state', () => {
    const h = renderLayout({
      activePanelId: 'panel-test',
      panels: [{
        id: 'panel-test',
        type: 'workspace',
        size: 1,
        view: {
          kind: 'file-preview',
          target: { kind: 'url', url: 'https://example.com/file.pdf' },
        },
        backStack: [],
        forwardStack: [{ kind: 'outliner', rootId: 'alpha', scrollTop: 420 }],
      }],
    });

    let next: ReturnType<LayoutApi['navigatePanelForward']> = null;
    act(() => {
      next = h.api.navigatePanelForward('panel-test');
    });

    expect(next).toEqual({ kind: 'outliner', rootId: 'alpha', scrollTop: 420 });
    expect(h.focusCalls).toEqual([null]);
    expect(h.clearFocusAndSelectionCalls).toBe(0);
  });

});

function renderLayout(layout: WorkspaceLayout) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const storage = new MemoryStorage();
  storage.setItem('lin-outliner:workspace-layout:v5', JSON.stringify({
    version: 5,
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

  const focusCalls: Array<NodeId | null> = [];
  let clearFocusAndSelectionCalls = 0;
  let api: LayoutApi | null = null;

  const Probe = () => {
    api = useWorkspaceLayout({
      focusNode: (nodeId) => {
        focusCalls.push(nodeId);
      },
      clearFocusAndSelection: () => {
        clearFocusAndSelectionCalls += 1;
      },
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
    focusCalls,
    get clearFocusAndSelectionCalls() {
      return clearFocusAndSelectionCalls;
    },
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
      node('root', { children: ['today', 'alpha'] }),
      node('today', { parentId: 'root' }),
      node('alpha', { parentId: 'root' }),
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
