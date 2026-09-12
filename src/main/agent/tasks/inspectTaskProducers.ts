import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DATA_OPERATION_ID } from '../../../core/dataLifecycle';
import { assertOwnedPath, missing, readPrivateJson, record } from '../../dataLifecycle/durableFiles';

/** Process evidence remains readable even when the Task SQLite file is damaged. */
export async function assertTaskProducersQuiescent(
  userData: string, isHistorical: (id: string) => boolean, candidates?: ReadonlySet<string>,
): Promise<void> {
  const root = await assertOwnedPath(userData, 'agent/tool-tasks');
  const names = await readdir(root).catch((error: unknown) => { if (missing(error)) return []; throw error; });
  const prefixes = [join(resolve(userData), 'agent/tool-tasks') + '/', join(await realpath(userData), 'agent/tool-tasks') + '/'];
  const processes = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,command='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, output) => error ? reject(error) : resolve(output));
  });
  if (processes.split('\n').some((line) => prefixes.some((prefix) => line.includes(prefix)))) throw busy('A Task supervisor still owns working files. Stop its work before data maintenance.');
  for (const id of names) {
    if (!id.startsWith('task_') || !DATA_OPERATION_ID.test(id.slice(5)) || isHistorical(id) || candidates && !candidates.has(id)) continue;
    const config = await readPrivateJson(await assertOwnedPath(userData, `agent/tool-tasks/${id}/config.json`), 1024 * 1024);
    if (config === null) continue;
    if (!record(config) || config.taskId !== id || typeof config.nonce !== 'string') throw busy('Task startup ownership could not be verified.');
    const receipt = await readPrivateJson(await assertOwnedPath(userData, `agent/tool-tasks/${id}/final-receipt.json`), 1024 * 1024);
    if (record(receipt) && receipt.version === 3 && receipt.taskId === id && receipt.nonce === config.nonce
      && typeof receipt.quiescedAt === 'number' && Number.isFinite(receipt.quiescedAt)) {
      const { receiptDigest, ...unsigned } = receipt;
      if (createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') === receiptDigest) continue;
    }
    const identity = await readPrivateJson(await assertOwnedPath(userData, `agent/tool-tasks/${id}/identity.json`));
    if (!record(identity) || identity.version !== 2 || identity.taskId !== id || identity.nonce !== config.nonce
      || !Number.isSafeInteger(identity.supervisorPid) || !Number.isSafeInteger(identity.childPid)) {
      throw busy('An unfinished Task has no verifiable process identity or terminal receipt. Its work must be settled before data maintenance.');
    }
    if (processExists(identity.supervisorPid as number) || processExists(identity.childPid as number)
      || processExists(-(identity.childPid as number))) throw busy('A Task process or process group is still active.');
  }
}

function busy(message: string): Error { return Object.assign(new Error(message), { code: 'SQLITE_BUSY' }); }
function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return record(error) && error.code === 'EPERM'; }
}
