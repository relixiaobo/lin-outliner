import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REASONING_EFFORTS,
  type AgentRole,
  type AgentRoleOverrides,
  type ConfigurationProfile,
  type EffectiveThreadConfiguration,
  type ReasoningEffort,
} from '../../core/agent/configuration';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../core/agent/tools';

interface ConfigurationLayer {
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyMap<string, ConfigurationProfile>;
  readonly roles: ReadonlyMap<string, AgentRole>;
}

const EMPTY_LAYER: ConfigurationLayer = Object.freeze({
  defaultProfile: null,
  profiles: new Map(),
  roles: new Map(),
});

const DEFAULT_PROFILE: ConfigurationProfile = Object.freeze({
  name: 'default',
  source: 'builtIn',
  description: 'General-purpose root Thread configuration.',
  model: 'inherit',
  reasoningEffort: 'medium',
  tools: Object.freeze(MODEL_TOOL_CATALOG.map((tool) => canonicalModelToolKey(tool.identity))),
  skills: Object.freeze([]),
  plugins: Object.freeze([]),
  mcpServers: Object.freeze([]),
});

export const BUILT_IN_AGENT_ROLE_DEFINITIONS: Readonly<Record<string, AgentRole>> = Object.freeze({
  default: Object.freeze({
    name: 'default',
    source: 'builtIn',
    description: 'General-purpose Subagent.',
    developerInstructions: 'Work on the assigned task and report concrete results to the parent Thread.',
  }),
  worker: Object.freeze({
    name: 'worker',
    source: 'builtIn',
    description: 'Implementation-focused Subagent.',
    developerInstructions: 'Execute the assigned implementation carefully, verify it, and report the changed artifacts.',
  }),
  explorer: Object.freeze({
    name: 'explorer',
    source: 'builtIn',
    description: 'Read-oriented research Subagent.',
    developerInstructions: 'Inspect the assigned area, gather evidence, and report findings without speculative changes.',
  }),
});

export class AgentConfigurationLoader {
  constructor(private readonly userDataPath: string) {}

  resolveProfile(requestedName: string | undefined, cwd: string): EffectiveThreadConfiguration {
    const merged = this.loadMerged(cwd);
    const name = normalizeSelectedName(requestedName ?? merged.defaultProfile ?? 'default', 'Configuration Profile');
    const profile = merged.profiles.get(name) ?? (name === DEFAULT_PROFILE.name ? DEFAULT_PROFILE : null);
    if (!profile) throw new Error(`Unknown Configuration Profile: ${name}`);
    return effectiveConfiguration(profile);
  }

  resolveRole(nameInput: string, cwd: string): AgentRole {
    const name = normalizeSelectedName(nameInput, 'Agent Role');
    const merged = this.loadMerged(cwd);
    const role = merged.roles.get(name) ?? BUILT_IN_AGENT_ROLE_DEFINITIONS[name];
    if (!role) throw new Error(`Unknown Agent Role: ${name}`);
    return role;
  }

  private loadMerged(cwd: string): ConfigurationLayer {
    const user = readLayer(userConfigurationPath(this.userDataPath), 'user');
    const project = readLayer(projectConfigurationPath(cwd), 'project');
    return {
      defaultProfile: project.defaultProfile ?? user.defaultProfile,
      profiles: new Map([...user.profiles, ...project.profiles]),
      roles: new Map([...user.roles, ...project.roles]),
    };
  }
}

export function userConfigurationPath(userDataPath: string): string {
  return join(userDataPath, 'agent', 'config.json');
}

export function projectConfigurationPath(cwd: string): string {
  return join(cwd, '.tenon', 'agent.json');
}

export function defaultEffectiveThreadConfiguration(
  profileName = 'default',
): EffectiveThreadConfiguration {
  if (profileName !== 'default') throw new Error(`Unknown Configuration Profile: ${profileName}`);
  return effectiveConfiguration(DEFAULT_PROFILE);
}

