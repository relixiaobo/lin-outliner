export const DATA_LIFECYCLE_CHANNEL = 'lin:data-lifecycle';
export const DATA_LIFECYCLE_CHANGED_CHANNEL = 'lin:data-lifecycle-changed';

export type DataLifecycleDomain = 'outline' | 'agent' | 'configuration' | 'desktop';
export type DataLifecyclePhase = 'inspecting' | 'backingUp' | 'migrating' | 'restoring'
  | 'rebuilding' | 'ready' | 'recoveryRequired';

export interface DataLifecycleIssue {
  readonly storeId: string;
  readonly domain: DataLifecycleDomain;
  readonly reason: 'future-version' | 'invalid-data' | 'locked' | 'storage-full'
    | 'permission' | 'incomplete-operation' | 'unknown';
  readonly message: string;
  readonly foundVersion?: number;
  readonly expectedVersion?: number;
}

export interface DataBackupSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly applicationVersion: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly verified: boolean;
  readonly pinned: boolean;
  readonly purpose: 'backup' | 'retention';
}

/** Opaque IDs authorize owner lookup. Filesystem paths never enter this protocol. */
export interface DataLifecycleState {
  readonly revision: number;
  readonly phase: DataLifecyclePhase;
  readonly operationId: string | null;
  readonly progress: { readonly completed: number; readonly total: number } | null;
  readonly issues: readonly DataLifecycleIssue[];
  readonly backups: readonly DataBackupSummary[];
  readonly restoredGeneration: string | null;
  readonly automaticExecutionPaused: boolean;
  readonly canCancelOperation: boolean;
}

export type DataLifecycleRequest =
  | { readonly action: 'status' }
  | { readonly action: 'inspect' }
  | { readonly action: 'backup' }
  | { readonly action: 'retry' }
  | { readonly action: 'export-diagnostics' }
  | { readonly action: 'reveal'; readonly backupId: string }
  | { readonly action: 'cancel'; readonly operationId: string; readonly revision: number }
  | { readonly action: 'repair-history'; readonly revision: number }
  | { readonly action: 'restore'; readonly backupId: string; readonly revision: number }
  | { readonly action: 'resume-execution'; readonly generation: string; readonly revision: number };

export interface DataLifecycleResponse {
  readonly state: DataLifecycleState;
  readonly cancelled?: true;
  readonly restartRequired?: true;
}

export function decodeDataLifecycleRequest(value: unknown): DataLifecycleRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid data recovery request');
  const record = value as Record<string, unknown>;
  const keys = record.action === 'restore' ? ['action', 'backupId', 'revision']
    : record.action === 'reveal' ? ['action', 'backupId']
      : record.action === 'cancel' ? ['action', 'operationId', 'revision']
        : record.action === 'repair-history' ? ['action', 'revision']
    : record.action === 'resume-execution' ? ['action', 'generation', 'revision']
      : ['status', 'inspect', 'backup', 'retry', 'export-diagnostics'].includes(String(record.action)) ? ['action'] : null;
  if (!keys || Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error('Invalid data recovery action');
  }
  for (const key of ['backupId', 'generation', 'operationId']) {
    if (key in record && (typeof record[key] !== 'string' || !DATA_OPERATION_ID.test(record[key]))) {
      throw new Error('Invalid data recovery identity');
    }
  }
  if ('revision' in record && (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0)) {
    throw new Error('Invalid data recovery observation');
  }
  return record as unknown as DataLifecycleRequest;
}

export const DATA_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function initialDataLifecycleState(): DataLifecycleState {
  return { revision: 0, phase: 'inspecting', operationId: null, progress: null,
    issues: [], backups: [], restoredGeneration: null, automaticExecutionPaused: false, canCancelOperation: false };
}
