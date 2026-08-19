import type {
  AgentCoreRequestByMethod,
  ThreadConfigurationSummary,
} from '../../core/agent/protocol';
import type { AgentProviderRuntimeConfig } from './capabilities/agentSettings';
import type { RendererThreadStartDefaults } from './ThreadService';

export interface RendererThreadStartDefaultsInput {
  readonly request: AgentCoreRequestByMethod['thread/start'];
  readonly remembered: ThreadConfigurationSummary | null;
  readonly cwd: string;
  readonly getProviderRuntimeConfig: (
    providerId: string,
  ) => Promise<AgentProviderRuntimeConfig | null>;
  readonly getActiveProviderRuntimeConfig: () => Promise<AgentProviderRuntimeConfig | null>;
  readonly validateRememberedSelection: (
    selection: ThreadConfigurationSummary,
    provider: AgentProviderRuntimeConfig,
  ) => void;
}

export async function resolveRendererThreadStartDefaults(
  input: RendererThreadStartDefaultsInput,
): Promise<RendererThreadStartDefaults> {
  if (input.request.modelProvider !== undefined) {
    return { modelProvider: input.request.modelProvider, cwd: input.cwd };
  }

  if (input.request.configurationProfile === undefined && input.remembered) {
    try {
      const provider = await input.getProviderRuntimeConfig(input.remembered.modelProvider);
      if (provider) {
        input.validateRememberedSelection(input.remembered, provider);
        return { cwd: input.cwd, executionSelection: input.remembered };
      }
    } catch {
      // A stale or temporarily unreadable remembered provider must not block a
      // new Thread. The active provider path below remains authoritative.
    }
  }

  const provider = await input.getActiveProviderRuntimeConfig();
  if (!provider) throw new Error('Configure an AI provider before starting a Thread.');
  return { modelProvider: provider.providerId, cwd: input.cwd };
}
