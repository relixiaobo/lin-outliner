import type { TranslationLanguage } from '../../../core/translationLanguage';
import {
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
  type UrlPageTranslationBlock,
  type UrlPageTranslationItem,
} from '../../../core/urlPageTranslation';
import {
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
  type UrlPageTranslationGuestActiveBatch,
  type UrlPageTranslationGuestBatchOptions,
  type UrlPageTranslationGuestCommand,
  type UrlPageTranslationGuestLabels,
} from '../../../core/urlPageTranslationGuest';

export { URL_PAGE_TRANSLATION_RUNTIME_KEY } from '../../../core/urlPageTranslationGuest';
export type {
  UrlPageTranslationGuestActiveBatch,
  UrlPageTranslationGuestBatchOptions,
  UrlPageTranslationGuestLabels,
} from '../../../core/urlPageTranslationGuest';

const URL_PAGE_TRANSLATION_DEFAULT_MAX_BLOCKS = 4;
const URL_PAGE_TRANSLATION_DEFAULT_MAX_CHARS = 4_000;

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
`;

export interface UrlPageTranslationGuestBatch {
  blocks: UrlPageTranslationBlock[];
  preemptRequestId?: string | null;
  priority: number | null;
}

export interface UrlPageTranslationGuestBridge {
  documentLanguage(): Promise<string | null>;
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
      const raw = await execute<unknown>({
        operation: 'next-batch',
        options: {
          activeBatches: options.activeBatches ?? [],
          maxBlocks,
          maxChars,
          retryOnly: options.retryOnly ?? false,
          visibleOnly: options.visibleOnly ?? false,
        },
      });
      return validatedGuestBatch(raw, maxBlocks, maxChars);
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
  const candidateSelector = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '[role="heading"]',
    'p', 'li', 'blockquote', 'figcaption', 'caption', 'td', 'th', 'dt', 'dd',
    'article div', 'main div', '[role="article"] div', '[role="main"] div',
  ].join(',');
  const excludedSelector = [
    'script', 'style', 'noscript', 'template', 'pre', 'code', 'kbd', 'samp',
    'input', 'textarea', 'select', 'option', 'button', 'form', 'nav',
    '[role="button"]', '[role="textbox"]', '[role="navigation"]',
    `[${translationAttribute}]`,
    `[${statusAttribute}]`,
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
  const hasReadableText = (value: string) => /[\p{L}\p{N}]/u.test(value);

  const isDeclaredTargetLanguage = (element: HTMLElement): boolean => {
    const declared = element.closest('[lang]')?.getAttribute('lang')?.trim().replaceAll('_', '-').toLowerCase();
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

  const MutationObserverCtor = constructors.MutationObserver;
  const observer = typeof MutationObserverCtor === 'function'
    ? new MutationObserverCtor((mutations: MutationRecord[]) => {
        const relevant = mutations.some((mutation) => {
          const target = mutation.target instanceof constructors.Element
            ? mutation.target
            : (mutation.target as Node & { parentElement?: Element | null }).parentElement;
          if (target?.closest(`[${translationAttribute}], [${statusAttribute}]`)) return false;
          if (mutation.type !== 'childList') return true;
          const changed = [...mutation.addedNodes, ...mutation.removedNodes];
          return changed.some((node) => (
            !(node instanceof constructors.Element)
              || !node.matches(`[${translationAttribute}], [${statusAttribute}]`)
          ));
        });
        if (relevant) dirty = true;
      })
    : null;
  observer?.observe(doc.documentElement, { childList: true, characterData: true, subtree: true });

  const runtime = {
    version: 1,
    setEnabled(nextEnabled: boolean, nextTargetLanguage: TranslationLanguage): void {
      const languageChanged = targetLanguage !== nextTargetLanguage;
      targetLanguage = nextTargetLanguage;
      if (languageChanged) {
        withStableAnchor(() => {
          for (const record of records.values()) removeTranslation(record);
        });
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
      dirty = true;
    },
    nextBatch(
      maxBlocks: number,
      maxChars: number,
      maxBlockChars: number,
      retryOnly = false,
      visibleOnly = false,
      activeBatches: readonly { ids: readonly string[]; requestId: string }[] = [],
    ): UrlPageTranslationGuestBatch {
      if (!enabled) return { blocks: [], preemptRequestId: null, priority: null };
      scanCount += 1;
      if (dirty || scanCount % 10 === 0) discover();

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
          if (!record?.element.isConnected) continue;
          const priority = priorityForRect(record.element.getBoundingClientRect(), viewportHeight);
          if (priority === null) continue;
          activePriority = activePriority === null ? priority : Math.min(activePriority, priority);
        }
        if (activePriority !== 0) {
          preemptRequestId = activeBatch.requestId;
          break;
        }
      }

      let pending = [...records.values()]
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

      if (activeBatches.length > 0) {
        if (!preemptRequestId) return { blocks: [], preemptRequestId: null, priority: null };
        pending = pending.filter((entry) => entry.priority === 0);
      } else if (visibleOnly) {
        pending = pending.filter((entry) => entry.priority === 0);
      }

      const blocks: UrlPageTranslationBlock[] = [];
      const selected: RecordEntry[] = [];
      let chars = 0;
      let firstPriority: number | null = null;
      for (const entry of pending) {
        if (firstPriority !== null && entry.priority !== firstPriority) break;
        if (blocks.length >= maxBlocks) break;
        if (chars + entry.record.text.length > maxChars) continue;
        entry.record.pending = true;
        entry.record.retryRequested = false;
        blocks.push({ id: entry.record.id, text: entry.record.text });
        selected.push(entry.record);
        chars += entry.record.text.length;
        firstPriority ??= entry.priority;
      }
      if (selected.length > 0) {
        withStableAnchor(() => {
          for (const record of selected) showStatus(record, 'loading');
        });
      }
      return { blocks, preemptRequestId, priority: firstPriority };
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
      records.clear();
      const holder = host as unknown as Record<string, unknown>;
      if (holder[runtimeKey] === runtime) delete holder[runtimeKey];
    },
  };

  (host as unknown as Record<string, unknown>)[runtimeKey] = runtime;
}

function validatedGuestBatch(
  value: unknown,
  maxBlocks: number,
  maxChars: number,
): UrlPageTranslationGuestBatch {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    return { blocks: [], preemptRequestId: null, priority: null };
  }
  const blocks: UrlPageTranslationBlock[] = [];
  const ids = new Set<string>();
  let chars = 0;
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
    const id = item.id;
    const text = item.text.trim();
    if (!/^[A-Za-z0-9:_-]{1,96}$/.test(id) || ids.has(id)) continue;
    if (!text || text.length > Math.min(URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS, maxChars)) continue;
    if (chars + text.length > maxChars) break;
    ids.add(id);
    chars += text.length;
    blocks.push({ id, text });
    if (blocks.length >= maxBlocks) break;
  }
  const priority = typeof value.priority === 'number' && Number.isInteger(value.priority)
    ? value.priority
    : null;
  const preemptRequestId = typeof value.preemptRequestId === 'string'
    && /^[A-Za-z0-9:_-]{1,96}$/.test(value.preemptRequestId)
    ? value.preemptRequestId
    : null;
  return { blocks, preemptRequestId, priority };
}

function boundedBatchLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
