import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { NodeProjection } from '../../src/core/types';
import type { UrlPageTranslationPreferences } from '../../src/core/urlPageTranslation';
import type { PreviewResolveSourceResult } from '../../src/core/preview';
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from '../../src/core/translationLanguage';
import type { DocumentIndex, UiState } from '../../src/renderer/state/document';
import { FilePreviewPanel } from '../../src/renderer/ui/preview/FilePreviewPanel';
import { resetUrlPageTranslationPreferencesForTests } from '../../src/renderer/ui/preview/urlPageTranslationPreferences';

const mounted: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  resetUrlPageTranslationPreferencesForTests();
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
    expect(translationToggle?.getAttribute('aria-label')).toBe('Translation settings: Translation off');
    expect(translationToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(translationToggle?.hasAttribute('aria-pressed')).toBe(false);
    expect(translationToggle?.getAttribute('data-translation-enabled')).toBe('false');
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

  test('opens the target-language popover, remembers a selection, and does not check an untranslated page', async () => {
    const rendered = renderUrlPanel();
    const toggle = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-toggle');
    const webview = rendered.document.querySelector('.file-preview-url-webview') as Electron.WebviewTag | null;
    if (!toggle || !webview) throw new Error('Missing URL translation controls');
    installReadyWebview(webview);

    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const select = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Translate to"]');
    expect(select?.querySelectorAll('option')).toHaveLength(TRANSLATION_LANGUAGES.length);
    expect(select?.textContent).toContain('日本語');
    if (!select) throw new Error('Missing target-language select');
    await act(async () => {
      Object.defineProperty(select, 'value', { configurable: true, value: 'ja' });
      select.dispatchEvent(new rendered.window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(rendered.savedLanguages).toEqual(['ja']);

    const modelSelect = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Model"]');
    expect(modelSelect?.textContent).toContain('Agent model');
    expect(modelSelect?.textContent).toContain('GPT-4.1 mini');
    expect(modelSelect?.querySelector('optgroup')?.getAttribute('label')).toBe('OpenAI');
    if (!modelSelect) throw new Error('Missing translation-model select');
    await act(async () => {
      Object.defineProperty(modelSelect, 'value', { configurable: true, value: 'openai/gpt-4.1-mini' });
      modelSelect.dispatchEvent(new rendered.window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      Object.defineProperty(modelSelect, 'value', { configurable: true, value: '' });
      modelSelect.dispatchEvent(new rendered.window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(rendered.savedTranslationPreferences.at(-1)).toEqual({
      translationModel: null,
      autoTranslateUrls: false,
    });
    await act(async () => {
      Object.defineProperty(modelSelect, 'value', { configurable: true, value: 'openai/gpt-4.1-mini' });
      modelSelect.dispatchEvent(new rendered.window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const autoSwitch = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-auto-switch');
    if (!autoSwitch) throw new Error('Missing automatic-translation switch');
    expect(autoSwitch?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      autoSwitch?.click();
      await Promise.resolve();
    });
    expect(rendered.savedTranslationPreferences.at(-1)).toEqual({
      translationModel: 'openai/gpt-4.1-mini',
      autoTranslateUrls: true,
    });

    const command = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-command');
    expect(command?.textContent).toContain('Translate page');
    expect(command?.querySelector('svg')).not.toBeNull();
    expect(command?.classList.contains('button-primary')).toBe(true);
    expect(command?.nextElementSibling?.classList.contains('file-preview-translation-divider')).toBe(true);
    expect(command?.nextElementSibling?.nextElementSibling).toBe(autoSwitch);
    await act(async () => {
      command?.click();
      webview.dispatchEvent(new rendered.window.Event('dom-ready'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(toggle.getAttribute('data-translation-enabled')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toStartWith('Translation settings:');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelector('.file-preview-translation-check')).toBeNull();

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    const disableCommand = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-command');
    expect(disableCommand?.textContent).toContain('Show original');
    expect(disableCommand?.classList.contains('button-secondary')).toBe(true);
    await act(async () => {
      disableCommand?.click();
      await Promise.resolve();
    });
    expect(toggle.getAttribute('data-translation-enabled')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Translation settings: Translation off');
    expect(toggle.querySelector('.file-preview-translation-check')).toBeNull();
  });

  test('keeps an unavailable explicit model visible and requires another selection', async () => {
    const rendered = renderUrlPanel({
      initialTranslationPreferences: {
        translationModel: 'anthropic/claude-retired',
        autoTranslateUrls: false,
      },
    });
    const toggle = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-toggle');
    if (!toggle) throw new Error('Missing URL translation control');

    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const modelSelect = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Model"]');
    const unavailable = [...(modelSelect?.querySelectorAll('option') ?? [])]
      .find((option) => option.textContent?.includes('claude-retired'));
    expect(unavailable?.hasAttribute('disabled')).toBe(true);
    expect(unavailable?.textContent).toContain('unavailable');
    expect(modelSelect?.textContent).toContain('Agent model');
  });

  test('routes a webview shortcut only to the matching active URL panel', async () => {
    const rendered = renderUrlPanel();
    const toggle = rendered.document.querySelector<HTMLButtonElement>('.file-preview-translation-toggle');
    const webview = rendered.document.querySelector('.file-preview-url-webview') as Electron.WebviewTag | null;
    if (!toggle || !webview) throw new Error('Missing URL translation controls');
    webview.getWebContentsId = () => 71;

    await act(async () => {
      rendered.sendWebviewShortcut(99);
      await Promise.resolve();
    });
    expect(toggle.getAttribute('data-translation-enabled')).toBe('false');

    await act(async () => {
      rendered.sendWebviewShortcut(71);
      await Promise.resolve();
    });
    expect(toggle.getAttribute('data-translation-enabled')).toBe('true');
    expect(rendered.savedTranslationPreferences).toEqual([]);
  });
});

function renderUrlPanel(options: {
  initialTranslationPreferences?: UrlPageTranslationPreferences;
  providerSettings?: unknown;
} = {}): {
  document: Document;
  savedLanguages: TranslationLanguage[];
  savedTranslationPreferences: UrlPageTranslationPreferences[];
  sendWebviewShortcut: (webContentsId: number) => void;
  window: Window;
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const savedLanguages: TranslationLanguage[] = [];
  const savedTranslationPreferences: UrlPageTranslationPreferences[] = [];
  let shortcutListener: ((webContentsId: number) => void) | null = null;
  (window as unknown as {
    lin: {
      initialTranslationLanguage: TranslationLanguage;
      initialUrlPageTranslationPreferences: UrlPageTranslationPreferences;
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      onTranslationLanguageChanged: (listener: (language: TranslationLanguage) => void) => () => void;
      onUrlPageTranslationPreferencesChanged: (listener: (preferences: UrlPageTranslationPreferences) => void) => () => void;
      onUrlPageTranslationShortcut: (listener: (webContentsId: number) => void) => () => void;
      setTranslationLanguage: (language: TranslationLanguage) => Promise<void>;
      setUrlPageTranslationPreferences: (preferences: UrlPageTranslationPreferences) => Promise<UrlPageTranslationPreferences>;
    };
  }).lin = {
    initialTranslationLanguage: 'en',
    initialUrlPageTranslationPreferences: options.initialTranslationPreferences ?? {
      translationModel: null,
      autoTranslateUrls: false,
    },
    invoke: (command) => Promise.resolve(
      command === 'agent_get_provider_settings'
        ? options.providerSettings ?? translationProviderSettingsFixture()
        : { source: null } satisfies PreviewResolveSourceResult,
    ),
    onTranslationLanguageChanged: () => () => undefined,
    onUrlPageTranslationPreferencesChanged: () => () => undefined,
    onUrlPageTranslationShortcut: (listener) => {
      shortcutListener = listener;
      return () => {
        if (shortcutListener === listener) shortcutListener = null;
      };
    },
    setTranslationLanguage: async (language) => {
      savedLanguages.push(language);
    },
    setUrlPageTranslationPreferences: async (preferences) => {
      savedTranslationPreferences.push(preferences);
      return preferences;
    },
  };
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
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
  return {
    document,
    savedLanguages,
    savedTranslationPreferences,
    sendWebviewShortcut: (webContentsId) => shortcutListener?.(webContentsId),
    window,
  };
}

function translationProviderSettingsFixture(): unknown {
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
      models: [{
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        reasoning: false,
        supportedThinkingLevels: [],
        contextWindow: 1_000_000,
        maxTokens: 32_768,
      }],
    }],
    agent: {},
    imageGeneration: {},
  };
}

function installReadyWebview(webview: Electron.WebviewTag): void {
  webview.getURL = () => 'https://example.com/docs';
  webview.isLoadingMainFrame = () => false;
  webview.getWebContentsId = () => 71;
  webview.insertCSS = async () => 'translation-css';
  webview.removeInsertedCSS = async () => undefined;
  webview.executeJavaScript = async (source: string) => (
    source.includes('"nextBatch"') ? { blocks: [], priority: null } : null
  );
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
