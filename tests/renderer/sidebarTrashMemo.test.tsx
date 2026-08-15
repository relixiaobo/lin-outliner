import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection, NodeId, NodeProjection } from '../../src/core/types';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { buildIndex, type DocumentIndex } from '../../src/renderer/state/document';
import { Sidebar } from '../../src/renderer/ui/Sidebar';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('Sidebar branch memoization', () => {
  test('refreshes a pinned descendant when an ancestor enters Trash', () => {
    const before = indexedProjection(false);
    const after = indexedProjection(true);
    const rendered = renderSidebar(before);

    expect(pinnedRow(rendered.document).classList.contains('trashed')).toBe(false);
    act(() => { rendered.render(after); });
    expect(pinnedRow(rendered.document).classList.contains('trashed')).toBe(true);
  });
});

function renderSidebar(initialIndex: DocumentIndex): {
  document: Document;
  render: (index: DocumentIndex) => void;
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { lin: unknown }).lin = {
    initialLanguage: 'en',
    getLauncherHotkey: async () => null,
  };
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const expandedIds = new Set<NodeId>();
  const noop = () => undefined;
  const render = (index: DocumentIndex) => {
    root.render(
      <I18nProvider>
        <Sidebar
          expandedIds={expandedIds}
          index={index}
          isNodePinned={() => true}
          onNavigateToday={noop}
          onNavigateRoot={noop}
          onOpenPanel={noop}
          onOpenSearch={noop}
          onOpenSettings={noop}
          onResizeKeyDown={noop}
          onResizeReset={noop}
          onResizeStart={noop}
          onToggleTreeNode={noop}
          onTogglePin={noop}
          onReorderPin={noop}
          pinnedNodeIds={['pinned']}
          projection={index.projection}
          rootId={null}
        />
      </I18nProvider>,
    );
  };
  act(() => { render(initialIndex); });
  cleanups.push(() => act(() => root.unmount()));
  return { document, render };
}

function pinnedRow(document: Document): HTMLElement {
  const row = document.querySelector<HTMLElement>('.pinned-branch .workspace-tree-row');
  if (!row) throw new Error('Missing pinned row');
  return row;
}

function indexedProjection(trashed: boolean): DocumentIndex {
  const value = projection(trashed);
  const index = buildIndex(value);
  return {
    ...index,
    renderRev: new Map<NodeId, number>([
      ['root', trashed ? 2 : 1],
      ['parent', trashed ? 2 : 1],
      ['pinned', 1],
      ['trash', trashed ? 2 : 1],
    ]),
    semanticRevisions: {
      ...index.semanticRevisions,
      trashMembership: trashed ? 2 : 1,
    },
  };
}

function projection(trashed: boolean): DocumentProjection {
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
      node('root', 'Root', { children: trashed ? ['trash'] : ['parent', 'trash'] }),
      node('parent', 'Parent', {
        parentId: trashed ? 'trash' : 'root',
        children: ['pinned'],
      }),
      node('pinned', 'Pinned', { parentId: 'parent' }),
      node('trash', 'Trash', {
        parentId: 'root',
        children: trashed ? ['parent'] : [],
      }),
    ],
  };
}

function node(id: NodeId, text = id, patch: Partial<NodeProjection> = {}): NodeProjection {
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
