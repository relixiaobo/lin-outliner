/**
 * Which point of a long message holds still while its clamp opens or closes.
 *
 * The measured Show more control hangs BELOW the text it opens, so the block's
 * top edge and the control are not interchangeable fixed points, and which one
 * is right depends on the direction and on where the reader is.
 *
 * - **Opening**, the revealed lines appear above the control. Holding the
 *   control makes them grow UPWARD, off the top of the viewport, and borrows
 *   tail runway when the transcript has no range to spend. The block's own top
 *   edge is the fixed point, and the text opens downward.
 * - **Opening while the transcript rides a tail it can actually scroll**, the
 *   control IS the bottom, and holding it is what staying at the bottom means.
 *   A transcript with no scroll range has no tail to ride, so it takes the
 *   ordinary case above: nothing is at the bottom of a view that is all of it.
 * - **Closing**, nothing grows. The control is the only point guaranteed to be
 *   on screen — it is what the reader just clicked, and reaching it in a message
 *   taller than the viewport means scrolling far past the block's top edge.
 *   Holding that off-screen edge instead pins a point ~2000px above the reader
 *   and drops the collapsed message out of view entirely.
 */
export type MessageDisclosureAnchor = 'block' | 'control';

export function messageDisclosureAnchor(
  { closing, ridingScrollableBottom }: {
    readonly closing: boolean;
    readonly ridingScrollableBottom: boolean;
  },
): MessageDisclosureAnchor {
  return closing || ridingScrollableBottom ? 'control' : 'block';
}
