import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';
import { discoverExecutionContext } from '../../src/main/agent/tasks/ExecutionContextDiscovery';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import type { ThreadContextPayload } from '../../src/core/agent/protocol';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

describe('execution context discovery', () => {
  test('walks ancestor scopes and preserves nested instruction applicability', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    try {
      const nested = path.join(root, 'src');
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(root, 'AGENTS.md'), 'Use the project test command.');
      await writeFile(path.join(nested, 'AGENTS.md'), 'Keep source changes typed.');
      const address = await resolveExecutionAddress({ defaultCwd: nested });
      const admitted = pendingExecutionContext(address, {
        capability: 'full-access', mutation: true, isolation: 'unsandboxed', writablePaths: [],
      });
      const result = await discoverExecutionContext(admitted);

      expect(result.context.snapshot.generation).toBe(1);
      expect(result.context.snapshot.predecessorRef).toBe(admitted.snapshotRef);
      expect(result.context.snapshot.discovery).toBe('complete');
      expect(result.context.snapshot.facts.filter((fact) => fact.kind === 'instruction').map((fact) => fact.scope))
        .toEqual([await realpath(root), await realpath(nested)]);
      expect(result.context.snapshot.facts.some((fact) => fact.text.includes('Keep source changes typed.'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records bounded source degradation without failing the admitted task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    try {
      await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(100));
      const address = await resolveExecutionAddress({ defaultCwd: root });
      const result = await discoverExecutionContext(pendingExecutionContext(address, {
        capability: 'full-access', mutation: true, isolation: 'unsandboxed', writablePaths: [],
      }), { maxSourceBytes: 12 });

      expect(result.context.snapshot.discovery).toBe('unavailable');
      expect(result.context.snapshot.degradation).toContain('exceeded the discovery byte limit');
      expect(result.context.snapshot.facts.find((fact) => fact.kind === 'instruction')).toBeUndefined();
      expect(result.sources.some((source) => source.path.endsWith('AGENTS.md') && source.state === 'unavailable')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists one immutable successor for a host operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    const database = new Database(':memory:');
    const store = new ToolTaskStore(database as unknown as SqliteDatabase);
    const service = new ToolTaskService(store, path.join(root, 'tasks'));
    const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
    let taskId: string | null = null;
    service.bindHost({
      ownerExists: () => true,
      readDeliveryAdmission: async () => null,
      startCompletionTurn: async () => false,
      taskChanged: () => {},
      contextEvidence: {
        write: (owner: string, payload: ThreadContextPayload) => payloads.writeContext(owner, payload),
        read: (owner: string, ref) => payloads.readContext(owner, ref),
      },
    });
    try {
      await service.initialize();
      await service.runHostOperation({
        ownerThreadId: 'thread', sourceTurnId: '00000000-0000-7000-8000-000000000002', sourceItemId: 'item', producer: 'test',
        executionContext: pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), {
          capability: 'full-access', mutation: true, isolation: 'unsandboxed', writablePaths: [],
        }),
        onAdmitted: async (task) => { taskId = task.taskId; },
        execute: async () => ({ result: null, success: true }),
      });
      for (let attempt = 0; attempt < 50 && !store.contextSuccessor(taskId!); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const successor = store.contextSuccessor(taskId!);
      expect(successor?.ref.kind).toBe('executionContextObservation');
      const observation = await payloads.readContext(taskId!, successor!.ref);
      expect(observation?.kind).toBe('executionContextObservation');
      if (observation?.kind !== 'executionContextObservation') throw new Error('Missing discovery observation');
      expect(observation.executionContext.snapshot.generation).toBe(1);
      expect(observation.executionContext.snapshot.predecessorRef).toBe(
        store.read(taskId!)!.executionContext.snapshotRef,
      );
      expect((await payloads.readContext(taskId!, observation.admissionRef))?.kind).toBe('taskExecutionContext');
      expect(await payloads.copyContextToThread(taskId!, 'thread', observation.admissionRef)).toBe(true);
      expect(await payloads.copyContextToThread(taskId!, 'thread', successor!.ref)).toBe(true);
      expect((await payloads.readContext('thread', observation.admissionRef))?.kind).toBe('taskExecutionContext');
      expect((await payloads.readContext('thread', successor!.ref))?.kind).toBe('executionContextObservation');
      await payloads.pruneUnreferencedContexts(taskId!, [], []);
      expect(await payloads.readContext(taskId!, successor!.ref)).toBeNull();
      expect((await payloads.readContext('thread', successor!.ref))?.kind).toBe('executionContextObservation');
      store.publishContextSuccessor(taskId!, successor.ref, Date.now());
      expect(store.contextSuccessor(taskId!)).toEqual(successor);
    } finally {
      await service.close(2_000);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
