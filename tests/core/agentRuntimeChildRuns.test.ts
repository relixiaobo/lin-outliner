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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { getAgentEventActivePath, type AgentEvent } from '../../src/core/agentEventLog';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

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

describe('agent runtime childRuns', () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('a fork sub-run (no agent_type) leaves its gated approval unattributed', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-fork-attribution-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-fork-attribution-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        // Parent forks its OWN context (no agent_type) — the fork runs AS the parent agent.
        fauxAssistantMessage([
          fauxToolCall('spawn', {
            description: 'fork to inspect config',
            objective: 'Inspect the local config.',
            verify: false,
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

  test('omitting agent_type creates a fork with parent context and placeholder tool results', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-data-'));
    roots.push(localRoot, dataRoot);

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('spawn', {
            description: 'fork check',
            objective: 'Inspect inherited context.',
            verify: false,
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

  test('the Agent tool forks Neva: the child run is owned by Neva (one-Neva invariant)', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-owner-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-owner-data-'));
    roots.push(localRoot, dataRoot);

    const streamFn = respondingStream((context) => {
      const text = textFromContext(context);
      if (text.includes('Do the fork work')) {
        return fauxAssistantMessage(fauxText('Fork result.'));
      }
      if (text.includes('Spawn a fork') && !text.includes('tool-agent-fork-owner')) {
        return fauxAssistantMessage([
          fauxToolCall('spawn', {
            description: 'fork owned by Neva',
            objective: 'Do the fork work.',
            verify: false,
            run_in_background: true,
            name: 'fork-owner',
          }, { id: 'tool-agent-fork-owner' }),
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
        providerConfigLoader: async () => ({ providerId: 'openai', enabled: true, apiKey: 'test-key' }),
        streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Spawn a fork for this.', sink);
    const childRunId = latestProjection(sink.events)?.childRunIds[0]!;
    expect(childRunId).toBeDefined();

    const data = await runtime.childRunStatus(conversation.conversationId, childRunId, { wait: true });
    // A fork runs AS Neva: it inherits the parent's executing + memory-owner identity, and its
    // recorded agent type is the fork pseudo-agent — never a second, separately-owned agent.
    expect(data).toMatchObject({
      memory_owner_agent_id: 'built-in:tenon:assistant',
      executing_agent_id: 'built-in:tenon:assistant',
      agent_type: 'fork',
    });
  });

  test('slims large child run tool outputs before the child continues', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-slim-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-run-slim-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('spawn', {
            description: 'large output',
            objective: 'Run a large-output tool call, then continue.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'compact sidechain',
            objective: 'Run large tool output, then continue after compaction.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'reactive compact',
            objective: 'Run until a context error, then recover.',
            verify: false,
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

  test('verifies a child run result and retries once on verifier failure', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-verifier-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-verifier-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const verifierContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('spawn', {
            description: 'verified child',
            objective: 'Produce a verified child result.',
            criteria: ['The final result must include the phrase verified result.'],
          }, { id: 'tool-agent-verified-child' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage([
          fauxToolCall('file_write', {
            file_path: path.join(localRoot, 'verified-child.txt'),
            content: 'first draft',
          }, { id: 'tool-file-write-verified-child' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('first incomplete result')),
        (context) => {
          verifierContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('{"verdict":"fail","gap":"missing required phrase"}'));
        },
        (context) => {
          childContexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('verified result'));
        },
        fauxAssistantMessage(fauxText('{"verdict":"pass","gap":""}')),
        fauxAssistantMessage(fauxText('Parent accepted verified child.')),
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
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Spawn verified child work.', sink);

    expect(script.pendingCount()).toBe(0);
    expect(childContexts.join('\n')).toContain('missing required phrase');
    expect(verifierContexts.join('\n')).toContain('File changes');
    expect(verifierContexts.join('\n')).toContain('verified-child.txt');
    expect(verifierContexts.join('\n')).toContain('Tool trace');
    const replay = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    const childRuns = Object.values(replay.childRuns);
    const worker = childRuns.find((run) => run.description === 'verified child');
    const verifier = childRuns.find((run) => run.purpose === 'verify');
    expect(worker?.objectiveStatus).toBe('verified');
    expect(worker?.result).toBe('verified result');
    expect(verifier?.contextMode).toBe('none');
  });

  test('/goal starts a detached child run with persisted objective and criteria', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-goal-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-goal-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Goal run result.')),
        fauxAssistantMessage(fauxText('{"verdict":"pass","gap":""}')),
        fauxAssistantMessage(fauxText('Parent consumed goal notification.')),
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
    await runtime.sendMessage(
      conversation.conversationId,
      '/goal Write the release note --criteria Mention the verified result; Mention any blockers',
    );
    await waitFor(() => script.pendingCount() === 0);

    const replay = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    const goalRun = Object.values(replay.childRuns).find((run) => run.objective === 'Write the release note');
    expect(goalRun).toMatchObject({
      description: 'Write the release note',
      contextMode: 'brief',
      objective: 'Write the release note',
      criteria: ['Mention the verified result', 'Mention any blockers'],
      objectiveStatus: 'verified',
      status: 'completed',
    });
  });

  test('tracks a background child run through run_status', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-background-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-background-data-'));
    roots.push(localRoot, dataRoot);

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('spawn', {
            description: 'background check',
            objective: 'Run in background.',
            verify: false,
            run_in_background: true,
            name: 'bg-check',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Background result.')),
        fauxAssistantMessage([
          fauxToolCall('run_status', {
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
          fauxToolCall('spawn', {
            description: 'background notify',
            objective: 'Run in background.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'background command',
            objective: 'Run in background.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'stoppable background',
            objective: 'Run until stopped.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'background restore',
            objective: 'Run in background.',
            verify: false,
            run_in_background: true,
            name: 'restored-bg',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Restored background result.')),
        fauxAssistantMessage([
          fauxToolCall('run_status', {
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
          fauxToolCall('run_status', {
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
          fauxToolCall('spawn', {
            description: 'interruptible background',
            objective: 'Run until the app dies.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'background seed',
            objective: 'Run in background.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'completes then fails on resume',
            objective: 'Do the first pass.',
            verify: false,
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
          fauxToolCall('spawn', {
            description: 'completes then is stopped on resume',
            objective: 'Do the first pass.',
            verify: false,
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

describe('agent runtime parallel tool results', () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('parallel tool results from one turn all stay on the active path', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-parallel-tools-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-parallel-tools-data-'));
    roots.push(localRoot, dataRoot);

    const names = ['a', 'b', 'c'];
    await Promise.all(names.map((name) => writeFile(path.join(localRoot, `${name}.md`), `content of ${name}`)));

    const script = scriptedStream(
      [
        // One assistant turn fans out three parallel file_read calls.
        fauxAssistantMessage(
          names.map((name) => fauxToolCall(
            'file_read',
            { file_path: path.join(localRoot, `${name}.md`) },
            { id: `tool-${name}` },
          )),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(fauxText('Read all three.')),
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
    await sendMessageApprovingAgent(runtime, conversation.conversationId, 'Read a, b and c.', sink);
    expect(script.pendingCount()).toBe(0);

    const replay = await new AgentEventStore(dataRoot).replay(conversation.conversationId);
    const activePath = getAgentEventActivePath(replay);
    const resultsOnPath = activePath.filter((message) => message.role === 'toolResult');

    // Every parallel result survives on the single-leaf active path. Before the fix
    // they parented to the assistant as siblings, so the linear path kept only one
    // and the rest rendered as resultless "Failed" rows.
    expect(resultsOnPath.map((message) => message.toolCallId).sort()).toEqual(['tool-a', 'tool-b', 'tool-c']);

    // The run is a linear spine: each result parents onto the run's tail (the
    // assistant for the first, then the previous result), never all onto the
    // assistant. So exactly one result chains directly off the assistant, and every
    // result's parent precedes it on the path.
    const assistant = activePath.find((message) => (
      message.role === 'assistant' && message.content.some((block) => block.type === 'toolCall')
    ));
    expect(assistant).toBeDefined();
    const orderById = activePath.map((message) => message.id);
    for (const result of resultsOnPath) {
      const parentIndex = orderById.indexOf(result.parentMessageId ?? '');
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(orderById.indexOf(result.id));
    }
    expect(resultsOnPath.filter((result) => result.parentMessageId === assistant!.id)).toHaveLength(1);
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
