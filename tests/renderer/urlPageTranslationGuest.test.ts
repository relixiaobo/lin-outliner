import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
  installUrlPageTranslationRuntime,
  type UrlPageTranslationGuestBatch,
  type UrlPageTranslationGuestLabels,
} from '../../src/renderer/ui/preview/urlPageTranslationGuest';
import type { UrlPageTranslationItem } from '../../src/core/urlPageTranslation';
import type { TranslationLanguage } from '../../src/core/translationLanguage';

const TEST_LABELS: UrlPageTranslationGuestLabels = {
  retry: 'Retry translation',
  translating: 'Translating',
};

interface GuestRuntime {
  version: 1;
  setEnabled(enabled: boolean, targetLanguage: TranslationLanguage): void;
  nextBatch(
    maxBlocks: number,
    maxChars: number,
    maxBlockChars: number,
    retryOnly?: boolean,
  ): UrlPageTranslationGuestBatch;
  apply(items: readonly UrlPageTranslationItem[]): void;
  fail(ids: readonly string[]): void;
  destroy(): void;
}

describe('URL page translation guest runtime', () => {
  test('collects only visible and nearby readable blocks and excludes sensitive regions', () => {
    const fixture = createFixture();
    const runtime = fixture.runtime;
    runtime.setEnabled(true, 'zh-Hans');

    const batch = runtime.nextBatch(12, 12_000, 6_000);
    const texts = batch.blocks.map((block) => block.text);

    expect(batch.priority).toBe(0);
    expect(texts).toContain('Above the viewport');
    expect(texts).toContain('Current paragraph');
    expect(texts).toContain('Prefetched paragraph');
    expect(texts).toContain('Recently passed paragraph');
    expect(texts).not.toContain('Far away paragraph');
    expect(texts).not.toContain('Do not upload this draft');
    expect(texts).not.toContain('const secret = 1');
    expect(texts).not.toContain('Password label');
    expect(texts).not.toContain('Already translated content');
    expect(fixture.document.querySelector('#target-language [data-tenon-bilingual-status]')).toBeNull();
    expect(fixture.document.querySelectorAll('[data-tenon-bilingual-status="loading"]').length)
      .toBe(batch.blocks.length);
  });

  test('skips blocks whose nearest declared language matches the selected target', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'en');

    const texts = fixture.runtime.nextBatch(12, 12_000, 6_000).blocks.map((block) => block.text);
    expect(texts).toEqual(['Already translated content']);
    expect(fixture.document.querySelector('#current [data-tenon-bilingual-status]')).toBeNull();
  });

  test('runs from its serialized function body without renderer closures', () => {
    const fixture = createFixture({ serialized: true });
    fixture.runtime.setEnabled(true, 'zh-Hans');

    expect(fixture.runtime.nextBatch(1, 12_000, 6_000).blocks).toHaveLength(1);
  });

  test('inserts model output with textContent and preserves the current reading anchor', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = fixture.runtime.nextBatch(1, 12_000, 6_000);
    const above = batch.blocks.find((block) => block.text === 'Above the viewport');
    if (!above) throw new Error('Missing above-viewport block');

    fixture.runtime.apply([{
      id: above.id,
      translation: '<img src=x onerror=alert(1)> 视口上方',
    }]);

    const translation = fixture.document.querySelector<HTMLElement>('[data-tenon-bilingual-translation="true"]');
    expect(translation?.textContent).toBe('<img src=x onerror=alert(1)> 视口上方');
    expect(translation?.querySelector('img')).toBeNull();
    expect(translation?.getAttribute('lang')).toBe('zh-Hans');
    expect(fixture.document.querySelector('[data-tenon-bilingual-status]')).toBeNull();
    expect(fixture.scrollDeltas).toEqual([30]);

    fixture.runtime.setEnabled(false, 'zh-Hans');
    expect(fixture.document.documentElement.getAttribute('data-tenon-bilingual-hidden')).toBe('true');
    expect(fixture.scrollDeltas).toEqual([30, -30]);

    fixture.runtime.setEnabled(true, 'zh-Hans');
    expect(fixture.document.documentElement.hasAttribute('data-tenon-bilingual-hidden')).toBe(false);
    expect(fixture.scrollDeltas).toEqual([30, -30, 30]);
  });

  test('changes a failed loader into a retry control and retries only after it is clicked', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const first = fixture.runtime.nextBatch(1, 12_000, 6_000);
    expect(first.blocks).toHaveLength(1);
    const loading = fixture.document.querySelector<HTMLButtonElement>('[data-tenon-bilingual-status="loading"]');
    expect(loading?.disabled).toBe(true);
    expect(loading?.getAttribute('aria-label')).toBe('Translating');

    fixture.runtime.fail(first.blocks.map((block) => block.id));
    const retry = fixture.document.querySelector<HTMLButtonElement>('[data-tenon-bilingual-status="error"]');
    expect(retry?.disabled).toBe(false);
    expect(retry?.getAttribute('aria-label')).toBe('Retry translation');
    expect(fixture.runtime.nextBatch(1, 12_000, 6_000, true).blocks).toEqual([]);

    retry?.click();

    expect(retry?.getAttribute('data-tenon-bilingual-status')).toBe('loading');
    const retried = fixture.runtime.nextBatch(1, 12_000, 6_000, true);
    expect(retried.blocks[0]?.id).toBe(first.blocks[0]?.id);
  });

  test('removes transient status controls when translation is disabled', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = fixture.runtime.nextBatch(1, 12_000, 6_000).blocks[0];
    if (!block) throw new Error('Missing block');
    fixture.runtime.fail([block.id]);

    fixture.runtime.setEnabled(false, 'zh-Hans');

    expect(fixture.document.querySelector('[data-tenon-bilingual-status]')).toBeNull();
  });

  test('removes injected state when the preview is destroyed', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = fixture.runtime.nextBatch(1, 12_000, 6_000).blocks[0];
    if (!block) throw new Error('Missing block');
    fixture.runtime.apply([{ id: block.id, translation: '译文' }]);

    fixture.runtime.destroy();

    expect(fixture.document.querySelector('[data-tenon-bilingual-translation="true"]')).toBeNull();
    expect((fixture.window as unknown as Record<string, unknown>)[URL_PAGE_TRANSLATION_RUNTIME_KEY]).toBeUndefined();
  });
});

