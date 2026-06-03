import * as electron from 'electron';
import {
  findEnvKeys,
  getEnvApiKey,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
  completeSimple,
} from '@earendil-works/pi-ai';
import type { Api, KnownProvider, Model, OAuthCredentials, OAuthProviderId, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { getOAuthApiKey, getOAuthProvider } from '@earendil-works/pi-ai/oauth';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentModelOption,
  AgentProviderAuthKind,
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentReasoningLevel,
  AgentProviderSecretStatus,
  AgentProviderSettingsView,
  ProviderAuthView,
} from '../core/types';
import { compareModels } from './modelRanking';

// safeStorage is accessed off the namespace (not a named import) so unit-test
// electron mocks that only provide `app` still link. Returns null when the OS
// keychain is unavailable → callers fall back to chmod-600 plaintext.
function activeSafeStorage(): typeof electron.safeStorage | null {
  const candidate = electron.safeStorage as typeof electron.safeStorage | undefined;
  return candidate && typeof candidate.isEncryptionAvailable === 'function' ? candidate : null;
}

const PROVIDERS_FILE = 'agent-providers.json';
const SECRETS_FILE = 'agent-secrets.json';

interface AgentProviderConfig {
  providerId: string;
  modelId: string;
  reasoningLevel: AgentReasoningLevel;
  baseUrl?: string;
  enabled: boolean;
}

interface ProviderConfigFile {
  activeProviderId?: string;
  agent?: Partial<AgentRuntimeSettings>;
  providers: AgentProviderConfig[];
}

// Stored credential shape — mirrors pi-mono's coding-agent `AuthCredential`
// (discriminated on `type`, oauth flattened) so we reuse its shape rather than
// invent one. A provider holds at most one stored credential: signing in writes
// an `oauth` entry, pasting a key writes an `api_key` entry, switching replaces.
// `managed` providers never appear here; env keys are read, never stored.
type ApiKeyCredential = { type: 'api_key'; key: string };
type OAuthStoredCredential = { type: 'oauth' } & OAuthCredentials;
type AuthCredential = ApiKeyCredential | OAuthStoredCredential;

interface SecretFile {
  credentials: Record<string, AuthCredential>;
}

// On-disk envelope. When safeStorage (OS keychain) is available the whole
// SecretFile is encrypted into `enc`; otherwise it is written in `credentials`
// as plaintext (still chmod 600). See D1 in docs/plans/agent-oauth-providers.md.
interface SecretEnvelope {
  enc?: string;
  credentials?: Record<string, AuthCredential>;
}

// pi-ai inlines `'amazon-bedrock'` / `'google-vertex'` in getEnvApiKey and
// exports no classifier, so we mirror that one small set here.
const MANAGED_PROVIDERS = new Set<string>(['amazon-bedrock', 'google-vertex']);

function getProviderAuthKind(providerId: string): AgentProviderAuthKind {
  if (getOAuthProvider(providerId as OAuthProviderId)) return 'oauth';
  if (MANAGED_PROVIDERS.has(providerId)) return 'managed';
  return 'api-key';
}

const MODEL_ID_REPLACEMENTS: Record<string, Record<string, string>> = {
  anthropic: {
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
  },
};

const AGENT_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const AGENT_PERMISSION_MODES = ['trusted', 'restricted'] as const;
const AGENT_CACHE_RETENTIONS = ['none', 'short', 'long'] as const;
const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  permissionMode: 'trusted',
  automaticSkillsEnabled: true,
  slashSkillsEnabled: true,
  compactEnabled: true,
  additionalSkillDirectories: [],
  additionalAgentDirectories: [],
  providerTimeoutMs: null,
  providerMaxRetries: null,
  providerMaxRetryDelayMs: 60_000,
  providerCacheRetention: 'short',
  disabledSkills: [],
  disabledAgents: [],
};

export interface AgentProviderRuntimeConfig extends AgentProviderConfig {
  apiKey?: string;
}

export async function getProviderSettings(): Promise<AgentProviderSettingsView> {
  return toSettingsView(await readProviderFile(), await readSecretFile());
}

