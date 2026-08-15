import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import type { DocumentProjection } from '../../src/core/types';
import { ThreadTurnView } from '../../src/renderer/agent/components/ThreadView';
import { emptyTurnAnchors } from '../../src/renderer/agent/subagentPresentation';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { buildIndex } from '../../src/renderer/state/document';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

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
      clientId: null,
      acceptedAt: 1,
      get content() {
        userContentReads += 1;
        return content;
      },
    } satisfies Extract<ThreadItem, { type: 'userMessage' }>;
    const response = agentResponse('A');
    const props = turnProps();

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

/** A Turn with no delegation in it: its own Items, no anchors. */
function turnAnchors(value: Turn) {
  return { turn: value, anchors: emptyTurnAnchors(value), delivery: null };
}

function turnProps() {
  return {
    canEditUserMessage: false,
    composerEnabled: true,
    expandState: {
      captureAnchor: () => undefined,
      holdAnchorUntilSettled: () => null,
      isExpanded: () => false,
      restoreAnchor: () => undefined,
      toggle: () => undefined,
    },
    index: buildIndex(emptyProjection()),
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
    selfSpeaker: { identity: 'main', name: 'main' },
    threadCwd: '/workspace',
    threadId: 'thread',
    threadsById: new Map(),
    userView: {
      activePanelId: null,
      focusedNodeId: null,
      focusedPanelId: null,
      focusSurface: null,
      panels: [],
      selectedNodeIds: [],
      truncated: false,
    },
    waitingOnUserInput: false,
  } as const;
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
