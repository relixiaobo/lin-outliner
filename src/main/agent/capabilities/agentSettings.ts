import * as electron from 'electron';
import {
  getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import type {
  Api,
  Credential,
  CredentialInfo,
  Model,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
  OAuthCredentials,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import type {
  AgentModelOption,
  AgentProviderAuthKind,
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
  AgentImageGenerationSettings,
  AgentImageGenerationSettingsInput,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentProviderCapabilitySummary,
  AgentProviderOption,
  AgentReasoningLevelLabels,
  AgentReasoningLevel,
  AgentProviderSecretStatus,
  AgentProviderStoredApiKey,
  AgentProviderSettingsView,
  ProviderConnectionCheckView,
  ProviderAuthView,
} from '../../../core/types';
import { isLocalBaseUrl } from '../../../core/localEndpoint';
import { createKeyedSerialMutationQueue } from '../../../core/serialMutationQueue';
import {
  CC_SWITCH_LOCAL_PROVIDER_ID,
  LOCAL_GATEWAY_PROVIDER_REGISTRY,
  isExternalSecretProviderId,
  localGatewayProviderDefinition,
  type LocalGatewayProviderDefinition,
} from '../../../core/localGatewayProviders';
import { PRIVATE_JSON_FILE_OPTIONS, readJsonOrDefault, updateJsonFile, writeJsonFile } from '../../jsonFileStore';
import { compareModels } from '../../modelRanking';
import {
  configurePiCredentialStorage,
  createOpenAICompatibleModel,
  ensurePiCustomProvider,
  registerLocalGatewayRuntimeModels,
  piCompleteSimple,
  piFindModel,
  piModels,
  piModelsForProvider,
  piProviderAuthKind,
  piProviderHasAmbientAuth,
  piProviderModelsRefreshable,
  piProviders,
  piFetchProviderModelsWithCredential,
  piRefreshProviderModels as refreshPiProviderModels,
  piResolveAuthApiKey,
  piResolveProviderRefreshCredential,
  piRestoreDynamicModels,
} from '../../piModels';
import {
  imageModelOptionsForProvider,
  piRefreshImageModels,
} from '../../piImageModels';
import {
  customOpenAIResponsesFetchOption,
  customOpenAIResponsesPayloadProfileOption,
} from '../../openAIResponsesCompat';
import {
  createResilientResponsesFetch,
  type ResilientResponsesFetchOptions,
} from '../runtime/sseResilientFetch';
import { redactSecretLikeContent } from './agentSecretRedaction';
import {
  ccSwitchModelOptionId,
  ccSwitchPiApiForSource,
  ccSwitchRunnableSources,
  ccSwitchSourceApiKey,
  ccSwitchSourceBaseUrl,
  ccSwitchSourceLabel,
  ccSwitchSourceModels,
  ccSwitchSourceRuntimeProviderId,
  parseCcSwitchModelOptionId,
  parseCcSwitchRuntimeProviderId,
  readCcSwitchRegistrySnapshot,
  type CcSwitchOpenAICompatibleApiId,
  type CcSwitchProviderSource,
  type CcSwitchRegistrySnapshot,
} from '../../ccSwitchRegistry';

const PROVIDERS_FILE = 'agent-providers.json';
const SECRETS_FILE = 'agent-secrets.json';
const MODEL_CATALOGS_FILE = 'agent-model-catalogs.json';

// A provider config is a connection record only. Thread configuration owns the
// model and reasoning effort selected for execution.
interface AgentProviderConfig {
  providerId: string;
  baseUrl?: string;
  enabled: boolean;
  /** Main-only identity version for rejecting probe results from an old connection. */
  connectionGeneration?: number;
  /**
   * The last probe verdict. Absent means unverified, which is what a credential
   * write restores — a rotated key must never inherit the old key's result.
   */
  connectionCheck?: ProviderConnectionCheckView;
}

interface ProviderConfigFile {
  activeProviderId?: string;
  agent?: StoredAgentRuntimeSettings;
  imageGeneration?: StoredImageGenerationSettings;
  providers: AgentProviderConfig[];
}

export interface ProviderConnectionProbeContext {
  input: {
    providerId: string;
    baseUrl?: string;
    apiKey?: string;
  };
  connectionGeneration?: number;
  matchesStoredConnection: boolean;
}

type StoredAgentRuntimeSettings = Partial<AgentRuntimeSettings>;

type StoredImageGenerationSettings = {
  defaultModel?: string | null;
};

// Stored credential shape — mirrors pi-mono's coding-agent `AuthCredential`
// (discriminated on `type`, oauth flattened) so we reuse its shape rather than
// invent one. A provider holds at most one stored credential: signing in writes
// an `oauth` entry, pasting a key writes an `api_key` entry, switching replaces.
// `managed` providers never appear here; env keys are read, never stored.
type ApiKeyCredential = { type: 'api_key'; key?: string; env?: Record<string, string> };
type OAuthStoredCredential = { type: 'oauth' } & OAuthCredentials;
type AuthCredential = ApiKeyCredential | OAuthStoredCredential;

interface SecretFile {
  credentials: Record<string, AuthCredential>;
}

// On-disk envelope. Credentials are local plaintext JSON with chmod 600.
interface SecretEnvelope {
  credentials?: Record<string, AuthCredential>;
}

interface ModelCatalogFile {
  catalogs: Record<string, ModelsStoreEntry>;
}

function getProviderAuthKind(providerId: string): AgentProviderAuthKind {
  return piProviderAuthKind(providerId);
}

const AGENT_REASONING_LEVELS = AGENT_REASONING_LADDER;
const AGENT_CACHE_RETENTIONS = ['none', 'short', 'long'] as const;
const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  additionalSkillDirectories: [],
  // Captured once for each delegated execution generation's local breaker.
  subagentTokenBudget: 1_500_000,
  subagentMaxDepth: 3,
  subagentMaxConcurrent: 20,
  providerTimeoutMs: null,
  providerMaxRetries: null,
  providerMaxRetryDelayMs: 60_000,
  providerCacheRetention: 'short',
  disabledSkills: [],
};

type OpenAICompatibleApiId = CcSwitchOpenAICompatibleApiId;
interface CcSwitchModelSortKey {
  upstreamModelId: string;
  sourceRank: number;
  sourceIndex: number;
}

const ccSwitchModelSortKeysByProvider = new Map<string, Map<string, CcSwitchModelSortKey>>();
// Credential writes for one provider are serialized: a login, a key edit, and pi's
// own OAuth refresh all read-modify-write the same secret file entry, and each
// then decides whether the connection verdict survives.
const providerCredentialMutations = createKeyedSerialMutationQueue();
let providerConnectionGenerationClock = Date.now();

export interface AgentProviderRuntimeConfig extends AgentProviderConfig {
  apiKey?: string;
  api?: OpenAICompatibleApiId;
  modelId?: string;
}

interface AgentProviderConnectionAuth {
  apiKey?: string;
  catalogCredential?: Credential;
  listHeaders?: Record<string, string>;
}

configurePiCredentialStorage({
  read: readPiCredential,
  list: listPiCredentials,
  modify: modifyPiCredential,
  delete: deletePiCredential,
}, {
  read: readPiModelCatalog,
  write: writePiModelCatalog,
  delete: deletePiModelCatalog,
});

export async function getProviderSettings(): Promise<AgentProviderSettingsView> {
  // A pure read — never destructive. Junk-row cleanup happens once at startup via
  // `reconcileProviderConfig`, NOT on every read: a write on the read path both
  // raced concurrent writers and could prune rows from a transient read failure.
  // See `reconcileProviderConfig`.
  await piRestoreDynamicModels();
  return toSettingsView(await readProviderFile(), await readSecretFileSafe());
}

export async function refreshProviderModels(providerIdInput: string): Promise<AgentProviderSettingsView> {
  const providerId = normalizeProviderId(providerIdInput);
  const localGatewayProvider = localGatewayProviderDefinition(providerId);
  if (localGatewayProvider?.adapter === 'cc-switch-codex' && localGatewayProvider.refreshableModels) {
    await registerCcSwitchRuntimeModels(localGatewayProvider, await readCcSwitchRegistry());
  }
  await refreshPiProviderModels(providerId);
  await piRefreshImageModels(providerId).catch(() => undefined);
  return getProviderSettings();
}

export async function getAgentRuntimeSettings(): Promise<AgentRuntimeSettings> {
  return normalizeAgentRuntimeSettings((await readProviderFile()).agent);
}

export async function getActiveProviderRuntimeConfig(): Promise<AgentProviderRuntimeConfig | null> {
  await piRestoreDynamicModels();
  const file = await readProviderFile();
  const secrets = await readSecretFileSafe();
  const active = await findUsableProvider(file.providers.filter((provider) => provider.providerId === file.activeProviderId), secrets)
    ?? await findUsableProvider(file.providers, secrets)
    ?? null;
  if (!active) return null;
  const localGatewayProvider = localGatewayProviderDefinition(active.providerId);
  if (localGatewayProvider?.adapter === 'cc-switch-codex') {
    return resolveCcSwitchRuntimeConfig(localGatewayProvider, active);
  }
  // Connection only. Do not bake auth here. pi `Models.applyAuth()` resolves
  // stored/env/oauth/provider-specific auth at request time; `apiKey` is only an
  // explicit override used by tests or the connection form's unsaved key.
  return { ...active };
}

/** Resolve one specific provider without falling back to another configured row. */
export async function getProviderRuntimeConfig(
  providerIdInput: string,
  modelIdInput?: string,
): Promise<AgentProviderRuntimeConfig | null> {
  await piRestoreDynamicModels();
  const providerId = normalizeProviderId(providerIdInput);
  const modelId = modelIdInput?.trim();
  if (modelIdInput !== undefined && !modelId) return null;
  const file = await readProviderFile();
  const secrets = await readSecretFileSafe();
  const provider = await findUsableProvider(
    file.providers.filter((candidate) => candidate.providerId === providerId),
    secrets,
  ) ?? null;
  if (!provider) return null;
  if (modelId) {
    const catalog = (await getAvailableProviders(file.providers))
      .find((candidate) => candidate.providerId === providerId);
    if (!catalog?.models.some((model) => model.id === modelId)) return null;
  }
  const localGatewayProvider = localGatewayProviderDefinition(provider.providerId);
  if (localGatewayProvider?.adapter === 'cc-switch-codex') {
    return resolveCcSwitchRuntimeConfig(localGatewayProvider, provider);
  }
  return { ...provider };
}

export async function updateAgentRuntimeSettings(input: AgentRuntimeSettingsInput) {
  await mutateProviderFile((file) => {
    file.agent = normalizeAgentRuntimeSettings({
      ...normalizeAgentRuntimeSettings(file.agent),
      ...input,
    });
  });
  return getProviderSettings();
}

export async function updateImageGenerationSettings(input: AgentImageGenerationSettingsInput) {
  await mutateProviderFile((file) => {
    file.imageGeneration = normalizeImageGenerationSettings({
      ...normalizeImageGenerationSettings(file.imageGeneration),
      ...input,
    });
  });
  return getProviderSettings();
}

export function providerStreamOptionsFromRuntimeSettings(
  settings?: Pick<
    AgentRuntimeSettings,
    'providerTimeoutMs' | 'providerMaxRetries' | 'providerMaxRetryDelayMs' | 'providerCacheRetention'
  > | null,
  model?: Pick<Model<Api>, 'api' | 'baseUrl'> | null,
  responsesStreamOptions: ResilientResponsesFetchOptions = {},
): Pick<SimpleStreamOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention' | 'fetch'> {
  const options: Pick<
    SimpleStreamOptions,
    'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention' | 'fetch'
  > = {};
  if (settings?.providerTimeoutMs !== null && settings?.providerTimeoutMs !== undefined) {
    options.timeoutMs = settings.providerTimeoutMs;
  }
  if (settings?.providerMaxRetries !== null && settings?.providerMaxRetries !== undefined) {
    options.maxRetries = settings.providerMaxRetries;
  }
  if (settings?.providerMaxRetryDelayMs !== null && settings?.providerMaxRetryDelayMs !== undefined) {
    options.maxRetryDelayMs = settings.providerMaxRetryDelayMs;
  }
  if (settings?.providerCacheRetention) {
    options.cacheRetention = settings.providerCacheRetention;
  }
  Object.assign(options, customOpenAIResponsesFetchOption(
    model,
    () => createResilientResponsesFetch(responsesStreamOptions),
  ));
  return options;
}

