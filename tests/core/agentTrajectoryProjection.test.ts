import { describe, expect, test } from 'bun:test';
import { decodeAgentCoreResponse } from '../../src/core/agent/codec';
import type {
  Thread,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadTrajectoryReadResponse,
  ThreadTrajectoryReplacementRange,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
} from '../../src/core/agent/protocol';
import { ThreadCore } from '../../src/main/agent/thread/ThreadCore';
import { ThreadTrajectoryProjection } from '../../src/main/agent/thread/ThreadTrajectoryProjection';

const THREAD_ID = '01910000-0000-7000-8000-000000000011';
const TURN_ID = '01910000-0000-7000-8000-000000000012';
const DIAGNOSTICS_REF: TurnDiagnosticsPayloadReference = {
  id: 'a'.repeat(64),
  mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
  byteLength: 4096,
  schemaVersion: 1,
};

describe('ThreadTrajectoryProjection', () => {
  test('keeps every tool execution evidence unique and resolves colon-bearing call ids exactly', async () => {
    const projection = trajectoryProjection();
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const tools = response.records.filter((record) => record.kind === 'tool');

    expect(response.selectedRecordId).toBeNull();
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((record) => record.id)).size).toBe(2);
    expect(tools.map((record) => record.primaryEvidence)).toEqual([
      {
        type: 'toolExecution',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: 1,
        callId: 'call:one',
      },
      {
        type: 'toolExecution',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: 1,
        callId: 'call:two:with:colon',
      },
    ]);

    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: tools[1]!.id });
    expect(detail.detail?.kind).toBe('tool');
    if (detail.detail?.kind !== 'tool') throw new Error('Expected Tool detail');
    expect(detail.detail.executionCallId).toBe('call:two:with:colon');
    expect(detail.detail.schema).toEqual({
      name: 'second_tool',
      description: 'Second tool',
      parameters: { type: 'object' },
    });
  });

  test('emits stable-prompt and tool-catalog records and round-trips exact tool evidence through the codec', async () => {
    const projection = trajectoryProjection();
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const toolCatalog = response.records.find((record) => record.primaryEvidence.type === 'toolCatalog');

    expect(response.records.filter((record) => record.primaryEvidence.type === 'stablePrompt')).toHaveLength(1);
    expect(toolCatalog).toMatchObject({
      kind: 'context',
      lane: 'input',
      title: 'Available Tools',
      subtitle: '2 tools · Request #1',
      preview: 'first_tool, second_tool',
      primaryEvidence: {
        type: 'toolCatalog',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callIndex: 0,
      },
    });
    expect(decodeAgentCoreResponse('thread/trajectory/read', response)).toEqual(response);

    if (!toolCatalog) throw new Error('Expected tool catalog record');
    const catalogDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: toolCatalog.id });
    expect(catalogDetail.detail?.kind).toBe('context');
    if (catalogDetail.detail?.kind !== 'context') throw new Error('Expected context detail');
    expect(catalogDetail.detail.modelContextText).toBeNull();
    expect(catalogDetail.detail.payload).toEqual({
      kind: 'toolCatalog',
      requestIndex: 0,
      toolNames: ['first_tool', 'second_tool'],
      tools: [
        { name: 'first_tool', description: 'First tool', parameters: { type: 'object' } },
        { name: 'second_tool', description: 'Second tool', parameters: { type: 'object' } },
      ],
    });
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', catalogDetail)).toEqual(catalogDetail);

    const invalid = structuredClone(response) as ThreadTrajectoryReadResponse;
    const toolIndex = invalid.records.findIndex((record) => record.primaryEvidence.type === 'toolExecution');
    const wire = structuredClone(invalid) as unknown as {
      records: Array<{ primaryEvidence: Record<string, unknown> }>;
    };
    delete wire.records[toolIndex]!.primaryEvidence.callId;
    expect(() => decodeAgentCoreResponse('thread/trajectory/read', wire)).toThrow(/callId/);
  });

  test('separates accepted user message from context envelope and materializes the consumed request', async () => {
    const projection = trajectoryProjection({
      diagnostics: inputEnvelopeDiagnostics(),
      contextPayload: turnEnvironmentPayload(),
      turn: inputEnvelopeTurn(),
    });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const input = response.records.find((record) => record.kind === 'input');
    const contexts = response.records.filter((record) => record.kind === 'context');
    const systemContexts = contexts.filter((record) => record.primaryEvidence.type === 'preparedContextPart');

    expect(input?.preview).toBe('nihao');
    expect(contexts.map((record) => record.title)).toEqual(['Available Tools', 'System Reminder']);
    expect(systemContexts.map((record) => record.title)).toEqual(['System Reminder']);
    expect(input?.primaryEvidence).toEqual({
      type: 'threadItem',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'user-message-1',
    });
    expect(input?.relatedEvidence).toEqual(expect.arrayContaining([
      {
        type: 'diagnosticActivity',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        activityIndex: 0,
        activityType: 'acceptedInput',
      },
      {
        type: 'providerCall',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callIndex: 0,
      },
    ]));
    expect(systemContexts[0]?.preview).toContain('<system-reminder>');
    expect(systemContexts[0]?.preview).toContain('<context-evidence kind="turnEnvironment"');
    expect(systemContexts[0]?.preview).toContain('<context-evidence kind="userView"');
    expect(contexts.map((record) => record.title)).not.toContain('Additional Context');
    expect(contexts.map((record) => record.title)).not.toContain('Tool Output Projection');

    if (!input) throw new Error('Expected input record');
    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: input.id });
    expect(detail.detail?.kind).toBe('input');
    if (detail.detail?.kind !== 'input') throw new Error('Expected input detail');
    expect(detail.detail.message?.content).toEqual([{ type: 'text', text: 'nihao' }]);
    expect(detail.detail.diagnostics?.providerCall?.request).toEqual({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'nihao' }] }],
    });
    expect(JSON.stringify(detail.detail)).not.toContain('Turn environment');
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);

    const context = contexts.find((record) => record.title === 'System Reminder');
    if (!context) throw new Error('Expected context record');
    const contextDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: context.id });
    expect(contextDetail.detail?.kind).toBe('context');
    if (contextDetail.detail?.kind !== 'context') throw new Error('Expected context detail');
    expect(contextDetail.detail.item).toBeNull();
    expect(contextDetail.detail.payload).toBeNull();
    expect(context.primaryEvidence).toEqual({
      type: 'preparedContextPart',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      callIndex: 0,
      messageIndex: 0,
      partIndex: 1,
    });
    expect(context.relatedEvidence).toEqual([{ type: 'providerCall', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0 }]);
    expect(contextDetail.detail.modelContextText).toContain('<system-reminder>');
    expect(contextDetail.detail.modelContextText).toContain('<context-evidence kind="turnEnvironment"');
    expect(contextDetail.detail.modelContextText).toContain('working_directory=/workspace');
    expect(contextDetail.detail.modelContextText).toContain('<context-evidence kind="userView"');
    expect(contextDetail.detail.modelContextText).toContain('active_panel_id=panel-1');
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', contextDetail)).toEqual(contextDetail);
  });

  test('redacts credential-looking strings from previews, details, tool output, and export bundles', async () => {
    const secret = `sk-${'a'.repeat(32)}`;
    const diagnostics = {
      ...trajectoryDiagnostics(),
      stablePrompt: {
        ...trajectoryDiagnostics().stablePrompt!,
        blocks: [{
          ...trajectoryDiagnostics().stablePrompt!.blocks[0]!,
          text: `System ${secret}`,
        }],
      },
      providerCalls: [{
        ...trajectoryDiagnostics().providerCalls[0]!,
        request: { kind: 'value' as const, value: { input: `Authorization: Bearer ${secret}` } },
        response: {
          ...trajectoryDiagnostics().providerCalls[0]!.response!,
          value: { role: 'assistant', content: [{ type: 'output_text', text: `token ${secret}` }] },
        },
      }],
    };
    const turn = {
      ...trajectoryTurn(),
      items: [{
        type: 'mcpToolCall' as const,
        id: 'tool-with-output',
        provenance: itemProvenance('tool-with-output'),
        server: 'server',
        tool: 'tool',
        arguments: { token: secret },
        status: 'completed' as const,
        result: `Tool returned ${secret}`,
        error: null,
        outputRef: {
          id: 'f'.repeat(64),
          mimeType: 'text/plain' as const,
          byteLength: 64,
          summary: `Tool returned ${secret}`,
        },
        durationMs: 10,
      }],
    };
    const projection = trajectoryProjection({
      diagnostics,
      toolOutput: `Raw tool output ${secret}`,
      turn,
    });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).toContain('[redacted secret-like content]');

    const assistant = response.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');
    const assistantDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    expect(JSON.stringify(assistantDetail)).not.toContain(secret);

    const tool = response.records.find((record) => record.kind === 'tool');
    if (!tool) throw new Error('Expected Tool record');
    const toolDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: tool.id });
    expect(JSON.stringify(toolDetail)).not.toContain(secret);

    const exported = await projection.exportBundle(THREAD_ID);
    expect(JSON.stringify(exported)).not.toContain(secret);
  });

  test('redacts camelCase fields and JSON-encoded secrets from detail and export evidence', async () => {
    const secret = '9f3a2c8d5e71b04a';
    const itemId = 'tool-json-secret';
    const jsonArguments = JSON.stringify({ password: secret });
    const baseDiagnostics = trajectoryDiagnostics();
    const diagnostics: TurnDiagnosticsPayload = {
      ...baseDiagnostics,
      providerCalls: [{
        ...baseDiagnostics.providerCalls[0]!,
        request: {
          kind: 'value',
          value: {
            clientSecret: secret,
            arguments: jsonArguments,
          },
        },
      }],
      activities: [
        baseDiagnostics.activities[0]!,
        {
          type: 'toolExecutionBatch',
          sourceCallIndex: 0,
          consumedByCallIndex: null,
          executions: [{
            callId: 'call:secret',
            toolName: 'secret_tool',
            itemId,
            admissionDisposition: 'accepted',
            canonicalIdentity: null,
            schemaDigest: null,
            startedAt: 190,
            completedAt: 210,
            status: 'completed',
          }],
        },
      ],
    };
    const turn: Turn = {
      ...trajectoryTurn(),
      items: [{
        type: 'mcpToolCall',
        id: itemId,
        provenance: itemProvenance(itemId),
        server: 'server',
        tool: 'secret_tool',
        arguments: {
          clientSecret: secret,
          arguments: jsonArguments,
        },
        status: 'completed',
        result: JSON.stringify({ clientSecret: secret, body: jsonArguments }),
        error: null,
        outputRef: {
          id: 'f'.repeat(64),
          mimeType: 'text/plain',
          byteLength: 128,
          summary: JSON.stringify({ clientSecret: secret }),
        },
        durationMs: 10,
      }],
    };
    const projection = trajectoryProjection({
      diagnostics,
      toolOutput: JSON.stringify({ clientSecret: secret, body: jsonArguments }),
      turn,
    });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    expect(JSON.stringify(response)).not.toContain(secret);

    const assistant = response.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');
    const assistantDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    const assistantJson = JSON.stringify(assistantDetail);
    expect(assistantJson).not.toContain(secret);
    expect(assistantJson).not.toContain(jsonArguments);

    const tool = response.records.find((record) => record.kind === 'tool');
    if (!tool) throw new Error('Expected Tool record');
    const toolDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: tool.id });
    const toolJson = JSON.stringify(toolDetail);
    expect(toolJson).not.toContain(secret);
    expect(toolJson).not.toContain(jsonArguments);

    const exported = await projection.exportBundle(THREAD_ID);
    const exportJson = JSON.stringify(exported);
    expect(exportJson).not.toContain(secret);
    expect(exportJson).not.toContain(jsonArguments);
  });

  test('keeps typed diagnostics structure when a large stable prompt exceeds redaction budget', async () => {
    const diagnostics: TurnDiagnosticsPayload = {
      ...trajectoryDiagnostics(),
      stablePrompt: {
        ...trajectoryDiagnostics().stablePrompt!,
        blocks: [{
          ...trajectoryDiagnostics().stablePrompt!.blocks[0]!,
          text: 'System '.padEnd(70_000, 'x'),
        }],
      },
    };
    const projection = trajectoryProjection({ diagnostics });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });

    expect(response.records.some((record) => record.kind === 'assistant')).toBe(true);
    expect(response.records.some((record) => record.primaryEvidence.type === 'toolCatalog')).toBe(true);
    expect(decodeAgentCoreResponse('thread/trajectory/read', response)).toEqual(response);
  });

  test('projects active in-memory diagnostics before the Turn has a final diagnostics reference', async () => {
    const activeTurn = {
      ...trajectoryTurn(),
      status: 'inProgress' as const,
      completedAt: null,
      durationMs: null,
      execution: { ...trajectoryTurn().execution, diagnosticsRef: null },
    };
    const activeDiagnostics = {
      ...trajectoryDiagnostics(),
      providerCalls: [{
        ...trajectoryDiagnostics().providerCalls[0]!,
        response: null,
      }],
    };
    const projection = trajectoryProjection({
      turn: activeTurn,
      activeDiagnostics: (_threadId, turnId) => turnId === activeTurn.id ? activeDiagnostics : null,
    });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const assistant = response.records.find((record) => record.kind === 'assistant');
    expect(assistant).toMatchObject({
      kind: 'assistant',
      state: 'running',
      title: 'Assistant call 1',
    });
    expect(response.records.some((record) => record.kind === 'tool')).toBe(true);
  });

  test('projects prepared system context for each consumed Provider Call without duplicating identical context', async () => {
    const first = inputEnvelopeDiagnostics();
    const firstCall = first.providerCalls[0]!;
    const secondMessageId = '5'.repeat(64);
    const secondContext = '<system-reminder>\nnew steering context\n</system-reminder>';
    const diagnostics: TurnDiagnosticsPayload = {
      ...first,
      canonicalMessages: [
        ...first.canonicalMessages,
        {
          id: secondMessageId,
          estimatedTokens: 4,
          value: {
            role: 'user',
            content: [
              { type: 'input_text', text: 'later' },
              { type: 'text', text: secondContext },
            ],
          },
        },
      ],
      providerCalls: [
        firstCall,
        {
          ...firstCall,
          index: 1,
          requestedAt: 160,
          preparedContext: {
            ...firstCall.preparedContext,
            messageIds: [secondMessageId],
            messagePartProvenance: [[
              { source: 'userInput' },
              {
                source: 'systemContext',
                entries: [{
                  kind: 'turnEnvironment',
                  authority: 'application',
                  purpose: 'observation',
                }],
              },
            ]],
          },
          requestFingerprint: '6'.repeat(64),
        },
      ],
      activities: [
        first.activities[0]!,
        first.activities[1]!,
        {
          type: 'acceptedInput',
          source: 'steering',
          acceptedAt: 150,
          itemIds: ['user-message-2'],
          consumedByCallIndex: 1,
        },
        { type: 'modelCall', callIndex: 1 },
      ],
    };
    const turn = {
      ...inputEnvelopeTurn(),
      items: [
        ...inputEnvelopeTurn().items,
        {
          type: 'userMessage' as const,
          id: 'user-message-2',
          provenance: itemProvenance('user-message-2'),
          clientId: null,
          content: [{ type: 'text' as const, text: 'later' }],
          acceptedAt: 150,
        },
      ],
    };
    const projection = trajectoryProjection({ diagnostics, turn });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const contexts = response.records.filter((record) => record.primaryEvidence.type === 'preparedContextPart');
    expect(contexts).toHaveLength(2);
    expect(contexts.map((record) => record.primaryEvidence)).toEqual([
      { type: 'preparedContextPart', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0, messageIndex: 0, partIndex: 1 },
      { type: 'preparedContextPart', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 1, messageIndex: 0, partIndex: 1 },
    ]);
  });

  test('uses stable bidirectional cursors for focused windows', async () => {
    const turns = Array.from({ length: 8 }, (_, index) => trajectoryTurnWithInput(index));
    const projection = trajectoryProjection({ turns, diagnosticsByRef: new Map() });
    const focused = await projection.read({
      threadId: THREAD_ID,
      limit: 3,
      focus: { turnId: turns[3]!.id },
    });
    expect(focused.summary.turnCount).toBe(8);
    expect(focused.olderCursor).not.toBeNull();
    expect(focused.newerCursor).not.toBeNull();
    expect(focused.records.map((record) => record.turnId)).toContain(turns[3]!.id);
    expect(focused.replacementRange).toEqual(replacementRangeForRecords(focused.records));

    const newer = await projection.read({
      threadId: THREAD_ID,
      limit: 3,
      cursor: focused.newerCursor,
    });
    expect(newer.records[0]?.turnId).toBe(turns[4]!.id);
    expect(newer.records.at(-1)?.turnId).toBe(turns[6]!.id);
    expect(newer.olderCursor).not.toBeNull();
    expect(newer.newerCursor).not.toBeNull();
  });

  test('keeps record sequence stable between tail and overlapping cursor windows', async () => {
    const turns = Array.from({ length: 3 }, (_, index) => trajectoryTurnWithDiagnosticsRef(index));
    const diagnosticsByRef = new Map(turns.map((turn) => [
      turn.execution.diagnosticsRef!.id,
      trajectoryDiagnostics(),
    ]));
    const projection = trajectoryProjection({ turns, diagnosticsByRef });
    const targetTurn = turns[2]!;
    const assistantId = `turn:${targetTurn.id}:assistant:0`;
    const finalToolId = `turn:${targetTurn.id}:tool:1:${encodeURIComponent('call:two:with:colon')}`;

    const tail = await projection.read({ threadId: THREAD_ID, limit: 1 });
    const cursorWindow = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      cursor: `before:${encodeURIComponent(finalToolId)}`,
    });
    const tailAssistant = tail.records.find((record) => record.id === assistantId);
    const cursorAssistant = cursorWindow.records.find((record) => record.id === assistantId);

    expect(tailAssistant).toBeDefined();
    expect(cursorAssistant).toBeDefined();
    expect(cursorAssistant?.sequence).toBe(tailAssistant?.sequence);
  });

  test('limits whole-Thread summary to facts available without diagnostics totals', async () => {
    const diagnostics: TurnDiagnosticsPayload = {
      ...trajectoryDiagnostics(),
      activities: [
        ...trajectoryDiagnostics().activities,
        {
          type: 'providerRetry',
          retryKind: 'request',
          attempt: 1,
          maxRetries: 2,
          occurredAt: 225,
          sourceCallIndex: 0,
          nextCallIndex: null,
        },
      ],
    };
    const response = await trajectoryProjection({ diagnostics }).read({ threadId: THREAD_ID, limit: 100 });

    expect(response.records.map((record) => record.kind)).toEqual([
      'context',
      'context',
      'assistant',
      'tool',
      'tool',
      'retry',
    ]);
    expect(response.summary).toEqual({
      threadId: THREAD_ID,
      turnCount: 1,
      startedAt: 100,
      completedAt: 300,
      durationMs: 200,
      usage: {
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: 14,
        costUsd: 0.00003,
      },
      availability: [],
    });
  });

  test('bounds trajectory read diagnostics materialization to the requested window', async () => {
    let diagnosticsReads = 0;
    const turns = Array.from({ length: 500 }, (_, index) => trajectoryTurnWithDiagnosticsRef(index));
    const diagnosticsByRef = new Map(turns.map((turn) => [
      turn.execution.diagnosticsRef!.id,
      trajectoryDiagnostics(),
    ]));
    const projection = trajectoryProjection({
      turns,
      diagnosticsByRef,
      onReadDiagnostics: () => { diagnosticsReads += 1; },
    });

    const response = await projection.read({ threadId: THREAD_ID, limit: 1 });

    expect(response.records.length).toBeGreaterThan(0);
    expect(diagnosticsReads).toBeLessThanOrEqual(1);
  });
});