export async function getAgentRuntimeSettings(): Promise<AgentRuntimeSettings> {
  return normalizeAgentRuntimeSettings((await readProviderFile()).agent);
}

export async function getActiveProviderRuntimeConfig(): Promise<AgentProviderRuntimeConfig | null> {
  const file = await readProviderFile();
  const secrets = await readSecretFile();
  const active = file.providers.find((provider) => provider.providerId === file.activeProviderId && providerHasCredential(provider, secrets))
    ?? file.providers.find((provider) => providerHasCredential(provider, secrets))
    ?? null;
  if (!active) return null;
  const modelId = normalizeModelId(active.providerId, active.modelId);
  // Do not bake the key here — this path is sync and cannot await an OAuth
  // refresh. Consumers resolve lazily via getProviderApiKey (the single async
  // resolver) at request time; leaving apiKey undefined routes them there.
  return {
    ...active,
    modelId,
    reasoningLevel: normalizeReasoningLevel(active.providerId, modelId, active.reasoningLevel),
  };
}

export async function updateAgentRuntimeSettings(input: AgentRuntimeSettingsInput) {
  const file = await readProviderFile();
  file.agent = normalizeAgentRuntimeSettings({
    ...normalizeAgentRuntimeSettings(file.agent),
    ...input,
  });
  await writeProviderFile(file);
  return getProviderSettings();
}

export function providerStreamOptionsFromRuntimeSettings(
  settings?: Pick<
    AgentRuntimeSettings,
    'providerTimeoutMs' | 'providerMaxRetries' | 'providerMaxRetryDelayMs' | 'providerCacheRetention'
  > | null,
): Pick<SimpleStreamOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention'> {
  const options: Pick<SimpleStreamOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention'> = {};
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
  return options;
}

export async function upsertProviderConfig(input: AgentProviderConfigInput) {
  const config = normalizeConfig(input);
  const file = await readProviderFile();
  const index = file.providers.findIndex((provider) => provider.providerId === config.providerId);
  if (index >= 0) file.providers[index] = config;
  else file.providers.push(config);
  file.providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
  file.activeProviderId ??= file.providers[0]?.providerId;
  await writeProviderFile(file);
  return getProviderSettings();
}

export async function deleteProviderConfig(providerIdInput: string) {
  const providerId = normalizeProviderId(providerIdInput);
  const file = await readProviderFile();
  const previousLength = file.providers.length;
  file.providers = file.providers.filter((provider) => provider.providerId !== providerId);
  if (file.providers.length === previousLength) throw new Error(`provider not found: ${providerId}`);
  if (file.activeProviderId === providerId) file.activeProviderId = file.providers[0]?.providerId;
  await writeProviderFile(file);
  const secrets = await readSecretFile();
  if (providerId in secrets.credentials) {
    delete secrets.credentials[providerId];
    await writeSecretFile(secrets);
  }
  return getProviderSettings();
}

export async function setActiveProvider(providerIdInput: string) {
  const providerId = normalizeProviderId(providerIdInput);
  const file = await readProviderFile();
  if (!file.providers.some((provider) => provider.providerId === providerId)) {
    throw new Error(`provider not found: ${providerId}`);
  }
  file.activeProviderId = providerId;
  await writeProviderFile(file);
  return getProviderSettings();
}

export async function setProviderApiKey(providerIdInput: string, apiKeyInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  const apiKey = apiKeyInput.trim();
  const secrets = await readSecretFile();
  if (apiKey) {
    secrets.credentials[providerId] = { type: 'api_key', key: apiKey };
  } else if (secrets.credentials[providerId]?.type === 'api_key') {
    // Clearing the key field removes only a stored key — never an oauth login.
    delete secrets.credentials[providerId];
  }
  await writeSecretFile(secrets);
  return { providerId, hasApiKey: !!apiKey };
}

export async function deleteProviderApiKey(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFile();
  if (secrets.credentials[providerId]?.type === 'api_key') delete secrets.credentials[providerId];
  await writeSecretFile(secrets);
  return { providerId, hasApiKey: false };
}

export async function getProviderSecretStatus(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFile();
  return { providerId, hasApiKey: secrets.credentials[providerId]?.type === 'api_key' };
}

