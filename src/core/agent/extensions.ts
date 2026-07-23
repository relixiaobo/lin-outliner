import type { EffectiveThreadConfiguration } from './configuration';
import type { ModelToolContract, ModelToolIdentity } from './tools';
import type {
  AdditionalContext,
  AgentCoreNotification,
  PrivilegedTurnStartRequest,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadItemId,
  Turn,
  TurnId,
  TurnProvenance,
  JsonValue,
} from './protocol';

export interface ThreadAdmissionBarrierSnapshot {
  readonly kind: 'thread';
  readonly threadId: ThreadId;
  readonly generation: number;
}

export interface HostRootTurnAdmissionBarrierSnapshot {
  readonly kind: 'hostRootTurns';
  readonly generation: number;
}

export function createThreadAdmissionBarrierSnapshot(
  threadId: ThreadId,
  generation: number,
): ThreadAdmissionBarrierSnapshot {
  return Object.freeze({
    kind: 'thread',
    threadId: nonEmpty(threadId, 'threadId'),
    generation: barrierGeneration(generation),
  });
}

export function createHostRootTurnAdmissionBarrierSnapshot(
  generation: number,
): HostRootTurnAdmissionBarrierSnapshot {
  return Object.freeze({ kind: 'hostRootTurns', generation: barrierGeneration(generation) });
}

export interface ThreadHistoryRollbackContext {
  readonly rollbackId: string;
  readonly threadId: ThreadId;
  readonly omittedTurnIds: readonly TurnId[];
  readonly beforeProjectionVersion: number;
  readonly afterProjectionVersion: number;
}

export function createThreadHistoryRollbackContext(
  rollbackId: string,
  threadId: ThreadId,
  omittedTurnIds: readonly TurnId[],
  beforeProjectionVersion: number,
  afterProjectionVersion: number,
): ThreadHistoryRollbackContext {
  if (omittedTurnIds.length === 0) throw new Error('omittedTurnIds must not be empty');
  const frozenTurnIds = Object.freeze(omittedTurnIds.map((turnId) => nonEmpty(turnId, 'omittedTurnIds')));
  if (new Set(frozenTurnIds).size !== frozenTurnIds.length) {
    throw new Error('omittedTurnIds must not contain duplicates');
  }
  const before = projectionVersion(beforeProjectionVersion, 'beforeProjectionVersion');
  const after = projectionVersion(afterProjectionVersion, 'afterProjectionVersion');
  if (after <= before) throw new Error('afterProjectionVersion must be greater than beforeProjectionVersion');
  return Object.freeze({
    rollbackId: nonEmpty(rollbackId, 'rollbackId'),
    threadId: nonEmpty(threadId, 'threadId'),
    omittedTurnIds: frozenTurnIds,
    beforeProjectionVersion: before,
    afterProjectionVersion: after,
  });
}

export interface TurnAdmissionContext {
  readonly thread: Thread;
  readonly turnId: TurnId;
  readonly provenance: TurnProvenance;
  readonly configuration: EffectiveThreadConfiguration;
  readonly threadBarrier: ThreadAdmissionBarrierSnapshot;
  readonly hostBarrier: HostRootTurnAdmissionBarrierSnapshot;
}

export interface TurnAdmissionContribution {
  readonly extensionId: string;
  readonly snapshotId: string;
}

export interface ThreadContextContribution {
  readonly extensionId: string;
  readonly additionalContext: AdditionalContext;
}

export interface ExtensionToolContribution {
  readonly extensionId: string;
  readonly tools: readonly ModelToolContract[];
}

export interface ToolLifecycleContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly identity: ModelToolIdentity;
  readonly arguments: JsonValue;
}

export interface ToolLifecycleResult extends ToolLifecycleContext {
  readonly result: JsonValue | null;
  readonly error: string | null;
}

export interface OrderedTurnItemContribution {
  readonly extensionId: string;
  readonly afterItemId?: ThreadItemId;
  readonly item: ThreadItem;
}

export interface AgentCoreExtension {
  readonly id: string;
  onThreadStarted?(thread: Thread): void | Promise<void>;
  onThreadResumed?(thread: Thread): void | Promise<void>;
  onThreadIdle?(thread: Thread): void | Promise<void>;
  onThreadStopped?(thread: Thread): void | Promise<void>;
  /** Durably prepares extension invalidation before the marker; idempotent by rollbackId. */
  prepareHistoryRollback?(context: ThreadHistoryRollbackContext): void | Promise<void>;
  /** Releases prepared state when no marker exists; Core retries until settled or shutdown. */
  abortHistoryRollback?(context: ThreadHistoryRollbackContext): void | Promise<void>;
  /** Records the durable marker; Core retries until settled or shutdown. */
  commitHistoryRollback?(context: ThreadHistoryRollbackContext): void | Promise<void>;
  contributeTurnAdmission?(context: TurnAdmissionContext): TurnAdmissionContribution | Promise<TurnAdmissionContribution>;
  onTurnStarted?(thread: Thread, turn: Turn): void | Promise<void>;
  onTurnStopped?(thread: Thread, turn: Turn): void | Promise<void>;
  onTurnAborted?(thread: Thread, turn: Turn): void | Promise<void>;
  onTurnError?(thread: Thread, turn: Turn, error: Error): void | Promise<void>;
  contributeThreadContext?(thread: Thread): ThreadContextContribution | Promise<ThreadContextContribution | null> | null;
  contributeTools?(thread: Thread): ExtensionToolContribution | Promise<ExtensionToolContribution | null> | null;
  onToolStarted?(context: ToolLifecycleContext): void | Promise<void>;
  onToolCompleted?(context: ToolLifecycleResult): void | Promise<void>;
  contributeTurnItems?(thread: Thread, turn: Turn): readonly OrderedTurnItemContribution[] | Promise<readonly OrderedTurnItemContribution[]>;
  onNotification?(notification: AgentCoreNotification): void | Promise<void>;
}

export interface ThreadServiceExtensionHost {
  tryStartTurnIfIdle(request: PrivilegedTurnStartRequest): Promise<Turn | null>;
  withThreadAdmissionBarrier<T>(
    threadId: ThreadId,
    operation: (snapshot: ThreadAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T>;
  /** Linearizes root admission but does not interrupt already active Turns. */
  withHostRootTurnAdmissionBarrier<T>(
    operation: (snapshot: HostRootTurnAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T>;
}

export type ExtensionStateScope =
  | { readonly kind: 'hostSession' }
  | { readonly kind: 'thread'; readonly threadId: ThreadId }
  | { readonly kind: 'turn'; readonly threadId: ThreadId; readonly turnId: TurnId };

export interface ExtensionStateStore<T> {
  get(extensionId: string, scope: ExtensionStateScope): T | undefined;
  set(extensionId: string, scope: ExtensionStateScope, value: T): void;
  delete(extensionId: string, scope: ExtensionStateScope): void;
}

function barrierGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Barrier generation must be a non-negative safe integer');
  return value;
}

function projectionVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
  return value;
}
