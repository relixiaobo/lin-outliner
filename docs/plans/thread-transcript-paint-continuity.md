# Thread Transcript Paint Continuity

## Goal And Purpose

Keep the Agent transcript continuously painted while a reader scrolls, drags the
scrollbar, jumps a long distance, restores a Thread, or follows a programmatic
anchor. No committed frame may show an empty transcript viewport when canonical
Turns exist at that position.

This is shape **(a): one complete feature in one PR**. It removes the competing
paint schedulers and makes viewport coverage a renderer invariant; it is not an
overscan or timeout adjustment.

## Non-goals

- No change to canonical Thread data, pagination, notifications, persistence, or
  core/preload protocol surfaces.
- No change to follow, Jump to latest, send-to-top, disclosure-anchor, virtual
  height-compensation, or Thread-restore product semantics.
- No visual cover-up, fade, skeleton, or animation that conceals an empty
  frame.
- No virtualization rewrite for other document surfaces.
- No new virtualization dependency in the selected target.

## Design

### Evidence And Root Cause

- **OBJ-1:** A reader navigating an existing conversation always sees the Turns
  at the real viewport position; rendering optimization may reduce work but may
  never make the transcript disappear between two paints.
- **EVD-1:** In a 39-Turn flow-layout transcript, a far `scrollTop` jump leaves
  three Turn rows intersecting the viewport in the DOM, but Chromium skips all
  three through `content-visibility: auto` until the third animation frame.
- **EVD-2:** In an 80-Turn virtual transcript, a far jump moves the real
  viewport beyond the mounted range while `scheduleScrollMetrics` defers the
  new range to `requestAnimationFrame`; no Turn intersects the viewport through
  the first animation frame, and the window recovers on the second.
- **EVD-3:** The Thread store retains the loaded Turns, `visibleTurnRange`
  retains at least one row, and the long-message disclosure path merged in
  #568 stays covered for 30 sampled frames. The defect is paint continuity, not
  history loss, an empty slice, or disclosure anchoring.
- **EVD-4:** In a temporary 120-paragraph Goal plus 80-Turn probe, jumping to
  the start of the Turn list produced zero viewport-intersecting rows in four
  consecutive samples. The final two samples mounted 20 rows, but all 20 were
  translated below the real viewport because scroller-relative `scrollTop` was
  interpreted as a Turn-local offset. The renderer window also has a coordinate
  origin defect whenever leading Goal geometry exceeds its overscan cushion.

### Decision, constraints, and options

- **DEC-1:** Give each transcript one paint owner. At or below the virtualization
  threshold, ordinary DOM layout owns every Turn. Above the threshold, the
  renderer virtual window owns mounting and painting. A mounted Turn never also
  delegates its paint timing to `content-visibility`.
- **Minimum acceptable outcome:** At the final virtualization threshold `N`,
  the `N`-Turn flow path and `N + 1`-Turn virtual path each have a painted,
  viewport-intersecting Turn on the first frame after a far jump, without
  making every incremental scroll update synchronous.
- **Clean-slate best answer (OPT-1):** Use one mature variable-height virtualizer
  as the sole long-transcript layout, measurement, range, and scroll-to-item
  authority, with no browser-level paint virtualization on its rows.
- **Selected target (OPT-2):** Preserve the current measured-row virtualizer and
  its already-tested anchor integrations, remove browser paint virtualization,
  and add a coverage-triggered urgent range commit. This reaches the same
  single-owner architecture without replacing the working measurement and
  scroll-ownership contracts or adding an infrastructure-owned dependency.
- **Minimum patch (OPT-3, rejected):** Increasing overscan, delaying assertions,
  or flushing every scroll event either leaves far jumps unbounded or taxes the
  normal scroll path. None establishes the coverage invariant.

Constraints:

- **CON-1 hard:** Scroll writers retain their existing priority: reader intent
  outranks restore and virtual compensation; explicit disclosure and send
  anchors outrank bottom follow.
- **CON-2 hard:** Per A9, measure the paint-cost trade before accepting removal
  of `content-visibility` or synchronous renderer work on the scroll path.
