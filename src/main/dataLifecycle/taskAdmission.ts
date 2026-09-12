import { basename, dirname, join } from 'node:path';
import { inspectRuntimeDataAdmission } from '../../outline/dataLifecycleGate';
import { DATA_OPERATION_ID } from '../../core/dataLifecycle';
import { assertOwnedPath, readPrivateJson, record } from './durableFiles';

export async function assertTaskDataAdmission(configPath: string, taskId: string): Promise<void> {
  const detailRoot = dirname(dirname(configPath));
  if (basename(detailRoot) !== 'tool-tasks' || basename(dirname(detailRoot)) !== 'agent') return;
  const userData = dirname(dirname(detailRoot));
  await inspectRuntimeDataAdmission(join(userData, 'outline-runtime'));
  const fence = await readPrivateJson(await assertOwnedPath(userData, 'data-lifecycle/execution-fence.json'));
  if (fence === null) return;
  if (!record(fence) || fence.version !== 1 || typeof fence.generation !== 'string' || !DATA_OPERATION_ID.test(fence.generation)) throw new Error('Task restoration authority is unavailable');
  const work = await readPrivateJson(await assertOwnedPath(userData, `data-lifecycle/restored-work/${fence.generation}.json`), 64 * 1024 * 1024);
  if (!record(work) || work.version !== 1 || work.generation !== fence.generation || !Array.isArray(work.entries)
    || work.entries.length > 200_000 || work.entries.some((entry) => !record(entry) || typeof entry.id !== 'string'
      || !['task', 'run', 'goal', 'session', 'profile', 'memory-job', 'thread'].includes(String(entry.kind)))) throw new Error('Restored work has not been classified');
  if (work.entries.some((entry) => record(entry) && entry.kind === 'task' && entry.id === taskId)) throw new Error('Historical Task configuration cannot relaunch a process');
}