/**
 * The single resolver for a provider's usable API key. Auth-kind-agnostic: it
 * tries the stored credential, then env (which also yields the `"<authenticated>"`
 * sentinel for managed Bedrock/Vertex). For an oauth credential it auto-refreshes
 * via pi-ai's getOAuthApiKey and persists the rotated tokens. This is the body of
 * pi-agent-core's per-call `getApiKey` hook, so refresh happens at request time.
 * Per that hook's contract it never throws — it returns undefined when no key.
 */
export async function getProviderApiKey(providerIdInput: string): Promise<string | undefined> {
  try {
    const providerId = normalizeProviderId(providerIdInput);
    const secrets = await readSecretFile();
    const cred = secrets.credentials[providerId];
    if (cred?.type === 'api_key') return cred.key;
    if (cred?.type === 'oauth') {
      const { type: _type, ...stored } = cred;
      const result = await getOAuthApiKey(providerId as OAuthProviderId, { [providerId]: stored });
      if (result) {
        if (oauthCredentialsChanged(stored, result.newCredentials)) {
          await persistOAuthCredential(providerId, result.newCredentials);
        }
        return result.apiKey;
      }
    }
    return getEnvApiKey(providerId);
  } catch {
    return undefined;
  }
}

/** Persist an oauth login / a rotated token. The only writer of oauth credentials. */
export async function persistOAuthCredential(providerIdInput: string, credentials: OAuthCredentials): Promise<void> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFile();
  secrets.credentials[providerId] = { type: 'oauth', ...credentials };
  await writeSecretFile(secrets);
}

function oauthCredentialsChanged(a: OAuthCredentials, b: OAuthCredentials): boolean {
  return a.access !== b.access || a.refresh !== b.refresh || a.expires !== b.expires;
}

function toSettingsView(file: ProviderConfigFile, secrets: SecretFile): AgentProviderSettingsView {
  const availableProviders = getAvailableProviders();
  return {
    activeProviderId: file.activeProviderId,
    agent: normalizeAgentRuntimeSettings(file.agent),
    providers: file.providers.map((provider): AgentProviderConfigView => {
      const modelId = normalizeModelId(provider.providerId, provider.modelId);
      const cred = secrets.credentials[provider.providerId];
      const hasStoredKey = cred?.type === 'api_key';
      const hasEnvApiKey = !!getEnvApiKey(provider.providerId);
      const authKind = getProviderAuthKind(provider.providerId);
      const oauthCred = cred?.type === 'oauth' ? cred : undefined;
      const auth: ProviderAuthView = {
        authKind,
        // Authoritative "can use models": any stored credential, env key, or
        // managed sentinel. Renderer reads this instead of re-deriving.
        credentialed: Boolean(cred) || hasEnvApiKey,
        hasStoredKey,
        oauth: authKind === 'oauth'
          ? { connected: Boolean(oauthCred), expiresAt: oauthCred?.expires }
          : undefined,
      };
      return {
        providerId: provider.providerId,
        modelId,
        reasoningLevel: normalizeReasoningLevel(provider.providerId, modelId, provider.reasoningLevel),
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        hasApiKey: hasStoredKey,
        hasEnvApiKey,
        auth,
      };
    }),
    availableProviders,
  };
}