export async function upsertProviderConfig(input: AgentProviderConfigInput) {
  const config = normalizeConfig(input);
  await mutateProviderFile((file) => {
    const index = file.providers.findIndex((provider) => provider.providerId === config.providerId);
    if (index >= 0) {
      // The endpoint is part of what a verdict was about, so changing it advances
      // the identity version. A late probe for the old endpoint can no longer
      // overwrite the new row even after the old verdict has been cleared.
      const previous = file.providers[index]!;
      // Compared normalized, so an absent endpoint and an empty one are the same
      // endpoint. A raw !== would let a stored '' and an incoming undefined read as
      // a change and discard a verdict nothing about the connection invalidated.
      const endpointUnchanged = normalizeBaseUrl(previous.baseUrl) === normalizeBaseUrl(config.baseUrl);
      file.providers[index] = {
        ...config,
        connectionGeneration: endpointUnchanged
          ? providerConnectionGeneration(previous)
          : allocateProviderConnectionGeneration(providerConnectionGeneration(previous)),
        ...(endpointUnchanged && previous.connectionCheck
          ? { connectionCheck: previous.connectionCheck }
          : {}),
      };
    } else {
      file.providers.push({
        ...config,
        connectionGeneration: allocateProviderConnectionGeneration(),
      });
    }
    if (file.activeProviderId === config.providerId && !config.enabled) file.activeProviderId = undefined;
    file.providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
  });
  // No auto-activation side effect (provider-config-cleanup A2): an upsert never
  // makes a provider active by itself — the credential may not be stored yet. Read
  // paths resolve the active provider by falling back through credentialed rows, so
  // a freshly credentialed provider is usable immediately; the startup reconcile
  // tidies the persisted activeProviderId at the next launch.
  return getProviderSettings();
}

/**
 * Ensure a provider has a config row in agent-providers.json. The OAuth sign-in
 * path persists a credential but, unlike the API-key form's `upsertProviderConfig`,
 * has no step that creates a provider row — so a first-time login would be
 * orphaned (credential on disk, no selectable provider). Creates a connection row
 * when none exists; an existing row is left untouched.
 */
export async function ensureProviderConfig(providerIdInput: string): Promise<void> {
  const providerId = normalizeProviderId(providerIdInput);
  await mutateProviderFile((file) => {
    if (file.providers.some((provider) => provider.providerId === providerId)) return;
    file.providers.push({
      providerId,
      enabled: true,
      connectionGeneration: allocateProviderConnectionGeneration(),
    });
    file.providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
    // The OAuth credential is persisted before this row is created, so read paths
    // resolve it as the active provider via the credentialed-row fallback even before
    // the startup reconcile tidies the persisted activeProviderId — no auto-activation
    // side effect needed here (provider-config-cleanup A2).
  });
}

/**
 * The runtime's default model for a provider connection: the first model after the
 * shared ranking sort (newest, thinking-capable first). Used as the connection
 * probe model and the catalog fallback when no Configuration Profile names one. Returns
 * null for a custom endpoint with no catalog.
 */
/** A provider's catalog models, sorted by the shared ranking (newest, thinking-first). */
export function rankedModels(providerId: string): Model<Api>[] {
  try {
    return rankProviderModels(providerId, piModelsForProvider(providerId));
  } catch {
    return [];
  }
}

function rankProviderModels(providerId: string, models: readonly Model<Api>[]): Model<Api>[] {
  return [...models].sort((left, right) => compareProviderRankables(providerId, left, right));
}

function firstRankedModel(providerId: string): Model<Api> | null {
  return rankedModels(providerId)[0] ?? null;
}

