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

export const FILE_PREFERENCES_RELATIVE_PATH = join('config', 'settings.jsonc');
export const MAX_FILE_PREFERENCES_BYTES = 256 * 1024;
const RECOVERY_FILE = join('config', 'settings.last-known-good.json');

export interface FilePreferences {
  readonly appearance: {
    readonly theme: 'system' | 'light' | 'dark';
    readonly language: string | null;
  };
  readonly agent: {
    readonly memory: { readonly enabled: boolean };
    readonly skills: {
      readonly disabled: readonly string[];
      readonly sources: readonly string[];
    };
    readonly tools: { readonly disabled: readonly string[] };
    readonly provider: {
      readonly timeoutMs: number | null;
      readonly maxRetries: number | null;
      readonly maxRetryDelayMs: number;
      readonly cacheRetention: 'none' | 'short' | 'long';
    };
  };
  readonly updates: { readonly checkAutomatically: boolean };
}

export type FilePreferencesSourceStatus = 'missing' | 'accepted' | 'rejected';

export interface FilePreferencesLoadResult {
  readonly path: string;
  readonly sourceStatus: FilePreferencesSourceStatus;
  readonly sourceBytes: string | null;
  readonly sourceDigest: string | null;
  readonly acceptedDigest: string | null;
  readonly preferences: FilePreferences;
  readonly error: string | null;
}

export const DEFAULT_FILE_PREFERENCES: FilePreferences = Object.freeze({
  appearance: Object.freeze({ theme: 'system', language: null }),
  agent: Object.freeze({
    memory: Object.freeze({ enabled: true }),
    skills: Object.freeze({ disabled: Object.freeze([]), sources: Object.freeze([]) }),
    tools: Object.freeze({ disabled: Object.freeze([]) }),
    provider: Object.freeze({
      timeoutMs: null,
      maxRetries: null,
      maxRetryDelayMs: 60_000,
      cacheRetention: 'short',
    }),
  }),
  updates: Object.freeze({ checkAutomatically: true }),
});

const TOP_LEVEL_KEYS = new Set(['appearance', 'agent', 'updates']);
const APPEARANCE_KEYS = new Set(['theme', 'language']);
const AGENT_KEYS = new Set(['memory', 'skills', 'tools', 'provider']);
const MEMORY_KEYS = new Set(['enabled']);
const SKILLS_KEYS = new Set(['disabled', 'sources']);
const TOOLS_KEYS = new Set(['disabled']);
const PROVIDER_KEYS = new Set(['timeoutMs', 'maxRetries', 'maxRetryDelayMs', 'cacheRetention']);
const UPDATES_KEYS = new Set(['checkAutomatically']);

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
      const recovery = readRecovery(userDataDir);
      return result(path, 'missing', null, DEFAULT_FILE_PREFERENCES, null, recovery.sourceDigest);
    }
    const recovery = readRecovery(userDataDir);
    return result(path, 'rejected', null, recovery.preferences, errorMessage(error), recovery.sourceDigest);
  }
  if (Buffer.byteLength(sourceBytes, 'utf8') > MAX_FILE_PREFERENCES_BYTES) {
    const recovery = readRecovery(userDataDir);
    return result(path, 'rejected', sourceBytes, recovery.preferences, `Source exceeds ${MAX_FILE_PREFERENCES_BYTES} bytes`, recovery.sourceDigest);
  }
  try {
    const parsed = parseJsonc(sourceBytes);
    const preferences = decodeFilePreferences(parsed);
    writeRecovery(userDataDir, sourceBytes, preferences);
    return result(path, 'accepted', sourceBytes, preferences, null, digest(sourceBytes));
  } catch (error) {
    const recovery = readRecovery(userDataDir);
    return result(path, 'rejected', sourceBytes, recovery.preferences, errorMessage(error), recovery.sourceDigest);
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
    { path: ['updates', 'checkAutomatically'], value: preferences.updates.checkAutomatically },
  ]);
}

