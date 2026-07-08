import { afterEach, describe, expect, mock, test } from 'bun:test';
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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import type { ActorRef } from '../../src/core/agentIssue';
import { AgentIssueStore } from '../../src/main/agentIssueStore';
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

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-issue-tools-test-user-data');

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
    getTextSearchIndex: () => undefined,
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async () => {
      throw new Error('No outliner command is expected in this test.');
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

function scriptedStream(
  responses: Array<AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage)>,
  onCall: (model: Model<Api>, context: Context) => void,
): { streamFn: StreamFn; pendingCount: () => number } {
  const queue = [...responses];
  return {
    pendingCount: () => queue.length,
    streamFn: ((model: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
      onCall(model, context);
      const stream = createAssistantMessageEventStream();
      const step = queue.shift();
      queueMicrotask(() => {
        const response = step
          ? typeof step === 'function'
            ? step(context, _options, model)
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

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

const actor: ActorRef = { type: 'agent', agentId: 'built-in:tenon:assistant' };

describe('agent runtime Issue tools', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('applies Issue tool calls without an approval interruption', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-tools-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-tools-data-'));
    roots.push(localRoot, dataRoot);

    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const calls: Array<{ tools: string[] }> = [];
    let issueForToolCall: Awaited<ReturnType<AgentIssueStore['search']>>['rows'][number] | null = null;
    const script = scriptedStream([
      () => {
        if (!issueForToolCall) throw new Error('Issue was not prepared before model call.');
        return fauxAssistantMessage([
          fauxToolCall('issue_update', {
            target: { type: 'issue', id: issueForToolCall.target.id, expectedRevision: issueForToolCall.revision },
            change: { type: 'transition', status: { name: 'Started', category: 'started' } },
            request: { mode: 'request' },
            reason: 'Update the Issue without interrupting the user.',
          }, { id: 'tool-issue-update' }),
        ]);
      },
      fauxAssistantMessage(fauxText('Issue updated.')),
    ], (_model, context) => {
      calls.push({ tools: context.tools?.map((tool) => tool.name) ?? [] });
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
        streamFn: script.streamFn,
      },
    );

    const conversation = await runtime.restoreLatestConversation();
    await store.create({
      issueType: 'issue',
      fields: {
        title: 'Update issue execution',
        trigger: { type: 'when-ready' },
        permissionMode: 'unattended',
      },
      request: { mode: 'request' },
      reason: 'Create executable work.',
    }, actor, 100);
    const issue = (await store.search({ targets: ['issue'] })).rows[0];
    issueForToolCall = issue;
    await runtime.sendMessage(conversation.conversationId, 'Update this issue.');

    expect(script.pendingCount()).toBe(0);
    expect(calls[0]?.tools).toContain('issue_update');
    expect(sink.events.some((event) => event.type === 'approval_request')).toBe(false);
    const read = await store.read({ target: issue.target, include: ['activity'] });
    expect(read.issue?.confirmation.confirmedBy).toEqual(actor);
    expect(read.issue?.status).toMatchObject({ name: 'Started', category: 'started' });
    expect(read.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: { type: 'status-change', from: 'Triage', to: 'Started' },
      }),
    ]));
  });

  test('catch-up materializes due Recurring Issues and starts Agent Sessions', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-scheduler-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-scheduler-data-'));
    roots.push(localRoot, dataRoot);

    const calls: Array<{ tools: string[]; text: string }> = [];
    const script = scriptedStream([
      fauxAssistantMessage(fauxText('Daily recurring work completed.')),
    ], (_model, context) => {
      calls.push({
        tools: context.tools?.map((tool) => tool.name) ?? [],
        text: JSON.stringify(context.messages),
      });
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
        streamFn: script.streamFn,
      },
    );
    await runtime.restoreLatestConversation();

    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const createdAt = Date.now() - 48 * 60 * 60 * 1000;
    const dueHour = (new Date().getHours() + 23) % 24;
    const dueTime = `${String(dueHour).padStart(2, '0')}:00`;
    await store.create({
      issueType: 'recurring-issue',
      fields: {
        titleTemplate: 'Runtime daily report',
        cadence: { type: 'daily', time: dueTime },
        timeZone: 'Local',
        issueTemplate: {
          delegate: { type: 'default-agent', runProfile: 'background' },
          trigger: { type: 'when-ready' },
          permissionMode: 'unattended',
          output: { type: 'activity-only' },
        },
      },
      request: { mode: 'request' },
      reason: 'Create due recurring work.',
    }, actor, createdAt);
    const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];

    runtime.runIssueCatchUp();
    await waitFor(async () => {
      const state = await store.state();
      const sessions = Object.values(state.sessions);
      return Object.keys(state.issues).length === 1
        && sessions.length === 1
        && sessions[0].state !== 'pending'
        && script.pendingCount() === 0;
    }, 2_000);

    const read = await store.read({ target: recurring.target, include: ['generated-issues', 'activity'] });
    const generated = read.generatedIssues?.[0];
    expect(generated?.title).toContain('Runtime daily report');
    expect(generated?.recurrence?.recurringIssueId).toBe(recurring.target.id);
    const sessions = Object.values((await store.state()).sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      issueId: generated?.id,
      source: {
        type: 'recurring-issue',
        recurringIssueId: recurring.target.id,
        dueAt: generated?.recurrence?.windowStartAt,
      },
    });
    expect(['active', 'complete']).toContain(sessions[0].state);
    expect(calls[0]?.tools).toContain('issue_search');
    expect(calls[0]?.text).toContain('You are executing one Agent Session for a Tenon Issue.');
    expect(script.pendingCount()).toBe(0);
    expect(read.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.objectContaining({ type: 'agent-action', action: 'materialize' }),
      }),
    ]));
  });
});