export async function deleteProviderConfig(providerIdInput: string) {
  const providerId = normalizeProviderId(providerIdInput);
  await mutateProviderFile((file) => {
    const previousLength = file.providers.length;
    file.providers = file.providers.filter((provider) => provider.providerId !== providerId);
    if (file.providers.length === previousLength) throw new Error(`provider not found: ${providerId}`);
    if (file.activeProviderId === providerId) file.activeProviderId = file.providers.find((provider) => provider.enabled)?.providerId;
  });
  await mutateSecretFile((secrets) => {
    delete secrets.credentials[providerId];
  });
  return getProviderSettings();
}

export async function setActiveProvider(providerIdInput: string) {
  const providerId = normalizeProviderId(providerIdInput);
  await mutateProviderFile((file) => {
    const provider = file.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new Error(`provider not found: ${providerId}`);
    }
    if (!provider.enabled) throw new Error(`provider is disabled: ${providerId}`);
    file.activeProviderId = providerId;
  });
  return getProviderSettings();
}

/**
 * Record what a probe found, or clear it.
 *
 * The mapping is deliberately conservative because `statusCode` is *inferred* —
 * `testProviderConnection` derives it by matching the redacted error text — and
 * this verdict is durable in a way a transient banner is not. A 500 whose body
 * happens to contain "unauthorized" must not be written down forever as a
 * rejected key, so only a confident 401/403 produces `rejected` and everything
 * else, including an unclassified failure, is `unreachable`.
 */
