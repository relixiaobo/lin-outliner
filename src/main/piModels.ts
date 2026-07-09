import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthResult,
  type Context,
  type Credential,
  type CredentialStore,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  LOCAL_GATEWAY_PROVIDER_REGISTRY,
  isLocalGatewayProviderId,
  localGatewayProviderDefinition,
  type LocalGatewayProviderDefinition,
} from '../core/localGatewayProviders';
import { isLocalBaseUrl } from '../core/localEndpoint';
import { parseCcSwitchModelOptionId } from './ccSwitchRegistry';

const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128000;
const DEFAULT_CUSTOM_MAX_TOKENS = 8192;
const CUSTOM_PROVIDER_ID_PREFIX = 'tenon-custom:';
type OpenAICompatibleApiId = 'openai-completions' | 'openai-responses';

export interface PiCredentialStorage {
  read(providerId: string): Promise<Credential | undefined>;
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}

export interface PiCustomProviderConfig {
  providerId: string;
  baseUrl?: string;
  modelId?: string;
  catalogModel?: Model<Api> | null;
  api?: OpenAICompatibleApiId;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

let credentialStorage: PiCredentialStorage | null = null;
let modelsInstance: MutableModels | null = null;
const localGatewayRuntimeModels = new Map<string, Model<Api>[]>();

export function configurePiCredentialStorage(storage: PiCredentialStorage): void {
  credentialStorage = storage;
  modelsInstance = null;
}

export function piModels(): MutableModels {
  if (!credentialStorage) throw new Error('pi credential storage is not configured');
  if (!modelsInstance) {
    modelsInstance = builtinModels({ credentials: credentialStoreAdapter });
    registerLocalGatewayProviders(modelsInstance);
  }
  return modelsInstance;
}

export function piCredentialStore(): CredentialStore {
  return credentialStoreAdapter;
}

export function registerLocalGatewayRuntimeModels(providerId: string, models: readonly Model<Api>[]): void {
  localGatewayRuntimeModels.set(providerId, [...models]);
  const definition = localGatewayProviderDefinition(providerId);
  if (definition && modelsInstance) registerLocalGatewayProvider(modelsInstance, definition);
}

export function piProviders(): string[] {
  return piModels().getProviders()
    .map((provider) => provider.id)
    .filter((providerId) => !providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX))
    .filter((providerId) => !isLocalGatewayProviderId(providerId));
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
    return auth?.auth.apiKey;
  } catch {
    return undefined;
  }
}

export function piStreamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  ensureProviderForModel(model);
  const stream = piModels().streamSimple(model, context, options);
  const externalProviderId = externalProviderIdForModel(model);
  return externalProviderId ? remapAssistantStreamProvider(stream, externalProviderId) : stream;
}

export async function piCompleteSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
  ensureProviderForModel(model);
  const message = await piModels().completeSimple(model, context, options);
  const externalProviderId = externalProviderIdForModel(model);
  return externalProviderId ? remapAssistantMessageProvider(message, externalProviderId) : message;
}

export function ensurePiCustomProvider(config: PiCustomProviderConfig): void {
  if (!config.baseUrl) return;
  const internalProviderId = piCustomProviderId(config.providerId);
  const modelId = config.modelId ?? '__tenon_openai_compatible_probe__';
  const existingModels = piModels().getModels(internalProviderId);
  const model = createOpenAICompatibleModel({
    providerId: config.providerId,
    modelId,
    baseUrl: config.baseUrl,
    catalogModel: config.catalogModel,
    api: config.api,
    name: config.name,
    reasoning: config.reasoning,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  });
  piModels().setProvider(createProvider({
    id: internalProviderId,
    name: config.providerId,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: `${config.providerId} API key`,
        resolve: async ({ credential: requestCredential, model }) => {
          if (requestCredential?.key) return { auth: { apiKey: requestCredential.key }, source: 'request override' };
          // A deliberately-stored key wins everywhere (e.g. a local proxy fronted by a
          // master key). Only AFTER that does a local endpoint fall back to an inert
          // client key — so a keyless localhost server stays runnable, but we never
          // forward an AMBIENT provider key (env / OAuth / managed) to localhost. Remote
          // endpoints get no such sentinel and must resolve a real credential or fail.
          const storedCredential = await readCredential(config.providerId);
          if (storedCredential?.type === 'api_key' && storedCredential.key) return { auth: { apiKey: storedCredential.key }, source: 'stored credential' };
          if (isLocalBaseUrl(model.baseUrl)) return { auth: { apiKey: 'local-endpoint' }, source: 'local endpoint' };
          const externalAuth = await resolveExternalProviderRequestAuth(config.providerId);
          if (externalAuth) return externalAuth;
          return undefined;
        },
      },
    },
    models: mergeCustomProviderModels(existingModels, model),
    api: {
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
    },
  }));
}

export function createOpenAICompatibleModel(
  config: {
    providerId: string;
    modelId: string;
    baseUrl?: string;
    catalogModel?: Model<Api> | null;
    name?: string;
    api?: OpenAICompatibleApiId;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  },
): Model<OpenAICompatibleApiId> {
  const catalogModel = config.catalogModel;
  const api = config.api ?? (catalogModel?.api === 'openai-responses' || localGatewayProviderDefinition(config.providerId)?.defaultApi === 'openai-responses'
    ? 'openai-responses'
    : 'openai-completions');
  return {
    id: config.modelId,
    name: catalogModel?.name ?? config.name ?? config.modelId,
    api,
    provider: piCustomProviderId(config.providerId),
    baseUrl: config.baseUrl ?? '',
    reasoning: catalogModel?.reasoning ?? config.reasoning ?? false,
    thinkingLevelMap: catalogModel?.thinkingLevelMap,
    input: catalogModel?.input ?? ['text'],
    cost: catalogModel?.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: catalogModel?.contextWindow ?? config.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
    maxTokens: catalogModel?.maxTokens ?? config.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
  };
}

