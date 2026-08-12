import { createHash } from 'node:crypto';
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
import type { RoleCatalogContextPayload, RoleCatalogEntry } from '../../core/agent/protocol';

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
  skills: Object.freeze(['*']),
  plugins: Object.freeze([]),
  mcpServers: Object.freeze([]),
});

export const GENERAL_PURPOSE_AGENT_INSTRUCTIONS = `You are an agent for Tenon. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use file_read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

export const EXPLORE_AGENT_INSTRUCTIONS = `You are a file search specialist for Tenon. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no file_write, touch, or file creation of any kind)
- Modifying existing files (no file_edit operations)
- Deleting files (no rm, file_delete, or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use file_glob for broad file pattern matching
- Use file_grep for searching file contents with regex
- Use file_read when you know the specific file path you need to read
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

export const PLAN_AGENT_INSTRUCTIONS = `You are a software architect and planning specialist for Tenon. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no file_write, touch, or file creation of any kind)
- Modifying existing files (no file_edit operations)
- Deleting files (no rm, file_delete, or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using file_glob, file_grep, and file_read
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
   - NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`;

export const BUILT_IN_AGENT_ROLE_DEFINITIONS: Readonly<Record<string, AgentRole>> = Object.freeze({
  default: Object.freeze({
    name: 'default',
    source: 'builtIn',
    description: 'General-purpose Subagent.',
    developerInstructions: GENERAL_PURPOSE_AGENT_INSTRUCTIONS,
  }),
  explorer: Object.freeze({
    name: 'explorer',
    source: 'builtIn',
    description: 'Fast Agent specialized for exploring codebases.',
    developerInstructions: EXPLORE_AGENT_INSTRUCTIONS,
  }),
  plan: Object.freeze({
    name: 'plan',
    source: 'builtIn',
    description: 'Software architect Agent for designing implementation plans.',
    developerInstructions: PLAN_AGENT_INSTRUCTIONS,
  }),
});

export interface ResolvedAgentType {
  readonly canonicalType: string;
  readonly role: AgentRole;
  readonly kind: 'general-purpose' | 'explore' | 'plan' | 'role';
}

const BUILT_IN_AGENT_TYPES = [
  {
    canonicalType: 'general-purpose',
    backingRole: 'default',
    description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
  },
  {
    canonicalType: 'explore',
    backingRole: 'explorer',
    description: 'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
  },
  {
    canonicalType: 'plan',
    backingRole: 'plan',
    description: 'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.',
  },
] as const;

const HIDDEN_BACKING_ROLE_NAMES: ReadonlySet<string> = new Set(
  BUILT_IN_AGENT_TYPES.map((entry) => entry.backingRole),
);

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

  resolveAgentType(nameInput: string | undefined, cwd: string): ResolvedAgentType {
    const candidates = this.agentTypeCandidates(cwd);
    const input = nameInput ?? 'general-purpose';
    const exact = candidates.find((candidate) => candidate.canonicalType === input);
    if (exact) return exact;
    const normalizedInput = normalizeAgentTypeForMatch(input);
    const matches = candidates.filter((candidate) => (
      normalizeAgentTypeForMatch(candidate.canonicalType) === normalizedInput
    ));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const names = matches.map((candidate) => candidate.canonicalType);
      throw new Error(
        `Agent type '${input}' is ambiguous — matches ${names.join(', ')}. Use the exact name: ${joinAlternatives(names)}`,
      );
    }
    throw new Error(
      `Agent type '${input}' not found. Available agents: ${candidates.map((candidate) => candidate.canonicalType).join(', ')}`,
    );
  }

  buildRoleCatalogSnapshot(cwd: string): RoleCatalogContextPayload {
    const entries = this.agentTypeCandidates(cwd).map((candidate) => (
      roleCatalogEntry(candidate.role, candidate.canonicalType, candidate.kind === 'role'
        ? candidate.role.description
        : BUILT_IN_AGENT_TYPES.find((entry) => entry.canonicalType === candidate.canonicalType)!.description)
    ));
    const catalogHash = createHash('sha256').update(JSON.stringify(entries.map((entry) => ({
      name: entry.name,
      displayName: entry.displayName,
      source: entry.source,
      identity: entry.identity,
      contentHash: entry.contentHash,
      description: entry.description,
    })))).digest('hex');
    return {
      schemaVersion: 1,
      kind: 'roleCatalog',
      mode: 'baseline',
      previousCatalogHash: null,
      catalogHash,
      entries,
    };
  }

  buildAgentTypeCatalogSnapshot(cwd: string): RoleCatalogContextPayload {
    return this.buildRoleCatalogSnapshot(cwd);
  }

  private agentTypeCandidates(cwd: string): ResolvedAgentType[] {
    const merged = this.loadMerged(cwd);
    const builtIns = BUILT_IN_AGENT_TYPES.map((entry): ResolvedAgentType => ({
      canonicalType: entry.canonicalType,
      role: BUILT_IN_AGENT_ROLE_DEFINITIONS[entry.backingRole]!,
      kind: entry.canonicalType,
    }));
    const dynamic = [...merged.roles.values()]
      .filter((role) => !HIDDEN_BACKING_ROLE_NAMES.has(role.name))
      .filter((role) => !builtIns.some((candidate) => candidate.canonicalType === role.name))
      .sort((left, right) => compareStableText(left.name, right.name))
      .map((role): ResolvedAgentType => ({
        canonicalType: role.name,
        role,
        kind: 'role',
      }));
    return [...builtIns, ...dynamic];
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

function roleCatalogEntry(role: AgentRole, name = role.name, description = role.description): RoleCatalogEntry {
  const source = role.source === 'builtIn' ? 'built-in' : role.source;
  const contentHash = createHash('sha256').update(JSON.stringify({
    name,
    source,
    description,
    developerInstructions: role.developerInstructions,
    nicknameCandidates: role.nicknameCandidates ?? [],
    overrides: role.overrides ?? null,
  })).digest('hex');
  return {
    change: 'available',
    name,
    displayName: name,
    source,
    identity: `${source}:${name}`,
    contentHash,
    description,
  };
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

function normalizeAgentTypeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[ _-]+/gu, '-');
}

function joinAlternatives(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
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

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
