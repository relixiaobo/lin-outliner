import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { replayAgentEvents } from '../../src/core/agentEventLog';
import type { AgentRenderProjection } from '../../src/core/agentRenderProjection';
import { AgentEventStore } from '../../src/main/agentEventStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-stop-test-user-data');

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

function latestProjection(events: AgentRuntimeEvent[]): AgentRenderProjection {
  const projection = [...events].reverse().find((event) => event.type === 'projection')?.renderProjection;
  if (!projection) throw new Error('No projection emitted.');
  return projection;
}

function persistedText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => (
      Boolean(part)
      && typeof part === 'object'
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
}

describe('agent runtime stop', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('settles a silent main stream and records an aborted assistant turn', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-stop-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-stop-data-'));
    roots.push(localRoot, dataRoot);

    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const streamFn = ((_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      receivedSignal = options?.signal;
      resolveStreamStarted?.();
      return createAssistantMessageEventStream();
    }) as StreamFn;

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

    const created = await runtime.restoreLatestConversation();
    const send = runtime.sendMessage(created.conversationId, 'Start and wait.');
    await streamStarted;

    runtime.stopConversation(created.conversationId);
    await send;

    const projection = latestProjection(sink.events);
    const lastRow = projection.rows.at(-1);
    if (!lastRow) throw new Error('No message row emitted.');
    const message = projection.entities.messages[lastRow.messageId];

    expect(receivedSignal?.aborted).toBe(true);
    expect(projection.activeRunId).toBe(null);
    expect(projection.runActive).toBe(false);
    expect(projection.errorMessage).toBe(null);
    expect(message.role).toBe('assistant');
    expect(message.status).toBe('completed');
    expect(message.stopReason).toBe('aborted');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('records a provider run failure as an inline failed assistant message', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-fail-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-fail-data-'));
    roots.push(localRoot, dataRoot);

    const partialText = 'Partial output before the provider stream terminated.';
    const errorText = 'terminated';
    const streamFn = ((model: Model<Api>) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        ...fauxAssistantMessage(fauxText(partialText), { stopReason: 'error', errorMessage: errorText }),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      queueMicrotask(() => {
        stream.push({ type: 'error', reason: 'error', error: message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Trigger a provider error.');

    const projection = latestProjection(sink.events);
    const lastRow = projection.rows.at(-1);
    if (!lastRow) throw new Error('No message row emitted.');
    const message = projection.entities.messages[lastRow.messageId];

    expect(message.role).toBe('assistant');
    expect(message.status).toBe('failed');
    expect(message.stopReason).toBe('error');
    expect(persistedText(message.content)).toBe(partialText);
    // The error rides on the assistant message so it renders inline as a failed
    // turn (with retry), not as a separate top banner.
    expect(message.errorMessage).toBe(errorText);
    expect(projection.errorMessage).toBe(null);
    // A normal provider run failure is not a transient operational error event.
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    const completed = events.find((event) => event.type === 'assistant_message.completed');
    const failed = events.find((event) => event.type === 'assistant_message.failed');
    const runFailed = events.find((event) => event.type === 'run.failed');
    expect(completed).toMatchObject({
      type: 'assistant_message.completed',
      messageId: message.id,
      stopReason: 'error',
      content: [{ type: 'text', text: partialText }],
    });
    expect(failed).toMatchObject({
      type: 'assistant_message.failed',
      messageId: message.id,
      errorMessage: errorText,
    });
    expect(runFailed).toMatchObject({
      type: 'run.failed',
      errorMessage: errorText,
    });

    const replayed = replayAgentEvents(events);
    expect(replayed.messages[message.id]?.status).toBe('failed');
    expect(persistedText(replayed.messages[message.id]?.content)).toBe(partialText);
  });

  test('emits runtime-only retry status around a recovered provider request', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-retry-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-retry-data-'));
    roots.push(localRoot, dataRoot);

    let attempts = 0;
    const streamFn = ((model: Model<Api>) => {
      attempts += 1;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        ...fauxAssistantMessage(
          attempts === 1 ? [] : fauxText('Recovered response.'),
          attempts === 1
            ? { stopReason: 'error', errorMessage: 'OpenAI API error (524): upstream timeout' }
            : { stopReason: 'stop' },
        ),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      queueMicrotask(() => {
        if (attempts === 1) {
          stream.push({ type: 'error', reason: 'error', error: message });
        } else {
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Recovered response.', partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: 'Recovered response.', partial: message });
          stream.push({ type: 'done', reason: 'stop', message });
        }
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

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
          modelId: 'gpt-5.4',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Recover this request.');

    const retryEvents = sink.events.filter((event): event is Extract<AgentRuntimeEvent, { type: 'provider_retry' }> => (
      event.type === 'provider_retry'
    ));
    expect(attempts).toBe(2);
    expect(retryEvents.map(({ phase, kind, attempt, maxRetries }) => ({ phase, kind, attempt, maxRetries }))).toEqual([
      { phase: 'retrying', kind: 'request', attempt: 1, maxRetries: 4 },
      { phase: 'cleared', kind: 'request', attempt: 1, maxRetries: 4 },
    ]);
    expect(retryEvents[0]?.conversationId).toBe(created.conversationId);
    expect(retryEvents[0]?.runId).toBeTruthy();
    expect(retryEvents[1]?.runId).toBe(retryEvents[0]?.runId);

    const projection = latestProjection(sink.events);
    const lastRow = projection.rows.at(-1);
    if (!lastRow) throw new Error('No response row emitted.');
    expect(persistedText(projection.entities.messages[lastRow.messageId]?.content)).toBe('Recovered response.');

    const persisted = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(persisted.some((event) => (event as { type: string }).type === 'provider_retry')).toBe(false);
  });
});
