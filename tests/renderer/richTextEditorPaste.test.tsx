import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { RichText } from '../../src/renderer/api/types';
import { RichTextEditor } from '../../src/renderer/ui/editor/RichTextEditor';

type EditorProps = ComponentProps<typeof RichTextEditor>;
const noop = () => undefined;
const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

describe('RichTextEditor structured paste commit', () => {
  test('keeps editor content unchanged while pending and after the owning Core command rejects', async () => {
    let resolvePaste: ((applied: boolean) => void) | undefined;
    let pastedContent: RichText | undefined;
    const changes: RichText[] = [];
    const rendered = renderEditor({ text: 'Original', marks: [], inlineRefs: [] }, {
      onChange: (content) => changes.push(content),
      onPasteOutliner: (payload) => {
        pastedContent = payload.content;
        return new Promise<boolean>((resolve) => { resolvePaste = resolve; });
      },
    });
    const editor = rendered.document.querySelector<HTMLElement>('.ProseMirror')!;

    act(() => {
      const event = new rendered.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [],
          items: [],
          getData: (type: string) => type === 'text/plain'
            ? 'See [[node:Missing^node:does-not-exist]]'
            : '',
        },
      });
      editor.dispatchEvent(event);
    });

    expect(resolvePaste).toBeDefined();
    expect(pastedContent?.inlineRefs).toEqual([{
      offset: 4,
      target: { kind: 'node', nodeId: 'node:does-not-exist' },
      displayName: 'Missing',
    }]);
    expect(editor.textContent).toBe('Original');
    expect(changes).toEqual([]);

    await act(async () => {
      resolvePaste?.(false);
      await Promise.resolve();
    });

    expect(editor.textContent).toBe('Original');
    expect(changes).toEqual([]);
  });
});

function renderEditor(
  content: RichText,
  overrides: Partial<EditorProps> = {},
) {
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
        nodeId="node:paste"
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
        {...overrides}
      />,
    );
  });
  mounted.push(() => act(() => root.unmount()));
  return { document, window };
}
