import { PREFERENCE_DEFINITIONS, configurationValue, validatePreference } from '../../core/settingsDefinitions';
import { DEFAULT_FILE_PREFERENCES, type FilePreferences } from '../../core/filePreferences';
export { DEFAULT_FILE_PREFERENCES, type FilePreferences } from '../../core/filePreferences';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdits,
  modify as jsoncModify,
  parse,
  parseTree,
  type JSONPath,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { atomicWriteFileSync, writeJsonFileSync } from '../jsonFileStore';
import type { AgentDelegationSettings, AgentReasoningLevel, AgentSkillSourceBinding } from '../../core/types';

export const FILE_PREFERENCES_RELATIVE_PATH = join('config', 'settings.jsonc');
export const MAX_FILE_PREFERENCES_BYTES = 256 * 1024;
const RECOVERY_FILE = join('config', 'settings.last-known-good.json');

export type FilePreferencesSourceStatus = 'missing' | 'accepted' | 'rejected';

export interface FilePreferencesLoadResult {
  readonly path: string;
  readonly sourceStatus: FilePreferencesSourceStatus;
  readonly sourceBytes: string | null;
  readonly sourceDigest: string | null;
  readonly acceptedDigest: string | null;
  readonly recoveryError: string | null;
  readonly preferences: FilePreferences;
  readonly error: string | null;
}

const TOP_LEVEL_KEYS = new Set(['appearance', 'agent', 'updates', 'models']);
const APPEARANCE_KEYS = new Set(['theme', 'language']);
const AGENT_KEYS = new Set(['memory', 'skills', 'tools', 'provider', 'delegation']);
const MEMORY_KEYS = new Set(['enabled']);
const SKILLS_KEYS = new Set(['disabled', 'sources']);
const TOOLS_KEYS = new Set(['disabled']);
const PROVIDER_KEYS = new Set(['timeoutMs', 'maxRetries', 'maxRetryDelayMs', 'cacheRetention']);
const DELEGATION_KEYS = new Set(['enabled', 'defaultRunnerId', 'maxConcurrentGlobal', 'maxConcurrentThread', 'maxQueuedGlobal', 'maxQueuedThread', 'runners']);
const DELEGATION_RUNNER_KEYS = new Set(['enabled', 'model', 'effort', 'maximumAccess', 'timeoutMs', 'maxConcurrent', 'pool', 'maxConcurrentPool']);
const UPDATES_KEYS = new Set(['checkAutomatically']);
const MODELS_KEYS = new Set(['connections', 'default', 'imageDefault']);
const CONNECTION_KEYS = new Set(['providerId', 'baseUrl', 'enabled', 'models']);

export function filePreferencesPath(userDataDir: string): string {
  return join(userDataDir, FILE_PREFERENCES_RELATIVE_PATH);
}

export function loadFilePreferences(userDataDir: string): FilePreferencesLoadResult {
  const path = filePreferencesPath(userDataDir);
  let sourceBytes: string;
  try {
    sourceBytes = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return result(path, 'missing', null, DEFAULT_FILE_PREFERENCES, null);
    }
    const recovery = readRecovery(userDataDir);
    return result(path, 'rejected', null, recovery.preferences, errorMessage(error), recovery.sourceDigest, recovery.error);
  }
  if (Buffer.byteLength(sourceBytes, 'utf8') > MAX_FILE_PREFERENCES_BYTES) {
    const recovery = readRecovery(userDataDir);
    return result(path, 'rejected', sourceBytes, recovery.preferences, `Source exceeds ${MAX_FILE_PREFERENCES_BYTES} bytes`, recovery.sourceDigest, recovery.error);
  }
  try {
    const parsed = parseJsonc(sourceBytes);
    const preferences = decodeFilePreferences(parsed);
    let recoveryError: string | null = null;
    try {
      writeRecovery(userDataDir, sourceBytes, preferences);
    } catch (error) {
      recoveryError = errorMessage(error);
    }
    return result(path, 'accepted', sourceBytes, preferences, null, digest(sourceBytes), recoveryError);
  } catch (error) {
    const recovery = readRecovery(userDataDir);
    return result(path, 'rejected', sourceBytes, recovery.preferences, errorMessage(error), recovery.sourceDigest, recovery.error);
  }
}