function registerLocalGatewayProviders(models: MutableModels): void {
  for (const provider of LOCAL_GATEWAY_PROVIDER_REGISTRY) {
    registerLocalGatewayProvider(models, provider);
  }
}

function registerLocalGatewayProvider(models: MutableModels, provider: LocalGatewayProviderDefinition): void {
  const runtimeModels = localGatewayRuntimeModels.get(provider.providerId);
  const source = provider.preferredCatalogProviders
    .map((providerId) => models.getModel(providerId, provider.defaultModelId) as Model<Api> | undefined)
    .find(Boolean);
  models.setProvider(createProvider({
    id: provider.providerId,
    name: provider.name,
    baseUrl: runtimeModels?.[0]?.baseUrl ?? provider.defaultBaseUrl,
    auth: {
      apiKey: {
        name: `${provider.name} key`,
        resolve: async ({ credential, model }) => {
          if (credential?.key) return { auth: { apiKey: credential.key }, source: 'stored credential' };
          const ccSwitchModel = parseCcSwitchModelOptionId(model.id);
          if (ccSwitchModel) {
            const sourceCredential = await readCredential(ccSwitchModel.sourceRuntimeProviderId);
            if (sourceCredential?.type === 'api_key' && sourceCredential.key) {
              return { auth: { apiKey: sourceCredential.key }, source: 'CC Switch registry' };
            }
          }
          if (isLocalBaseUrl(model.baseUrl)) return { auth: { apiKey: 'local-endpoint' }, source: 'local endpoint' };
          return undefined;
        },
      },
    },
    models: runtimeModels ?? [source ? {
      ...source,
      provider: provider.providerId,
      baseUrl: provider.defaultBaseUrl,
      name: 'Current routed model',
    } : {
      id: provider.defaultModelId,
      name: 'Current routed model',
      api: provider.defaultApi,
      provider: provider.providerId,
      baseUrl: provider.defaultBaseUrl,
      reasoning: provider.defaultApi === 'openai-responses',
      input: ['text'],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
      maxTokens: DEFAULT_CUSTOM_MAX_TOKENS,
    }],
    api: {
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
    },
  }));
}

function ensureProviderForModel(model: Model<Api>): void {
  if (piModels().getProvider(model.provider)) return;
  if (model.baseUrl) {
    ensurePiCustomProvider({
      providerId: piExternalProviderId(model.provider),
      baseUrl: model.baseUrl,
      modelId: model.id,
      api: isOpenAICompatibleApiId(model.api) ? model.api : undefined,
    });
  }
}

function mergeCustomProviderModels(existingModels: readonly Model<Api>[], model: Model<OpenAICompatibleApiId>): Model<Api>[] {
  const next = existingModels.filter((existing) => existing.id !== model.id);
  next.push(model);
  return next;
}

function isOpenAICompatibleApiId(api: Api): api is OpenAICompatibleApiId {
  return api === 'openai-completions' || api === 'openai-responses';
}

export function piCustomProviderId(providerId: string): string {
  return providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX)
    ? providerId
    : `${CUSTOM_PROVIDER_ID_PREFIX}${providerId}`;
}

export function piExternalProviderId(providerId: string): string {
  return providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX)
    ? providerId.slice(CUSTOM_PROVIDER_ID_PREFIX.length)
    : providerId;
}

function externalProviderIdForModel(model: Model<Api>): string | null {
  const externalProviderId = piExternalProviderId(model.provider);
  return externalProviderId === model.provider ? null : externalProviderId;
}

function remapAssistantMessageProvider(message: AssistantMessage, provider: string): AssistantMessage {
  return message.provider === provider ? message : { ...message, provider };
}

function remapAssistantEventProvider(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
  if (event.type === 'done') return { ...event, message: remapAssistantMessageProvider(event.message, provider) };
  if (event.type === 'error') return { ...event, error: remapAssistantMessageProvider(event.error, provider) };
  return { ...event, partial: remapAssistantMessageProvider(event.partial, provider) };
}

function remapAssistantStreamProvider(stream: AsyncIterable<AssistantMessageEvent>, provider: string) {
  const mapped = createAssistantMessageEventStream();
  void (async () => {
    let finalMessage: AssistantMessage | undefined;
    try {
      for await (const event of stream) {
        const mappedEvent = remapAssistantEventProvider(event, provider);
        if (mappedEvent.type === 'done') finalMessage = mappedEvent.message;
        if (mappedEvent.type === 'error') finalMessage = mappedEvent.error;
        mapped.push(mappedEvent);
      }
      mapped.end(finalMessage);
    } catch (error) {
      mapped.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider,
          model: 'unknown',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      });
    }
  })();
  return mapped;
}

async function readCredential(providerId: string): Promise<Credential | undefined> {
  try {
    return await credentialStoreAdapter.read(providerId);
  } catch {
    return undefined;
  }
}

async function resolveExternalProviderRequestAuth(providerId: string): Promise<AuthResult | undefined> {
  const externalModel = piModelsForProvider(providerId)[0];
  if (!externalModel) return undefined;
  const resolved = await piModels().getAuth(externalModel);
  if (!resolved) return undefined;
  const { baseUrl: _baseUrl, ...auth } = resolved.auth;
  return { ...resolved, auth };
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
