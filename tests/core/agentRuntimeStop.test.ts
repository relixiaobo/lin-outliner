import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
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
import type { AgentRenderProjection } from '../../src/core/agentRenderProjection';
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

    const errorText = "OpenAI API error (400): Invalid schema for function 'node_search'.";
    const streamFn = ((model: Model<Api>) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        ...fauxAssistantMessage([], { stopReason: 'error', errorMessage: errorText }),
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
    expect(message.stopReason).toBe('error');
    // The error rides on the assistant message so it renders inline as a failed
    // turn (with retry), not as a separate top banner.
    expect(message.errorMessage).toBe(errorText);
    expect(projection.errorMessage).toBe(null);
    // A normal provider run failure is not a transient operational error event.
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });
});