function replacementRangeForRecords(
  records: readonly { readonly sequence: number }[],
): ThreadTrajectoryReplacementRange | null {
  const first = records[0] ?? null;
  const last = records.at(-1) ?? null;
  return first && last ? { startSequence: first.sequence, endSequence: last.sequence + 1 } : null;
}

function trajectoryProjection(overrides: {
  readonly contextPayload?: ThreadContextPayload | null;
  readonly diagnostics?: TurnDiagnosticsPayload;
  readonly diagnosticsByRef?: ReadonlyMap<string, TurnDiagnosticsPayload>;
  readonly activeDiagnostics?: (threadId: string, turnId: string) => TurnDiagnosticsPayload | null;
  readonly toolOutput?: string | null;
  readonly turn?: Turn;
  readonly turns?: readonly Turn[];
  readonly onReadDiagnostics?: (ref: TurnDiagnosticsPayloadReference) => void;
} = {}): ThreadTrajectoryProjection {
  const thread = trajectoryThread();
  const turns = overrides.turns ?? [overrides.turn ?? trajectoryTurn()];
  const diagnostics = overrides.diagnostics ?? trajectoryDiagnostics();
  const diagnosticsByRef = overrides.diagnosticsByRef ?? new Map([[DIAGNOSTICS_REF.id, diagnostics]]);
  const contextPayload = overrides.contextPayload ?? null;
  const core = {
    requireThread: (threadId: string) => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      return { thread };
    },
    allTurns: (threadId: string) => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      return turns;
    },
    payloads: {
      readTurnDiagnostics: async (threadId: string, ref: TurnDiagnosticsPayloadReference) => {
        overrides.onReadDiagnostics?.(ref);
        return threadId === THREAD_ID ? diagnosticsByRef.get(ref.id) ?? null : null;
      },
      readTextReference: async () => overrides.toolOutput ?? null,
      readContext: async (_threadId: string, ref: ThreadContextPayloadReference) => (
        contextPayload && ref.id === CONTEXT_REF.id ? contextPayload : null
      ),
    },
  } as unknown as ThreadCore;
  return new ThreadTrajectoryProjection(core, () => 500, overrides.activeDiagnostics ?? null);
}

