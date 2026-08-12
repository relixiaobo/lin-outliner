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
  test('translates a budget interruption without rendering token counts', async () => {
    const base = detailsResponse('thread-budget', 'turn-budget', 'budget-marker');
    const detail: ThreadTurnDetailsReadResponse = {
      ...base,
      turn: {
        ...base.turn,
        status: 'interrupted',
        error: {
          message: 'Token budget exhausted mid-Turn (1234 of 1000 tokens)',
          code: 'subagent_budget_exhausted',
          detail: 'Internal budget receipt: 1234 tokens used',
        },
      },
    };
    const rendered = renderPanel(async (method) => {
      if (method === 'thread/turn/details/read') return detail;
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render('thread-budget', 'turn-budget');
    await flush();
    expect(rendered.document.body.textContent).toContain(
      'Task reached the system resource limit. Results have been preserved.',
    );
    expect(rendered.document.body.textContent).not.toContain('1234');
    expect(rendered.document.body.textContent).not.toContain('1000 tokens');
    expect(rendered.document.body.textContent).not.toContain('Internal budget receipt');
  });

  test('sanitizes Subagent canonical Items and never reads collaboration raw output', async () => {
    const base = detailsResponse('thread-subagent', 'turn-subagent', 'subagent-marker');
    const collaborationOutput = {
      id: 'b'.repeat(64),
      mimeType: 'application/json' as const,
      byteLength: 80,
      summary: 'tokensUsed: 9876, tokenBudget: 9000',
    };
    const detail: ThreadTurnDetailsReadResponse = {
      ...base,
      turn: {
        ...base.turn,
        items: [
          ...base.turn.items,
          {
            type: 'collabAgentToolCall',
            id: 'collaboration-item',
            provenance: {
              originThreadId: base.thread.id,
              originTurnId: base.turn.id,
              originItemId: 'collaboration-item',
            },
            status: 'completed',
            outputRef: collaborationOutput,
            tool: 'agent',
            senderThreadId: base.thread.id,
            receiverThreadIds: ['thread-child'],
            prompt: 'Research the issue',
            model: null,
            reasoningEffort: null,
            agentsStates: {
              'thread-child': {
                status: 'errored',
                taskPath: '/root/research',
                nickname: 'Researcher',
                role: 'worker',
              },
            },
          },
          {
            type: 'subAgentActivity',
            id: 'subagent-item',
            provenance: {
              originThreadId: base.thread.id,
              originTurnId: base.turn.id,
              originItemId: 'subagent-item',
            },
            kind: 'errored',
            agentThreadId: 'thread-child',
            agentPath: '/root/research',
            error: {
              message: 'Token budget exhausted (9876 of 9000 tokens)',
              code: 'subagent_budget_exhausted',
              detail: 'Internal receipt: 9876 tokens used',
            },
            spawnItemId: null,
          },
        ],
      },
    };
    const requests: string[] = [];
    const rendered = renderPanel(async (method) => {
      requests.push(method);
      if (method === 'thread/turn/details/read') return detail;
      if (method === 'thread/item/output/read') {
        return { output: { ref: collaborationOutput, text: '{"tokensUsed":9876,"tokenBudget":9000}' } };
      }
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render('thread-subagent', 'turn-subagent');
    await flush();
    await openDetailsContaining(rendered.document, 'Internal diagnostics');
    await openDetailsContaining(rendered.document, 'Canonical Items');
    await openExecutionItem(rendered.document, 'collabAgentToolCall');
    await openExecutionItem(rendered.document, 'subAgentActivity');
    await flush();

    const text = rendered.document.body.textContent ?? '';
    expect(requests).toEqual(['thread/turn/details/read']);
    expect(text).toContain('Task reached the system resource limit. Results have been preserved.');
    expect(text).toContain('/root/research');
    expect(text).not.toContain('tokensUsed');
    expect(text).not.toContain('tokenBudget');
    expect(text).not.toContain('9876');
    expect(text).not.toContain('9000');
    expect(text).not.toContain('Internal receipt');
  });

  test('renders the typed activity timeline and copies the complete model interaction', async () => {
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
    const initialText = rendered.document.body.textContent;
    expect(initialText).toContain('Model Interactions');
    expect(initialText).toContain('Summary');
    expect(initialText).toContain('Interaction Timeline (3)');
    expect(initialText).toContain('Internal diagnostics');
    expect(initialText).not.toContain('Canonical Items (3)');
    expect(initialText).toContain('Input tokens');
    expect(initialText).toContain('Model calls2');
    expect(initialText).toContain('Tool executions: 1');
    expect(initialText).not.toContain('Accepted user input');
    expect(initialText).not.toContain('Effective configuration');
    expect([...rendered.document.querySelectorAll(
      '.thread-turn-details-timeline > .thread-turn-details-timeline-activity > summary',
    )].map((summary) => summary.querySelector('strong')?.textContent)).toEqual([
      'Model Call 1',
      'Tool Execution (1)',
      'Model Call 2',
    ]);

    await openDetailsContaining(rendered.document, 'Model Call 1');
    const firstCall = [...rendered.document.querySelectorAll<HTMLDetailsElement>(
      '.thread-turn-details-timeline-activity',
    )].find((details) => details.querySelector(':scope > summary')?.textContent?.includes('Model Call 1'));
    if (!firstCall) throw new Error('Missing first Model Call');
    let callText = firstCall.textContent ?? '';
    expect(callText).toContain('Request');
    expect(callText).toContain('Response');
    expect(callText).toContain('Provider Request Content');
    expect(callText).not.toContain('System instructions');
    expect(callText).toContain('Model Response');
    expect(callText).not.toContain('Provider request JSON');
    expect(callText).not.toContain('Pre-adapter context');
    expect(callText).not.toContain('Request metadata');
    expect(callText).not.toContain('Normalized model response JSON');
    expect(callText).not.toContain('Response metadata');
    await openDetailsContaining(rendered.document, 'input');
    callText = firstCall.textContent ?? '';
    expect(callText).toContain('[0] Text part');
    expect(callText).toContain('[1] System Context');
    expect(callText).toContain('[2] Attachment');
    expect(callText).toContain('[3] Text part');
    expect(callText).toContain('/workspace/report.pdf');
    await openDetailsContaining(rendered.document, 'System Context');
    callText = firstCall.textContent ?? '';
    expect(callText).toContain('Referenced Resources · Application · Observation');
    expect(callText).toContain('Raw system context part');
    expect(callText).not.toContain('Available Skills');

    expect(rendered.document.querySelector('.thread-turn-details-request-facts-card')).toBeNull();

    const callInformation = firstCall.querySelector<HTMLButtonElement>(
      'button[aria-label="Model call information"]',
    );
    if (!callInformation) throw new Error('Missing first Model Call header actions');
    await act(async () => {
      callInformation.dispatchEvent(new Event('focusin', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    const requestFacts = rendered.document.querySelector('.thread-turn-details-request-facts-card');
    expect(requestFacts?.textContent).toContain('Model call information');
    expect(requestFacts?.textContent).toContain('Modeltest-model');
    expect(requestFacts?.textContent).toContain('Provideropenai');
    expect(requestFacts?.textContent).toContain('Provider parameters');
    expect(requestFacts?.textContent).toContain('streamtrue');
    expect(requestFacts?.textContent).toContain('storefalse');
    expect(requestFacts?.textContent).toContain('reasoning{ "effort": "medium" }');
    expect(requestFacts?.textContent).toContain('tool_choiceauto');
    expect(requestFacts?.textContent).toContain('parallel_tool_callstrue');
    expect(requestFacts?.textContent).toContain('Estimated input tokens120');
    expect(requestFacts?.textContent).toContain('Time to HTTP headers<1s');
    expect(requestFacts?.textContent).toContain('HTTP status200');
    expect(requestFacts?.textContent).toContain('Provider request IDrequest-1');
    expect(requestFacts?.textContent).toContain('Input token limit100,000');
    expect(requestFacts?.textContent).toContain('Reserved output tokens8,192');
    expect(requestFacts?.textContent).toContain('Stop reasonstop');
    expect(requestFacts?.textContent).toContain('Input100');
    expect(requestFacts?.textContent).toContain('Output20');
    expect(requestFacts?.textContent).toContain('Cache read50');
    expect(requestFacts?.textContent).toContain('Cache write5');
    expect(requestFacts?.textContent).toContain('Reported reasoning tokens4');
    expect(requestFacts?.textContent).toContain('Cost$0.00330');

    const clipboardWrites: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
    });
    const copyModelCall = firstCall.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy model call"]',
    );
    if (!copyModelCall) throw new Error('Missing Model Call copy action');
    const wasOpen = firstCall.open;
    await act(async () => {
      copyModelCall.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();
    expect(firstCall.open).toBe(wasOpen);
    expect(copyModelCall.getAttribute('aria-label')).toBe('Model call copied');
    expect(clipboardWrites).toHaveLength(1);
    const copiedCall = JSON.parse(clipboardWrites[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(copiedCall)).toEqual([
      'format', 'runtime', 'request', 'response', 'limitations',
    ]);
    expect(copiedCall).toMatchObject({
      format: 'tenon.model-call-diagnostics/v1',
      runtime: { provider: 'openai', model: 'test-model', api: 'openai-responses' },
      request: {
        modelContext: {
          systemInstructions: 'Canonical stable prompt',
          toolDefinitions: [{ name: 'file_read' }],
          messages: [{ value: detail.diagnostics?.payload.canonicalMessages[0]?.value }],
        },
        providerPayload: {
          model: 'test-model',
          instructions: 'Canonical stable prompt',
          input: [detail.diagnostics?.payload.canonicalMessages[0]?.value],
        },
        facts: { callIndex: 0, estimatedInputTokens: 120 },
      },
      response: {
        transport: { httpStatus: 200, requestId: 'request-1' },
        model: {
          stopReason: 'stop',
          usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5 },
          value: detail.diagnostics?.payload.providerCalls[0]?.response?.value,
        },
      },
      limitations: {
        imageBytes: 'omitted-with-byte-length-and-sha256',
        secretHeaders: 'not-recorded',
        rawProviderResponseBody: 'not-recorded',
      },
    });

    expect([...firstCall.querySelectorAll('.thread-turn-details-phase > h4')]
      .map((heading) => heading.textContent)).toEqual(['Request', 'Response']);

    const flowGroups = [...firstCall.querySelectorAll('.thread-turn-details-flow-group')];
    expect(flowGroups.map((group) => group.querySelector(':scope > h5')?.textContent)).toEqual([
      'Provider Request Content',
      'Model Response',
    ]);
    const providerFieldList = flowGroups[0]!.querySelector(
      ':scope > .thread-turn-details-flow-fields > .thread-turn-details-flow-fields',
    );
    expect(providerFieldList).not.toBeNull();
    const providerFields = [...providerFieldList!.children].map((element) => element.textContent?.trim());
    expect(providerFields).toEqual([
      expect.stringContaining('instructions'),
      expect.stringContaining('input'),
      expect.stringContaining('tools'),
    ]);
    expect(providerFieldList?.textContent).not.toContain('model');
    expect(providerFieldList?.textContent).not.toContain('stream');
    expect(callText).not.toContain('0. model');
    await openDetailsContaining(rendered.document, 'Tool Execution (1)');
    await openExecutionItem(rendered.document, 'commandExecution');
    await flush();
    expect(requests.at(-1)).toMatchObject({
      method: 'thread/item/output/read',
      input: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'tool-item' },
    });
    expect(rendered.document.body.textContent).toContain(FULL_TOOL_OUTPUT);

    await openDetailsContaining(rendered.document, 'Internal diagnostics');
    expect(rendered.document.body.textContent).toContain('Canonical Items (3)');
    expect(rendered.document.body.textContent).toContain('Input admission records');
    expect(rendered.document.body.textContent).toContain('Effective configuration');
    expect(rendered.document.body.textContent).toContain('Stable prompt source blocks');
    expect(rendered.document.body.textContent).toContain('Canonical tool schemas (1)');
    expect(rendered.document.body.textContent).toContain('Resolved runtime configuration');
    await openDetailsContaining(rendered.document, 'Turn identity');
    expect(rendered.document.body.textContent).toContain('Context epochinitial');
    expect(rendered.document.body.textContent).toContain(`Cache affinity${'a'.repeat(64)}`);
    expect(rendered.document.body.textContent).toContain(`Diagnostics payload digest${'d'.repeat(64)}`);
    await openDetailsContaining(rendered.document, 'Stable prompt source blocks');
    await openDetailsContaining(rendered.document, 'L0 · framework');
    expect(rendered.document.body.textContent).toContain('Canonical stable prompt');
    expect(rendered.document.body.textContent).toContain('Stable prompt fingerprints');
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
    await openDetailsContaining(rendered.document, 'input');
    expect(rendered.document.body.textContent).toContain('fresh-b');

    stale.resolve(detailsResponse('thread-a', 'turn-a', 'stale-a'));
    await flush();
    expect(rendered.document.body.textContent).toContain('fresh-b');
    expect(rendered.document.body.textContent).not.toContain('stale-a');
  });

  test('renders retry, compaction, and steering as sibling timeline activities', async () => {
    const detail = detailsResponse('thread-a', 'turn-a', 'timeline-a');
    if (!detail.diagnostics) throw new Error('Missing diagnostics fixture');
    const [initialInput, firstCall, toolBatch, secondCall] = detail.diagnostics.payload.activities;
    if (!initialInput || !firstCall || !toolBatch || !secondCall) throw new Error('Missing activity fixture');
    const expanded: ThreadTurnDetailsReadResponse = {
      ...detail,
      diagnostics: {
        ...detail.diagnostics,
        payload: {
          ...detail.diagnostics.payload,
          activities: [
            initialInput,
            firstCall,
            {
              type: 'providerRetry',
              retryKind: 'stream',
              attempt: 1,
              maxRetries: 1,
              occurredAt: 21,
              sourceCallIndex: 0,
              nextCallIndex: 1,
            },
            {
              type: 'contextCompaction',
              trigger: 'automaticPreflight',
              itemId: 'compaction-item',
              completedAt: 22,
              sourceCallIndex: 0,
              nextCallIndex: 1,
            },
            {
              type: 'acceptedInput',
              source: 'steering',
              acceptedAt: 23,
              itemIds: ['turn-a-user'],
              consumedByCallIndex: 1,
            },
            toolBatch,
            secondCall,
          ],
        },
      },
    };
    const rendered = renderPanel(async () => expanded);

    rendered.render('thread-a', 'turn-a');
    await flush();

    const timeline = rendered.document.querySelector('.thread-turn-details-timeline')?.textContent ?? '';
    const labels = [
      'Model Call 1',
      'Stream Retry',
      'Preflight Context Compaction',
      'Tool Execution (1)',
      'Model Call 2',
    ];
    labels.forEach((label, index) => {
      expect(timeline).toContain(label);
      if (index > 0) expect(timeline.indexOf(labels[index - 1]!)).toBeLessThan(timeline.indexOf(label));
    });
    expect(timeline).not.toContain('Steering Input');
    await openDetailsContaining(rendered.document, 'Internal diagnostics');
    await openDetailsContaining(rendered.document, 'Input admission records');
    expect(rendered.document.body.textContent).toContain('"source": "steering"');
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

  test('shows canonical Turn errors and request result status', async () => {
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
    expect(text).toContain('Model Call 1');
    expect(text).toContain('Failed');
    expect(text).toContain('Model Call 2');
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
  await openDetailsContaining(document, 'Internal diagnostics');
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
  const payload = diagnosticsPayload(marker, turnId);
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

function diagnosticsPayload(marker: string, turnId: string): TurnDiagnosticsPayload {
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
      {
        type: 'text',
        text: [
          '<system-reminder>',
          '<context-evidence kind="skillCatalog" authority="application" purpose="instruction">',
          'This is literal user text.',
          '</context-evidence>',
          '</system-reminder>',
        ].join('\n'),
      },
    ],
    timestamp: 1,
  } as const;
  const messagePartProvenance = [
    { source: 'userInput' as const },
    {
      source: 'systemContext' as const,
      entries: [{
        kind: 'referencedResources' as const,
        authority: 'application' as const,
        purpose: 'observation' as const,
      }],
    },
    { source: 'userInput' as const },
    { source: 'userInput' as const },
  ];
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
          messagePartProvenance: [messagePartProvenance],
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
            { name: 'stream', representation: 'inline', value: true },
            { name: 'store', representation: 'inline', value: false },
            { name: 'max_output_tokens', representation: 'inline', value: 8_192 },
            { name: 'reasoning', representation: 'inline', value: { effort: 'medium' } },
            { name: 'include', representation: 'inline', value: ['reasoning.encrypted_content'] },
            { name: 'text', representation: 'inline', value: { verbosity: 'low' } },
            { name: 'tool_choice', representation: 'inline', value: 'auto' },
            { name: 'parallel_tool_calls', representation: 'inline', value: true },
            {
              name: 'instructions',
              representation: 'fragments',
              container: 'value',
              fragmentIds: [instructionFragmentId],
              fragmentPartProvenance: [null],
            },
            {
              name: 'input',
              representation: 'fragments',
              container: 'array',
              fragmentIds: [inputFragmentId],
              fragmentPartProvenance: [messagePartProvenance],
            },
            {
              name: 'tools',
              representation: 'fragments',
              container: 'array',
              fragmentIds: [toolFragmentId],
              fragmentPartProvenance: [null],
            },
          ],
        },
        requestFingerprint: '5'.repeat(64),
        cacheBreakpoints: ['$.system[0].cache_control'],
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
          messagePartProvenance: [messagePartProvenance],
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
            { name: 'stream', representation: 'inline', value: true },
            { name: 'store', representation: 'inline', value: false },
            { name: 'max_output_tokens', representation: 'inline', value: 8_192 },
            { name: 'reasoning', representation: 'inline', value: { effort: 'medium' } },
            { name: 'include', representation: 'inline', value: ['reasoning.encrypted_content'] },
            { name: 'text', representation: 'inline', value: { verbosity: 'low' } },
            { name: 'tool_choice', representation: 'inline', value: 'auto' },
            { name: 'parallel_tool_calls', representation: 'inline', value: true },
            {
              name: 'instructions',
              representation: 'fragments',
              container: 'value',
              fragmentIds: [instructionFragmentId],
              fragmentPartProvenance: [null],
            },
            {
              name: 'input',
              representation: 'fragments',
              container: 'array',
              fragmentIds: [inputFragmentId],
              fragmentPartProvenance: [messagePartProvenance],
            },
            {
              name: 'tools',
              representation: 'fragments',
              container: 'array',
              fragmentIds: [toolFragmentId],
              fragmentPartProvenance: [null],
            },
          ],
        },
        requestFingerprint: '6'.repeat(64),
        cacheBreakpoints: [],
        transportResponse: null,
        response: null,
      },
    ],
    activities: [
      {
        type: 'acceptedInput',
        source: 'initial',
        acceptedAt: 1,
        itemIds: [`${turnId}-user`, 'shared-context-item'],
        consumedByCallIndex: 0,
      },
      { type: 'modelCall', callIndex: 0 },
      {
        type: 'toolExecutionBatch',
        sourceCallIndex: 0,
        consumedByCallIndex: 1,
        executions: [{
          callId: 'tool-call',
          toolName: 'bash',
          itemId: 'tool-item',
          startedAt: 21,
          completedAt: 29,
          status: 'completed',
        }],
      },
      { type: 'modelCall', callIndex: 1 },
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
    turnEntries: [{
      key: 'marker',
      source: 'test',
      authority: 'application',
      purpose: 'observation',
      text: marker,
    }],
    threadState: null,
  };
  return { context: { ref, payload } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
