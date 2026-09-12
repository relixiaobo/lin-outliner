import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_OPERATION_ID } from '../../core/dataLifecycle';
import { assertOwnedPath, readPrivateJson, record, writeDurableJson, type DataLifecycleCheckpoint } from './durableFiles';

export interface DataOperation {
  readonly version: 1;
  readonly id: string;
  readonly kind: 'initialize' | 'backup' | 'restore';
  readonly phase: 'preparing' | 'retaining' | 'staging' | 'installing' | 'verifying' | 'complete';
  readonly createdAt: number;
  readonly backupId: string;
  readonly sourceBackupId: string | null;
  readonly completedRoots: readonly string[];
  readonly generation: string | null;
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

  async write(operation: DataOperation): Promise<void> {
    decodeDataOperation(operation);
    const current = this.latest ?? await this.read();
    if (current && current.phase !== 'complete' && current.id !== operation.id) throw new Error('Another data operation still owns the dataset');
    const path = await assertOwnedPath(this.userData, 'data-lifecycle/operation.json');
    if (current) await writeDurableJson(join(this.userData, 'data-lifecycle/operation.previous.json'), {
      operation: current, digest: operationDigest(current),
    }, this.checkpoint);
    await this.checkpoint?.('before-operation-intent');
    await writeDurableJson(path, { operation, digest: operationDigest(operation) }, this.checkpoint);
    this.latest = operation;
    await this.checkpoint?.(`operation:${operation.phase}`);
  }
}

export function decodeDataOperation(value: unknown): DataOperation {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !DATA_OPERATION_ID.test(value.id)
    || !['initialize', 'backup', 'restore'].includes(String(value.kind))
    || !['preparing', 'retaining', 'staging', 'installing', 'verifying', 'complete'].includes(String(value.phase))
    || !Number.isSafeInteger(value.createdAt) || typeof value.backupId !== 'string' || !DATA_OPERATION_ID.test(value.backupId)
    || (value.sourceBackupId !== null && (typeof value.sourceBackupId !== 'string' || !DATA_OPERATION_ID.test(value.sourceBackupId)))
    || (value.generation !== null && (typeof value.generation !== 'string' || !DATA_OPERATION_ID.test(value.generation)))
    || !Array.isArray(value.completedRoots) || value.completedRoots.some((root) => typeof root !== 'string')
    || new Set(value.completedRoots).size !== value.completedRoots.length || value.completedRoots.length > 100) {
    throw new Error('Unsupported data operation journal');
  }
  if (value.kind === 'restore' && (!value.sourceBackupId || !value.generation)) throw new Error('Restore journal is missing its source or generation');
  return value as unknown as DataOperation;
}

function operationDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