export async function recordProviderConnectionCheck(
  providerIdInput: string,
  result: { success: boolean; message?: string; statusCode?: number } | null,
  expectedGeneration?: number,
): Promise<boolean> {
  const providerId = normalizeProviderId(providerIdInput);
  let recorded = false;
  await mutateProviderFile((file) => {
    const provider = file.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) return;
    if (expectedGeneration !== undefined && providerConnectionGeneration(provider) !== expectedGeneration) return;

    if (!result) {
      delete provider.connectionCheck;
    } else {
      const rejected = result.statusCode === 401 || result.statusCode === 403;
      provider.connectionCheck = {
        outcome: result.success ? 'ok' : rejected ? 'rejected' : 'unreachable',
        at: Date.now(),
        ...(result.statusCode ? { statusCode: result.statusCode } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
    }
    recorded = true;
  });
  return recorded;
}

export async function setProviderApiKey(providerIdInput: string, apiKeyInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  if (isExternalSecretProviderId(providerId)) {
    await withProviderCredentialMutation(providerId, async () => {
      await mutateSecretFile((secrets) => {
        delete secrets.credentials[providerId];
      });
      await invalidateProviderConnection(providerId);
    });
    return { providerId, hasApiKey: false };
  }
  const apiKey = apiKeyInput.trim();
  await withProviderCredentialMutation(providerId, async () => {
    await mutateSecretFile((secrets) => {
      if (apiKey) {
        secrets.credentials[providerId] = { type: 'api_key', key: apiKey };
      } else if (secrets.credentials[providerId]?.type === 'api_key') {
        // Clearing the key field removes only a stored key — never an oauth login.
        delete secrets.credentials[providerId];
      }
    });
    await invalidateProviderConnection(providerId);
  });
  if (apiKey) await refreshPiProviderModels(providerId).catch(() => undefined);
  return { providerId, hasApiKey: !!apiKey };
}

export async function deleteProviderApiKey(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  await withProviderCredentialMutation(providerId, async () => {
    await mutateSecretFile((secrets) => {
      if (secrets.credentials[providerId]?.type === 'api_key') delete secrets.credentials[providerId];
    });
    await invalidateProviderConnection(providerId);
  });
  return { providerId, hasApiKey: false };
}

export async function getProviderSecretStatus(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  if (isExternalSecretProviderId(providerId)) return { providerId, hasApiKey: false };
  const secrets = await readSecretFileSafe();
  return { providerId, hasApiKey: secrets.credentials[providerId]?.type === 'api_key' };
}

/**
 * Return only the API key the user explicitly pasted into Tenon. This deliberately
 * does not resolve env keys, OAuth access tokens, managed credentials, or local
 * endpoint sentinels; it powers the user-clicked "show/copy saved key" UI.
 */
export async function getStoredProviderApiKey(providerIdInput: string): Promise<AgentProviderStoredApiKey> {
  const providerId = normalizeProviderId(providerIdInput);
  if (isExternalSecretProviderId(providerId)) return { providerId, apiKey: undefined };
  const secrets = await readSecretFileSafe();
  const credential = secrets.credentials[providerId];
  return {
    providerId,
    apiKey: credential?.type === 'api_key' ? credential.key : undefined,
  };
}

/**
 * Resolve only the concrete API-key field from pi auth. This is for legacy
 * callsites/tests that truly need a string key, not for provider requests:
 * request dispatch should let pi `Models.applyAuth()` preserve provider-specific
 * headers, env, and baseUrl auth fields.
 */
export async function getProviderApiKey(providerIdInput: string): Promise<string | undefined> {
  try {
    const providerId = normalizeProviderId(providerIdInput);
    if (parseCcSwitchRuntimeProviderId(providerId) || isExternalSecretProviderId(providerId)) return undefined;
    const file = await readProviderFile();
    const providerConfig = file.providers.find((provider) => provider.providerId === providerId);
    if (providerConfig?.baseUrl) ensurePiCustomProvider(providerConfig);
    const model = firstRankedModel(providerId);
    const authModel = model
      ?? (providerConfig?.baseUrl
        ? createOpenAICompatibleModel({ providerId, modelId: '__tenon_openai_compatible_probe__', baseUrl: providerConfig.baseUrl })
        : null);
    return authModel ? piResolveAuthApiKey(authModel) : undefined;
  } catch {
    return undefined;
  }
}

/** Persist an oauth login / a rotated token. The only writer of oauth credentials. */
export async function persistOAuthCredential(providerIdInput: string, credentials: OAuthCredentials): Promise<void> {
  const providerId = normalizeProviderId(providerIdInput);
  await withProviderCredentialMutation(providerId, async () => {
    await mutateSecretFile((secrets) => {
      secrets.credentials[providerId] = { type: 'oauth', ...credentials };
    });
    await invalidateProviderConnection(providerId);
  });
}

/** Remove any stored credential for a provider (oauth sign-out). */
export async function deleteProviderCredential(providerIdInput: string): Promise<void> {
  const providerId = normalizeProviderId(providerIdInput);
  await withProviderCredentialMutation(providerId, async () => {
    await mutateSecretFile((secrets) => {
      delete secrets.credentials[providerId];
    });
    await invalidateProviderConnection(providerId);
  });
}

/**
 * Capture exactly what a connection probe will test. A supplied Base URL is an
 * explicit override even when it is the empty string (meaning the provider's
 * official endpoint); omitting it uses the stored endpoint. Unsaved inputs can be
 * tested, but only a byte-equivalent stored key and the stored endpoint may
 * produce a durable verdict.
 */
export async function prepareProviderConnectionProbe(input: {
  providerId: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  baseUrlOverride?: boolean;
  apiKeyOverride?: boolean;
}): Promise<ProviderConnectionProbeContext> {
  const providerId = normalizeProviderId(input.providerId);
  await providerCredentialMutations.settled(providerId);
  const file = await readProviderFile();
  const provider = file.providers.find((candidate) => candidate.providerId === providerId);
  const storedBaseUrl = normalizeBaseUrl(provider?.baseUrl);
  const baseUrl = input.baseUrlOverride ? normalizeBaseUrl(input.baseUrl) : storedBaseUrl;
  const apiKey = input.apiKeyOverride ? input.apiKey?.trim() || undefined : undefined;
  let credentialMatches = true;
  if (input.apiKeyOverride) {
    const storedCredential = (await readSecretFileSafe()).credentials[providerId];
    const storedApiKey = storedCredential?.type === 'api_key' ? storedCredential.key?.trim() : undefined;
    credentialMatches = secretsEqual(apiKey, storedApiKey);
  }
  return {
    input: {
      providerId,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
    connectionGeneration: provider ? providerConnectionGeneration(provider) : undefined,
    matchesStoredConnection: Boolean(provider)
      && baseUrl === storedBaseUrl
      && credentialMatches,
  };
}

async function toSettingsView(file: ProviderConfigFile, secrets: SecretFile): Promise<AgentProviderSettingsView> {
  const availableProviders = await getAvailableProviders(file.providers);
  const availableProviderById = new Map(availableProviders.map((provider) => [provider.providerId, provider]));
  return {
    activeProviderId: file.activeProviderId,
    agent: normalizeAgentRuntimeSettings(file.agent),
    imageGeneration: normalizeImageGenerationSettings(file.imageGeneration),
    providers: await Promise.all(file.providers.map(async (provider): Promise<AgentProviderConfigView> => {
      const catalogProvider = availableProviderById.get(provider.providerId);
      const cred = secrets.credentials[provider.providerId];
      const localGatewayProvider = localGatewayProviderDefinition(provider.providerId);
      const externalSecretProvider = isExternalSecretProviderId(provider.providerId);
      const viewBaseUrl = localGatewayProvider ? catalogProvider?.defaultBaseUrl ?? provider.baseUrl : provider.baseUrl;
      if (viewBaseUrl) ensurePiCustomProvider({ ...provider, baseUrl: viewBaseUrl });
      const hasEnvApiKey = localGatewayProvider ? false : await piProviderHasAmbientAuth(provider.providerId);
      const authKind = getProviderAuthKind(provider.providerId);
      const oauthCred = cred?.type === 'oauth' ? cred : undefined;
      const hasStoredKey = !externalSecretProvider && cred?.type === 'api_key';
      const isKeylessLocalEndpoint = !cred
        && isLocalBaseUrl(viewBaseUrl)
        && !localGatewayProvider;
      const auth: ProviderAuthView = {
        authKind,
        // Authoritative "can use models": any stored credential, env key, or
        // managed sentinel. Keyless local endpoints are allowed; registered local
        // gateways are the exception because main must prove their own reachability.
        // Renderer reads this instead of re-deriving.
        credentialed: localGatewayProvider
          ? Boolean(catalogProvider?.credentialed)
          : Boolean(cred) || hasEnvApiKey || isKeylessLocalEndpoint,
        hasStoredKey,
        oauth: authKind === 'oauth'
          ? { connected: Boolean(oauthCred), expiresAt: oauthCred?.expires }
          : undefined,
      };
      return {
        providerId: provider.providerId,
        baseUrl: viewBaseUrl,
        enabled: provider.enabled,
        hasApiKey: hasStoredKey,
        hasEnvApiKey,
        auth,
        ...(provider.connectionCheck ? { connectionCheck: provider.connectionCheck } : {}),
      };
    })),
    availableProviders,
  };
}

function normalizeImageGenerationSettings(input?: StoredImageGenerationSettings | null): AgentImageGenerationSettings {
  const defaultModel = normalizeOptionalString(input?.defaultModel);
  return defaultModel && defaultModel !== 'auto' ? { defaultModel } : {};
}

function normalizeAgentRuntimeSettings(input?: StoredAgentRuntimeSettings | null): AgentRuntimeSettings {
  return {
    additionalSkillDirectories: normalizeStringList(input?.additionalSkillDirectories, MAX_ADDITIONAL_SKILL_DIRECTORIES),
    subagentTokenBudget: normalizeNullablePositiveInteger(
      input?.subagentTokenBudget,
      DEFAULT_AGENT_RUNTIME_SETTINGS.subagentTokenBudget,
    ),
    subagentMaxDepth: normalizePositiveInteger(
      input?.subagentMaxDepth,
      DEFAULT_AGENT_RUNTIME_SETTINGS.subagentMaxDepth,
    ),
    subagentMaxConcurrent: normalizePositiveInteger(
      input?.subagentMaxConcurrent,
      DEFAULT_AGENT_RUNTIME_SETTINGS.subagentMaxConcurrent,
    ),
    providerTimeoutMs: normalizeNullablePositiveInteger(input?.providerTimeoutMs, DEFAULT_AGENT_RUNTIME_SETTINGS.providerTimeoutMs),
    providerMaxRetries: normalizeNullableNonNegativeInteger(input?.providerMaxRetries, DEFAULT_AGENT_RUNTIME_SETTINGS.providerMaxRetries),
    providerMaxRetryDelayMs: normalizeNullableNonNegativeInteger(
      input?.providerMaxRetryDelayMs,
      DEFAULT_AGENT_RUNTIME_SETTINGS.providerMaxRetryDelayMs,
    ),
    providerCacheRetention: isAgentCacheRetention(input?.providerCacheRetention)
      ? input.providerCacheRetention
      : DEFAULT_AGENT_RUNTIME_SETTINGS.providerCacheRetention,
    disabledSkills: normalizeStringList(input?.disabledSkills, MAX_DISABLED_SKILLS),
  };
}

/**
 * Bound on how many directories a user may point the Skill loader at. Each one
 * is scanned on every registry refresh, so this stays small.
 */
const MAX_ADDITIONAL_SKILL_DIRECTORIES = 20;

/**
 * Bound on `disabledSkills`. It is generous because this list is keyed by name
 * over EVERY source — built-in, user, project, local, managed — so it scales
 * with how many Skills a user has, not with anything they configure. At 20 it
 * silently dropped the 21st disable: the row snapped back on and the Skill
 * stayed model-invocable despite an explicit off.
 */
const MAX_DISABLED_SKILLS = 1_000;

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function normalizeNullablePositiveInteger(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return normalizeInteger(value, fallback, 1);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return normalizeInteger(value, fallback, 1) ?? fallback;
}

function normalizeNullableNonNegativeInteger(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return normalizeInteger(value, fallback, 0);
}

function normalizeInteger(value: unknown, fallback: number | null, min: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return Number.isSafeInteger(normalized) && normalized >= min ? normalized : fallback;
}

async function getAvailableProviders(configuredProviders: readonly AgentProviderConfig[]): Promise<AgentProviderOption[]> {
  const builtinProviders = await Promise.all(piProviders().map(async (providerId) => {
    const models = providerModelOptions(providerId, piModelsForProvider(providerId));
    return {
      providerId,
      authKind: getProviderAuthKind(providerId),
      hasEnvApiKey: await piProviderHasAmbientAuth(providerId),
      envKeyNames: [],
      defaultBaseUrl: piModelsForProvider(providerId)[0]?.baseUrl,
      modelsRefreshable: piProviderModelsRefreshable(providerId) || undefined,
      capabilities: providerCapabilities(providerId, models),
      models,
    };
  }));
  const localGatewayProviders = (await Promise.all(LOCAL_GATEWAY_PROVIDER_REGISTRY.map((provider) => (
    getLocalGatewayProviderOption(provider, configuredProviders)
  )))).filter((provider): provider is AgentProviderOption => Boolean(provider));
  return [...builtinProviders, ...localGatewayProviders];
}

async function getLocalGatewayProviderOption(
  localGatewayProvider: LocalGatewayProviderDefinition,
  configuredProviders: readonly AgentProviderConfig[],
): Promise<AgentProviderOption | null> {
  if (localGatewayProvider.adapter === 'cc-switch-codex') {
    return getCcSwitchProviderOption(localGatewayProvider, configuredProviders);
  }
  return null;
}

async function getCcSwitchProviderOption(
  localGatewayProvider: LocalGatewayProviderDefinition,
  configuredProviders: readonly AgentProviderConfig[],
): Promise<AgentProviderOption | null> {
  const configured = configuredProviders.find((provider) => provider.providerId === localGatewayProvider.providerId);
  const snapshot = await readCcSwitchRegistry();
  const runtimeModels = registerCcSwitchRuntimeModels(localGatewayProvider, snapshot);
  const detected = snapshot.detected;
  if (!configured && !detected) return null;
  const models = providerModelOptions(localGatewayProvider.providerId, runtimeModels);
  const baseUrl = ccSwitchRunnableSources(snapshot)[0]
    ? ccSwitchSourceBaseUrl(ccSwitchRunnableSources(snapshot)[0]!)
    : configured?.baseUrl ?? localGatewayProvider.defaultBaseUrl;
  return {
    providerId: localGatewayProvider.providerId,
    authKind: 'api-key',
    credentialed: snapshot.status === 'ready',
    detected,
    connectionStatus: snapshot.status,
    connectionStatusMessage: snapshot.statusMessage,
    hasEnvApiKey: false,
    envKeyNames: [],
    defaultBaseUrl: baseUrl,
    modelsRefreshable: localGatewayProvider.refreshableModels || undefined,
    capabilities: providerCapabilities(localGatewayProvider.providerId, models),
    models,
  };
}

async function readCcSwitchRegistry(): Promise<CcSwitchRegistrySnapshot> {
  return readCcSwitchRegistrySnapshot(getElectronHomePath());
}

function registerCcSwitchRuntimeModels(
  localGatewayProvider: LocalGatewayProviderDefinition,
  snapshot: CcSwitchRegistrySnapshot,
): Model<Api>[] {
  const sortKeys = new Map<string, CcSwitchModelSortKey>();
  const runtimeModels = ccSwitchRunnableSources(snapshot)
    .flatMap((source, sourceIndex) => ccSwitchRuntimeModelsForSource(localGatewayProvider, source, sourceIndex, sortKeys));
  ccSwitchModelSortKeysByProvider.set(localGatewayProvider.providerId, sortKeys);
  registerLocalGatewayRuntimeModels(localGatewayProvider.providerId, runtimeModels);
  return runtimeModels;
}

function ccSwitchRuntimeModelsForSource(
  localGatewayProvider: LocalGatewayProviderDefinition,
  source: CcSwitchProviderSource,
  sourceIndex: number,
  sortKeys: Map<string, CcSwitchModelSortKey>,
): Model<Api>[] {
  const baseUrl = ccSwitchSourceBaseUrl(source);
  if (!baseUrl) return [];
  const sourceRuntimeProviderId = ccSwitchSourceRuntimeProviderId(source);
  return ccSwitchSourceModels(source).map((descriptor) => {
    const modelApi = descriptor.api ?? ccSwitchPiApiForSource(source);
    const modelId = ccSwitchModelOptionId(sourceRuntimeProviderId, descriptor.id);
    const model = createOpenAICompatibleModel({
      providerId: localGatewayProvider.providerId,
      modelId,
      name: ccSwitchSourceLabel(source, descriptor),
      baseUrl,
      api: modelApi,
      catalogModel: ccSwitchCatalogModel(localGatewayProvider, descriptor.id),
      reasoning: descriptor.reasoning ?? modelApi === 'openai-responses',
      contextWindow: descriptor.contextWindow,
      maxTokens: descriptor.maxTokens,
    });
    sortKeys.set(modelId, {
      upstreamModelId: descriptor.id,
      sourceRank: source.isCurrent ? 0 : 1,
      sourceIndex,
    });
    return { ...model, provider: localGatewayProvider.providerId, name: ccSwitchSourceLabel(source, descriptor) };
  });
}

function ccSwitchCatalogModel(localGatewayProvider: LocalGatewayProviderDefinition, modelId: string): Model<Api> | null {
  return piFindModel(localGatewayProvider.providerId, modelId)
    ?? localGatewayProvider.preferredCatalogProviders
      .map((providerId) => piFindModel(providerId, modelId))
      .find((model): model is Model<Api> => Boolean(model))
    ?? null;
}

async function resolveCcSwitchRuntimeConfig(
  localGatewayProvider: LocalGatewayProviderDefinition,
  config: AgentProviderConfig,
): Promise<AgentProviderRuntimeConfig | null> {
  const snapshot = await readCcSwitchRegistry();
  registerCcSwitchRuntimeModels(localGatewayProvider, snapshot);
  const model = rankedModels(localGatewayProvider.providerId)[0];
  if (!model) return null;
  return {
    providerId: config.providerId,
    enabled: config.enabled,
    modelId: model.id,
    api: isOpenAICompatibleApiId(model.api) ? model.api : undefined,
  };
}

function isOpenAICompatibleApiId(api: Api): api is OpenAICompatibleApiId {
  return api === 'openai-completions' || api === 'openai-responses';
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function providerCapabilities(providerId: string, languageModels: readonly AgentModelOption[]): AgentProviderCapabilitySummary[] {
  const capabilities: AgentProviderCapabilitySummary[] = [];
  const languageRefreshable = piProviderModelsRefreshable(providerId);
  if (languageModels.length > 0) {
    capabilities.push({
      kind: 'language',
      refreshable: languageRefreshable || undefined,
      models: languageModels.map((model) => ({
        id: model.id,
        name: model.name,
        providerId,
        input: ['text'],
        output: ['text'],
      })),
    });
  }
  const imageModels = imageModelOptionsForProvider(providerId);
  if (imageModels.length > 0) {
    capabilities.push({
      kind: 'image_generation',
      models: imageModels.map((model) => ({
        id: model.id,
        name: model.name,
        providerId: model.providerId,
        input: [...model.input],
        output: [...model.output],
      })),
    });
  }
  return capabilities;
}

function providerModelOptions(providerId: string, models: readonly Model<Api>[]): AgentModelOption[] {
  return models
    .map((model): AgentModelOption => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      supportedThinkingLevels: getSupportedReasoningLevelsForModel(model),
      thinkingLevelLabels: getReasoningLevelLabelsForModel(model),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))
    .sort((left, right) => compareProviderRankables(providerId, left, right));
}

function compareProviderRankables(
  providerId: string,
  left: { id: string; reasoning: boolean },
  right: { id: string; reasoning: boolean },
): number {
  if (localGatewayProviderDefinition(providerId)?.adapter !== 'cc-switch-codex') {
    return compareModels(providerId, left, right);
  }
  const leftKey = ccSwitchSortKey(providerId, left.id);
  const rightKey = ccSwitchSortKey(providerId, right.id);
  return (
    leftKey.sourceRank - rightKey.sourceRank
    || compareModels(providerId, { ...left, id: leftKey.upstreamModelId }, { ...right, id: rightKey.upstreamModelId })
    || leftKey.sourceIndex - rightKey.sourceIndex
    || left.id.localeCompare(right.id)
  );
}

function ccSwitchSortKey(providerId: string, modelId: string): CcSwitchModelSortKey {
  const registered = ccSwitchModelSortKeysByProvider.get(providerId)?.get(modelId);
  if (registered) return registered;
  return {
    upstreamModelId: parseCcSwitchModelOptionId(modelId)?.modelId ?? modelId,
    sourceRank: 1,
    sourceIndex: Number.MAX_SAFE_INTEGER,
  };
}

function getElectronHomePath(): string | undefined {
  try {
    return electron.app.getPath('home');
  } catch {
    return undefined;
  }
}

function normalizeConfig(input: AgentProviderConfigInput): AgentProviderConfig {
  const providerId = normalizeProviderId(input.providerId);
  if (localGatewayProviderDefinition(providerId)) {
    return { providerId, enabled: input.enabled ?? true };
  }
  const baseUrl = input.baseUrl?.trim() || undefined;
  return { providerId, baseUrl, enabled: input.enabled ?? true };
}

async function providerCanRun(provider: AgentProviderConfig, secrets: SecretFile): Promise<boolean> {
  if (!provider.enabled) return false;
  const localGatewayProvider = localGatewayProviderDefinition(provider.providerId);
  if (localGatewayProvider?.adapter === 'cc-switch-codex') {
    const snapshot = await readCcSwitchRegistry();
    registerCcSwitchRuntimeModels(localGatewayProvider, snapshot);
    return snapshot.status === 'ready';
  }
  if (secrets.credentials[provider.providerId]) return true;
  if (provider.baseUrl) ensurePiCustomProvider(provider);
  if (isLocalBaseUrl(provider.baseUrl)) return true;
  return piProviderHasAmbientAuth(provider.providerId);
}

async function findUsableProvider(
  providers: AgentProviderConfig[],
  secrets: SecretFile,
): Promise<AgentProviderConfig | undefined> {
  for (const provider of providers) {
    if (await providerCanRun(provider, secrets)) return provider;
  }
  return undefined;
}

/**
 * One-time, startup cleanup of `agent-providers.json` (provider-config-cleanup A3).
 * Removes the literal bug shape — a keyless catalog row the old main-pane save side
 * effect produced — and repoints a now-dangling active pointer. Intentionally NOT
 * run on the read path: a write there raced concurrent writers and, fed the
 * degrading secret read, could prune rows from a transient read failure.
 *
 * Two hard safety rules, each guarding against permanent loss from a transient or
 * ambient signal:
 *
 * 1. If the secrets file cannot be read, do nothing: never prune, never write.
 *    The credential picture is unknown.
 * 2. Judge a row only by DURABLE, launch-stable signals: a stored secret-file
 *    credential, any deliberate `baseUrl`, and the provider kind. Ambient env
 *    keys are NOT consulted — they are launch-context-dependent (a Finder/Dock
 *    launch inherits no shell env), so judging on them would delete a deliberate
 *    row whenever the env happens to be absent. Managed (Bedrock/Vertex) and
 *    oauth kinds are exempt outright: managed credentials are always ambient, and
 *    oauth rows carry a stored credential.
 */
export async function reconcileProviderConfig(): Promise<{
  readonly activeProviderChanged: boolean;
}> {
  await piRestoreDynamicModels();
  const { secrets, readable } = await readSecretsWithStatus();
  if (!readable) return { activeProviderChanged: false }; // rule 1: credential picture unknown → touch nothing
  let activeProviderChanged = false;
  await mutateProviderFile((file) => {
    const previousActiveProviderId = file.activeProviderId;
    reconcileProviderFile(file, secrets);
    activeProviderChanged ||= file.activeProviderId !== previousActiveProviderId;
  });
  return Object.freeze({ activeProviderChanged });
}

/** Mutates `file` in place; returns whether anything changed. See `reconcileProviderConfig`. */
function reconcileProviderFile(file: ProviderConfigFile, secrets: SecretFile): boolean {
  let changed = false;

  const kept = file.providers.filter((provider) => !isPrunableJunkRow(provider, secrets));
  if (kept.length !== file.providers.length) {
    file.providers = kept;
    changed = true;
  }

  // Repoint the active pointer only when it is unset or DANGLING (no surviving row
  // by that id) — a purely structural check, never a credential judgment, so a
  // deliberately-active managed/env provider is never churned. Target the first row
  // holding a durable stored credential, else clear it; read paths
  // (`resolveUsableActiveProvider` / `getActiveProviderRuntimeConfig`) already fall
  // back through env/managed at runtime.
  const activeExists = file.providers.some((provider) => provider.providerId === file.activeProviderId);
  if (!file.activeProviderId || !activeExists) {
    const next = file.providers.find(
      (provider) => provider.enabled && secrets.credentials[provider.providerId],
    )?.providerId;
    if (file.activeProviderId !== next) {
      file.activeProviderId = next;
      changed = true;
    }
  }

  return changed;
}

/**
 * The literal bug shape, and ONLY it: a plain api-key catalog row with no durable
 * stored credential and no `baseUrl`. Exempts managed/oauth kinds and any row
 * with a stored credential or deliberate endpoint. Never consults ambient env
 * (see `reconcileProviderConfig` rule 2).
 */
function isPrunableJunkRow(provider: AgentProviderConfig, secrets: SecretFile): boolean {
  if (isExternalSecretProviderId(provider.providerId)) return false;        // deliberate external-secret row
  if (getProviderAuthKind(provider.providerId) !== 'api-key') return false; // exempt managed + oauth
  if (secrets.credentials[provider.providerId]) return false;               // durable stored credential
  if (provider.baseUrl) return false;                                       // deliberate endpoint
  return true;
}

function normalizeProviderId(providerIdInput: string) {
  const providerId = providerIdInput.trim();
  if (!providerId) throw new Error('providerId is required');
  return providerId;
}

function normalizeBaseUrl(baseUrl: string | null | undefined): string | undefined {
  return baseUrl?.trim() || undefined;
}

function providerConnectionGeneration(provider: AgentProviderConfig): number {
  return Number.isSafeInteger(provider.connectionGeneration) && (provider.connectionGeneration ?? -1) >= 0
    ? provider.connectionGeneration!
    : 0;
}

function allocateProviderConnectionGeneration(after = -1): number {
  providerConnectionGenerationClock = Math.max(
    providerConnectionGenerationClock + 1,
    after + 1,
  );
  return providerConnectionGenerationClock;
}

async function invalidateProviderConnection(providerId: string): Promise<void> {
  await mutateProviderFile((file) => {
    const provider = file.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) return;
    provider.connectionGeneration = allocateProviderConnectionGeneration(
      providerConnectionGeneration(provider),
    );
    delete provider.connectionCheck;
  });
}

function secretsEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function getSupportedReasoningLevelsForModel(model: Model<Api>): AgentReasoningLevel[] {
  return getSupportedThinkingLevels(model);
}

function getReasoningLevelLabelsForModel(model: Model<Api>): AgentReasoningLevelLabels | undefined {
  const labels: AgentReasoningLevelLabels = {};
  for (const level of AGENT_REASONING_LEVELS) {
    const mapped = model.thinkingLevelMap?.[level];
    if (typeof mapped === 'string' && mapped.trim()) labels[level] = mapped.trim();
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function isAgentReasoningLevel(value: unknown): value is AgentReasoningLevel {
  return typeof value === 'string' && (AGENT_REASONING_LEVELS as readonly string[]).includes(value);
}

function isAgentCacheRetention(value: unknown): value is AgentRuntimeSettings['providerCacheRetention'] {
  return typeof value === 'string' && (AGENT_CACHE_RETENTIONS as readonly string[]).includes(value);
}

async function readProviderFile(): Promise<ProviderConfigFile> {
  return readJsonOrDefault(providerPath(), { providers: [] });
}

async function mutateProviderFile(mutator: (file: ProviderConfigFile) => void | Promise<void>): Promise<ProviderConfigFile> {
  return updateJsonFile(
    providerPath(),
    { providers: [] },
    (value) => value as ProviderConfigFile,
    mutator,
  );
}

async function readSecretFile(): Promise<SecretFile> {
  const envelope = await readJsonOrDefault<SecretEnvelope>(secretPath(), {});
  return normalizeSecretFile(envelope);
}

/**
 * Read for read-only consumers (settings view, status, key resolution): malformed
 * files degrade to "no credentials" so the UI still renders. The write path uses
 * the throwing `readSecretFile` so it never clobbers a file it could not read.
 */
async function readSecretFileSafe(): Promise<SecretFile> {
  try {
    return await readSecretFile();
  } catch {
    return { credentials: {} };
  }
}

/**
 * Like `readSecretFileSafe` but reports whether the read actually succeeded. The
 * reconcile path needs this: an unreadable file degrades to empty credentials,
 * which must NOT be mistaken for "these providers have no credential" and drive a
 * destructive prune. `readable: false` means "credential picture unknown; do not
 * delete anything."
 */
async function readSecretsWithStatus(): Promise<{ secrets: SecretFile; readable: boolean }> {
  try {
    return { secrets: await readSecretFile(), readable: true };
  } catch {
    return { secrets: { credentials: {} }, readable: false };
  }
}

async function writeSecretFile(file: SecretFile) {
  const envelope: SecretEnvelope = { credentials: file.credentials };
  await writeJsonFile(secretPath(), envelope, PRIVATE_JSON_FILE_OPTIONS);
}

/**
 * Serialized read-modify-write of the secret file. The read uses the throwing
 * `readSecretFile`, so when the existing blob is unreadable the mutation aborts
 * instead of overwriting it (the #5 data-loss guard).
 */
async function mutateSecretFile(mutator: (file: SecretFile) => void): Promise<SecretFile> {
  return updateJsonFile(secretPath(), { credentials: {} }, normalizeSecretFile, (file) => {
    mutator(file);
  }, PRIVATE_JSON_FILE_OPTIONS);
}

async function readPiCredential(providerId: string): Promise<Credential | undefined> {
  const ccSwitchSource = parseCcSwitchRuntimeProviderId(providerId);
  if (ccSwitchSource) {
    const snapshot = await readCcSwitchRegistry();
    const source = snapshot.sources.find((candidate) => (
      candidate.appType === ccSwitchSource.appType
      && candidate.providerId === ccSwitchSource.providerId
      && candidate.routeKind === 'direct'
    ));
    const apiKey = source ? ccSwitchSourceApiKey(source) : undefined;
    return apiKey ? { type: 'api_key', key: apiKey } : undefined;
  }
  const localGatewayProvider = localGatewayProviderDefinition(providerId);
  if (localGatewayProvider?.externalSecret) return undefined;
  return toPiCredential((await readSecretFileSafe()).credentials[providerId]);
}

async function listPiCredentials(): Promise<readonly CredentialInfo[]> {
  return Object.entries((await readSecretFileSafe()).credentials)
    .flatMap(([providerId, credential]) => (
      credential.type === 'api_key' || credential.type === 'oauth'
        ? [{ providerId, type: credential.type }]
        : []
    ));
}

/**
 * pi's credential-store `modify` hook — the write path for logins AND for every
 * automatic OAuth token refresh, which `Models.getAuth()` runs under this lock.
 *
 * So it invalidates the connection verdict only when the credential is a
 * different *connection*, not on every write. Invalidating unconditionally meant
 * an OAuth verdict was wiped each time the access token rotated (roughly hourly),
 * and — worse — that it could never stick at all: pressing Test on an expired
 * token refreshes it mid-probe, which bumped the very generation
 * `prepareProviderConnectionProbe` had captured, so `recordProviderConnectionCheck`
 * silently discarded the successful result.
 */
async function modifyPiCredential(
  providerId: string,
  fn: (current: Credential | undefined) => Promise<Credential | undefined>,
): Promise<Credential | undefined> {
  let nextCredential: Credential | undefined;
  let connectionChanged = false;
  await withProviderCredentialMutation(providerId, async () => {
    await mutateSecretFileAsync(async (secrets) => {
      const currentCredential = toPiCredential(secrets.credentials[providerId]);
      nextCredential = await fn(currentCredential) ?? currentCredential;
      if (nextCredential) secrets.credentials[providerId] = fromPiCredential(nextCredential);
      connectionChanged = credentialConnectionChanged(currentCredential, nextCredential);
    });
    if (connectionChanged) await invalidateProviderConnection(providerId);
  });
  return nextCredential;
}

/**
 * Whether two stored credentials describe different connections.
 *
 * A verdict answers "does this credential reach this endpoint", so what identifies
 * it is the durable half: the api key, or the OAuth refresh token that identifies
 * the login. `access`/`expires` rotate underneath a single login and say nothing
 * about whether it still works.
 */
function credentialConnectionChanged(
  previous: Credential | undefined,
  next: Credential | undefined,
): boolean {
  if (!previous || !next) return Boolean(previous) !== Boolean(next);
  if (previous.type === 'api_key' && next.type === 'api_key') {
    return !secretsEqual(previous.key, next.key)
      || JSON.stringify(previous.env ?? null) !== JSON.stringify(next.env ?? null);
  }
  if (previous.type === 'oauth' && next.type === 'oauth') return !secretsEqual(previous.refresh, next.refresh);
  return true;
}

async function deletePiCredential(providerId: string): Promise<void> {
  await withProviderCredentialMutation(providerId, async () => {
    await mutateSecretFile((secrets) => {
      delete secrets.credentials[providerId];
    });
    await invalidateProviderConnection(providerId);
  });
}

async function withProviderCredentialMutation<T>(providerId: string, task: () => Promise<T>): Promise<T> {
  return providerCredentialMutations.run(providerId, task);
}

async function mutateSecretFileAsync(mutator: (file: SecretFile) => Promise<void>): Promise<SecretFile> {
  return updateJsonFile(secretPath(), { credentials: {} }, normalizeSecretFile, async (file) => {
    await mutator(file);
  }, PRIVATE_JSON_FILE_OPTIONS);
}

function toPiCredential(credential: AuthCredential | undefined): Credential | undefined {
  if (!credential) return undefined;
  if (credential.type === 'api_key') return { type: 'api_key', key: credential.key, env: credential.env };
  return credential;
}

function fromPiCredential(credential: Credential): AuthCredential {
  if (credential.type === 'api_key') return { type: 'api_key', key: credential.key, env: credential.env };
  return credential;
}

function normalizeSecretFile(value: unknown): SecretFile {
  const envelope = value && typeof value === 'object' && !Array.isArray(value)
    ? value as SecretEnvelope
    : {};
  const credentials = envelope.credentials;
  return { credentials: credentials && typeof credentials === 'object' ? credentials : {} };
}

async function readPiModelCatalog(
  providerId: string,
  options?: ModelsStoreOperationOptions,
): Promise<ModelsStoreEntry | undefined> {
  options?.signal?.throwIfAborted();
  const entry = (await readJsonOrDefault(
    modelCatalogsPath(),
    { catalogs: {} },
    normalizeModelCatalogFile,
  )).catalogs[providerId];
  options?.signal?.throwIfAborted();
  return entry;
}

async function writePiModelCatalog(
  providerId: string,
  entry: ModelsStoreEntry,
  options?: ModelsStoreOperationOptions,
): Promise<void> {
  options?.signal?.throwIfAborted();
  await updateJsonFile(
    modelCatalogsPath(),
    { catalogs: {} },
    normalizeModelCatalogFile,
    (file) => {
      options?.signal?.throwIfAborted();
      file.catalogs[providerId] = entry;
    },
    { ...PRIVATE_JSON_FILE_OPTIONS, signal: options?.signal },
  );
}

async function deletePiModelCatalog(
  providerId: string,
  options?: ModelsStoreOperationOptions,
): Promise<void> {
  options?.signal?.throwIfAborted();
  await updateJsonFile(
    modelCatalogsPath(),
    { catalogs: {} },
    normalizeModelCatalogFile,
    (file) => {
      options?.signal?.throwIfAborted();
      delete file.catalogs[providerId];
    },
    { ...PRIVATE_JSON_FILE_OPTIONS, signal: options?.signal },
  );
}

function normalizeModelCatalogFile(value: unknown): ModelCatalogFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { catalogs: {} };
  const catalogsValue = (value as { catalogs?: unknown }).catalogs;
  if (!catalogsValue || typeof catalogsValue !== 'object' || Array.isArray(catalogsValue)) return { catalogs: {} };
  const catalogs: Record<string, ModelsStoreEntry> = {};
  for (const [providerId, entry] of Object.entries(catalogsValue)) {
    if (isModelsStoreEntry(entry)) catalogs[providerId] = entry;
  }
  return { catalogs };
}

function isModelsStoreEntry(value: unknown): value is ModelsStoreEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<ModelsStoreEntry>;
  return Array.isArray(entry.models)
    && entry.models.every(isStoredModel)
    && (entry.lastModified === undefined || typeof entry.lastModified === 'number')
    && (entry.checkedAt === undefined || typeof entry.checkedAt === 'number')
    && (entry.etag === undefined || typeof entry.etag === 'string');
}

function isStoredModel(value: unknown): value is Model<Api> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const model = value as Partial<Model<Api>>;
  const cost = model.cost as Partial<Model<Api>['cost']> | undefined;
  return typeof model.id === 'string'
    && typeof model.name === 'string'
    && typeof model.api === 'string'
    && typeof model.provider === 'string'
    && typeof model.baseUrl === 'string'
    && typeof model.reasoning === 'boolean'
    && Array.isArray(model.input)
    && model.input.every((input) => input === 'text' || input === 'image')
    && Boolean(cost)
    && typeof cost?.input === 'number'
    && typeof cost.output === 'number'
    && typeof cost.cacheRead === 'number'
    && typeof cost.cacheWrite === 'number'
    && typeof model.contextWindow === 'number'
    && typeof model.maxTokens === 'number';
}

