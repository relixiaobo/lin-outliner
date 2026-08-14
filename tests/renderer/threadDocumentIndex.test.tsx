import { afterEach, describe, expect, test } from 'bun:test';
import { act, Profiler, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import { formatNodeReferenceIdMarker, formatNodeReferenceMarker } from '../../src/core/referenceMarkup';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';
import {
  ThreadView,
  ThreadTurnView,
  threadDocumentNodeIds,
} from '../../src/renderer/agent/components/ThreadView';
import {
  useThreadStore,
  type ThreadSnapshotSource,
  type ThreadStoreSnapshot,
} from '../../src/renderer/agent/store/threadStore';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { reduceProjection } from '../../src/renderer/state/document';
import { DocumentIndexStore } from '../../src/renderer/state/documentIndexStore';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

const GLOBAL_KEYS = [
  'document',
  'Element',
  'Event',
  'HTMLElement',
  'navigator',
  'Node',
  'ResizeObserver',
  'window',
] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('Thread document subscriptions', () => {
  test('collects every index-derived Node id in a Turn', () => {
    const items: ThreadItem[] = [
      userMessage([{ type: 'nodeReference', nodeId: 'node-a' }]),
      agentMessage(`Read ${formatNodeReferenceIdMarker('node-b')}`),
      reasoning(formatNodeReferenceMarker('Named', 'node-c')),
      dynamicNodeTool('node_read', { node_id: 'node-d', node_ids: ['node-e', 'node-d'] }),
      dynamicNodeTool('node_search', { query: 'node-not-a-subject' }),
    ];

    expect(threadDocumentNodeIds(completedTurn(items))).toEqual([
      'node-a',
      'node-b',
      'node-c',
      'node-d',
      'node-e',
    ]);
  });

  test('does not re-render a Turn for an unrelated document delta', async () => {
    const { root } = installDom();
    const target = node('node-a', 'Alpha');
    const unrelated = node('node-b', 'Before');
    const state = fullState([target, unrelated]);
    const store = new DocumentIndexStore(state.index);
    let contentReads = 0;
    const content = [{ type: 'nodeReference' as const, nodeId: target.id }];
    const item = {
      ...userMessage(content),
      get content() {
        contentReads += 1;
        return content;
      },
    };
    const turn = completedTurn([item]);

    await render(root, <ThreadTurnView {...turnProps(store)} turn={turn} />);
    const readsAfterMount = contentReads;
    const next = patchState(state, [{ ...unrelated, content: richText('After'), updatedAt: 2 }]);
    await act(async () => {
      store.commit(next.index);
      await Promise.resolve();
    });

    expect(contentReads).toBe(readsAfterMount);
    await act(async () => root.unmount());
  });

  test('refreshes reference chips, tool subjects, process headers, and derived color', async () => {
    const { document, root } = installDom();
    const target = node('node-a', 'Alpha', { parentId: 'root', tags: ['tag-work'] });
    const tag = node('tag-work', 'Work', {
      children: ['tag-work::cfg:color'],
      parentId: 'schema',
      type: 'tagDef',
    });
    const colorConfig = node('tag-work::cfg:color', 'color', {
      children: ['tag-work::cfg:color/value'],
      configKey: 'color',
      parentId: tag.id,
      type: 'defConfig',
    });
    const colorValue = node('tag-work::cfg:color/value', 'red', { parentId: colorConfig.id });
    const state = fullState([target, tag, colorConfig, colorValue]);
    const store = new DocumentIndexStore(state.index);
    const turn = completedTurn([
      userMessage([{ type: 'nodeReference', nodeId: target.id }]),
      dynamicNodeTool('node_read', { node_id: target.id }),
    ]);

    await render(root, <ThreadTurnView {...turnProps(store)} turn={turn} />);
    const chip = () => document.querySelector<HTMLElement>('.thread-message-inline-ref');
    const tool = () => document.querySelector<HTMLElement>('.thread-tool-activity-summary, .thread-tool-label');
    const process = () => document.querySelector<HTMLElement>('.thread-process-title');
    expect(chip()?.textContent).toBe('Alpha');
    expect(chip()?.getAttribute('style')).toContain('var(--identity-tint-0)');
    expect(tool()?.textContent).toContain('Alpha');
    expect(process()?.textContent).toContain('Alpha');

    const renamedTarget = { ...target, content: richText('Beta'), updatedAt: 2 };
    const renamed = patchState(state, [renamedTarget]);
    await act(async () => {
      store.commit(renamed.index);
      await Promise.resolve();
    });
    expect(chip()?.textContent).toBe('Beta');
    expect(tool()?.textContent).toContain('Beta');
    expect(process()?.textContent).toContain('Beta');

    const recolored = patchState(renamed, [{ ...colorValue, content: richText('blue'), updatedAt: 3 }]);
    await act(async () => {
      store.commit(recolored.index);
      await Promise.resolve();
    });
    expect(chip()?.getAttribute('style')).toContain('var(--identity-tint-5)');
    await act(async () => root.unmount());
  });

  test('freezes while inactive, catches up on reopen, and copies the latest title', async () => {
    const { clipboardWrites, document, root } = installDom();
    const target = node('node-a', 'Alpha');
    const state = fullState([target]);
    const store = new DocumentIndexStore(state.index);
    const turn = completedTurn([userMessage([{ type: 'nodeReference', nodeId: target.id }])]);
    const props = turnProps(store);

    await render(root, <ThreadTurnView {...props} active={false} turn={turn} />);
    const renamed = patchState(state, [{ ...target, content: richText('Beta'), updatedAt: 2 }]);
    await act(async () => {
      store.commit(renamed.index);
      await Promise.resolve();
    });
    expect(document.querySelector('.thread-message-inline-ref')?.textContent).toBe('Alpha');

    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]');
    expect(copy).not.toBeNull();
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });
    expect(clipboardWrites).toEqual(['Beta']);

    await render(root, <ThreadTurnView {...props} active turn={turn} />);
    expect(document.querySelector('.thread-message-inline-ref')?.textContent).toBe('Beta');
    await act(async () => root.unmount());
  });

  test('keeps the composer draft, attachment lifecycle, and scroll DOM across close and reopen', async () => {
    const { document, root } = installDom();
    const state = fullState([node('node-a', 'Alpha')]);
    const store = new DocumentIndexStore(state.index);
    const props = threadViewProps(store);

    await render(root, <ThreadView {...props} active />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const view = document.querySelector<HTMLElement>('.thread-view');
    const transcript = document.querySelector<HTMLElement>('.thread-transcript');
    const editor = document.querySelector<HTMLElement>('.ProseMirror');
    expect(view).not.toBeNull();
    expect(transcript).not.toBeNull();
    expect(editor).not.toBeNull();
    if (transcript) transcript.scrollTop = 37;
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [], getData: () => 'Draft note' },
    });
    await act(async () => {
      editor?.dispatchEvent(paste);
      await Promise.resolve();
    });
    expect(editor?.textContent).toContain('Draft note');

    await render(root, <ThreadView {...props} active={false} />);
    await render(root, <ThreadView {...props} active />);
    expect(document.querySelector('.thread-view')).toBe(view);
    expect(document.querySelector('.thread-transcript')).toBe(transcript);
    // Drafts and staged attachments share this mounted ThreadView lifecycle;
    // preserving the editor node prevents the attachment cleanup from running.
    expect(document.querySelector('.ProseMirror')).toBe(editor);
    expect(document.querySelector<HTMLElement>('.thread-transcript')?.scrollTop).toBe(37);
    expect(document.querySelector('.ProseMirror')?.textContent).toContain('Draft note');
    await act(async () => root.unmount());
  });

  test('does not commit ThreadView for a document delta while the mention menu is closed', async () => {
    const { root } = installDom();
    const target = node('node-a', 'Alpha');
    const unrelated = node('node-b', 'Before');
    const state = fullState([target, unrelated]);
    const store = new DocumentIndexStore(state.index);
    let commits = 0;

    await render(root, (
      <Profiler id="thread-view" onRender={() => { commits += 1; }}>
        <ThreadView {...threadViewProps(store)} active />
      </Profiler>
    ));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const commitsAfterMount = commits;
    const next = patchState(state, [{ ...unrelated, content: richText('After'), updatedAt: 2 }]);
    await act(async () => {
      store.commit(next.index);
      await Promise.resolve();
    });

    expect(commits).toBe(commitsAfterMount);
    await act(async () => root.unmount());
  });
});

