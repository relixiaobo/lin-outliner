/**
 * The one hash that turns an identity into a slot in the shared identity
 * palette.
 *
 * Tag chips and participant avatars both key a colour off a stable string, and
 * both were carrying their own copy of this — same constants, same shifts, and
 * already drifting apart in the surface tint each mixed. One family reads as
 * one family only while there is one derivation.
 */
export function identitySlot(identity: string, slots: number): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 0x5bd1e995);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % slots;
}

/** How far an identity hue is mixed toward the live content surface. */
export const IDENTITY_SURFACE_TINT = '12%';
