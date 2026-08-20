/**
 * Where a side flyout sits beside the row that opened it.
 *
 * A submenu opens level with its row and to whichever side has room. What makes
 * this its own module is the part that is easy to get wrong: the flyout has a
 * control inside it that makes it taller ("Show all models"), and a surface that
 * re-derives its own position from its own current height answers that growth by
 * MOVING — every row the reader was reading slides up under the cursor.
 *
 * So the two heights are kept apart. The height the flyout had when it OPENED
 * decides where it goes, and is frozen there; the height it is allowed to reach
 * is then derived from that position, so past it the content scrolls inside a
 * surface that stays put. Growing and collapsing move nothing, while the flyout
 * still tracks an anchor that moves under it — a ceiling fed back from the
 * surface's own clipped height would instead make the position a one-way valve,
 * ratcheting toward the top of the viewport and never coming back level with the
 * row that opened it.
 *
 * Not folded into `useAnchoredOverlay`, which owns every other overlay, yet: it
 * would need a side placement AND this ceiling rule, and the rule is only right
 * per placement (a menu opening upward must keep the edge that touches its
 * trigger, not its top). That is a change to every overlay in the app and wants
 * its own visual verification rather than a ride-along.
 */

import { clamp } from './clamp';

export interface FlyoutPlacementInput {
  readonly anchorLeft: number;
  readonly anchorRight: number;
  readonly anchorTop: number;
  /** Gap between the anchor's side and the flyout. */
  readonly gap: number;
  /** Keep-out band at every viewport edge. */
  readonly margin: number;
  /**
   * The height the flyout wanted when it OPENED — its natural content height,
   * measured once for this surface and reused unchanged while it stays open.
   * Feeding it the current height instead is what makes a growing flyout move.
   */
  readonly placementHeight: number;
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
  const {
    anchorLeft, anchorRight, anchorTop, gap, margin, placementHeight,
    viewportHeight, viewportWidth, width,
  } = input;
  // The reading side first: a submenu that would hang off the right edge opens
  // to the left of its row instead of being clamped on top of it.
  const fitsLeft = anchorLeft - gap - width >= margin;
  const left = fitsLeft
    ? anchorLeft - gap - width
    : clamp(anchorRight + gap, margin, Math.max(margin, viewportWidth - width - margin));
  const top = clamp(
    anchorTop - margin,
    margin,
    Math.max(margin, viewportHeight - placementHeight - margin),
  );
  return { left, maxHeight: Math.max(0, viewportHeight - top - margin), top };
}
