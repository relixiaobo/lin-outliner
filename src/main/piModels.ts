import {
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Credential,
  type CredentialStore,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128000;
const DEFAULT_CUSTOM_MAX_TOKENS = 8192;

export interface PiCredentialStorage {
  read(providerId: string): Promise<Credential | undefined>;
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}

export interface PiCustomProviderConfig {
  providerId: string;
  baseUrl?: string;
  modelId?: string;
}

let credentialStorage: PiCredentialStorage | null = null;
let modelsInstance: MutableModels | null = null;

export function configurePiCredentialStorage(storage: PiCredentialStorage): void {
  credentialStorage = storage;
  modelsInstance = null;
}

export function piModels(): MutableModels {
  if (!credentialStorage) throw new Error('pi credential storage is not configured');
  modelsInstance ??= builtinModels({ credentials: credentialStoreAdapter });
  return modelsInstance;
}

export function piProviders(): string[] {
  return piModels().getProviders().map((provider) => provider.id);
}

export function piProviderAuthKind(providerId: string): 'api-key' | 'oauth' | 'managed' {
  const auth = piModels().getProvider(providerId)?.auth;
  if (auth?.oauth) return 'oauth';
  if (providerId === 'amazon-bedrock' || providerId === 'google-vertex') return 'managed';
  return 'api-key';
}

export function piModelsForProvider(providerId: string): Model<Api>[] {
  return piModels().getModels(providerId) as Model<Api>[];
}

export function piFindModel(providerId: string, modelId: string): Model<Api> | null {
  return piModels().getModel(providerId, modelId) as Model<Api> | undefined ?? null;
}

export async function piProviderHasAmbientAuth(providerId: string): Promise<boolean> {
  const model = piModelsForProvider(providerId)[0];
  if (!model) return false;
  const credential = await readCredential(providerId);
  if (credential) return false;
  try {
    return Boolean(await piModels().getAuth(model));
  } catch {
    return false;
  }
}

export async function piResolveAuthApiKey(model: Model<Api>): Promise<string | undefined> {
  try {
    const auth = await piModels().getAuth(model);
    return auth ? auth.auth.apiKey ?? '<authenticated>' : undefined;
  } catch {
    return undefined;
  }
}

export function piStreamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  ensureProviderForModel(model);
  return piModels().streamSimple(model, context, options);
}

export async function piCompleteSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
  ensureProviderForModel(model);
  return piModels().completeSimple(model, context, options);
}

export function ensurePiCustomProvider(config: PiCustomProviderConfig): void {
  if (!config.baseUrl) return;
  if (piModels().getProvider(config.providerId)) return;
  const model = createOpenAICompatibleModel({
    providerId: config.providerId,
    modelId: config.modelId ?? '__tenon_openai_compatible_probe__',
    baseUrl: config.baseUrl,
  });
  piModels().setProvider(createProvider({
    id: config.providerId,
    name: config.providerId,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: `${config.providerId} API key`,
        resolve: async ({ credential }) => {
          if (credential?.key) return { auth: { apiKey: credential.key }, source: 'stored credential' };
          return undefined;
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  }));
}

export function createOpenAICompatibleModel(
  config: { providerId: string; modelId: string; baseUrl?: string },
): Model<'openai-completions'> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
    maxTokens: DEFAULT_CUSTOM_MAX_TOKENS,
  };
}

function ensureProviderForModel(model: Model<Api>): void {
  if (piModels().getProvider(model.provider)) return;
  if (model.baseUrl) {
    ensurePiCustomProvider({ providerId: model.provider, baseUrl: model.baseUrl, modelId: model.id });
  }
}

async function readCredential(providerId: string): Promise<Credential | undefined> {
  try {
    return await credentialStoreAdapter.read(providerId);
  } catch {
    return undefined;
  }
}

const credentialStoreAdapter: CredentialStore = {
  read(providerId) {
    return requireCredentialStorage().read(providerId);
  },
  modify(providerId, fn) {
    return requireCredentialStorage().modify(providerId, fn);
  },
  delete(providerId) {
    return requireCredentialStorage().delete(providerId);
  },
};

function requireCredentialStorage(): PiCredentialStorage {
  if (!credentialStorage) throw new Error('pi credential storage is not configured');
  return credentialStorage;
}