- **CON-3 legacy:** `ThreadView` already owns measured heights, restore anchors,
  send anchors, disclosure anchors, and bottom following. Replacing that owner
  solely to fix scheduling would enlarge the regression surface without
  evidence that its layout model is wrong.
- **CON-4 resolvable:** `N` is the largest Turn count that uses flow layout. It
  begins at the current `TRANSCRIPT_VIRTUAL_MIN_TURNS` value, but if painting
  that cohort is too expensive, lower `N` from measured evidence and rerun the
  exact-`N` / `N + 1` gates; do not reintroduce a second paint scheduler.

Revisit OPT-1 only when the existing virtualizer needs another structural
capability that it cannot express, or when measured maintenance/performance cost
exceeds the integration cost of a dependency and its `package.json` / `bun.lock`
ownership change.

### One paint owner

Delete the `.thread-turn` `content-visibility` / `contain-intrinsic-size` rule,
the per-row intrinsic-size style, and the measurement branch that ignores a
content-visibility-skipped subtree. Flow-layout Turns then use normal browser
layout and paint. Virtual transcripts still mount only the renderer-selected
range; every mounted Turn is paint-eligible immediately.

Keep the measured-height cache. It remains the virtual layout's source for
variable-height rows and lets a flow transcript at the final threshold `N`
cross into virtualization at `N + 1` with real measurements rather than only
estimates. The Thread restore continues to target a Turn plus viewport offset;
only its obsolete intrinsic fallback rationale is removed from the rendering
specification.

Move the existing layout/range math and a new pure coverage predicate into a
small renderer-local transcript-window module. The predicate answers whether
the currently committed range contains every Turn intersecting the actual
Turn-local viewport. The module also owns the final threshold `N`, so production
selection, unit tests, E2E cohorts, and performance traces cannot drift onto
different flow/virtual paths. Overscan remains a performance cushion, never a
correctness premise.

### Turn-local viewport coordinates

The virtual layout's origin is the top of `.thread-transcript-turns`, not the
top of `.thread-transcript`. Define the Turn origin as that container's top in
the scroller's content coordinate space. The Turn-local viewport interval is:

- `top = scroller.scrollTop - turnOrigin`;
- `bottom = top + scroller.clientHeight`;
- coverage-relevant interval = the intersection of `[top, bottom]` with
  `[0, virtualLayout.totalHeight]`.

An interval that lies wholly inside the Goal or wholly after the Turns requires
no Turn row. Otherwise, both range selection and the coverage predicate consume
this same local interval; raw scroller-relative `scrollTop` never enters either
calculation. Derive `turnOrigin` from live scroller and Turn-container geometry,
so Goal height, content padding, and the Goal-to-Turn gap are included without a
duplicated estimate.

Refresh the origin on every native or programmatic scroll coverage check, on
scroller resize, and whenever leading geometry changes. Goal mount/unmount,
Goal content resize, and transcript-content layout changes feed the existing
layout-observation pass, which recomputes the local viewport and requests an
urgent commit if the newly exposed Turn interval is not covered. A cached origin
may be reused only while those geometry inputs are unchanged.

### Coverage-triggered scheduling

Separate visibility-critical window selection from deferred scroll bookkeeping
behind one shared coverage boundary:

1. On every native scroll, read the actual scroller geometry and normalize the
   viewport into Turn-local coordinates before evaluating the committed range.
2. If the committed virtual range still covers that viewport, retain the
   existing one-per-frame metric update. This is the normal wheel/trackpad path.
3. If the viewport has left the committed range, synchronously commit only the
   latest viewport/range state before the next paint, then let the normal frame
   pass refresh anchors, follow state, and the Jump to latest metric. This is a
   bounded recovery path for scrollbar drags and far jumps, not a global
   `flushSync` policy.
4. Make `setProgrammaticScrollTop` the sole product-code mutation boundary for
   `scrollTop`, including the remaining disclosure-anchor delta write. It writes
   the DOM position, reads the browser-clamped result and live Turn origin, and
   synchronously commits an uncovered virtual range before returning to its
   layout-effect, event, or rAF caller. Restore, send/disclosure anchors, bottom
   follow, anchor travel, and virtual-height compensation therefore share the
   same first-frame guarantee rather than relying on a later native `scroll`
   event.

