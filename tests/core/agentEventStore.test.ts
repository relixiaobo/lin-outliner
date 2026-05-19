import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import {
  AgentEventStore,
  agentCheckpointFileName,
  agentPayloadFileName,
  agentSessionDirName,
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

      const raw = await readFile(store.paths(sessionId).eventsPath, 'utf8');
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

      const entries = await store.listSessionIndexEntries();
      expect(entries).toEqual([{
        id: sessionId,
        title: 'Renamed',
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_004,
        messageCount: 2,
        latestSeq: 4,
      }]);
      const index = JSON.parse(await readFile(path.join(root, 'indexes', 'session-index.json'), 'utf8')) as {
        sessions: Record<string, unknown>;
      };
      expect(index.sessions[sessionId]).toBeDefined();
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

      expect(await store.listSessionIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Untitled',
        messageCount: 1,
        latestSeq: 2,
      }]);
      await expect(readFile(path.join(root, 'indexes', 'session-index.json'), 'utf8')).resolves.toContain(sessionId);
    });
  });

  test('rebuilds the session index when the derived index is malformed', async () => {
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
      const indexPath = path.join(root, 'indexes', 'session-index.json');
      await writeFile(indexPath, 'not-json\n', 'utf8');

      expect(await store.listSessionIndexEntries()).toMatchObject([{
        id: sessionId,
        title: 'Untitled',
        messageCount: 1,
        latestSeq: 2,
      }]);
      await expect(readFile(indexPath, 'utf8')).resolves.toContain(sessionId);
    });
  });

  test('removes deleted sessions from the derived session index', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Untitled' },
      ]);

      await store.deleteSession(sessionId);

      expect(await store.listSessionIndexEntries()).toEqual([]);
      expect(await store.listSessionIds()).toEqual([]);
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

      expect(agentSessionDirName(sessionId)).not.toContain('..');
      expect(store.paths(sessionId).sessionDir.startsWith(path.join(root, 'sessions'))).toBe(true);
      expect(await store.listSessionIds()).toEqual([sessionId]);
    });
  });

  test('reports malformed JSONL line numbers', async () => {
    await withStore(async (store) => {
      const sessionId = 'session-1';
      const eventsPath = store.paths(sessionId).eventsPath;
      await mkdir(path.dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, '{"v":1}\nnot-json\n', 'utf8');

      await expect(store.readEvents(sessionId)).rejects.toThrow(/events\.jsonl:2/);
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
});
