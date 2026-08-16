import { IDENTITY_SURFACE_TINT, identitySlot } from '../ui/tags/identityHash';

/**
 * The hue a participant's avatar wears.
 *
 * Identity is its own decorative category, separate from every colour rule the
 * design system fixes: it is not a functional state (B3 keeps selection, hover,
 * active and focus neutral), not a status (B4 reserves those hues for meaning),
 * and not the rose accent (B4 spends that sparsely on brand marks). The palette
 * is the shared `--identity-tint-*` set, so avatars, tag chips and the usage
 * chart read as one coordinated family rather than three inventions.
 *
 * Red is left out: it sits next to `--status-danger`, and an Agent whose avatar
 * reads as an error every time it speaks is a worse trade than one fewer hue.
 *
 * The tint is mixed toward `--bg-content` rather than baked, so the same
 * identity is a soft light wash in light mode and a soft dark one in dark —
 * never the near-white disc that glared out of a dark panel.
 */
export interface AgentAvatarColor {
  /** The initial's colour: the hue itself, legible on its own tint. */
  readonly text: string;
  /** The disc: that hue mixed toward the live content surface. */
  readonly background: string;
}

const AVATAR_HUES = [
  'var(--identity-tint-1)', // orange
  'var(--identity-tint-2)', // amber
  'var(--identity-tint-3)', // green
  'var(--identity-tint-4)', // teal
  'var(--identity-tint-5)', // blue
  'var(--identity-tint-6)', // violet
  'var(--identity-tint-7)', // pink
].map((hue): AgentAvatarColor => ({
  text: hue,
  background: `color-mix(in srgb, ${hue} ${IDENTITY_SURFACE_TINT}, var(--bg-content))`,
}));

/**
 * The conversation's own agent, in every conversation.
 *
 * `main` is one participant from the reader's side of the screen — the one that
 * is always there — so its hue is pinned to this untranslated key rather than
 * hashed from a Thread id that changes with every new conversation, or from its
 * displayed name, which is translated. A participant whose colour changed when
 * you opened a new chat, or switched language, would not be a participant.
 */
export const MAIN_AVATAR_IDENTITY = 'main';

/**
 * One TYPE, one avatar — everywhere, in every conversation, for good.
 *
 * Derived rather than enumerated: an Agent type is any name a project puts in
 * `.claude/agents/*.md`, so a hand-kept table of hues would silently miss the
 * ones that matter most to a given workspace. Hashing the type name is fixed
 * per type without needing to know the types in advance.
 *
 * Keyed by type rather than by Agent id on purpose. Two `general-purpose`
 * siblings share one NAME in this stream, so giving them different discs said
 * they were different kinds of participant; and an id-keyed hue repainted the
 * same Agent on the way into its own pushed view. What tells two siblings apart
 * is the task on each one's report, not its colour.
 *
 * Colliding hues remain possible across many types; the name sits beside the
 * disc and is the identity of record.
 */
export function agentAvatarColor(agentType: string): AgentAvatarColor {
  return AVATAR_HUES[identitySlot(agentType, AVATAR_HUES.length)]!;
}

/**
 * The one character the disc shows.
 *
 * Read by code point, not by UTF-16 unit: a name that opens with an emoji or
 * any astral character would otherwise render half a surrogate pair.
 */
export function agentAvatarInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? '?';
  return first.toLocaleUpperCase();
}
