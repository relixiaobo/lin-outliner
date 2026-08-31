import { describe, expect, test } from 'bun:test';
import {
  createLocalItemProvenance,
  createLocalTurnProvenance,
  decodeRendererAgentCoreNotification,
  decodeRendererAgentCoreResponse,
  decodeThreadItem,
  encodeThreadContextPayload,
} from '../../src/core/agent/codec';
import type {
  AgentCoreMethod,
  AgentCoreNotification,
  AgentCoreResponseByMethod,
  CommandExecutionThreadItem,
  RendererAgentCoreResponseByMethod,
  Thread,
  Turn,
} from '../../src/core/agent/protocol';
import {
  projectAgentCoreNotification,
  projectAgentCoreResponse,
} from '../../src/core/agent/rendererProjection';
import { TEST_TOOL_SCHEMA_DIGEST } from '../fixtures/agentToolCallHistory';

const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abe';
const ITEM_ID = 'item-private-arguments';

const internalTextRef = {
  id: '1'.repeat(64),
  encoding: 'utf-8' as const,
  byteLength: 48 * 1024,
};
const argumentPayloadRef = {
  id: '2'.repeat(64),
  mimeType: 'application/vnd.tenon.agent-context+json' as const,
  byteLength: 512,
  schemaVersion: 1 as const,
  kind: 'toolCallArguments' as const,
};
const privateItem: CommandExecutionThreadItem = {
  type: 'commandExecution',
  id: ITEM_ID,
  provenance: createLocalItemProvenance(THREAD_ID, TURN_ID, ITEM_ID),
  command: 'outline add --input -',
  description: 'Add nodes from stdin',
  cwd: '/tmp/project',
  processId: null,
  status: 'completed',
  commandActions: [{ kind: 'outline.read', command: 'outline add --input -' }],
  aggregatedOutput: 'ok',
  exitCode: 0,
  durationMs: 10,
  outputRef: null,
  resourceRefs: [],
  modelCall: {
    disposition: 'replayable',
    identity: { namespace: null, name: 'bash' },
    providerName: 'bash',
    arguments: {
      storage: 'payload',
      ref: argumentPayloadRef,
      internalTextRefs: [internalTextRef],
    },
    schemaDigest: TEST_TOOL_SCHEMA_DIGEST,
  },
};
const privateTurn: Turn = {
  id: TURN_ID,
  items: [privateItem],
  itemsView: 'full',
  provenance: createLocalTurnProvenance(THREAD_ID, TURN_ID, { kind: 'user' }),
  status: 'completed',
  error: null,
  execution: {
    modelProvider: 'openai',
    model: 'openai/gpt-5',
    reasoningEffort: 'high',
    diagnosticsRef: null,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: null,
    },
  },
  startedAt: 100,
  completedAt: 110,
  durationMs: 10,
};
const privateThread: Thread = {
  id: THREAD_ID,
  sessionId: '018f0f24-7b2e-7a3f-8a4b-123456789abd',
  parentThreadId: null,
  forkedFromId: null,
  agentNickname: null,
  agentRole: null,
  name: 'Private arguments',
  preview: 'Bash stdin',
  ephemeral: false,
  source: 'app',
  threadSource: 'user',
  modelProvider: 'openai',
  cwd: '/tmp/project',
  createdAt: 100,
  updatedAt: 110,
  status: { type: 'idle' },
  historyMode: 'paginated',
  turns: [privateTurn],
};
const inheritedPayload = {
  schemaVersion: 1 as const,
  kind: 'inheritedContext' as const,
  sourceThreadId: THREAD_ID,
  coveredThrough: { turnId: TURN_ID, itemId: ITEM_ID },
  requestedTurns: 'all' as const,
  turns: [privateTurn],
};
const inheritedPayloadRef = {
  id: '3'.repeat(64),
  mimeType: 'application/vnd.tenon.agent-context+json' as const,
  byteLength: new TextEncoder().encode(encodeThreadContextPayload(inheritedPayload)).byteLength,
  schemaVersion: 1 as const,
  kind: 'inheritedContext' as const,
};