export function writeFilePreferences(userDataDir: string, preferences: FilePreferences): void {
  updateFilePreferences(userDataDir, [
    { path: ['appearance', 'theme'], value: preferences.appearance.theme },
    { path: ['appearance', 'language'], value: preferences.appearance.language },
    { path: ['agent', 'memory', 'enabled'], value: preferences.agent.memory.enabled },
    { path: ['agent', 'skills', 'disabled'], value: preferences.agent.skills.disabled },
    { path: ['agent', 'skills', 'sources'], value: preferences.agent.skills.sources },
    { path: ['agent', 'tools', 'disabled'], value: preferences.agent.tools.disabled },
    { path: ['agent', 'provider', 'timeoutMs'], value: preferences.agent.provider.timeoutMs },
    { path: ['agent', 'provider', 'maxRetries'], value: preferences.agent.provider.maxRetries },
    { path: ['agent', 'provider', 'maxRetryDelayMs'], value: preferences.agent.provider.maxRetryDelayMs },
    { path: ['agent', 'provider', 'cacheRetention'], value: preferences.agent.provider.cacheRetention },
    { path: ['agent', 'delegation'], value: preferences.agent.delegation },
    { path: ['updates', 'checkAutomatically'], value: preferences.updates.checkAutomatically },
    { path: ['models', 'connections'], value: preferences.models.connections },
    { path: ['models', 'default'], value: preferences.models.default },
    { path: ['models', 'imageDefault'], value: preferences.models.imageDefault },
  ]);
}

export function updateFilePreferences(
  userDataDir: string,
  updates: readonly { readonly path: readonly (string | number)[]; readonly value: unknown }[],
  expectedDigest?: string | null,
): void {
  const loaded = loadFilePreferences(userDataDir);
  if (loaded.sourceStatus === 'rejected') {
    throw new Error(`Cannot write rejected settings source: ${loaded.error ?? 'invalid source'}`);
  }
  if (expectedDigest !== undefined && expectedDigest !== loaded.sourceDigest) {
    throw new Error('Settings source changed; refresh before retrying this edit');
  }
  let source = loaded.sourceBytes ?? '{}';
  for (const update of updates) {
    source = modify(source, update.path, update.value);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_PREFERENCES_BYTES) throw new Error('Settings source exceeds the size limit');
  decodeFilePreferences(parseJsonc(source));
  const observed = readSourceIfPresent(filePreferencesPath(userDataDir));
  if (observed !== loaded.sourceBytes) {
    throw new Error('Settings source changed while preparing an update; retry against the latest file');
  }
  atomicWriteFileSync(filePreferencesPath(userDataDir), source, { directoryMode: 0o700 });
}

function parseJsonc(source: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new Error(`Invalid JSONC: ${errors[0]!.error}`);
  const tree = parseTree(source, [], { allowTrailingComma: true, disallowComments: false });
  if (tree) assertUniqueKeys(tree, 'settings');
  return parsed;
}

function modify(source: string, path: readonly (string | number)[], value: unknown): string {
  const edits = jsoncModify(source, [...path] as JSONPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  return applyEdits(source, edits);
}

function assertUniqueKeys(node: Node, path: string): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const child of node.children ?? []) {
      const keyNode = child.children?.[0];
      if (child.type !== 'property' || !keyNode || typeof keyNode.value !== 'string') continue;
      if (keys.has(keyNode.value)) throw new Error(`${path}.${keyNode.value} is duplicated`);
      keys.add(keyNode.value);
      const valueNode = child.children?.[1];
      if (valueNode) assertUniqueKeys(valueNode, `${path}.${keyNode.value}`);
    }
  } else {
    for (const child of node.children ?? []) assertUniqueKeys(child, path);
  }
}

