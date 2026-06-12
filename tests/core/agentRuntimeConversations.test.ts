import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { AGENT_EVENT_VERSION, getAgentEventActivePath, type AgentEvent } from '../../src/core/agentEventLog';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { agentDefinitionAgentId } from '../../src/main/agentDelegationIdentity';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-conversations-test-user-data');

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
    getVersion: () => 'test',
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

const roots: string[] = [];
const ASSISTANT_AGENT_ID = 'built-in:tenon:assistant';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hostFor(core: Core): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async () => {
      throw new Error('node tools are not used in this test');
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

async function createRuntime(dataRoot: string, localRoot?: string) {
  const { AgentRuntime } = await loadRuntimeModule();
  const sink = createWindowSink();
  const runtime = new AgentRuntime(
    () => sink.window as never,
    hostFor(Core.new()),
    {
      agentDataRoot: dataRoot,
      localFileRoot: localRoot,
      providerConfigLoader: async () => null,
      runtimeSettingsLoader: async () => ({
        permissionMode: 'trusted',
        automaticSkillsEnabled: false,
        slashSkillsEnabled: false,
        compactEnabled: true,
        additionalSkillDirectories: [],
        additionalAgentDirectories: [],
      }),
    },
  );
  return { runtime, sink };
}

async function createProjectAgent(localRoot: string, name = 'self') {
  const rootDir = path.join(localRoot, '.agents', 'agents', name);
  const agentFile = path.join(rootDir, 'AGENT.md');
  await mkdir(rootDir, { recursive: true });
  await writeFile(agentFile, [
    '---',
    `name: ${name}`,
    'description: User-owned personal agent.',
    '---',
    'You are a focused child agent.',
    '',
  ].join('\n'));
  return {
    agentId: agentDefinitionAgentId({
      name,
      displayName: name,
      source: 'project',
      rootDir,
      agentFile,
      description: 'User-owned personal agent.',
      body: 'You are a focused child agent.',
    }),
    rootDir,
    agentFile,
  };
}

async function expectRejects(fn: () => Promise<unknown>, message: string) {
  try {
    await fn();
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(message);
    return;
  }
  throw new Error('Expected promise to reject.');
}

describe('agent runtime conversations', () => {
  test('exposes the built-in Tenon assistant as a view-only agent definition', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);

    const definitions = await runtime.listAllAgentDefinitions('workspace');
    const assistant = definitions.find((definition) => definition.agentId === ASSISTANT_AGENT_ID);

    expect(assistant).toMatchObject({
      agentId: ASSISTANT_AGENT_ID,
      name: 'assistant',
      displayName: 'Tenon Assistant',
      source: 'built-in',
      rootDir: 'built-in',
      agentFile: 'built-in/assistant',
      description: 'Default Tenon assistant profile.',
    });
    expect(assistant?.body).toContain('You are Tenon Agent.');
  });

  test('previews run-scoped tool output payloads only with the owning run id', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const store = new AgentEventStore(dataRoot);
    const conversationId = 'conversation-preview-payload';
    const runId = 'run-preview-payload';
    const payload = await store.writePayload(conversationId, {
      runId,
      id: 'tool-output-preview',
      data: 'full tool output',
      mimeType: 'text/plain',
      role: 'tool_output',
      summary: 'large.log output',
      truncated: true,
    });

    await store.appendEvents(conversationId, [
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'conversation-preview-payload-created',
        seq: 1,
        conversationId,
        type: 'conversation.created',
        createdAt: 1_800_000_000_001,
        actor: { type: 'system' },
        title: 'Preview payload scope',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'conversation-preview-payload-run-started',
        seq: 2,
        conversationId,
        type: 'run.started',
        createdAt: 1_800_000_000_002,
        actor: { type: 'system' },
        runId,
        agentId: ASSISTANT_AGENT_ID,
        kind: 'turn',
        retention: 'hot',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'conversation-preview-payload-created-payload',
        seq: 3,
        conversationId,
        type: 'payload.created',
        createdAt: 1_800_000_000_003,
        actor: { type: 'system' },
        runId,
        payload,
      },
    ] satisfies AgentEvent[]);

    await expect(runtime.previewPayload(conversationId, payload.id)).resolves.toBeNull();
    await expect(runtime.previewPayload(conversationId, payload.id, 'other-run')).resolves.toBeNull();
    await expect(runtime.previewPayload(conversationId, payload.id, runId)).resolves.toMatchObject({
      id: payload.id,
      role: 'tool_output',
      scope: { type: 'run', conversationId, runId },
    });
    await expect(runtime.previewPayloadBytes(conversationId, payload.id, runId)).resolves.toEqual(Buffer.from('full tool output'));
  });

  test('lists every configured agent as a deterministic canonical DM roster row', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    const selfAgent = await createProjectAgent(localRoot);
    const { runtime } = await createRuntime(dataRoot, localRoot);

    const first = await runtime.restoreLatestConversation();
    const secondRuntime = await createRuntime(dataRoot, localRoot);
    const second = await secondRuntime.runtime.restoreLatestConversation();
    const state = await new AgentEventStore(dataRoot).replay(first.conversationId);
    const roster = await runtime.listConversations();
    const assistantRow = roster.find((entry) => entry.canonicalDmAgentId === ASSISTANT_AGENT_ID);
    const selfRow = roster.find((entry) => entry.canonicalDmAgentId === selfAgent.agentId);

    expect(first.conversationId).toMatch(/^lin-agent-dm-/);
    expect(second.conversationId).toBe(first.conversationId);
    expect(roster.filter((entry) => !entry.canonicalDmAgentId)).toEqual([]);
    expect(assistantRow?.id).toBe(first.conversationId);
    expect(selfRow?.id).toMatch(/^lin-agent-dm-/);
    expect(selfRow?.messageCount).toBe(0);
    expect(state.conversation?.title).toBe('Tenon Assistant');
    expect(state.conversation?.goal).toBeUndefined();
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: ASSISTANT_AGENT_ID },
    ]);

    const self = await runtime.restoreConversation(selfRow!.id);
    const selfState = await new AgentEventStore(dataRoot).replay(self.conversationId);
    expect(self.conversationId).toBe(selfRow!.id);
    expect(selfState.conversation?.goal).toBeUndefined();
    expect(selfState.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: selfAgent.agentId },
    ]);
  });

  test('creates, renames, and deletes channels without mutating the canonical DM', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);

    const dm = await runtime.restoreLatestConversation();
    const channel = await runtime.createConversation({ title: 'Initial Project' });
    let channels = (await runtime.listConversations()).filter((entry) => !entry.canonicalDmAgentId);

    expect(channel.conversationId).toMatch(/^lin-agent-channel-/);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      id: channel.conversationId,
      title: 'Initial Project',
      goal: 'Initial Project',
      members: [
        { type: 'user', userId: 'local-user' },
        { type: 'agent', agentId: ASSISTANT_AGENT_ID },
      ],
    });

    const renamed = await runtime.renameConversation(channel.conversationId, 'Project Alpha');
    channels = (await runtime.listConversations()).filter((entry) => !entry.canonicalDmAgentId);

    expect(renamed).toMatchObject({ title: 'Project Alpha', goal: 'Project Alpha' });
    expect(channels[0]).toMatchObject({ title: 'Project Alpha', goal: 'Project Alpha' });
    await expectRejects(() => runtime.renameConversation(dm.conversationId, 'Renamed DM'), 'cannot be renamed');
    await expectRejects(() => runtime.deleteConversation(dm.conversationId), 'cannot be deleted');

    await runtime.deleteConversation(channel.conversationId);
    expect((await runtime.listConversations()).filter((entry) => !entry.canonicalDmAgentId)).toEqual([]);
    expect((await new AgentEventStore(dataRoot).replay(dm.conversationId)).conversation?.title).toBe('Tenon Assistant');
  });

  test('Channel creation requires a name and allows optional invited agents', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    const selfAgent = await createProjectAgent(localRoot);
    const { runtime } = await createRuntime(dataRoot, localRoot);

    await expectRejects(
      () => runtime.createConversation(),
      'requires a name',
    );
    await expectRejects(
      () => runtime.createConversation({ agentIds: [selfAgent.agentId] }),
      'requires a name',
    );

    const soloChannel = await runtime.createConversation({
      title: 'Solo channel',
    });
    let state = await new AgentEventStore(dataRoot).replay(soloChannel.conversationId);

    expect(state.conversation?.goal).toBe('Solo channel');
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: ASSISTANT_AGENT_ID },
    ]);

    const teamChannel = await runtime.createConversation({
      agentIds: [selfAgent.agentId],
      title: 'Shared channel',
    });
    state = await new AgentEventStore(dataRoot).replay(teamChannel.conversationId);

    expect(state.conversation?.goal).toBe('Shared channel');
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: ASSISTANT_AGENT_ID },
      { type: 'agent', agentId: selfAgent.agentId },
    ]);
  });

  test('restores and resolves durable pending user questions', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const conversationId = 'lin-agent-channel-question';
    const events: AgentEvent[] = [
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-1',
        seq: 1,
        conversationId,
        type: 'conversation.created',
        createdAt: 1,
        actor: { type: 'system' },
        title: 'Question channel',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: 'built-in:tenon:assistant' },
        ],
        goal: 'Question channel',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-2',
        seq: 2,
        conversationId,
        type: 'run.started',
        createdAt: 2,
        actor: { type: 'system' },
        runId: 'run-1',
        agentId: 'built-in:tenon:assistant',
        kind: 'turn',
        trigger: { type: 'manual' },
        fingerprint: {
          appVersion: 'test',
          promptHash: 'prompt',
          toolSchemaHash: 'tools',
          skillBindings: [],
          modelConfig: 'model',
        },
        retention: 'hot',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-3',
        seq: 3,
        conversationId,
        type: 'assistant_message.started',
        createdAt: 3,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-4',
        seq: 4,
        conversationId,
        type: 'tool_call.started',
        createdAt: 4,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        toolCallId: 'tool-question-1',
        name: 'ask_user_question',
        inputSummary: '{"questions":[{"id":"direction"}]}',
        args: { questions: [{ id: 'direction' }] },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-5',
        seq: 5,
        conversationId,
        type: 'assistant_message.completed',
        createdAt: 5,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        stopReason: 'toolUse',
        content: [{
          type: 'toolCall',
          id: 'tool-question-1',
          name: 'ask_user_question',
          arguments: { questions: [{ id: 'direction' }] },
        }],
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-6',
        seq: 6,
        conversationId,
        type: 'user_question.requested',
        createdAt: 6,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        requestId: 'question-1',
        toolCallId: 'tool-question-1',
        request: {
          questions: [{
            id: 'direction',
            type: 'single_choice',
            question: 'Which path?',
            allowReferences: true,
            allowAttachments: true,
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }, {
            id: 'node-context',
            type: 'free_text',
            question: 'Which node has the context?',
            allowReferences: true,
          }, {
            id: 'file-context',
            type: 'free_text',
            question: 'Which file has the context?',
            allowReferences: true,
          }, {
            id: 'attachment-context',
            type: 'free_text',
            question: 'Attach the context.',
            allowAttachments: true,
          }],
        },
      },
    ];
    await new AgentEventStore(dataRoot).appendEvents(conversationId, events);
    const { runtime } = await createRuntime(dataRoot);

    const restored = await runtime.restoreConversation(conversationId);
    expect(restored.pendingUserQuestion?.requestId).toBe('question-1');

    await expectRejects(
      () => runtime.resolveUserQuestion(conversationId, 'question-1', {
        requestId: 'question-1',
        answers: [{ questionId: 'direction', selectedOptionIds: [] }],
      }),
      'Question direction is required.',
    );

    await runtime.resolveUserQuestion(conversationId, 'question-1', {
      requestId: 'question-1',
      answers: [{
        questionId: 'direction',
        selectedOptionIds: ['b'],
        text: 'use [[file:readme^README.md]]',
        nodeRefs: [{ nodeId: 'node-1', title: 'Referenced node' }],
        fileRefs: [{
          attachmentId: 'attachment-1',
          entryKind: 'file',
          name: 'README.md',
          path: 'README.md',
          ref: 'readme',
          mimeType: 'text/markdown',
          sizeBytes: 12,
        }],
        attachments: [{
          id: 'attachment-1',
          kind: 'text',
          name: 'notes.txt',
          ref: 'notes',
          mimeType: 'text/plain',
          sizeBytes: 5,
          text: 'hello',
        }],
      }, {
        questionId: 'node-context',
        nodeRefs: [{ nodeId: 'node-only', title: 'Node only' }],
      }, {
        questionId: 'file-context',
        fileRefs: [{
          attachmentId: 'file-ref-only',
          entryKind: 'file',
          iconDataUrl: 'data:image/png;base64,icon',
          name: 'reference.md',
          path: 'reference.md',
          ref: 'reference',
          mimeType: 'text/markdown',
          sizeBytes: 24,
          thumbnailDataUrl: 'data:image/png;base64,thumb',
        }],
      }, {
        questionId: 'attachment-context',
        attachments: [{
          id: 'attachment-only',
          kind: 'text',
          name: 'context.txt',
          ref: 'context',
          mimeType: 'text/plain',
          sizeBytes: 11,
          text: 'hello world',
        }],
      }],
    });

    const replay = await new AgentEventStore(dataRoot).replay(conversationId);
    expect(replay.userQuestions['question-1']).toMatchObject({
      status: 'answered',
      result: {
        requestId: 'question-1',
        outcome: 'answered',
        answers: [{
          questionId: 'direction',
          selectedOptionIds: ['b'],
          text: 'use [[file:readme^README.md]]',
          nodeRefs: [{ nodeId: 'node-1', label: 'Referenced node' }],
          fileRefs: [{
            attachmentId: 'attachment-1',
            entryKind: 'file',
            name: 'README.md',
            path: 'README.md',
            ref: 'readme',
            mimeType: 'text/markdown',
            sizeBytes: 12,
          }],
          attachments: [{
            id: 'attachment-1',
            kind: 'text',
            name: 'notes.txt',
            ref: 'notes',
            mimeType: 'text/plain',
            sizeBytes: 5,
            payload: expect.objectContaining({ kind: 'payload_ref', mimeType: 'text/plain' }),
          }],
        }, {
          questionId: 'node-context',
          nodeRefs: [{ nodeId: 'node-only', label: 'Node only' }],
        }, {
          questionId: 'file-context',
          fileRefs: [{
            attachmentId: 'file-ref-only',
            entryKind: 'file',
            name: 'reference.md',
            path: 'reference.md',
            ref: 'reference',
            mimeType: 'text/markdown',
            sizeBytes: 24,
          }],
        }, {
          questionId: 'attachment-context',
          attachments: [{
            id: 'attachment-only',
            kind: 'text',
            name: 'context.txt',
            ref: 'context',
            mimeType: 'text/plain',
            sizeBytes: 11,
            payload: expect.objectContaining({ kind: 'payload_ref', mimeType: 'text/plain' }),
          }],
        }],
      },
    });
    const toolResult = getAgentEventActivePath(replay).find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'tool-question-1',
    );
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      actor: { type: 'tool', toolName: 'ask_user_question', toolCallId: 'tool-question-1' },
      parentMessageId: 'assistant-question-1',
      toolName: 'ask_user_question',
      isError: false,
    });
    // Replayed answers render through the shared tool-result envelope, identical to
    // the live ask_user_question result the model sees (format-agnostic structure check).
    expect(toolResult?.content).toHaveLength(1);
    expect(toolResult?.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((toolResult?.content[0] as { text: string }).text)).toEqual({
      ok: true,
      data: replay.userQuestions['question-1']!.result,
    });
  });

  test('resolves durable pending user questions with a discuss outcome', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const conversationId = 'lin-agent-channel-question-discuss';
    const events: AgentEvent[] = [
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-1',
        seq: 1,
        conversationId,
        type: 'conversation.created',
        createdAt: 1,
        actor: { type: 'system' },
        title: 'Question channel',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: 'built-in:tenon:assistant' },
        ],
        goal: 'Question channel',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-2',
        seq: 2,
        conversationId,
        type: 'run.started',
        createdAt: 2,
        actor: { type: 'system' },
        runId: 'run-1',
        agentId: 'built-in:tenon:assistant',
        kind: 'turn',
        trigger: { type: 'manual' },
        fingerprint: {
          appVersion: 'test',
          promptHash: 'prompt',
          toolSchemaHash: 'tools',
          skillBindings: [],
          modelConfig: 'model',
        },
        retention: 'hot',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-3',
        seq: 3,
        conversationId,
        type: 'assistant_message.started',
        createdAt: 3,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-4',
        seq: 4,
        conversationId,
        type: 'tool_call.started',
        createdAt: 4,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        toolCallId: 'tool-question-1',
        name: 'ask_user_question',
        inputSummary: '{"questions":[{"id":"direction"}]}',
        args: { questions: [{ id: 'direction' }] },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-5',
        seq: 5,
        conversationId,
        type: 'assistant_message.completed',
        createdAt: 5,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        stopReason: 'toolUse',
        content: [{
          type: 'toolCall',
          id: 'tool-question-1',
          name: 'ask_user_question',
          arguments: { questions: [{ id: 'direction' }] },
        }],
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-6',
        seq: 6,
        conversationId,
        type: 'user_question.requested',
        createdAt: 6,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        requestId: 'question-1',
        toolCallId: 'tool-question-1',
        request: {
          questions: [{
            id: 'direction',
            type: 'single_choice',
            question: 'Which path?',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }],
        },
      },
    ];
    await new AgentEventStore(dataRoot).appendEvents(conversationId, events);
    const { runtime } = await createRuntime(dataRoot);

    await runtime.resolveUserQuestion(conversationId, 'question-1', {
      requestId: 'question-1',
      outcome: 'discussed',
      discuss: { message: 'Can we discuss the tradeoffs first?' },
      answers: [],
    });

    const replay = await new AgentEventStore(dataRoot).replay(conversationId);
    expect(replay.userQuestions['question-1']).toMatchObject({
      status: 'answered',
      result: {
        requestId: 'question-1',
        outcome: 'discussed',
        discuss: { message: 'Can we discuss the tradeoffs first?' },
        answers: [],
      },
    });
    const toolResult = getAgentEventActivePath(replay).find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'tool-question-1',
    );
    const visible = JSON.parse((toolResult?.content[0] as { text: string }).text);
    expect(visible).toMatchObject({
      ok: true,
      data: {
        requestId: 'question-1',
        outcome: 'discussed',
        discuss: { message: 'Can we discuss the tradeoffs first?' },
        answers: [],
      },
    });
    expect(visible.instructions).toContain('discuss before answering');
  });
});
