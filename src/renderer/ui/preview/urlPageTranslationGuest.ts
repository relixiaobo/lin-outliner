import type { TranslationLanguage } from '../../../core/translationLanguage';
import {
  URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
  URL_CAPTION_TRANSLATION_MAX_BLOCKS,
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
  type UrlPageTranslationBlock,
  type UrlPageTranslationContentKind,
  type UrlPageTranslationItem,
} from '../../../core/urlPageTranslation';
import {
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
  URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS,
  type UrlPageTranslationGuestActiveBatch,
  type UrlPageTranslationGuestBatchOptions,
  type UrlPageTranslationGuestCommand,
  type UrlPageTranslationGuestLabels,
} from '../../../core/urlPageTranslationGuest';

export {
  URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS,
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
} from '../../../core/urlPageTranslationGuest';
export type {
  UrlPageTranslationGuestActiveBatch,
  UrlPageTranslationGuestBatchOptions,
  UrlPageTranslationGuestLabels,
} from '../../../core/urlPageTranslationGuest';

const URL_PAGE_TRANSLATION_DEFAULT_MAX_BLOCKS = 4;
const URL_PAGE_TRANSLATION_DEFAULT_MAX_CHARS = 4_000;
const URL_CAPTION_TRANSLATION_DEFAULT_MAX_BLOCKS = 16;
const URL_CAPTION_TRANSLATION_DEFAULT_MAX_CHARS = 4_000;

export const URL_PAGE_TRANSLATION_GUEST_CSS = `
[data-tenon-bilingual-translation="true"] {
  display: block !important;
  width: 100% !important;
  flex-basis: 100% !important;
  margin-block-start: 0.35em !important;
  border: 0 !important;
  background: transparent !important;
  color: inherit !important;
  font: inherit !important;
  font-size: inherit !important;
  font-style: normal !important;
  font-weight: 400 !important;
  letter-spacing: 0 !important;
  line-height: inherit !important;
  opacity: 0.72 !important;
  overflow-anchor: none !important;
  text-decoration: none !important;
  text-transform: none !important;
  white-space: pre-wrap !important;
}
html[data-tenon-bilingual-hidden="true"] [data-tenon-bilingual-translation="true"] {
  display: none !important;
}
[data-tenon-bilingual-status] {
  all: unset !important;
  box-sizing: border-box !important;
  display: inline-flex !important;
  width: 16px !important;
  height: 16px !important;
  align-items: center !important;
  justify-content: center !important;
  margin-inline-start: 4px !important;
  border: 0 !important;
  border-radius: 50% !important;
  background: transparent !important;
  color: currentColor !important;
  cursor: default !important;
  font: 700 11px/1 system-ui, sans-serif !important;
  opacity: 0.52 !important;
  overflow-anchor: none !important;
  vertical-align: -2px !important;
}
[data-tenon-bilingual-status="loading"]::before {
  box-sizing: border-box !important;
  width: 10px !important;
  height: 10px !important;
  border: 1.5px solid currentColor !important;
  border-inline-end-color: transparent !important;
  border-radius: 50% !important;
  animation: tenon-bilingual-spin 0.8s linear infinite !important;
  content: "" !important;
}
[data-tenon-bilingual-status="error"] {
  border: 1px solid currentColor !important;
  opacity: 0.78 !important;
}
[data-tenon-bilingual-status="error"]:hover {
  opacity: 0.92 !important;
}
[data-tenon-bilingual-status="error"]:active {
  border-width: 2px !important;
  opacity: 1 !important;
}
[data-tenon-bilingual-status="error"]::before {
  content: "!" !important;
}
[data-tenon-bilingual-status="error"]:focus-visible {
  outline: 2px solid currentColor !important;
  outline-offset: 2px !important;
  opacity: 1 !important;
}
@keyframes tenon-bilingual-spin {
  to { transform: rotate(1turn); }
}
@media (prefers-contrast: more) {
  [data-tenon-bilingual-translation="true"],
  [data-tenon-bilingual-status] {
    opacity: 1 !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-tenon-bilingual-status="loading"]::before {
    animation: none !important;
  }
}
[data-tenon-bilingual-caption-player="true"] {
  position: relative !important;
}
[data-tenon-bilingual-caption-overlay] {
  --tenon-caption-background: rgb(0 0 0 / 0.72);
  --tenon-caption-foreground: rgb(255 255 255);
  --tenon-caption-shadow: 0 1px 2px rgb(0 0 0 / 0.95);
  position: absolute !important;
  z-index: 2147483000 !important;
  inset-inline: 8% !important;
  bottom: max(72px, 12%) !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  gap: 4px !important;
  color: var(--tenon-caption-foreground) !important;
  font: 600 20px/1.35 system-ui, sans-serif !important;
  letter-spacing: 0 !important;
  pointer-events: none !important;
  text-align: center !important;
  text-shadow: var(--tenon-caption-shadow) !important;
}
[data-tenon-bilingual-caption-overlay="youtube"] {
  transition: bottom 160ms ease-out !important;
}
.html5-video-player.ytp-autohide > [data-tenon-bilingual-caption-overlay="youtube"] {
  bottom: max(20px, 4%) !important;
}
.html5-video-player.ad-showing > [data-tenon-bilingual-caption-overlay="youtube"] {
  display: none !important;
}
[data-tenon-bilingual-caption-overlay][hidden],
html[data-tenon-bilingual-hidden="true"] [data-tenon-bilingual-caption-overlay] {
  display: none !important;
}
[data-tenon-bilingual-caption-line] {
  box-sizing: border-box !important;
  max-width: 100% !important;
  padding: 2px 7px !important;
  border-radius: 4px !important;
  background: var(--tenon-caption-background) !important;
  color: inherit !important;
  white-space: pre-line !important;
}
[data-tenon-bilingual-caption-line="translation"] {
  font-weight: 500 !important;
}
[data-tenon-bilingual-caption-overlay="status"] [data-tenon-bilingual-caption-line] {
  display: none !important;
}
[data-tenon-bilingual-caption-overlay] [data-tenon-bilingual-status] {
  margin: 0 !important;
  background: var(--tenon-caption-background) !important;
  pointer-events: auto !important;
}
html[data-tenon-bilingual-youtube-captions="true"] .ytp-caption-window-container {
  visibility: hidden !important;
}
@media (prefers-reduced-motion: reduce) {
  [data-tenon-bilingual-caption-overlay="youtube"] {
    transition: none !important;
  }
}
@media (prefers-reduced-transparency: reduce) {
  [data-tenon-bilingual-caption-overlay] {
    --tenon-caption-background: rgb(0 0 0);
  }
}
`;

export interface UrlPageTranslationGuestBatch {
  blocks: UrlPageTranslationBlock[];
  captionRevision: number;
  contentKind?: UrlPageTranslationContentKind;
  preemptRequestId?: string | null;
  priority: number | null;
}

export interface UrlPageTranslationGuestBridge {
  documentLanguage(): Promise<string | null>;
  captionLanguage?(): Promise<string | null>;
  initialize(targetLanguage: TranslationLanguage, labels: UrlPageTranslationGuestLabels): Promise<void>;
  setEnabled(enabled: boolean, targetLanguage: TranslationLanguage): Promise<void>;
  nextBatch(options?: UrlPageTranslationGuestBatchOptions): Promise<UrlPageTranslationGuestBatch>;
  release(ids: readonly string[]): Promise<void>;
  apply(translations: readonly UrlPageTranslationItem[]): Promise<number>;
  fail(ids: readonly string[]): Promise<void>;
  destroy(): Promise<void>;
}

export type UrlPageTranslationGuestCommandExecutor = (
  command: UrlPageTranslationGuestCommand,
) => Promise<unknown>;

export function createUrlPageTranslationGuestBridge(
  webview: Electron.WebviewTag,
  commandExecutor: UrlPageTranslationGuestCommandExecutor = defaultCommandExecutor(webview),
): UrlPageTranslationGuestBridge {
  let cssKey: string | null = null;

  const execute = async <T>(command: UrlPageTranslationGuestCommand): Promise<T> => (
    await commandExecutor(command) as T
  );

  const removeCss = async () => {
    const key = cssKey;
    cssKey = null;
    if (!key) return;
    await webview.removeInsertedCSS(key).catch(() => undefined);
  };

  return {
    async documentLanguage() {
      const raw = await execute<unknown>({ operation: 'document-language' });
      return typeof raw === 'string' ? raw : null;
    },
    async captionLanguage() {
      const raw = await execute<unknown>({ operation: 'caption-language' });
      return typeof raw === 'string' ? raw : null;
    },
    async initialize(targetLanguage, labels) {
      await removeCss();
      cssKey = await webview.insertCSS(URL_PAGE_TRANSLATION_GUEST_CSS);
      await execute({
        operation: 'initialize',
        labels,
        runtimeSource: installUrlPageTranslationRuntime.toString(),
        targetLanguage,
      });
    },
    async setEnabled(enabled, targetLanguage) {
      await execute({ operation: 'set-enabled', enabled, targetLanguage });
    },
    async nextBatch(options = {}) {
      const maxBlocks = boundedBatchLimit(
        options.maxBlocks,
        URL_PAGE_TRANSLATION_DEFAULT_MAX_BLOCKS,
        URL_PAGE_TRANSLATION_MAX_BLOCKS,
      );
      const maxChars = boundedBatchLimit(
        options.maxChars,
        URL_PAGE_TRANSLATION_DEFAULT_MAX_CHARS,
        URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
      );
      const captionMaxBlocks = boundedBatchLimit(
        options.captionMaxBlocks,
        URL_CAPTION_TRANSLATION_DEFAULT_MAX_BLOCKS,
        URL_CAPTION_TRANSLATION_MAX_BLOCKS,
      );
      const captionMaxChars = boundedBatchLimit(
        options.captionMaxChars,
        URL_CAPTION_TRANSLATION_DEFAULT_MAX_CHARS,
        URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
      );
      const raw = await execute<unknown>({
        operation: 'next-batch',
        options: {
          activeBatches: options.activeBatches ?? [],
          captionMaxBlocks,
          captionMaxChars,
          maxBlocks,
          maxChars,
          retryOnly: options.retryOnly ?? false,
          visibleOnly: options.visibleOnly ?? false,
        },
      });
      return validatedGuestBatch(raw, {
        captionMaxBlocks,
        captionMaxChars,
        maxBlocks,
        maxChars,
      });
    },
    async release(ids) {
      await execute({ operation: 'release', ids });
    },
    async apply(translations) {
      const inserted = await execute<unknown>({ operation: 'apply', translations });
      return Number.isInteger(inserted) && (inserted as number) > 0
        ? Math.min(inserted as number, translations.length)
        : 0;
    },
    async fail(ids) {
      await execute({ operation: 'fail', ids });
    },
    async destroy() {
      await execute({ operation: 'destroy' }).catch(() => undefined);
      await removeCss();
    },
  };
}

