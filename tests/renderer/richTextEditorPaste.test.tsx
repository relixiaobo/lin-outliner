import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { RichText } from '../../src/renderer/api/types';
import { useUiState } from '../../src/renderer/state/document';
import { RichTextEditor } from '../../src/renderer/ui/editor/RichTextEditor';
import { useWorkspaceKeyboard } from '../../src/renderer/ui/useWorkspaceKeyboard';

const MISSING_NODE_ID = 'node:11111111-1111-4111-8111-111111111111';
const MISSING_NODE_MARKER = '[[node://11111111-1111-4111-8111-111111111111]]';

type EditorProps = ComponentProps<typeof RichTextEditor>;
const noop = () => undefined;
const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

describe('RichTextEditor structured paste commit', () => {
  test('refreshes an unfocused Node reference title without changing its target', () => {
    const content: RichText = {
      text: 'See ',
      marks: [],
      inlineRefs: [{
        offset: 4,
        target: { kind: 'node', nodeId: MISSING_NODE_ID },
        displayName: 'Stored title',
      }],
    };
    let title = 'Current title';
    const props = () => ({
      readOnly: true,
      resolveInlineReferenceDisplayName: () => title,
    });
    const rendered = renderEditor(content, props());
    const reference = rendered.document.querySelector<HTMLElement>('.inline-ref')!;

    expect(reference.textContent).toBe('Current title');
    expect(reference.dataset.inlineRef).toBe(MISSING_NODE_ID);

    title = 'Renamed title';
    rendered.rerender(content, props());

    const renamedReference = rendered.document.querySelector<HTMLElement>('.inline-ref')!;
    expect(renamedReference.textContent).toBe('Renamed title');
    expect(renamedReference.dataset.inlineRef).toBe(MISSING_NODE_ID);
  });

  test('applies a focused Node reference title refresh when the editor blurs', () => {
    const content: RichText = {
      text: 'See ',
      marks: [],
      inlineRefs: [{
        offset: 4,
        target: { kind: 'node', nodeId: MISSING_NODE_ID },
        displayName: 'Stored title',
      }],
    };
    let title = 'Current title';
    const props = () => ({ resolveInlineReferenceDisplayName: () => title });
    const rendered = renderEditor(content, props());
    const editor = rendered.document.querySelector<HTMLElement>('.ProseMirror')!;
    let activeElement: Element | null = editor;
    Object.defineProperty(rendered.document, 'activeElement', {
      configurable: true,
      get: () => activeElement,
    });

    title = 'Renamed title';
    rendered.rerender(content, props());
    expect(rendered.document.querySelector<HTMLElement>('.inline-ref')?.textContent).toBe('Current title');

    activeElement = rendered.document.body;
    act(() => editor.dispatchEvent(new rendered.window.Event('blur')));

    const renamedReference = rendered.document.querySelector<HTMLElement>('.inline-ref')!;
    expect(renamedReference.textContent).toBe('Renamed title');
    expect(renamedReference.dataset.inlineRef).toBe(MISSING_NODE_ID);
  });

  test('applies a composing Node reference title refresh at composition end', async () => {
    const content: RichText = {
      text: 'See ',
      marks: [],
      inlineRefs: [{
        offset: 4,
        target: { kind: 'node', nodeId: MISSING_NODE_ID },
        displayName: 'Stored title',
      }],
    };
    let title = 'Current title';
    const props = () => ({ resolveInlineReferenceDisplayName: () => title });
    const rendered = renderEditor(content, props());
    const editor = rendered.document.querySelector<HTMLElement>('.ProseMirror')!;

    act(() => editor.dispatchEvent(new rendered.window.Event('compositionstart')));
    title = 'Renamed title';
    rendered.rerender(content, props());
    expect(rendered.document.querySelector<HTMLElement>('.inline-ref')?.textContent).toBe('Current title');

    await act(async () => {
      editor.dispatchEvent(new rendered.window.Event('compositionend'));
      await Promise.resolve();
    });

    expect(rendered.document.querySelector<HTMLElement>('.inline-ref')?.textContent).toBe('Renamed title');
  });

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
            ? `See ${MISSING_NODE_MARKER}`
            : '',
        },
      });
      editor.dispatchEvent(event);
    });

    expect(resolvePaste).toBeDefined();
    expect(pastedContent?.inlineRefs).toEqual([{
      offset: 4,
      target: { kind: 'node', nodeId: MISSING_NODE_ID },
      displayName: '11111111',
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

  test('synchronously applies Cmd+ArrowRight before a following Enter', () => {
    const splits: Parameters<NonNullable<EditorProps['onEnter']>>[0][] = [];
    const rendered = renderEditor({ text: 'Renamed report', marks: [], inlineRefs: [] }, {
      onEnter: (payload) => splits.push(payload),
    });
    const editor = rendered.document.querySelector<HTMLElement>('.ProseMirror')!;

    const moveToEnd = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(moveToEnd, {
      altKey: { value: false },
      ctrlKey: { value: false },
      key: { value: 'ArrowRight' },
      metaKey: { value: true },
      shiftKey: { value: false },
    });
    const enter = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(enter, {
      altKey: { value: false },
      ctrlKey: { value: false },
      key: { value: 'Enter' },
      metaKey: { value: false },
      shiftKey: { value: false },
    });

    act(() => {
      editor.dispatchEvent(moveToEnd);
      editor.dispatchEvent(enter);
    });

    expect(moveToEnd.defaultPrevented).toBe(true);
    expect(splits).toEqual([{
      after: { text: '', marks: [], inlineRefs: [] },
      atEnd: true,
      atStart: false,
      before: { text: 'Renamed report', marks: [], inlineRefs: [] },
    }]);
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
  return {
    document,
    rerender(nextContent: RichText, nextOverrides: Partial<EditorProps> = overrides) {
      act(() => {
        root.render(
          <EditorHarness
            content={nextContent}
            overrides={nextOverrides}
            onGlobalCommand={onGlobalCommand}
          />,
        );
      });
    },
    window,
  };
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
