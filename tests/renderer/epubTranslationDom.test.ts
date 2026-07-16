import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  EPUB_TRANSLATION_CSS,
  EpubTranslationDomAdapter,
} from '../../src/renderer/ui/preview/epubTranslationDom';

const LABELS = {
  retry: 'Retry translation',
  translating: 'Translating',
};

describe('EPUB translation DOM adapter', () => {
  test('collects bounded readable blocks, skips matching language, and inserts plain text', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);

    const batch = fixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000, visibleOnly: true });
    expect(batch.priority).toBe(0);
    expect(batch.blocks.map(({ text }) => text)).toEqual(['Current paragraph']);
    expect(fixture.chapter.querySelectorAll('[data-tenon-epub-translation-status="loading"]')).toHaveLength(1);
    expect(fixture.chapter.querySelector('#same-language [data-tenon-epub-translation-status]')).toBeNull();
    expect(fixture.chapter.querySelector('#code [data-tenon-epub-translation-status]')).toBeNull();

    const inserted = fixture.adapter.apply(batch.blocks.map(({ id }) => ({
      id,
      translation: '<strong>Translated safely</strong>',
    })));
    const translation = fixture.chapter.querySelector('[data-tenon-epub-translation="true"]');
    expect(inserted).toBe(1);
    expect(translation?.textContent).toBe('<strong>Translated safely</strong>');
    expect(translation?.getAttribute('lang')).toBe('zh-Hans');
    expect(translation?.querySelector('strong')).toBeNull();
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status]')).toBeNull();

    fixture.adapter.setEnabled(false);
    expect(fixture.chapter.documentElement.getAttribute('data-tenon-epub-translations-hidden')).toBe('true');
    fixture.adapter.setEnabled(true);
    expect(fixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000, visibleOnly: true }).blocks).toEqual([]);
    fixture.cleanup();
  });

  test('marks the complete EPUB viewport loading before request-sized batches drain it', () => {
    const chapter = chapterDocumentFromMarkup(`
      <p id="first">First visible paragraph</p>
      <p id="second">Second visible paragraph</p>
      <p id="third">Third visible paragraph</p>
    `);
    const fixture = createFixture(chapter, (document) => {
      setRect(document, 'first', () => rect(20, 60));
      setRect(document, 'second', () => rect(80, 120));
      setRect(document, 'third', () => rect(140, 180));
    });
    fixture.adapter.setEnabled(true);

    const first = fixture.adapter.nextBatch({
      maxBlocks: 1,
      maxChars: 2_000,
      queueVisible: true,
      visibleOnly: true,
    });

    expect(first.blocks).toHaveLength(1);
    expect(fixture.chapter.querySelectorAll('[data-tenon-epub-translation-status="loading"]'))
      .toHaveLength(3);
    fixture.cleanup();
  });

  test('collects nested semantic structures once while preserving direct parent text', () => {
    const chapter = chapterDocumentFromMarkup(`
      <ul><li id="parent-item">Parent item<p id="nested-item">Nested item</p></li></ul>
      <blockquote id="quote"><p id="quoted-text">Quoted text</p></blockquote>
      <section><div id="leaf-container">Leaf container text</div></section>
    `);
    const fixture = createFixture(chapter, (document) => {
      setRect(document, 'parent-item', () => rect(20, 50));
      setRect(document, 'nested-item', () => rect(60, 90));
      setRect(document, 'quote', () => rect(100, 160));
      setRect(document, 'quoted-text', () => rect(110, 140));
      setRect(document, 'leaf-container', () => rect(180, 220));
    });
    fixture.adapter.setEnabled(true);

    const batch = fixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000, visibleOnly: true });
    expect(batch.blocks.map(({ text }) => text)).toEqual([
      'Parent item',
      'Nested item',
      'Quoted text',
      'Leaf container text',
    ]);
    fixture.cleanup();
  });

  test('excludes hidden descendant text and falls through invalid language declarations', () => {
    const chapter = chapterDocumentFromMarkup(`
      <p id="visible">Visible <span style="display: none">Private note</span> text</p>
      <div style="display: none"><p id="hidden">Hidden paragraph</p></div>
      <div contenteditable>
        <p id="editable">Editable draft</p>
        <p id="read-only" contenteditable="false">Read-only published text</p>
      </div>
      <section lang="zh-Hans"><div lang="not_a_language"><p id="inherited">Inherited target text</p></div></section>
      <p id="xml-language" lang="invalid_tag" xml:lang="zh-Hans">XML target text</p>
    `);
    const fixture = createFixture(chapter, (document) => {
      setRect(document, 'visible', () => rect(20, 60));
      setRect(document, 'hidden', () => rect(80, 120));
      setRect(document, 'editable', () => rect(120, 160));
      setRect(document, 'read-only', () => rect(180, 220));
      setRect(document, 'inherited', () => rect(240, 280));
      setRect(document, 'xml-language', () => rect(300, 340));
    });
    fixture.adapter.setEnabled(true);

    const batch = fixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000, visibleOnly: true });
    expect(batch.blocks.map(({ text }) => text)).toEqual([
      'Visible text',
      'Read-only published text',
    ]);
    fixture.cleanup();
  });

  test('keeps visible and prefetch tiers separate and enforces the requested character budget', () => {
    const longText = 'x'.repeat(3_000);
    const longChapter = chapterDocumentFromMarkup(`<p id="long">${longText}</p>`);
    const longFixture = createFixture(longChapter, (document) => {
      setRect(document, 'long', () => rect(20, 80));
    });
    longFixture.adapter.setEnabled(true);
    expect(longFixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true }).blocks)
      .toEqual([]);
    expect(longFixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000, visibleOnly: true }).blocks[0]?.text)
      .toHaveLength(3_000);

    const tierChapter = chapterDocumentFromMarkup(`
      <p id="visible">Visible paragraph</p>
      <p id="prefetch">Prefetch paragraph</p>
    `);
    const tierFixture = createFixture(tierChapter, (document) => {
      setRect(document, 'visible', () => rect(20, 60));
      setRect(document, 'prefetch', () => rect(800, 840));
    });
    tierFixture.adapter.setEnabled(true);
    const visible = tierFixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000 });
    expect(visible.priority).toBe(0);
    expect(visible.blocks.map(({ text }) => text)).toEqual(['Visible paragraph']);
    tierFixture.adapter.apply(visible.blocks.map(({ id }) => ({ id, translation: 'Visible translation' })));
    const prefetch = tierFixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000 });
    expect(prefetch.priority).toBe(1);
    expect(prefetch.blocks.map(({ text }) => text)).toEqual(['Prefetch paragraph']);

    longFixture.cleanup();
    tierFixture.cleanup();
  });

  test('preempts the farthest non-visible EPUB batch', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const visible = fixture.adapter.nextBatch({ maxBlocks: 8, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.apply(visible.blocks.map(({ id }) => ({ id, translation: `T ${id}` })));
    const behind = fixture.adapter.nextBatch({ maxBlocks: 1, maxChars: 4_000 });
    const ahead = fixture.adapter.nextBatch({ maxBlocks: 1, maxChars: 4_000 });
    expect(behind.blocks[0]?.text).toBe('Earlier paragraph');
    expect(ahead.blocks[0]?.text).toBe('Upcoming paragraph');

    fixture.scrollRoot.scrollTop = 1_500;
    fixture.scrollRoot.dispatchEvent(new fixture.window.Event('scroll'));
    const replacement = fixture.adapter.nextBatch({
      activeBatches: [
        { ids: ahead.blocks.map(({ id }) => id), requestId: 'request:ahead' },
        { ids: behind.blocks.map(({ id }) => id), requestId: 'request:behind' },
      ],
      maxBlocks: 8,
      maxChars: 2_000,
      visibleOnly: true,
    });

    expect(replacement.blocks.map(({ text }) => text)).toContain('Far paragraph');
    expect(replacement.preemptRequestId).toBe('request:behind');
    fixture.cleanup();
  });

  test('sends upward batches in document order', () => {
    const chapter = chapterDocumentFromMarkup(`
      <p id="first">First paragraph</p>
      <p id="second">Second paragraph</p>
      <p id="third">Third paragraph</p>
    `);
    const fixture = createFixture(chapter, (document) => {
      setRect(document, 'first', () => rect(20, 50));
      setRect(document, 'second', () => rect(80, 110));
      setRect(document, 'third', () => rect(140, 170));
    });
    fixture.scrollRoot.scrollTop = 10;
    fixture.scrollRoot.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.scrollRoot.scrollTop = 0;
    fixture.scrollRoot.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.adapter.setEnabled(true);

    const batch = fixture.adapter.nextBatch({ maxBlocks: 4, maxChars: 4_000, visibleOnly: true });
    expect(batch.blocks.map(({ text }) => text)).toEqual([
      'First paragraph',
      'Second paragraph',
      'Third paragraph',
    ]);
    fixture.cleanup();
  });

  test('prefetches in the reading direction before filling the behind buffer', () => {
    const downward = createFixture();
    downward.scrollRoot.scrollTop = 20;
    downward.scrollRoot.dispatchEvent(new downward.window.Event('scroll'));
    downward.adapter.setEnabled(true);
    const downwardVisible = downward.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    downward.adapter.apply(downwardVisible.blocks.map(({ id }) => ({ id, translation: 'Current translation' })));
    const downwardPrefetch = downward.adapter.nextBatch({ maxBlocks: 1, maxChars: 4_000 });
    expect(downwardPrefetch.priority).toBe(1);
    expect(downwardPrefetch.blocks.map(({ text }) => text)).toEqual(['Upcoming paragraph']);

    const upward = createFixture();
    upward.scrollRoot.scrollTop = 20;
    upward.scrollRoot.dispatchEvent(new upward.window.Event('scroll'));
    upward.scrollRoot.scrollTop = 0;
    upward.scrollRoot.dispatchEvent(new upward.window.Event('scroll'));
    upward.adapter.setEnabled(true);
    const upwardVisible = upward.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    upward.adapter.apply(upwardVisible.blocks.map(({ id }) => ({ id, translation: 'Current translation' })));
    const upwardPrefetch = upward.adapter.nextBatch({ maxBlocks: 1, maxChars: 4_000 });
    expect(upwardPrefetch.priority).toBe(1);
    expect(upwardPrefetch.blocks.map(({ text }) => text)).toEqual(['Earlier paragraph']);

    downward.cleanup();
    upward.cleanup();
  });

  test('removes stale loaders before discovering a changed source record', async () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const batch = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    const source = fixture.chapter.getElementById('current');
    if (!source?.firstChild) throw new Error('Missing source text node');
    source.firstChild.nodeValue = 'Updated paragraph';

    expect(fixture.adapter.apply(batch.blocks.map(({ id }) => ({ id, translation: 'Stale translation' }))))
      .toBe(0);
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status]')).toBeNull();
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation]')).toBeNull();

    await Promise.resolve();
    const refreshed = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    expect(refreshed.blocks.map(({ text }) => text)).toEqual(['Updated paragraph']);
    fixture.cleanup();
  });

  test('drops obsolete failure state when the source text changes', async () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const batch = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.fail(batch.blocks.map(({ id }) => id));
    const source = fixture.chapter.getElementById('current');
    if (!source?.firstChild) throw new Error('Missing source text node');
    source.firstChild.nodeValue = 'Updated after failure';

    await Promise.resolve();
    expect(fixture.adapter.failedRecordIds()).toEqual([]);
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status]')).toBeNull();
    fixture.cleanup();
  });

  test('keeps stable translations across lazy section unload and remount', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const batch = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.apply(batch.blocks.map(({ id }) => ({ id, translation: 'Cached translation' })));

    fixture.adapter.unregisterSection(0);
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation]')).toBeNull();

    const replacement = chapterDocument();
    setChapterRects(replacement.document, fixture);
    const replacementFrame = fixture.makeFrame(replacement.document);
    fixture.adapter.registerSection(0, replacementFrame);
    expect(replacement.document.querySelector('[data-tenon-epub-translation]')?.textContent)
      .toBe('Cached translation');
    expect(fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true }).blocks).toEqual([]);
    fixture.cleanup();
  });

  test('discards unverifiable responses while a section is unmounted', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const batch = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.unregisterSection(0);

    expect(fixture.adapter.apply(batch.blocks.map(({ id }) => ({ id, translation: 'Late translation' }))))
      .toBe(0);
    const firstReplacement = chapterDocument();
    setChapterRects(firstReplacement.document, fixture);
    fixture.adapter.registerSection(0, fixture.makeFrame(firstReplacement.document));
    const retriedAfterSuccess = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    expect(retriedAfterSuccess.blocks).toEqual(batch.blocks);

    fixture.adapter.unregisterSection(0);
    expect(fixture.adapter.fail(retriedAfterSuccess.blocks.map(({ id }) => id))).toEqual([]);
    expect(fixture.adapter.failedRecordIds()).toEqual([]);
    const secondReplacement = chapterDocument();
    setChapterRects(secondReplacement.document, fixture);
    fixture.adapter.registerSection(0, fixture.makeFrame(secondReplacement.document));
    expect(fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true }).blocks)
      .toEqual(batch.blocks);
    fixture.cleanup();
  });

  test('turns a failed loader into a local retry without resubmitting unrelated blocks', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const batch = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.fail(batch.blocks.map(({ id }) => id));
    const retry = fixture.chapter.querySelector<HTMLButtonElement>('[data-tenon-epub-translation-status="error"]');
    expect(retry?.getAttribute('aria-label')).toBe('Retry translation');
    let bubbledClicks = 0;
    retry?.parentElement?.addEventListener('click', () => { bubbledClicks += 1; });

    retry?.click();
    expect(bubbledClicks).toBe(0);
    expect(retry?.getAttribute('data-tenon-epub-translation-status')).toBe('loading');
    fixture.layoutShift.value = 5_000;
    const retried = fixture.adapter.nextBatch({
      maxBlocks: 4,
      maxChars: 4_000,
      retryOnly: true,
    });
    expect(retried.blocks).toEqual(batch.blocks);
    expect(fixture.adapter.failedRecordIds()).toEqual(batch.blocks.map(({ id }) => id));
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status="loading"]')).not.toBeNull();
    fixture.adapter.apply(retried.blocks.map(({ id }) => ({ id, translation: 'Recovered translation' })));
    expect(fixture.adapter.failedRecordIds()).toEqual([]);
    fixture.cleanup();
  });

  test('returns a released failed EPUB block to normal scheduling', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const first = fixture.adapter.nextBatch({ maxBlocks: 1, maxChars: 2_000, visibleOnly: true });
    const id = first.blocks[0]?.id;
    if (!id) throw new Error('Missing EPUB block');
    fixture.adapter.fail([id]);

    fixture.adapter.release([id]);

    expect(fixture.adapter.failedRecordIds()).toEqual([]);
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status]')).toBeNull();
    expect(fixture.adapter.nextBatch({ maxBlocks: 1, maxChars: 2_000, visibleOnly: true }).blocks[0]?.id)
      .toBe(id);
    fixture.cleanup();
  });

  test('updates live status labels without rebuilding the section adapter', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const batch = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.setLabels({ retry: 'Retry updated', translating: 'Translating updated' });
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status="loading"]')?.getAttribute('aria-label'))
      .toBe('Translating updated');

    fixture.adapter.fail(batch.blocks.map(({ id }) => id));
    expect(fixture.chapter.querySelector('[data-tenon-epub-translation-status="error"]')?.getAttribute('aria-label'))
      .toBe('Retry updated');
    fixture.cleanup();
  });

  test('compensates translation growth but never reverses a user scroll', () => {
    const fixture = createFixture();
    fixture.adapter.setEnabled(true);
    const current = fixture.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    fixture.adapter.apply(current.blocks.map(({ id }) => ({ id, translation: 'Current translation' })));
    fixture.flushAnimationFrames();

    const above = fixture.adapter.nextBatch({ maxBlocks: 1, maxChars: 4_000 });
    expect(above.blocks.map(({ text }) => text)).toEqual(['Earlier paragraph']);
    fixture.adapter.apply(above.blocks.map(({ id }) => ({ id, translation: 'Earlier translation' })));
    fixture.flushAnimationFrames();
    expect(fixture.scrollRoot.scrollTop).toBe(30);

    const second = createFixture();
    second.adapter.setEnabled(true);
    const secondCurrent = second.adapter.nextBatch({ maxBlocks: 2, maxChars: 2_000, visibleOnly: true });
    second.adapter.apply(secondCurrent.blocks.map(({ id }) => ({ id, translation: 'Current translation' })));
    second.flushAnimationFrames();
    const secondAbove = second.adapter.nextBatch({ maxBlocks: 1, maxChars: 4_000 });
    second.adapter.apply(secondAbove.blocks.map(({ id }) => ({ id, translation: 'Earlier translation' })));
    second.scrollRoot.scrollTop = 100;
    second.scrollRoot.dispatchEvent(new second.window.Event('scroll'));
    second.flushAnimationFrames();
    expect(second.scrollRoot.scrollTop).toBe(100);

    fixture.cleanup();
    second.cleanup();
  });

  test('keeps loader geometry fixed across EPUB typography', () => {
    expect(cssRuleBody(EPUB_TRANSLATION_CSS, '[data-tenon-epub-translation-status]'))
      .toContain('width: 16px !important;');
    expect(cssRuleBody(EPUB_TRANSLATION_CSS, '[data-tenon-epub-translation-status]'))
      .toContain('height: 16px !important;');
    expect(cssRuleBody(
      EPUB_TRANSLATION_CSS,
      '[data-tenon-epub-translation-status="loading"]::before',
    )).toContain('width: 10px !important;');
  });

  test('routes the scoped shortcut while focus is inside a section document', () => {
    const fixture = createFixture();
    let toggles = 0;
    fixture.adapter.setShortcutHandler(() => {
      toggles += 1;
      return true;
    });
    const event = new fixture.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      altKey: { value: true },
      code: { value: 'KeyA' },
      ctrlKey: { value: false },
      key: { value: 'a' },
      metaKey: { value: false },
      repeat: { value: false },
      shiftKey: { value: false },
    });
    fixture.chapter.dispatchEvent(event);
    expect(toggles).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    fixture.cleanup();
  });
});

