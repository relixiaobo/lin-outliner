import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { NodeProjection } from '../../src/core/types';
import type { PreviewResolveSourceResult } from '../../src/core/preview';
import type { DocumentIndex, UiState } from '../../src/renderer/state/document';
import { FilePreviewPanel } from '../../src/renderer/ui/preview/FilePreviewPanel';

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('FilePreviewPanel URL preview chrome', () => {
  test('shows URL title in the breadcrumb without a duplicate file heading', async () => {
    const rendered = renderUrlPanel();

    await act(async () => {
      await Promise.resolve();
    });

    expect(rendered.document.querySelector('.file-preview-url-title')?.textContent).toContain('Example docs');
    expect(rendered.document.querySelector('.file-preview-panel--fill')).not.toBeNull();
    expect(rendered.document.querySelector('.file-preview-content')).not.toBeNull();
    expect(rendered.document.querySelector('.panel-title-file-heading')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-message')).toBeNull();
    expect(rendered.document.querySelector('.file-preview-url-webview')?.getAttribute('src')).toBe('https://example.com/docs');
    const translationToggle = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-toggle');
    expect(translationToggle?.getAttribute('aria-label')).toBe('Translate page');
    expect(translationToggle?.getAttribute('aria-pressed')).toBe('false');
  });

  test('updates the breadcrumb from webview page title and favicon events', async () => {
    const rendered = renderUrlPanel();

    await act(async () => {
      await Promise.resolve();
    });

    const webview = rendered.document.querySelector('.file-preview-url-webview');
    if (!webview) throw new Error('Missing URL webview');

    await act(async () => {
      const titleEvent = new rendered.window.Event('page-title-updated');
      Object.defineProperty(titleEvent, 'title', { value: 'vega / vega-lite' });
      webview.dispatchEvent(titleEvent);

      const faviconEvent = new rendered.window.Event('page-favicon-updated');
      Object.defineProperty(faviconEvent, 'favicons', { value: ['https://github.githubassets.com/favicons/favicon.svg'] });
      webview.dispatchEvent(faviconEvent);
      await Promise.resolve();
    });

    expect(rendered.document.querySelector('.file-preview-url-title')?.textContent).toContain('vega / vega-lite');
    const favicon = rendered.document.querySelector<HTMLImageElement>('.file-preview-url-favicon');
    expect(favicon?.getAttribute('src')).toBe('https://github.githubassets.com/favicons/favicon.svg');
  });
});

function renderUrlPanel(): { document: Document; window: Window } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  (window as unknown as {
    lin: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<PreviewResolveSourceResult>;
    };
  }).lin = {
    invoke: () => Promise.resolve({ source: null }),
  };
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <FilePreviewPanel
        canGoBack={false}
        dragId={null}
        index={emptyIndex()}
        isNodePinned={() => false}
        onBack={() => undefined}
        onClose={() => undefined}
        onOpenTarget={() => undefined}
        onRoot={() => undefined}
        onTogglePin={() => undefined}
        panelId="panel-url"
        run={async () => null}
        setDragId={() => undefined}
        setTrigger={() => undefined}
        setUi={() => undefined}
        showClose
        target={{ kind: 'url', url: 'https://example.com/docs', label: 'Example docs' }}
        trigger={null}
        ui={emptyUi()}
      />,
    );
  });
  mounted.push({ cleanup: () => act(() => root.unmount()) });
  return { document, window };
}

function emptyIndex(): DocumentIndex {
  const nodes: NodeProjection[] = [
    node('root'),
    node('library'),
    node('trash'),
  ];
  return {
    projection: {
      workspaceId: 'workspace',
      rootId: 'root',
      libraryId: 'library',
      dailyNotesId: 'daily-notes',
      schemaId: 'schema',
      searchesId: 'searches',
      recentsId: 'recents',
      trashId: 'trash',
      todayId: 'today',
      nodes,
    },
    byId: new Map(nodes.map((entry) => [entry.id, entry])),
  };
}

function node(id: string): NodeProjection {
  return {
    id,
    children: [],
    content: { text: '', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
  } as NodeProjection;
}

function emptyUi(): UiState {
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
    pendingReferenceTypeAhead: null,
    trailingDraftPlacement: null,
    expanded: new Set(),
    expandedHiddenFields: new Set(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  };
}

function installDomGlobals(window: Window) {
  (window as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame = (cb) => { cb(0); return 0; };
  (window as unknown as { cancelAnimationFrame: (handle: number) => void })
    .cancelAnimationFrame = () => undefined;
  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
