import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  createUrlPageTranslationGuestBridge,
  URL_PAGE_TRANSLATION_GUEST_CSS,
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
  installUrlPageTranslationRuntime,
  type UrlPageTranslationGuestActiveBatch,
  type UrlPageTranslationGuestBatch,
  type UrlPageTranslationGuestLabels,
} from '../../src/renderer/ui/preview/urlPageTranslationGuest';
import type { UrlPageTranslationItem } from '../../src/core/urlPageTranslation';
import type { TranslationLanguage } from '../../src/core/translationLanguage';

const TEST_LABELS: UrlPageTranslationGuestLabels = {
  retry: 'Retry translation',
  translating: 'Translating',
};
const MAX_BLOCKS = 4;
const MAX_CHARS = 4_000;
const MAX_BLOCK_CHARS = 6_000;

interface GuestRuntime {
  version: 1;
  setEnabled(enabled: boolean, targetLanguage: TranslationLanguage): void;
  nextBatch(
    maxBlocks: number,
    maxChars: number,
    maxBlockChars: number,
    retryOnly?: boolean,
    visibleOnly?: boolean,
    activeBatches?: readonly UrlPageTranslationGuestActiveBatch[],
  ): UrlPageTranslationGuestBatch;
  release(ids: readonly string[]): void;
  apply(items: readonly UrlPageTranslationItem[]): number;
  fail(ids: readonly string[]): void;
  destroy(): void;
}

