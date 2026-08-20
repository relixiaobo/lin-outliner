/**
 * One clamp for overlay geometry, because the two that grew up beside each other
 * disagreed about the case that matters: an inverted range, where the keep-out
 * margins leave less room than the surface needs. `Math.min(max, …)` last answers
 * `max` there and puts the surface off the top of the viewport; answering `min`
 * keeps it on screen, clipped, which is the only useful thing to do with a window
 * too short for what it is being asked to hold.
 *
 * A non-finite value reads as 0 rather than propagating NaN into a style.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Number.isFinite(value) ? value : 0, max));
}
