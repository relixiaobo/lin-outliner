import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import type { DocumentProjection } from '../../src/core/types';
import { emptyTurnAnchors } from '../../src/renderer/agent/subagentPresentation';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { buildIndex } from '../../src/renderer/state/document';
import { DocumentIndexStore } from '../../src/renderer/state/documentIndexStore';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

// The identity mark is generated inline, so the component tree no longer pulls
// any bundler-only module; the dynamic import is simply how this file loads it.
async function loadThreadTurnView(): Promise<typeof import('../../src/renderer/agent/components/ThreadView')['ThreadTurnView']> {
  return (await import('../../src/renderer/agent/components/ThreadView')).ThreadTurnView;
}

const GLOBAL_KEYS = ['document', 'Event', 'HTMLElement', 'Node', 'ResizeObserver', 'window'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('streaming Turn item memoization', () => {
  test('re-renders the changed response Item without re-rendering an identity-stable user Item', async () => {
    const { document, root } = installDom();
    let userContentReads = 0;
    const content = [{ type: 'text' as const, text: 'Inspect the workspace.' }];
    const user = {
      id: 'user',
      provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'user' },
      type: 'userMessage' as const,
      author: { kind: 'reader' } as const,
      clientId: null,
      acceptedAt: 1,
      get content() {
        userContentReads += 1;
        return content;
      },
    } satisfies Extract<ThreadItem, { type: 'userMessage' }>;
    const response = agentResponse('A');
    const props = turnProps();
    const ThreadTurnView = await loadThreadTurnView();

    await render(root, <ThreadTurnView {...props} {...turnAnchors(turn([user, response]))} />);
    const readsAfterFirstRender = userContentReads;
    expect(readsAfterFirstRender).toBeGreaterThan(0);
    expect(document.querySelector('.thread-user-message')?.textContent).toContain('Inspect the workspace.');

    const changedResponse = { ...response, text: 'AB' };
    await render(root, <ThreadTurnView {...props} {...turnAnchors(turn([user, changedResponse]))} />);

    expect(userContentReads).toBe(readsAfterFirstRender);
    await act(async () => root.unmount());
  });

  test('does not re-render an identity-stable consecutive tool group for a response delta', async () => {
    const { root } = installDom();
    let outputReferenceReads = 0;
    const firstTool = command('first-tool', () => {
      outputReferenceReads += 1;
    });
    const secondTool = command('second-tool', () => undefined);
    const response = agentResponse('A');
    const baseProps = turnProps();
    const props = {
      ...baseProps,
      expandState: {
        ...baseProps.expandState,
        isExpanded: (id: string) => id.startsWith('tools:'),
      },
    };

    const ThreadTurnView = await loadThreadTurnView();
    await render(root, (
      <ThreadTurnView {...props} {...turnAnchors(turn([firstTool, secondTool, response]))} />
    ));
    const readsAfterFirstRender = outputReferenceReads;
    expect(readsAfterFirstRender).toBeGreaterThan(0);

    await render(root, (
      <ThreadTurnView
        {...props}
        {...turnAnchors(turn([firstTool, secondTool, { ...response, text: 'AB' }]))}
      />
    ));

    expect(outputReferenceReads).toBe(readsAfterFirstRender);
    await act(async () => root.unmount());
  });
});

describe('Turn provider recovery', () => {
  test('resolves canonical root-Thread input to the conversation Agent', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const notice = {
      ...userMessage('Delegated by the conversation Agent'),
      author: { kind: 'agent', threadId: 'thread' } as const,
    };

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(turn([notice]))}
      />
    ));

    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('Main Agent');
    expect(document.querySelector('.thread-host-event')?.textContent)
      .toContain('Delegated by the conversation Agent');
    await act(async () => root.unmount());
  });

  test('keeps a canonical delivery input neutral when its Agent registry entry is gone', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const notice = {
      ...userMessage('[Agent finished] Retained delivery evidence'),
      author: { kind: 'agent', threadId: 'missing-agent' } as const,
    };
    const value: Turn = {
      ...turn([notice]),
      provenance: {
        originThreadId: 'thread',
        originTurnId: 'turn',
        trigger: {
          kind: 'subagent',
          parentThreadId: 'thread',
          parentItemId: 'parent-tool',
        },
      },
      status: 'completed',
      completedAt: 2,
      durationMs: 1,
    };

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(value)}
        delivery={{ agentId: 'missing-agent', fromLatest: 0, generationIndex: 0 }}
      />
    ));

    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('From an Agent');
    expect(document.querySelector('.thread-host-event')?.textContent).toContain('Retained delivery evidence');
    expect(document.querySelector('[aria-label="Edit message"]')).toBeNull();
    await act(async () => root.unmount());
  });

  test('distinguishes request retries from stream reconnection', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const value = turn([userMessage('Wait for the provider')]);

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(value)}
        providerRetry={{ kind: 'request', attempt: 1, maxRetries: 5 }}
      />
    ));
    expect(document.querySelector('.thread-provider-retry')?.textContent).toBe('Retrying 1/5');

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(value)}
        providerRetry={{ kind: 'stream', attempt: 2, maxRetries: 5 }}
      />
    ));
    expect(document.querySelector('.thread-provider-retry')?.textContent).toBe('Reconnecting 2/5');
    await act(async () => root.unmount());
  });

  test('routes a host-authored failed Turn Retry through onRetryTurn only', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const failed = failedHostTurn();
    const retried: Turn[] = [];
    let editCalls = 0;

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failed)}
        onEditUserMessage={async () => { editCalls += 1; }}
        onRetryTurn={async (candidate) => { retried.push(candidate); }}
      />
    ));
    const retry = document.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(retried).toEqual([failed]);
    expect(editCalls).toBe(0);
    await act(async () => root.unmount());
  });
});

