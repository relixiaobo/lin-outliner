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
import { AgentEventStore } from '../../src/main/agentEventStore';
import { AgentPastChatsService } from '../../src/main/agentPastChats';
import { subagentDreamEvidenceStartMessageIndex } from '../../src/main/agentSubagentTranscript';
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

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-subagent-test-user-data');

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
  runtime: { sendMessage: (sessionId: string, message: string) => Promise<unknown>; resolveApproval: (sessionId: string, requestId: string, approved: boolean) => Promise<unknown> },
  sessionId: string,
  message: string,
  sink: ReturnType<typeof createWindowSink>,
) {
  const sendPromise = runtime.sendMessage(sessionId, message);
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
      await runtime.resolveApproval(sessionId, approval.requestId, true);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await sendPromise;
}

function scriptedStream(
  responses: Array<AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage | Promise<AssistantMessage>)>,
  onCall: (model: Model<Api>, context: Context) => void,
): { streamFn: StreamFn; pendingCount: () => number } {
  const queue = [...responses];
  return {
    pendingCount: () => queue.length,
    streamFn: ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      onCall(model, context);
      const stream = createAssistantMessageEventStream();
      const step = queue.shift();
      queueMicrotask(async () => {
        try {
          const response = step
            ? typeof step === 'function'
              ? await step(context, options, model)
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

function textFromContext(context: Context): string {
  return JSON.stringify({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools?.map((tool) => tool.name),
  });
}

describe('agent runtime subagents', () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('fork Dream evidence uses persisted boundaries and skips legacy unknown boundaries', () => {
    expect(subagentDreamEvidenceStartMessageIndex({ contextMode: 'fresh' }, 5)).toBe(0);
    expect(subagentDreamEvidenceStartMessageIndex({ contextMode: 'fork', dreamEvidenceStartMessageIndex: 3 }, 5)).toBe(3);
    expect(subagentDreamEvidenceStartMessageIndex({ contextMode: 'fork' }, 5)).toBe(5);
  });

  test('runs a fresh subagent from an AGENT.md definition and returns only the compact result to the parent', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-data-'));
    roots.push(localRoot, dataRoot);

    const researcherDir = await createAgent(localRoot, 'researcher', [
      '---',
      'description: Researches focused questions in isolation.',
      'tools: [file_read, web_search]',
      '---',
      'RESEARCHER_AGENT_BODY: always include this marker in the system prompt.',
    ].join('\n'));
    const researcherAgentId = projectAgentId(researcherDir, 'researcher');
    await new AgentEventStore(dataRoot).addMemoryEntry(researcherAgentId, {
      id: 'memory-researcher-own',
      fact: 'Researcher agent prefers teal source notes.',
      sources: [{ conversationId: 'seed-researcher' }],
    });
    await new AgentEventStore(dataRoot).addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-parent-only',
      fact: 'Parent agent prefers amber planning notes.',
      sources: [{ conversationId: 'seed-parent' }],
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'research isolated',
            prompt: 'Find the answer.',
            subagent_type: 'researcher',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Use a subagent for this.', sink);

    expect(script.pendingCount()).toBe(0);
    expect(contexts.some((text) => text.includes('RESEARCHER_AGENT_BODY'))).toBe(true);
    expect(contexts.some((text) => text.includes('Research result from child.'))).toBe(true);
    expect(contexts.some((text) => text.includes('"toolName":"Agent"'))).toBe(true);
    const childContext = contexts.find((text) => text.includes('RESEARCHER_AGENT_BODY')) ?? '';
    expect(childContext).toContain('memory-researcher-own');
    expect(childContext).toContain('Researcher agent prefers teal source notes.');
    expect(childContext).not.toContain('"recall"');
    expect(childContext).not.toContain('memory-parent-only');
    expect(childContext).not.toContain('Parent agent prefers amber planning notes.');
  });

  test('scheduled Dream writes fresh subagent transcript memory to the called agent owner', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-dream-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-dream-data-'));
    roots.push(localRoot, dataRoot);

    const researcherDir = await createAgent(localRoot, 'researcher', [
      '---',
      'description: Researches focused questions in isolation.',
      '---',
      'Researcher agent body.',
    ].join('\n'));
    const researcherAgentId = projectAgentId(researcherDir, 'researcher');
    const childEvidence = `Researcher durable note: use teal source notes for synthesis. ${'agent-owned evidence '.repeat(90)}`;
    const dreamRequests: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'research memory',
            prompt: 'Record whether the researcher should use teal source notes.',
            subagent_type: 'researcher',
          }, { id: 'tool-agent-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText(childEvidence)),
        fauxAssistantMessage(fauxText('Parent received the researcher result.')),
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
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'isolated',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, context) => {
          const request = textFromContext(context);
          dreamRequests.push(request);
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: request.includes('## Agent Run')
                ? [{ type: 'add', fact: 'Researcher agent uses teal source notes for synthesis.' }]
                : [],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Use the researcher agent.', sink);
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    await flushProjectionCoalescing();

    const store = new AgentEventStore(dataRoot);
    const researcherEntries = await store.listMemoryEntries(researcherAgentId);
    const parentEntries = await store.listMemoryEntries('built-in:tenon:assistant');
    const source = researcherEntries[0]?.sources[0];
    const dreamState = await store.readDreamState(researcherAgentId);
    const runId = source?.subagentRunId ?? source?.runId;
    const evidence = source
      ? await new AgentPastChatsService(store).readMemorySourceEvidence({ source, maxChars: 2_000 })
      : null;
    const projection = latestProjection(sink.events);
    const dreamTask = projection?.taskIds
      .map((taskId) => projection.entities.tasks[taskId])
      .find((task) => task?.kind === 'dream' && task.runId === dreamState.lastCompleted?.runId);
    const replacementPayload = runId
      ? await store.writePayload(session.conversationId, {
          id: `subagent-transcript-${runId}-replacement`,
          data: JSON.stringify({
            v: 1,
            runId,
            messageCount: 1,
            messages: [fauxAssistantMessage(fauxText(
              `Replacement transcript text that must not satisfy old provenance. ${'replacement evidence '.repeat(90)}`,
            ))],
          }),
          mimeType: 'application/json',
          role: 'subagent_transcript',
          summary: 'Replacement subagent transcript',
        })
      : null;
    const replayBeforeReplacement = await store.replay(session.conversationId);
    const runBeforeReplacement = runId ? replayBeforeReplacement.subagents[runId] : null;
    if (runId && replacementPayload && runBeforeReplacement) {
      await store.appendEvents(session.conversationId, [
        {
          v: 1,
          eventId: `test-payload-replacement-${runId}`,
          seq: replayBeforeReplacement.latestSeq + 1,
          sessionId: session.conversationId,
          createdAt: Date.now(),
          actor: { type: 'system' },
          type: 'payload.created',
          payload: replacementPayload,
        },
        {
          v: 1,
          eventId: `test-subagent-replacement-${runId}`,
          seq: replayBeforeReplacement.latestSeq + 2,
          sessionId: session.conversationId,
          createdAt: Date.now(),
          actor: { type: 'tool', toolName: 'Agent', toolCallId: runBeforeReplacement.parentToolCallId ?? 'tool-agent-1' },
          type: 'subagent_run.updated',
          subagentRunId: runId,
          status: runBeforeReplacement.status,
          completedAt: runBeforeReplacement.completedAt,
          result: runBeforeReplacement.result,
          error: runBeforeReplacement.error,
          dreamEvidenceStartMessageIndex: 0,
          transcriptPayload: replacementPayload,
          transcriptMessageCount: 1,
        },
      ]);
    }
    const evidenceAfterPayloadReplacement = source
      ? await new AgentPastChatsService(store).readMemorySourceEvidence({ source, maxChars: 2_000 })
      : null;
    await runtime.runScheduledDreamsForTest(new Date(Date.now() + 48 * 60 * 60 * 1000));
    const dreamStateAfterPayloadReplacement = await new AgentEventStore(dataRoot).readDreamState(researcherAgentId);

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(researcherEntries.map((entry) => entry.fact)).toEqual([
      'Researcher agent uses teal source notes for synthesis.',
    ]);
    expect(researcherEntries[0]?.originWorkspace).toBe(memoryOriginWorkspace(localRoot));
    expect(parentEntries).toEqual([]);
    expect(dreamTask).toMatchObject({
      kind: 'dream',
      status: 'completed',
      trigger: 'schedule',
      runId: dreamState.lastCompleted?.runId,
      processed: { consolidateOnly: false },
      changes: { added: 1 },
    });
    expect(dreamTask?.kind === 'dream' ? dreamTask.processed?.totalMessageCount : 0).toBeGreaterThan(0);
    expect(dreamTask?.kind === 'dream' ? dreamTask.processed?.agentRuns?.[runId!]?.transcriptPayloadId : null)
      .toBe(source?.eventId);
    expect(source).toMatchObject({
      kind: 'agent_run',
      conversationId: session.conversationId,
      agentId: researcherAgentId,
    });
    expect(runId).toMatch(/^subagent-/);
    expect(source?.messageRange?.[0]).toContain(`${runId}:message:`);
    expect(dreamState.watermark.agentRuns?.[runId!]?.messageCount).toBeGreaterThan(0);
    expect(evidence?.mode).toBe('evidence');
    expect(evidence?.mode === 'evidence' ? evidence.messages.some((message) => (
      message.messageId.startsWith(`${runId}:message:`)
      && message.text.includes('Researcher durable note: use teal source notes')
    )) : false).toBe(true);
    expect(evidenceAfterPayloadReplacement?.mode === 'evidence' ? evidenceAfterPayloadReplacement.messages.some((message) => (
      message.text.includes('Researcher durable note: use teal source notes')
    )) : false).toBe(true);
    expect(evidenceAfterPayloadReplacement?.mode === 'evidence' ? evidenceAfterPayloadReplacement.messages.some((message) => (
      message.text.includes('Replacement transcript text')
    )) : false).toBe(false);
    expect(dreamRequests.some((request) => request.includes('Replacement transcript text that must not satisfy old provenance.'))).toBe(true);
    expect(dreamStateAfterPayloadReplacement.watermark.agentRuns?.[runId!]?.payloadId).toBe(replacementPayload?.id);
    expect(dreamRequests.some((request) => (
      request.includes('## Agent Run')
      && request.includes('Researcher durable note: use teal source notes')
    ))).toBe(true);
  });

  test('scheduled Dream batches same-owner subagent runs by origin workspace', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-dream-workspace-root-'));
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-dream-other-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-dream-workspace-data-'));
    roots.push(localRoot, otherRoot, dataRoot);

    const ownerAgentId = 'built-in:tenon:researcher';
    const currentWorkspace = memoryOriginWorkspace(localRoot);
    const otherWorkspace = memoryOriginWorkspace(otherRoot);
    const currentEvidence = `Current workspace durable note: prefer teal synthesis notes. ${'current evidence '.repeat(90)}`;
    const otherEvidence = `Other workspace durable note: prefer amber synthesis notes. ${'other evidence '.repeat(90)}`;
    const dreamRequests: string[] = [];

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'isolated',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: scriptedStream([], () => undefined).streamFn,
        completeSimpleFn: async (model, context) => {
          const request = textFromContext(context);
          dreamRequests.push(request);
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [
                ...(request.includes('Current workspace durable note')
                  ? [{ type: 'add', fact: 'Researcher prefers teal synthesis notes in the current workspace.' }]
                  : []),
                ...(request.includes('Other workspace durable note')
                  ? [{ type: 'add', fact: 'Researcher prefers amber synthesis notes in the other workspace.' }]
                  : []),
              ],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const session = await runtime.createConversation();
    const store = new AgentEventStore(dataRoot);
    const replay = await store.replay(session.conversationId);
    const seedSubagentRun = async (
      runId: string,
      toolCallId: string,
      originWorkspace: string,
      evidence: string,
      seqOffset: number,
    ) => {
      const payload = await store.writePayload(session.conversationId, {
        id: `subagent-transcript-${runId}`,
        data: JSON.stringify({
          v: 1,
          runId,
          messageCount: 1,
          messages: [fauxAssistantMessage(fauxText(evidence))],
        }),
        mimeType: 'application/json',
        role: 'subagent_transcript',
        summary: `Transcript for ${runId}`,
      });
      await store.appendEvents(session.conversationId, [
        {
          v: 1,
          eventId: `test-payload-${runId}`,
          seq: replay.latestSeq + seqOffset,
          sessionId: session.conversationId,
          createdAt: Date.now() + seqOffset,
          actor: { type: 'system' },
          type: 'payload.created',
          payload,
        },
        {
          v: 1,
          eventId: `test-subagent-start-${runId}`,
          seq: replay.latestSeq + seqOffset + 1,
          sessionId: session.conversationId,
          createdAt: Date.now() + seqOffset + 1,
          actor: { type: 'tool', toolName: 'Agent', toolCallId },
          type: 'subagent_run.started',
          subagentRunId: runId,
          parentToolCallId: toolCallId,
          executingAgentId: ownerAgentId,
          memoryOwnerAgentId: ownerAgentId,
          memoryOriginWorkspace: originWorkspace,
          description: `seeded ${runId}`,
          prompt: `Seed ${runId}`,
          subagentType: 'researcher',
          contextMode: 'fresh',
          transcriptPayload: payload,
          transcriptMessageCount: 1,
        },
        {
          v: 1,
          eventId: `test-subagent-complete-${runId}`,
          seq: replay.latestSeq + seqOffset + 2,
          sessionId: session.conversationId,
          createdAt: Date.now() + seqOffset + 2,
          actor: { type: 'tool', toolName: 'Agent', toolCallId },
          type: 'subagent_run.updated',
          subagentRunId: runId,
          status: 'completed',
          completedAt: Date.now() + seqOffset + 2,
          result: 'done',
          transcriptPayload: payload,
          transcriptMessageCount: 1,
        },
      ]);
    };

    await seedSubagentRun('subagent-current-workspace', 'tool-current-workspace', currentWorkspace, currentEvidence, 1);
    await seedSubagentRun('subagent-other-workspace', 'tool-other-workspace', otherWorkspace, otherEvidence, 10);
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));

    const entries = await store.listMemoryEntries(ownerAgentId);
    const entriesByFact = new Map(entries.map((entry) => [entry.fact, entry]));

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(entriesByFact.get('Researcher prefers teal synthesis notes in the current workspace.')?.originWorkspace).toBe(currentWorkspace);
    expect(entriesByFact.get('Researcher prefers amber synthesis notes in the other workspace.')?.originWorkspace).toBe(otherWorkspace);
    expect(dreamRequests.filter((request) => request.includes('## Agent Run')).length).toBe(2);
    expect(dreamRequests.some((request) => (
      request.includes('Current workspace durable note') && request.includes('Other workspace durable note')
    ))).toBe(false);
  });

  test('omitting subagent_type creates a fork with parent context and placeholder tool results', async () => {
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Parent context marker.', sink);

    const forkContext = contexts.join('\n');
    expect(forkContext).toContain('Parent context marker.');
    expect(forkContext).toContain('lin-fork-subagent');
    expect(forkContext).toContain('Fork started - processing in background.');
  });

  test('slims large subagent tool outputs before the child continues', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-slim-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-slim-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'large output',
            prompt: 'Run a large-output tool call, then continue.',
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Use a subagent for large output.', sink);

    const slimmedContext = childContexts.find((context) => context.includes('<persisted-output>')) ?? '';
    expect(script.pendingCount()).toBe(0);
    expect(slimmedContext).toContain('Output too large');
  });

  test('auto-compacts subagent sidechain before the child continues', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-compact-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-compact-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const compactContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'compact sidechain',
            prompt: 'Run large tool output, then continue after compaction.',
            subagent_type: 'general',
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
    const compactModel: Model<Api> = {
      id: 'subagent-compact-test-model',
      name: 'Subagent Compact Test Model',
      provider: 'openai',
      api: 'openai-completions',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      contextWindow: 20_000,
      maxTokens: 1_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

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
          modelId: 'subagent-compact-test-model',
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
            fauxAssistantMessage('<analysis>subagent compact</analysis><summary>Subagent compact summary.</summary>'),
            model as Model<Api>,
          );
        },
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Use a subagent that will compact.', sink);

    const compactedChildContext = childContexts.join('\n');
    expect(script.pendingCount()).toBe(0);
    expect(compactContexts.join('\n')).toContain('<conversation>');
    expect(compactedChildContext).toContain('Conversation compacted.');
    expect(compactedChildContext).toContain('Subagent compact summary.');
    expect(compactedChildContext).not.toContain('Print compact output block 0');
  });

  test('reactively compacts and retries a subagent after a context-length error', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-reactive-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-subagent-reactive-data-'));
    roots.push(localRoot, dataRoot);

    const childContexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'reactive compact',
            prompt: 'Run until a context error, then recover.',
            subagent_type: 'general',
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
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage('<analysis>reactive subagent compact</analysis><summary>Reactive subagent compact summary.</summary>'),
          model as Model<Api>,
        ),
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Use a subagent that will hit a context error.', sink);

    const retriedContext = childContexts.join('\n');
    expect(script.pendingCount()).toBe(0);
    expect(retriedContext).toContain('Conversation compacted.');
    expect(retriedContext).toContain('Reactive subagent compact summary.');
  });

  test('tracks a background subagent through AgentStatus', async () => {
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
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Start and inspect a background subagent.', sink);

    expect(script.pendingCount()).toBe(0);
    expect(contexts.join('\n')).toContain('Background result.');
    expect(contexts.join('\n')).toContain('\\"status\\": \\"completed\\"');
  });

  test('automatically returns completed background subagents to the parent context', async () => {
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
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Start a self-reporting background subagent.', sink);

    expect(script.pendingCount()).toBe(0);
    const notificationText = notificationContexts.join('\n');
    expect(notificationText).toContain('subagent-notification');
    expect(notificationText).toContain('bg-notify');
    expect(notificationText).toContain('Background notification result.');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    // Durable per-conversation delivery: the detached-subagent terminal raises a
    // folded attention signal anchored to its origin conversation.
    const attentionEvents = sink.events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'conversation_attention' }> =>
        event.type === 'conversation_attention',
    );
    expect(attentionEvents.length).toBeGreaterThan(0);
    const raised = attentionEvents[attentionEvents.length - 1]!;
    expect(raised.conversationId).toBe(session.conversationId);
    expect(raised.unreadCount).toBeGreaterThanOrEqual(1);

    // Restoring (the config-reload path also restores) must NOT mark read: the
    // durable unread is still present in the persisted log afterwards.
    await runtime.restoreConversation(session.conversationId);
    const afterRestore = await new AgentEventStore(dataRoot).replay(session.conversationId);
    expect(afterRestore.attentionByConversationId[session.conversationId]?.unreadCount).toBeGreaterThanOrEqual(1);

    // Marking the conversation read (the renderer's explicit user-open signal) is
    // what clears attention to zero, and it survives because it is a durable
    // notification.read cursor.
    await runtime.markConversationRead(session.conversationId);
    const afterOpen = sink.events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'conversation_attention' }> =>
        event.type === 'conversation_attention',
    );
    expect(afterOpen[afterOpen.length - 1]?.unreadCount).toBe(0);
  });

  test('exposes runtime commands for subagent follow-up and status refresh', async () => {
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
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Start a commandable background subagent.', sink);
    const restored = await runtime.restoreConversation(session.conversationId);
    const subagentId = restored.renderProjection.subagentRunIds[0]!;

    const queued = await runtime.subagentSend(session.conversationId, subagentId, 'Continue with risks.');
    expect(queued).toMatchObject({
      agent_id: subagentId,
      status: 'queued',
    });

    const status = await runtime.subagentStatus(session.conversationId, subagentId, { wait: true });
    expect(status).toMatchObject({
      agent_id: subagentId,
      result: 'Follow-up background result.',
      status: 'completed',
    });
    await waitFor(() => script.pendingCount() === 0);
    expect(contexts.join('\n')).toContain('Continue with risks.');
  });

  test('resumes stopped subagents through follow-up continuation', async () => {
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
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: script.streamFn,
      },
    );

    const session = await runtime.createConversation();
    await sendMessageApprovingAgent(runtime, session.conversationId, 'Start a stoppable background subagent.', sink);
    const subagentId = latestProjection(sink.events)?.subagentRunIds[0]!;

    const stopped = await runtime.subagentStop(session.conversationId, subagentId);
    expect(stopped).toMatchObject({
      agent_id: subagentId,
      status: 'stopped',
    });
    await waitFor(() => script.pendingCount() === 2);

    // A user-initiated stop is the user's own action — it raises NO durable
    // notification/badge (the in-app model-injection still tells the parent).
    const afterStop = await new AgentEventStore(dataRoot).replay(session.conversationId);
    expect(afterStop.attentionByConversationId[session.conversationId]?.unreadCount ?? 0).toBe(0);
    expect(Object.values(afterStop.notifications)).toHaveLength(0);

    const queued = await runtime.subagentSend(session.conversationId, subagentId, 'Resume after stop.');
    expect(queued).toMatchObject({
      agent_id: subagentId,
      status: 'queued',
    });

    const status = await runtime.subagentStatus(session.conversationId, subagentId, { wait: true });
    expect(status).toMatchObject({
      agent_id: subagentId,
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
      const replay = await new AgentEventStore(dataRoot).replay(session.conversationId);
      resumeNotification = Object.values(replay.notifications).find(
        (record) => record.source?.type === 'subagent' && record.source.subagentRunId === subagentId,
      );
      if (!resumeNotification) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(resumeNotification?.kind).toBe('task_completed');
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);

    releaseOriginalChild();
  });

  test('persists subagent sidechain metadata and restores status by name', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-restore-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-restore-data-'));
    roots.push(localRoot, dataRoot);

    const firstScript = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('Agent', {
            description: 'background restore',
            prompt: 'Run in background.',
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const session = await firstRuntime.createConversation();
    await sendMessageApprovingAgent(firstRuntime, session.conversationId, 'Start a restorable background subagent.', firstSink);
    firstRuntime.closeConversation(session.conversationId);
    const transcriptPayloadEvents = (await new AgentEventStore(dataRoot).readEvents(session.conversationId))
      .filter((event) => event.type === 'payload.created' && event.payload?.role === 'subagent_transcript');
    expect(new Set(transcriptPayloadEvents.map((event) => event.payload?.sha256)).size)
      .toBe(transcriptPayloadEvents.length);

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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: secondScript.streamFn,
      },
    );

    const restored = await secondRuntime.restoreConversation(session.conversationId);
    expect(restored.renderProjection.subagentRunIds).toHaveLength(1);
    const subagent = restored.renderProjection.entities.subagents[restored.renderProjection.subagentRunIds[0]!];
    expect(subagent).toMatchObject({
      name: 'restored-bg',
      status: 'completed',
      result: 'Restored background result.',
    });
    expect(subagent?.transcriptMessageCount).toBeGreaterThan(0);

    await secondRuntime.sendMessage(session.conversationId, 'Check the restored background subagent status.');

    expect(secondScript.pendingCount()).toBe(0);
    expect(restoredContexts.join('\n')).toContain('Restored background result.');
    expect(restoredContexts.join('\n')).toContain('\\"status\\": \\"completed\\"');
  });

  test('a background subagent interrupted by restart raises a durable failed notification', async () => {
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
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const session = await firstRuntime.createConversation();
    await sendMessageApprovingAgent(firstRuntime, session.conversationId, 'Start an interruptible background subagent.', firstSink);
    const subagentId = latestProjection(firstSink.events)?.subagentRunIds[0]!;
    expect(subagentId).toBeTruthy();
    // The run is still alive (blocked) — persisted as running, no terminal yet.
    const beforeRestart = await new AgentEventStore(dataRoot).replay(session.conversationId);
    expect(beforeRestart.subagents[subagentId]?.status).toBe('running');
    expect(beforeRestart.attentionByConversationId[session.conversationId]?.unreadCount ?? 0).toBe(0);

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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: secondScript.streamFn,
      },
    );

    const restored = await secondRuntime.restoreConversation(session.conversationId);
    const restoredSubagent = restored.renderProjection.entities.subagents[subagentId];
    expect(restoredSubagent?.status).toBe('failed');

    const afterRestart = await new AgentEventStore(dataRoot).replay(session.conversationId);
    expect(afterRestart.attentionByConversationId[session.conversationId]?.unreadCount).toBeGreaterThanOrEqual(1);
    const interruptedNotification = Object.values(afterRestart.notifications).find(
      (record) => record.source?.type === 'subagent' && record.source.subagentRunId === subagentId,
    );
    expect(interruptedNotification?.kind).toBe('task_failed');

    const attentionRaised = secondSink.events.some(
      (event) => event.type === 'conversation_attention'
        && event.conversationId === session.conversationId
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
            subagent_type: 'general',
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: firstScript.streamFn,
      },
    );

    const session = await firstRuntime.createConversation();
    await sendMessageApprovingAgent(firstRuntime, session.conversationId, 'Start a background subagent that completes.', firstSink);
    // The completed background subagent left durable unread (never opened/read).
    const persisted = await new AgentEventStore(dataRoot).replay(session.conversationId);
    expect(persisted.attentionByConversationId[session.conversationId]?.unreadCount).toBeGreaterThanOrEqual(1);

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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
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
        && event.conversationId === session.conversationId
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
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        streamFn: scriptedStream([], () => undefined).streamFn,
      },
    );

    const session = await runtime.createConversation();
    const conversationId = session.conversationId;

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
});
