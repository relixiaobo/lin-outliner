import type { AgentIdentityEntry } from '../../core/agent/protocol';
import { agentAvatarColor, agentAvatarInitial, type AgentAvatarColor } from './agentAvatarColor';

/** The conversation's own agent, where an Agent type would go. */
export const MAIN_IDENTITY_KEY = 'main';

/**
 * What to draw for one participant: its name, which portrait it wears, and the
 * initial disc it falls back to.
 *
 * Resolved at RENDER time from configuration rather than read off the Thread
 * that produced a message. A persona is a property of the identity, not of the
 * words it once said — renaming `Fox` has to rename the speaker of every
 * message that Agent ever sent, and only a live lookup does that.
 *
 * Deliberately data, not markup: the portrait is named here and loaded where it
 * is drawn, so identity resolution stays a plain function.
 */
export interface AgentIdentity {
  /** Display name: a persona if one is configured, else the type's own name. */
  readonly name: string;
  /** Bundled portrait key, or null to wear the initial disc. */
  readonly avatarKey: string | null;
  /** The disc colour, always resolved: it shows under and around a portrait. */
  readonly color: AgentAvatarColor;
  readonly initial: string;
}

export type AgentIdentityCatalog = ReadonlyMap<string, AgentIdentityEntry>;

export const EMPTY_IDENTITY_CATALOG: AgentIdentityCatalog = new Map();

export function identityCatalogFrom(entries: readonly AgentIdentityEntry[]): AgentIdentityCatalog {
  return new Map(entries.map((entry) => [entry.agentType, entry]));
}

/**
 * One participant's identity, degrading rather than failing.
 *
 * Every step of the chain answers with something drawable, because this runs on
 * the read path of a transcript that must render Agents whose definition was
 * edited, renamed, or deleted after they ran (A12). A type with no entry is
 * named after itself and wears its initial — which is exactly what an
 * unconfigured custom Role should look like, so the fallback is also the
 * intended first-run appearance rather than an error state.
 *
 * `fallbackName` carries the caller's own best name for participants that are
 * not types at all: an isolated Skill is named by the Skill, and has no persona
 * to find.
 */
export function resolveAgentIdentity(
  catalog: AgentIdentityCatalog,
  agentType: string | null,
  fallbackName?: string,
): AgentIdentity {
  const entry = agentType === null ? undefined : catalog.get(agentType);
  const name = entry?.persona?.trim() || agentType?.trim() || fallbackName?.trim() || '?';
  return {
    name,
    avatarKey: entry?.avatar ?? null,
    // Keyed by TYPE, not by the displayed name: one type, one colour,
    // everywhere — a hue that moved when a persona was renamed would make the
    // same participant look like a different one across two conversations.
    color: agentAvatarColor(agentType ?? MAIN_IDENTITY_KEY),
    initial: agentAvatarInitial(name),
  };
}
