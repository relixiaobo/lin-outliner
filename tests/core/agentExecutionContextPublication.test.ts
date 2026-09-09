import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ExecutionContextFact } from '../../src/core/agent/executionContext';
import type { ContextEvidenceThreadItem, ThreadContextPayload, ThreadContextPayloadReference, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { checkpointExecutionContext, executionFactKey, planExecutionContextPublication, reducePublishedExecutionContext } from '../../src/main/agent/context/ExecutionContextPublication';
import { planContextCompaction } from '../../src/main/agent/context/ContextCompaction';
import { contextPayloadDependencies } from '../../src/main/agent/context/contextDependencies';
import { executionDigest, pendingExecutionContext } from '../../src/main/agent/tasks/ExecutionContext';

describe('execution-context publication', () => {
  test('announces only committed scoped facts and retains an empty boundary for unchanged task evidence', async () => {
    const f = fixture();
    const a = f.observation(fact('/a'));
    const first = await f.publish([a]);
    expect(first.payload.operations).toEqual([fact('/a')]);
    expect(await planExecutionContextPublication([turn([a, first.item])], f.read)).toBeNull();
    const same = f.observation(fact('/a'));
    const duplicate = await f.publish([a, first.item, same]);
    expect(duplicate.payload.text).toBe('');
    expect(duplicate.payload.evidenceRefs).toContainEqual(same.payloadRef);
    const b = f.observation(fact('/b'));
    const second = await f.publish([a, first.item, same, duplicate.item, b]);
    expect(second.payload.operations).toEqual([fact('/b')]);
    expect(JSON.stringify(second.payload)).not.toContain('task-');
    const uncommitted = await reducePublishedExecutionContext([turn([a])], f.read);
    expect(uncommitted.size).toBe(0);
    expect((await f.publish([a])).payload).toEqual(first.payload);
  });

  test('keeps source, scope, invalidation and repeated-event versions distinct', async () => {
    const f = fixture();
    const root = fact('/a');
    const baseline = await f.publish([f.observation(root)]);
    const nested = { ...root, scope: '/a/nested', source: '/a/nested/AGENTS.md' };
    const invalidation = { ...root, version: '2', text: 'The source was removed.', invalidated: true };
    const items = [baseline.item, f.observation(nested), f.observation(invalidation)];
    const delta = await f.publish(items);
    const state = await reducePublishedExecutionContext([turn([...items, delta.item])], f.read);
    expect(state.get(executionFactKey(root))?.fact.invalidated).toBe(true);
    expect(state.get(executionFactKey(nested))?.fact.invalidated).toBe(false);
    const check = { ...root, kind: 'check' as const, authority: 'host' as const, purpose: 'observation' as const, text: 'Tests passed.' };
    const checked = await f.publish([delta.item, f.observation(check)]);
    const checkedAgain = await f.publish([checked.item, f.observation({ ...check, version: '2' })]);
    expect(checkedAgain.payload.operations).toHaveLength(1);
  });

  test('leaves evidence arriving after bundle selection pending for the next boundary', async () => {
    const f = fixture();
    const a = f.observation(fact('/a'));
    const selected = await f.publish([a]);
    const late = f.observation(fact('/b'));
    const next = await f.publish([a, late, selected.item]);
    expect(next.payload.operations).toEqual([fact('/b')]);
    expect(next.payload.evidenceRefs).toEqual([late.payloadRef]);
    const committed = [a, late, selected.item, next.item];
    expect(await planExecutionContextPublication([turn(committed)], f.read)).toBeNull();
    expect([...await reducePublishedExecutionContext([turn(committed)], f.read)]
      .map(([, entry]) => entry.fact.scope)).toEqual(['/a', '/b']);
  });

  test('does not revive old guidance when a newer publication or inherited baseline is unavailable', async () => {
    const f = fixture();
    const old = await f.publish([f.observation(fact('/a'))]);
    const replacement = await f.publish([old.item, f.observation({ ...fact('/a'), version: '2', text: 'Changed guidance' })]);
    f.payloads.delete(replacement.item.payloadRef.id);
    expect((await reducePublishedExecutionContext([turn([old.item, replacement.item])], f.read)).size).toBe(0);
    const missingInherited = f.evidence({ schemaVersion: 1, kind: 'inheritedContext', turns: [] } as unknown as ThreadContextPayload);
    f.payloads.delete(missingInherited.payloadRef.id);
    expect((await reducePublishedExecutionContext([turn([old.item, missingInherited])], f.read)).size).toBe(0);
  });

  test('copies only the published baseline into a fork and drops pending evidence at reset', async () => {
    const f = fixture();
    const published = await f.publish([f.observation(fact('/a'))]);
    const pending = f.observation(fact('/b'));
    const inherited = f.evidence({ schemaVersion: 1, kind: 'inheritedContext', turns: [turn([published.item, pending])] } as unknown as ThreadContextPayload);
    const state = await reducePublishedExecutionContext([turn([inherited])], f.read);
    expect([...state.values()].map(({ fact }) => fact.scope)).toEqual(['/a']);
    expect((await f.publish([inherited, f.observation(fact('/b'))])).payload.operations).toEqual([fact('/b')]);
    const reset = { id: 'reset', type: 'contextReset' } as ThreadItem;
    expect(await planExecutionContextPublication([turn([published.item, pending, reset])], f.read)).toBeNull();
    expect((await reducePublishedExecutionContext([turn([published.item, reset])], f.read)).size).toBe(0);
  });

  test('bounds first publication and invalidates an obsolete baseline when its replacement cannot fit', async () => {
    const f = fixture();
    const oversized = { ...fact('/a'), text: 'x'.repeat(20_000) };
    const first = await f.publish([f.observation(oversized)]);
    expect(first.payload.text.length).toBeLessThanOrEqual(16_000);
    expect(first.payload.operations).toEqual([]);
    const baseline = await f.publish([f.observation(fact('/a'))]);
    const replacement = await f.publish([baseline.item, f.observation({ ...oversized, version: '2' })]);
    expect(replacement.payload.text).toContain('invalidated');
    expect(replacement.payload.operations[0]?.invalidated).toBe(true);
    const later = await f.publish([replacement.item, f.observation(fact('/a'))]);
    expect(later.payload.operations).toEqual([fact('/a')]);
  });

  test('compaction restores actual bodies with dependencies, excludes the preserved tail and survives repeated compaction', async () => {
    const f = fixture();
    const before = await f.publish([f.observation(fact('/a'))]);
    const after = await f.publish([before.item, f.observation(fact('/b'))]);
    const history = [turn([before.item, after.item])];
    const plan = await planContextCompaction({ turns: history, readContext: f.read,
      preserveFrom: { turnId: 'turn', itemId: after.item.id } });
    expect(plan?.restoredState.executionContext.text).toContain('/a');
    expect(plan?.restoredState.executionContext.text).not.toContain('/b');
    expect(plan?.contextRefs).toContainEqual(before.item.payloadRef);
    const restoredStateRef = f.evidence(plan!.restoredState).payloadRef;
    const compacted = { id: 'compaction', type: 'contextCompaction', ...plan, restoredStateRef,
      summaryRef: f.evidence(plan!.summary).payloadRef } as unknown as ThreadItem;
    const restored = [turn([before.item, after.item, compacted])];
    const state = await reducePublishedExecutionContext(restored, f.read);
    expect([...state.values()].map(({ fact }) => fact.scope)).toEqual(['/a', '/b']);
    const checkpoint = await checkpointExecutionContext(restored, f.read);
    expect(checkpoint.entries).toHaveLength(2);
    expect(checkpoint.text).toContain('recorded state');
    const pendingTail = f.observation(fact('/c'));
    const partialHistory = [turn([before.item, after.item, pendingTail, compacted])];
    const partialPlan = await planContextCompaction({ turns: partialHistory, readContext: f.read,
      preserveFrom: { turnId: 'turn', itemId: pendingTail.id } });
    expect(partialPlan?.restoredState.executionContext.entries.map(({ fact }) => fact.scope)).toEqual(['/a', '/b']);
    const partial = [turn([...partialHistory[0]!.items, { id: 'partial-compaction', type: 'contextCompaction', ...partialPlan,
      restoredStateRef: f.evidence(partialPlan!.restoredState).payloadRef,
      summaryRef: f.evidence(partialPlan!.summary).payloadRef } as unknown as ThreadItem])];
    expect([...await reducePublishedExecutionContext(partial, f.read)].map(([, entry]) => entry.fact.scope)).toEqual(['/a', '/b']);
    const secondPlan = await planContextCompaction({ turns: restored, readContext: f.read });
    expect(secondPlan?.restoredState.executionContext.entries).toHaveLength(2);
    const secondRef = f.evidence(secondPlan!.restoredState).payloadRef;
    const twice = [turn([...restored[0]!.items, { id: 'second-compaction', type: 'contextCompaction',
      ...secondPlan, restoredStateRef: secondRef, summaryRef: f.evidence(secondPlan!.summary).payloadRef } as unknown as ThreadItem])];
    expect([...await reducePublishedExecutionContext(twice, f.read)].map(([, entry]) => entry.fact.scope)).toEqual(['/a', '/b']);
    expect(contextPayloadDependencies(secondPlan!.restoredState).contexts).toContainEqual(before.item.payloadRef);
    f.payloads.delete(restoredStateRef.id);
    expect([...await reducePublishedExecutionContext(restored, f.read)].map(([, entry]) => entry.fact.scope)).toEqual(['/b']);
  });
});

function fact(scope: string): ExecutionContextFact {
  return { source: `${scope}/AGENTS.md`, scope, kind: 'instruction', authority: 'repository',
    purpose: 'guidance', version: '1', text: 'Run the project checks.', invalidated: false };
}
function turn(items: ThreadItem[]): Turn {
  return { id: 'turn', startedAt: 1, completedAt: 2, status: 'completed', items } as Turn;
}
function fixture() {
  const payloads = new Map<string, ThreadContextPayload>();
  const read = async (ref: ThreadContextPayloadReference) => payloads.get(ref.id) ?? null;
  let serial = 0;
  const evidence = (payload: ThreadContextPayload): ContextEvidenceThreadItem => {
    const bytes = JSON.stringify(payload);
    const payloadRef = { id: createHash('sha256').update(bytes).digest('hex'), schemaVersion: 1, kind: payload.kind, byteLength: Buffer.byteLength(bytes) } as ThreadContextPayloadReference;
    payloads.set(payloadRef.id, payload);
    const dependencies = contextPayloadDependencies(payload);
    return { type: 'contextEvidence', id: `evidence-${++serial}`, kind: payload.kind, payloadRef,
      summary: 'Execution observation', contextRefs: dependencies.contexts, internalTextRefs: dependencies.internalTexts,
      resourceRefs: dependencies.resources, outputRefs: dependencies.outputs } as ContextEvidenceThreadItem;
  };
  const observation = (fact: ExecutionContextFact) => {
    const context = pendingExecutionContext({ requestedCwd: null, cwd: fact.scope, targets: [], targetMode: 'follow', coverage: 'cwd-only',
      scopes: [{ key: `directory:${fact.scope}`, directory: fact.scope, worktree: null, gitDirectory: null }] },
    { capability: 'full-access', isolation: 'unsandboxed', writablePaths: [] });
    const snapshot = { ...context.snapshot, facts: [fact] };
    return evidence({ schemaVersion: 1, kind: 'taskExecutionContext', taskId: `task-${serial}`, sourceTurnId: 'turn',
      sourceItemId: 'tool', executionContext: { ...context, snapshot, snapshotRef: executionDigest(snapshot) } });
  };
  const publish = async (items: ThreadItem[]) => {
    const payload = (await planExecutionContextPublication([turn(items)], read))!;
    expect(payload).not.toBeNull();
    return { payload, item: evidence(payload) };
  };
  return { read, payloads, evidence, observation, publish };
}

test('process observations resume from canonical history, deduplicate unchanged isolation and retain owned Tasks through compaction', async () => {
  const { planProcessObservations, processObservation } = await import('../../src/main/agent/context/ProcessObservations');
  const { pendingProcessIsolation } = await import('../../src/core/agent/processIsolation');
  const f = fixture();
  const executionContext = pendingExecutionContext({ requestedCwd: null, cwd: '/repo', targets: [], targetMode: 'follow', coverage: 'cwd-only',
    scopes: [{ key: 'repo', directory: '/repo', worktree: null, gitDirectory: null }] },
  { capability: 'full-access', isolation: 'unsandboxed', writablePaths: [] });
  const task = { taskId: 'owned-process', cwd: '/repo', executionContext, sourceTurnId: 'turn', sourceItemId: 'tool',
    state: 'running', outcomeReason: null, backgroundEnabled: true, startedAt: 1, completedAt: null,
    isolation: { ...pendingProcessIsolation(executionContext.policy, 'darwin'), state: 'unsandboxed' },
  } as import('../../src/main/agent/tasks/toolTaskTypes').ToolTaskRecord;
  const source = { type: 'toolCall', id: 'tool' } as ThreadItem;
  const pending = await planProcessObservations([turn([source])], [task], f.read);
  expect(pending).toHaveLength(1);
  const observed = f.evidence(pending[0]!);
  expect(await planProcessObservations([turn([source, observed])], [task], f.read)).toEqual([]);
  const baseline = await f.publish([source, observed]);
  const stopped = f.evidence(processObservation({ ...task, state: 'cancelled', completedAt: 2, outcomeReason: 'stop_requested' })!);
  const after = await f.publish([source, observed, baseline.item, stopped]);
  expect(after.payload.text).toContain('cancelled');
  expect(after.payload.text).not.toContain('Write roots:');
  const history = [turn([source, observed, baseline.item, stopped, after.item])];
  const plan = await planContextCompaction({ turns: history, readContext: f.read });
  expect(plan!.restoredState.executionContext.text).toContain('owned-process');
  expect(plan!.restoredState.executionContext.text).toContain('not current liveness');
  expect(plan!.restoredState.executionContext.text).not.toContain('was observed running');
  expect(contextPayloadDependencies(plan!.restoredState).contexts).toContainEqual(after.item.payloadRef);
  expect(await planProcessObservations([turn([...history[0]!.items, { type: 'contextReset', id: 'reset' } as ThreadItem])], [task], f.read)).toEqual([]);

  const many = Array.from({ length: 40 }, (_, index) => ({ ...task, taskId: 'task-' + index }));
  const first = await planProcessObservations([turn([source])], many, f.read);
  expect(first).toHaveLength(32);
  const second = await planProcessObservations([turn([source, ...first.map(f.evidence)])], many, f.read);
  expect(second).toHaveLength(8);
  const foreground = f.evidence(processObservation({ ...task, taskId: 'foreground', backgroundEnabled: false, startedAt: 3 })!);
  const unchanged = await f.publish([source, observed, baseline.item, foreground]);
  expect(unchanged.payload.text).toBe('');
});
