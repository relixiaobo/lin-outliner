import {
  IDENTITY_COLOR_TINT,
  deriveIdentityColor,
  type IdentityColor,
} from '../../core/agent/configuration';
import type { AgentIdentityEntry } from '../../core/agent/protocol';

/** The stable presentation key for the conversation's own Agent. */
export const MAIN_IDENTITY_KEY = 'main';

/**
 * What to draw for one participant: its name and the hue its mark wears.
 *
 * Resolved at RENDER time from configuration rather than read off the Thread
 * that produced a message. A persona is a property of the presentation, not of
 * the words it once said; only a live lookup can apply a rename to history.
 */
export interface AgentIdentity {
  /** Display name: a persona if one is configured, else the type's own name. */
  readonly name: string;
  /** Identity-palette colour name. */
  readonly color: IdentityColor;
  /** The `--identity-tint-<n>` index for that colour. */
  readonly tint: number;
}

export type AgentIdentityCatalog = ReadonlyMap<string, AgentIdentityEntry>;

export const EMPTY_IDENTITY_CATALOG: AgentIdentityCatalog = new Map();

export function identityCatalogFrom(entries: readonly AgentIdentityEntry[]): AgentIdentityCatalog {
  return new Map(entries.map((entry) => [entry.agentType, entry]));
}

/**
 * One participant's identity, degrading rather than failing.
 *
 * Every step answers with something drawable, because this runs on the read
 * path of a transcript that must render Agents whose definition was edited,
 * renamed, or deleted after they ran (A12). A type with no catalog entry is
 * named after itself and wears the colour its name derives — exactly what an
 * unconfigured custom Role looks like on first run, so the fallback is also
 * the intended first appearance rather than an error state.
 *
 * `fallbackName` carries the caller's own best name for an uncatalogued
 * participant.
 */
export function resolveAgentIdentity(
  catalog: AgentIdentityCatalog,
  agentType: string | null,
  fallbackName?: string,
): AgentIdentity {
  const entry = agentType === null ? undefined : catalog.get(agentType);
  const name = entry?.persona?.trim()
    // Before the catalog answers — or if it never does — the conversation's own
    // agent still deserves a name rather than the raw key `main`. Every other
    // type IS named after itself, which is what an unconfigured Role should
    // look like.
    || (agentType === MAIN_IDENTITY_KEY ? fallbackName?.trim() : agentType?.trim())
    || agentType?.trim() || fallbackName?.trim() || '?';
  // The catalog's colour is trusted but not blindly: a stale entry naming a
  // hue the palette no longer has degrades to derivation instead of drawing
  // nothing. `hasOwn`, not `in`: an entry claiming `toString` would otherwise
  // pass and hand a function to the renderer as a tint.
  const color = entry !== undefined && Object.hasOwn(IDENTITY_COLOR_TINT, entry.color)
    ? entry.color as IdentityColor
    : deriveIdentityColor(agentType ?? fallbackName ?? MAIN_IDENTITY_KEY);
  return { name, color, tint: IDENTITY_COLOR_TINT[color] };
}
