import type { ToolTaskRecord } from '../tasks/toolTaskTypes';

/** Existing owner facts only; captured PIDs do not prove present process identity. */
export function taskExecutionObservation(task: ToolTaskRecord) {
  const reference = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
  const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : null;
  const pid = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? value as number : null;
  const sourceTurnId = reference(task.sourceTurnId), sourceItemId = reference(task.sourceItemId);
  const cwd = task.executionContext?.address.cwd;
  return {
    source: sourceTurnId && sourceItemId ? { turnId: sourceTurnId, itemId: sourceItemId } : null,
    cwd: typeof cwd === 'string' && cwd.length <= 4096 ? cwd : null,
    startedAt: time(task.startedAt), completedAt: time(task.completedAt),
    recordedProcess: { supervisorPid: pid(task.supervisorPid), childPid: pid(task.childPid) },
  };
}
