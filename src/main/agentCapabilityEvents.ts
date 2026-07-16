import type { ToolCall } from '@earendil-works/pi-ai';
import type {
  AgentCapabilityResolutionReason,
  AgentToolCapabilityEventSource,
  AgentToolCapabilityResolvedBy,
} from '../core/agentEventLog';
import type {
  AgentCapabilityAllowDecision,
  AgentCapabilityDecision,
  AgentCapabilityUnavailableDecision,
} from './agentCapabilities';

export type {
  AgentCapabilityResolutionReason,
  AgentToolCapabilityEventSource,
  AgentToolCapabilityResolvedBy,
} from '../core/agentEventLog';

const RESOLUTION_CONTRACT: Record<AgentCapabilityResolutionReason, {
  recoverable: boolean;
  resolvedBy: AgentToolCapabilityResolvedBy;
  source: AgentToolCapabilityEventSource;
  status: 'unavailable' | 'cancelled';
}> = {
  user_blocked: {
    recoverable: false,
    resolvedBy: 'user_blocklist',
    source: 'user_blocklist',
    status: 'unavailable',
  },
  control_plane: {
    recoverable: false,
    resolvedBy: 'control_plane',
    source: 'control_plane',
    status: 'unavailable',
  },
  run_aborted: {
    recoverable: true,
    resolvedBy: 'system_abort',
    source: 'runtime',
    status: 'cancelled',
  },
  runtime: {
    recoverable: false,
    resolvedBy: 'runtime',
    source: 'runtime',
    status: 'unavailable',
  },
  user_cancelled: {
    recoverable: true,
    resolvedBy: 'user_cancelled',
    source: 'user',
    status: 'cancelled',
  },
};

export interface AgentToolCapabilityLogInput {
  runId?: string;
  requestedByAgentId?: string;
  requestId: string;
  toolCall: ToolCall;
  decision: AgentCapabilityDecision;
  outcome: 'allow' | 'capability_required' | 'unavailable';
  unattended?: boolean;
  includeChecked?: boolean;
  source?: AgentToolCapabilityEventSource;
  resolved?: {
    status: 'available' | 'unavailable' | 'cancelled';
    resolvedBy: AgentToolCapabilityResolvedBy;
    updatedFolders?: string[];
    reason?: AgentCapabilityResolutionReason;
  };
}

export function capabilityActionKinds(decision: AgentCapabilityDecision): string[] {
  return [...new Set(decision.descriptors.map((descriptor) => descriptor.actionKind))];
}

export function capabilityPrimaryActionKind(decision: AgentCapabilityDecision): string | undefined {
  return decision.descriptor?.actionKind ?? capabilityActionKinds(decision)[0];
}

export function capabilityResolutionReasonForDecision(
  decision: AgentCapabilityUnavailableDecision,
): AgentCapabilityResolutionReason {
  if (decision.source === 'user_blocklist') return 'user_blocked';
  if (decision.source === 'control_plane') return 'control_plane';
  return 'runtime';
}

export function capabilityEventSourceForDecision(
  decision: AgentCapabilityDecision,
): AgentToolCapabilityEventSource {
  if (decision.behavior === 'unavailable') {
    return capabilityEventSourceForReason(capabilityResolutionReasonForDecision(decision));
  }
  return decision.source === 'folder_capability' ? 'folder_capability' : 'default';
}

export function capabilityResolvedByForAllowDecision(
  decision: AgentCapabilityAllowDecision,
): AgentToolCapabilityResolvedBy {
  return decision.source === 'folder_capability' ? 'folder_capability' : 'default';
}

export function capabilityResolvedByForReason(
  reason: AgentCapabilityResolutionReason,
): AgentToolCapabilityResolvedBy {
  return RESOLUTION_CONTRACT[reason].resolvedBy;
}

export function capabilityEventSourceForReason(
  reason: AgentCapabilityResolutionReason,
): AgentToolCapabilityEventSource {
  return RESOLUTION_CONTRACT[reason].source;
}

export function capabilityStatusForReason(
  reason: AgentCapabilityResolutionReason,
): 'unavailable' | 'cancelled' {
  return RESOLUTION_CONTRACT[reason].status;
}

export function capabilityRecoverableForReason(reason: AgentCapabilityResolutionReason): boolean {
  return RESOLUTION_CONTRACT[reason].recoverable;
}

export function unavailableToolResultMessage(input: {
  toolName: string;
  reason: AgentCapabilityResolutionReason;
  message: string;
}): string {
  const status = capabilityStatusForReason(input.reason);
  return JSON.stringify({
    ok: false,
    tool: input.toolName,
    status,
    error: {
      code: status === 'cancelled' ? 'capability_cancelled' : 'operation_unavailable',
      message: input.message,
      recoverable: capabilityRecoverableForReason(input.reason),
      details: { reason: input.reason },
    },
    instructions: status === 'cancelled'
      ? 'The capability request was cancelled. Continue with another available approach.'
      : 'This operation is unavailable in the current context. Continue with another available approach.',
  }, null, 2);
}

export function folderCapabilityRequiredToolResultMessage(input: {
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
      details: { kind: 'folder', folders: input.folders, unattended: input.unattended === true },
    },
    instructions: input.unattended
      ? 'The Run stopped before execution and recorded a durable folder request. Continue other independent work.'
      : 'Wait for the folder capability resolution. Do not retry until the folder is granted.',
  }, null, 2);
}
