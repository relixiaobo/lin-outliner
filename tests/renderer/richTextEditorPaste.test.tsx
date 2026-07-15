import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { RichText } from '../../src/renderer/api/types';
import { useUiState } from '../../src/renderer/state/document';
import { RichTextEditor } from '../../src/renderer/ui/editor/RichTextEditor';
import { useWorkspaceKeyboard } from '../../src/renderer/ui/useWorkspaceKeyboard';

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
    let globalCommands = 0;
    const changes: RichText[] = [];
    const rendered = renderEditor({ text: 'Original', marks: [], inlineRefs: [] }, {
      onChange: (content) => changes.push(content),
      onPasteOutliner: (payload) => {
        pastedContent = payload.content;
        return new Promise<boolean>((resolve) => { resolvePaste = resolve; });
      },
    }, () => { globalCommands += 1; });
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
    expect(editor.getAttribute('contenteditable')).toBe('false');
    const undoEvent = dispatchModZ(rendered, editor, false);
    expect(undoEvent.defaultPrevented).toBe(true);
    expect(globalCommands).toBe(0);

    await act(async () => {
      resolvePaste?.(false);
      await Promise.resolve();
    });

    expect(editor.textContent).toBe('Original');
    expect(changes).toEqual([]);
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(globalCommands).toBe(0);
  });

  test('blocks input while pending before applying a successful structured paste', async () => {
    let resolvePaste: ((applied: boolean) => void) | undefined;
    let pastedContent: RichText | undefined;
    let globalCommands = 0;
    const changes: RichText[] = [];
    const rendered = renderEditor({ text: 'Original', marks: [], inlineRefs: [] }, {
      onChange: (content) => changes.push(content),
      onPasteOutliner: (payload) => {
        pastedContent = payload.content;
        return new Promise<boolean>((resolve) => { resolvePaste = resolve; });
      },
    }, () => { globalCommands += 1; });
    const editor = rendered.document.querySelector<HTMLElement>('.ProseMirror')!;

    act(() => {
      const event = new rendered.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [],
          items: [],
          getData: (type: string) => type === 'text/plain' ? 'Pasted\nNext' : '',
        },
      });
      editor.dispatchEvent(event);
    });

    expect(resolvePaste).toBeDefined();
    expect(editor.getAttribute('contenteditable')).toBe('false');

    const inputEvent = new rendered.window.Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperties(inputEvent, {
      data: { value: 'X' },
      inputType: { value: 'insertText' },
    });
    act(() => {
      editor.dispatchEvent(inputEvent);
    });

    expect(inputEvent.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe('Original');
    expect(changes).toEqual([]);
    const redoEvent = dispatchModZ(rendered, editor, true);
    expect(redoEvent.defaultPrevented).toBe(true);
    expect(globalCommands).toBe(0);

    await act(async () => {
      resolvePaste?.(true);
      await Promise.resolve();
    });

    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(changes).toEqual([pastedContent!]);
    expect(editor.textContent).not.toContain('X');
    expect(globalCommands).toBe(0);
  });
});

function dispatchModZ(
  rendered: ReturnType<typeof renderEditor>,
  editor: HTMLElement,
  shiftKey: boolean,
) {
  const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    altKey: { value: false },
    code: { value: 'KeyZ' },
    ctrlKey: { value: false },
    key: { value: 'z' },
    metaKey: { value: true },
    shiftKey: { value: shiftKey },
  });
  act(() => {
    editor.dispatchEvent(event);
  });
  return event;
}

function renderEditor(
  content: RichText,
  overrides: Partial<EditorProps> = {},
  onGlobalCommand: () => void = noop,
) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(document, {
    getSelection: () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      isCollapsed: true,
      rangeCount: 0,
    }),
  });
  Object.assign(globalThis, {
    CustomEvent: window.CustomEvent,
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    innerHeight: 900,
    window,
  });
  (globalThis.window.HTMLElement.prototype as { focus?: () => void }).focus = () => {};
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root')!);
  act(() => {
    root.render(
      <EditorHarness content={content} overrides={overrides} onGlobalCommand={onGlobalCommand} />,
    );
  });
  mounted.push(() => act(() => root.unmount()));
  return { document, window };
}

function EditorHarness({
  content,
  overrides,
  onGlobalCommand,
}: {
  content: RichText;
  overrides: Partial<EditorProps>;
  onGlobalCommand: () => void;
}) {
  const [ui, setUi] = useUiState();
  useWorkspaceKeyboard({
    appendTypedCharToRow: noop,
    index: null,
    onGoToRoot: noop,
    onNavigateBack: noop,
    onNavigateForward: noop,
    onOpenPanel: noop,
    requestEditFocus: noop,
    rootId: null,
    run: async () => {
      onGlobalCommand();
      return null;
    },
    setCommandOpen: noop,
    setError: noop,
    setUi,
    ui,
  });
  return (
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
    />
  );
}
