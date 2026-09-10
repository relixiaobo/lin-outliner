import type { ProcessObservationPayload, ThreadContextPayload, ThreadContextPayloadReference, Turn } from '../../../core/agent/protocol';
import type { ToolTaskRecord } from '../tasks/toolTaskTypes';
import { executionDigest } from '../tasks/ExecutionContext';

/** Read the Task owner; never infer liveness from a terminal name or launch work. */
export function processObservation(task: ToolTaskRecord): ProcessObservationPayload | null {
  if (task.isolation.state === null) return null;
  const { isolation } = task;
  const isolationVersion = executionDigest(isolation);
  const isolationText = 'The latest observed invocation at ' + JSON.stringify(task.cwd)
    + ' requested ' + isolation.requested + '; actual isolation: ' + isolation.state
    + '; backend: ' + (isolation.backend ?? 'none') + '; network: ' + isolation.network
    + '. Write roots: ' + JSON.stringify(isolation.writablePaths)
    + '. Protected Git object stores: ' + JSON.stringify(isolation.protectedGitObjectStores)
    + '. ' + (isolation.reason ?? '') + ' This records that invocation, not a guarantee for future commands.';
  const observedAt = task.completedAt ?? task.startedAt;
  const facts: ProcessObservationPayload['facts'][number][] = [{
    source: 'host:process-isolation', kind: 'process', authority: 'host', purpose: 'observation',
    scope: task.cwd, version: isolationVersion, text: isolationText, invalidated: false, observedAt,
  }];
  if (task.backgroundEnabled) facts.push({
    source: 'host:process:' + task.taskId, kind: 'process', authority: 'host', purpose: 'observation', scope: task.cwd,
    version: executionDigest({ isolation, state: task.state, outcome: task.outcomeReason, continuation: task.continuation }),
    text: 'Owned Task ' + task.taskId + ' at ' + JSON.stringify(task.cwd) + ' was observed ' + task.state
      + '; isolation: ' + isolation.state + '; outcome: ' + (task.outcomeReason ?? 'pending')
      + '; responsibility: ' + JSON.stringify(task.continuation)
      + '. This is recorded evidence, not current liveness. Reconcile this Task before acting; do not start a replacement from context alone.',
    invalidated: false, observedAt,
  });
  return { schemaVersion: 1, kind: 'processObservation', taskId: task.taskId, state: task.state,
    executionContext: task.executionContext, isolation, facts };
}

/** Canonical evidence is the delivery cursor. A bounded backlog resumes after interruption. */
export async function planProcessObservations(
  turns: readonly Turn[], tasks: readonly ToolTaskRecord[],
  read: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<readonly ProcessObservationPayload[]> {
  const located = turns.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
  let reset = -1;
  located.forEach(({ item }, index) => { if (item.type === 'contextReset') reset = index; });
  const visible = located.slice(reset + 1);
  const sources = new Set(visible.map(({ turn, item }) => JSON.stringify([turn.id, item.id])));
  const previous = new Map<string, string>();
  for (const { item } of visible) {
    if (item.type !== 'contextEvidence' || item.kind !== 'processObservation') continue;
    const payload = await read(item.payloadRef).catch(() => null);
    if (payload?.kind === 'processObservation') previous.set(payload.taskId, executionDigest(payload.facts));
  }
  const pending: ProcessObservationPayload[] = [];
  for (const task of tasks) {
    if (!sources.has(JSON.stringify([task.sourceTurnId, task.sourceItemId]))) continue;
    const payload = processObservation(task);
    if (!payload || previous.get(task.taskId) === executionDigest(payload.facts)) continue;
    pending.push(payload);
    if (pending.length === 32) break;
  }
  return pending;
}