describe('paused Thread store subscription', () => {
  test('does not render while closed and catches up when reopened', async () => {
    const { document, root } = installDom();
    const source = new MutableThreadSnapshotSource(threadSnapshot(true));
    let renders = 0;
    const Probe = ({ active }: { active: boolean }) => {
      renders += 1;
      const snapshot = useThreadStore(active, source);
      return <span>{snapshot.loading ? 'loading' : 'ready'}</span>;
    };

    await render(root, <Probe active />);
    await render(root, <Probe active={false} />);
    const rendersAfterClose = renders;
    await act(async () => {
      source.commit(threadSnapshot(false));
      await Promise.resolve();
    });
    expect(renders).toBe(rendersAfterClose);
    expect(document.body.textContent).toContain('loading');

    await render(root, <Probe active />);
    expect(document.body.textContent).toContain('ready');
    await act(async () => root.unmount());
  });
});

class MutableThreadSnapshotSource implements ThreadSnapshotSource {
  private readonly listeners = new Set<() => void>();

  constructor(private snapshot: ThreadStoreSnapshot) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  commit(snapshot: ThreadStoreSnapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

function threadSnapshot(loading: boolean): ThreadStoreSnapshot {
  return {
    threads: [],
    selectedThreadId: null,
    turnsByThread: new Map(),
    latestTurnByThread: new Map(),
    configurationsByThread: new Map(),
    goalsByThread: new Map(),
    userInputByThread: new Map(),
    providerRetryByThread: new Map(),
    planByThread: new Map(),
    loading,
    error: null,
  };
}

function turnProps(indexStore: DocumentIndexStore) {
  return {
    active: true,
    canEditUserMessage: false,
    composerEnabled: true,
    expandState: {
      captureAnchor: () => undefined,
      holdAnchorUntilSettled: () => null,
      isExpanded: () => false,
      restoreAnchor: () => undefined,
      toggle: () => undefined,
    },
    getUserView: () => ({
      activePanelId: null,
      focusedNodeId: null,
      focusedPanelId: null,
      focusSurface: null,
      panels: [],
      selectedNodeIds: [],
      truncated: false,
    }),
    indexStore,
    isLastTurn: true,
    latchedReasoning: new Set<string>(),
    latestTurnByThread: new Map(),
    liveReasoningSeen: new Set<string>(),
    onContinueInNewChat: async () => undefined,
    onEditUserMessage: async () => undefined,
    onInterruptThread: async () => undefined,
    onOpenNodeReference: () => undefined,
    onOpenThread: async () => undefined,
    onOpenTurnDetails: () => undefined,
    onReadToolArguments: async () => null,
    onReadToolOutput: async () => null,
    providerRetry: null,
    threadCwd: '/workspace',
    threadId: 'thread',
    threadsById: new Map(),
    waitingOnUserInput: false,
  } as const;
}

function threadViewProps(indexStore: DocumentIndexStore) {
  return {
    composerEnabled: true,
    composerFocusToken: 0,
    configuration: null,
    getUserView: turnProps(indexStore).getUserView,
    goal: null,
    indexStore,
    inputRequest: null,
    latestTurnByThread: new Map(),
    onConfigurationChange: async () => undefined,
    onContinueInNewChat: async () => undefined,
    onCreateThread: async () => false,
    onEditUserMessage: async () => undefined,
    onInterrupt: async () => undefined,
    onInterruptThread: async () => undefined,
    onOpenNodeReference: () => undefined,
    onOpenThread: async () => undefined,
    onOpenTurnDetails: () => undefined,
    onReadToolArguments: async () => null,
    onReadToolOutput: async () => null,
    onSend: async () => null,
    onSubmitUserInput: async () => undefined,
    plan: null,
    providerRetry: null,
    providerSettings: null,
    providerSettingsLoaded: false,
    slashCommands: [],
    threadCreationBlocked: false,
    threadCreationPending: false,
    threadCwd: '/workspace',
    threadId: 'thread',
    threadModelProvider: 'openai',
    threadsById: new Map(),
    turns: [],
    waitingOnUserInput: false,
  } as const;
}

function completedTurn(items: readonly ThreadItem[]): Turn {
  return {
    id: 'turn',
    items,
    itemsView: 'full',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', trigger: { kind: 'user' } },
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: null,
  };
}

function userMessage(
  content: Extract<ThreadItem, { type: 'userMessage' }>['content'],
): Extract<ThreadItem, { type: 'userMessage' }> {
  return {
    id: 'user',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'user' },
    type: 'userMessage',
    clientId: null,
    content,
    acceptedAt: 1,
  };
}

function agentMessage(text: string): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    id: 'agent',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'agent' },
    type: 'agentMessage',
    text,
    phase: 'final_answer',
    memoryCitation: null,
  };
}

