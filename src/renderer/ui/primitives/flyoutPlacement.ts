/**
 * Where a side flyout sits beside the row that opened it.
 *
 * A submenu opens level with its row and to whichever side has room. What makes
 * this its own module is the part that is easy to get wrong: the flyout has a
 * control inside it that makes it taller ("Show all models"), and a surface that
 * re-derives its own top from its own height answers that growth by MOVING —
 * every row the reader was reading slides up under the cursor. So the height the
 * surface is allowed to reach is derived FROM the resolved top, never the other
 * way round: past that height the content scrolls inside a surface that stays
 * where it was put.
 *
 * That makes the placement a fixed point. Feed the rendered (already clipped)
 * height back in and the same top comes out, because a clipped surface measures
 * exactly the space below its own top — so repeated passes on scroll, on resize,
 * and after the content grows all agree. Opening height still decides the first
 * placement, which is why a long list opened low on screen still lifts to fit.
 */

export interface FlyoutPlacementInput {
  readonly anchorLeft: number;
  readonly anchorRight: number;
  readonly anchorTop: number;
  /** Gap between the anchor's side and the flyout. */
  readonly gap: number;
  /** Keep-out band at every viewport edge. */
  readonly margin: number;
  /**
   * The flyout's CURRENT rendered height — clipped by whatever `maxHeight` a
   * previous pass gave it, not the height its content wishes it had. The
   * clipped height is what makes the result stable under growth.
   */
  readonly measuredHeight: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly width: number;
}

export interface FlyoutPlacement {
  readonly left: number;
  readonly maxHeight: number;
  readonly top: number;
}

export function resolveFlyoutPlacement(input: FlyoutPlacementInput): FlyoutPlacement {
  const { anchorLeft, anchorRight, anchorTop, gap, margin, viewportHeight, viewportWidth, width } = input;
  // The reading side first: a submenu that would hang off the right edge opens
  // to the left of its row instead of being clamped on top of it.
  const fitsLeft = anchorLeft - gap - width >= margin;
  const left = fitsLeft
    ? Math.max(margin, anchorLeft - gap - width)
    : clamp(anchorRight + gap, margin, Math.max(margin, viewportWidth - width - margin));
  const top = clamp(
    anchorTop - margin,
    margin,
    Math.max(margin, viewportHeight - input.measuredHeight - margin),
  );
  return { left, maxHeight: Math.max(0, viewportHeight - top - margin), top };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Number.isFinite(value) ? value : 0, max));
}
