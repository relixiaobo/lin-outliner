import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AdditionalContextPayload,
  Thread,
  ThreadContextPayloadReference,
  ThreadTurnDetailsReadResponse,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
} from '../../src/core/agent/protocol';
import { ThreadTurnDetailsPanel } from '../../src/renderer/agent/components/ThreadTurnDetailsPanel';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const mounted: Array<() => void> = [];
const FULL_TOOL_OUTPUT = '/workspace\nfull diagnostic output';
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

describe('ThreadTurnDetailsPanel', () => {
  test('renders each Provider Call in wire order with request, response, local execution, and audit evidence', async () => {
    const requests: Array<{ method: string; input: Record<string, unknown> }> = [];
    const detail = detailsResponse('thread-a', 'turn-a', 'fresh-a');
    const rendered = renderPanel(async (method, input) => {
      requests.push({ method, input });
      if (method === 'thread/turn/details/read') return detail;
      if (method === 'thread/context/read') return contextResponse(contextRef('c'), 'context-payload');
      if (method === 'thread/item/output/read') {
        return { output: { ref: toolOutputRef(), text: FULL_TOOL_OUTPUT } };
      }
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render('thread-a', 'turn-a');
    await flush();

    expect(requests.map((request) => request.method)).toEqual(['thread/turn/details/read']);
    const text = rendered.document.body.textContent;
    expect(text).toContain('Turn Diagnostics');
    expect(text).toContain('Overview');
    expect(text).toContain('Execution Timeline (2)');
    expect(text).toContain('Audit');
    expect(text).toContain('Canonical Items (3)');
    expect(text).toContain('Input tokens');
    expect(text).toContain('Accepted user input');
    expect(text).toContain('Effective configuration');
    expect(text).toContain('Stable prompt source blocks');
    expect(text).toContain('Canonical tool schemas (1)');
    expect(text).toContain('Resolved runtime configuration');
    expect(text).toContain('Provider Call 1');
    expect(text).toContain('Provider Call 2');
    expect(text).toContain('Request');
    expect(text).toContain('Response');
    expect(text).toContain('Local Execution (1)');
    expect(text).toContain('Prepared model context');
    expect(text).toContain('System instructions');
    expect(text).toContain('Tool definitions (1)');
    expect(text).toContain('Messages (1)');
    expect(text).toContain('Provider payload');
    expect(text).toContain('[0] Text part');
    expect(text).toContain('[1] System reminder · referencedResources');
    expect(text).toContain('[2] Attachment');
    expect(text).toContain('/workspace/report.pdf');
    expect(text).toContain('Done');

    const requestGroups = [...rendered.document.querySelectorAll('.thread-turn-details-request-group')];
    expect(requestGroups.map((group) => group.querySelector(':scope > h5')?.textContent)).toEqual([
      'Prepared model context',
      'Provider payload',
    ]);
    const providerFieldList = requestGroups[1]!.querySelector(
      ':scope > .thread-turn-details-request-fields > .thread-turn-details-request-fields',
    );
    expect(providerFieldList).not.toBeNull();
    const providerFields = [...providerFieldList!.children].map((element) => element.textContent?.trim());
    expect(providerFields).toEqual([
      'modeltest-model',
      expect.stringContaining('instructions'),
      expect.stringContaining('input'),
      expect.stringContaining('tools'),
    ]);
    expect(text.indexOf('System instructions')).toBeLessThan(text.indexOf('Tool definitions (1)'));
    expect(text.indexOf('Tool definitions (1)')).toBeLessThan(text.indexOf('Messages (1)'));
    expect(text.indexOf('Messages (1)')).toBeLessThan(text.indexOf('Provider payload'));
    expect(text).not.toContain('0. model');

    await openDetailsContaining(rendered.document, 'Response diagnostics');
    const responseText = rendered.document.body.textContent;
    expect(responseText).toContain('HTTP headers received at');
    expect(responseText).toContain('Time to HTTP headers');
    expect(responseText).toContain('Assistant response completed at');
    expect(responseText).toContain('Total call duration');
    expect(responseText).toContain('HTTP status');
    expect(responseText).toContain('Provider request ID');
    expect(responseText).toContain('request-1');
    expect(responseText).toContain('Stop reason');
    expect(responseText).toContain('Reported cache read');
    expect(responseText).toContain('Reported cache write');
    expect(responseText).toContain('Reported reasoning tokens');
    expect(responseText).toContain('Calculated cost');
    await openDetailsContaining(rendered.document, 'Provider Call 2');
    expect(rendered.document.body.textContent).toContain('Local Execution (0)');
    expect(rendered.document.body.textContent).toContain('No local execution was recorded for this call.');

    await openExecutionItem(rendered.document, 'commandExecution');
    await flush();
    expect(requests.at(-1)).toMatchObject({
      method: 'thread/item/output/read',
      input: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'tool-item' },
    });
    expect(rendered.document.body.textContent).toContain(FULL_TOOL_OUTPUT);

    await openDetailsContaining(rendered.document, 'Turn identity');
    expect(rendered.document.body.textContent).toContain('Context epochinitial');
    expect(rendered.document.body.textContent).toContain(`Cache affinity${'a'.repeat(64)}`);
    expect(rendered.document.body.textContent).toContain(`Diagnostics payload digest${'d'.repeat(64)}`);
    await openDetailsContaining(rendered.document, 'Stable prompt source blocks');
    await openDetailsContaining(rendered.document, 'L0 · framework');
    expect(rendered.document.body.textContent).toContain('Canonical stable prompt');
    expect(rendered.document.body.textContent).toContain('Stable prompt fingerprints');
    await openDetailsContaining(rendered.document, 'Provider payload JSON');
    expect(rendered.document.body.textContent).toContain('<system-reminder>');
    expect(rendered.document.body.textContent).toContain('/workspace/report.pdf');

    await openCanonicalContextItem(rendered.document);
    await flush();
    expect(requests.at(-1)).toMatchObject({
      method: 'thread/context/read',
      input: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'shared-context-item' },
    });
    expect(rendered.document.body.textContent).toContain('context-payload');
  });

  test('cannot apply an old details response after switching Thread and Turn targets', async () => {
    const stale = deferred<ThreadTurnDetailsReadResponse>();
    const rendered = renderPanel(async (_method, input) => (
      input.threadId === 'thread-a'
        ? stale.promise
        : detailsResponse('thread-b', 'turn-b', 'fresh-b')
    ));

    rendered.render('thread-a', 'turn-a');
    await flush();
    rendered.render('thread-b', 'turn-b');
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-b');

    stale.resolve(detailsResponse('thread-a', 'turn-a', 'stale-a'));
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-b');
    expect(rendered.document.body.textContent).not.toContain('stale-a');
  });

  test('cannot apply an old context response after switching Turn targets', async () => {
    const stale = deferred<ReturnType<typeof contextResponse>>();
    const rendered = renderPanel(async (method, input) => {
      if (method === 'thread/turn/details/read') {
        return detailsResponse(String(input.threadId), String(input.turnId), String(input.turnId));
      }
      if (method === 'thread/context/read') {
        return input.turnId === 'turn-a'
          ? stale.promise
          : contextResponse(contextRef('c'), 'fresh-context-b');
      }
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render('thread-a', 'turn-a');
    await flush();
    await openCanonicalContextItem(rendered.document);
    rendered.render('thread-b', 'turn-b');
    await flush();
    await openCanonicalContextItem(rendered.document);
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-context-b');

    stale.resolve(contextResponse(contextRef('c'), 'stale-context-a'));
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-context-b');
    expect(rendered.document.body.textContent).not.toContain('stale-context-a');
  });

  test('shows canonical Turn errors and Provider Call terminal status', async () => {
    const detail = detailsResponse('thread-a', 'turn-a', 'failed-turn');
    const firstCall = detail.diagnostics?.payload.providerCalls[0];
    const secondCall = detail.diagnostics?.payload.providerCalls[1];
    if (!detail.diagnostics || !firstCall || !secondCall) throw new Error('Missing diagnostics fixture');
    const failedDetail: ThreadTurnDetailsReadResponse = {
      ...detail,
      turn: {
        ...detail.turn,
        status: 'failed',
        error: { code: 'provider_error', message: 'Provider rejected the request.', detail: 'Quota exhausted.' },
      },
      diagnostics: {
        ...detail.diagnostics,
        payload: {
          ...detail.diagnostics.payload,
          providerCalls: [
            {
              ...firstCall,
              response: {
                ...firstCall.response!,
                stopReason: 'error',
                errorMessage: 'Quota exhausted.',
                value: { role: 'assistant', stopReason: 'error', errorMessage: 'Quota exhausted.' },
              },
            },
            {
              ...secondCall,
              response: {
                receivedAt: 40,
                stopReason: 'aborted',
                errorMessage: null,
                usage: providerUsage(),
                value: { role: 'assistant', stopReason: 'aborted' },
              },
            },
          ],
        },
      },
    };
    const rendered = renderPanel(async () => failedDetail);

    rendered.render('thread-a', 'turn-a');
    await flush();

    const text = rendered.document.body.textContent;
    expect(text).toContain('Turn errorProvider rejected the request.');
    expect(text).toContain('Error codeprovider_error');
    expect(text).toContain('Error detailQuota exhausted.');
    expect(text).toContain('Provider Call 1');
    expect(text).toContain('Failed');
    expect(text).toContain('Provider Call 2');
    expect(text).toContain('Interrupted');
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
      <ThreadTurnDetailsPanel
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

async function openDetailsContaining(document: Document, text: string): Promise<void> {
  const details = [...document.querySelectorAll<HTMLDetailsElement>('details')]
    .find((candidate) => candidate.querySelector(':scope > summary')?.textContent?.includes(text));
  if (!details) {
    const summaries = [...document.querySelectorAll('summary')].map((summary) => summary.textContent).join(' | ');
    throw new Error(`Missing disclosure: ${text}. Available: ${summaries}`);
  }
  await act(async () => {
    details.setAttribute('open', '');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
  });
}

async function openCanonicalContextItem(document: Document): Promise<void> {
  await openDetailsContaining(document, 'Canonical Items');
  const row = [...document.querySelectorAll<HTMLDetailsElement>('.thread-turn-details-item')]
    .find((candidate) => candidate.textContent?.includes('contextEvidence'));
  if (!row) throw new Error('Missing canonical context Item');
  await act(async () => {
    row.setAttribute('open', '');
    row.open = true;
    row.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
  });
}

async function openExecutionItem(document: Document, itemType: string): Promise<void> {
  const row = [...document.querySelectorAll<HTMLDetailsElement>('.thread-turn-details-item')]
    .find((candidate) => candidate.textContent?.includes(itemType));
  if (!row) throw new Error(`Missing execution Item: ${itemType}`);
  await act(async () => {
    row.setAttribute('open', '');
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

function detailsResponse(threadId: string, turnId: string, marker: string): ThreadTurnDetailsReadResponse {
  const payload = diagnosticsPayload(marker);
  const ref: TurnDiagnosticsPayloadReference = {
    id: 'd'.repeat(64),
    mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
    byteLength: JSON.stringify(payload).length,
    schemaVersion: 1,
  };
  const targetTurn = turn(threadId, turnId, contextRef('c'));
  return {
    thread: thread(threadId),
    turn: { ...targetTurn, execution: { ...targetTurn.execution, diagnosticsRef: ref } },
    diagnostics: { ref, payload },
  };
}

function diagnosticsPayload(marker: string): TurnDiagnosticsPayload {
  const userMessage = {
    role: 'user',
    content: [
      { type: 'text', text: marker },
      {
        type: 'text',
        text: [
          '<system-reminder>',
          '<context-evidence kind="referencedResources" authority="application" purpose="observation">',
          'readable_path=/workspace/report.pdf',
          '</context-evidence>',
          '</system-reminder>',
        ].join('\n'),
      },
      {
        type: 'text',
        text: '[Attachment: report.pdf, application/pdf, 42 bytes]\nReadable path: /workspace/report.pdf',
      },
    ],
    timestamp: 1,
  } as const;
  const messageId = 'e'.repeat(64);
  const inputFragmentId = '6'.repeat(64);
  const instructionFragmentId = '7'.repeat(64);
  const toolFragmentId = '8'.repeat(64);
  return {
    schemaVersion: 1,
    contextEpochId: 'initial',
    cacheAffinity: 'a'.repeat(64),
    configuration: {
      profileName: 'default',
      developerInstructions: ['Keep terminology exact.'],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: ['file_read'],
      skills: ['review'],
      plugins: [],
      mcpServers: [],
    },
    stablePrompt: {
      blocks: [{ id: 'framework', layer: 'L0', text: 'Canonical stable prompt', fingerprint: '1'.repeat(64) }],
      fingerprints: {
        l0: '1'.repeat(64),
        l1: '2'.repeat(64),
        l2: '3'.repeat(64),
        complete: '4'.repeat(64),
      },
    },
    toolSchemas: [{
      name: 'file_read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    runtime: {
      provider: 'openai',
      model: 'test-model',
      api: 'openai-responses',
      configuredBaseUrl: 'https://api.openai.com/v1',
      transportSelection: 'auto',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      thinkingLevel: 'medium',
      timeoutMs: 30_000,
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
      cacheRetention: 'short',
      toolExecution: 'parallel',
      steeringMode: 'all',
    },
    canonicalMessages: [{ id: messageId, estimatedTokens: 20, value: userMessage }],
    requestFragments: [
      { id: inputFragmentId, value: userMessage },
      { id: instructionFragmentId, value: 'Canonical stable prompt' },
      {
        id: toolFragmentId,
        value: {
          type: 'function',
          name: 'file_read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
    providerCalls: [
      {
        index: 0,
        requestedAt: 10,
        preparedContext: {
          systemPromptFragmentId: instructionFragmentId,
          toolNames: ['file_read'],
          messageIds: [messageId],
        },
        protectedFromMessageIndex: 0,
        estimatedInputTokens: 120,
        inputTokenLimit: 100_000,
        reservedOutputTokens: 8_192,
        commonPrefixMessageCount: 0,
        request: {
          kind: 'object',
          fields: [
            { name: 'model', representation: 'inline', value: 'test-model' },
            {
              name: 'instructions',
              representation: 'fragments',
              container: 'value',
              fragmentIds: [instructionFragmentId],
            },
            { name: 'input', representation: 'fragments', container: 'array', fragmentIds: [inputFragmentId] },
            { name: 'tools', representation: 'fragments', container: 'array', fragmentIds: [toolFragmentId] },
          ],
        },
        requestFingerprint: '5'.repeat(64),
        cacheBreakpoints: ['$.system[0].cache_control'],
        executionItemIds: ['tool-item'],
        transportResponse: { headersReceivedAt: 12, httpStatus: 200, requestId: 'request-1' },
        response: {
          receivedAt: 20,
          stopReason: 'stop',
          errorMessage: null,
          usage: providerUsage(),
          value: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
        },
      },
      {
        index: 1,
        requestedAt: 30,
        preparedContext: {
          systemPromptFragmentId: instructionFragmentId,
          toolNames: ['file_read'],
          messageIds: [messageId],
        },
        protectedFromMessageIndex: 0,
        estimatedInputTokens: 130,
        inputTokenLimit: 100_000,
        reservedOutputTokens: 8_192,
        commonPrefixMessageCount: 1,
        request: {
          kind: 'object',
          fields: [
            { name: 'model', representation: 'inline', value: 'test-model' },
            {
              name: 'instructions',
              representation: 'fragments',
              container: 'value',
              fragmentIds: [instructionFragmentId],
            },
            { name: 'input', representation: 'fragments', container: 'array', fragmentIds: [inputFragmentId] },
            { name: 'tools', representation: 'fragments', container: 'array', fragmentIds: [toolFragmentId] },
          ],
        },
        requestFingerprint: '6'.repeat(64),
        cacheBreakpoints: [],
        executionItemIds: [],
        transportResponse: null,
        response: null,
      },
    ],
  };
}

function providerUsage() {
  return {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 5,
    cacheWrite1h: null,
    reasoning: 4,
    totalTokens: 175,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
  };
}

function thread(id: string): Thread {
  return {
    id,
    sessionId: `${id}-session`,
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
  const userId = `${turnId}-user`;
  const contextId = 'shared-context-item';
  return {
    id: turnId,
    items: [
      {
        type: 'userMessage',
        id: userId,
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userId },
        clientId: null,
        acceptedAt: 1,
        content: [{ type: 'text', text: `Request ${turnId}` }],
      },
      {
        type: 'contextEvidence',
        id: contextId,
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: contextId },
        kind: 'additionalContext',
        payloadRef: ref,
        summary: 'Additional context',
        contextRefs: [],
        resourceRefs: [],
        outputRefs: [],
      },
      {
        type: 'commandExecution',
        id: 'tool-item',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: 'tool-item' },
        status: 'completed',
        outputRef: toolOutputRef(),
        command: 'pwd',
        cwd: '/workspace',
        processId: 'process-1',
        commandActions: [],
        aggregatedOutput: '/workspace',
        exitCode: 0,
        durationMs: 10,
      },
    ],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'test-model',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, totalTokens: 175, cost: null },
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

function toolOutputRef() {
  return {
    id: '9'.repeat(64),
    mimeType: 'text/plain' as const,
    byteLength: new TextEncoder().encode(FULL_TOOL_OUTPUT).byteLength,
    summary: 'Full command output',
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
