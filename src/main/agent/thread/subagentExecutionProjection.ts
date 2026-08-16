import type {
  SubagentExecutionProjection,
  SubagentNotificationState,
  SubagentTerminalStatus,
} from '../../../core/agent/protocol';
import type { SubagentExecutionRecord } from '../persistence/SubagentExecutionLedger';

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
  terminal: {
    readonly status: SubagentTerminalStatus;
    readonly state: SubagentNotificationState;
  } | null,
): SubagentExecutionProjection {
  return {
    agentId: record.agentId,
    parentThreadId: record.parentThreadId,
    description: record.description,
    agentType: record.agentType,
    runMode: record.runMode,
    generation: record.generation,
    currentTurnId: record.currentTurnId,
    stopProvenance: record.stopProvenance,
    terminalStatus: terminal?.status ?? null,
    notificationState: terminal?.state ?? 'none',
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
