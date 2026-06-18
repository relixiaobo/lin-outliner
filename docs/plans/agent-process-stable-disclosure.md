# Agent process stable disclosure

## Goal

Make agent process rendering feel stable when a turn moves from working to
worked. Thinking, tool calls, and interim narration should behave like a compact
progress disclosure: collapsed by default, showing the latest useful activity
while work is running, and expanding only when the user asks for detail.

This is an approved product behavior change. The current shipped behavior
intentionally auto-expands live work and auto-collapses it on completion. PM has
ratified the reversal: live work should also default collapsed.

The completed state should update in place instead of removing a large visible
process list in one frame. The visible transcript anchor should stay stable
through working -> worked in the unified single-agent conversation transcript,
including long virtualized transcripts.

## Non-goals

- Do not change the event log, tool protocol, run lifecycle, or provider/runtime
  execution semantics.
- Do not change how final assistant prose is split from process content.
- Do not redesign the conversation list, channel naming/configuration surfaces,
  or child-run detail panel beyond the process disclosure behavior needed here.
- Do not add a new agent UI surface. This is a refinement of
  `AgentProcessBlock`, `AgentTurnProcessFold`, and the existing assistant-turn
  rendering path.
- Do not implement outliner node expand/collapse anchoring in this PR. The
  outliner case below is recorded only as a related stability finding and a
  shared interaction invariant.
- Do not animate for decoration. Any motion must be functional, short, and
  disabled by `prefers-reduced-motion`.

## Shape

(a) ONE complete feature in one PR.

The implementation PR should ship one complete user-visible behavior:
PM-approved live process rows default collapsed, expose latest live activity in
the header, and update to the settled summary in the same disclosure row.

The earlier draft bundled broader row-identity cleanup, generic scroll-anchor
infrastructure, and Channel working-row geometry. After #294/#296, those are not
all prerequisites for this feature:

- Row identity is a verification point. If the current unified transcript keys
  already preserve the visible row across live -> sealed, do not add identity
  infrastructure.
- Scroll anchoring is a targeted safety net. Add only local compensation required
  by process disclosure toggles/completion tests; do not introduce broad
  transcript infrastructure unless the focused tests prove it is necessary.
- Multi-agent Channel working-row geometry is out of scope. #294 collapsed the
  agent model to one agent and removed the multi-agent channel activity surface.

If implementation reveals a protocol/shared projection change is required, stop
and split an interface-first PR instead of expanding this feature PR.

## Collision Self-check

#294 and #296 have merged. This plan is based on post-merge `main`:

- The agent subsystem is now a single-agent conversation model. There is no
  DM-vs-Channel branch in the renderer path this plan targets.
- `summarizeProcess(... liveCollapsed)` already exists in
  `AgentProcessBlock.tsx` and can produce a live collapsed header from pending
  tool calls or latest thinking text.
- The current live default is still the opposite of this plan:
  `defaultExpanded = surfaceResultlessProcess || liveSegment`.
- `AgentTurnProcessFold` also forces live turns open with
  `expanded = liveSegment ? true : ...`.

Open PR scan at implementation-claim time is still required, but #294/#296 are
no longer blockers or unknowns.

Board scan: `docs/TASKS.md` has no active item for this exact stability change.
The plan PR intentionally leaves `docs/TASKS.md` untouched because that file is
main-agent-owned.

## Intended File Scope

- `src/renderer/ui/agent/AgentProcessBlock.tsx`
- `src/renderer/ui/agent/AgentAssistantTurnContent.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentTranscriptMessageList.tsx` only if focused tests
  prove row anchoring must be handled at the list layer
- `src/renderer/styles/agent-tool-rows.css`
- `src/renderer/styles/agent-message.css`
- `tests/e2e/agent-process.spec.ts`
- `tests/renderer/agentConversationRenderRows.test.ts` only if render-row key
  helpers change
- `docs/spec/agent-event-log-rendering.md`
- `docs/spec/agent-architecture.md` only if it still points readers at the old
  live-disclosure behavior after the implementation lands

Avoid `src/renderer/agent/runtime.ts` unless the renderer cannot keep row
identity stable without changing the render-row projection.

