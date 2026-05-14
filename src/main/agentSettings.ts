import { app } from 'electron';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentProviderSecretStatus,
  AgentProviderSettingsView,
} from '../core/types';

const PROVIDERS_FILE = 'agent-providers.json';
const SECRETS_FILE = 'agent-secrets.json';

interface AgentProviderConfig {
  providerId: string;
  modelId: string;
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

export async function getProviderSettings(): Promise<AgentProviderSettingsView> {
  return toSettingsView(await readProviderFile(), await readSecretFile());
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

function toSettingsView(file: ProviderConfigFile, secrets: SecretFile): AgentProviderSettingsView {
  return {
    activeProviderId: file.activeProviderId,
    providers: file.providers.map((provider): AgentProviderConfigView => ({
      providerId: provider.providerId,
      modelId: provider.modelId,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      hasApiKey: provider.providerId in secrets.keys,
    })),
  };
}

function normalizeConfig(input: AgentProviderConfigInput): AgentProviderConfig {
  const providerId = normalizeProviderId(input.providerId);
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error('modelId is required');
  const baseUrl = input.baseUrl?.trim() || undefined;
  return { providerId, modelId, baseUrl, enabled: input.enabled ?? false };
}

function normalizeProviderId(providerIdInput: string) {
  const providerId = providerIdInput.trim();
  if (!providerId) throw new Error('providerId is required');
  return providerId;
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

