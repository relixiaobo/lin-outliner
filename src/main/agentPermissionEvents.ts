import type { ToolCall } from '@earendil-works/pi-ai';
import type {
  AgentToolPermissionEventSource,
  AgentToolPermissionResolvedBy,
} from '../core/agentEventLog';
import type {
  AgentPermissionAllowDecision,
  AgentPermissionAskDecision,
  AgentPermissionDenyDecision,
  AgentPermissionSoftBlockDecision,
} from './agentPermissions';
import type { PermissionDeniedReason } from './agentPermissionAskResolver';

export type {
  AgentToolPermissionEventSource,
  AgentToolPermissionResolvedBy,
} from '../core/agentEventLog';

const PERMISSION_DENIED_CONTRACT: Record<PermissionDeniedReason, {
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
  user_denied: {
    recoverable: true,
    resolvedBy: 'user_once',
    source: 'user',
    status: 'denied',
  },
};

export interface AgentToolPermissionLogInput {
  requestId: string;
  toolCall: ToolCall;
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionSoftBlockDecision | AgentPermissionDenyDecision;
  outcome: 'allow' | 'ask' | 'soft_blocked' | 'blocked';
  includeChecked?: boolean;
  source?: AgentToolPermissionEventSource;
  resolved?: {
    status: 'approved' | 'denied' | 'aborted';
    resolvedBy: AgentToolPermissionResolvedBy;
    updatedRule?: string;
    deniedReason?: PermissionDeniedReason;
  };
}

export function permissionActionKinds(
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionSoftBlockDecision | AgentPermissionDenyDecision,
): string[] {
  const descriptors = decision.descriptors ?? (decision.descriptor ? [decision.descriptor] : []);
  return [...new Set(descriptors.map((descriptor) => descriptor.actionKind))];
}

export function permissionPrimaryActionKind(
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionSoftBlockDecision | AgentPermissionDenyDecision,
): string | undefined {
  return decision.descriptor?.actionKind ?? permissionActionKinds(decision)[0];
}

export function permissionDeniedReasonForDecision(decision: AgentPermissionDenyDecision): PermissionDeniedReason {
  if (decision.code === 'configured_deny') return 'configured_deny';
  if (decision.redline || decision.descriptor?.platformHardBlock) return 'platform_hard_block';
  if (decision.code === 'tool_denied' || decision.code === 'tool_not_preapproved') return 'policy_denied';
  return 'runtime';
}

export function permissionEventSourceForDecision(
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionSoftBlockDecision | AgentPermissionDenyDecision,
): AgentToolPermissionEventSource {
  if (decision.behavior === 'deny') {
    return permissionEventSourceForDeniedReason(permissionDeniedReasonForDecision(decision));
  }
  if (decision.permissionSource === 'trust_ledger') {
    return 'trust_ledger';
  }
  return 'default';
}

export function permissionResolvedByForAllowDecision(decision: AgentPermissionAllowDecision): AgentToolPermissionResolvedBy {
  const source = permissionEventSourceForDecision(decision);
  if (source === 'trust_ledger') return source;
  return 'default';
}

export function permissionResolvedByForDeniedReason(reason: PermissionDeniedReason): AgentToolPermissionResolvedBy {
  return PERMISSION_DENIED_CONTRACT[reason].resolvedBy;
}

export function permissionEventSourceForDeniedReason(reason: PermissionDeniedReason): AgentToolPermissionEventSource {
  return PERMISSION_DENIED_CONTRACT[reason].source;
}

export function permissionResolutionStatusForDeniedReason(reason: PermissionDeniedReason): 'denied' | 'aborted' {
  return PERMISSION_DENIED_CONTRACT[reason].status;
}

export function permissionRecoverableForDeniedReason(reason: PermissionDeniedReason): boolean {
  return PERMISSION_DENIED_CONTRACT[reason].recoverable;
}

export function permissionDeniedToolResultMessage(input: {
  toolName: string;
  reason: PermissionDeniedReason;
  message: string;
}): string {
  return JSON.stringify({
    ok: false,
    tool: input.toolName,
    status: 'denied',
    error: {
      code: 'permission_denied',
      message: input.message,
      recoverable: permissionRecoverableForDeniedReason(input.reason),
      details: {
        reason: input.reason,
      },
    },
    instructions: 'Treat this as a normal denied tool result. Continue with a safe fallback or explain the blocker.',
  }, null, 2);
}
