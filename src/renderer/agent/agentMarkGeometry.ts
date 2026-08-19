/**
 * The mark's eye rig, as pure geometry.
 *
 * An eye is ONE THICK ROUND-CAPPED STROKE. Upright and short, it reads as the
 * open capsule; arched over, a thick smile; a shallow sag, sleep; drooping
 * outward, crestfallen. One model for every expression means constant visual
 * weight, round ends everywhere, and states that MORPH into each other by
 * interpolating a handful of numbers — no eyelid rectangles slicing straight
 * edges into a face made entirely of curves.
 *
 * The face is a BALL, not a disc. The eye's anchor is a point on a sphere; a
 * pose (yaw, pitch) rotates the sphere and the anchor projects back to the
 * screen, with the stroke's outward axis compressed by the surface normal —
 * full facing forward, vanishing at the limb — and the whole stroke clamped
 * inside the silhouette, because a hole that crosses the outline reads as a
 * bite out of the face, not an eye.
 *
 * Kept pure and DOM-free so the invariants (silhouette containment, mood
 * completeness) are testable without a browser.
 */

/** Per-eye stroke in local coordinates: u grows OUTWARD (mirrored by side), v down. */
export interface MarkEyeParams {
  readonly u1: number; readonly v1: number;
  readonly uc: number; readonly vc: number;
  readonly u2: number; readonly v2: number;
  /** Stroke width — the eye's visual weight, constant across moods by design. */
  readonly w: number;
  /** Vertical shift of the eye's anchor on the sphere (looking down > 0). */
  readonly look: number;
  /** Uniform scale, for the wide-open ask. */
  readonly grow: number;
  /**
   * How open the eye is, 1 → 0. A blink is a PARAMETER of the rig, not a CSS
   * transform on the group: it collapses the stroke toward its own anchor, so
   * it composes with whatever mood is showing (an agent can blink mid-scan)
   * and needs neither a scale transform nor a timing literal in the
   * stylesheet — both of which the design guards refuse, rightly, since a
   * scale on a mask group is exactly the "hover pop" B7 exists to prevent.
   */
  readonly openness: number;
}

export const MARK_EYE_BASE: MarkEyeParams = Object.freeze({
  u1: 0, v1: -1.6, uc: 0, vc: 0, u2: 0, v2: 1.6, w: 4.6, look: 0, grow: 1, openness: 1,
});

/**
 * A mood is DATA over one rig, not a drawing. The emotional reading of each
 * pose is deliberate: a failed agent droops (sorry), it does not glare
 * (angry) — an agent that failed the user has nothing to be cross about.
 */
export const MARK_MOODS = Object.freeze({
  idle:     Object.freeze({}),
  working:  Object.freeze({ v1: -1.3, v2: 1.4, w: 4.4, look: 2.1 }),
  needsYou: Object.freeze({ v1: -2.0, v2: 2.0, w: 5.4, grow: 1.04 }),
  done:     Object.freeze({ u1: -2.7, v1: .9, uc: 0, vc: -2.6, u2: 2.7, v2: .9, w: 4.0 }),
  stopped:  Object.freeze({ u1: -2.5, v1: .4, uc: 0, vc: 1.7, u2: 2.5, v2: .4, w: 3.4, look: 1.2 }),
  failed:   Object.freeze({ u1: -2.0, v1: -.7, uc: .3, vc: .2, u2: 2.4, v2: 1.6, w: 3.4, look: 1.0 }),
} satisfies Record<string, Partial<MarkEyeParams>>);

export type MarkMood = keyof typeof MARK_MOODS;

/**
 * Moods whose eyes are open. Closed eyes do not blink — a sleeping face that
 * blinks is the one thing more unsettling than one that never does.
 */
export const AWAKE_MARK_MOODS: readonly MarkMood[] = Object.freeze(['idle', 'working', 'needsYou']);

export function markMoodParams(mood: MarkMood): MarkEyeParams {
  return { ...MARK_EYE_BASE, ...MARK_MOODS[mood] };
}

/** The face sphere: radius, centre, eye anchors, and the clamp circle. */
const R = 12.8, CX = 16, CY = 16, EYE_DX = 5.2, EYE_DY = -1, RIN = 11.9;

/** The silhouette radius, exported for the containment invariant test. */
export const MARK_SILHOUETTE_RADIUS = R;

export interface ProjectedEye {
  /** Anchor on screen. */
  readonly px: number; readonly py: number;
  /** Outward-axis compression from the surface normal (limb → near 0). */
  readonly fx: number;
}

