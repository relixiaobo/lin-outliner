import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { TOOL_CATALOG } from '../../src/core/agentToolCatalog';
import { DEFAULT_GENERAL_CHANNEL_ID, DEFAULT_GENERAL_CHANNEL_TITLE } from '../../src/core/agentChannel';
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
  test('exposes the built-in Tenon assistant as a directly editable agent definition', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);

    const definitions = await runtime.listAllAgentDefinitions('workspace');
    const assistant = definitions.find((definition) => definition.agentId === ASSISTANT_AGENT_ID);

    expect(assistant).toMatchObject({
      agentId: ASSISTANT_AGENT_ID,
      name: 'assistant',
      displayName: 'Neva',
      source: 'built-in',
      rootDir: 'built-in',
      agentFile: 'built-in/assistant',
      description: 'Default Tenon assistant profile.',
      // Editable in place (its edits persist to the settings overlay, not a file).
      writable: true,
    });
    expect(assistant?.body).toContain('You are Neva.');
  });

  test('the registry loads only Neva — a dropped AGENT.md under .agents/agents is ignored (one-Neva invariant)', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    // A user drops a file-backed agent under the workspace agents dir. Pre-collapse this
    // would have loaded a second agent; the registry now never scans it.
    await createProjectAgent(localRoot, 'shadow-researcher');
    const { runtime } = await createRuntime(dataRoot, localRoot);

    const definitions = await runtime.listAllAgentDefinitions('workspace');

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ agentId: ASSISTANT_AGENT_ID, name: 'assistant', source: 'built-in' });
  });

  test('editing the built-in assistant overlays display name + persona, keeping the stable id', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    try {
      await runtime.updateAgentDefinition('workspace', ASSISTANT_AGENT_ID, {
        name: 'Lin',
        description: 'My editing partner',
        body: 'You are Lin. Be terse.',
      });

      const assistant = (await runtime.listAllAgentDefinitions('workspace'))
        .find((definition) => definition.agentId === ASSISTANT_AGENT_ID);

      // The name field edits the DISPLAY name; the stable id / `name` is untouched, so
      // memory anchored to the agentId never orphans on a rename.
      expect(assistant?.agentId).toBe(ASSISTANT_AGENT_ID);
      expect(assistant?.name).toBe('assistant');
      expect(assistant?.displayName).toBe('Lin');
      expect(assistant?.description).toBe('My editing partner');
      expect(assistant?.body).toBe('You are Lin. Be terse.');
      expect(assistant?.writable).toBe(true);
    } finally {
      // The overlay lives under the shared mocked userData — reset it so sibling tests
      // still see the default Neva.
      await rm(path.join(electronUserDataRoot, 'agent-providers.json'), { force: true });
    }
  });

  test('re-saving the built-in with an unchanged persona/description does not freeze them into the overlay', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    try {
      const before = (await runtime.listAllAgentDefinitions('workspace'))
        .find((definition) => definition.agentId === ASSISTANT_AGENT_ID);
      // The user only renames; the persona + description round-trip unchanged through the
      // form (the editor loads them from the materialized definition).
      await runtime.updateAgentDefinition('workspace', ASSISTANT_AGENT_ID, {
        name: 'Lin',
        description: before?.description,
        body: before?.body,
      });

      // Only the field the user actually changed (displayName) is stored. Persisting the
      // unchanged persona/description would freeze them at edit time, so a later change to
      // the code default (NEVA_AGENT_PERSONA) would be silently ignored.
      const overlay = JSON.parse(
        await readFile(path.join(electronUserDataRoot, 'agent-providers.json'), 'utf8'),
      ) as { builtInAgentProfiles?: Record<string, Record<string, unknown>> };
      const entries = Object.values(overlay.builtInAgentProfiles ?? {});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ displayName: 'Lin' });
    } finally {
      await rm(path.join(electronUserDataRoot, 'agent-providers.json'), { force: true });
    }
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

  test('#General membership is exactly {user, Neva}', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    const { runtime } = await createRuntime(dataRoot, localRoot);

    await runtime.restoreConversation(DEFAULT_GENERAL_CHANNEL_ID);
    // The one-Neva invariant: the only conversation members are the local user and
    // Neva. There is no second agent to add, and no member.added beyond setup.
    const state = await new AgentEventStore(dataRoot).replay(DEFAULT_GENERAL_CHANNEL_ID);
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: ASSISTANT_AGENT_ID },
    ]);
    expect((await new AgentEventStore(dataRoot).readEvents(DEFAULT_GENERAL_CHANNEL_ID))
      .filter((event) => event.type === 'member.added'))
      .toHaveLength(0);
  });

  test('creates, renames, and deletes channels; #General stays immutable', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);

    await runtime.restoreLatestConversation();
    const channel = await runtime.createConversation({ title: 'Initial Project' });
    let channels = await runtime.listConversations();

    expect(channel.conversationId).toMatch(/^lin-agent-channel-/);
    expect(channels.map((entry) => entry.id)).toEqual([DEFAULT_GENERAL_CHANNEL_ID, channel.conversationId]);
    expect(channels.find((entry) => entry.id === channel.conversationId)).toMatchObject({
      id: channel.conversationId,
      title: 'Initial Project',
      goal: 'Initial Project',
      members: [
        { type: 'user', userId: 'local-user' },
        { type: 'agent', agentId: ASSISTANT_AGENT_ID },
      ],
    });

    const renamed = await runtime.renameConversation(channel.conversationId, 'Project Alpha');
    channels = await runtime.listConversations();

    expect(renamed).toMatchObject({ title: 'Project Alpha', goal: 'Project Alpha' });
    expect(channels.find((entry) => entry.id === channel.conversationId))
      .toMatchObject({ title: 'Project Alpha', goal: 'Project Alpha' });
    await expectRejects(() => runtime.renameConversation(DEFAULT_GENERAL_CHANNEL_ID, 'Town Square'), '#General cannot be renamed');
    await expectRejects(() => runtime.deleteConversation(DEFAULT_GENERAL_CHANNEL_ID), '#General cannot be deleted');

    await runtime.deleteConversation(channel.conversationId);
    expect((await runtime.listConversations()).map((entry) => entry.id))
      .toEqual([DEFAULT_GENERAL_CHANNEL_ID]);
  });

  test('Channel creation requires a name; a channel always has exactly {user, Neva}', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    // A project agent definition exists, but it is a delegation child-type — it
    // must never join a conversation as a member (single-agent collapse).
    await createProjectAgent(localRoot);
    const { runtime } = await createRuntime(dataRoot, localRoot);

    await expectRejects(
      () => runtime.createConversation(),
      'requires a name',
    );

    const soloChannel = await runtime.createConversation({
      title: 'Solo channel',
    });
    const state = await new AgentEventStore(dataRoot).replay(soloChannel.conversationId);

    expect(state.conversation?.goal).toBe('Solo channel');
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: ASSISTANT_AGENT_ID },
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

