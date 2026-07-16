import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  createUrlPageTranslationGuestBridge,
  URL_PAGE_TRANSLATION_GUEST_CSS,
  URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS,
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
const MAX_BLOCK_CHARS = 4_000;
const MAX_CAPTION_BLOCKS = 16;
const MAX_CAPTION_CHARS = 4_000;

interface GuestRuntime {
  version: 1;
  captionLanguage(): Promise<string | null>;
  setEnabled(enabled: boolean, targetLanguage: TranslationLanguage): void;
  nextBatch(
    maxBlocks: number,
    maxChars: number,
    maxBlockChars: number,
    retryOnly?: boolean,
    visibleOnly?: boolean,
    activeBatches?: readonly UrlPageTranslationGuestActiveBatch[],
    captionMaxBlocks?: number,
    captionMaxChars?: number,
    estimatedLatencyMs?: number,
    queueVisible?: boolean,
  ): UrlPageTranslationGuestBatch;
  waitForWork(afterRevision: number, timeoutMs: number): Promise<number>;
  release(ids: readonly string[]): void;
  apply(items: readonly UrlPageTranslationItem[]): number;
  fail(ids: readonly string[]): void;
  destroy(): void;
}

describe('URL page translation guest runtime', () => {
  test('stays within the isolated-world runtime source limit', () => {
    expect(installUrlPageTranslationRuntime.toString().length)
      .toBeLessThanOrEqual(URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS);
  });

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

  test('lowers YouTube captions after the player controls auto-hide', () => {
    const overlayRule = cssRuleBody(
      URL_PAGE_TRANSLATION_GUEST_CSS,
      '[data-tenon-bilingual-caption-overlay]',
    );
    const youtubeRule = cssRuleBody(
      URL_PAGE_TRANSLATION_GUEST_CSS,
      '[data-tenon-bilingual-caption-overlay="youtube"]',
    );
    const autoHideRule = cssRuleBody(
      URL_PAGE_TRANSLATION_GUEST_CSS,
      '.html5-video-player.ytp-autohide > [data-tenon-bilingual-caption-overlay="youtube"]',
    );
    const adRule = cssRuleBody(
      URL_PAGE_TRANSLATION_GUEST_CSS,
      '.html5-video-player.ad-showing > [data-tenon-bilingual-caption-overlay="youtube"]',
    );

    expect(overlayRule).toContain('bottom: max(72px, 12%) !important;');
    expect(overlayRule).toContain('--tenon-caption-background: rgb(0 0 0 / 0.72);');
    expect(overlayRule).toContain('--tenon-caption-foreground: rgb(255 255 255);');
    expect(overlayRule).toContain('--tenon-caption-shadow: 0 1px 2px rgb(0 0 0 / 0.95);');
    expect(URL_PAGE_TRANSLATION_GUEST_CSS).toContain('--tenon-caption-background: rgb(0 0 0);');
    expect(youtubeRule).toContain('transition: bottom 160ms ease-out !important;');
    expect(autoHideRule).toContain('bottom: max(20px, 4%) !important;');
    expect(adRule).toContain('display: none !important;');
    expect(URL_PAGE_TRANSLATION_GUEST_CSS).toContain(`
  [data-tenon-bilingual-caption-overlay="youtube"] {
    transition: none !important;
  }
`);
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

  test('marks the complete visible viewport loading before request-sized batches drain it', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');

    const first = nextBatch(fixture.runtime, { maxBlocks: 1, queueVisible: true, visibleOnly: true });

    expect(first.blocks).toHaveLength(1);
    expect(fixture.document.querySelectorAll('[data-tenon-bilingual-status="loading"]')).toHaveLength(2);
  });

  test('does not leave an untranslatable oversized visible block loading', () => {
    const fixture = createFixture();
    const current = fixture.document.getElementById('current');
    if (!current) throw new Error('Missing current paragraph');
    current.textContent = 'x'.repeat(MAX_BLOCK_CHARS + 1);
    fixture.runtime.setEnabled(true, 'zh-Hans');

    nextBatch(fixture.runtime, { maxBlocks: 1, queueVisible: true, visibleOnly: true });

    expect(current.querySelector('[data-tenon-bilingual-status]')).toBeNull();
  });

  test('resolves a bounded work wait when the viewport changes', async () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const revision = nextBatch(fixture.runtime, { visibleOnly: true }).workRevision;
    const waiting = fixture.runtime.waitForWork(revision, 1_000);

    fixture.setScrollY(300);
    fixture.dispatchScroll();

    expect(await waiting).toBeGreaterThan(revision);
  });

  test('wakes scheduling when caption playback crosses a cue or seeks', async () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [
        { startTime: 0, endTime: 8, text: 'First cue' },
        { startTime: 8, endTime: 16, text: 'Second cue' },
      ],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const EventCtor = (fixture.window as unknown as { Event: typeof Event }).Event;
    const revision = nextBatch(fixture.runtime).workRevision;
    const cueWait = fixture.runtime.waitForWork(revision, 1_000);

    caption.media.currentTime = 9;
    caption.media.dispatchEvent(new EventCtor('timeupdate'));
    const cueRevision = await cueWait;

    expect(cueRevision).toBeGreaterThan(revision);
    const seekWait = fixture.runtime.waitForWork(cueRevision, 1_000);
    caption.media.dispatchEvent(new EventCtor('seeked'));
    expect(await seekWait).toBeGreaterThan(cueRevision);
  });

  test('skips blocks whose nearest declared language matches the selected target', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'en');

    const texts = nextBatch(fixture.runtime).blocks.map((block) => block.text);
    expect(texts).toEqual(['Already translated content']);
    expect(fixture.document.querySelector('#current [data-tenon-bilingual-status]')).toBeNull();
  });

  test('renders and restores a Frontend Masters-style remote TextTrack as bilingual cues', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [
        { startTime: 0, endTime: 8, text: 'How Claude Code works' },
        { startTime: 8, endTime: 16, text: 'The agentic loop' },
      ],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');

    const batch = nextBatch(fixture.runtime);
    expect(batch.contentKind).toBe('caption');
    expect(batch.blocks.map((block) => block.text)).toEqual([
      'How Claude Code works',
      'The agentic loop',
    ]);
    expect(caption.source.mode).toBe('hidden');
    expect(caption.bilingual().mode).toBe('showing');
    expect(caption.bilingual().cues?.[0]?.text).toBe('How Claude Code works');

    expect(fixture.runtime.apply(batch.blocks.map((block) => ({
      id: block.id,
      translation: block.text === 'How Claude Code works' ? 'Claude Code 的工作原理' : '智能体循环',
    })))).toBe(2);
    expect(caption.bilingual().cues?.map((cue) => cue.text)).toEqual([
      'How Claude Code works\nClaude Code 的工作原理',
      'The agentic loop\n智能体循环',
    ]);

    fixture.runtime.setEnabled(false, 'zh-Hans');
    expect(caption.source.mode).toBe('showing');
    expect(caption.bilingual().mode).toBe('disabled');
  });

  test('releases pending caption cues when translation is hidden and shown again', () => {
    const fixture = createFixture();
    addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Resume this caption' }],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const pending = nextBatch(fixture.runtime);
    expect(pending.blocks.map((block) => block.text)).toEqual(['Resume this caption']);

    fixture.runtime.setEnabled(false, 'zh-Hans');
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const resumed = nextBatch(fixture.runtime);

    expect(resumed.contentKind).toBe('caption');
    expect(resumed.blocks).toEqual(pending.blocks);
  });

  test('detects a standard caption language without adding a synthetic track', async () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Source caption' }],
    });

    expect(await fixture.runtime.captionLanguage()).toBe('en');
    expect(() => caption.bilingual()).toThrow('Missing bilingual caption track');
    expect(caption.source.mode).toBe('showing');
  });

  test('does not translate live standard caption timelines', async () => {
    const standardFixture = createFixture();
    const standard = addCaptionVideo(standardFixture.document, standardFixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Live source caption' }],
    });
    Object.defineProperty(standard.media, 'duration', { configurable: true, value: Infinity });
    standardFixture.runtime.setEnabled(true, 'zh-Hans');

    expect(await standardFixture.runtime.captionLanguage()).toBeNull();
    expect(nextBatch(standardFixture.runtime).blocks.map((block) => block.text))
      .not.toContain('Live source caption');
    expect(() => standard.bilingual()).toThrow('Missing bilingual caption track');
  });

  test('does not read timed text for live YouTube captions', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    const youtube = addCaptionVideo(fixture.document, fixture.window, {
      cues: [],
      language: null,
    });
    Object.defineProperty(youtube.media, 'duration', { configurable: true, value: Infinity });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: timedTextUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    const fetched: string[] = [];
    setWindowFetch(fixture.window, async (url) => {
      fetched.push(String(url));
      return new Response('', { status: 200 });
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');

    try {
      expect(await fixture.runtime.captionLanguage()).toBeNull();
      expect(fetched).toEqual([]);
    } finally {
      fixture.runtime.destroy();
      setWindowLocation(fixture.window, 'https://example.com/');
    }
  });

  test('escapes model markup before placing translated text in a native cue', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Source caption' }],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = nextBatch(fixture.runtime);

    fixture.runtime.apply([{
      id: batch.blocks[0]!.id,
      translation: '<img src=x onerror=alert(1)> & translated',
    }]);

    expect(caption.bilingual().cues?.[0]?.text)
      .toBe('Source caption\n&lt;img src=x onerror=alert(1)> &amp; translated');
  });

  test('preserves native cue layout when translated text replaces the generated cue', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Positioned source caption' }],
    });
    const sourceCue = caption.source.cues?.[0];
    if (!sourceCue) throw new Error('Missing source cue');
    sourceCue.align = 'start';
    sourceCue.line = 0;
    sourceCue.position = 24;
    sourceCue.size = 62;
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = nextBatch(fixture.runtime);

    fixture.runtime.apply([{ id: batch.blocks[0]!.id, translation: '定位后的译文' }]);

    expect(caption.bilingual().cues?.[0]).toMatchObject({
      align: 'start',
      line: 0,
      position: 24,
      size: 62,
    });
  });

  test('keeps source cue layout paired after invalid cues are filtered out', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [
        { startTime: 0, endTime: 4, text: '   ' },
        { startTime: 4, endTime: 8, text: 'Visible positioned caption' },
      ],
    });
    const emptyCue = caption.source.cues?.[0];
    const visibleCue = caption.source.cues?.[1];
    if (!emptyCue || !visibleCue) throw new Error('Missing source cues');
    emptyCue.align = 'start';
    emptyCue.line = 2;
    visibleCue.align = 'end';
    visibleCue.line = 0;
    visibleCue.position = 72;
    fixture.runtime.setEnabled(true, 'zh-Hans');

    expect(nextBatch(fixture.runtime).blocks.map((block) => block.text))
      .toEqual(['Visible positioned caption']);
    expect(caption.bilingual().cues).toHaveLength(1);
    expect(caption.bilingual().cues?.[0]).toMatchObject({
      align: 'end',
      line: 0,
      position: 72,
    });
  });

  test('does not translate a caption track that already matches the target language', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en-US',
      cues: [{ startTime: 0, endTime: 8, text: 'Already English' }],
    });
    fixture.runtime.setEnabled(true, 'en');

    const batch = nextBatch(fixture.runtime);
    expect(batch.contentKind).toBe('page');
    expect(batch.blocks.map((block) => block.text)).not.toContain('Already English');
    expect(() => caption.bilingual()).toThrow('Missing bilingual caption track');
  });

  test('does not restore the old source when the user selects a target-language track', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'English source' }],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    nextBatch(fixture.runtime);

    const replacement = caption.replaceSource('zh-Hans', [{
      startTime: 0,
      endTime: 8,
      text: '中文字幕',
    }]);
    nextBatch(fixture.runtime);

    expect(caption.source.mode).toBe('disabled');
    expect(replacement.mode).toBe('showing');
    expect(caption.bilingual().mode).toBe('disabled');
  });

  test('restores the previous source track when playback moves to another video', () => {
    const fixture = createFixture();
    const first = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'First video caption' }],
    });
    const second = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Second video caption' }],
    });
    Object.defineProperty(second.media, 'paused', { configurable: true, value: true, writable: true });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    expect(nextBatch(fixture.runtime).blocks[0]?.text).toBe('First video caption');
    expect(first.source.mode).toBe('hidden');

    Object.defineProperty(first.media, 'paused', { configurable: true, value: true, writable: true });
    Object.defineProperty(second.media, 'paused', { configurable: true, value: false, writable: true });
    expect(nextBatch(fixture.runtime).blocks[0]?.text).toBe('Second video caption');

    expect(first.source.mode).toBe('showing');
    expect(second.source.mode).toBe('hidden');
  });

  test('sends selected caption cues to the model in playback order', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [
        { startTime: 5, endTime: 14, text: 'Earlier context' },
        { startTime: 14, endTime: 16, text: 'Current cue' },
        { startTime: 16, endTime: 20, text: 'Upcoming cue' },
      ],
    });
    caption.media.currentTime = 15;
    fixture.runtime.setEnabled(true, 'zh-Hans');

    expect(nextBatch(fixture.runtime, { visibleOnly: true }).blocks.map((block) => block.text)).toEqual([
      'Earlier context',
      'Current cue',
      'Upcoming cue',
    ]);
  });

  test('allows one long current cue through the first soft caption budget', () => {
    const fixture = createFixture();
    const longCue = `Long cue ${'x'.repeat(1_592)}`;
    addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: longCue }],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');

    const captionBatch = nextBatch(fixture.runtime, { captionMaxChars: 1_500, visibleOnly: true });
    expect(captionBatch.contentKind).toBe('caption');
    expect(captionBatch.blocks.map((block) => block.text)).toEqual([longCue]);

    const pageBatch = nextBatch(fixture.runtime, { captionMaxChars: 1_500, visibleOnly: true });
    expect(pageBatch.contentKind).toBe('page');
    expect(pageBatch.blocks.length).toBeGreaterThan(0);
  });

  test('bounds caption prefetch by playback time and preempts it after a seek', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [
        { startTime: 0, endTime: 8, text: 'Current cue' },
        { startTime: 10, endTime: 18, text: 'Immediately upcoming cue' },
        { startTime: 60, endTime: 68, text: 'Prefetched cue' },
        { startTime: 200, endTime: 208, text: 'Far seek target' },
      ],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const current = nextBatch(fixture.runtime, { visibleOnly: true });
    expect(current.blocks.map((block) => block.text)).toEqual([
      'Current cue',
      'Immediately upcoming cue',
    ]);
    fixture.runtime.apply(current.blocks.map((block) => ({ id: block.id, translation: `T ${block.text}` })));
    let prefetch = nextBatch(fixture.runtime);
    if (prefetch.contentKind === 'page') {
      fixture.runtime.apply(prefetch.blocks.map((block) => ({ id: block.id, translation: `T ${block.text}` })));
      prefetch = nextBatch(fixture.runtime);
    }
    expect(prefetch.priority).toBe(1);
    expect(prefetch.blocks.map((block) => block.text)).toEqual(['Prefetched cue']);

    caption.media.currentTime = 201;
    const sought = nextBatch(fixture.runtime, {
      activeBatches: [{ ids: prefetch.blocks.map((block) => block.id), requestId: 'request:prefetch' }],
    });
    expect(sought.preemptRequestId).toBe('request:prefetch');
    expect(sought.priority).toBe(0);
    expect(sought.blocks.map((block) => block.text)).toEqual(['Far seek target']);
  });

  test('drops stale caption responses after the player replaces its source track', () => {
    const fixture = createFixture();
    const caption = addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Old track cue' }],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const oldBatch = nextBatch(fixture.runtime);

    caption.replaceSource('en', [{ startTime: 0, endTime: 8, text: 'New track cue' }]);
    const newBatch = nextBatch(fixture.runtime);
    expect(newBatch.blocks[0]?.text).toBe('New track cue');
    expect(newBatch.blocks[0]?.id).not.toBe(oldBatch.blocks[0]?.id);
    expect(newBatch.captionRevision).toBeGreaterThan(oldBatch.captionRevision);
    expect(fixture.runtime.apply([{
      id: oldBatch.blocks[0]!.id,
      translation: 'STALE CAPTION',
    }])).toBe(0);
    expect(caption.bilingual().cues?.some((cue) => cue.text.includes('STALE CAPTION'))).toBe(false);
  });

  test('turns a failed current caption loader into a focused retry control', () => {
    const fixture = createFixture();
    addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [{ startTime: 0, endTime: 8, text: 'Retry this cue' }],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = nextBatch(fixture.runtime);
    fixture.runtime.fail(batch.blocks.map((block) => block.id));

    const retry = fixture.document.querySelector<HTMLButtonElement>(
      '[data-tenon-bilingual-caption-overlay] [data-tenon-bilingual-status="error"]',
    );
    expect(retry?.disabled).toBe(false);
    expect(retry?.getAttribute('aria-label')).toBe('Retry translation');
    retry?.click();

    const retried = nextBatch(fixture.runtime, { retryOnly: true });
    expect(retried.contentKind).toBe('caption');
    expect(retried.blocks[0]?.id).toBe(batch.blocks[0]?.id);
  });

  test('makes an off-window caption failure immediately retryable', () => {
    const fixture = createFixture();
    addCaptionVideo(fixture.document, fixture.window, {
      language: 'en',
      cues: [
        { startTime: 0, endTime: 8, text: 'Current cue' },
        { startTime: 60, endTime: 68, text: 'Prefetched cue' },
      ],
    });
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const current = nextBatch(fixture.runtime, { visibleOnly: true });
    fixture.runtime.apply(current.blocks.map((block) => ({ id: block.id, translation: `T ${block.text}` })));
    let prefetch = nextBatch(fixture.runtime);
    if (prefetch.contentKind === 'page') {
      fixture.runtime.apply(prefetch.blocks.map((block) => ({ id: block.id, translation: `T ${block.text}` })));
      prefetch = nextBatch(fixture.runtime);
    }
    fixture.runtime.fail(prefetch.blocks.map((block) => block.id));

    const retry = fixture.document.querySelector<HTMLButtonElement>(
      '[data-tenon-bilingual-caption-overlay] [data-tenon-bilingual-status="error"]',
    );
    expect(retry?.getAttribute('aria-label')).toBe('Retry translation');
    retry?.click();

    expect(fixture.document.querySelector(
      '[data-tenon-bilingual-caption-overlay] [data-tenon-bilingual-status="loading"]',
    )).not.toBeNull();
    expect(nextBatch(fixture.runtime, { retryOnly: true }).blocks.map((block) => block.id))
      .toEqual(prefetch.blocks.map((block) => block.id));
    expect(fixture.document.querySelector(
      '[data-tenon-bilingual-caption-overlay] [data-tenon-bilingual-status="loading"]',
    )).not.toBeNull();
  });

  test('loads YouTube timed text in the isolated runtime and renders model output as text', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    const player = fixture.document.createElement('div');
    player.id = 'movie_player';
    fixture.document.body.append(player);
    addCaptionVideo(fixture.document, fixture.window, { player, cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: timedTextUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    const fetched: Array<{ redirect: RequestRedirect | undefined; url: string }> = [];
    setWindowFetch(fixture.window, async (url, init) => {
      fetched.push({ redirect: init?.redirect, url: String(url) });
      return new Response(JSON.stringify({
        events: [{
          tStartMs: 0,
          dDurationMs: 10_000,
          segs: [{ utf8: 'YouTube source caption' }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    expect(await fixture.runtime.captionLanguage()).toBe('en');
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const batch = await waitForCaptionBatch(fixture.runtime);
    expect(batch.contentKind).toBe('caption');
    expect(batch.blocks).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0]!.url).pathname).toBe('/api/timedtext');
    expect(fetched[0]!.redirect).toBe('error');

    fixture.runtime.apply([{
      id: batch.blocks[0]!.id,
      translation: '<img src=x onerror=alert(1)> YouTube 译文',
    }]);
    const overlay = player.querySelector<HTMLElement>('[data-tenon-bilingual-caption-overlay="youtube"]');
    expect(overlay?.querySelector('[data-tenon-bilingual-caption-line="source"]')?.textContent)
      .toBe('YouTube source caption');
    expect(overlay?.querySelector('[data-tenon-bilingual-caption-line="translation"]')?.textContent)
      .toBe('<img src=x onerror=alert(1)> YouTube 译文');
    expect(overlay?.querySelector('img')).toBeNull();
    expect(fixture.document.documentElement.getAttribute('data-tenon-bilingual-youtube-captions'))
      .toBe('true');

    fixture.runtime.setEnabled(false, 'zh-Hans');
    expect(fixture.document.documentElement.hasAttribute('data-tenon-bilingual-youtube-captions')).toBe(false);
  });

  test('hides and pauses bilingual YouTube captions during an ad', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    const player = fixture.document.createElement('div');
    player.id = 'movie_player';
    player.className = 'html5-video-player';
    fixture.document.body.append(player);
    const youtube = addCaptionVideo(fixture.document, fixture.window, { player, cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: timedTextUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    setWindowFetch(fixture.window, async () => new Response(JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 10_000, segs: [{ utf8: 'Current YouTube cue' }] },
        { tStartMs: 60_000, dDurationMs: 10_000, segs: [{ utf8: 'Prefetched YouTube cue' }] },
      ],
    }), { status: 200 }));

    fixture.runtime.setEnabled(true, 'zh-Hans');
    const current = await waitForCaptionBatch(fixture.runtime);
    fixture.runtime.apply(current.blocks.map((block) => ({ id: block.id, translation: `T ${block.text}` })));
    const overlay = player.querySelector<HTMLElement>('[data-tenon-bilingual-caption-overlay="youtube"]');
    expect(overlay?.hidden).toBe(false);

    player.classList.add('ad-showing');
    youtube.media.dispatchEvent(new (fixture.window as unknown as { Event: typeof Event }).Event('timeupdate'));
    expect(overlay?.hidden).toBe(true);
    for (let index = 0; index < 3; index += 1) {
      const batch = nextBatch(fixture.runtime);
      expect(batch.blocks.map((block) => block.text)).not.toContain('Prefetched YouTube cue');
      fixture.runtime.apply(batch.blocks.map((block) => ({ id: block.id, translation: `T ${block.text}` })));
    }

    player.classList.remove('ad-showing');
    youtube.media.dispatchEvent(new (fixture.window as unknown as { Event: typeof Event }).Event('timeupdate'));
    expect(overlay?.hidden).toBe(false);
    expect((await waitForCaptionBatch(fixture.runtime)).blocks.map((block) => block.text))
      .toEqual(['Prefetched YouTube cue']);
  });

  test('uses YouTube default caption metadata for same-language exclusion', async () => {
    const fixture = createFixture();
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          audioTracks: [{ defaultCaptionTrackIndex: 1 }],
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=video123&lang=en',
              languageCode: 'en',
            },
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=video123&lang=zh-Hans',
              languageCode: 'zh-Hans',
            },
          ],
        },
      },
    })};`;
    fixture.document.head.append(script);

    expect(await fixture.runtime.captionLanguage()).toBe('zh-Hans');
  });

  test('keeps the YouTube language and refreshes stale timed text without changing CC state', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en&pot=proof';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const captionButton = fixture.document.createElement('button');
    const captionStates: string[] = [];
    captionButton.className = 'ytp-subtitles-button';
    captionButton.setAttribute('aria-pressed', 'true');
    captionButton.addEventListener('click', () => {
      const next = captionButton.getAttribute('aria-pressed') === 'true' ? 'false' : 'true';
      captionButton.setAttribute('aria-pressed', next);
      captionStates.push(next);
    });
    fixture.document.body.append(captionButton);
    const restorePerformance = setWindowPerformanceResources(fixture.window, [timedTextUrl]);
    setWindowFetch(fixture.window, async () => new Response('', { status: 200 }));

    fixture.runtime.setEnabled(true, 'zh-Hans');
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(await fixture.runtime.captionLanguage()).toBe('en');
    expect(captionStates).toEqual(['false', 'true']);
    expect(captionButton.getAttribute('aria-pressed')).toBe('true');
    restorePerformance();
  });

  test('does not let a destroyed YouTube loader toggle the site caption control', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en&pot=expired';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: timedTextUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    const captionButton = fixture.document.createElement('button');
    captionButton.className = 'ytp-subtitles-button';
    captionButton.setAttribute('aria-pressed', 'true');
    let captionClicks = 0;
    captionButton.addEventListener('click', () => {
      captionClicks += 1;
    });
    fixture.document.body.append(captionButton);
    let fetchCount = 0;
    let resolveFirstFetch: ((response: Response) => void) | null = null;
    setWindowFetch(fixture.window, async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return await new Promise<Response>((resolve) => {
          resolveFirstFetch = resolve;
        });
      }
      return new Response('', { status: 200 });
    });

    expect(await fixture.runtime.captionLanguage()).toBe('en');
    fixture.runtime.setEnabled(true, 'zh-Hans');
    await waitForCount(() => fetchCount, 1);
    fixture.runtime.destroy();
    resolveFirstFetch?.(new Response('', { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(fetchCount).toBe(1);
    expect(captionClicks).toBe(0);
    setWindowLocation(fixture.window, 'https://example.com/');
  });

  test('invalidates a pending YouTube loader across a disable and re-enable cycle', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en&pot=expired';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: timedTextUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    let fetchCount = 0;
    let resolveStaleFetch: ((response: Response) => void) | null = null;
    setWindowFetch(fixture.window, async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return await new Promise<Response>((resolve) => {
          resolveStaleFetch = resolve;
        });
      }
      return new Response(JSON.stringify({
        events: [{
          tStartMs: 0,
          dDurationMs: 10_000,
          segs: [{ utf8: 'Fresh YouTube caption' }],
        }],
      }), { status: 200 });
    });

    expect(await fixture.runtime.captionLanguage()).toBe('en');
    fixture.runtime.setEnabled(true, 'zh-Hans');
    await waitForCount(() => fetchCount, 1);
    fixture.runtime.setEnabled(false, 'zh-Hans');
    fixture.runtime.setEnabled(true, 'zh-Hans');
    expect((await waitForCaptionBatch(fixture.runtime)).blocks.map((block) => block.text))
      .toEqual(['Fresh YouTube caption']);

    resolveStaleFetch?.(new Response('', { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fetchCount).toBe(2);
    setWindowLocation(fixture.window, 'https://example.com/');
  });

  test('exponentially backs off an unreadable YouTube caption URL', async () => {
    const fixture = createFixture();
    const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en&pot=expired';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: timedTextUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    let fetchCount = 0;
    setWindowFetch(fixture.window, async () => {
      fetchCount += 1;
      return new Response('', { status: 200 });
    });
    expect(await fixture.runtime.captionLanguage()).toBe('en');
    const originalDateNow = Date.now;
    let now = originalDateNow();
    Date.now = () => now;
    try {
      fixture.runtime.setEnabled(true, 'zh-Hans');
      await waitForCount(() => fetchCount, 2);

      now += 5_001;
      nextBatch(fixture.runtime);
      await waitForCount(() => fetchCount, 4);

      now += 5_001;
      nextBatch(fixture.runtime);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchCount).toBe(4);
    } finally {
      Date.now = originalDateNow;
      fixture.runtime.destroy();
      setWindowLocation(fixture.window, 'https://example.com/');
    }
  });

  test('invalidates YouTube results when the player requests a different caption track', async () => {
    const fixture = createFixture();
    const englishUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=en';
    const chineseUrl = 'https://www.youtube.com/api/timedtext?v=video123&lang=zh-Hans';
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    const player = fixture.document.createElement('div');
    player.id = 'movie_player';
    fixture.document.body.append(player);
    addCaptionVideo(fixture.document, fixture.window, { player, cues: [], language: null });
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: englishUrl, languageCode: 'en' }],
        },
      },
    })};`;
    fixture.document.head.append(script);
    const resources: string[] = [];
    const restorePerformance = setWindowPerformanceResources(fixture.window, resources);
    setWindowFetch(fixture.window, async () => new Response(JSON.stringify({
      events: [{
        tStartMs: 0,
        dDurationMs: 10_000,
        segs: [{ utf8: 'English caption' }],
      }],
    }), { status: 200 }));

    fixture.runtime.setEnabled(true, 'zh-Hans');
    const oldBatch = await waitForCaptionBatch(fixture.runtime);
    resources.push(chineseUrl);

    expect(await fixture.runtime.captionLanguage()).toBe('zh-Hans');
    expect(fixture.runtime.apply([{
      id: oldBatch.blocks[0]!.id,
      translation: 'STALE YOUTUBE TRANSLATION',
    }])).toBe(0);
    expect(fixture.document.documentElement.hasAttribute('data-tenon-bilingual-youtube-captions')).toBe(false);
    fixture.runtime.destroy();
    restorePerformance();
  });

  test('rejects a non-YouTube timed-text origin', async () => {
    const fixture = createFixture();
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const playerResponse = {
      videoDetails: { videoId: 'video123' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: 'https://captions.example/api/timedtext?v=video123&lang=en',
            languageCode: 'en',
          }],
        },
      },
    };
    const script = fixture.document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};`;
    fixture.document.head.append(script);
    const fetched: string[] = [];
    setWindowFetch(fixture.window, async (url) => {
      fetched.push(String(url));
      return new Response(
        `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};`,
        { status: 200 },
      );
    });

    expect(await fixture.runtime.captionLanguage()).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0]!).origin).toBe('https://www.youtube.com');
  });

  test('negative-caches a confirmed captionless YouTube video beyond the old retry window', async () => {
    const fixture = createFixture();
    setWindowLocation(fixture.window, 'https://www.youtube.com/watch?v=video123');
    addCaptionVideo(fixture.document, fixture.window, { cues: [], language: null });
    const playerResponse = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { videoId: 'video123' },
    };
    const fetched: string[] = [];
    setWindowFetch(fixture.window, async (url) => {
      fetched.push(String(url));
      return new Response(
        `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};`,
        { status: 200 },
      );
    });
    const originalDateNow = Date.now;
    let now = originalDateNow();
    Date.now = () => now;
    try {
      expect(await fixture.runtime.captionLanguage()).toBeNull();
      now += 120_000;
      expect(await fixture.runtime.captionLanguage()).toBeNull();
      expect(await fixture.runtime.captionLanguage()).toBeNull();
      expect(fetched).toHaveLength(1);
    } finally {
      Date.now = originalDateNow;
      fixture.runtime.destroy();
      setWindowLocation(fixture.window, 'https://example.com/');
    }
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

  test('sends upward page batches in document order', () => {
    const fixture = createFixture();
    const earliest = fixture.document.createElement('p');
    earliest.id = 'earliest';
    earliest.textContent = 'Earliest paragraph';
    fixture.document.getElementById('behind')?.before(earliest);
    setRect(fixture.document, 'earliest', () => rect(-400, -350));
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const visible = nextBatch(fixture.runtime, { visibleOnly: true });
    fixture.runtime.apply(visible.blocks.map(({ id }) => ({ id, translation: `T ${id}` })));
    fixture.setScrollY(10);
    fixture.dispatchScroll();
    fixture.setScrollY(0);
    fixture.dispatchScroll();

    const upward = nextBatch(fixture.runtime, { maxBlocks: 2 });

    expect(upward.priority).toBe(1);
    expect(upward.blocks.map(({ text }) => text)).toEqual([
      'Earliest paragraph',
      'Recently passed paragraph',
    ]);
  });

  test('preempts the farthest non-visible page batch', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const visible = nextBatch(fixture.runtime, { maxBlocks: 8, visibleOnly: true });
    fixture.runtime.apply(visible.blocks.map(({ id }) => ({ id, translation: `T ${id}` })));
    const firstPrefetch = nextBatch(fixture.runtime, { maxBlocks: 1 });
    const secondPrefetch = nextBatch(fixture.runtime, { maxBlocks: 1 });
    const behind = [firstPrefetch, secondPrefetch]
      .find((batch) => batch.blocks[0]?.text === 'Recently passed paragraph');
    const ahead = [firstPrefetch, secondPrefetch]
      .find((batch) => batch.blocks[0]?.text === 'Prefetched paragraph');
    if (!behind || !ahead) throw new Error('Missing directional prefetch batches');

    fixture.setScrollY(2_100);
    fixture.dispatchScroll();
    const replacement = nextBatch(fixture.runtime, {
      activeBatches: [
        { ids: ahead.blocks.map(({ id }) => id), requestId: 'request:ahead' },
        { ids: behind.blocks.map(({ id }) => id), requestId: 'request:behind' },
      ],
    });

    expect(replacement.blocks.map(({ text }) => text)).toContain('Far away paragraph');
    expect(replacement.preemptRequestId).toBe('request:behind');
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

  test('validates one long caption against the hard block limit instead of the soft first budget', async () => {
    const longCue = 'x'.repeat(1_600);
    const webview = {
      getWebContentsId: () => 71,
      insertCSS: async () => 'css-key',
      removeInsertedCSS: async () => undefined,
    } as unknown as Electron.WebviewTag;
    const bridge = createUrlPageTranslationGuestBridge(webview, async (command) => (
      command.operation === 'next-batch'
        ? {
            blocks: [
              { id: 'c7:0', text: longCue },
              { id: 'c7:1', text: 'must not join the oversized cue' },
            ],
            captionRevision: 7,
            contentKind: 'caption',
            priority: 0,
          }
        : null
    ));

    const batch = await bridge.nextBatch({ captionMaxBlocks: 6, captionMaxChars: 1_500 });

    expect(batch).toMatchObject({
      blocks: [{ id: 'c7:0', text: longCue }],
      captionRevision: 7,
      contentKind: 'caption',
    });
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

    fixture.dispatchScroll();
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

  test('does not undo scrollbar scrolling from a deferred anchor correction', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const block = nextBatch(fixture.runtime, { maxBlocks: 1 }).blocks[0];
    if (!block) throw new Error('Missing block');
    fixture.runtime.apply([{ id: block.id, translation: 'Translated above viewport' }]);
    expect(fixture.scrollDeltas).toEqual([30]);

    fixture.setScrollY(130);
    fixture.dispatchScroll();
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
    const failedBatch = nextBatch(fixture.runtime, { maxBlocks: 1, retryOnly: true });
    expect(failedBatch.blocks).toEqual([]);
    expect(failedBatch.hasActiveFailures).toBe(true);

    retry?.click();

    expect(retry?.getAttribute('data-tenon-bilingual-status')).toBe('loading');
    const retried = nextBatch(fixture.runtime, { maxBlocks: 1, retryOnly: true });
    expect(retried.blocks[0]?.id).toBe(first.blocks[0]?.id);
    expect(retried.hasActiveFailures).toBe(false);
  });

  test('returns a released failed block to normal scheduling without a hidden failure', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const first = nextBatch(fixture.runtime, { maxBlocks: 1 });
    const id = first.blocks[0]?.id;
    if (!id) throw new Error('Missing block');
    fixture.runtime.fail([id]);

    fixture.runtime.release([id]);

    expect(fixture.document.querySelector('[data-tenon-bilingual-status]')).toBeNull();
    const rescheduled = nextBatch(fixture.runtime, { maxBlocks: 1 });
    expect(rescheduled.blocks[0]?.id).toBe(id);
    expect(rescheduled.hasActiveFailures).toBe(false);
  });

  test('reconciles failure state after the remote page removes a failed block', () => {
    const fixture = createFixture();
    fixture.runtime.setEnabled(true, 'zh-Hans');
    const first = nextBatch(fixture.runtime, { maxBlocks: 1 });
    fixture.runtime.fail(first.blocks.map(({ id }) => id));
    expect(nextBatch(fixture.runtime, { retryOnly: true }).hasActiveFailures).toBe(true);

    fixture.document.querySelector('[data-tenon-bilingual-status="error"]')?.parentElement?.remove();
    let reconciled = nextBatch(fixture.runtime, { retryOnly: true });
    for (let index = 0; index < 10 && reconciled.hasActiveFailures; index += 1) {
      reconciled = nextBatch(fixture.runtime, { retryOnly: true });
    }

    expect(reconciled.hasActiveFailures).toBe(false);
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
    captionMaxChars?: number;
    maxBlocks?: number;
    queueVisible?: boolean;
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
    MAX_CAPTION_BLOCKS,
    options.captionMaxChars ?? MAX_CAPTION_CHARS,
    1_500,
    options.queueVisible ?? false,
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
  dispatchScroll: () => void;
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
    innerHeight: { configurable: true, value: 600, writable: true },
    requestAnimationFrame: {
      configurable: true,
      writable: true,
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
  setRect(document, 'far', () => rect(2_600 - testWindow.scrollY, 2_650 - testWindow.scrollY));
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
  const EventCtor = (testWindow as unknown as { Event: typeof Event }).Event;
  return {
    document,
    dispatchScroll: () => testWindow.dispatchEvent(new EventCtor('scroll')),
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

interface FakeCaptionCueSnapshot {
  endTime: number;
  startTime: number;
  text: string;
}

class FakeCaptionCue {
  align: AlignSetting = 'center';
  line: LineAndPositionSetting = 'auto';
  position: LineAndPositionSetting = 'auto';
  size = 100;
  snapToLines = true;
  vertical: DirectionSetting = '';

  constructor(
    public startTime: number,
    public endTime: number,
    public text: string,
  ) {}
}

class FakeCaptionTrack {
  cues: FakeCaptionCue[] | null;
  id = '';
  kind: TextTrackKind = 'captions';
  label: string;
  mode: TextTrackMode;

  constructor(
    label: string,
    public language: string,
    cues: FakeCaptionCueSnapshot[],
    mode: TextTrackMode,
  ) {
    this.label = label;
    this.mode = mode;
    this.cues = cues.map((cue) => new FakeCaptionCue(cue.startTime, cue.endTime, cue.text));
  }

  addCue(cue: TextTrackCue): void {
    this.cues ??= [];
    this.cues.push(cue as unknown as FakeCaptionCue);
    this.cues.sort((left, right) => left.startTime - right.startTime);
  }

  removeCue(cue: TextTrackCue): void {
    if (!this.cues) return;
    const index = this.cues.indexOf(cue as unknown as FakeCaptionCue);
    if (index >= 0) this.cues.splice(index, 1);
  }
}

function addCaptionVideo(
  document: Document,
  window: Window,
  options: {
    cues: FakeCaptionCueSnapshot[];
    language: string | null;
    player?: HTMLElement;
  },
): {
  bilingual: () => FakeCaptionTrack;
  media: HTMLVideoElement;
  replaceSource: (language: string, cues: FakeCaptionCueSnapshot[]) => FakeCaptionTrack;
  source: FakeCaptionTrack;
} {
  const player = options.player ?? document.createElement('div');
  if (!player.isConnected) document.body.append(player);
  const media = document.createElement('video');
  player.append(media);
  media.getBoundingClientRect = () => rect(0, 400);
  const source = new FakeCaptionTrack('English', options.language ?? '', options.cues, 'showing');
  const tracks: FakeCaptionTrack[] = options.language ? [source] : [];
  Object.defineProperties(media, {
    currentTime: { configurable: true, value: 1, writable: true },
    duration: { configurable: true, value: 600, writable: true },
    ended: { configurable: true, value: false, writable: true },
    paused: { configurable: true, value: false, writable: true },
    playbackRate: { configurable: true, value: 1, writable: true },
    textTracks: { configurable: true, value: tracks },
  });
  Object.defineProperty(media, 'addTextTrack', {
    configurable: true,
    value: (kind: TextTrackKind, label: string, language: string) => {
      const track = new FakeCaptionTrack(label, language, [], 'disabled');
      track.kind = kind;
      tracks.push(track);
      return track;
    },
  });
  (window as Window & { VTTCue?: typeof VTTCue }).VTTCue = FakeCaptionCue as unknown as typeof VTTCue;
  return {
    bilingual: () => {
      const track = [...tracks].reverse().find((entry) => entry.label === 'Tenon bilingual');
      if (!track) throw new Error('Missing bilingual caption track');
      return track;
    },
    media,
    replaceSource: (language, cues) => {
      const replacement = new FakeCaptionTrack('Replacement', language, cues, 'showing');
      source.mode = 'disabled';
      const sourceIndex = tracks.indexOf(source);
      if (sourceIndex >= 0) tracks.splice(sourceIndex, 1, replacement);
      else tracks.unshift(replacement);
      return replacement;
    },
    source,
  };
}

function setWindowLocation(window: Window, href: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL(href),
  });
}

function setWindowFetch(
  window: Window,
  fetcher: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: fetcher,
  });
}

function setWindowPerformanceResources(window: Window, resources: string[]): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'performance');
  Object.defineProperty(window, 'performance', {
    configurable: true,
    value: {
      now: () => Date.now(),
      getEntriesByType: (type: string) => type === 'resource'
        ? resources.map((name) => ({ name }))
        : [],
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(window, 'performance', descriptor);
    else delete (window as Window & { performance?: Performance }).performance;
  };
}

async function waitForCaptionBatch(runtime: GuestRuntime): Promise<UrlPageTranslationGuestBatch> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    const batch = nextBatch(runtime);
    if (batch.contentKind === 'caption' && batch.blocks.length > 0) return batch;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for caption batch');
}

async function waitForCount(read: () => number, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read() >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for count ${expected}`);
}
