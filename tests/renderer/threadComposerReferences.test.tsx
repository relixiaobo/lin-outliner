import { afterEach, describe, expect, test } from 'bun:test';
import { act, createRef, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection } from '../../src/core/types';
import {
  ThreadComposerEditor,
  type ThreadComposerDraft,
  type ThreadComposerEditorHandle,
} from '../../src/renderer/agent/components/ThreadComposerEditor';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { buildIndex } from '../../src/renderer/state/document';
import { DocumentIndexStore } from '../../src/renderer/state/documentIndexStore';

const THREAD_ID = '01951d6e-7c25-7c31-8d62-313038616239';
const mounted: Array<() => void> = [];
const GLOBAL_KEYS = [
  'CustomEvent',
  'document',
  'Element',
  'Event',
  'getComputedStyle',
  'HTMLElement',
  'innerHeight',
  'innerWidth',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'window',
] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('ThreadComposerEditor Thread references', () => {
  test('preserves a structured atom through snapshot restore and history content restore', () => {
    const rendered = renderComposer();

    act(() => rendered.ref.current?.insertThreadReference({
      threadId: THREAD_ID,
      title: 'Launch research',
    }));
    expect(rendered.draft().content).toEqual([{
      type: 'threadReference',
      reference: { threadId: THREAD_ID, title: 'Launch research' },
    }, { type: 'text', text: ' ' }]);
    expect(rendered.document.querySelector('[data-thread-thread-ref]')?.textContent).toBe('Launch research');

    const snapshot = rendered.ref.current?.snapshot();
    expect(snapshot).not.toBeNull();
    act(() => rendered.ref.current?.clear());
    expect(rendered.draft().empty).toBe(true);
    act(() => rendered.ref.current?.restore(snapshot!));
    expect(rendered.draft().content).toEqual([{
      type: 'threadReference',
      reference: { threadId: THREAD_ID, title: 'Launch research' },
    }, { type: 'text', text: ' ' }]);

    act(() => rendered.ref.current?.setContent([{
      type: 'threadReference',
      reference: { threadId: THREAD_ID, title: 'Renamed launch research' },
    }], { selection: 'end' }));
    expect(rendered.draft().content).toEqual([{
      type: 'threadReference',
      reference: { threadId: THREAD_ID, title: 'Renamed launch research' },
    }]);
    expect(rendered.document.querySelector('[data-thread-thread-ref]')?.textContent)
      .toBe('Renamed launch research');
  });
});

function renderComposer(): {
  readonly document: Document;
  readonly draft: () => ThreadComposerDraft;
  readonly ref: React.RefObject<ThreadComposerEditorHandle | null>;
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  class ResizeObserverStub {
    disconnect() {}
    observe(_target: Element) {}
    unobserve(_target: Element) {}
  }
  Object.assign(window, {
    cancelAnimationFrame: () => undefined,
    getComputedStyle: () => ({ getPropertyValue: () => '', lineHeight: '20px' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    ResizeObserver: ResizeObserverStub,
  });
  Object.assign(document, {
    getSelection: () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      isCollapsed: true,
      rangeCount: 0,
      removeAllRanges: () => undefined,
    }),
  });
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    CustomEvent: window.CustomEvent,
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    getComputedStyle: window.getComputedStyle,
    HTMLElement: window.HTMLElement,
    innerHeight: 900,
    innerWidth: 1200,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    ResizeObserver: ResizeObserverStub,
    window,
  });
  (globalThis.window.HTMLElement.prototype as { focus?: () => void }).focus = () => undefined;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const ref = createRef<ThreadComposerEditorHandle>();
  let latestDraft: ThreadComposerDraft = {
    content: [],
    empty: true,
    fileRefs: [],
    pendingFileRefs: [],
    text: '',
  };
  const root = createRoot(document.getElementById('root')!);
  const props: ComponentProps<typeof ThreadComposerEditor> = {
    currentNodeId: null,
    indexStore: new DocumentIndexStore(buildIndex(emptyProjection())),
    isStreaming: false,
    onChange: (draft) => { latestDraft = draft; },
    onFilesPasted: () => undefined,
    onLargeTextPaste: () => null,
    onLocalFilePreview: async () => null,
    onLocalFileSearch: async () => [],
    onLocalFileSelect: async () => null,
    onNodeReferenceClick: () => undefined,
    onThreadReferenceClick: () => undefined,
    onThreadReferenceSearch: async () => [],
    onTextPasteRejected: () => undefined,
    recentLocalFiles: [],
    onStop: () => undefined,
    onSubmit: () => undefined,
    placeholder: 'Message this Thread',
    slashCommands: [],
  };
  act(() => root.render(
    <I18nProvider>
      <ThreadComposerEditor ref={ref} {...props} />
    </I18nProvider>,
  ));
  mounted.push(() => act(() => root.unmount()));
  return { document, draft: () => latestDraft, ref };
}

function emptyProjection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes: [],
  };
}