/** A Turn with no delegation in it: its own Items, no anchors. */
function turnAnchors(value: Turn) {
  return { turn: value, anchors: emptyTurnAnchors(value), delivery: null };
}

function turnProps() {
  return {
    active: true,
    agentEntries: new Map(),
    agentTranscript: false,
    canEditUserMessage: false,
    composerEnabled: true,
    expandState: {
      captureAnchor: () => undefined,
      holdAnchorUntilSettled: () => null,
      isExpanded: () => false,
      isFollowingBottom: () => false,
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
    indexStore: new DocumentIndexStore(buildIndex(emptyProjection())),
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
    onRetryTurn: async () => undefined,
    providerRetry: null,
    rootSpeaker: { participantId: 'main', avatarKey: 'main', name: 'Main Agent' },
    rootThreadId: 'thread',
    selfSpeaker: { participantId: 'main', avatarKey: 'main', name: 'Main Agent' },
    threadCwd: '/workspace',
    threadId: 'thread',
    threadsById: new Map(),
    waitingOnUserInput: false,
  } as const;
}

function userMessage(text: string): Extract<ThreadItem, { type: 'userMessage' }> {
  return {
    id: 'user',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'user' },
    type: 'userMessage',
    author: { kind: 'reader' },
    clientId: 'user-client-id',
    content: [{ type: 'text', text }],
    acceptedAt: 1,
  };
}

function failedHostTurn(): Turn {
  const notice = {
    ...userMessage('[Agent finished] Canonical host notice'),
    author: { kind: 'host' } as const,
  };
  return {
    ...turn([notice]),
    provenance: {
      originThreadId: 'thread',
      originTurnId: 'turn',
      trigger: {
        kind: 'subagent',
        parentThreadId: 'thread',
        parentItemId: 'parent-tool',
      },
    },
    status: 'failed',
    error: { code: 'runtime_failure', message: 'Provider unavailable' },
    completedAt: 2,
    durationMs: 1,
  };
}

function turn(items: readonly ThreadItem[]): Turn {
  return {
    id: 'turn',
    items,
    itemsView: 'full',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

function agentResponse(text: string): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    id: 'response',
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'response' },
    type: 'agentMessage',
    text,
    phase: 'final_answer',
    memoryCitation: null,
  };
}

function command(
  id: string,
  onOutputReferenceRead: () => void,
): Extract<ThreadItem, { type: 'commandExecution' }> {
  return {
    id,
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: id },
    type: 'commandExecution',
    command: 'pwd',
    description: 'Inspect the working directory',
    cwd: '/workspace',
    processId: null,
    status: 'completed',
    commandActions: [],
    aggregatedOutput: '/workspace',
    exitCode: 0,
    durationMs: 1,
    get outputRef() {
      onOutputReferenceRead();
      return null;
    },
    modelCall: replayableModelCall('bash', {
      command: 'pwd',
      description: 'Inspect the working directory',
    }),
  };
}

async function render(root: ReturnType<typeof createRoot>, view: ReactNode): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider>{view}</I18nProvider>);
    await Promise.resolve();
  });
}

function installDom(): { readonly document: Document; readonly root: ReturnType<typeof createRoot> } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  class ResizeObserverStub {
    disconnect() {}
    observe(_target: Element) {}
    unobserve(_target: Element) {}
  }
  Object.assign(window, {
    getComputedStyle: () => ({ lineHeight: '26px' }),
    lin: {
      initialLanguage: 'en',
      onLanguageChanged: () => () => undefined,
    },
    ResizeObserver: ResizeObserverStub,
  });
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    ResizeObserver: ResizeObserverStub,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  return { document, root: createRoot(container) };
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
