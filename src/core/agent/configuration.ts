export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface ConfigurationProfile {
  readonly name: string;
  readonly source: 'builtIn' | 'user' | 'project';
  readonly description?: string;
  readonly developerInstructions?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
}

export interface AgentRoleOverrides {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
}

export interface AgentRole {
  readonly name: string;
  readonly source: 'builtIn' | 'user' | 'project';
  readonly description: string;
  readonly developerInstructions: string;
  /** What the reader calls this Agent and what its face looks like. */
  readonly presentation?: AgentPresentationOverride;
  readonly overrides?: AgentRoleOverrides;
}

export const BUILT_IN_AGENT_ROLES = ['default', 'explorer', 'plan'] as const;
export type BuiltInAgentRoleName = typeof BUILT_IN_AGENT_ROLES[number];

/**
 * How an Agent identity is presented to the reader: a name and a face.
 *
 * Presentation is a HOST-SIDE concern and never reaches a model. The model
 * addresses Agent types and raw Agent IDs — the byte-locked tool contract says
 * `explore`, and it must keep saying `explore` no matter what the reader calls
 * that Agent on screen. Keeping the two apart is what makes a persona free to
 * change: renaming `Fox` cannot break a prompt, a fixture, or a catalog hash.
 *
 * It is keyed by Agent TYPE rather than by Agent, because an Agent is a
 * short-lived instance and a type is the durable thing a user configures. Three
 * concurrent `explore` children are three runs of one identity, and they share
 * a face the way three copies of a tool share an icon; the task each was handed
 * is what tells them apart, on the report each brings back.
 */
export interface AgentPresentationOverride {
  readonly persona?: string;
  readonly avatar?: string;
}

/** A presentation with every field settled: what the renderer draws. */
export interface AgentPresentation {
  readonly persona: string;
  /** A bundled portrait key, or null to wear the initial-disc fallback. */
  readonly avatar: string | null;
}

/**
 * The bundled portraits.
 *
 * The persona IS the animal: what you see is what it is called, so a roster
 * stays learnable without a legend. Adding a key here is adding an image to
 * `src/renderer/assets/agent-avatars/`; a configuration naming a key that does
 * not exist is refused at the write boundary rather than silently drawn blank.
 */
export const AGENT_AVATAR_KEYS = ['beaver', 'fox', 'owl', 'bear'] as const;
export type AgentAvatarKey = typeof AGENT_AVATAR_KEYS[number];

/**
 * The conversation's own agent, addressed where an Agent type would go.
 *
 * `main` has no Role — it is the root Thread, configured by a Profile — but it
 * is a participant like any other and needs the same name and face. Reserving
 * one key lets a user re-skin it through the same override path, and the loader
 * refuses it as a Role name so the two can never collide.
 */
export const MAIN_PRESENTATION_KEY = 'main';

/** The roster a fresh install starts with, keyed by Agent type. */
export const DEFAULT_AGENT_PRESENTATIONS: Readonly<Record<string, AgentPresentation>> = Object.freeze({
  [MAIN_PRESENTATION_KEY]: Object.freeze({ persona: 'Tenon', avatar: 'beaver' }),
  'general-purpose': Object.freeze({ persona: 'Bear', avatar: 'bear' }),
  explore: Object.freeze({ persona: 'Fox', avatar: 'fox' }),
  plan: Object.freeze({ persona: 'Owl', avatar: 'owl' }),
});

export interface EffectiveThreadConfiguration {
  readonly profileName: string | null;
  readonly developerInstructions: readonly string[];
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  /** Role-declared Skills whose full content is admitted on a fresh child Turn. */
  readonly preloadedSkills: readonly string[];
  readonly plugins: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface ChildConfigurationRequest {
  readonly role: AgentRole;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export function resolveChildConfiguration(
  parent: EffectiveThreadConfiguration,
  request: ChildConfigurationRequest,
): EffectiveThreadConfiguration {
  const overrides = request.role.overrides;
  const preloadedSkills = constrainPreloadedSkills(parent.skills, overrides?.skills);

  return Object.freeze({
    profileName: parent.profileName,
    developerInstructions: Object.freeze([request.role.developerInstructions]),
    model: request.model ?? overrides?.model ?? parent.model,
    reasoningEffort: request.reasoningEffort ?? overrides?.reasoningEffort ?? parent.reasoningEffort,
    tools: constrainChildCapabilities(parent.tools, overrides?.tools),
    skills: constrainChildCapabilities(parent.skills, overrides?.skills),
    preloadedSkills,
    plugins: constrainChildCapabilities(parent.plugins, overrides?.plugins),
    mcpServers: constrainChildCapabilities(parent.mcpServers, overrides?.mcpServers),
  });
}

function constrainPreloadedSkills(
  parent: readonly string[],
  requested: readonly string[] | undefined,
): readonly string[] {
  if (!requested) return Object.freeze([]);
  const concrete = [...new Set(requested)].filter((skill) => skill !== '*');
  if (parent.includes('*')) return Object.freeze(concrete);
  const parentCeiling = new Set(parent);
  return Object.freeze(concrete.filter((skill) => parentCeiling.has(skill)));
}

function constrainChildCapabilities(
  parent: readonly string[],
  requested: readonly string[] | undefined,
): readonly string[] {
  if (!requested) return Object.freeze([...new Set(parent)]);
  if (parent.includes('*')) return Object.freeze([...new Set(requested)]);
  if (requested.includes('*')) return Object.freeze([...new Set(parent)]);
  const parentCeiling = new Set(parent);
  return Object.freeze([...new Set(requested)].filter((capability) => parentCeiling.has(capability)));
}
