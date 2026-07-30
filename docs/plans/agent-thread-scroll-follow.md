# Agent Thread Scroll & Follow

## Goal

Make transcript scrolling predictable and controllable. Sending a message
anchors the just-sent user message at the top of the viewport (PM-ratified
direction, 2026-07-30) so the response streams downward from it. Follow-mode
becomes visible renderer state with an explicit jump-to-latest affordance, and
every content-height source participates in the pin logic so the reader is
never silently moved — or silently abandoned.

All `file:line` references are against `main` at `7bd60a04`.

## Non-goals

- No optimistic user-message insertion into `threadStore` (turns still appear
  on `turn/started`); this plan only changes when and where the view scrolls.
- No change to Thread/Turn/Item protocol shapes or store notification handling.
- No smooth-scroll animation pass; movements stay instant except where noted.
- No change to the per-thread scroll snapshot model beyond the bug fixes below.
- No virtualization redesign; only scroll compensation on top of the existing
  measured-row layout.

## Shape

Shape **(a): one complete feature in one PR.** Follow state, send anchoring,
the jump-to-latest control, pin triggers, and the restore/anchor bug fixes are
one state machine; splitting them would ship intermediate mechanisms that the
next PR immediately rewrites (A7).

## Collision Result

- `gh pr list` (2026-07-30): #450 (subagent budget PR B, backend kernel), #451
  (`threadservice-decomposition`, main-process ThreadService), #452
  (`cc/pane-reorder`, workspace panes), #453 (`codex-4/tool-path-modifier-click`,
  Draft, tool-path rendering in `ThreadItemView.tsx`). This plan's primary
  surface is `ThreadView.tsx` scroll machinery plus
  `disclosureScrollAnchor.ts`; the only potential overlap is #453 on
  `ThreadItemView.tsx` (one small hunk here: the show-more anchor fix). Land
  whichever is ready first; the other rebases mechanically.
- No infrastructure-ownership files are touched.

## Current defects (evidence)

- **D1 — Send does not scroll.** `submit()` only re-arms the follow flag
  (`stickToBottomRef.current = true`, `ThreadView.tsx:530`); the actual scroll
  waits for the `turn/started` notification to change `turns` and trigger the
  pin effect (`ThreadView.tsx:432-443`). `threadStore.send()` inserts nothing
  optimistic (`threadStore.ts:182-206`). On a slow provider nothing moves, and
  there is no `scrollIntoView` anywhere in the transcript code.
- **D2 — No jump-to-latest affordance.** The transcript renders only goal,
  turns, and retry status (`ThreadView.tsx:843-881`); once follow disengages,
  the only recovery is manually scrolling to within 56px of a bottom that keeps
  receding during streaming (`ThreadView.tsx:182-184`, `836-837`).
- **D3 — Follow is a ref, not state.** `stickToBottomRef`
  (`ThreadView.tsx:313`) cannot drive any UI, so no control can reflect or
  restore following.
- **D4 — Any disclosure toggle unconditionally kills follow**, even when the
  reader is pinned at the bottom (`ThreadView.tsx:347`, `394`).
- **D5 — Container-height changes never re-pin.** The scroller's
  ResizeObserver only refreshes metrics (`ThreadView.tsx:404-412`); composer
  growth (`thread.css:614`), `UserInputRequest` swap-in (`ThreadView.tsx:892`),
  and the plan chip mount (`ThreadView.tsx:884`) all shrink the viewport
  without re-pinning.
- **D6 — Non-turn transcript content is invisible to the pin triggers.**
  `ThreadGoalView` (`ThreadView.tsx:843`) and `ThreadProviderRetryStatus`
  (`ThreadView.tsx:881`) change `scrollHeight` without changing `turns` or
  `virtualLayout.totalHeight` (effect deps `ThreadView.tsx:443`), so the retry
  banner appears below the fold while "following".