export function projectMarkEye(
  m: MarkEyeParams,
  yaw: number,
  pitch: number,
  sign: -1 | 1,
): ProjectedEye {
  const bx = sign * EYE_DX / R, by = (EYE_DY + m.look) / R;
  const bz = Math.sqrt(Math.max(.02, 1 - bx * bx - by * by));
  const cy1 = Math.cos(yaw), sy1 = Math.sin(yaw);
  const x1 = bx * cy1 + bz * sy1, z1 = -bx * sy1 + bz * cy1;
  // Positive pitch tips the head DOWN, so the eyes move down the screen —
  // the rotation runs Y toward +Z because screen y grows downward.
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = by * cp + z1 * sp, z2 = -by * sp + z1 * cp;
  let px = CX + x1 * R, py = CY + y2 * R;
  const fx = Math.max(.12, Math.min(1.08, z2 / bz));
  // Clamp the stroke's whole box inside the silhouette circle. The available
  // span on one axis is measured at the box's FARTHEST extent on the other —
  // using the centre line instead let a corner poke past the arc at poses the
  // behaviour layer never requests but the maths must still survive. When a
  // box is too large for the room at all, it centres rather than crossing.
  const uMax = Math.max(Math.abs(m.u1), Math.abs(m.u2), Math.abs(m.uc)) * m.grow;
  // Measured at FULL openness on purpose: a blink only ever shrinks the box,
  // so the clamp computed here stays valid mid-blink and the anchor does not
  // drift while an eye closes.
  const vMax = Math.max(Math.abs(m.v1), Math.abs(m.v2), Math.abs(m.vc)) * m.grow;
  const halfW = uMax * fx + m.w / 2, halfH = vMax + m.w / 2;
  const clampAxis = (value: number, centre: number, half: number, otherOffset: number): number => {
    const avail = Math.sqrt(Math.max(0, RIN * RIN - otherOffset * otherOffset));
    const lo = centre - avail + half + .5, hi = centre + avail - half - .5;
    return lo > hi ? centre : Math.max(lo, Math.min(hi, value));
  };
  // Two passes: the first pins each axis against the other's raw offset, the
  // second re-pins against the clamped result so both settle consistently.
  for (let pass = 0; pass < 2; pass++) {
    py = clampAxis(py, CY, halfH, Math.abs(px - CX) + halfW);
    px = clampAxis(px, CX, halfW, Math.abs(py - CY) + halfH);
  }
  return { px, py, fx };
}

export interface RenderedEye {
  /** SVG path data for the eye stroke. */
  readonly d: string;
  /** Apparent stroke width after foreshortening. */
  readonly width: number;
  /** Blink pivot (the eye's projected anchor). */
  readonly originX: number;
  readonly originY: number;
}

export function renderMarkEye(
  m: MarkEyeParams,
  yaw: number,
  pitch: number,
  sign: -1 | 1,
): RenderedEye {
  const { px, py, fx } = projectMarkEye(m, yaw, pitch, sign);
  const g = m.grow;
  // Openness squashes the stroke onto its anchor; the outward axis is
  // untouched, so a closing eye narrows to a line rather than shrinking to a
  // dot — which is what a lid does.
  const o = Math.max(0.02, m.openness);
  const x = (u: number) => px + sign * u * g * fx;
  const y = (v: number) => py + v * g * o;
  return {
    d: `M${x(m.u1).toFixed(2)} ${y(m.v1).toFixed(2)} Q${x(m.uc).toFixed(2)} ${y(m.vc).toFixed(2)} ${x(m.u2).toFixed(2)} ${y(m.v2).toFixed(2)}`,
    width: m.w * g * (0.55 + 0.45 * fx),
    originX: px,
    originY: py,
  };
}

/** Interpolate two parameter sets; the morphing between moods is just this. */
export function mixMarkParams(from: MarkEyeParams, to: MarkEyeParams, k: number): MarkEyeParams {
  // Endpoints land exactly: an animation that never quite reaches its target
  // never settles, and floating error at k=1 is a target missed forever.
  const lerp = k >= 1 ? (_: number, b: number) => b
    : k <= 0 ? (a: number) => a
      : (a: number, b: number) => a + (b - a) * k;
  return {
    u1: lerp(from.u1, to.u1), v1: lerp(from.v1, to.v1),
    uc: lerp(from.uc, to.uc), vc: lerp(from.vc, to.vc),
    u2: lerp(from.u2, to.u2), v2: lerp(from.v2, to.v2),
    w: lerp(from.w, to.w), look: lerp(from.look, to.look), grow: lerp(from.grow, to.grow),
    openness: lerp(from.openness, to.openness),
  };
}
