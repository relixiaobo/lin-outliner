// How many identity tints exist (mirrors --identity-tint-0..N-1 in tokens.css).
// Keep in sync with that token block: the avatar maps the hashed index onto an
// `is-tint-{index}` class, and each class binds one --identity-tint-* token.
export const AVATAR_TINT_COUNT = 8;

// Deterministically map an agent's stable identity key (its mention token, or the
// display label as a fallback) onto a tint index. Same agent → same hue across
// every render and session; an unset/empty key returns -1 so the caller can keep
// the neutral fallback rather than always pinning bucket 0. The hash is the
// MurmurHash3 finalizer mix reused from tagColors.ts (good avalanche so adjacent
// keys like "agent1"/"agent2" don't collide into the same bucket).
export function agentAvatarTintIndex(key: string | null | undefined): number {
  const source = (key ?? '').trim();
  if (!source) return -1;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x5bd1e995);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % AVATAR_TINT_COUNT;
}
