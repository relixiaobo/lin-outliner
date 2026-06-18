# Agent process stable disclosure

## Goal

Make agent process rendering feel stable when a turn moves from working to
worked. Thinking, tool calls, and interim narration should behave like a compact
progress disclosure: collapsed by default, showing the latest useful activity
while work is running, and expanding only when the user asks for detail.

The completed state should update in place instead of removing a large visible
process list in one frame. The visible transcript anchor should stay stable
through working -> worked, including Channel activity rows and long virtualized
transcripts.

## Non-goals

- Do not change the event log, tool protocol, run lifecycle, or provider/runtime
  execution semantics.
- Do not change how final assistant prose is split from process content.
- Do not redesign the Channel activity detail popover beyond the layout stability
  needed here.
- Do not add a new agent UI surface. This is a refinement of
  `AgentMessageRow` / process disclosure behavior.
- Do not implement outliner node expand/collapse anchoring in this PR. The
  outliner case below is recorded only as a related stability finding and a
  shared interaction invariant.
- Do not animate for decoration. Any motion must be functional, short, and
  disabled by `prefers-reduced-motion`.

## Shape

(a) ONE complete feature in one PR.

This should ship as one user-visible interaction change because the default
collapsed process, scroll anchoring, Channel working-row stability, tests, and
spec update are one behavior contract. Splitting them would leave a partially
stable UI.

## Collision Self-check

Open-PR overlap exists:

- #294 `cc-2/single-agent-collapse` touches `src/renderer/ui/agent/*`,
  `src/core/agentRenderProjection.ts`, agent specs, and may replace the
  multi-agent Channel model this plan is based on.
- #296 `cc-2/single-agent-dock-ui` touches `AgentChatPanel`,
  agent composer/model controls, i18n, and `agent-pi-mono-implementation.md`;
  it is stacked on #294.

Board scan: `docs/TASKS.md` has no active item for this exact stability change.
It records the shipped result-first fold and Channel working set, which this plan
refines rather than replacing.

Implementation should wait until #294/#296 land, or rebase onto their final
branch before editing agent UI files. Re-run this collision check at claim time.

## Intended File Scope