function defaultCommandExecutor(webview: Electron.WebviewTag): UrlPageTranslationGuestCommandExecutor {
  return async (command) => {
    const execute = window.lin?.executeUrlPageTranslationGuest;
    if (!execute) throw new Error('Tenon URL page translation bridge is unavailable.');
    return await execute({ webContentsId: webview.getWebContentsId(), command });
  };
}

/**
 * Self-contained guest runtime. It is serialized with `Function#toString` and run
 * inside the remote page, so every helper and constant it uses must stay local.
 */
export function installUrlPageTranslationRuntime(
  host: Window,
  runtimeKey: string,
  initialTargetLanguage: TranslationLanguage,
  labels: UrlPageTranslationGuestLabels,
): void {
  const doc = host.document;
  const constructors = host as unknown as {
    Element: typeof Element;
    MutationObserver?: typeof MutationObserver;
    NodeFilter: typeof NodeFilter;
  };
  const translationAttribute = 'data-tenon-bilingual-translation';
  const statusAttribute = 'data-tenon-bilingual-status';
  const hiddenAttribute = 'data-tenon-bilingual-hidden';
  const captionOverlayAttribute = 'data-tenon-bilingual-caption-overlay';
  const captionPlayerAttribute = 'data-tenon-bilingual-caption-player';
  const youtubeCaptionsAttribute = 'data-tenon-bilingual-youtube-captions';
  const ownedSelector = [
    `[${translationAttribute}]`,
    `[${statusAttribute}]`,
    `[${captionOverlayAttribute}]`,
  ].join(',');
  const candidateSelector = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '[role="heading"]',
    'p', 'li', 'blockquote', 'figcaption', 'caption', 'td', 'th', 'dt', 'dd',
    'article div', 'main div', '[role="article"] div', '[role="main"] div',
  ].join(',');
  const excludedSelector = [
    'script', 'style', 'noscript', 'template', 'pre', 'code', 'kbd', 'samp',
    'input', 'textarea', 'select', 'option', 'button', 'form', 'nav', 'video', 'audio',
    '.ytp-caption-window-container', '.vjs-text-track-display',
    '[role="button"]', '[role="textbox"]', '[role="navigation"]',
    `[${translationAttribute}]`,
    `[${statusAttribute}]`,
    `[${captionOverlayAttribute}]`,
  ].join(',');
  type RecordEntry = {
    id: string;
    element: HTMLElement;
    text: string;
    completed: boolean;
    failed: boolean;
    pending: boolean;
    retryRequested: boolean;
    statusNode: HTMLButtonElement | null;
    translationNode: HTMLElement | null;
  };
  type CaptionCueSnapshot = {
    endTime: number;
    startTime: number;
    text: string;
  };
  type CaptionRecord = {
    completed: boolean;
    endTime: number;
    failed: boolean;
    generatedCue: TextTrackCue | null;
    id: string;
    pending: boolean;
    retrying: boolean;
    retryRequested: boolean;
    startTime: number;
    text: string;
    translation: string | null;
  };
  type CaptionState = {
    adapter: 'standard' | 'youtube';
    bilingualElement: HTMLTrackElement | null;
    bilingualTrack: TextTrack | null;
    currentRecordId: string | null;
    key: string;
    language: string | null;
    media: HTMLMediaElement;
    overlay: HTMLElement | null;
    player: HTMLElement | null;
    records: Map<string, CaptionRecord>;
    sourceMode: TextTrackMode | null;
    sourceSignature: string;
    sourceTrack: TextTrack | null;
  };
  type YoutubeCaptionMetadata = {
    key: string;
    language: string;
    url: string;
  };
  type YoutubeCaptionMetadataLookup =
    | { status: 'found'; metadata: YoutubeCaptionMetadata }
    | { status: 'absent' }
    | { status: 'unknown' };

  const previous = (host as unknown as Record<string, unknown>)[runtimeKey] as { destroy?: () => void } | undefined;
  if (typeof previous?.destroy === 'function') previous.destroy();

  const records = new Map<string, RecordEntry>();
  const elementIds = new WeakMap<HTMLElement, string>();
  const readScrollTop = () => doc.scrollingElement?.scrollTop ?? host.scrollY;
  let nextId = 1;
  let enabled = false;
  let dirty = true;
  let scanCount = 0;
  let lastScrollTop = readScrollTop();
  let direction: 'down' | 'neutral' | 'up' = 'neutral';
  let targetLanguage = initialTargetLanguage;
  let anchorRevision = 0;
  let applyingAnchorScroll = false;
  let expectedAnchorScrollTop: number | null = null;
  let runtimeActive = true;
  let captionRevision = 0;
  let captionState: CaptionState | null = null;
  let detectedCaptionLanguage: string | null = null;
  let youtubeMetadata: YoutubeCaptionMetadata | null = null;
  let youtubeIdentityKey: string | null = null;
  let youtubeNoCaptionsKey: string | null = null;
  let youtubeLoadKey: string | null = null;
  let youtubeLoadPromise: Promise<void> | null = null;
  let youtubeRetryAttempt = 0;
  let youtubeRetryAt = 0;
  let youtubeRetryKey: string | null = null;
  let youtubeCaptionRefreshKey: string | null = null;
  let youtubeCaptionRestoreButton: HTMLButtonElement | null = null;
  let youtubeCaptionRestorePressed: boolean | null = null;
  let youtubeCaptionRestoreTimer: number | null = null;
  const scrollKeys = new Set([' ', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp']);

  const invalidateDeferredAnchorCorrection = (): void => {
    expectedAnchorScrollTop = null;
    anchorRevision += 1;
  };
  const invalidateDeferredAnchorCorrectionForKey = (event: KeyboardEvent): void => {
    if (scrollKeys.has(event.key)) invalidateDeferredAnchorCorrection();
  };
  const handleViewportScroll = (): void => {
    if (applyingAnchorScroll) return;
    const scrollTop = readScrollTop();
    if (expectedAnchorScrollTop !== null && Math.abs(scrollTop - expectedAnchorScrollTop) <= 1) return;
    invalidateDeferredAnchorCorrection();
  };
  host.addEventListener('wheel', invalidateDeferredAnchorCorrection, { capture: true, passive: true });
  host.addEventListener('touchstart', invalidateDeferredAnchorCorrection, { capture: true, passive: true });
  host.addEventListener('touchmove', invalidateDeferredAnchorCorrection, { capture: true, passive: true });
  host.addEventListener('keydown', invalidateDeferredAnchorCorrectionForKey, { capture: true });
  host.addEventListener('scroll', handleViewportScroll, { capture: true, passive: true });

  const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
  const nativeCueText = (value: string) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;');
  const hasReadableText = (value: string) => /[\p{L}\p{N}]/u.test(value);

  const languageMatchesTarget = (raw: string | null | undefined): boolean => {
    const declared = raw?.trim().replaceAll('_', '-').toLowerCase();
    if (!declared) return false;
    if (targetLanguage === 'zh-Hans') {
      return declared === 'zh'
        || declared.startsWith('zh-hans')
        || declared.startsWith('zh-cn')
        || declared.startsWith('zh-sg');
    }
    if (targetLanguage === 'zh-Hant') {
      return declared.startsWith('zh-hant')
        || declared.startsWith('zh-tw')
        || declared.startsWith('zh-hk')
        || declared.startsWith('zh-mo');
    }
    const primary = declared.split('-')[0];
    if (targetLanguage === 'nb') return primary === 'nb' || primary === 'no';
    if (targetLanguage === 'fil') return primary === 'fil' || primary === 'tl';
    if (targetLanguage === 'he') return primary === 'he' || primary === 'iw';
    if (targetLanguage === 'id') return primary === 'id' || primary === 'in';
    return primary === targetLanguage.toLowerCase();
  };

  const isDeclaredTargetLanguage = (element: HTMLElement): boolean => (
    languageMatchesTarget(element.closest('[lang]')?.getAttribute('lang'))
  );

  const isExcluded = (element: Element): boolean => {
    if (element.closest(excludedSelector)) return true;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
    const editable = element.closest('[contenteditable]');
    return Boolean(editable && editable.getAttribute('contenteditable') !== 'false');
  };

  const candidateText = (element: HTMLElement, candidates: ReadonlySet<HTMLElement>): string => {
    const walker = doc.createTreeWalker(element, constructors.NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      let skip = !parent || isExcluded(parent);
      let ancestor = parent;
      while (!skip && ancestor && ancestor !== element) {
        if (candidates.has(ancestor)) skip = true;
        ancestor = ancestor.parentElement;
      }
      if (!skip && node.textContent) parts.push(node.textContent);
      node = walker.nextNode();
    }
    return normalizeText(parts.join(' '));
  };

  const isRendered = (element: HTMLElement): boolean => {
    if (!element.isConnected || isExcluded(element)) return false;
    const style = host.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const removeStatus = (record: RecordEntry): void => {
    record.statusNode?.remove();
    record.statusNode = null;
    record.retryRequested = false;
  };

  const showStatus = (record: RecordEntry, state: 'error' | 'loading'): void => {
    let status = record.statusNode;
    if (!status?.isConnected) {
      status = doc.createElement('button');
      status.type = 'button';
      status.setAttribute(statusAttribute, state);
      status.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!enabled || !record.failed) return;
        withStableAnchor(() => {
          record.failed = false;
          record.retryRequested = true;
          showStatus(record, 'loading');
        });
      });
      record.element.append(status);
      record.statusNode = status;
    }
    status.setAttribute(statusAttribute, state);
    status.disabled = state === 'loading';
    status.setAttribute('aria-label', state === 'loading' ? labels.translating : labels.retry);
    status.title = state === 'loading' ? labels.translating : labels.retry;
  };

  const removeTranslation = (record: RecordEntry): void => {
    record.translationNode?.remove();
    record.translationNode = null;
    removeStatus(record);
    record.completed = false;
    record.failed = false;
    record.pending = false;
  };

  const discover = (): void => {
    const elements = Array.from(doc.querySelectorAll<HTMLElement>(candidateSelector));
    const candidates = new Set(elements);
    const seen = new Set<string>();
    for (const element of elements) {
      if (!isRendered(element) || isDeclaredTargetLanguage(element)) continue;
      const text = candidateText(element, candidates);
      if (text.length < 2 || !hasReadableText(text)) continue;
      let id = elementIds.get(element);
      if (!id) {
        id = `b${nextId++}`;
        elementIds.set(element, id);
      }
      let existing = records.get(id);
      if (existing && existing.text !== text) {
        removeTranslation(existing);
        records.delete(id);
        id = `b${nextId++}`;
        elementIds.set(element, id);
        existing = undefined;
      }
      seen.add(id);
      if (!existing) {
        records.set(id, {
          id,
          element,
          text,
          completed: false,
          failed: false,
          pending: false,
          retryRequested: false,
          statusNode: null,
          translationNode: null,
        });
        continue;
      }
      existing.element = element;
      if (existing.translationNode && !existing.translationNode.isConnected) {
        removeTranslation(existing);
        existing.text = text;
      }
    }
    for (const [id, record] of records) {
      if (seen.has(id) && record.element.isConnected) continue;
      record.translationNode?.remove();
      removeStatus(record);
      records.delete(id);
    }
    dirty = false;
  };

  const captureAnchor = (): { element: HTMLElement; top: number } | null => {
    const viewportHeight = Math.max(1, host.innerHeight);
    const visible = [...records.values()]
      .filter((record) => record.element.isConnected)
      .map((record) => ({ record, rect: record.element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < viewportHeight)
      .sort((left, right) => left.rect.top - right.rect.top);
    const anchor = visible.find(({ rect }) => rect.top >= 0) ?? visible[0];
    return anchor ? { element: anchor.record.element, top: anchor.rect.top } : null;
  };

  const correctAnchor = (
    anchor: { element: HTMLElement; top: number },
    revision: number,
  ): void => {
    if (!runtimeActive || revision !== anchorRevision || !anchor.element.isConnected) return;
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) {
      const scrollTopBefore = readScrollTop();
      applyingAnchorScroll = true;
      try {
        host.scrollBy({ behavior: 'instant', left: 0, top: delta });
      } finally {
        applyingAnchorScroll = false;
      }
      const scrollTopAfter = readScrollTop();
      expectedAnchorScrollTop = Math.abs(scrollTopAfter - scrollTopBefore) > 0.5
        ? scrollTopAfter
        : null;
    }
    lastScrollTop = readScrollTop();
  };

  const withStableAnchor = (mutate: () => void): void => {
    if (dirty) discover();
    const anchor = captureAnchor();
    const revision = ++anchorRevision;
    mutate();
    if (!anchor) return;
    correctAnchor(anchor, revision);
    if (typeof host.requestAnimationFrame !== 'function') return;
    host.requestAnimationFrame(() => {
      correctAnchor(anchor, revision);
      host.requestAnimationFrame(() => correctAnchor(anchor, revision));
    });
  };

  const priorityForRect = (rect: DOMRect, viewportHeight: number): number | null => {
    if (rect.bottom > 0 && rect.top < viewportHeight) return 0;
    if (direction === 'neutral') {
      if (rect.bottom <= 0 && rect.bottom > -viewportHeight * 2) return 1;
      if (rect.top >= viewportHeight && rect.top < viewportHeight * 3) return 1;
      return null;
    }
    if (direction === 'down') {
      if (rect.top >= viewportHeight && rect.top < viewportHeight * 5) return 1;
      if (rect.bottom <= 0 && rect.bottom > -viewportHeight) return 2;
      return null;
    }
    if (rect.bottom <= 0 && rect.bottom > -viewportHeight * 4) return 1;
    if (rect.top >= viewportHeight && rect.top < viewportHeight * 2) return 2;
    return null;
  };

  const distanceForRect = (rect: DOMRect, viewportHeight: number): number => {
    if (rect.bottom > 0 && rect.top < viewportHeight) return Math.max(0, rect.top);
    if (rect.bottom <= 0) return Math.max(0, -rect.bottom);
    return Math.max(0, rect.top - viewportHeight);
  };

  const captionTrackList = (media: HTMLMediaElement): TextTrack[] => {
    const tracks: TextTrack[] = [];
    for (let index = 0; index < media.textTracks.length; index += 1) {
      const track = media.textTracks[index];
      if (track) tracks.push(track);
    }
    return tracks;
  };

  const captionCueList = (track: TextTrack): TextTrackCue[] => {
    const cues: TextTrackCue[] = [];
    try {
      const source = track.cues;
      if (!source) return cues;
      for (let index = 0; index < source.length; index += 1) {
        const cue = source[index];
        if (cue) cues.push(cue);
      }
    } catch {
      return [];
    }
    return cues;
  };

  const setTrackMode = (track: TextTrack | null, mode: TextTrackMode): boolean => {
    if (!track) return false;
    try {
      track.mode = mode;
      return track.mode === mode;
    } catch {
      return false;
    }
  };

  const cueText = (cue: TextTrackCue): string => {
    const value = (cue as TextTrackCue & { text?: unknown }).text;
    return typeof value === 'string' ? normalizeText(value.replace(/<[^>]{1,200}>/g, ' ')) : '';
  };

  const currentMedia = (): HTMLMediaElement | null => {
    if (youtubeHost()) {
      const youtubeMedia = doc.querySelector<HTMLMediaElement>('#movie_player video, video.html5-main-video');
      if (youtubeMedia?.isConnected) return youtubeMedia;
    }
    const media = Array.from(doc.querySelectorAll<HTMLMediaElement>('video'))
      .filter((entry) => entry.isConnected);
    return media.find((entry) => !entry.paused && !entry.ended)
      ?? media.find((entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < host.innerHeight;
      })
      ?? media[0]
      ?? null;
  };

  const hasFiniteCaptionTimeline = (media: HTMLMediaElement): boolean => (
    Number.isFinite(media.duration) && media.duration > 0
  );

  const clearGeneratedCues = (state: CaptionState): void => {
    const track = state.bilingualTrack;
    if (!track) return;
    for (const cue of captionCueList(track)) {
      try {
        track.removeCue(cue);
      } catch {
        // A detached media element may already have released its native cues.
      }
    }
    setTrackMode(track, 'disabled');
    for (const record of state.records.values()) record.generatedCue = null;
  };

  const detachCaptionOverlay = (state: CaptionState): void => {
    state.overlay?.remove();
    state.overlay = null;
    state.player?.removeAttribute(captionPlayerAttribute);
    state.player = null;
  };

  const setCaptionPresentationEnabled = (
    state: CaptionState,
    nextEnabled: boolean,
    restoreSource = true,
  ): void => {
    if (state.adapter === 'standard') {
      if (nextEnabled && state.bilingualTrack && state.records.size > 0) {
        setTrackMode(state.sourceTrack, 'hidden');
        setTrackMode(state.bilingualTrack, 'showing');
      } else {
        setTrackMode(state.bilingualTrack, 'disabled');
        if (restoreSource && state.sourceMode) setTrackMode(state.sourceTrack, state.sourceMode);
      }
    }
    if (state.adapter === 'youtube' && nextEnabled) {
      doc.documentElement.setAttribute(youtubeCaptionsAttribute, 'true');
    } else {
      doc.documentElement.removeAttribute(youtubeCaptionsAttribute);
    }
    if (!nextEnabled && state.overlay) state.overlay.hidden = true;
  };

  const clearCaptionState = (restoreSource = true): void => {
    const state = captionState;
    if (!state) return;
    state.media.removeEventListener('timeupdate', renderCurrentCaption);
    state.media.removeEventListener('seeked', renderCurrentCaption);
    setCaptionPresentationEnabled(state, false, restoreSource);
    clearGeneratedCues(state);
    state.bilingualElement?.remove();
    state.bilingualElement = null;
    detachCaptionOverlay(state);
    state.records.clear();
    captionState = null;
    captionRevision += 1;
  };

  const captionPlayerFor = (state: CaptionState): HTMLElement | null => {
    if (state.adapter === 'youtube') {
      return doc.querySelector<HTMLElement>('#movie_player, .html5-video-player')
        ?? state.media.parentElement;
    }
    return state.media.closest<HTMLElement>('.video-js, [data-player-root], [data-player], [class*="player"]')
      ?? state.media.parentElement;
  };

  const ensureCaptionOverlay = (state: CaptionState): HTMLElement | null => {
    const player = captionPlayerFor(state);
    if (!player) return null;
    if (state.player !== player) {
      detachCaptionOverlay(state);
      state.player = player;
      player.setAttribute(captionPlayerAttribute, 'true');
    }
    if (state.overlay?.isConnected) return state.overlay;
    const overlay = doc.createElement('div');
    overlay.setAttribute(captionOverlayAttribute, state.adapter === 'youtube' ? 'youtube' : 'status');
    overlay.hidden = true;
    const source = doc.createElement('span');
    source.setAttribute('data-tenon-bilingual-caption-line', 'source');
    const translation = doc.createElement('span');
    translation.setAttribute('data-tenon-bilingual-caption-line', 'translation');
    const status = doc.createElement('button');
    status.type = 'button';
    status.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = captionState;
      const failed = current ? [...current.records.values()].filter((record) => record.failed) : [];
      if (!enabled || failed.length === 0) return;
      for (const record of failed) {
        record.failed = false;
        record.retrying = true;
        record.retryRequested = true;
      }
      renderCurrentCaption();
    });
    overlay.append(source, translation, status);
    player.append(overlay);
    state.overlay = overlay;
    return overlay;
  };

  const recordAtTime = (state: CaptionState, time: number): CaptionRecord | null => {
    const records = [...state.records.values()];
    let low = 0;
    let high = records.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const record = records[middle];
      if (!record) break;
      if (time < record.startTime) high = middle - 1;
      else if (time >= record.endTime) low = middle + 1;
      else return record;
    }
    return null;
  };

  function renderCurrentCaption(): void {
    const state = captionState;
    if (!state || !enabled) return;
    if (state.adapter === 'youtube' && youtubeAdShowing()) {
      if (state.overlay) state.overlay.hidden = true;
      return;
    }
    const overlay = ensureCaptionOverlay(state);
    if (!overlay) return;
    const record = recordAtTime(state, state.media.currentTime);
    const hasFailure = [...state.records.values()].some((entry) => entry.failed);
    const hasRetrying = [...state.records.values()].some((entry) => entry.retrying);
    state.currentRecordId = record?.id ?? null;
    overlay.setAttribute(
      captionOverlayAttribute,
      state.adapter === 'youtube' && record ? 'youtube' : 'status',
    );
    if (!record && !hasFailure) {
      overlay.hidden = true;
      return;
    }
    const source = overlay.querySelector<HTMLElement>('[data-tenon-bilingual-caption-line="source"]');
    const translation = overlay.querySelector<HTMLElement>('[data-tenon-bilingual-caption-line="translation"]');
    const status = overlay.querySelector<HTMLButtonElement>(`[${statusAttribute}], button`);
    if (source) source.textContent = record?.text ?? '';
    if (translation) {
      translation.textContent = record?.completed && record.translation ? record.translation : '';
      translation.hidden = !translation.textContent;
    }
    if (status) {
      const stateName = hasFailure
        ? 'error'
        : hasRetrying || record?.pending || record?.retryRequested
          ? 'loading'
          : null;
      if (stateName) {
        status.setAttribute(statusAttribute, stateName);
        status.disabled = stateName === 'loading';
        status.setAttribute('aria-label', stateName === 'loading' ? labels.translating : labels.retry);
        status.title = stateName === 'loading' ? labels.translating : labels.retry;
        status.hidden = false;
      } else {
        status.removeAttribute(statusAttribute);
        status.hidden = true;
      }
    }
    overlay.hidden = state.adapter === 'standard'
      ? !(hasFailure || hasRetrying || record?.pending || record?.retryRequested)
      : false;
  }

  const createNativeCue = (
    sourceCue: TextTrackCue | null,
    startTime: number,
    endTime: number,
    text: string,
  ): TextTrackCue | null => {
    const CueConstructor = (host as unknown as { VTTCue?: typeof VTTCue }).VTTCue
      ?? sourceCue?.constructor as typeof VTTCue | undefined;
    if (typeof CueConstructor !== 'function') return null;
    try {
      const cue = new CueConstructor(startTime, endTime, text);
      if (sourceCue) {
        const from = sourceCue as TextTrackCue & Partial<VTTCue>;
        const to = cue as VTTCue;
        for (const property of [
          'align',
          'line',
          'lineAlign',
          'position',
          'positionAlign',
          'region',
          'size',
          'snapToLines',
          'vertical',
        ] as const) {
          try {
            if (property in from && from[property] !== undefined) {
              (to as unknown as Record<string, unknown>)[property] = from[property];
            }
          } catch {
            // Cue layout fields vary between native implementations.
          }
        }
      }
      return cue;
    } catch {
      return null;
    }
  };

  const replaceGeneratedCue = (state: CaptionState, record: CaptionRecord): void => {
    const track = state.bilingualTrack;
    if (!track) return;
    const layoutSource = record.generatedCue;
    if (layoutSource) {
      try {
        track.removeCue(layoutSource);
      } catch {
        // The player may have replaced its native track list while navigating.
      }
    }
    const text = record.translation
      ? `${nativeCueText(record.text)}\n${nativeCueText(record.translation)}`
      : nativeCueText(record.text);
    const cue = createNativeCue(layoutSource, record.startTime, record.endTime, text);
    if (!cue) {
      record.generatedCue = null;
      return;
    }
    try {
      track.addCue(cue);
      record.generatedCue = cue;
    } catch {
      record.generatedCue = null;
    }
  };

  const createCaptionRecords = (
    snapshots: readonly CaptionCueSnapshot[],
    generatedTrack: TextTrack | null,
    sourceCues: readonly TextTrackCue[] = [],
  ): Map<string, CaptionRecord> => {
    const records = new Map<string, CaptionRecord>();
    const revision = ++captionRevision;
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      if (!snapshot) continue;
      const id = `c${revision}:${index}`;
      const record: CaptionRecord = {
        completed: false,
        endTime: snapshot.endTime,
        failed: false,
        generatedCue: null,
        id,
        pending: false,
        retrying: false,
        retryRequested: false,
        startTime: snapshot.startTime,
        text: snapshot.text,
        translation: null,
      };
      if (generatedTrack) {
        const cue = createNativeCue(
          sourceCues[index] ?? null,
          snapshot.startTime,
          snapshot.endTime,
          nativeCueText(snapshot.text),
        );
        if (cue) {
          try {
            generatedTrack.addCue(cue);
            record.generatedCue = cue;
          } catch {
            // Leave the source track active if this player rejects synthetic cues.
          }
        }
      }
      records.set(id, record);
    }
    return records;
  };

  const standardSourceTrack = (media: HTMLMediaElement): TextTrack | null => {
    const candidates = captionTrackList(media).filter((track) => (
      (track.kind === 'captions' || track.kind === 'subtitles')
      && track.label !== 'Tenon bilingual'
    ));
    const showing = candidates.find((track) => track.mode === 'showing');
    if (showing) return showing;
    if (captionState?.adapter === 'standard' && captionState.media === media && captionState.sourceTrack) {
      if (candidates.includes(captionState.sourceTrack)) return captionState.sourceTrack;
    }
    const defaultTrack = Array.from(media.querySelectorAll('track'))
      .find((track) => track.default && candidates.includes(track.track))?.track;
    if (defaultTrack) return defaultTrack;
    return candidates.length === 1 ? candidates[0] ?? null : null;
  };

  const createBilingualTrack = (
    media: HTMLMediaElement,
  ): { element: HTMLTrackElement | null; track: TextTrack } | null => {
    try {
      const element = doc.createElement('track');
      element.kind = 'captions';
      element.label = 'Tenon bilingual';
      element.srclang = targetLanguage;
      media.append(element);
      if (element.track) {
        setTrackMode(element.track, 'disabled');
        return { element, track: element.track };
      }
      element.remove();
      const track = media.addTextTrack('captions', 'Tenon bilingual', targetLanguage);
      setTrackMode(track, 'disabled');
      return { element: null, track };
    } catch {
      return null;
    }
  };

  const syncStandardCaptionState = (): boolean => {
    const media = currentMedia();
    if (!media || !hasFiniteCaptionTimeline(media)) {
      if (captionState?.adapter === 'standard') clearCaptionState();
      detectedCaptionLanguage = null;
      return false;
    }
    const sourceTrack = standardSourceTrack(media);
    if (!sourceTrack) {
      if (captionState?.adapter === 'standard') clearCaptionState();
      detectedCaptionLanguage = null;
      return false;
    }
    detectedCaptionLanguage = sourceTrack.language || null;
    if (languageMatchesTarget(detectedCaptionLanguage)) {
      if (captionState?.adapter === 'standard') {
        const restoreSource = captionState.media !== media || captionState.sourceTrack === sourceTrack;
        clearCaptionState(restoreSource);
      }
      return true;
    }
    if (!enabled) {
      if (captionState?.adapter === 'standard') setCaptionPresentationEnabled(captionState, false);
      return true;
    }
    const key = `standard:${sourceTrack.id || sourceTrack.label}:${sourceTrack.language}`;
    if (
      captionState?.adapter !== 'standard'
      || captionState.media !== media
      || captionState.sourceTrack !== sourceTrack
      || captionState.key !== key
    ) {
      const restoreReplacedSource = captionState?.adapter !== 'standard'
        || captionState.media !== media
        || captionState.sourceTrack === sourceTrack;
      clearCaptionState(restoreReplacedSource);
      const sourceMode = sourceTrack.mode;
      const bilingual = createBilingualTrack(media);
      if (!bilingual) return false;
      captionState = {
        adapter: 'standard',
        bilingualElement: bilingual.element,
        bilingualTrack: bilingual.track,
        currentRecordId: null,
        key,
        language: detectedCaptionLanguage,
        media,
        overlay: null,
        player: null,
        records: new Map(),
        sourceMode,
        sourceSignature: '',
        sourceTrack,
      };
      media.addEventListener('timeupdate', renderCurrentCaption);
      media.addEventListener('seeked', renderCurrentCaption);
    }
    const state = captionState;
    if (!state || state.adapter !== 'standard') return false;
    let sourceHasCues = false;
    try {
      sourceHasCues = Boolean(sourceTrack.cues);
    } catch {
      return false;
    }
    if (!sourceHasCues && sourceTrack.mode === 'disabled') setTrackMode(sourceTrack, 'hidden');
    const cues = captionCueList(sourceTrack);
    if (cues.length === 0 || cues.length > 5_000) return true;
    const firstCue = cues[0];
    const lastCue = cues[cues.length - 1];
    const signature = [
      cues.length,
      firstCue?.startTime,
      firstCue?.endTime,
      cueText(firstCue!),
      lastCue?.startTime,
      lastCue?.endTime,
      cueText(lastCue!),
    ].join(':');
    if (state.sourceSignature === signature && state.records.size > 0) {
      setCaptionPresentationEnabled(state, true);
      renderCurrentCaption();
      return true;
    }
    const snapshots = cues.map((cue) => ({
      endTime: cue.endTime,
      startTime: cue.startTime,
      text: cueText(cue),
    })).filter((cue) => (
      Number.isFinite(cue.startTime)
      && Number.isFinite(cue.endTime)
      && cue.endTime > cue.startTime
      && cue.text.length > 0
    ));
    const totalChars = snapshots.reduce((sum, cue) => sum + cue.text.length, 0);
    if (snapshots.length === 0 || totalChars > 1_000_000) return true;
    clearGeneratedCues(state);
    state.records = createCaptionRecords(snapshots, state.bilingualTrack, cues);
    state.sourceSignature = signature;
    if (![...state.records.values()].some((record) => record.generatedCue)) {
      state.records.clear();
      setCaptionPresentationEnabled(state, false);
      return false;
    }
    setCaptionPresentationEnabled(state, true);
    renderCurrentCaption();
    return true;
  };

  const decodedCodePoint = (value: number, fallback: string): string => (
    Number.isInteger(value) && value >= 0 && value <= 0x10_FFFF
      ? String.fromCodePoint(value)
      : fallback
  );

  const decodeCaptionEntities = (value: string): string => value
    .replace(/&#(\d+);/g, (match, digits: string) => decodedCodePoint(Number(digits), match))
    .replace(/&#x([\da-f]+);/gi, (match, digits: string) => (
      decodedCodePoint(Number.parseInt(digits, 16), match)
    ))
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");

  const parseCaptionTimestamp = (value: string): number | null => {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) return (parts[0] ?? 0) * 3_600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
    if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    return null;
  };

  const parseVttCaptions = (source: string): CaptionCueSnapshot[] => {
    const lines = source.replaceAll('\r\n', '\n').split('\n');
    const cues: CaptionCueSnapshot[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const timing = lines[index];
      if (!timing?.includes('-->')) continue;
      const [rawStart, rawEndWithSettings] = timing.split('-->');
      const rawEnd = rawEndWithSettings?.trim().split(/\s+/)[0];
      const startTime = rawStart ? parseCaptionTimestamp(rawStart) : null;
      const endTime = rawEnd ? parseCaptionTimestamp(rawEnd) : null;
      if (startTime === null || endTime === null || endTime <= startTime) continue;
      const text: string[] = [];
      for (index += 1; index < lines.length && lines[index]?.trim(); index += 1) {
        text.push(lines[index] ?? '');
      }
      const normalized = normalizeText(decodeCaptionEntities(text.join(' ')).replace(/<[^>]{1,200}>/g, ' '));
      if (normalized) cues.push({ endTime, startTime, text: normalized });
    }
    return cues;
  };

  const parseXmlCaptions = (source: string): CaptionCueSnapshot[] => {
    const cues: CaptionCueSnapshot[] = [];
    for (const match of source.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
      const attributes = match[1] ?? '';
      const startMatch = attributes.match(/\bstart="([\d.]+)"/i);
      const durationMatch = attributes.match(/\bdur="([\d.]+)"/i);
      const startTime = Number(startMatch?.[1]);
      const duration = Number(durationMatch?.[1]);
      const text = normalizeText(decodeCaptionEntities(match[2] ?? '').replace(/<[^>]{1,200}>/g, ' '));
      if (Number.isFinite(startTime) && Number.isFinite(duration) && duration > 0 && text) {
        cues.push({ endTime: startTime + duration, startTime, text });
      }
    }
    return cues;
  };

  const parseJsonCaptions = (source: string): CaptionCueSnapshot[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { events?: unknown }).events)) return [];
    const cues: CaptionCueSnapshot[] = [];
    for (const rawEvent of (parsed as { events: unknown[] }).events) {
      if (!rawEvent || typeof rawEvent !== 'object') continue;
      const event = rawEvent as { dDurationMs?: unknown; segs?: unknown; tStartMs?: unknown };
      const startTime = Number(event.tStartMs) / 1_000;
      const duration = Number(event.dDurationMs) / 1_000;
      if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0 || !Array.isArray(event.segs)) {
        continue;
      }
      const text = normalizeText(event.segs.map((rawSegment) => {
        if (!rawSegment || typeof rawSegment !== 'object') return '';
        const value = (rawSegment as { utf8?: unknown }).utf8;
        return typeof value === 'string' ? value : '';
      }).join(''));
      if (text) cues.push({ endTime: startTime + duration, startTime, text });
    }
    return cues;
  };

  const parseCaptionResponse = (source: string): CaptionCueSnapshot[] => {
    const trimmed = source.trim();
    const cues = trimmed.startsWith('{')
      ? parseJsonCaptions(trimmed)
      : trimmed.startsWith('WEBVTT')
        ? parseVttCaptions(trimmed)
        : parseXmlCaptions(trimmed);
    if (cues.length === 0 || cues.length > 5_000) return [];
    const sorted = cues
      .filter((cue) => cue.text.length > 0 && cue.text.length <= 4_000)
      .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
    return sorted.reduce<CaptionCueSnapshot[]>((result, cue) => {
      const previous = result[result.length - 1];
      if (
        previous
        && previous.startTime === cue.startTime
        && previous.endTime === cue.endTime
        && previous.text === cue.text
      ) return result;
      result.push(cue);
      return result;
    }, []);
  };

  const extractAssignedJson = (source: string, marker: string): unknown => {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = source.indexOf('{', markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let escaped = false;
    let quoted = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  };

  const youtubeHost = (): boolean => {
    const hostname = host.location?.hostname?.toLowerCase() ?? '';
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  };

  const youtubeAdShowing = (): boolean => (
    doc.querySelector<HTMLElement>('.html5-video-player')?.classList.contains('ad-showing') ?? false
  );

  const clearYoutubeRetry = (): void => {
    youtubeRetryAttempt = 0;
    youtubeRetryAt = 0;
    youtubeRetryKey = null;
  };

  const deferYoutubeRetry = (key: string): void => {
    youtubeRetryAttempt = youtubeRetryKey === key ? youtubeRetryAttempt + 1 : 1;
    youtubeRetryKey = key;
    youtubeRetryAt = Date.now() + Math.min(60_000, 5_000 * (2 ** (youtubeRetryAttempt - 1)));
  };

  const youtubeRetryPending = (key: string): boolean => (
    youtubeRetryKey === key && Date.now() < youtubeRetryAt
  );

  const prepareYoutubeIdentity = (identity: { key: string }): void => {
    if (youtubeIdentityKey === identity.key) return;
    youtubeIdentityKey = identity.key;
    youtubeMetadata = null;
    youtubeNoCaptionsKey = null;
    youtubeLoadKey = null;
    detectedCaptionLanguage = null;
    clearYoutubeRetry();
  };

  const youtubeVideoKey = (): { key: string; videoId: string } | null => {
    if (!youtubeHost()) return null;
    try {
      const url = new URL(host.location.href);
      const videoId = url.searchParams.get('v')?.trim() ?? '';
      if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) return null;
      return { key: `youtube:${videoId}`, videoId };
    } catch {
      return null;
    }
  };

  const restoreYoutubeCaptionToggle = (): void => {
    if (youtubeCaptionRestoreTimer !== null) host.clearTimeout(youtubeCaptionRestoreTimer);
    youtubeCaptionRestoreTimer = null;
    const button = youtubeCaptionRestoreButton;
    const pressed = youtubeCaptionRestorePressed;
    youtubeCaptionRestoreButton = null;
    youtubeCaptionRestorePressed = null;
    if (!button?.isConnected || pressed === null) return;
    if ((button.getAttribute('aria-pressed') === 'true') === pressed) return;
    try {
      button.click();
    } catch {
      // The player may replace its controls while handling the first click.
    }
  };

  const requestYoutubeCaptionRefresh = (
    identity: { key: string; videoId: string },
    metadata: YoutubeCaptionMetadata,
  ): void => {
    const refreshKey = `${identity.key}:${metadata.language}:${metadata.url}`;
    if (youtubeCaptionRefreshKey === refreshKey) return;
    const button = doc.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
    if (!button) return;
    restoreYoutubeCaptionToggle();
    const pressed = button.getAttribute('aria-pressed') === 'true';
    try {
      button.click();
    } catch {
      return;
    }
    youtubeCaptionRefreshKey = refreshKey;
    youtubeCaptionRestoreButton = button;
    youtubeCaptionRestorePressed = pressed;
    youtubeCaptionRestoreTimer = host.setTimeout(restoreYoutubeCaptionToggle, 50);
  };

  const youtubeMetadataFromUrl = (
    rawUrl: string,
    videoId: string,
    languageHint: string | null = null,
  ): YoutubeCaptionMetadata | null => {
    try {
      const url = new URL(rawUrl, host.location.href);
      const hostname = url.hostname.toLowerCase();
      const urlVideoId = url.searchParams.get('v');
      const language = url.searchParams.get('tlang') ?? languageHint ?? url.searchParams.get('lang') ?? '';
      if (
        url.protocol !== 'https:'
        || (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com'))
        || url.pathname !== '/api/timedtext'
        || urlVideoId !== videoId
        || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)
      ) return null;
      url.searchParams.delete('fmt');
      return { key: `youtube:${videoId}`, language, url: url.href };
    } catch {
      return null;
    }
  };

  const youtubeMetadataFromPerformance = (videoId: string): YoutubeCaptionMetadata | null => {
    try {
      const entries = host.performance?.getEntriesByType?.('resource') ?? [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const name = entries[index]?.name;
        if (typeof name !== 'string' || name.length > 8_192) continue;
        const metadata = youtubeMetadataFromUrl(name, videoId);
        if (metadata) return metadata;
      }
    } catch {
      // Resource Timing can be unavailable in hardened or older webviews.
    }
    return null;
  };

  const syncYoutubeMetadataFromPerformance = (
    identity: { key: string; videoId: string },
  ): void => {
    const active = youtubeMetadataFromPerformance(identity.videoId);
    if (!active) return;
    const changed = youtubeMetadata?.language !== active.language || youtubeMetadata.url !== active.url;
    if (changed || youtubeNoCaptionsKey === identity.key) clearYoutubeRetry();
    youtubeNoCaptionsKey = null;
    youtubeMetadata = active;
    detectedCaptionLanguage = active.language;
    if (!changed) return;
    if (
      captionState?.adapter === 'youtube'
      && captionState.key === identity.key
      && captionState.sourceSignature !== active.url
    ) clearCaptionState();
  };

  const youtubeMetadataFromHtml = (
    html: string,
    videoId: string,
  ): YoutubeCaptionMetadataLookup => {
    const parsed = extractAssignedJson(html, 'ytInitialPlayerResponse') as {
      captions?: {
        playerCaptionsTracklistRenderer?: {
          audioTracks?: unknown;
          captionTracks?: unknown;
        };
      };
      playabilityStatus?: { status?: unknown };
      videoDetails?: { videoId?: unknown };
    } | null;
    if (!parsed || parsed.videoDetails?.videoId !== videoId) {
      return { status: 'unknown' };
    }
    const renderer = parsed.captions?.playerCaptionsTracklistRenderer;
    const rawTracks = renderer?.captionTracks;
    if (!Array.isArray(rawTracks)) {
      return parsed.playabilityStatus?.status === 'OK'
        ? { status: 'absent' }
        : { status: 'unknown' };
    }
    const tracks = rawTracks.flatMap((rawTrack, index) => {
      if (!rawTrack || typeof rawTrack !== 'object') return [];
      const track = rawTrack as { baseUrl?: unknown; kind?: unknown; languageCode?: unknown };
      if (
        typeof track.baseUrl !== 'string'
        || track.baseUrl.length > 8_192
        || typeof track.languageCode !== 'string'
        || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(track.languageCode)
      ) return [];
      const metadata = youtubeMetadataFromUrl(track.baseUrl, videoId, track.languageCode);
      return metadata ? [{ ...metadata, automatic: track.kind === 'asr', index }] : [];
    });
    if (tracks.length === 0) {
      return rawTracks.length === 0 ? { status: 'absent' } : { status: 'unknown' };
    }
    let defaultTrackIndex: number | null = null;
    if (Array.isArray(renderer?.audioTracks)) {
      for (const rawAudioTrack of renderer.audioTracks) {
        if (!rawAudioTrack || typeof rawAudioTrack !== 'object') continue;
        const candidate = (rawAudioTrack as { defaultCaptionTrackIndex?: unknown }).defaultCaptionTrackIndex;
        if (Number.isInteger(candidate) && tracks.some((track) => track.index === candidate)) {
          defaultTrackIndex = candidate as number;
          break;
        }
      }
    }
    const selected = tracks.find((track) => track.index === defaultTrackIndex)
      ?? tracks.find((track) => !track.automatic)
      ?? tracks[0];
    return selected
      ? {
          status: 'found',
          metadata: { key: `youtube:${videoId}`, language: selected.language, url: selected.url },
        }
      : { status: 'absent' };
  };

  const inlineYoutubeMetadata = (videoId: string): YoutubeCaptionMetadataLookup => {
    let scannedChars = 0;
    let foundAbsentMetadata = false;
    for (const script of Array.from(doc.querySelectorAll('script'))) {
      const source = script.textContent ?? '';
      scannedChars += source.length;
      if (scannedChars > 5_000_000) return { status: 'unknown' };
      if (!source.includes('ytInitialPlayerResponse')) continue;
      const result = youtubeMetadataFromHtml(source, videoId);
      if (result.status === 'found') return result;
      if (result.status === 'absent') foundAbsentMetadata = true;
    }
    return foundAbsentMetadata ? { status: 'absent' } : { status: 'unknown' };
  };

  const readBoundedResponse = async (response: Response, maxChars: number): Promise<string> => {
    if (!response.ok) throw new Error('Caption response failed.');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxChars) throw new Error('Caption response is too large.');
    const Decoder = (host as unknown as { TextDecoder?: typeof TextDecoder }).TextDecoder;
    if (!response.body || typeof Decoder !== 'function') {
      const source = await response.text();
      if (!source || source.length > maxChars) throw new Error('Caption response is empty or too large.');
      return source;
    }
    const reader = response.body.getReader();
    const decoder = new Decoder();
    let source = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        if (source.length + text.length > maxChars) {
          await reader.cancel().catch(() => undefined);
          throw new Error('Caption response is too large.');
        }
        source += text;
      }
      const tail = decoder.decode();
      if (source.length + tail.length > maxChars) throw new Error('Caption response is too large.');
      source += tail;
    } finally {
      reader.releaseLock();
    }
    if (!source || source.length > maxChars) throw new Error('Caption response is empty or too large.');
    return source;
  };

  const loadYoutubeCaptionState = async (loadCues: boolean): Promise<void> => {
    if (!runtimeActive) return;
    const identity = youtubeVideoKey();
    const media = currentMedia();
    if (!identity || !media) return;
    prepareYoutubeIdentity(identity);
    if (!hasFiniteCaptionTimeline(media)) {
      if (captionState?.adapter === 'youtube') clearCaptionState();
      detectedCaptionLanguage = null;
      return;
    }
    if (youtubeMetadata?.key !== identity.key) {
      youtubeMetadata = null;
      detectedCaptionLanguage = null;
    }
    syncYoutubeMetadataFromPerformance(identity);
    if (captionState?.adapter === 'youtube' && captionState.key !== identity.key) clearCaptionState();
    if (!youtubeMetadata) {
      if (youtubeNoCaptionsKey === identity.key) return;
      let lookup = inlineYoutubeMetadata(identity.videoId);
      if (lookup.status === 'unknown') {
        const fetcher = (host as Window & { fetch?: typeof fetch }).fetch?.bind(host);
        if (!fetcher) return;
        const watchUrl = new URL('/watch', host.location.origin);
        watchUrl.searchParams.set('v', identity.videoId);
        const html = await readBoundedResponse(await fetcher(watchUrl.href, {
          credentials: 'include',
          redirect: 'error',
        }), 5_000_000);
        if (!runtimeActive || youtubeVideoKey()?.key !== identity.key) return;
        lookup = youtubeMetadataFromHtml(html, identity.videoId);
      }
      if (lookup.status === 'absent') {
        youtubeNoCaptionsKey = identity.key;
        detectedCaptionLanguage = null;
        clearYoutubeRetry();
        return;
      }
      if (lookup.status === 'unknown') throw new Error('YouTube caption metadata is unavailable.');
      youtubeMetadata = lookup.metadata;
      youtubeNoCaptionsKey = null;
      detectedCaptionLanguage = lookup.metadata.language;
      clearYoutubeRetry();
    }
    if (!runtimeActive) return;
    const metadata = youtubeMetadata;
    if (!metadata) return;
    if (!loadCues || languageMatchesTarget(metadata.language)) return;
    if (captionState?.adapter === 'youtube' && captionState.key === identity.key) {
      setCaptionPresentationEnabled(captionState, enabled);
      return;
    }
    const fetcher = (host as Window & { fetch?: typeof fetch }).fetch?.bind(host);
    if (!fetcher) return;
    const captionRetryKey = `${identity.key}:caption:${metadata.language}:${metadata.url}`;
    const captionsUrl = new URL(metadata.url);
    captionsUrl.searchParams.set('fmt', 'json3');
    let source = await readBoundedResponse(await fetcher(captionsUrl.href, {
      credentials: 'include',
      redirect: 'error',
    }), 2_000_000).catch(() => '');
    if (!source) {
      source = await readBoundedResponse(await fetcher(metadata.url, {
        credentials: 'include',
        redirect: 'error',
      }), 2_000_000).catch(() => '');
    }
    if (!source) {
      requestYoutubeCaptionRefresh(identity, metadata);
      deferYoutubeRetry(captionRetryKey);
      return;
    }
    if (
      !runtimeActive
      || youtubeVideoKey()?.key !== identity.key
      || youtubeMetadata?.language !== metadata.language
      || youtubeMetadata?.url !== metadata.url
    ) return;
    const snapshots = parseCaptionResponse(source);
    const totalChars = snapshots.reduce((sum, cue) => sum + cue.text.length, 0);
    if (snapshots.length === 0 || totalChars > 1_000_000) {
      requestYoutubeCaptionRefresh(identity, metadata);
      deferYoutubeRetry(captionRetryKey);
      return;
    }
    clearYoutubeRetry();
    clearCaptionState();
    captionState = {
      adapter: 'youtube',
      bilingualElement: null,
      bilingualTrack: null,
      currentRecordId: null,
      key: identity.key,
      language: metadata.language,
      media,
      overlay: null,
      player: null,
      records: createCaptionRecords(snapshots, null),
      sourceMode: null,
      sourceSignature: metadata.url,
      sourceTrack: null,
    };
    media.addEventListener('timeupdate', renderCurrentCaption);
    media.addEventListener('seeked', renderCurrentCaption);
    setCaptionPresentationEnabled(captionState, enabled);
    renderCurrentCaption();
  };

  const refreshYoutubeCaptions = async (loadCues: boolean): Promise<void> => {
    if (!runtimeActive) return;
    const identity = youtubeVideoKey();
    if (!identity) return;
    prepareYoutubeIdentity(identity);
    syncYoutubeMetadataFromPerformance(identity);
    if (!youtubeMetadata && youtubeNoCaptionsKey === identity.key) return;
    const key = loadCues && youtubeMetadata
      ? `${identity.key}:caption:${youtubeMetadata.language}:${youtubeMetadata.url}`
      : `${identity.key}:metadata`;
    if (youtubeLoadPromise && youtubeLoadKey === key) return await youtubeLoadPromise;
    if (youtubeRetryPending(key)) return;
    youtubeLoadKey = key;
    const loading = loadYoutubeCaptionState(loadCues).catch(() => {
      deferYoutubeRetry(key);
    }).finally(() => {
      if (youtubeLoadPromise === loading) youtubeLoadPromise = null;
    });
    youtubeLoadPromise = loading;
    await loading;
  };

  const refreshCaptionState = (): void => {
    if (youtubeHost()) {
      const identity = youtubeVideoKey();
      if (captionState?.adapter === 'youtube' && captionState.key !== identity?.key) {
        clearCaptionState();
        youtubeMetadata = null;
        detectedCaptionLanguage = null;
      }
      void refreshYoutubeCaptions(enabled);
      if (captionState?.adapter === 'youtube') {
        renderCurrentCaption();
      }
      return;
    }
    syncStandardCaptionState();
  };

  const captionPriority = (record: CaptionRecord, media: HTMLMediaElement): number | null => {
    const currentTime = Math.max(0, media.currentTime || 0);
    const playbackRate = Math.max(1, media.playbackRate || 1);
    const ahead = Math.min(120, 90 * playbackRate);
    if (record.endTime >= currentTime - 2 && record.startTime <= currentTime + 30) return 0;
    if (record.startTime > currentTime + 30 && record.startTime <= currentTime + ahead) return 1;
    if (record.endTime < currentTime - 2 && record.endTime >= currentTime - 15) return 2;
    return null;
  };

  const captionDistance = (record: CaptionRecord, media: HTMLMediaElement): number => (
    Math.abs(record.startTime - Math.max(0, media.currentTime || 0))
  );

  const MutationObserverCtor = constructors.MutationObserver;
  const observer = typeof MutationObserverCtor === 'function'
    ? new MutationObserverCtor((mutations: MutationRecord[]) => {
        const relevant = mutations.some((mutation) => {
          const target = mutation.target instanceof constructors.Element
            ? mutation.target
            : (mutation.target as Node & { parentElement?: Element | null }).parentElement;
          if (target?.closest(ownedSelector)) return false;
          if (mutation.type !== 'childList') return true;
          const changed = [...mutation.addedNodes, ...mutation.removedNodes];
          return changed.some((node) => (
            !(node instanceof constructors.Element)
              || !node.matches(ownedSelector)
          ));
        });
        if (relevant) dirty = true;
      })
    : null;
  observer?.observe(doc.documentElement, { childList: true, characterData: true, subtree: true });

  const runtime = {
    version: 1,
    async captionLanguage(): Promise<string | null> {
      if (youtubeHost()) await refreshYoutubeCaptions(false);
      else {
        const media = currentMedia();
        detectedCaptionLanguage = media && hasFiniteCaptionTimeline(media)
          ? standardSourceTrack(media)?.language || null
          : null;
      }
      return detectedCaptionLanguage;
    },
    setEnabled(nextEnabled: boolean, nextTargetLanguage: TranslationLanguage): void {
      const languageChanged = targetLanguage !== nextTargetLanguage;
      targetLanguage = nextTargetLanguage;
      if (languageChanged) {
        withStableAnchor(() => {
          for (const record of records.values()) removeTranslation(record);
        });
        clearCaptionState();
        youtubeMetadata = null;
        detectedCaptionLanguage = null;
      }
      if (nextEnabled && !enabled) {
        for (const record of records.values()) {
          record.failed = false;
          record.retryRequested = false;
          removeStatus(record);
        }
      }
      enabled = nextEnabled;
      withStableAnchor(() => {
        if (enabled) doc.documentElement.removeAttribute(hiddenAttribute);
        else doc.documentElement.setAttribute(hiddenAttribute, 'true');
      });
      if (!enabled) {
        withStableAnchor(() => {
          for (const record of records.values()) {
            record.pending = false;
            record.failed = false;
            removeStatus(record);
          }
        });
      }
      refreshCaptionState();
      if (captionState) {
        setCaptionPresentationEnabled(captionState, enabled && !languageMatchesTarget(captionState.language));
        renderCurrentCaption();
      }
      dirty = true;
    },
    nextBatch(
      maxBlocks: number,
      maxChars: number,
      maxBlockChars: number,
      retryOnly = false,
      visibleOnly = false,
      activeBatches: readonly { ids: readonly string[]; requestId: string }[] = [],
      captionMaxBlocks = 16,
      captionMaxChars = 4_000,
    ): UrlPageTranslationGuestBatch {
      if (!enabled) {
        return {
          blocks: [],
          captionRevision,
          contentKind: 'page',
          preemptRequestId: null,
          priority: null,
        };
      }
      scanCount += 1;
      if (dirty || scanCount % 10 === 0) discover();
      refreshCaptionState();

      const scrollTop = readScrollTop();
      if (scrollTop > lastScrollTop + 2) direction = 'down';
      else if (scrollTop < lastScrollTop - 2) direction = 'up';
      lastScrollTop = scrollTop;
      const viewportHeight = Math.max(1, host.innerHeight);

      let preemptRequestId: string | null = null;
      for (const activeBatch of activeBatches) {
        let activePriority: number | null = null;
        for (const id of activeBatch.ids) {
          const record = records.get(id);
          const captionRecord = captionState?.records.get(id);
          const priority = record?.element.isConnected
            ? priorityForRect(record.element.getBoundingClientRect(), viewportHeight)
            : captionRecord
              && captionState
              && !(captionState.adapter === 'youtube' && youtubeAdShowing())
              ? captionPriority(captionRecord, captionState.media)
              : null;
          if (priority === null) continue;
          activePriority = activePriority === null ? priority : Math.min(activePriority, priority);
        }
        if (activePriority !== 0) {
          preemptRequestId = activeBatch.requestId;
          break;
        }
      }

      let pagePending = [...records.values()]
        .filter((record) => !record.completed && !record.pending)
        .filter((record) => retryOnly ? record.retryRequested : !record.failed && !record.retryRequested)
        .filter((record) => record.text.length <= maxBlockChars && isRendered(record.element))
        .map((record) => {
          const rect = record.element.getBoundingClientRect();
          return {
            record,
            priority: retryOnly ? 0 : priorityForRect(rect, viewportHeight),
            distance: distanceForRect(rect, viewportHeight),
          };
        })
        .filter((entry): entry is typeof entry & { priority: number } => entry.priority !== null)
        .sort((left, right) => left.priority - right.priority || left.distance - right.distance);

      const activeCaptionState = captionState;
      let captionPending = activeCaptionState
        && !languageMatchesTarget(activeCaptionState.language)
        && !(activeCaptionState.adapter === 'youtube' && youtubeAdShowing())
        ? [...activeCaptionState.records.values()]
            .filter((record) => !record.completed && !record.pending)
            .filter((record) => retryOnly
              ? record.retryRequested
              : (!record.failed && !record.retryRequested) || record.retryRequested)
            .filter((record) => record.text.length <= maxBlockChars)
            .map((record) => ({
              record,
              priority: record.retryRequested ? 0 : captionPriority(record, activeCaptionState.media),
              distance: captionDistance(record, activeCaptionState.media),
            }))
            .filter((entry): entry is typeof entry & { priority: number } => entry.priority !== null)
            .sort((left, right) => left.priority - right.priority || left.distance - right.distance)
        : [];

      if (activeBatches.length > 0) {
        if (!preemptRequestId) {
          return {
            blocks: [],
            captionRevision,
            contentKind: 'page',
            preemptRequestId: null,
            priority: null,
          };
        }
        pagePending = pagePending.filter((entry) => entry.priority === 0);
        captionPending = captionPending.filter((entry) => entry.priority === 0);
      } else if (visibleOnly) {
        pagePending = pagePending.filter((entry) => entry.priority === 0);
        captionPending = captionPending.filter((entry) => entry.priority === 0);
      }

      const contentKind: UrlPageTranslationContentKind = captionPending[0]?.priority === 0
        ? 'caption'
        : pagePending[0]?.priority === 0
          ? 'page'
          : captionPending.length > 0
            ? 'caption'
            : 'page';
      const pending = contentKind === 'caption' ? captionPending : pagePending;
      const selectedMaxBlocks = contentKind === 'caption' ? captionMaxBlocks : maxBlocks;
      const selectedMaxChars = contentKind === 'caption' ? captionMaxChars : maxChars;

      const blocks: UrlPageTranslationBlock[] = [];
      const selectedPage: RecordEntry[] = [];
      const selectedCaptions: CaptionRecord[] = [];
      let chars = 0;
      let firstPriority: number | null = null;
      for (const entry of pending) {
        if (firstPriority !== null && entry.priority !== firstPriority) break;
        if (blocks.length >= selectedMaxBlocks) break;
        if (blocks.length > 0 && chars >= selectedMaxChars) break;
        const exceedsSoftLimit = chars + entry.record.text.length > selectedMaxChars;
        const allowSingleLongCaption = contentKind === 'caption'
          && blocks.length === 0
          && entry.record.text.length <= maxBlockChars;
        if (exceedsSoftLimit && !allowSingleLongCaption) continue;
        entry.record.pending = true;
        entry.record.retryRequested = false;
        blocks.push({ id: entry.record.id, text: entry.record.text });
        if (contentKind === 'caption') selectedCaptions.push(entry.record as CaptionRecord);
        else selectedPage.push(entry.record as RecordEntry);
        chars += entry.record.text.length;
        firstPriority ??= entry.priority;
      }
      if (contentKind === 'caption' && blocks.length > 1) {
        const startTimes = new Map(selectedCaptions.map((record) => [record.id, record.startTime]));
        blocks.sort((left, right) => (
          (startTimes.get(left.id) ?? 0) - (startTimes.get(right.id) ?? 0)
        ));
      }
      if (selectedPage.length > 0) {
        withStableAnchor(() => {
          for (const record of selectedPage) showStatus(record, 'loading');
        });
      }
      if (selectedCaptions.length > 0) renderCurrentCaption();
      return { blocks, captionRevision, contentKind, preemptRequestId, priority: firstPriority };
    },
    release(ids: readonly string[]): void {
      withStableAnchor(() => {
        for (const id of ids) {
          const record = records.get(id);
          if (!record || record.completed) continue;
          record.pending = false;
          removeStatus(record);
        }
      });
      for (const id of ids) {
        const record = captionState?.records.get(id);
        if (!record || record.completed) continue;
        record.pending = false;
        if (record.retrying) record.retryRequested = true;
      }
      renderCurrentCaption();
    },
    apply(items: readonly UrlPageTranslationItem[]): number {
      let inserted = 0;
      withStableAnchor(() => {
        for (const item of items) {
          const record = records.get(item.id);
          if (!record || !record.element.isConnected) continue;
          record.pending = false;
          record.failed = false;
          record.retryRequested = false;
          record.completed = true;
          removeStatus(record);
          record.translationNode?.remove();
          record.translationNode = null;
          if (normalizeText(item.translation) === record.text) continue;
          const translation = doc.createElement('span');
          translation.setAttribute(translationAttribute, 'true');
          translation.setAttribute('lang', targetLanguage);
          translation.textContent = item.translation;
          record.element.append(translation);
          record.translationNode = translation;
          inserted += 1;
        }
      });
      for (const item of items) {
        const state = captionState;
        const record = state?.records.get(item.id);
        if (!state || !record) continue;
        record.pending = false;
        record.failed = false;
        record.retrying = false;
        record.retryRequested = false;
        record.completed = true;
        const translation = normalizeText(item.translation);
        record.translation = translation === record.text ? null : item.translation;
        if (state.adapter === 'standard') replaceGeneratedCue(state, record);
        if (record.translation) inserted += 1;
      }
      renderCurrentCaption();
      return inserted;
    },
    fail(ids: readonly string[]): void {
      withStableAnchor(() => {
        for (const id of ids) {
          const record = records.get(id);
          if (!record) continue;
          record.pending = false;
          record.retryRequested = false;
          record.failed = true;
          showStatus(record, 'error');
        }
      });
      for (const id of ids) {
        const record = captionState?.records.get(id);
        if (!record) continue;
        record.pending = false;
        record.retrying = false;
        record.retryRequested = false;
        record.failed = true;
      }
      renderCurrentCaption();
    },
    destroy(): void {
      observer?.disconnect();
      host.removeEventListener('wheel', invalidateDeferredAnchorCorrection, { capture: true });
      host.removeEventListener('touchstart', invalidateDeferredAnchorCorrection, { capture: true });
      host.removeEventListener('touchmove', invalidateDeferredAnchorCorrection, { capture: true });
      host.removeEventListener('keydown', invalidateDeferredAnchorCorrectionForKey, { capture: true });
      host.removeEventListener('scroll', handleViewportScroll, { capture: true });
      anchorRevision += 1;
      withStableAnchor(() => {
        for (const record of records.values()) {
          record.translationNode?.remove();
          removeStatus(record);
        }
        doc.documentElement.removeAttribute(hiddenAttribute);
      });
      runtimeActive = false;
      restoreYoutubeCaptionToggle();
      clearCaptionState();
      doc.documentElement.removeAttribute(youtubeCaptionsAttribute);
      records.clear();
      const holder = host as unknown as Record<string, unknown>;
      if (holder[runtimeKey] === runtime) delete holder[runtimeKey];
    },
  };

  (host as unknown as Record<string, unknown>)[runtimeKey] = runtime;
}