function decodeFilePreferences(value: unknown): FilePreferences {
  const root = record(value, 'settings');
  exactKeys(root, TOP_LEVEL_KEYS, 'settings');
  for (const definition of PREFERENCE_DEFINITIONS) {
    const scalar = configurationValue(root, definition.id);
    if (scalar !== undefined) validatePreference(definition, scalar);
  }
  const appearance = recordOrDefault(root.appearance, DEFAULT_FILE_PREFERENCES.appearance, 'settings.appearance');
  exactKeys(appearance, APPEARANCE_KEYS, 'settings.appearance');
  const agent = recordOrDefault(root.agent, DEFAULT_FILE_PREFERENCES.agent, 'settings.agent');
  exactKeys(agent, AGENT_KEYS, 'settings.agent');
  const memory = recordOrDefault(agent.memory, DEFAULT_FILE_PREFERENCES.agent.memory, 'settings.agent.memory');
  exactKeys(memory, MEMORY_KEYS, 'settings.agent.memory');
  const skills = recordOrDefault(agent.skills, DEFAULT_FILE_PREFERENCES.agent.skills, 'settings.agent.skills');
  exactKeys(skills, SKILLS_KEYS, 'settings.agent.skills');
  const tools = recordOrDefault(agent.tools, DEFAULT_FILE_PREFERENCES.agent.tools, 'settings.agent.tools');
  exactKeys(tools, TOOLS_KEYS, 'settings.agent.tools');
  const provider = recordOrDefault(agent.provider, DEFAULT_FILE_PREFERENCES.agent.provider, 'settings.agent.provider');
  exactKeys(provider, PROVIDER_KEYS, 'settings.agent.provider');
  const delegation = recordOrDefault(agent.delegation, DEFAULT_FILE_PREFERENCES.agent.delegation, 'settings.agent.delegation');
  exactKeys(delegation, DELEGATION_KEYS, 'settings.agent.delegation');
  const updates = recordOrDefault(root.updates, DEFAULT_FILE_PREFERENCES.updates, 'settings.updates');
  exactKeys(updates, UPDATES_KEYS, 'settings.updates');
  const models = recordOrDefault(root.models, DEFAULT_FILE_PREFERENCES.models, 'settings.models');
  exactKeys(models, MODELS_KEYS, 'settings.models');
  const connections = connectionList(
    models.connections ?? DEFAULT_FILE_PREFERENCES.models.connections,
    'settings.models.connections',
  );

  return Object.freeze({
    appearance: Object.freeze({
      theme: enumValue(appearance.theme ?? DEFAULT_FILE_PREFERENCES.appearance.theme, ['system', 'light', 'dark'], 'settings.appearance.theme'),
      language: nullableString(appearance.language ?? DEFAULT_FILE_PREFERENCES.appearance.language, 'settings.appearance.language'),
    }),
    agent: Object.freeze({
      memory: Object.freeze({ enabled: booleanValue(memory.enabled ?? DEFAULT_FILE_PREFERENCES.agent.memory.enabled, 'settings.agent.memory.enabled') }),
      skills: Object.freeze({
        disabled: stringList(skills.disabled ?? DEFAULT_FILE_PREFERENCES.agent.skills.disabled, 'settings.agent.skills.disabled'),
        sources: skillSourceBindings(skills.sources ?? DEFAULT_FILE_PREFERENCES.agent.skills.sources, 'settings.agent.skills.sources'),
      }),
      tools: Object.freeze({ disabled: stringList(tools.disabled ?? DEFAULT_FILE_PREFERENCES.agent.tools.disabled, 'settings.agent.tools.disabled') }),
      provider: Object.freeze({
        timeoutMs: nullableNonNegativeInteger(provider.timeoutMs ?? DEFAULT_FILE_PREFERENCES.agent.provider.timeoutMs, 'settings.agent.provider.timeoutMs'),
        maxRetries: nullableNonNegativeInteger(provider.maxRetries ?? DEFAULT_FILE_PREFERENCES.agent.provider.maxRetries, 'settings.agent.provider.maxRetries'),
        maxRetryDelayMs: positiveInteger(provider.maxRetryDelayMs ?? DEFAULT_FILE_PREFERENCES.agent.provider.maxRetryDelayMs, 'settings.agent.provider.maxRetryDelayMs'),
        cacheRetention: enumValue(provider.cacheRetention ?? DEFAULT_FILE_PREFERENCES.agent.provider.cacheRetention, ['none', 'short', 'long'], 'settings.agent.provider.cacheRetention'),
      }),
      delegation: decodeDelegation(delegation),
    }),
    updates: Object.freeze({ checkAutomatically: booleanValue(updates.checkAutomatically ?? DEFAULT_FILE_PREFERENCES.updates.checkAutomatically, 'settings.updates.checkAutomatically') }),
    models: Object.freeze({
      connections,
      default: modelSelection(models.default ?? DEFAULT_FILE_PREFERENCES.models.default, 'settings.models.default'),
      imageDefault: nullableString(models.imageDefault ?? DEFAULT_FILE_PREFERENCES.models.imageDefault, 'settings.models.imageDefault'),
    }),
  });
}