function providerPath() {
  return join(electron.app.getPath('userData'), PROVIDERS_FILE);
}

function secretPath() {
  return join(electron.app.getPath('userData'), SECRETS_FILE);
}

function modelCatalogsPath() {
  return join(electron.app.getPath('userData'), MODEL_CATALOGS_FILE);
}

/**
 * Validate a provider CONNECTION — credentials + endpoint reachability — not a
 * user-chosen model. The runtime picks its own probe model:
 *
 * 1. A known catalog model for the provider (the first after the ranking sort),
 *    probed with a 1-token completion.
 * 2. For a custom OpenAI-compatible endpoint with no catalog, list models at
 *    `{baseUrl}/models`; a non-empty list proves the connection.
 * 3. If no model can be discovered, return an honest error: the endpoint was
 *    reached but advertised no usable model.
 *
 * Keeps the old bounded behavior: short timeout, tiny output, no model field in
 * the UI.
 */
export async function testProviderConnection(input: {
  providerId: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const providerId = normalizeProviderId(input.providerId);
    const localGatewayProvider = localGatewayProviderDefinition(providerId);
    if (localGatewayProvider?.adapter === 'cc-switch-codex') {
      const snapshot = await readCcSwitchRegistry();
      registerCcSwitchRuntimeModels(localGatewayProvider, snapshot);
      if (snapshot.status !== 'ready') {
        return { success: false, message: snapshot.statusMessage ?? 'CC Switch has no direct-runnable registry provider.' };
      }
    }
    const baseUrl = localGatewayProvider ? undefined : input.baseUrl?.trim() || undefined;

    const explicitApiKey = input.apiKey?.trim();
    const requestAuth = explicitApiKey
      ? {
          apiKey: explicitApiKey,
          catalogCredential: { type: 'api_key' as const, key: explicitApiKey },
          listHeaders: { Authorization: `Bearer ${explicitApiKey}` },
        }
      : await resolveProviderConnectionAuth(providerId, baseUrl);
    if (!requestAuth) {
      return { success: false, message: 'API Key is missing.' };
    }
    const authOverride = requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {};

    let catalogModel = firstRankedModel(providerId);
    if (!catalogModel && requestAuth.catalogCredential && piProviderModelsRefreshable(providerId)) {
      const probeModels = await piFetchProviderModelsWithCredential(providerId, requestAuth.catalogCredential);
      catalogModel = rankProviderModels(providerId, probeModels)[0] ?? null;
    }

    // A custom base URL means the connection points at a proxy/gateway, which may
    // not host the catalog's first-ranked model — so discover the endpoint's own
    // models first (validate the connection, not a chosen model). Listing alone is
    // not enough (some gateways expose /models unauthenticated): prove the credential
    // too with a 1-token completion against a DISCOVERED (hosted) model.
    if (baseUrl) {
      try {
        const models = await listOpenAiCompatibleModels(baseUrl, requestAuth.listHeaders);
        if (models.length > 0) {
          const discoveredModelId = models[0]!;
          const model = createOpenAICompatibleModel({
            providerId,
            modelId: discoveredModelId,
            baseUrl,
            catalogModel: piFindModel(providerId, discoveredModelId),
          });
          const response = await piCompleteSimple(model, {
            messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
          }, {
            ...authOverride,
            ...providerStreamOptionsFromRuntimeSettings({ ...DEFAULT_AGENT_RUNTIME_SETTINGS, providerCacheRetention: 'short' }, model),
            ...customOpenAIResponsesPayloadProfileOption(),
            timeoutMs: 8000,
            maxTokens: 1,
          });
          assertProviderProbeSucceeded(response);
          return { success: true, message: `Connection successful. ${models.length} model(s) available.` };
        }
      } catch (listError) {
        // With no catalog model to fall back to, the listing/probe error IS the
        // result (its status maps to the auth/endpoint message below). With a catalog
        // model, the gateway may simply not expose /models — fall through and prove
        // reachability with a catalog completion probe instead.
        if (!catalogModel) throw listError;
      }
    }

    if (catalogModel) {
      const model = baseUrl ? { ...catalogModel, baseUrl } : { ...catalogModel };
      const response = await piCompleteSimple(model as Model<any>, {
        messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
      }, {
        ...authOverride,
        ...providerStreamOptionsFromRuntimeSettings({ ...DEFAULT_AGENT_RUNTIME_SETTINGS, providerCacheRetention: 'short' }, model),
        ...customOpenAIResponsesPayloadProfileOption(),
        timeoutMs: 8000,
        maxTokens: 1,
      });
      assertProviderProbeSucceeded(response);
      return { success: true, message: 'Connection successful.' };
    }

    if (baseUrl) {
      return { success: false, message: 'Reached the endpoint, but it advertised no usable model.' };
    }
    return { success: false, message: 'Reached the endpoint, but no usable model could be found.' };
  } catch (error: any) {
    const errMsg = redactProviderErrorMessage(error?.message || String(error));
    // Log only the message, never the raw error: provider SDK errors can embed the
    // Authorization header / API key, and oauth/refresh keys now route through here.
    console.error('Test connection failed:', errMsg);
    let message = `Connection failed: ${errMsg}`;
    let statusCode: number | undefined;

    if (errMsg.includes('401') || errMsg.toLowerCase().includes('unauthorized') || errMsg.toLowerCase().includes('invalid api key')) {
      statusCode = 401;
      message = 'Unauthorized (401): Please check your API Key.';
    } else if (errMsg.includes('404') || errMsg.toLowerCase().includes('not found') || errMsg.toLowerCase().includes('model_not_found')) {
      statusCode = 404;
      message = 'Not Found (404): Please check your Base URL or Model ID.';
    } else if (errMsg.includes('403') || errMsg.toLowerCase().includes('forbidden')) {
      statusCode = 403;
      message = 'Forbidden (403): You do not have permission to access this model.';
    } else if (errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('abort')) {
      message = 'Timeout: The request took longer than 8 seconds. Please check your network or Base URL.';
    }

    return { success: false, message, statusCode };
  }
}

