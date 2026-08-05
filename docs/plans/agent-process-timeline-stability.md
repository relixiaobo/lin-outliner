# Agent Process Timeline Stability

## Goal

Make the live Agent process timeline read as one regular compact sequence and
keep bottom-followed content in one painted state when a new Item appears. The
direct reasoning summary, expanded reasoning text, and tool rows use one
vertical interval, reasoning starts folded while live, and a structural Item
insertion reaches its final bottom-pinned position before the browser paints it.

This is shape **(a): one complete feature in one PR**.

## Non-goals

- No change to Thread, Turn, Item, notification, or command protocol shapes.
- No change to bottom-follow policy, the 56px release threshold, send-to-top
  anchoring, explicit disclosure anchoring, or virtual-row compensation.
- No animation or smooth scrolling to disguise geometry changes.
- No broad renderer subscription or memoization rewrite.

## Design

### One compact vertical interval

Use the process timeline's existing `--space-3` row gap as the interval between
every adjacent compact line. Expanded reasoning text currently adds
`--space-2` below its headline, while the next timeline child adds
`--space-3`; align the reasoning-body margin with the timeline gap. Preserve
the established type, line height, hierarchy, and token-only CSS.

Present the first meaningful reasoning line directly in the timeline instead
of prefixing it with `Thinking` or `Thought`. A single-line reasoning Item is a
plain row with no disclosure. When content remains after that line, the direct
summary becomes a disclosure and expansion renders only the remainder. Live
reasoning starts folded; an explicit expansion remains authoritative as newer
Items arrive. Preserve the lone resultless terminal reasoning default.

The E2E geometry assertion derives the expected interval from computed styles
rather than duplicating a pixel constant. It compares the reasoning
headline-to-body interval with the body-to-tool and tool-to-next-reasoning
intervals in the same rendered timeline, and separately measures a single-line
reasoning row between split Web search/fetch runs. Component coverage asserts
that a single line has no button or chevron and that a multi-line disclosure
does not repeat its summary in the expanded body.

### Same-paint structural bottom pin

Keep the frame-coalesced bottom-pin scheduler for resize observations,
streaming deltas, composer changes, virtual measurements, and deferred replay.
Those sources can arrive repeatedly and should not force synchronous layout on
every update.

Treat a change in canonical Item count as a narrower structural signal. When
follow is active and no higher-priority layout owner exists, pin the transcript
to its new bottom from the content-change layout effect, after React commits the
new row and before that commit is painted. Cancel or consume any redundant
scheduled bottom-pin frame so the new row cannot paint once at the old
`scrollTop` and then move the existing timeline on the following frame.

The immediate path yields to the same authorities as the scheduled path:

- a pending explicit disclosure anchor owns its layout transaction;
- a pending send anchor owns initial Turn placement;
- a reader who released follow is never moved;
- deferred anchor work remains replayable after its owner settles.

Transient scheduling and ownership flags remain refs. The structural trigger is
the primitive Item count, so ordinary Turn object replacement and text deltas do
not enter the immediate layout path.

### Verification contract

Extend the canonical Agent Thread E2E fixture with an overflowing live process
timeline that is following the bottom. Append one tool Item and record the first
painted frames. Assert that:

- the first frame containing the tool is already bottom-pinned;
- an existing process node keeps its DOM identity;
- existing content has no second-frame position correction;
- the timeline remains bottom-pinned after later frames settle;
- a reader who scrolled upward is still not pulled down.

Keep the existing send-anchor, disclosure-anchor, completion-layout, and virtual
compensation tests as regression coverage. Verify the compact timeline in light
and dark themes.

Update `docs/spec/agent-thread-rendering.md` with the uniform compact interval
and same-paint structural follow guarantees.

## Files

- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/components/items/ThreadItemView.tsx`
- `src/renderer/styles/thread.css`
- `tests/e2e/agent-thread.spec.ts`
- `tests/renderer/threadItemView.test.tsx`
- `docs/spec/agent-thread-rendering.md`
- `docs/plans/agent-process-timeline-stability.md`

## Risks

- A synchronous structural pin could fight send or disclosure anchoring. The
  immediate path must use the existing ownership gates and leave deferred replay
  intact.
- Broadening the immediate path to every Turn replacement would force layout on
  streaming token deltas. Item count is the deliberate narrow dependency.
- Canceling a scheduled frame without preserving its replay bit could lose work
  deferred behind an anchor. Tests cover both the immediate path and release.
- Removing `content-visibility` would regress long-Thread rendering and would not
  address the measured two-frame scroll correction; containment stays unchanged.
- Splitting a reasoning Item at its first meaningful line must preserve the
  remaining Markdown exactly once; component and E2E assertions cover both
  halves.

## Collision Result

No active overlap. The open PR inventory contains the Settings redesign, release
pipeline, and default Browser Pilot work; none claims the Thread renderer,
Thread Item renderer, Thread CSS, Agent Thread tests, or rendering spec. The task
board still lists this clone as idle because its entry is main-agent-owned. The
unclaimed future command-surface implementation may later touch `ThreadView.tsx`,
but it has no Draft PR claim and this change does not alter its composer contract.

## Open Questions

None.