function connectionList(
  value: unknown,
  path: string,
): readonly FilePreferences['models']['connections'][number][] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a list`);
  const seen = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const connection = record(entry, `${path}[${index}]`);
    exactKeys(connection, CONNECTION_KEYS, `${path}[${index}]`);
    const providerId = nonEmptyString(connection.providerId, `${path}[${index}].providerId`);
    if (seen.has(providerId)) throw new Error(`${path}.${providerId} is duplicated`);
    seen.add(providerId);
    return Object.freeze({
      providerId,
      baseUrl: connection.baseUrl === undefined
        ? null
        : nullableString(connection.baseUrl, `${path}[${index}].baseUrl`),
      enabled: booleanValue(connection.enabled ?? true, `${path}[${index}].enabled`),
      models: connection.models === undefined
        ? Object.freeze([])
        : stringList(connection.models, `${path}[${index}].models`),
    });
  }));
}

function decodeDelegation(value: Record<string, unknown>): AgentDelegationSettings {
  const runnersValue = value.runners === undefined ? {} : record(value.runners, 'settings.agent.delegation.runners');
  const runners: Record<string, AgentDelegationSettings['runners'][string]> = {};
  for (const [runnerId, entry] of Object.entries(runnersValue)) {
    const runner = record(entry, `settings.agent.delegation.runners.${runnerId}`);
    exactKeys(runner, DELEGATION_RUNNER_KEYS, `settings.agent.delegation.runners.${runnerId}`);
    runners[runnerId] = {
      enabled: booleanValue(runner.enabled ?? false, `settings.agent.delegation.runners.${runnerId}.enabled`),
      model: runner.model === null || runner.model === undefined ? null : nullableString(runner.model, `settings.agent.delegation.runners.${runnerId}.model`),
      effort: runner.effort === null || runner.effort === undefined
        ? null
        : enumValue(runner.effort, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] satisfies readonly AgentReasoningLevel[], `settings.agent.delegation.runners.${runnerId}.effort`),
      maximumAccess: enumValue(runner.maximumAccess ?? 'read-only', ['read-only', 'workspace-write'], `settings.agent.delegation.runners.${runnerId}.maximumAccess`),
      timeoutMs: positiveInteger(runner.timeoutMs ?? 60 * 60_000, `settings.agent.delegation.runners.${runnerId}.timeoutMs`),
      maxConcurrent: positiveInteger(runner.maxConcurrent ?? 4, `settings.agent.delegation.runners.${runnerId}.maxConcurrent`),
      pool: nonEmptyString(runner.pool ?? runnerId, `settings.agent.delegation.runners.${runnerId}.pool`),
      maxConcurrentPool: positiveInteger(runner.maxConcurrentPool ?? 4, `settings.agent.delegation.runners.${runnerId}.maxConcurrentPool`),
    };
  }
  return {
    enabled: booleanValue(value.enabled ?? false, 'settings.agent.delegation.enabled'),
    defaultRunnerId: nonEmptyString(value.defaultRunnerId ?? 'internal', 'settings.agent.delegation.defaultRunnerId'),
    maxConcurrentGlobal: positiveInteger(value.maxConcurrentGlobal ?? 8, 'settings.agent.delegation.maxConcurrentGlobal'),
    maxConcurrentThread: positiveInteger(value.maxConcurrentThread ?? 4, 'settings.agent.delegation.maxConcurrentThread'),
    maxQueuedGlobal: positiveInteger(value.maxQueuedGlobal ?? 32, 'settings.agent.delegation.maxQueuedGlobal'),
    maxQueuedThread: positiveInteger(value.maxQueuedThread ?? 8, 'settings.agent.delegation.maxQueuedThread'),
    runners: Object.freeze(runners),
  };
}

function modelSelection(value: unknown, path: string): string {
  if (typeof value !== 'string' || (!value.trim() && value !== 'auto')) {
    throw new Error(`${path} must be \"auto\" or a qualified model`);
  }
  return value.trim() || 'auto';
}

