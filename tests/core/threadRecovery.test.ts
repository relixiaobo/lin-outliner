import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadRecoveryService } from '../../src/main/agent/recovery/ThreadRecoveryService';
import type { RecoveryInspection } from '../../src/main/agent/recovery/ThreadRecoveryService';
import type { Thread } from '../../src/core/agent/protocol';
import { decodeThread } from '../../src/core/agent/codec';
import { decodeThreadRecoveryRequest } from '../../src/core/threadRecovery';

function thread(id: string, parentThreadId: string | null = null): Thread {
  return decodeThread({ id, sessionId: id, parentThreadId, forkedFromId: null, name: id,
    preview: '', ephemeral: false, source: 'app', threadSource: 'user', modelProvider: 'openai',
    configurationSource: { kind: 'user' }, createdAt: 1, updatedAt: 1, status: { type: 'idle' }, historyMode: 'paginated' });
}

describe('ThreadRecoveryService', () => {
  test('persists one exact operation and resumes after an interrupted apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-recovery-'));
    const records = new Map<string, string>();
    const parent = thread('018f1f9e-7b6e-7e11-8e45-111111111111');
    const child = thread('018f1f9e-7b6e-7e12-8e45-222222222222', parent.id);
    const inspection: RecoveryInspection = { threads: [parent, child], revision: 'a'.repeat(64), source: null,
      rebuildUnavailable: 'No complete source', blockers: [], resourceCount: 0 };
    let applied = 0;
    let interrupt = true;
    const create = () => new ThreadRecoveryService({
      root,
      journal: { read: () => [...records].map(([id, value]) => ({ id, value })), write: (id, value) => records.set(id, value) },
      inspect: async () => inspection,
      withFence: async (_threads, operation) => operation(),
      retain: async (_operation, evidence) => { await evidence.json('original.json', { preserved: true }); },
      steps: () => [{ name: 'remove', run: () => { applied++; } }],
      changed: () => undefined,
      completed: async () => undefined,
      checkpoint: async (name) => { if (name === 'retained' && interrupt) { interrupt = false; throw new Error('simulated restart'); } },
    });
    const service = create();
    const first = await service.execute(parent.id, 'remove', inspection.revision, async () => true).catch((error) => error as Error);
    expect(first).toBeInstanceOf(Error);
    expect(service.pending()).toHaveLength(1);
    expect(applied).toBe(0);
    const resumed = create();
    const preview = await resumed.resume(parent.id, service.pending()[0]!.id);
    expect(preview.operation?.phase).toBe('complete');
    expect(applied).toBe(1);
    expect(JSON.parse(await readFile(join(root, service.pending()[0]!.id, 'retention.json'), 'utf8')).version).toBe(1);
    expect((await resumed.execute(parent.id, 'remove', inspection.revision, async () => true)).preview.operation?.id).toBe(service.pending()[0]!.id);
    await rm(root, { recursive: true, force: true });
  });

  test('rejects stale observations and arbitrary request fields', async () => {
    expect(() => decodeThreadRecoveryRequest({ recoveryId: 'thread:018f1f9e-7b6e-7e11-8e45-111111111111', action: 'inspect', path: '/tmp' })).toThrow();
    expect(() => decodeThreadRecoveryRequest({ recoveryId: 'thread:018f1f9e-7b6e-7e11-8e45-111111111111', action: 'remove', revision: 'x' })).toThrow();
  });

  test('does not retain or mutate after a scope revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-recovery-stale-'));
    const records = new Map<string, string>();
    const source = thread('018f1f9e-7b6e-7e11-8e45-111111111111');
    let revision = 'a'.repeat(64);
    const service = new ThreadRecoveryService({
      root,
      journal: { read: () => [...records].map(([id, value]) => ({ id, value })), write: (id, value) => records.set(id, value) },
      inspect: async () => ({ threads: [source], revision, source: null, rebuildUnavailable: 'none', blockers: [], resourceCount: 0 }),
      withFence: async (_threads, operation) => operation(), retain: async () => { throw new Error('must not retain'); },
      steps: () => [], changed: () => undefined, completed: async () => undefined,
    });
    revision = 'b'.repeat(64);
    await expect(service.execute(source.id, 'remove', 'a'.repeat(64), async () => true)).rejects.toThrow('scope changed');
    expect(records.size).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