const CONTEXT_REF: ThreadContextPayloadReference = {
  id: 'c'.repeat(64),
  mimeType: 'application/vnd.tenon.agent-context+json',
  byteLength: 128,
  schemaVersion: 1,
  kind: 'turnEnvironment',
};

function trajectoryThread(): Thread {
  return {
    id: THREAD_ID,
    sessionId: 'trajectory-test',
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: 'Trajectory test',
    preview: 'Trajectory test',
    ephemeral: false,
    source: 'test',
    threadSource: { kind: 'user' },
    modelProvider: 'openai',
    cwd: '/redacted',
    createdAt: 100,
    updatedAt: 300,
    status: { type: 'idle' },
    historyMode: 'paginated',
  };
}

function trajectoryTurn(): Turn {
  return {
    id: TURN_ID,
    items: [],
    itemsView: 'full',
    provenance: {
      originThreadId: THREAD_ID,
      originTurnId: TURN_ID,
      trigger: { kind: 'user' },
    },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      usage: {
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: {
          input: 0.00001,
          output: 0.00002,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.00003,
          currency: 'USD',
        },
      },
      diagnosticsRef: DIAGNOSTICS_REF,
    },
    startedAt: 100,
    completedAt: 300,
    durationMs: 200,
  };
}

function inputEnvelopeTurn(): Turn {
  return {
    ...trajectoryTurn(),
    items: [
      contextItem(),
      emptyAdditionalContextItem(),
      toolOutputProjectionItem(),
      {
        type: 'userMessage',
        id: 'user-message-1',
        provenance: itemProvenance('user-message-1'),
        clientId: null,
        content: [{ type: 'text', text: 'nihao' }],
        acceptedAt: 106,
      },
    ],
  };
}