- **D7 — Restore-on-open is one-shot, clamped, and destructive.** The mount
  restore clamps the saved position to the current `scrollHeight` and then
  overwrites the snapshot with the clamped value (`ThreadView.tsx:414-430`);
  if turns are still loading (store seeds an empty list,
  `threadStore.ts:319-326`), `maximumTop === 0` and a saved reading position
  permanently collapses to the top.
- **D8 — Async tool output defeats the disclosure anchor.** The anchor restore
  budget is 12 frames (`disclosureScrollAnchor.ts:3`, `147-159`) but expanded
  tool output arrives via an IPC read (`ThreadItemView.tsx:597-606`), long
  after the anchor died — the transcript jumps.
- **D9 — The user-message show-more expander is unanchored.**
  `ThreadItemView.tsx:506-509` toggles without `capturePendingAnchor`, unlike
  every other collapsible.
- **D10 — Virtualized estimate corrections shift the reader.** Rows are
  absolutely positioned (`thread.css:363-368`) so native scroll anchoring
  cannot apply; when an estimate is replaced by a measurement
  (`ThreadView.tsx:186-229`, `397-402`), offsets below change with no
  `scrollTop` compensation for a non-pinned reader.

## Design

### 1. Follow becomes state with one derivation rule

Replace `stickToBottomRef` with `follow: boolean` React state plus a ref
mirror for effect reads. One rule derives it: **after any scroll — user or
programmatic — `follow = nearBottom(56px)`.** `onScroll` already implements
the user half (`ThreadView.tsx:834-840`); programmatic movers (pin, restore,
anchor corrections, jump control) recompute the flag from the resulting
position instead of writing it directly. Explicit writes remain in exactly two
places: send (below) and the jump-to-latest control.

Consequence (PM-ratified spec change, 2026-07-30): disclosure toggles stop
writing follow state — delete the unconditional clears at `ThreadView.tsx:347`
and `:394`. A toggle that keeps the row anchored while content grows moves the
position away from the bottom, so the position rule releases follow naturally;
a small expansion at the bottom stays within the threshold and keeps
following. `docs/spec/agent-thread-rendering.md:436-439` and `:469-471` are
rewritten accordingly in the same PR.

### 2. Send anchors the user message to the viewport top

PM-ratified direction: after sending, the sent user message sits at the top of
the viewport and the response streams below it (instead of pinning to the
transcript tail).

- On `submit()`: record `pendingSendScrollRef = { threadId }` and immediately
  hard-scroll to the current bottom (instant feedback; the old tail is where
  the new message will mount).
- When the first turn for this thread whose `id` is new arrives while
  `pendingSendScrollRef` matches (the `turn/started` upsert,
  `threadStore.ts:418-429` → new `turns` array): after the row mounts and
  measures, set `scrollTop = rowTop - topInset` where `rowTop` is the user
  message row's offset and `topInset` is the transcript's existing top padding
  token. Clear the pending ref. Steering an active turn (no new turn id) keeps
  today's pin-to-bottom path.
- Follow is then recomputed by the position rule: for any conversation longer
  than one viewport this yields `follow = false` — intended, the reader is
  reading from the anchored message. New streamed content grows below without
  moving the view; the jump-to-latest control (below) is the return path.
- Short transcripts where the anchored position is also the bottom keep
  `follow = true` naturally.
- Virtualized threads: the anchor targets the measured row offset from
  `buildVirtualTurnLayout` (`ThreadView.tsx:214-229`); if the row is not yet
  measured, anchor once on its first `ResizeObserver` measurement
  (`ThreadView.tsx:996-1005`).

### 3. Jump-to-latest control

A floating pill, horizontally centered near the bottom edge of
`.thread-transcript`, visible when `follow === false` **and** content exists
below the viewport (`scrollMetrics`, `ThreadView.tsx:325`, `376-383`, already
carries the needed numbers). Behavior:

