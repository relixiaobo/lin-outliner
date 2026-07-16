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
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import type { AgentRunBudget, AgentRunScope } from '../../src/core/agentEventLog';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import type { ActorRef } from '../../src/core/agentIssue';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { AgentIssueStore } from '../../src/main/agentIssueStore';
import type { AgentChildAgentCreateInput, AgentDelegationRuntime } from '../../src/main/agentDelegation';
import type { AgentSessionExecutor } from '../../src/main/agentIssueRuntime';
import type { AgentIssueToolRuntime } from '../../src/main/agentIssueTools';
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

function dynamicStream(
  respond: (context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage,
  onCall: (model: Model<Api>, context: Context) => void,
): StreamFn {
  return ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    onCall(model, context);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const response = normalizeAssistantMessage(respond(context, options, model), model);
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        stream.push({ type: 'error', reason: response.stopReason, error: response });
        stream.end(response);
        return;
      }
      stream.push({ type: 'start', partial: { ...response, content: [] } });
      stream.push({ type: 'done', reason: response.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message: response });
      stream.end(response);
    });
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

function latestContextMessage(context: Context): string {
  return JSON.stringify(context.messages.at(-1));
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
const drainableRuntimes: Array<{ drainPendingWrites(): Promise<void> }> = [];

interface IssueRuntimeInternals {
  conversations: Map<string, { delegationRuntime: AgentDelegationRuntime }>;
  createIssueSessionExecutor(
    getDelegationRuntime: () => AgentDelegationRuntime | null,
    getConversationId: () => string,
  ): AgentSessionExecutor;
  createIssueToolRuntime(
    agentId: string,
    executor?: AgentSessionExecutor,
    originContext?: () => { conversationId?: string | null; executionId?: string | null },
  ): AgentIssueToolRuntime;
}

describe('agent runtime Issue tools', () => {
  const roots: string[] = [];

  beforeEach(async () => {
    const { resetFolderCapabilityServiceForTests } = await import('../../src/main/agentToolPermissionStore');
    resetFolderCapabilityServiceForTests();
    await rm(electronUserDataRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    const { resetFolderCapabilityServiceForTests } = await import('../../src/main/agentToolPermissionStore');
    resetFolderCapabilityServiceForTests();
    await Promise.allSettled(drainableRuntimes.splice(0).map((runtime) => runtime.drainPendingWrites()));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    await rm(electronUserDataRoot, { recursive: true, force: true });
    roots.length = 0;
  });

  test('fails closed when Issue Session origin ownership cannot be resolved', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-origin-fail-closed-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-origin-fail-closed-data-'));
    roots.push(localRoot, dataRoot);

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
      () => null,
      hostFor(Core.new()),
      { agentDataRoot: dataRoot, localFileRoot: localRoot },
    );
    drainableRuntimes.push(runtime);
    const internals = runtime as unknown as IssueRuntimeInternals;

    const orphanInternalRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      undefined,
      () => ({ conversationId: 'lin-agent-issue-orphaned-binding' }),
    );
    await expect(orphanInternalRuntime.search({ targets: ['issue'] }))
      .rejects.toThrow('has no Agent Session execution binding');

    const eventStore = new AgentEventStore(dataRoot);
    (runtime as unknown as { eventStore: AgentEventStore | null }).eventStore = eventStore;
    const originalReadRunMetaProjection = eventStore.readRunMetaProjection.bind(eventStore);
    eventStore.readRunMetaProjection = async () => {
      throw new Error('simulated run ownership read failure');
    };
    const nestedVisibleRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      undefined,
      () => ({ conversationId: 'lin-agent-channel-visible', executionId: 'run:nested-origin' }),
    );
    await expect(nestedVisibleRuntime.search({ targets: ['issue'] }))
      .rejects.toThrow('simulated run ownership read failure');
    eventStore.readRunMetaProjection = originalReadRunMetaProjection;

    const missingMetaRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      undefined,
      () => ({ conversationId: 'lin-agent-channel-visible', executionId: 'run:missing-origin' }),
    );
    await expect(missingMetaRuntime.search({ targets: ['issue'] }))
      .rejects.toThrow('has no ownership metadata');

    eventStore.readRunMetaProjection = async (runId) => ({
      id: runId,
      conversationId: 'lin-agent-channel-visible',
      parentRunId: runId,
      purpose: 'work',
      objectiveRole: 'worker',
      execution: { status: 'running' },
      createdAt: 1,
      updatedAt: 1,
      latestSeq: 1,
    });
    const cyclicMetaRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      undefined,
      () => ({ conversationId: 'lin-agent-channel-visible', executionId: 'run:cyclic-origin' }),
    );
    await expect(cyclicMetaRuntime.search({ targets: ['issue'] }))
      .rejects.toThrow('ownership chain contains a cycle');
    eventStore.readRunMetaProjection = originalReadRunMetaProjection;
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
    drainableRuntimes.push(runtime);

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

  test('starts a when-ready unattended Issue after issue_create without an explicit session_start tool call', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-autostart-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-autostart-data-'));
    roots.push(localRoot, dataRoot);

    let issueCreateCalled = false;
    let agentSessionReadCalled = false;
    let sessionIdToRead: string | null = null;
    const callKinds: string[] = [];
    const sessionReadContexts: string[] = [];
    const rootDeliveryContexts: string[] = [];
    const streamFn = dynamicStream((context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (serializedMessages.includes('You are executing one Agent Session for a Tenon Issue.')) {
        return fauxAssistantMessage(fauxText('Weather issue execution result.'));
      }
      if (latestContextMessage(context).includes('<root-issue-delivery')) {
        rootDeliveryContexts.push(serializedMessages);
        return fauxAssistantMessage(fauxText('Weather issue execution result delivered to the user.'));
      }
      if (sessionIdToRead) {
        sessionReadContexts.push(serializedMessages);
        if (!agentSessionReadCalled) {
          agentSessionReadCalled = true;
          return fauxAssistantMessage([
            fauxToolCall('agent_session_read', {
              agentSessionId: sessionIdToRead,
              wait: true,
              timeoutMs: 1_000,
            }, { id: 'tool-agent-session-read' }),
          ]);
        }
      }
      if (!issueCreateCalled) {
        issueCreateCalled = true;
        return fauxAssistantMessage([
          fauxToolCall('issue_create', {
            issueType: 'issue',
            fields: {
              title: 'Query Beijing district weather',
              description: 'Query current weather for all Beijing districts and summarize coverage, source, update time, and missing fields.',
              delegate: { type: 'default-agent', runProfile: 'background' },
              trigger: { type: 'when-ready' },
              completionCriteria: [{
                id: 'weather-summary',
                text: 'A Beijing district weather summary is produced with sources and update time.',
                state: 'open',
              }],
              output: { type: 'activity-only' },
              permissionMode: 'unattended',
            },
            request: { mode: 'request' },
            reason: 'Create durable weather work and let runtime execute it when ready.',
          }, { id: 'tool-issue-create' }),
        ]);
      }
      return fauxAssistantMessage(fauxText('Created and handed off.'));
    }, (_model, context) => {
      const serializedMessages = JSON.stringify(context.messages);
      callKinds.push(
        serializedMessages.includes('You are executing one Agent Session for a Tenon Issue.')
          ? 'issue-session'
          : latestContextMessage(context).includes('<root-issue-delivery')
            ? 'root-issue-delivery'
          : serializedMessages.includes('<agent-run-notification')
            ? 'issue-notification'
            : 'conversation',
      );
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
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    await runtime.sendMessage(conversation.conversationId, 'Create and execute a Beijing district weather Issue.');

    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await waitFor(async () => {
      const state = await store.state();
      return Object.values(state.sessions).some((session) => session.state === 'complete')
        && Object.values(state.issues).some((issue) => issue.status.category === 'completed');
    }, 2_000);

    expect(callKinds).toContain('issue-session');
    await waitFor(async () => {
      const deliveries = Object.values((await store.state()).terminalDeliveries);
      return deliveries.length === 1 && deliveries[0]?.status === 'delivered';
    }, 5_000);
    const deliveredResponse = await runtime.restoreConversation(conversation.conversationId);
    expect(JSON.stringify(deliveredResponse.renderProjection))
      .toContain('Weather issue execution result delivered to the user.');
    expect(Object.values(deliveredResponse.renderProjection.entities.messages).find((message) => (
      message.issueNotification !== undefined
    ))?.issueNotification?.title).toBe('Query Beijing district weather');
    expect(callKinds).toContain('root-issue-delivery');
    expect(callKinds).not.toContain('issue-notification');
    expect(rootDeliveryContexts).toHaveLength(1);
    expect(rootDeliveryContexts[0]).toContain('Weather issue execution result.');
    expect((await runtime.listConversations()).map((entry) => entry.title)).not.toContain('Query Beijing district weather');
    expect(sink.events.some((event) => event.type === 'approval_request')).toBe(false);
    const state = await store.state();
    expect(Object.values(state.sessions)).toHaveLength(1);
    const session = Object.values(state.sessions)[0];
    expect(session?.latestOutput).toContain('Weather issue execution result');
    expect(session?.issueSnapshot.origin).toMatchObject({
      type: 'conversation',
      conversationId: conversation.conversationId,
    });
    expect(Object.values(state.issues)[0]?.completionCriteria?.[0]?.state).toBe('met');
    const binding = await store.executionForSession(session!.id);
    expect(binding).not.toBeNull();
    const conversationEvents = await new AgentEventStore(dataRoot)
      .readConversationStreamEvents(conversation.conversationId);
    expect(conversationEvents.some((event) => (
      event.type === 'notification.created'
      && event.source?.type === 'run'
      && event.source.runId === binding!.executionId
    ))).toBe(false);
    const transcript = await runtime.agentSessionTranscript(session!.id);
    expect(transcript?.agentSessionId).toBe(session!.id);
    expect(transcript?.run.runId).toBe(transcript?.runId);
    expect(JSON.stringify(transcript?.transcript.messages)).toContain('Weather issue execution result');

    const deliveredIssueResults = async () => {
      const restored = await runtime.restoreConversation(conversation.conversationId);
      return Object.values(restored.renderProjection.entities.messages).filter((message) => (
        message.runId?.startsWith('issue-delivery-run-')
        && JSON.stringify(message.content).includes('Weather issue execution result delivered to the user.')
      ));
    };
    expect(await deliveredIssueResults()).toHaveLength(1);
    const deliveredProjection = await runtime.restoreConversation(conversation.conversationId);
    const hiddenDeliveryPrompts = Object.values(deliveredProjection.renderProjection.entities.messages).filter((message) => (
      message.role === 'user'
      && message.actor.type === 'system'
      && JSON.stringify(message.content).includes('<root-issue-delivery')
    ));
    expect(hiddenDeliveryPrompts).toHaveLength(1);
    const deliveredIssueResult = (await deliveredIssueResults())[0]!;
    const hiddenDeliveryPrompt = hiddenDeliveryPrompts[0]!;
    expect(deliveredIssueResult.parentMessageId).toBe(hiddenDeliveryPrompt.id);
    const previousAssistant = hiddenDeliveryPrompt.parentMessageId
      ? deliveredProjection.renderProjection.entities.messages[hiddenDeliveryPrompt.parentMessageId]
      : undefined;
    expect(previousAssistant?.role).toBe('assistant');
    expect(previousAssistant?.runId).not.toBe(deliveredIssueResult.runId);
    await runtime.readAgentSession({ agentSessionId: session!.id, include: ['latest-output'] });
    await runtime.readAgentSession({ agentSessionId: session!.id, include: ['latest-output'] });
    expect(await deliveredIssueResults()).toHaveLength(1);

    sessionIdToRead = session?.id ?? null;
    expect(sessionIdToRead).toBeTruthy();
    await runtime.sendMessage(conversation.conversationId, 'Read the completed Agent Session.');

    expect(agentSessionReadCalled).toBe(true);
    expect(sessionReadContexts.some((text) => text.includes('Weather issue execution result'))).toBe(true);
    expect(sessionReadContexts.some((text) => text.includes('Unknown run'))).toBe(false);
  });

  test('retries an unattended Agent Session after a durable folder capability grant', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-folder-retry-root-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-folder-retry-outside-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-folder-retry-data-'));
    roots.push(localRoot, outsideRoot, dataRoot);
    const outsideFile = path.join(outsideRoot, 'source.txt');
    await writeFile(outsideFile, 'persistent-folder-content');
    const canonicalOutsideRoot = await realpath(outsideRoot);

    let issueCreated = false;
    let sessionToolCalls = 0;
    const streamFn = dynamicStream((context) => {
      const serialized = JSON.stringify(context.messages);
      if (latestContextMessage(context).includes('<root-issue-delivery')) {
        return fauxAssistantMessage(fauxText('Folder retry result delivered.'));
      }
      if (serialized.includes('You are executing one Agent Session for a Tenon Issue.')) {
        if (serialized.includes('persistent-folder-content')) {
          return fauxAssistantMessage(fauxText('Folder retry completed from the granted source.'));
        }
        sessionToolCalls += 1;
        return fauxAssistantMessage([
          fauxToolCall('file_read', {
            file_path: outsideFile,
          }, { id: `tool-unattended-folder-${sessionToolCalls}` }),
        ], { stopReason: 'toolUse' });
      }
      if (!issueCreated) {
        issueCreated = true;
        return fauxAssistantMessage([
          fauxToolCall('issue_create', {
            issueType: 'issue',
            fields: {
              title: 'Read an external durable source',
              description: 'Read the external source and report its content.',
              trigger: { type: 'when-ready' },
              permissionMode: 'unattended',
            },
            request: { mode: 'request' },
            reason: 'Create durable work that requires a folder capability.',
          }, { id: 'tool-create-folder-retry-issue' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(fauxText('Folder work handed off.'));
    }, () => undefined);

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
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    await runtime.sendMessage(conversation.conversationId, 'Create background work for the external source.');
    await waitFor(() => sink.events.some((event) => (
      event.type === 'approval_request'
      && event.conversationId === conversation.conversationId
    )), 3_000);
    const approval = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
      && event.conversationId === conversation.conversationId
    ));
    if (!approval) throw new Error('Expected durable folder capability request.');
    expect(approval.request.folders).toEqual([canonicalOutsideRoot]);

    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await waitFor(async () => Object.values((await store.state()).sessions).some((session) => session.state === 'error'), 3_000);
    const beforeGrant = await store.state();
    const failedSession = Object.values(beforeGrant.sessions)[0]!;
    expect(failedSession.errorMessage).toContain('required folder capability is missing');
    const restoredPending = await runtime.restoreConversation(conversation.conversationId);
    expect(restoredPending.pendingApprovals?.map((request) => request.requestId)).toContain(approval.requestId);

    await runtime.resolveApproval(conversation.conversationId, approval.requestId, true);
    await waitFor(async () => {
      const state = await store.state();
      return Object.values(state.sessions).length === 2
        && Object.values(state.sessions).some((session) => session.state === 'complete')
        && Object.values(state.issues).some((issue) => issue.status.category === 'completed');
    }, 5_000);
    await waitFor(async () => {
      const deliveries = Object.values((await store.state()).terminalDeliveries);
      return deliveries.length === 1 && deliveries[0]?.status === 'delivered';
    }, 5_000);

    const afterGrant = await store.state();
    const sessions = Object.values(afterGrant.sessions).sort((left, right) => left.createdAt - right.createdAt);
    expect(sessions[0]?.state).toBe('error');
    expect(sessions[1]).toMatchObject({
      state: 'complete',
      continuationOfAgentSessionId: sessions[0]?.id,
    });
    expect(sessions[1]?.latestOutput).toContain('Folder retry completed from the granted source.');
    expect(sessionToolCalls).toBe(2);

    const restoredResolved = await runtime.restoreConversation(conversation.conversationId);
    expect(restoredResolved.pendingApprovals ?? []).toHaveLength(0);
    const originEvents = await new AgentEventStore(dataRoot)
      .readConversationStreamEvents(conversation.conversationId);
    expect(originEvents.find((event) => (
      event.type === 'notification.created'
      && event.folderCapability?.requestId === approval.requestId
    ))).toMatchObject({ kind: 'needs_input' });
    expect(originEvents.find((event) => (
      event.type === 'tool.permission.resolved'
      && event.requestId === approval.requestId
    ))).toMatchObject({ status: 'approved', resolvedBy: 'folder_grant' });
  });

  test('keeps an active conversation turn alive across same-process restore', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-active-restore-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-active-restore-data-'));
    roots.push(localRoot, dataRoot);

    let releaseResponse!: () => void;
    let markProviderStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let providerCalls = 0;
    let providerSignal: AbortSignal | undefined;
    const streamFn = ((model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      providerCalls += 1;
      providerSignal = options?.signal;
      markProviderStarted();
      const stream = createAssistantMessageEventStream();
      void responseGate.then(() => {
        const response = normalizeAssistantMessage(
          fauxAssistantMessage(fauxText('Active response survived restore.')),
          model,
        );
        stream.push({ type: 'start', partial: { ...response, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message: response });
        stream.end(response);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as {
      conversations: Map<string, unknown>;
    };
    const originalRuntime = internals.conversations.get(conversation.conversationId);
    const send = runtime.sendMessage(conversation.conversationId, 'Keep this response alive during restore.');
    await providerStarted;

    const restored = await runtime.restoreConversation(conversation.conversationId);

    expect(restored.conversationId).toBe(conversation.conversationId);
    expect(internals.conversations.get(conversation.conversationId)).toBe(originalRuntime);
    expect(providerSignal?.aborted).toBe(false);

    releaseResponse();
    await send;

    expect(providerCalls).toBe(1);
    expect(providerSignal?.aborted).toBe(false);
    const completed = await runtime.restoreConversation(conversation.conversationId);
    expect(JSON.stringify(completed.renderProjection)).toContain('Active response survived restore.');
  });

  test('acknowledges a root delivery when the Agent ends without a visible response', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-empty-root-delivery-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-empty-root-delivery-data-'));
    roots.push(localRoot, dataRoot);

    let deliveryAttempts = 0;
    const streamFn = dynamicStream((context) => {
      if (!latestContextMessage(context).includes('<root-issue-delivery')) {
        return fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'Unexpected non-delivery provider call.',
        });
      }
      deliveryAttempts += 1;
      expect(latestContextMessage(context)).toContain('does not require a visible reply');
      return fauxAssistantMessage([]);
    }, () => undefined);

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await store.create({
      issueType: 'issue',
      fields: { title: 'Retry empty root delivery' },
      request: { mode: 'request' },
      reason: 'Create empty root delivery retry work.',
    }, actor, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await store.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start empty root delivery retry work.',
    }, { type: 'runtime-action', actor }, actor, 110);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await store.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: 'execution:empty-root-delivery',
      startedAt: 120,
    }, actor, 120);
    await store.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:empty-root-delivery',
      state: 'completed',
      latestOutput: 'Authoritative root result.',
      completedAt: 130,
    }, actor, 130);

    const internals = runtime as unknown as {
      drainTerminalIssueDeliveries(): Promise<void>;
      issueDeliveryRetryNotBefore: Map<string, number>;
    };
    await internals.drainTerminalIssueDeliveries();
    internals.issueDeliveryRetryNotBefore.clear();
    await internals.drainTerminalIssueDeliveries();

    expect(deliveryAttempts).toBe(1);
    expect(Object.values((await store.state()).terminalDeliveries)[0]?.status).toBe('delivered');
    const restored = await runtime.restoreConversation(conversation.conversationId);
    const deliveryMessages = Object.values(restored.renderProjection.entities.messages).filter((message) => (
      message.runId?.startsWith('issue-delivery-run-')
    ));
    expect(deliveryMessages).toHaveLength(1);
    expect(deliveryMessages[0]?.content).toEqual([]);
  });

  test('keeps a reactive-compaction retry inside the same root delivery attempt', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-root-delivery-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-reactive-root-delivery-data-'));
    roots.push(localRoot, dataRoot);

    let providerCalls = 0;
    const streamFn = dynamicStream((context) => {
      expect(JSON.stringify(context.messages)).toContain('<root-issue-delivery');
      providerCalls += 1;
      return providerCalls === 1
        ? fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt too long: context length exceeded',
        })
        : fauxAssistantMessage(fauxText('Root delivery recovered after reactive compact.'));
    }, () => undefined);

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
        runtimeSettingsLoader: async () => ({
          automaticSkillsEnabled: false,
          slashSkillsEnabled: true,
          compactEnabled: true,
          additionalSkillDirectories: [],
        }),
        streamFn,
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>root delivery</analysis><summary>Root delivery compact summary.</summary>'),
          model as Model<Api>,
        ),
      },
    );
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await store.create({
      issueType: 'issue',
      fields: { title: 'Reactive root delivery' },
      request: { mode: 'request' },
      reason: 'Create reactive root delivery work.',
    }, actor, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await store.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start reactive root delivery work.',
    }, { type: 'runtime-action', actor }, actor, 110);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await store.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: 'execution:reactive-root-delivery',
      startedAt: 120,
    }, actor, 120);
    await store.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:reactive-root-delivery',
      state: 'completed',
      latestOutput: 'Authoritative reactive root result.',
      completedAt: 130,
    }, actor, 130);

    const internals = runtime as unknown as {
      drainTerminalIssueDeliveries(): Promise<void>;
    };
    await internals.drainTerminalIssueDeliveries();

    const delivery = Object.values((await store.state()).terminalDeliveries)[0]!;
    expect(delivery).toMatchObject({
      status: 'delivered',
      attemptCount: 1,
    });
    expect(providerCalls).toBe(2);

    const restored = await runtime.restoreConversation(conversation.conversationId);
    const messages = Object.values(restored.renderProjection.entities.messages);
    const hiddenDeliveryPrompts = messages.filter((message) => (
      message.role === 'user'
      && message.actor.type === 'system'
      && JSON.stringify(message.content).includes('<root-issue-delivery')
    ));
    expect(hiddenDeliveryPrompts).toHaveLength(1);
    const finalResponses = messages.filter((message) => (
      message.role === 'assistant'
      && JSON.stringify(message.content).includes('Root delivery recovered after reactive compact.')
    ));
    expect(finalResponses).toHaveLength(1);
    expect(finalResponses[0]?.runId).toMatch(/^issue-delivery-run-.+-1-reactive$/);

    await internals.drainTerminalIssueDeliveries();
    expect(providerCalls).toBe(2);
    expect(Object.values((await store.state()).terminalDeliveries)[0]?.attemptCount).toBe(1);
  });

  test('retains a live detached Agent Session across close and same-process reopen', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-close-reopen-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-close-reopen-data-'));
    roots.push(localRoot, dataRoot);

    let releaseExecution!: () => void;
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    const streamFn = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const serializedMessages = JSON.stringify(context.messages);
      if (!serializedMessages.includes('Close/reopen detached Session')) {
        queueMicrotask(() => {
          const response = normalizeAssistantMessage(
            fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Unexpected provider call.' }),
            model,
          );
          stream.push({ type: 'error', reason: 'error', error: response });
          stream.end(response);
        });
        return stream;
      }
      executionSignal = options?.signal;
      markExecutionStarted();
      void executionGate.then(() => {
        const response = normalizeAssistantMessage(
          fauxAssistantMessage(fauxText('Detached Session survived close and reopen.')),
          model,
        );
        stream.push({ type: 'start', partial: { ...response, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message: response });
        stream.end(response);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const originalConversation = internals.conversations.get(conversation.conversationId)!;
    const executor = internals.createIssueSessionExecutor(
      () => originalConversation.delegationRuntime,
      () => conversation.conversationId,
    );
    const issueRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      executor,
      () => ({ conversationId: conversation.conversationId }),
    );
    const created = await issueRuntime.create({
      issueType: 'issue',
      fields: {
        title: 'Close/reopen detached Session',
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Exercise same-process headless retention.',
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueRuntime.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueRuntime.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      detach: true,
      request: { mode: 'request' },
      reason: 'Start detached work before closing the Channel.',
    });
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await executionStarted;
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const binding = await store.executionForSession(sessionId);
    expect(binding).not.toBeNull();
    const liveRun = (originalConversation.delegationRuntime as unknown as {
      runs: Map<string, { budgetTimerRefresh?: () => void }>;
    }).runs.get(binding!.executionId)!;
    expect(typeof liveRun.budgetTimerRefresh).toBe('function');
    const originalBudgetTimerRefresh = liveRun.budgetTimerRefresh!;
    let budgetTimerRefreshCount = 0;
    liveRun.budgetTimerRefresh = () => {
      budgetTimerRefreshCount += 1;
      originalBudgetTimerRefresh();
    };
    await runtime.runAmend(conversation.conversationId, binding!.executionId, {
      budget: { deadlineAt: Date.now() + 5 * 60_000 },
    });
    liveRun.budgetTimerRefresh = originalBudgetTimerRefresh;
    expect(budgetTimerRefreshCount).toBe(1);
    expect(executionSignal?.aborted).toBe(false);

    runtime.closeConversation(conversation.conversationId);
    const reopened = await runtime.restoreConversation(conversation.conversationId);

    expect(reopened.conversationId).toBe(conversation.conversationId);
    expect(internals.conversations.get(conversation.conversationId)).toBe(originalConversation);
    expect(executionSignal?.aborted).toBe(false);
    expect((await new AgentEventStore(dataRoot).readRunMetaProjection(binding!.executionId))?.execution.status).toBe('running');

    releaseExecution();
    await waitFor(async () => (
      (await store.readSession({ agentSessionId: sessionId }))?.agentSession.state === 'complete'
    ), 2_000);
    expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.latestOutput)
      .toBe('Detached Session survived close and reopen.');
    const runEvents = await new AgentEventStore(dataRoot).readRunStreamEvents(binding!.executionId);
    expect(runEvents.filter((event) => event.type === 'run.failed')).toHaveLength(0);
    expect(runEvents.filter((event) => event.type === 'run.completed')).toHaveLength(1);
  });

  test('binds an attended Agent Session before it creates a child Issue', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-attended-origin-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-attended-origin-data-'));
    roots.push(localRoot, dataRoot);

    let rootIssueId = '';
    let rootIssueRevision = '';
    let startRequested = false;
    let childIssueCreated = false;
    let parentResumeCount = 0;
    const streamFn = dynamicStream((context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (latestContextMessage(context).includes('<root-issue-delivery')) {
        return fauxAssistantMessage(fauxText('Attended root result delivered independently.'));
      }
      const isIssueSession = serializedMessages.includes('You are executing one Agent Session for a Tenon Issue.');
      if (isIssueSession && serializedMessages.includes('<child-issue-delivery')) {
        parentResumeCount += 1;
        return fauxAssistantMessage([]);
      }
      if (isIssueSession && serializedMessages.includes('Attended root routing issue')) {
        if (!childIssueCreated) {
          childIssueCreated = true;
          return fauxAssistantMessage([
            fauxToolCall('issue_create', {
              issueType: 'issue',
              fields: {
                title: 'Attended child routing issue',
                description: 'Produce the child result required by the attended parent Agent Session.',
                trigger: { type: 'when-ready' },
                permissionMode: 'unattended',
              },
              request: { mode: 'request' },
              reason: 'Create durable child work while the attended parent execution is still running.',
            }, { id: 'tool-create-attended-child-issue' }),
          ]);
        }
        return fauxAssistantMessage(fauxText('Attended parent session is waiting for its child Issue.'));
      }
      if (isIssueSession && serializedMessages.includes('Attended child routing issue')) {
        return fauxAssistantMessage(fauxText('Attended child routing result.'));
      }
      if (!startRequested) {
        startRequested = true;
        return fauxAssistantMessage([
          fauxToolCall('agent_session_start', {
            issueId: rootIssueId,
            expectedIssueRevision: rootIssueRevision,
            detach: false,
            request: { mode: 'request' },
            reason: 'Run the parent synchronously and preserve child Issue origin routing.',
          }, { id: 'tool-start-attended-root-session' }),
        ]);
      }
      return fauxAssistantMessage(fauxText('Attended root execution returned.'));
    }, () => undefined);

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await store.create({
      issueType: 'issue',
      fields: {
        title: 'Attended root routing issue',
        description: 'Create a child Issue while this non-detached Agent Session is running.',
        trigger: { type: 'when-ready' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create the attended routing fixture.',
    }, actor, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const rootRow = (await store.search({ targets: ['issue'] })).rows[0];
    rootIssueId = rootRow.target.id;
    rootIssueRevision = rootRow.revision;

    await runtime.sendMessage(conversation.conversationId, 'Start the attended Issue and integrate its child result.');
    await waitFor(async () => {
      const state = await store.state();
      const deliveries = Object.values(state.terminalDeliveries);
      return Object.values(state.issues).length === 2
        && Object.values(state.issues).every((issue) => issue.status.category === 'completed')
        && Object.values(state.sessions).length === 2
        && Object.values(state.sessions).every((session) => session.state === 'complete')
        && deliveries.length === 2
        && deliveries.every((delivery) => delivery.status === 'delivered');
    }, 5_000);

    const state = await store.state();
    const rootIssue = state.issues[rootIssueId];
    const childIssue = Object.values(state.issues).find((issue) => issue.title === 'Attended child routing issue');
    const rootSession = Object.values(state.sessions).find((session) => session.issueId === rootIssueId);
    const rootBinding = rootSession ? await store.executionForSession(rootSession.id) : null;
    if (!rootBinding) throw new Error('Expected an execution binding for the attended root Session.');
    const rootRunEvents = await new AgentEventStore(dataRoot).readRunStreamEvents(rootBinding.executionId);
    const permissionIndex = rootRunEvents.findIndex((event) => event.type === 'tool.permission.checked');
    const toolResultIndex = rootRunEvents.findIndex((event) => event.type === 'tool_result.created');
    expect(rootIssue?.origin).toEqual({ type: 'conversation', conversationId: conversation.conversationId });
    expect(childIssue).toMatchObject({
      parentIssueId: rootIssueId,
      origin: { type: 'agent-session', agentSessionId: rootSession?.id },
    });
    expect(parentResumeCount).toBe(1);
    expect(rootSession?.latestOutput).toBe('Run completed without a text result.');
    expect(rootRunEvents.map((event) => event.seq)).toEqual(rootRunEvents.map((event) => event.seq).sort((a, b) => a - b));
    expect(permissionIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBeGreaterThan(permissionIndex);
    expect(Object.values(state.terminalDeliveries)).toHaveLength(2);
    expect(Object.values(state.terminalDeliveries).every((delivery) => delivery.status === 'delivered')).toBe(true);

    await waitFor(async () => {
      const restored = await runtime.restoreConversation(conversation.conversationId);
      return Object.values(restored.renderProjection.entities.messages).some((message) => (
        message.runId?.startsWith('issue-delivery-run-')
        && JSON.stringify(message.content).includes('Attended root result delivered independently.')
      ));
    }, 2_000);
    const restored = await runtime.restoreConversation(conversation.conversationId);
    const deliveredResults = Object.values(restored.renderProjection.entities.messages).filter((message) => (
      message.runId?.startsWith('issue-delivery-run-')
    ));
    expect(deliveredResults).toHaveLength(1);
    expect(JSON.stringify(deliveredResults[0]?.content)).toContain('Attended root result delivered independently.');
    expect(JSON.stringify(deliveredResults[0]?.content)).not.toContain('Attended parent session is waiting for its child Issue.');
    expect(JSON.stringify(deliveredResults[0]?.content)).not.toContain('Attended child routing result.');
  });

  test('replans a turn-owned verified Agent Session in place without generic Run notification', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-controller-replan-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-controller-replan-data-'));
    roots.push(localRoot, dataRoot);

    let issueId = '';
    let issueRevision = '';
    let startRequested = false;
    let verifierAttempts = 0;
    let replanCount = 0;
    let genericRunNotificationCalls = 0;
    const streamFn = dynamicStream((context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (serializedMessages.includes('<agent-run-notification')) {
        genericRunNotificationCalls += 1;
        return fauxAssistantMessage(fauxText('Unexpected generic Run notification.'));
      }
      if (serializedMessages.includes('You are an independent verifier Run.')) {
        verifierAttempts += 1;
        return fauxAssistantMessage(fauxText(verifierAttempts === 1
          ? '{"verdict":"fail","gap":"Address the acceptance criterion directly."}'
          : '{"verdict":"pass","gap":""}'));
      }
      if (serializedMessages.includes('You are executing one Agent Session for a Tenon Issue.')) {
        if (serializedMessages.includes('Your previous submission did not pass independent verification.')) {
          replanCount += 1;
          return fauxAssistantMessage(fauxText('Replanned verified Session result.'));
        }
        return fauxAssistantMessage(fauxText('Initial Session result requiring revision.'));
      }
      if (!startRequested) {
        startRequested = true;
        return fauxAssistantMessage([
          fauxToolCall('agent_session_start', {
            issueId,
            expectedIssueRevision: issueRevision,
            detach: false,
            request: { mode: 'request' },
            reason: 'Run the verified Agent Session synchronously from the visible turn.',
          }, { id: 'tool-start-controller-replan-session' }),
        ]);
      }
      return fauxAssistantMessage(fauxText('Verified Session finished.'));
    }, () => undefined);

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
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await store.create({
      issueType: 'issue',
      fields: {
        title: 'Turn-owned verified Session',
        completionCriteria: [{ id: 'verified-result', text: 'Return the verified result.', state: 'open' }],
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create a verified Session fixture owned by a visible turn.',
    }, actor, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const issueRow = (await store.search({ targets: ['issue'] })).rows[0]!;
    issueId = issueRow.target.id;
    issueRevision = issueRow.revision;

    await runtime.sendMessage(conversation.conversationId, 'Start the verified Agent Session.');
    await waitFor(async () => {
      const state = await store.state();
      return state.issues[issueId]?.status.category === 'completed'
        && Object.values(state.sessions).some((session) => session.issueId === issueId && session.state === 'complete');
    }, 2_000);

    const state = await store.state();
    const session = Object.values(state.sessions).find((candidate) => candidate.issueId === issueId)!;
    const binding = await store.executionForSession(session.id);
    expect(binding).not.toBeNull();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const delegationRuns = (internals.conversations.get(conversation.conversationId)!.delegationRuntime as unknown as {
      runs: Map<string, {
        id: string;
        parentRunId?: string;
        purpose?: string;
        objectiveRole?: string;
        objectiveStatus?: string;
      }>;
    }).runs;
    const boundRun = delegationRuns.get(binding!.executionId);
    const siblingWorkRuns = [...delegationRuns.values()].filter((run) => (
      run.id !== binding!.executionId
      && run.purpose !== 'verify'
      && run.parentRunId === boundRun?.parentRunId
    ));
    const eventStore = new AgentEventStore(dataRoot);
    const [runEvents, conversationEvents] = await Promise.all([
      eventStore.readRunStreamEvents(binding!.executionId),
      eventStore.readConversationStreamEvents(conversation.conversationId),
    ]);

    expect(boundRun).toMatchObject({
      parentRunId: expect.any(String),
      objectiveRole: 'controller',
      objectiveStatus: 'verified',
    });
    expect(siblingWorkRuns).toHaveLength(0);
    expect(verifierAttempts).toBe(2);
    expect(replanCount).toBe(1);
    expect(session.latestOutput).toBe('Replanned verified Session result.');
    expect(genericRunNotificationCalls).toBe(0);
    expect(conversationEvents.some((event) => (
      event.type === 'notification.created'
      && event.source?.type === 'run'
      && event.source.runId === binding!.executionId
    ))).toBe(false);
    expect(runEvents.some((event) => (
      event.type === 'run.started' && event.objectiveRole === 'controller'
    ))).toBe(true);
  });

  test('runs explicit verifier Sessions with clean context and read-only tools', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-data-'));
    roots.push(localRoot, dataRoot);

    let issueId = '';
    let issueRevision = '';
    let startRequested = false;
    let verifierTools: string[] = [];
    let verifierContext = '';
    const streamFn = dynamicStream((context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (serializedMessages.includes('Agent Session purpose: verify')) {
        verifierTools = context.tools?.map((tool) => tool.name) ?? [];
        verifierContext = serializedMessages;
        return fauxAssistantMessage(fauxText('Verdict: pass\nThe source URL was checked and supports the result.'));
      }
      if (!startRequested) {
        startRequested = true;
        return fauxAssistantMessage([
          fauxToolCall('agent_session_start', {
            issueId,
            purpose: 'verify',
            expectedIssueRevision: issueRevision,
            detach: false,
            request: { mode: 'request' },
            reason: 'Run the configured verifier.',
          }, { id: 'tool-start-explicit-verifier' }),
        ]);
      }
      return fauxAssistantMessage(fauxText('Verifier finished.'));
    }, () => undefined);

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await store.create({
      issueType: 'issue',
      fields: {
        title: 'Explicit verifier fixture',
        verificationPolicy: {
          mode: 'agent-review',
          requiredVerdict: 'pass',
          requiredEvidence: ['source URL'],
        },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create explicit verifier work.',
    }, actor, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const issue = (await store.search({ targets: ['issue'] })).rows[0];
    issueId = issue.target.id;
    issueRevision = issue.revision;

    await runtime.sendMessage(conversation.conversationId, 'VISIBLE_SENTINEL: start the explicit verifier.');
    await waitFor(async () => (
      (await store.read({ target: { type: 'issue', id: issueId } })).issue?.status.category === 'completed'
    ), 2_000);

    expect(verifierContext).toContain('Required evidence: source URL');
    expect(verifierContext).not.toContain('VISIBLE_SENTINEL');
    expect(verifierTools).toContain('issue_read');
    expect(verifierTools).not.toContain('issue_create');
    expect(verifierTools).not.toContain('issue_update');
    expect(verifierTools).not.toContain('agent_session_start');
    expect(verifierTools).not.toContain('node_edit');
    expect(verifierTools).not.toContain('file_write');
    const state = await store.state();
    expect(Object.values(state.sessions)).toEqual([
      expect.objectContaining({ purpose: 'verify', state: 'complete' }),
    ]);
    expect(Object.values(state.activity).some((activity) => (
      activity.content.type === 'verification-result' && activity.content.verdict === 'pass'
    ))).toBe(true);
  });

  test('stops a verifying Issue Session and its live verifier before committing cancellation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifying-stop-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifying-stop-data-'));
    roots.push(localRoot, dataRoot);

    let callCount = 0;
    let verifierSignal: AbortSignal | undefined;
    let markVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      markVerifierStarted = resolve;
    });
    const streamFn = ((model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      callCount += 1;
      const stream = createAssistantMessageEventStream();
      if (callCount === 1) {
        queueMicrotask(() => {
          const response = normalizeAssistantMessage(
            fauxAssistantMessage(fauxText('Candidate verified result.')),
            model,
          );
          stream.push({ type: 'start', partial: { ...response, content: [] } });
          stream.push({ type: 'done', reason: 'stop', message: response });
          stream.end(response);
        });
        return stream;
      }

      verifierSignal = options?.signal;
      markVerifierStarted();
      const finishAbort = () => {
        const response = normalizeAssistantMessage(
          fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'Verifier stopped.' }),
          model,
        );
        stream.push({ type: 'error', reason: 'aborted', error: response });
        stream.end(response);
      };
      if (verifierSignal?.aborted) queueMicrotask(finishAbort);
      else verifierSignal?.addEventListener('abort', finishAbort, { once: true });
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
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const conversationState = internals.conversations.get(conversation.conversationId)!;
    const executor = internals.createIssueSessionExecutor(
      () => conversationState.delegationRuntime,
      () => conversation.conversationId,
    );
    const issueRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      executor,
      () => ({ conversationId: conversation.conversationId }),
    );
    const created = await issueRuntime.create({
      issueType: 'issue',
      fields: {
        title: 'Verifying stop fixture',
        completionCriteria: [{ id: 'verified-output', text: 'Return verified output.', state: 'open' }],
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create verification stop work.',
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueRuntime.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueRuntime.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start verification stop work.',
    });
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await verifierStarted;

    const stopped = await issueRuntime.stopSession({
      agentSessionId: sessionId,
      request: { mode: 'request' },
      reason: 'Stop during verification.',
    });
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const binding = await store.executionForSession(sessionId);
    const parentRun = binding
      ? await conversationState.delegationRuntime.status({ runId: binding.executionId })
      : null;

    expect(stopped.status).toBe('applied');
    expect(verifierSignal?.aborted).toBe(true);
    expect((await issueRuntime.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('canceled');
    expect(parentRun).toMatchObject({ status: 'completed', objective_status: 'stopped' });
    const verifierRuns = [...(conversationState.delegationRuntime as unknown as {
      runs: Map<string, { parentRunId?: string; purpose?: string; status: string; objectiveStatus?: string }>;
    }).runs.values()].filter((run) => run.parentRunId === binding?.executionId && run.purpose === 'verify');
    expect(verifierRuns).toEqual([
      expect.objectContaining({ status: 'cancelled', objectiveStatus: 'stopped' }),
    ]);
  });

  test('invalidates an in-flight verifier and restores scoped continuation limits', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-amend-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-amend-data-'));
    roots.push(localRoot, dataRoot);

    let callCount = 0;
    let verifierSignal: AbortSignal | undefined;
    let markVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      markVerifierStarted = resolve;
    });
    const streamFn = ((model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      callCount += 1;
      const stream = createAssistantMessageEventStream();
      if (callCount === 1) {
        queueMicrotask(() => {
          const response = normalizeAssistantMessage(
            fauxAssistantMessage(fauxText('Candidate result before amendment.')),
            model,
          );
          stream.push({ type: 'start', partial: { ...response, content: [] } });
          stream.push({ type: 'done', reason: 'stop', message: response });
          stream.end(response);
        });
        return stream;
      }

      verifierSignal = options?.signal;
      markVerifierStarted();
      const finishAbort = () => {
        const response = normalizeAssistantMessage(
          fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'Verifier invalidated.' }),
          model,
        );
        stream.push({ type: 'error', reason: 'aborted', error: response });
        stream.end(response);
      };
      if (verifierSignal?.aborted) queueMicrotask(finishAbort);
      else verifierSignal?.addEventListener('abort', finishAbort, { once: true });
      return stream;
    }) as StreamFn;

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const core = Core.new();
    const scopeNodeId = core.createNode(
      core.projection().todayId,
      null,
      'Restored scope fixture',
    ).focus?.nodeId;
    if (!scopeNodeId) throw new Error('Expected a scope fixture node.');
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
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
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const conversationState = internals.conversations.get(conversation.conversationId)!;
    const delegationInternals = conversationState.delegationRuntime as unknown as {
      verifyCompletedRun(
        run: { purpose?: string },
        signal: AbortSignal | undefined,
        detached: boolean,
      ): Promise<unknown>;
    };
    const originalVerifyCompletedRun = delegationInternals.verifyCompletedRun
      .bind(conversationState.delegationRuntime);
    let markVerificationExited!: () => void;
    const verificationExited = new Promise<void>((resolve) => {
      markVerificationExited = resolve;
    });
    delegationInternals.verifyCompletedRun = async (run, signal, detached) => {
      try {
        return await originalVerifyCompletedRun(run, signal, detached);
      } finally {
        if (run.purpose !== 'verify') markVerificationExited();
      }
    };
    const executor = internals.createIssueSessionExecutor(
      () => conversationState.delegationRuntime,
      () => conversation.conversationId,
    );
    const issueRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      executor,
      () => ({ conversationId: conversation.conversationId }),
    );
    const created = await issueRuntime.create({
      issueType: 'issue',
      fields: {
        title: 'Verifier amendment fixture',
        noteNodeIds: [scopeNodeId],
        completionCriteria: [{ id: 'initial-output', text: 'Return the initial output.', state: 'open' }],
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create verifier amendment work.',
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueRuntime.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueRuntime.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start verifier amendment work.',
    });
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await verifierStarted;
    const binding = await AgentIssueStore.forAgentDataRoot(dataRoot).executionForSession(sessionId);
    expect(binding).not.toBeNull();

    const amended = await runtime.runAmend(
      conversation.conversationId,
      binding!.executionId,
      { criteria: ['Return the amended output.'] },
    );
    await verificationExited;
    const parentRun = await runtime.runStatus(conversation.conversationId, binding!.executionId);

    expect(verifierSignal?.aborted).toBe(true);
    expect(callCount).toBe(2);
    expect(amended).toMatchObject({ status: 'completed', objective_status: 'active' });
    expect(parentRun).toMatchObject({ status: 'completed', objective_status: 'active' });
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');
    await waitFor(() => !conversationState.delegationRuntime.hasLiveRun(binding!.executionId));
    const persistedRun = await new AgentEventStore(dataRoot).readRunMetaProjection(binding!.executionId);
    expect(persistedRun?.objective?.scope).toEqual({
      capabilities: undefined,
      resources: {
        nodes: [scopeNodeId],
        writableNodes: [],
        creatableNodeParents: [],
      },
    });
    expect(persistedRun?.objective?.budget).toBeDefined();

    const resumedWorkContexts: string[] = [];
    const resumedStreamFn = dynamicStream((context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (serializedMessages.includes('You are an independent verifier Run.')) {
        return fauxAssistantMessage(fauxText('{"verdict":"pass","gap":""}'));
      }
      resumedWorkContexts.push(serializedMessages);
      return fauxAssistantMessage(fauxText('Result produced under the amended contract.'));
    }, () => undefined);
    const resumedRuntime = new AgentRuntime(
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
        streamFn: resumedStreamFn,
      },
    );
    drainableRuntimes.push(resumedRuntime);
    const resumedRuntimeInternals = resumedRuntime as unknown as {
      createChildPiAgent: (...args: unknown[]) => { state: { tools: Array<{ name: string }> } };
    };
    const originalCreateChildPiAgent = resumedRuntimeInternals.createChildPiAgent.bind(resumedRuntime);
    let restoredScope: AgentRunScope | undefined;
    let restoredNestedScope: AgentRunScope | undefined;
    let restoredNestedBudget: AgentRunBudget | undefined;
    let restoredToolNames: string[] = [];
    resumedRuntimeInternals.createChildPiAgent = (...args) => {
      const input = args[3] as AgentChildAgentCreateInput;
      const childAgent = originalCreateChildPiAgent(...args);
      if (input.runId === binding!.executionId) {
        const nestedRuntime = input.delegationRuntime as unknown as {
          inheritedScope?: AgentRunScope;
          inheritedBudget?: AgentRunBudget;
        };
        restoredScope = structuredClone(input.scope);
        restoredNestedScope = structuredClone(nestedRuntime.inheritedScope);
        restoredNestedBudget = structuredClone(nestedRuntime.inheritedBudget);
        restoredToolNames = childAgent.state.tools.map((tool) => tool.name);
      }
      return childAgent;
    };
    await resumedRuntime.restoreConversation(conversation.conversationId);
    await resumedRuntime.runSteer(
      conversation.conversationId,
      binding!.executionId,
      'Continue using the durable amended contract.',
    );
    await waitFor(async () => (
      (await store.readSession({ agentSessionId: sessionId }))?.agentSession.state === 'complete'
    ), 2_000);

    expect(resumedWorkContexts.some((context) => (
      context.includes('Run amendment (durable; supersedes earlier values for the changed fields).')
      && context.includes('Return the amended output.')
    ))).toBe(true);
    expect(restoredScope).toEqual(persistedRun?.objective?.scope);
    expect(restoredNestedScope).toEqual(persistedRun?.objective?.scope);
    expect(restoredNestedBudget).toEqual(persistedRun?.objective?.budget);
    expect(restoredToolNames).toContain('node_read');
    expect(restoredToolNames).not.toContain('outline_undo_stack');
    expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.latestOutput)
      .toBe('Result produced under the amended contract.');
    expect((await new AgentEventStore(dataRoot).readRunMetaProjection(binding!.executionId))?.objective).toMatchObject({
      criteria: ['Return the amended output.'],
      role: 'controller',
      status: 'verified',
    });
  });

  test('keeps an in-flight verifier valid for a budget-only amendment', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-budget-amend-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-budget-amend-data-'));
    roots.push(localRoot, dataRoot);

    let providerCallCount = 0;
    let verifierSignal: AbortSignal | undefined;
    let markVerifierStarted!: () => void;
    let releaseVerifier!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      markVerifierStarted = resolve;
    });
    const verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const streamFn = ((model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      providerCallCount += 1;
      const stream = createAssistantMessageEventStream();
      if (providerCallCount === 1) {
        queueMicrotask(() => {
          const response = normalizeAssistantMessage(
            fauxAssistantMessage(fauxText('Candidate result before the budget extension.')),
            model,
          );
          stream.push({ type: 'start', partial: { ...response, content: [] } });
          stream.push({ type: 'done', reason: 'stop', message: response });
          stream.end(response);
        });
        return stream;
      }
      verifierSignal = options?.signal;
      markVerifierStarted();
      void verifierGate.then(() => {
        const response = normalizeAssistantMessage(
          fauxAssistantMessage(fauxText('{"verdict":"pass","gap":""}')),
          model,
        );
        stream.push({ type: 'start', partial: { ...response, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message: response });
        stream.end(response);
      });
      return stream;
    }) as StreamFn;

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const conversationState = internals.conversations.get(conversation.conversationId)!;
    const executor = internals.createIssueSessionExecutor(
      () => conversationState.delegationRuntime,
      () => conversation.conversationId,
    );
    const issueRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      executor,
      () => ({ conversationId: conversation.conversationId }),
    );
    const created = await issueRuntime.create({
      issueType: 'issue',
      fields: {
        title: 'Budget-only amendment fixture',
        completionCriteria: [{ id: 'verified-output', text: 'Return verified output.', state: 'open' }],
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create budget-only amendment work.',
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueRuntime.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueRuntime.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start budget-only amendment work.',
    });
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await verifierStarted;
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const binding = await store.executionForSession(sessionId);
    expect(binding).not.toBeNull();

    const delegationRun = (conversationState.delegationRuntime as unknown as {
      runs: Map<string, {
        budget?: { tokens?: number; [key: string]: unknown };
        budgetSettled?: boolean;
        criteria?: string[];
        objectiveStatus?: string;
        parentBudgetRef?: { tokens?: number; reservedTokens?: number; spentTokens?: number };
      }>;
    }).runs.get(binding!.executionId)!;
    const originalBudget = delegationRun.budget;
    const originalCriteria = [...(delegationRun.criteria ?? [])];
    delegationRun.budget = { ...originalBudget, tokens: 80 };
    delegationRun.budgetSettled = false;
    delegationRun.parentBudgetRef = { tokens: 100, reservedTokens: 80, spentTokens: 0 };
    await expect(runtime.runAmend(
      conversation.conversationId,
      binding!.executionId,
      { criteria: ['This invalid amendment must not apply.'], budget: { tokens: 101 } },
    )).rejects.toThrow('exceeds parent remaining token budget');
    expect(verifierSignal?.aborted).toBe(false);
    expect(delegationRun.criteria).toEqual(originalCriteria);
    expect(delegationRun.objectiveStatus).toBe('verifying');
    delegationRun.budget = originalBudget;
    delegationRun.parentBudgetRef = undefined;

    const amended = await runtime.runAmend(
      conversation.conversationId,
      binding!.executionId,
      { budget: { tokens: 2_000 } },
    );

    expect(verifierSignal?.aborted).toBe(false);
    expect(amended).toMatchObject({ status: 'completed', objective_status: 'verifying' });
    expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');
    releaseVerifier();
    await waitFor(async () => (
      (await store.readSession({ agentSessionId: sessionId }))?.agentSession.state === 'complete'
    ), 2_000);
    expect((await new AgentEventStore(dataRoot).readRunMetaProjection(binding!.executionId))?.objective).toMatchObject({
      status: 'verified',
      budget: { tokens: 2_000 },
    });
  });

  test('invalidates an old verifier before steering a terminal Run continuation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-resume-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-resume-data-'));
    roots.push(localRoot, dataRoot);

    let providerCallCount = 0;
    let rootDeliveryCallCount = 0;
    let oldVerifierSignal: AbortSignal | undefined;
    let markOldVerifierStarted!: () => void;
    const oldVerifierStarted = new Promise<void>((resolve) => {
      markOldVerifierStarted = resolve;
    });
    const streamFn = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const finish = (message: AssistantMessage) => {
        const response = normalizeAssistantMessage(message, model);
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: response.stopReason, error: response });
        } else {
          stream.push({ type: 'start', partial: { ...response, content: [] } });
          stream.push({ type: 'done', reason: response.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message: response });
        }
        stream.end(response);
      };
      if (latestContextMessage(context).includes('<root-issue-delivery')) {
        rootDeliveryCallCount += 1;
        queueMicrotask(() => finish(fauxAssistantMessage(fauxText('Steered result delivered to the user.'))));
        return stream;
      }
      providerCallCount += 1;
      if (providerCallCount === 1) {
        queueMicrotask(() => finish(fauxAssistantMessage(fauxText('Candidate before terminal steering.'))));
        return stream;
      }
      if (providerCallCount === 2) {
        oldVerifierSignal = options?.signal;
        markOldVerifierStarted();
        const abort = () => finish(fauxAssistantMessage([], {
          stopReason: 'aborted',
          errorMessage: 'Old verifier invalidated by continuation.',
        }));
        if (oldVerifierSignal?.aborted) queueMicrotask(abort);
        else oldVerifierSignal?.addEventListener('abort', abort, { once: true });
        return stream;
      }
      queueMicrotask(() => finish(providerCallCount === 3
        ? fauxAssistantMessage(fauxText('Result from the steered continuation.'))
        : fauxAssistantMessage(fauxText('{"verdict":"pass","gap":""}'))));
      return stream;
    }) as StreamFn;

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const conversationState = internals.conversations.get(conversation.conversationId)!;
    const executor = internals.createIssueSessionExecutor(
      () => conversationState.delegationRuntime,
      () => conversation.conversationId,
    );
    const issueRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      executor,
      () => ({ conversationId: conversation.conversationId }),
    );
    const created = await issueRuntime.create({
      issueType: 'issue',
      fields: {
        title: 'Terminal verifier steering fixture',
        completionCriteria: [{ id: 'verified-output', text: 'Return verified output.', state: 'open' }],
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create terminal verifier steering work.',
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueRuntime.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueRuntime.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start terminal verifier steering work.',
    });
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await oldVerifierStarted;
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const binding = await store.executionForSession(sessionId);
    expect(binding).not.toBeNull();

    await runtime.runSteer(
      conversation.conversationId,
      binding!.executionId,
      'Continue with the newer execution instead of the old verifier result.',
    );
    await waitFor(async () => (
      (await store.readSession({ agentSessionId: sessionId }))?.agentSession.state === 'complete'
    ), 2_000);
    await waitFor(async () => Object.values((await store.state()).terminalDeliveries).some((delivery) => (
      delivery.status === 'delivered'
    )), 2_000);

    expect(oldVerifierSignal?.aborted).toBe(true);
    expect(providerCallCount).toBe(4);
    expect(rootDeliveryCallCount).toBe(1);
    expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.latestOutput)
      .toBe('Result from the steered continuation.');
    expect((await new AgentEventStore(dataRoot).readRunMetaProjection(binding!.executionId))?.objective?.status)
      .toBe('verified');
  });

  test('prevents a verifier from reaching the provider when stop wins during harness startup', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-start-stop-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-verifier-start-stop-data-'));
    roots.push(localRoot, dataRoot);

    let providerCalls = 0;
    const streamFn = ((model: Model<Api>) => {
      providerCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const response = normalizeAssistantMessage(
          fauxAssistantMessage(fauxText(providerCalls === 1 ? 'Candidate result.' : '{"verdict":"pass"}')),
          model,
        );
        stream.push({ type: 'start', partial: { ...response, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message: response });
        stream.end(response);
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
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    const internals = runtime as unknown as IssueRuntimeInternals;
    const conversationState = internals.conversations.get(conversation.conversationId)!;
    const delegationInternals = conversationState.delegationRuntime as unknown as {
      buildChildAgentHarness(input: unknown): Promise<unknown>;
      runs: Map<string, {
        purpose?: string;
        verificationAbortController?: AbortController;
      }>;
    };
    const originalBuildHarness = delegationInternals.buildChildAgentHarness.bind(conversationState.delegationRuntime);
    let harnessCalls = 0;
    let releaseVerifierHarness!: () => void;
    let markVerifierHarnessEntered!: () => void;
    const verifierHarnessEntered = new Promise<void>((resolve) => {
      markVerifierHarnessEntered = resolve;
    });
    const verifierHarnessGate = new Promise<void>((resolve) => {
      releaseVerifierHarness = resolve;
    });
    delegationInternals.buildChildAgentHarness = async (input) => {
      harnessCalls += 1;
      if (harnessCalls === 2) {
        markVerifierHarnessEntered();
        await verifierHarnessGate;
      }
      return originalBuildHarness(input);
    };
    const executor = internals.createIssueSessionExecutor(
      () => conversationState.delegationRuntime,
      () => conversation.conversationId,
    );
    const issueRuntime = internals.createIssueToolRuntime(
      'built-in:tenon:assistant',
      executor,
      () => ({ conversationId: conversation.conversationId }),
    );
    const created = await issueRuntime.create({
      issueType: 'issue',
      fields: {
        title: 'Verifier startup stop fixture',
        completionCriteria: [{ id: 'verified-output', text: 'Return verified output.', state: 'open' }],
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        permissionMode: 'attended',
      },
      request: { mode: 'request' },
      reason: 'Create verifier startup stop work.',
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueRuntime.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueRuntime.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start verifier startup stop work.',
    });
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await verifierHarnessEntered;

    const stopped = await issueRuntime.stopSession({
      agentSessionId: sessionId,
      request: { mode: 'request' },
      reason: 'Stop before verifier registration.',
    });
    releaseVerifierHarness();
    await waitFor(() => [...delegationInternals.runs.values()].every((run) => (
      run.purpose === 'verify' || run.verificationAbortController === undefined
    )));

    expect(stopped.status).toBe('applied');
    expect(providerCalls).toBe(1);
    expect((await issueRuntime.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('canceled');
  });

  test('routes nested Issue completion one Agent Session at a time before the origin conversation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-routing-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-routing-data-'));
    roots.push(localRoot, dataRoot);

    let rootIssueCreated = false;
    let childIssueCreated = false;
    let grandchildIssueCreated = false;
    const callKinds: string[] = [];
    const deliveredExecutionIds = new Set<string>();
    let genericControllerSummaryCalls = 0;
    const rootDeliveryContexts: string[] = [];
    const streamFn = dynamicStream((context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (latestContextMessage(context).includes('<root-issue-delivery')) {
        rootDeliveryContexts.push(serializedMessages);
        return fauxAssistantMessage(fauxText('Final integrated root result delivered to the user.'));
      }
      for (const match of serializedMessages.matchAll(/<executionId>([^<]+)<\/executionId>/gu)) {
        if (match[1]) deliveredExecutionIds.add(match[1]);
      }
      const isIssueSession = serializedMessages.includes('You are executing one Agent Session for a Tenon Issue.');
      if (isIssueSession
        && serializedMessages.includes('<child-issue-delivery')
        && serializedMessages.includes('Grandchild routing issue')) {
        return fauxAssistantMessage(fauxText('Integrated child result after grandchild completion.'));
      }
      if (isIssueSession
        && serializedMessages.includes('<child-issue-delivery')
        && serializedMessages.includes('Child routing issue')) {
        return fauxAssistantMessage(fauxText('Integrated parent result after child completion.'));
      }
      if (isIssueSession
        && serializedMessages.includes('Grandchild routing issue')
        && !serializedMessages.includes('Child routing issue')) {
        return fauxAssistantMessage(fauxText('Grandchild routing result.'));
      }
      if (isIssueSession
        && serializedMessages.includes('Child routing issue')
        && !serializedMessages.includes('Root routing issue')) {
        if (!grandchildIssueCreated) {
          grandchildIssueCreated = true;
          return fauxAssistantMessage([
            fauxToolCall('issue_create', {
              issueType: 'issue',
              fields: {
                title: 'Grandchild routing issue',
                description: 'Produce the grandchild result required by the child Agent Session.',
                trigger: { type: 'when-ready' },
                permissionMode: 'unattended',
              },
              request: { mode: 'request' },
              reason: 'Delegate nested durable work and continue only after its result returns.',
            }, { id: 'tool-create-grandchild-issue' }),
          ]);
        }
        return fauxAssistantMessage(fauxText('Child session is waiting for its grandchild Issue.'));
      }
      if (isIssueSession && serializedMessages.includes('Root routing issue')) {
        if (!childIssueCreated) {
          childIssueCreated = true;
          return fauxAssistantMessage([
            fauxToolCall('issue_create', {
              issueType: 'issue',
              fields: {
                title: 'Child routing issue',
                description: 'Produce the child result required by the parent Agent Session.',
                trigger: { type: 'when-ready' },
                permissionMode: 'unattended',
              },
              request: { mode: 'request' },
              reason: 'Delegate durable child work and continue only after its result returns.',
            }, { id: 'tool-create-child-issue' }),
          ]);
        }
        return fauxAssistantMessage(fauxText('Parent session is waiting for its child Issue.'));
      }
      if (!rootIssueCreated) {
        rootIssueCreated = true;
        return fauxAssistantMessage([
          fauxToolCall('issue_create', {
            issueType: 'issue',
            fields: {
              title: 'Root routing issue',
              description: 'Create a child Issue, integrate its result, and return one parent result.',
              trigger: { type: 'when-ready' },
              permissionMode: 'unattended',
            },
            request: { mode: 'request' },
            reason: 'Create durable root work.',
          }, { id: 'tool-create-root-issue' }),
        ]);
      }
      return fauxAssistantMessage(fauxText('Root Issue handed off.'));
    }, (_model, context) => {
      const serializedMessages = JSON.stringify(context.messages);
      if (serializedMessages.includes('<detached-sub-run-results>')) {
        genericControllerSummaryCalls += 1;
      }
      callKinds.push(
        latestContextMessage(context).includes('<root-issue-delivery')
          ? 'root-delivery'
          : serializedMessages.includes('<child-issue-delivery')
          && serializedMessages.includes('Grandchild routing issue')
          ? 'child-resume'
          : serializedMessages.includes('<child-issue-delivery')
            && serializedMessages.includes('Child routing issue')
            ? 'root-resume'
          : serializedMessages.includes('You are executing one Agent Session for a Tenon Issue.')
            ? 'issue-session'
            : 'conversation',
      );
    });

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);

    const conversation = await runtime.restoreLatestConversation();
    await runtime.sendMessage(conversation.conversationId, 'Run the root Issue with durable child work.');

    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await waitFor(async () => {
      const state = await store.state();
      const sessions = Object.values(state.sessions);
      const rootSession = sessions.find((session) => session.issueSnapshot.title === 'Root routing issue');
      const childSession = sessions.find((session) => session.issueSnapshot.title === 'Child routing issue');
      return Object.values(state.issues).length === 3
        && Object.values(state.issues).every((issue) => issue.status.category === 'completed')
        && sessions.length === 3
        && sessions.every((session) => session.state === 'complete')
        && rootSession?.latestOutput?.includes('Integrated parent result after child completion.') === true
        && childSession?.latestOutput?.includes('Integrated child result after grandchild completion.') === true;
    }, 5_000);

    const state = await store.state();
    const rootIssue = Object.values(state.issues).find((issue) => issue.title === 'Root routing issue');
    const childIssue = Object.values(state.issues).find((issue) => issue.title === 'Child routing issue');
    const grandchildIssue = Object.values(state.issues).find((issue) => issue.title === 'Grandchild routing issue');
    const rootSession = Object.values(state.sessions).find((session) => session.issueId === rootIssue?.id);
    const childSession = Object.values(state.sessions).find((session) => session.issueId === childIssue?.id);
    const grandchildSession = Object.values(state.sessions).find((session) => session.issueId === grandchildIssue?.id);
    expect(rootIssue?.origin).toEqual({ type: 'conversation', conversationId: conversation.conversationId });
    expect(childIssue).toMatchObject({
      parentIssueId: rootIssue?.id,
      origin: { type: 'agent-session', agentSessionId: rootSession?.id },
    });
    expect(grandchildIssue).toMatchObject({
      parentIssueId: childIssue?.id,
      origin: { type: 'agent-session', agentSessionId: childSession?.id },
    });
    expect(rootSession?.latestOutput).toContain('Integrated parent result after child completion.');
    expect(childSession?.latestOutput).toContain('Integrated child result after grandchild completion.');
    expect(grandchildSession?.latestOutput).toContain('Grandchild routing result.');
    expect(callKinds).toContain('child-resume');
    expect(callKinds).toContain('root-resume');
    expect(callKinds.filter((kind) => kind === 'child-resume')).toHaveLength(1);
    expect(callKinds.filter((kind) => kind === 'root-resume')).toHaveLength(1);
    expect(genericControllerSummaryCalls).toBe(0);

    const rootBinding = await store.executionForSession(rootSession!.id);
    const childBinding = await store.executionForSession(childSession!.id);
    const grandchildBinding = await store.executionForSession(grandchildSession!.id);
    expect(deliveredExecutionIds).toEqual(new Set([
      childBinding!.executionId,
      grandchildBinding!.executionId,
    ]));
    const internalConversation = (runtime as unknown as {
      conversations: Map<string, { delegationRuntime: { sendLive(input: unknown): Promise<unknown> } }>;
    }).conversations.get(rootBinding!.conversationId);
    await expect(internalConversation!.delegationRuntime.sendLive({
      runId: rootBinding!.executionId,
      message: 'Must not revive a completed Issue Session.',
    })).rejects.toThrow('no longer running');
    expect((await store.readSession({ agentSessionId: rootSession!.id }))?.agentSession.state).toBe('complete');

    await runtime.readAgentSession({ agentSessionId: grandchildSession!.id, include: ['latest-output'] });
    await runtime.readAgentSession({ agentSessionId: childSession!.id, include: ['latest-output'] });
    expect(callKinds.filter((kind) => kind === 'child-resume')).toHaveLength(1);
    expect(callKinds.filter((kind) => kind === 'root-resume')).toHaveLength(1);

    await waitFor(async () => {
      const deliveries = Object.values((await store.state()).terminalDeliveries);
      return deliveries.length === 3 && deliveries.every((delivery) => delivery.status === 'delivered');
    }, 5_000);
    expect(callKinds.filter((kind) => kind === 'root-delivery')).toHaveLength(1);
    expect(rootDeliveryContexts).toHaveLength(1);
    expect(rootDeliveryContexts[0]).toContain('Integrated parent result after child completion.');
    const restored = await runtime.restoreConversation(conversation.conversationId);
    const deliveredResults = Object.values(restored.renderProjection.entities.messages).filter((message) => (
      message.runId?.startsWith('issue-delivery-run-')
    ));
    expect(deliveredResults).toHaveLength(1);
    expect(JSON.stringify(deliveredResults[0]?.content)).toContain('Final integrated root result delivered to the user.');
    expect(JSON.stringify(deliveredResults[0]?.content)).not.toContain('Integrated child result after grandchild completion.');
    expect(JSON.stringify(deliveredResults[0]?.content)).not.toContain('Grandchild routing result.');
  });

  test('retries a persisted child delivery after the first parent continuation provider error', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-retry-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-issue-retry-data-'));
    roots.push(localRoot, dataRoot);

    let rootIssueCreated = false;
    let childIssueCreated = false;
    let parentContinuationAttempts = 0;
    const streamFn = dynamicStream((context) => {
      const messages = JSON.stringify(context.messages);
      const isIssueSession = messages.includes('You are executing one Agent Session for a Tenon Issue.');
      if (isIssueSession && messages.includes('<child-issue-delivery')) {
        parentContinuationAttempts += 1;
        if (parentContinuationAttempts === 1) {
          return fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: 'Transient provider failure during parent continuation.',
          });
        }
        return fauxAssistantMessage(fauxText('Integrated child result after retry.'));
      }
      if (isIssueSession && messages.includes('Retry child issue') && !messages.includes('Retry root issue')) {
        return fauxAssistantMessage(fauxText('Retry child result.'));
      }
      if (isIssueSession && messages.includes('Retry root issue')) {
        if (!childIssueCreated) {
          childIssueCreated = true;
          return fauxAssistantMessage([
            fauxToolCall('issue_create', {
              issueType: 'issue',
              fields: {
                title: 'Retry child issue',
                trigger: { type: 'when-ready' },
                permissionMode: 'unattended',
              },
              request: { mode: 'request' },
              reason: 'Create retry child work.',
            }, { id: 'tool-create-retry-child' }),
          ]);
        }
        return fauxAssistantMessage(fauxText('Parent waits for retry child.'));
      }
      if (!rootIssueCreated) {
        rootIssueCreated = true;
        return fauxAssistantMessage([
          fauxToolCall('issue_create', {
            issueType: 'issue',
            fields: {
              title: 'Retry root issue',
              trigger: { type: 'when-ready' },
              permissionMode: 'unattended',
            },
            request: { mode: 'request' },
            reason: 'Create retry root work.',
          }, { id: 'tool-create-retry-root' }),
        ]);
      }
      return fauxAssistantMessage(fauxText('Retry root handed off.'));
    }, () => undefined);

    const { AgentRuntime } = await loadRuntimeModule();
    const runtime = new AgentRuntime(
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
      },
    );
    drainableRuntimes.push(runtime);
    const conversation = await runtime.restoreLatestConversation();
    await runtime.sendMessage(conversation.conversationId, 'Run durable child work with retry.');
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await waitFor(async () => {
      const state = await store.state();
      const root = Object.values(state.issues).find((issue) => issue.title === 'Retry root issue');
      const rootSession = Object.values(state.sessions).find((session) => session.issueId === root?.id);
      return parentContinuationAttempts === 1 && rootSession?.state === 'error';
    }, 2_000);
    const failedState = await store.state();
    const failedRoot = Object.values(failedState.issues).find((issue) => issue.title === 'Retry root issue')!;
    const failedRootSession = Object.values(failedState.sessions).find((session) => session.issueId === failedRoot.id)!;
    const failedRootBinding = await store.executionForSession(failedRootSession.id);
    const failedConversation = (runtime as unknown as {
      conversations: Map<string, { delegationRuntime: { hasLiveRun(runId: string): boolean } }>;
    }).conversations.get(failedRootBinding!.conversationId);
    await waitFor(
      () => !failedConversation!.delegationRuntime.hasLiveRun(failedRootBinding!.executionId),
      2_000,
    );

    await waitFor(async () => {
      const state = await store.state();
      const root = Object.values(state.issues).find((issue) => issue.title === 'Retry root issue');
      const rootSession = Object.values(state.sessions).find((session) => session.issueId === root?.id);
      return parentContinuationAttempts === 2
        && root?.status.category === 'completed'
        && rootSession?.latestOutput === 'Integrated child result after retry.';
    }, 3_000);

    const state = await store.state();
    const child = Object.values(state.issues).find((issue) => issue.title === 'Retry child issue')!;
    const childDeliveries = Object.values(state.terminalDeliveries).filter((delivery) => (
      delivery.issueId === child.id && delivery.state === 'complete'
    ));
    expect(parentContinuationAttempts).toBe(2);
    expect(childDeliveries).toHaveLength(1);
    expect(childDeliveries[0]?.status).toBe('delivered');
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
    drainableRuntimes.push(runtime);
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
