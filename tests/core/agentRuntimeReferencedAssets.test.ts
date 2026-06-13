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
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { plainText, type AssetMetadata, type DocumentProjection, type NodeProjection } from '../../src/core/types';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-referenced-assets-test-user-data');

mock.module('electron', () => ({
  app: { getPath: () => electronUserDataRoot },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
  },
}));

type RuntimeModule = typeof import('../../src/main/agentRuntime');
let runtimeModulePromise: Promise<RuntimeModule> | null = null;
async function loadRuntimeModule() {
  runtimeModulePromise ??= import('../../src/main/agentRuntime');
  return runtimeModulePromise;
}

function node(partial: Partial<NodeProjection> & { id: string }): NodeProjection {
  return {
    content: plainText(''),
    children: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...partial,
  } as NodeProjection;
}

function hostWithNodes(extra: NodeProjection[]): OutlinerToolHost {
  const base = Core.new().projection();
  const projection: DocumentProjection = { ...base, nodes: [...base.nodes, ...extra] };
  return {
    getProjection: () => projection,
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

function userContentParts(context: Context): Array<{ type?: string; text?: string; mimeType?: string }> {
  return context.messages
    .filter((message) => (message as { role?: string }).role === 'user')
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? (content as Array<{ type?: string; text?: string; mimeType?: string }>) : [];
    });
}

function textFromContext(context: Context): string {
  return userContentParts(context)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

function defaultRuntimeOptions(localRoot: string, dataRoot: string, assetResolver: unknown, contexts: Context[]) {
  return {
    agentDataRoot: dataRoot,
    localFileRoot: localRoot,
    assetResolver: assetResolver as never,
    providerConfigLoader: async () => ({
      providerId: 'openai',
      modelId: 'gpt-4.1',
      reasoningLevel: 'low' as const,
      enabled: true,
      apiKey: 'test-key',
    }),
    runtimeSettingsLoader: async () => ({
      permissionMode: 'trusted' as const,
      automaticSkillsEnabled: false,
      slashSkillsEnabled: false,
      compactEnabled: true,
      additionalSkillDirectories: [],
      additionalAgentDirectories: [],
    }),
    streamFn: captureStream(contexts),
  };
}

describe('agent runtime referenced asset materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('materializes a referenced image node — inlines it for vision and records its scratch path', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-ref-asset-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-ref-asset-data-'));
    const assetRoot = await mkdtemp(path.join(tmpdir(), 'lin-ref-asset-store-'));
    roots.push(localRoot, dataRoot, assetRoot);

    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const imagePath = path.join(assetRoot, 'asset-img.png');
    await writeFile(imagePath, imageBytes);
    const pdfPath = path.join(assetRoot, 'asset-doc.pdf');
    await writeFile(pdfPath, '%PDF-1.4 body');

    const meta: Record<string, AssetMetadata> = {
      'asset-img': { id: 'asset-img', mimeType: 'image/png', byteSize: imageBytes.length, createdAt: 0, originalFilename: 'diagram.png' },
      'asset-doc': { id: 'asset-doc', mimeType: 'application/pdf', byteSize: 13, createdAt: 0, originalFilename: 'report.pdf' },
    };
    const assetResolver = {
      pathFor: async (id: string) => (id === 'asset-img' ? imagePath : id === 'asset-doc' ? pdfPath : null),
      lookup: async (id: string) => meta[id] ?? null,
    };

    const contexts: Context[] = [];
    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostWithNodes([
        node({ id: 'img', type: 'image', assetId: 'asset-img', content: plainText('Diagram') }),
        node({ id: 'pdf', type: 'attachment', assetId: 'asset-doc', mimeType: 'application/pdf', content: plainText('Report') }),
      ]),
      defaultRuntimeOptions(localRoot, dataRoot, assetResolver, contexts),
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(
      created.conversationId,
      'Look at these.',
      [],
      { referencedNodes: [{ nodeId: 'img', title: 'Diagram' }, { nodeId: 'pdf', title: 'Report' }] },
    );

    expect(contexts).toHaveLength(1);
    const parts = userContentParts(contexts[0]!);
    const imageParts = parts.filter((part) => part.type === 'image');
    // The referenced image is inlined as a vision block; the PDF is not.
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].mimeType).toBe('image/png');

    const text = textFromContext(contexts[0]!);
    expect(text).toContain('<referenced-files>');
    expect(text).toContain('use file_read');
    expect(text).toContain('node_id="img"');
    expect(text).toContain('inline_image="true"');
    expect(text).toContain('node_id="pdf"');
    expect(text).toContain('mime="application/pdf"');

    // Both assets are copied into the scratch attachment dir (a sibling of the workdir),
    // never into the agent's file area itself.
    const scratchDir = path.join(localRoot, 'tmp', 'agent-attachments');
    const copied = await readdir(scratchDir);
    expect(copied).toHaveLength(2);
    expect(text).toContain(scratchDir);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('referencing a plain text node copies nothing and adds no referenced-files reminder', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-ref-asset-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-ref-asset-data-'));
    roots.push(localRoot, dataRoot);

    let pathForCalls = 0;
    const assetResolver = {
      pathFor: async () => {
        pathForCalls += 1;
        return null;
      },
      lookup: async () => null,
    };

    const contexts: Context[] = [];
    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostWithNodes([node({ id: 'note', content: plainText('Just a note') })]),
      defaultRuntimeOptions(localRoot, dataRoot, assetResolver, contexts),
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(
      created.conversationId,
      'Consider this note.',
      [],
      { referencedNodes: [{ nodeId: 'note', title: 'Just a note' }] },
    );

    expect(contexts).toHaveLength(1);
    expect(pathForCalls).toBe(0);
    const text = textFromContext(contexts[0]!);
    expect(text).not.toContain('<referenced-files>');
    expect(userContentParts(contexts[0]!).some((part) => part.type === 'image')).toBe(false);
    await expect(readdir(path.join(localRoot, 'tmp', 'agent-attachments'))).rejects.toThrow();
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });
});
