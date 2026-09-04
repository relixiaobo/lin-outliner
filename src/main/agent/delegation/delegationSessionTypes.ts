import type { ReasoningEffort } from '../../../core/agent/configuration';
import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import type { DelegateAccess, DelegateTaskProfile } from '../../../delegate/contract';

export type DelegationSessionState = 'open' | 'closed';
export type DelegationMessageState = 'queued' | 'committed' | 'blocked';
export type DelegationSettlementState =
  | 'awaiting_result'
  | 'prepared'
  | 'context_committed'
  | 'committed'
  | 'blocked';

export interface DelegationPolicySnapshot {
  readonly runnerId: string;
  readonly runnerVersion: string | null;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly effort: ReasoningEffort | null;
  readonly profile: DelegateTaskProfile;
  readonly access: DelegateAccess;
  readonly capabilityCeilingDigest: string;
  readonly schedulingPolicyDigest: string;
  readonly configurationRevision: string;
  readonly cwd: string;
  readonly worktreePolicy: 'none' | 'dedicated';
}

export type DelegationWorktreeDisposition =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'active' | 'unchanged' | 'changed' | 'retained' | 'ambiguous';
    readonly path: string;
    readonly baseRevision: string;
  }
  | { readonly kind: 'cleaned'; readonly baseRevision: string };

export interface DelegationStopFence {
  readonly cancelledTaskId: string;
  readonly stoppedByRootTurnId: TurnId;
  readonly stoppedAtRootIntentRevision: number;
  readonly minimumResumeRevision: number;
  readonly stoppedAt: number;
}

export interface DelegationResumeRecord {
  readonly rootTurnId: TurnId;
  readonly rootIntentRevision: number;
  readonly resumedAt: number;
}

export interface DelegationSessionBinding {
  readonly sessionId: ThreadId;
  readonly ownerThreadId: ThreadId;
  readonly state: DelegationSessionState;
  readonly revision: number;
  readonly policy: DelegationPolicySnapshot;
  readonly adapterSessionId: string | null;
  readonly currentTaskId: string | null;
  readonly previousTaskId: string | null;
  readonly messageSequence: number;
  readonly stopFence: DelegationStopFence | null;
  readonly lastResume: DelegationResumeRecord | null;
  readonly worktree: DelegationWorktreeDisposition;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface DelegationRootMessage {
  readonly messageId: string;
  readonly sessionId: ThreadId;
  readonly sequence: number;
  readonly digest: string;
  readonly prefixDigest: string;
  readonly text: string | null;
  readonly state: DelegationMessageState;
  readonly sourceTaskId: string;
  readonly sourceRootTurnId: TurnId;
  readonly sourceRootItemId: string;
  readonly sourceRootIntentRevision: number | null;
  readonly deliveryTurnId: TurnId | null;
  readonly blockedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DelegationExecutionSettlement {
  readonly settlementId: string;
  readonly sessionId: ThreadId;
  readonly turnId: TurnId;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly messageSequence: number;
  readonly messageSequenceDigest: string;
  readonly preparedResultDigest: string | null;
  readonly finalReceiptDigest: string | null;
  readonly state: DelegationSettlementState;
  readonly blockedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class DelegationStateError extends Error {
  constructor(
    readonly code: 'not_found' | 'stale_revision' | 'conflict' | 'blocked' | 'closed' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DelegationStateError';
  }
}
