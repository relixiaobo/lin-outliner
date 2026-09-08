import { readFileSync } from 'node:fs';
import { IDENTITY_COLORS, MAIN_PRESENTATION_KEY, type IdentityColor } from '../../core/agent/configuration';
import type { AgentProfileDraft } from '../../core/types';
import { applyEdits, modify as jsoncModify } from 'jsonc-parser';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../jsonFileStore';
import {
  decodeConfigurationLayer,
  parseAgentConfigurationSource,
  projectConfigurationPath,
  writeProjectAgentConfigurationSchema,
  userConfigurationPath,
} from './AgentConfigurationLoader';

export type ConfigurationLayerTarget = 'user' | 'project';

export interface PresentationDraft {
  readonly persona?: string;
  readonly color?: string;
}

type JsonObject = Record<string, unknown>;

export class AgentConfigurationWriter {
  constructor(private readonly userDataPath: string) {}

  async writeProfile(
    target: ConfigurationLayerTarget,
    cwd: string,
    name: string,
    draft: AgentProfileDraft,
    presentation?: PresentationDraft,
    expectedDigest?: string | null,
  ): Promise<void> {
    await this.edit(target, cwd, (config) => {
      if (presentation !== undefined) config = applyMainPresentation(config, presentation);
      const profiles = asObject(config.profiles);
      const next = { ...asObject(profiles[name]) };
      applyText(next, 'developerInstructions', draft.developerInstructions);
      applyText(next, 'model', draft.model);
      applyText(next, 'reasoningEffort', draft.reasoningEffort);
      applyCapabilities(next, draft);
      if (Object.keys(next).length > 0) profiles[name] = next;
      else delete profiles[name];
      return Object.keys(profiles).length > 0
        ? { ...config, profiles }
        : withoutKey(config, 'profiles');
    }, expectedDigest);
  }

  private layerPath(target: ConfigurationLayerTarget, cwd: string): string {
    return target === 'user' ? userConfigurationPath(this.userDataPath) : projectConfigurationPath(cwd);
  }

  private async edit(
    target: ConfigurationLayerTarget,
    cwd: string,
    change: (config: JsonObject) => JsonObject,
    expectedDigest?: string | null,
  ): Promise<void> {
    const path = this.layerPath(target, cwd);
    const original = readSource(path);
    const observedDigest = original === null ? null : createHash('sha256').update(original).digest('hex');
    if (expectedDigest !== undefined && expectedDigest !== observedDigest) throw new Error('Agent source changed; reopen the editor before retrying');
    let current: JsonObject = {};
    if (original !== null) {
      let parsed: unknown;
      try {
        parsed = parseAgentConfigurationSource(original, path);
        decodeConfigurationLayer(parsed, target, path);
      } catch (error) {
        throw new Error(`Cannot edit ${path}: ${errorText(error)}`);
      }
      current = parsed as JsonObject;
    }
    const next = change(current);
    try {
      decodeConfigurationLayer(next, target, path);
    } catch (error) {
      throw new Error(`Refused: ${errorText(error)}`);
    }
    let source = original ?? '{}';
    source = applyJsonObjectDiff(source, current, next);
    if (readSource(path) !== original) throw new Error('Agent source changed while preparing the edit');
    atomicWriteFileSync(path, source.endsWith('\n') ? source : `${source}\n`);
    if (target === 'project') writeProjectAgentConfigurationSchema(cwd);
  }
}

function applyJsonObjectDiff(source: string, current: JsonObject, next: JsonObject, basePath: string[] = []): string {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of keys) {
    const before = current[key];
    const after = next[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const path = [...basePath, key];
    if (isObject(before) && isObject(after)) {
      source = applyJsonObjectDiff(source, before, after, path);
      continue;
    }
    source = applyEdits(source, jsoncModify(source, path, after, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    }));
  }
  return source;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyMainPresentation(config: JsonObject, draft: PresentationDraft): JsonObject {
  const overrides = asObject(config.presentationOverrides);
  const entry: JsonObject = {};
  const persona = draft.persona?.trim();
  if (persona) entry.persona = persona;
  if (draft.color) entry.color = assertColor(draft.color);
  if (Object.keys(entry).length > 0) overrides[MAIN_PRESENTATION_KEY] = entry;
  else delete overrides[MAIN_PRESENTATION_KEY];
  return Object.keys(overrides).length > 0
    ? { ...config, presentationOverrides: overrides }
    : withoutKey(config, 'presentationOverrides');
}

function applyCapabilities(
  target: JsonObject,
  draft: {
    readonly tools?: readonly string[] | null;
    readonly skills?: readonly string[] | null;
  },
): void {
  for (const key of ['tools', 'skills'] as const) {
    const value = draft[key];
    if (value === undefined) continue;
    if (value === null) delete target[key];
    else target[key] = [...value];
  }
}

function applyText(target: JsonObject, key: string, value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length > 0) target[key] = trimmed;
  else delete target[key];
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : {};
}

function withoutKey(config: JsonObject, key: string): JsonObject {
  const next = { ...config };
  delete next[key];
  return next;
}

function assertColor(value: string): IdentityColor {
  if (!IDENTITY_COLORS.includes(value as IdentityColor)) {
    throw new Error(`Unknown identity colour '${value}'`);
  }
  return value as IdentityColor;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSource(path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
