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
  test('opens Trajectory in the current pane and preserves Back navigation', () => {
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
      h.api.openThreadTrajectoryPanel('thread-alpha', { turnId: 'turn-one' });
    });

    expect(h.api.panels).toHaveLength(1);
    expect(h.api.panels[0]).toMatchObject({
      id: 'panel-test',
      type: 'workspace',
      view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
      backStack: [{ kind: 'outliner', rootId: 'today' }],
      forwardStack: [],
    });
    expect(h.api.activePanelId).toBe('panel-test');

    act(() => {
      h.api.openThreadTrajectoryPanel('thread-beta', { turnId: 'turn-two' });
    });

    expect(h.api.panels).toHaveLength(1);
    expect(h.api.panels[0]).toMatchObject({
      view: { kind: 'thread-trajectory', threadId: 'thread-beta', turnId: 'turn-two' },
      backStack: [{ kind: 'outliner', rootId: 'today' }],
    });
    expect(h.clearFocusAndSelectionCalls).toBe(2);

    act(() => {
      h.api.navigatePanelBack('panel-test');
    });
    expect(h.api.panels[0]).toMatchObject({
      view: { kind: 'outliner', rootId: 'today' },
      forwardStack: [{ kind: 'thread-trajectory', threadId: 'thread-beta', turnId: 'turn-two' }],
    });
  });

  test('restores a same-day Trajectory view with its outliner history', () => {
    const h = renderLayout({
      activePanelId: 'panel-debug',
      panels: [{
        id: 'panel-debug',
        type: 'workspace',
        size: 1,
        view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
        backStack: [{ kind: 'outliner', rootId: 'today' }],
        forwardStack: [],
      }],
    });

    expect(h.api.activePanelId).toBe('panel-debug');
    expect(h.api.panels[0]).toEqual({
      id: 'panel-debug',
      type: 'workspace',
      size: 1,
      view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
      backStack: [{ kind: 'outliner', rootId: 'today' }],
      forwardStack: [],
    });
  });

  test('restores an invalid current view from the latest Back outliner', () => {
    const h = renderLayout({
      activePanelId: 'panel-reader',
      panels: [{
        id: 'panel-reader',
        type: 'workspace',
        size: 2.5,
        view: {
          kind: 'file-preview',
          target: { kind: 'asset', assetId: 'legacy-asset', label: 'legacy.md' },
        },
        backStack: [
          { kind: 'outliner', rootId: 'today', scrollTop: 120 },
          { kind: 'outliner', rootId: 'missing' },
          { kind: 'outliner', rootId: 'alpha', scrollTop: 240 },
          { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
        ],
        forwardStack: [{ kind: 'outliner', rootId: 'today', scrollTop: 360 }],
      }],
    });

    expect(h.api.activePanelId).toBe('panel-reader');
    expect(h.api.panels).toEqual([{
      id: 'panel-reader',
      type: 'workspace',
      size: 2.5,
      view: { kind: 'outliner', rootId: 'alpha', scrollTop: 240 },
      recoveryRootId: 'alpha',
      backStack: [{ kind: 'outliner', rootId: 'today', scrollTop: 120 }],
      forwardStack: [
        { kind: 'outliner', rootId: 'today', scrollTop: 360 },
        { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
      ],
    }]);
  });

  test('restores from a Forward outliner without auto-opening a nearer URL', () => {
    const h = renderLayout({
      activePanelId: 'panel-reader',
      panels: [{
        id: 'panel-reader',
        type: 'workspace',
        size: 1,
        view: {
          kind: 'file-preview',
          target: { kind: 'asset', assetId: 'legacy-current', label: 'current.md' },
        },
        backStack: [
          { kind: 'outliner', rootId: 'missing' },
          {
            kind: 'file-preview',
            target: { kind: 'asset', assetId: 'legacy-back', label: 'back.md' },
          },
        ],
        forwardStack: [
          { kind: 'outliner', rootId: 'today', scrollTop: 120 },
          { kind: 'outliner', rootId: 'alpha', scrollTop: 240 },
          {
            kind: 'file-preview',
            target: { kind: 'url', url: 'https://example.com/navigated-away' },
          },
        ],
      }],
    });

    expect(h.api.panels).toEqual([{
      id: 'panel-reader',
      type: 'workspace',
      size: 1,
      view: { kind: 'outliner', rootId: 'alpha', scrollTop: 240 },
      recoveryRootId: 'alpha',
      backStack: [{
        kind: 'file-preview',
        target: { kind: 'url', url: 'https://example.com/navigated-away' },
      }],
      forwardStack: [{ kind: 'outliner', rootId: 'today', scrollTop: 120 }],
    }]);
  });

  test('uses Today for an active pane with no valid view and removes the recovery duplicate', () => {
    const h = renderLayout({
      activePanelId: 'panel-invalid',
      panels: [
        {
          id: 'panel-base',
          type: 'workspace',
          size: 1,
          view: { kind: 'outliner', rootId: 'today' },
          backStack: [],
          forwardStack: [],
        },
        {
          id: 'panel-invalid',
          type: 'workspace',
          size: 2,
          view: {
            kind: 'file-preview',
            target: { kind: 'asset', assetId: 'legacy-current', label: 'current.md' },
          },
          backStack: [{ kind: 'outliner', rootId: 'missing' }],
          forwardStack: [{
            kind: 'file-preview',
            target: { kind: 'asset', assetId: 'legacy-forward', label: 'forward.md' },
          }],
        },
      ],
    });

    expect(h.api.activePanelId).toBe('panel-invalid');
    expect(h.api.panels).toEqual([{
      id: 'panel-invalid',
      type: 'workspace',
      size: 2,
      view: { kind: 'outliner', rootId: 'today' },
      recoveryRootId: 'today',
      backStack: [],
      forwardStack: [],
    }]);
  });

  test('collapses duplicate roots produced by two recovered panes', () => {
    const invalidView = {
      kind: 'file-preview' as const,
      target: { kind: 'asset' as const, assetId: 'legacy-asset', label: 'legacy.md' },
    };
    const h = renderLayout({
      activePanelId: 'panel-second',
      panels: [
        {
          id: 'panel-first',
          type: 'workspace',
          size: 1,
          view: invalidView,
          backStack: [{ kind: 'outliner', rootId: 'today' }],
          forwardStack: [],
        },
        {
          id: 'panel-second',
          type: 'workspace',
          size: 2,
          view: invalidView,
          backStack: [{ kind: 'outliner', rootId: 'today' }],
          forwardStack: [],
        },
      ],
    });

    expect(h.api.activePanelId).toBe('panel-second');
    expect(h.api.panels).toEqual([{
      id: 'panel-second',
      type: 'workspace',
      size: 2,
      view: { kind: 'outliner', rootId: 'today' },
      recoveryRootId: 'today',
      backStack: [],
      forwardStack: [],
    }]);
  });

  test('uses a fresh split recovery root when no navigation history exists', () => {
    const h = renderLayout({
      activePanelId: 'panel-reader',
      panels: [
        {
          id: 'panel-base',
          type: 'workspace',
          size: 1,
          view: { kind: 'outliner', rootId: 'today' },
          backStack: [],
          forwardStack: [],
        },
        {
          id: 'panel-reader',
          type: 'workspace',
          size: 1.5,
          view: {
            kind: 'file-preview',
            target: { kind: 'asset', assetId: 'deleted-asset', label: 'deleted.md' },
          },
          recoveryRootId: 'alpha',
          backStack: [],
          forwardStack: [],
        },
      ],
    });

    expect(h.api.activePanelId).toBe('panel-reader');
    expect(h.api.panels).toEqual([
      {
        id: 'panel-base',
        type: 'workspace',
        size: 1,
        view: { kind: 'outliner', rootId: 'today' },
        backStack: [],
        forwardStack: [],
      },
      {
        id: 'panel-reader',
        type: 'workspace',
        size: 1.5,
        view: { kind: 'outliner', rootId: 'alpha' },
        recoveryRootId: 'alpha',
        backStack: [],
        forwardStack: [],
      },
    ]);
  });

  test('preserves intentional duplicate outliner panes when neither was recovered', () => {
    const h = renderLayout({
      activePanelId: 'panel-second',
      panels: [
        {
          id: 'panel-first',
          type: 'workspace',
          size: 1,
          view: { kind: 'outliner', rootId: 'today' },
          backStack: [],
          forwardStack: [],
        },
        {
          id: 'panel-second',
          type: 'workspace',
          size: 1,
          view: { kind: 'outliner', rootId: 'today' },
          backStack: [],
          forwardStack: [],
        },
      ],
    });

    expect(h.api.activePanelId).toBe('panel-second');
    expect(h.api.panels.map((panel) => panel.id)).toEqual(['panel-first', 'panel-second']);
  });

  test('global root navigation leaves active Trajectory and reuses an existing outliner pane', () => {
    const h = renderLayout({
      activePanelId: 'panel-details',
      panels: [
        {
          id: 'panel-outliner',
          type: 'workspace',
          size: 1,
          view: { kind: 'outliner', rootId: 'today' },
          backStack: [],
          forwardStack: [],
        },
        {
          id: 'panel-details',
          type: 'workspace',
          size: 1,
          view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
          backStack: [{ kind: 'outliner', rootId: 'alpha' }],
          forwardStack: [],
        },
      ],
    });

    act(() => {
      h.api.navigateRoot('alpha');
    });

    expect(h.api.activePanelId).toBe('panel-outliner');
    expect(h.api.panels).toEqual([
      {
        id: 'panel-outliner',
        type: 'workspace',
        size: 1,
        view: { kind: 'outliner', rootId: 'alpha' },
        backStack: [{ kind: 'outliner', rootId: 'today' }],
        forwardStack: [],
      },
      {
        id: 'panel-details',
        type: 'workspace',
        size: 1,
        view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
        backStack: [{ kind: 'outliner', rootId: 'alpha' }],
        forwardStack: [],
      },
    ]);
  });

  test('global root navigation adds an outliner beside a lone Trajectory pane', () => {
    const h = renderLayout({
      activePanelId: 'panel-details',
      panels: [{
        id: 'panel-details',
        type: 'workspace',
        size: 1,
        view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
        backStack: [{ kind: 'outliner', rootId: 'today' }],
        forwardStack: [],
      }],
    });

    act(() => {
      h.api.navigateRoot('alpha');
    });

    expect(h.api.panels).toHaveLength(2);
    expect(h.api.panels[0]).toMatchObject({
      id: 'panel-details',
      view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
    });
    expect(h.api.panels[1]).toMatchObject({
      type: 'workspace',
      view: { kind: 'outliner', rootId: 'alpha' },
    });
    expect(h.api.activePanelId).toBe(h.api.panels[1]?.id);
  });

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
      recoveryRootId: 'today',
      view: {
        kind: 'file-preview',
        nodeId: 'alpha',
        presentation: 'reader',
        target: { kind: 'asset', assetId: 'asset-alpha', label: 'reader-note.md' },
      },
    });
  });

  test('repairs a deleted fresh-split file node at runtime with the restore policy', () => {
    const h = renderLayout({
      activePanelId: 'panel-base',
      panels: [{
        id: 'panel-base',
        type: 'workspace',
        size: 1,
        view: { kind: 'outliner', rootId: 'today' },
        backStack: [],
        forwardStack: [],
      }],
    });

    act(() => {
      h.api.navigatePanelPreview('panel-base', {
        kind: 'asset',
        assetId: 'asset-alpha',
        label: 'reader-note.md',
      }, { newPane: true, nodeId: 'alpha', presentation: 'reader' });
    });
    const readerPanelId = h.api.activePanelId;
    const nextProjection = projection();
    const nodes = nextProjection.nodes
      .filter((candidate) => candidate.id !== 'alpha')
      .map((candidate) => candidate.id === 'root'
        ? { ...candidate, children: candidate.children.filter((childId) => childId !== 'alpha') }
        : candidate);
    const withoutFileNode = { ...nextProjection, nodes };
    const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
    let repairedRootId: NodeId | null = null;

    act(() => {
      repairedRootId = h.api.repairInvalidPanelViews(withoutFileNode, byId);
    });

    expect(repairedRootId).toBe('today');
    expect(h.api.activePanelId).toBe(readerPanelId);
    expect(h.api.panels).toEqual([{
      id: readerPanelId,
      type: 'workspace',
      size: 1,
      view: { kind: 'outliner', rootId: 'today' },
      recoveryRootId: 'today',
      backStack: [],
      forwardStack: [],
    }]);
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
  storage.setItem('lin-outliner:workspace-layout:v7', JSON.stringify({
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
