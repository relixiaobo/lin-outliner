import type { DelegationRunnerAdapter } from './DelegationPolicyResolver';
import type { ToolTaskService } from '../tasks/ToolTaskService';
import type { ToolTaskRecord } from '../tasks/toolTaskTypes';

type ProcessExecutor = Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0]['executeProcess'];

export function nativeAgentProcessExecutor(
  service: ToolTaskService,
  owner: ToolTaskRecord,
  signal: AbortSignal,
  onAdmitted: (task: ToolTaskRecord) => Promise<void>,
): ProcessExecutor {
  return async (input) => {
    const task = await service.start({
      ownerThreadId: owner.ownerThreadId, sourceTurnId: owner.sourceTurnId, sourceItemId: owner.sourceItemId,
      producer: 'native_agent', description: 'Run native Agent', command: input.executable,
      cwd: owner.cwd, executionContext: owner.executionContext, parentTaskId: owner.taskId,
      stdin: input.stdin, timeoutMs: 600_000, env: process.env,
      process: { kind: 'exec', executable: input.executable, args: input.args,
        env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        privateControl: false },
      backgroundEnabled: false, signal, onAdmitted,
    });
    const stop = () => { void service.stop(task.taskId, task.ownerThreadId).catch(() => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      const terminal = await service.waitForTerminal(task.taskId, task.ownerThreadId, 605_000);
      const output = await service.output(task.taskId, task.ownerThreadId, 8 * 1024 * 1024);
      return {
        stdout: output?.stdout ?? '', stderr: output?.stderr ?? '',
        truncated: (output?.stdoutTruncated ?? false) || (output?.stderrTruncated ?? false),
        outcome: terminal?.state === 'succeeded' ? 'succeeded' : terminal?.state === 'cancelled' ? 'cancelled' : 'failed',
        error: terminal?.error ?? (terminal?.state === 'succeeded' ? null : `Native Agent task ended as ${terminal?.state ?? 'unavailable'}`),
      };
    } finally { signal.removeEventListener('abort', stop); }
  };
}
