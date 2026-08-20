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

### Decision, constraints, and options

- **DEC-1:** Give each transcript one paint owner. At or below the virtualization
  threshold, ordinary DOM layout owns every Turn. Above the threshold, the
  renderer virtual window owns mounting and painting. A mounted Turn never also
  delegates its paint timing to `content-visibility`.
- **Minimum acceptable outcome:** Both the 39-Turn flow path and the 80-Turn
  virtual path have a painted, viewport-intersecting Turn on the first frame
  after a far jump, without making every incremental scroll update synchronous.
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
- **CON-4 resolvable:** If painting every Turn at the current flow-layout ceiling
  is too expensive, lower `TRANSCRIPT_VIRTUAL_MIN_TURNS` from measured evidence;
  do not reintroduce a second paint scheduler.

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
variable-height rows and lets a 40-Turn flow transcript cross the threshold with
real measurements rather than estimates. The Thread restore continues to target
a Turn plus viewport offset; only its obsolete intrinsic fallback rationale
is removed from the rendering specification.

Move the existing layout/range math and a new pure coverage predicate into a
small renderer-local transcript-window module. The predicate answers whether
the currently committed range contains every Turn intersecting the actual
viewport. Overscan remains a performance cushion, never a correctness premise.

### Coverage-triggered scheduling

Separate visibility-critical window selection from deferred scroll bookkeeping:

1. On every native scroll, read the actual `scrollTop` and `clientHeight`.
2. If the committed virtual range still covers that viewport, retain the
   existing one-per-frame metric update. This is the normal wheel/trackpad path.
3. If the viewport has left the committed range, synchronously commit only the
   latest viewport/range state before the next paint, then let the normal frame
   pass refresh anchors, follow state, and the Jump to latest metric. This is a
   bounded recovery path for scrollbar drags and far jumps, not a global
   `flushSync` policy.
4. Route programmatic scroll writers through the same coverage check. Layout
   effects already commit before paint; event/rAF writers request an urgent
   commit only when their write would otherwise expose an uncovered viewport.

Coalesce multiple pending readings to the latest DOM position. A stale scheduled
frame must never move the virtual window back to an earlier offset.

### Reader Flow And Failure Recovery

- **FLOW-1:** A reader scrolls or jumps within an existing transcript.
  - **Entry state:** Canonical Turns are loaded and the transcript has a
    committed flow layout or virtual range.
  - **Mainline:** The browser moves the viewport, the renderer checks committed
    coverage, and the normal frame pass advances overscan and scroll metrics.
  - **Decision point:** If the committed virtual range does not cover the new
    viewport, the renderer commits the latest range before paint.
  - **Result:** At least one real Turn intersects every viewport that contains
    canonical Turn content.
  - **Failure/recovery:** A stale scheduled reading is discarded in favor of
    the latest DOM position; an expensive flow ceiling is recovered by lowering
    the renderer-virtualization threshold.
  - **Requirements:** FR-1, NFR-1, BR-1.

### Performance decision gate

Before fixing the threshold, record baseline and branch traces for the maximum
flow path (40 mixed-height completed Turns) and a long virtual path (80 Turns):

- cold Thread selection and first settled paint;
- incremental wheel/trackpad scrolling within overscan;
- a top-to-bottom scrollbar jump;
- one streaming tail update while the reader is scrolled back.

Report scripting, layout, paint, longest task, renderer commit count, and the number
of urgent coverage commits in the PR. Incremental scrolling must produce zero
urgent commits while the viewport remains covered. If removing paint containment
creates a material long task at the 40-Turn ceiling, lower the threshold and
repeat the trace; do not trade continuity back for throughput.

### Contract and specification update

Rewrite the scroll/restore section of `agent-thread-rendering.md` around the new
invariant: flow Turns use real layout; virtual Turns use measured estimates and
viewport overscan; a coverage breach is repaired before paint. Preserve the
existing Turn-and-offset restore contract, virtual height compensation, send
anchor, disclosure anchor, bottom follow, and accessibility announcer behavior.

## Requirements And Acceptance Criteria

- **FR-1:** The Thread transcript shall use one paint owner for every Turn and
  shall repair a renderer-window coverage breach before the next paint.
- **NFR-1:** The urgent range-commit path shall run only when the committed
  virtual range no longer covers the real viewport; covered scrolling remains
  coalesced to one metric update per animation frame.
- **BR-1:** Reader intent, explicit disclosure, send anchoring, bottom follow,
  restore, and virtual compensation retain their existing ownership priority.

- **AC-1:** When a 39-Turn flow transcript jumps from the top to a distant
  position, the synchronous sample and the first two animation-frame samples
  shall each contain at least one paint-eligible Turn intersecting the viewport.
- **AC-2:** When an 80-Turn virtual transcript jumps outside the mounted window,
  the first animation-frame sample shall contain a mounted, paint-eligible Turn
  intersecting the viewport; no sampled frame may have zero coverage.
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
- Existing scroll writers can race over `scrollTop`. The feature changes only
  when the virtual range becomes visible; it does not change writer priority.

## Collision Result

PR #567 merged on 2026-08-20, and this plan branch now starts at the resulting
`main`. Its Retry integration changed separate `ThreadView.tsx`, E2E,
and specification regions; the virtual range, scroll scheduling, and
`content-visibility` paths remain unchanged. PR #569 changes only its own plan,
and PR #570 does not touch this feature's files. The active
`interaction-jank-cleanups` plan covers other scroll surfaces. There is no open
file collision, and the significant review queue has room for this feature
after PM ratification.

## Open Questions

None inside the selected target. PM ratification is the directional decision:
retain the current measured-row virtualizer under the single-owner invariant
(OPT-2), or pay the larger dependency and integration cost of OPT-1 now.

## Verification

- Run the new renderer unit tests for range coverage and stale-frame coalescing.
- Run the focused continuity, restore, send-anchor, disclosure-anchor, and
  virtual compensation cases in `tests/e2e/agent-thread.spec.ts`.
- Run the light/dark rapid-scroll visual check and retain trace numbers in the
  PR body.
- Run `bun run typecheck`, `bun run test:renderer`, the focused E2E suite,
  `bun run docs:check`, and `git diff --check`.
