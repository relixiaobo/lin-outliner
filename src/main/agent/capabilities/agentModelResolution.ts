import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { parseProviderQualifiedModel } from '../../../core/agentModelId';
import { defaultThinkingLevelFor } from '../../../core/agentReasoning';
import { isLocalGatewayProviderId } from '../../../core/localGatewayProviders';
import { AGENT_REASONING_LADDER, type AgentReasoningLevel } from '../../../core/types';
import { rankedModels, type AgentProviderRuntimeConfig } from './agentSettings';
import {
  createOpenAICompatibleModel,
  ensurePiCustomProvider,
  piFindModel,
  piProviders,
} from '../../piModels';

const AGENT_REASONING_LEVELS = new Set<AgentReasoningLevel>(AGENT_REASONING_LADDER);

let knownProviderIdsCache: Set<string> | null = null;

/** Resolve a model override against a provider connection and its optional custom endpoint. */
export function resolveAgentModelOverride(
  requested: string,
  providerConfig: AgentProviderRuntimeConfig,
): Model<Api> | null {
  const parsed = parseProviderQualifiedModel(requested, isKnownProviderId);
  const providerId = parsed?.providerId ?? providerConfig.providerId;
  const modelId = parsed?.modelId ?? requested;
  const knownModel = findKnownModel(providerId, modelId);
  if (providerId === providerConfig.providerId && providerConfig.baseUrl) {
    return createCustomEndpointModel(providerConfig, modelId, knownModel);
  }
  return knownModel;
}

/** The concrete default model for a provider connection. */
export function resolveProviderModel(config: AgentProviderRuntimeConfig): Model<Api> {
  const model = resolveProviderCatalogModel(config);
  if (model) return model;
  if (config.baseUrl) {
    throw new Error(`No catalog model for custom provider ${config.providerId}; set a model on the Thread Configuration Profile.`);
  }
  throw new Error(`model not found for provider ${config.providerId}`);
}

/** Resolve a Thread Configuration Profile's model selection over a provider connection. */
export function resolveAgentModel(
  modelInput: string | undefined,
  config: AgentProviderRuntimeConfig,
  fallback: () => Model<Api> | null,
): Model<Api> {
  const requested = modelInput?.trim();
  if (!requested || requested === 'inherit') {
    const resolved = fallback();
    if (resolved) return resolved;
    throw new Error('No model is configured for this Thread. Set a model in its Configuration Profile.');
  }
  const resolved = resolveAgentModelOverride(requested, config);
  if (resolved) return resolved;
  const fell = fallback();
  if (fell) return fell;
  throw new Error(`Model not found for provider ${config.providerId}: ${requested}`);
}

/** Resolve the effective model and thinking level for a Thread Configuration Profile. */
export function resolveAgentModelEffort(
  modelInput: string | undefined,
  effortInput: string | undefined,
  config: AgentProviderRuntimeConfig,
  fallback: () => Model<Api> | null,
): { model: Model<Api>; thinkingLevel: AgentReasoningLevel } {
  const model = resolveAgentModel(modelInput, config, fallback);
  const thinkingLevel = effortInput
    ? resolveSkillEffortOverride(effortInput, model, defaultThinkingLevel(model))
    : defaultThinkingLevel(model);
  return { model, thinkingLevel };
}

export function validateAgentModelSelection(
  modelInput: string,
  effort: AgentReasoningLevel,
  config: AgentProviderRuntimeConfig,
): void {
  const requested = modelInput.trim();
  const model = requested === 'inherit'
    ? resolveProviderModel(config)
    : resolveAgentModelOverride(requested, config);
  if (!model) throw new Error(`Model not found for provider ${config.providerId}: ${requested}`);
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(effort)) {
    throw new Error(`Reasoning effort ${effort} is not supported by ${config.providerId}/${model.id}`);
  }
}

export function defaultThinkingLevel(model: Model<Api>): AgentReasoningLevel {
  return defaultThinkingLevelFor(getSupportedThinkingLevels(model));
}

export function lowestThinkingLevel(model: Model<Api>): AgentReasoningLevel {
  return getSupportedThinkingLevels(model)[0] ?? 'off';
}

export function resolveSkillEffortOverride(
  effortInput: string,
  model: Model<Api>,
  currentThinkingLevel: AgentReasoningLevel,
): AgentReasoningLevel {
  const requested = effortInput.trim().toLowerCase();
  if (!AGENT_REASONING_LEVELS.has(requested as AgentReasoningLevel)) return currentThinkingLevel;
  const level = requested as AgentReasoningLevel;
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(level)) return level;
  if (supported.includes('off')) return 'off';
  return supported[0] ?? currentThinkingLevel;
}

function resolveProviderCatalogModel(config: AgentProviderRuntimeConfig): Model<Api> | null {
  if (config.modelId) {
    const configured = findKnownModel(config.providerId, config.modelId);
    if (configured) return configured;
  }
  const first = rankedModels(config.providerId)[0];
  if (config.baseUrl) {
    const modelId = config.modelId ?? first?.id ?? '__tenon_openai_compatible_probe__';
    return createCustomEndpointModel(config, modelId, first);
  }
  return first ?? null;
}

function createCustomEndpointModel(
  config: AgentProviderRuntimeConfig,
  modelId: string,
  catalogModel?: Model<Api> | null,
): Model<Api> {
  ensurePiCustomProvider({ ...config, modelId, catalogModel });
  return createOpenAICompatibleModel({ ...config, modelId, catalogModel });
}

function isKnownProviderId(providerId: string): boolean {
  if (isLocalGatewayProviderId(providerId)) return true;
  if (!knownProviderIdsCache) knownProviderIdsCache = new Set(piProviders());
  return knownProviderIdsCache.has(providerId);
}

function findKnownModel(providerId: string, modelId: string): Model<Api> | null {
  try {
    return piFindModel(providerId, modelId);
  } catch {
    return null;
  }
}
