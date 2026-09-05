import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import type { DocumentProjection } from '../../src/core/types';
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
        isExpanded: (id: string, defaultExpanded = false) => id.startsWith('tools:') || defaultExpanded,
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
  test('filters content-free input for every author before opening a visible run', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const authors = [
      { kind: 'reader' } as const,
      { kind: 'host' } as const,
      { kind: 'feature', feature: 'automation', ref: 'execution' } as const,
    ];
    const items = authors.map((author, index) => {
      const item = blankUserMessage(`blank-${index}`, author);
      return index === 0 ? { ...item, content: [] } : item;
    });
    const value: Turn = {
      ...turn([...items, agentResponse('Visible answer')]),
      status: 'completed',
      completedAt: 2,
      durationMs: null,
    };

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(value)}
      />
    ));

    expect(document.querySelectorAll('.thread-speaker')).toHaveLength(1);
    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('Main Agent');
    expect(document.querySelector('.thread-agent-message')?.textContent).toContain('Visible answer');
    expect(document.querySelector('.thread-user-message')).toBeNull();
    expect(document.querySelector('.thread-user-content-sequence')).toBeNull();
    expect(document.querySelector('.thread-message-actions-slot')).toBeNull();
    await act(async () => root.unmount());
  });

  test('keeps attachment-only and Node-reference-only reader input visible', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const attachmentOnly: Extract<ThreadItem, { type: 'userMessage' }> = {
      ...userMessage(''),
      id: 'attachment-only',
      provenance: {
        originThreadId: 'thread',
        originTurnId: 'turn',
        originItemId: 'attachment-only',
      },
      content: [{
        type: 'attachment',
        id: 'attachment',
        name: 'evidence.txt',
        mimeType: 'text/plain',
        sizeBytes: 8,
        source: { kind: 'localFile', path: '/workspace/evidence.txt' },
      }],
    };
    const nodeOnly: Extract<ThreadItem, { type: 'userMessage' }> = {
      ...userMessage(''),
      id: 'node-only',
      provenance: {
        originThreadId: 'thread',
        originTurnId: 'turn',
        originItemId: 'node-only',
      },
      content: [{ type: 'nodeReference', nodeId: 'node:alpha', note: 'Alpha' }],
    };
    const value: Turn = {
      ...turn([attachmentOnly, nodeOnly]),
      status: 'completed',
      completedAt: 2,
      durationMs: null,
    };

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(value)}
      />
    ));

    expect(document.querySelectorAll('.thread-user-message')).toHaveLength(2);
    expect(document.querySelector('.thread-message-file-ref')?.textContent).toContain('evidence.txt');
    expect(document.querySelector('.thread-message-inline-ref')?.textContent).toBe('Alpha');
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

  test('routes a host-authored failed Turn Rerun through onRerunTurn only', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const failed = failedHostTurn();
    const rerunTurns: Turn[] = [];
    let editCalls = 0;

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failed)}
        onEditUserMessage={async () => { editCalls += 1; }}
        onReadTurnRecovery={async () => ({
          canContinue: false,
          canRerun: true,
          rerunRequiresConfirmation: false,
        })}
        onRerunTurn={async (candidate) => { rerunTurns.push(candidate); }}
      />
    ));
    await act(async () => {
      await Promise.resolve();
    });
    const rerun = document.querySelector<HTMLButtonElement>('button[aria-label="Rerun turn"]');
    expect(rerun).not.toBeNull();
    await act(async () => {
      rerun?.click();
      await Promise.resolve();
    });

    expect(rerunTurns).toEqual([failed]);
    expect(editCalls).toBe(0);
    await act(async () => root.unmount());
  });

  test('orders Continue and Rerun before the ordinary response actions', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const base = failedHostTurn();
    const failed = { ...base, items: [...base.items, agentResponse('Settled partial result')] };
    const continued: Turn[] = [];
    const rerun: Array<{ turn: Turn; confirmed: boolean }> = [];

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failed)}
        onContinueTurn={async (candidate) => { continued.push(candidate); }}
        onReadTurnRecovery={async () => ({
          canContinue: true,
          canRerun: true,
          rerunRequiresConfirmation: false,
        })}
        onRerunTurn={async (candidate, confirmed) => { rerun.push({ turn: candidate, confirmed }); }}
      />
    ));
    await act(async () => { await Promise.resolve(); });

    expect([...document.querySelectorAll<HTMLButtonElement>('.thread-response-actions button')]
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Continue from failure',
      'Rerun turn',
      'Copy message',
      'Continue in new chat',
      'Open Trajectory',
    ]);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Continue from failure"]')?.click();
      await Promise.resolve();
    });
    expect(continued).toEqual([failed]);
    expect(rerun).toEqual([]);
    await act(async () => root.unmount());
  });

  test('does not repeat a recovery probe when only its callback identity changes', async () => {
    const { root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const failed = { ...failedHostTurn(), items: [agentResponse('Settled partial result')] };
    let reads = 0;
    const recovery = async () => {
      reads += 1;
      return { canContinue: true, canRerun: true, rerunRequiresConfirmation: false };
    };

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failed)}
        onReadTurnRecovery={() => recovery()}
      />
    ));
    await act(async () => { await Promise.resolve(); });
    expect(reads).toBe(1);

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failed)}
        onReadTurnRecovery={() => recovery()}
      />
    ));
    await act(async () => { await Promise.resolve(); });
    expect(reads).toBe(1);
    await act(async () => root.unmount());
  });

  test('confirms a settled-tool Rerun and sends no mutation when canceled', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();
    const base = failedHostTurn();
    const failed = { ...base, items: [...base.items, command('settled-tool', () => undefined)] };
    const rerunConfirmations: boolean[] = [];

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failed)}
        onReadTurnRecovery={async () => ({
          canContinue: true,
          canRerun: true,
          rerunRequiresConfirmation: true,
        })}
        onRerunTurn={async (_candidate, confirmed) => { rerunConfirmations.push(confirmed); }}
      />
    ));
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rerun turn"]')?.click();
    });
    expect(document.querySelector('.confirm-dialog')?.textContent).toContain('may repeat them');
    const dialogButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.confirm-dialog button')];
    await act(async () => { dialogButtons().find((button) => button.textContent === 'Cancel')?.click(); });
    expect(rerunConfirmations).toEqual([]);
    expect(document.querySelector('.confirm-dialog')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rerun turn"]')?.click();
    });
    await act(async () => {
      dialogButtons().find((button) => button.textContent === 'Rerun turn')?.click();
      await Promise.resolve();
    });
    expect(rerunConfirmations).toEqual([true]);
    await act(async () => root.unmount());
  });

  test('hides recovery actions when the capability read fails', async () => {
    const { document, root } = installDom();
    const ThreadTurnView = await loadThreadTurnView();

    await render(root, (
      <ThreadTurnView
        {...turnProps()}
        {...turnAnchors(failedHostTurn())}
        onReadTurnRecovery={async () => { throw new Error('read failed'); }}
      />
    ));
    await act(async () => { await Promise.resolve(); });

    expect(document.querySelector('button[aria-label="Continue from failure"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Rerun turn"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});

function turnAnchors(value: Turn) {
  return { turn: value };
}

function turnProps() {
  return {
    active: true,
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
    liveReasoningSeen: new Set<string>(),
    onContinueTurn: async () => undefined,
    onContinueInNewChat: async () => undefined,
    onEditUserMessage: async () => undefined,
    onOpenNodeReference: () => undefined,
    onOpenThreadReference: async () => undefined,
    onOpenTurnDetails: () => undefined,
    onReadToolArguments: async () => null,
    onReadToolOutput: async () => null,
    onReadTurnRecovery: async () => ({
      canContinue: false,
      canRerun: false,
      rerunRequiresConfirmation: false,
    }),
    onRerunTurn: async () => undefined,
    providerRetry: null,
    selfSpeaker: { participantId: 'main', avatarKey: 'main', name: 'Main Agent' },
    threadCwd: '/workspace',
    threadId: 'thread',
    threadReferences: new Map(),
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

function blankUserMessage(
  id: string,
  author: Extract<ThreadItem, { type: 'userMessage' }>['author'],
): Extract<ThreadItem, { type: 'userMessage' }> {
  return {
    ...userMessage(' \n\t'),
    id,
    author,
    provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: id },
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
      trigger: { kind: 'user' },
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
