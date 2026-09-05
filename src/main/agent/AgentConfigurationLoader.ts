import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AGENT_PRESENTATIONS,
  IDENTITY_COLORS,
  MAIN_PRESENTATION_KEY,
  REASONING_EFFORTS,
  type AgentPresentation,
  type AgentPresentationOverride,
  type ConfigurationProfile,
  type EffectiveThreadConfiguration,
  type IdentityColor,
  type ReasoningEffort,
} from '../../core/agent/configuration';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../core/agent/tools';
import type { AgentIdentityEntry } from '../../core/agent/protocol';
import type { ErrorReport } from '../../core/errorObservability';
import type { AgentPresentationOverrideRow, AgentProfileView } from '../../core/types';

interface ConfigurationLayer {
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyMap<string, ConfigurationProfile>;
  readonly mainPresentation: AgentPresentationOverride | null;
}

export type AgentConfigurationReadFailureReporter = (report: ErrorReport) => void;

const EMPTY_LAYER: ConfigurationLayer = Object.freeze({
  defaultProfile: null,
  profiles: new Map(),
  mainPresentation: null,
});

const DEFAULT_PROFILE: ConfigurationProfile = Object.freeze({
  name: 'default',
  source: 'builtIn',
  description: 'Root Thread configuration.',
  model: 'inherit',
  reasoningEffort: 'medium',
  tools: Object.freeze(MODEL_TOOL_CATALOG.map((tool) => canonicalModelToolKey(tool.identity))),
  skills: Object.freeze(['*']),
  plugins: Object.freeze([]),
  mcpServers: Object.freeze([]),
});

const DEFAULT_MAIN_IDENTITY: AgentIdentityEntry = Object.freeze({
  agentType: MAIN_PRESENTATION_KEY,
  persona: DEFAULT_AGENT_PRESENTATIONS[MAIN_PRESENTATION_KEY]!.persona,
  color: DEFAULT_AGENT_PRESENTATIONS[MAIN_PRESENTATION_KEY]!.color,
  source: 'built-in',
});
const MAX_TRACKED_USER_PATH_FAILURES = 64;

export class AgentConfigurationLoader {
  private readonly activeUserPathFailures = new Set<string>();

  constructor(private readonly userDataPath: string) {}

  resolveProfile(requestedName: string | undefined, cwd: string): EffectiveThreadConfiguration {
    const merged = this.loadMerged(cwd);
    const name = normalizeSelectedName(requestedName ?? merged.defaultProfile ?? DEFAULT_PROFILE.name);
    const profile = merged.profiles.get(name) ?? (name === DEFAULT_PROFILE.name ? DEFAULT_PROFILE : null);
    if (!profile) throw new Error(`Unknown Configuration Profile: ${name}`);
    return effectiveConfiguration(profile);
  }

  resolveIdentityCatalog(cwd: string): readonly AgentIdentityEntry[] {
    const presentation = resolveMainPresentation(this.loadMerged(cwd));
    return Object.freeze([{
      agentType: MAIN_PRESENTATION_KEY,
      persona: presentation.persona,
      color: presentation.color,
      source: 'built-in',
    }]);
  }

  resolveIdentityCatalogForUserPath(
    cwd: string,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ): readonly AgentIdentityEntry[] {
    return this.readForUserPath(
      'resolve-identity-catalog',
      () => this.resolveIdentityCatalog(cwd),
      () => Object.freeze([DEFAULT_MAIN_IDENTITY]),
      reportFailure,
    );
  }

  resolveThreadPersona(thread: {
    readonly cwd: string;
  }, reportFailure?: AgentConfigurationReadFailureReporter): string {
    return this.readForUserPath(
      'resolve-agent-persona',
      () => resolveMainPresentation(this.loadMerged(thread.cwd)).persona,
      () => DEFAULT_MAIN_IDENTITY.persona,
      reportFailure,
    );
  }

  resolveEditableProfile(cwd: string): AgentProfileView {
    const merged = this.loadMerged(cwd);
    const name = merged.defaultProfile ?? DEFAULT_PROFILE.name;
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    const written = project.profiles.get(name) ?? user.profiles.get(name) ?? null;
    const layer = project.profiles.has(name)
      ? 'project'
      : user.profiles.has(name) ? 'user' : null;
    return {
      name,
      layer,
      developerInstructions: written?.developerInstructions ?? null,
      model: written?.model ?? null,
      reasoningEffort: written?.reasoningEffort ?? null,
      tools: written?.tools ?? null,
      skills: written?.skills ?? null,
    };
  }

  listPresentationOverrides(cwd: string): readonly AgentPresentationOverrideRow[] {
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    const rows: AgentPresentationOverrideRow[] = [];
    for (const [layer, source] of [[user, 'user'], [project, 'project']] as const) {
      if (!layer.mainPresentation) continue;
      rows.push({
        agentType: MAIN_PRESENTATION_KEY,
        layer: source,
        persona: layer.mainPresentation.persona ?? null,
        color: layer.mainPresentation.color ?? null,
      });
    }
    return Object.freeze(rows);
  }