describe('resolveAgentToolFilter', () => {
  const CORE_TOOLS = ['past_chats', 'node_create', 'node_edit', 'node_read', 'skill'] as const;

  test('external (file) agents keep a strict allow-list passthrough', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    expect(
      resolveAgentToolFilter({ isBuiltIn: false, tools: ['file_read', 'bash'], disallowedTools: ['web_fetch'] }),
    ).toEqual({ allowedTools: ['file_read', 'bash'], disallowedTools: ['web_fetch'] });
  });

  test('built-in with no restriction or an explicit `*` never sets an allow-list', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    expect(resolveAgentToolFilter({ isBuiltIn: true, tools: undefined, disallowedTools: undefined }))
      .toEqual({ allowedTools: undefined, disallowedTools: undefined });
    expect(resolveAgentToolFilter({ isBuiltIn: true, tools: ['*'], disallowedTools: ['web_fetch'] }))
      .toEqual({ allowedTools: undefined, disallowedTools: ['web_fetch'] });
  });

  test('a built-in catalog restriction becomes a disallow-list over the unchecked catalog — never an allow-list, so core tools stay on', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    const result = resolveAgentToolFilter({ isBuiltIn: true, tools: ['file_read', 'bash'], disallowedTools: undefined });
    // No allow-list — a strict allow-list would also strip Neva's core tools.
    expect(result.allowedTools).toBeUndefined();
    // Exactly the catalog tools the user left unchecked are disallowed.
    expect(result.disallowedTools).toEqual(TOOL_CATALOG.filter((name) => name !== 'file_read' && name !== 'bash'));
    // No core tool ever leaks into the disallow-list.
    for (const core of CORE_TOOLS) expect(result.disallowedTools).not.toContain(core);
  });

  test('a built-in restriction merges with an explicit disallow-list without duplicates', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    const result = resolveAgentToolFilter({ isBuiltIn: true, tools: ['file_read'], disallowedTools: ['bash', 'web_fetch'] });
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toEqual([
      'bash',
      'web_fetch',
      ...TOOL_CATALOG.filter((name) => name !== 'file_read' && name !== 'bash' && name !== 'web_fetch'),
    ]);
    expect(new Set(result.disallowedTools).size).toBe(result.disallowedTools!.length);
  });
});

describe('builtInModelEffortChanged', () => {
  test('a persona/display-name-only edit (model + effort round-tripped unchanged) is not a change', async () => {
    const { builtInModelEffortChanged } = await loadRuntimeModule();
    // The composer chip and the editor both re-send the existing model/effort.
    // Re-resolving on such an edit would silently swap a live conversation's
    // model when the active provider had changed since setup — the #2 bug.
    expect(builtInModelEffortChanged({ model: 'inherit', effort: '' }, { model: 'inherit', effort: '' })).toBe(false);
    expect(builtInModelEffortChanged({ model: 'openai/gpt-5.4', effort: 'high' }, { model: 'openai/gpt-5.4', effort: 'high' })).toBe(false);
  });

  test('the unset sentinels (undefined / blank / whitespace / `inherit`) all normalize together', async () => {
    const { builtInModelEffortChanged } = await loadRuntimeModule();
    expect(builtInModelEffortChanged({ model: undefined, effort: undefined }, { model: 'inherit', effort: '' })).toBe(false);
    expect(builtInModelEffortChanged({ model: '  ', effort: '  ' }, { model: 'inherit', effort: '' })).toBe(false);
    expect(builtInModelEffortChanged({ model: null, effort: null }, { model: undefined, effort: undefined })).toBe(false);
  });

  test('an actual model or effort move is a change', async () => {
    const { builtInModelEffortChanged } = await loadRuntimeModule();
    expect(builtInModelEffortChanged({ model: 'inherit', effort: '' }, { model: 'openai/gpt-5.4', effort: '' })).toBe(true);
    expect(builtInModelEffortChanged({ model: 'openai/gpt-5.4', effort: 'low' }, { model: 'openai/gpt-5.4', effort: 'high' })).toBe(true);
    // Setting an explicit model that happens to equal `inherit`'s resolution is
    // still an unset model — not a change.
    expect(builtInModelEffortChanged({ model: 'inherit', effort: 'high' }, { model: '', effort: 'high' })).toBe(false);
  });
});