interface Fixture {
  adapter: EpubTranslationDomAdapter;
  chapter: Document;
  cleanup: () => void;
  flushAnimationFrames: () => void;
  layoutShift: { value: number };
  makeFrame: (document: Document) => HTMLIFrameElement;
  scrollRoot: HTMLElement;
  window: Window;
}

function createFixture(
  chapter = chapterDocument(),
  configureRects: (document: Document, fixture: Pick<Fixture, 'layoutShift'>) => void = setChapterRects,
): Fixture {
  const host = parseHTML('<!doctype html><html><body><div id="scroll-root"></div></body></html>');
  const scrollRoot = host.document.getElementById('scroll-root');
  if (!scrollRoot) throw new Error('Missing EPUB scroll root');
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrame = 1;
  Object.defineProperties(host.window, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        const id = nextAnimationFrame++;
        animationFrames.set(id, callback);
        return id;
      },
    },
    cancelAnimationFrame: {
      configurable: true,
      value: (id: number) => animationFrames.delete(id),
    },
  });
  Object.defineProperty(scrollRoot, 'scrollTop', { configurable: true, value: 0, writable: true });
  scrollRoot.getBoundingClientRect = () => rect(0, 600);
  const layoutShift = { value: 0 };
  const fixture = {
    adapter: null as unknown as EpubTranslationDomAdapter,
    chapter: chapter.document,
    cleanup: () => undefined,
    flushAnimationFrames: () => {
      while (animationFrames.size > 0) {
        const callbacks = [...animationFrames.values()];
        animationFrames.clear();
        callbacks.forEach((callback) => callback(0));
      }
    },
    layoutShift,
    makeFrame: (document: Document) => makeFrame(host.document, scrollRoot, document),
    scrollRoot,
    window: host.window as unknown as Window,
  } satisfies Fixture;
  configureRects(chapter.document, fixture);
  const frame = fixture.makeFrame(chapter.document);
  const adapter = new EpubTranslationDomAdapter({
    bookLanguages: ['en'],
    labels: LABELS,
    onShortcut: () => false,
    scrollRoot,
  });
  fixture.adapter = adapter;
  adapter.reset('zh-Hans');
  adapter.registerSection(0, frame);
  fixture.cleanup = () => adapter.destroy();
  return fixture;
}

