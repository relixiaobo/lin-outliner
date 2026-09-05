import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileSync } from '../jsonFileStore';

export const FILE_PREFERENCES_RELATIVE_PATH = join('config', 'settings.jsonc');
export const MAX_FILE_PREFERENCES_BYTES = 256 * 1024;

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
      return result(path, 'missing', null, DEFAULT_FILE_PREFERENCES, null);
    }
    return result(path, 'rejected', null, DEFAULT_FILE_PREFERENCES, errorMessage(error));
  }
  if (Buffer.byteLength(sourceBytes, 'utf8') > MAX_FILE_PREFERENCES_BYTES) {
    return result(path, 'rejected', sourceBytes, DEFAULT_FILE_PREFERENCES, `Source exceeds ${MAX_FILE_PREFERENCES_BYTES} bytes`);
  }
  try {
    const parsed = JSON.parse(stripJsonc(sourceBytes)) as unknown;
    return result(path, 'accepted', sourceBytes, decodeFilePreferences(parsed), null);
  } catch (error) {
    return result(path, 'rejected', sourceBytes, DEFAULT_FILE_PREFERENCES, errorMessage(error));
  }
}

export function writeFilePreferences(userDataDir: string, preferences: FilePreferences): void {
  const path = filePreferencesPath(userDataDir);
  writeJsonFileSync(path, preferences, { directoryMode: 0o700 });
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
      theme: enumValue(appearance.theme, ['system', 'light', 'dark'], 'settings.appearance.theme'),
      language: nullableString(appearance.language, 'settings.appearance.language'),
    }),
    agent: Object.freeze({
      memory: Object.freeze({ enabled: booleanValue(memory.enabled, 'settings.agent.memory.enabled') }),
      skills: Object.freeze({
        disabled: stringList(skills.disabled, 'settings.agent.skills.disabled'),
        sources: stringList(skills.sources, 'settings.agent.skills.sources'),
      }),
      tools: Object.freeze({ disabled: stringList(tools.disabled, 'settings.agent.tools.disabled') }),
      provider: Object.freeze({
        timeoutMs: nullableNonNegativeInteger(provider.timeoutMs, 'settings.agent.provider.timeoutMs'),
        maxRetries: nullableNonNegativeInteger(provider.maxRetries, 'settings.agent.provider.maxRetries'),
        maxRetryDelayMs: positiveInteger(provider.maxRetryDelayMs, 'settings.agent.provider.maxRetryDelayMs'),
        cacheRetention: enumValue(provider.cacheRetention, ['none', 'short', 'long'], 'settings.agent.provider.cacheRetention'),
      }),
    }),
    updates: Object.freeze({ checkAutomatically: booleanValue(updates.checkAutomatically, 'settings.updates.checkAutomatically') }),
  });
}

function result(
  path: string,
  sourceStatus: FilePreferencesSourceStatus,
  sourceBytes: string | null,
  preferences: FilePreferences,
  error: string | null,
): FilePreferencesLoadResult {
  return Object.freeze({
    path,
    sourceStatus,
    sourceBytes,
    sourceDigest: sourceBytes === null ? null : digest(sourceBytes),
    preferences,
    error,
  });
}

function stripJsonc(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
        output += ' ';
      } else if (char === '\n' || char === '\r') {
        output += char;
      }
      continue;
    }
    if (!inString && char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!inString && char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    output += char;
    if (char === '"' && !escaped) inString = !inString;
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  if (lineComment || blockComment) throw new Error('Unterminated JSONC comment');
  return output.replace(/,\s*([}\]])/g, '$1');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