describe('renderer Agent Core projection', () => {
  test('removes private arguments from every response carrier', () => {
    const cases: readonly ResponseCase[] = [
      ['thread/list', { data: [privateThread], nextCursor: null }],
      ['thread/descendants', { data: [privateThread], queuedWorkThreadIds: [] }],
      ['thread/read', { thread: privateThread }],
      ['thread/start', { thread: privateThread }],
      ['thread/resume', { thread: privateThread }],
      ['thread/fork', { thread: privateThread }],
      ['thread/rollback', { thread: privateThread }],
      ['thread/configuration/get', {
        thread: privateThread,
        configuration: { modelProvider: 'openai', model: 'openai/gpt-5', reasoningEffort: 'high' },
      }],
      ['thread/configuration/set', {
        thread: privateThread,
        configuration: { modelProvider: 'openai', model: 'openai/gpt-5', reasoningEffort: 'high' },
      }],
      ['thread/turns/list', {
        data: [privateTurn], nextCursor: null, backwardsCursor: null,
      }],
      ['thread/items/list', {
        data: [{ turnId: TURN_ID, item: privateItem }], nextCursor: null, backwardsCursor: null,
      }],
      ['thread/context/read', { context: { ref: inheritedPayloadRef, payload: inheritedPayload } }],
      ['thread/turn/details/read', { thread: privateThread, turn: privateTurn, diagnostics: null }],
      ['turn/submit', {
        turn: privateTurn, turnId: TURN_ID, acceptedItemId: ITEM_ID, deduplicated: false,
      }],
      ['turn/start', { turn: privateTurn, acceptedItemId: ITEM_ID, deduplicated: false }],
      ['turn/retry', { thread: privateThread, turn: privateTurn, replacedTurnId: TURN_ID }],
    ];

    for (const [method, response] of cases) {
      const projected = projectResponse(method, response);
      expectPrivateArgumentsAbsent(projected);
      expect(countItemBoundArguments(projected)).toBeGreaterThan(0);
    }
  });

  test('renderer context codec projects private arguments nested in inherited Turns', () => {
    const projected = projectAgentCoreResponse('thread/context/read', {
      context: { ref: inheritedPayloadRef, payload: inheritedPayload },
    });
    const decoded = decodeRendererAgentCoreResponse('thread/context/read', projected);

    expectPrivateArgumentsAbsent(decoded);
    expect(countItemBoundArguments(decoded)).toBe(1);
  });

  test('removes private arguments from every full Thread, Turn, or Item notification', () => {
    const notifications: readonly AgentCoreNotification[] = [
      { type: 'thread/started', threadId: THREAD_ID, thread: privateThread },
      { type: 'turn/started', threadId: THREAD_ID, turnId: TURN_ID, turn: privateTurn },
      {
        type: 'item/started',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: ITEM_ID,
        item: { ...privateItem, status: 'inProgress' },
        startedAt: 100,
      },
      {
        type: 'item/completed',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: ITEM_ID,
        item: privateItem,
        completedAt: 110,
      },
      {
        type: 'items/completed',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        items: [privateItem],
        completedAt: 110,
      },
      { type: 'turn/completed', threadId: THREAD_ID, turnId: TURN_ID, turn: privateTurn },
    ];

    for (const notification of notifications) {
      const projected = projectAgentCoreNotification(notification);
      expectPrivateArgumentsAbsent(projected);
      expect(countItemBoundArguments(projected)).toBeGreaterThan(0);
    }
  });

  test('renderer codecs reject canonical argument dependencies at the model-call slot', () => {
    expect(() => decodeRendererAgentCoreResponse('thread/read', { thread: privateThread }))
      .toThrow('private payload arguments cannot cross IPC');
    expect(() => decodeRendererAgentCoreNotification({
      type: 'turn/completed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      turn: privateTurn,
    })).toThrow('private payload arguments cannot cross IPC');
  });

  test('renderer projection preserves private-looking fields inside inline JSON arguments', () => {
    const inlineValue = {
      storage: 'payload',
      bindings: [{ internalTextRefs: [internalTextRef] }],
      nested: { storage: 'itemBound' },
    };
    const inlineItem: CommandExecutionThreadItem = {
      ...privateItem,
      modelCall: {
        ...privateItem.modelCall,
        arguments: { storage: 'inline', value: inlineValue },
      },
    };
    const response = projectAgentCoreResponse('thread/read', {
      thread: {
        ...privateThread,
        turns: [{ ...privateTurn, items: [inlineItem] }],
      },
    });
    const decoded = decodeRendererAgentCoreResponse('thread/read', response);
    const decodedItem = decoded.thread.turns?.[0]?.items[0];
    expect(decodedItem && 'modelCall' in decodedItem && decodedItem.modelCall.disposition === 'replayable'
      ? decodedItem.modelCall.arguments
      : null).toEqual({ storage: 'inline', value: inlineValue });
  });

  test('canonical codec rejects duplicate internal-text dependency references', () => {
    expect(() => decodeThreadItem({
      ...privateItem,
      modelCall: {
        ...privateItem.modelCall,
        arguments: {
          storage: 'payload',
          ref: argumentPayloadRef,
          internalTextRefs: [internalTextRef, internalTextRef],
        },
      },
    })).toThrow('duplicate internal-text references');
  });
});

type ResponseCase = {
  readonly [Method in AgentCoreMethod]: readonly [Method, AgentCoreResponseByMethod[Method]];
}[AgentCoreMethod];

function projectResponse<Method extends AgentCoreMethod>(
  method: Method,
  response: AgentCoreResponseByMethod[Method],
): RendererAgentCoreResponseByMethod[Method] {
  return projectAgentCoreResponse(method, response);
}

function expectPrivateArgumentsAbsent(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) expectPrivateArgumentsAbsent(entry);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Readonly<Record<string, unknown>>;
  expect(record.storage).not.toBe('payload');
  expect(record).not.toHaveProperty('internalTextRefs');
  expect(record).not.toHaveProperty('bindings');
  for (const entry of Object.values(record)) expectPrivateArgumentsAbsent(entry);
}

function countItemBoundArguments(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countItemBoundArguments(entry), 0);
  if (value === null || typeof value !== 'object') return 0;
  const record = value as Readonly<Record<string, unknown>>;
  return (record.storage === 'itemBound' ? 1 : 0)
    + Object.values(record).reduce((sum, entry) => sum + countItemBoundArguments(entry), 0);
}
