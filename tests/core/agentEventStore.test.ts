import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import {
  AgentEventStore,
  agentCheckpointFileName,
  agentPayloadFileName,
  agentConversationDirName,
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

function base(sessionId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${sessionId}-event-${seq}`,
    seq,
    sessionId,
    type,
    createdAt: 1_700_000_000_000 + seq,
    actor,
  };
}

describe('agent event store', () => {
  test('appends JSONL events and replays a session', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);

      const raw = await readFile(store.paths(sessionId).conversationEventsPath, 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(2);

      const events = await store.readEvents(sessionId);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);

      const replayed = await store.replay(sessionId);
      expect(replayed.session?.id).toBe(sessionId);
      expect(replayed.messages['message-1']?.content).toEqual([{ type: 'text', text: 'Hello' }]);
    });
  });

  test('maintains a lightweight session index for listing', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 3, 'session.renamed'), title: 'Renamed' },
        {
          ...base(sessionId, 4, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
      ]);

      const entries = await store.listConversationIndexEntries();
      expect(entries).toEqual([{
        id: sessionId,
        title: 'Renamed',
        members: [],
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_004,
        messageCount: 2,
        latestSeq: 4,
      }]);
      const index = JSON.parse(await readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')) as {
        conversations: Record<string, unknown>;
      };
      expect(index.conversations[sessionId]).toBeDefined();
    });
  });

  test('writes checkpoints and replays tail events after a checkpoint', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);

      const checkpointState = await store.replay(sessionId);
      const checkpoint = await store.writeCheckpoint(sessionId, checkpointState);
      expect(checkpoint?.seq).toBe(2);
      expect(checkpoint?.targets.conversationByteOffset).toBeGreaterThan(0);
      expect(agentCheckpointFileName(2)).toBe('checkpoint-2.json');
      await expect(readFile(store.checkpointPath(sessionId, 2), 'utf8')).resolves.toContain('"seq":2');

      await store.appendEvents(sessionId, [
        { ...base(sessionId, 3, 'session.renamed'), title: 'Renamed' },
        {
          ...base(sessionId, 4, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
      ]);

      const replayed = await store.replay(sessionId);
      expect(replayed.session?.title).toBe('Renamed');
      expect(replayed.latestSeq).toBe(4);
      expect(replayed.messages['assistant-1']?.parentMessageId).toBe('message-1');
    });
  });

  test('reads a long trailing JSONL event as the physical tail after restart', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      const runId = 'run-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Long tail' },
        { ...base(sessionId, 2, 'run.started'), runId },
        {
          ...base(sessionId, 3, 'assistant_message.completed'),
          runId,
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'x'.repeat(5_000) }],
        },
      ]);

      const restarted = new AgentEventStore(root);
      await expect(restarted.appendEvents(sessionId, [
        { ...base(sessionId, 4, 'run.completed'), runId },
      ])).resolves.toBeUndefined();

      expect((await restarted.readEvents(sessionId)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    });
  });

  test('falls back to log replay when a checkpoint points past the physical tail', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      await store.writeCheckpoint(sessionId, await store.replay(sessionId));

      const eventsPath = store.paths(sessionId).conversationEventsPath;
      const firstLine = (await readFile(eventsPath, 'utf8')).split('\n')[0]!;
      await writeFile(eventsPath, `${firstLine}\n`, 'utf8');

      const replayed = await store.replay(sessionId);
      expect(replayed.latestSeq).toBe(1);
      expect(replayed.messages['message-1']).toBeUndefined();
    });
  });

  test('falls back to log replay when a checkpoint has a stale replay-state shape', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const checkpoint = await store.writeCheckpoint(sessionId, await store.replay(sessionId));
      expect(checkpoint?.seq).toBe(2);

      const checkpointPath = store.checkpointPath(sessionId, 2);
      const raw = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        state: Record<string, unknown>;
      };
      delete raw.state.dreamsByMessageId;
      await writeFile(checkpointPath, `${JSON.stringify(raw)}\n`, 'utf8');

      const replayed = await store.replay(sessionId);

      expect(replayed.latestSeq).toBe(2);
      expect(replayed.messages['message-1']?.content).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(replayed.dreamsByMessageId).toEqual({});
    });
  });

  test('does not write a checkpoint for stale replay state', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const staleState = await store.replay(sessionId);
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 3, 'session.renamed'), title: 'Renamed' },
      ]);

      await expect(store.writeCheckpoint(sessionId, staleState)).resolves.toBeNull();
      await expect(readFile(store.checkpointPath(sessionId, 2), 'utf8')).rejects.toThrow();
      expect((await store.replay(sessionId)).latestSeq).toBe(3);
    });
  });

  test('uses an older valid checkpoint when a newer checkpoint is corrupt', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const checkpoint = await store.writeCheckpoint(sessionId, await store.replay(sessionId));
      expect(checkpoint?.seq).toBe(2);

      await store.appendEvents(sessionId, [
        { ...base(sessionId, 3, 'session.renamed'), title: 'Renamed' },
      ]);
      await mkdir(store.paths(sessionId).checkpointsDir, { recursive: true });
      await writeFile(store.checkpointPath(sessionId, 99), 'not-json\n', 'utf8');

      const replayed = await store.replay(sessionId);
      expect(replayed.session?.title).toBe('Renamed');
      expect(replayed.latestSeq).toBe(3);
    });
  });

  test('retains only recent valid checkpoints and removes stale checkpoint temp files', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Title 1' },
      ]);
      await store.writeCheckpoint(sessionId, await store.replay(sessionId));

      await store.appendEvents(sessionId, [
        { ...base(sessionId, 2, 'session.renamed'), title: 'Title 2' },
      ]);
      await store.writeCheckpoint(sessionId, await store.replay(sessionId));

      await mkdir(store.paths(sessionId).checkpointsDir, { recursive: true });
      await writeFile(store.checkpointPath(sessionId, 99), 'not-json\n', 'utf8');
      await writeFile(`${store.checkpointPath(sessionId, 100)}.stale.tmp`, 'partial\n', 'utf8');

      for (let seq = 3; seq <= 5; seq += 1) {
        await store.appendEvents(sessionId, [
          { ...base(sessionId, seq, 'session.renamed'), title: `Title ${seq}` },
        ]);
        await store.writeCheckpoint(sessionId, await store.replay(sessionId));
      }

      const checkpointFiles = (await readdir(store.paths(sessionId).checkpointsDir)).sort();
      expect(checkpointFiles).toEqual([
        'checkpoint-3.json',
        'checkpoint-4.json',
        'checkpoint-5.json',
      ]);
      expect((await store.replay(sessionId)).session?.title).toBe('Title 5');
    });
  });

  test('maintains derived search and user-message indexes', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Find quarterly planning notes' }],
        },
        {
          ...base(sessionId, 3, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 4, 'assistant_message.completed'),
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Quarterly planning is in the roadmap node.' }],
        },
      ]);

      const userMessages = await store.listUserMessageIndexEntries(sessionId);
      expect(userMessages.map((entry) => entry.messageId)).toEqual(['message-1']);
      expect(userMessages[0]?.preview).toBe('Find quarterly planning notes');
      expect(userMessages[0]?.hasAttachments).toBe(false);

      const results = await store.searchMessages('quarterly roadmap', { sessionId });
      expect(results.map((entry) => entry.messageId)).toEqual(['assistant-1']);
      expect(results[0]?.preview).toBe('Quarterly planning is in the roadmap node.');
    });
  });

  test('updates the derived user-message index after edits', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Old prompt' }],
        },
        {
          ...base(sessionId, 3, 'user_message.edited', userActor),
          messageId: 'message-1',
          content: [{ type: 'text', text: 'New product strategy prompt' }],
        },
      ]);

      expect(await store.searchMessages('old prompt', { sessionId })).toEqual([]);
      expect((await store.searchMessages('strategy', { sessionId })).map((entry) => entry.messageId)).toEqual(['message-1']);
      expect((await store.listUserMessageIndexEntries(sessionId))[0]?.text).toBe('New product strategy prompt');
    });
  });

  test('rebuilds the derived search index when it is missing', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Recoverable index text' }],
        },
      ]);
      await rm(path.join(root, 'indexes', 'search-index.json'), { force: true });

      expect((await store.searchMessages('recoverable', { sessionId })).map((entry) => entry.messageId)).toEqual(['message-1']);
      await expect(readFile(path.join(root, 'indexes', 'search-index.json'), 'utf8')).resolves.toContain('message-1');
    });
  });

  test('rebuilds the session index when the derived index is missing', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      await rm(path.join(root, 'indexes'), { recursive: true, force: true });

      expect(await store.listConversationIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Untitled',
        messageCount: 1,
        latestSeq: 2,
      }]);
      await expect(readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')).resolves.toContain(sessionId);
    });
  });

  test('rebuilds the conversation index when the derived index is malformed', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
      const indexPath = path.join(root, 'indexes', 'conversation-index.json');
      await writeFile(indexPath, 'not-json\n', 'utf8');

      expect(await store.listConversationIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Untitled',
        messageCount: 1,
        latestSeq: 2,
      }]);
      await expect(readFile(indexPath, 'utf8')).resolves.toContain(sessionId);
    });
  });

  test('drops legacy flat sessions and stale indexes on first access', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      const agentId = 'built-in:tenon:assistant';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Current layout' },
      ]);
      await store.addMemoryEntry(agentId, {
        id: 'memory-legacy',
        fact: 'Legacy memory should not cross the clean cut.',
        sources: [{ conversationId: sessionId }],
      });

      await mkdir(path.join(root, 'sessions', 'legacy-session'), { recursive: true });
      await writeFile(path.join(root, 'indexes', 'session-index.json'), JSON.stringify({
        sessions: {
          'legacy-session': {
            id: 'legacy-session',
            title: 'Legacy',
            createdAt: 1,
            updatedAt: 9_999,
            messageCount: 1,
            latestSeq: 1,
          },
        },
      }), 'utf8');

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Current layout',
      }]);
      await expect(readdir(path.join(root, 'sessions'))).rejects.toThrow();
      await expect(readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')).resolves.toContain(sessionId);
      await expect(restarted.readMemoryEvents(agentId)).resolves.toEqual([]);
    });
  });

  test('drops an orphaned legacy session index from the current storage layout', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Current layout' },
      ]);
      const legacyIndexPath = path.join(root, 'indexes', 'session-index.json');
      await writeFile(legacyIndexPath, JSON.stringify({
        sessions: {
          'legacy-session': {
            id: 'legacy-session',
            title: 'Legacy',
            createdAt: 1,
            updatedAt: 9_999,
            messageCount: 1,
            latestSeq: 1,
          },
        },
      }), 'utf8');

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Current layout',
      }]);
      await expect(readFile(legacyIndexPath, 'utf8')).rejects.toThrow();
      await expect(readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')).resolves.toContain(sessionId);
    });
  });

  test('rebuilds stale conversation indexes that do not match conversations', async () => {
    await withStore(async (store, root) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Indexed conversation' },
      ]);
      await writeFile(path.join(root, 'indexes', 'conversation-index.json'), JSON.stringify({
        conversations: {
          'missing-session': {
            id: 'missing-session',
            title: 'Missing',
            createdAt: 1,
            updatedAt: 9_999,
            messageCount: 1,
            latestSeq: 1,
          },
        },
      }), 'utf8');

      expect(await new AgentEventStore(root).listConversationIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Indexed conversation',
      }]);
      const rebuilt = JSON.parse(await readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8')) as {
        conversations: Record<string, unknown>;
      };
      expect(Object.keys(rebuilt.conversations)).toEqual([sessionId]);
    });
  });

  test('removes deleted conversations from the derived conversation index', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
      ]);

      await store.deleteConversation(sessionId);

      expect(await store.listConversationIndexEntries()).toEqual([]);
      expect(await store.listConversationIds()).toEqual([]);
    });
  });

  test('rejects appends that are not after the persisted tail seq', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
      ]);

      await expect(store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.renamed'), eventId: 'event-late', title: 'Late' },
      ])).rejects.toThrow(/not after existing seq/);
    });
  });

  test('encodes session ids as safe directory names', async () => {
    await withStore(async (store, root) => {
      const sessionId = '../session.with/slashes';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
      ]);

      expect(agentConversationDirName(sessionId)).not.toContain('..');
      expect(store.paths(sessionId).conversationDir.startsWith(path.join(root, 'conversations'))).toBe(true);
      expect(await store.listConversationIds()).toEqual([sessionId]);
    });
  });

  test('splits conversation events from run execution events and joins them for replay', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const runId = 'run-1';

      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Split test' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'message-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Run a tool' }],
        },
        {
          ...base(sessionId, 3, 'run.started'),
          runId,
          agentId: 'built-in:tenon:assistant',
          kind: 'turn',
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
          ...base(sessionId, 4, 'assistant_message.started'),
          runId,
          messageId: 'assistant-1',
          parentMessageId: 'message-1',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 5, 'assistant_message.completed'),
          runId,
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done' }],
        },
        {
          ...base(sessionId, 6, 'run.completed'),
          runId,
        },
      ]);

      const conversationRaw = await readFile(store.paths(sessionId).conversationEventsPath, 'utf8');
      expect(conversationRaw).toContain('session.created');
      expect(conversationRaw).toContain('user_message.created');
      expect(conversationRaw).not.toContain('assistant_message.started');

      const runRaw = await readFile(store.runPaths(runId).runEventsPath, 'utf8');
      expect(runRaw).toContain('run.started');
      expect(runRaw).toContain('assistant_message.completed');

      const runMeta = JSON.parse(await readFile(store.runPaths(runId).runMetaPath, 'utf8')) as {
        agentId: string;
        anchor: { type: string; agentId: string; conversationId?: string };
        trigger: { type: string; messageId?: string };
        fingerprint: { appVersion: string };
        status: string;
        retention: string;
      };
      expect(runMeta).toMatchObject({
        agentId: 'built-in:tenon:assistant',
        anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId: sessionId },
        trigger: { type: 'message', messageId: 'message-1' },
        fingerprint: { appVersion: 'test' },
        status: 'completed',
        retention: 'hot',
      });
      const runIndex = JSON.parse(await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(runIndex.runIds).toEqual([runId]);

      expect((await store.readEvents(sessionId)).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await store.listConversationIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Split test',
        latestSeq: 6,
      }]);
    });
  });

  test('rebuilds the derived per-conversation run index when it is missing', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const runId = 'run-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Run index rebuild' },
        { ...base(sessionId, 2, 'run.started'), runId },
        {
          ...base(sessionId, 3, 'assistant_message.started'),
          runId,
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
      ]);

      await rm(store.paths(sessionId).conversationRunIndexPath, { force: true });

      expect((await store.readEvents(sessionId)).map((event) => event.seq)).toEqual([1, 2, 3]);
      const rebuilt = JSON.parse(await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual([runId]);
    });
  });

  test('rebuilds the run index from legacy flat conversation run metadata', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-legacy-run-meta';
      const runId = 'run-legacy-meta';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Legacy run meta' },
        { ...base(sessionId, 2, 'run.started'), runId },
        {
          ...base(sessionId, 3, 'assistant_message.started'),
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
        conversationId: sessionId,
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
      await rm(store.paths(sessionId).conversationRunIndexPath, { force: true });

      expect((await store.readEvents(sessionId)).map((event) => event.seq)).toEqual([1, 2, 3]);
      const rebuilt = JSON.parse(await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual([runId]);
    });
  });

  test('leaves agent-anchored runs out of a conversation run index rebuild', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-agent-anchor';
      const runId = 'run-agent-anchor';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Agent anchor filter' },
      ]);
      const runPaths = store.runPaths(runId);
      await mkdir(runPaths.runDir, { recursive: true });
      await writeFile(runPaths.runMetaPath, `${JSON.stringify({
        v: 1,
        id: runId,
        agentId: 'built-in:tenon:assistant',
        anchor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        kind: 'scheduled',
        status: 'completed',
        trigger: { type: 'system' },
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
      await rm(store.paths(sessionId).conversationRunIndexPath, { force: true });

      expect((await store.readEvents(sessionId)).map((event) => event.seq)).toEqual([1]);
      const rebuilt = JSON.parse(await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual([]);
    });
  });

  test('leaves live-appended agent-anchored runs out of the conversation run index', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-live-agent-anchor';
      const runId = 'run-live-agent-anchor';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Live agent anchor filter' },
        {
          ...base(sessionId, 2, 'run.started'),
          runId,
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
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
        anchor: { type: string; agentId: string };
      };
      expect(runMeta.anchor).toEqual({ type: 'agent', agentId: 'built-in:tenon:assistant' });

      const index = JSON.parse(await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(index.runIds).toEqual([]);
      expect((await store.readEvents(sessionId)).map((event) => event.seq)).toEqual([1]);
    });
  });

  test('preserves existing runs when appending after the derived run index is missing', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Run index merge' },
        { ...base(sessionId, 2, 'run.started'), runId: 'run-1' },
        {
          ...base(sessionId, 3, 'assistant_message.started'),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
      ]);
      await rm(store.paths(sessionId).conversationRunIndexPath, { force: true });

      await store.appendEvents(sessionId, [
        { ...base(sessionId, 4, 'run.started'), runId: 'run-2' },
      ]);

      expect((await store.readEvents(sessionId)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      const rebuilt = JSON.parse(await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')) as {
        runIds: string[];
      };
      expect(rebuilt.runIds).toEqual(['run-1', 'run-2']);
    });
  });

  test('does not rewrite metadata for streaming delta-only appends', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const runId = 'run-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Delta test' },
        {
          ...base(sessionId, 2, 'run.started'),
          runId,
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
      ]);
      const conversationMetaBefore = await readFile(store.paths(sessionId).conversationMetaPath, 'utf8');
      const runMetaBefore = await readFile(store.runPaths(runId).runMetaPath, 'utf8');
      const runIndexBefore = await readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8');

      await store.appendEvents(sessionId, [{
        ...base(sessionId, 3, 'assistant_message.delta'),
        runId,
        messageId: 'assistant-1',
        delta: { type: 'text_delta', text: 'stream' },
        providerChunkCount: 1,
        startedAt: 1_700_000_000_003,
        endedAt: 1_700_000_000_003,
      }]);

      await expect(readFile(store.paths(sessionId).conversationMetaPath, 'utf8')).resolves.toBe(conversationMetaBefore);
      await expect(readFile(store.runPaths(runId).runMetaPath, 'utf8')).resolves.toBe(runMetaBefore);
      await expect(readFile(store.paths(sessionId).conversationRunIndexPath, 'utf8')).resolves.toBe(runIndexBefore);
    });
  });

  test('persists terminal usage for failed and cancelled runs', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const usage = {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      };
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Usage test' },
        { ...base(sessionId, 2, 'run.started'), runId: 'run-failed' },
        { ...base(sessionId, 3, 'run.failed'), runId: 'run-failed', errorMessage: 'Nope', usage },
        { ...base(sessionId, 4, 'run.started'), runId: 'run-cancelled' },
        { ...base(sessionId, 5, 'run.cancelled'), runId: 'run-cancelled', usage },
      ]);

      const failedMeta = JSON.parse(await readFile(store.runPaths('run-failed').runMetaPath, 'utf8')) as { usage?: unknown };
      const cancelledMeta = JSON.parse(await readFile(store.runPaths('run-cancelled').runMetaPath, 'utf8')) as { usage?: unknown };
      expect(failedMeta.usage).toEqual(usage);
      expect(cancelledMeta.usage).toEqual(usage);
    });
  });

  test('keeps any run-scoped event with a runId in the run log', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const runId = 'run-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Run scoped' },
        { ...base(sessionId, 2, 'run.started'), runId },
        {
          ...base(sessionId, 3, 'task.created'),
          runId,
          taskId: 'task-1',
          title: 'Run-local task',
        },
      ]);

      const conversationRaw = await readFile(store.paths(sessionId).conversationEventsPath, 'utf8');
      const runRaw = await readFile(store.runPaths(runId).runEventsPath, 'utf8');
      expect(conversationRaw).not.toContain('task.created');
      expect(runRaw).toContain('task.created');
      expect((await store.readEvents(sessionId)).map((event) => event.type)).toEqual([
        'session.created',
        'run.started',
        'task.created',
      ]);
    });
  });

  test('reports malformed JSONL line numbers', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const eventsPath = store.paths(sessionId).conversationEventsPath;
      await mkdir(path.dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, '{"v":1}\nnot-json\n', 'utf8');

      await expect(store.readEvents(sessionId)).rejects.toThrow(/\.jsonl:2/);
    });
  });

  test('stores payload bytes outside the JSONL event stream', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const payload = await store.writePayload(sessionId, {
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
      await expect(readFile(store.payloadPath(sessionId, payload), 'utf8')).resolves.toBe('image-bytes');
      await expect(store.readPayload(sessionId, payload)).resolves.toEqual(Buffer.from('image-bytes'));
    });
  });

  test('stores run-scoped payload bytes under the owning run', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const runId = 'run-1';
      const payload = await store.writePayload(sessionId, {
        runId,
        id: 'tool-output-1',
        data: 'tool bytes',
        mimeType: 'text/plain',
        role: 'tool_output',
      });

      expect(payload.scope).toEqual({ type: 'run', conversationId: sessionId, runId });
      await expect(readFile(store.payloadPath(sessionId, payload), 'utf8')).resolves.toBe('tool bytes');
      expect(store.payloadPath(sessionId, payload).startsWith(store.runPaths(runId).payloadsDir)).toBe(true);
    });
  });

  test('persists stable agent identity records', async () => {
    await withStore(async (store) => {
      await store.writeAgentIdentity({
        agentId: 'built-in:tenon:assistant',
        displayName: 'Tenon Assistant',
        model: 'test-model',
        systemPrompt: 'You are Tenon.',
        skills: ['skill-a'],
      });

      await expect(readFile(store.agentPaths('built-in:tenon:assistant').identityPath, 'utf8')).resolves.toContain('test-model');
      await expect(store.readAgentIdentity('built-in:tenon:assistant')).resolves.toMatchObject({
        agentId: 'built-in:tenon:assistant',
        displayName: 'Tenon Assistant',
        model: 'test-model',
        skills: ['skill-a'],
      });
    });
  });

  test('projects agent memory from per-agent JSONL events', async () => {
    await withStore(async (store, root) => {
      const agentId = 'built-in:tenon:assistant';
      const first = await store.addMemoryEntry(agentId, {
        id: 'memory-1',
        fact: '  User prefers concise engineering answers.  ',
        originWorkspace: 'workspace:abc',
        sources: [{ conversationId: 'conversation-1', runId: 'run-1', messageRange: ['user-1', 'user-1'] }],
        createdAt: 10,
      });
      const second = await store.addMemoryEntry(agentId, {
        id: 'memory-2',
        fact: 'Project codename is Tenon.',
        sources: [{ conversationId: 'conversation-2' }],
        createdAt: 20,
      });

      expect(first.fact).toBe('User prefers concise engineering answers.');
      expect(second.fact).toBe('Project codename is Tenon.');
      await expect(readFile(store.agentPaths(agentId).memoryEventsPath, 'utf8')).resolves.toContain('memory.entry_added');

      const updated = await store.updateMemoryEntry(agentId, 'memory-1', {
        fact: 'User prefers direct, concise engineering answers.',
      });
      expect(updated?.fact).toBe('User prefers direct, concise engineering answers.');

      const removed = await store.removeMemoryEntry(agentId, 'memory-1', 'test');
      expect(removed?.status).toBe('invalidated');
      await store.removeMemoryEntry(agentId, 'memory-1', 'test-again');

      expect(await store.listMemoryEntries(agentId)).toMatchObject([
        { id: 'memory-2', status: 'active' },
      ]);
      expect(await store.listMemoryEntries(agentId, { includeInvalidated: true, query: 'direct concise' })).toMatchObject([
        { id: 'memory-1', status: 'invalidated' },
      ]);

      const raw = await readFile(store.agentPaths(agentId).memoryEventsPath, 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(4);
      const restarted = new AgentEventStore(root);
      expect(await restarted.listMemoryEntries(agentId, { includeInvalidated: true })).toMatchObject([
        { id: 'memory-2', status: 'active' },
        { id: 'memory-1', status: 'invalidated' },
      ]);
    });
  });

  test('rejects empty memory updates and keeps normalized facts within the max length', async () => {
    await withStore(async (store) => {
      const agentId = 'built-in:tenon:assistant';
      const entry = await store.addMemoryEntry(agentId, {
        id: 'memory-long',
        fact: 'x'.repeat(2_100),
        sources: [{ conversationId: 'conversation-1' }],
      });

      expect(entry.fact).toHaveLength(2_000);
      expect(entry.fact.endsWith('...')).toBe(true);
      await expect(store.updateMemoryEntry(agentId, 'memory-long', { fact: '   ' })).rejects.toThrow(/cannot be empty/);
    });
  });

  test('compacts high-churn memory logs to the current projection', async () => {
    await withStore(async (store) => {
      const agentId = 'built-in:tenon:assistant';
      await store.appendDreamCompleted(agentId, {
        runId: 'dream-run-before-churn',
        trigger: 'schedule',
        startedAt: 40,
        completedAt: 50,
        watermark: {
          conversations: {
            'conversation-1': { seq: 12, eventId: 'event-12' },
          },
        },
        processed: {
          conversations: {
            'conversation-1': {
              fromSeqExclusive: 0,
              throughSeq: 12,
              throughEventId: 'event-12',
              messageCount: 2,
              charCount: 200,
            },
          },
          totalMessageCount: 2,
          totalCharCount: 200,
          consolidateOnly: false,
        },
        changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
      });
      await store.addMemoryEntry(agentId, {
        id: 'memory-churn',
        fact: 'Version 0.',
        sources: [{ conversationId: 'conversation-1' }],
      });

      for (let index = 1; index <= 70; index += 1) {
        await store.updateMemoryEntry(agentId, 'memory-churn', { fact: `Version ${index}.` });
      }

      const raw = await readFile(store.agentPaths(agentId).memoryEventsPath, 'utf8');
      expect(raw.trim().split('\n').length).toBeLessThan(20);
      expect(await store.listMemoryEntries(agentId)).toMatchObject([
        { id: 'memory-churn', fact: 'Version 70.' },
      ]);
      expect((await store.readDreamState(agentId)).watermark.conversations['conversation-1']).toEqual({
        seq: 12,
        eventId: 'event-12',
      });
    });
  });

  test('persists agent-anchored reflective run meta for Dream runs', async () => {
    await withStore(async (store) => {
      await store.writeRunMeta({
        v: 1,
        id: 'dream-run-1',
        agentId: 'built-in:tenon:assistant',
        anchor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        kind: 'reflective',
        status: 'completed',
        trigger: { type: 'schedule', schedule: '2026-01-01T03:00 RRULE:FREQ=DAILY', dueAt: 1_800_000_000_000 },
        fingerprint: {
          appVersion: 'test',
          promptHash: 'prompt',
          toolSchemaHash: 'no-tools',
          skillBindings: [],
          modelConfig: 'model',
        },
        retention: 'hot',
        createdAt: 100,
        updatedAt: 120,
        latestSeq: 0,
      });

      await expect(store.readRunMetaProjection('dream-run-1')).resolves.toMatchObject({
        id: 'dream-run-1',
        anchor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        kind: 'reflective',
        trigger: { type: 'schedule' },
      });
      await expect(store.listAgentRunMetaProjections('built-in:tenon:assistant')).resolves.toMatchObject([{
        id: 'dream-run-1',
        kind: 'reflective',
        status: 'completed',
      }]);
    });
  });
});
