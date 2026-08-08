import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';
import { buildIndex } from '../../src/renderer/state/document';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { Sidebar } from '../../src/renderer/ui/Sidebar';

// The sidebar's Search row: the mouse-reachable entry point to the command
// surface. Its keystroke hint must come from the accelerator that actually
// REGISTERED — which now lives in main, because the summon is a global hotkey
// that may have fallen back — never from a literal in the sidebar. A hardcoded
// hint would survive the guard below and keep lying about the keystroke.

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

function projection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'library',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes: [
      node('root', 'Workspace'),
      node('library', 'Library'),
      node('daily', 'Daily notes'),
      node('schema', 'Schema'),
      node('searches', 'Saved searches'),
      node('recents', 'Recents'),
      node('trash', 'Trash'),
      node('today', 'Today'),
    ],
  };
}

interface Rendered { cleanup: () => void; document: Document; window: Window & typeof globalThis; }
const mounted: Rendered[] = [];
afterEach(() => { while (mounted.length) mounted.pop()?.cleanup(); });

function renderSidebar(
  onOpenSearch: () => void = () => {},
  hotkey: string | null = 'CommandOrControl+Shift+Space',
): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as { document: Document; window: Window & typeof globalThis };
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { lin: unknown }).lin = {
    initialLanguage: 'en',
    getLauncherHotkey: async () => hotkey,
  };
  const index = buildIndex(projection());
  const container = document.getElementById('root')!;
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <Sidebar
          expandedIds={new Set()}
          index={index}
          isNodePinned={() => false}
          onNavigateToday={() => {}}
          onNavigateRoot={() => {}}
          onOpenPanel={() => {}}
          onOpenSearch={onOpenSearch}
          onOpenSettings={() => {}}
          onResizeKeyDown={() => {}}
          onResizeReset={() => {}}
          onResizeStart={() => {}}
          onToggleTreeNode={() => {}}
          onTogglePin={() => {}}
          onReorderPin={() => {}}
          pinnedNodeIds={[]}
          projection={index.projection}
          rootId={null}
        />
      </I18nProvider>,
    );
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
  mounted.push(rendered);
  return rendered;
}

async function renderSidebarWithHotkey(accelerator: string | null): Promise<Rendered> {
  const r = renderSidebar(() => {}, accelerator);
  await act(async () => { await Promise.resolve(); });
  return r;
}

function navRows(r: Rendered): HTMLElement[] {
  return Array.from(r.document.querySelectorAll<HTMLElement>('.sidebar-nav-item'));
}

describe('Sidebar Search row', () => {
  test('is the first primary-nav row, above Today', () => {
    const r = renderSidebar();
    const labels = navRows(r).map((row) => row.textContent);
    expect(labels[0]).toContain('Search');
    expect(labels[1]).toContain('Today');
  });

  test('clicking it opens the command surface', () => {
    let opened = 0;
    const r = renderSidebar(() => { opened += 1; });
    act(() => {
      navRows(r)[0].dispatchEvent(new r.window.Event('click', { bubbles: true }));
    });
    expect(opened).toBe(1);
  });

  test('the hint follows the accelerator that actually registered', async () => {
    const first = await renderSidebarWithHotkey('CommandOrControl+Shift+Space');
    expect(navRows(first)[0].querySelector('.sidebar-nav-hint')?.textContent).toBe('⌘⇧Space');
    // The accessible name stays "Search" — the hint is decoration for the eye.
    expect(navRows(first)[0].querySelector('.sidebar-nav-hint')?.getAttribute('aria-hidden')).toBe('true');

    // The guard: change what main says registered, and the row must follow.
    const rebound = await renderSidebarWithHotkey('CommandOrControl+Shift+J');
    expect(rebound.document.querySelector('.sidebar-nav-hint')?.textContent).toBe('⌘⇧J');
  });

  test('no accelerator registered → the row shows no hint rather than a lie', async () => {
    const r = await renderSidebarWithHotkey(null);
    expect(r.document.querySelector('.sidebar-nav-hint')).toBeNull();
  });
});