function reasoning(text: string): Extract<ThreadItem, { type: 'reasoning' }> {
  return {
    id: 'reasoning',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'reasoning' },
    type: 'reasoning',
    summary: [text],
    content: [],
  };
}

function dynamicNodeTool(
  tool: string,
  args: Record<string, unknown>,
): Extract<ThreadItem, { type: 'dynamicToolCall' }> {
  return {
    id: `tool-${tool}`,
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: `tool-${tool}` },
    type: 'dynamicToolCall',
    status: 'completed',
    outputRef: null,
    namespace: null,
    tool,
    arguments: args as never,
    contentItems: null,
    success: true,
    durationMs: 1,
    modelCall: replayableModelCall(tool, args as never),
  };
}

type ProjectionState = NonNullable<ReturnType<typeof reduceProjection>>;

function fullState(nodes: readonly NodeProjection[]): ProjectionState {
  const state = reduceProjection(null, {
    kind: 'full',
    projection: projection(nodes),
    revision: 1,
  });
  if (!state) throw new Error('Expected a full projection state');
  return state;
}

function patchState(state: ProjectionState, changedNodes: readonly NodeProjection[]): ProjectionState {
  const next = reduceProjection(state, {
    kind: 'delta',
    revision: state.revision + 1,
    todayId: 'today',
    changedNodes: [...changedNodes],
    removedIds: [],
  });
  if (!next) throw new Error('Expected a patched projection state');
  return next;
}