describe('URL page translation guest runtime', () => {
  test('keeps inline loading controls the same size across page typography', () => {
    const translationRule = cssRuleBody(
      URL_PAGE_TRANSLATION_GUEST_CSS,
      '[data-tenon-bilingual-translation="true"]',
    );
    const statusRule = cssRuleBody(URL_PAGE_TRANSLATION_GUEST_CSS, '[data-tenon-bilingual-status]');
    const loaderRule = cssRuleBody(
      URL_PAGE_TRANSLATION_GUEST_CSS,
      '[data-tenon-bilingual-status="loading"]::before',
    );

    expect(statusRule).toContain('width: 16px !important;');
    expect(statusRule).toContain('height: 16px !important;');
    expect(loaderRule).toContain('width: 10px !important;');
    expect(loaderRule).toContain('height: 10px !important;');
    expect(statusRule).not.toContain('width: max(1em, 16px)');
    expect(loaderRule).not.toContain('width: 0.72em');
    expect(translationRule).toContain('overflow-anchor: none !important;');
    expect(statusRule).toContain('overflow-anchor: none !important;');
  });

  test('collects only visible and nearby readable blocks and excludes sensitive regions', () => {
    const fixture = createFixture();
    const runtime = fixture.runtime;
    runtime.setEnabled(true, 'zh-Hans');

    const visibleBatch = nextBatch(runtime);
    const visibleTexts = visibleBatch.blocks.map((block) => block.text);

    expect(visibleBatch.priority).toBe(0);
    expect(visibleTexts).toContain('Above the viewport');
    expect(visibleTexts).toContain('Current paragraph');
    expect(visibleTexts).not.toContain('Prefetched paragraph');
    runtime.apply(visibleBatch.blocks.map((block) => ({
      id: block.id,
      translation: `Translated: ${block.text}`,
    })));

    const prefetchBatch = nextBatch(runtime);
    const texts = [...visibleTexts, ...prefetchBatch.blocks.map((block) => block.text)];
    expect(prefetchBatch.priority).toBe(1);
    expect(texts).toContain('Prefetched paragraph');
    expect(texts).toContain('Recently passed paragraph');
    expect(texts).not.toContain('Far away paragraph');
    expect(texts).not.toContain('Do not upload this draft');
    expect(texts).not.toContain('const secret = 1');
    expect(texts).not.toContain('Password label');
    expect(texts).not.toContain('Already translated content');
    expect(fixture.document.querySelector('#target-language [data-tenon-bilingual-status]')).toBeNull();
    expect(fixture.document.querySelectorAll('[data-tenon-bilingual-status="loading"]').length)
      .toBe(prefetchBatch.blocks.length);
  });

  test('skips blocks whose nearest declared language matches the selected target', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'en');

    const texts = nextBatch(fixture.runtime).blocks.map((block) => block.text);
    expect(texts).toEqual(['Already translated content']);
    expect(fixture.document.querySelector('#current [data-tenon-bilingual-status]')).toBeNull();
  });

  test('keeps a second prefetch batch out when the controller requests visible-only work', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const visible = nextBatch(fixture.runtime);
    fixture.runtime.apply(visible.blocks.map((block) => ({
      id: block.id,
      translation: `Translated: ${block.text}`,
    })));

    expect(nextBatch(fixture.runtime, { visibleOnly: true }).blocks).toEqual([]);
    expect(nextBatch(fixture.runtime).priority).toBe(1);
  });

  test('returns newly visible earlier blocks while a downward request is still pending', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    fixture.setScrollY(800);

    const downwardBatch = nextBatch(fixture.runtime, { maxBlocks: 1 });
    expect(downwardBatch.blocks.map((block) => block.text)).toEqual(['Prefetched paragraph']);

    fixture.setScrollY(0);
    const upwardBatch = nextBatch(fixture.runtime, {
      activeBatches: [{
        ids: downwardBatch.blocks.map((block) => block.id),
        requestId: 'request:downward',
      }],
    });

    expect(upwardBatch.preemptRequestId).toBe('request:downward');
    expect(upwardBatch.priority).toBe(0);
    expect(upwardBatch.blocks.map((block) => block.text)).toContain('Current paragraph');
    fixture.runtime.release(downwardBatch.blocks.map((block) => block.id));
    expect(fixture.document.querySelector('#ahead [data-tenon-bilingual-status]')).toBeNull();
  });

  test('runs from its serialized function body without renderer closures', () => {
    const fixture = createFixture({ serialized: true });
    fixture.runtime.setEnabled(true, 'zh-Hans');

    expect(nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks).toHaveLength(1);
  });

  test('routes runtime commands through the isolated guest executor and keeps exact batch bounds', async () => {
    const commands: string[] = [];
    let mainWorldExecutions = 0;
    const webview = {
      executeJavaScript: async () => {
        mainWorldExecutions += 1;
        return null;
      },
      getWebContentsId: () => 71,
      insertCSS: async () => 'css-key',
      removeInsertedCSS: async () => undefined,
    } as unknown as Electron.WebviewTag;
    const bridge = createUrlPageTranslationGuestBridge(webview, async (command) => {
      commands.push(command.operation);
      if (command.operation === 'next-batch') {
        return {
          blocks: [
            { id: 'b1', text: 'One' },
            { id: 'b2', text: 'Two' },
            { id: 'b3', text: 'Three' },
          ],
          priority: 0,
        };
      }
      if (command.operation === 'apply') return 1;
      return null;
    });

    await bridge.initialize('zh-Hans', TEST_LABELS);
    await bridge.setEnabled(true, 'zh-Hans');
    const batch = await bridge.nextBatch({ maxBlocks: 2, maxChars: 6 });
    expect(await bridge.apply([{ id: 'b1', translation: '一' }])).toBe(1);
    await bridge.destroy();

    expect(batch.blocks).toEqual([
      { id: 'b1', text: 'One' },
      { id: 'b2', text: 'Two' },
    ]);
    expect(commands).toEqual(['initialize', 'set-enabled', 'next-batch', 'apply', 'destroy']);
    expect(mainWorldExecutions).toBe(0);
  });

  test('inserts model output with textContent and preserves the current reading anchor', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = nextBatch(fixture.runtime, { maxBlocks: 1 });
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
    expect(fixture.scrollBehaviors).toEqual(['instant']);

    fixture.shiftCurrentAnchor(12);
    fixture.flushAnimationFrame();
    expect(fixture.scrollDeltas).toEqual([30, 12]);
    expect(fixture.scrollBehaviors).toEqual(['instant', 'instant']);
    fixture.flushAnimationFrame();
    expect(fixture.scrollDeltas).toEqual([30, 12]);

    fixture.runtime.setEnabled(false, 'zh-Hans');
    expect(fixture.document.documentElement.getAttribute('data-tenon-bilingual-hidden')).toBe('true');
    expect(fixture.scrollDeltas).toEqual([30, 12, -30]);

    fixture.runtime.setEnabled(true, 'zh-Hans');
    expect(fixture.document.documentElement.hasAttribute('data-tenon-bilingual-hidden')).toBe(false);
    expect(fixture.scrollDeltas).toEqual([30, 12, -30, 30]);
  });

  test('reports zero insertions when model output is unchanged source text', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    if (!block) throw new Error('Missing block');

    expect(fixture.runtime.apply([{ id: block.id, translation: block.text }])).toBe(0);
    expect(fixture.document.querySelector('[data-tenon-bilingual-translation="true"]')).toBeNull();
    expect(fixture.document.querySelector('[data-tenon-bilingual-status]')).toBeNull();
  });

  test('does not let a stale response attach to changed source text', async () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const oldBlock = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    if (!oldBlock) throw new Error('Missing old block');
    const source = fixture.document.getElementById('above');
    const textNode = source?.firstChild;
    if (!textNode) throw new Error('Missing source text node');
    textNode.textContent = 'Changed source text';
    await Promise.resolve();

    const newBlock = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    expect(newBlock?.text).toBe('Changed source text');
    expect(newBlock?.id).not.toBe(oldBlock.id);
    expect(fixture.runtime.apply([{ id: oldBlock.id, translation: 'STALE TRANSLATION' }])).toBe(0);
    expect(source.querySelector('[data-tenon-bilingual-translation="true"]')).toBeNull();
    expect(source.querySelector('[data-tenon-bilingual-status="loading"]')).not.toBeNull();
  });

  test('does not undo user scrolling from a deferred anchor correction', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    if (!block) throw new Error('Missing block');
    fixture.runtime.apply([{ id: block.id, translation: 'Translated above viewport' }]);
    expect(fixture.scrollDeltas).toEqual([30]);

    const EventCtor = (fixture.window as unknown as { Event: typeof Event }).Event;
    fixture.window.dispatchEvent(new EventCtor('wheel'));
    fixture.setScrollY(130);
    fixture.flushAnimationFrame();
    fixture.flushAnimationFrame();

    expect(fixture.scrollDeltas).toEqual([30]);
  });

  test('prevents a replaced runtime from applying stale frame corrections', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = nextBatch(fixture.runtime, { maxBlocks: 1 });
    const above = batch.blocks.find((block) => block.text === 'Above the viewport');
    if (!above) throw new Error('Missing above-viewport block');
    fixture.runtime.apply([{ id: above.id, translation: 'Translated above viewport' }]);
    expect(fixture.scrollDeltas).toEqual([30]);

    installUrlPageTranslationRuntime(
      fixture.window,
      URL_PAGE_TRANSLATION_RUNTIME_KEY,
      'zh-Hans',
      TEST_LABELS,
    );
    expect(fixture.scrollDeltas).toEqual([30, -30]);

    fixture.shiftCurrentAnchor(12);
    fixture.flushAnimationFrame();
    fixture.flushAnimationFrame();
    expect(fixture.scrollDeltas).toEqual([30, -30]);
  });

  test('changes a failed loader into a retry control and retries only after it is clicked', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const first = nextBatch(fixture.runtime, { maxBlocks: 1 });
    expect(first.blocks).toHaveLength(1);
    const loading = fixture.document.querySelector<HTMLButtonElement>('[data-tenon-bilingual-status="loading"]');
    expect(loading?.disabled).toBe(true);
    expect(loading?.getAttribute('aria-label')).toBe('Translating');

    fixture.runtime.fail(first.blocks.map((block) => block.id));
    const retry = fixture.document.querySelector<HTMLButtonElement>('[data-tenon-bilingual-status="error"]');
    expect(retry?.disabled).toBe(false);
    expect(retry?.getAttribute('aria-label')).toBe('Retry translation');
    expect(nextBatch(fixture.runtime, { maxBlocks: 1, retryOnly: true }).blocks).toEqual([]);

    retry?.click();

    expect(retry?.getAttribute('data-tenon-bilingual-status')).toBe('loading');
    const retried = nextBatch(fixture.runtime, { maxBlocks: 1, retryOnly: true });
    expect(retried.blocks[0]?.id).toBe(first.blocks[0]?.id);
  });

  test('removes transient status controls when translation is disabled', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    if (!block) throw new Error('Missing block');
    fixture.runtime.fail([block.id]);

    fixture.runtime.setEnabled(false, 'zh-Hans');

    expect(fixture.document.querySelector('[data-tenon-bilingual-status]')).toBeNull();
  });

  test('removes injected state when the preview is destroyed', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    if (!block) throw new Error('Missing block');
    fixture.runtime.apply([{ id: block.id, translation: '译文' }]);

    fixture.runtime.destroy();

    expect(fixture.document.querySelector('[data-tenon-bilingual-translation="true"]')).toBeNull();
    expect((fixture.window as unknown as Record<string, unknown>)[URL_PAGE_TRANSLATION_RUNTIME_KEY]).toBeUndefined();
  });
});