function validatedGuestBatch(
  value: unknown,
  limits: {
    captionMaxBlocks: number;
    captionMaxChars: number;
    maxBlocks: number;
    maxChars: number;
  },
): UrlPageTranslationGuestBatch {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    return {
      blocks: [],
      captionRevision: 0,
      contentKind: 'page',
      preemptRequestId: null,
      priority: null,
    };
  }
  const contentKind: UrlPageTranslationContentKind = value.contentKind === 'caption' ? 'caption' : 'page';
  const maxBlocks = contentKind === 'caption' ? limits.captionMaxBlocks : limits.maxBlocks;
  const maxChars = contentKind === 'caption' ? limits.captionMaxChars : limits.maxChars;
  const blocks: UrlPageTranslationBlock[] = [];
  const ids = new Set<string>();
  let chars = 0;
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
    const id = item.id;
    const text = item.text.trim();
    if (!/^[A-Za-z0-9:_-]{1,96}$/.test(id) || ids.has(id)) continue;
    const allowSingleLongCaption = contentKind === 'caption'
      && blocks.length === 0
      && text.length <= URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS;
    if (!text || text.length > URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS) continue;
    if (text.length > maxChars && !allowSingleLongCaption) continue;
    if (chars + text.length > maxChars && !allowSingleLongCaption) break;
    ids.add(id);
    chars += text.length;
    blocks.push({ id, text });
    if (chars > maxChars) break;
    if (blocks.length >= maxBlocks) break;
  }
  const captionRevision = Number.isSafeInteger(value.captionRevision)
    && (value.captionRevision as number) >= 0
    ? value.captionRevision as number
    : 0;
  const priority = typeof value.priority === 'number' && Number.isInteger(value.priority)
    ? value.priority
    : null;
  const preemptRequestId = typeof value.preemptRequestId === 'string'
    && /^[A-Za-z0-9:_-]{1,96}$/.test(value.preemptRequestId)
    ? value.preemptRequestId
    : null;
  return { blocks, captionRevision, contentKind, preemptRequestId, priority };
}

function boundedBatchLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
