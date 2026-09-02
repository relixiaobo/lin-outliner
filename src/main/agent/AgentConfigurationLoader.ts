import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AGENT_PRESENTATIONS,
  IDENTITY_COLORS,
  MAIN_PRESENTATION_KEY,
  REASONING_EFFORTS,
  deriveIdentityColor,
  type AgentPresentation,
  type AgentPresentationOverride,
  type AgentExecutionSelection,
  type IdentityColor,
  type AgentRole,
  type AgentRoleOverrides,
  type ConfigurationProfile,
  type EffectiveThreadConfiguration,
  type ReasoningEffort,
} from '../../core/agent/configuration';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../core/agent/tools';
import type { AgentIdentityEntry, RoleCatalogContextPayload, RoleCatalogEntry } from '../../core/agent/protocol';
import type { ErrorReport } from '../../core/errorObservability';
import type {
  AgentBuiltInDefinition,
  AgentExecutionSelectionRow,
  AgentEditableRole,
  AgentPresentationOverrideRow,
  AgentProfileView,
} from '../../core/types';

interface ConfigurationLayer {
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyMap<string, ConfigurationProfile>;
  readonly roles: ReadonlyMap<string, AgentRole>;
  /**
   * Re-skins for identities this layer does not define: the built-in Agent
   * types and `main`. A Role carries its own presentation, so this map exists
   * for the identities a user cannot redefine without forking them.
   *
   * Layered per ENTRY, like Profiles and Roles: a project override replaces a
   * user one outright rather than merging field by field. One layering rule for
   * the whole file is worth more than the convenience of inheriting half an
   * override from underneath.
   */
  readonly presentationOverrides: ReadonlyMap<string, AgentPresentationOverride>;
  readonly agentExecution: ReadonlyMap<string, AgentExecutionSelection>;
}

export type AgentConfigurationReadFailureReporter = (report: ErrorReport) => void;

