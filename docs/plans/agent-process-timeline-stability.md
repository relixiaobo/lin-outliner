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

Present a compact summary of the first visible reasoning Markdown block
directly in the timeline instead of prefixing it with `Thinking` or `Thought`.
Derive that summary with the existing Markdown lexer rather than splitting the
canonical source at a physical newline. A plain-text leading paragraph may be
separated from later blocks so expansion reveals only the remainder without
repeating the summary. When the leading block is structured or contains inline
Markdown, expansion renders the complete canonical source; fences, tables,
lists, links, references, inline code, glob asterisks, and arithmetic asterisks
therefore remain recoverable exactly as received.

A compact summary is a plain row with no disclosure while it fits the available
width. Measure the summary locally and add a disclosure when it is visually
truncated; expansion wraps the complete summary in place. The first measurement
also runs when a disclosure mounts with an expanded override, so a long
single-line Item cannot become permanently clipped. Keep one `ResizeObserver`
for a folded disclosure across streamed token updates and coalesce subsequent
text-driven measurements into animation frames instead of forcing layout for
each token. A folded disclosure hides its chevron until hover or keyboard focus
while retaining the icon's layout slot; an expanded disclosure keeps it visible.

Live reasoning starts folded; an explicit expansion remains authoritative as
newer Items arrive. Record reasoning seen while its Turn is live and keep it
folded when the Turn settles, avoiding a completion-time expansion jolt. Preserve
the lone resultless terminal default only for reasoning first observed after
settlement.

Provider timelines may contain empty commentary Items between tool and
reasoning Items. Remove those Items at the Turn process projection boundary, not
only at the leaf renderer. They therefore cannot create an empty timeline,
split consecutive tools into separate activity groups, defeat the lone
resultless-reasoning default, or contribute an invisible flex interval between
visible rows.

The E2E geometry assertion derives the expected interval from computed styles
rather than duplicating a pixel constant. It compares the reasoning
headline-to-body interval with the body-to-tool and tool-to-next-reasoning
intervals in the same rendered timeline, and separately measures a single-line
reasoning row between split Web search/fetch runs separated by real empty
commentary Items. Component coverage asserts that a fitting single line has no
button or chevron, empty commentary does not enter the process projection,
visually truncated content can expand in full, a plain-text leading block is not
repeated in the expanded body, and structured leading Markdown expands from the
complete canonical source.

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
- a reader whose DOM position moved upward is treated as having released follow
  even before the queued `scroll` event synchronizes state;
- deferred anchor work remains replayable after its owner settles.

Track the last synchronized `scrollTop` in a ref shared by user and
programmatic scroll synchronization. Before either the immediate or scheduled
bottom pin writes, compare it with the current DOM position. Release follow on
an unsynchronized upward divergence, while ignoring a browser clamp when
content contraction lowered the maximum reachable offset.

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
- a reader who scrolled upward is still not pulled down; and
- assigning an upward `scrollTop` and appending an Item in the same task, without
  manually dispatching `scroll`, preserves the reader's position across the
  first painted frames.

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
- `tests/renderer/threadProcessSummary.test.ts`
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
- Deriving a summary must never split a Markdown construct. Lexer-backed tests
  cover fenced code, inline formatting, and literal asterisks, while expansion
  keeps the canonical source available for structured leading blocks.
- Width measurement must discover overflow even for an initially expanded
  single-line disclosure, then avoid measuring expanded wrapping as evidence
  that the disclosure is no longer needed.
- Streaming summary changes must not recreate observers or force a synchronous
  layout read per token; the observer lifetime and frame-coalesced reads have
  component coverage.

## Collision Result

No active overlap. The open PR inventory contains the Settings redesign, release
pipeline, and default Browser Pilot work; none claims the Thread renderer,
Thread Item renderer, Thread CSS, Agent Thread tests, or rendering spec. The task
board still lists this clone as idle because its entry is main-agent-owned. The
unclaimed future command-surface implementation may later touch `ThreadView.tsx`,
but it has no Draft PR claim and this change does not alter its composer contract.

## Open Questions

None.