function readLayer(path: string, source: 'user' | 'project'): ConfigurationLayer {
  if (!existsSync(path)) return EMPTY_LAYER;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Agent configuration at ${path}: ${errorMessage(error)}`);
  }
  const root = objectValue(value, path);
  exactKeys(root, ['defaultProfile', 'profiles', 'roles'], path);
  const profiles = new Map<string, ConfigurationProfile>();
  for (const [name, profileValue] of Object.entries(optionalObject(root.profiles, `${path}.profiles`))) {
    validateDefinitionName(name, `${path}.profiles`);
    profiles.set(name, decodeProfile(name, profileValue, source, `${path}.profiles.${name}`));
  }
  const roles = new Map<string, AgentRole>();
  for (const [name, roleValue] of Object.entries(optionalObject(root.roles, `${path}.roles`))) {
    validateDefinitionName(name, `${path}.roles`);
    roles.set(name, decodeRole(name, roleValue, source, `${path}.roles.${name}`));
  }
  return {
    defaultProfile: root.defaultProfile === undefined
      ? null
      : normalizeSelectedName(stringValue(root.defaultProfile, `${path}.defaultProfile`), 'Configuration Profile'),
    profiles,
    roles,
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
    ...(optionalString(record.description, `${path}.description`) === undefined
      ? {}
      : { description: optionalString(record.description, `${path}.description`) }),
    ...(optionalString(record.developerInstructions, `${path}.developerInstructions`) === undefined
      ? {}
      : { developerInstructions: optionalString(record.developerInstructions, `${path}.developerInstructions`) }),
    ...(optionalString(record.model, `${path}.model`) === undefined
      ? {}
      : { model: optionalString(record.model, `${path}.model`) }),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: reasoningEffort(record.reasoningEffort, `${path}.reasoningEffort`) }),
    ...optionalCapabilities(record, path),
  });
}

function decodeRole(
  name: string,
  value: unknown,
  source: 'user' | 'project',
  path: string,
): AgentRole {
  const record = objectValue(value, path);
  exactKeys(record, [
    'description',
    'developerInstructions',
    'nicknameCandidates',
    'overrides',
  ], path);
  const description = nonEmptyString(record.description, `${path}.description`);
  const developerInstructions = nonEmptyString(record.developerInstructions, `${path}.developerInstructions`);
  const nicknameCandidates = record.nicknameCandidates === undefined
    ? undefined
    : uniqueStringArray(record.nicknameCandidates, `${path}.nicknameCandidates`, validateNickname);
  const overrides = record.overrides === undefined
    ? undefined
    : decodeRoleOverrides(record.overrides, `${path}.overrides`);
  return Object.freeze({
    name,
    source,
    description,
    developerInstructions,
    ...(nicknameCandidates === undefined ? {} : { nicknameCandidates }),
    ...(overrides === undefined ? {} : { overrides }),
  });
}

function decodeRoleOverrides(value: unknown, path: string): AgentRoleOverrides {
  const record = objectValue(value, path);
  exactKeys(record, ['model', 'reasoningEffort', 'tools', 'skills', 'plugins', 'mcpServers'], path);
  return Object.freeze({
    ...(optionalString(record.model, `${path}.model`) === undefined
      ? {}
      : { model: optionalString(record.model, `${path}.model`) }),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: reasoningEffort(record.reasoningEffort, `${path}.reasoningEffort`) }),
    ...optionalCapabilities(record, path),
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

function uniqueStringArray(
  value: unknown,
  path: string,
  validate: (value: string, path: string) => void = () => undefined,
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const normalized = value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
  normalized.forEach((entry, index) => validate(entry, `${path}[${index}]`));
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

function normalizeSelectedName(value: string, label: string): string {
  const normalized = value.trim();
  validateDefinitionName(normalized, label);
  return normalized;
}

function validateDefinitionName(value: string, path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error(`${path} must use letters, digits, hyphens, and underscores`);
  }
}

function validateNickname(value: string, path: string): void {
  if (!/^[A-Za-z0-9 _-]+$/u.test(value)) {
    throw new Error(`${path} may use only ASCII letters, digits, spaces, hyphens, and underscores`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
