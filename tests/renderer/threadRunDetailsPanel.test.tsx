import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AdditionalContextPayload,
  Thread,
  ThreadContextPayloadReference,
  Turn,
} from '../../src/core/agent/protocol';
import { ThreadRunDetailsPanel } from '../../src/renderer/agent/components/ThreadRunDetailsPanel';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const mounted: Array<() => void> = [];
const GLOBAL_KEYS = [
  'document',
  'window',
  'navigator',
  'Event',
  'HTMLElement',
  'MouseEvent',
  'Node',
] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('ThreadRunDetailsPanel context payloads', () => {
  test('cannot apply an old context response after switching Thread and Turn targets', async () => {
    const staleContext = deferred<ReturnType<typeof contextResponse>>();
    const requests: Array<{ method: string; input: Record<string, unknown> }> = [];
    const rendered = renderPanel(async (method, input) => {
      requests.push({ method, input });
      const threadId = String(input.threadId);
      if (method === 'thread/read') return { thread: thread(threadId) };
      if (method === 'thread/turns/list') {
        const turnId = threadId === 'thread-a' ? 'turn-a' : 'turn-b';
        const ref = contextRef(threadId === 'thread-a' ? 'a' : 'b');
        return { data: [turn(threadId, turnId, ref)], nextCursor: null, backwardsCursor: null };
      }
      if (method === 'thread/context/read') {
        if (threadId === 'thread-a') return staleContext.promise;
        return contextResponse(contextRef('b'), 'fresh-b');
      }
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render('thread-a', 'turn-a');
    await flush();
    await openContextRow(rendered.document);
    expect(requests.some((request) => (
      request.method === 'thread/context/read' && request.input.threadId === 'thread-a'
    ))).toBe(true);

    rendered.render('thread-b', 'turn-b');
    await flush();
    await openContextRow(rendered.document);
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-b');

    staleContext.resolve(contextResponse(contextRef('a'), 'stale-a'));
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-b');
    expect(rendered.document.body.textContent).not.toContain('stale-a');
  });
});

function renderPanel(
  request: (method: string, input: Record<string, unknown>) => Promise<unknown>,
): { document: Document; render: (threadId: string, turnId: string) => void } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      onLanguageChanged: () => () => undefined,
      agentCoreRequest: request,
    },
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const render = (threadId: string, turnId: string) => act(() => root.render(
    <I18nProvider>
      <ThreadRunDetailsPanel
        canGoBack={false}
        onBack={() => undefined}
        onClose={() => undefined}
        showClose={false}
        threadId={threadId}
        turnId={turnId}
      />
    </I18nProvider>,
  ));
  mounted.push(() => act(() => root.unmount()));
  return { document, render };
}

async function openContextRow(document: Document): Promise<void> {
  const card = document.querySelector<HTMLDetailsElement>('.thread-run-details-execution-card');
  if (!card) throw new Error('Missing Turn execution card');
  await act(async () => {
    card.open = true;
    card.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
  });
  const row = document.querySelector<HTMLDetailsElement>('.thread-run-details-execution-event');
  if (!row) throw new Error('Missing context evidence row');
  await act(async () => {
    row.open = true;
    row.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

function thread(id: string): Thread {
  return {
    id,
    sessionId: id,
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: id,
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    status: { type: 'idle' },
    historyMode: 'paginated',
  };
}

function turn(threadId: string, turnId: string, ref: ThreadContextPayloadReference): Turn {
  const itemId = 'shared-context-item';
  return {
    id: turnId,
    items: [{
      type: 'contextEvidence',
      id: itemId,
      provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
      kind: 'additionalContext',
      payloadRef: ref,
      summary: 'Additional context',
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [],
    }],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'test-model',
      reasoningEffort: 'medium',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: null },
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function contextRef(seed: string): ThreadContextPayloadReference {
  return {
    id: seed.repeat(64),
    mimeType: 'application/vnd.tenon.agent-context+json',
    byteLength: 1,
    schemaVersion: 1,
    kind: 'additionalContext',
  };
}

function contextResponse(ref: ThreadContextPayloadReference, marker: string) {
  const payload: AdditionalContextPayload = {
    schemaVersion: 1,
    kind: 'additionalContext',
    entries: [{
      key: 'marker',
      source: 'test',
      authority: 'application',
      purpose: 'observation',
      text: marker,
    }],
  };
  return { context: { ref, payload } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
