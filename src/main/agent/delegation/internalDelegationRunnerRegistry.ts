import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { parseProviderQualifiedModel } from '../../../core/agentModelId';
import type { AgentReasoningLevel } from '../../../core/types';
import {
  getProviderRuntimeConfig,
} from '../capabilities/agentSettings';
import { resolveAgentModelOverride } from '../capabilities/agentModelResolution';
import {
  DelegationRunnerRegistry,
  internalDelegationRunnerAdapter,
  type DelegationModelSelection,
} from './DelegationPolicyResolver';

export function createInternalDelegationRunnerRegistry(): DelegationRunnerRegistry {
  return new DelegationRunnerRegistry([
    internalDelegationRunnerAdapter(resolveConfiguredInternalModel),
  ]);
}

export async function resolveConfiguredInternalModel(
  modelInput: string,
  effort: AgentReasoningLevel,
): Promise<DelegationModelSelection | null> {
  const parsed = parseProviderQualifiedModel(modelInput, () => false);
  if (!parsed) return null;
  const provider = await getProviderRuntimeConfig(parsed.providerId, parsed.modelId);
  if (!provider) return null;
  const model = resolveAgentModelOverride(modelInput, provider);
  if (!model) return null;
  return {
    providerId: parsed.providerId,
    modelId: model.id,
    effort,
    supportedEfforts: getSupportedThinkingLevels(model),
  };
}
