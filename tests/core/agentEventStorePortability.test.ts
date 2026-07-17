import { describe, expect, spyOn, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent, AgentPayloadRole } from '../../src/core/agentEventLog';
import {
  AGENT_DELETION_LOG_FILE,
  AgentEventStore,
  type AgentDeletionTombstone,
} from '../../src/main/agentEventStore';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };

async function withStore<T>(fn: (store: AgentEventStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-portability-'));
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

async function readTombstones(root: string): Promise<AgentDeletionTombstone[]> {
  const raw = await readFile(path.join(root, AGENT_DELETION_LOG_FILE), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as AgentDeletionTombstone);
}

async function appendRetentionFixture(store: AgentEventStore, conversationId: string) {
  const oldRunId = `${conversationId}-old-run`;
  const retainedRunId = `${conversationId}-retained-run`;
  await store.appendEvents(conversationId, [
    { ...base(conversationId, 1, 'conversation.created'), title: 'Retention recovery' },
    {
      ...base(conversationId, 2, 'user_message.created', userActor),
      messageId: 'old-user-message',
      parentMessageId: null,
      content: [{ type: 'text', text: 'obsolete-retention-token user prompt' }],
    },
    { ...base(conversationId, 3, 'branch.selected'), leafMessageId: 'old-user-message' },
    {
      ...base(conversationId, 4, 'run.started'),
      runId: oldRunId,
      trigger: { type: 'message', messageId: 'old-user-message' },
    },
    {
      ...base(conversationId, 5, 'assistant_message.started'),
      runId: oldRunId,
      messageId: 'old-assistant-message',
      parentMessageId: 'old-user-message',
      providerId: 'test',
      modelId: 'test',
    },
    {
      ...base(conversationId, 6, 'assistant_message.completed'),
      runId: oldRunId,
      messageId: 'old-assistant-message',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'obsolete-retention-token assistant reply' }],
    },
    { ...base(conversationId, 7, 'run.completed'), runId: oldRunId },
    {
      ...base(conversationId, 8, 'user_message.created', userActor),
      messageId: 'retained-user-message',
      parentMessageId: 'old-assistant-message',
      content: [{ type: 'text', text: 'current-retention-token user prompt' }],
    },
    { ...base(conversationId, 9, 'branch.selected'), leafMessageId: 'retained-user-message' },
    {
      ...base(conversationId, 10, 'run.started'),
      runId: retainedRunId,
      trigger: { type: 'message', messageId: 'retained-user-message' },
    },
    {
      ...base(conversationId, 11, 'assistant_message.started'),
      runId: retainedRunId,
      messageId: 'retained-assistant-message',
      parentMessageId: 'retained-user-message',
      providerId: 'test',
      modelId: 'test',
    },
    {
      ...base(conversationId, 12, 'assistant_message.completed'),
      runId: retainedRunId,
      messageId: 'retained-assistant-message',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'current-retention-token assistant reply' }],
    },
    { ...base(conversationId, 13, 'run.completed'), runId: retainedRunId },
  ]);
  return { oldRunId, retainedRunId };
}