function createFixture(options: { serialized?: boolean } = {}): {
  document: Document;
  runtime: GuestRuntime;
  scrollDeltas: number[];
  window: Window;
} {
  const { document, window } = parseHTML(`<!doctype html><html lang="en"><body><main>
    <p id="behind">Recently passed paragraph</p>
    <p id="above">Above the viewport</p>
    <p id="current">Current paragraph</p>
    <p id="ahead">Prefetched paragraph</p>
    <p id="far">Far away paragraph</p>
    <form><p id="form">Password label</p><input value="secret"></form>
    <pre><code>const secret = 1</code></pre>
    <div contenteditable="true"><p id="editable">Do not upload this draft</p></div>
    <p id="target-language" lang="zh-Hans">Already translated content</p>
  </main></body></html>`);
  const testWindow = window as unknown as Window & Record<string, unknown>;
  Object.defineProperties(testWindow, {
    innerHeight: { configurable: true, value: 600 },
    scrollY: { configurable: true, value: 0, writable: true },
  });
  testWindow.NodeFilter = { SHOW_TEXT: 4 } as unknown as typeof NodeFilter;
  testWindow.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
  }) as CSSStyleDeclaration;

  const translationVisible = () => !document.documentElement.hasAttribute('data-tenon-bilingual-hidden');
  setRect(document, 'behind', () => rect(-200, -150));
  setRect(document, 'above', () => rect(-20, 20));
  setRect(document, 'current', () => {
    const translatedAbove = Boolean(document.querySelector('#above [data-tenon-bilingual-translation="true"]'));
    const top = 100 + (translatedAbove && translationVisible() ? 30 : 0);
    return rect(top, top + 40);
  });
  setRect(document, 'ahead', () => rect(800, 850));
  setRect(document, 'far', () => rect(1_900, 1_950));
  setRect(document, 'form', () => rect(200, 240));
  setRect(document, 'editable', () => rect(260, 300));
  setRect(document, 'target-language', () => rect(320, 360));

  const scrollDeltas: number[] = [];
  testWindow.scrollBy = (_x: number, y: number) => {
    scrollDeltas.push(y);
  };
  if (options.serialized) {
    const install = new Function(
      'host',
      'runtimeKey',
      'targetLanguage',
      'labels',
      `return (${installUrlPageTranslationRuntime.toString()})(host, runtimeKey, targetLanguage, labels);`,
    ) as (
      host: Window,
      runtimeKey: string,
      targetLanguage: TranslationLanguage,
      labels: UrlPageTranslationGuestLabels,
    ) => void;
    install(testWindow, URL_PAGE_TRANSLATION_RUNTIME_KEY, 'zh-Hans', TEST_LABELS);
  } else {
    installUrlPageTranslationRuntime(testWindow, URL_PAGE_TRANSLATION_RUNTIME_KEY, 'zh-Hans', TEST_LABELS);
  }
  const runtime = testWindow[URL_PAGE_TRANSLATION_RUNTIME_KEY] as GuestRuntime;
  return { document, runtime, scrollDeltas, window: testWindow };
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
