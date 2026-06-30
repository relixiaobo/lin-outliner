import { afterEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';
import {
  openUrlPreviewFromClick,
  previewTargetForUrl,
} from '../../src/renderer/ui/preview/urlPreviewRouting';

afterEach(() => {
  delete (globalThis as typeof globalThis & { window?: Window }).window;
  delete (globalThis as typeof globalThis & { CustomEvent?: typeof CustomEvent }).CustomEvent;
});

describe('URL preview routing', () => {
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
