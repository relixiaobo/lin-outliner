import type { TranslationLanguage } from '../../../core/translationLanguage';
import {
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
  type UrlPageTranslationBlock,
  type UrlPageTranslationItem,
} from '../../../core/urlPageTranslation';

export const URL_PAGE_TRANSLATION_RUNTIME_KEY = '__tenonBilingualTranslationV1__';

const TRANSLATION_CSS = `
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
  width: max(1em, 16px) !important;
  height: max(1em, 16px) !important;
  align-items: center !important;
  justify-content: center !important;
  margin-inline-start: 0.35em !important;
  border: 0 !important;
  border-radius: 50% !important;
  background: transparent !important;
  color: currentColor !important;
  cursor: default !important;
  font: 700 0.72em/1 system-ui, sans-serif !important;
  opacity: 0.52 !important;
  vertical-align: 0.05em !important;
}
[data-tenon-bilingual-status="loading"]::before {
  box-sizing: border-box !important;
  width: 0.72em !important;
  height: 0.72em !important;
  border: 0.11em solid currentColor !important;
  border-inline-end-color: transparent !important;
  border-radius: 50% !important;
  animation: tenon-bilingual-spin 0.8s linear infinite !important;
  content: "" !important;
}
[data-tenon-bilingual-status="error"] {
  border: 0.1em solid currentColor !important;
  opacity: 0.78 !important;
}
[data-tenon-bilingual-status="error"]:hover {
  opacity: 0.92 !important;
}
[data-tenon-bilingual-status="error"]:active {
  border-width: 0.14em !important;
  opacity: 1 !important;
}
[data-tenon-bilingual-status="error"]::before {
  content: "!" !important;
}
[data-tenon-bilingual-status="error"]:focus-visible {
  outline: 0.12em solid currentColor !important;
  outline-offset: 0.12em !important;
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

export interface UrlPageTranslationGuestLabels {
  retry: string;
  translating: string;
}

export interface UrlPageTranslationGuestBatch {
  blocks: UrlPageTranslationBlock[];
  priority: number | null;
}

export interface UrlPageTranslationGuestBridge {
  initialize(targetLanguage: TranslationLanguage, labels: UrlPageTranslationGuestLabels): Promise<void>;
  setEnabled(enabled: boolean, targetLanguage: TranslationLanguage): Promise<void>;
  nextBatch(retryOnly?: boolean): Promise<UrlPageTranslationGuestBatch>;
  apply(translations: readonly UrlPageTranslationItem[]): Promise<void>;
  fail(ids: readonly string[]): Promise<void>;
  destroy(): Promise<void>;
}

export function createUrlPageTranslationGuestBridge(
  webview: Electron.WebviewTag,
): UrlPageTranslationGuestBridge {
  let cssKey: string | null = null;

  const execute = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const source = `(() => {
      const runtime = window[${JSON.stringify(URL_PAGE_TRANSLATION_RUNTIME_KEY)}];
      if (!runtime || runtime.version !== 1 || typeof runtime[${JSON.stringify(method)}] !== 'function') return null;
      return runtime[${JSON.stringify(method)}](...${JSON.stringify(args)});
    })()`;
    return await webview.executeJavaScript(source) as T;
  };

  const removeCss = async () => {
    const key = cssKey;
    cssKey = null;
    if (!key) return;
    await webview.removeInsertedCSS(key).catch(() => undefined);
  };

  return {
    async initialize(targetLanguage, labels) {
      await removeCss();
      cssKey = await webview.insertCSS(TRANSLATION_CSS);
      const source = `(${installUrlPageTranslationRuntime.toString()})(window, ${JSON.stringify(URL_PAGE_TRANSLATION_RUNTIME_KEY)}, ${JSON.stringify(targetLanguage)}, ${JSON.stringify(labels)})`;
      await webview.executeJavaScript(source);
    },
    async setEnabled(enabled, targetLanguage) {
      await execute('setEnabled', enabled, targetLanguage);
    },
    async nextBatch(retryOnly = false) {
      const raw = await execute<unknown>(
        'nextBatch',
        URL_PAGE_TRANSLATION_MAX_BLOCKS,
        URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
        URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
        retryOnly,
      );
      return validatedGuestBatch(raw);
    },
    async apply(translations) {
      await execute('apply', translations);
    },
    async fail(ids) {
      await execute('fail', ids);
    },
    async destroy() {
      await execute('destroy').catch(() => undefined);
      await removeCss();
    },
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
  let nextId = 1;
  let enabled = false;
  let dirty = true;
  let scanCount = 0;
  let lastScrollTop = doc.scrollingElement?.scrollTop ?? host.scrollY;
  let direction: 'down' | 'up' = 'down';
  let targetLanguage = initialTargetLanguage;

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
      seen.add(id);
      const existing = records.get(id);
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
      if (existing.text !== text || (existing.translationNode && !existing.translationNode.isConnected)) {
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

  const withStableAnchor = (mutate: () => void): void => {
    if (dirty) discover();
    const anchor = captureAnchor();
    mutate();
    if (!anchor?.element.isConnected) return;
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) host.scrollBy(0, delta);
  };

  const priorityForRect = (rect: DOMRect, viewportHeight: number): number | null => {
    if (rect.bottom > 0 && rect.top < viewportHeight) return 0;
    if (direction === 'down') {
      if (rect.top >= viewportHeight && rect.top < viewportHeight * 3) return 1;
      if (rect.bottom <= 0 && rect.bottom > -viewportHeight * 0.5) return 2;
      return null;
    }
    if (rect.bottom <= 0 && rect.bottom > -viewportHeight * 2) return 1;
    if (rect.top >= viewportHeight && rect.top < viewportHeight * 1.5) return 2;
    return null;
  };

  const distanceForRect = (rect: DOMRect, viewportHeight: number): number => {
    if (rect.bottom > 0 && rect.top < viewportHeight) return Math.max(0, rect.top);
    return direction === 'down'
      ? Math.max(0, rect.top - viewportHeight)
      : Math.max(0, -rect.bottom);
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
    ): UrlPageTranslationGuestBatch {
      if (!enabled) return { blocks: [], priority: null };
      scanCount += 1;
      if (dirty || scanCount % 10 === 0) discover();

      const scrollTop = doc.scrollingElement?.scrollTop ?? host.scrollY;
      if (scrollTop > lastScrollTop + 2) direction = 'down';
      else if (scrollTop < lastScrollTop - 2) direction = 'up';
      lastScrollTop = scrollTop;
      const viewportHeight = Math.max(1, host.innerHeight);

      const pending = [...records.values()]
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

      const blocks: UrlPageTranslationBlock[] = [];
      const selected: RecordEntry[] = [];
      let chars = 0;
      let firstPriority: number | null = null;
      for (const entry of pending) {
        if (blocks.length >= maxBlocks) break;
        if (blocks.length > 0 && chars + entry.record.text.length > maxChars) break;
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
      return { blocks, priority: firstPriority };
    },
    apply(items: readonly UrlPageTranslationItem[]): void {
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
        }
      });
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
      withStableAnchor(() => {
        for (const record of records.values()) {
          record.translationNode?.remove();
          removeStatus(record);
        }
        doc.documentElement.removeAttribute(hiddenAttribute);
      });
      records.clear();
      const holder = host as unknown as Record<string, unknown>;
      if (holder[runtimeKey] === runtime) delete holder[runtimeKey];
    },
  };

  (host as unknown as Record<string, unknown>)[runtimeKey] = runtime;
}

function validatedGuestBatch(value: unknown): UrlPageTranslationGuestBatch {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return { blocks: [], priority: null };
  const blocks: UrlPageTranslationBlock[] = [];
  const ids = new Set<string>();
  let chars = 0;
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
    const id = item.id;
    const text = item.text.trim();
    if (!/^[A-Za-z0-9:_-]{1,96}$/.test(id) || ids.has(id)) continue;
    if (!text || text.length > URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS) continue;
    if (chars + text.length > URL_PAGE_TRANSLATION_MAX_BATCH_CHARS) break;
    ids.add(id);
    chars += text.length;
    blocks.push({ id, text });
    if (blocks.length >= URL_PAGE_TRANSLATION_MAX_BLOCKS) break;
  }
  const priority = typeof value.priority === 'number' && Number.isInteger(value.priority)
    ? value.priority
    : null;
  return { blocks, priority };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