function trajectoryTurnWithInput(index: number): Turn {
  const turnId = `01910000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`;
  const itemId = `user-message-${index}`;
  return {
    ...trajectoryTurn(),
    id: turnId,
    items: [{
      type: 'userMessage',
      id: itemId,
      provenance: {
        originThreadId: THREAD_ID,
        originTurnId: turnId,
        originItemId: itemId,
      },
      clientId: null,
      content: [{ type: 'text', text: `message ${index}` }],
      acceptedAt: 100 + index,
    }],
    provenance: {
      originThreadId: THREAD_ID,
      originTurnId: turnId,
      trigger: { kind: 'user' },
    },
    execution: { ...trajectoryTurn().execution, diagnosticsRef: null },
    startedAt: 100 + index,
    completedAt: 101 + index,
    durationMs: 1,
  };
}

function trajectoryTurnWithDiagnosticsRef(index: number): Turn {
  const ref: TurnDiagnosticsPayloadReference = {
    ...DIAGNOSTICS_REF,
    id: String(index).padStart(64, 'a').slice(-64),
  };
  return {
    ...trajectoryTurnWithInput(index),
    execution: { ...trajectoryTurn().execution, diagnosticsRef: ref },
  };
}

function toolOutputProjectionItem(): ThreadItem {
  return {
    type: 'contextEvidence',
    id: 'context-tool-output-projection',
    provenance: itemProvenance('context-tool-output-projection'),
    kind: 'toolOutputProjection',
    payloadRef: {
      id: 'e'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: 128,
      schemaVersion: 1,
      kind: 'toolOutputProjection',
    },
    summary: 'Frozen tool output projection',
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [],
  };
}

