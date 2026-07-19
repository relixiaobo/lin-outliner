import { describe, expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { OperationJournal, type OperationHistoryEntry, type OperationStackState } from '../../src/core/operationJournal';

const emptyStack: OperationStackState = {
  canUndo: false,
  canRedo: false,
};

function entry(index: number, origin: OperationHistoryEntry['origin'] = index % 2 === 0 ? 'agent' : 'user'): OperationHistoryEntry {
  return {
    operationId: `op:${index}`,
    origin,
    tool: 'probe',
    action: 'probe',
    summary: 'Probe operation.',
    affectedNodeIds: [`node:${index}`],
    affectedNodeCount: 1,
    createdAt: new Date(0).toISOString(),
  };
}

describe('OperationJournal', () => {
  test('restores only the bounded live window and rebuilds lookup indexes', () => {
    const journal = new OperationJournal(Array.from({ length: 12 }, (_value, index) => entry(index)), { maxEntries: 5 });

    expect(journal.entriesForSerialization(100)).toHaveLength(5);
    expect(journal.findByOperationId('op:6')).toBeUndefined();
    expect(journal.findByOperationId('op:7')).toBeDefined();
    expect(journal.findByOperationId('op:11')).toBeDefined();
    expect(journal.list({ origin: 'all', limit: 10, offset: 0 }, emptyStack).items?.map((item) => item.operationId))
      .toEqual(['op:11', 'op:10', 'op:9', 'op:8', 'op:7']);
  });

  test('records, merges, evicts, and pages without scanning the whole session history', () => {
    const journal = new OperationJournal(undefined, { maxEntries: 500 });

    const started = performance.now();
    for (let index = 0; index < 100_000; index += 1) {
      journal.record(entry(index));
    }
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(journal.entriesForSerialization(1_000)).toHaveLength(500);
    expect(journal.entriesForSerialization(0)).toEqual([]);
    expect(journal.findByOperationId('op:0')).toBeUndefined();
    expect(journal.findByOperationId('op:99')).toBeUndefined();
    expect(journal.findByOperationId('op:99499')).toBeUndefined();
    expect(journal.findByOperationId('op:99999')).toMatchObject({
      operationId: 'op:99999',
      affectedNodeIds: ['node:99999'],
      affectedNodeCount: 1,
    });

    const all = journal.list({ origin: 'all', limit: 3, offset: 0 }, emptyStack);
    expect(all).toMatchObject({ count: 3, total: 500, hasMore: true });
    expect(all.items?.map((item) => item.operationId)).toEqual(['op:99999', 'op:99998', 'op:99997']);

    const agentPage = journal.list({ origin: 'agent', limit: 3, offset: 2 }, emptyStack);
    expect(agentPage.total).toBe(250);
    expect(agentPage.items?.map((item) => item.operationId)).toEqual(['op:99994', 'op:99992', 'op:99990']);

    const merge = journal.createEntry('agent:tool', {
      operationId: 'op:99998',
      tool: 'probe_merge',
      summary: 'Merged probe operation.',
    }, ['node:extra', 'node:99998']);
    expect(merge).toBeDefined();
    journal.record(merge!);

    expect(journal.findByOperationId('op:99998')).toMatchObject({
      tool: 'probe',
      action: 'probe_merge',
      summary: 'Merged probe operation.',
      affectedNodeIds: ['node:99998', 'node:extra'],
      affectedNodeCount: 2,
    });
    expect(journal.entriesForSerialization(1_000)).toHaveLength(500);
  });

  test('stores a bounded affected-node sample with total count and hash', () => {
    const journal = new OperationJournal(undefined, { maxEntries: 10 });
    const affectedNodeIds = Array.from({ length: 5_000 }, (_value, index) => `node:${index.toString().padStart(4, '0')}`);

    const entry = journal.createEntry('agent:bulk', {
      operationId: 'op:bulk',
      tool: 'bulk_probe',
      summary: 'Bulk probe operation.',
    }, affectedNodeIds);
    expect(entry).toBeDefined();
    journal.record(entry!);

    const stored = journal.findByOperationId('op:bulk');
    expect(stored).toMatchObject({
      affectedNodeCount: 5_000,
      affectedNodeIdsTruncated: true,
    });
    expect(stored?.affectedNodeIds).toHaveLength(100);
    expect(stored?.affectedNodeIds[0]).toBe('node:0000');
    expect(stored?.affectedNodeIds[99]).toBe('node:0099');
    expect(typeof stored?.affectedNodeIdsHash).toBe('string');

    const serialized = journal.entriesForSerialization(10);
    expect(serialized[0]?.affectedNodeIds).toHaveLength(100);
    expect(JSON.stringify(serialized).length).toBeLessThan(4_000);
  });

  test('normalizes legacy and overlong restored affected-node metadata', () => {
    const legacyEntry = {
      operationId: 'op:legacy',
      origin: 'agent',
      action: 'legacy_probe',
      summary: 'Legacy probe operation.',
      affectedNodeIds: Array.from({ length: 250 }, (_value, index) => `node:${index.toString().padStart(3, '0')}`),
      createdAt: new Date(0).toISOString(),
    };
    const journal = new OperationJournal([legacyEntry], { maxEntries: 10 });

    expect(journal.findByOperationId('op:legacy')).toMatchObject({
      affectedNodeCount: 250,
      affectedNodeIdsTruncated: true,
    });
    expect(journal.findByOperationId('op:legacy')?.affectedNodeIds).toHaveLength(100);
    expect(journal.list({ origin: 'all', limit: 1, offset: 0 }, emptyStack).items?.[0]).toMatchObject({
      affectedNodeCount: 250,
      affectedNodeIdsTruncated: true,
    });
  });
});