## Design

### Shared disclosure anchor invariant

The same class of perceived instability can appear outside the agent transcript.
For example, in the outliner, collapsing a node whose expanded body extends below
the viewport can move the visible node/header because descendant rows are removed
from the flat list and later rows are re-positioned. The current outliner flat
view compensates height-only measurement corrections, but not expansion
add/remove projections.

This agent plan should not implement the outliner fix, but it should follow the
same invariant so the solution is not agent-specific:

- When a disclosure change is caused directly by a user click, capture the
  clicked disclosure row or trigger's viewport position before the expansion
  state changes.
- After layout commits, if that row/trigger still exists, adjust the scroll
  container so the row/trigger remains at the same viewport position.
- If the trigger row is unavailable, fall back to preserving the first visible
  row for scrolled-away readers, or the bottom/composer boundary for at-bottom
  readers.
- Automatic lifecycle transitions, such as agent working -> worked, do not have
  a clicked trigger. They should use the transcript/bottom anchor policy below.
- Scroll compensation is an instantaneous layout correction, not a smooth scroll
  animation.

### 1. Live process disclosure defaults collapsed

Change the default process state from "live turns auto-expand" to "live turns
stay collapsed unless the user expands them."

Current post-#294 behavior:

- `AgentProcessBlock` derives `liveSegment = turnActive && !sealed`.
- It defaults open with `surfaceResultlessProcess || liveSegment`.
- `AgentTurnProcessFold` forces the outer live fold open and locked while final
  prose streams.

Target behavior:

- Ordinary live process blocks default collapsed.
- The collapsed header shows the current running tool summary when a tool is
  pending.
- Otherwise it shows the latest non-empty thinking preview.
- Otherwise it shows `Working...`.
- The trailing disclosure slot remains stable: spinner or chevron may swap within
  the same slot, but title x-position and row height must not change.
- User expansion reveals the full process list in original order.
- The user choice is sticky for that process id. If the user expanded while live,
  completion must not auto-collapse it.
- If the user never expanded, completion keeps the row collapsed and only updates
  the header summary.

The implementation should reuse the existing
`summarizeProcess(... liveCollapsed)` path. The main code change is the default
expansion policy, plus the corresponding live-fold behavior in
`AgentTurnProcessFold`.

### 2. Completion updates the same row

When a turn seals:

- A collapsed live header updates from the live activity summary to
  `Worked for {duration}` when timing is known.
- If timing is unknown, it falls back to the static group summary.
- A genuinely interrupted resultless turn keeps the interrupted label/error
  state.
- A surfaced resultless turn remains expanded only when the user opened it or
  when the existing resultless surfacing rule requires visible context.

The important contract is geometric: the resting header remains the same visual
row. Completion should not remove a previously visible process list unless that
list was explicitly opened by the user or required by an exceptional
resultless/error case.

### 3. Row identity is verified before expanded in scope

The feature needs the visible process disclosure to survive live -> sealed
without remounting into a different transcript row. After #294, the renderer has
a simpler single-agent path, so do not assume a broad identity rewrite is needed.

Implementation rule:

- First add focused tests around live collapsed -> sealed collapsed behavior.
- If they pass with the existing `contentKey` / row keys, leave row identity
  infrastructure alone.
- If the same visible turn still remounts or loses expand-state, fix the smallest
  renderer-local key boundary.
- If the fix would require protocol/shared projection shape changes, stop and
  split an interface-first PR.

### 4. Scroll anchoring is targeted, not global infrastructure by default

Collapsed-by-default removes the main automatic height collapse. Remaining
height changes can still happen when:

- The user manually opens/closes process details.
- Final prose lands above the current viewport.
- Virtual row measurements correct after content renders.
- Child-run process detail expands or seals.

Anchor policy:

- If the reader is at the bottom, keep the bottom/composer boundary stable.
- If the reader is not at the bottom, preserve the first visible transcript row's
  viewport top.
- For user-triggered process disclosure toggles, prefer the clicked process
  trigger as the anchor when it remains mounted.