const EMPTY_LAYER: ConfigurationLayer = Object.freeze({
  defaultProfile: null,
  profiles: new Map(),
  roles: new Map(),
  presentationOverrides: new Map(),
  agentExecution: new Map(),
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

export const GENERAL_PURPOSE_AGENT_INSTRUCTIONS = `You are an agent for Tenon. Given the user's message, use the tools available to work the assigned task thoroughly within its scope. Don't gold-plate, but don't leave avoidable gaps. Your final response is a concise handoff for the caller: state what you produced or concluded, the checks or evidence used and their actual results, what remains incomplete, uncertain, or unchecked, and the next concrete action when work remains.

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

/**
 * Agent-type names a Role may not claim.
 *
 * `main` addresses the conversation's own agent wherever presentation is
 * written. A built-in canonical type is worse than merely taken: `agentTypeCandidates`
 * drops a dynamic Role that collides with one, so the Role would never dispatch —
 * while `resolveRole` prefers the configured entry, leaving the two resolution
 * paths disagreeing about which definition wins.
 */
export const RESERVED_AGENT_TYPE_NAMES: readonly string[] = Object.freeze([
  MAIN_PRESENTATION_KEY,
  ...BUILT_IN_AGENT_TYPES.map((entry) => entry.canonicalType),
  // The BACKING names too. `resolveRole` prefers a configured entry over the
  // built-in definition, and every spawn that names no role asks for
  // `default` — so a user Role called `default` would quietly become the
  // instructions every untyped Subagent runs.
  ...BUILT_IN_AGENT_TYPES.map((entry) => entry.backingRole),
]);

const DEFAULT_IDENTITY_CATALOG: readonly AgentIdentityEntry[] = Object.freeze([
  defaultIdentityEntry(MAIN_PRESENTATION_KEY),
  ...BUILT_IN_AGENT_TYPES.map((entry) => defaultIdentityEntry(entry.canonicalType)),
]);
const BUILT_IN_AGENT_TYPE_CANDIDATES: readonly ResolvedAgentType[] = Object.freeze(
  BUILT_IN_AGENT_TYPES.map((entry): ResolvedAgentType => Object.freeze({
    canonicalType: entry.canonicalType,
    role: BUILT_IN_AGENT_ROLE_DEFINITIONS[entry.backingRole]!,
    kind: entry.canonicalType,
  })),
);
const DEFAULT_ROLE_CATALOG = roleCatalogSnapshot(BUILT_IN_AGENT_TYPE_CANDIDATES);
const MAX_TRACKED_USER_PATH_FAILURES = 64;

export class AgentConfigurationLoader {
  /**
   * Configuration paths already reported during their current failure episode.
   * Each layer clears its own episode as soon as that file reads successfully;
   * the fixed cap bounds workspaces seen even when none of them recovers.
   */
  private readonly activeUserPathFailures = new Set<string>();

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
    return roleCatalogSnapshot(this.agentTypeCandidates(cwd));
  }

  buildAgentTypeCatalogSnapshot(cwd: string): RoleCatalogContextPayload {
    return this.buildRoleCatalogSnapshot(cwd);
  }

  /** The per-Turn Role read: invalid configuration retracts custom Roles. */
  buildRoleCatalogSnapshotForUserPath(
    cwd: string,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ): RoleCatalogContextPayload {
    return this.readForUserPath(
      'resolve-role-catalog',
      () => this.buildRoleCatalogSnapshot(cwd),
      () => DEFAULT_ROLE_CATALOG,
      reportFailure,
    );
  }

  /**
   * Every identity the reader can meet, with its name and face settled.
   *
   * Resolution is layered the way configuration is: the definition's own
   * presentation, then a user re-skin, then a project one. An identity with
   * nothing to say for itself is named after its type and wears the colour its
   * name derives — which is what an unconfigured custom Role should look like:
   * distinct the moment it exists, without anyone drawing anything.
   *
   * Deliberately NOT part of `buildRoleCatalogSnapshot`: that payload is the
   * model's view of the Agent catalog and its hashes gate re-announcement.
   * Presentation must never move those bytes, so it travels its own path.
   */
  resolveIdentityCatalog(cwd: string): readonly AgentIdentityEntry[] {
    // One parse of each layer for the whole call: `agentTypeCandidates` reads
    // the same merge, and `loadMerged` has no cache, so taking the default
    // path read both files twice per request.
    const merged = this.loadMerged(cwd);
    const candidates = this.agentTypeCandidates(cwd, merged);
    const entries: AgentIdentityEntry[] = [identityEntryForKey(merged, MAIN_PRESENTATION_KEY)!];
    for (const candidate of candidates) {
      entries.push(identityEntryForKey(merged, candidate.canonicalType)!);
    }
    return Object.freeze(entries);
  }

  /** The transcript/dock read: a broken catalog becomes the built-in roster. */
  resolveIdentityCatalogForUserPath(
    cwd: string,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ): readonly AgentIdentityEntry[] {
    return this.readForUserPath(
      'resolve-identity-catalog',
      () => this.resolveIdentityCatalog(cwd),
      () => DEFAULT_IDENTITY_CATALOG,
      reportFailure,
    );
  }

  /**
   * The name one participant answers to, resolved the way the transcript
   * resolves it.
   *
   * Live rather than recorded at spawn: a rename reaches the next Turn instead
   * of being frozen into the configuration a resumed Turn replays. It also
   * keeps `persona` out of the recorded configuration and its codec, where a
   * display name would have to be versioned forever.
   */
  resolveAgentPersona(
    agentType: string | null,
    cwd: string,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ): string {
    // A Thread records its BACKING Role (`explorer`), while identity is keyed on
    // the canonical Agent type (`explore`). Without this hop a subagent would be
    // told a name the reader never sees.
    const backing = BUILT_IN_AGENT_TYPES.find((entry) => entry.backingRole === agentType);
    const key = backing?.canonicalType ?? agentType ?? MAIN_PRESENTATION_KEY;
    // Resolve only this participant rather than constructing and freezing the
    // whole catalog on every Turn. The shared entry resolver also builds the
    // renderer catalog, so prompt and transcript keep identical fallback rules.
    return this.readForUserPath(
      'resolve-agent-persona',
      () => identityEntryForKey(this.loadMerged(cwd), key)?.persona.trim() || key,
      () => defaultIdentityEntry(key).persona,
      reportFailure,
    );
  }

  /**
   * A configuration read on the user path. Only typed configuration failures
   * degrade; a programming or injected resolver error still propagates.
   */
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

  /**
   * The name one Thread's agent answers to.
   *
   * A recorded nickname wins over the type's persona: an isolated Skill is
   * spawned with `role: 'default'` and the Skill's own name as its nickname, so
   * resolving by type would tell it it is `Bruno` — the general-purpose persona
   * — when its own name IS what it is.
   */
  resolveThreadPersona(thread: {
    readonly parentThreadId: string | null;
    readonly agentRole: string | null;
    readonly agentNickname: string | null;
    readonly cwd: string;
  }, reportFailure?: AgentConfigurationReadFailureReporter): string {
    return thread.agentNickname?.trim()
      || this.resolveAgentPersona(
        thread.parentThreadId === null ? null : thread.agentRole,
        thread.cwd,
        reportFailure,
      );
  }

  /**
   * The Roles a user may edit, with the layer each came from.
   *
   * Separate from `resolveIdentityCatalog`, which answers what the transcript
   * DRAWS: this answers what the editor may CHANGE. Built-in types are absent
   * on purpose — their definitions are frozen code constants, and the editor
   * re-skins them through `presentationOverrides` rather than pretending they
   * can be rewritten in place.
   */
  listEditableRoles(cwd: string): readonly AgentEditableRole[] {
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    const rows: AgentEditableRole[] = [];
    for (const [layer, source] of [[user, 'user'], [project, 'project']] as const) {
      for (const role of layer.roles.values()) {
        rows.push({
          name: role.name,
          layer: source,
          description: role.description,
          developerInstructions: role.developerInstructions,
          persona: role.presentation?.persona ?? null,
          color: role.presentation?.color ?? null,
          tools: role.overrides?.tools ?? null,
          skills: role.overrides?.skills ?? null,
        });
      }
    }
    return Object.freeze(rows.sort((left, right) => compareStableText(left.name, right.name)));
  }

  resolveAgentExecution(agentType: string, cwd: string): AgentExecutionSelection | null {
    return this.loadMerged(cwd).agentExecution.get(agentType) ?? null;
  }

  listAgentExecutionSelections(cwd: string): readonly AgentExecutionSelectionRow[] {
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    const rows: AgentExecutionSelectionRow[] = [];
    for (const [layer, source] of [[user, 'user'], [project, 'project']] as const) {
      for (const [agentType, selection] of layer.agentExecution) {
        rows.push({
          agentType,
          layer: source,
          modelProvider: selection.modelProvider ?? null,
          model: selection.model ?? null,
          reasoningEffort: selection.reasoningEffort ?? null,
        });
      }
    }
    return Object.freeze(rows.sort((left, right) => compareStableText(left.agentType, right.agentType)));
  }

  /**
   * The Configuration Profile in force, as WRITTEN.
   *
   * A field left null inherits the built-in default rather than meaning "empty",
   * which is what lets a later change to that default still reach the user —
   * the same rule presentation overrides follow.
   */
  resolveEditableProfile(cwd: string): AgentProfileView {
    const merged = this.loadMerged(cwd);
    const name = merged.defaultProfile ?? DEFAULT_PROFILE.name;
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    // Project replaces user entry-by-entry, matching how the layers resolve.
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

  /**
   * The built-in definitions, so the editor can seed a duplicate from one. They
   * are code constants and read-only everywhere: duplicating produces a Role the
   * user owns, it does not make the built-in editable.
   */
  listBuiltInDefinitions(): readonly AgentBuiltInDefinition[] {
    return Object.freeze(BUILT_IN_AGENT_TYPES.map((entry) => ({
      agentType: entry.canonicalType,
      description: entry.description,
      developerInstructions: BUILT_IN_AGENT_ROLE_DEFINITIONS[entry.backingRole]!.developerInstructions,
    })));
  }

  /**
   * The re-skins actually written down, per layer — as opposed to
   * `resolveIdentityCatalog`, which answers with the RESOLVED identity and so
   * cannot tell an override apart from the built-in default it happens to
   * equal.
   *
   * The editor needs the difference: seeding a field from the resolved value
   * and saving it back writes today's default in as a permanent override,
   * after which a later change to that default never reaches the user again.
   */
  listPresentationOverrides(cwd: string): readonly AgentPresentationOverrideRow[] {
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    const rows: AgentPresentationOverrideRow[] = [];
    for (const [layer, source] of [[user, 'user'], [project, 'project']] as const) {
      for (const [agentType, override] of layer.presentationOverrides) {
        rows.push({
          agentType,
          layer: source,
          persona: override.persona ?? null,
          color: override.color ?? null,
        });
      }
    }
    return Object.freeze(rows);
  }

  private agentTypeCandidates(cwd: string, preloaded?: ConfigurationLayer): ResolvedAgentType[] {
    const merged = preloaded ?? this.loadMerged(cwd);
    const dynamic = [...merged.roles.values()]
      .filter((role) => !BUILT_IN_AGENT_TYPE_CANDIDATES.some((candidate) => candidate.canonicalType === role.name))
      .sort((left, right) => compareStableText(left.name, right.name))
      .map((role): ResolvedAgentType => ({
        canonicalType: role.name,
        role,
        kind: 'role',
      }));
    return [...BUILT_IN_AGENT_TYPE_CANDIDATES, ...dynamic];
  }

  private loadMerged(cwd: string): ConfigurationLayer {
    const user = this.readLayerAndClearFailure(userConfigurationPath(this.userDataPath), 'user');
    const project = this.readLayerAndClearFailure(projectConfigurationPath(cwd), 'project');
    return {
      defaultProfile: project.defaultProfile ?? user.defaultProfile,
      profiles: new Map([...user.profiles, ...project.profiles]),
      roles: new Map([...user.roles, ...project.roles]),
      presentationOverrides: new Map([...user.presentationOverrides, ...project.presentationOverrides]),
      agentExecution: new Map([...user.agentExecution, ...project.agentExecution]),
    };
  }

  private readLayerAndClearFailure(
    path: string,
    source: 'user' | 'project',
  ): ConfigurationLayer {
    const layer = readLayer(path, source);
    this.activeUserPathFailures.delete(path);
    return layer;
  }
}

function identityEntryForKey(
  merged: ConfigurationLayer,
  key: string,
): AgentIdentityEntry | null {
  if (key === MAIN_PRESENTATION_KEY) {
    const resolved = overlayPresentation(
      merged,
      key,
      defaultAgentPresentation(key) ?? {
        persona: key,
        color: deriveIdentityColor(key),
      },
    );
    return {
      agentType: key,
      persona: resolved.persona,
      color: resolved.color,
      source: 'built-in',
    };
  }

  const builtIn = BUILT_IN_AGENT_TYPES.find((entry) => entry.canonicalType === key);
  const role = builtIn
    ? BUILT_IN_AGENT_ROLE_DEFINITIONS[builtIn.backingRole]!
    : merged.roles.get(key);
  if (!role) return null;
  const declared = role.presentation;
  const defaults = defaultAgentPresentation(key);
  const resolved = overlayPresentation(merged, key, {
    persona: declared?.persona ?? defaults?.persona ?? key,
    color: declared?.color ?? defaults?.color ?? deriveIdentityColor(key),
  });
  return {
    agentType: key,
    persona: resolved.persona,
    color: resolved.color,
    source: role.source === 'builtIn' ? 'built-in' : role.source,
  };
}

function overlayPresentation(
  merged: ConfigurationLayer,
  key: string,
  base: AgentPresentation,
): AgentPresentation {
  const override = merged.presentationOverrides.get(key);
  return {
    persona: override?.persona ?? base.persona,
    color: override?.color ?? base.color,
  };
}

function defaultIdentityEntry(key: string): AgentIdentityEntry {
  const presentation = defaultAgentPresentation(key);
  return {
    agentType: key,
    persona: presentation?.persona.trim() || key,
    color: presentation?.color ?? deriveIdentityColor(key),
    source: 'built-in',
  };
}

function defaultAgentPresentation(key: string): AgentPresentation | null {
  return Object.hasOwn(DEFAULT_AGENT_PRESENTATIONS, key)
    ? DEFAULT_AGENT_PRESENTATIONS[key] ?? null
    : null;
}

function roleCatalogEntry(role: AgentRole, name = role.name, description = role.description): RoleCatalogEntry {
  const source = role.source === 'builtIn' ? 'built-in' : role.source;
  // Presentation is deliberately absent: this hash gates re-announcing the
  // catalog to the model, and renaming an Agent on screen changes nothing the
  // model was told.
  const contentHash = createHash('sha256').update(JSON.stringify({
    name,
    source,
    description,
    developerInstructions: role.developerInstructions,
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

function roleCatalogSnapshot(candidates: readonly ResolvedAgentType[]): RoleCatalogContextPayload {
  const entries = Object.freeze(candidates.map((candidate) => (
    roleCatalogEntry(candidate.role, candidate.canonicalType, candidate.kind === 'role'
      ? candidate.role.description
      : BUILT_IN_AGENT_TYPES.find((entry) => entry.canonicalType === candidate.canonicalType)!.description)
  )));
  const catalogHash = createHash('sha256').update(JSON.stringify(entries.map((entry) => ({
    name: entry.name,
    displayName: entry.displayName,
    source: entry.source,
    identity: entry.identity,
    contentHash: entry.contentHash,
    description: entry.description,
  })))).digest('hex');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'roleCatalog',
    mode: 'baseline',
    previousCatalogHash: null,
    catalogHash,
    entries,
  });
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
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return decodeConfigurationLayer(value, source, path);
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

/**
 * Decode one layer from an in-memory value.
 *
 * Split out of `readLayer` so a WRITE can be validated before it exists on
 * disk: the writer builds a candidate, runs it through this — the same and only
 * parser the reader uses — and writes only if it survives. Validating a
 * candidate by writing it and re-reading leaves a window in which the rejected
 * bytes ARE the live configuration.
 */
export function decodeConfigurationLayer(
  value: unknown,
  source: 'user' | 'project',
  path: string,
): ConfigurationLayer {
  const root = objectValue(value, path);
  exactKeys(root, ['defaultProfile', 'profiles', 'roles', 'presentationOverrides', 'agentExecution'], path);
  const profiles = new Map<string, ConfigurationProfile>();
  for (const [name, profileValue] of Object.entries(optionalObject(root.profiles, `${path}.profiles`))) {
    validateDefinitionName(name, `${path}.profiles`);
    profiles.set(name, decodeProfile(name, profileValue, source, `${path}.profiles.${name}`));
  }
  const roles = new Map<string, AgentRole>();
  for (const [name, roleValue] of Object.entries(optionalObject(root.roles, `${path}.roles`))) {
    validateDefinitionName(name, `${path}.roles`);
    // `main` names the conversation's own agent everywhere presentation is
    // addressed. A Role by that name would resolve to one identity in the
    // override map and another in the Agent-type catalog.
    if (name === MAIN_PRESENTATION_KEY) {
      throw new Error(`${path}.roles.${name} is reserved: '${MAIN_PRESENTATION_KEY}' names the conversation's own agent`);
    }
    roles.set(name, decodeRole(name, roleValue, source, `${path}.roles.${name}`));
  }
  const presentationOverrides = new Map<string, AgentPresentationOverride>();
  for (const [name, overrideValue] of Object.entries(
    optionalObject(root.presentationOverrides, `${path}.presentationOverrides`),
  )) {
    if (name !== MAIN_PRESENTATION_KEY) validateDefinitionName(name, `${path}.presentationOverrides`);
    presentationOverrides.set(
      name,
      decodePresentation(overrideValue, `${path}.presentationOverrides.${name}`),
    );
  }
  const agentExecution = new Map<string, AgentExecutionSelection>();
  for (const [name, selectionValue] of Object.entries(
    optionalObject(root.agentExecution, `${path}.agentExecution`),
  )) {
    validateDefinitionName(name, `${path}.agentExecution`);
    const builtIn = BUILT_IN_AGENT_TYPES.some((entry) => entry.canonicalType === name);
    if (!builtIn && !roles.has(name)) {
      throw new Error(`${path}.agentExecution.${name} requires a Role in the same layer`);
    }
    agentExecution.set(name, decodeAgentExecutionSelection(
      selectionValue,
      `${path}.agentExecution.${name}`,
    ));
  }
  return {
    defaultProfile: root.defaultProfile === undefined
      ? null
      : normalizeSelectedName(stringValue(root.defaultProfile, `${path}.defaultProfile`), 'Configuration Profile'),
    profiles,
    roles,
    presentationOverrides,
    agentExecution,
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
    'presentation',
    'overrides',
  ], path);
  const description = nonEmptyString(record.description, `${path}.description`);
  const developerInstructions = nonEmptyString(record.developerInstructions, `${path}.developerInstructions`);
  const presentation = record.presentation === undefined
    ? undefined
    : decodePresentation(record.presentation, `${path}.presentation`);
  const overrides = record.overrides === undefined
    ? undefined
    : decodeRoleOverrides(record.overrides, `${path}.overrides`);
  return Object.freeze({
    name,
    source,
    description,
    developerInstructions,
    ...(presentation === undefined ? {} : { presentation }),
    ...(overrides === undefined ? {} : { overrides }),
  });
}