export function updateFilePreferences(
  userDataDir: string,
  updates: readonly { readonly path: readonly (string | number)[]; readonly value: unknown }[],
): void {
  const loaded = loadFilePreferences(userDataDir);
  if (loaded.sourceStatus === 'rejected') {
    throw new Error(`Cannot write rejected settings source: ${loaded.error ?? 'invalid source'}`);
  }
  let source = loaded.sourceBytes ?? '{}';
  for (const update of updates) {
    source = modify(source, update.path, update.value);
  }
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
  const updates = recordOrDefault(root.updates, DEFAULT_FILE_PREFERENCES.updates, 'settings.updates');
  exactKeys(updates, UPDATES_KEYS, 'settings.updates');

  return Object.freeze({
    appearance: Object.freeze({
      theme: enumValue(appearance.theme ?? DEFAULT_FILE_PREFERENCES.appearance.theme, ['system', 'light', 'dark'], 'settings.appearance.theme'),
      language: nullableString(appearance.language ?? DEFAULT_FILE_PREFERENCES.appearance.language, 'settings.appearance.language'),
    }),
    agent: Object.freeze({
      memory: Object.freeze({ enabled: booleanValue(memory.enabled ?? DEFAULT_FILE_PREFERENCES.agent.memory.enabled, 'settings.agent.memory.enabled') }),
      skills: Object.freeze({
        disabled: stringList(skills.disabled ?? DEFAULT_FILE_PREFERENCES.agent.skills.disabled, 'settings.agent.skills.disabled'),
        sources: stringList(skills.sources ?? DEFAULT_FILE_PREFERENCES.agent.skills.sources, 'settings.agent.skills.sources'),
      }),
      tools: Object.freeze({ disabled: stringList(tools.disabled ?? DEFAULT_FILE_PREFERENCES.agent.tools.disabled, 'settings.agent.tools.disabled') }),
      provider: Object.freeze({
        timeoutMs: nullableNonNegativeInteger(provider.timeoutMs ?? DEFAULT_FILE_PREFERENCES.agent.provider.timeoutMs, 'settings.agent.provider.timeoutMs'),
        maxRetries: nullableNonNegativeInteger(provider.maxRetries ?? DEFAULT_FILE_PREFERENCES.agent.provider.maxRetries, 'settings.agent.provider.maxRetries'),
        maxRetryDelayMs: positiveInteger(provider.maxRetryDelayMs ?? DEFAULT_FILE_PREFERENCES.agent.provider.maxRetryDelayMs, 'settings.agent.provider.maxRetryDelayMs'),
        cacheRetention: enumValue(provider.cacheRetention ?? DEFAULT_FILE_PREFERENCES.agent.provider.cacheRetention, ['none', 'short', 'long'], 'settings.agent.provider.cacheRetention'),
      }),
    }),
    updates: Object.freeze({ checkAutomatically: booleanValue(updates.checkAutomatically ?? DEFAULT_FILE_PREFERENCES.updates.checkAutomatically, 'settings.updates.checkAutomatically') }),
  });
}

function result(
  path: string,
  sourceStatus: FilePreferencesSourceStatus,
  sourceBytes: string | null,
  preferences: FilePreferences,
  error: string | null,
  acceptedDigest: string | null = null,
): FilePreferencesLoadResult {
  return Object.freeze({
    path,
    sourceStatus,
    sourceBytes,
    sourceDigest: sourceBytes === null ? null : digest(sourceBytes),
    acceptedDigest,
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

function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${path} must be a list of non-empty strings`);
  }
  return Object.freeze([...new Set(value)]);
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

function readRecovery(userDataDir: string): { readonly preferences: FilePreferences; readonly sourceDigest: string | null } {
  try {
    const raw = JSON.parse(readFileSync(recoveryPath(userDataDir), 'utf8')) as Record<string, unknown>;
    if (typeof raw.sourceBytes !== 'string' || Buffer.byteLength(raw.sourceBytes, 'utf8') > MAX_FILE_PREFERENCES_BYTES) {
      return { preferences: DEFAULT_FILE_PREFERENCES, sourceDigest: null };
    }
    return { preferences: decodeFilePreferences(parseJsonc(raw.sourceBytes)), sourceDigest: digest(raw.sourceBytes) };
  } catch {
    return { preferences: DEFAULT_FILE_PREFERENCES, sourceDigest: null };
  }
}

function writeRecovery(userDataDir: string, sourceBytes: string, preferences: FilePreferences): void {
  writeJsonFileSync(recoveryPath(userDataDir), { sourceBytes, preferences }, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}