function assertProviderProbeSucceeded(response: Awaited<ReturnType<typeof piCompleteSimple>>): void {
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(response.errorMessage || 'Provider connection probe failed.');
  }
}

async function resolveProviderConnectionAuth(providerId: string, baseUrl?: string): Promise<AgentProviderConnectionAuth | null> {
  const localGatewayProvider = localGatewayProviderDefinition(providerId);
  if (localGatewayProvider?.externalSecret) {
    if (localGatewayProvider.adapter === 'cc-switch-codex') {
      registerCcSwitchRuntimeModels(localGatewayProvider, await readCcSwitchRegistry());
      const model = firstRankedModel(providerId);
      if (!model) return null;
      const apiKey = await piResolveAuthApiKey(model);
      return apiKey && apiKey !== 'local-endpoint'
        ? { apiKey, listHeaders: { Authorization: `Bearer ${apiKey}` } }
        : {};
    }
    return null;
  }
  if (baseUrl) ensurePiCustomProvider({ providerId, baseUrl });
  const model = baseUrl
    ? createOpenAICompatibleModel({ providerId, modelId: '__tenon_openai_compatible_probe__', baseUrl })
    : firstRankedModel(providerId);
  try {
    const resolved = model
      ? await piModels().getAuth(model)
      : await piModels().getAuth(providerId);
    if (!resolved) return null;
    const headers = providerHeadersForModelList(resolved.auth, resolved.source);
    return {
      ...(!baseUrl && piProviderModelsRefreshable(providerId)
        ? { catalogCredential: await piResolveProviderRefreshCredential(providerId) }
        : {}),
      listHeaders: headers,
    };
  } catch {
    return null;
  }
}