- For virtualized transcripts, use row key + measured delta; do not depend only
  on `scrollHeight`.
- Do not force bottom pinning for users who have scrolled away from the bottom.

Implementation direction:

- Start with tests that capture bounding boxes before/after live -> sealed and
  manual disclosure toggles.
- Add local `useLayoutEffect` scroll compensation only where tests show visible
  movement remains.
- Keep reads grouped before writes.
- Respect `prefers-reduced-motion`; scroll compensation is instantaneous and not
  a smooth scroll.

### 5. Detail expansion remains explicit

Manual expansion still changes row height. That is acceptable because the user
caused it and expects content to open. The stability requirement is that the
clicked disclosure row or the user's current viewport anchor should not move
unexpectedly as the rest of the transcript reflows.

## Testing

Add or update focused Playwright coverage:

- Live turn: process starts collapsed while a tool is pending; header shows the
  latest tool summary or latest thinking preview; the process list is not mounted
  until the user expands it.
- Live -> sealed: completing the turn changes only the same process header to
  `Worked for ...`; the final answer stays visible; the row does not jump.
- User-expanded live turn: when the user expands during live work, completion does
  not auto-collapse or reset that choice.
- Resultless/interrupted turns: existing surfaced-process/error behavior remains
  visible and does not regress into a misleading clean `Worked for ...` state.
- Child-run detail: running child transcript uses the same collapsed live process
  behavior and preserves row identity on completion.
- Long transcript: with virtualization active, completing a visible or
  above-viewport process row preserves the first visible row's top or the bottom
  boundary according to the user's scroll position.
- Manual disclosure toggle: the clicked process trigger remains visually anchored
  when expansion/collapse changes a large amount of detail content.
- Reduced motion: no height/opacity transition is required; any scroll
  compensation still keeps the viewport stable.

Retain existing assertions that:

- Final answer prose renders outside the process fold.
- Resultless interrupted turns surface their process/error context.
- Cleanly completed resultless turns do not show `Interrupted`.

Visual verification before marking ready:

- Light and dark mode.
- Short transcript and virtualized long transcript.
- At-bottom and scrolled-away positions.
- Live tool, live thinking-only, final prose streaming, and child-run transcript.

## Risks

- This is a product behavior reversal from the current intentional default. The
  PM has given GO, but implementation and spec text should call out the change
  clearly so review does not treat it as a bug fix.
- `AgentTurnProcessFold` currently locks live rows open. Changing that may expose
  assumptions in tests that expect live folds to be disabled/non-interactive.
- Row identity changes can accidentally reset branch/action/menu state if keys
  are too broad or too narrow. Avoid touching keys unless focused tests prove a
  remount.
- Scroll anchoring can fight the browser's own scroll anchoring if it is applied
  unconditionally. It must only compensate known disclosure/transcript layout
  updates.
- E2E screenshots may be needed because bounding-box checks alone can miss the
  subjective "jump" caused by multiple small deltas in one frame.

## Open Questions

- Should the completed collapsed header prefer `Worked for {duration}` or an
  action summary such as `Read 3 files` when the tool summary is more informative?
- Should a user-expanded live process remain expanded forever for that turn, or
  should there be an explicit "collapse on completion" preference later?
- Should outliner node expand/collapse anchoring be planned as a separate PR
  using the same clicked-trigger anchor rule?

## Build Checklist

- Re-run collision self-check at implementation-claim time.
- Update `AgentProcessBlock` default expansion from live-open to live-collapsed
  for ordinary live process blocks.
- Update `AgentTurnProcessFold` so live outer folds are not forced open/locked
  when the PM-approved collapsed-live policy applies.
- Preserve existing resultless/interrupted surfacing rules.
- Verify row/content keys across live -> sealed transitions before changing any
  identity infrastructure.
- Add targeted scroll-anchor compensation only if focused tests still show
  movement after the default collapsed behavior lands.
- Update focused E2E tests.
- Fold the shipped behavior into `docs/spec/agent-event-log-rendering.md` and any
  agent architecture text that still describes the old live-open default.
- Run `bun run typecheck`, focused e2e, and `bun run docs:check`.
