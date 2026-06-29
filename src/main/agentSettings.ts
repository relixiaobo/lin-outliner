import * as electron from 'electron';
import {
  getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import type { Api, Credential, Model, OAuthCredentials, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import type {
  AgentDelegationPermissionMode,
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
import { isLocalBaseUrl } from '../core/localEndpoint';
import { parseDateSchedule } from '../core/dateSchedule';
import { PRIVATE_JSON_FILE_OPTIONS, readJsonOrDefault, updateJsonFile, writeJsonFile } from './jsonFileStore';
import { compareModels } from './modelRanking';
import {
  configurePiCredentialStorage,
  createOpenAICompatibleModel,
  ensurePiCustomProvider,
  piCompleteSimple,
  piModels,
  piModelsForProvider,
  piProviderAuthKind,
  piProviderHasAmbientAuth,
  piProviders,
  piResolveAuthApiKey,
} from './piModels';

const PROVIDERS_FILE = 'agent-providers.json';
const SECRETS_FILE = 'agent-secrets.json';

// A provider config is a CONNECTION record only — credentials + endpoint. The
// model/effort that actually runs is owned by the agent profile (user/project
// `AgentDefinition`, or the built-in assistant's `builtInAgentProfiles` overlay
// below), never by the provider. See `docs/spec/agent-delegation-runtime.md`.
interface AgentProviderConfig {
  providerId: string;
  baseUrl?: string;
  enabled: boolean;
}

// Settings-owned editable profile for the built-in assistant (Neva), keyed by
// agentId. The built-in definition is code, not a file, so the user's edits layer
// here as an overlay on top of `createTenonAssistantAgentDefinition()` — keeping
// `name` (the stable id and memory anchor) fixed while everything the user sees is
// editable ([[single-agent-collapse]]). Absent fields fall back to the built-in
// default; an empty/`inherit` model or unset effort means "use the catalog default
// for the active provider", which the runtime coerces to the model's levels.
export interface StoredBuiltInAgentProfile {
  displayName?: string;
  description?: string;
  body?: string;
  model?: string;
  effort?: string;
  permissionMode?: AgentDelegationPermissionMode;
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  background?: boolean;
}

interface ProviderConfigFile {
  activeProviderId?: string;
  agent?: StoredAgentRuntimeSettings;
  providers: AgentProviderConfig[];
  builtInAgentProfiles?: Record<string, StoredBuiltInAgentProfile>;
}

type StoredAgentRuntimeSettings = Partial<AgentRuntimeSettings> & {
  permissionMode?: 'trusted' | 'restricted';
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

function getProviderAuthKind(providerId: string): AgentProviderAuthKind {
  return piProviderAuthKind(providerId);
}

const AGENT_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const AGENT_CACHE_RETENTIONS = ['none', 'short', 'long'] as const;
export const DEFAULT_DREAM_SCHEDULE = '2026-01-01T03:00 RRULE:FREQ=DAILY';
const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  automaticSkillsEnabled: true,
  slashSkillsEnabled: true,
  compactEnabled: true,
  dreamSchedule: DEFAULT_DREAM_SCHEDULE,
  additionalSkillDirectories: [],
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

interface AgentProviderConnectionAuth {
  apiKey?: string;
  listHeaders?: Record<string, string>;
}

configurePiCredentialStorage({
  read: readPiCredential,
  modify: modifyPiCredential,
  delete: deletePiCredential,
});

export async function getProviderSettings(): Promise<AgentProviderSettingsView> {
  // A pure read — never destructive. Junk-row cleanup happens once at startup via
  // `reconcileProviderConfig`, NOT on every read: a write on the read path both
  // raced concurrent writers and could prune rows from a transient read failure.
  // See `reconcileProviderConfig`.
  return toSettingsView(await readProviderFile(), await readSecretFileSafe());
}

export async function getAgentRuntimeSettings(): Promise<AgentRuntimeSettings> {
  return normalizeAgentRuntimeSettings((await readProviderFile()).agent);
}

export async function getActiveProviderRuntimeConfig(): Promise<AgentProviderRuntimeConfig | null> {
  const file = await readProviderFile();
  const secrets = await readSecretFileSafe();
  const active = await findUsableProvider(file.providers.filter((provider) => provider.providerId === file.activeProviderId), secrets)
    ?? await findUsableProvider(file.providers, secrets)
    ?? null;
  if (!active) return null;
  // Connection only. Do not bake auth here. pi `Models.applyAuth()` resolves
  // stored/env/oauth/provider-specific auth at request time; `apiKey` is only an
  // explicit override used by tests or the connection form's unsaved key.
  return { ...active };
}

/**
 * The settings-owned editable overlay for the built-in assistant (Neva). Built-in
 * definitions are code, so the user's edits (display name, persona, model/effort,
 * tools, skills, …) live here and layer over the code default. Empty when never
 * set — the runtime then falls back to the built-in default / provider catalog.
 */
export async function getBuiltInAgentProfile(agentId: string): Promise<StoredBuiltInAgentProfile> {
  const file = await readProviderFile();
  const stored = file.builtInAgentProfiles?.[agentId];
  if (!stored) return {};
  const profile: StoredBuiltInAgentProfile = {};
  if (typeof stored.displayName === 'string' && stored.displayName.trim()) profile.displayName = stored.displayName.trim();
  if (typeof stored.description === 'string' && stored.description.trim()) profile.description = stored.description.trim();
  if (typeof stored.body === 'string' && stored.body.trim()) profile.body = stored.body;
  if (typeof stored.model === 'string' && stored.model.trim()) profile.model = stored.model.trim();
  if (isAgentReasoningLevel(stored.effort)) profile.effort = stored.effort;
  if (stored.permissionMode === 'restricted') profile.permissionMode = stored.permissionMode;
  if (typeof stored.maxTurns === 'number' && Number.isInteger(stored.maxTurns) && stored.maxTurns > 0) profile.maxTurns = stored.maxTurns;
  const tools = normalizeBuiltInProfileStringList(stored.tools);
  if (tools) profile.tools = tools;
  const disallowedTools = normalizeBuiltInProfileStringList(stored.disallowedTools);
  if (disallowedTools) profile.disallowedTools = disallowedTools;
  const skills = normalizeBuiltInProfileStringList(stored.skills);
  if (skills) profile.skills = skills;
  if (typeof stored.background === 'boolean') profile.background = stored.background;
  return profile;
}

/**
 * Persist the built-in assistant's editable profile overlay. Each field clears when
 * empty/default (falling back to the code default); when every field clears, the
 * whole overlay entry is removed. The stable `name` is never stored here — it stays
 * the code constant so renaming Neva never orphans her memory ([[single-agent-collapse]]).
 */
export async function setBuiltInAgentProfile(
  agentId: string,
  input: {
    displayName?: string | null;
    description?: string | null;
    body?: string | null;
    model?: string | null;
    effort?: string | null;
    permissionMode?: AgentDelegationPermissionMode | null;
    maxTurns?: number | null;
    tools?: readonly string[] | null;
    disallowedTools?: readonly string[] | null;
    skills?: readonly string[] | null;
    background?: boolean | null;
  },
): Promise<void> {
  const id = agentId.trim();
  if (!id) throw new Error('agentId is required');
  const next: StoredBuiltInAgentProfile = {};
  const displayName = input.displayName?.trim();
  if (displayName) next.displayName = displayName;
  const description = input.description?.trim();
  if (description) next.description = description;
  if (typeof input.body === 'string' && input.body.trim()) next.body = input.body;
  const model = input.model?.trim();
  if (model && model !== 'inherit') next.model = model;
  if (isAgentReasoningLevel(input.effort)) next.effort = input.effort;
  if (input.permissionMode === 'restricted') next.permissionMode = input.permissionMode;
  if (typeof input.maxTurns === 'number' && Number.isInteger(input.maxTurns) && input.maxTurns > 0) next.maxTurns = input.maxTurns;
  const tools = normalizeBuiltInProfileStringList(input.tools);
  if (tools) next.tools = tools;
  const disallowedTools = normalizeBuiltInProfileStringList(input.disallowedTools);
  if (disallowedTools) next.disallowedTools = disallowedTools;
  const skills = normalizeBuiltInProfileStringList(input.skills);
  if (skills) next.skills = skills;
  if (input.background === true) next.background = true;
  const file = await readProviderFile();
  const profiles = { ...(file.builtInAgentProfiles ?? {}) };
  if (Object.keys(next).length === 0) delete profiles[id];
  else profiles[id] = next;
  file.builtInAgentProfiles = profiles;
  await writeProviderFile(file);
}

/** Trim + drop blanks, preserving order; returns undefined for an empty result. */
function normalizeBuiltInProfileStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
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
  // No auto-activation side effect (provider-config-cleanup A2): an upsert never
  // makes a provider active by itself — the credential may not be stored yet. Read
  // paths resolve the active provider by falling back through credentialed rows, so
  // a freshly credentialed provider is usable immediately; the startup reconcile
  // tidies the persisted activeProviderId at the next launch.
  await writeProviderFile(file);
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
  const file = await readProviderFile();
  if (file.providers.some((provider) => provider.providerId === providerId)) return;
  file.providers.push({ providerId, enabled: true });
  file.providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
  // The OAuth credential is persisted before this row is created, so read paths
  // resolve it as the active provider via the credentialed-row fallback even before
  // the startup reconcile tidies the persisted activeProviderId — no auto-activation
  // side effect needed here (provider-config-cleanup A2).
  await writeProviderFile(file);
}

/**
 * The runtime's default model for a provider connection: the first model after the
 * shared ranking sort (newest, thinking-capable first). Used as the connection
 * probe model and the catalog fallback when no agent profile names one. Returns
 * null for a custom endpoint with no catalog.
 */
/** A provider's catalog models, sorted by the shared ranking (newest, thinking-first). */
export function rankedModels(providerId: string): Model<Api>[] {
  try {
    const models = piModelsForProvider(providerId);
    return [...models].sort((left, right) => compareModels(providerId, left, right));
  } catch {
    return [];
  }
}

function firstRankedModel(providerId: string): Model<Api> | null {
  return rankedModels(providerId)[0] ?? null;
}

export async function deleteProviderConfig(providerIdInput: string) {
  const providerId = normalizeProviderId(providerIdInput);
  const file = await readProviderFile();
  const previousLength = file.providers.length;
  file.providers = file.providers.filter((provider) => provider.providerId !== providerId);
  if (file.providers.length === previousLength) throw new Error(`provider not found: ${providerId}`);
  if (file.activeProviderId === providerId) file.activeProviderId = file.providers[0]?.providerId;
  await writeProviderFile(file);
  await mutateSecretFile((secrets) => {
    delete secrets.credentials[providerId];
  });
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
  await mutateSecretFile((secrets) => {
    if (apiKey) {
      secrets.credentials[providerId] = { type: 'api_key', key: apiKey };
    } else if (secrets.credentials[providerId]?.type === 'api_key') {
      // Clearing the key field removes only a stored key — never an oauth login.
      delete secrets.credentials[providerId];
    }
  });
  return { providerId, hasApiKey: !!apiKey };
}

export async function deleteProviderApiKey(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  await mutateSecretFile((secrets) => {
    if (secrets.credentials[providerId]?.type === 'api_key') delete secrets.credentials[providerId];
  });
  return { providerId, hasApiKey: false };
}

export async function getProviderSecretStatus(providerIdInput: string): Promise<AgentProviderSecretStatus> {
  const providerId = normalizeProviderId(providerIdInput);
  const secrets = await readSecretFileSafe();
  return { providerId, hasApiKey: secrets.credentials[providerId]?.type === 'api_key' };
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
  await mutateSecretFile((secrets) => {
    secrets.credentials[providerId] = { type: 'oauth', ...credentials };
  });
}

/** Remove any stored credential for a provider (oauth sign-out). */
export async function deleteProviderCredential(providerIdInput: string): Promise<void> {
  const providerId = normalizeProviderId(providerIdInput);
  await mutateSecretFile((secrets) => {
    delete secrets.credentials[providerId];
  });
}

async function toSettingsView(file: ProviderConfigFile, secrets: SecretFile): Promise<AgentProviderSettingsView> {
  const availableProviders = await getAvailableProviders();
  return {
    activeProviderId: file.activeProviderId,
    agent: normalizeAgentRuntimeSettings(file.agent),
    providers: await Promise.all(file.providers.map(async (provider): Promise<AgentProviderConfigView> => {
      if (provider.baseUrl) ensurePiCustomProvider(provider);
      const cred = secrets.credentials[provider.providerId];
      const hasEnvApiKey = await piProviderHasAmbientAuth(provider.providerId);
      const authKind = getProviderAuthKind(provider.providerId);
      const oauthCred = cred?.type === 'oauth' ? cred : undefined;
      const hasStoredKey = cred?.type === 'api_key';
      const isKeylessLocalEndpoint = !cred && isLocalBaseUrl(provider.baseUrl);
      const auth: ProviderAuthView = {
        authKind,
        // Authoritative "can use models": any stored credential, env key, or
        // managed sentinel. Keyless local endpoints are allowed. Renderer reads
        // this instead of re-deriving.
        credentialed: Boolean(cred) || hasEnvApiKey || isKeylessLocalEndpoint,
        hasStoredKey,
        oauth: authKind === 'oauth'
          ? { connected: Boolean(oauthCred), expiresAt: oauthCred?.expires }
          : undefined,
      };
      return {
        providerId: provider.providerId,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        hasApiKey: hasStoredKey,
        hasEnvApiKey,
        auth,
      };
    })),
    availableProviders,
  };
}

function normalizeAgentRuntimeSettings(input?: StoredAgentRuntimeSettings | null): AgentRuntimeSettings {
  return {
    automaticSkillsEnabled: booleanOrDefault(input?.automaticSkillsEnabled, DEFAULT_AGENT_RUNTIME_SETTINGS.automaticSkillsEnabled),
    slashSkillsEnabled: booleanOrDefault(input?.slashSkillsEnabled, DEFAULT_AGENT_RUNTIME_SETTINGS.slashSkillsEnabled),
    compactEnabled: booleanOrDefault(input?.compactEnabled, DEFAULT_AGENT_RUNTIME_SETTINGS.compactEnabled),
    dreamSchedule: normalizeDreamSchedule(input?.dreamSchedule, DEFAULT_DREAM_SCHEDULE),
    additionalSkillDirectories: normalizeStringList(input?.additionalSkillDirectories),
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

function normalizeDreamSchedule(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed && parseDateSchedule(trimmed) ? trimmed : fallback;
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

async function getAvailableProviders(): Promise<AgentProviderOption[]> {
  return Promise.all(piProviders().map(async (providerId) => ({
    providerId,
    authKind: getProviderAuthKind(providerId),
    hasEnvApiKey: await piProviderHasAmbientAuth(providerId),
    envKeyNames: [],
    defaultBaseUrl: piModelsForProvider(providerId)[0]?.baseUrl,
    models: piModelsForProvider(providerId)
      .map((model): AgentModelOption => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        supportedThinkingLevels: getSupportedReasoningLevelsForModel(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
      .sort((left, right) => compareModels(providerId, left, right)),
  })));
}

function normalizeConfig(input: AgentProviderConfigInput): AgentProviderConfig {
  const providerId = normalizeProviderId(input.providerId);
  const baseUrl = input.baseUrl?.trim() || undefined;
  return { providerId, baseUrl, enabled: input.enabled ?? true };
}

async function providerCanRun(provider: AgentProviderConfig, secrets: SecretFile): Promise<boolean> {
  if (!provider.enabled) return false;
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
export async function reconcileProviderConfig(): Promise<void> {
  const { secrets, readable } = await readSecretsWithStatus();
  if (!readable) return; // rule 1: credential picture unknown → touch nothing
  const file = await readProviderFile();
  if (reconcileProviderFile(file, secrets)) {
    await writeProviderFile(file);
  }
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

function getSupportedReasoningLevelsForModel(model: Model<Api>): AgentReasoningLevel[] {
  return getSupportedThinkingLevels(model).filter(isAgentReasoningLevel);
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

async function writeProviderFile(file: ProviderConfigFile) {
  await writeJsonFile(providerPath(), file);
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
  return toPiCredential((await readSecretFileSafe()).credentials[providerId]);
}

async function modifyPiCredential(
  providerId: string,
  fn: (current: Credential | undefined) => Promise<Credential | undefined>,
): Promise<Credential | undefined> {
  let nextCredential: Credential | undefined;
  await mutateSecretFileAsync(async (secrets) => {
    const currentCredential = toPiCredential(secrets.credentials[providerId]);
    nextCredential = await fn(currentCredential) ?? currentCredential;
    if (nextCredential) secrets.credentials[providerId] = fromPiCredential(nextCredential);
  });
  return nextCredential;
}

async function deletePiCredential(providerId: string): Promise<void> {
  await mutateSecretFile((secrets) => {
    delete secrets.credentials[providerId];
  });
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

function providerPath() {
  return join(electron.app.getPath('userData'), PROVIDERS_FILE);
}

function secretPath() {
  return join(electron.app.getPath('userData'), SECRETS_FILE);
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
    const baseUrl = input.baseUrl?.trim() || undefined;

    const explicitApiKey = input.apiKey?.trim();
    const requestAuth = explicitApiKey
      ? { apiKey: explicitApiKey, listHeaders: { Authorization: `Bearer ${explicitApiKey}` } }
      : await resolveProviderConnectionAuth(providerId, baseUrl);
    if (!requestAuth) {
      return { success: false, message: 'API Key is missing.' };
    }
    const authOverride = requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {};

    const catalogModel = firstRankedModel(providerId);

    // A custom base URL means the connection points at a proxy/gateway, which may
    // not host the catalog's first-ranked model — so discover the endpoint's own
    // models first (validate the connection, not a chosen model). Listing alone is
    // not enough (some gateways expose /models unauthenticated): prove the credential
    // too with a 1-token completion against a DISCOVERED (hosted) model.
    if (baseUrl) {
      try {
        const models = await listOpenAiCompatibleModels(baseUrl, requestAuth.listHeaders);
        if (models.length > 0) {
          await piCompleteSimple(createOpenAICompatibleModel({ providerId, modelId: models[0], baseUrl }), {
            messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
          }, { ...authOverride, timeoutMs: 8000, maxTokens: 1 });
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
      await piCompleteSimple(model as Model<any>, {
        messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
      }, { ...authOverride, timeoutMs: 8000, maxTokens: 1 });
      return { success: true, message: 'Connection successful.' };
    }

    if (baseUrl) {
      return { success: false, message: 'Reached the endpoint, but it advertised no usable model.' };
    }
    return { success: false, message: 'Reached the endpoint, but no usable model could be found.' };
  } catch (error: any) {
    const errMsg = error?.message || String(error);
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

async function resolveProviderConnectionAuth(providerId: string, baseUrl?: string): Promise<AgentProviderConnectionAuth | null> {
  if (baseUrl) ensurePiCustomProvider({ providerId, baseUrl });
  const model = baseUrl
    ? createOpenAICompatibleModel({ providerId, modelId: '__tenon_openai_compatible_probe__', baseUrl })
    : firstRankedModel(providerId);
  if (!model) return null;
  try {
    const resolved = await piModels().getAuth(model);
    if (!resolved) return null;
    const headers = providerHeadersForModelList(resolved.auth);
    return {
      listHeaders: headers,
    };
  } catch {
    return null;
  }
}

function providerHeadersForModelList(auth: { apiKey?: string; headers?: Record<string, string | null> }): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * List models from an OpenAI-compatible `GET {baseUrl}/models`. Used to prove a
 * custom endpoint's connection when there is no catalog model to probe with.
 * Bounded (8s). A successful-but-unparseable body yields an empty list; a non-OK
 * response (or a timeout/abort) THROWS with the status, which `testProviderConnection`
 * maps to a precise auth/endpoint message (401/404/timeout) — strictly better than
 * a generic "no usable model".
 */
async function listOpenAiCompatibleModels(baseUrl: string, headers?: Record<string, string>): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const data = Array.isArray(body?.data) ? body.data : [];
    return data
      .map((entry) => (typeof entry?.id === 'string' ? entry.id : null))
      .filter((id): id is string => Boolean(id));
  } finally {
    clearTimeout(timeout);
  }
}
