import type { ToolCall } from '@earendil-works/pi-ai';
import type {
  AgentPermissionDeniedReason,
  AgentToolPermissionEventSource,
  AgentToolPermissionResolvedBy,
} from '../core/agentEventLog';
import type {
  AgentPermissionAllowDecision,
  AgentPermissionBlockedDecision,
  AgentPermissionDecision,
} from './agentPermissions';

export type {
  AgentPermissionDeniedReason,
  AgentToolPermissionEventSource,
  AgentToolPermissionResolvedBy,
} from '../core/agentEventLog';

const PERMISSION_DENIED_CONTRACT: Record<AgentPermissionDeniedReason, {
  recoverable: boolean;
  resolvedBy: AgentToolPermissionResolvedBy;
  source: AgentToolPermissionEventSource;
  status: 'denied' | 'aborted';
}> = {
  configured_deny: {
    recoverable: false,
    resolvedBy: 'configured_deny',
    source: 'configured_deny',
    status: 'denied',
  },
  policy_denied: {
    recoverable: false,
    resolvedBy: 'policy_denied',
    source: 'policy_denied',
    status: 'denied',
  },
  platform_hard_block: {
    recoverable: false,
    resolvedBy: 'platform_hard_block',
    source: 'platform_hard_block',
    status: 'denied',
  },
  run_aborted: {
    recoverable: true,
    resolvedBy: 'system_abort',
    source: 'runtime',
    status: 'aborted',
  },
  runtime: {
    recoverable: true,
    resolvedBy: 'runtime',
    source: 'runtime',
    status: 'denied',
  },
  user_cancelled: {
    recoverable: true,
    resolvedBy: 'user_cancelled',
    source: 'user',
    status: 'aborted',
  },
};

export interface AgentToolPermissionLogInput {
  runId?: string;
  requestedByAgentId?: string;
  requestId: string;
  toolCall: ToolCall;
  decision: AgentPermissionDecision;
  outcome: 'allow' | 'folder_required' | 'blocked';
  unattended?: boolean;
  includeChecked?: boolean;
  source?: AgentToolPermissionEventSource;
  resolved?: {
    status: 'approved' | 'denied' | 'aborted';
    resolvedBy: AgentToolPermissionResolvedBy;
    updatedFolders?: string[];
    deniedReason?: AgentPermissionDeniedReason;
  };
}

export function permissionActionKinds(decision: AgentPermissionDecision): string[] {
  return [...new Set(decision.descriptors.map((descriptor) => descriptor.actionKind))];
}

export function permissionPrimaryActionKind(decision: AgentPermissionDecision): string | undefined {
  return decision.descriptor?.actionKind ?? permissionActionKinds(decision)[0];
}

export function permissionDeniedReasonForDecision(decision: AgentPermissionBlockedDecision): AgentPermissionDeniedReason {
  if (decision.code === 'configured_deny') return 'configured_deny';
  if (decision.redline || decision.descriptor?.platformHardBlock) return 'platform_hard_block';
  if (decision.code === 'tool_denied') return 'policy_denied';
  return 'runtime';
}

export function permissionEventSourceForDecision(decision: AgentPermissionDecision): AgentToolPermissionEventSource {
  if (decision.behavior === 'blocked') {
    if (decision.permissionSource === 'user_blocklist') return 'user_blocklist';
    return permissionEventSourceForDeniedReason(permissionDeniedReasonForDecision(decision));
  }
  return decision.permissionSource === 'folder_capability' ? 'folder_capability' : 'default';
}

export function permissionResolvedByForAllowDecision(decision: AgentPermissionAllowDecision): AgentToolPermissionResolvedBy {
  return decision.permissionSource === 'folder_capability' ? 'folder_capability' : 'default';
}

export function permissionResolvedByForDeniedReason(reason: AgentPermissionDeniedReason): AgentToolPermissionResolvedBy {
  return PERMISSION_DENIED_CONTRACT[reason].resolvedBy;
}

export function permissionEventSourceForDeniedReason(reason: AgentPermissionDeniedReason): AgentToolPermissionEventSource {
  return PERMISSION_DENIED_CONTRACT[reason].source;
}

export function permissionResolutionStatusForDeniedReason(reason: AgentPermissionDeniedReason): 'denied' | 'aborted' {
  return PERMISSION_DENIED_CONTRACT[reason].status;
}

export function permissionRecoverableForDeniedReason(reason: AgentPermissionDeniedReason): boolean {
  return PERMISSION_DENIED_CONTRACT[reason].recoverable;
}

export function permissionDeniedToolResultMessage(input: {
  toolName: string;
  reason: AgentPermissionDeniedReason;
  message: string;
}): string {
  return JSON.stringify({
    ok: false,
    tool: input.toolName,
    status: input.reason === 'user_cancelled' || input.reason === 'run_aborted' ? 'aborted' : 'denied',
    error: {
      code: 'permission_denied',
      message: input.message,
      recoverable: permissionRecoverableForDeniedReason(input.reason),
      details: { reason: input.reason },
    },
    instructions: 'Treat this as a non-overridable denial or cancellation. Continue with another available approach.',
  }, null, 2);
}

export function folderAccessRequiredToolResultMessage(input: {
  toolName: string;
  folders: readonly string[];
  unattended?: boolean;
}): string {
  return JSON.stringify({
    ok: false,
    tool: input.toolName,
    status: 'needs_input',
    error: {
      code: 'folder_access_required',
      message: `Folder access is required: ${input.folders.join(', ')}`,
      recoverable: true,
      details: { folders: input.folders, unattended: input.unattended === true },
    },
    instructions: input.unattended
      ? 'The Run stopped before execution and recorded a durable folder request. Continue other independent work.'
      : 'Wait for the folder capability decision. Do not retry the command until the folder is granted.',
  }, null, 2);
}