Coalesce multiple pending readings to the latest DOM position. A stale scheduled
frame must never move the virtual window back to an earlier offset.

### Reader Flow And Failure Recovery

- **FLOW-1:** A reader scrolls or jumps within an existing transcript.
  - **Entry state:** Canonical Turns are loaded and the transcript has a
    committed flow layout or virtual range.
  - **Mainline:** The browser moves the viewport, the renderer converts it to
    Turn-local coordinates, checks committed coverage, and the normal frame pass
    advances overscan and scroll metrics.
  - **Decision point:** If the committed virtual range does not cover the new
    viewport, the renderer commits the latest range before paint.
  - **Result:** At least one real Turn intersects every viewport that contains
    canonical Turn content.
  - **Failure/recovery:** A stale scheduled reading is discarded in favor of
    the latest DOM position; an expensive flow ceiling is recovered by lowering
    the renderer-virtualization threshold.
  - **Requirements:** FR-1, FR-2, NFR-1, BR-1, BR-2.

### Performance decision gate

Before fixing the threshold, record baseline and branch traces for exactly `N`
mixed-height completed Turns (flow), exactly `N + 1` Turns (the first virtual
cohort), and `L = max(80, N + 1)` Turns as an additional long-list sample.
Assert `data-virtualized="false"` for `N` and
`data-virtualized="true"` for `N + 1` before accepting any measurement. For
each applicable cohort, trace:

- cold Thread selection and first settled paint;
- incremental wheel/trackpad scrolling within overscan;
- a top-to-bottom scrollbar jump;
- one streaming tail update while the reader is scrolled back.

Report scripting, layout, paint, longest task, renderer commit count, and the
number of urgent coverage commits in the PR. Incremental scrolling must produce
zero urgent commits while the viewport remains covered. If removing paint
containment creates a material long task at `N`, lower `N`, update the shared
policy value, and repeat all exact-`N`, `N + 1`, and `L` traces and coverage
tests; do not trade continuity back for throughput.

### Contract and specification update

Rewrite the scroll/restore section of `agent-thread-rendering.md` around the new
invariant: flow Turns use real layout; virtual Turns use measured estimates and
Turn-local viewport overscan; a coverage breach is repaired before paint.
Document `.thread-transcript-turns` as the virtual coordinate origin and the
shared programmatic-scroll boundary as the pre-paint authority. Preserve the
existing Turn-and-offset restore contract, virtual height compensation, send
anchor, disclosure anchor, bottom follow, and accessibility announcer behavior.

## Requirements And Acceptance Criteria

- **FR-1:** The Thread transcript shall use one paint owner for every Turn and
  shall repair a renderer-window coverage breach before the next paint.
- **FR-2:** Native and programmatic scroll paths shall evaluate renderer-window
  coverage in Turn-local coordinates through the same urgent-commit boundary.
- **NFR-1:** The urgent range-commit path shall run only when the committed
  virtual range no longer covers the real viewport; covered scrolling remains
  coalesced to one metric update per animation frame.
- **BR-1:** Reader intent, explicit disclosure, send anchoring, bottom follow,
  restore, and virtual compensation retain their existing ownership priority.
- **BR-2:** Goal and other leading geometry contribute only to `turnOrigin`;
  they never masquerade as progress through the virtual Turn layout.

- **AC-1:** When a transcript contains exactly the final threshold `N` Turns,
  it shall report `data-virtualized="false"`; after a top-to-distant jump, the
  synchronous sample and first two animation-frame samples shall each contain
  at least one paint-eligible Turn intersecting every viewport interval that
  overlaps Turn content.
- **AC-2:** When a transcript contains exactly `N + 1` Turns, it shall report
  `data-virtualized="true"`; after a jump outside the mounted window, the
  synchronous sample and first two animation-frame samples shall each contain a
  mounted, paint-eligible Turn intersecting every viewport interval that
  overlaps Turn content.
- **AC-3:** While rapid wheel, trackpad, and scrollbar movements alternate among
  distant positions, every painted sample shall remain covered and the final
  viewport shall correspond to the latest scroll position, not a stale frame.
- **AC-4:** While incremental scrolling remains inside overscan, scroll metrics
  shall still coalesce to at most one update per animation frame and shall not
  enter the urgent commit path.