function normalizeAgentRuntimeSettings(input?: Partial<AgentRuntimeSettings> | null): AgentRuntimeSettings {
  return {
    permissionMode: isAgentPermissionMode(input?.permissionMode)
      ? input.permissionMode
      : DEFAULT_AGENT_RUNTIME_SETTINGS.permissionMode,
    automaticSkillsEnabled: booleanOrDefault(input?.automaticSkillsEnabled, DEFAULT_AGENT_RUNTIME_SETTINGS.automaticSkillsEnabled),
    slashSkillsEnabled: booleanOrDefault(input?.slashSkillsEnabled, DEFAULT_AGENT_RUNTIME_SETTINGS.slashSkillsEnabled),
    compactEnabled: booleanOrDefault(input?.compactEnabled, DEFAULT_AGENT_RUNTIME_SETTINGS.compactEnabled),
    additionalSkillDirectories: normalizeStringList(input?.additionalSkillDirectories),
    additionalAgentDirectories: normalizeStringList(input?.additionalAgentDirectories),
    providerTimeoutMs: normalizeNullablePositiveInteger(input?.providerTimeoutMs, DEFAULT_AGENT_RUNTIME_SETTINGS.providerTimeoutMs),
    providerMaxRetries: normalizeNullableNonNegativeInteger(input?.providerMaxRetries, DEFAULT_AGENT_RUNTIME_SETTINGS.providerMaxRetries),
    providerMaxRetryDelayMs: normalizeNullableNonNegativeInteger(
      input?.providerMaxRetryDelayMs,
      DEFAULT_AGENT_RUNTIME_SETTINGS.providerMaxRetryDelayMs,
    ),
    providerCacheRetention: isAgentCacheRetention(input?.providerCacheRetention)
      ? input.providerCacheRetention
      : DEFAULT_AGENT_RUNTIME_SETTINGS.providerCacheRetention,
    disabledSkills: normalizeStringList(input?.disabledSkills),
    disabledAgents: normalizeStringList(input?.disabledAgents),
  };
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 20);
}

function normalizeNullablePositiveInteger(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return normalizeInteger(value, fallback, 1);
}

function normalizeNullableNonNegativeInteger(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return normalizeInteger(value, fallback, 0);
}

function normalizeInteger(value: unknown, fallback: number | null, min: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= min ? normalized : fallback;
}

function getAvailableProviders(): AgentProviderOption[] {
  return getProviders().map((providerId) => ({
    providerId,
    hasEnvApiKey: !!getEnvApiKey(providerId),
    envKeyNames: findEnvKeys(providerId) ?? [],
    defaultBaseUrl: getModels(providerId)[0]?.baseUrl,
    models: getModels(providerId)
      .map((model): AgentModelOption => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        supportedThinkingLevels: getSupportedReasoningLevelsForModel(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
      .sort((left, right) => compareModels(providerId, left, right)),
  }));
}

function normalizeConfig(input: AgentProviderConfigInput): AgentProviderConfig {
  const providerId = normalizeProviderId(input.providerId);
  const modelId = normalizeModelId(providerId, input.modelId.trim());
  if (!modelId) throw new Error('modelId is required');
  const reasoningLevel = normalizeReasoningLevel(providerId, modelId, input.reasoningLevel);
  const baseUrl = input.baseUrl?.trim() || undefined;
  return { providerId, modelId, reasoningLevel, baseUrl, enabled: input.enabled ?? true };
}

function providerHasCredential(provider: AgentProviderConfig, secrets: SecretFile): boolean {
  // A stored credential (api_key or oauth login), an env key, or a managed
  // ambient sentinel all count. Kind-agnostic, mirroring the resolver.
  return provider.enabled && Boolean(secrets.credentials[provider.providerId] || getEnvApiKey(provider.providerId));
}

function normalizeProviderId(providerIdInput: string) {
  const providerId = providerIdInput.trim();
  if (!providerId) throw new Error('providerId is required');
  return providerId;
}

function normalizeModelId(providerId: string, modelId: string) {
  return MODEL_ID_REPLACEMENTS[providerId]?.[modelId] ?? modelId;
}

function normalizeReasoningLevel(
  providerId: string,
  modelId: string,
  reasoningLevelInput?: string,
): AgentReasoningLevel {
  const requested = isAgentReasoningLevel(reasoningLevelInput) ? reasoningLevelInput : 'off';
  const supported = getSupportedReasoningLevels(providerId, modelId);
  if (supported.includes(requested)) return requested;
  if (supported.includes('off')) return 'off';
  return supported[0] ?? 'off';
}

function getSupportedReasoningLevels(providerId: string, modelId: string): AgentReasoningLevel[] {
  const model = findKnownModel(providerId, modelId);
  if (!model) return ['off'];
  return getSupportedReasoningLevelsForModel(model);
}

function getSupportedReasoningLevelsForModel(model: Model<Api>): AgentReasoningLevel[] {
  return getSupportedThinkingLevels(model).filter(isAgentReasoningLevel);
}

function findKnownModel(providerId: string, modelId: string): Model<Api> | null {
  try {
    return getModels(providerId as KnownProvider).find((model) => model.id === modelId) as Model<Api> | undefined ?? null;
  } catch {
    return null;
  }
}

function isAgentReasoningLevel(value: unknown): value is AgentReasoningLevel {
  return typeof value === 'string' && (AGENT_REASONING_LEVELS as readonly string[]).includes(value);
}

function isAgentPermissionMode(value: unknown): value is AgentRuntimeSettings['permissionMode'] {
  return typeof value === 'string' && (AGENT_PERMISSION_MODES as readonly string[]).includes(value);
}

function isAgentCacheRetention(value: unknown): value is AgentRuntimeSettings['providerCacheRetention'] {
  return typeof value === 'string' && (AGENT_CACHE_RETENTIONS as readonly string[]).includes(value);
}

async function readProviderFile(): Promise<ProviderConfigFile> {
  return readJsonOrDefault(providerPath(), { providers: [] });
}

async function writeProviderFile(file: ProviderConfigFile) {
  await writeJsonFile(providerPath(), file, false);
}

async function readSecretFile(): Promise<SecretFile> {
  const envelope = await readJsonOrDefault<SecretEnvelope>(secretPath(), {});
  if (typeof envelope.enc === 'string') {
    const store = activeSafeStorage();
    if (!store?.isEncryptionAvailable()) return { credentials: {} };
    try {
      const json = store.decryptString(Buffer.from(envelope.enc, 'base64'));
      return normalizeSecretFile(JSON.parse(json));
    } catch {
      return { credentials: {} };
    }
  }
  return normalizeSecretFile(envelope);
}

async function writeSecretFile(file: SecretFile) {
  const store = activeSafeStorage();
  const envelope: SecretEnvelope = store?.isEncryptionAvailable()
    ? { enc: store.encryptString(JSON.stringify(file)).toString('base64') }
    : { credentials: file.credentials };
  await writeJsonFile(secretPath(), envelope, true);
}

function normalizeSecretFile(value: SecretEnvelope): SecretFile {
  const credentials = value.credentials;
  return { credentials: credentials && typeof credentials === 'object' ? credentials : {} };
}

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown, privateFile: boolean) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  if (privateFile && process.platform !== 'win32') await chmod(parent, 0o700);
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  if (privateFile && process.platform !== 'win32') await chmod(path, 0o600);
}

