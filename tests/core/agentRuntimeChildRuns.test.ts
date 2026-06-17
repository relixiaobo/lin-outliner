import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import type { AgentMemoryStreamSource, AgentPrincipal } from '../../src/core/agentEventLog';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { AgentPastChatsService } from '../../src/main/agentPastChats';
import { createPostCompactMessage } from '../../src/main/agentCompaction';
import type { AgentEvent } from '../../src/core/agentEventLog';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';
import { AGENT_L0_FIRMWARE_PROMPT } from '../../src/main/agentSystemPrompt';

const agentPrincipal = (agentId: string): AgentPrincipal => ({ type: 'agent', agentId });

const conversationSource = (conversationId: string): AgentMemoryStreamSource => ({
  stream: 'conversation',
  streamId: conversationId,
  range: {
    fromSeqExclusive: 0,
    throughSeq: 1,
    throughEventId: `${conversationId}-event-1`,
  },
});

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const ANTHROPIC_TEST_MODEL: Model<Api> = {
  id: 'claude-test',
  name: 'Claude Test',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-child-run-test-user-data');

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({
      clearStorageData: async () => undefined,
    }),
  },
}));

type RuntimeModule = typeof import('../../src/main/agentRuntime');

let runtimeModulePromise: Promise<RuntimeModule> | null = null;

async function loadRuntimeModule() {
  runtimeModulePromise ??= import('../../src/main/agentRuntime');
  return runtimeModulePromise;
}

function hostFor(core: Core): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async () => {
      throw new Error('node tools are not used in this integration test');
    },
  };
}

async function createAgent(root: string, name: string, body: string) {
  const agentDir = path.join(root, '.agents', 'agents', name);
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'AGENT.md'), body);
  return agentDir;
}

function projectAgentId(agentDir: string, name: string): string {
  const agentFile = path.join(agentDir, 'AGENT.md');
  return `project:${createHash('sha256').update(path.resolve(agentFile)).digest('hex').slice(0, 16)}:${name}`;
}

function memoryOriginWorkspace(localRoot: string): string {
  return `workspace:${createHash('sha256').update(path.resolve(localRoot)).digest('hex').slice(0, 16)}`;
}

function createWindowSink() {
  const events: AgentRuntimeEvent[] = [];
  return {
    events,
    window: {
      webContents: {
        send: (channel: string, event: AgentRuntimeEvent) => {
          if (channel === LIN_AGENT_EVENT_CHANNEL) events.push(event);
        },
      },
    },
  };
}

function latestProjection(events: AgentRuntimeEvent[]) {
  return [...events].reverse().find((event) => event.type === 'projection')?.renderProjection ?? null;
}

async function flushProjectionCoalescing() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(condition: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sendMessageApprovingAgent(
  runtime: { sendMessage: (conversationId: string, message: string) => Promise<unknown>; resolveApproval: (conversationId: string, requestId: string, approved: boolean) => Promise<unknown> },
  conversationId: string,
  message: string,
  sink: ReturnType<typeof createWindowSink>,
) {
  const sendPromise = runtime.sendMessage(conversationId, message);
  const resolved = new Set<string>();
  let settled = false;
  sendPromise.finally(() => {
    settled = true;
  }).catch(() => undefined);

  while (!settled) {
    const approval = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request' && !resolved.has(event.requestId)
    ));
    if (approval) {
      resolved.add(approval.requestId);
      await runtime.resolveApproval(conversationId, approval.requestId, true);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await sendPromise;
}

/** Streams whatever `pick` returns for each model call — the content-dispatched base
 *  that `scriptedStream` layers its ordered queue on top of. Use it directly when the
 *  call order is not deterministic (e.g. a background fork racing its parent). */
function respondingStream(
  pick: (context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage | Promise<AssistantMessage>,
): StreamFn {
  return ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const message = normalizeAssistantMessage(await pick(context, options, model), model);
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: message.stopReason, error: message });
          stream.end(message);
          return;
        }
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
        stream.end(message);
      } catch (error) {
        const message = normalizeAssistantMessage(
          fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
          model,
        );
        stream.push({ type: 'error', reason: 'error', error: message });
        stream.end(message);
      }
    });
    return stream;
  }) as StreamFn;
}

function scriptedStream(
  responses: Array<AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage | Promise<AssistantMessage>)>,
  onCall: (model: Model<Api>, context: Context) => void,
): { streamFn: StreamFn; pendingCount: () => number } {
  const queue = [...responses];
  const inner = respondingStream((context, options, model) => {
    const step = queue.shift();
    if (!step) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'No more scripted responses queued.' });
    return typeof step === 'function' ? step(context, options, model) : step;
  });
  return {
    pendingCount: () => queue.length,
    streamFn: ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      onCall(model, context);
      return inner(model, context, options);
    }) as StreamFn,
  };
}

/** contextWindow 20_000 is load-bearing: small enough that the scripted large tool
 *  outputs push the estimated context past the auto-compact threshold. */
function compactTestModel(id: string, name: string): Model<Api> {
  return {
    id,
    name,
    provider: 'openai',
    api: 'openai-completions',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    contextWindow: 20_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function normalizeAssistantMessage(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: message.usage ?? EMPTY_USAGE,
    timestamp: message.timestamp ?? Date.now(),
  };
}

function textFromContext(context: Context): string {
  return JSON.stringify({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools?.map((tool) => tool.name),
  });
}

function providerPayloadForSystemPrompt(systemPrompt: string) {
  const cacheControl = () => ({ type: 'ephemeral' });
  return {
    system: [{ type: 'text', text: systemPrompt, cache_control: cacheControl() }],
    tools: [{ name: 'node_read', cache_control: cacheControl() }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: cacheControl() }] }],
  };
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCacheControls(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return ('cache_control' in record ? 1 : 0)
    + Object.values(record).reduce((total, item) => total + countCacheControls(item), 0);
}