function projection(nodes: readonly NodeProjection[]): DocumentProjection {
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
    nodes: [...nodes],
  };
}

function node(
  id: string,
  text: string,
  patch: Partial<NodeProjection> = {},
): NodeProjection {
  return {
    id,
    children: [],
    content: richText(text),
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

function richText(text: string) {
  return { text, marks: [], inlineRefs: [] };
}

async function render(root: ReturnType<typeof createRoot>, view: ReactNode): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider>{view}</I18nProvider>);
    await Promise.resolve();
  });
}

function installDom(): {
  readonly clipboardWrites: string[];
  readonly document: Document;
  readonly root: ReturnType<typeof createRoot>;
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const clipboardWrites: string[] = [];
  const navigatorStub = {
    clipboard: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  };
  class ResizeObserverStub {
    disconnect() {}
    observe(_target: Element) {}
    unobserve(_target: Element) {}
  }
  Object.assign(window, {
    cancelAnimationFrame: (_id: number) => undefined,
    getComputedStyle: () => ({ lineHeight: '26px' }),
    getSelection: () => null,
    lin: {
      initialLanguage: 'en',
      onLanguageChanged: () => () => undefined,
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(Date.now());
      return 1;
    },
    ResizeObserver: ResizeObserverStub,
  });
  Object.defineProperty(document, 'getSelection', {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(window, 'navigator', {
    configurable: true,
    value: navigatorStub,
  });
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    navigator: navigatorStub,
    Node: window.Node,
    ResizeObserver: ResizeObserverStub,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  return { clipboardWrites, document, root: createRoot(container) };
}
