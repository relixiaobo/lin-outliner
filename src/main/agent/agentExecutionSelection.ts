import type { AgentExecutionSelection } from '../../core/agent/configuration';
import type { ThreadConfigurationSummary } from '../../core/agent/protocol';
import type { AgentProviderRuntimeConfig } from './capabilities/agentSettings';

export interface AgentExecutionSelectionFallback {
  readonly requestedModelProvider: string | null;
  readonly requestedModel: string | null;
  readonly requestedReasoningEffort: ThreadConfigurationSummary['reasoningEffort'] | null;
  readonly reason: 'unavailable';
}

export interface ResolvedAgentExecutionSelection extends ThreadConfigurationSummary {
  readonly fallback: AgentExecutionSelectionFallback | null;
}

export interface AgentExecutionSelectionResolverInput {
  readonly selection: AgentExecutionSelection | null;
  readonly parent: ThreadConfigurationSummary;
  readonly getProviderRuntimeConfig: (
    providerId: string,
    modelId?: string,
  ) => Promise<AgentProviderRuntimeConfig | null>;
  readonly validateSelection: (
    selection: ThreadConfigurationSummary,
    provider: AgentProviderRuntimeConfig,
  ) => void;
}

/** Resolve one fresh collaboration Agent without mutating its standing setting. */
export async function resolveAgentExecutionSelection(
  input: AgentExecutionSelectionResolverInput,
): Promise<ResolvedAgentExecutionSelection> {
  const { selection, parent } = input;
  if (!selection) {
    await validateRuntimeSelection(parent, input);
    return { ...parent, fallback: null };
  }

  const requested: ThreadConfigurationSummary = {
    modelProvider: selection.modelProvider ?? parent.modelProvider,
    model: selection.model ?? parent.model,
    reasoningEffort: selection.reasoningEffort ?? parent.reasoningEffort,
  };
  try {
    const explicitModelId = selection.model === undefined
      ? undefined
      : selection.model.slice(`${requested.modelProvider}/`.length);
    const provider = await input.getProviderRuntimeConfig(
      requested.modelProvider,
      explicitModelId,
    );
    if (!provider) throw new Error(`Provider or model is unavailable: ${requested.modelProvider}`);
    input.validateSelection(requested, provider);
    return { ...requested, fallback: null };
  } catch {
    await validateRuntimeSelection(parent, input);
    return {
      ...parent,
      fallback: {
        requestedModelProvider: selection.modelProvider ?? null,
        requestedModel: selection.model ?? null,
        requestedReasoningEffort: selection.reasoningEffort ?? null,
        reason: 'unavailable',
      },
    };
  }
}

async function validateRuntimeSelection(
  selection: ThreadConfigurationSummary,
  input: Pick<AgentExecutionSelectionResolverInput, 'getProviderRuntimeConfig' | 'validateSelection'>,
): Promise<void> {
  const provider = await input.getProviderRuntimeConfig(selection.modelProvider);
  if (!provider) throw new Error(`Parent provider is unavailable: ${selection.modelProvider}`);
  input.validateSelection(selection, provider);
}
