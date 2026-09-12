import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_OPERATION_ID } from '../../core/dataLifecycle';
import { assertOwnedPath, readPrivateJson, record, writeDurableJson, type DataLifecycleCheckpoint } from './durableFiles';

export interface DataOperation {
  readonly version: 1;
  readonly id: string;
  readonly kind: 'initialize' | 'backup' | 'restore' | 'resume' | 'repair-history';
  readonly phase: 'preparing' | 'retaining' | 'staging' | 'installing' | 'verifying' | 'reconciling' | 'complete';
  readonly createdAt: number;
  readonly backupId: string;
  readonly sourceBackupId: string | null;
  readonly completedRoots: readonly string[];
  readonly generation: string | null;
  readonly targetDigest: string;
  readonly applicationVersion: string;
  readonly sourceDigest?: string;
  readonly supersedes?: string;
  readonly cancelled?: true;
}

export class DataOperationJournal {
  private latest: DataOperation | null = null;
  constructor(private readonly userData: string, private readonly checkpoint?: DataLifecycleCheckpoint) {}

  async read(): Promise<DataOperation | null> {
    const path = await assertOwnedPath(this.userData, 'data-lifecycle/operation.json');
    const value = await readPrivateJson(path);
    if (value === null) return this.latest = null;
    if (!record(value) || !record(value.operation) || value.digest !== operationDigest(value.operation)) {
      throw new Error('The data operation journal is invalid; its retained previous generation is available for inspection.');
    }
    return this.latest = decodeDataOperation(value.operation);
  }

  async write(operation: DataOperation, supersedeId?: string): Promise<void> {
    decodeDataOperation(operation);
    const current = this.latest ?? await this.read();
    if (current && current.phase !== 'complete' && current.id !== operation.id) {
      if (operation.kind !== 'restore' || operation.supersedes !== current.id || supersedeId !== current.id) throw new Error('Another data operation still owns the dataset');
      await writeDurableJson(join(this.userData, 'data-lifecycle/operations', current.id, 'superseded.json'), {
        operation: current, digest: operationDigest(current), supersededBy: operation.id,
      }, this.checkpoint);
    }
    const path = await assertOwnedPath(this.userData, 'data-lifecycle/operation.json');
    if (current) await writeDurableJson(join(this.userData, 'data-lifecycle/operation.previous.json'), {
      operation: current, digest: operationDigest(current),
    }, this.checkpoint);
    await this.checkpoint?.('before-operation-intent');
    await writeDurableJson(path, { operation, digest: operationDigest(operation) }, this.checkpoint);
    this.latest = operation;
    await this.checkpoint?.(`operation:${operation.phase}`);
  }

  /** Restored PID fields are not process evidence after a proven installation fence. */
  async hasQuiescedPredecessor(operation: DataOperation): Promise<boolean> {
    let current = operation;
    const seen = new Set<string>();
    while (current.supersedes) {
      if (seen.has(current.id) || seen.size > 100) throw new Error('Invalid recovery predecessor chain');
      seen.add(current.id);
      const path = await assertOwnedPath(this.userData, `data-lifecycle/operations/${current.supersedes}/superseded.json`);
      const value = await readPrivateJson(path);
      if (!record(value) || !record(value.operation) || value.supersededBy !== current.id
        || value.digest !== operationDigest(value.operation)) throw new Error('Recovery predecessor evidence is unavailable');
      current = decodeDataOperation(value.operation);
      if (current.phase !== 'preparing' && current.phase !== 'complete') return true;
    }
    return false;
  }
}

export function decodeDataOperation(value: unknown): DataOperation {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !DATA_OPERATION_ID.test(value.id)
    || !['initialize', 'backup', 'restore', 'resume', 'repair-history'].includes(String(value.kind))
    || !['preparing', 'retaining', 'staging', 'installing', 'verifying', 'reconciling', 'complete'].includes(String(value.phase))
    || !Number.isSafeInteger(value.createdAt) || typeof value.backupId !== 'string' || !DATA_OPERATION_ID.test(value.backupId)
    || (value.sourceBackupId !== null && (typeof value.sourceBackupId !== 'string' || !DATA_OPERATION_ID.test(value.sourceBackupId)))
    || (value.generation !== null && (typeof value.generation !== 'string' || !DATA_OPERATION_ID.test(value.generation)))
    || !Array.isArray(value.completedRoots) || value.completedRoots.some((root) => typeof root !== 'string')
    || new Set(value.completedRoots).size !== value.completedRoots.length || value.completedRoots.length > 100
    || typeof value.targetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.targetDigest)
    || typeof value.applicationVersion !== 'string' || value.applicationVersion.length > 100) {
    throw new Error('Unsupported data operation journal');
  }
  if (value.kind === 'restore' && (!value.sourceBackupId || !value.generation)) throw new Error('Restore journal is missing its source or generation');
  if (value.kind === 'resume' && !value.generation) throw new Error('Execution resumption is missing its restore generation');
  if (value.kind === 'repair-history' && (typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDigest))) throw new Error('History repair is missing its verified source digest');
  if (value.supersedes !== undefined && (value.kind !== 'restore' || typeof value.supersedes !== 'string' || !DATA_OPERATION_ID.test(value.supersedes))) throw new Error('Invalid superseded operation identity');
  if (value.cancelled !== undefined && (value.cancelled !== true || value.phase !== 'complete' || value.completedRoots.length)) throw new Error('Invalid data operation cancellation');
  return value as unknown as DataOperation;
}

function operationDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
