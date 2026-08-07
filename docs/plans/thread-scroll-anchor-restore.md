# Thread scroll restore keyed to the Turn being read

## Goal

Returning to a conversation puts the reader back on the same *content*, not the
same pixel offset — including the common case of a flow-layout (non-virtualized)
transcript, where the pixel offset is not stable across a remount.

## Non-goals

- Persisting the reading position across app restarts. The snapshot stays
  ephemeral and session-scoped, as today.
- Changing the virtual transcript, the bottom-follow rule, the send anchor, or
  the disclosure anchor. This plan only changes what a *restore* aims at.
- Removing `content-visibility: auto` from `.thread-turn`. Its intrinsic
  placeholder is the trigger, but it is a deliberate rendering optimization and
  other sources of height drift (fonts, images, fresh markdown layout) would
  leave the same defect behind.

## The defect

`ThreadView` caches `{ follow, top }` per Thread and, on remount, writes the
saved `top` back. That assumes a given `scrollTop` maps to the same content
before and after the remount. In a flow-layout transcript it does not.

`.thread-turn` carries `content-visibility: auto; contain-intrinsic-size: auto
180px`. On a fresh mount the browser has no remembered size for rows it has
never rendered, so every Turn above the restored viewport contributes 180px
instead of its real height. The saved offset then lands further along the
conversation, by the accumulated error of everything above it.

Measured with 12 Turns of ordinary prose, switching away and back:

| | before | after |
|---|---|---|
| `scrollTop` | 1594 | 1594 |
| transcript `scrollHeight` | 4516 | 4150 |
| the two rows above the viewport | 363 / 363 | **180 / 180** |
| anchored row, relative to viewport top | −78 | **−444** |

The existing guard test covers Threads above forty Turns, where the virtual
transcript positions rows from the cached measured-height map and the geometry
is self-consistent — which is why it passes while flow layout, the shape of
almost every real conversation, drifts.

## Design

**The snapshot records what is being read, not where the scrollbar sat.**
`ThreadScrollSnapshot` gains an anchor: the first Turn row whose bottom is still
below the viewport top, plus that row's offset from the viewport top. `top`
stays as the fallback for when the anchored Turn is not reachable.

The anchor is read by binary search over the rendered `[data-thread-turn-row]`
elements — rows are in document order, so their edges are monotonic and the
search costs about six rect reads rather than one per row. It is skipped while
follow is active: a followed Thread resumes at the bottom and needs no anchor.

**A measured Turn carries its own placeholder height.** The per-Thread measured
height cache already survives the remount, and measurements already exclude
`content-visibility`-skipped subtrees, so every value in it is a real rendered
height. Feeding it back as that Turn's `contain-intrinsic-size` makes the
remounted transcript rebuild at the height the reader left, so the anchor has
stable geometry to correct against instead of a layout that keeps growing under
it. Turns never rendered in this session keep the nominal fallback; the anchor is
what covers them.

**The restore converges instead of firing once.** A pending restore keeps the
anchor, the fallback offset, and an attempt count.

1. If the anchored row is in the DOM, correct `scrollTop` by the difference
   between its current offset and the recorded one. Once that difference is
   under a pixel, the restore is settled and released.
2. If it is not (a virtualized Thread whose rendered window does not yet reach
   it), place by the fallback offset — which brings the row into range — and
   keep the request alive for the next layout pass.
3. Agreement alone does not release it — the transcript must also have stopped
   growing. A restore that settles on the first agreement and is then pushed by
   rows rendering above it has still lost the reader's place.
4. An attempt cap releases the request so a Thread whose geometry cannot satisfy
   the anchor (content removed, viewport resized) settles at the nearest
   reachable offset instead of rewriting `scrollTop` on every layout pass.

Because the request now outlives its first application, it has to yield where
every other writer of the scroll position yields. User scroll takes ownership and
cancels it; the jump-to-latest control clears it; an activated disclosure anchor
makes it wait without spending an attempt; and a send cancels it, since asking
for the end of the conversation outranks a position that was left. While one is
pending, follow is not re-derived and the snapshot is not re-cached from the
geometry it is passing through: a clamped intermediate offset reads as
bottom-follow and would hand the transcript to the bottom pin, and an anchor read
mid-flight overwrites the snapshot the restore is aiming at. The settling attempt
releases the request before its own write, so the final position still reaches
both.

The anchor search keys on row *tops*. A virtualized row is placed at its layout
slot, so tops stay ordered even on the frame a Turn renders taller than the
estimate it was given and its bottom overlaps the next row's.

The failed-send path records the anchor alongside the offset it already
captures, so restoring the pre-send viewport goes through the same correction.

The last position is captured from a **layout** cleanup. React detaches host refs
and the DOM node before passive cleanups run for a deleted subtree, so a passive
one sees a null ref and records nothing — which is what the existing unmount
capture had always been doing. Everything the reader did with the scrollbar is
already cached by then; what this adds is a position moved by content growth that
never produced a scroll event of its own.

## Verification

An e2e guard for the flow-layout path: a Thread tall enough to scroll but under
the virtualization threshold, scrolled to a middle anchor, switched away and
back, asserting the anchored row returns to its offset. Plus the same assertion
on the path this was reported from — parent conversation → Subagent → back.
