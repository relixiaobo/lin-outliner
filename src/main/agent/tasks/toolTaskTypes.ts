import type {
  ThreadId,
  ToolTaskDeliveryState,
  ToolTaskDetailState,
  ToolTaskArtifact,
  ToolTaskExecutionState,
  ToolTaskProgress,
  ToolTaskProjection,
  ToolTaskStoragePressure,
  ToolTaskTurnAdmission,
  TurnId,
} from '../../../core/agent/protocol';

export type {
  ToolTaskDeliveryState,
  ToolTaskDetailState,
  ToolTaskArtifact,
  ToolTaskExecutionState,
  ToolTaskProgress,
  ToolTaskProjection,
  ToolTaskStoragePressure,
};

export interface ToolTaskRecord extends ToolTaskProjection {
  readonly backgroundEnabled: boolean;
  readonly commandDigest: string;
  readonly cwd: string;
  readonly nonce: string;
  readonly detailPath: string;
  readonly supervisorPid: number | null;
  readonly childPid: number | null;
  readonly timeoutMs: number;
  readonly stopRequestedAt: number | null;
  readonly terminalDigest: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly quiescedAt: number | null;
  readonly updatedAt: number;
  readonly artifactsSettled: boolean;
  readonly reservationBytes: number;
  readonly deliveredAt: number | null;
}

export interface ToolTaskArtifactSettlement {
  readonly artifacts: readonly ToolTaskArtifact[];
  readonly warnings: readonly string[];
}

export type ToolTaskProducerReconciliation =
  | { readonly outcome: 'preserve' }
  | {
    readonly outcome: 'replace';
    readonly state: Extract<ToolTaskExecutionState, 'failed' | 'cancelled' | 'timed_out' | 'lost'>;
    readonly reason: string;
    readonly error: string | null;
  };

export interface ToolTaskSchedulingPolicy {
  readonly pool: string;
  readonly configurationRevision: string;
  readonly maxConcurrentProducer: number;
  readonly maxConcurrentPool: number;
}

export interface ToolTaskSchedulerLimits {
  readonly maxConcurrentGlobal: number;
  readonly maxConcurrentThread: number;
  readonly maxQueuedGlobal: number;
  readonly maxQueuedThread: number;
}

export interface ToolTaskLease {
  readonly taskId: string;
  readonly ownerThreadId: ThreadId;
  readonly nonce: string;
  readonly producer: string;
  readonly pool: string;
  readonly configurationRevision: string;
  readonly maxConcurrentProducer: number;
  readonly maxConcurrentPool: number;
  readonly state: 'queued' | 'active' | 'released';
  readonly createdAt: number;
  readonly acquiredAt: number | null;
  readonly releasedAt: number | null;
}

export type ToolTaskProcessSpec =
  | { readonly kind: 'shell'; readonly command: string }
  | {
    readonly kind: 'exec';
    readonly executable: string;
    readonly args: readonly string[];
    /** Complete child environment snapshot. The supervisor does not add ambient variables. */
    readonly env: Readonly<Record<string, string>>;
    readonly privateControl: boolean;
  };

export interface ToolTaskSupervisorConfig {
  readonly version: 2;
  readonly taskId: string;
  readonly nonce: string;
  readonly process: ToolTaskProcessSpec;
  readonly cwd: string;
  readonly stdinPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly progressPath: string;
  readonly identityPath: string;
  readonly heartbeatPath: string;
  readonly stopRequestPath: string;
  readonly finalReceiptPath: string;
  readonly preparedResultPath: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxPreparedResultBytes: number;
}

export interface ToolTaskSupervisorIdentity {
  readonly version: 1;
  readonly taskId: string;
  readonly nonce: string;
  readonly supervisorPid: number;
  readonly childPid: number;
  readonly startedAt: number;
}

export interface ToolTaskSupervisorHeartbeat {
  readonly version: 1;
  readonly taskId: string;
  readonly nonce: string;
  readonly supervisorPid: number;
  readonly updatedAt: number;
}

export interface ToolTaskFinalReceipt {
  readonly version: 2;
  readonly taskId: string;
  readonly nonce: string;
  readonly state: Extract<ToolTaskExecutionState, 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'lost'>;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: string;
  readonly error: string | null;
  readonly supervisorPid: number | null;
  readonly childPid: number | null;
  readonly startedAt: number;
  readonly quiescedAt: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly preparedResultDigest: string | null;
  readonly preparedResultBytes: number;
  readonly receiptDigest: string;
}

export type ToolTaskDeliveryAdmission = ToolTaskTurnAdmission;

export interface ToolTaskDeliveryBatch {
  readonly batchId: string;
  readonly ownerThreadId: ThreadId;
  readonly reservedTurnId: TurnId;
  readonly clientId: string;
  readonly envelopeDigest: string;
  readonly state: 'prepared' | 'linked' | 'rolled_back' | 'blocked';
  readonly taskIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function isToolTaskTerminal(state: ToolTaskExecutionState): boolean {
  return state !== 'running' && state !== 'settling';
}
