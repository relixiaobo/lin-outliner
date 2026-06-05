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
  type StopReason,
  type Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { formatFileReferenceMarker, splitFileReferenceMarkers } from '../../src/core/referenceMarkup';
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

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-attachments-test-user-data');

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

function captureStream(contexts: Context[]): StreamFn {
  return ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('ok')), model);
      stream.push({ type: 'start', partial: { ...message, content: [] } });
      stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
      stream.end(message);
    });
    options?.signal?.throwIfAborted();
    return stream;
  }) as StreamFn;
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
  return context.messages
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
          return [String((part as { text?: unknown }).text ?? '')];
        }
        return [];
      });
    })
    .join('\n');
}

describe('agent runtime attachments', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('materializes out-of-root attachment paths and rewrites user message markers without hidden attachment JSON', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-data-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-source-'));
    roots.push(localRoot, dataRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'report.txt');
    await writeFile(sourcePath, 'runtime report body');
    const contexts: Context[] = [];

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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: false,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: captureStream(contexts),
      },
    );

    const created = await runtime.createSession();
    await runtime.sendMessage(
      created.sessionId,
      `Read ${formatFileReferenceMarker('report.txt', sourcePath)}.`,
      [{
        id: 'attachment-report',
        kind: 'file',
        name: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 19,
        path: sourcePath,
      }],
    );

    const contextText = textFromContext(contexts[0]!);
    const marker = splitFileReferenceMarkers(contextText).find((segment) => segment.type === 'file');

    expect(contexts).toHaveLength(1);
    expect(contextText).not.toContain('<user-attachments>');
    expect(contextText).not.toContain(encodeURIComponent(sourcePath));
    expect(marker?.path).toStartWith(path.join(localRoot, 'tmp', 'agent-attachments'));
    expect(await readFile(marker!.path, 'utf8')).toBe('runtime report body');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('does not materialize arbitrary file markers without a matching attachment payload', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-data-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-source-'));
    roots.push(localRoot, dataRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'secret.txt');
    await writeFile(sourcePath, 'secret body');
    const contexts: Context[] = [];

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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: false,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: captureStream(contexts),
      },
    );

    const created = await runtime.createSession();
    await runtime.sendMessage(
      created.sessionId,
      `Read ${formatFileReferenceMarker('secret.txt', sourcePath)}.`,
      [],
    );

    const contextText = textFromContext(contexts[0]!);
    const marker = splitFileReferenceMarkers(contextText).find((segment) => segment.type === 'file');

    expect(contexts).toHaveLength(1);
    expect(contextText).toContain(encodeURIComponent(sourcePath));
    expect(marker?.path).toBe(sourcePath);
    await expect(readdir(path.join(localRoot, 'tmp', 'agent-attachments'))).rejects.toThrow();
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('keeps out-of-root directory attachments as live paths for folder tools', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-data-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-attachment-source-'));
    roots.push(localRoot, dataRoot, sourceRoot);
    const contexts: Context[] = [];

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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: false,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: captureStream(contexts),
      },
    );

    const created = await runtime.createSession();
    await runtime.sendMessage(
      created.sessionId,
      `List ${formatFileReferenceMarker('Projects', sourceRoot, 'directory')}.`,
      [{
        id: 'attachment-projects',
        kind: 'file',
        name: 'Projects',
        mimeType: 'inode/directory',
        sizeBytes: 0,
        path: sourceRoot,
      }],
    );

    const contextText = textFromContext(contexts[0]!);
    const marker = splitFileReferenceMarkers(contextText).find((segment) => segment.type === 'file');

    expect(contexts).toHaveLength(1);
    expect(contextText).toContain(encodeURIComponent(sourceRoot));
    expect(marker?.path).toBe(sourceRoot);
    expect(marker?.entryKind).toBe('directory');
    await expect(readdir(path.join(localRoot, 'tmp', 'agent-attachments'))).rejects.toThrow();
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });
});
