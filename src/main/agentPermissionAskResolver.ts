import type { AgentPermissionDeniedReason } from '../core/agentEventLog';
import type { AgentPermissionAskDecision } from './agentPermissions';

export type PermissionDeniedReason = AgentPermissionDeniedReason;

export type AgentPermissionAskResolverOutcome =
  | { outcome: 'block'; reason: PermissionDeniedReason; message: string }
  | { outcome: 'needs_user' };

export async function resolveAgentPermissionAsk(
  input: {
    decision: AgentPermissionAskDecision;
    interactionAvailable: boolean;
    signal?: AbortSignal;
  },
): Promise<AgentPermissionAskResolverOutcome> {
  const { decision } = input;
  if (input.signal?.aborted) {
    return { outcome: 'block', reason: 'run_aborted', message: 'Permission request was cancelled before approval.' };
  }

  void decision;
  return { outcome: 'needs_user' };
}