function providerHeadersForModelList(auth: { apiKey?: string; headers?: Record<string, string | null> }, source?: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (auth.apiKey && source !== 'local endpoint') headers.Authorization = `Bearer ${auth.apiKey}`;
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function redactProviderErrorMessage(message: string): string {
  return redactSecretLikeContent(message);
}

/**
 * List models from an OpenAI-compatible `GET {baseUrl}/models`. Used to prove a
 * custom endpoint's connection when there is no catalog model to probe with.
 * Bounded (8s). A successful-but-unparseable body yields an empty list; a non-OK
 * response (or a timeout/abort) THROWS with the status, which `testProviderConnection`
 * maps to a precise auth/endpoint message (401/404/timeout) — strictly better than
 * a generic "no usable model".
 */
async function listOpenAiCompatibleModels(baseUrl: string, headers?: Record<string, string>, timeoutMs = 8000): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const body = await response.json() as { data?: unknown; models?: unknown };
    return parseOpenAiCompatibleModelIds(body);
  } finally {
    clearTimeout(timeout);
  }
}

function parseOpenAiCompatibleModelIds(body: { data?: unknown; models?: unknown }): string[] {
  const entries = Array.isArray(body?.data)
    ? body.data
    : (Array.isArray(body?.models) ? body.models : []);
  return entries
    .map(modelIdFromListEntry)
    .filter((id): id is string => Boolean(id));
}

function modelIdFromListEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null;
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  for (const key of ['id', 'model', 'slug']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