function nextBatch(
  runtime: GuestRuntime,
  options: {
    activeBatches?: readonly UrlPageTranslationGuestActiveBatch[];
    maxBlocks?: number;
    retryOnly?: boolean;
    visibleOnly?: boolean;
  } = {},
): UrlPageTranslationGuestBatch {
  return runtime.nextBatch(
    options.maxBlocks ?? MAX_BLOCKS,
    MAX_CHARS,
    MAX_BLOCK_CHARS,
    options.retryOnly ?? false,
    options.visibleOnly ?? false,
    options.activeBatches ?? [],
  );
}

function cssRuleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'u'));
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

function createFixture(options: { serialized?: boolean } = {}): {
  document: Document;
  flushAnimationFrame: () => void;
  runtime: GuestRuntime;
  scrollBehaviors: ScrollBehavior[];
  scrollDeltas: number[];
  setScrollY: (value: number) => void;
  shiftCurrentAnchor: (delta: number) => void;
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
  // Linkedom window globals can survive across parsed documents in one test file.
  testWindow[URL_PAGE_TRANSLATION_RUNTIME_KEY] = undefined;
  const animationFrames: FrameRequestCallback[] = [];
  let currentAnchorShift = 0;
  Object.defineProperties(testWindow, {
    innerHeight: { configurable: true, value: 600 },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
    },
    scrollY: { configurable: true, value: 0, writable: true },
  });
  testWindow.NodeFilter = { SHOW_TEXT: 4 } as unknown as typeof NodeFilter;
  testWindow.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
  }) as CSSStyleDeclaration;

  const translationVisible = () => !document.documentElement.hasAttribute('data-tenon-bilingual-hidden');
  setRect(document, 'behind', () => rect(-200 - testWindow.scrollY, -150 - testWindow.scrollY));
  setRect(document, 'above', () => rect(-20 - testWindow.scrollY, 20 - testWindow.scrollY));
  setRect(document, 'current', () => {
    const translatedAbove = Boolean(document.querySelector('#above [data-tenon-bilingual-translation="true"]'));
    const top = 100
      + (translatedAbove && translationVisible() ? 30 : 0)
      + currentAnchorShift
      - testWindow.scrollY;
    return rect(top, top + 40);
  });
  setRect(document, 'ahead', () => rect(800 - testWindow.scrollY, 850 - testWindow.scrollY));
  setRect(document, 'far', () => rect(1_900 - testWindow.scrollY, 1_950 - testWindow.scrollY));
  setRect(document, 'form', () => rect(200 - testWindow.scrollY, 240 - testWindow.scrollY));
  setRect(document, 'editable', () => rect(260 - testWindow.scrollY, 300 - testWindow.scrollY));
  setRect(document, 'target-language', () => rect(320 - testWindow.scrollY, 360 - testWindow.scrollY));

  const scrollDeltas: number[] = [];
  const scrollBehaviors: ScrollBehavior[] = [];
  testWindow.scrollBy = ((optionsOrX: number | ScrollToOptions, y?: number) => {
    const delta = typeof optionsOrX === 'number' ? (y ?? 0) : (optionsOrX.top ?? 0);
    scrollDeltas.push(delta);
    if (typeof optionsOrX !== 'number' && optionsOrX.behavior) {
      scrollBehaviors.push(optionsOrX.behavior);
    }
    testWindow.scrollY += delta;
  }) as typeof testWindow.scrollBy;
  const flushAnimationFrame = () => {
    const callbacks = animationFrames.splice(0);
    for (const callback of callbacks) callback(0);
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
  return {
    document,
    flushAnimationFrame,
    runtime,
    scrollBehaviors,
    scrollDeltas,
    setScrollY: (value) => {
      testWindow.scrollY = value;
    },
    shiftCurrentAnchor: (delta) => {
      currentAnchorShift += delta;
    },
    window: testWindow,
  };
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