function decodePresentation(value: unknown, path: string): AgentPresentationOverride {
  const record = objectValue(value, path);
  exactKeys(record, ['persona', 'color'], path);
  const persona = record.persona === undefined
    ? undefined
    : nonEmptyString(record.persona, `${path}.persona`);
  if (persona !== undefined) validatePersona(persona, `${path}.persona`);
  const color = record.color === undefined
    ? undefined
    : nonEmptyString(record.color, `${path}.color`);
  if (color !== undefined && !IDENTITY_COLORS.includes(color as IdentityColor)) {
    throw new Error(
      `${path}.color must be one of ${IDENTITY_COLORS.join(', ')} — got '${color}'`,
    );
  }
  return Object.freeze({
    ...(persona === undefined ? {} : { persona }),
    ...(color === undefined ? {} : { color }),
  });
}

function decodeRoleOverrides(value: unknown, path: string): AgentRoleOverrides {
  const record = objectValue(value, path);
  exactKeys(record, ['tools', 'skills', 'plugins', 'mcpServers'], path);
  return Object.freeze({
    ...optionalCapabilities(record, path),
  });
}

function decodeAgentExecutionSelection(value: unknown, path: string): AgentExecutionSelection {
  const record = objectValue(value, path);
  exactKeys(record, ['modelProvider', 'model', 'reasoningEffort'], path);
  const modelProvider = optionalString(record.modelProvider, `${path}.modelProvider`);
  const model = optionalString(record.model, `${path}.model`);
  if ((modelProvider === undefined) !== (model === undefined)) {
    throw new Error(`${path}.modelProvider and ${path}.model must be set together`);
  }
  if (modelProvider !== undefined && !model!.startsWith(`${modelProvider}/`)) {
    throw new Error(`${path}.model must be qualified by modelProvider '${modelProvider}'`);
  }
  const effort = record.reasoningEffort === undefined
    ? undefined
    : reasoningEffort(record.reasoningEffort, `${path}.reasoningEffort`);
  if (model === undefined && effort === undefined) throw new Error(`${path} must not be empty`);
  return Object.freeze({
    ...(modelProvider === undefined ? {} : { modelProvider, model }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
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

/**
 * A persona is a display name, not an identifier: any script is welcome, so a
 * reader can call an Agent whatever they call it. It only has to fit on one
 * header line beside a role label in a 344px deck.
 */
const MAX_PERSONA_LENGTH = 40;

function validatePersona(value: string, path: string): void {
  // Leading/trailing space is not checked here: `nonEmptyString` upstream has
  // already trimmed it, so the branch that once lived here could never fire
  // and its error message promised a rejection that never happened.
  if (/[\n\r]/u.test(value)) throw new Error(`${path} must be a single line`);
  if ([...value].length > MAX_PERSONA_LENGTH) {
    throw new Error(`${path} must be at most ${MAX_PERSONA_LENGTH} characters`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
