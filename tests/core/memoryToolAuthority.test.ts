import { expect, test } from 'bun:test';
import { createMemoryOperations } from '../../src/main/hostDomain/memoryOperations';
import { createMemoryTools } from '../../src/main/agent/capabilities/memoryTools';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import { evaluateAgentToolCapability } from '../../src/main/agent/capabilities/agentCapabilities';
import type { MemoryExtension } from '../../src/main/agent/extensions/memory/MemoryExtension';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';

const requests = [
  ['memory_inspect', { operation: 'status' }],
  ['memory_inspect', { operation: 'reset', operationId: 'memory:reset:test' }],
  ['memory_manage', { operation: 'open' }],
  ['memory_manage', { operation: 'set_thread_mode', mode: 'disabled', expectedRevision: 0 }],
  ['memory_manage', { operation: 'reset' }],
] as const;

test.each(['absent', 'disabled', 'blocked', 'delegated'] as const)('Memory rejects %s authority even through raw dynamic contributions', async (restriction) => {
  const f = fixture(async () => true);
  for (const [name, request] of requests) {
    let raw: readonly AgentTool[] = [];
    const runtime = new ToolRuntime(service(), {
      capabilityTools: () => [],
      disabledTools: () => restriction === 'disabled' ? [name] : [],
      capabilityConfig: { blocks: restriction === 'blocked' ? [`Action(agent.memory.${name === 'memory_inspect' ? 'inspect' : 'manage'})`] : [] },
      delegationPolicy: () => ({ profile: 'general', access: 'workspace-write' }),
      dynamicTools: (context, authorize) => raw = createMemoryTools(f.operations, (itemId, signal) => ({
        origin: { kind: 'agent', threadId: context.thread.id, turnId: context.turn.id, itemId }, authorize, signal,
      })),
    });
    const tools = await runtime.createTools(context(restriction === 'absent' ? [] : [name], restriction === 'delegated'));
    if (restriction !== 'blocked') expect(tools.some((tool) => tool.name === name)).toBe(false);
    expect(await raw.find((tool) => tool.name === name)!.execute('item', { request })).toMatchObject({ outcome: { ok: false, error: { code: 'operation_unavailable' } } });
  }
  expect(f.commits()).toBe(0);
  expect(f.reviews()).toBe(0);
});

test('destructive blocks do not hide status or Thread mode operations', () => {
  for (const [toolName, request] of requests) {
    const decision = evaluateAgentToolCapability({ toolName, args: { request },
      policy: { capabilityConfig: { blocks: ['Action(outline.delete)'] } } });
    expect(decision.behavior).toBe(toolName === 'memory_manage' && request.operation === 'reset' ? 'unavailable' : 'allow');
  }
  expect(evaluateAgentToolCapability({ toolName: 'memory_manage', args: { request: { operation: 'open' } },
    policy: { capabilityConfig: { blocks: ['Action(outline.edit)'] } } }).behavior).toBe('unavailable');
});

test.each(['disabled', 'blocked', 'turn_ended', 'aborted'] as const)('Memory rechecks %s after a real ToolRuntime pending review', async (restriction) => {
  let decide!: (value: boolean) => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const f = fixture(() => new Promise((resolve) => { decide = resolve; opened(); }));
  let revoked = false;
  const controller = new AbortController();
  const runtime = new ToolRuntime(service(() => !(revoked && restriction === 'turn_ended')), {
    capabilityTools: () => [],
    disabledTools: () => revoked && restriction === 'disabled' ? ['memory_manage'] : [],
    capabilityConfig: () => ({ blocks: revoked && restriction === 'blocked' ? ['Action(outline.delete)'] : [] }),
    dynamicTools: (context, authorize) => createMemoryTools(f.operations, (itemId, signal) => ({
      origin: { kind: 'agent', threadId: context.thread.id, turnId: context.turn.id, itemId }, authorize, signal,
    })),
  });
  const tools = await runtime.createTools(context(['memory_manage']));
  const result = tools.find((tool) => tool.name === 'memory_manage')!.execute('item', { request: { operation: 'reset' } }, controller.signal).catch((error: unknown) => error);
  await ready;
  revoked = true;
  if (restriction === 'aborted') controller.abort();
  decide(true);
  expect(await result).toMatchObject(restriction === 'aborted' ? { name: 'AbortError' } : { outcome: { ok: false, error: { code: 'operation_unavailable' } } });
  expect(f.commits()).toBe(0);
});

test('Memory success envelopes pass the actual ToolRuntime output validator', async () => {
  const f = fixture(async () => true);
  const runtime = new ToolRuntime(service(), {
    capabilityConfig: { blocks: [] },
    capabilityTools: () => [],
    dynamicTools: (context, authorize) => createMemoryTools(f.operations, (itemId, signal) => ({
      origin: { kind: 'agent', threadId: context.thread.id, turnId: context.turn.id, itemId }, authorize, signal,
    })),
  });
  const tools = await runtime.createTools(context(['memory_manage', 'memory_inspect']));
  for (const [name, request] of requests) expect(await tools.find((tool) => tool.name === name)!.execute('item', { request })).toMatchObject({ outcome: { ok: true } });
});

function fixture(review: () => Promise<boolean>) {
  let commits = 0;
  let reviews = 0;
  const thread = { threadId: 'thread', mode: 'enabled', revision: 0, appliesAt: 'subsequent_admissions' };
  const reset = { operationId: 'memory:reset:test', state: 'finalized', admittedAt: 1, targetEpoch: 1 };
  const memory = {
    threadView: () => thread,
    view: () => ({ status: { featureMode: 'enabled', featureModeGeneration: 0, resetEpoch: 0, memoryVisibilityGeneration: 0,
      lastSuccessfulRunAt: null, lastError: null, pendingJobs: 0, strayTaggedNodeCount: 0 }, thread }),
    inspectReset: () => reset,
    reviewReset: () => ({ containerIds: [], resetEpoch: 0, nodeCount: 0, ordinaryNodeCount: 0 }),
    setThreadMode: async (_id: string, _mode: string, _revision: number, authorize: () => Promise<void>) => { await authorize(); commits++; return thread; },
    reset: async (_target: unknown, authorize: () => Promise<void>) => { await authorize(); commits++; return reset; },
  } as unknown as MemoryExtension;
  const operations = createMemoryOperations({ memory, review: async () => { reviews++; return review(); },
    open: async (authorize) => { await authorize(); commits++; return { operation: 'open', nodeId: 'node:search', navigation: 'unknown' }; } });
  return { operations, commits: () => commits, reviews: () => reviews };
}
function context(tools: string[], child = false): TurnExecutionContext {
  return { thread: { id: 'thread', cwd: process.cwd(), parentThreadId: child ? 'parent' : null, threadSource: child ? 'delegation' : 'user' },
    turn: { id: 'turn' }, configuration: { tools, plugins: [], mcpServers: [] } } as unknown as TurnExecutionContext;
}
function service(active = () => true): ThreadService {
  return { extensionToolContributions: async () => [], notifyToolStarted: async () => {}, notifyToolCompleted: async () => {},
    readTurnForHost: () => ({ status: active() ? 'inProgress' : 'completed' }) } as unknown as ThreadService;
}
