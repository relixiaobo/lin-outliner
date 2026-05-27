import { app } from 'electron';
import {
  findEnvKeys,
  getEnvApiKey,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import type { Api, KnownProvider, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentModelOption,
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentReasoningLevel,
  AgentProviderSecretStatus,
  AgentProviderSettingsView,
} from '../core/types';

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

interface SecretFile {
  keys: Record<string, string>;
}

const MODEL_ID_REPLACEMENTS: Record<string, Record<string, string>> = {
  anthropic: {
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
  },
};

const PREFERRED_MODEL_IDS: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-sonnet-4-0',
    'claude-3-7-sonnet-20250219',
  ],
  openai: [
    'gpt-5.2',
    'gpt-5.1',
    'gpt-4.1',
    'gpt-4o',
  ],
  google: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
  ],
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
  return {
    ...active,
    modelId,
    reasoningLevel: normalizeReasoningLevel(active.providerId, modelId, active.reasoningLevel),
    apiKey: secrets.keys[active.providerId] ?? getEnvApiKey(active.providerId),
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
  if (providerId in secrets.keys) {
    delete secrets.keys[providerId];
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
  if (apiKey) secrets.keys[providerId] = apiKey;
  else delete secrets.keys[providerId];
  await writeSecretFile(secrets);
  return { providerId, hasApiKey: !!apiKey };
}

export async function deleteProviderApiKey(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFile();
  delete secrets.keys[providerId];
  await writeSecretFile(secrets);
  return { providerId, hasApiKey: false };
}

export async function getProviderSecretStatus(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFile();
  return { providerId, hasApiKey: providerId in secrets.keys };
}

export async function getProviderApiKey(providerIdInput: string): Promise<string | undefined> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFile();
  return secrets.keys[providerId];
}

function toSettingsView(file: ProviderConfigFile, secrets: SecretFile): AgentProviderSettingsView {
  const availableProviders = getAvailableProviders();
  return {
    activeProviderId: file.activeProviderId,
    agent: normalizeAgentRuntimeSettings(file.agent),
    providers: file.providers.map((provider): AgentProviderConfigView => {
      const modelId = normalizeModelId(provider.providerId, provider.modelId);
      return {
        providerId: provider.providerId,
        modelId,
        reasoningLevel: normalizeReasoningLevel(provider.providerId, modelId, provider.reasoningLevel),
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        hasApiKey: provider.providerId in secrets.keys,
        hasEnvApiKey: !!getEnvApiKey(provider.providerId),
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
      .sort((left, right) => modelPreferenceRank(providerId, left.id) - modelPreferenceRank(providerId, right.id)),
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
  return provider.enabled && Boolean(secrets.keys[provider.providerId] || getEnvApiKey(provider.providerId));
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

function modelPreferenceRank(providerId: string, modelId: string) {
  const preferred = PREFERRED_MODEL_IDS[providerId] ?? [];
  const index = preferred.indexOf(modelId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

async function readProviderFile(): Promise<ProviderConfigFile> {
  return readJsonOrDefault(providerPath(), { providers: [] });
}

async function writeProviderFile(file: ProviderConfigFile) {
  await writeJsonFile(providerPath(), file, false);
}

async function readSecretFile(): Promise<SecretFile> {
  return readJsonOrDefault(secretPath(), { keys: {} });
}

async function writeSecretFile(file: SecretFile) {
  await writeJsonFile(secretPath(), file, true);
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
  return join(app.getPath('userData'), PROVIDERS_FILE);
}

function secretPath() {
  return join(app.getPath('userData'), SECRETS_FILE);
}