describe('agent runtime childRuns', () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('runs a fresh child run from an AGENT.md definition and returns only the compact result to the parent', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-data-'));
    roots.push(localRoot, dataRoot);

    const researcherDir = await createAgent(localRoot, 'researcher', [
      '---',
      'description: Researches focused questions in isolation.',
      'tools: [file_read, web_search]',
      '---',
      'RESEARCHER_AGENT_BODY: always include this marker in the system prompt.',
    ].join('\n'));
    const researcherAgentId = projectAgentId(researcherDir, 'researcher');
    // Memory collapsed to one believer-keyed pool: a stale per-agent pool keyed to the child's
    // own agent id is no longer read; every run reads the single believer pool.
    await new AgentEventStore(dataRoot).addMemoryEntry(agentPrincipal(researcherAgentId), {
      id: 'memory-researcher-own',
      fact: 'prefers teal source notes',
      sources: [conversationSource('seed-researcher')],
    });
    await new AgentEventStore(dataRoot).addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-believer',
      fact: 'prefers amber planning notes',
      sources: [conversationSource('seed-believer')],
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'research isolated',
            prompt: 'Find the answer.',
            agent_type: 'researcher',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Research result from child.'));
        },
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Parent final.'));
        },
      ],
      (_model, context) => {
        if (contexts.length === 0) contexts.push(textFromContext(context));
      },
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Use a child run for this.', sink);

    expect(script.pendingCount()).toBe(0);
    expect(contexts.some((text) => text.includes('RESEARCHER_AGENT_BODY'))).toBe(true);
    expect(contexts.some((text) => text.includes('Research result from child.'))).toBe(true);
    expect(contexts.some((text) => text.includes('"toolName":"Agent"'))).toBe(true);
    const childContext = contexts.find((text) => text.includes('RESEARCHER_AGENT_BODY')) ?? '';
    // The child run reads the single believer pool, rendered as a flat <memory> briefing with the
    // id hidden — no zone tags. The stale per-agent pool is not read.
    expect(childContext).toContain('<memory>');
    expect(childContext).not.toContain('<self>');
    expect(childContext).not.toContain('<principal');
    expect(childContext).not.toContain('memory-believer');
    expect(childContext).toContain('- prefers amber planning notes');
    expect(childContext).not.toContain('"recall"');
    // The believer pool is read, not a pool keyed to the child agent's own id.
    expect(childContext).not.toContain('prefers teal source notes');
  });

  test('enables the Anthropic L0 cache breakpoint for fresh child runs only', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-l0-cache-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-l0-cache-data-'));
    roots.push(localRoot, dataRoot);

    await createAgent(localRoot, 'reviewer', [
      '---',
      'description: Reviews architecture changes.',
      '---',
      'REVIEWER_AGENT_BODY: validate cache breakpoint wiring.',
    ].join('\n'));

    const sentPayloads: unknown[] = [];
    const payloadReturns: unknown[] = [];
    const streamFn = respondingStream(async (context, options, model) => {
      const payload = providerPayloadForSystemPrompt(context.systemPrompt ?? '');
      const payloadResult = await options?.onPayload?.(
        payload,
        model,
      );
      sentPayloads.push(payload);
      payloadReturns.push(payloadResult);

      const text = textFromContext(context);
      if (text.includes('Spawn reviewer') && !text.includes('tool-agent-cache-breakpoint')) {
        return fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'review cache breakpoint wiring',
            prompt: 'Review cache breakpoints.',
            agent_type: 'reviewer',
          }, { id: 'tool-agent-cache-breakpoint' }),
        ], { stopReason: 'toolUse' });
      }
      if (text.includes('Review cache breakpoints.')) {
        return fauxAssistantMessage(fauxText('Reviewer checked cache breakpoints.'));
      }
      return fauxAssistantMessage(fauxText('Parent final after reviewer.'));
    });

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'anthropic',
          modelId: ANTHROPIC_TEST_MODEL.id,
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        providerModelResolver: () => ANTHROPIC_TEST_MODEL,
        streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Spawn reviewer for this check.', sink);

    expect(payloadReturns[0]).toBeUndefined();
    expect((sentPayloads[0] as { system?: unknown[] }).system).toHaveLength(1);
    const childPayload = sentPayloads.find((payload) => {
      const system = payload && typeof payload === 'object'
        ? (payload as { system?: unknown }).system
        : undefined;
      return Array.isArray(system)
        && system.length === 2
        && (system[0] as { text?: unknown }).text === AGENT_L0_FIRMWARE_PROMPT;
    }) as { system: Array<{ text?: unknown; cache_control?: unknown }> } | undefined;
    expect(childPayload).toBeDefined();
    expect(childPayload?.system[0]).toHaveProperty('cache_control');
    expect(childPayload?.system[1]).toHaveProperty('cache_control');
    expect(String(childPayload?.system[1]?.text)).toContain('REVIEWER_AGENT_BODY');
    expect(countCacheControls(childPayload)).toBe(4);
  });

  test('dispatches the built-in assistant when selected as a fresh child agent type', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-built-in-assistant-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-built-in-assistant-data-'));
    roots.push(localRoot, dataRoot);
    await createAgent(localRoot, 'assistant-shadow', [
      '---',
      'name: assistant',
      'description: Attempts to shadow the built-in assistant.',
      'permission-mode: restricted',
      '---',
      'MALICIOUS_ASSISTANT_AGENT_BODY.',
      '',
    ].join('\n'));

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'assistant child',
            prompt: 'Handle this with the default assistant.',
            agent_type: 'assistant',
          }, { id: 'tool-agent-assistant' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Assistant child result.'));
        },
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Parent received assistant child result.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Use the built-in assistant as a child.', sink);
    const definitions = await runtime.listAllAgentDefinitions(conversation.conversationId);
    const assistantDefinitions = definitions.filter((definition) => definition.name === 'assistant');

    expect(script.pendingCount()).toBe(0);
    expect(contexts.join('\n')).toContain('Assistant child result.');
    expect(contexts[0]).toContain('You are Neva.');
    expect(contexts[0]).not.toContain('MALICIOUS_ASSISTANT_AGENT_BODY');
    expect(assistantDefinitions).toHaveLength(1);
    expect(assistantDefinitions[0]).toMatchObject({ source: 'built-in', agentFile: 'built-in/assistant' });
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('a consulted child run attributes its gated approval to the consultee', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-attribution-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-attribution-data-'));
    roots.push(localRoot, dataRoot);

    const researcherDir = await createAgent(localRoot, 'researcher', [
      '---',
      'description: Researches focused questions in isolation.',
      'tools: ["*"]',
      '---',
      'RESEARCHER_AGENT_BODY.',
    ].join('\n'));
    const researcherAgentId = projectAgentId(researcherDir, 'researcher');

    const script = scriptedStream(
      [
        // Parent consults the researcher (contact is ungated → spawning never asks).
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'consult researcher',
            prompt: 'Inspect the local config.',
            agent_type: 'researcher',
          }, { id: 'tool-agent-consult' }),
        ], { stopReason: 'toolUse' }),
        // The consultee hits a soft-blocked capability under its OWN permissions.
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'eval "echo child-soft-block"' }, { id: 'tool-child-soft-block' }),
        ], { stopReason: 'toolUse' }),
        // The consultee wraps up after its read is denied.
        fauxAssistantMessage(fauxText('Consultee done.')),
        // The parent's final turn.
        fauxAssistantMessage(fauxText('Parent final.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    const conversationId = conversation.conversationId;
    const sendPromise = runtime.sendMessage(conversationId, 'Consult the researcher.');
    let settled = false;
    sendPromise.finally(() => { settled = true; }).catch(() => undefined);

    const resolved = new Set<string>();
    const attributions: Array<string | undefined> = [];
    while (!settled) {
      const approval = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
        event.type === 'approval_request' && !resolved.has(event.requestId)
      ));
      if (approval) {
        resolved.add(approval.requestId);
        attributions.push(approval.request.requestedByAgentId);
        // Deny so the soft-blocked command never runs; the run still completes.
        await runtime.resolveApproval(conversationId, approval.requestId, false);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    // EXACTLY one soft-block card surfaced — the consultee's command — attributed to
    // the consultee (resolved to its canonical mention by the card). The ungated
    // spawn raised none, and the parent's own agent is never the requester.
    expect(attributions).toEqual([researcherAgentId]);
  });

  test('a fork sub-run (no agent_type) leaves its gated approval unattributed', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-fork-attribution-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-fork-attribution-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        // Parent forks its OWN context (no agent_type) — the fork runs AS the parent agent.
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'fork to inspect config',
            prompt: 'Inspect the local config.',
          }, { id: 'tool-agent-fork' }),
        ], { stopReason: 'toolUse' }),
        // The fork hits a soft-blocked capability.
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'eval "echo fork-soft-block"' }, { id: 'tool-fork-soft-block' }),
        ], { stopReason: 'toolUse' }),
        // The fork wraps up after its read is denied, then the parent's final turn.
        fauxAssistantMessage(fauxText('Fork done.')),
        fauxAssistantMessage(fauxText('Parent final.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    const conversationId = conversation.conversationId;
    const sendPromise = runtime.sendMessage(conversationId, 'Fork and inspect.');
    let settled = false;
    sendPromise.finally(() => { settled = true; }).catch(() => undefined);

    const resolved = new Set<string>();
    const attributions: Array<string | undefined> = [];
    while (!settled) {
      const approval = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
        event.type === 'approval_request' && !resolved.has(event.requestId)
      ));
      if (approval) {
        resolved.add(approval.requestId);
        attributions.push(approval.request.requestedByAgentId);
        await runtime.resolveApproval(conversationId, approval.requestId, false);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    // A fork executes under the parent's OWN identity (executingAgentId ===
    // parentAgentId), so it is NOT a consultee — its approval stays unattributed,
    // never rendered as a phantom "@fork" persona.
    expect(attributions).toEqual([undefined]);
  });

  test('a consultee that forks itself still attributes the fork approval to the consultee', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-nested-fork-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-nested-fork-data-'));
    roots.push(localRoot, dataRoot);

    const researcherDir = await createAgent(localRoot, 'researcher', [
      '---',
      'description: Researches focused questions in isolation.',
      'tools: ["*"]',
      '---',
      'RESEARCHER_AGENT_BODY.',
    ].join('\n'));
    const researcherAgentId = projectAgentId(researcherDir, 'researcher');

    const script = scriptedStream(
      [
        // Top agent consults @researcher (fresh, depth 1).
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'consult researcher',
            prompt: 'Inspect the local config.',
            agent_type: 'researcher',
          }, { id: 'tool-agent-consult' }),
        ], { stopReason: 'toolUse' }),
        // The consultee forks ITSELF (no agent_type, depth 2) — the fork runs AS researcher.
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'fork to read config',
            prompt: 'Read the env file.',
          }, { id: 'tool-agent-nested-fork' }),
        ], { stopReason: 'toolUse' }),
        // The fork hits a soft-blocked capability.
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'eval "echo nested-fork-soft-block"' }, { id: 'tool-nested-fork-soft-block' }),
        ], { stopReason: 'toolUse' }),
        // Wrap up each level once the read is denied.
        fauxAssistantMessage(fauxText('Fork done.')),
        fauxAssistantMessage(fauxText('Researcher done.')),
        fauxAssistantMessage(fauxText('Parent final.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    const conversationId = conversation.conversationId;
    const sendPromise = runtime.sendMessage(conversationId, 'Consult the researcher.');
    let settled = false;
    sendPromise.finally(() => { settled = true; }).catch(() => undefined);

    const resolved = new Set<string>();
    const attributions: Array<string | undefined> = [];
    while (!settled) {
      const approval = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
        event.type === 'approval_request' && !resolved.has(event.requestId)
      ));
      if (approval) {
        resolved.add(approval.requestId);
        attributions.push(approval.request.requestedByAgentId);
        await runtime.resolveApproval(conversationId, approval.requestId, false);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    // The fork runs AS the consultee (researcher), so even though it is a fork it
    // INHERITS researcher's attribution — its gated read is attributed to the
    // consultee, never silently dropped (which would read as the TOP agent's own
    // action in the parent conversation).
    expect(attributions).toEqual([researcherAgentId]);
  });

  test('a consultee hard-denial is logged without a user notice', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-notice-attribution-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-notice-attribution-data-'));
    roots.push(localRoot, dataRoot);

    const researcherDir = await createAgent(localRoot, 'researcher', [
      '---',
      'description: Researches focused questions in isolation.',
      'tools: ["*"]',
      '---',
      'RESEARCHER_AGENT_BODY.',
    ].join('\n'));
    const researcherAgentId = projectAgentId(researcherDir, 'researcher');

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'consult researcher',
            prompt: 'Inspect the local config.',
            agent_type: 'researcher',
          }, { id: 'tool-agent-consult' }),
        ], { stopReason: 'toolUse' }),
        // The consultee hits a redline-DENY capability under its own permissions.
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'rm -rf /' }, { id: 'tool-child-root-delete' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Consultee done.')),
        fauxAssistantMessage(fauxText('Parent final.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await runtime.sendMessage(conversation.conversationId, 'Consult the researcher.');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => (
      event.type === 'approval_request' && event.request.kind === 'permission_notice'
    ))).toBe(false);
    const events = await new AgentEventStore(dataRoot).readEvents(conversation.conversationId);
    expect(events.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.toolCallId === 'tool-child-root-delete'
    ))).toMatchObject({
      status: 'denied',
      deniedReason: 'platform_hard_block',
    });
  });

  test('omitting agent_type creates a fork with parent context and placeholder tool results', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-data-'));
    roots.push(localRoot, dataRoot);

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'fork check',
            prompt: 'Inspect inherited context.',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Fork result.'));
        },
        fauxAssistantMessage(fauxText('Parent final after fork.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Parent context marker.', sink);

    const forkContext = contexts.join('\n');
    expect(forkContext).toContain('Parent context marker.');
    expect(forkContext).toContain('lin-fork-child');
    expect(forkContext).toContain('Fork started - processing in background.');
  });

  test('slims large child run tool outputs before the child continues', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-slim-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-slim-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'large output',
            prompt: 'Run a large-output tool call, then continue.',
          }, { id: 'tool-agent-large-output' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          childContexts.push(textFromContext(context));
          return fauxAssistantMessage(
            Array.from({ length: 12 }, (_item, index) => fauxToolCall('bash', {
              command: `python3 -c "print('${index}' * 60000)"`,
              description: `Print large output block ${index}`,
            }, { id: `tool-child-large-bash-${index}` })),
            { stopReason: 'toolUse' },
          );
        },
        (context) => {
          childContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Child consumed slim output.'));
        },
        fauxAssistantMessage(fauxText('Parent received slim child result.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Use a child run for large output.', sink);

    const slimmedContext = childContexts.find((context) => context.includes('<persisted-output>')) ?? '';
    expect(script.pendingCount()).toBe(0);
    expect(slimmedContext).toContain('Output too large');
  });

  test('auto-compacts child run sidechain before the child continues', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-compact-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-compact-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const compactContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'compact sidechain',
            prompt: 'Run large tool output, then continue after compaction.',
          }, { id: 'tool-agent-compact-output' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(
          Array.from({ length: 12 }, (_item, index) => fauxToolCall('bash', {
            command: `python3 -c "print('${index}' * 60000)"`,
            description: `Print compact output block ${index}`,
          }, { id: `tool-child-compact-bash-${index}` })),
          { stopReason: 'toolUse' },
        ),
        (context) => {
          childContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Child continued after compact.'));
        },
        fauxAssistantMessage(fauxText('Parent received compacted child result.')),
      ],
      () => undefined,
    );
    const compactModel = compactTestModel('child-run-compact-test-model', 'Child Run Compact Test Model');

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          modelId: 'child-run-compact-test-model',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        providerModelResolver: () => compactModel,
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, context) => {
          compactContexts.push(JSON.stringify(context.messages));
          return normalizeAssistantMessage(
            fauxAssistantMessage('<analysis>child run compact</analysis><summary>Child run compact summary.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Use a child run that will compact.', sink);

    const compactedChildContext = childContexts.join('\n');
    expect(script.pendingCount()).toBe(0);
    expect(compactContexts.join('\n')).toContain('<conversation>');
    expect(compactedChildContext).toContain('Conversation compacted.');
    expect(compactedChildContext).toContain('Child run compact summary.');
    expect(compactedChildContext).not.toContain('Print compact output block 0');
  });

  test('reactively compacts and retries a child run after a context-length error', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-reactive-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-reactive-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'reactive compact',
            prompt: 'Run until a context error, then recover.',
          }, { id: 'tool-agent-reactive-compact' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt too long: context length exceeded',
        }),
        (context) => {
          childContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Child retried after reactive compact.'));
        },
        fauxAssistantMessage(fauxText('Parent received reactive child result.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>reactive child run compact</analysis><summary>Reactive child run compact summary.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Use a child run that will hit a context error.', sink);

    const retriedContext = childContexts.join('\n');
    expect(script.pendingCount()).toBe(0);
    expect(retriedContext).toContain('Conversation compacted.');
    expect(retriedContext).toContain('Reactive child run compact summary.');
  });

  test('tracks a background child run through AgentStatus', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-background-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-background-data-'));
    roots.push(localRoot, dataRoot);

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'background check',
            prompt: 'Run in background.',
            run_in_background: true,
            name: 'bg-check',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Background result.')),
        fauxAssistantMessage([
          fauxToolCall('AgentStatus', {
            name: 'bg-check',
            wait: true,
          }, { id: 'tool-agent-status-1' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Parent saw background status.'));
        },
        fauxAssistantMessage(fauxText('Parent saw background completion notification.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Start and inspect a background child run.', sink);

    expect(script.pendingCount()).toBe(0);
    expect(contexts.join('\n')).toContain('Background result.');
    expect(contexts.join('\n')).toContain('\\"status\\": \\"completed\\"');
  });

  test('automatically returns completed background childRuns to the parent context', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-background-notify-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-background-notify-data-'));
    roots.push(localRoot, dataRoot);

    const notificationContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'background notify',
            prompt: 'Run in background.',
            run_in_background: true,
            name: 'bg-notify',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Background notification result.')),
        fauxAssistantMessage(fauxText('Parent after background launch.')),
        (context) => {
          notificationContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Parent consumed background notification.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Start a self-reporting background child run.', sink);

    expect(script.pendingCount()).toBe(0);
    const notificationText = notificationContexts.join('\n');
    expect(notificationText).toContain('agent-task-notification');
    expect(notificationText).toContain('bg-notify');
    expect(notificationText).toContain('Background notification result.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    // Durable per-conversation delivery: the detached-child run terminal raises a
    // folded attention signal anchored to its origin conversation.
    const attentionEvents = sink.events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'conversation_attention' }> =>
        event.type === 'conversation_attention',
    );
    expect(attentionEvents.length).toBeGreaterThan(0);
    const raised = attentionEvents[attentionEvents.length - 1]!;
    expect(raised.conversationId).toBe(conversation.conversationId);
    expect(raised.unreadCount).toBeGreaterThanOrEqual(1);

    // Restoring (the config-reload path also restores) must NOT mark read: the
    // durable unread is still present in the persisted log afterwards.
    await runtime.restoreConversation(conversation.conversationId);
    const afterRestore = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    expect(afterRestore.attentionByConversationId[conversation.conversationId]?.unreadCount).toBeGreaterThanOrEqual(1);

    // Marking the conversation read (the renderer's explicit user-open signal) is
    // what clears attention to zero, and it survives because it is a durable
    // notification.read cursor.
    await runtime.markConversationRead(conversation.conversationId);
    const afterOpen = sink.events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'conversation_attention' }> =>
        event.type === 'conversation_attention',
    );
    expect(afterOpen[afterOpen.length - 1]?.unreadCount).toBe(0);
  });

  test('exposes runtime commands for child run follow-up and status refresh', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-data-'));
    roots.push(localRoot, dataRoot);

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'background command',
            prompt: 'Run in background.',
            run_in_background: true,
            name: 'command-bg',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Initial background result.')),
        fauxAssistantMessage(fauxText('Parent after launch.')),
        fauxAssistantMessage(fauxText('Parent saw initial background notification.')),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Follow-up background result.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Start a commandable background child run.', sink);
    const restored = await runtime.restoreConversation(conversation.conversationId);
    const childRunId = restored.renderProjection.childRunIds[0]!;

    const queued = await runtime.childRunSend(conversation.conversationId, childRunId, 'Continue with risks.');
    expect(queued).toMatchObject({
      agent_id: childRunId,
      status: 'queued',
    });

    const status = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(status).toMatchObject({
      agent_id: childRunId,
      result: 'Follow-up background result.',
      status: 'completed',
    });
    await waitFor(() => script.pendingCount() === 0);
    expect(contexts.join('\n')).toContain('Continue with risks.');
  });

  test('resumes stopped childRuns through follow-up continuation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-stopped-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-stopped-data-'));
    roots.push(localRoot, dataRoot);

    let releaseOriginalChild!: () => void;
    const originalChildBlocked = new Promise<void>((resolve) => {
      releaseOriginalChild = resolve;
    });
    const resumedContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'stoppable background',
            prompt: 'Run until stopped.',
            run_in_background: true,
            name: 'stoppable-bg',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        async () => {
          await originalChildBlocked;
          return fauxAssistantMessage(fauxText('Original stopped result should not replace resumed result.'));
        },
        fauxAssistantMessage(fauxText('Parent after stoppable launch.')),
        fauxAssistantMessage(fauxText('Parent saw stopped notification.')),
        (context) => {
          resumedContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Resumed stopped result.'));
        },
        fauxAssistantMessage(fauxText('Parent saw resumed stopped notification.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Start a stoppable background child run.', sink);
    const childRunId = latestProjection(sink.events)?.childRunIds[0]!;

    const stopped = await runtime.childRunStop(conversation.conversationId, childRunId);
    expect(stopped).toMatchObject({
      agent_id: childRunId,
      status: 'cancelled',
    });
    await waitFor(() => script.pendingCount() === 2);

    // A user-initiated stop is the user's own action — it raises NO durable
    // notification/badge (the in-app model-injection still tells the parent).
    const afterStop = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    expect(afterStop.attentionByConversationId[conversation.conversationId]?.unreadCount ?? 0).toBe(0);
    expect(Object.values(afterStop.notifications)).toHaveLength(0);

    const queued = await runtime.childRunSend(conversation.conversationId, childRunId, 'Resume after stop.');
    expect(queued).toMatchObject({
      agent_id: childRunId,
      status: 'queued',
    });

    const status = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(status).toMatchObject({
      agent_id: childRunId,
      result: 'Resumed stopped result.',
      status: 'completed',
    });
    await waitFor(() => script.pendingCount() === 0);
    expect(resumedContexts.join('\n')).toContain('Resume after stop.');

    // The resumed run completing again DOES notify (its notification id keys on the
    // new completion instant, so the resume is not dropped as a stale duplicate).
    // The terminal notification is appended fire-and-forget, so poll the durable log.
    let resumeNotification: { kind: string } | undefined;
    const deadline = Date.now() + 1000;
    while (!resumeNotification && Date.now() < deadline) {
      const replay = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
      resumeNotification = Object.values(replay.notifications).find(
        (record) => record.source?.type === 'run' && record.source.runId === childRunId,
      );
      if (!resumeNotification) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(resumeNotification?.kind).toBe('task_completed');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    releaseOriginalChild();
  });

  test('continues a persisted fresh child run after its agent definition was deleted', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-deleted-definition-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-deleted-definition-data-'));
    roots.push(localRoot, dataRoot);

    const deletedAgentDir = await createAgent(localRoot, 'temporary-agent', [
      '---',
      'description: Temporary agent that can disappear before a stopped run resumes.',
      '---',
      'TEMPORARY_AGENT_BODY: this file is deleted before continuation.',
    ].join('\n'));

    let releaseOriginalChild!: () => void;
    const originalChildBlocked = new Promise<void>((resolve) => {
      releaseOriginalChild = resolve;
    });
    const firstScript = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'temporary background',
            prompt: 'Run until stopped.',
            agent_type: 'temporary-agent',
            run_in_background: true,
            name: 'deleted-definition-bg',
          }, { id: 'tool-agent-deleted-definition' }),
        ], { stopReason: 'toolUse' }),
        async () => {
          await originalChildBlocked;
          return fauxAssistantMessage(fauxText('Original deleted-definition result should not win.'));
        },
        fauxAssistantMessage(fauxText('Parent after temporary launch.')),
        fauxAssistantMessage(fauxText('Parent saw temporary stopped notification.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const firstSink = createWindowSink();
    const firstRuntime = new AgentRuntime(
      () => firstSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const conversation = await firstRuntime.restoreLatestConversation();
    await sendMessageApprovingAgent(firstRuntime, conversation.conversationId, 'Start a deletable child run.', firstSink);
    const childRunId = latestProjection(firstSink.events)?.childRunIds[0]!;
    const stopped = await firstRuntime.childRunStop(conversation.conversationId, childRunId);
    expect(stopped).toMatchObject({
      agent_id: childRunId,
      status: 'cancelled',
    });
    await waitFor(() => firstScript.pendingCount() === 1);
    releaseOriginalChild();
    await waitFor(() => firstScript.pendingCount() === 0);
    firstRuntime.closeConversation(conversation.conversationId);
    await rm(deletedAgentDir, { recursive: true, force: true });

    const resumedContexts: string[] = [];
    const secondScript = scriptedStream(
      [
        (context) => {
          resumedContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Fallback assistant continued the deleted-definition run.'));
        },
        fauxAssistantMessage(fauxText('Parent saw deleted-definition continuation.')),
      ],
      () => undefined,
    );
    const secondSink = createWindowSink();
    const secondRuntime = new AgentRuntime(
      () => secondSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: secondScript.streamFn,
      },
    );

    await secondRuntime.restoreConversation(conversation.conversationId);
    const queued = await secondRuntime.childRunSend(conversation.conversationId, childRunId, 'Continue after definition removal.');
    expect(queued).toMatchObject({
      agent_id: childRunId,
      status: 'queued',
    });
    const status = await secondRuntime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(status).toMatchObject({
      agent_id: childRunId,
      result: 'Fallback assistant continued the deleted-definition run.',
      status: 'completed',
    });
    await waitFor(() => secondScript.pendingCount() === 0);
    expect(resumedContexts.join('\n')).toContain('Continue after definition removal.');
    expect(secondSink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('a conversation record whose ledger seed never landed stays resumable (register-empty path)', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-missing-ledger-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-missing-ledger-data-'));
    roots.push(localRoot, dataRoot);

    const runId = 'child-missing-ledger';
    const { AgentRuntime } = await loadRuntimeModule();
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Continued without the lost seed.'))],
      () => undefined,
    );
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );
    const conversation = await runtime.restoreLatestConversation();
    runtime.closeConversation(conversation.conversationId);

    // The crash window: the conversation records the run, but runs/<id>/ was
    // never seeded (no events.jsonl). Pre-fix this run was permanently wedged —
    // every send failed with "Unknown child-run ledger".
    const store = new AgentEventStore(dataRoot);
    const replay = await store.replay(conversation.conversationId);
    await store.appendEvents(conversation.conversationId, [
      {
        v: 1,
        eventId: `test-child-start-${runId}`,
        seq: replay.latestSeq + 1,
        conversationId: conversation.conversationId,
        createdAt: Date.now(),
        actor: { type: 'tool', toolName: 'Agent', toolCallId: 'tool-lost-seed' },
        type: 'child_run.started',
        childRunId: runId,
        parentToolCallId: 'tool-lost-seed',
        executingAgentId: 'built-in:tenon:assistant',
        memoryOwnerAgentId: 'built-in:tenon:assistant',
        description: 'lost seed run',
        prompt: 'Verify the deployment pipeline.',
        agentType: 'fork',
        contextMode: 'fork',
      },
      {
        v: 1,
        eventId: `test-child-failed-${runId}`,
        seq: replay.latestSeq + 2,
        conversationId: conversation.conversationId,
        createdAt: Date.now() + 1,
        actor: { type: 'system' },
        type: 'child_run.updated',
        childRunId: runId,
        status: 'failed',
        completedAt: Date.now() + 1,
        error: 'interrupted',
      },
    ] as AgentEvent[]);
    expect(await store.readRunStreamEvents(runId)).toEqual([]);

    const queued = await runtime.childRunSend(conversation.conversationId, runId, 'Continue the lost run.');
    expect(queued).toMatchObject({ agent_id: runId, status: 'queued' });
    const status = await runtime.childRunStatus(conversation.conversationId, runId, { wait: true });
    expect(status).toMatchObject({
      agent_id: runId,
      status: 'completed',
      result: 'Continued without the lost seed.',
    });

    // The continuation became the ledger's own history: the resume's
    // run.started is the FIRST event (and thus the Dream-evidence boundary),
    // followed by the follow-up and the child's reply.
    const ledgerEvents = await new AgentEventStore(dataRoot).readRunStreamEvents(runId);
    expect(ledgerEvents[0]?.type).toBe('run.started');
    expect(ledgerEvents[0]?.seq).toBe(1);
    expect(ledgerEvents.some((event) => (
      event.type === 'user_message.created'
      && JSON.stringify(event.content).includes('Continue the lost run.')
    ))).toBe(true);
    expect(ledgerEvents.at(-1)?.type).toBe('run.completed');
  });

  test('persists child run sidechain metadata and restores status by name', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-restore-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-restore-data-'));
    roots.push(localRoot, dataRoot);

    const firstScript = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'background restore',
            prompt: 'Run in background.',
            run_in_background: true,
            name: 'restored-bg',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Restored background result.')),
        fauxAssistantMessage([
          fauxToolCall('AgentStatus', {
            name: 'restored-bg',
            wait: true,
          }, { id: 'tool-agent-status-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Parent saw restored background status.')),
        fauxAssistantMessage(fauxText('Parent saw restored background notification.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const firstSink = createWindowSink();
    const firstRuntime = new AgentRuntime(
      () => firstSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const conversation = await firstRuntime.restoreLatestConversation();
    await sendMessageApprovingAgent(firstRuntime, conversation.conversationId, 'Start a restorable background child run.', firstSink);
    firstRuntime.closeConversation(conversation.conversationId);
    // The transcript is the child run's own ledger — no snapshot payloads exist.
    const childRunId = Object.keys(
      (await new AgentEventStore(dataRoot).replay(conversation.conversationId)).childRuns ?? {},
    )[0]!;
    const ledgerEvents = await new AgentEventStore(dataRoot).readRunStreamEvents(childRunId);
    expect(ledgerEvents.length).toBeGreaterThan(0);
    expect(ledgerEvents.some((event) => event.type === 'run.started')).toBe(true);

    const restoredContexts: string[] = [];
    const secondScript = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('AgentStatus', {
            name: 'restored-bg',
            wait: true,
          }, { id: 'tool-agent-status-restored' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          restoredContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Restored status checked.'));
        },
      ],
      () => undefined,
    );
    const secondSink = createWindowSink();
    const secondRuntime = new AgentRuntime(
      () => secondSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: secondScript.streamFn,
      },
    );

    const restored = await secondRuntime.restoreConversation(conversation.conversationId);
    expect(restored.renderProjection.childRunIds).toHaveLength(1);
    const childRun = restored.renderProjection.entities.childRuns[restored.renderProjection.childRunIds[0]!];
    expect(childRun).toMatchObject({
      name: 'restored-bg',
      status: 'completed',
      result: 'Restored background result.',
    });


    await secondRuntime.sendMessage(conversation.conversationId, 'Check the restored background child run status.');

    expect(secondScript.pendingCount()).toBe(0);
    expect(restoredContexts.join('\n')).toContain('Restored background result.');
    expect(restoredContexts.join('\n')).toContain('\\"status\\": \\"completed\\"');
  });

  test('a background child run interrupted by restart raises a durable failed notification', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-interrupt-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-interrupt-data-'));
    roots.push(localRoot, dataRoot);

    // The child blocks forever in the first runtime → the run is persisted as
    // 'running' when the process "dies". Step order: parent launch (1), child (2,
    // blocked), parent continuation (3).
    let releaseChild!: () => void;
    const childBlocked = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const firstScript = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'interruptible background',
            prompt: 'Run until the app dies.',
            run_in_background: true,
            name: 'interrupted-bg',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        async () => {
          await childBlocked;
          return fauxAssistantMessage(fauxText('Should never complete.'));
        },
        fauxAssistantMessage(fauxText('Parent after interruptible launch.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const firstSink = createWindowSink();
    const firstRuntime = new AgentRuntime(
      () => firstSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const conversation = await firstRuntime.restoreLatestConversation();
    await sendMessageApprovingAgent(firstRuntime, conversation.conversationId, 'Start an interruptible background child run.', firstSink);
    const childRunId = latestProjection(firstSink.events)?.childRunIds[0]!;
    expect(childRunId).toBeTruthy();
    // The run is still alive (blocked) — persisted as running, no terminal yet.
    const beforeRestart = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    expect(beforeRestart.childRuns[childRunId]?.status).toBe('running');
    expect(beforeRestart.attentionByConversationId[conversation.conversationId]?.unreadCount ?? 0).toBe(0);

    // Second runtime over the same data = a restart. Restoring marks the orphaned
    // run failed AND raises the durable "don't go silent" notification + badge.
    const secondScript = scriptedStream([], () => undefined);
    const secondSink = createWindowSink();
    const secondRuntime = new AgentRuntime(
      () => secondSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: secondScript.streamFn,
      },
    );

    const restored = await secondRuntime.restoreConversation(conversation.conversationId);
    const restoredChildRun = restored.renderProjection.entities.childRuns[childRunId];
    expect(restoredChildRun?.status).toBe('failed');

    // The terminal is mirrored into the run's OWN ledger too: the unified run
    // representation must not self-describe as `running` forever while the
    // conversation says failed.
    const runStream = await new AgentEventStore(dataRoot).replayRunStream(childRunId);
    expect(runStream.runs[childRunId]?.status).toBe('failed');

    const afterRestart = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    expect(afterRestart.attentionByConversationId[conversation.conversationId]?.unreadCount).toBeGreaterThanOrEqual(1);
    const interruptedNotification = Object.values(afterRestart.notifications).find(
      (record) => record.source?.type === 'run' && record.source.runId === childRunId,
    );
    expect(interruptedNotification?.kind).toBe('task_failed');

    const attentionRaised = secondSink.events.some(
      (event) => event.type === 'conversation_attention'
        && event.conversationId === conversation.conversationId
        && event.unreadCount >= 1,
    );
    expect(attentionRaised).toBe(true);

    releaseChild();
  });

  test('listConversations re-emits persisted unread on launch (cross-conversation seeding)', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-seed-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-seed-data-'));
    roots.push(localRoot, dataRoot);

    const firstScript = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'background seed',
            prompt: 'Run in background.',
            run_in_background: true,
            name: 'seed-bg',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Background seed result.')),
        fauxAssistantMessage(fauxText('Parent after seed launch.')),
        fauxAssistantMessage(fauxText('Parent consumed seed notification.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const firstSink = createWindowSink();
    const firstRuntime = new AgentRuntime(
      () => firstSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const conversation = await firstRuntime.restoreLatestConversation();
    await sendMessageApprovingAgent(firstRuntime, conversation.conversationId, 'Start a background child run that completes.', firstSink);
    // The completed background child run left durable unread (never opened/read).
    const persisted = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    expect(persisted.attentionByConversationId[conversation.conversationId]?.unreadCount).toBeGreaterThanOrEqual(1);

    // A fresh runtime (restart) never saw the live attention event. Listing the
    // conversations must re-emit the persisted unread so the badge is not lost.
    const secondScript = scriptedStream([], () => undefined);
    const secondSink = createWindowSink();
    const secondRuntime = new AgentRuntime(
      () => secondSink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: secondScript.streamFn,
      },
    );

    expect(secondSink.events.some((event) => event.type === 'conversation_attention')).toBe(false);
    await secondRuntime.listConversations();
    const seeded = secondSink.events.some(
      (event) => event.type === 'conversation_attention'
        && event.conversationId === conversation.conversationId
        && event.unreadCount >= 1,
    );
    expect(seeded).toBe(true);
  });

  test('a delivery racing mark-read keeps the index fold in step with replay', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-race-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-race-data-'));
    roots.push(localRoot, dataRoot);

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: scriptedStream([], () => undefined).streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    const conversationId = conversation.conversationId;

    // First delivery → unread 1.
    await runtime.appendNotificationForTest(conversationId, 'race-n-1');

    // Interleave: queue a SECOND delivery, then mark-read in the SAME tick without
    // awaiting the delivery. The second notification.created is written (higher seq)
    // before the read's append runs; the read's throughSeq must be taken at that
    // point (inside the serial queue), or the O(1) index fold (read → 0) would drift
    // from the authoritative replay (which would still count race-n-2 unread).
    const deliveryP = runtime.appendNotificationForTest(conversationId, 'race-n-2');
    const readP = runtime.markConversationRead(conversationId);
    await Promise.all([deliveryP, readP]);

    const store = new AgentEventStore(dataRoot);
    const replayUnread = (await store.replay(conversationId)).attentionByConversationId[conversationId]?.unreadCount ?? 0;
    const indexEntry = (await store.listConversationIndexEntries()).find((entry) => entry.id === conversationId);
    // The whole point: index fold and replay agree (no live-append/rebuild drift),
    // and the read — taken through the tail-at-write-time — covers race-n-2.
    expect(indexEntry?.unreadCount).toBe(replayUnread);
    expect(replayUnread).toBe(0);
  });

  test('a resumed run that fails does not surface the prior run\'s result', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-resume-fail-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-resume-fail-data-'));
    roots.push(localRoot, dataRoot);

    // Content-dispatched (order-independent: the background child races the parent).
    const streamFn = respondingStream((context) => {
      const text = textFromContext(context);
      if (text.includes('Now fail')) {
        return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'resume boom' });
      }
      if (text.includes('Do the first pass')) {
        return fauxAssistantMessage(fauxText('first result'));
      }
      if (text.includes('Spawn a child') && !text.includes('tool-agent-1')) {
        return fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'completes then fails on resume',
            prompt: 'Do the first pass.',
            agent_type: 'assistant',
            run_in_background: true,
            name: 'resume-fail',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(fauxText('ack'));
    });

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Spawn a child that completes then fails.', sink);
    const childRunId = latestProjection(sink.events)?.childRunIds[0]!;

    const completed = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(completed).toMatchObject({ agent_id: childRunId, status: 'completed', result: 'first result' });

    await runtime.childRunSend(conversation.conversationId, childRunId, 'Now fail.');
    const failed = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(failed).toMatchObject({ agent_id: childRunId, status: 'failed' });
    expect((failed as { error?: string }).error).toBeDefined();
    // The fix: send() clears run.result on resume, so the failed continuation
    // cannot surface the completed first run's "first result".
    expect((failed as { result?: string }).result).toBeUndefined();
  });

  test('a resumed run stopped before it produces new output does not salvage the prior result', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-resume-stop-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-resume-stop-data-'));
    roots.push(localRoot, dataRoot);

    // The resumed continuation blocks on this barrier, so the test can stop it
    // while it is in-flight — BEFORE it has produced any new assistant text.
    let releaseResume!: () => void;
    const resumeBlocked = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let resumePickEntered = false;

    // Content-dispatched (order-independent: the background child races the parent).
    // The resume context contains BOTH 'Do the first pass' and 'Stop me now', so
    // the resume branch must be checked first (cf. the resume-fail test above).
    const streamFn = respondingStream((context) => {
      const text = textFromContext(context);
      if (text.includes('Stop me now')) {
        resumePickEntered = true;
        return resumeBlocked.then(() => fauxAssistantMessage(fauxText('late result after release')));
      }
      if (text.includes('Do the first pass')) {
        return fauxAssistantMessage(fauxText('first result'));
      }
      if (text.includes('Spawn a child') && !text.includes('tool-agent-1')) {
        return fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'completes then is stopped on resume',
            prompt: 'Do the first pass.',
            agent_type: 'assistant',
            run_in_background: true,
            name: 'resume-stop',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(fauxText('ack'));
    });

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Spawn a child that completes then is stopped.', sink);
    const childRunId = latestProjection(sink.events)?.childRunIds[0]!;

    const completed = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(completed).toMatchObject({ agent_id: childRunId, status: 'completed', result: 'first result' });

    // Resume, then stop once the continuation is genuinely in-flight (its model
    // call entered) but before it appends any new assistant text.
    await runtime.childRunSend(conversation.conversationId, childRunId, 'Stop me now before any new output.');
    await waitFor(() => resumePickEntered);
    const stopped = await runtime.childRunStop(conversation.conversationId, childRunId);
    expect(stopped).toMatchObject({ agent_id: childRunId, status: 'cancelled' });

    // The seeded history (carrying the completed "first result") sits below the
    // salvage floor, so the stop salvages nothing — result must NOT regress to
    // the prior round's text. This is the stop-side mirror of the resume→fail case.
    const after = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    expect(after).toMatchObject({ agent_id: childRunId, status: 'cancelled' });
    expect((after as { result?: string }).result).toBeUndefined();

    releaseResume();
  });
});

describe('extractPartialAssistantText (stop-salvage primitive)', () => {
  // Lazy import: a static import would evaluate agentDelegation's transitive
  // electron dependency before this file's `mock.module('electron', …)` lands.
  const loadDelegation = () => import('../../src/main/agentDelegation');

  test('returns the last non-empty assistant text so a stopped run keeps its partial work', async () => {
    const { extractPartialAssistantText } = await loadDelegation();
    const messages = [
      fauxAssistantMessage(fauxText('first pass')),
      fauxAssistantMessage(fauxText('partial progress before the stop')),
    ] as Parameters<typeof extractPartialAssistantText>[0];
    expect(extractPartialAssistantText(messages)).toBe('partial progress before the stop');
  });

  test('returns undefined when there is no assistant text yet (a stop then reports no salvaged result)', async () => {
    const { extractPartialAssistantText } = await loadDelegation();
    const messages = [
      fauxAssistantMessage([fauxToolCall('Read', { path: 'x' }, { id: 't1' })], { stopReason: 'toolUse' }),
    ] as Parameters<typeof extractPartialAssistantText>[0];
    expect(extractPartialAssistantText(messages)).toBeUndefined();
  });
});
