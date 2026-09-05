import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { decodeAgentCoreResponse } from '../../src/core/agent/codec';
import { MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES } from '../../src/core/agent/protocol';
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
  TurnItemsView,
} from '../../src/core/agent/protocol';
import { ThreadCore } from '../../src/main/agent/thread/ThreadCore';
import { ThreadTrajectoryProjection } from '../../src/main/agent/thread/ThreadTrajectoryProjection';
import { testProviderCall } from '../fixtures/agentToolCallHistory';

const THREAD_ID = '01910000-0000-7000-8000-000000000011';
const TURN_ID = '01910000-0000-7000-8000-000000000012';
const REFERENCE_NODE_ID = 'node:11111111-1111-4111-8111-111111111111';
const REFERENCE_NODE_MARKER = '[[node://11111111-1111-4111-8111-111111111111]]';
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

  test('resolves repeated host call ids within the record owning execution batch', async () => {
    const base = trajectoryDiagnostics();
    const firstBatch = base.activities[1] as Extract<
      TurnDiagnosticsPayload['activities'][number],
      { type: 'toolExecutionBatch' }
    >;
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      providerCalls: [
        base.providerCalls[0]!,
        {
          ...base.providerCalls[0]!,
          index: 1,
          requestedAt: 300,
          response: {
            ...base.providerCalls[0]!.response!,
            receivedAt: 310,
            value: {
              role: 'assistant',
              content: [{
                type: 'toolCall',
                id: 'provider:call:reused',
                name: 'first_tool',
                arguments: { batch: 'second' },
              }],
            },
          },
        },
      ],
      activities: [
        ...base.activities,
        {
          ...firstBatch,
          sourceCallIndex: 1,
          executions: [{
            ...firstBatch.executions[0]!,
            callId: 'call:one',
            providerResponsePartIndex: 0,
            itemId: null,
            startedAt: 320,
            completedAt: 330,
          }],
        },
      ],
    };
    const projection = trajectoryProjection({ diagnostics });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const repeated = response.records.find((record) => (
      record.primaryEvidence.type === 'toolExecution'
      && record.primaryEvidence.activityIndex === 2
    ));
    if (!repeated) throw new Error('Expected repeated-ID Tool record');

    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: repeated.id });
    if (detail.detail?.kind !== 'tool') throw new Error('Expected repeated-ID Tool detail');
    expect(detail.detail.input).toEqual({ batch: 'second' });
  });

  test('resolves empty and repeated provider call ids by their exact response part coordinates', async () => {
    const base = trajectoryDiagnostics();
    const batch = base.activities[1] as Extract<
      TurnDiagnosticsPayload['activities'][number],
      { type: 'toolExecutionBatch' }
    >;
    const response = base.providerCalls[0]!.response!;
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      providerCalls: [{
        ...base.providerCalls[0]!,
        response: {
          ...response,
          value: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'before' },
              { type: 'toolCall', id: '', name: 'first_tool', arguments: { position: 'empty' } },
              { type: 'toolCall', id: 'duplicate', name: 'first_tool', arguments: { position: 'first' } },
              { type: 'toolCall', id: 'duplicate', name: 'second_tool', arguments: { position: 'second' } },
            ],
          },
        },
      }],
      activities: [
        base.activities[0]!,
        {
          ...batch,
          executions: [
            { ...batch.executions[0]!, callId: 'host-empty', providerResponsePartIndex: 1, itemId: null },
            { ...batch.executions[0]!, callId: 'host-first', providerResponsePartIndex: 2, itemId: null },
            { ...batch.executions[1]!, callId: 'host-second', providerResponsePartIndex: 3, itemId: null },
          ],
        },
      ],
    };
    const projection = trajectoryProjection({ diagnostics });
    const trajectory = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const tools = trajectory.records.filter((record) => record.kind === 'tool');
    const details = await Promise.all(tools.map(async (record) => (
      (await projection.readDetail({ threadId: THREAD_ID, recordId: record.id })).detail
    )));

    expect(tools).toHaveLength(3);
    expect(details.map((detail) => detail?.kind === 'tool' ? detail.input : null)).toEqual([
      { position: 'empty' },
      { position: 'first' },
      { position: 'second' },
    ]);
  });

  test('reads Tool Input from the exact provider response despite divergent or missing replay storage', async () => {
    const base = trajectoryDiagnostics();
    const argumentsRef: ThreadContextPayloadReference = {
      id: '6'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: 128,
      schemaVersion: 1,
      kind: 'toolCallArguments',
    };
    const outputRef = {
      id: '7'.repeat(64),
      mimeType: 'text/plain' as const,
      byteLength: 64,
      summary: 'Missing output',
    };
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      activities: [
        base.activities[0]!,
        {
          ...base.activities[1] as Extract<TurnDiagnosticsPayload['activities'][number], { type: 'toolExecutionBatch' }>,
          executions: [
            {
              ...(base.activities[1] as Extract<TurnDiagnosticsPayload['activities'][number], { type: 'toolExecutionBatch' }>).executions[0]!,
              itemId: 'tool-inline',
            },
            {
              ...(base.activities[1] as Extract<TurnDiagnosticsPayload['activities'][number], { type: 'toolExecutionBatch' }>).executions[1]!,
              itemId: 'tool-payload',
            },
          ],
        },
      ],
    };
    const turn: Turn = {
      ...trajectoryTurn(),
      items: [
        commandItem('tool-inline', {
          disposition: 'replayable',
          identity: { namespace: null, name: 'first_tool' },
          providerName: 'first_tool',
          providerCall: testProviderCall('first_tool', {
            command: 'printf model', timeout: 5_000, run_in_background: true,
          }),
          arguments: {
            storage: 'inline',
            value: { command: 'printf model', timeout: 5_000, run_in_background: true },
          },
          schemaDigest: '8'.repeat(64),
        }, null),
        commandItem('tool-payload', {
          disposition: 'replayable',
          identity: { namespace: null, name: 'second_tool' },
          providerName: 'second_tool',
          providerCall: testProviderCall('second_tool', { file_path: '/workspace/second-payload.ts' }),
          arguments: { storage: 'payload', ref: argumentsRef, internalTextRefs: [] },
          schemaDigest: '9'.repeat(64),
        }, outputRef),
      ],
    };
    const projection = trajectoryProjection({ diagnostics, turn });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const tools = response.records.filter((record) => record.kind === 'tool');

    expect(tools[0]?.preview).toContain('printf model');
    expect(tools[0]?.preview).not.toContain('Host-derived display value');
    expect(tools[0]?.preview).not.toContain('/host/injected');
    expect(tools[1]?.preview).toBeNull();

    const inlineDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: tools[0]!.id });
    if (inlineDetail.detail?.kind !== 'tool') throw new Error('Expected inline Tool detail');
    expect(inlineDetail.detail.input).toEqual({
      command: 'printf model',
      timeout: 5_000,
      run_in_background: true,
    });
    expect(JSON.stringify(inlineDetail.detail.input)).not.toContain('/host/injected');

    const missingDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: tools[1]!.id });
    if (missingDetail.detail?.kind !== 'tool' || !missingDetail.record) {
      throw new Error('Expected payload-backed Tool detail');
    }
    expect(missingDetail.detail.input).toEqual({ file_path: '/workspace/second-payload.ts' });
    expect(missingDetail.detail.outputText).toBeNull();
    expect(missingDetail.record.availability).toEqual([{ reason: 'evidenceUnavailable' }]);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', missingDetail)).toEqual(missingDetail);
  });

  test('emits stable-prompt and tool-catalog records and round-trips exact tool evidence through the codec', async () => {
    const projection = trajectoryProjection();
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const toolCatalog = response.records.find((record) => record.primaryEvidence.type === 'toolCatalog');

    expect(response.records.filter((record) => record.primaryEvidence.type === 'stablePrompt')).toHaveLength(1);
    expect(toolCatalog).toMatchObject({
      kind: 'context',
      lane: 'input',
      label: {
        type: 'toolCatalog',
        change: 'initial',
        requestIndex: 0,
        toolCount: 2,
      },
      meta: null,
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

  test('uses the captured provider-context prompt instead of stable-prompt source blocks', async () => {
    const base = trajectoryDiagnostics();
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      stablePrompt: {
        ...base.stablePrompt!,
        blocks: [{
          ...base.stablePrompt!.blocks[0]!,
          text: 'Stable prompt source block',
        }],
      },
      requestFragments: [{ id: 'system', value: 'Captured provider-context prompt' }],
    };
    const projection = trajectoryProjection({ diagnostics });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const system = response.records.find((record) => record.primaryEvidence.type === 'stablePrompt');

    expect(system?.preview).toBe('Captured provider-context prompt');
    if (!system) throw new Error('Expected System Prompt record');
    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: system.id });
    if (detail.detail?.kind !== 'context') throw new Error('Expected System Prompt detail');
    expect(detail.detail.modelContextText).toBe('Captured provider-context prompt');
    expect(JSON.stringify(detail.detail.payload)).toContain('Stable prompt source block');
  });

  test('preserves ordered Assistant text, thinking, tool calls, images, and unknown output parts', async () => {
    const base = trajectoryDiagnostics();
    const imageDigest = '4'.repeat(64);
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      providerCalls: [{
        ...base.providerCalls[0]!,
        response: {
          ...base.providerCalls[0]!.response!,
          value: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Inspect the repository first.', thinkingSignature: 'opaque-signature' },
              { type: 'text', text: 'Checking the relevant file.' },
              {
                type: 'toolCall',
                id: 'call:file-read',
                name: 'file_read',
                arguments: {
                  path: '/workspace/src/app.ts',
                  line_start: 1,
                  line_end: 80,
                  authorization: 'Bearer test-credential-value',
                },
              },
              {
                type: 'image',
                mimeType: 'image/png',
                data: {
                  omitted: true,
                  encoding: 'base64',
                  byteLength: 128,
                  sha256: imageDigest,
                },
              },
              { type: 'citation', source: 'provider', index: 1 },
            ],
          },
        },
      }],
    };
    const projection = trajectoryProjection({ diagnostics });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const assistant = response.records.find((record) => record.kind === 'assistant');

    expect(assistant?.preview).toContain('Inspect the repository first.');
    expect(assistant?.preview).toContain('file_read');
    if (!assistant) throw new Error('Expected Assistant record');
    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    if (detail.detail?.kind !== 'assistant') throw new Error('Expected Assistant detail');
    expect(detail.detail.modelOutputParts).toEqual([
      { type: 'thinking', text: 'Inspect the repository first.' },
      { type: 'text', text: 'Checking the relevant file.' },
      {
        type: 'toolCall',
        callId: 'call:file-read',
        name: 'file_read',
        arguments: {
          path: '/workspace/src/app.ts',
          line_start: 1,
          line_end: 80,
        authorization: 'Bearer test-credential-value',
        },
      },
      { type: 'image', mimeType: 'image/png', byteLength: 128, sha256: imageDigest },
      { type: 'other', value: { type: 'citation', source: 'provider', index: 1 } },
    ]);
    expect(JSON.stringify(detail.detail.modelOutputParts)).not.toContain('opaque-signature');
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);
  });

  test('reads the retained compaction summary instead of presenting an Item label as Preview evidence', async () => {
    const summaryRef: ThreadContextPayloadReference = {
      id: CONTEXT_REF.id,
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: 128,
      schemaVersion: 1,
      kind: 'compactionSummary',
    };
    const restoredStateRef: ThreadContextPayloadReference = {
      ...summaryRef,
      id: '5'.repeat(64),
      kind: 'compactionRestoredState',
    };
    const compaction: ThreadItem = {
      type: 'contextCompaction',
      id: 'manual-compaction',
      provenance: itemProvenance('manual-compaction'),
      trigger: 'manual',
      coveredFrom: { turnId: TURN_ID, itemId: 'manual-compaction' },
      coveredThrough: { turnId: TURN_ID, itemId: 'manual-compaction' },
      preservedFrom: null,
      summaryRef,
      restoredStateRef,
      instructionsRef: null,
      contextRefs: [summaryRef, restoredStateRef],
      internalTextRefs: [],
      resourceRefs: [],
      outputRefs: [],
    };
    const projection = trajectoryProjection({
      contextPayload: {
        schemaVersion: 1,
        kind: 'compactionSummary',
        source: 'deterministic',
        text: 'The retained conversation summary.',
      },
      turn: { ...trajectoryTurn(), items: [compaction] },
    });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const record = response.records.find((candidate) => candidate.kind === 'compaction');
    if (!record) throw new Error('Expected Compaction record');
    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: record.id });

    if (detail.detail?.kind !== 'compaction') throw new Error('Expected Compaction detail');
    expect(detail.detail.summaryText).toBe('The retained conversation summary.');
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);

    const missingProjection = trajectoryProjection({
      contextPayload: null,
      turn: { ...trajectoryTurn(), items: [compaction] },
    });
    const missingRecords = await missingProjection.read({ threadId: THREAD_ID, limit: 100 });
    const missingRecord = missingRecords.records.find((candidate) => candidate.kind === 'compaction');
    if (!missingRecord) throw new Error('Expected missing-payload Compaction record');
    const missingDetail = await missingProjection.readDetail({
      threadId: THREAD_ID,
      recordId: missingRecord.id,
    });
    if (missingDetail.detail?.kind !== 'compaction') throw new Error('Expected missing Compaction detail');
    expect(missingDetail.detail.summaryText).toBeNull();
    expect(missingDetail.record?.availability).toContainEqual({ reason: 'payloadUnavailable' });
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
    expect(contexts.map((record) => record.label)).toEqual([
      { type: 'toolCatalog', change: 'initial', requestIndex: 0, toolCount: 2 },
      { type: 'context', kinds: ['turnEnvironment', 'userView'] },
    ]);
    expect(systemContexts.map((record) => record.label)).toEqual([
      { type: 'context', kinds: ['turnEnvironment', 'userView'] },
    ]);
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
    expect(systemContexts[0]?.preview).toContain('<context authority="application" purpose="observation">');
    expect(systemContexts[0]?.preview).toContain('<context authority="untrusted" purpose="observation">');
    expect(contexts.flatMap((record) => record.label.type === 'context' ? record.label.kinds : []))
      .not.toContain('additionalContext');
    expect(contexts.flatMap((record) => record.label.type === 'context' ? record.label.kinds : []))
      .not.toContain('toolOutputProjection');

    if (!input) throw new Error('Expected input record');
    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: input.id });
    expect(detail.detail?.kind).toBe('input');
    if (detail.detail?.kind !== 'input') throw new Error('Expected input detail');
    expect(detail.detail.modelInputParts).toEqual([{ type: 'text', text: 'nihao' }]);
    expect(detail.detail.message?.content).toEqual([{ type: 'text', text: 'nihao' }]);
    expect(detail.detail.diagnostics?.providerCall?.request).toEqual({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'nihao' }] }],
    });
    expect(JSON.stringify(detail.detail)).not.toContain('Turn environment');
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);

    const context = contexts.find((record) => record.primaryEvidence.type === 'preparedContextPart');
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
    expect(contextDetail.detail.modelContextText).toContain('<context authority="application" purpose="observation">');
    expect(contextDetail.detail.modelContextText).toContain('Working directory: /workspace.');
    expect(contextDetail.detail.modelContextText).toContain('<context authority="untrusted" purpose="observation">');
    expect(contextDetail.detail.modelContextText).toContain('Viewing "Plan" [[node://');
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', contextDetail)).toEqual(contextDetail);
  });

  test('decodes provider cache breakpoint JSON paths in Trajectory detail', async () => {
    const base = inputEnvelopeDiagnostics();
    const cacheBreakpoints = ['$.messages[0].content[0].cache_control'];
    const projection = trajectoryProjection({
      diagnostics: {
        ...base,
        providerCalls: [{ ...base.providerCalls[0]!, cacheBreakpoints }],
      },
      contextPayload: turnEnvironmentPayload(),
      turn: inputEnvelopeTurn(),
    });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const input = response.records.find((record) => record.kind === 'input');
    if (!input) throw new Error('Expected input record');

    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: input.id });
    if (detail.detail?.kind !== 'input') throw new Error('Expected input detail');
    expect(detail.detail.diagnostics?.providerCall?.cacheBreakpoints).toEqual(cacheBreakpoints);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);
  });

  test('uses captured attachment, Node, and image input while keeping Node snapshots in Context', async () => {
    const base = inputEnvelopeDiagnostics();
    const call = base.providerCalls[0]!;
    const messageId = '7'.repeat(64);
    const imageDigest = '8'.repeat(64);
    const narrative = [
      'brief.txt: [[file:///workspace/brief.txt]]',
      ' Extract the attachment, inspect ',
      `Plan: ${REFERENCE_NODE_MARKER}`,
      ', and compare ',
      'diagram.png: [[file:///workspace/diagram.png]]',
      '.',
    ].join('');
    const attachmentText = [
      '[Attachment: brief.txt, text/plain, 64 bytes]',
      'Readable path: /workspace/brief.txt',
      'Use file_read with this path to inspect the attachment.',
    ].join('\n');
    const imageText = [
      '[Attachment image: diagram.png, image/png, 128 bytes]',
      `Artifact: ${'9'.repeat(64)}`,
      'Readable path: /workspace/diagram.png',
      'Image geometry: observation=1x1; source=1x1',
      'Source pixels per observation pixel: x=1, y=1',
      'Observation-to-source matrix: [1, 0, 0, 1, 0, 0]',
      'The following image is the immutable model observation for this attachment.',
    ].join('\n');
    const nodeContext = [
      '<system-reminder>',
      '<context authority="untrusted" purpose="observation">',
      `Supplied Node: "Plan" [[node://${REFERENCE_NODE_ID}]].`,
      'Supplied content:\nRelease plan body',
      '</context>',
      '</system-reminder>',
    ].join('\n');
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      canonicalMessages: [{
        id: messageId,
        estimatedTokens: 100,
        value: {
          role: 'user',
          content: [
            { type: 'text', text: narrative },
            { type: 'text', text: attachmentText },
            { type: 'text', text: imageText },
            {
              type: 'image',
              data: {
                omitted: true,
                encoding: 'base64',
                encodedLength: 12,
                byteLength: 8,
                sha256: imageDigest,
              },
              mimeType: 'image/png',
            },
            { type: 'text', text: nodeContext },
          ],
        },
      }],
      providerCalls: [{
        ...call,
        preparedContext: {
          ...call.preparedContext,
          messageIds: [messageId],
          messagePartProvenance: [[
            { source: 'userInput', itemId: 'user-message-rich' },
            { source: 'userInput', itemId: 'user-message-rich' },
            { source: 'userInput', itemId: 'user-message-rich' },
            { source: 'userInput', itemId: 'user-message-rich' },
            {
              source: 'systemContext',
              entries: [{
                kind: 'referencedResources',
                authority: 'untrusted',
                purpose: 'observation',
              }],
            },
          ]],
        },
        request: {
          kind: 'value',
          value: {
            input: [{
              role: 'user',
              content: [{
                type: 'input_image',
                image_url: { omitted: true, encoding: 'data-url', sha256: imageDigest },
              }],
            }],
          },
        },
      }],
      activities: [{
        type: 'acceptedInput',
        source: 'initial',
        acceptedAt: 106,
        itemIds: ['user-message-rich'],
        consumedByCallIndex: 0,
      }, { type: 'modelCall', callIndex: 0 }],
    };
    const turn: Turn = {
      ...inputEnvelopeTurn(),
      items: [{
        type: 'userMessage',
        author: { kind: 'reader' },
        id: 'user-message-rich',
        provenance: itemProvenance('user-message-rich'),
        clientId: null,
        content: [
          {
            type: 'attachment',
            id: 'attachment-text',
            name: 'brief.txt',
            mimeType: 'text/plain',
            sizeBytes: 64,
            source: { kind: 'localFile', path: '/workspace/brief.txt' },
          },
          { type: 'text', text: 'Extract the attachment and compare the references.' },
          { type: 'nodeReference', nodeId: REFERENCE_NODE_ID, note: 'Plan' },
          {
            type: 'attachment',
            id: 'attachment-image',
            name: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 128,
            source: { kind: 'localFile', path: '/workspace/diagram.png' },
            artifactRef: {
              id: '9'.repeat(64),
              createdAt: 100,
              retention: 'external',
              original: { kind: 'localFile', path: '/workspace/diagram.png' },
              observation: {
                id: 'resource:00000000-0000-4000-8000-000000000009',
                mimeType: 'image/png',
                byteLength: 8,
                fileName: 'diagram.png',
              },
              geometry: {
                sourceWidth: 1,
                sourceHeight: 1,
                observationWidth: 1,
                observationHeight: 1,
                observationToSource: [1, 0, 0, 1, 0, 0],
              },
            },
          },
        ],
        acceptedAt: 106,
      }],
    };
    const projection = trajectoryProjection({ diagnostics, turn });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const input = response.records.find((record) => record.kind === 'input');
    const context = response.records.find((record) => record.primaryEvidence.type === 'preparedContextPart');

    expect(input?.preview).toContain('brief.txt: [[file:///workspace/brief.txt]]');
    expect(input?.preview).not.toContain('brief.txt Extract the attachment and compare the references. Plan diagram.png');
    expect(context?.label).toEqual({ type: 'context', kinds: ['referencedResources'] });
    if (!input || !context) throw new Error('Expected input and referenced-resource Context records');

    const inputDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: input.id });
    if (inputDetail.detail?.kind !== 'input') throw new Error('Expected input detail');
    const inputText = inputDetail.detail.modelInputParts
      ?.flatMap((part) => part.type === 'text' ? [part.text] : [])
      .join('\n\n') ?? '';
    expect(inputDetail.detail.modelInputParts?.map((part) => part.type)).toEqual([
      'text',
      'text',
      'text',
      'image',
    ]);
    expect(inputText).toContain('brief.txt: [[file:///workspace/brief.txt]]');
    expect(inputText).toContain(`Plan: ${REFERENCE_NODE_MARKER}`);
    expect(inputText).toContain('diagram.png: [[file:///workspace/diagram.png]]');
    expect(inputText).toContain('Readable path: /workspace/brief.txt');
    expect(inputText).toContain('Readable path: /workspace/diagram.png');
    expect(inputText).toContain('Use file_read with this path to inspect the attachment.');
    expect(inputText).toContain('[Attachment image: diagram.png, image/png, 128 bytes]');
    expect(inputText).not.toContain('Supplied content:');
    expect(inputDetail.detail.modelInputParts?.at(-1)).toEqual({
      type: 'image',
      mimeType: 'image/png',
      byteLength: 8,
      sha256: imageDigest,
    });
    expect(JSON.stringify(inputDetail.detail.diagnostics?.providerCall?.request)).toContain(imageDigest);
    expect(JSON.stringify(inputDetail)).not.toContain('iVBOR');

    const contextDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: context.id });
    if (contextDetail.detail?.kind !== 'context') throw new Error('Expected Context detail');
    expect(contextDetail.detail.modelContextText).toContain('Supplied content:\nRelease plan body');
    expect(inputText).not.toContain(contextDetail.detail.modelContextText!);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', inputDetail)).toEqual(inputDetail);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', contextDetail)).toEqual(contextDetail);
  });

  test('never substitutes canonical accepted input for missing prepared provider evidence', async () => {
    const turn = trajectoryTurnWithInput(0);
    const projection = trajectoryProjection({ turns: [turn], diagnosticsByRef: new Map() });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const input = response.records.find((record) => record.kind === 'input');

    expect(input?.preview).toBeNull();
    expect(input?.availability).toEqual([{ reason: 'diagnosticsUnavailable' }]);
    if (!input) throw new Error('Expected fallback Input record');

    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: input.id });
    if (detail.detail?.kind !== 'input') throw new Error('Expected fallback Input detail');
    expect(detail.detail.modelInputParts).toBeNull();
    expect(detail.detail.message?.content).toEqual([{ type: 'text', text: 'message 0' }]);
  });

  test('preserves credential-looking strings in summaries and exact detail evidence', async () => {
    const secret = `sk-${'a'.repeat(32)}`;
    const base = trajectoryDiagnostics();
    const batch = base.activities.find((activity) => activity.type === 'toolExecutionBatch');
    if (!batch || batch.type !== 'toolExecutionBatch') throw new Error('Expected tool batch');
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      stablePrompt: {
        ...base.stablePrompt!,
        blocks: [{
          ...base.stablePrompt!.blocks[0]!,
          text: `System ${secret}`,
        }],
      },
      providerCalls: [{
        ...base.providerCalls[0]!,
        request: { kind: 'value' as const, value: { input: `Authorization: Bearer ${secret}` } },
        response: {
          ...base.providerCalls[0]!.response!,
          value: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'provider:call:one',
                name: 'first_tool',
                arguments: { token: secret },
              },
              { type: 'output_text', text: `token ${secret}` },
            ],
          },
        },
      }],
      activities: [
        base.activities[0]!,
        {
          ...batch,
          executions: [{ ...batch.executions[0]!, itemId: 'tool-with-output' }],
        },
      ],
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
        modelCall: {
          disposition: 'replayable' as const,
          identity: { namespace: null, name: 'first_tool' },
          providerName: 'first_tool',
          providerCall: testProviderCall('first_tool', { token: secret }),
          arguments: { storage: 'inline' as const, value: { token: secret } },
          schemaDigest: '8'.repeat(64),
        },
        pluginId: null,
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
    expect(JSON.stringify(response)).toContain(secret);

    const assistant = response.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');
    const assistantDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    expect(JSON.stringify(assistantDetail)).toContain(secret);

    const system = response.records.find((record) => record.primaryEvidence.type === 'stablePrompt');
    if (!system) throw new Error('Expected System Prompt record');
    const systemDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: system.id });
    expect(JSON.stringify(systemDetail)).toContain(secret);

    const tool = response.records.find((record) => record.kind === 'tool');
    if (!tool) throw new Error('Expected Tool record');
    const toolDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: tool.id });
    if (toolDetail.detail?.kind !== 'tool') throw new Error('Expected Tool detail');
    expect(toolDetail.detail.input).toEqual({ token: secret });
    expect(toolDetail.detail.outputText).toBe(`Raw tool output ${secret}`);
  });

  test('preserves a System Reminder after more than 64,000 preceding characters', async () => {
    const reminder = '<system-reminder>'.padEnd(8_087, 'R');
    const exactPrompt = `${'P'.repeat(64_001)}${reminder}`;
    const base = trajectoryDiagnostics();
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      stablePrompt: {
        ...base.stablePrompt!,
        blocks: [{
          ...base.stablePrompt!.blocks[0]!,
          text: exactPrompt,
        }],
      },
      requestFragments: [{ id: 'system', value: exactPrompt }],
    };
    const projection = trajectoryProjection({ diagnostics });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });

    expect(response.records.some((record) => record.kind === 'assistant')).toBe(true);
    expect(response.records.some((record) => record.primaryEvidence.type === 'toolCatalog')).toBe(true);
    expect(decodeAgentCoreResponse('thread/trajectory/read', response)).toEqual(response);

    const system = response.records.find((record) => record.primaryEvidence.type === 'stablePrompt');
    if (!system) throw new Error('Expected System Prompt record');
    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: system.id });
    if (detail.detail?.kind !== 'context') throw new Error('Expected Context detail');
    expect(detail.detail.modelContextText).toBe(exactPrompt);
    expect(detail.detail.payload).toMatchObject({
      stablePrompt: { blocks: [{ text: exactPrompt }] },
    });
    expect(detail.record?.availability).toEqual([]);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);
  });

  test('preserves multiple large provider evidence leaves without a shared response budget', async () => {
    const base = trajectoryDiagnostics();
    const large = 'Evidence '.padEnd(19_000, 'x');
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      providerCalls: [{
        ...base.providerCalls[0]!,
        request: {
          kind: 'value',
          value: { first: large, second: large, third: large },
        },
        response: {
          ...base.providerCalls[0]!.response!,
          value: {
            role: 'assistant',
            content: [
              { type: 'text', text: large },
              { type: 'text', text: large },
              { type: 'text', text: large },
            ],
          },
        },
      }],
    };
    const projection = trajectoryProjection({ diagnostics });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const assistant = response.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');

    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    if (detail.detail?.kind !== 'assistant') throw new Error('Expected Assistant detail');
    expect(detail.detail.diagnostics?.providerCall?.request).toEqual({
      first: large,
      second: large,
      third: large,
    });
    expect(detail.detail.modelOutputParts).toEqual([
      { type: 'text', text: large },
      { type: 'text', text: large },
      { type: 'text', text: large },
    ]);
    expect(detail.record?.availability).toEqual([]);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', detail)).toEqual(detail);
  });

  test('preserves collections beyond 100 entries and deeply nested valid JSON', async () => {
    let deep: import('../../src/core/agent/protocol').JsonValue = 'deep-sentinel';
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    const output = Array.from({ length: 150 }, (_, index) => ({
      type: 'text',
      text: `part-${index}`,
    }));
    const base = trajectoryDiagnostics();
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      providerCalls: [{
        ...base.providerCalls[0]!,
        request: { kind: 'value', value: { deep } },
        response: {
          ...base.providerCalls[0]!.response!,
          value: { role: 'assistant', content: output },
        },
      }],
    };
    const projection = trajectoryProjection({ diagnostics });
    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const assistant = response.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');

    const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    if (detail.detail?.kind !== 'assistant') throw new Error('Expected Assistant detail');
    expect(detail.detail.modelOutputParts).toHaveLength(150);
    expect(detail.detail.modelOutputParts?.at(-1)).toEqual({ type: 'text', text: 'part-149' });
    expect(detail.detail.diagnostics?.providerCall?.request).toEqual({ deep });
    expect(JSON.stringify(detail)).toContain('deep-sentinel');
    expect(detail.record?.availability).toEqual([]);
  });

  test('preserves large input evidence and typed activities together', async () => {
    const large = 'Evidence '.padEnd(19_000, 'x');
    const inputText = 'Input '.padEnd(30_000, 'x');
    const inputDiagnostics = inputEnvelopeDiagnostics();
    const canonicalMessage = inputDiagnostics.canonicalMessages[0]!;
    const inputProjection = trajectoryProjection({
      diagnostics: {
        ...inputDiagnostics,
        canonicalMessages: [{
          ...canonicalMessage,
          value: {
            role: 'user',
            content: [{ type: 'input_text', text: inputText }],
          },
        }],
      },
      turn: {
        ...inputEnvelopeTurn(),
        items: inputEnvelopeTurn().items.map((item) => item.type === 'userMessage'
          ? { ...item, content: [{ type: 'text' as const, text: inputText }] }
          : item),
      },
    });
    const inputRead = await inputProjection.read({ threadId: THREAD_ID, limit: 100 });
    const inputRecord = inputRead.records.find((record) => record.kind === 'input');
    if (!inputRecord) throw new Error('Expected Input record');

    const inputDetail = await inputProjection.readDetail({
      threadId: THREAD_ID,
      recordId: inputRecord.id,
    });
    if (inputDetail.detail?.kind !== 'input') throw new Error('Expected Input detail');
    expect(inputDetail.detail.modelInputParts).toEqual([{ type: 'text', text: inputText }]);
    expect(inputDetail.detail.message?.content).toEqual([{ type: 'text', text: inputText }]);
    expect(inputDetail.detail.diagnostics?.activity).toMatchObject({ type: 'acceptedInput' });
    expect(inputDetail.record?.availability).toEqual([]);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', inputDetail)).toEqual(inputDetail);

    const toolDiagnostics = trajectoryDiagnostics();
    const batch = toolDiagnostics.activities.find((activity) => activity.type === 'toolExecutionBatch');
    if (!batch || batch.type !== 'toolExecutionBatch') throw new Error('Expected tool batch');
    const toolProjection = trajectoryProjection({
      diagnostics: {
        ...toolDiagnostics,
        activities: [
          toolDiagnostics.activities[0]!,
          {
            ...batch,
            executions: [{ ...batch.executions[0]!, itemId: 'tool-large' }],
          },
        ],
      },
      turn: {
        ...trajectoryTurn(),
        items: [commandItem('tool-large', {
          disposition: 'replayable',
          identity: { namespace: null, name: 'first_tool' },
          providerName: 'first_tool',
          providerCall: testProviderCall('first_tool', { first: large, second: large, third: large }),
          arguments: { storage: 'inline', value: { first: large, second: large, third: large } },
          schemaDigest: '8'.repeat(64),
        }, null)],
      },
    });
    const toolRead = await toolProjection.read({ threadId: THREAD_ID, limit: 100 });
    const toolRecord = toolRead.records.find((record) => record.kind === 'tool');
    if (!toolRecord) throw new Error('Expected Tool record');

    const toolDetail = await toolProjection.readDetail({ threadId: THREAD_ID, recordId: toolRecord.id });
    if (toolDetail.detail?.kind !== 'tool') throw new Error('Expected Tool detail');
    expect(toolDetail.detail.diagnostics?.activity).toMatchObject({ type: 'toolExecutionBatch' });
    expect(toolDetail.record?.availability).toEqual([]);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', toolDetail)).toEqual(toolDetail);
  });

  test('bounds oversized provider tool-call identities only in record keys', async () => {
    const callId = `call:${'x'.repeat(70_000)}`;
    const expectedIdentity = `tenon:tool-call:sha256:${createHash('sha256').update(callId, 'utf8').digest('hex')}`;
    const base = trajectoryDiagnostics();
    const batch = base.activities.find((activity) => activity.type === 'toolExecutionBatch');
    if (!batch || batch.type !== 'toolExecutionBatch') throw new Error('Expected tool batch');
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      providerCalls: [{
        ...base.providerCalls[0]!,
        response: {
          ...base.providerCalls[0]!.response!,
          value: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: callId, name: 'first_tool', arguments: {} }],
          },
        },
      }],
      activities: [
        base.activities[0]!,
        {
          ...batch,
          executions: [{ ...batch.executions[0]!, callId, providerResponsePartIndex: 0, itemId: null }],
        },
      ],
    };
    const projection = trajectoryProjection({ diagnostics });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const tool = response.records.find((record) => record.kind === 'tool');
    if (!tool || tool.primaryEvidence.type !== 'toolExecution') throw new Error('Expected Tool record');
    expect(tool.primaryEvidence.callId).toBe(expectedIdentity);
    expect(tool.id).toContain(encodeURIComponent(expectedIdentity));
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(64_000);
    expect(decodeAgentCoreResponse('thread/trajectory/read', response)).toEqual(response);

    const toolDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: tool.id });
    if (toolDetail.detail?.kind !== 'tool') throw new Error('Expected Tool detail');
    expect(toolDetail.detail.executionCallId).toBe(callId);
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', toolDetail)).toEqual(toolDetail);

    const assistant = response.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');
    const assistantDetail = await projection.readDetail({ threadId: THREAD_ID, recordId: assistant.id });
    if (assistantDetail.detail?.kind !== 'assistant') throw new Error('Expected Assistant detail');
    expect(assistantDetail.detail.modelOutputParts).toContainEqual({
      type: 'toolCall',
      callId,
      name: 'first_tool',
      arguments: {},
    });
    expect(decodeAgentCoreResponse('thread/trajectory/detail/read', assistantDetail)).toEqual(assistantDetail);
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
    let activeReads = 0;
    const projection = trajectoryProjection({
      turn: activeTurn,
      activeDiagnostics: (_threadId, turnId) => {
        activeReads += 1;
        if (turnId !== activeTurn.id) return null;
        return activeReads === 1 ? activeDiagnostics : trajectoryDiagnostics();
      },
    });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const assistant = response.records.find((record) => record.kind === 'assistant');
    expect(assistant).toMatchObject({
      kind: 'assistant',
      state: 'running',
      label: { type: 'assistantCall', callIndex: 0 },
    });
    expect(response.records.some((record) => record.kind === 'tool')).toBe(true);

    const refreshed = await projection.read({ threadId: THREAD_ID, limit: 100 });
    expect(activeReads).toBe(2);
    expect(refreshed.records.find((record) => record.kind === 'assistant')?.state).toBe('completed');
  });

  test('makes oversized active diagnostics wholly unavailable', async () => {
    const activeTurn = {
      ...trajectoryTurn(),
      status: 'inProgress' as const,
      completedAt: null,
      durationMs: null,
      execution: { ...trajectoryTurn().execution, diagnosticsRef: null },
    };
    const base = trajectoryDiagnostics();
    const activeDiagnostics: TurnDiagnosticsPayload = {
      ...base,
      stablePrompt: {
        ...base.stablePrompt!,
        blocks: [{
          ...base.stablePrompt!.blocks[0]!,
          text: 'x'.repeat(MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES),
        }],
      },
    };
    const projection = trajectoryProjection({
      turn: activeTurn,
      activeDiagnostics: () => activeDiagnostics,
    });

    const response = await projection.read({ threadId: THREAD_ID, limit: 100 });
    expect(response.records.some((record) => record.kind === 'assistant')).toBeFalse();
    expect(response.summary.availability).toContainEqual({ reason: 'diagnosticsUnavailable' });
    expect(response.records.every((record) => (
      record.availability.some((entry) => entry.reason === 'diagnosticsUnavailable')
    ))).toBeTrue();
  });

  test('does not cache unavailable diagnostics after their retained payload recovers', async () => {
    const diagnosticsByRef = new Map<string, TurnDiagnosticsPayload>();
    let diagnosticsReads = 0;
    const projection = trajectoryProjection({
      diagnosticsByRef,
      onReadDiagnostics: () => { diagnosticsReads += 1; },
    });

    const unavailable = await projection.read({ threadId: THREAD_ID, limit: 100 });
    expect(unavailable.summary.availability).toContainEqual({ reason: 'diagnosticsUnavailable' });
    expect(unavailable.records.some((record) => record.kind === 'assistant')).toBeFalse();

    diagnosticsByRef.set(DIAGNOSTICS_REF.id, trajectoryDiagnostics());
    const recovered = await projection.read({ threadId: THREAD_ID, limit: 100 });
    expect(diagnosticsReads).toBe(2);
    expect(recovered.records.some((record) => record.kind === 'assistant')).toBeTrue();
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
            messageIds: [firstCall.preparedContext.messageIds[0]!, secondMessageId],
            messagePartProvenance: [
              firstCall.preparedContext.messagePartProvenance[0]!,
              [
                { source: 'userInput', itemId: 'user-message-2' },
                {
                  source: 'systemContext',
                  entries: [{
                    kind: 'turnEnvironment',
                    authority: 'application',
                    purpose: 'observation',
                  }],
                },
              ],
            ],
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
    const inputs = response.records.filter((record) => record.kind === 'input');
    const contexts = response.records.filter((record) => record.primaryEvidence.type === 'preparedContextPart');
    expect(inputs.map((record) => record.preview)).toEqual(['nihao', 'later']);
    expect(contexts).toHaveLength(2);
    expect(contexts.map((record) => record.primaryEvidence)).toEqual([
      { type: 'preparedContextPart', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 0, messageIndex: 0, partIndex: 1 },
      { type: 'preparedContextPart', threadId: THREAD_ID, turnId: TURN_ID, callIndex: 1, messageIndex: 1, partIndex: 1 },
    ]);
    const details = await Promise.all(inputs.map((input) => projection.readDetail({
      threadId: THREAD_ID,
      recordId: input.id,
    })));
    expect(details.map((detail) => detail.detail?.kind === 'input' ? detail.detail.modelInputParts : null))
      .toEqual([
        [{ type: 'text', text: 'nihao' }],
        [{ type: 'text', text: 'later' }],
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

  test('keeps record order stable between tail and overlapping cursor windows', async () => {
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
    expect(cursorAssistant?.orderKey).toBe(tailAssistant?.orderKey);
  });

  test('classifies structural records consistently in full and focused windows', async () => {
    const turns = Array.from({ length: 3 }, (_, index) => trajectoryTurnWithDiagnosticsRef(index));
    const diagnosticsByRef = new Map(turns.map((turn) => [
      turn.execution.diagnosticsRef!.id,
      trajectoryDiagnostics(),
    ]));
    const projection = trajectoryProjection({ turns, diagnosticsByRef });
    const targetTurn = turns[1]!;

    const full = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const focused = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      focus: { turnId: targetTurn.id },
    });
    const structuralLabels = (response: ThreadTrajectoryReadResponse) => response.records
      .filter((record) => record.turnId === targetTurn.id)
      .filter((record) => record.primaryEvidence.type === 'stablePrompt'
        || record.primaryEvidence.type === 'toolCatalog')
      .map((record) => record.label);

    expect(structuralLabels(focused)).toEqual(structuralLabels(full));
    expect(structuralLabels(focused)).toEqual([]);
  });

  test('treats structural state after a diagnostics gap consistently in every read mode', async () => {
    const turns = Array.from({ length: 4 }, (_, index) => trajectoryTurnWithDiagnosticsRef(index));
    const diagnosticsByRef = new Map([
      [turns[0]!.execution.diagnosticsRef!.id, structuralDiagnostics('a')],
      [turns[2]!.execution.diagnosticsRef!.id, structuralDiagnostics('b')],
      [turns[3]!.execution.diagnosticsRef!.id, structuralDiagnostics('c')],
    ]);
    const projection = trajectoryProjection({ turns, diagnosticsByRef });
    const afterGap = turns[2]!;
    const afterKnownBaseline = turns[3]!;
    const structuralRecords = (response: ThreadTrajectoryReadResponse, turnId: string) => response.records
      .filter((record) => record.turnId === turnId)
      .filter((record) => record.primaryEvidence.type === 'stablePrompt'
        || record.primaryEvidence.type === 'toolCatalog');

    const full = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const focusedByTurn = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      focus: { turnId: afterGap.id },
    });
    const missingStructuralId = `turn:${afterGap.id}:context:tools:0`;
    const focusedByRecord = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      focus: { recordId: missingStructuralId },
    });
    const missingDetail = await projection.readDetail({
      threadId: THREAD_ID,
      recordId: missingStructuralId,
    });

    expect(structuralRecords(full, afterGap.id)).toEqual([]);
    expect(structuralRecords(focusedByTurn, afterGap.id)).toEqual([]);
    expect(structuralRecords(focusedByRecord, afterGap.id)).toEqual([]);
    expect(missingDetail).toEqual({ threadId: THREAD_ID, record: null, detail: null });

    const visibleStructural = structuralRecords(full, afterKnownBaseline.id);
    expect(visibleStructural.map((record) => record.label.type).sort()).toEqual(['systemPrompt', 'toolCatalog']);
    for (const record of visibleStructural) {
      const focused = await projection.read({
        threadId: THREAD_ID,
        limit: 1,
        focus: { recordId: record.id },
      });
      const detail = await projection.readDetail({ threadId: THREAD_ID, recordId: record.id });
      expect(focused.records.some((candidate) => candidate.id === record.id)).toBe(true);
      expect(detail.record?.id).toBe(record.id);
      expect(detail.detail).not.toBeNull();
    }
  });

  test('retains an empty predecessor catalog as the known boundary state', async () => {
    const turns = Array.from({ length: 2 }, (_, index) => trajectoryTurnWithDiagnosticsRef(index));
    const emptyCatalog = trajectoryDiagnostics();
    const diagnosticsByRef = new Map([
      [turns[0]!.execution.diagnosticsRef!.id, {
        ...emptyCatalog,
        configuration: { ...emptyCatalog.configuration, tools: [] },
        toolSchemas: [],
        providerCalls: [{
          ...emptyCatalog.providerCalls[0]!,
          preparedContext: {
            ...emptyCatalog.providerCalls[0]!.preparedContext,
            toolNames: [],
          },
        }],
      }],
      [turns[1]!.execution.diagnosticsRef!.id, trajectoryDiagnostics()],
    ]);
    const projection = trajectoryProjection({ turns, diagnosticsByRef });

    const focused = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      focus: { turnId: turns[1]!.id },
    });
    const toolCatalog = focused.records.find((record) => record.primaryEvidence.type === 'toolCatalog');

    expect(toolCatalog?.turnId).toBe(turns[1]!.id);
    expect(toolCatalog?.label).toEqual({
      type: 'toolCatalog',
      change: 'updated',
      requestIndex: 0,
      toolCount: 2,
    });
  });

  test('expands only required ancestors without returning structural siblings beyond the limit', async () => {
    const base = trajectoryDiagnostics();
    const batch = base.activities.find((activity) => activity.type === 'toolExecutionBatch');
    if (!batch || batch.type !== 'toolExecutionBatch') throw new Error('Expected tool batch');
    const diagnostics: TurnDiagnosticsPayload = {
      ...base,
      activities: [
        { type: 'modelCall', callIndex: 0 },
        {
          ...batch,
          executions: Array.from({ length: 300 }, (_, index) => ({
            ...batch.executions[0]!,
            callId: `call:${index}`,
            providerResponsePartIndex: index,
            toolName: 'first_tool',
            itemId: null,
          })),
        },
      ],
    };
    const projection = trajectoryProjection({ diagnostics });
    const assistantId = `turn:${TURN_ID}:assistant:0`;
    const firstToolId = `turn:${TURN_ID}:tool:1:${encodeURIComponent('call:0')}`;
    const secondToolId = `turn:${TURN_ID}:tool:1:${encodeURIComponent('call:1')}`;

    const parentPage = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      cursor: `before:${encodeURIComponent(firstToolId)}`,
    });
    expect(parentPage.records.map((record) => record.id)).toEqual([assistantId]);
    expect(parentPage.replacementRange).toEqual(replacementRangeForRecords(parentPage.records));

    const childPage = await projection.read({
      threadId: THREAD_ID,
      limit: 1,
      cursor: `before:${encodeURIComponent(secondToolId)}`,
    });
    expect(childPage.records.map((record) => record.id)).toEqual([assistantId, firstToolId]);
    expect(childPage.replacementRange).toEqual(replacementRangeForRecords([
      childPage.records.find((record) => record.id === firstToolId)!,
    ]));

    const expandedBatch = diagnostics.activities[1];
    if (expandedBatch?.type !== 'toolExecutionBatch') throw new Error('Expected expanded tool batch');
    const traversalDiagnostics: TurnDiagnosticsPayload = {
      ...diagnostics,
      activities: [
        diagnostics.activities[0]!,
        {
          ...expandedBatch,
          executions: expandedBatch.executions.slice(0, 3),
        },
      ],
    };
    const traversalProjection = trajectoryProjection({ diagnostics: traversalDiagnostics });
    const visitedToolIds: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await traversalProjection.read({
        threadId: THREAD_ID,
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      visitedToolIds.push(...page.records.filter((record) => record.kind === 'tool').map((record) => record.id));
      cursor = page.olderCursor;
      if (cursor === null) break;
    }
    expect(visitedToolIds).toEqual([
      `turn:${TURN_ID}:tool:1:${encodeURIComponent('call:2')}`,
      `turn:${TURN_ID}:tool:1:${encodeURIComponent('call:1')}`,
      `turn:${TURN_ID}:tool:1:${encodeURIComponent('call:0')}`,
    ]);
  });

  test('keeps an existing Assistant order key when active diagnostics add a changed tool catalog', async () => {
    const turn = {
      ...trajectoryTurn(),
      status: 'inProgress' as const,
      completedAt: null,
      durationMs: null,
      execution: { ...trajectoryTurn().execution, diagnosticsRef: null },
    };
    let diagnostics = trajectoryDiagnostics();
    const projection = trajectoryProjection({
      turn,
      activeDiagnostics: () => diagnostics,
    });
    const initial = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const assistant = initial.records.find((record) => record.kind === 'assistant');
    if (!assistant) throw new Error('Expected Assistant record');

    const firstCall = diagnostics.providerCalls[0]!;
    diagnostics = {
      ...diagnostics,
      providerCalls: [
        firstCall,
        {
          ...firstCall,
          index: 1,
          requestedAt: 260,
          preparedContext: { ...firstCall.preparedContext, toolNames: ['first_tool'] },
          requestFingerprint: '8'.repeat(64),
        },
      ],
      activities: [...diagnostics.activities, { type: 'modelCall', callIndex: 1 }],
    };
    const refreshed = await projection.read({ threadId: THREAD_ID, limit: 100 });
    const sameAssistant = refreshed.records.find((record) => record.id === assistant.id);

    expect(sameAssistant?.orderKey).toBe(assistant.orderKey);
    expect(refreshed.records.filter((record) => record.primaryEvidence.type === 'toolCatalog'))
      .toHaveLength(2);
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
    expect(diagnosticsReads).toBeLessThanOrEqual(2);
  });

  test('scales tail refresh by covered records and reuses completed Turn summaries', async () => {
    const turns = Array.from({ length: 10_000 }, (_, index) => trajectoryTurnWithDiagnosticsRef(index));
    const diagnosticsByRef = new Map(turns.map((turn) => [
      turn.execution.diagnosticsRef!.id,
      trajectoryDiagnostics(),
    ]));
    const turnViews: TurnItemsView[] = [];
    let diagnosticsReads = 0;
    let fullTurnReads = 0;
    let rangedTurnHeaders = 0;
    const projection = trajectoryProjection({
      turns,
      diagnosticsByRef,
      onAllTurns: (itemsView) => { turnViews.push(itemsView); },
      onReadDiagnostics: () => { diagnosticsReads += 1; },
      onReadTurn: () => { fullTurnReads += 1; },
      onTrajectoryTurnRange: (start, end) => { rangedTurnHeaders += end - start; },
    });

    const first = await projection.read({ threadId: THREAD_ID, limit: 120 });
    const coldDiagnosticsReads = diagnosticsReads;
    const coldTurnReads = fullTurnReads;

    expect(first.records.length).toBeGreaterThanOrEqual(120);
    expect(turnViews).toEqual([]);
    expect(coldDiagnosticsReads).toBeLessThan(50);
    expect(coldTurnReads).toBe(coldDiagnosticsReads);
    expect(rangedTurnHeaders).toBeLessThan(50);

    const refreshed = await projection.read({ threadId: THREAD_ID, limit: 120 });

    expect(refreshed.records.map((record) => record.id)).toEqual(first.records.map((record) => record.id));
    expect(diagnosticsReads).toBe(coldDiagnosticsReads);
    expect(fullTurnReads).toBe(coldTurnReads);

    const selected = refreshed.records.find((record) => record.kind === 'assistant');
    if (!selected) throw new Error('Expected an Assistant record');
    for (let index = 0; index < 300; index += 1) {
      await projection.readDetail({ threadId: THREAD_ID, recordId: selected.id });
    }
    expect(diagnosticsReads).toBeGreaterThan(coldDiagnosticsReads);
    const readsAfterDetail = diagnosticsReads;

    await projection.read({ threadId: THREAD_ID, limit: 120 });
    expect(diagnosticsReads).toBe(readsAfterDetail);
  });
});