function contextItem(): ThreadItem {
  return {
    type: 'contextEvidence',
    id: 'context-turn-environment',
    provenance: itemProvenance('context-turn-environment'),
    kind: 'turnEnvironment',
    payloadRef: CONTEXT_REF,
    summary: 'Turn environment',
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [],
  };
}

function emptyAdditionalContextItem(): ThreadItem {
  return {
    type: 'contextEvidence',
    id: 'context-additional',
    provenance: itemProvenance('context-additional'),
    kind: 'additionalContext',
    payloadRef: {
      id: 'd'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: 128,
      schemaVersion: 1,
      kind: 'additionalContext',
    },
    summary: 'Additional context (0 turn, 0 state)',
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [],
  };
}

function itemProvenance(itemId: string) {
  return {
    originThreadId: THREAD_ID,
    originTurnId: TURN_ID,
    originItemId: itemId,
  };
}

function turnEnvironmentPayload(): ThreadContextPayload {
  return {
    schemaVersion: 1,
    kind: 'turnEnvironment',
    acceptedAt: 106,
    utcInstant: '2026-08-21T00:00:00.000Z',
    localDate: '2026-08-21',
    localTime: '08:00:00',
    timeZone: 'Asia/Shanghai',
    utcOffsetMinutes: 480,
    locale: 'en-US',
    workingDirectory: '/redacted',
    conversationMode: 'interactive',
    executionMode: 'root',
    replyIdentity: null,
    todayNodeId: null,
    todayNodeTitle: null,
  };
}