- `src/renderer/ui/agent/AgentProcessBlock.tsx`
- `src/renderer/ui/agent/AgentAssistantTurnContent.tsx`
- `src/renderer/ui/agent/AgentProcessTimeline.tsx`
- `src/renderer/ui/agent/AgentThinkingBlock.tsx`
- `src/renderer/ui/agent/AgentToolCallBlock.tsx`
- `src/renderer/ui/agent/AgentTranscriptMessageList.tsx`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/agent/runtime.ts` only if stable row identity cannot be solved
  in the render-row layer
- `src/renderer/styles/agent-tool-rows.css`
- `src/renderer/styles/agent-message.css`
- `tests/e2e/agent-process.spec.ts`
- `tests/e2e/agent-composer.spec.ts` only for Channel working-row regression
  coverage
- `tests/renderer/agentConversationRenderRows.test.ts` if row identity helpers
  move
- `docs/spec/agent-event-log-rendering.md`
- `docs/spec/agent-architecture.md` only if the Channel resting/live contract is
  restated there after #294

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

### 1. Process disclosure defaults collapsed while live

The default process state changes from "live turns auto-expand" to "live turns
stay collapsed unless the user expands them."

Collapsed live header behavior:

- Show the current running tool summary when a tool is pending.
- Otherwise show the latest non-empty thinking preview.
- Otherwise show `Working...`.
- Keep the trailing disclosure slot stable: spinner or chevron may swap within
  the same slot, but the title x-position and row height must not change.

Expanded behavior:

- User expansion reveals the full process list in original order.
- The user choice is sticky for that process id. If the user expanded while live,
  completion must not auto-collapse it.
- If the user never expanded, completion should keep the row collapsed and only
  update the header summary.

This uses the existing `summarizeProcess(... liveCollapsed)` direction instead of
making the expanded timeline the default live surface.

### 2. Completed summary updates in place

When a turn seals:

- A collapsed live header updates from the live activity summary to
  `Worked for {duration}` when timing is known.
- If timing is unknown, it falls back to the static group summary.
- A genuinely interrupted resultless turn keeps the interrupted label/error
  state.
- A surfaced resultless DM turn remains expanded only when the user opened it or
  when the existing resultless surfacing rule requires visible context.

The important contract is geometric: the resting header remains the same visual
row. Completion should not remove a previously visible list unless that list was
opened by default for an exceptional resultless/error case.

### 3. Stable row identity across live -> sealed

The render row key for a turn should stay stable across these transitions:

- DM placeholder before an assistant message exists.
- DM streaming assistant row that later receives a persisted message id.
- Channel activity entry disappearing while the completed utterance appears.
- Child-run transcript rows using `AgentTranscriptMessageList`.

Preferred approach:

- Derive a turn identity from the user-message anchor plus producing run id when
  available.
- Avoid switching between `active-assistant-*` and a persisted transcript row key
  for the same visible turn.
- Keep `contentKey` stable enough that process expansion state survives the
  working -> worked update.

If a full identity cleanup would touch protocol/shared projection shape, stop and
split an interface-first PR. Otherwise keep it renderer-local.

### 4. Scroll anchoring as a safety net

Even with collapsed-by-default process rows, content can still change height:
Channel working rows disappear, final prose lands, details can load, and virtual
row measurements update. The scroll container should preserve the user's visual
anchor.

Anchor policy:

- If the reader is at the bottom, keep the bottom/composer boundary stable.
- If the reader is not at the bottom, preserve the first visible transcript row's
  viewport top.
- For virtualized transcripts, use the same row key + measured delta; do not
  depend only on `scrollHeight`.
- Do not force bottom pinning for users who have scrolled away from the bottom.

Implementation direction:

- Before applying a projection/render update that may add/remove Channel
  activity rows or change transcript row heights, capture a visible anchor
  `{rowKey, top}` or bottom distance.
- After layout commits, adjust `scrollTop` by the delta needed to keep that
  anchor in place.
- Use `useLayoutEffect` for the read/write pair and keep reads grouped before
  writes.
- Respect `prefers-reduced-motion`; scroll compensation is instantaneous and not
  a smooth scroll.

### 5. Channel working row should not change layout abruptly

Channel activity currently lives above the composer. If it mounts/unmounts as an
ordinary in-flow row, the composer region height changes at completion.

Preferred minimal fix:

- Reserve a stable working-row slot in Channel mode, even when no agents are
  active, and fade/disable its content when idle.
- If reserving height feels too heavy visually, use an overlay anchored above the
  composer that does not change transcript layout.

Either option must keep the composer and transcript anchor stable when the last
Channel run completes.

### 6. Detail expansion remains explicit

Manual expansion still directly changes row height. That is acceptable because
the user caused it and expects content to open. The plan only removes automatic
large layout changes caused by run lifecycle transitions.

Manual expansion should still preserve the transcript anchor when the expanded
content is above the viewport anchor, using the same scroll anchoring helper.

## Testing

Add or update focused Playwright coverage:

- DM: process is collapsed while a tool is pending; header shows the latest tool
  summary; completing the turn changes only the header to `Worked for ...`; the
  final answer stays visible.
- DM: when the user expands during live work, completion does not auto-collapse.
- Channel: running activity appears without moving the composer/transcript anchor;
  completion removes/settles the working state without visible jump.
- Child-run detail: running child transcript uses the same collapsed live process
  behavior and preserves row identity on completion.
- Long transcript: with virtualization active, completing a visible or above-
  viewport process row preserves the first visible row's top.
- Reduced motion: no height/opacity transition is required; scroll anchor
  compensation still keeps the viewport stable.

Retain existing assertions that:

- Final answer prose renders outside the process fold.
- Resultless interrupted turns surface their process/error context.
- Cleanly completed resultless Channel turns do not show `Interrupted`.

Visual verification before marking ready:

- Light and dark mode.
- DM and Channel.
- Short transcript and virtualized long transcript.
- At-bottom and scrolled-away positions.

## Risks

- #294/#296 may remove or reshape Channel/multi-agent UI paths. The final
  implementation must adapt to the post-collapse agent model before coding.
- Row identity changes can accidentally reset branch/action/menu state if keys
  are too broad or too narrow.
- Scroll anchoring can fight the browser's own scroll anchoring if it is applied
  unconditionally. It must only compensate known transcript/composer layout
  updates.
- Reserving Channel working-row height may feel like dead space when idle; the
  overlay option avoids that but needs careful focus and pointer semantics.
- E2E screenshots may be needed because bounding-box checks alone can miss the
  subjective "jump" caused by multiple small deltas in one frame.

## Open Questions

- After #294, does Channel still exist as a distinct surface, or does this plan
  reduce to the single-agent DM transcript plus a simplified working indicator?
- Should the completed collapsed header prefer `Worked for {duration}` or an
  action summary such as `Read 3 files` when the tool summary is more informative?
- Should a user-expanded live process remain expanded forever for that turn, or
  should there be an explicit "collapse on completion" preference later?
- Is a reserved Channel working-row slot acceptable in the final visual design,
  or should it be an overlay to avoid idle spacing?
- Should outliner node expand/collapse anchoring be planned as a separate PR
  using the same clicked-trigger anchor rule?

## Build Checklist

- Re-run collision self-check after #294/#296 settle.
- Update the process default expansion logic.
- Stabilize row/content keys across live -> sealed transitions where needed.
- Add the scroll-anchor helper and apply it to transcript/channel activity
  layout changes.
- Stabilize Channel working-row geometry.
- Update focused E2E tests.
- Fold the shipped behavior into `docs/spec/agent-event-log-rendering.md` and
  any post-#294 agent architecture text that still describes the old default.
- Run `bun run typecheck`, focused e2e, and `bun run docs:check`.
