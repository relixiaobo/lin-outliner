import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent, AgentPrincipal } from '../../src/core/agentEventLog';
import { buildAgentRenderProjection } from '../../src/core/agentRenderProjection';
import {
  AgentEventStore,
  agentCheckpointFileName,
  agentPayloadFileName,
  agentConversationDirName,
  deriveAgentRunKind,
  LAYOUT_SENTINEL_FILE,
  STORAGE_LAYOUT_VERSION,
  type AgentRunMetaProjection,
} from '../../src/main/agentEventStore';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };

async function withStore<T>(fn: (store: AgentEventStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-events-'));
  try {
    return await fn(new AgentEventStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function base(conversationId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${conversationId}-event-${seq}`,
    seq,
    conversationId,
    type,
    createdAt: 1_700_000_000_000 + seq,
    actor,
  };
}

function testFingerprint(): AgentRunMetaProjection['fingerprint'] {
  return {
    appVersion: 'test',
    promptHash: 'prompt',
    toolSchemaHash: 'tools',
    skillBindings: [],
    modelConfig: 'model',
  };
}

function testRunMeta(
  input: Omit<Partial<AgentRunMetaProjection>, 'execution' | 'fingerprint'> & {
    id: string;
    execution?: Partial<AgentRunMetaProjection['execution']>;
    fingerprint?: Partial<AgentRunMetaProjection['fingerprint']>;
  },
): AgentRunMetaProjection {
  const createdAt = input.createdAt ?? 1;
  return {
    v: 2,
    id: input.id,
    agentId: input.agentId ?? 'built-in:tenon:assistant',
    anchor: input.anchor ?? { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId: 'conversation-1' },
    parentRunId: input.parentRunId,
    parentToolCallId: input.parentToolCallId,
    disposition: input.disposition ?? 'attended',
    context: input.context ?? 'full',
    runProfile: input.runProfile ?? 'default',
    trigger: input.trigger ?? { type: 'manual' },
    fingerprint: { ...testFingerprint(), ...input.fingerprint },
    retention: input.retention ?? 'hot',
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    latestSeq: input.latestSeq ?? 0,
    execution: {
      status: input.execution?.status ?? 'running',
      ...input.execution,
    },
    ...(input.objective ? { objective: input.objective } : {}),
  };
}

describe('agent event store', () => {
  test('appends JSONL events and replays a conversation', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);

      const raw = await readFile(store.paths(conversationId).conversationEventsPath, 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(2);

      const events = await store.readEvents(conversationId);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);

      const replayed = await store.replay(conversationId);
      expect(replayed.conversation?.id).toBe(conversationId);
      expect(replayed.messages['message-1']?.content).toEqual([{ type: 'text', text: 'Hello' }]);
    });
  });

  test('maintains a lightweight conversation index for listing', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 3, 'conversation.renamed'), title: 'Renamed' },
        {
          ...base(conversationId, 4, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 5, 'assistant_message.completed'),
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Assistant reply [[node:Alpha^node-alpha]]' }],
        },
      ]);

      const entries = await store.listConversationIndexEntries();
      expect(entries).toEqual([{
        id: conversationId,
        title: 'Renamed',
        members: [],
        settings: {},
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_005,
        messageCount: 2,
        latestSeq: 5,
        lastMessageSnippet: 'Assistant reply Alpha',
        lastMessageAt: 1_700_000_000_005,
        unreadCount: 0,
      }]);
      const index = JSON.parse(await readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')) as {
        conversations: Record<string, unknown>;
      };
      expect(index.conversations[conversationId]).toBeDefined();
    });
  });

  test('folds unreadCount into the index incrementally without bumping updatedAt', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled', goal: 'g' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const afterMessage = (await store.listConversationIndexEntries())[0]!;
      expect(afterMessage.unreadCount).toBe(0);
      expect(afterMessage.updatedAt).toBe(1_700_000_000_002);

      // Two off-floor deliveries fold to unreadCount 2, and DO NOT bump updatedAt
      // (a background delivery is not conversation activity — review #5).
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 3, 'notification.created'), notificationId: 'n-1', conversationId: conversationId, kind: 'task_completed', title: 'A' },
        { ...base(conversationId, 4, 'notification.created'), notificationId: 'n-2', conversationId: conversationId, kind: 'task_failed', title: 'B' },
      ] as AgentEvent[]);
      const afterNotifs = (await store.listConversationIndexEntries())[0]!;
      expect(afterNotifs.unreadCount).toBe(2);
      expect(afterNotifs.updatedAt).toBe(1_700_000_000_002);

      // A read through the tail clears the fold to 0 (still no updatedAt bump). The
      // index value matches an authoritative full replay (no incremental drift).
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 5, 'notification.read'), conversationId: conversationId, throughSeq: 4 },
      ] as AgentEvent[]);
      const afterRead = (await store.listConversationIndexEntries())[0]!;
      expect(afterRead.unreadCount).toBe(0);
      expect(afterRead.updatedAt).toBe(1_700_000_000_002);
      expect(afterRead.unreadCount).toBe(
        (await store.replay(conversationId)).attentionByConversationId[conversationId]?.unreadCount ?? 0,
      );
    });
  });

  test('writes checkpoints and replays tail events after a checkpoint', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);

      const checkpointState = await store.replay(conversationId);
      const checkpoint = await store.writeCheckpoint(conversationId, checkpointState);
      expect(checkpoint?.seq).toBe(2);
      expect(checkpoint?.targets.conversationByteOffset).toBeGreaterThan(0);
      expect(agentCheckpointFileName(2)).toBe('checkpoint-2.json');
      await expect(readFile(store.checkpointPath(conversationId, 2), 'utf8')).resolves.toContain('"seq":2');

      await store.appendEvents(conversationId, [
        { ...base(conversationId, 3, 'conversation.renamed'), title: 'Renamed' },
        {
          ...base(conversationId, 4, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
      ]);

      const replayed = await store.replay(conversationId);
      expect(replayed.conversation?.title).toBe('Renamed');
      expect(replayed.latestSeq).toBe(4);
      expect(replayed.messages['assistant-1']?.parentMessageId).toBe('message-1');
    });
  });

  test('reads a long trailing JSONL event as the physical tail after restart', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      const runId = 'run-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Long tail' },
        { ...base(conversationId, 2, 'run.started'), runId },
        {
          ...base(conversationId, 3, 'assistant_message.completed'),
          runId,
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'x'.repeat(5_000) }],
        },
      ]);

      const restarted = new AgentEventStore(root);
      await expect(restarted.appendEvents(conversationId, [
        { ...base(conversationId, 4, 'run.completed'), runId },
      ])).resolves.toBeUndefined();

      expect((await restarted.readEvents(conversationId)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    });
  });

  test('falls back to log replay when a checkpoint points past the physical tail', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      await store.writeCheckpoint(conversationId, await store.replay(conversationId));

      const eventsPath = store.paths(conversationId).conversationEventsPath;
      const firstLine = (await readFile(eventsPath, 'utf8')).split('\n')[0]!;
      await writeFile(eventsPath, `${firstLine}\n`, 'utf8');

      const replayed = await store.replay(conversationId);
      expect(replayed.latestSeq).toBe(1);
      expect(replayed.messages['message-1']).toBeUndefined();
    });
  });

  test('falls back to log replay when a checkpoint has a stale replay-state shape', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const checkpoint = await store.writeCheckpoint(conversationId, await store.replay(conversationId));
      expect(checkpoint?.seq).toBe(2);

      const checkpointPath = store.checkpointPath(conversationId, 2);
      const raw = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        state: Record<string, unknown>;
      };
      delete raw.state.dreamsByMessageId;
      await writeFile(checkpointPath, `${JSON.stringify(raw)}\n`, 'utf8');

      const replayed = await store.replay(conversationId);

      expect(replayed.latestSeq).toBe(2);
      expect(replayed.messages['message-1']?.content).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(replayed.dreamsByMessageId).toEqual({});
    });
  });

  test('falls back to log replay when a checkpoint predates context clear replay state', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello before checkpoint' }],
        },
      ]);
      const checkpoint = await store.writeCheckpoint(conversationId, await store.replay(conversationId));
      expect(checkpoint?.seq).toBe(2);

      const checkpointPath = store.checkpointPath(conversationId, 2);
      const raw = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        state: Record<string, unknown>;
      };
      delete raw.state.contextClearsByMessageId;
      await writeFile(checkpointPath, `${JSON.stringify(raw)}\n`, 'utf8');

      const replayed = await store.replay(conversationId);

      expect(replayed.latestSeq).toBe(2);
      expect(replayed.contextClearsByMessageId).toEqual({});
      expect(() => buildAgentRenderProjection(replayed, { revision: 1 })).not.toThrow();
    });
  });

  test('does not write a checkpoint for stale replay state', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const staleState = await store.replay(conversationId);
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 3, 'conversation.renamed'), title: 'Renamed' },
      ]);

      await expect(store.writeCheckpoint(conversationId, staleState)).resolves.toBeNull();
      await expect(readFile(store.checkpointPath(conversationId, 2), 'utf8')).rejects.toThrow();
      expect((await store.replay(conversationId)).latestSeq).toBe(3);
    });
  });

  test('uses an older valid checkpoint when a newer checkpoint is corrupt', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const checkpoint = await store.writeCheckpoint(conversationId, await store.replay(conversationId));
      expect(checkpoint?.seq).toBe(2);

      await store.appendEvents(conversationId, [
        { ...base(conversationId, 3, 'conversation.renamed'), title: 'Renamed' },
      ]);
      await mkdir(store.paths(conversationId).checkpointsDir, { recursive: true });
      await writeFile(store.checkpointPath(conversationId, 99), 'not-json\n', 'utf8');

      const replayed = await store.replay(conversationId);
      expect(replayed.conversation?.title).toBe('Renamed');
      expect(replayed.latestSeq).toBe(3);
    });
  });

  test('retains only recent valid checkpoints and removes stale checkpoint temp files', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Title 1' },
      ]);
      await store.writeCheckpoint(conversationId, await store.replay(conversationId));

      await store.appendEvents(conversationId, [
        { ...base(conversationId, 2, 'conversation.renamed'), title: 'Title 2' },
      ]);
      await store.writeCheckpoint(conversationId, await store.replay(conversationId));

      await mkdir(store.paths(conversationId).checkpointsDir, { recursive: true });
      await writeFile(store.checkpointPath(conversationId, 99), 'not-json\n', 'utf8');
      await writeFile(`${store.checkpointPath(conversationId, 100)}.stale.tmp`, 'partial\n', 'utf8');

      for (let seq = 3; seq <= 5; seq += 1) {
        await store.appendEvents(conversationId, [
          { ...base(conversationId, seq, 'conversation.renamed'), title: `Title ${seq}` },
        ]);
        await store.writeCheckpoint(conversationId, await store.replay(conversationId));
      }

      const checkpointFiles = (await readdir(store.paths(conversationId).checkpointsDir)).sort();
      expect(checkpointFiles).toEqual([
        'checkpoint-3.json',
        'checkpoint-4.json',
        'checkpoint-5.json',
      ]);
      expect((await store.replay(conversationId)).conversation?.title).toBe('Title 5');
    });
  });

  test('maintains derived search and user-message indexes', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Find quarterly planning notes' }],
        },
        {
          ...base(conversationId, 3, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 4, 'assistant_message.completed'),
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Quarterly planning is in the roadmap node.' }],
        },
      ]);

      const userMessages = await store.listUserMessageIndexEntries(conversationId);
      expect(userMessages.map((entry) => entry.messageId)).toEqual(['message-1']);
      expect(userMessages[0]?.preview).toBe('Find quarterly planning notes');
      expect(userMessages[0]?.hasAttachments).toBe(false);

      const results = await store.searchMessages('quarterly roadmap', { conversationId });
      expect(results.map((entry) => entry.messageId)).toEqual(['assistant-1']);
      expect(results[0]?.preview).toBe('Quarterly planning is in the roadmap node.');
    });
  });

  test('keeps the full tool output searchable after a model-context slim', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      const payload = {
        kind: 'payload_ref' as const,
        id: 'tool-output-tool-1',
        storage: 'file' as const,
        mimeType: 'text/plain',
        byteLength: 90_000,
        sha256: 'sha',
        role: 'tool_output' as const,
        summary: 'web output',
        truncated: true,
      };
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 3, 'assistant_message.completed'),
          messageId: 'assistant-1',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'tool-1', name: 'web_fetch', arguments: {} }],
        },
        {
          ...base(conversationId, 4, 'tool_result.created', { type: 'tool', toolName: 'web_fetch', toolCallId: 'tool-1' }),
          messageId: 'tool-result-1',
          parentMessageId: 'assistant-1',
          toolCallId: 'tool-1',
          toolName: 'web_fetch',
          isError: false,
          content: [{ type: 'text', text: 'the rare needle phrase lives in this fetched output' }],
          outputSummary: 'web output',
        },
        { ...base(conversationId, 5, 'payload.created'), payload },
        // The slim replaces only the model copy; the canonical text stays indexed.
        {
          ...base(conversationId, 6, 'tool_result.replaced'),
          runId: 'run-1',
          messageId: 'tool-result-1',
          toolCallId: 'tool-1',
          content: [{ type: 'payload_ref', payload, label: '<persisted-output>\nPreview\n</persisted-output>' }],
          outputSummary: 'web output',
          outputRef: payload,
        },
      ]);

      const results = await store.searchMessages('needle', { conversationId });
      expect(results.map((entry) => entry.messageId)).toContain('tool-result-1');

      // The replace preserves the creation entry's full text and only advances the
      // seq + merges the offload payload id — it must never overwrite the indexed
      // text with the slim preview, nor drop the canonical payload registration.
      const index = JSON.parse(
        await readFile(path.join(root, 'indexes', 'search-index.json'), 'utf8'),
      ) as {
        messages: Record<
          string,
          { messageId: string; latestSeq: number; payloadIds: string[]; normalizedText: string }
        >;
      };
      const entry = Object.values(index.messages).find((message) => message.messageId === 'tool-result-1');
      expect(entry?.payloadIds).toContain('tool-output-tool-1');
      expect(entry?.latestSeq).toBe(6);
      expect(entry?.normalizedText).toContain('needle');
      expect(entry?.normalizedText).not.toContain('persisted-output');
    });
  });

  test('updates the derived user-message index after edits', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Old prompt' }],
        },
        {
          ...base(conversationId, 3, 'user_message.edited', userActor),
          messageId: 'message-1',
          content: [{ type: 'text', text: 'New product strategy prompt' }],
        },
      ]);

      expect(await store.searchMessages('old prompt', { conversationId })).toEqual([]);
      expect((await store.searchMessages('strategy', { conversationId })).map((entry) => entry.messageId)).toEqual(['message-1']);
      expect((await store.listUserMessageIndexEntries(conversationId))[0]?.text).toBe('New product strategy prompt');
    });
  });

  test('rebuilds the derived search index when it is missing', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Recoverable index text' }],
        },
      ]);
      await rm(path.join(root, 'indexes', 'search-index.json'), { force: true });

      expect((await store.searchMessages('recoverable', { conversationId })).map((entry) => entry.messageId)).toEqual(['message-1']);
      await expect(readFile(path.join(root, 'indexes', 'search-index.json'), 'utf8')).resolves.toContain('message-1');
    });
  });

  test('rebuilds the conversation index when the derived index is missing', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      await rm(path.join(root, 'indexes'), { recursive: true, force: true });

      expect(await store.listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
        title: 'Untitled',
        messageCount: 1,
        latestSeq: 2,
        lastMessageSnippet: 'Hello',
        lastMessageAt: 1_700_000_000_002,
      }]);
      await expect(readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')).resolves.toContain(conversationId);
    });
  });

  test('rebuilds the conversation index when the derived index is malformed', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const indexPath = path.join(root, 'indexes', 'conversation-index.json');
      await writeFile(indexPath, 'not-json\n', 'utf8');

      expect(await store.listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
        title: 'Untitled',
        messageCount: 1,
        latestSeq: 2,
      }]);
      await expect(readFile(indexPath, 'utf8')).resolves.toContain(conversationId);
    });
  });

  // --- Pre-release clean-cut: any old-format event artifact wipes event-store owned paths ---

  async function seedCurrentLayout(store: AgentEventStore) {
    const conversationId = 'conversation-1';
    await store.appendEvents(conversationId, [
      { ...base(conversationId, 1, 'conversation.created'), title: 'Current layout' },
    ]);
    const agentPrincipal: AgentPrincipal = { type: 'agent', agentId: 'built-in:tenon:assistant' };
    const userPrincipal: AgentPrincipal = { type: 'user', userId: 'local-user' };
    const writePrincipalRun = (id: string, principal: AgentPrincipal, updatedAt: number) => store.writeRunMeta(testRunMeta({
      id,
      anchor: { type: 'principal', principal },
      disposition: 'detached',
      context: 'none',
      runProfile: 'dream',
      createdAt: updatedAt,
      updatedAt,
      execution: { status: 'completed', completedAt: updatedAt },
    }));
    await writePrincipalRun('run-agent', agentPrincipal, 2);
    await writePrincipalRun('run-user', userPrincipal, 3);
    return { conversationId, agentPrincipal, userPrincipal };
  }

  test('pre-sentinel data (no layout.json) is positive proof and wipes event paths + writes the sentinel', async () => {
    await withStore(async (store, root) => {
      const { conversationId, agentPrincipal, userPrincipal } = await seedCurrentLayout(store);
      await writeFile(path.join(root, 'issue-manager.json'), '{"v":1,"issues":{}}\n', 'utf8');
      // Simulate a pre-sentinel generation: data exists but the sentinel does not.
      await rm(path.join(root, LAYOUT_SENTINEL_FILE), { force: true });

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toEqual([]);
      await expect(restarted.readEvents(conversationId)).resolves.toEqual([]);
      await expect(restarted.listPrincipalRunMetaProjections(agentPrincipal)).resolves.toEqual([]);
      await expect(restarted.listPrincipalRunMetaProjections(userPrincipal)).resolves.toEqual([]);
      expect(JSON.parse(await readFile(path.join(root, LAYOUT_SENTINEL_FILE), 'utf8'))).toEqual({ v: STORAGE_LAYOUT_VERSION });
      await expect(readFile(path.join(root, 'issue-manager.json'), 'utf8')).resolves.toContain('"issues"');
    });
  });

  test('a stale sentinel generation wipes event paths and re-stamps the current one', async () => {
    await withStore(async (store, root) => {
      const { conversationId } = await seedCurrentLayout(store);
      await writeFile(path.join(root, LAYOUT_SENTINEL_FILE), `${JSON.stringify({ v: STORAGE_LAYOUT_VERSION - 1 })}\n`, 'utf8');

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toEqual([]);
      await expect(restarted.readEvents(conversationId)).resolves.toEqual([]);
      expect(JSON.parse(await readFile(path.join(root, LAYOUT_SENTINEL_FILE), 'utf8'))).toEqual({ v: STORAGE_LAYOUT_VERSION });
    });
  });

  test('a current sentinel proceeds with no wipe and no per-conversation probing', async () => {
    await withStore(async (store, root) => {
      const { conversationId, agentPrincipal } = await seedCurrentLayout(store);
      // Old-format artifacts are no longer probed for — the sentinel alone decides.
      await mkdir(path.join(root, 'sessions'), { recursive: true });

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{ id: conversationId }]);
      expect(await restarted.listPrincipalRunMetaProjections(agentPrincipal)).toMatchObject([{ id: 'run-agent' }]);
    });
  });

  test('a corrupt sentinel is ambiguity: fail OPEN — no wipe, store fully functional (#180 invariants)', async () => {
    await withStore(async (store, root) => {
      const { conversationId, agentPrincipal } = await seedCurrentLayout(store);
      await writeFile(path.join(root, LAYOUT_SENTINEL_FILE), 'not-json {{{', 'utf8');

      const restarted = new AgentEventStore(root);
      // The destructive path requires positive proof; corruption is not proof.
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{ id: conversationId }]);
      expect(await restarted.listPrincipalRunMetaProjections(agentPrincipal)).toMatchObject([{ id: 'run-agent' }]);
      // The corrupt sentinel is left for the next launch to re-probe — never overwritten blindly.
      await expect(readFile(path.join(root, LAYOUT_SENTINEL_FILE), 'utf8')).resolves.toContain('not-json');
    });
  });

  test('a sentinel with a non-integer v is ambiguity too — fail open', async () => {
    await withStore(async (store, root) => {
      const { conversationId } = await seedCurrentLayout(store);
      await writeFile(path.join(root, LAYOUT_SENTINEL_FILE), '{"v":"2"}\n', 'utf8');

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{ id: conversationId }]);
    });
  });

  test('current-vocabulary data survives a restart untouched (no false-positive wipe)', async () => {
    await withStore(async (store, root) => {
      const { conversationId, agentPrincipal, userPrincipal } = await seedCurrentLayout(store);
      // An orphaned CURRENT index is a rebuild case, not a clean-cut marker.
      await writeFile(path.join(root, 'indexes', 'conversation-index.json'), JSON.stringify({
        conversations: {
          'missing-conversation': {
            id: 'missing-conversation',
            title: 'Missing',
            createdAt: 1,
            updatedAt: 9_999,
            messageCount: 1,
            latestSeq: 1,
          },
        },
      }), 'utf8');

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
        title: 'Current layout',
      }]);
      expect(await restarted.listPrincipalRunMetaProjections(agentPrincipal)).toMatchObject([{ id: 'run-agent' }]);
      expect(await restarted.listPrincipalRunMetaProjections(userPrincipal)).toMatchObject([{ id: 'run-user' }]);
      // Principal sidecars live under principals/.
      expect((await readdir(path.join(root, 'principals'))).sort()).toEqual([
        'agent-built-in%3Atenon%3Aassistant',
        'user-local-user',
      ]);
    });
  });

  test('user-controllable content can never trip the wipe (structured detection, gate #180 #1)', async () => {
    await withStore(async (store, root) => {
      // Title/goal carry the legacy markers as TEXT — a substring probe would
      // match them; the structured field check must not.
      const conversationId = 'conversation-tricky';
      await store.appendEvents(conversationId, [
        {
          ...base(conversationId, 1, 'conversation.created'),
          title: 'Renaming "sessionId" and "type":"session.created" sessionId session.created',
          goal: 'Document the session.* → conversation.* cut; sessionId must die',
        } as AgentEvent,
      ]);

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
      }]);
      const replayed = await restarted.replay(conversationId);
      expect(replayed.conversation?.title).toContain('"sessionId"');
    });
  });

  test('a non-JSON head line is ambiguity, not a legacy marker (no wipe)', async () => {
    await withStore(async (store, root) => {
      const { conversationId } = await seedCurrentLayout(store);
      const tornDir = path.join(root, 'conversations', agentConversationDirName('torn-1'), 'segments');
      await mkdir(tornDir, { recursive: true });
      await writeFile(path.join(tornDir, '000001.jsonl'), '{"v":1,"eventId":"torn', 'utf8');

      const restarted = new AgentEventStore(root);
      // The destructive path requires positive proof; the good conversation survives.
      await expect(restarted.readEvents(conversationId)).resolves.toHaveLength(1);
    });
  });

  test('a probe error fails open instead of bricking the store (gate #180 #2)', async () => {
    await withStore(async (store, root) => {
      const { conversationId } = await seedCurrentLayout(store);
      // `agents` as a regular FILE makes the pool probe throw ENOTDIR (not ENOENT).
      await rm(path.join(root, 'agents'), { recursive: true, force: true });
      await writeFile(path.join(root, 'agents'), 'not a directory', 'utf8');

      const restarted = new AgentEventStore(root);
      // Fail-open: the store keeps serving the current layout...
      await expect(restarted.readEvents(conversationId)).resolves.toHaveLength(1);
      // ...and the memoized layout promise is not a sticky rejection — later
      // accesses (including writes) keep working within the same instance.
      await restarted.appendEvents(conversationId, [
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-after-probe-error',
          parentMessageId: null,
          content: [{ type: 'text', text: 'still alive' }],
        } as AgentEvent,
      ]);
      await expect(restarted.readEvents(conversationId)).resolves.toHaveLength(2);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{ id: conversationId }]);
    });
  });

  test('rebuilds stale conversation indexes that do not match conversations', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Indexed conversation' },
      ]);
      await writeFile(path.join(root, 'indexes', 'conversation-index.json'), JSON.stringify({
        conversations: {
          'missing-conversation': {
            id: 'missing-conversation',
            title: 'Missing',
            createdAt: 1,
            updatedAt: 9_999,
            messageCount: 1,
            latestSeq: 1,
          },
        },
      }), 'utf8');

      expect(await new AgentEventStore(root).listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
        title: 'Indexed conversation',
      }]);
      const rebuilt = JSON.parse(await readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')) as {
        conversations: Record<string, unknown>;
      };
      expect(Object.keys(rebuilt.conversations)).toEqual([conversationId]);
    });
  });

  test('rebuilds old conversation indexes that lack list summary fields', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Indexed conversation' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Fresh summary' }],
        },
      ]);
      await writeFile(path.join(root, 'indexes', 'conversation-index.json'), JSON.stringify({
        conversations: {
          [conversationId]: {
            id: conversationId,
            title: 'Indexed conversation',
            members: [],
            createdAt: 1_700_000_000_001,
            updatedAt: 1_700_000_000_002,
            messageCount: 1,
            latestSeq: 2,
            unreadCount: 0,
          },
        },
      }), 'utf8');

      expect(await new AgentEventStore(root).listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
        lastMessageSnippet: 'Fresh summary',
        lastMessageAt: 1_700_000_000_002,
      }]);
    });
  });

  test('removes deleted conversations from the derived conversation index', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
      ]);

      await store.deleteConversation(conversationId);

      expect(await store.listConversationIndexEntries()).toEqual([]);
      expect(await store.listConversationIds()).toEqual([]);
    });
  });

  test('rejects appends that are not after the persisted tail seq', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
      ]);

      await expect(store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.renamed'), eventId: 'event-late', title: 'Late' },
      ])).rejects.toThrow(/not after existing seq/);
    });
  });

  test('encodes conversation ids as safe directory names', async () => {
    await withStore(async (store, root) => {
      const conversationId = '../conversation.with/slashes';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Untitled' },
      ]);

      expect(agentConversationDirName(conversationId)).not.toContain('..');
      expect(store.paths(conversationId).conversationDir.startsWith(path.join(root, 'conversations'))).toBe(true);
      expect(await store.listConversationIds()).toEqual([conversationId]);
    });
  });

  test('splits conversation events from run execution events and joins them for replay', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const runId = 'run-1';

      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Split test' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Run a tool' }],
        },
        {
          ...base(conversationId, 3, 'run.started'),
          runId,
          agentId: 'built-in:tenon:assistant',
          disposition: 'attended',
          trigger: { type: 'message', messageId: 'message-1' },
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
          ...base(conversationId, 4, 'assistant_message.started'),
          runId,
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 5, 'assistant_message.completed'),
          runId,
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done' }],
        },
        {
          ...base(conversationId, 6, 'run.completed'),
          runId,
        },
      ]);

      const conversationRaw = await readFile(store.paths(conversationId).conversationEventsPath, 'utf8');
      expect(conversationRaw).toContain('conversation.created');
      expect(conversationRaw).toContain('user_message.created');
      expect(conversationRaw).not.toContain('assistant_message.started');

      const runRaw = await readFile(store.runPaths(runId).runEventsPath, 'utf8');
      expect(runRaw).toContain('run.started');
      expect(runRaw).toContain('assistant_message.completed');

      const runMeta = JSON.parse(await readFile(store.runPaths(runId).runMetaPath, 'utf8')) as {
        v: number;
        agentId: string;
        anchor: { type: string; agentId: string; conversationId?: string };
        trigger: { type: string; messageId?: string };
        fingerprint: { appVersion: string };
        execution: { status: string };
        context: string;
        runProfile: string;
        retention: string;
      };
      expect(runMeta).toMatchObject({
        v: 2,
        agentId: 'built-in:tenon:assistant',
        anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId: conversationId },
        trigger: { type: 'message', messageId: 'message-1' },
        fingerprint: { appVersion: 'test' },
        context: 'full',
        runProfile: 'default',
        execution: { status: 'completed' },
        retention: 'hot',
      });
      const runIndex = JSON.parse(await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(runIndex.runIds).toEqual([runId]);

      expect((await store.readEvents(conversationId)).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await store.listConversationIndexEntries()).toMatchObject([{
        id: conversationId,
        title: 'Split test',
        latestSeq: 6,
      }]);
    });
  });

  test('rebuilds the derived per-conversation run index when it is missing', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const runId = 'run-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Run index rebuild' },
        { ...base(conversationId, 2, 'run.started'), runId },
        {
          ...base(conversationId, 3, 'assistant_message.started'),
          runId,
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
      ]);

      await rm(store.paths(conversationId).conversationRunIndexPath, { force: true });

      expect((await store.readEvents(conversationId)).map((event) => event.seq)).toEqual([1, 2, 3]);
      const rebuilt = JSON.parse(await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual([runId]);
    });
  });

  test('does not rebuild the run index from obsolete flat run metadata', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-legacy-run-meta';
      const runId = 'run-legacy-meta';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Legacy run meta' },
        { ...base(conversationId, 2, 'run.started'), runId },
        {
          ...base(conversationId, 3, 'assistant_message.started'),
          runId,
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
      ]);
      await writeFile(store.runPaths(runId).runMetaPath, `${JSON.stringify({
        v: 1,
        id: runId,
        agentId: 'built-in:tenon:assistant',
        conversationId: conversationId,
        kind: 'turn',
        status: 'running',
        trigger: { type: 'manual' },
        fingerprint: {
          appVersion: 'test',
          promptHash: 'prompt',
          toolSchemaHash: 'tools',
          skillBindings: [],
          modelConfig: 'model',
        },
        retention: 'hot',
        createdAt: 1_700_000_000_002,
        updatedAt: 1_700_000_000_003,
        latestSeq: 3,
      })}\n`);
      await rm(store.paths(conversationId).conversationRunIndexPath, { force: true });

      expect((await store.readEvents(conversationId)).map((event) => event.seq)).toEqual([1]);
      const rebuilt = JSON.parse(await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual([]);
    });
  });

  test('leaves principal-anchored runs out of a conversation run index rebuild', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-agent-anchor';
      const runId = 'run-agent-anchor';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Agent anchor filter' },
      ]);
      const runPaths = store.runPaths(runId);
      await mkdir(runPaths.runDir, { recursive: true });
      await writeFile(runPaths.runMetaPath, `${JSON.stringify(testRunMeta({
        id: runId,
        anchor: { type: 'principal', principal: { type: 'agent', agentId: 'built-in:tenon:assistant' } },
        trigger: { type: 'system' },
        createdAt: 1_700_000_000_002,
        updatedAt: 1_700_000_000_003,
        latestSeq: 3,
        execution: { status: 'completed', completedAt: 1_700_000_000_003 },
      }))}\n`);
      await rm(store.paths(conversationId).conversationRunIndexPath, { force: true });

      expect((await store.readEvents(conversationId)).map((event) => event.seq)).toEqual([1]);
      const rebuilt = JSON.parse(await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual([]);
    });
  });

  test('leaves live-appended principal-anchored runs out of the conversation run index', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-live-agent-anchor';
      const runId = 'run-live-agent-anchor';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Live agent anchor filter' },
        {
          ...base(conversationId, 2, 'run.started'),
          runId,
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'principal', principal: { type: 'agent', agentId: 'built-in:tenon:assistant' } },
          kind: 'scheduled',
          trigger: { type: 'system' },
          fingerprint: {
            appVersion: 'test',
            promptHash: 'prompt',
            toolSchemaHash: 'tools',
            skillBindings: [],
            modelConfig: 'model',
          },
          retention: 'hot',
        },
      ]);

      const runRaw = await readFile(store.runPaths(runId).runEventsPath, 'utf8');
      expect(runRaw).toContain('run.started');
      const runMeta = JSON.parse(await readFile(store.runPaths(runId).runMetaPath, 'utf8')) as {
        anchor: { type: string };
      };
      expect(runMeta.anchor).toEqual({ type: 'principal', principal: { type: 'agent', agentId: 'built-in:tenon:assistant' } });

      const index = JSON.parse(await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(index.runIds).toEqual([]);
      expect((await store.readEvents(conversationId)).map((event) => event.seq)).toEqual([1]);
    });
  });

  test('preserves existing runs when appending after the derived run index is missing', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Run index merge' },
        { ...base(conversationId, 2, 'run.started'), runId: 'run-1' },
        {
          ...base(conversationId, 3, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
      ]);
      await rm(store.paths(conversationId).conversationRunIndexPath, { force: true });

      await store.appendEvents(conversationId, [
        { ...base(conversationId, 4, 'run.started'), runId: 'run-2' },
      ]);

      expect((await store.readEvents(conversationId)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      const rebuilt = JSON.parse(await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual(['run-1', 'run-2']);
    });
  });

  test('does not rewrite metadata for streaming delta-only appends', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const runId = 'run-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Delta test' },
        {
          ...base(conversationId, 2, 'run.started'),
          runId,
          agentId: 'built-in:tenon:assistant',
          disposition: 'attended',
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
      ]);
      const conversationMetaBefore = await readFile(store.paths(conversationId).conversationMetaPath, 'utf8');
      const runMetaBefore = await readFile(store.runPaths(runId).runMetaPath, 'utf8');
      const runIndexBefore = await readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8');

      await store.appendEvents(conversationId, [{
        ...base(conversationId, 3, 'assistant_message.delta'),
        runId,
        messageId: 'assistant-1',
        delta: { type: 'text_delta', text: 'stream' },
        providerChunkCount: 1,
        startedAt: 1_700_000_000_003,
        endedAt: 1_700_000_000_003,
      }]);

      await expect(readFile(store.paths(conversationId).conversationMetaPath, 'utf8')).resolves.toBe(conversationMetaBefore);
      await expect(readFile(store.runPaths(runId).runMetaPath, 'utf8')).resolves.toBe(runMetaBefore);
      await expect(readFile(store.paths(conversationId).conversationRunIndexPath, 'utf8')).resolves.toBe(runIndexBefore);
    });
  });

  test('persists terminal usage for failed and cancelled runs', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const usage = {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      };
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Usage test' },
        { ...base(conversationId, 2, 'run.started'), runId: 'run-failed' },
        { ...base(conversationId, 3, 'run.failed'), runId: 'run-failed', errorMessage: 'Nope', usage },
        { ...base(conversationId, 4, 'run.started'), runId: 'run-cancelled' },
        { ...base(conversationId, 5, 'run.cancelled'), runId: 'run-cancelled', usage },
      ]);

      const failedMeta = JSON.parse(await readFile(store.runPaths('run-failed').runMetaPath, 'utf8')) as { execution?: { usage?: unknown; error?: string } };
      const cancelledMeta = JSON.parse(await readFile(store.runPaths('run-cancelled').runMetaPath, 'utf8')) as { execution?: { usage?: unknown } };
      expect(failedMeta.execution?.usage).toEqual(usage);
      expect(failedMeta.execution?.error).toBe('Nope');
      expect(cancelledMeta.execution?.usage).toEqual(usage);
    });
  });

  test('keeps any run-scoped event with a runId in the run log', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const runId = 'run-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Run scoped' },
        { ...base(conversationId, 2, 'run.started'), runId },
        {
          ...base(conversationId, 3, 'skill.created'),
          runId,
          skillId: 'skill-1',
          source: 'project',
          summary: 'Run-local skill audit',
        },
      ]);

      const conversationRaw = await readFile(store.paths(conversationId).conversationEventsPath, 'utf8');
      const runRaw = await readFile(store.runPaths(runId).runEventsPath, 'utf8');
      expect(conversationRaw).not.toContain('skill.created');
      expect(runRaw).toContain('skill.created');
      expect((await store.readEvents(conversationId)).map((event) => event.type)).toEqual([
        'conversation.created',
        'run.started',
        'skill.created',
      ]);
    });
  });

  test('reports malformed JSONL line numbers', async () => {
    await withStore(async (store, root) => {
      // Hand-seeded data needs the current-generation sentinel, or the store
      // treats the root as another generation and wipes it (by design).
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, LAYOUT_SENTINEL_FILE), `${JSON.stringify({ v: STORAGE_LAYOUT_VERSION })}\n`, 'utf8');
      const conversationId = 'conversation-1';
      const eventsPath = store.paths(conversationId).conversationEventsPath;
      await mkdir(path.dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, '{"v":1}\nnot-json\n', 'utf8');

      await expect(store.readEvents(conversationId)).rejects.toThrow(/\.jsonl:2/);
    });
  });

  test('a torn trailing line in a delegated-run ledger is dropped on read and truncated on the next append', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const runId = 'child-torn-tail';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Torn tail' },
      ]);
      const runEvent = (seq: number): AgentEvent => ({
        ...base(conversationId, seq, 'user_message.created', userActor),
        eventId: `${runId}-evt-${seq}`,
        runId,
        messageId: `${runId}-message-${seq}`,
        parentMessageId: seq === 1 ? null : `${runId}-message-${seq - 1}`,
        content: [{ type: 'text', text: `child message ${seq}` }],
      } as AgentEvent);
      await store.appendRunStreamEvents(conversationId, runId, [runEvent(1), runEvent(2)]);

      // Crash artifact: an interrupted append leaves half a JSON object as the
      // final line of the run's events.jsonl.
      const runEventsPath = store.runPaths(runId).runEventsPath;
      await writeFile(runEventsPath, `${await readFile(runEventsPath, 'utf8')}{"v":1,"eventId":"TORN-FRAGMENT`, 'utf8');

      // Read: the torn FINAL line is dropped; the intact prefix stays readable
      // (a corrupt child ledger must never brick its parent conversation).
      const events = await store.readRunStreamEvents(runId);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
      expect((await store.replayRunStream(runId)).latestSeq).toBe(2);

      // Append (a resume): the before-append repair truncates the fragment, the
      // new event lands after the intact tail, and the file is whole again.
      await store.appendRunStreamEvents(conversationId, runId, [runEvent(3)]);
      const after = await store.readRunStreamEvents(runId);
      expect(after.map((event) => event.seq)).toEqual([1, 2, 3]);
      const raw = await readFile(runEventsPath, 'utf8');
      expect(raw.includes('TORN-FRAGMENT')).toBe(false);
      expect(raw.endsWith('\n')).toBe(true);

      // A malformed line in the MIDDLE is real corruption and still fails loudly.
      await writeFile(runEventsPath, `not-json\n${raw}`, 'utf8');
      await expect(store.readRunStreamEvents(runId)).rejects.toThrow(/agent run event JSON/);
    });
  });

  test('projects delegated run stream metadata into v2 run meta', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-run-meta-v2';
      const runId = 'child-run-meta-v2';
      const usage = { input: 11, output: 7, totalTokens: 18, cost: { total: 0.002 } };
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Run meta v2' },
      ]);
      await store.appendRunStreamEvents(conversationId, runId, [
        {
          ...base(conversationId, 1, 'run.started'),
          eventId: `${runId}-start`,
          runId,
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
          parentToolCallId: 'tool-spawn-1',
          disposition: 'detached',
          context: 'brief',
          runProfile: 'research',
          objective: 'Research the run graph.',
          criteria: ['Find the storage seam'],
          objectiveRole: 'worker',
          objectiveStatus: 'active',
          verificationRequired: true,
          verificationAttemptBase: 1,
          verifierGapSignatures: ['missing evidence', 'missing evidence'],
          purpose: 'work',
          scope: {
            resources: {
              paths: ['src/main'],
              nodes: ['node:output'],
              writableNodes: [],
              creatableNodeParents: ['node:output'],
            },
          },
          budget: { tokens: 1000, spentTokens: 100 },
          trigger: { type: 'parent-run', parentRunId: 'parent-run-1' },
          fingerprint: testFingerprint(),
          retention: 'hot',
        },
        {
          ...base(conversationId, 2, 'run.result.submitted'),
          eventId: `${runId}-submitted`,
          runId,
          summary: 'The storage seam is in the run ledger.',
          source: 'final_assistant_message',
        },
        {
          ...base(conversationId, 3, 'run.failed'),
          eventId: `${runId}-failed`,
          runId,
          errorMessage: 'Verifier rejected the evidence.',
          objectiveStatus: 'blocked',
          budget: { tokens: 1000, spentTokens: 250 },
          blockedReason: 'Missing evidence',
          latestVerifierGap: 'No tool evidence',
          verifierGapSignatures: ['missing evidence', 'missing evidence'],
          usage,
        },
      ]);

      await expect(store.readRunMetaProjection(runId)).resolves.toMatchObject({
        v: 2,
        id: runId,
        parentRunId: 'parent-run-1',
        parentToolCallId: 'tool-spawn-1',
        disposition: 'detached',
        context: 'brief',
        runProfile: 'research',
        execution: {
          status: 'failed',
          completedAt: 1_700_000_000_003,
          error: 'Verifier rejected the evidence.',
          usage,
        },
        objective: {
          text: 'Research the run graph.',
          criteria: ['Find the storage seam'],
          role: 'worker',
          status: 'blocked',
          verificationRequired: true,
          verificationAttemptBase: 1,
          verifierGapSignatures: ['missing evidence', 'missing evidence'],
          scope: {
            resources: {
              paths: ['src/main'],
              nodes: ['node:output'],
              writableNodes: [],
              creatableNodeParents: ['node:output'],
            },
          },
          budget: { tokens: 1000, spentTokens: 250 },
          blockedReason: 'Missing evidence',
          latestVerifierGap: 'No tool evidence',
          latestSubmissionSeq: 2,
        },
      });
      await expect(store.listConversationRunMetaProjections(conversationId)).resolves.toMatchObject([
        { id: runId, parentToolCallId: 'tool-spawn-1', runProfile: 'research' },
      ]);

      await store.appendRunStreamEvents(conversationId, runId, [
        {
          ...base(conversationId, 4, 'run.started'),
          eventId: `${runId}-resume`,
          runId,
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
          objectiveStatus: 'active',
          verifierGapSignatures: ['missing evidence', 'missing evidence'],
          trigger: { type: 'parent-run', parentRunId: 'parent-run-1' },
        },
      ]);
      const activeMeta = await store.readRunMetaProjection(runId);
      expect(activeMeta?.objective).toMatchObject({
        status: 'active',
        verificationAttemptBase: 1,
        verifierGapSignatures: ['missing evidence', 'missing evidence'],
      });
      expect(activeMeta?.objective?.blockedReason).toBeUndefined();
      expect(activeMeta?.objective?.latestVerifierGap).toBeUndefined();
      expect(activeMeta?.objective?.latestSubmissionSeq).toBeUndefined();

      await store.appendRunStreamEvents(conversationId, runId, [
        {
          ...base(conversationId, 5, 'run.completed'),
          eventId: `${runId}-verified`,
          runId,
          objectiveStatus: 'verified',
          verifierGapSignatures: [],
        },
      ]);
      const verifiedMeta = await store.readRunMetaProjection(runId);
      expect(verifiedMeta?.objective).toMatchObject({
        status: 'verified',
        verificationAttemptBase: 1,
        verifierGapSignatures: [],
      });
      expect(verifiedMeta?.objective?.blockedReason).toBeUndefined();
      expect(verifiedMeta?.objective?.latestVerifierGap).toBeUndefined();
    });
  });

  test('folds resumed run lifecycle metadata through running before the next terminal', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-run-resume-meta';
      const runId = 'child-run-resume-meta';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Run resume meta' },
      ]);
      await store.appendRunStreamEvents(conversationId, runId, [
        {
          ...base(conversationId, 1, 'run.started'),
          eventId: `${runId}-start`,
          runId,
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
          objective: 'Resume safely.',
          objectiveRole: 'worker',
          objectiveStatus: 'active',
          trigger: { type: 'system' },
        },
        {
          ...base(conversationId, 2, 'run.completed'),
          eventId: `${runId}-completed`,
          runId,
          objectiveStatus: 'verified',
        },
      ]);

      await expect(store.readRunMetaProjection(runId)).resolves.toMatchObject({
        execution: { status: 'completed', completedAt: 1_700_000_000_002 },
        objective: { status: 'verified' },
      });

      await store.appendRunStreamEvents(conversationId, runId, [
        {
          ...base(conversationId, 3, 'run.started'),
          eventId: `${runId}-resume`,
          runId,
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
          objective: 'Use the amended objective.',
          criteria: ['Return the amended result.'],
          objectiveRole: 'controller',
          objectiveStatus: 'active',
          trigger: { type: 'system' },
        },
      ]);

      const runningMeta = await store.readRunMetaProjection(runId);
      expect(runningMeta?.execution.status).toBe('running');
      expect(runningMeta?.execution.completedAt).toBeUndefined();
      expect(runningMeta?.execution.error).toBeUndefined();
      expect(runningMeta?.objective).toMatchObject({
        text: 'Use the amended objective.',
        criteria: ['Return the amended result.'],
        role: 'controller',
        status: 'active',
      });

      await store.appendRunStreamEvents(conversationId, runId, [
        {
          ...base(conversationId, 4, 'run.failed'),
          eventId: `${runId}-failed`,
          runId,
          errorMessage: 'resume failed',
          objective: 'Use the final amended objective.',
          criteria: ['Return final amended evidence.'],
          objectiveRole: 'controller',
          objectiveStatus: 'blocked',
        },
      ]);

      await expect(store.readRunMetaProjection(runId)).resolves.toMatchObject({
        execution: {
          status: 'failed',
          completedAt: 1_700_000_000_004,
          error: 'resume failed',
        },
        objective: {
          text: 'Use the final amended objective.',
          criteria: ['Return final amended evidence.'],
          role: 'controller',
          status: 'blocked',
        },
      });
    });
  });

  test('concurrent conversation and delegated-run appends never drop a run from the run index', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'conversation-1';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Index race' },
      ]);

      // runs.json is a read-modify-write merge reached from two different
      // serial queues (per-conversation event queue vs per-run ledger queue).
      // Each round races one turn-run append against one delegated-run append;
      // a lost update permanently drops the turn run from the index, and cold
      // replay then silently misses that turn-run ledger's events.
      const turnRunSeqs: number[] = [];
      const jobs: Promise<unknown>[] = [];
      let seq = 1;
      for (let round = 0; round < 16; round += 1) {
        const turnRunId = `turn-run-${round}`;
        const childRunId = `child-run-${round}`;
        const startSeq = (seq += 1);
        const messageSeq = (seq += 1);
        const doneSeq = (seq += 1);
        turnRunSeqs.push(startSeq, doneSeq);
        const childEvent = (childSeq: number): AgentEvent => ({
          ...base(conversationId, childSeq, childSeq === 1 ? 'run.started' : 'run.completed'),
          eventId: `${childRunId}-evt-${childSeq}`,
          runId: childRunId,
          ...(childSeq === 1 ? { disposition: 'attended' } : {}),
        } as AgentEvent);
        jobs.push(store.appendEvents(conversationId, [
          { ...base(conversationId, startSeq, 'run.started'), runId: turnRunId },
          {
            ...base(conversationId, messageSeq, 'user_message.created', userActor),
            runId: turnRunId,
            messageId: `message-${round}`,
            parentMessageId: null,
            content: [{ type: 'text', text: `turn ${round}` }],
          },
          { ...base(conversationId, doneSeq, 'run.completed'), runId: turnRunId },
        ]));
        jobs.push(store.appendRunStreamEvents(conversationId, childRunId, [childEvent(1), childEvent(2)]));
      }
      await Promise.all(jobs);

      // Cold replay: every turn run's ledger must still join the conversation
      // (run.started/run.completed live in the run's OWN events file, so a
      // dropped index entry makes them vanish from the join).
      const replayedSeqs = (await new AgentEventStore(root).readEvents(conversationId)).map((event) => event.seq);
      for (const turnRunSeq of turnRunSeqs) expect(replayedSeqs).toContain(turnRunSeq);
    });
  });

  test('stores payload bytes outside the JSONL event stream', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const payload = await store.writePayload(conversationId, {
        id: 'screen/shot',
        data: Buffer.from('image-bytes'),
        mimeType: 'image/png',
        role: 'source',
        summary: 'Screenshot',
        display: { width: 800, height: 600 },
      });

      expect(payload).toMatchObject({
        id: 'screen/shot',
        mimeType: 'image/png',
        byteLength: 11,
        role: 'source',
        summary: 'Screenshot',
        display: { width: 800, height: 600 },
      });
      expect(payload.sha256).toHaveLength(64);
      expect(agentPayloadFileName(payload.id, payload.mimeType)).toMatch(/^screen_shot-[a-f0-9]{12}\.png$/);
      expect(agentPayloadFileName('screen:shot', payload.mimeType)).not.toBe(agentPayloadFileName(payload.id, payload.mimeType));
      expect(agentPayloadFileName('screen_shot', payload.mimeType)).not.toBe(agentPayloadFileName(payload.id, payload.mimeType));
      await expect(readFile(store.payloadPath(conversationId, payload), 'utf8')).resolves.toBe('image-bytes');
      await expect(store.readPayload(conversationId, payload)).resolves.toEqual(Buffer.from('image-bytes'));
    });
  });

  test('stores run-scoped payload bytes under the owning run', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-1';
      const runId = 'run-1';
      const payload = await store.writePayload(conversationId, {
        runId,
        id: 'tool-output-1',
        data: 'tool bytes',
        mimeType: 'text/plain',
        role: 'tool_output',
      });

      expect(payload.scope).toEqual({ type: 'run', conversationId: conversationId, runId });
      await expect(readFile(store.payloadPath(conversationId, payload), 'utf8')).resolves.toBe('tool bytes');
      expect(store.payloadPath(conversationId, payload).startsWith(store.runPaths(runId).payloadsDir)).toBe(true);
    });
  });

  test('persists stable agent identity records', async () => {
    await withStore(async (store) => {
      await store.writeAgentIdentity({
        agentId: 'built-in:tenon:assistant',
        displayName: 'Neva',
        model: 'test-model',
        systemPrompt: 'You are Tenon.',
        skills: ['skill-a'],
      });

      await expect(readFile(store.agentPaths('built-in:tenon:assistant').identityPath, 'utf8')).resolves.toContain('test-model');
      await expect(store.readAgentIdentity('built-in:tenon:assistant')).resolves.toMatchObject({
        agentId: 'built-in:tenon:assistant',
        displayName: 'Neva',
        model: 'test-model',
        skills: ['skill-a'],
      });
    });
  });

  test('limits conversation run meta reads from the run index tail', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-run-limit';
      const writeRun = (id: string, createdAt: number) => store.writeRunMeta(testRunMeta({
        id,
        anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
        createdAt,
        updatedAt: createdAt,
        latestSeq: createdAt,
        execution: { status: 'completed', completedAt: createdAt },
      }));
      await writeRun('dream-run-1', 1);
      await writeRun('dream-run-2', 2);
      await writeRun('dream-run-3', 3);

      await expect(store.listConversationRunMetaProjections(conversationId, { limit: 2 }))
        .resolves.toMatchObject([
          { id: 'dream-run-2' },
          { id: 'dream-run-3' },
        ]);
      await expect(store.listConversationRunMetaProjections(conversationId, { limit: 0 }))
        .resolves.toEqual([]);
    });
  });

  test('retains only recent conversation run ledgers and anchor markers', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-run-retention';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Dream retention' },
      ]);
      let seq = 2;
      let previousAssistantMessageId: string | null = null;
      const appendRun = async (runId: string, label: string) => {
        const anchorMessageId = `anchor-${runId}`;
        const assistantMessageId = `assistant-${runId}`;
        await store.appendEvents(conversationId, [
          {
            ...base(conversationId, seq++, 'user_message.created', userActor),
            messageId: anchorMessageId,
            parentMessageId: previousAssistantMessageId,
            content: [{ type: 'text', text: `${label} anchor prompt` }],
          },
          { ...base(conversationId, seq++, 'branch.selected'), leafMessageId: anchorMessageId },
          { ...base(conversationId, seq++, 'run.started'), runId },
          {
            ...base(conversationId, seq++, 'assistant_message.started'),
            runId,
            messageId: assistantMessageId,
            parentMessageId: anchorMessageId,
            providerId: 'test',
            modelId: 'test',
          },
          {
            ...base(conversationId, seq++, 'assistant_message.completed'),
            runId,
            messageId: assistantMessageId,
            stopReason: 'stop',
            content: [{ type: 'text', text: `${label} assistant transcript` }],
          },
          { ...base(conversationId, seq++, 'run.completed'), runId },
          {
            ...base(conversationId, seq++, 'dream.finished'),
            messageId: anchorMessageId,
            agentId: 'built-in:tenon:assistant',
            runId,
            trigger: { type: 'manual' },
            status: 'completed',
            startedAt: 1_700_000_000_000 + seq,
            completedAt: 1_700_000_000_000 + seq,
          },
        ]);
        previousAssistantMessageId = assistantMessageId;
      };

      await appendRun('run-1', 'forgotten');
      await appendRun('run-2', 'retained-two');
      await appendRun('run-3', 'retained-three');

      expect(await store.searchMessages('forgotten', { conversationId })).toHaveLength(2);
      await expect(store.retainRecentConversationRuns(conversationId, 2))
        .resolves.toEqual({ prunedRunIds: ['run-1'], retainedRunIds: ['run-2', 'run-3'] });

      const events = await store.readEvents(conversationId);
      expect(events.map((event) => event.type)).toEqual([
        'conversation.created',
        'user_message.created',
        'branch.selected',
        'run.started',
        'assistant_message.started',
        'assistant_message.completed',
        'run.completed',
        'dream.finished',
        'user_message.created',
        'branch.selected',
        'run.started',
        'assistant_message.started',
        'assistant_message.completed',
        'run.completed',
        'dream.finished',
      ]);
      expect(events.some((event) => event.type === 'dream.finished' && event.runId === 'run-1')).toBe(false);
      expect(events.some((event) => event.type === 'user_message.created' && event.messageId === 'anchor-run-1')).toBe(false);
      expect(events.find((event) => event.type === 'user_message.created' && event.messageId === 'anchor-run-2')).toMatchObject({
        parentMessageId: null,
      });
      expect(events.some((event) => event.type === 'assistant_message.completed' && event.messageId === 'assistant-run-2')).toBe(true);
      await expect(readFile(store.runPaths('run-1').runMetaPath, 'utf8')).rejects.toThrow();
      await expect(readFile(store.runPaths('run-2').runMetaPath, 'utf8')).resolves.toContain('"id":"run-2"');
      await expect(store.listConversationRunMetaProjections(conversationId)).resolves.toMatchObject([
        { id: 'run-2' },
        { id: 'run-3' },
      ]);
      await expect(store.searchMessages('forgotten', { conversationId })).resolves.toHaveLength(0);
      await expect(store.searchMessages('retained-two', { conversationId })).resolves.toHaveLength(2);
    });
  });

  test('does not mutate retained run storage when retention validation fails', async () => {
    await withStore(async (store) => {
      const conversationId = 'conversation-run-retention-invalid';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Invalid retention' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'anchor-run-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'old anchor' }],
        },
        { ...base(conversationId, 3, 'run.started'), runId: 'run-1' },
        {
          ...base(conversationId, 4, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-run-1',
          parentMessageId: 'anchor-run-1',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 5, 'assistant_message.completed'),
          runId: 'run-1',
          messageId: 'assistant-run-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'old assistant' }],
        },
        { ...base(conversationId, 6, 'run.completed'), runId: 'run-1' },
        {
          ...base(conversationId, 7, 'user_message.created', userActor),
          messageId: 'anchor-run-2',
          parentMessageId: 'missing-message-that-is-not-pruned',
          content: [{ type: 'text', text: 'retained anchor' }],
        },
        { ...base(conversationId, 8, 'run.started'), runId: 'run-2' },
      ]);
      const rawBefore = await readFile(store.paths(conversationId).conversationEventsPath, 'utf8');

      await expect(store.retainRecentConversationRuns(conversationId, 1))
        .rejects.toThrow('Missing parent agent message: missing-message-that-is-not-pruned');

      await expect(readFile(store.paths(conversationId).conversationEventsPath, 'utf8')).resolves.toBe(rawBefore);
      await expect(readFile(store.runPaths('run-1').runMetaPath, 'utf8')).resolves.toContain('"id":"run-1"');
    });
  });

  test('persists principal-anchored reflective run meta for Dream runs', async () => {
    await withStore(async (store) => {
      const writeDreamMeta = (id: string, principal: AgentPrincipal) => store.writeRunMeta(testRunMeta({
        id,
        anchor: { type: 'principal', principal },
        disposition: 'detached',
        context: 'none',
        runProfile: 'dream',
        trigger: { type: 'schedule', schedule: '2026-01-01T03:00 RRULE:FREQ=DAILY', dueAt: 1_800_000_000_000 },
        fingerprint: { toolSchemaHash: 'no-tools' },
        createdAt: 100,
        updatedAt: 120,
        execution: { status: 'completed', completedAt: 120 },
      }));
      const agent: AgentPrincipal = { type: 'agent', agentId: 'built-in:tenon:assistant' };
      const user: AgentPrincipal = { type: 'user', userId: 'local-user' };
      await writeDreamMeta('dream-run-1', agent);
      await writeDreamMeta('dream-run-user', user);

      await expect(store.readRunMetaProjection('dream-run-1')).resolves.toMatchObject({
        id: 'dream-run-1',
        anchor: { type: 'principal', principal: agent },
        disposition: 'detached',
        trigger: { type: 'schedule' },
      });
      const dreamMeta = await store.readRunMetaProjection('dream-run-1');
      expect(dreamMeta && deriveAgentRunKind(dreamMeta)).toBe('reflective');
      expect(JSON.parse(await readFile(store.runPaths('dream-run-1').runMetaPath, 'utf8'))).not.toHaveProperty('kind');
      // Each principal's run index lists only the runs maintaining ITS pool — the executor
      // (agentId) does not leak the user-Dream into the agent's run history.
      await expect(store.listPrincipalRunMetaProjections(agent)).resolves.toMatchObject([{
        id: 'dream-run-1',
        disposition: 'detached',
        runProfile: 'dream',
        execution: { status: 'completed' },
      }]);
      await expect(store.listPrincipalRunMetaProjections(user)).resolves.toMatchObject([{
        id: 'dream-run-user',
        disposition: 'detached',
        runProfile: 'dream',
        execution: { status: 'completed' },
      }]);
    });
  });
});
