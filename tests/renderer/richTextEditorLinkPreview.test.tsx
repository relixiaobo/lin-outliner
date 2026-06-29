import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { RichText } from '../../src/renderer/api/types';
import { RichTextEditor } from '../../src/renderer/ui/editor/RichTextEditor';
import {
  PREVIEW_TARGET_OPEN_EVENT,
  type PreviewTargetOpenDetail,
} from '../../src/renderer/ui/preview/previewEvents';

const noop = () => undefined;
const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

describe('RichTextEditor link preview routing', () => {
  test('routes ordinary http links to Tenon preview events', () => {
    const rendered = renderEditor({
      text: 'Docs',
      marks: [{ start: 0, end: 4, type: 'link', attrs: { href: 'https://example.com/docs' } }],
      inlineRefs: [],
    });
    const opened: PreviewTargetOpenDetail[] = [];
    rendered.window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, (event) => {
      opened.push((event as CustomEvent<PreviewTargetOpenDetail>).detail);
    });
    const link = rendered.document.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
    expect(link).not.toBeNull();

    act(() => {
      const event = new rendered.window.Event('click', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        ctrlKey: { value: false },
        metaKey: { value: false },
        shiftKey: { value: false },
      });
      link?.dispatchEvent(event);
    });

    expect(opened).toEqual([{
      newPane: false,
      target: {
        kind: 'url',
        url: 'https://example.com/docs',
        label: 'Docs',
      },
    }]);
  });
});

function renderEditor(content: RichText) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    CustomEvent: window.CustomEvent,
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis.window.HTMLElement.prototype as { focus?: () => void }).focus = () => {};
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root')!);
  act(() => {
    root.render(
      <RichTextEditor
        nodeId="node:link-preview"
        content={content}
        onFocus={noop}
        onChange={noop}
        onPatch={noop}
        onCommit={noop}
        onEnter={noop}
        onBackspaceAtStart={noop}
        onTab={noop}
        onArrowUpAtStart={noop}
        onArrowDownAtEnd={noop}
        onModEnter={noop}
        onEscape={noop}
        onTriggerChange={noop}
      />,
    );
  });
  mounted.push(() => act(() => root.unmount()));
  return { document, window };
}
