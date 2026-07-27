import { describe, expect, test } from 'bun:test';
import {
  AgentProtocolCodecError,
  createLocalItemProvenance,
  createLocalTurnProvenance,
  decodeAgentCoreRequest,
  decodeAgentCoreResponse,
  decodeAgentCoreNotification,
  decodeAgentCoreRecordedNotification,
  decodePrivilegedTurnStartRequest,
  decodeRendererTurnStartRequest,
  decodeThread,
  decodeThreadContextPayload,
  decodeThreadContextPayloadJson,
  decodeThreadItem,
  decodeThreadItemJson,
  decodeThreadJson,
  decodeTurn,
  encodeThread,
  encodeThreadContextPayload,
  encodeThreadItem,
} from '../../src/core/agent/codec';
import {
  AGENT_CORE_METHODS,
  THREAD_ITEM_TYPES,
  THREAD_MESSAGE_CONTEXT_MENU_ACTIONS,
  THREAD_MESSAGE_CONTEXT_MENU_CAPABILITY_FIELDS,
  threadFeatureSource,
  type Thread,
  type ThreadContextPayload,
  type ThreadItem,
  type ThreadMessageContextMenuRequest,
  type Turn,
} from '../../src/core/agent/protocol';

const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const SESSION_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abd';
const TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abe';
const CHILD_THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abf';
const OUTPUT_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const imageResourceRef = {
  id: '9'.repeat(64),
  mimeType: 'image/png',
  byteLength: 12,
  fileName: 'tool-output.png',
};
const contextRef = {
  id: 'a'.repeat(64),
  mimeType: 'application/vnd.tenon.agent-context+json' as const,
  byteLength: 32,
  schemaVersion: 1 as const,
  kind: 'turnEnvironment' as const,
};
const summaryContextRef = {
  ...contextRef,
  id: 'b'.repeat(64),
  kind: 'compactionSummary' as const,
};
const restoredContextRef = {
  ...contextRef,
  id: 'c'.repeat(64),
  kind: 'compactionRestoredState' as const,
};
const skillInvocationContextRef = {
  ...contextRef,
  id: 'd'.repeat(64),
  kind: 'skillInvocation' as const,
};
const userViewContextRef = {
  ...contextRef,
  id: 'e'.repeat(64),
  kind: 'userView' as const,
};
const projectionContextRef = {
  ...contextRef,
  id: 'f'.repeat(64),
  kind: 'toolOutputProjection' as const,
};

const itemProvenance = createLocalItemProvenance(THREAD_ID, TURN_ID, 'item-1');
const turnProvenance = createLocalTurnProvenance(THREAD_ID, TURN_ID, { kind: 'user' });

const allItems: readonly ThreadItem[] = [
  {
    type: 'userMessage',
    id: 'item-1',
    provenance: itemProvenance,
    clientId: 'client-1',
    acceptedAt: 100,
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'nodeReference', nodeId: 'node-1', note: 'Relevant context' },
      {
        type: 'attachment',
        id: 'attachment-1',
        name: 'brief.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        source: { kind: 'localFile', path: '/tmp/brief.txt' },
      },
    ],
  },
  {
    type: 'agentMessage',
    id: 'item-2',
    provenance: { ...itemProvenance, originItemId: 'item-2' },
    text: 'Done',
    phase: 'final_answer',
    memoryCitation: {
      entries: [{ nodeId: 'memory-node-1', note: 'User preference' }],
      threadIds: [THREAD_ID],
    },
  },
  {
    type: 'reasoning',
    id: 'item-4',
    provenance: { ...itemProvenance, originItemId: 'item-4' },
    summary: ['Inspected the contract'],
    content: ['Detailed private reasoning payload'],
  },
  {
    type: 'commandExecution',
    id: 'item-5',
    provenance: { ...itemProvenance, originItemId: 'item-5' },
    command: 'bun run typecheck',
    cwd: '/tmp/project',
    processId: null,
    status: 'completed',
    commandActions: [{ kind: 'projectScript', command: 'bun run typecheck' }],
    aggregatedOutput: 'ok',
    exitCode: 0,
    durationMs: 10,
    outputRef: { id: OUTPUT_ID, mimeType: 'text/plain', byteLength: 2, summary: 'Command output' },
  },
  {
    type: 'fileChange',
    id: 'item-6',
    provenance: { ...itemProvenance, originItemId: 'item-6' },
    changes: [{ path: 'src/a.ts', kind: 'update', diff: '+export {}' }],
    status: 'completed',
    outputRef: null,
  },
  {
    type: 'mcpToolCall',
    id: 'item-7',
    provenance: { ...itemProvenance, originItemId: 'item-7' },
    server: 'github',
    tool: 'read_pr',
    status: 'completed',
    arguments: { number: 1 },
    pluginId: null,
    result: { title: 'PR' },
    error: null,
    durationMs: 20,
    outputRef: null,
  },
  {
    type: 'dynamicToolCall',
    id: 'item-8',
    provenance: { ...itemProvenance, originItemId: 'item-8' },
    namespace: null,
    tool: 'node_read',
    arguments: { nodeId: 'node-1' },
    status: 'completed',
    contentItems: [
      { type: 'text', text: 'Node text' },
      { type: 'image', source: { kind: 'threadPayload', ref: imageResourceRef }, alt: 'Node image' },
    ],
    success: true,
    durationMs: 3,
    outputRef: null,
  },
  {
    type: 'collabAgentToolCall',
    id: 'item-9',
    provenance: { ...itemProvenance, originItemId: 'item-9' },
    tool: 'spawn_agent',
    status: 'completed',
    senderThreadId: THREAD_ID,
    receiverThreadIds: [CHILD_THREAD_ID],
    prompt: 'Inspect tests',
    model: null,
    reasoningEffort: null,
    agentsStates: { [CHILD_THREAD_ID]: 'running' },
    outputRef: null,
  },
  {
    type: 'subAgentActivity',
    id: 'item-10',
    provenance: { ...itemProvenance, originItemId: 'item-10' },
    kind: 'started',
    agentThreadId: CHILD_THREAD_ID,
    agentPath: '/root/inspect_tests',
  },
  {
    type: 'webSearch',
    id: 'item-11',
    provenance: { ...itemProvenance, originItemId: 'item-11' },
    query: 'Codex protocol',
    status: 'completed',
    results: [{ title: 'Result', url: 'https://example.com', snippet: 'Summary' }],
    error: null,
    outputRef: null,
  },
  {
    type: 'imageView',
    id: 'item-12',
    provenance: { ...itemProvenance, originItemId: 'item-12' },
    path: '/tmp/image.png',
  },
  {
    type: 'contextEvidence',
    id: 'item-13',
    provenance: { ...itemProvenance, originItemId: 'item-13' },
    kind: 'turnEnvironment',
    payloadRef: contextRef,
    summary: 'Turn environment',
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [],
  },
  {
    type: 'contextReset',
    id: 'item-14',
    provenance: { ...itemProvenance, originItemId: 'item-14' },
    clearedThrough: { turnId: TURN_ID, itemId: 'item-1' },
  },
  {
    type: 'contextCompaction',
    id: 'item-15',
    provenance: { ...itemProvenance, originItemId: 'item-15' },
    trigger: 'manual',
    coveredFrom: { turnId: TURN_ID, itemId: 'item-1' },
    coveredThrough: { turnId: TURN_ID, itemId: 'item-12' },
    preservedFrom: null,
    summaryRef: summaryContextRef,
    restoredStateRef: restoredContextRef,
    instructionsRef: null,
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [],
  },
];

