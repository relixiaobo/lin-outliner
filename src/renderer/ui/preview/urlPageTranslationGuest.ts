import type { Locale } from '../../../core/locale';
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
@media (prefers-contrast: more) {
  [data-tenon-bilingual-translation="true"] {
    opacity: 1 !important;
  }
}
`;

export interface UrlPageTranslationGuestBatch {
  blocks: UrlPageTranslationBlock[];
  priority: number | null;
}

export interface UrlPageTranslationGuestBridge {
  initialize(targetLocale: Locale): Promise<void>;
  setEnabled(enabled: boolean, targetLocale: Locale): Promise<void>;
  nextBatch(): Promise<UrlPageTranslationGuestBatch>;
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
    async initialize(targetLocale) {
      await removeCss();
      cssKey = await webview.insertCSS(TRANSLATION_CSS);
      const source = `(${installUrlPageTranslationRuntime.toString()})(window, ${JSON.stringify(URL_PAGE_TRANSLATION_RUNTIME_KEY)}, ${JSON.stringify(targetLocale)})`;
      await webview.executeJavaScript(source);
    },
    async setEnabled(enabled, targetLocale) {
      await execute('setEnabled', enabled, targetLocale);
    },
    async nextBatch() {
      const raw = await execute<unknown>(
        'nextBatch',
        URL_PAGE_TRANSLATION_MAX_BLOCKS,
        URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
        URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
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
  initialTargetLocale: Locale,
): void {
  const doc = host.document;
  const constructors = host as unknown as {
    Element: typeof Element;
    MutationObserver?: typeof MutationObserver;
    NodeFilter: typeof NodeFilter;
  };
  const translationAttribute = 'data-tenon-bilingual-translation';
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
  ].join(',');
  type RecordEntry = {
    id: string;
    element: HTMLElement;
    text: string;
    completed: boolean;
    failed: boolean;
    pending: boolean;
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
  let targetLocale = initialTargetLocale;

  const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
  const hasReadableText = (value: string) => /[\p{L}\p{N}]/u.test(value);

  const isDeclaredTargetLanguage = (element: HTMLElement): boolean => {
    const declared = element.closest('[lang]')?.getAttribute('lang')?.trim().toLowerCase();
    if (!declared) return false;
    const targetPrefix = targetLocale === 'zh-Hans' ? 'zh' : 'en';
    return declared === targetPrefix || declared.startsWith(`${targetPrefix}-`);
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

  const removeTranslation = (record: RecordEntry): void => {
    record.translationNode?.remove();
    record.translationNode = null;
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
          if (target?.closest(`[${translationAttribute}]`)) return false;
          if (mutation.type !== 'childList') return true;
          const changed = [...mutation.addedNodes, ...mutation.removedNodes];
          return changed.some((node) => (
            !(node instanceof constructors.Element) || !node.matches(`[${translationAttribute}]`)
          ));
        });
        if (relevant) dirty = true;
      })
    : null;
  observer?.observe(doc.documentElement, { childList: true, characterData: true, subtree: true });

  const runtime = {
    version: 1,
    setEnabled(nextEnabled: boolean, nextTargetLocale: Locale): void {
      const localeChanged = targetLocale !== nextTargetLocale;
      targetLocale = nextTargetLocale;
      if (localeChanged) {
        withStableAnchor(() => {
          for (const record of records.values()) removeTranslation(record);
        });
      }
      if (nextEnabled && !enabled) {
        for (const record of records.values()) record.failed = false;
      }
      enabled = nextEnabled;
      withStableAnchor(() => {
        if (enabled) doc.documentElement.removeAttribute(hiddenAttribute);
        else doc.documentElement.setAttribute(hiddenAttribute, 'true');
      });
      if (!enabled) {
        for (const record of records.values()) record.pending = false;
      }
      dirty = true;
    },
    nextBatch(maxBlocks: number, maxChars: number, maxBlockChars: number): UrlPageTranslationGuestBatch {
      if (!enabled) return { blocks: [], priority: null };
      scanCount += 1;
      if (dirty || scanCount % 10 === 0) discover();

      const scrollTop = doc.scrollingElement?.scrollTop ?? host.scrollY;
      if (scrollTop > lastScrollTop + 2) direction = 'down';
      else if (scrollTop < lastScrollTop - 2) direction = 'up';
      lastScrollTop = scrollTop;
      const viewportHeight = Math.max(1, host.innerHeight);

      const pending = [...records.values()]
        .filter((record) => !record.completed && !record.failed && !record.pending)
        .filter((record) => record.text.length <= maxBlockChars && isRendered(record.element))
        .map((record) => {
          const rect = record.element.getBoundingClientRect();
          return {
            record,
            priority: priorityForRect(rect, viewportHeight),
            distance: distanceForRect(rect, viewportHeight),
          };
        })
        .filter((entry): entry is typeof entry & { priority: number } => entry.priority !== null)
        .sort((left, right) => left.priority - right.priority || left.distance - right.distance);

      const blocks: UrlPageTranslationBlock[] = [];
      let chars = 0;
      let firstPriority: number | null = null;
      for (const entry of pending) {
        if (blocks.length >= maxBlocks) break;
        if (blocks.length > 0 && chars + entry.record.text.length > maxChars) break;
        entry.record.pending = true;
        blocks.push({ id: entry.record.id, text: entry.record.text });
        chars += entry.record.text.length;
        firstPriority ??= entry.priority;
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
          record.completed = true;
          record.translationNode?.remove();
          record.translationNode = null;
          if (normalizeText(item.translation) === record.text) continue;
          const translation = doc.createElement('span');
          translation.setAttribute(translationAttribute, 'true');
          translation.setAttribute('lang', targetLocale);
          translation.textContent = item.translation;
          record.element.append(translation);
          record.translationNode = translation;
        }
      });
    },
    fail(ids: readonly string[]): void {
      for (const id of ids) {
        const record = records.get(id);
        if (!record) continue;
        record.pending = false;
        record.failed = true;
      }
    },
    destroy(): void {
      observer?.disconnect();
      withStableAnchor(() => {
        for (const record of records.values()) record.translationNode?.remove();
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
