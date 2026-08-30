import { afterEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';
import {
  openUrlPreviewFromClick,
  previewTargetForUrl,
  youtubePreviewRouteForUrl,
} from '../../src/renderer/ui/preview/urlPreviewRouting';

afterEach(() => {
  delete (globalThis as typeof globalThis & { window?: Window }).window;
  delete (globalThis as typeof globalThis & { CustomEvent?: typeof CustomEvent }).CustomEvent;
});

describe('URL preview routing', () => {
  test('routes supported YouTube URLs to a click-to-play embed', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1',
      'https://youtu.be/dQw4w9WgXcQ?autoplay=1',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      expect(youtubePreviewRouteForUrl(url)).toEqual({
        embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=0&playsinline=1',
        videoId: 'dQw4w9WgXcQ',
      });
    }
  });

  test('leaves ordinary and malformed URLs on the generic web route', () => {
    expect(youtubePreviewRouteForUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubePreviewRouteForUrl('https://www.youtube.com/watch?v=bad!')).toBeNull();
  });

  test('normalizes http(s) URLs into preview targets only', () => {
    expect(previewTargetForUrl('https://example.com/docs', 'Docs')).toEqual({
      kind: 'url',
      url: 'https://example.com/docs',
      label: 'Docs',
    });
    expect(previewTargetForUrl('mailto:team@example.com')).toBeNull();
    expect(previewTargetForUrl('/relative')).toBeNull();
  });

  test('dispatches URL preview open events into a split pane by default', () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
      CustomEvent: window.CustomEvent,
      window,
    });
    const opened: PreviewTargetOpenDetail[] = [];
    window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      opened.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });

    const routed = openUrlPreviewFromClick({ ctrlKey: false, metaKey: false }, 'https://example.com/a', 'A');

    expect(routed).toBe(true);
    expect(opened).toEqual([{
      newPane: true,
      target: {
        kind: 'url',
        url: 'https://example.com/a',
        label: 'A',
      },
    }]);
  });
});