  private loadMerged(cwd: string): ConfigurationLayer {
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    return {
      defaultProfile: project.defaultProfile ?? user.defaultProfile,
      profiles: new Map([...user.profiles, ...project.profiles]),
      mainPresentation: project.mainPresentation ?? user.mainPresentation,
    };
  }

  private readLayerAndClearFailure(path: string, source: 'user' | 'project'): ConfigurationLayer {
    const layer = readLayer(path, source);
    this.activeUserPathFailures.delete(path);
    return layer;
  }

  private readForUserPath<T>(
    operation: string,
    read: () => T,
    fallback: () => T,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ): T {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof AgentConfigurationReadError)) throw error;
      this.reportUserPathFailure(operation, error, reportFailure);
      return fallback();
    }
  }

  private reportUserPathFailure(
    operation: string,
    error: AgentConfigurationReadError,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ): void {
    if (!reportFailure || this.activeUserPathFailures.has(error.configurationPath)) return;
    if (this.activeUserPathFailures.size >= MAX_TRACKED_USER_PATH_FAILURES) {
      const oldest = this.activeUserPathFailures.values().next().value;
      if (oldest !== undefined) this.activeUserPathFailures.delete(oldest);
    }
    this.activeUserPathFailures.add(error.configurationPath);
    try {
      reportFailure({
        domain: 'runtime',
        severity: 'warn',
        code: 'agent-configuration-user-path-degraded',
        message: 'Agent configuration was unreadable on a user path; the read degraded instead of ending the user action.',
        context: { operation, source: error.configurationSource },
        error,
      });
    } catch (reportError) {
      console.warn('[agent] Failed to report a degraded configuration read', reportError);
    }
  }
}

function resolveMainPresentation(layer: ConfigurationLayer): AgentPresentation {
  const defaults = DEFAULT_AGENT_PRESENTATIONS[MAIN_PRESENTATION_KEY]!;
  return {
    persona: layer.mainPresentation?.persona ?? defaults.persona,
    color: layer.mainPresentation?.color ?? defaults.color,
  };
}

export function userConfigurationPath(userDataPath: string): string {
  return join(userDataPath, 'agent', 'config.json');
}

export function projectConfigurationPath(cwd: string): string {
  return join(cwd, '.tenon', 'agent.json');
}

export function defaultEffectiveThreadConfiguration(
  profileName = DEFAULT_PROFILE.name,
): EffectiveThreadConfiguration {
  if (profileName !== DEFAULT_PROFILE.name) throw new Error(`Unknown Configuration Profile: ${profileName}`);
  return effectiveConfiguration(DEFAULT_PROFILE);
}

function readLayer(path: string, source: 'user' | 'project'): ConfigurationLayer {
  if (!existsSync(path)) return EMPTY_LAYER;
  try {
    return decodeConfigurationLayer(JSON.parse(readFileSync(path, 'utf8')), source, path);
  } catch (error) {
    if (error instanceof AgentConfigurationReadError) throw error;
    throw new AgentConfigurationReadError(path, source, error);
  }
}

class AgentConfigurationReadError extends Error {
  readonly name = 'AgentConfigurationReadError';

  constructor(
    readonly configurationPath: string,
    readonly configurationSource: 'user' | 'project',
    cause: unknown,
  ) {
    super(`Invalid Agent configuration at ${configurationPath}: ${errorMessage(cause)}`);
  }
}

export function decodeConfigurationLayer(
  value: unknown,
  source: 'user' | 'project',
  path: string,
): ConfigurationLayer {
  const root = objectValue(value, path);
  exactKeys(root, ['defaultProfile', 'profiles', 'presentationOverrides'], path);
  const profiles = new Map<string, ConfigurationProfile>();
  for (const [name, profileValue] of Object.entries(optionalObject(root.profiles, `${path}.profiles`))) {
    validateDefinitionName(name, `${path}.profiles`);
    profiles.set(name, decodeProfile(name, profileValue, source, `${path}.profiles.${name}`));
  }
  const presentationValues = optionalObject(root.presentationOverrides, `${path}.presentationOverrides`);
  const unsupportedPresentation = Object.keys(presentationValues).find((name) => name !== MAIN_PRESENTATION_KEY);
  if (unsupportedPresentation) {
    throw new Error(`${path}.presentationOverrides.${unsupportedPresentation} is unsupported; only main is configurable`);
  }
  const mainPresentation = presentationValues[MAIN_PRESENTATION_KEY] === undefined
    ? null
    : decodePresentation(
      presentationValues[MAIN_PRESENTATION_KEY],
      `${path}.presentationOverrides.${MAIN_PRESENTATION_KEY}`,
    );
  return {
    defaultProfile: root.defaultProfile === undefined
      ? null
      : normalizeSelectedName(stringValue(root.defaultProfile, `${path}.defaultProfile`)),
    profiles,
    mainPresentation,
  };
}

