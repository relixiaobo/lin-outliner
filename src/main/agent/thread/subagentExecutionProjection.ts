import type {
  SubagentExecutionProjection,
  SubagentGenerationReceipt,
  Turn,
} from '../../../core/agent/protocol';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';
import type { SubagentExecutionRecord } from '../persistence/SubagentExecutionLedger';
import type { SubagentPendingNotification } from '../persistence/SubagentExecutionLedger';

/**
 * The renderer-facing half of an Agent execution record.
 *
 * Presentation needs identity, lifecycle, and placement; it never needs the
 * tool policy, the startup snapshot, or the worktree recovery intent, which
 * describe how the host executes an Agent rather than what the user is looking
 * at. Keeping the projection narrow is a boundary decision, not an
 * optimization: a field that never crosses cannot be rendered by accident.
 */
export function projectSubagentExecution(
  record: SubagentExecutionRecord,
  terminal: Pick<
    SubagentPendingNotification,
    | 'status'
    | 'state'
    | 'error'
    | 'deliveryTurnId'
    | 'deliveryClass'
    | 'eligibleAfterGeneration'
    | 'coverageDisposition'
    | 'omittedBytes'
    | 'omittedTokens'
  > | null,
  generationReceipts: readonly SubagentGenerationReceipt[] = [],
): SubagentExecutionProjection {
  const notificationState = terminal === null
    ? 'none'
    : presentationNotificationState(terminal.state, terminal.deliveryTurnId);
  return {
    agentId: record.agentId,
    parentThreadId: record.parentThreadId,
    description: record.description,
    agentType: record.agentType,
    runMode: record.runMode,
    generation: record.generation,
    currentTurnId: record.currentTurnId,
    parentItemId: record.toolUseId,
    stopProvenance: record.stopProvenance,
    terminalStatus: terminal?.status ?? null,
    notificationState,
    terminalError: terminal?.error ?? null,
    deliveryTurnId: terminal?.deliveryTurnId ?? null,
    deliveryClass: terminal?.deliveryClass ?? null,
    eligibleAfterGeneration: terminal?.eligibleAfterGeneration ?? null,
    coverageDisposition: terminal?.coverageDisposition ?? null,
    omittedOutputBytes: terminal?.omittedBytes ?? 0,
    omittedOutputTokens: terminal?.omittedTokens ?? 0,
    generationReceipts,
    notificationCutoff: record.notificationCutoff,
    executionMode: record.executionMode,
    settlementCoverage: record.settlementCoverage,
    executionSelectionFallback: record.executionSelectionFallback,
    // A removed worktree is a tombstone, not a retained one: the branch it
    // names no longer exists, so a footer offering to reveal it would point
    // the user at a directory the host has already deleted.
    worktree: record.worktree && record.worktree.removedAt === null
      ? { branch: record.worktree.branch, path: record.worktree.path }
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function projectSubagentGenerationReceipt(
  notification: SubagentPendingNotification,
  turn: Turn | null,
  deliveryTurnId: string | null,
): SubagentGenerationReceipt {
  return {
    generation: notification.generation,
    turnId: notification.turnId,
    parentItemId: notification.toolUseId,
    terminalStatus: notification.status,
    stopProvenance: notification.stopProvenance,
    durationMs: turn?.durationMs ?? null,
    error: notification.error,
    partialOutputAvailable: turn !== null && turnTerminalAnswer(turn.items).trim().length > 0,
    parentThreadId: notification.parentThreadId,
    notificationState: presentationNotificationState(notification.state, notification.deliveryTurnId),
    deliveryTurnId,
  };
}

function presentationNotificationState(
  state: SubagentPendingNotification['state'],
  deliveryTurnId: string | null,
): SubagentGenerationReceipt['notificationState'] {
  // The ledger marks foreground settlement delivered so it is terminal and
  // never enters the queue. Presentation must not turn that storage state into
  // a claim that a parent notification existed.
  return state === 'delivered' && deliveryTurnId === null ? 'none' : state;
}
