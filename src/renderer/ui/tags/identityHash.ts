/**
 * The identity palette's shared derivation, re-exported for the tag surfaces.
 * The hash itself lives in `core/identityHash` because the agent identity
 * catalog resolves colours on both sides of the process seam.
 */
export { identitySlot } from '../../../core/identityHash';

/** How far an identity hue is mixed toward the live content surface. */
export const IDENTITY_SURFACE_TINT = '12%';