function decodeProfile(
  name: string,
  value: unknown,
  source: 'user' | 'project',
  path: string,
): ConfigurationProfile {
  const record = objectValue(value, path);
  exactKeys(record, [
    'description',
    'developerInstructions',
    'model',
    'reasoningEffort',
    'tools',
    'skills',
    'plugins',
    'mcpServers',
  ], path);
  return Object.freeze({
    name,
    source,
    ...optionalProperty(record, 'description', path),
    ...optionalProperty(record, 'developerInstructions', path),
    ...optionalProperty(record, 'model', path),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: reasoningEffort(record.reasoningEffort, `${path}.reasoningEffort`) }),
    ...optionalCapabilities(record, path),
  });
}

function optionalProperty(
  record: Record<string, unknown>,
  key: 'description' | 'developerInstructions' | 'model',
  path: string,
): Record<string, string> {
  const value = optionalString(record[key], `${path}.${key}`);
  return value === undefined ? {} : { [key]: value };
}

function decodePresentation(value: unknown, path: string): AgentPresentationOverride {
  const record = objectValue(value, path);
  exactKeys(record, ['persona', 'color'], path);
  const persona = optionalString(record.persona, `${path}.persona`);
  if (persona !== undefined) validatePersona(persona, `${path}.persona`);
  const color = optionalString(record.color, `${path}.color`);
  if (color !== undefined && !IDENTITY_COLORS.includes(color as IdentityColor)) {
    throw new Error(`${path}.color must be one of ${IDENTITY_COLORS.join(', ')} - got '${color}'`);
  }
  return Object.freeze({
    ...(persona === undefined ? {} : { persona }),
    ...(color === undefined ? {} : { color }),
  });
}

function optionalCapabilities(
  record: Record<string, unknown>,
  path: string,
): Pick<ConfigurationProfile, 'tools' | 'skills' | 'plugins' | 'mcpServers'> {
  return {
    ...(record.tools === undefined ? {} : { tools: uniqueStringArray(record.tools, `${path}.tools`) }),
    ...(record.skills === undefined ? {} : { skills: uniqueStringArray(record.skills, `${path}.skills`) }),
    ...(record.plugins === undefined ? {} : { plugins: uniqueStringArray(record.plugins, `${path}.plugins`) }),
    ...(record.mcpServers === undefined ? {} : { mcpServers: uniqueStringArray(record.mcpServers, `${path}.mcpServers`) }),
  };
}

function effectiveConfiguration(profile: ConfigurationProfile): EffectiveThreadConfiguration {
  return Object.freeze({
    profileName: profile.name,
    developerInstructions: Object.freeze(profile.developerInstructions ? [profile.developerInstructions] : []),
    model: profile.model ?? DEFAULT_PROFILE.model!,
    reasoningEffort: profile.reasoningEffort ?? DEFAULT_PROFILE.reasoningEffort!,
    tools: Object.freeze([...(profile.tools ?? DEFAULT_PROFILE.tools!)]),
    skills: Object.freeze([...(profile.skills ?? DEFAULT_PROFILE.skills!)]),
    preloadedSkills: Object.freeze([]),
    plugins: Object.freeze([...(profile.plugins ?? DEFAULT_PROFILE.plugins!)]),
    mcpServers: Object.freeze([...(profile.mcpServers ?? DEFAULT_PROFILE.mcpServers!)]),
  });
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, path: string): Record<string, unknown> {
  return value === undefined ? {} : objectValue(value, path);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path} contains unknown field: ${unknown}`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, path);
}

function nonEmptyString(value: unknown, path: string): string {
  const normalized = stringValue(value, path).trim();
  if (!normalized) throw new Error(`${path} must be non-empty`);
  return normalized;
}

function uniqueStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const normalized = value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${path} cannot contain duplicates`);
  return Object.freeze(normalized);
}

function reasoningEffort(value: unknown, path: string): ReasoningEffort {
  const normalized = nonEmptyString(value, path);
  if (!(REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    throw new Error(`${path} must be one of: ${REASONING_EFFORTS.join(', ')}`);
  }
  return normalized as ReasoningEffort;
}

function normalizeSelectedName(value: string): string {
  const normalized = value.trim();
  validateDefinitionName(normalized, 'Configuration Profile');
  return normalized;
}

function validateDefinitionName(value: string, path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error(`${path} must use letters, digits, hyphens, and underscores`);
  }
}

function validatePersona(value: string, path: string): void {
  if (/[\n\r]/u.test(value)) throw new Error(`${path} must be a single line`);
  if ([...value].length > 40) throw new Error(`${path} must be at most 40 characters`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