function replacementRangeForRecords(
  records: readonly { readonly orderKey: string }[],
): ThreadTrajectoryReplacementRange | null {
  const first = records[0] ?? null;
  const last = records.at(-1) ?? null;
  return first && last ? { startOrderKey: first.orderKey, endOrderKey: last.orderKey } : null;
}

function trajectoryProjection(overrides: {
  readonly contextPayload?: ThreadContextPayload | null;
  readonly diagnostics?: TurnDiagnosticsPayload;
  readonly diagnosticsByRef?: ReadonlyMap<string, TurnDiagnosticsPayload>;
  readonly activeDiagnostics?: (threadId: string, turnId: string) => TurnDiagnosticsPayload | null;
  readonly toolOutput?: string | null;
  readonly turn?: Turn;
  readonly turns?: readonly Turn[];
  readonly onAllTurns?: (itemsView: TurnItemsView) => void;
  readonly onReadDiagnostics?: (ref: TurnDiagnosticsPayloadReference) => void;
  readonly onReadTurn?: (turnId: string) => void;
  readonly onTrajectoryTurnRange?: (start: number, end: number) => void;
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
    allTurns: (threadId: string, itemsView: TurnItemsView = 'full') => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      overrides.onAllTurns?.(itemsView);
      return itemsView === 'notLoaded'
        ? turns.map((turn) => ({ ...turn, items: [], itemsView }))
        : turns;
    },
    trajectoryTurnOverview: (threadId: string) => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      const usage = turns.reduce((total, turn) => ({
        input: total.input + turn.execution.usage.input,
        output: total.output + turn.execution.usage.output,
        cacheRead: total.cacheRead + turn.execution.usage.cacheRead,
        cacheWrite: total.cacheWrite + turn.execution.usage.cacheWrite,
        reasoning: null,
        totalTokens: total.totalTokens + turn.execution.usage.totalTokens,
        costUsd: total.costUsd === null || turn.execution.usage.cost === null
          ? null
          : total.costUsd + turn.execution.usage.cost.total,
      }), {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        totalTokens: 0,
        costUsd: turns.length === 0 ? null : 0,
      });
      return {
        completedAt: turns.length === 0 || turns.some((turn) => turn.completedAt === null)
          ? null
          : Math.max(...turns.map((turn) => turn.completedAt ?? turn.startedAt)),
        diagnosticsUnavailable: turns.some((turn) => (
          turn.status !== 'inProgress' && turn.execution.diagnosticsRef === null
        )),
        startedAt: turns.length === 0 ? null : Math.min(...turns.map((turn) => turn.startedAt)),
        turnCount: turns.length,
        usage: turns.length === 0 ? null : usage,
      };
    },
    trajectoryTurnPosition: (threadId: string, turnId: string) => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      const position = turns.findIndex((turn) => turn.id === turnId);
      return position < 0 ? null : position;
    },
    trajectoryTurnRange: (threadId: string, start: number, end: number) => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      overrides.onTrajectoryTurnRange?.(start, end);
      return turns.slice(start, end).map((turn) => ({
        ...turn,
        items: [],
        itemsView: 'notLoaded' as const,
      }));
    },
    readTurn: (threadId: string, turnId: string) => {
      if (threadId !== THREAD_ID) throw new Error('Unknown Thread');
      overrides.onReadTurn?.(turnId);
      return turns.find((turn) => turn.id === turnId) ?? null;
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

function commandItem(
  id: string,
  modelCall: Extract<ThreadItem, { type: 'commandExecution' }>['modelCall'],
  outputRef: Extract<ThreadItem, { type: 'commandExecution' }>['outputRef'],
): Extract<ThreadItem, { type: 'commandExecution' }> {
  return {
    type: 'commandExecution',
    id,
    provenance: itemProvenance(id),
    status: 'completed',
    outputRef,
    command: 'printf host',
    description: 'Host-derived display value',
    cwd: '/host/injected',
    processId: null,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: 10,
    modelCall,
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
        author: { kind: 'reader' },
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
      author: { kind: 'reader' },
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
    internalTextRefs: [],
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
    internalTextRefs: [],
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
    internalTextRefs: [],
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
    requestFragments: [{ id: 'system', value: 'System instructions' }],
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
      requestFingerprint: 'b'.repeat(64),
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
        value: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'provider:call:one',
              name: 'first_tool',
              arguments: { command: 'printf model', timeout: 5_000, run_in_background: true },
            },
            {
              type: 'toolCall',
              id: 'provider:call:two',
              name: 'second_tool',
              arguments: { file_path: '/workspace/second-payload.ts' },
            },
          ],
        },
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
            providerResponsePartIndex: 0,
            toolName: 'first_tool',
            itemId: null,
            admissionDisposition: 'replayable',
            canonicalIdentity: null,
            schemaDigest: null,
            startedAt: 190,
            completedAt: 210,
            status: 'completed',
          },
          {
            callId: 'call:two:with:colon',
            providerResponsePartIndex: 1,
            toolName: 'second_tool',
            itemId: null,
            admissionDisposition: 'replayable',
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

function structuralDiagnostics(version: string): TurnDiagnosticsPayload {
  const base = trajectoryDiagnostics();
  const toolName = `tool_${version}`;
  return {
    ...base,
    configuration: {
      ...base.configuration,
      tools: [toolName],
    },
    stablePrompt: {
      blocks: [{
        id: 'system',
        layer: 'L0',
        text: `System instructions ${version}`,
        fingerprint: `block-${version}`,
      }],
      fingerprints: {
        l0: `l0-${version}`,
        l1: `l1-${version}`,
        l2: `l2-${version}`,
        complete: `complete-${version}`,
      },
    },
    toolSchemas: [{
      name: toolName,
      description: `Tool ${version}`,
      parameters: { type: 'object' },
    }],
    requestFragments: [{ id: 'system', value: `System instructions ${version}` }],
    providerCalls: [{
      ...base.providerCalls[0]!,
      preparedContext: {
        ...base.providerCalls[0]!.preparedContext,
        toolNames: [toolName],
      },
      requestFingerprint: version.repeat(64).slice(0, 64),
    }],
  };
}

function inputEnvelopeDiagnostics(): TurnDiagnosticsPayload {
  const messageId = '4'.repeat(64);
  const modelContextText = [
    '<system-reminder>',
    '<context authority="application" purpose="observation">',
    'Local time at this input: 2026-09-01T11:14:11+08:00 [Asia/Shanghai].',
    'Working directory: /workspace.',
    '</context>',
    '<context authority="untrusted" purpose="observation">',
    `Viewing "Plan" [[node://${REFERENCE_NODE_ID}]].`,
    '</context>',
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
          { source: 'userInput', itemId: 'user-message-1' },
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