- Click / Enter: `scrollTop = scrollHeight`, which re-derives `follow = true`;
  focus returns to the composer per the terminal model
  (`docs/spec/agent-thread-rendering.md:337-347`).
- Presentation: level-1 overlay (menus tier), `--radius-pill`, neutral
  `--fill-*` chrome per B3 (no accent), down-arrow icon plus a short label
  from typed i18n (`agent.thread.jumpToLatest`, en + zh-Hans); an absolute
  overlay so appearing/disappearing never reflows the transcript (B7).
- While a turn is live and new items arrive with `follow === false`, the pill
  is the sole "new content" indicator; no unread badge in this PR.
- Reduced motion: no entry animation. Accessibility: it is a real button in
  the tab order with a visible focus ring (B8).

### 4. Pin triggers cover every height source

While `follow === true`, pinning must react to all four growth sources, not
just turn-array changes:

- Keep the existing effect on `turns` / `virtualLayout.totalHeight`
  (`ThreadView.tsx:432-443`).
- Add a ResizeObserver on the transcript's inner content wrapper so non-turn
  children (goal view, retry status) re-pin (fixes D6).
- Add a ResizeObserver on `.thread-composer-region` so composer growth, the
  plan chip, and the `UserInputRequest` swap re-pin the shrunken viewport
  (fixes D5).
- All three paths coalesce into the existing single-rAF pin
  (`bottomScrollFrameRef`, `ThreadView.tsx:311`).

### 5. Restore and anchor fixes

- **D7:** the mount restore no longer overwrites the saved snapshot with the
  clamped value; it retries after each turns-load settles (`loadTurns`
  resolution, `threadStore.ts:337-366`) until the saved offset is reachable or
  the user scrolls (which takes ownership and rewrites the snapshot as today,
  `ThreadView.tsx:838`). A thread whose turns have not loaded yet performs no
  restore at all instead of restoring into an empty scroller.
- **D8:** expanding a tool row keeps a pending anchor alive across the
  `outputRef` read: `usePendingDisclosureAnchor` accepts an explicit
  `holdUntilSettled` handle that the tool-output fetch resolves
  (`ThreadItemView.tsx:597-606`), re-applying the anchor once after content
  lands. User scroll/wheel/keydown still cancels immediately
  (`disclosureScrollAnchor.ts:99-129` unchanged).
- **D9:** the show-more expander calls `capturePendingAnchor` like every other
  disclosure (`ThreadItemView.tsx:506-509`).
- **D10:** when a measured height replaces an estimate for a row fully above
  the viewport and `follow === false`, add the delta to `scrollTop` in the
  same frame (standard virtualization compensation), so the visible content
  does not slide.

### 6. Spec update

Rewrite the follow/scroll contract in `docs/spec/agent-thread-rendering.md`
(the paragraphs at `:436-448` and `:469-471`) in the same change: send anchors
the sent message to the viewport top; follow is position-derived; the
jump-to-latest control restores following; disclosure toggles no longer
release follow directly.

## Verification

- E2E (`tests/e2e/agent-thread.spec.ts`): send anchors the user message top at
  the transcript top inset; response growth does not move the anchored view;
  jump-to-latest appears when scrolled up during streaming, returns to bottom,
  and re-engages follow; disclosure expansion at the bottom keeps following;
  the existing "does not pull the transcript down after the reader scrolls
  upward" case (`:2471-2552`) still passes; thread-switch restore returns to a
  mid-history position after turns load (regression for D7).
- Renderer tests for the follow-derivation rule and pending-send anchor
  bookkeeping.
- Manual/visual: light + dark pill rendering; reduced-motion run; a >40-turn
  virtualized thread for D10 compensation.
- `bun run typecheck`, `bun run test:renderer`, focused `bun run test:e2e`
  scope, `bun run docs:check`.

## Open questions

None. The send-to-top direction, the jump-to-latest control, and the
disclosure/follow spec change were ratified by the PM on 2026-07-30.
