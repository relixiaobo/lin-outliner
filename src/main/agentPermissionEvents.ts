import type { ToolCall } from '@earendil-works/pi-ai';
import type {
  AgentPermissionAllowDecision,
  AgentPermissionAskDecision,
  AgentPermissionDenyDecision,
} from './agentPermissions';
import type { PermissionDeniedReason } from './agentPermissionAskResolver';

export type AgentToolPermissionEventSource =
  | 'global_rule'
  | 'action_default'
  | 'configured_deny'
  | 'classifier'
  | 'classifier_unavailable'
  | 'safe_allowlist'
  | 'user'
  | 'platform_hard_block'
  | 'runtime';

export type AgentToolPermissionResolvedBy =
  | 'classifier'
  | 'safe_allowlist'
  | 'user_once'
  | 'allow_rule_update'
  | 'global_rule'
  | 'configured_deny'
  | 'classifier_unavailable'
  | 'platform_hard_block'
  | 'runtime'
  | 'system_abort';

export interface AgentToolPermissionLogInput {
  requestId: string;
  toolCall: ToolCall;
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionDenyDecision;
  outcome: 'allow' | 'ask' | 'blocked';
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
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionDenyDecision,
): string[] {
  const descriptors = decision.descriptors ?? (decision.descriptor ? [decision.descriptor] : []);
  return [...new Set(descriptors.map((descriptor) => descriptor.actionKind))];
}

export function permissionPrimaryActionKind(
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionDenyDecision,
): string | undefined {
  return decision.descriptor?.actionKind ?? permissionActionKinds(decision)[0];
}

export function permissionDeniedReasonForDecision(decision: AgentPermissionDenyDecision): PermissionDeniedReason {
  if (decision.code === 'configured_deny') return 'configured_deny';
  if (decision.redline || decision.descriptor?.platformHardBlock) return 'platform_hard_block';
  return 'runtime';
}

export function permissionEventSourceForDecision(
  decision: AgentPermissionAllowDecision | AgentPermissionAskDecision | AgentPermissionDenyDecision,
): AgentToolPermissionEventSource {
  if (decision.behavior === 'deny') {
    if (decision.code === 'configured_deny') return 'configured_deny';
    if (decision.redline || decision.descriptor?.platformHardBlock) return 'platform_hard_block';
    return 'runtime';
  }
  if (decision.permissionSource === 'configured_allow' || decision.permissionSource === 'configured_ask') {
    return 'global_rule';
  }
  return 'action_default';
}

export function permissionResolvedByForAllowDecision(decision: AgentPermissionAllowDecision): AgentToolPermissionResolvedBy {
  return permissionEventSourceForDecision(decision) === 'global_rule' ? 'global_rule' : 'runtime';
}

export function permissionResolvedByForDeniedReason(reason: PermissionDeniedReason): AgentToolPermissionResolvedBy {
  switch (reason) {
    case 'configured_deny':
      return 'configured_deny';
    case 'classifier_blocked':
      return 'classifier';
    case 'classifier_unavailable':
      return 'classifier_unavailable';
    case 'platform_hard_block':
      return 'platform_hard_block';
    case 'run_aborted':
      return 'system_abort';
    case 'user_denied':
      return 'user_once';
    case 'runtime':
    default:
      return 'runtime';
  }
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
      recoverable: isRecoverablePermissionDeniedReason(input.reason),
      details: {
        reason: input.reason,
      },
    },
    instructions: 'Treat this as a normal denied tool result. Continue with a safe fallback or explain the blocker.',
  }, null, 2);
}

function isRecoverablePermissionDeniedReason(reason: PermissionDeniedReason): boolean {
  switch (reason) {
    case 'classifier_blocked':
    case 'classifier_unavailable':
    case 'run_aborted':
    case 'runtime':
    case 'user_denied':
      return true;
    case 'configured_deny':
    case 'platform_hard_block':
      return false;
  }
}
