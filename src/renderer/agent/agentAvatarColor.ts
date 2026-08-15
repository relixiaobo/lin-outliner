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

const AVATAR_SURFACE_TINT = '14%';

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
  background: `color-mix(in srgb, ${hue} ${AVATAR_SURFACE_TINT}, var(--bg-content))`,
}));

/**
 * The conversation's own agent, in every conversation.
 *
 * `main` is one participant from the reader's side of the screen — the one that
 * is always there — so its hue is pinned to a name rather than hashed from a
 * Thread id that changes with every new conversation. A participant whose
 * colour changed each time you opened a new chat would not be a participant.
 */
export const MAIN_AVATAR_IDENTITY = 'main';

/**
 * Deterministic, id-keyed, and stable for the Agent's whole life.
 *
 * Keyed by Agent id rather than display name so two siblings that a task
 * description named alike still differ, which is the case the colour exists to
 * disambiguate. Colliding hues remain possible across a large conversation; the
 * name sits beside the disc and is the identity of record.
 */
export function agentAvatarColor(identity: string): AgentAvatarColor {
  let hash = 0;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 0x5bd1e995);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return AVATAR_HUES[(hash >>> 0) % AVATAR_HUES.length]!;
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