- **AC-5:** When switching away from and back to both a flow and virtual Thread,
  the same Turn shall return to its recorded viewport offset within the existing
  tolerance.
- **AC-6:** Send anchoring, bottom follow, Jump to latest, virtual height
  compensation, and the #568 long-message disclosure anchor shall retain their
  existing focused E2E behavior.
- **AC-7:** The committed CSS shall contain no `content-visibility` or
  `contain-intrinsic-size` rule for `.thread-turn`.
- **AC-8:** When `L` virtual Turns follow a Goal whose measured leading extent
  exceeds both the overscan and one viewport, far jumps to the start and middle
  of the Turn list shall use the Turn-local interval and meet the synchronous
  plus first-two-frame coverage judge from AC-2.
- **AC-9:** When rAF virtual-height compensation or Thread restore writes a
  position outside the committed range, the shared programmatic boundary shall
  commit covering rows before the writer returns; its end-of-writer sample and
  first two animation-frame samples shall never have zero Turn coverage, and
  the final Turn-and-offset anchor shall remain within the existing tolerance.

## Files

- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/transcriptVirtualWindow.ts` (new, renderer-local pure
  layout/range/coverage boundary)
- `src/renderer/styles/thread.css`
- `tests/renderer/transcriptVirtualWindow.test.ts` (new)
- `tests/e2e/agent-thread.spec.ts`
- `docs/spec/agent-thread-rendering.md`

No infrastructure-ownership or protocol file is in scope.

## Risks And Failure Recovery

- Removing `content-visibility` can increase layout/paint work near the
  non-virtual threshold. The measured response is to lower that threshold, not
  restore dual virtualization.
- An unconditional synchronous update would turn scroll frequency into renderer
  commit frequency. The committed-range predicate and urgent-commit counter
  guard against that regression.
- A stale rAF update could overwrite the far-jump position after the urgent
  commit. Coalescing by latest DOM position and the alternating-jump E2E judge
  make this observable.
- A scroller-space coordinate can appear covered while every mounted row is
  displaced by a leading Goal. One Turn-local interval feeds both selection and
  the predicate, and the long-Goal E2E case guards their shared origin.
- Existing scroll writers can race over `scrollTop`. The feature changes only
  when the virtual range becomes visible; centralizing their mutation boundary
  does not change writer priority.

## Collision Result

PR #567 merged on 2026-08-20, and this plan branch starts at its integration
commit. PR #570 then merged as `29341c47` and does overlap
`src/renderer/agent/components/ThreadView.tsx`: it passes `threadId` into
`ThreadSpeakerGroup` inside `ThreadTurnView`. That speaker/configuration region
is semantically independent from the virtual range, scroll scheduling, and
transcript-container geometry owned here, and #570 did not change this plan's
CSS, E2E, or rendering-spec files. The branch must synchronize with the latest
post-#570 `main` before any product implementation begins.

Open PR #569 changes only its own plan. The active
`interaction-jank-cleanups` plan owns chrome, outliner, panel, translation, and
search scroll costs rather than the Agent transcript. The collision check
therefore finds one disclosed, already-merged file overlap with #570 and no
open implementation collision; the significant review queue still has room for
this feature after PM ratification.

## Open Questions

None inside the selected target. PM ratification is the directional decision:
retain the current measured-row virtualizer under the single-owner invariant
(OPT-2), or pay the larger dependency and integration cost of OPT-1 now.

## Verification

- Run the new renderer unit tests for threshold ownership, Turn-local range and
  coverage math, leading intervals with no Turn content, the shared urgent
  programmatic boundary, and stale-frame coalescing.
- Run the exact-`N`, `N + 1`, long-Goal, rapid-jump, restore, send-anchor,
  disclosure-anchor, and virtual-compensation cases in
  `tests/e2e/agent-thread.spec.ts`; first-frame judges sample coverage, not only
  final scroll positions.
- Run the light/dark rapid-scroll visual check and retain trace numbers in the
  PR body.
- Run `bun run typecheck`, `bun run test:renderer`, the focused E2E suite,
  `bun run docs:check`, and `git diff --check`.