async function atomicWrite(path: string, data: string) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

function providerPath() {
  return join(electron.app.getPath('userData'), PROVIDERS_FILE);
}

function secretPath() {
  return join(electron.app.getPath('userData'), SECRETS_FILE);
}

export async function testProviderConnection(input: {
  providerId: string;
  modelId: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const providerId = normalizeProviderId(input.providerId);
    const modelId = input.modelId.trim();
    if (!modelId) {
      return { success: false, message: 'Model ID is required.' };
    }

    let apiKey = input.apiKey?.trim();
    if (!apiKey) {
      // The single resolver handles api-key, oauth refresh, env, and managed.
      apiKey = await getProviderApiKey(providerId);
    }

    if (!apiKey) {
      return { success: false, message: 'API Key is missing.' };
    }

    const model = getTempModelForTest(providerId, modelId);
    
    const streamOptions: SimpleStreamOptions = {
      apiKey,
      timeoutMs: 8000,
      maxTokens: 1,
    };
    
    const baseUrl = input.baseUrl?.trim();
    if (baseUrl) {
      model.baseUrl = baseUrl;
    }

    await completeSimple(model as Model<any>, {
      messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
    }, streamOptions);

    return { success: true, message: 'Connection successful.' };
  } catch (error: any) {
    console.error('Test connection failed:', error);
    const errMsg = error?.message || String(error);
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

function getTempModelForTest(providerId: string, modelId: string): Model<any> {
  const known = findKnownModel(providerId, modelId);
  if (known) return { ...known };
  let first: any = null;
  try {
    const list = getModels(providerId as KnownProvider);
    first = list[0];
  } catch {}
  return {
    id: modelId,
    name: modelId,
    api: first ? first.api : 'openai-completions',
    provider: providerId,
    baseUrl: first ? first.baseUrl : '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}
