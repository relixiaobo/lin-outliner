import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createProvider,
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
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { getAgentEventActivePath } from '../../src/core/agentEventLog';
import type { AgentRenderProjection } from '../../src/core/agentRenderProjection';
import { AgentEventStore } from '../../src/main/agentEventStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';
import {
  createOpenAICompatibleModel,
  ensurePiCustomProvider,
  piCustomProviderId,
  piModels,
} from '../../src/main/piModels';

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

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-test-user-data');

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

async function createSkill(root: string, name: string, body: string) {
  const skillDir = path.join(root, '.agents', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), body);
  return skillDir;
}

async function acceptRuntimeSkill(
  runtime: {
    listAllSkills(conversationId: string): Promise<Array<{ name: string; contentHash?: string }>>;
    acceptSkill(conversationId: string, skillName: string, expectedHash: string): Promise<unknown>;
  },
  conversationId: string,
  skillName: string,
) {
  const skill = (await runtime.listAllSkills(conversationId)).find((candidate) => candidate.name === skillName);
  if (!skill?.contentHash) throw new Error(`Missing test skill hash for ${skillName}`);
  await runtime.acceptSkill(conversationId, skillName, skill.contentHash);
}

function textFromContent(content: unknown): string {
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

const hasPdfTextTools = commandExists('pdfinfo') && commandExists('pdftotext');
const pdfTextTest = hasPdfTextTools ? test : test.skip;

function commandExists(command: string): boolean {
  return !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
}

function makePdf(pageTexts: string[]): string {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, index) => 3 + index);
  const contentIds = pageTexts.map((_, index) => 3 + pageTexts.length + index);
  const fontId = 3 + pageTexts.length * 2;
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  pageTexts.forEach((text, index) => {
    objects[pageIds[index]! - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`;
  });
  pageTexts.forEach((text, index) => {
    const stream = `BT /F1 24 Tf 100 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects[contentIds[index]! - 1] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

function projectionTexts(projection: AgentRenderProjection) {
  return projection.rows.map((row) => textFromContent(projection.entities.messages[row.messageId]?.content));
}

function latestProjectedCompaction(events: AgentRuntimeEvent[]) {
  for (const event of [...events].reverse()) {
    if (event.type !== 'projection') continue;
    for (const row of event.renderProjection.rows) {
      if (row.kind !== 'compaction') continue;
      return event.renderProjection.entities.compactions[row.compactionId] ?? null;
    }
  }
  return null;
}

function latestActiveProjectedCompaction(events: AgentRuntimeEvent[]) {
  for (const event of [...events].reverse()) {
    if (event.type === 'projection') return event.renderProjection.activeCompaction;
  }
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function scriptedStream(
  responses: Array<AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage)>,
  onCall: (model: Model<Api>, context: Context) => void,
): { streamFn: StreamFn; pendingCount: () => number } {
  const queue = [...responses];
  return {
    pendingCount: () => queue.length,
    streamFn: ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      onCall(model, context);
      const stream = createAssistantMessageEventStream();
      const step = queue.shift();
      queueMicrotask(() => {
        const response = step
          ? typeof step === 'function'
            ? step(context, options, model)
            : step
          : fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'No more scripted responses queued.' });
        const message = normalizeAssistantMessage(response, model);
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: message.stopReason, error: message });
          stream.end(message);
          return;
        }
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn,
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

describe('agent runtime skill integration', () => {
  let roots: string[] = [];

  beforeEach(async () => {
    await rm(electronUserDataRoot, { recursive: true, force: true });
    roots = [electronUserDataRoot];
  });

  afterEach(async () => {
    piModels().deleteProvider(piCustomProviderId('openai'));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('leaves ambient provider auth for pi to apply at request time', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-ambient-auth-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-ambient-auth-data-'));
    roots.push(localRoot, dataRoot);

    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-key';

    try {
      const providerOptions: SimpleStreamOptions[] = [];
      const compactOptions: SimpleStreamOptions[] = [];
      const script = scriptedStream(
        [
          (_context, options, _model) => {
            providerOptions.push(options ?? {});
            return fauxAssistantMessage(fauxText('Ambient auth preserved.'));
          },
        ],
        () => undefined,
      );

      const { AgentRuntime: Runtime } = await loadRuntimeModule();
      const sink = createWindowSink();
      const runtime = new Runtime(
        () => sink.window as never,
        hostFor(Core.new()),
        {
          agentDataRoot: dataRoot,
          localFileRoot: localRoot,
          providerConfigLoader: async () => ({
            providerId: 'openai',
            enabled: true,
          }),
          runtimeSettingsLoader: async () => ({
            permissionMode: 'trusted',
            automaticSkillsEnabled: true,
            slashSkillsEnabled: true,
            compactEnabled: true,
            additionalSkillDirectories: [],
          }),
          streamFn: script.streamFn,
          completeSimpleFn: async (model, _context, options) => {
            compactOptions.push(options ?? {});
            return normalizeAssistantMessage(
              fauxAssistantMessage('<analysis>ambient auth</analysis><summary>Ambient auth stayed ambient.</summary>'),
              model as Model<Api>,
            );
          },
        },
      );

      const created = await runtime.restoreLatestConversation();
      await runtime.sendMessage(created.conversationId, 'Check ambient auth.');
      await runtime.sendMessage(created.conversationId, '/compact');

      expect(sink.events.some((event) => event.type === 'error')).toBe(false);
      expect(providerOptions[0]?.apiKey).toBeUndefined();
      expect(compactOptions[0]?.apiKey).toBeUndefined();
    } finally {
      if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAIKey;
    }
  });

  test('routes custom OpenAI-compatible catalog models through pi custom provider while preserving their API', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-custom-provider-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-custom-provider-data-'));
    roots.push(localRoot, dataRoot);

    const modelId = 'gpt-5.5';
    const catalogModel = piModels().getModel('openai', modelId);
    expect(catalogModel).toBeDefined();
    expect(catalogModel?.api).toBe('openai-responses');
    const { setBuiltInAgentProfile } = await import('../../src/main/agentSettings');
    await setBuiltInAgentProfile('built-in:tenon:assistant', { model: modelId });
    const seenModels: Model<Api>[] = [];
    const streamFn: StreamFn = ((model: Model<Api>) => {
      seenModels.push(model);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Custom endpoint routed.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          baseUrl: 'https://proxy.example.com/v1',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Use the configured custom endpoint.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(seenModels).toHaveLength(1);
    expect(seenModels[0]?.provider).toBe(piCustomProviderId('openai'));
    expect(seenModels[0]?.api).toBe('openai-responses');
    expect(seenModels[0]?.baseUrl).toBe('https://proxy.example.com/v1');
    expect(seenModels[0]?.contextWindow).toBe(catalogModel?.contextWindow);
    expect(seenModels[0]?.maxTokens).toBe(catalogModel?.maxTokens);
    expect(seenModels[0]?.reasoning).toBe(catalogModel?.reasoning);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    const started = events.find((event) => event.type === 'assistant_message.started');
    expect(started).toMatchObject({
      type: 'assistant_message.started',
      providerId: 'openai',
      modelId,
      apiId: 'openai-responses',
    });
  });

  test('passes runtime provider stream settings to agent and compact requests', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-provider-options-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-provider-options-data-'));
    roots.push(localRoot, dataRoot);

    const providerOptions: SimpleStreamOptions[] = [];
    const compactOptions: SimpleStreamOptions[] = [];
    const script = scriptedStream(
      [
        (_context, options, _model) => {
          providerOptions.push(options ?? {});
          return fauxAssistantMessage(fauxText('Provider options received.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
          providerTimeoutMs: 12_345,
          providerMaxRetries: 1,
          providerMaxRetryDelayMs: 2_345,
          providerCacheRetention: 'long',
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, _context, options) => {
          compactOptions.push(options ?? {});
          return normalizeAssistantMessage(
            fauxAssistantMessage('<analysis>compact options</analysis><summary>Provider stream options survived compact.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Check provider stream settings.');
    await runtime.sendMessage(created.conversationId, '/compact');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(providerOptions[0]).toMatchObject({
      timeoutMs: 12_345,
      maxRetries: 1,
      maxRetryDelayMs: 2_345,
      cacheRetention: 'long',
    });
    expect(compactOptions[0]).toMatchObject({
      timeoutMs: 12_345,
      maxRetries: 1,
      maxRetryDelayMs: 2_345,
      cacheRetention: 'long',
    });
  });

  test('keeps cache affinity and applies the Responses compatibility profile for custom endpoints', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-custom-cache-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-custom-cache-data-'));
    roots.push(localRoot, dataRoot);

    const providerOptions: SimpleStreamOptions[] = [];
    const compactOptions: SimpleStreamOptions[] = [];
    const payloads: unknown[] = [];
    const payloadWrites: Promise<void>[] = [];
    const catalogModel = piModels().getModel('openai', 'gpt-5.5') as Model<Api>;
    const customModel = createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      baseUrl: 'https://proxy.example.com/v1',
      catalogModel,
    });
    const script = scriptedStream(
      [
        (_context, options) => {
          providerOptions.push(options ?? {});
          payloadWrites.push(Promise.resolve(options?.onPayload?.({
            input: [
              { role: 'developer', content: 'Runtime system prompt.' },
              { role: 'user', content: [{ type: 'input_text', text: 'Ping' }] },
            ],
            tools: [{ type: 'function', name: 'runtime_probe' }],
          }, customModel)).then((payload) => {
            payloads.push(payload ?? null);
          }));
          return fauxAssistantMessage(fauxText('Custom provider options received.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
          baseUrl: 'https://proxy.example.com/v1',
        }),
        providerModelResolver: () => customModel,
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
          providerTimeoutMs: null,
          providerMaxRetries: null,
          providerMaxRetryDelayMs: 60_000,
          providerCacheRetention: 'short',
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, _context, options) => {
          compactOptions.push(options ?? {});
          payloads.push(await options?.onPayload?.({
            input: [
              { role: 'developer', content: 'Compact system prompt.' },
              { role: 'user', content: [{ type: 'input_text', text: 'Summarize' }] },
            ],
            tools: [],
          }, model as Model<Api>) ?? null);
          return normalizeAssistantMessage(
            fauxAssistantMessage('<analysis>custom compact</analysis><summary>Custom compact summary.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Check custom provider cache settings.');
    await runtime.sendMessage(created.conversationId, '/compact');
    await Promise.all(payloadWrites);

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(providerOptions[0]).toMatchObject({ cacheRetention: 'short' });
    expect(compactOptions[0]).toMatchObject({ cacheRetention: 'short' });
    expect(payloads).toEqual([
      {
        instructions: 'Runtime system prompt.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Ping' }] },
        ],
        text: { verbosity: 'low' },
        tool_choice: 'auto',
        parallel_tool_calls: true,
        tools: [{ type: 'function', name: 'runtime_probe' }],
      },
      {
        instructions: 'Compact system prompt.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Summarize' }] },
        ],
        text: { verbosity: 'low' },
        tools: [],
      },
    ]);
  });

  test('uses Codex-style auto-compact accounting from provider usage', async () => {
    const { agentMessagesAutoCompactTokens, autoCompactThreshold } = await import('../../src/main/agentRuntimeContext');

    expect(autoCompactThreshold({
      api: 'openai-responses',
      baseUrl: 'https://proxy.example.com/v1',
      contextWindow: 272000,
      maxTokens: 128000,
    } as never)).toBe(244800);

    expect(autoCompactThreshold({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      contextWindow: 272000,
      maxTokens: 128000,
    } as never)).toBe(244800);

    const observed = normalizeAssistantMessage({
      ...fauxAssistantMessage(fauxText('Observed usage.')),
      usage: { ...EMPTY_USAGE, totalTokens: 42_000 },
    }, {
      api: 'openai-responses',
      provider: 'openai',
      id: 'gpt-5.5',
      name: 'gpt-5.5',
      baseUrl: 'https://proxy.example.com/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(agentMessagesAutoCompactTokens([
      { role: 'user', content: [{ type: 'text', text: 'start' }], timestamp: 1 },
      observed,
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4_000) }], timestamp: 2 },
    ])).toBeGreaterThan(42_000);
  });

  test('exposes each user request as its own turn run in the debug view (compaction is not a run)', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-debug-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-debug-data-'));
    roots.push(localRoot, dataRoot);

    const streamFn = (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      await options?.onPayload?.({ kind: 'normal', messages: context.messages }, model);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Normal response.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const runtime = new Runtime(
      () => createWindowSink().window as never,
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
        completeSimpleFn: async (model, context, options) => {
          await options?.onPayload?.({ kind: 'compact', messages: context.messages }, model as Model<Api>);
          return normalizeAssistantMessage(
            fauxAssistantMessage('<analysis>manual compact</analysis><summary>Manual compact summary.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'First request before manual compact.');
    await runtime.sendMessage(created.conversationId, '/compact');
    await runtime.sendMessage(created.conversationId, 'Second request after manual compact.');

    // Run-grounded debug view ([[agent-debug-run-grounded]]): each user request is
    // its own turn run; the manual /compact is a summary call, not a run, so it
    // never appears as a turn in the tree.
    const view = await runtime.agentDebugView(created.conversationId);
    const turnRuns = view.runs.filter((run) => run.kind === 'turn');
    expect(turnRuns.length).toBe(2);
    expect(view.totals.rounds).toBeGreaterThanOrEqual(2);
    // Shape comes from the conversation's member ROSTER, not distinct run
    // executors: a single-agent DM is 'dm' with one member ([[agent-debug-run-grounded]]).
    expect(view.shape).toBe('dm');
    expect(view.members).toHaveLength(1);

    // The triggering user message lives in the CONVERSATION stream (no runId), not
    // the run's own ledger — so the detail must splice it into round 0's request
    // window. Exercised end-to-end through the real store split (NOT hand-stamped).
    const firstTurn = turnRuns[0]!;
    const detail = await runtime.agentDebugRun(created.conversationId, firstTurn.runId);
    expect(detail).not.toBeNull();
    const firstWindow = detail!.rounds[0]!.requestWindow;
    expect(firstWindow.some((row) => row.role === 'user')).toBe(true);
    expect(firstWindow.map((row) => row.parts.map((part) => part.body).join(' ')).join(' '))
      .toContain('First request before manual compact.');
  });

  test('clears automatic model context without compacting visible transcript history', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-clear-context-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-clear-context-data-'));
    roots.push(localRoot, dataRoot);

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('First answer before clear.')),
        fauxAssistantMessage(fauxText('Second answer after clear.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>unexpected compact</analysis><summary>Unexpected compact.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'First request before clear.');
    await runtime.sendMessage(created.conversationId, '/clear');
    await runtime.sendMessage(created.conversationId, 'Second request after clear.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextTexts).toHaveLength(2);
    expect(contextTexts[0]).toContain('First request before clear.');
    expect(contextTexts[1]).toContain('Context cleared.');
    expect(contextTexts[1]).toContain('Second request after clear.');
    expect(contextTexts[1]).not.toContain('First request before clear.');
    expect(contextTexts[1]).not.toContain('First answer before clear.');

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => event.type === 'context.cleared')).toBe(true);
    expect(events.some((event) => event.type === 'compaction.completed')).toBe(false);

    const restored = await runtime.restoreConversation(created.conversationId);
    const activeText = projectionTexts(restored.renderProjection).join('\n');
    const transcriptText = restored.renderProjection.transcriptRows
      .map((row) => textFromContent(restored.renderProjection.entities.messages[row.messageId]?.content))
      .join('\n');
    const clearRow = restored.renderProjection.rows.find((row) => row.kind === 'context-clear');
    expect(clearRow?.kind).toBe('context-clear');
    expect(activeText).toContain('Context cleared.');
    expect(activeText).toContain('Second request after clear.');
    expect(activeText).not.toContain('First request before clear.');
    expect(transcriptText).toContain('First request before clear.');
    expect(transcriptText).toContain('First answer before clear.');
  });

  test('a regenerated turn run still splices its triggering user message into round 0', async () => {
    // Regression guard for the trigger-splice edge: regenerate re-runs the turn
    // under a NEW run id whose `run.started.trigger` resolves (via the
    // branch.selected leaf) to the original user message — which lives in the
    // conversation stream, never the new run's ledger. The detail must still
    // splice it into round 0, exactly like a fresh turn.
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-regen-debug-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-regen-debug-data-'));
    roots.push(localRoot, dataRoot);

    const streamFn = (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      await options?.onPayload?.({ kind: 'normal', messages: context.messages }, model);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Normal response.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const runtime = new Runtime(
      () => createWindowSink().window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({ providerId: 'openai', enabled: true, apiKey: 'test-key' }),
        streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Only request, then regenerated.');

    const firstTurn = (await runtime.agentDebugView(created.conversationId)).runs.find((run) => run.kind === 'turn')!;
    const firstDetail = await runtime.agentDebugRun(created.conversationId, firstTurn.runId);
    const assistantMessageId = firstDetail!.rounds[0]!.messageId;

    await runtime.regenerateMessage(created.conversationId, assistantMessageId);

    // A second turn run now exists; its round 0 must still carry the user message.
    const turnRuns = (await runtime.agentDebugView(created.conversationId)).runs.filter((run) => run.kind === 'turn');
    expect(turnRuns.length).toBe(2);
    const regenerated = turnRuns[turnRuns.length - 1]!;
    expect(regenerated.runId).not.toBe(firstTurn.runId);
    const regenDetail = await runtime.agentDebugRun(created.conversationId, regenerated.runId);
    const regenWindow = regenDetail!.rounds[0]!.requestWindow;
    expect(regenWindow.some((row) => row.role === 'user')).toBe(true);
    expect(regenWindow.map((row) => row.parts.map((part) => part.body).join(' ')).join(' '))
      .toContain('Only request, then regenerated.');
  });

  test('runs automatic skill loading through a real pi agent conversation and keeps compact replay short', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skills-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-data-'));
    roots.push(localRoot, dataRoot);

    const skillDir = await createSkill(localRoot, 'auto-skill', [
      '---',
      'description: Use when the user asks for an automatic skill integration check.',
      'allowed-tools: Bash(git status:*), file_read',
      'model: gpt-5.2',
      'effort: high',
      '---',
      'AUTO_SKILL_BODY: follow this loaded skill instruction exactly.',
      '',
      'ARGUMENTS: $ARGUMENTS',
    ].join('\n'));

    const callModels: string[] = [];
    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', { skill: 'auto-skill', args: 'runtime-check' }, { id: 'tool-skill-1' }),
        ], { stopReason: 'toolUse' }),
        (context, _options, _model) => {
          return fauxAssistantMessage(fauxText('Skill instruction applied.'));
        },
      ],
      (model, context) => {
        callModels.push(model.id);
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        // The provider connection owns no model now; the built-in assistant's
        // default model is the connection's resolved model. Pin it for a stable
        // assertion (the real catalog's ranked-first model drifts as pi-ai updates).
        providerModelResolver: () => ({
          id: 'gpt-4.1',
          name: 'gpt-4.1',
          provider: 'openai',
          api: 'openai-completions',
          baseUrl: '',
          reasoning: false,
          input: ['text'],
          contextWindow: 1_000_000,
          maxTokens: 32_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, context) => {
          callModels.push(model.id);
          contextTexts.push(JSON.stringify(context.messages));
          return normalizeAssistantMessage(
            fauxAssistantMessage('<analysis>compress</analysis><summary>Kept the skill outcome.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'auto-skill');
    await runtime.sendMessage(created.conversationId, 'Please do the automatic skill integration check.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(script.pendingCount()).toBe(0);
    // First turn runs on the pinned connection model; the skill's `model: gpt-5.2`
    // frontmatter override resolves through the REAL pi-ai catalog (there is no
    // injected catalog-by-id seam), so `gpt-5.2` must remain a live catalog id — this
    // assertion tracks catalog drift, like the base-model note on the resolver above.
    expect(callModels).toEqual(['gpt-4.1', 'gpt-5.2']);
    expect(contextTexts.join('\n')).toContain('AUTO_SKILL_BODY');
    expect(contextTexts.join('\n')).toContain(`Base directory for this skill: ${skillDir}`);

    const beforeCompact = await runtime.restoreConversation(created.conversationId);
    const textsBeforeCompact = projectionTexts(beforeCompact.renderProjection).join('\n');
    expect(textsBeforeCompact).toContain('The following skills are available for use with the skill tool');
    expect(textsBeforeCompact).toContain('Launching skill: auto-skill');
    expect(textsBeforeCompact).toContain('Skill instruction applied.');

    await runtime.sendMessage(created.conversationId, '/compact keep the skill context');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    const compactionEvent = (await new AgentEventStore(dataRoot).readEvents(created.conversationId))
      .find((event) => event.type === 'compaction.completed');
    expect(compactionEvent?.summary).toBe('Kept the skill outcome.');

    const restored = await runtime.restoreConversation(created.conversationId);
    expect(restored.renderProjection.rows).toHaveLength(1);
    expect(restored.renderProjection.transcriptRows.length).toBeGreaterThan(restored.renderProjection.rows.length);
    const [rootRow] = restored.renderProjection.rows;
    const compactEntity = rootRow?.kind === 'compaction'
      ? restored.renderProjection.entities.compactions[rootRow.compactionId]
      : null;
    expect(compactEntity?.summary).toBe('Kept the skill outcome.');
    const rootMessage = restored.renderProjection.entities.messages[rootRow!.messageId]!;
    const compactRootText = textFromContent(rootMessage.content);
    expect(compactRootText).toContain('Conversation compacted.');
    expect(compactRootText).toContain('Kept the skill outcome.');
    expect(compactRootText).toContain('The following skills were invoked in this session');
    expect(compactRootText).toContain('AUTO_SKILL_BODY');
    expect(compactRootText).toContain('The following skills have already been listed to the agent in this session');
    expect(compactRootText).toContain('- auto-skill');
  });

  test('lets invoked skills read referenced resource files outside the workspace', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-read-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-read-root-data-'));
    const externalSkillsRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-external-skills-'));
    roots.push(localRoot, dataRoot, externalSkillsRoot);

    const skillDir = path.join(externalSkillsRoot, 'external-reader');
    const referencePath = path.join(skillDir, 'references', 'details.md');
    await mkdir(path.dirname(referencePath), { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'description: Use when the user asks for an external skill reference check.',
      'allowed-tools: file_read',
      '---',
      'Read ${AGENT_SKILL_DIR}/references/details.md before answering.',
      '',
    ].join('\n'), 'utf8');
    await writeFile(referencePath, 'External skill reference loaded.', 'utf8');

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', { skill: 'external-reader' }, { id: 'tool-skill-external-reader' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage([
          fauxToolCall('file_read', { file_path: referencePath }, { id: 'tool-read-external-skill-reference' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Reference loaded.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          memoryIsolation: 'global',
          additionalSkillDirectories: [externalSkillsRoot],
          providerTimeoutMs: null,
          providerMaxRetries: null,
          providerMaxRetryDelayMs: 60_000,
          providerCacheRetention: 'short',
          disabledSkills: [],
          disabledAgents: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Check the external skill reference.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(script.pendingCount()).toBe(0);
    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    const readResult = events.find((event) => (
      event.type === 'tool_result.created'
      && event.toolCallId === 'tool-read-external-skill-reference'
    ));
    expect(readResult).toMatchObject({ type: 'tool_result.created', isError: false });
    expect(JSON.stringify(readResult)).toContain('External skill reference loaded.');
  });

  test('loads skillify for explicit natural-language save-as-skill requests', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-nl-skillify-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-nl-skillify-data-'));
    roots.push(localRoot, dataRoot);

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Prepared the Skillify review.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: false,
          slashSkillsEnabled: true,
          compactEnabled: false,
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          providerTimeoutMs: null,
          providerMaxRetries: null,
          providerMaxRetryDelayMs: 60_000,
          providerCacheRetention: 'short',
          disabledSkills: [],
          disabledAgents: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Save this workflow as a reusable skill');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(script.pendingCount()).toBe(0);
    const context = contextTexts.join('\n');
    expect(context).toContain('<skill-name>skillify</skill-name>');
    expect(context).toContain('Skillify v2 workflow');
    expect(context).toContain('Save this workflow as a reusable skill');
    expect(context).not.toContain('The following skills are available for use with the skill tool');
  });

  test('loads mutable automatic skills without skill trust approval', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-trust-card-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-trust-card-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'card-skill', [
      '---',
      'description: Use when checking automatic skill loading.',
      '---',
      'CARD_SKILL_BODY',
    ].join('\n'));

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', { skill: 'card-skill' }, { id: 'tool-card-skill' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Card skill loaded.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Use the card skill.');

    expect(script.pendingCount()).toBe(0);
    expect(contextTexts.join('\n')).toContain('CARD_SKILL_BODY');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(sink.events.some((event) => (
      event.type === 'approval_request'
      && event.request.kind === 'skill_trust'
    ))).toBe(false);

    const acceptedSkill = (await runtime.listAllSkills(created.conversationId))
      .find((skill) => skill.name === 'card-skill');
    expect(acceptedSkill?.accepted).toBe(false);
    expect(acceptedSkill?.ratified).toBe(true);
  });

  test('records skill audit events for successful agent-authored skill writes', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-authoring-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-authoring-data-'));
    roots.push(localRoot, dataRoot);

    const skillContent = [
      '---',
      'description: Use when testing agent-authored skill audit events.',
      'disable-model-invocation: true',
      '---',
      'AUDITED_SKILL_BODY.',
    ].join('\n');
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('file_write', {
            file_path: '.agents/skills/audited-skill/SKILL.md',
            content: skillContent,
          }, { id: 'tool-skill-write-audit' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Skill authored.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Create the audited skill.');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'approval_request')).toBe(false);
    expect(await readFile(path.join(localRoot, '.agents', 'skills', 'audited-skill', 'SKILL.md'), 'utf8'))
      .toBe(skillContent);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    const toolCompleted = events.find((event) => (
      event.type === 'tool_call.completed'
      && event.toolCallId === 'tool-skill-write-audit'
    ));
    const skillCreated = events.find((event) => event.type === 'skill.created');
    expect(skillCreated?.runId).toBe(toolCompleted?.runId);
    expect(skillCreated).toMatchObject({
      actor: { type: 'tool', toolName: 'file_write', toolCallId: 'tool-skill-write-audit' },
      skillId: 'audited-skill',
      source: 'project',
    });
    expect(skillCreated?.summary).toContain('create SKILL.md');
    expect(skillCreated?.seq).toBe((toolCompleted?.seq ?? 0) + 1);
    if (!skillCreated?.runId) throw new Error('Expected skill audit event to be run-scoped.');
    const store = new AgentEventStore(dataRoot);
    const conversationRaw = await readFile(store.paths(created.conversationId).conversationEventsPath, 'utf8');
    const runRaw = await readFile(store.runPaths(skillCreated.runId).runEventsPath, 'utf8');
    expect(conversationRaw).not.toContain('skill.created');
    expect(runRaw).toContain('skill.created');
  });

  test('projects manual compact as active while the summary request is running', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-active-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-active-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Ready to compact.'))],
      () => undefined,
    );
    const compactResponse = deferred<AssistantMessage>();

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        completeSimpleFn: async (model) => normalizeAssistantMessage(await compactResponse.promise, model as Model<Api>),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Create compactable context.');

    const compactPromise = runtime.sendMessage(created.conversationId, '/compact');
    await waitFor(() => latestActiveProjectedCompaction(sink.events)?.trigger === 'manual');
    expect(latestActiveProjectedCompaction(sink.events)).toMatchObject({ trigger: 'manual' });

    compactResponse.resolve(fauxAssistantMessage('<analysis>manual compact</analysis><summary>Manual compact summary.</summary>'));
    await compactPromise;

    expect(latestActiveProjectedCompaction(sink.events)).toBeNull();
    expect(latestProjectedCompaction(sink.events)).toMatchObject({
      summary: 'Manual compact summary.',
      trigger: 'manual',
    });
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('runs isolated-execution skills through a sidechain child run and returns only the result to the parent', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-isolated-skill-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-isolated-skill-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'isolated-skill', [
      '---',
      'description: Use when isolated skill execution is requested.',
      'execution: isolated',
      'allowed-tools: Bash(echo isolated-ok*)',
      '---',
      'ISOLATED_SKILL_BODY for $ARGUMENTS.',
    ].join('\n'));

    const childContexts: string[] = [];
    const parentContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', {
            skill: 'isolated-skill',
            args: 'target-doc',
          }, { id: 'tool-skill-isolated' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          childContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage([
            fauxToolCall('bash', {
              command: 'echo isolated-ok',
              description: 'Print isolated skill permission marker',
            }, { id: 'tool-isolated-bash' }),
          ], { stopReason: 'toolUse' });
        },
        (context) => {
          childContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Isolated skill result.'));
        },
        (context) => {
          parentContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Parent consumed isolated skill result.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        permissionMode: 'restricted',
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'isolated-skill');
    await runtime.sendMessage(created.conversationId, 'Use the isolated skill.');

    expect(script.pendingCount()).toBe(0);
    expect(childContexts.join('\n')).toContain('ISOLATED_SKILL_BODY for target-doc.');
    expect(childContexts.join('\n')).toContain('isolated-ok');
    expect(parentContexts.join('\n')).toContain('Isolated skill result.');
    expect(parentContexts.join('\n')).not.toContain('ISOLATED_SKILL_BODY for target-doc.');
  });

  test('runs built-in research skill as a read-only isolated run with mutating tools absent from the child catalog', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-research-skill-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-research-skill-data-'));
    roots.push(localRoot, dataRoot);

    const childToolNames: string[][] = [];
    const parentContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', {
            skill: 'research',
            args: 'map the agent skill runtime',
          }, { id: 'tool-skill-research' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          childToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
          return fauxAssistantMessage(fauxText([
            'Findings',
            '- Research child inspected available context.',
            '',
            'Evidence',
            '- Local runtime request.',
            '',
            'Confidence',
            '- High, based on visible tool catalog.',
          ].join('\n')));
        },
        (context) => {
          parentContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Parent consumed research result.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        permissionMode: 'restricted',
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Use research on the skill runtime.');

    expect(script.pendingCount()).toBe(0);
    expect(childToolNames).toHaveLength(1);
    const childTools = childToolNames[0] ?? [];
    expect([...childTools].sort()).toEqual([
      'file_read',
      'file_glob',
      'file_grep',
      'web_search',
      'web_fetch',
      'node_read',
      'node_search',
      'past_chats',
    ].sort());
    expect(childTools).not.toContain('file_write');
    expect(childTools).not.toContain('file_edit');
    expect(childTools).not.toContain('node_create');
    expect(childTools).not.toContain('node_edit');
    expect(childTools).not.toContain('node_delete');
    expect(childTools).not.toContain('operation_history');
    expect(childTools).not.toContain('bash');
    expect(childTools).not.toContain('skill');
    expect(childTools).not.toContain('spawn_run');
    expect(childTools).not.toContain('run_status');
    expect(childTools).not.toContain('run_steer');
    expect(childTools).not.toContain('run_stop');
    expect(parentContexts.join('\n')).toContain('Research child inspected available context.');
    const runMetas = await new AgentEventStore(dataRoot).listConversationRunMetaProjections(created.conversationId);
    const researchMeta = runMetas.find((meta) => meta.runProfile === 'research');
    expect(researchMeta).toMatchObject({
      context: 'none',
      runProfile: 'research',
      objective: {
        role: 'worker',
      },
    });
  });

  test('direct slash isolated skills surface the user turn before the isolated run completes', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-slash-research-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-slash-research-data-'));
    roots.push(localRoot, dataRoot);

    const childStarted = deferred<void>();
    const releaseChild = deferred<void>();
    const parentContexts: string[] = [];
    let callCount = 0;
    const streamFn: StreamFn = ((model: Model<Api>, context: Context) => {
      callCount += 1;
      const stream = createAssistantMessageEventStream();
      if (callCount === 1) {
        childStarted.resolve();
        void releaseChild.promise.then(() => {
          const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Slash research result.')), model);
          stream.push({ type: 'start', partial: { ...message, content: [] } });
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end(message);
        });
        return stream;
      }

      parentContexts.push(JSON.stringify(context.messages));
      queueMicrotask(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Parent consumed slash research.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, '/research map the agent run detail UI');
    await childStarted.promise;
    await waitFor(() => sink.events.some((event) => (
      event.type === 'projection'
      && projectionTexts(event.renderProjection).join('\n').includes('/research map the agent run detail UI')
      && event.renderProjection.activeRun !== null
    )));

    releaseChild.resolve();
    await sendPromise;

    expect(parentContexts.join('\n')).toContain('Slash research result.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('asks for a read scope when research inspects an external folder', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-research-scope-root-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-research-scope-external-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-research-scope-data-'));
    roots.push(localRoot, outsideRoot, dataRoot);
    await mkdir(path.join(outsideRoot, 'src'), { recursive: true });
    await writeFile(path.join(outsideRoot, 'src', 'finding.ts'), 'export const finding = true;\n');

    const childFollowUpContexts: string[] = [];
    const parentContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', {
            skill: 'research',
            args: `inspect ${outsideRoot}`,
          }, { id: 'tool-skill-research-scope' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage([
          fauxToolCall('file_glob', {
            path: outsideRoot,
            pattern: '**/*.ts',
          }, { id: 'tool-research-glob-outside' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          childFollowUpContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage([
            fauxToolCall('file_read', {
              file_path: path.join(outsideRoot, 'src', 'finding.ts'),
            }, { id: 'tool-research-read-outside' }),
          ], { stopReason: 'toolUse' });
        },
        (context) => {
          childFollowUpContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText([
            'Findings',
            '- External folder contained a TypeScript file.',
            '',
            'Evidence',
            '- file_glob returned src/finding.ts.',
            '',
            'Confidence',
            '- High.',
          ].join('\n')));
        },
        (context) => {
          parentContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Parent consumed scoped research result.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        permissionMode: 'restricted',
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Use research on the external folder.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected research file-scope approval request.');

    expect(approvalEvent.request.toolName).toBe('file_glob');
    expect(approvalEvent.request.toolCallId).toBe('tool-research-glob-outside');
    expect(approvalEvent.request.target).toBe(outsideRoot);
    expect(approvalEvent.request.alwaysAllowRule).toBe(`Scope(read:${outsideRoot})`);
    expect(approvalEvent.request.alwaysAllowAction).toBe('grant');

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true);
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(childFollowUpContexts.join('\n')).toContain('tool-research-glob-outside');
    expect(childFollowUpContexts.join('\n')).toContain('tool-research-read-outside');
    expect(childFollowUpContexts.join('\n')).toContain('finding.ts');
    expect(childFollowUpContexts.join('\n')).toContain('export const finding = true');
    expect(childFollowUpContexts.join('\n')).not.toContain('path_outside_local_root');
    expect(parentContexts.join('\n')).toContain('External folder contained a TypeScript file.');
    expect(sink.events.filter((event) => event.type === 'approval_request')).toHaveLength(1);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.find((event) => (
      event.type === 'tool.permission.checked'
      && event.requestId === approvalEvent.requestId
    ))).toMatchObject({
      toolCallId: 'tool-research-glob-outside',
      outcome: 'ask',
    });
    expect(events.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.requestId === approvalEvent.requestId
    ))).toMatchObject({
      toolCallId: 'tool-research-glob-outside',
      status: 'approved',
      resolvedBy: 'user_once',
    });
    expect(events.find((event) => (
      event.type === 'tool.permission.checked'
      && event.toolCallId === 'tool-research-read-outside'
    ))).toMatchObject({
      toolCallId: 'tool-research-read-outside',
      outcome: 'allow',
    });
  });

  test('runs skill shell expansion through the runtime permission layer', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-shell-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-shell-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'shell-skill', [
      '---',
      'description: Use when checking skill shell expansion.',
      'allowed-tools: Bash(echo skill-shell-ok*)',
      '---',
      'Shell output: !`echo skill-shell-ok`',
    ].join('\n'));

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', { skill: 'shell-skill' }, { id: 'tool-skill-shell-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Shell skill loaded.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          permissionMode: 'restricted',
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'shell-skill');
    await runtime.sendMessage(created.conversationId, 'Please load the shell skill.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(script.pendingCount()).toBe(0);
    expect(contextTexts.join('\n')).toContain('Shell output: skill-shell-ok');
  });

  test('routes skill shell approval requests through the runtime approval flow', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-shell-approval-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-shell-approval-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'shell-approval-skill', [
      '---',
      'description: Use when checking skill shell approval.',
      '---',
      'Shell output: !`eval "echo skill-shell-approved"`',
    ].join('\n'));

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', { skill: 'shell-approval-skill' }, { id: 'tool-skill-shell-approval-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Shell approval skill loaded.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'shell-approval-skill');
    const sendPromise = runtime.sendMessage(created.conversationId, 'Please load the shell approval skill.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected skill shell approval request.');

    expect(approvalEvent.request.toolName).toBe('bash');
    expect(approvalEvent.request.toolCallId).toStartWith('skill-shell-');
    expect(approvalEvent.request.target).toContain('eval "echo skill-shell-approved"');

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true);
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    expect(contextTexts.join('\n')).toContain('Shell output: skill-shell-approved');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.find((event) => event.type === 'approval.requested')).toMatchObject({
      requestId: approvalEvent.requestId,
    });
    expect(events.find((event) => event.type === 'approval.resolved')).toMatchObject({
      requestId: approvalEvent.requestId,
      approved: true,
    });
    expect(events.find((event) => (
      event.type === 'tool.permission.checked'
      && event.requestId === approvalEvent.requestId
    ))).toMatchObject({
      requestId: approvalEvent.requestId,
      toolCallId: approvalEvent.request.toolCallId,
      outcome: 'soft_blocked',
    });
    expect(events.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.requestId === approvalEvent.requestId
    ))).toMatchObject({
      requestId: approvalEvent.requestId,
      toolCallId: approvalEvent.request.toolCallId,
      status: 'approved',
      resolvedBy: 'user_once',
    });
  });

  test('reports rejected approvals as user-denied tool results', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-denied-approval-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-denied-approval-data-'));
    roots.push(localRoot, dataRoot);

    const followUpContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'eval "echo denied-soft-block"',
            description: 'Soft-blocked eval command',
          }, { id: 'tool-denied-soft-block' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          followUpContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Approval denial handled.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Try the dry-run push.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected approval request event.');

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, false);
    await sendPromise;

    const contextText = followUpContexts.join('\n');
    expect(contextText).toContain('User denied permission. The requested tool call was not executed.');
    expect(contextText).not.toContain('Permission denied: This changes external state on a git remote.');

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    const persistedApprovalRequest = events.find((event) => event.type === 'approval.requested');
    const persistedApprovalResolution = events.find((event) => event.type === 'approval.resolved');
    const permissionChecked = events.find((event) => event.type === 'tool.permission.checked');
    const permissionResolved = events.find((event) => event.type === 'tool.permission.resolved');
    expect(approvalEvent.requestId.startsWith('permission-')).toBe(true);
    expect(persistedApprovalRequest).toMatchObject({ requestId: approvalEvent.requestId });
    expect(persistedApprovalResolution).toMatchObject({ requestId: approvalEvent.requestId, approved: false });
    expect(permissionChecked).toMatchObject({
      requestId: approvalEvent.requestId,
      outcome: 'soft_blocked',
    });
    expect(permissionResolved).toMatchObject({
      requestId: approvalEvent.requestId,
      status: 'denied',
      resolvedBy: 'user_once',
      deniedReason: 'user_denied',
    });
    const deniedToolResult = events.find((event) => (
      event.type === 'tool_result.created'
      && event.toolCallId === 'tool-denied-soft-block'
    ));
    expect(deniedToolResult?.runId).toBeDefined();
    expect(events.some((event) => (
      event.type === 'run.started'
      && event.runId === deniedToolResult?.runId
    ))).toBe(true);
  });

  test('auto-blocks soft-block approvals in main when the renderer does not respond', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-auto-block-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-auto-block-data-'));
    roots.push(localRoot, dataRoot);

    const followUpContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'eval "echo auto-blocked-soft-block"',
            description: 'Soft-blocked eval command',
          }, { id: 'tool-auto-blocked-soft-block' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          followUpContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Auto-block handled.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const originalSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => originalSetTimeout(handler, timeout === 10_000 ? 5 : timeout, ...args)) as typeof setTimeout;
    globalThis.setTimeout = fastSetTimeout;

    try {
      const created = await runtime.restoreLatestConversation();
      const sendPromise = runtime.sendMessage(created.conversationId, 'Try an unattended soft-block.');
      await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
      const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
        event.type === 'approval_request'
      ));
      if (!approvalEvent) throw new Error('Expected approval request event.');

      await sendPromise;

      const contextText = followUpContexts.join('\n');
      expect(contextText).toContain('User denied permission. The requested tool call was not executed.');
      expect(sink.events.some((event) => (
        event.type === 'approval_resolved'
        && event.requestId === approvalEvent.requestId
        && event.approved === false
      ))).toBe(true);

      const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
      expect(events.find((event) => event.type === 'approval.resolved')).toMatchObject({
        requestId: approvalEvent.requestId,
        approved: false,
      });
      expect(events.find((event) => event.type === 'tool.permission.resolved')).toMatchObject({
        requestId: approvalEvent.requestId,
        status: 'denied',
        deniedReason: 'user_denied',
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('returns hard-denied tool calls to the model without user notice cards', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-deny-notice-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-deny-notice-data-'));
    roots.push(localRoot, dataRoot);

    const followUpContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'rm -rf /',
          }, { id: 'tool-hard-denied-shell' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          followUpContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Saw the blocked command.'));
        },
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Run the blocked shell command.');

    expect(sink.events.some((event) => (
      event.type === 'approval_request'
      && event.request.kind === 'permission_notice'
    ))).toBe(false);
    expect(followUpContexts.join('\n')).toContain('permission_denied');
    expect(followUpContexts.join('\n')).toContain('recursively delete');

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(events.some((event) => event.type === 'approval.resolved')).toBe(false);
    expect(events.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.toolCallId === 'tool-hard-denied-shell'
    ))).toMatchObject({
      status: 'denied',
      deniedReason: 'platform_hard_block',
    });
  });

  test('persists always-allow soft-block exceptions globally', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-always-approval-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-always-approval-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'eval "echo always-soft-block"',
            description: 'Soft-blocked eval command',
          }, { id: 'tool-always-soft-block' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Cleanup handled.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Clean build output.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected approval request event.');

    expect(approvalEvent.request.alwaysAllowRule).toBe('Command(eval "echo always-soft-block")');

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true, 'always');
    await sendPromise;

    const settings = JSON.parse(await readFile(path.join(electronUserDataRoot, 'agent-tool-permissions.json'), 'utf8')) as {
      grants?: string[];
      softBlockAllows?: string[];
    };
    expect(settings.softBlockAllows).toContain('Command(eval "echo always-soft-block")');

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => (
      event.type === 'tool.permission.resolved'
      && event.status === 'approved'
      && event.resolvedBy === 'allow_rule_update'
      && event.updatedRule === 'Command(eval "echo always-soft-block")'
    ))).toBe(true);
  });

  test('downgrades always-allow approval to approve-once when the global rule cannot be saved', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-always-approval-fail-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-always-approval-fail-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'eval "echo always-soft-block-fail"',
            description: 'Soft-blocked eval command',
          }, { id: 'tool-always-soft-block-fail' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Cleanup handled after downgraded approval.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Clean build output.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected approval request event.');

    await rm(electronUserDataRoot, { recursive: true, force: true });
    await writeFile(electronUserDataRoot, 'not-a-directory');

    await expect(runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true, 'always')).resolves.toEqual({ resolved: true });
    await sendPromise;

    expect(sink.events.some((event) => (
      event.type === 'error'
      && event.error.includes('Failed to persist permission rule; approved once instead.')
    ))).toBe(true);
    expect(sink.events.some((event) => (
      event.type === 'approval_resolved'
      && event.requestId === approvalEvent.requestId
      && event.scope === 'once'
    ))).toBe(true);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => (
      event.type === 'tool.permission.resolved'
      && event.status === 'approved'
      && event.resolvedBy === 'user_once'
      && event.updatedRule === undefined
    ))).toBe(true);
  });

  test('records legacy grants distinctly with all compound shell action kinds', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-global-allow-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-global-allow-data-'));
    roots.push(localRoot, dataRoot);
    await mkdir(electronUserDataRoot, { recursive: true });
    await writeFile(path.join(electronUserDataRoot, 'agent-tool-permissions.json'), JSON.stringify({
      grants: ['Command(ls && rm -rf ./dist)'],
    }));

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'ls && rm -rf ./dist',
            description: 'Inspect and remove build output',
          }, { id: 'tool-global-allow-rm' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Cleanup handled by global rule.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Clean build output without prompting.');

    expect(sink.events.some((event) => event.type === 'approval_request')).toBe(false);
    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => (
      event.type === 'tool.permission.checked'
      && event.outcome === 'allow'
      && event.source === 'trust_ledger'
      && event.actionKinds.includes('shell.unknown')
      && event.actionKinds.includes('file.delete.allowed_file_area')
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === 'tool.permission.resolved'
      && event.status === 'approved'
      && event.resolvedBy === 'trust_ledger'
    ))).toBe(true);
  });

  test('records runtime-denied approval resolutions when closing a conversation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-close-approval-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-close-approval-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'eval "echo close-soft-block"',
            description: 'Soft-blocked eval command',
          }, { id: 'tool-close-soft-block' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('This should not be needed after close.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Try the dry-run push before close.')
      .catch(() => undefined);
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected approval request event.');

    runtime.closeConversation(created.conversationId);
    await waitFor(() => sink.events.some((event) => (
      event.type === 'approval_resolved'
      && event.requestId === approvalEvent.requestId
      && event.approved === false
    )));

    const store = new AgentEventStore(dataRoot);
    await waitFor(async () => {
      const events = await store.readEvents(created.conversationId);
      return events.some((event) => (
        event.type === 'approval.resolved'
        && event.requestId === approvalEvent.requestId
        && event.approved === false
      ));
    });
    await sendPromise;

    const events = await store.readEvents(created.conversationId);
    expect(events.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.requestId === approvalEvent.requestId
    ))).toMatchObject({
      requestId: approvalEvent.requestId,
      status: 'denied',
      resolvedBy: 'runtime',
      deniedReason: 'runtime',
    });
  });

  test('honors runtime switches for automatic skills and compact', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-switches-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-switch-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'auto-skill', [
      '---',
      'description: Use when the user asks for an automatic skill integration check.',
      '---',
      'AUTO_SKILL_BODY',
    ].join('\n'));

    const callTexts: string[] = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Normal response.'))],
      (_model, context) => {
        callTexts.push(JSON.stringify(context.messages));
      },
    );
    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          slashSkillsEnabled: false,
          compactEnabled: false,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, '/compact should be a normal prompt');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(callTexts.join('\n')).toContain('/compact should be a normal prompt');
    expect(callTexts.join('\n')).not.toContain('The following skills are available');
    const restored = await runtime.restoreConversation(created.conversationId);
    expect(restored.renderProjection.rows).toHaveLength(2);
  });

  test('refreshes configured skill directories for existing conversations', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-refresh-'));
    const extraRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-extra-skills-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-refresh-data-'));
    roots.push(localRoot, extraRoot, dataRoot);

    await createSkill(extraRoot, 'extra-skill', [
      '---',
      'description: Use when extra configured skills are enabled.',
      '---',
      'EXTRA_SKILL_BODY',
    ].join('\n'));
    const extraSkillDir = path.join(extraRoot, '.agents', 'skills');

    let runtimeSettings = {
      permissionMode: 'trusted' as const,
      automaticSkillsEnabled: true,
      slashSkillsEnabled: true,
      compactEnabled: true,
      additionalSkillDirectories: [] as string[],
    };
    const callTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('First response.')),
        fauxAssistantMessage(fauxText('Second response.')),
      ],
      (_model, context) => {
        callTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        runtimeSettingsLoader: async () => runtimeSettings,
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'First turn before extra skills are configured.');
    expect(callTexts[0]).not.toContain('extra-skill');

    runtimeSettings = {
      ...runtimeSettings,
      additionalSkillDirectories: [extraSkillDir],
    };
    await runtime.sendMessage(created.conversationId, 'Second turn after extra skills are configured.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(callTexts[1]).toContain('extra-skill');
    expect(callTexts[1]).toContain('Use when extra configured skills are enabled.');
  });

  test('releases queued follow-up skill listing state when the follow-up is cleared', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-follow-up-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-follow-up-data-'));
    const extraRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-follow-up-extra-'));
    roots.push(localRoot, dataRoot, extraRoot);
    await createSkill(extraRoot, 'queued-skill', [
      '---',
      'description: Use when checking queued follow-up skill listing release.',
      '---',
      'QUEUED_SKILL_BODY',
    ].join('\n'));

    const contextTexts: string[] = [];
    let additionalSkillDirectories: string[] = [];
    let firstStream: ReturnType<typeof createAssistantMessageEventStream> | null = null;
    let firstModel: Model<Api> | null = null;
    let resolveFirstStream: (() => void) | null = null;
    const firstStreamStarted = new Promise<void>((resolve) => {
      resolveFirstStream = resolve;
    });
    let callCount = 0;
    const streamFn = ((model: Model<Api>, context: Context) => {
      callCount += 1;
      contextTexts.push(JSON.stringify(context.messages));
      const stream = createAssistantMessageEventStream();
      if (callCount === 1) {
        firstStream = stream;
        firstModel = model;
        resolveFirstStream?.();
        queueMicrotask(() => {
          const message = normalizeAssistantMessage(fauxAssistantMessage([]), model);
          stream.push({ type: 'start', partial: { ...message, content: [] } });
        });
        return stream;
      }

      queueMicrotask(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('After clear.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories,
        }),
        streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const firstSend = runtime.sendMessage(created.conversationId, 'Start without any configured skills.');
    await firstStreamStarted;
    additionalSkillDirectories = [path.join(extraRoot, '.agents', 'skills')];
    await runtime.queueFollowUp(created.conversationId, 'Queue after adding a skill directory.');
    runtime.clearFollowUp(created.conversationId);

    const finalFirstMessage = normalizeAssistantMessage(fauxAssistantMessage(fauxText('First done.')), firstModel!);
    firstStream!.push({
      type: 'done',
      reason: finalFirstMessage.stopReason as Exclude<StopReason, 'error' | 'aborted'>,
      message: finalFirstMessage,
    });
    firstStream!.end(finalFirstMessage);
    await firstSend;

    await runtime.sendMessage(created.conversationId, 'Now send after clearing the queued follow-up.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextTexts).toHaveLength(2);
    expect(contextTexts[0]).not.toContain('queued-skill');
    expect(contextTexts[1]).toContain('queued-skill');
  });

  test('injects runtime steer before the next model call while a run is active', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-steer-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-steer-data-'));
    roots.push(localRoot, dataRoot);
    const filePath = path.join(localRoot, 'notes.txt');
    await writeFile(filePath, 'steer integration fixture\n', 'utf8');

    const steerText = 'Stop after this read and summarize the result.';
    const contextTexts: string[] = [];
    let firstStream: ReturnType<typeof createAssistantMessageEventStream> | null = null;
    let firstModel: Model<Api> | null = null;
    let resolveFirstStream: (() => void) | null = null;
    const firstStreamStarted = new Promise<void>((resolve) => {
      resolveFirstStream = resolve;
    });
    let callCount = 0;
    const streamFn = ((model: Model<Api>, context: Context) => {
      callCount += 1;
      contextTexts.push(JSON.stringify(context.messages));
      const stream = createAssistantMessageEventStream();
      if (callCount === 1) {
        firstStream = stream;
        firstModel = model;
        resolveFirstStream?.();
        queueMicrotask(() => {
          const partial = normalizeAssistantMessage(fauxAssistantMessage([], { stopReason: 'toolUse' }), model);
          stream.push({ type: 'start', partial: { ...partial, content: [] } });
        });
        return stream;
      }

      queueMicrotask(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Steered after read.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
    const send = runtime.sendMessage(created.conversationId, 'Read the notes file first.');
    await firstStreamStarted;

    expect(runtime.steerConversation(created.conversationId, steerText)).toEqual({ queued: true });

    const finalFirstMessage = normalizeAssistantMessage(
      fauxAssistantMessage([
        fauxToolCall('file_read', { file_path: filePath }, { id: 'tool-read-steer' }),
      ], { stopReason: 'toolUse' }),
      firstModel!,
    );
    firstStream!.push({
      type: 'done',
      reason: finalFirstMessage.stopReason as Exclude<StopReason, 'error' | 'aborted'>,
      message: finalFirstMessage,
    });
    firstStream!.end(finalFirstMessage);
    await send;

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextTexts).toHaveLength(2);
    expect(contextTexts[0]).not.toContain(steerText);
    expect(contextTexts[1]).toContain('tool-read-steer');
    expect(contextTexts[1]).toContain(steerText);
    expect(runtime.steerConversation(created.conversationId, 'idle steer')).toEqual({ queued: false });
  });

  test('slims large live tool results before the follow-up model call', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tool-slim-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tool-slim-data-'));
    roots.push(localRoot, dataRoot);
    const largeFile = path.join(localRoot, 'large.txt');
    await writeFile(largeFile, Array.from({ length: 1200 }, (_, index) => `${index}: ${'x'.repeat(80)}`).join('\n'));

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('file_read', { file_path: largeFile }, { id: 'tool-read-large' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Large file inspected.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Read the large file.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextTexts[1]).toContain('<persisted-output>');
    expect(contextTexts[1]).toContain('tool-output-tool-read-large');
    expect(contextTexts[1]!.length).toBeLessThan(40_000);
  });

  pdfTextTest('extracts PDF text before OpenAI Responses provider calls', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-pdf-text-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-pdf-text-data-'));
    roots.push(localRoot, dataRoot);
    const pdfPath = path.join(localRoot, 'sample.pdf');
    await writeFile(pdfPath, makePdf(['First page', 'Second page']), 'utf8');

    const payloads: unknown[] = [];
    let callIndex = 0;
    const streamFn: StreamFn = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const toolResult = context.messages.find((message) => message.role === 'toolResult') as
          | { toolCallId: string; content: Array<{ type: string; text?: string }> }
          | undefined;
        if (toolResult) {
          const text = toolResult.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n');
          const payload = {
            input: [{
              type: 'function_call_output',
              call_id: toolResult.toolCallId.split('|')[0],
              output: text,
            }],
          };
          payloads.push(await options?.onPayload?.(payload, model) ?? payload);
        }
        const response = callIndex++ === 0
          ? fauxAssistantMessage([
              fauxToolCall('file_read', { file_path: pdfPath }, { id: 'tool-read-pdf' }),
            ], { stopReason: 'toolUse' })
          : fauxAssistantMessage(fauxText('PDF inspected.'));
        const message = normalizeAssistantMessage(response, model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        providerModelResolver: () => ({
          id: 'gpt-native-pdf',
          name: 'gpt-native-pdf',
          provider: 'openai',
          api: 'openai-responses',
          baseUrl: '',
          reasoning: false,
          input: ['text', 'image'],
          contextWindow: 1_000_000,
          maxTokens: 32_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Read the PDF.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as {
      input: Array<{ output: string }>;
    };
    const output = payload.input[0]!.output;
    expect(output).toContain('Extracted text from PDF pages 1-2');
    expect(output).toContain('First page');
    expect(output).toContain('Second page');
    expect(output).not.toContain('input_file');
    expect(output).not.toContain('file_data');
    expect(output).not.toContain('data:application/pdf;base64,');
    expect(output).not.toContain('<tenon-native-pdf>');
  });

  test('auto-compacts before a model call when the active context crosses the threshold', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-auto-compact-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-auto-compact-data-'));
    roots.push(localRoot, dataRoot);

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Initial response.')),
        fauxAssistantMessage(fauxText('Continued after auto compact.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );
    const compactModel: Model<Api> = {
      id: 'compact-test-model',
      name: 'Compact Test Model',
      provider: 'openai',
      api: 'openai-completions',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      contextWindow: 30_000,
      maxTokens: 1_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          modelId: 'compact-test-model',
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
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>auto compact</analysis><summary>Auto compact summary.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Start a small context.');
    await runtime.sendMessage(created.conversationId, `Please continue after this large context.\n\n${'z'.repeat(90_000)}`);

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextTexts[1]).toContain('Conversation compacted.');
    expect(contextTexts[1]).toContain('Auto compact summary.');
    expect(contextTexts[1]!.length).toBeLessThan(20_000);
    expect(latestProjectedCompaction(sink.events)).toMatchObject({
      summary: 'Auto compact summary.',
      trigger: 'auto',
    });
  });

  test('continues an in-flight run from the compact root after auto compact', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-auto-compact-tail-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-auto-compact-tail-data-'));
    roots.push(localRoot, dataRoot);
    const filePath = path.join(localRoot, 'large-notes.txt');
    await writeFile(
      filePath,
      Array.from({ length: 600 }, (_, index) => `line-${index}: ${'x'.repeat(48)}`).join('\n'),
      'utf8',
    );

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('file_read', { file_path: filePath }, { id: 'tool-read-before-auto-compact' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Continued from compact root.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );
    const compactModel: Model<Api> = {
      id: 'compact-tail-test-model',
      name: 'Compact Tail Test Model',
      provider: 'openai',
      api: 'openai-completions',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      contextWindow: 12_000,
      maxTokens: 1_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          modelId: 'compact-tail-test-model',
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
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>auto compact tail</analysis><summary>Tool output summarized.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Read the large notes and continue.');

    expect(script.pendingCount()).toBe(0);
    expect(contextTexts[1]).toContain('Conversation compacted.');
    expect(contextTexts[1]).toContain('Tool output summarized.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    const store = new AgentEventStore(dataRoot);
    const events = await store.readEvents(created.conversationId);
    const compaction = events.find((event) => event.type === 'compaction.completed');
    if (!compaction || compaction.type !== 'compaction.completed') throw new Error('Expected auto compaction event.');
    const replay = await store.replay(created.conversationId);
    const activePath = getAgentEventActivePath(replay);
    expect(activePath.map((message) => message.id)).toEqual([
      compaction.messageId,
      expect.stringMatching(/^assistant-/),
    ]);
    expect(activePath[1]?.parentMessageId).toBe(compaction.messageId);
  });

  test('reactively compacts and retries after a prompt-too-long model error', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-compact-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-compact-data-'));
    roots.push(localRoot, dataRoot);

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt too long: context length exceeded',
        }),
        fauxAssistantMessage(fauxText('Retried after reactive compact.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          fauxAssistantMessage('<analysis>reactive compact</analysis><summary>Reactive compact summary.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Trigger a context length retry.');

    expect(script.pendingCount()).toBe(0);
    expect(contextTexts[1]).toContain('Conversation compacted.');
    expect(contextTexts[1]).toContain('Reactive compact summary.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(latestProjectedCompaction(sink.events)).toMatchObject({
      summary: 'Reactive compact summary.',
      trigger: 'reactive',
    });
  });

  test('retries compact summary requests that hit the provider context limit', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-ptl-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-ptl-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('First answer.')),
        fauxAssistantMessage(fauxText('Second answer.')),
      ],
      () => undefined,
    );
    const compactRequests: string[] = [];
    let compactCalls = 0;

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        completeSimpleFn: async (model, context) => {
          compactCalls += 1;
          compactRequests.push(JSON.stringify(context.messages));
          return normalizeAssistantMessage(
            compactCalls === 1
              ? fauxAssistantMessage([], {
                  stopReason: 'error',
                  errorMessage: 'prompt too long: context length exceeded',
                })
              : fauxAssistantMessage('<analysis>retry compact</analysis><summary>Retry compact summary.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'First request before compact.');
    await runtime.sendMessage(created.conversationId, 'Second request before compact.');
    await runtime.sendMessage(created.conversationId, '/compact');

    expect(compactCalls).toBe(2);
    expect(compactRequests[1]).not.toContain('First request before compact.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    const restored = await runtime.restoreConversation(created.conversationId);
    expect(projectionTexts(restored.renderProjection).join('\n')).toContain('Retry compact summary.');
  });

  test('restores recently read file context after compact', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-files-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-compact-files-data-'));
    roots.push(localRoot, dataRoot);
    const filePath = path.join(localRoot, 'notes.txt');
    await writeFile(filePath, 'important compact restore content\nsecond line\n', 'utf8');

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('file_read', { file_path: filePath }, { id: 'tool-read-notes' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Read notes.')),
      ],
      () => undefined,
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>file compact</analysis><summary>File compact summary.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Read notes before compact.');
    await runtime.sendMessage(created.conversationId, '/compact');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    const restored = await runtime.restoreConversation(created.conversationId);
    const compactText = projectionTexts(restored.renderProjection).join('\n');
    expect(compactText).toContain('Recent file context restored after compaction');
    expect(compactText).toContain(filePath);
    expect(compactText).toContain('important compact restore content');
  });

  test('reactive compact preserves the latest user prompt verbatim before retrying', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-tail-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-tail-data-'));
    roots.push(localRoot, dataRoot);

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Earlier response.')),
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt too long: context length exceeded',
        }),
        fauxAssistantMessage(fauxText('Retried with preserved prompt.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          fauxAssistantMessage('<analysis>reactive tail</analysis><summary>Earlier summary only.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Earlier context to summarize.');
    await runtime.sendMessage(created.conversationId, 'Latest prompt must stay verbatim.');

    expect(script.pendingCount()).toBe(0);
    expect(contextTexts[2]).toContain('Conversation compacted.');
    expect(contextTexts[2]).toContain('Earlier summary only.');
    expect(contextTexts[2]).toContain('Latest prompt must stay verbatim.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('reactive compact restores file content when preserved tail only has an unchanged read stub', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-stub-file-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-stub-file-data-'));
    roots.push(localRoot, dataRoot);
    const filePath = path.join(localRoot, 'notes.txt');
    await writeFile(filePath, 'reactive restore body from original full read\n', 'utf8');

    const contextTexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('file_read', { file_path: filePath }, { id: 'tool-read-full' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Full read completed.')),
        fauxAssistantMessage([
          fauxToolCall('file_read', { file_path: filePath }, { id: 'tool-read-unchanged' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt too long: context length exceeded',
        }),
        fauxAssistantMessage(fauxText('Retried after reactive file restore.')),
      ],
      (_model, context) => {
        contextTexts.push(JSON.stringify(context.messages));
      },
    );

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
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
          fauxAssistantMessage('<analysis>reactive file</analysis><summary>Earlier file work.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Read the file initially.');
    await runtime.sendMessage(created.conversationId, 'Read it again, then continue.');

    expect(script.pendingCount()).toBe(0);
    const retryContext = contextTexts.at(-1) ?? '';
    expect(retryContext).toContain('Recent file context restored after compaction');
    expect(retryContext).toContain(filePath);
    expect(retryContext).toContain('reactive restore body from original full read');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });

  test('editing the built-in tool filter hot-swaps the live conversation tool set (no reopen)', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tool-hotswap-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tool-hotswap-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream([fauxAssistantMessage(fauxText('Ack.'))], () => undefined);

    const { AgentRuntime: Runtime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new Runtime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({ providerId: 'openai', enabled: true, apiKey: 'test-key' }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: false,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const ASSISTANT_AGENT_ID = 'built-in:tenon:assistant';
    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Hello.');

    // Reach into the live conversation's pi-agent to read its actual tool set — the
    // surface a turn calls, not a projection.
    const conversation = (
      runtime as unknown as {
        conversations: Map<string, { agent: { state: { tools: Array<{ name: string }> } } }>;
      }
    ).conversations.get(created.conversationId);
    if (!conversation) throw new Error('expected a live conversation in the runtime map');
    const toolNames = () => conversation.agent.state.tools.map((tool) => tool.name.toLowerCase());

    // web_search is on by default; file_read is the control that must survive the edit.
    expect(toolNames()).toContain('web_search');
    expect(toolNames()).toContain('file_read');

    // Disallow web_search through the same authoring surface the settings editor uses.
    // This MUST take effect on the live conversation's next turn, not only on reopen —
    // the hot-swap loop re-resolves agentToolFilter from the saved overlay.
    const before = (await runtime.listAllAgentDefinitions(created.conversationId))
      .find((definition) => definition.agentId === ASSISTANT_AGENT_ID);
    await runtime.updateAgentDefinition(created.conversationId, ASSISTANT_AGENT_ID, {
      name: before?.displayName ?? 'Neva',
      description: before?.description ?? '',
      body: before?.body ?? '',
      disallowedTools: ['web_search'],
    });

    expect(toolNames()).not.toContain('web_search');
    expect(toolNames()).toContain('file_read');
  });
});
