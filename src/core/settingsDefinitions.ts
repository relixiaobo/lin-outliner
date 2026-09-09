import { MAX_DELEGATION_CONCURRENCY, MAX_DELEGATION_GLOBAL_QUEUE, MAX_DELEGATION_THREAD_QUEUE } from './delegationSettings';
import { DEFAULT_FILE_PREFERENCES } from './filePreferences';
import type { ConfigurationDestination, ConfigurationDomain } from './settingsWindow';

export type PreferenceValue = string | number | boolean | null;
export interface PreferenceDefinition {
  readonly id: string;
  readonly kind: 'boolean' | 'choice' | 'integer';
  readonly domain: ConfigurationDomain;
  readonly choices?: readonly PreferenceValue[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly nullable?: boolean;
}

/** Scalar source definitions shared by decoding, schema, discovery, and editing. */
export const PREFERENCE_DEFINITIONS = [
  { id: 'appearance.theme', kind: 'choice', domain: 'preferences', choices: ['system', 'light', 'dark'] },
  { id: 'appearance.language', kind: 'choice', domain: 'preferences', choices: [null, 'en', 'zh-Hans'] },
  { id: 'updates.checkAutomatically', kind: 'boolean', domain: 'preferences' },
  { id: 'agent.memory.enabled', kind: 'boolean', domain: 'preferences' },
  { id: 'agent.provider.timeoutMs', kind: 'integer', domain: 'models', minimum: 1, nullable: true },
  { id: 'agent.provider.maxRetries', kind: 'integer', domain: 'models', minimum: 0, nullable: true },
  { id: 'agent.provider.maxRetryDelayMs', kind: 'integer', domain: 'models', minimum: 1 },
  { id: 'agent.provider.cacheRetention', kind: 'choice', domain: 'models', choices: ['none', 'short', 'long'] },
  { id: 'agent.delegation.enabled', kind: 'boolean', domain: 'agents' },
  { id: 'agent.delegation.maxConcurrentGlobal', kind: 'integer', domain: 'agents', minimum: 1, maximum: MAX_DELEGATION_CONCURRENCY },
  { id: 'agent.delegation.maxConcurrentThread', kind: 'integer', domain: 'agents', minimum: 1, maximum: MAX_DELEGATION_CONCURRENCY },
  { id: 'agent.delegation.maxQueuedGlobal', kind: 'integer', domain: 'agents', minimum: 1, maximum: MAX_DELEGATION_GLOBAL_QUEUE },
  { id: 'agent.delegation.maxQueuedThread', kind: 'integer', domain: 'agents', minimum: 1, maximum: MAX_DELEGATION_THREAD_QUEUE },
] as const satisfies readonly PreferenceDefinition[];
export type PreferenceId = typeof PREFERENCE_DEFINITIONS[number]['id'];

/** Structured settings point at their real editor without loading its catalogs. */
export const CONFIGURATION_LINKS = [
  { destination: 'models', paths: ['models.connections', 'models.default', 'models.imageDefault'] },
  { destination: 'agents', paths: ['agent.delegation.defaultRunnerId', 'agent.delegation.runners', 'agent/config.json', '.tenon/agent.json', 'profile', 'tools', 'skills', 'presentation'] },
  { destination: 'skills', paths: ['agent.skills.sources', 'agent.skills.disabled'] },
  { destination: 'memory', paths: ['memory', 'retention', 'reset'] },
  { destination: 'access', paths: ['agent.tools.disabled', 'blocks'] },
  { destination: 'data', paths: ['data', 'cache', 'storage', 'preview'] },
  { destination: 'shortcuts', paths: ['keybindings.jsonc', 'keyboard', 'commands'] },
  { destination: 'diagnostics', paths: ['logs', 'diagnostics', 'export'] },
] as const satisfies readonly { destination: ConfigurationDestination; paths: readonly string[] }[];

export function preferenceDefinition(id: string): PreferenceDefinition | undefined {
  return PREFERENCE_DEFINITIONS.find((definition) => definition.id === id);
}

export function configurationValue(source: unknown, id: string): unknown {
  let value = source;
  for (const key of id.split('.')) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function preferenceDefault(id: PreferenceId): PreferenceValue {
  return configurationValue(DEFAULT_FILE_PREFERENCES, id) as PreferenceValue;
}

export function validatePreference(definition: PreferenceDefinition, value: unknown): asserts value is PreferenceValue {
  if (definition.kind === 'boolean' ? typeof value === 'boolean'
    : definition.kind === 'choice' ? definition.choices?.includes(value as PreferenceValue)
    : value === null ? definition.nullable
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= (definition.minimum ?? 0) && value <= (definition.maximum ?? Number.MAX_SAFE_INTEGER)) return;
  throw new Error(`Invalid value for ${definition.id}`);
}

export function preferenceSchema(definition: PreferenceDefinition): object {
  const defaultValue = preferenceDefault(definition.id as PreferenceId);
  if (definition.kind === 'choice') return { enum: definition.choices, default: defaultValue };
  if (definition.kind === 'boolean') return { type: 'boolean', default: defaultValue };
  return { type: definition.nullable ? ['integer', 'null'] : 'integer', minimum: definition.minimum, ...(definition.maximum === undefined ? {} : { maximum: definition.maximum }), default: defaultValue };
}

export interface PreferenceObservation {
  readonly id: PreferenceId;
  readonly value: PreferenceValue;
  readonly modified: boolean;
  readonly effectiveValue?: PreferenceValue;
  readonly application?: { readonly status: 'pending' | 'applied' | 'failed'; readonly error: string | null };
}
export interface PreferencesView {
  readonly source: {
    readonly path: string;
    readonly status: 'missing' | 'accepted' | 'rejected';
    readonly digest: string | null;
    readonly acceptedDigest: string | null;
    readonly error: string | null;
    readonly recoveryError: string | null;
  };
  readonly entries: readonly PreferenceObservation[];
  readonly structuredOverrides: readonly string[];
  readonly sources?: readonly ConfigurationSourceSummary[];
  /** Runtime application is reported separately from accepting source bytes. */
  readonly application: { readonly status: 'pending' | 'applied' | 'failed'; readonly error: string | null };
}
export interface PreferenceEdit {
  readonly id: PreferenceId;
  readonly expectedDigest: string | null;
  readonly operation: 'set' | 'reset';
  readonly value?: PreferenceValue;
}

export type PreferencesApplicationDomain = 'appearance' | 'memory' | 'updates' | 'skills' | 'access' | 'requests' | 'delegation' | 'models';
export type PreferencesApplicationState = Partial<Record<PreferencesApplicationDomain, {
  readonly status: 'pending' | 'applied' | 'failed';
  readonly error: string | null;
  readonly digest: string | null;
}>>;
export function preferenceApplicationDomain(id: string): PreferencesApplicationDomain {
  return id.startsWith('appearance.') ? 'appearance' : id.startsWith('updates.') ? 'updates'
    : id.startsWith('agent.memory.') ? 'memory' : id.startsWith('agent.provider.') ? 'requests' : 'delegation';
}

/** Bounded public-file observations, never runtime catalogs or private credentials. */
export interface ConfigurationSourceSummary {
  readonly destination: 'agents' | 'shortcuts';
  readonly sourceId: 'agent-user' | 'agent-project' | 'shortcuts';
  readonly path: string;
  readonly status: 'missing' | 'accepted' | 'rejected';
  readonly digest: string | null;
  readonly modified: boolean;
  readonly error: string | null;
}
