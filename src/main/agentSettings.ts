import { app } from 'electron';
import {
  findEnvKeys,
  getEnvApiKey,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentModelOption,
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

export interface AgentProviderRuntimeConfig extends AgentProviderConfig {
  apiKey?: string;
}

export async function getProviderSettings(): Promise<AgentProviderSettingsView> {
  return toSettingsView(await readProviderFile(), await readSecretFile());
}

export async function getActiveProviderRuntimeConfig(): Promise<AgentProviderRuntimeConfig | null> {
  const file = await readProviderFile();
  const active = file.providers.find((provider) => provider.providerId === file.activeProviderId && provider.enabled)
    ?? file.providers.find((provider) => provider.enabled)
    ?? null;
  if (!active) return null;
  const secrets = await readSecretFile();
  const modelId = normalizeModelId(active.providerId, active.modelId);
  return {
    ...active,
    modelId,
    reasoningLevel: normalizeReasoningLevel(active.providerId, modelId, active.reasoningLevel),
    apiKey: secrets.keys[active.providerId],
  };
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

function getAvailableProviders(): AgentProviderOption[] {
  return getProviders().map((providerId) => ({
    providerId,
    hasEnvApiKey: !!getEnvApiKey(providerId),
    envKeyNames: findEnvKeys(providerId) ?? [],
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