function chapterDocument() {
  return chapterDocumentFromMarkup(`
    <p id="above">Earlier paragraph</p>
    <p id="current">Current paragraph</p>
    <p id="ahead">Upcoming paragraph</p>
    <p id="far">Far paragraph</p>
    <p id="same-language" lang="zh-Hans">Already translated</p>
    <pre><code id="code">const secret = 1</code></pre>
  `);
}

function chapterDocumentFromMarkup(markup: string) {
  const parsed = parseHTML(`<!doctype html><html lang="en"><head></head><body><main>${markup}</main></body></html>`);
  Object.defineProperties(parsed.window, {
    NodeFilter: {
      configurable: true,
      value: { FILTER_ACCEPT: 1, FILTER_REJECT: 2, SHOW_TEXT: 4 },
    },
    getComputedStyle: {
      configurable: true,
      value: (element: HTMLElement) => ({
        contentVisibility: element.style.contentVisibility || 'visible',
        display: element.style.display || 'block',
        visibility: element.style.visibility || 'visible',
      }),
    },
  });
  return parsed;
}

function setChapterRects(document: Document, fixture: Pick<Fixture, 'layoutShift'>): void {
  setRect(document, 'above', () => rect(-80, -20));
  setRect(document, 'current', () => {
    const shifted = document.querySelector('#above + [data-tenon-epub-translation]') ? 30 : 0;
    return rect(100 + shifted + fixture.layoutShift.value, 140 + shifted + fixture.layoutShift.value);
  });
  setRect(document, 'ahead', () => rect(800, 840));
  setRect(document, 'far', () => rect(2_000, 2_040));
  setRect(document, 'same-language', () => rect(200, 240));
}

function makeFrame(
  hostDocument: Document,
  scrollRoot: HTMLElement,
  contentDocument: Document,
): HTMLIFrameElement {
  const frame = hostDocument.createElement('iframe');
  scrollRoot.append(frame);
  Object.defineProperty(frame, 'contentDocument', { configurable: true, value: contentDocument });
  frame.getBoundingClientRect = () => rect(-scrollRoot.scrollTop, 2_200 - scrollRoot.scrollTop);
  return frame as HTMLIFrameElement;
}

function setRect(document: Document, id: string, read: () => DOMRect): void {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing fixture element: ${id}`);
  element.getBoundingClientRect = read;
}

function rect(top: number, bottom: number): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 500,
    top,
    width: 500,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function cssRuleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'u'));
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}
