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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import type { AgentRenderProjection } from '../../src/core/agentRenderProjection';
import { AgentEventStore } from '../../src/main/agentEventStore';
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
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
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

    const created = await runtime.createConversation();
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

  test('keeps manual compact debug capture separate from the next user request', async () => {
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'First request before manual compact.');
    await runtime.sendMessage(created.conversationId, '/compact');
    await runtime.sendMessage(created.conversationId, 'Second request after manual compact.');

    const payloadSnapshots = (await runtime.debugHistory(created.conversationId))
      .filter((snapshot) => snapshot.source === 'provider_payload');
    expect(payloadSnapshots.map((snapshot) => snapshot.queryIndex)).toEqual([1, 2, 3]);
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
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

    const created = await runtime.createConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'auto-skill');
    await runtime.sendMessage(created.conversationId, 'Please do the automatic skill integration check.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(script.pendingCount()).toBe(0);
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

  test('accepts unratified automatic skills from the interrupt card and then loads them', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-trust-card-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-trust-card-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'card-skill', [
      '---',
      'description: Use when checking in-flow skill trust.',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Use the card skill.');
    await waitFor(() => sink.events.some((event) => (
      event.type === 'approval_request'
      && event.request.kind === 'skill_trust'
    )));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
      && event.request.kind === 'skill_trust'
    ));
    if (!approvalEvent) throw new Error('Expected skill trust approval request.');

    expect(approvalEvent.request.toolName).toBe('skill');
    expect(approvalEvent.request.target).toBe('/card-skill');
    expect(approvalEvent.request.skillTrust).toMatchObject({
      name: 'card-skill',
      source: 'project',
    });

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true);
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    expect(contextTexts.join('\n')).toContain('CARD_SKILL_BODY');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    const acceptedSkill = (await runtime.listAllSkills(created.conversationId))
      .find((skill) => skill.name === 'card-skill');
    expect(acceptedSkill?.accepted).toBe(true);
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Create the audited skill.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected skill write approval request.');
    expect(approvalEvent.request.toolName).toBe('file_write');
    expect(approvalEvent.request.title).toBe('Approve skill content write?');

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true);
    await sendPromise;

    expect(script.pendingCount()).toBe(0);
    expect(await readFile(path.join(localRoot, '.agents', 'skills', 'audited-skill', 'SKILL.md'), 'utf8'))
      .toBe(skillContent);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    const toolCompleted = events.find((event) => (
      event.type === 'tool_call.completed'
      && event.toolCallId === 'tool-skill-write-audit'
    ));
    const skillCreated = events.find((event) => event.type === 'skill.created');
    expect(skillCreated).toMatchObject({
      actor: { type: 'tool', toolName: 'file_write', toolCallId: 'tool-skill-write-audit' },
      skillId: 'audited-skill',
      source: 'project',
    });
    expect(skillCreated?.summary).toContain('create SKILL.md');
    expect(skillCreated?.seq).toBe((toolCompleted?.seq ?? 0) + 1);
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => normalizeAssistantMessage(await compactResponse.promise, model as Model<Api>),
      },
    );

    const created = await runtime.createConversation();
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

  test('runs context-fork skills through a sidechain child run and returns only the result to the parent', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-skill-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-skill-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'fork-skill', [
      '---',
      'description: Use when fork skill execution is requested.',
      'context: fork',
      'agent: general',
      'allowed-tools: Bash(echo fork-ok*)',
      '---',
      'FORK_SKILL_BODY for $ARGUMENTS.',
    ].join('\n'));

    const childContexts: string[] = [];
    const parentContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', {
            skill: 'fork-skill',
            args: 'target-doc',
          }, { id: 'tool-skill-fork' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          childContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage([
            fauxToolCall('bash', {
              command: 'echo fork-ok',
              description: 'Print fork skill permission marker',
            }, { id: 'tool-fork-bash' }),
          ], { stopReason: 'toolUse' });
        },
        (context) => {
          childContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Forked skill result.'));
        },
        (context) => {
          parentContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Parent consumed forked skill result.'));
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        permissionMode: 'restricted',
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'fork-skill');
    await runtime.sendMessage(created.conversationId, 'Use the fork skill.');

    expect(script.pendingCount()).toBe(0);
    expect(childContexts.join('\n')).toContain('FORK_SKILL_BODY for target-doc.');
    expect(childContexts.join('\n')).toContain('fork-ok');
    expect(parentContexts.join('\n')).toContain('Forked skill result.');
    expect(parentContexts.join('\n')).not.toContain('FORK_SKILL_BODY for target-doc.');
  });

  test('fails context-fork skills with an explicit unknown agent instead of falling back to general', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-skill-unknown-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-fork-skill-unknown-data-'));
    roots.push(localRoot, dataRoot);

    await createSkill(localRoot, 'unknown-agent-skill', [
      '---',
      'description: Use when an unknown fork skill agent is requested.',
      'context: fork',
      'agent: missing-specialist',
      '---',
      'UNKNOWN_AGENT_SKILL_BODY.',
    ].join('\n'));

    const parentContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('skill', {
            skill: 'unknown-agent-skill',
          }, { id: 'tool-skill-unknown-agent' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          parentContexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(fauxText('Parent handled unknown skill agent.'));
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'unknown-agent-skill');
    await runtime.sendMessage(created.conversationId, 'Use the unknown agent fork skill.');

    expect(script.pendingCount()).toBe(0);
    const parentText = parentContexts.join('\n');
    expect(parentText).toContain("Agent type 'missing-specialist' not found");
    expect(parentText).not.toContain('UNKNOWN_AGENT_SKILL_BODY.');
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'shell-skill');
    await runtime.sendMessage(created.conversationId, 'Please load the shell skill.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(script.pendingCount()).toBe(0);
    expect(contextTexts.join('\n')).toContain('Shell output: skill-shell-ok');
  });

  test('routes skill shell approval requests through the runtime approval flow', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-shell-approval-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-skill-shell-approval-data-'));
    const outsideTarget = path.join(tmpdir(), `lin-agent-skill-shell-outside-${Date.now()}`);
    roots.push(localRoot, dataRoot, outsideTarget);

    await createSkill(localRoot, 'shell-approval-skill', [
      '---',
      'description: Use when checking skill shell approval.',
      '---',
      `Shell output: !\`rm -rf ${outsideTarget} && echo skill-shell-approved\``,
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    await acceptRuntimeSkill(runtime, created.conversationId, 'shell-approval-skill');
    const sendPromise = runtime.sendMessage(created.conversationId, 'Please load the shell approval skill.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected skill shell approval request.');

    expect(approvalEvent.request.toolName).toBe('bash');
    expect(approvalEvent.request.toolCallId).toStartWith('skill-shell-');
    expect(approvalEvent.request.target).toContain(outsideTarget);

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
      outcome: 'ask',
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
            command: 'git push --dry-run origin codex/agent-permissions',
            description: 'Dry-run git push',
          }, { id: 'tool-denied-push' }),
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
      outcome: 'ask',
    });
    expect(permissionResolved).toMatchObject({
      requestId: approvalEvent.requestId,
      status: 'denied',
      resolvedBy: 'user_once',
      deniedReason: 'user_denied',
    });
    const deniedToolResult = events.find((event) => (
      event.type === 'tool_result.created'
      && event.toolCallId === 'tool-denied-push'
    ));
    expect(deniedToolResult?.runId).toBeDefined();
    expect(events.some((event) => (
      event.type === 'run.started'
      && event.runId === deniedToolResult?.runId
    ))).toBe(true);
  });

  test('surfaces hard-denied tool calls as tell-only permission cards', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-deny-notice-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-deny-notice-data-'));
    roots.push(localRoot, dataRoot);

    const followUpContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: '$(cat ./script.sh)',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          safetyMode: 'full_access',
          automaticSkillsEnabled: true,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Run the ambiguous shell command.');

    const noticeEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
      && event.request.kind === 'permission_notice'
    ));
    if (!noticeEvent) throw new Error('Expected permission notice request.');

    expect(noticeEvent.request.title).toContain('Blocked');
    expect(noticeEvent.request.toolName).toBe('bash');
    expect(noticeEvent.request.target).toContain('$(cat ./script.sh)');
    expect(followUpContexts.join('\n')).toContain('permission_denied');
    expect(followUpContexts.join('\n')).toContain('Unknown or ambiguous shell execution.');

    await runtime.resolveApproval(created.conversationId, noticeEvent.requestId, false);

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.find((event) => event.type === 'approval.requested')).toMatchObject({
      requestId: noticeEvent.requestId,
    });
    expect(events.find((event) => event.type === 'approval.resolved')).toMatchObject({
      requestId: noticeEvent.requestId,
      approved: false,
    });
    expect(events.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.requestId === noticeEvent.requestId
    ))).toMatchObject({
      status: 'denied',
      deniedReason: 'platform_hard_block',
    });
  });

  test('persists always-allow approval rules globally', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-always-approval-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-always-approval-data-'));
    roots.push(localRoot, dataRoot);

    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('bash', {
            command: 'rm -rf ./dist',
            description: 'Remove build output',
          }, { id: 'tool-always-rm' }),
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'Clean build output.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected approval request event.');

    expect(approvalEvent.request.alwaysAllowRule).toBe('Action(file.delete.allowed_file_area)');

    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true, 'always');
    await sendPromise;

    const settings = JSON.parse(await readFile(path.join(electronUserDataRoot, 'agent-tool-permissions.json'), 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toContain('Action(file.delete.allowed_file_area)');

    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => (
      event.type === 'tool.permission.resolved'
      && event.status === 'approved'
      && event.resolvedBy === 'allow_rule_update'
      && event.updatedRule === 'Action(file.delete.allowed_file_area)'
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
            command: 'rm -rf ./dist',
            description: 'Remove build output',
          }, { id: 'tool-always-rm-fail' }),
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
      && event.error.includes('Failed to persist always-allow rule; approved once instead.')
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

  test('records configured global allow distinctly with all compound shell action kinds', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-global-allow-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-global-allow-data-'));
    roots.push(localRoot, dataRoot);
    await mkdir(electronUserDataRoot, { recursive: true });
    await writeFile(path.join(electronUserDataRoot, 'agent-tool-permissions.json'), JSON.stringify({
      permissions: {
        allow: ['Action(file.delete.allowed_file_area)'],
      },
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Clean build output without prompting.');

    expect(sink.events.some((event) => event.type === 'approval_request')).toBe(false);
    const events = await new AgentEventStore(dataRoot).readEvents(created.conversationId);
    expect(events.some((event) => (
      event.type === 'tool.permission.checked'
      && event.outcome === 'allow'
      && event.source === 'global_rule'
      && event.primaryActionKind === 'file.delete.allowed_file_area'
      && event.actionKinds.includes('shell.read_search')
      && event.actionKinds.includes('file.delete.allowed_file_area')
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === 'tool.permission.resolved'
      && event.status === 'approved'
      && event.resolvedBy === 'global_rule'
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
            command: 'git push --dry-run origin codex/agent-permissions',
            description: 'Dry-run git push',
          }, { id: 'tool-close-push' }),
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => runtimeSettings,
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn,
      },
    );

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Read the large file.');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextTexts[1]).toContain('<persisted-output>');
    expect(contextTexts[1]).toContain('tool-output-tool-read-large');
    expect(contextTexts[1]!.length).toBeLessThan(40_000);
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Read the file initially.');
    await runtime.sendMessage(created.conversationId, 'Read it again, then continue.');

    expect(script.pendingCount()).toBe(0);
    const retryContext = contextTexts.at(-1) ?? '';
    expect(retryContext).toContain('Recent file context restored after compaction');
    expect(retryContext).toContain(filePath);
    expect(retryContext).toContain('reactive restore body from original full read');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });
});
