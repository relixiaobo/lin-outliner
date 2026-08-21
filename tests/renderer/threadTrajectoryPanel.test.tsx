import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AgentCoreMethod,
  AgentCoreRequestByMethod,
  AgentCoreResponseByMethod,
  ThreadTrajectoryDetailReadResponse,
  ThreadTrajectoryReadResponse,
} from '../../src/core/agent/protocol';
import { ThreadTrajectoryPanel } from '../../src/renderer/agent/components/ThreadTrajectoryPanel';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const THREAD_ID = '01910000-0000-7000-8000-000000000001';
const TURN_ID = '01910000-0000-7000-8000-000000000002';
const RECORD_ID = `turn:${TURN_ID}:assistant:0`;
const GLOBAL_KEYS = [
  'document',
  'window',
  'navigator',
  'Event',
  'HTMLElement',
  'MouseEvent',
  'Node',
] as const;

const mounted: Array<() => void> = [];
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('ThreadTrajectoryPanel', () => {
  test('loads a sanitized Trajectory window, details, and export action', async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const rendered = renderPanel(async (method, input) => {
      calls.push({ method, input });
      if (method === 'thread/trajectory/read') return trajectoryReadResponse();
      if (method === 'thread/trajectory/detail/read') return trajectoryDetailResponse();
      if (method === 'thread/trajectory/export') {
        return { status: 'written', fileName: 'trajectory.json', byteLength: 2048 };
      }
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();

    expect(rendered.document.body.textContent).toContain('Trajectory');
    expect(rendered.document.body.textContent).toContain('Assistant call 1');
    expect(rendered.document.body.textContent).toContain('Mock response');
    expect(rendered.document.body.textContent).toContain('Primary evidence');

    clickButton(rendered.document, 'Request');
    await flush();
    expect(rendered.document.body.textContent).toContain('Read ‹path:redacted›');
    expect(rendered.document.body.textContent).not.toContain('/Users/example/project');

    clickButton(rendered.document, 'Export');
    clickButton(rendered.document, 'Export Thread Trajectory');
    await flush();
    expect(rendered.document.body.textContent).toContain('Exported trajectory.json (2,048 bytes).');
    expect(calls.map((call) => call.method)).toEqual([
      'thread/trajectory/read',
      'thread/trajectory/detail/read',
      'thread/trajectory/export',
    ]);
  });
});

function renderPanel(
  agentCoreRequest: <Method extends AgentCoreMethod>(
    method: Method,
    input: AgentCoreRequestByMethod[Method],
  ) => Promise<AgentCoreResponseByMethod[Method]>,
) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(Date.now());
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    lin: {
      initialLanguage: 'en',
      agentCoreRequest,
      onAgentCoreNotification: () => () => undefined,
      onLanguageChanged: () => () => undefined,
    },
  });
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Missing root element');
  const root = createRoot(rootElement);
  return {
    document,
    render: () => {
      act(() => {
        root.render(
          <I18nProvider>
            <ThreadTrajectoryPanel
              canGoBack
              onBack={() => undefined}
              onClose={() => undefined}
              showClose
              threadId={THREAD_ID}
              turnId={TURN_ID}
            />
          </I18nProvider>,
        );
      });
      mounted.push(() => act(() => root.unmount()));
    },
  };
}

function trajectoryReadResponse(): ThreadTrajectoryReadResponse {
  return {
    threadId: THREAD_ID,
    summary: {
      threadId: THREAD_ID,
      turnCount: 1,
      recordCount: 1,
      inputCount: 0,
      contextCount: 0,
      assistantCount: 1,
      toolCount: 0,
      retryCount: 0,
      compactionCount: 0,
      delegationCount: 0,
      startedAt: 100,
      completedAt: 130,
      durationMs: 30,
      usage: {
        input: 120,
        output: 24,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: 144,
        costUsd: 0.001,
      },
      availability: [],
    },
    records: [{
      id: RECORD_ID,
      kind: 'assistant',
      lane: 'assistant',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 0,
      parentRecordId: null,
      title: 'Assistant call 1',
      subtitle: 'openai · gpt-5',
      preview: 'Mock response',
      state: 'completed',
      timing: { startedAt: 100, firstTokenAt: null, completedAt: 130, durationMs: 30 },
      usage: {
        input: 120,
        output: 24,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: 144,
        costUsd: 0.001,
      },
      primaryEvidence: { type: 'providerCall', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0 },
      relatedEvidence: [],
      availability: [],
      childThreadId: null,
    }],
    nextCursor: null,
    hasMore: false,
    selectedRecordId: RECORD_ID,
  };
}

function trajectoryDetailResponse(): ThreadTrajectoryDetailReadResponse {
  return {
    threadId: THREAD_ID,
    record: trajectoryReadResponse().records[0],
    detail: {
      kind: 'assistant',
      turn: {
        id: TURN_ID,
        status: 'completed',
        error: null,
        startedAt: 100,
        completedAt: 130,
        durationMs: 30,
        modelProvider: 'openai',
        model: 'gpt-5',
        reasoningEffort: 'medium',
      },
      diagnostics: {
        ref: {
          id: 'a'.repeat(64),
          mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
          byteLength: 1024,
          schemaVersion: 1,
        },
        runtime: {
          provider: 'openai',
          model: 'gpt-5',
          api: 'responses',
          transportSelection: 'sse',
          contextWindow: 128000,
          maxOutputTokens: 8192,
          thinkingLevel: 'medium',
          timeoutMs: null,
          maxRetries: 2,
          maxRetryDelayMs: 1000,
          cacheRetention: 'short',
          toolExecution: 'parallel',
          steeringMode: 'all',
        },
        activity: null,
        providerCall: {
          index: 0,
          requestedAt: 100,
          estimatedInputTokens: 120,
          inputTokenLimit: 128000,
          reservedOutputTokens: 8192,
          commonPrefixMessageCount: 0,
          requestFingerprint: 'b'.repeat(64),
          cacheBreakpoints: [],
          request: { input: 'Read ‹path:redacted›' },
          response: { outputText: 'Mock response' },
          transportResponse: { headersReceivedAt: 101, httpStatus: 200, requestId: 'req_1' },
        },
      },
      providerCallIndex: 0,
      relatedItems: [],
    },
  };
}

function clickButton(document: Document, name: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  act(() => button.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function installDomGlobals(window: Window): void {
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      ...window.navigator,
      clipboard: { writeText: async () => undefined },
    },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
