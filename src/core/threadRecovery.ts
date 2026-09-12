export const THREAD_RECOVERY_CHANNEL = 'lin:thread-recovery';

export type ThreadRecoveryAction = 'rebuild' | 'remove';
export type ThreadRecoveryPhase = 'retaining' | 'applying' | 'complete' | 'cancelled';

export interface ThreadRecoveryScope {
  readonly threadId: string;
  readonly name: string | null;
  readonly parentThreadId: string | null;
}

/** Paths in this DTO are display-only; requests never accept a filesystem path. */
export interface ThreadRecoveryPreview {
  readonly recoveryId: string;
  readonly revision: string;
  readonly threads: readonly ThreadRecoveryScope[];
  readonly source: 'rollout' | 'history-projection' | null;
  readonly rebuildUnavailable: string | null;
  readonly blockers: readonly string[];
  readonly resourceCount: number;
  readonly retainedRoot: string;
  readonly operation: {
    readonly id: string;
    readonly action: ThreadRecoveryAction;
    readonly phase: ThreadRecoveryPhase;
    readonly completedSteps: number;
    readonly error: string | null;
    readonly retainedPath: string;
  } | null;
}

export type ThreadRecoveryRequest =
  | { readonly recoveryId: string; readonly action: 'inspect' }
  | { readonly recoveryId: string; readonly action: ThreadRecoveryAction; readonly revision: string }
  | { readonly recoveryId: string; readonly action: 'resume' | 'reveal' | 'reinspect'; readonly operationId: string };

export interface ThreadRecoveryResponse {
  readonly preview: ThreadRecoveryPreview;
  readonly cancelled?: true;
}

export function decodeThreadRecoveryRequest(value: unknown): ThreadRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery request');
  const record = value as Record<string, unknown>;
  const id = record.recoveryId;
  if (typeof id !== 'string' || !/^thread:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid conversation recovery identity');
  }
  const keys = record.action === 'inspect' ? ['recoveryId', 'action']
    : record.action === 'rebuild' || record.action === 'remove' ? ['recoveryId', 'action', 'revision']
      : record.action === 'resume' || record.action === 'reveal' || record.action === 'reinspect' ? ['recoveryId', 'action', 'operationId'] : null;
  if (!keys || Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error('Invalid recovery action');
  }
  if ('revision' in record && (typeof record.revision !== 'string' || !/^[a-f0-9]{64}$/.test(record.revision))) {
    throw new Error('Invalid recovery observation');
  }
  if ('operationId' in record && (typeof record.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(record.operationId))) {
    throw new Error('Invalid recovery operation identity');
  }
  return record as unknown as ThreadRecoveryRequest;
}
