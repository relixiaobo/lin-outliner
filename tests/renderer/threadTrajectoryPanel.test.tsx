import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AgentCoreNotification,
  AgentCoreMethod,
  AgentCoreRequestByMethod,
  AgentCoreResponseByMethod,
  JsonValue,
  ThreadTrajectoryDetailReadResponse,
  ThreadTrajectoryDiagnosticsEvidence,
  ThreadTrajectoryReadResponse,
  ThreadTrajectoryRecordSummary,
} from '../../src/core/agent/protocol';
import { ThreadTrajectoryPanel } from '../../src/renderer/agent/components/ThreadTrajectoryPanel';
import {
  buildTrajectoryLedgerRows,
  buildTrajectoryTimeline,
  trajectoryRecordsInRange,
  trajectorySearchMatches,
} from '../../src/renderer/agent/components/trajectory/trajectoryModel';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const THREAD_ID = '01910000-0000-7000-8000-000000000001';
const TURN_ID = '01910000-0000-7000-8000-000000000002';
const CHILD_THREAD_ID = '01910000-0000-7000-8000-000000000003';
const INPUT_ID = `turn:${TURN_ID}:input:0`;
const CONTEXT_ID = `turn:${TURN_ID}:context:prepared:0:0:1`;
const TOOL_CATALOG_ID = `turn:${TURN_ID}:context:tools:0`;
const ASSISTANT_ID = `turn:${TURN_ID}:assistant:0`;
const TOOL_ID = `turn:${TURN_ID}:tool:2:call%3Aread`;
const DELEGATION_ID = `turn:${TURN_ID}:delegation:2:call%3Aagent`;
const GLOBAL_KEYS = [
  'document',
  'window',
  'navigator',
  'Event',
  'HTMLElement',
  'KeyboardEvent',
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
  test('keeps the ledger message-first and opens sanitized Assistant evidence lazily', async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const rendered = renderPanel(async (method, input) => {
      calls.push({ method, input });
      if (method === 'thread/trajectory/read') return trajectoryReadResponse();
      if (method === 'thread/trajectory/detail/read') return assistantDetailResponse();
      if (method === 'thread/trajectory/export') {
        return { status: 'written', fileName: 'trajectory.json', byteLength: 2048 };
      }
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();

    expect(rendered.document.querySelector('[aria-label="Trajectory inspector"]')).toBeNull();
    expect(recordRow(rendered.document, ASSISTANT_ID).textContent).toContain('ASSISTANTMock response');
    expect(recordRow(rendered.document, ASSISTANT_ID).textContent).not.toContain('Assistant call 1');
    expect(calls.map((call) => call.method)).toEqual(['thread/trajectory/read']);

    clickRecord(rendered.document, ASSISTANT_ID);
    await flush();

    expect(buttonLabels(rendered.document)).toEqual(expect.arrayContaining(['Summary', 'Preview', 'Raw']));
    expect(rendered.document.body.textContent).toContain('Request #1');
    expect(rendered.document.body.textContent).toContain('Mock response');

    clickButton(rendered.document, 'Raw');
    expect(rendered.document.body.textContent).toContain('Read ‹path:redacted›');
    expect(rendered.document.body.textContent).not.toContain('/Users/example/project');

    clickAriaButton(rendered.document, 'Export Thread Trajectory');
    await flush();
    expect(rendered.document.body.textContent).toContain('Exported trajectory.json (2,048 bytes).');
    expect(calls.map((call) => call.method)).toEqual([
      'thread/trajectory/read',
      'thread/trajectory/detail/read',
      'thread/trajectory/export',
    ]);
  });

  test('preserves Turn and Assistant-call hierarchy while folding', async () => {
    const rendered = renderPanel(async (method) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse();
      if (method === 'thread/trajectory/detail/read') return assistantDetailResponse();
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();

    clickTitleButton(rendered.document, 'Collapse all Assistant calls');
    expect(recordRowOrNull(rendered.document, TOOL_ID)).toBeNull();
    expect(recordRow(rendered.document, ASSISTANT_ID).textContent).toContain('1 record');

    clickTitleButton(rendered.document, 'Collapse all Turns');
    expect(rendered.document.querySelectorAll('[data-trajectory-record-id]').length).toBe(1);
    expect(recordRow(rendered.document, INPUT_ID).textContent).toContain('USERPlan the release');
    expect(rendered.document.body.textContent).toContain('2 records');
  });

  test('shows Tool payload, result, and schema tabs and supports keyboard inspector resizing', async () => {
    const rendered = renderPanel(async (method, input) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse();
      if (method === 'thread/trajectory/detail/read') {
        expect(input).toEqual({ threadId: THREAD_ID, recordId: TOOL_ID });
        return toolDetailResponse();
      }
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();
    clickRecord(rendered.document, TOOL_ID);
    await flush();

    expect(buttonLabels(rendered.document)).toEqual(expect.arrayContaining([
      'Summary', 'Input', 'Output', 'Schema', 'Raw',
    ]));
    clickButton(rendered.document, 'Input');
    expect(rendered.document.body.textContent).toContain('package.json');
    clickButton(rendered.document, 'Output');
    expect(rendered.document.body.textContent).toContain('Read 42 lines');
    clickButton(rendered.document, 'Schema');
    expect(rendered.document.body.textContent).toContain('Read a UTF-8 file');

    const resize = ariaButton(rendered.document, 'Resize Trajectory inspector');
    act(() => {
      const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: 'ArrowLeft' });
      resize.dispatchEvent(event);
    });
    const inspector = rendered.document.querySelector<HTMLElement>('[aria-label="Trajectory inspector"]');
    expect(inspector?.style.width).toBe('320px');

    clickAriaButton(rendered.document, 'Close Trajectory inspector');
    expect(rendered.document.querySelector('[aria-label="Trajectory inspector"]')).toBeNull();
  });

  test('consumes Turn focus once so live refresh does not reopen a closed inspector', async () => {
    const readInputs: AgentCoreRequestByMethod['thread/trajectory/read'][] = [];
    const rendered = renderPanel(async (method, input) => {
      if (method === 'thread/trajectory/read') {
        readInputs.push(input);
        return trajectoryReadResponse(
          trajectoryRecords(),
          input.focus?.turnId === TURN_ID ? ASSISTANT_ID : null,
        );
      }
      if (method === 'thread/trajectory/detail/read') return assistantDetailResponse();
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    }, { turnId: TURN_ID });

    rendered.render();
    await flush();
    await flush();

    expect(readInputs[0]?.focus).toEqual({ recordId: null, turnId: TURN_ID });
    expect(rendered.document.querySelector('[aria-label="Trajectory inspector"]')).not.toBeNull();

    clickAriaButton(rendered.document, 'Close Trajectory inspector');
    await flush();
    expect(rendered.document.querySelector('[aria-label="Trajectory inspector"]')).toBeNull();

    rendered.notify({
      type: 'turn/providerRetry/changed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      status: null,
    });
    await wait(150);
    await flush();

    expect(readInputs.at(-1)?.focus).toBeNull();
    expect(rendered.document.querySelector('[aria-label="Trajectory inspector"]')).toBeNull();
  });

  test('renders provider-visible tool catalog records as first-class Tools evidence', async () => {
    const toolCatalog = record({
      id: TOOL_CATALOG_ID,
      kind: 'context',
      lane: 'input',
      sequence: 0,
      title: 'Available Tools',
      subtitle: '2 tools · Request #1',
      preview: 'first_tool, second_tool',
      primaryEvidence: {
        type: 'toolCatalog',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callIndex: 0,
      },
      relatedEvidence: [{ type: 'providerCall', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0 }],
    });
    const rendered = renderPanel(async (method, request) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse([toolCatalog]);
      if (method === 'thread/trajectory/detail/read') {
        expect(request).toEqual({ threadId: THREAD_ID, recordId: TOOL_CATALOG_ID });
        return contextDetailResponse(toolCatalog, {
          kind: 'toolCatalog',
          requestIndex: 0,
          toolNames: ['first_tool', 'second_tool'],
          tools: [
            { name: 'first_tool', description: 'First tool', parameters: { type: 'object' } },
            { name: 'second_tool', description: 'Second tool', parameters: { type: 'object' } },
          ],
        });
      }
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();
    expect(recordRow(rendered.document, TOOL_CATALOG_ID).textContent).toContain('TOOLSAvailable Tools');

    clickRecord(rendered.document, TOOL_CATALOG_ID);
    await flush();
    expect(buttonLabels(rendered.document)).toEqual(expect.arrayContaining(['Tools', 'Raw']));
    expect(rendered.document.body.textContent).toContain('first_tool');
    expect(rendered.document.body.textContent).toContain('First tool');
  });

  test('renders USER preview from the canonical user message instead of the accepted context envelope', async () => {
    const input = record({
      id: INPUT_ID,
      kind: 'input',
      lane: 'input',
      sequence: 0,
      title: 'Input',
      preview: 'nihao',
      primaryEvidence: {
        type: 'threadItem',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'user-message-1',
      },
      relatedEvidence: [
        {
          type: 'diagnosticActivity',
          threadId: THREAD_ID,
          turnId: TURN_ID,
          activityIndex: 0,
          activityType: 'acceptedInput',
        },
        { type: 'providerCall', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0 },
      ],
    });
    const context = record({
      id: CONTEXT_ID,
      kind: 'context',
      lane: 'input',
      sequence: 1,
      title: 'Turn Environment',
      subtitle: 'application · observation',
      preview: '<context-evidence kind="turnEnvironment">working_directory=/workspace</context-evidence>',
      primaryEvidence: {
        type: 'preparedContextPart',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callIndex: 0,
        messageIndex: 0,
        partIndex: 1,
      },
    });
    const rendered = renderPanel(async (method, request) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse([input, context]);
      if (method === 'thread/trajectory/detail/read') {
        expect(request).toEqual({ threadId: THREAD_ID, recordId: INPUT_ID });
        return inputDetailResponse(input);
      }
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();
    expect(recordRow(rendered.document, INPUT_ID).textContent).toContain('USERnihao');
    expect(recordRow(rendered.document, context.id).textContent).toContain('CONTEXTTurn Environment');

    clickRecord(rendered.document, INPUT_ID);
    await flush();
    clickButton(rendered.document, 'Preview');
    const inspector = rendered.document.querySelector<HTMLElement>('[aria-label="Trajectory inspector"]');
    expect(inspector?.textContent).toContain('nihao');
    expect(inspector?.textContent).not.toContain('Turn environment');

    clickButton(rendered.document, 'Request');
    await flush();
    expect(inspector?.textContent).toContain('"model": "gpt-5"');
    expect(inspector?.textContent).toContain('"text": "nihao"');
  });

  test('renders CONTEXT preview from captured model context text instead of the item summary', async () => {
    const context = record({
      id: CONTEXT_ID,
      kind: 'context',
      lane: 'input',
      sequence: 0,
      title: 'Skill Catalog',
      subtitle: 'application · instruction',
      preview: 'Available Skills (2)',
      primaryEvidence: {
        type: 'preparedContextPart',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callIndex: 0,
        messageIndex: 0,
        partIndex: 1,
      },
    });
    const modelContextText = [
      '<system-reminder>',
      '<context-evidence kind="skillCatalog" authority="application" purpose="instruction">',
      'Use Browser Pilot for signed-in browser work.',
      'Use code-review for local diffs and pull requests.',
      '</context-evidence>',
      '</system-reminder>',
    ].join('\n');
    const rendered = renderPanel(async (method, request) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse([context]);
      if (method === 'thread/trajectory/detail/read') {
        expect(request).toEqual({ threadId: THREAD_ID, recordId: context.id });
        return contextDetailResponse(context, null, modelContextText);
      }
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();
    expect(recordRow(rendered.document, context.id).textContent).toContain('CONTEXTSkill Catalog · Available Skills (2)');

    clickRecord(rendered.document, context.id);
    await flush();
    const inspector = rendered.document.querySelector<HTMLElement>('[aria-label="Trajectory inspector"]');
    expect(inspector?.textContent).toContain('Sourceapplication · instruction');
    expect(inspector?.textContent).toContain('<system-reminder>');
    expect(inspector?.textContent).toContain('<context-evidence kind="skillCatalog"');
    expect(inspector?.textContent).toContain('Use Browser Pilot for signed-in browser work.');
    expect(inspector?.textContent).not.toContain('Available Skills (2)');

    clickButton(rendered.document, 'Preview');
    expect(inspector?.textContent).toContain('Use code-review for local diffs and pull requests.');

    clickButton(rendered.document, 'Raw');
    expect(inspector?.textContent).toContain('"item": null');
    expect(inspector?.textContent).toContain('"modelContextText"');
  });

  test('opens a delegation target as the child Thread own Trajectory', async () => {
    const opened: string[] = [];
    const delegation = record({
      id: DELEGATION_ID,
      kind: 'delegation',
      lane: 'tools',
      sequence: 0,
      title: 'Agent delegation',
      preview: 'Inspect the renderer',
      childThreadId: CHILD_THREAD_ID,
      primaryEvidence: {
        type: 'toolExecution',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: 2,
        callId: 'call:agent',
      },
    });
    const rendered = renderPanel(async (method) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse([delegation]);
      if (method === 'thread/trajectory/detail/read') return delegationDetailResponse(delegation);
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    }, {
      onOpenThreadTrajectory: (threadId) => opened.push(threadId),
    });

    rendered.render();
    await flush();
    clickRecord(rendered.document, DELEGATION_ID);
    await flush();
    clickButton(rendered.document, 'Open child Trajectory');
    expect(opened).toEqual([CHILD_THREAD_ID]);
  });

  test('mounts a bounded virtual window for a long loaded Thread', async () => {
    const records = Array.from({ length: 140 }, (_, index) => record({
      id: `turn:${TURN_ID}:input:${index}`,
      kind: 'input',
      lane: 'input',
      sequence: index,
      title: 'Input',
      preview: `Message ${index + 1}`,
      timing: { startedAt: 100 + index, firstTokenAt: null, completedAt: 100 + index, durationMs: 0 },
      primaryEvidence: {
        type: 'diagnosticActivity',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: index,
        activityType: 'acceptedInput',
      },
    }));
    const rendered = renderPanel(async (method) => {
      if (method === 'thread/trajectory/read') return trajectoryReadResponse(records);
      if (method === 'thread/trajectory/detail/read') return assistantDetailResponse();
      if (method === 'thread/trajectory/export') return { status: 'canceled' };
      throw new Error(`Unexpected Agent Core method: ${method}`);
    });

    rendered.render();
    await flush();

    const table = rendered.document.querySelector('table[aria-rowcount="140"]');
    expect(table).not.toBeNull();
    const mountedRows = rendered.document.querySelectorAll('[data-trajectory-record-id]').length;
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(100);
    expect(rendered.document.querySelector('.thread-trajectory-virtual-spacer')).not.toBeNull();
  });
});

describe('Trajectory projection model', () => {
  test('derives truthful duration geometry and range membership without fabricating untimed spans', () => {
    const records = trajectoryRecords();
    const untimed = record({
      id: `turn:${TURN_ID}:context:untimed`,
      kind: 'context',
      lane: 'input',
      sequence: records.length,
      title: 'Context reset',
      preview: null,
      timing: { startedAt: null, firstTokenAt: null, completedAt: null, durationMs: null },
      primaryEvidence: { type: 'threadTurn', threadId: THREAD_ID, turnId: TURN_ID },
    });
    const duration = buildTrajectoryTimeline([...records, untimed], 'duration');
    expect(duration?.start).toBe(100);
    expect(duration?.end).toBe(220);
    expect(duration?.unpositionedCount).toBe(1);
    expect(duration?.spans.find((span) => span.record.id === INPUT_ID)?.marker).toBe(true);
    expect(trajectoryRecordsInRange(duration, { start: 205, end: 215 })).toEqual(new Set([TOOL_ID]));

    const sequence = buildTrajectoryTimeline([...records, untimed], 'sequence');
    expect(sequence?.spans.map((span) => [span.start, span.end])).toEqual([
      [0, 1], [1, 2], [2, 3], [3, 4],
    ]);
  });

  test('keeps matching children attached to their Assistant row and applies folds after search', () => {
    const records = trajectoryRecords();
    const matches = trajectorySearchMatches(records, 'package');
    const rows = buildTrajectoryLedgerRows({
      collapsedCalls: new Set(),
      collapsedTurns: new Set(),
      rangeMatches: null,
      records,
      searchMatches: matches,
    });
    expect(rows.flatMap((row) => row.type === 'record' ? [row.record.id] : [])).toEqual([
      ASSISTANT_ID,
      TOOL_ID,
    ]);

    const folded = buildTrajectoryLedgerRows({
      collapsedCalls: new Set([ASSISTANT_ID]),
      collapsedTurns: new Set(),
      rangeMatches: null,
      records,
      searchMatches: matches,
    });
    expect(folded.flatMap((row) => row.type === 'record' ? [row.record.id] : [])).toEqual([
      ASSISTANT_ID,
    ]);
  });

  test('keeps system-level prompt and tool catalog rows outside Turn folds', () => {
    const system = record({
      id: `turn:${TURN_ID}:context`,
      kind: 'context',
      lane: 'input',
      sequence: 0,
      title: 'Initial System Prompt',
      primaryEvidence: { type: 'stablePrompt', threadId: THREAD_ID, turnId: TURN_ID },
    });
    const tools = record({
      id: TOOL_CATALOG_ID,
      kind: 'context',
      lane: 'input',
      sequence: 1,
      title: 'Available Tools',
      primaryEvidence: { type: 'toolCatalog', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0 },
    });
    const input = record({
      ...trajectoryRecords()[0]!,
      sequence: 2,
    });
    const assistant = record({
      ...trajectoryRecords()[1]!,
      sequence: 3,
    });

    const rows = buildTrajectoryLedgerRows({
      collapsedCalls: new Set(),
      collapsedTurns: new Set([TURN_ID]),
      rangeMatches: null,
      records: [system, tools, input, assistant],
      searchMatches: null,
    });

    expect(rows.map((row) => row.type === 'record' ? row.record.id : row.type)).toEqual([
      system.id,
      tools.id,
      input.id,
      'turnSummary',
    ]);
    expect(rows.filter((row) => row.type === 'record').map((row) => row.turnStart)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

function renderPanel(
  agentCoreRequest: <Method extends AgentCoreMethod>(
    method: Method,
    input: AgentCoreRequestByMethod[Method],
  ) => Promise<AgentCoreResponseByMethod[Method]>,
  options: {
    readonly onOpenThreadTrajectory?: (threadId: string) => void;
    readonly selectedRecordId?: string;
    readonly turnId?: string;
  } = {},
) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  let notificationListener: ((notification: AgentCoreNotification) => void) | null = null;
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(Date.now());
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    lin: {
      initialLanguage: 'en',
      agentCoreRequest,
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notificationListener = listener;
        return () => {
          if (notificationListener === listener) notificationListener = null;
        };
      },
      onLanguageChanged: () => () => undefined,
    },
  });
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Missing root element');
  const root = createRoot(rootElement);
  return {
    document,
    notify: (notification: AgentCoreNotification) => {
      act(() => notificationListener?.(notification));
    },
    window,
    render: () => {
      act(() => {
        root.render(
          <I18nProvider>
            <ThreadTrajectoryPanel
              canGoBack
              onBack={() => undefined}
              onClose={() => undefined}
              onOpenThreadTrajectory={options.onOpenThreadTrajectory ?? (() => undefined)}
              selectedRecordId={options.selectedRecordId}
              showClose
              threadId={THREAD_ID}
              turnId={options.turnId}
            />
          </I18nProvider>,
        );
      });
      mounted.push(() => act(() => root.unmount()));
    },
  };
}

function trajectoryReadResponse(
  records: readonly ThreadTrajectoryRecordSummary[] = trajectoryRecords(),
  selectedRecordId: string | null = null,
): ThreadTrajectoryReadResponse {
  const usage = records.reduce((total, entry) => total + (entry.usage?.totalTokens ?? 0), 0);
  return {
    threadId: THREAD_ID,
    summary: {
      threadId: THREAD_ID,
      turnCount: records.length === 0 ? 0 : 1,
      recordCount: records.length,
      inputCount: records.filter((entry) => entry.kind === 'input').length,
      contextCount: records.filter((entry) => entry.kind === 'context').length,
      assistantCount: records.filter((entry) => entry.kind === 'assistant').length,
      toolCount: records.filter((entry) => entry.kind === 'tool').length,
      retryCount: records.filter((entry) => entry.kind === 'retry').length,
      compactionCount: records.filter((entry) => entry.kind === 'compaction').length,
      delegationCount: records.filter((entry) => entry.kind === 'delegation').length,
      startedAt: records.length === 0 ? null : 100,
      completedAt: records.length === 0 ? null : 220,
      durationMs: records.length === 0 ? null : 120,
      usage: usage === 0 ? null : {
        input: 120,
        output: 24,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: usage,
        costUsd: 0.001,
      },
      availability: [],
    },
    records,
    nextCursor: null,
    hasMore: false,
    selectedRecordId,
  };
}

function trajectoryRecords(): readonly ThreadTrajectoryRecordSummary[] {
  return [
    record({
      id: INPUT_ID,
      kind: 'input',
      lane: 'input',
      sequence: 0,
      title: 'Input',
      preview: 'Plan the release',
      timing: { startedAt: 100, firstTokenAt: null, completedAt: 100, durationMs: 0 },
      primaryEvidence: {
        type: 'diagnosticActivity',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: 0,
        activityType: 'acceptedInput',
      },
    }),
    record({
      id: ASSISTANT_ID,
      kind: 'assistant',
      lane: 'assistant',
      sequence: 1,
      title: 'Assistant call 1',
      subtitle: 'openai · gpt-5',
      preview: 'Mock response',
      timing: { startedAt: 110, firstTokenAt: null, completedAt: 180, durationMs: 70 },
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
    }),
    record({
      id: TOOL_ID,
      kind: 'tool',
      lane: 'tools',
      sequence: 2,
      parentRecordId: ASSISTANT_ID,
      title: 'Read file',
      subtitle: 'read_file',
      preview: 'package.json',
      timing: { startedAt: 200, firstTokenAt: null, completedAt: 220, durationMs: 20 },
      primaryEvidence: {
        type: 'toolExecution',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: 2,
        callId: 'call:read',
      },
    }),
  ];
}

function record(
  overrides: Partial<ThreadTrajectoryRecordSummary> & Pick<
    ThreadTrajectoryRecordSummary,
    'id' | 'kind' | 'lane' | 'sequence' | 'title' | 'primaryEvidence'
  >,
): ThreadTrajectoryRecordSummary {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    parentRecordId: null,
    subtitle: null,
    preview: null,
    state: 'completed',
    timing: { startedAt: 100, firstTokenAt: null, completedAt: 100, durationMs: 0 },
    usage: null,
    relatedEvidence: [],
    availability: [],
    childThreadId: null,
    ...overrides,
  };
}

function assistantDetailResponse(): ThreadTrajectoryDetailReadResponse {
  return {
    threadId: THREAD_ID,
    record: trajectoryRecords()[1]!,
    detail: {
      kind: 'assistant',
      turn: turnEvidence(),
      diagnostics: diagnosticsEvidence({
        request: { input: 'Read ‹path:redacted›' },
        response: { outputText: 'Mock response' },
      }),
      providerCallIndex: 0,
      relatedItems: [],
    },
  };
}

function inputDetailResponse(input: ThreadTrajectoryRecordSummary): ThreadTrajectoryDetailReadResponse {
  return {
    threadId: THREAD_ID,
    record: input,
    detail: {
      kind: 'input',
      turn: turnEvidence(),
      message: {
        itemId: 'user-message-1',
        acceptedAt: 106,
        content: [{ type: 'text', text: 'nihao' }],
      },
      diagnostics: diagnosticsEvidence({
        request: { model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_text', text: 'nihao' }] }] },
        response: null,
      }),
      activityIndex: 0,
    },
  };
}

function contextDetailResponse(
  context: ThreadTrajectoryRecordSummary,
  payload: JsonValue | null,
  modelContextText: string | null = null,
): ThreadTrajectoryDetailReadResponse {
  return {
    threadId: THREAD_ID,
    record: context,
    detail: {
      kind: 'context',
      turn: turnEvidence(),
      item: context.primaryEvidence.type === 'threadItem'
        ? {
          itemId: context.primaryEvidence.itemId,
          type: 'contextEvidence',
          title: context.title,
          preview: context.preview,
          status: null,
        }
        : null,
      modelContextText,
      payload,
    },
  };
}

function toolDetailResponse(): ThreadTrajectoryDetailReadResponse {
  return {
    threadId: THREAD_ID,
    record: trajectoryRecords()[2]!,
    detail: {
      kind: 'tool',
      turn: turnEvidence(),
      item: {
        itemId: 'tool-item',
        type: 'dynamicToolCall',
        title: 'Read file',
        preview: 'package.json',
        status: 'completed',
      },
      diagnostics: null,
      activityIndex: 2,
      executionCallId: 'call:read',
      input: { path: 'package.json' },
      outputText: 'Read 42 lines',
      schema: { name: 'read_file', description: 'Read a UTF-8 file' },
    },
  };
}

function delegationDetailResponse(
  delegation: ThreadTrajectoryRecordSummary,
): ThreadTrajectoryDetailReadResponse {
  return {
    threadId: THREAD_ID,
    record: delegation,
    detail: {
      kind: 'delegation',
      turn: turnEvidence(),
      item: null,
      diagnostics: null,
      activityIndex: 2,
      executionCallId: 'call:agent',
      input: { prompt: 'Inspect the renderer' },
      outputText: 'Inspection complete',
      schema: null,
      childThreadId: CHILD_THREAD_ID,
    },
  };
}

function turnEvidence() {
  return {
    id: TURN_ID,
    status: 'completed' as const,
    error: null,
    startedAt: 100,
    completedAt: 220,
    durationMs: 120,
    modelProvider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium' as const,
  };
}

function diagnosticsEvidence({
  request,
  response,
}: {
  readonly request: JsonValue | null;
  readonly response: JsonValue | null;
}): ThreadTrajectoryDiagnosticsEvidence {
  return {
    ref: {
      id: 'a'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json' as const,
      byteLength: 1024,
      schemaVersion: 1 as const,
    },
    runtime: {
      provider: 'openai',
      model: 'gpt-5',
      api: 'responses',
      transportSelection: 'sse' as const,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      thinkingLevel: 'medium',
      timeoutMs: null,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
      cacheRetention: 'short' as const,
      toolExecution: 'parallel' as const,
      steeringMode: 'all' as const,
    },
    activity: null,
    providerCall: {
      index: 0,
      requestedAt: 110,
      estimatedInputTokens: 120,
      inputTokenLimit: 128000,
      reservedOutputTokens: 8192,
      commonPrefixMessageCount: 0,
      requestFingerprint: 'b'.repeat(64),
      cacheBreakpoints: [],
      request,
      response,
      transportResponse: { headersReceivedAt: 111, httpStatus: 200, requestId: 'req_1' },
    },
  };
}

function recordRow(document: Document, recordId: string): HTMLElement {
  const row = recordRowOrNull(document, recordId);
  if (!row) throw new Error(`Missing Trajectory row: ${recordId}`);
  return row;
}

function recordRowOrNull(document: Document, recordId: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-trajectory-record-id]')]
    .find((candidate) => candidate.dataset.trajectoryRecordId === recordId) ?? null;
}

function clickRecord(document: Document, recordId: string): void {
  act(() => recordRow(document, recordId).click());
}

function buttonLabels(document: Document): readonly string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .map((button) => button.textContent?.trim() ?? '')
    .filter(Boolean);
}

function clickButton(document: Document, name: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  act(() => button.click());
}

function ariaButton(document: Document, name: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!button) throw new Error(`Missing button with aria-label: ${name}`);
  return button;
}

function clickAriaButton(document: Document, name: string): void {
  act(() => ariaButton(document, name).click());
}

function clickTitleButton(document: Document, title: string): void {
  const button = document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`Missing button with title: ${title}`);
  act(() => button.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function installDomGlobals(window: Window): void {
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
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