const completedTurn: Turn = {
  id: TURN_ID,
  items: allItems,
  itemsView: 'full',
  provenance: turnProvenance,
  status: 'completed',
  error: null,
  execution: {
    modelProvider: 'openai',
    model: 'openai/gpt-5',
    reasoningEffort: 'high',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 170,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0,
        total: 0.0031,
        currency: 'USD',
      },
    },
  },
  startedAt: 100,
  completedAt: 200,
  durationMs: 100,
};

const thread: Thread = {
  id: THREAD_ID,
  sessionId: SESSION_ID,
  parentThreadId: null,
  forkedFromId: null,
  agentNickname: null,
  agentRole: null,
  name: 'Protocol work',
  preview: 'Implement the protocol',
  ephemeral: false,
  source: 'app',
  threadSource: threadFeatureSource('automation'),
  modelProvider: 'openai',
  cwd: '/tmp/project',
  createdAt: 100,
  updatedAt: 200,
  status: { type: 'idle' },
  historyMode: 'paginated',
  turns: [completedTurn],
};

describe('Codex Agent Core protocol codec', () => {
  test('round-trips and freezes the canonical Thread graph', () => {
    const decoded = decodeThreadJson(encodeThread(thread));

    expect(decoded).toEqual(thread);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.turns)).toBe(true);
    expect(Object.isFrozen(decoded.turns?.[0]?.items)).toBe(true);
    expect(decoded.historyMode).toBe('paginated');
  });

  test('round-trips every exhaustive ThreadItem variant', () => {
    expect(allItems.map((item) => item.type)).toEqual(THREAD_ITEM_TYPES);
    for (const item of allItems) {
      const decoded = decodeThreadItemJson(encodeThreadItem(item));
      expect(decoded).toEqual(item);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.provenance)).toBe(true);
    }
  });

  test('keeps context evidence references, cursors, and acceptance time strict', () => {
    const user = allItems.find((item) => item.type === 'userMessage')!;
    const evidence = allItems.find((item) => item.type === 'contextEvidence')!;
    const reset = allItems.find((item) => item.type === 'contextReset')!;
    const compaction = allItems.find((item) => item.type === 'contextCompaction')!;
    const dynamic = allItems.find((item) => item.type === 'dynamicToolCall')!;

    const { acceptedAt: _acceptedAt, ...missingAcceptedAt } = user;
    expect(() => decodeThreadItem(missingAcceptedAt)).toThrow('item.acceptedAt');
    expect(() => decodeThreadItem({ ...user, acceptedAt: -1 })).toThrow('non-negative');
    expect(() => decodeThreadItem({ ...evidence, kind: 'unknown' })).toThrow('item.kind');
    expect(() => decodeThreadItem({ ...evidence, payloadRef: userViewContextRef }))
      .toThrow('expected turnEnvironment');
    expect(() => decodeThreadItem({
      ...evidence,
      payloadRef: { ...evidence.payloadRef, schemaVersion: 2 },
    })).toThrow('schema version 1');
    expect(() => decodeThreadItem({
      ...evidence,
      payloadRef: { ...evidence.payloadRef, mimeType: 'application/json' },
    })).toThrow('item.payloadRef.mimeType');
    expect(() => decodeThreadItem({
      ...evidence,
      payloadRef: { ...evidence.payloadRef, byteLength: 16 * 1024 * 1024 + 1 },
    })).toThrow('managed context payload budget');
    expect(() => decodeThreadItem({ ...evidence, outputRefs: [null] })).toThrow('expected an output reference');
    expect(() => decodeThreadItem({ ...evidence, contextRefs: [contextRef, contextRef] }))
      .toThrow('duplicate references');
    expect(() => decodeThreadItem({
      ...dynamic,
      contentItems: [{ type: 'image', imageRef: '/tmp/legacy.png' }],
    })).toThrow('unknown fields');
    expect(() => decodeThreadItem({
      ...reset,
      clearedThrough: { ...reset.clearedThrough, turnId: 'not-a-turn' },
    })).toThrow('UUIDv7');
    expect(() => decodeThreadItem({ ...compaction, unexpected: true })).toThrow('unknown fields');
    expect(() => decodeThreadItem({ ...compaction, summaryRef: contextRef }))
      .toThrow('expected compactionSummary');
    expect(() => decodeThread({
      ...thread,
      turns: [{
        ...completedTurn,
        items: allItems.map((item) => item.type === 'contextReset'
          ? { ...item, clearedThrough: { turnId: TURN_ID, itemId: 'missing-item' } }
          : item),
      }],
    })).toThrow('cursor target is not reachable');
    expect(() => decodeThread({
      ...thread,
      turns: [{
        ...completedTurn,
        items: allItems.map((item) => item.type === 'contextCompaction'
          ? { ...item, coveredFrom: item.coveredThrough, coveredThrough: item.coveredFrom }
          : item),
      }],
    })).toThrow('coveredFrom must not follow coveredThrough');
  });

  test('round-trips every semantic context payload and rejects authority escalation', () => {
    const payloads: readonly ThreadContextPayload[] = [
      {
        schemaVersion: 1,
        kind: 'turnEnvironment',
        acceptedAt: 100,
        utcInstant: '2024-01-01T00:00:00.000Z',
        localDate: '2024-01-01',
        localTime: '08:00:00',
        timeZone: 'Asia/Shanghai',
        utcOffsetMinutes: 480,
        locale: 'zh-CN',
        workingDirectory: '/tmp/project',
        conversationMode: 'interactive',
        executionMode: 'root',
        replyIdentity: 'local-user',
        todayNodeId: 'today',
      },
      {
        schemaVersion: 1,
        kind: 'userView',
        mode: 'interactive',
        activePanelId: 'panel-1',
        focusedPanelId: 'panel-1',
        focusSurface: 'outline',
        focusedNode: { nodeId: 'node-1', title: 'Focus', panelId: 'panel-1', surface: 'outline' },
        selectedNodes: [],
        referencedNodes: [],
        panels: [{
          panelId: 'panel-1',
          rootNodeId: 'root',
          rootTitle: 'Root',
          rootType: 'outline',
          active: true,
          focused: true,
          order: 0,
          childCount: 1,
          breadcrumb: [],
          visibleOutline: [{
            nodeId: 'node-1',
            title: 'Focus',
            depth: 1,
            focused: true,
            collapsed: false,
            childCount: 0,
            includedChildCount: null,
          }],
          visibleOutlineTruncated: false,
        }],
        truncated: false,
      },
      {
        schemaVersion: 1,
        kind: 'additionalContext',
        entries: [{
          key: 'automation_info',
          source: 'automation',
          authority: 'application',
          purpose: 'observation',
          text: 'Scheduled execution',
        }],
      },
      {
        schemaVersion: 1,
        kind: 'referencedResources',
        resources: [{
          nodeId: 'node-1',
          nodeType: 'attachment',
          title: 'Report',
          breadcrumb: [],
          content: 'Report node',
          contentTruncated: false,
          resourceRef: { id: '1'.repeat(64), mimeType: 'text/plain', byteLength: 10, fileName: 'report.txt' },
          inlineImage: false,
          unavailableReason: null,
        }],
      },
      {
        schemaVersion: 1,
        kind: 'skillCatalog',
        mode: 'baseline',
        previousCatalogHash: null,
        catalogHash: '2'.repeat(64),
        entries: [{
          change: 'available',
          name: 'review',
          displayName: 'Review',
          source: 'user',
          identity: '/skills/review/SKILL.md',
          contentHash: '3'.repeat(64),
          description: 'Review changes',
        }],
      },
      {
        schemaVersion: 1,
        kind: 'skillInvocation',
        name: 'review',
        displayName: 'Review',
        source: 'user',
        identity: '/skills/review/SKILL.md',
        resourceRoot: '/skills/review',
        contentHash: '3'.repeat(64),
        instructions: 'Inspect the complete diff.',
        arguments: '',
        execution: 'inline',
        invocationSource: 'model',
        constraints: { allowedTools: [], model: null, effort: null },
        invokedAt: 110,
      },
      {
        schemaVersion: 1,
        kind: 'roleCatalog',
        mode: 'delta',
        previousCatalogHash: '4'.repeat(64),
        catalogHash: '5'.repeat(64),
        entries: [{
          change: 'added',
          name: 'researcher',
          displayName: 'Researcher',
          source: 'project',
          identity: '/roles/researcher.md',
          contentHash: '6'.repeat(64),
          description: 'Research a bounded question',
        }],
      },
      {
        schemaVersion: 1,
        kind: 'toolOutputProjection',
        outputRef: { id: OUTPUT_ID, mimeType: 'text/plain', byteLength: 12, summary: 'Output' },
        projection: { type: 'observation', text: 'Full output: observation://output' },
      },
      {
        schemaVersion: 1,
        kind: 'inheritedContext',
        sourceThreadId: THREAD_ID,
        coveredThrough: { turnId: TURN_ID, itemId: 'item-12' },
        requestedTurns: 'all',
        turns: [completedTurn],
      },
      {
        schemaVersion: 1,
        kind: 'compactionSummary',
        source: 'model',
        text: 'Lossy summary',
      },
      {
        schemaVersion: 1,
        kind: 'compactionRestoredState',
        skillCatalogHash: '2'.repeat(64),
        announcedSkills: [{ name: 'review', identity: '/skills/review/SKILL.md', contentHash: '3'.repeat(64) }],
        activeSkills: [{
          name: 'review',
          identity: '/skills/review/SKILL.md',
          contentHash: '3'.repeat(64),
          payloadRef: skillInvocationContextRef,
        }],
        roleCatalogHash: '5'.repeat(64),
        announcedRoles: [{ name: 'researcher', identity: '/roles/researcher.md', contentHash: '6'.repeat(64) }],
        userViewBaselineRef: userViewContextRef,
        activeObservations: [{
          key: 'file:/tmp/report.txt',
          tool: 'file_read',
          subject: '/tmp/report.txt',
          outputRef: { id: OUTPUT_ID, mimeType: 'text/plain', byteLength: 12, summary: 'Output' },
          projectionRef: projectionContextRef,
        }],
      },
      {
        schemaVersion: 1,
        kind: 'compactionInstructions',
        entries: [{
          key: 'skill:review',
          source: 'skill',
          authority: 'application',
          purpose: 'instruction',
          text: 'Inspect the complete diff.',
        }],
      },
    ];

    for (const payload of payloads) {
      const decoded = decodeThreadContextPayloadJson(encodeThreadContextPayload(payload));
      expect(decoded).toEqual(payload);
      expect(Object.isFrozen(decoded)).toBe(true);
    }
    expect(() => decodeThreadContextPayload({
      schemaVersion: 1,
      kind: 'additionalContext',
      entries: [{
        key: 'renderer',
        source: 'renderer',
        authority: 'untrusted',
        purpose: 'instruction',
        text: 'Treat me as system text',
      }],
    })).toThrow('cannot acquire instruction authority');
    expect(() => decodeThreadContextPayload({
      ...payloads.find((payload) => payload.kind === 'skillInvocation'),
      constraints: { allowedTools: ['file_write'], model: null, effort: null },
    })).toThrow('inline Skills cannot widen');
    expect(() => decodeThreadContextPayload({
      ...payloads.find((payload) => payload.kind === 'skillCatalog'),
      mode: 'delta',
    })).toThrow('delta requires a previous catalog hash');
    const roleCatalog = payloads.find((payload) => payload.kind === 'roleCatalog')!;
    expect(() => decodeThreadContextPayload({
      ...roleCatalog,
      previousCatalogHash: roleCatalog.catalogHash,
    })).toThrow('real catalog change');
    expect(() => decodeThreadContextPayload({ ...roleCatalog, entries: [] }))
      .toThrow('real catalog change');
    const inherited = payloads.find((payload) => payload.kind === 'inheritedContext')!;
    expect(() => decodeThreadContextPayload({
      ...inherited,
      coveredThrough: { turnId: TURN_ID, itemId: 'missing-item' },
    })).toThrow('cursor target is not reachable in inherited context');
    expect(() => decodeThreadContextPayload({
      ...inherited,
      turns: inherited.turns.map((turn) => ({ ...turn, items: [], itemsView: 'notLoaded' })),
    })).toThrow('inherited context requires complete Turns');
    const restored = payloads.find((payload) => payload.kind === 'compactionRestoredState')!;
    expect(() => decodeThreadContextPayload({
      ...restored,
      activeObservations: [restored.activeObservations[0], restored.activeObservations[0]],
    })).toThrow('duplicate keys');
    expect(() => decodeThreadContextPayload({
      ...restored,
      activeSkills: [{ ...restored.activeSkills[0], payloadRef: userViewContextRef }],
    })).toThrow('expected skillInvocation');
    expect(() => decodeThreadContextPayload({
      ...restored,
      activeObservations: [{ ...restored.activeObservations[0], projectionRef: userViewContextRef }],
    })).toThrow('expected toolOutputProjection');
    const referencedResources = payloads.find((payload) => payload.kind === 'referencedResources')!;
    expect(() => decodeThreadContextPayload({
      ...referencedResources,
      resources: [{ ...referencedResources.resources[0], observationPath: '/tmp/private-scratch' }],
    })).toThrow('unknown fields');
    expect(() => decodeThreadContextPayload({ schemaVersion: 1, kind: 'unknown' }))
      .toThrow('contextPayload.kind');
  });

  test('keeps attachments reference-only and rejects legacy inline bytes', () => {
    const ref = {
      id: 'b'.repeat(64),
      mimeType: 'image/png',
      byteLength: 128,
      fileName: 'prompt.png',
    };
    const managed = decodeThreadItem({
      type: 'userMessage',
      id: 'managed-message',
      provenance: { ...itemProvenance, originItemId: 'managed-message' },
      clientId: null,
      acceptedAt: 250,
      content: [{
        type: 'attachment',
        id: 'managed-attachment',
        name: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        source: { kind: 'threadPayload', ref: { ...ref, fileName: 'image.png', byteLength: 1024 } },
        promptImage: ref,
      }],
    });
    expect(managed).toMatchObject({
      content: [{ source: { kind: 'threadPayload' }, promptImage: ref }],
    });
    expect(() => decodeThreadItem({
      type: 'userMessage',
      id: 'legacy-message',
      provenance: { ...itemProvenance, originItemId: 'legacy-message' },
      clientId: null,
      acceptedAt: 250,
      content: [{
        type: 'attachment',
        id: 'legacy-attachment',
        name: 'legacy.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        source: { kind: 'inline', dataBase64: 'YWJj' },
      }],
    })).toThrow('expected one of: localFile, threadPayload');
    expect(() => decodeThreadItem({
      ...(managed as ThreadItem),
      content: [{
        ...(managed as Extract<ThreadItem, { type: 'userMessage' }>).content[0],
        source: { kind: 'threadPayload', ref: { ...ref, fileName: '../prompt.png' } },
      }],
    })).toThrow('expected a safe base name');
    expect(() => decodeThreadItem({
      ...(managed as ThreadItem),
      content: [{
        ...(managed as Extract<ThreadItem, { type: 'userMessage' }>).content[0],
        source: { kind: 'threadPayload', ref: { ...ref, fileName: '..' } },
      }],
    })).toThrow('expected a safe base name');
    expect(() => decodeThreadItem({
      ...(managed as ThreadItem),
      content: [{
        ...(managed as Extract<ThreadItem, { type: 'userMessage' }>).content[0],
        source: { kind: 'threadPayload', ref: { ...ref, byteLength: 2 * 1024 * 1024 * 1024 + 1 } },
      }],
    })).toThrow('managed resource budget');
  });

  test('rejects legacy history, invalid lineage, and approval state', () => {
    expect(() => decodeThread({ ...thread, historyMode: 'legacy' })).toThrow('only paginated history');
    expect(() => decodeThread({ ...thread, parentThreadId: CHILD_THREAD_ID, forkedFromId: CHILD_THREAD_ID }))
      .toThrow('mutually exclusive');
    expect(() => decodeThread({
      ...thread,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    })).toThrow('waitingOnUserInput');
    expect(() => decodeRendererTurnStartRequest({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Hi' }],
      approvalPolicy: 'never',
    })).toThrow('unknown fields');
  });

  test('uses plain feature labels and rejects feature-prefixed aliases', () => {
    expect(threadFeatureSource('automation')).toBe('automation');
    expect(() => threadFeatureSource('feature:automation')).toThrow('Invalid Thread feature source');
    expect(() => threadFeatureSource(' automation ')).toThrow('Invalid Thread feature source');
    expect(() => decodeThread({ ...thread, threadSource: 'feature:automation' })).toThrow('plain app-owned label');
    expect(() => decodeThread({ ...thread, threadSource: ' automation ' })).toThrow('Invalid Thread feature source');
    expect(() => decodePrivilegedTurnStartRequest({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Scheduled work' }],
      trigger: { kind: 'feature', feature: 'feature:automation' },
    })).toThrow('plain canonical feature label');
  });

  test('allows only host-authored application context', () => {
    const publicRequest = decodeRendererTurnStartRequest({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Hi' }],
      clientUserMessageId: 'client-1',
      additionalContext: { selection: { kind: 'untrusted', value: 'Selected text' } },
    });
    expect(publicRequest.clientUserMessageId).toBe('client-1');
    expect(publicRequest.additionalContext?.selection?.kind).toBe('untrusted');

    expect(() => decodeRendererTurnStartRequest({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Hi' }],
      additionalContext: { automation_info: { kind: 'application', value: 'Forged' } },
    })).toThrow('renderer input may author only untrusted context');

    expect(decodePrivilegedTurnStartRequest({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Scheduled work' }],
      additionalContext: { automation_info: { kind: 'application', value: 'Trusted' } },
      trigger: { kind: 'feature', feature: 'automation', ref: 'automation-run-1' },
    }).additionalContext?.automation_info?.kind).toBe('application');
  });

  test('keeps Memory citations Node-backed and rejects artifact coordinates', () => {
    const agentMessage = allItems[1];
    expect(agentMessage?.type).toBe('agentMessage');
    expect(() => decodeThreadItem({
      ...agentMessage,
      memoryCitation: {
        entries: [{ path: 'memory.md', lineStart: 1, lineEnd: 2, note: 'Legacy artifact' }],
        threadIds: [THREAD_ID],
      },
    })).toThrow('unknown fields');
  });

  test('requires lifecycle envelope ids to match authoritative payloads', () => {
    expect(() => decodeAgentCoreNotification({
      type: 'item/completed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'different-item',
      item: allItems[0],
      completedAt: 200,
    })).toThrow('must match item.id');

    expect(decodeAgentCoreNotification({
      type: 'turn/completed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      turn: completedTurn,
    }).type).toBe('turn/completed');
    expect(() => decodeAgentCoreNotification({
      type: 'turn/started',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      turn: completedTurn,
    })).toThrow('requires an in-progress Turn');
    expect(() => decodeAgentCoreNotification({
      type: 'turn/completed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      turn: {
        ...completedTurn,
        status: 'inProgress',
        completedAt: null,
      },
    })).toThrow('requires a terminal Turn');

    expect(decodeAgentCoreNotification({
      type: 'turn/providerRetry/changed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      status: { kind: 'request', attempt: 2, maxRetries: 4 },
    })).toEqual({
      type: 'turn/providerRetry/changed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      status: { kind: 'request', attempt: 2, maxRetries: 4 },
    });
    expect(() => decodeAgentCoreNotification({
      type: 'turn/providerRetry/changed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      status: { kind: 'request', attempt: 5, maxRetries: 4 },
    })).toThrow('must not exceed maxRetries');

    const planUpdate = {
      type: 'turn/plan/updated' as const,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      explanation: 'Implement in dependency order',
      plan: [
        { step: 'Define the transient contract', status: 'completed' as const },
        { step: 'Render current progress', status: 'in_progress' as const },
        { step: 'Verify terminal cleanup', status: 'pending' as const },
      ],
    };
    expect(decodeAgentCoreNotification(planUpdate)).toEqual(planUpdate);
    expect(() => decodeAgentCoreNotification({
      ...planUpdate,
      plan: [
        { step: 'First', status: 'in_progress' },
        { step: 'Second', status: 'in_progress' },
      ],
    })).toThrow('at most one in_progress');
    expect(() => decodeAgentCoreRecordedNotification(planUpdate))
      .toThrow('cannot record transient notification turn/plan/updated');
  });

  test('validates canonical Thread name update notifications', () => {
    expect(decodeAgentCoreNotification({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
      threadName: 'Canonical Thread name',
    })).toEqual({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
      threadName: 'Canonical Thread name',
    });
    expect(decodeAgentCoreNotification({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
      threadName: null,
    })).toEqual({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
    });
    expect(decodeAgentCoreNotification({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
    })).toEqual({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
    });
    expect(() => decodeAgentCoreNotification({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
      threadName: '',
    })).toThrow('expected a string');
    expect(() => decodeAgentCoreNotification({
      type: 'thread/name/updated',
      threadId: THREAD_ID,
      threadName: 'Name',
      name: 'legacy alias',
    })).toThrow('unknown fields');
  });

  test('validates canonical Turn execution details and content-addressed tool output', () => {
    expect(() => decodeTurn({
      ...completedTurn,
      execution: {
        ...completedTurn.execution,
        usage: { ...completedTurn.execution.usage, totalTokens: 169 },
      },
    })).toThrow('must cover input, output, cache-read, and cache-write tokens');
    expect(() => decodeThreadItem({
      ...allItems[3],
      outputRef: { id: 'not-a-digest', mimeType: 'text/plain', byteLength: 2, summary: 'Output' },
    })).toThrow('lowercase SHA-256');
    expect(() => decodeAgentCoreResponse('thread/item/output/read', {
      output: {
        ref: allItems[3]?.type === 'commandExecution' ? allItems[3].outputRef : null,
        text: 'wrong length',
      },
    })).toThrow('byte length must match');
  });

  test('enforces executable Item status at Item and terminal Turn boundaries', () => {
    const executableItems = allItems.filter((item) => 'status' in item);
    expect(executableItems.map((item) => item.type)).toEqual([
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'dynamicToolCall',
      'collabAgentToolCall',
      'webSearch',
    ]);

    for (const item of executableItems) {
      const inProgressItem = { ...item, status: 'inProgress' } as ThreadItem;
      expect(() => decodeAgentCoreNotification({
        type: 'item/completed',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: item.id,
        item: inProgressItem,
        completedAt: 200,
      })).toThrow('requires a terminal executable Item');
      expect(() => decodeAgentCoreNotification({
        type: 'item/started',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: item.id,
        item,
        startedAt: 100,
      })).toThrow('requires an in-progress executable Item');

      for (const status of ['completed', 'interrupted', 'failed'] as const) {
        expect(() => decodeTurn({
          ...completedTurn,
          status,
          items: allItems.map((candidate) => candidate.id === item.id ? inProgressItem : candidate),
        })).toThrow('terminal Turn cannot contain an in-progress Item');
      }
    }

    expect(decodeAgentCoreNotification({
      type: 'item/completed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: allItems[0]!.id,
      item: allItems[0],
      completedAt: 200,
    }).type).toBe('item/completed');
  });

  test('rejects unknown item variants instead of adapting them', () => {
    expect(() => decodeThreadItem({
      type: 'message',
      id: 'legacy-item',
      provenance: itemProvenance,
    })).toThrow(AgentProtocolCodecError);
  });

  test('validates every canonical RPC request and response through one method map', () => {
    const goal = {
      threadId: THREAD_ID,
      objective: 'Replace Agent Core',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 100,
      updatedAt: 100,
    } as const;
    const requests: Record<string, unknown> = {
      'thread/list': {},
      'thread/read': { threadId: THREAD_ID, includeTurns: true },
      'thread/start': {},
      'thread/resume': { threadId: THREAD_ID },
      'thread/fork': { threadId: THREAD_ID, boundary: { kind: 'beforeTurn', turnId: TURN_ID } },
      'thread/rollback': { threadId: THREAD_ID, numTurns: 1 },
      'thread/name/set': { threadId: THREAD_ID, name: 'Renamed' },
      'thread/configuration/get': { threadId: THREAD_ID },
      'thread/configuration/set': {
        threadId: THREAD_ID,
        modelProvider: 'openai',
        model: 'openai/gpt-5',
        reasoningEffort: 'high',
      },
      'thread/archive': { threadId: THREAD_ID },
      'thread/unarchive': { threadId: THREAD_ID },
      'thread/delete': { threadId: THREAD_ID },
      'thread/turns/list': { threadId: THREAD_ID, limit: 20, itemsView: 'summary' },
      'thread/items/list': { threadId: THREAD_ID, turnId: TURN_ID, sortDirection: 'asc' },
      'thread/item/output/read': {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-5',
        outputId: OUTPUT_ID,
      },
      'turn/start': {
        threadId: THREAD_ID,
        input: [{ type: 'text', text: 'Start' }],
        clientUserMessageId: 'client-start',
      },
      'turn/steer': {
        threadId: THREAD_ID,
        expectedTurnId: TURN_ID,
        input: [{ type: 'text', text: 'Steer' }],
      },
      'turn/interrupt': { threadId: THREAD_ID, turnId: TURN_ID },
      'goal/get': { threadId: THREAD_ID },
      'goal/create': { threadId: THREAD_ID, objective: 'Replace Agent Core' },
      'goal/update': { threadId: THREAD_ID, status: 'complete' },
      'userInput/respond': {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-question',
        answers: [{ questionId: 'delivery_mode', optionLabel: 'Direct' }],
        autoResolved: false,
      },
    };
    const responses: Record<string, unknown> = {
      'thread/list': { data: [thread], nextCursor: null },
      'thread/read': { thread },
      'thread/start': { thread },
      'thread/resume': { thread },
      'thread/fork': { thread },
      'thread/rollback': { thread },
      'thread/name/set': {},
      'thread/configuration/get': {
        thread,
        configuration: { modelProvider: 'openai', model: 'openai/gpt-5', reasoningEffort: 'high' },
      },
      'thread/configuration/set': {
        thread,
        configuration: { modelProvider: 'openai', model: 'openai/gpt-5', reasoningEffort: 'high' },
      },
      'thread/archive': {},
      'thread/unarchive': {},
      'thread/delete': {},
      'thread/turns/list': { data: [completedTurn], nextCursor: null, backwardsCursor: null },
      'thread/items/list': {
        data: [{ turnId: TURN_ID, item: allItems[0] }],
        nextCursor: null,
        backwardsCursor: null,
      },
      'thread/item/output/read': {
        output: {
          ref: allItems[3]?.type === 'commandExecution' ? allItems[3].outputRef : null,
          text: 'ok',
        },
      },
      'turn/start': { turn: completedTurn, acceptedItemId: 'item-1', deduplicated: false },
      'turn/steer': { turnId: TURN_ID, acceptedItemId: 'item-1', deduplicated: true },
      'turn/interrupt': { turnId: TURN_ID },
      'goal/get': { goal: null },
      'goal/create': { goal },
      'goal/update': { goal: { ...goal, status: 'complete' } },
      'userInput/respond': {},
    };

    expect(Object.keys(requests)).toEqual(AGENT_CORE_METHODS);
    expect(Object.keys(responses)).toEqual(AGENT_CORE_METHODS);
    for (const method of AGENT_CORE_METHODS) {
      expect(Object.isFrozen(decodeAgentCoreRequest(method, requests[method]))).toBe(true);
      expect(Object.isFrozen(decodeAgentCoreResponse(method, responses[method]))).toBe(true);
    }
  });

  test('requires rollback to remove a positive whole number of Turns', () => {
    expect(decodeAgentCoreRequest('thread/rollback', {
      threadId: THREAD_ID,
      numTurns: 1,
    })).toEqual({ threadId: THREAD_ID, numTurns: 1 });
    expect(() => decodeAgentCoreRequest('thread/rollback', {
      threadId: THREAD_ID,
      numTurns: 0,
    })).toThrow('expected a positive safe integer');
    expect(() => decodeAgentCoreRequest('thread/rollback', {
      threadId: THREAD_ID,
      numTurns: 1.5,
    })).toThrow('expected a positive safe integer');
    expect(() => decodeAgentCoreRequest('thread/rollback', {
      threadId: THREAD_ID,
      numTurns: 1,
      turnId: TURN_ID,
    })).toThrow('unknown fields: turnId');
  });

  test('exposes only the ratified response-menu actions', () => {
    const request = {
      canCopy: true,
      canContinueInNewChat: true,
      canShowDetails: true,
    } satisfies ThreadMessageContextMenuRequest;

    expect(THREAD_MESSAGE_CONTEXT_MENU_ACTIONS).toEqual([
      'copy',
      'continueInNewChat',
      'details',
    ]);
    expect(Object.isFrozen(THREAD_MESSAGE_CONTEXT_MENU_ACTIONS)).toBe(true);
    expect(THREAD_MESSAGE_CONTEXT_MENU_CAPABILITY_FIELDS).toEqual([
      'canCopy',
      'canContinueInNewChat',
      'canShowDetails',
    ]);
    expect(Object.isFrozen(THREAD_MESSAGE_CONTEXT_MENU_CAPABILITY_FIELDS)).toBe(true);
    expect(Object.keys(request)).toEqual(THREAD_MESSAGE_CONTEXT_MENU_CAPABILITY_FIELDS);
  });

  test('keeps renderer Thread admission and Goal status transitions privileged', () => {
    expect(() => decodeAgentCoreRequest('thread/start', {
      source: 'automation-host',
      threadSource: 'automation',
      modelProvider: 'openai',
      cwd: '/tmp/project',
    })).toThrow('renderer source must be app');
    expect(() => decodeAgentCoreRequest('goal/update', {
      threadId: THREAD_ID,
      status: 'paused',
    })).toThrow('complete, blocked');
  });

  test('validates Thread configuration as one canonical execution selection', () => {
    expect(() => decodeAgentCoreRequest('thread/configuration/set', {
      threadId: THREAD_ID,
      modelProvider: 'openai',
      model: 'openai/gpt-5',
      reasoningEffort: 'extreme',
    })).toThrow('off, minimal, low, medium, high, xhigh, max');
    expect(() => decodeAgentCoreRequest('thread/configuration/set', {
      threadId: THREAD_ID,
      modelProvider: ' openai ',
      model: 'openai/gpt-5',
      reasoningEffort: 'medium',
    })).toThrow('trimmed');
    expect(() => decodeAgentCoreResponse('thread/configuration/get', {
      thread,
      configuration: {
        modelProvider: 'openai',
        model: '',
        reasoningEffort: 'medium',
      },
    })).toThrow('non-empty');
    expect(() => decodeAgentCoreRequest('thread/configuration/set', {
      threadId: THREAD_ID,
      modelProvider: 'openai',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'medium',
    })).toThrow('qualified by modelProvider');
    expect(() => decodeAgentCoreRequest('thread/configuration/set', {
      threadId: THREAD_ID,
      modelProvider: 'openai',
      model: 'openai/',
      reasoningEffort: 'medium',
    })).toThrow('qualified by modelProvider');
    expect(decodeAgentCoreRequest('thread/configuration/set', {
      threadId: THREAD_ID,
      modelProvider: 'openai',
      model: 'project-model',
      reasoningEffort: 'medium',
    })).toMatchObject({ modelProvider: 'openai', model: 'project-model' });
    expect(decodeAgentCoreResponse('thread/configuration/get', {
      thread,
      configuration: {
        modelProvider: 'openai',
        model: 'user-model',
        reasoningEffort: 'high',
      },
    })).toMatchObject({
      configuration: { modelProvider: 'openai', model: 'user-model', reasoningEffort: 'high' },
    });
    expect(decodeAgentCoreRequest('thread/configuration/set', {
      threadId: THREAD_ID,
      modelProvider: 'openai',
      model: 'inherit',
      reasoningEffort: 'medium',
    })).toMatchObject({ modelProvider: 'openai', model: 'inherit' });
  });

  test('keeps user-input requests in the control plane with matching ids', () => {
    const request = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'item-question',
      questions: [{
        id: 'delivery_mode',
        header: 'Delivery',
        question: 'How should this ship?',
        options: [
          { label: 'Direct (Recommended)', description: 'Ship it now.' },
          { label: 'Pause', description: 'Wait for another decision.' },
        ],
      }],
    };
    expect(decodeAgentCoreNotification({
      type: 'userInput/requested',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'item-question',
      request,
    }).type).toBe('userInput/requested');
    expect(() => decodeAgentCoreNotification({
      type: 'userInput/requested',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'different-item',
      request,
    })).toThrow('control-plane ids must match');

    const response = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'item-question',
      answers: [{ questionId: 'delivery_mode', optionLabel: 'Direct' }],
      autoResolved: false,
    };
    expect(decodeAgentCoreRequest('userInput/respond', response)).toEqual(response);
    expect(() => decodeAgentCoreRequest('userInput/respond', {
      ...response,
      answers: [{ questionId: 'delivery_mode' }],
    })).toThrow('requires exactly one of optionLabel or otherText');
    expect(() => decodeAgentCoreRequest('userInput/respond', {
      ...response,
      answers: [{ questionId: 'delivery_mode', optionLabel: 'Direct', otherText: 'Something else' }],
    })).toThrow('requires exactly one of optionLabel or otherText');
    expect(() => decodeAgentCoreRequest('userInput/respond', {
      ...response,
      answers: [
        { questionId: 'delivery_mode', optionLabel: 'Direct' },
        { questionId: 'delivery_mode', otherText: 'Something else' },
      ],
    })).toThrow('answer question ids must be unique');
  });
});
