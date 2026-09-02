import { identitySlot } from '../identityHash';

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
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
}

/** A standing execution preference for fresh collaboration Agents of one type. */
export interface AgentExecutionSelection {
  readonly modelProvider?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
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
  readonly color?: string;
}

/** A presentation with every field settled: what the renderer draws. */
export interface AgentPresentation {
  readonly persona: string;
  /** An identity-palette colour name; the mark is drawn in this hue. */
  readonly color: string;
}

/**
 * The identity palette, by name.
 *
 * Every agent wears the SAME soft mark; what tells them apart is the colour,
 * drawn from the `--identity-tint-*` ladder the app already uses for identity
 * (tags, usage chart). Names map to tint indices below. Red — tint 0 — is
 * deliberately absent: it sits next to `--status-danger`, and an agent whose
 * mark reads as an error every time it speaks is a worse trade than one fewer
 * hue.
 */
export const IDENTITY_COLORS = ['orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const;
export type IdentityColor = typeof IDENTITY_COLORS[number];

/** Colour name → `--identity-tint-<n>` index. */
export const IDENTITY_COLOR_TINT: Readonly<Record<IdentityColor, number>> = Object.freeze({
  orange: 1, amber: 2, green: 3, teal: 4, blue: 5, violet: 6, pink: 7,
});

/**
 * The conversation's own agent, addressed where an Agent type would go.
 *
 * `main` has no Role — it is the root Thread, configured by a Profile — but it
 * is a participant like any other and needs the same name and face. Reserving
 * one key lets a user re-skin it through the same override path, and the loader
 * refuses it as a Role name so the two can never collide.
 */
export const MAIN_PRESENTATION_KEY = 'main';

/**
 * The roster a fresh install starts with, keyed by Agent type. The four hues
 * are hand-picked and well separated — four names hashed into seven buckets
 * collide about half the time, and a fixed roster is small enough to assign.
 */
export const DEFAULT_AGENT_PRESENTATIONS: Readonly<Record<string, AgentPresentation>> = Object.freeze({
  [MAIN_PRESENTATION_KEY]: Object.freeze({ persona: 'Aspen', color: 'teal' }),
  'general-purpose': Object.freeze({ persona: 'Bruno', color: 'amber' }),
  explore: Object.freeze({ persona: 'Rena', color: 'orange' }),
  plan: Object.freeze({ persona: 'Ada', color: 'blue' }),
});

/**
 * Hues open to DERIVATION — everything the default roster did not take. A
 * custom Role gets its colour from its name so it is distinct the moment it is
 * created; deriving over the built-ins' hues would let a fresh Role walk in
 * wearing Aspen's teal, and a collision with `main` is the one that misleads.
 * (An explicit `presentation.color` may still choose any palette hue.)
 */
export const DERIVED_IDENTITY_COLORS: readonly IdentityColor[] = Object.freeze(
  IDENTITY_COLORS.filter((color) => !Object.values(DEFAULT_AGENT_PRESENTATIONS).some((p) => p.color === color)),
);

/**
 * The colour an identity wears when nobody chose one. Deterministic in the
 * identity key, so the same Role is the same hue in every conversation and
 * after every restart; degrades never — any string resolves to a palette hue.
 *
 * Keyed through the SHARED `identitySlot`, not a second hash of its own: tag
 * chips and identity marks draw from one palette, and one family reads as one
 * family only while there is one derivation.
 */
export function deriveIdentityColor(key: string): IdentityColor {
  return DERIVED_IDENTITY_COLORS[identitySlot(key, DERIVED_IDENTITY_COLORS.length)]!;
}

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
  readonly execution?: AgentExecutionSelection;
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
    model: request.execution?.model ?? parent.model,
    reasoningEffort: request.execution?.reasoningEffort ?? parent.reasoningEffort,
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