describe('agent event store portability', () => {
  test('builds a deterministic catalog from portable streams and payload roles only', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'portable-conversation';
      const runId = 'portable-run';
      const roles: Array<AgentPayloadRole | undefined> = [
        'source',
        'preview',
        'text_extract',
        'tool_output',
        'thumbnail',
        'debug',
        undefined,
      ];
      const payloads = await Promise.all(roles.map((role, index) => store.writePayload(conversationId, {
        id: `payload-${index}-${role ?? 'unclassified'}`,
        data: `payload ${role ?? 'unclassified'}`,
        mimeType: 'text/plain',
        role,
        summary: `/Users/private/${role ?? 'unclassified'}`,
      })));
      let seq = 1;
      const events: AgentEvent[] = [
        { ...base(conversationId, seq++, 'conversation.created'), title: 'Portable' },
        ...payloads.map((payload): AgentEvent => ({
          ...base(conversationId, seq++, 'payload.created'),
          payload,
        })),
        {
          ...base(conversationId, seq++, 'user_message.created', userActor),
          messageId: 'message-with-filtered-payloads',
          parentMessageId: null,
          content: [
            { type: 'payload_ref', payload: payloads[0]! },
            { type: 'payload_ref', payload: payloads[5]! },
          ],
          attachments: [payloads[0]!, payloads[5]!],
        },
        { ...base(conversationId, seq++, 'run.started'), runId },
        {
          ...base(conversationId, seq++, 'debug.run_snapshot.created'),
          runId,
          systemPrompt: 'DO_NOT_EXPORT_SYSTEM_PROMPT',
          tools: [{ name: 'read', description: 'private tool', schema: '{"path":"/Users/private"}' }],
        },
        {
          ...base(conversationId, seq++, 'tool.capability.checked'),
          runId,
          requestId: 'capability-1',
          toolCallId: 'tool-call-1',
          toolName: 'read',
          actionKinds: ['read'],
          outcome: 'capability_required',
          source: 'folder_capability',
          requiredFolders: ['/Users/private/workspace'],
        },
        {
          ...base(conversationId, seq++, 'tool.capability.resolved'),
          runId,
          requestId: 'capability-1',
          toolCallId: 'tool-call-1',
          toolName: 'read',
          status: 'available',
          resolvedBy: 'folder_grant',
          updatedFolders: ['/Users/private/workspace'],
        },
        {
          ...base(conversationId, seq++, 'notification.created'),
          notificationId: 'capability-notification',
          kind: 'needs_input',
          title: 'Folder access required',
          body: 'Allow access to /Users/private/workspace',
          folderCapability: {
            requestId: 'capability-1',
            runId,
            agentSessionId: 'agent-session-1',
            issueId: 'issue-1',
            toolCallId: 'tool-call-1',
            toolName: 'read',
            folders: ['/Users/private/workspace'],
          },
        },
        {
          ...base(conversationId, seq++, 'checkpoint.created'),
          checkpointSeq: seq - 1,
          eventByteOffset: 42,
        },
      ];
      await store.appendEvents(conversationId, events);

      const first = await store.buildPortableCatalog();
      const restartedStore = new AgentEventStore(root);
      const restarted = await restartedStore.buildPortableCatalog();
      expect(restarted).toEqual(first);
      expect(JSON.stringify(restarted)).toBe(JSON.stringify(first));
      expect(first).not.toHaveProperty('generatedAt');
      expect(first.streams.map((stream) => stream.identity)).toEqual([
        { type: 'conversation', conversationId },
        { type: 'run', conversationId, runId },
      ]);
      expect(first.payloads.map((payload) => payload.role)).toEqual([
        'source',
        'preview',
        'text_extract',
        'tool_output',
      ]);
      expect(first.payloads.every((payload) => !('summary' in payload))).toBe(true);
      expect((await restartedStore.readPayload(conversationId, first.payloads[0]!)).toString('utf8'))
        .toBe('payload source');

      const portableRun = await restartedStore.readPortableStream({ type: 'run', conversationId, runId });
      const portableConversation = await restartedStore.readPortableStream({ type: 'conversation', conversationId });
      expect(portableRun.map((event) => event.type)).toEqual(['run.started']);
      expect(portableConversation.map((event) => event.type)).not.toContain('notification.created');
      const portableJson = JSON.stringify({ catalog: restarted, conversation: portableConversation, run: portableRun });
      expect(portableJson).not.toContain('DO_NOT_EXPORT_SYSTEM_PROMPT');
      expect(portableJson).not.toContain('/Users/private');
      expect(portableJson).not.toContain('payload-5-debug');
    });
  });

  test('writes conversation and Run tombstones before physical cleanup can fail', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'delete-cleanup-failure';
      const runId = 'delete-cleanup-failure-run';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Delete me' },
        { ...base(conversationId, 2, 'run.started'), runId },
      ]);

      const conversationDir = store.paths(conversationId).conversationDir;
      const removePath = fsPromises.rm;
      const removeSpy = spyOn(fsPromises, 'rm').mockImplementation((target, options) => {
        if (target === conversationDir) return Promise.reject(new Error('simulated cleanup failure'));
        return removePath(target, options);
      });
      try {
        await expect(store.deleteConversation(conversationId, {
          actor: userActor,
          reason: 'conversation_deleted',
        })).rejects.toThrow('simulated cleanup failure');
      } finally {
        removeSpy.mockRestore();
      }

      expect(await readTombstones(root)).toMatchObject([
        {
          v: 1,
          seq: 1,
          deletionId: expect.any(String),
          entity: { type: 'conversation', conversationId },
          actor: userActor,
          reason: 'conversation_deleted',
          lastKnownEvent: { seq: 1, eventId: `${conversationId}-event-1` },
        },
        {
          v: 1,
          seq: 2,
          deletionId: expect.any(String),
          entity: { type: 'run', conversationId, runId },
          actor: userActor,
          reason: 'conversation_deleted',
          lastKnownEvent: { seq: 2, eventId: `${conversationId}-event-2` },
        },
      ]);
      expect(await store.listConversationIds()).toEqual([]);
      expect(await store.readEvents(conversationId)).toEqual([]);
      await expect(readFile(store.paths(conversationId).conversationEventsPath, 'utf8')).resolves.toContain('conversation.created');

      await store.deleteConversation(conversationId, {
        actor: userActor,
        reason: 'conversation_deleted',
      });
      expect(await readTombstones(root)).toHaveLength(2);
    });
  });

  test('does not resurrect a deleted conversation when stale directories and indexes return', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'deleted-conversation';
      const runId = 'deleted-run';
      const payload = await store.writePayload(conversationId, {
        id: 'deleted-source',
        data: 'deleted bytes',
        mimeType: 'text/plain',
        role: 'source',
      });
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Deleted' },
        { ...base(conversationId, 2, 'payload.created'), payload },
        { ...base(conversationId, 3, 'run.started'), runId },
        { ...base(conversationId, 4, 'run.completed'), runId },
      ]);

      const backupDir = path.join(root, 'stale-backup');
      await mkdir(backupDir, { recursive: true });
      await cp(store.paths(conversationId).conversationDir, path.join(backupDir, 'conversation'), { recursive: true });
      await cp(store.runPaths(runId).runDir, path.join(backupDir, 'run'), { recursive: true });

      await store.deleteConversation(conversationId, {
        actor: userActor,
        reason: 'conversation_deleted',
      });
      await cp(path.join(backupDir, 'conversation'), store.paths(conversationId).conversationDir, { recursive: true });
      await cp(path.join(backupDir, 'run'), store.runPaths(runId).runDir, { recursive: true });
      await rm(path.join(root, 'indexes'), { recursive: true, force: true });

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationIds()).toEqual([]);
      expect(await restarted.listConversationIndexEntries()).toEqual([]);
      expect(await restarted.readConversationStreamEvents(conversationId)).toEqual([]);
      expect(await restarted.readEvents(conversationId)).toEqual([]);
      expect((await restarted.replay(conversationId)).conversation).toBeNull();
      expect(await restarted.readRunStreamEvents(runId)).toEqual([]);
      expect(await restarted.readRunMetaProjection(runId)).toBeNull();
      expect(await restarted.listConversationRunMetaProjections(conversationId)).toEqual([]);
      await expect(restarted.appendEvents(conversationId, [
        { ...base(conversationId, 5, 'conversation.renamed'), title: 'Resurrected' },
      ])).rejects.toThrow('was deleted');
      await expect(restarted.writePayload(conversationId, {
        data: 'resurrected',
        mimeType: 'text/plain',
        role: 'source',
      })).rejects.toThrow('was deleted');

      const catalog = await restarted.buildPortableCatalog();
      expect(catalog.streams).toEqual([]);
      expect(catalog.payloads).toEqual([]);
      expect(catalog.tombstones).toHaveLength(2);
    });
  });

  test('concurrent Run writes cannot recreate storage after conversation deletion', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'concurrent-delete';
      const runId = 'child-concurrent-delete';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Concurrent delete' },
      ]);
      await store.appendRunStreamEvents(conversationId, runId, [{
        ...base(conversationId, 1, 'run.started'),
        eventId: `${runId}-event-1`,
        runId,
      }]);

      const writes = Array.from({ length: 32 }, (_, index) => store.appendRunStreamEvents(
        conversationId,
        runId,
        [{
          ...base(conversationId, index + 2, 'assistant_message.delta'),
          eventId: `${runId}-event-${index + 2}`,
          runId,
          messageId: 'assistant-1',
          delta: { type: 'text_delta', text: `chunk-${index}` },
          providerChunkCount: index + 1,
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_000_001 + index,
        }],
      ));
      const deletion = store.deleteConversation(conversationId, {
        actor: userActor,
        reason: 'conversation_deleted',
      });
      await Promise.allSettled(writes);
      await expect(deletion).resolves.toBeUndefined();

      expect(await store.readRunStreamEvents(runId)).toEqual([]);
      await expect(readFile(store.runPaths(runId).runEventsPath, 'utf8')).rejects.toThrow();
      expect((await readTombstones(root)).map((tombstone) => tombstone.entity)).toEqual([
        { type: 'conversation', conversationId },
        { type: 'run', conversationId, runId },
      ]);
    });
  });

  test('retention tombstones prevent a restored Run from re-entering a rebuilt index', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'retention-conversation';
      const oldRunId = 'retention-run-old';
      const retainedRunId = 'retention-run-new';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Retention' },
        { ...base(conversationId, 2, 'run.started'), runId: oldRunId },
        { ...base(conversationId, 3, 'run.completed'), runId: oldRunId },
        { ...base(conversationId, 4, 'run.started'), runId: retainedRunId },
        { ...base(conversationId, 5, 'run.completed'), runId: retainedRunId },
      ]);

      const backupDir = path.join(root, 'old-run-backup');
      await cp(store.runPaths(oldRunId).runDir, backupDir, { recursive: true });
      await expect(store.retainRecentConversationRuns(conversationId, 1, {
        actor: systemActor,
        reason: 'retention_pruned',
      })).resolves.toEqual({ prunedRunIds: [oldRunId], retainedRunIds: [retainedRunId] });
      expect(await readTombstones(root)).toMatchObject([{
        entity: { type: 'run', conversationId, runId: oldRunId },
        reason: 'retention_pruned',
      }]);

      await cp(backupDir, store.runPaths(oldRunId).runDir, { recursive: true });
      await rm(store.paths(conversationId).conversationRunIndexPath, { force: true });
      await rm(path.join(root, 'indexes'), { recursive: true, force: true });

      const restarted = new AgentEventStore(root);
      expect(await restarted.listConversationRunMetaProjections(conversationId)).toMatchObject([
        { id: retainedRunId },
      ]);
      expect(await restarted.readRunMetaProjection(oldRunId)).toBeNull();
      expect(await restarted.readRunStreamEvents(oldRunId)).toEqual([]);
      const conversationEventsBeforeRejectedAppend = await readFile(
        restarted.paths(conversationId).conversationEventsPath,
        'utf8',
      );
      const runEventsBeforeRejectedAppend = await readFile(
        restarted.runPaths(oldRunId).runEventsPath,
        'utf8',
      );
      await expect(restarted.appendEvents(conversationId, [
        { ...base(conversationId, 6, 'conversation.renamed'), title: 'Partially resurrected' },
        {
          ...base(conversationId, 7, 'assistant_message.completed'),
          runId: oldRunId,
          messageId: 'resurrected-message',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'resurrected-run-token' }],
        },
      ])).rejects.toThrow('was deleted');
      await expect(readFile(restarted.paths(conversationId).conversationEventsPath, 'utf8'))
        .resolves.toBe(conversationEventsBeforeRejectedAppend);
      await expect(readFile(restarted.runPaths(oldRunId).runEventsPath, 'utf8'))
        .resolves.toBe(runEventsBeforeRejectedAppend);
      expect(await restarted.searchMessages('resurrected-run-token', { conversationId })).toEqual([]);
      await expect(restarted.appendRunStreamEvents(conversationId, oldRunId, [
        { ...base(conversationId, 6, 'run.completed'), runId: oldRunId },
      ])).rejects.toThrow('was deleted');
      const catalog = await restarted.buildPortableCatalog();
      expect(catalog.streams.map((stream) => stream.identity)).not.toContainEqual({
        type: 'run',
        conversationId,
        runId: oldRunId,
      });
    });
  });

  test('reset tombstones discarded Runs without permanently deleting the conversation identity', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'reset-conversation';
      const runId = 'reset-run';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Before reset' },
        { ...base(conversationId, 2, 'run.started'), runId },
      ]);

      await store.resetConversationStorage(conversationId, {
        actor: systemActor,
        reason: 'conversation_reset',
      });
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), eventId: 'reset-conversation-recreated', title: 'After reset' },
      ]);

      const conversationEventsBeforeRejectedAppend = await readFile(
        store.paths(conversationId).conversationEventsPath,
        'utf8',
      );
      await expect(store.appendEvents(conversationId, [
        { ...base(conversationId, 2, 'conversation.renamed'), title: 'Partially resurrected' },
        { ...base(conversationId, 3, 'run.completed'), runId },
      ])).rejects.toThrow('was deleted');
      await expect(readFile(store.paths(conversationId).conversationEventsPath, 'utf8'))
        .resolves.toBe(conversationEventsBeforeRejectedAppend);
      await expect(readFile(store.runPaths(runId).runEventsPath, 'utf8')).rejects.toThrow();
      await expect(store.appendEvents(conversationId, [{
        ...base(conversationId, 2, 'payload.created'),
        payload: {
          kind: 'payload_ref',
          id: 'deleted-run-payload',
          storage: 'file',
          mimeType: 'text/plain',
          byteLength: 1,
          sha256: '0'.repeat(64),
          scope: { type: 'run', conversationId, runId },
          role: 'source',
        },
      }])).rejects.toThrow('was deleted');
      expect((await store.replay(conversationId)).conversation?.title).toBe('After reset');
      expect(await store.readRunStreamEvents(runId)).toEqual([]);
      expect(await readTombstones(root)).toMatchObject([{
        entity: { type: 'run', conversationId, runId },
        reason: 'conversation_reset',
      }]);
    });
  });

  test('retries retention cleanup after the tombstone has already committed', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'retention-retry';
      const { oldRunId, retainedRunId } = await appendRetentionFixture(store, conversationId);
      expect(await store.searchMessages('obsolete-retention-token', { conversationId })).toHaveLength(2);

      const makeDirectory = fsPromises.mkdir;
      const segmentsDir = store.paths(conversationId).conversationSegmentsDir;
      const mkdirSpy = spyOn(fsPromises, 'mkdir').mockImplementation((target, options) => {
        if (target === segmentsDir) return Promise.reject(new Error('simulated retention rewrite failure'));
        return makeDirectory(target, options);
      });
      try {
        await expect(store.retainRecentConversationRuns(conversationId, 1, {
          actor: systemActor,
          reason: 'retention_pruned',
        })).rejects.toThrow('simulated retention rewrite failure');
      } finally {
        mkdirSpy.mockRestore();
      }

      expect(await readTombstones(root)).toMatchObject([{
        entity: { type: 'run', conversationId, runId: oldRunId },
        reason: 'retention_pruned',
      }]);
      await expect(store.retainRecentConversationRuns(conversationId, 1, {
        actor: systemActor,
        reason: 'retention_pruned',
      })).resolves.toEqual({ prunedRunIds: [oldRunId], retainedRunIds: [retainedRunId] });

      expect(await readTombstones(root)).toHaveLength(1);
      expect(await store.searchMessages('obsolete-retention-token', { conversationId })).toEqual([]);
      expect(await store.searchMessages('current-retention-token', { conversationId })).toHaveLength(2);
      expect((await store.listConversationIndexEntries())[0]?.messageCount).toBe(2);
      await expect(readFile(store.runPaths(oldRunId).runEventsPath, 'utf8')).rejects.toThrow();
    });
  });

  test('rebuilds conversation and search indexes restored from before a Run tombstone', async () => {
    await withStore(async (store, root) => {
      const conversationId = 'retention-index-watermark';
      const { oldRunId, retainedRunId } = await appendRetentionFixture(store, conversationId);
      const backupDir = path.join(root, 'index-backup');
      await mkdir(backupDir, { recursive: true });
      await cp(
        path.join(root, 'indexes', 'conversation-index.json'),
        path.join(backupDir, 'conversation-index.json'),
      );
      await cp(
        path.join(root, 'indexes', 'search-index.json'),
        path.join(backupDir, 'search-index.json'),
      );

      await expect(store.retainRecentConversationRuns(conversationId, 1, {
        actor: systemActor,
        reason: 'retention_pruned',
      })).resolves.toEqual({ prunedRunIds: [oldRunId], retainedRunIds: [retainedRunId] });
      await cp(
        path.join(backupDir, 'conversation-index.json'),
        path.join(root, 'indexes', 'conversation-index.json'),
      );
      await cp(
        path.join(backupDir, 'search-index.json'),
        path.join(root, 'indexes', 'search-index.json'),
      );

      const restarted = new AgentEventStore(root);
      expect((await restarted.listConversationIndexEntries())[0]?.messageCount).toBe(2);
      expect(await restarted.searchMessages('obsolete-retention-token', { conversationId })).toEqual([]);
      expect(await restarted.searchMessages('current-retention-token', { conversationId })).toHaveLength(2);

      const conversationIndex = JSON.parse(
        await readFile(path.join(root, 'indexes', 'conversation-index.json'), 'utf8'),
      ) as { deletionSeq?: number };
      const searchIndex = JSON.parse(
        await readFile(path.join(root, 'indexes', 'search-index.json'), 'utf8'),
      ) as { deletionSeq?: number };
      expect(conversationIndex.deletionSeq).toBe(1);
      expect(searchIndex.deletionSeq).toBe(1);
    });
  });

  test.each([
    ['conversation', 'conversation-index.json'],
    ['search', 'search-index.json'],
  ] as const)('restarts a concurrent %s index rebuild when retention advances the deletion ledger', async (
    indexKind,
    indexFileName,
  ) => {
    await withStore(async (store, root) => {
      const conversationId = `retention-concurrent-${indexKind}-index`;
      const { oldRunId, retainedRunId } = await appendRetentionFixture(store, conversationId);
      const oldRunEventsPath = store.runPaths(oldRunId).runEventsPath;
      await rm(path.join(root, 'indexes', indexFileName), { force: true });

      let releaseOldRunRead = (): void => undefined;
      const oldRunReadReleased = new Promise<void>((resolve) => {
        releaseOldRunRead = resolve;
      });
      let markOldRunReadCaptured = (): void => undefined;
      const oldRunReadCaptured = new Promise<void>((resolve) => {
        markOldRunReadCaptured = resolve;
      });
      const readStoredFile = fsPromises.readFile;
      let capturedOldRunRead = false;
      const readFileSpy = spyOn(fsPromises, 'readFile').mockImplementation(async (target, options) => {
        if (!capturedOldRunRead && target === oldRunEventsPath) {
          capturedOldRunRead = true;
          const oldRunEvents = await readStoredFile(target, options);
          markOldRunReadCaptured();
          await oldRunReadReleased;
          return oldRunEvents;
        }
        return readStoredFile(target, options);
      });

      let rebuildPromise: Promise<unknown> | null = null;
      try {
        rebuildPromise = indexKind === 'conversation'
          ? store.listConversationIndexEntries()
          : store.searchMessages('obsolete-retention-token', { conversationId });
        await oldRunReadCaptured;

        await expect(store.retainRecentConversationRuns(conversationId, 1, {
          actor: systemActor,
          reason: 'retention_pruned',
        })).resolves.toEqual({ prunedRunIds: [oldRunId], retainedRunIds: [retainedRunId] });
        releaseOldRunRead();

        const rebuilt = await rebuildPromise;
        if (indexKind === 'conversation') {
          expect(rebuilt).toMatchObject([{ id: conversationId, messageCount: 2 }]);
        } else {
          expect(rebuilt).toEqual([]);
        }
      } finally {
        releaseOldRunRead();
        readFileSpy.mockRestore();
        await rebuildPromise?.catch(() => undefined);
      }

      const persistedIndex = JSON.parse(
        await readFile(path.join(root, 'indexes', indexFileName), 'utf8'),
      ) as { deletionSeq?: number };
      expect(persistedIndex.deletionSeq).toBe(1);

      const restarted = new AgentEventStore(root);
      if (indexKind === 'conversation') {
        expect(await restarted.listConversationIndexEntries()).toMatchObject([{
          id: conversationId,
          messageCount: 2,
        }]);
      } else {
        expect(await restarted.searchMessages('obsolete-retention-token', { conversationId })).toEqual([]);
      }
    });
  });
});
