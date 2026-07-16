import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { Locale } from '../../src/core/locale';
import type { PreviewFileSource, PreviewResolveSourceResult } from '../../src/core/preview';
import type { UrlPageTranslationPreferences } from '../../src/core/urlPageTranslation';
import type { NodeProjection } from '../../src/core/types';
import type { TranslationLanguage } from '../../src/core/translationLanguage';
import type { DocumentIndex, UiState } from '../../src/renderer/state/document';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { FilePreviewPanel } from '../../src/renderer/ui/preview/FilePreviewPanel';
import { resetUrlPageTranslationPreferencesForTests } from '../../src/renderer/ui/preview/urlPageTranslationPreferences';

const makeBookInputs: unknown[] = [];
const originalFetch = globalThis.fetch;

mock.module('foliate-js/view.js', () => ({
  makeBook: async (input: unknown) => {
    makeBookInputs.push(input);
    return {
      metadata: { language: ['en'] },
      sections: [{ load: () => 'about:blank', unload: () => undefined }],
      toc: [],
      destroy: () => undefined,
    };
  },
}));

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  globalThis.fetch = originalFetch;
  makeBookInputs.length = 0;
  resetUrlPageTranslationPreferencesForTests();
});

describe('FilePreviewPanel EPUB translation chrome', () => {
  test('shows the shared control while keeping local automatic translation independent', async () => {
    const rendered = renderEpubPanel({
      translationModel: null,
      autoTranslateEpubs: false,
      autoTranslateUrls: true,
    });
    await waitFor(() => rendered.document.querySelector('.file-preview-translation-toggle') !== null);
    const toggle = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-toggle');
    expect(toggle?.getAttribute('aria-label')).toBe('Translation settings: Translation off');
    expect(rendered.document.querySelector('.file-preview-reader-title')?.textContent).toContain('book.epub');
    expect(rendered.invokedCommands).not.toContain('url_page_translate_blocks');

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    const autoSwitch = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-auto-switch');
    expect(autoSwitch?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      autoSwitch?.click();
      await Promise.resolve();
    });
    expect(rendered.savedPreferences.at(-1)).toEqual({
      translationModel: null,
      autoTranslateEpubs: true,
      autoTranslateUrls: true,
    });
    await waitFor(() => (
      rendered.document.querySelector('.file-preview-translation-toggle')?.getAttribute('aria-label')
      === 'Translation settings: Translation on'
    ));
  });

  test('keeps an active translation session when localized status labels change', async () => {
    const rendered = renderEpubPanel({
      translationModel: null,
      autoTranslateEpubs: false,
      autoTranslateUrls: false,
    });
    await waitFor(() => rendered.document.querySelector('.file-preview-translation-toggle') !== null);

    await act(async () => {
      rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-toggle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-command')?.click();
      await Promise.resolve();
    });
    await waitFor(() => (
      rendered.document.querySelector('.file-preview-translation-toggle')?.getAttribute('aria-label')
      === 'Translation settings: Translation on'
    ));

    await act(async () => {
      rendered.changeUiLanguage('zh-Hans');
      await Promise.resolve();
    });
    await waitFor(() => rendered.document.documentElement.lang === 'zh-Hans');
    expect(rendered.document.querySelector('.file-preview-translation-toggle')?.getAttribute('data-translation-enabled'))
      .toBe('true');
  });

  test('streams image-heavy EPUBs without using the generic preview byte read', async () => {
    const streamUrl = 'preview-local://large-epub';
    let requestedRange: string | null = null;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(streamUrl);
      requestedRange = new Headers(init?.headers).get('range');
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 206,
        headers: {
          'content-length': '4',
          'content-range': `bytes 0-3/${29 * 1024 * 1024}`,
          'content-type': 'application/epub+zip',
        },
      });
    }) as typeof fetch;

    const rendered = renderEpubPanel({
      translationModel: null,
      autoTranslateEpubs: false,
      autoTranslateUrls: false,
    }, {
      sizeBytes: 29 * 1024 * 1024,
      streamUrl,
    });

    await waitFor(() => (
      rendered.document.querySelector('.file-preview-epub-host')?.getAttribute('aria-hidden') === 'false'
    ));
    expect(requestedRange).toBe(`bytes=0-${128 * 1024 * 1024}`);
    expect(rendered.invokedCommands).not.toContain('preview_read_bytes');
    expect(makeBookInputs.at(-1)).toBeInstanceOf(File);
    expect((makeBookInputs.at(-1) as File).name).toBe('book.epub');
  });

  test('cancels an EPUB stream whose current size exceeds the package limit', async () => {
    let bodyCancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancelled = true;
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      },
    }), {
      status: 206,
      headers: {
        'content-range': `bytes 0-134217728/${129 * 1024 * 1024}`,
        'content-type': 'application/epub+zip',
      },
    })) as typeof fetch;

    const rendered = renderEpubPanel({
      translationModel: null,
      autoTranslateEpubs: false,
      autoTranslateUrls: false,
    }, {
      sizeBytes: 29 * 1024 * 1024,
      streamUrl: 'preview-local://changed-large-epub',
    });

    await waitFor(() => (
      rendered.document.querySelector('.file-preview-unavailable-note')?.textContent
      === 'This file is too large to preview.'
    ));
    expect(bodyCancelled).toBe(true);
    expect(rendered.invokedCommands).not.toContain('preview_read_bytes');
    expect(makeBookInputs).toHaveLength(0);
  });
});

