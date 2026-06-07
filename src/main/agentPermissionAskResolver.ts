import type { AgentPermissionDeniedReason } from '../core/agentEventLog';
import type { AgentPermissionAskDecision, AgentPermissionClassifierProjection } from './agentPermissions';
import { isSafeAutoAllowToolName, type ToolPermissionClassifierResult } from './agentToolPermissionRules';

export type PermissionDeniedReason = AgentPermissionDeniedReason;

export type AgentPermissionAskResolverOutcome =
  | { outcome: 'allow'; source: 'safe_allowlist' | 'classifier' }
  | { outcome: 'block'; reason: PermissionDeniedReason; message: string }
  | { outcome: 'needs_user' };

export interface AgentPermissionClassifierInput {
  decision: AgentPermissionAskDecision;
  projection: AgentPermissionClassifierProjection;
  contextRecords?: readonly unknown[];
}

export type AgentPermissionClassifier = (
  input: AgentPermissionClassifierInput,
  signal?: AbortSignal,
) => Promise<ToolPermissionClassifierResult> | ToolPermissionClassifierResult;

export async function resolveAgentPermissionAsk(
  input: {
    decision: AgentPermissionAskDecision;
    classifier?: AgentPermissionClassifier;
    classifierProjection?: AgentPermissionClassifierProjection | null;
    classifierContextRecords?: readonly unknown[];
    interactionAvailable: boolean;
    signal?: AbortSignal;
  },
): Promise<AgentPermissionAskResolverOutcome> {
  const { decision } = input;
  if (input.signal?.aborted) {
    return { outcome: 'block', reason: 'run_aborted', message: 'Permission request was cancelled before approval.' };
  }

  const descriptor = decision.descriptor;
  if (!descriptor) return { outcome: 'needs_user' };
  if (decision.permissionSource === 'configured_ask') return { outcome: 'needs_user' };

  if (isSafeAutoAllowDescriptor(decision)) {
    return { outcome: 'allow', source: 'safe_allowlist' };
  }

  if (!descriptor.classifierAutoAllowEligible) return { outcome: 'needs_user' };
  if (descriptor.externalEffect || descriptor.highConsequence || descriptor.accessScope === 'sensitive_local_path' || descriptor.actionKind.includes('unknown')) {
    return { outcome: 'needs_user' };
  }

  const projection = input.classifierProjection;
  if (!projection) return { outcome: 'needs_user' };
  if (!input.classifier) {
    return classifierUnavailable(input.interactionAvailable);
  }

  try {
    const result = await input.classifier({
      decision,
      projection,
      contextRecords: input.classifierContextRecords,
    }, input.signal);
    if (result.unavailable) return classifierUnavailable(input.interactionAvailable, result.reason);
    if (result.outcome === 'allow') return { outcome: 'allow', source: 'classifier' };
    return {
      outcome: 'block',
      reason: 'classifier_blocked',
      message: result.reason || 'The permission classifier blocked this action.',
    };
  } catch (error) {
    return classifierUnavailable(input.interactionAvailable, error instanceof Error ? error.message : String(error));
  }
}

function isSafeAutoAllowDescriptor(decision: AgentPermissionAskDecision): boolean {
  const descriptor = decision.descriptor;
  return Boolean(
    descriptor
    && isSafeAutoAllowToolName(descriptor.toolName)
    && !descriptor.externalEffect
    && !descriptor.highConsequence
    && (descriptor.accessScope === 'allowed_file_area' || descriptor.accessScope === 'none'),
  );
}

function classifierUnavailable(interactionAvailable: boolean, detail = 'Permission classifier is unavailable.'): AgentPermissionAskResolverOutcome {
  if (interactionAvailable) return { outcome: 'needs_user' };
  return {
    outcome: 'block',
    reason: 'classifier_unavailable',
    message: detail,
  };
}