function result(
  path: string,
  sourceStatus: FilePreferencesSourceStatus,
  sourceBytes: string | null,
  preferences: FilePreferences,
  error: string | null,
  acceptedDigest: string | null = null,
  recoveryError: string | null = null,
): FilePreferencesLoadResult {
  return Object.freeze({
    path,
    sourceStatus,
    sourceBytes,
    sourceDigest: sourceBytes === null ? null : digest(sourceBytes),
    acceptedDigest,
    recoveryError,
    preferences,
    error,
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function recordOrDefault(value: unknown, fallback: object, path: string): Record<string, unknown> {
  return value === undefined ? { ...fallback } : record(value, path);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${path} must be one of ${values.join(', ')}`);
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${path} must be a string or null`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${path} must be a list of non-empty strings`);
  }
  return Object.freeze([...new Set(value)]);
}

function skillSourceBindings(value: unknown, path: string): readonly AgentSkillSourceBinding[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a list of source objects`);
  const seen = new Set<string>();
  const bindings: AgentSkillSourceBinding[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path}[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== 'path' && key !== 'mode')) {
      throw new Error(`${path}[${index}] contains an unsupported field`);
    }
    const sourcePath = nonEmptyString(record.path, `${path}[${index}].path`);
    const mode = enumValue(record.mode, ['skill', 'container'] as const, `${path}[${index}].mode`);
    if (seen.has(sourcePath)) throw new Error(`${path} cannot contain duplicate paths`);
    seen.add(sourcePath);
    bindings.push(Object.freeze({ path: sourcePath, mode }));
  }
  return Object.freeze(bindings);
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return nonNegativeInteger(value, path);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${path} must be a non-negative integer`);
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive integer`);
  return value as number;
}

function digest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function readSourceIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryPath(userDataDir: string): string {
  return join(userDataDir, RECOVERY_FILE);
}

function readRecovery(userDataDir: string): {
  readonly preferences: FilePreferences;
  readonly sourceDigest: string | null;
  readonly error: string | null;
} {
  try {
    const raw = JSON.parse(readFileSync(recoveryPath(userDataDir), 'utf8')) as Record<string, unknown>;
    if (typeof raw.sourceBytes !== 'string' || Buffer.byteLength(raw.sourceBytes, 'utf8') > MAX_FILE_PREFERENCES_BYTES) {
      return { preferences: DEFAULT_FILE_PREFERENCES, sourceDigest: null, error: 'Recovery source exceeds the settings size limit' };
    }
    return { preferences: decodeFilePreferences(parseJsonc(raw.sourceBytes)), sourceDigest: digest(raw.sourceBytes), error: null };
  } catch (error) {
    return { preferences: DEFAULT_FILE_PREFERENCES, sourceDigest: null, error: errorMessage(error) };
  }
}

function writeRecovery(userDataDir: string, sourceBytes: string, preferences: FilePreferences): void {
  writeJsonFileSync(recoveryPath(userDataDir), { sourceBytes, preferences }, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}