function renderEpubPanel(
  initialPreferences: UrlPageTranslationPreferences,
  sourceOverrides: Partial<PreviewFileSource> = {},
): {
  changeUiLanguage: (locale: Locale) => void;
  document: Document;
  invokedCommands: string[];
  savedPreferences: UrlPageTranslationPreferences[];
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window as unknown as Window);
  const invokedCommands: string[] = [];
  const savedPreferences: UrlPageTranslationPreferences[] = [];
  let languageListener: ((locale: Locale) => void) | null = null;
  const target = { kind: 'local-file' as const, path: '/tmp/book.epub', entryKind: 'file' as const };
  const previewSource: PreviewFileSource = {
    kind: 'file',
    sourceKind: 'local-file',
    id: 'epub:test',
    target,
    name: 'book.epub',
    ext: 'epub',
    mimeType: 'application/epub+zip',
    entryKind: 'file',
    sizeBytes: 1_024,
    displayPath: '/tmp/book.epub',
    ...sourceOverrides,
  };
  (window as unknown as {
    lin: {
      initialLanguage: Locale;
      initialTranslationLanguage: TranslationLanguage;
      initialUrlPageTranslationPreferences: UrlPageTranslationPreferences;
      invoke: (command: string) => Promise<unknown>;
      onLanguageChanged: (listener: (locale: Locale) => void) => () => void;
      onTranslationLanguageChanged: () => () => void;
      onUrlPageTranslationPreferencesChanged: () => () => void;
      onUrlPageTranslationShortcut: () => () => void;
      setLanguage: () => Promise<void>;
      setTranslationLanguage: () => Promise<void>;
      setUrlPageTranslationPreferences: (preferences: UrlPageTranslationPreferences) => Promise<UrlPageTranslationPreferences>;
    };
  }).lin = {
    initialLanguage: 'en',
    initialTranslationLanguage: 'zh-Hans',
    initialUrlPageTranslationPreferences: initialPreferences,
    invoke: async (command) => {
      invokedCommands.push(command);
      if (command === 'preview_resolve_source') {
        return {
          source: previewSource,
        } satisfies PreviewResolveSourceResult;
      }
      if (command === 'preview_read_bytes') {
        return { bytes: new Uint8Array([1]).buffer, mimeType: 'application/epub+zip' };
      }
      if (command === 'agent_get_provider_settings') return providerSettingsFixture();
      return {};
    },
    onLanguageChanged: (listener) => {
      languageListener = listener;
      return () => {
        if (languageListener === listener) languageListener = null;
      };
    },
    onTranslationLanguageChanged: () => () => undefined,
    onUrlPageTranslationPreferencesChanged: () => () => undefined,
    onUrlPageTranslationShortcut: () => () => undefined,
    setLanguage: async () => undefined,
    setTranslationLanguage: async () => undefined,
    setUrlPageTranslationPreferences: async (preferences) => {
      savedPreferences.push(preferences);
      return preferences;
    },
  };
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root');
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <FilePreviewPanel
          activePanel
          canGoBack={false}
          dragId={null}
          index={emptyIndex()}
          isNodePinned={() => false}
          onBack={() => undefined}
          onClose={() => undefined}
          onOpenTarget={() => undefined}
          onRoot={() => undefined}
          onTogglePin={() => undefined}
          panelId="panel-epub"
          presentation="reader"
          run={async () => null}
          setDragId={() => undefined}
          setTrigger={() => undefined}
          setUi={() => undefined}
          showClose
          target={target}
          trigger={null}
          ui={emptyUi()}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ cleanup: () => act(() => root.unmount()) });
  return {
    changeUiLanguage: (locale) => languageListener?.(locale),
    document,
    invokedCommands,
    savedPreferences,
  };
}

function providerSettingsFixture(): unknown {
  return {
    activeProviderId: 'openai',
    providers: [{
      providerId: 'openai',
      enabled: true,
      hasApiKey: true,
      auth: { authKind: 'api-key', credentialed: true },
    }],
    availableProviders: [{
      providerId: 'openai',
      authKind: 'api-key',
      hasEnvApiKey: false,
      envKeyNames: [],
      models: [],
    }],
    agent: {},
    imageGeneration: {},
  };
}

function emptyIndex(): DocumentIndex {
  const nodes = ['root', 'library', 'trash'].map(node);
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

function installDomGlobals(window: Window): void {
  Object.defineProperties(window, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => { callback(0); return 0; },
    },
    cancelAnimationFrame: {
      configurable: true,
      value: () => undefined,
    },
  });
  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IntersectionObserver: class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      takeRecords() { return []; }
      unobserve() {}
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for EPUB preview chrome');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}
