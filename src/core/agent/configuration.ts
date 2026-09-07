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

/**
 * How the root conversation Agent is presented to the reader: a name and a face.
 *
 * Presentation is a HOST-SIDE concern and never reaches a model. The root
 * conversation identity is configured independently from model
 * behavior, so changing its presentation cannot change a prompt contract.
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
 * The conversation Agent wears one soft mark whose colour comes from
 * drawn from the `--identity-tint-*` ladder the app already uses for identity
 * (tags, usage chart). Names map to tint indices below. Red — tint 0 — is
 * deliberately absent: it sits next to `--status-danger`, and a mark whose
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
 * The root Thread's conversation presentation key.
 *
 * Reserving one key keeps the persisted override stable without making it an
 * Agent type or execution selector.
 */
export const MAIN_PRESENTATION_KEY = 'main';

/**
 * The root identity a fresh install starts with.
 */
export const DEFAULT_AGENT_PRESENTATIONS: Readonly<Record<string, AgentPresentation>> = Object.freeze({
  [MAIN_PRESENTATION_KEY]: Object.freeze({ persona: 'Aspen', color: 'teal' }),
});

/**
 * Hues open to deterministic fallback derivation.
 */
export const DERIVED_IDENTITY_COLORS: readonly IdentityColor[] = Object.freeze(
  IDENTITY_COLORS.filter((color) => !Object.values(DEFAULT_AGENT_PRESENTATIONS).some((p) => p.color === color)),
);

/**
 * The colour an identity wears when nobody chose one. Deterministic in the
 * identity key, so the same fallback is stable across restarts. Any string
 * resolves to a palette hue.
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
  /** Skills whose full content is admitted on a fresh Turn. */
  readonly preloadedSkills: readonly string[];
  readonly plugins: readonly string[];
  readonly mcpServers: readonly string[];
}
