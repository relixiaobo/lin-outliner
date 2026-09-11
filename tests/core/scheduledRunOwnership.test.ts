import { describe, expect, test } from 'bun:test';
import { ScheduledRunOwnership } from '../../src/main/agent/automations/ScheduledRunOwnership';
import { scheduledRunResult } from '../../src/main/agent/automations/AutomationRunResult';
import type { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import type { AutomationRun } from '../../src/core/agent/automation';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { Turn } from '../../src/core/agent/protocol';
import type { ToolTaskRecord, ToolTaskDeliveryBatch } from '../../src/main/agent/tasks/toolTaskTypes';

function fixture() {
  const run = { id: 'run-one', automationId: 'assignment', state: 'dispatched', threadId: 'root-one', turnId: 'turn-one', error: null } as AutomationRun;
  const other = { ...run, id: 'run-two', threadId: 'root-two', turnId: 'turn-two' };
  const original = { id: run.turnId, status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Delivered answer' }],
    provenance: { trigger: { kind: 'feature', feature: 'automation', ref: run.id } }, startedAt: 1, completedAt: 2, error: null } as Turn;
  const turns = new Map<string, Turn>([['root-one:turn-one', original], ['root-two:turn-two', { ...original, id: 'turn-two', provenance: { ...original.provenance, trigger: { kind: 'feature', feature: 'automation', ref: other.id } } }]]);
  const tasks = new Map<string, ToolTaskRecord>();
  const batches = new Map<string, ToolTaskDeliveryBatch>();
  const reader = {
    readTurnForHost: (thread: string, turn: string) => turns.get(`${thread}:${turn}`) ?? null,
    activeTurnIdForHost: () => null,
    toolTaskService: () => ({ store: { read: (id: string) => tasks.get(id) ?? null, readBatch: (id: string) => batches.get(id) ?? null,
      listAll: (owner: string) => [...tasks.values()].filter((task) => task.ownerThreadId === owner) } }),
  } as unknown as ThreadService;
  const owner = new ScheduledRunOwnership({ readRun: (id: string) => [run, other].find((value) => value.id === id) ?? null } as AutomationStore, reader);
  return { run, other, original, turns, tasks, batches, reader, owner };
}

describe('Scheduled run canonical ownership', () => {
  test('a delivery update remains with its original run even after another run exists', () => {
    const f = fixture();
    f.tasks.set('process', { taskId: 'process', ownerThreadId: 'root-one', sourceTurnId: 'turn-one', parentTaskId: null, deliveryTurnId: 'update', backgroundEnabled: true } as ToolTaskRecord);
    f.batches.set('batch', { batchId: 'batch', ownerThreadId: 'root-one', reservedTurnId: 'update', taskIds: ['process'], state: 'prepared' } as ToolTaskDeliveryBatch);
    // Canonical Turn admission can precede the delivery owner's linked receipt.
    f.turns.set('root-one:update', { ...f.original, id: 'update', startedAt: 3,
      provenance: { ...f.original.provenance, trigger: { kind: 'feature', feature: 'tool-task-completion', ref: 'batch' } } });
    expect(f.owner.forBatch('batch', 'root-one')?.id).toBe(f.run.id);
    expect(f.owner.forTurn('root-one', 'update')?.id).toBe(f.run.id);
    expect(f.owner.turns(f.run).map((turn) => turn.id)).toEqual(['turn-one', 'update']);
    expect(f.owner.turns(f.other).map((turn) => turn.id)).toEqual(['turn-two']);
  });

  test('an unrelated source Task, substituted owner, or mixed batch cannot borrow a run identity', () => {
    const f = fixture();
    const process = { taskId: 'process', ownerThreadId: 'root-two', sourceTurnId: 'turn-two', parentTaskId: null } as ToolTaskRecord;
    f.tasks.set(process.taskId, process);
    expect(f.owner.ownsTask(f.run, process)).toBe(false);
    f.batches.set('mixed', { batchId: 'mixed', ownerThreadId: 'root-one', reservedTurnId: 'update', taskIds: ['process'] } as ToolTaskDeliveryBatch);
    expect(f.owner.forBatch('mixed', 'root-one')).toBeNull();
    f.turns.set('root-two:forged', { ...f.original, id: 'forged' });
    expect(f.owner.forTurn('root-two', 'forged')).toBeNull();
  });

  test('delegated process membership follows canonical parent relationships and rejects cycles', () => {
    const f = fixture();
    const parent = { taskId: 'launcher', ownerThreadId: 'root-one', sourceTurnId: 'turn-one', parentTaskId: null } as ToolTaskRecord;
    const child = { taskId: 'child', ownerThreadId: 'delegated', sourceTurnId: 'child-turn', parentTaskId: parent.taskId } as ToolTaskRecord;
    f.tasks.set(parent.taskId, parent); f.tasks.set(child.taskId, child);
    expect(f.owner.ownsTask(f.run, child)).toBe(true);
    f.tasks.set(parent.taskId, { ...parent, sourceTurnId: 'missing', parentTaskId: child.taskId });
    expect(f.owner.ownsTask(f.run, child)).toBe(false);
  });

  test('an empty terminal Turn is not displayed as a delivered result', async () => {
    const f = fixture();
    const result = await scheduledRunResult(f.run, { readTurn: () => ({ ...f.original, items: [] }),
      recordPath: async () => '/records/empty.md', acknowledged: () => false });
    expect(result.state).toBe('unavailable');
    expect(result.answer).toBeNull();
    expect(result.recordPath).toBe('/records/empty.md');
    expect(result.issue).toContain('without a delivered answer');
  });

  test('an interrupted Turn remains stopping until its cancellation-owned process settles', async () => {
    const f = fixture();
    const result = await scheduledRunResult(f.run, { readTurn: () => ({ ...f.original, status: 'interrupted' }),
      stopping: () => true, recordPath: async () => '/records/one.md', acknowledged: () => false });
    expect(result.state).toBe('stopping');
    expect(result.finishedAt).toBeNull();
    expect(result.issues[0]?.text).toBe('Execution was interrupted.');
  });

  test('unsettled resource attention stays separate from a delivered answer', async () => {
    const f = fixture();
    const result = await scheduledRunResult(f.run, { readTurn: () => f.original, recordPath: async () => '/records/one.md', acknowledged: () => false,
      resourceIssues: () => [{ key: 'task:service:ownership_unverified', text: 'Service ownership needs recovery', turnId: f.original.id, terminal: false }] });
    expect(result.state).toBe('completed');
    expect(result.answer).toBe('Delivered answer');
    expect(result.issues).toEqual([expect.objectContaining({ text: 'Service ownership needs recovery', terminal: false, acknowledged: false })]);
  });

  test('missing canonical output shows unavailable and never preserves completed from a dispatch association', async () => {
    const f = fixture();
    const result = await scheduledRunResult(f.run, { readTurn: () => null, recordPath: async () => null, acknowledged: () => false });
    expect(result.state).toBe('unavailable');
    expect(result.answer).toBeNull();
    expect(result.issueKey).not.toBeNull();
  });

  test('inspection failures preserve known execution evidence and explicit answer truncation', async () => {
    const f = fixture();
    const result = await scheduledRunResult(f.run, { readTurn: () => ({ ...f.original, items: [{ ...f.original.items[0]!, text: 'a'.repeat(40_000) }] as Turn['items'] }),
      additionalTurns: () => { throw new Error('Optional update inspection unavailable'); }, recordPath: async () => { throw new Error('Record publication unavailable'); }, acknowledged: () => false });
    expect(result.state).toBe('completed');
    expect(result.answerTruncated).toBe(true);
    expect(result.recordPath).toBeNull();
  });

  test('a later delivery does not dismiss an older failed Turn in the same run', async () => {
    const f = fixture();
    const first = { ...f.original, status: 'failed', error: { message: 'Unresolved original failure' } } as Turn;
    const update = { ...f.original, id: 'later-delivery', startedAt: 3, completedAt: 4 };
    const result = await scheduledRunResult(f.run, { readTurn: () => first, additionalTurns: () => [update],
      recordPath: async () => '/records/retained.md', acknowledged: () => false });
    expect(result.state).toBe('completed');
    expect(result.issues).toEqual([expect.objectContaining({ text: 'Unresolved original failure', acknowledged: false, turnId: first.id })]);
  });

  test('acknowledgement changes attention only and a different terminal cause remains new', async () => {
    const f = fixture();
    const first = await scheduledRunResult(f.run, { readTurn: () => ({ ...f.original, status: 'failed', error: { message: 'Failure one' } } as Turn),
      recordPath: async () => null, acknowledged: () => false });
    const acknowledged = await scheduledRunResult(f.run, { readTurn: () => ({ ...f.original, status: 'failed', error: { message: 'Failure one' } } as Turn),
      recordPath: async () => null, acknowledged: (_run, key) => key === first.issueKey });
    expect(acknowledged).toMatchObject({ state: 'failed', acknowledged: true, issueKey: first.issueKey });
    const later = await scheduledRunResult(f.run, { readTurn: () => ({ ...f.original, status: 'failed', error: { message: 'Failure two' } } as Turn),
      recordPath: async () => null, acknowledged: (_run, key) => key === first.issueKey });
    expect(later.acknowledged).toBe(false);
  });
});