function trajectoryDiagnostics(): TurnDiagnosticsPayload {
  return {
    schemaVersion: 1,
    contextEpochId: 'epoch-1',
    cacheAffinity: 'affinity-1',
    configuration: {
      profileName: null,
      developerInstructions: [],
      model: 'gpt-5',
      reasoningEffort: 'medium',
      tools: ['first_tool', 'second_tool'],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    stablePrompt: {
      blocks: [{
        id: 'system',
        layer: 'L0',
        text: 'System instructions',
        fingerprint: 'block-fingerprint',
      }],
      fingerprints: {
        l0: 'l0-fingerprint',
        l1: 'l1-fingerprint',
        l2: 'l2-fingerprint',
        complete: 'complete-fingerprint',
      },
    },
    toolSchemas: [
      { name: 'first_tool', description: 'First tool', parameters: { type: 'object' } },
      { name: 'second_tool', description: 'Second tool', parameters: { type: 'object' } },
    ],
    runtime: {
      provider: 'openai',
      model: 'gpt-5',
      api: 'responses',
      configuredBaseUrl: 'https://example.invalid',
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
    canonicalMessages: [],
    requestFragments: [],
    providerCalls: [{
      index: 0,
      requestedAt: 120,
      preparedContext: {
        systemPromptFragmentId: 'system',
        toolNames: ['first_tool', 'second_tool'],
        messageIds: [],
        messagePartProvenance: [],
      },
      protectedFromMessageIndex: 0,
      estimatedInputTokens: 10,
      inputTokenLimit: 128000,
      reservedOutputTokens: 8192,
      commonPrefixMessageCount: 0,
      request: { kind: 'value', value: { input: 'test' } },
      requestFingerprint: 'request-fingerprint',
      cacheBreakpoints: [],
      transportResponse: { headersReceivedAt: 130, httpStatus: 200, requestId: 'request-1' },
      response: {
        receivedAt: 180,
        stopReason: 'toolUse',
        errorMessage: null,
        usage: {
          input: 10,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: null,
          reasoning: null,
          totalTokens: 14,
          cost: { input: 0.00001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00003 },
        },
        value: { role: 'assistant', content: [] },
      },
    }],
    activities: [
      { type: 'modelCall', callIndex: 0 },
      {
        type: 'toolExecutionBatch',
        sourceCallIndex: 0,
        consumedByCallIndex: null,
        executions: [
          {
            callId: 'call:one',
            toolName: 'first_tool',
            itemId: null,
            admissionDisposition: 'accepted',
            canonicalIdentity: null,
            schemaDigest: null,
            startedAt: 190,
            completedAt: 210,
            status: 'completed',
          },
          {
            callId: 'call:two:with:colon',
            toolName: 'second_tool',
            itemId: null,
            admissionDisposition: 'accepted',
            canonicalIdentity: null,
            schemaDigest: null,
            startedAt: 190,
            completedAt: 220,
            status: 'completed',
          },
        ],
      },
    ],
  };
}

function inputEnvelopeDiagnostics(): TurnDiagnosticsPayload {
  const messageId = '4'.repeat(64);
  const modelContextText = [
    '<system-reminder>',
    '<context-evidence kind="turnEnvironment" authority="application" purpose="observation">',
    'working_directory=/workspace',
    '</context-evidence>',
    '<context-evidence kind="userView" authority="untrusted" purpose="observation">',
    'active_panel_id=panel-1',
    '</context-evidence>',
    '</system-reminder>',
  ].join('\n');
  return {
    ...trajectoryDiagnostics(),
    stablePrompt: null,
    canonicalMessages: [{
      id: messageId,
      estimatedTokens: 8,
      value: {
        role: 'user',
        content: [
          { type: 'input_text', text: 'nihao' },
          { type: 'text', text: modelContextText },
        ],
      },
    }],
    requestFragments: [
      { id: '1'.repeat(64), value: '' },
      {
        id: '2'.repeat(64),
        value: { role: 'user', content: [{ type: 'input_text', text: 'nihao' }] },
      },
    ],
    providerCalls: [{
      index: 0,
      requestedAt: 120,
      preparedContext: {
        systemPromptFragmentId: '1'.repeat(64),
        toolNames: ['first_tool', 'second_tool'],
        messageIds: [messageId],
        messagePartProvenance: [[
          { source: 'userInput' },
          {
            source: 'systemContext',
            entries: [{
              kind: 'turnEnvironment',
              authority: 'application',
              purpose: 'observation',
            }, {
              kind: 'userView',
              authority: 'untrusted',
              purpose: 'observation',
            }],
          },
        ]],
      },
      protectedFromMessageIndex: 0,
      estimatedInputTokens: 10,
      inputTokenLimit: 128000,
      reservedOutputTokens: 8192,
      commonPrefixMessageCount: 0,
      request: {
        kind: 'object',
        fields: [
          { name: 'model', representation: 'inline', value: 'gpt-5' },
          {
            name: 'input',
            representation: 'fragments',
            container: 'array',
            fragmentIds: ['2'.repeat(64)],
            fragmentPartProvenance: [null],
          },
        ],
      },
      requestFingerprint: '3'.repeat(64),
      cacheBreakpoints: [],
      transportResponse: { headersReceivedAt: 130, httpStatus: 200, requestId: 'request-1' },
      response: {
        receivedAt: 180,
        stopReason: 'stop',
        errorMessage: null,
        usage: {
          input: 10,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: null,
          reasoning: null,
          totalTokens: 14,
          cost: { input: 0.00001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00003 },
        },
        value: { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      },
    }],
    activities: [
      {
        type: 'acceptedInput',
        source: 'initial',
        acceptedAt: 106,
        itemIds: ['context-turn-environment', 'user-message-1'],
        consumedByCallIndex: 0,
      },
      { type: 'modelCall', callIndex: 0 },
    ],
  };
}
