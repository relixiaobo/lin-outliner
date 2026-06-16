# Channel working indicator (redesign)

## Goal

After sending in a multi-agent **Channel**, the user must immediately and legibly
see that agents are working, who they are, where each one is, and be able to stop
them — without the indicator overlapping the transcript. Today the "who's
responding" surface is a faint, corner-anchored, absolutely-positioned pill whose
hover list floats **over** the last message (semi-transparent material that does
not paint out the text underneath → visible clipping / overlap), and whose state
text is `--text-faint` and hidden until hover. The result reads as silence: "no
one is answering, and I don't know what happens next."

This redesign keeps the PM-ratified IM model (whole-utterance delivery, typing
indicator while running) but moves the indicator into the layout flow above the
composer, makes it legible, and lights it up the instant the message is sent. It
also makes the run drill-in (opened from the indicator) reuse the **same
message/process UI DM uses**, so "watch a Channel agent compose" === "watch a DM
agent compose" — one mental model, not two.

## Non-goals

- **DM / single-agent unchanged** — streaming, steer, inline process all stay.
- **Delivery model unchanged** — replies are still whole-utterance, appended in
  completion order. The indicator makes **no ordering promise** (it never reserves
  a transcript slot per agent), which is what avoids the "positions look fixed"
  problem.
- No token-streaming into the transcript; no new per-agent bubble inside the
  scroll area. The indicator lives above the composer only.

## Design

### Placement & layout — fixes the overlap (穿模)

- Render a new in-flow status row, `ChannelWorkingRow`, as a **real flex child of
  `.agent-composer-region`, above `.agent-composer`** (the region is `flex: 0 0
  auto` below the `flex: 1` scroll area, so the row occupies its own height and
  shrinks the scroll area — it can never paint over transcript content). This
  replaces the current `position: absolute; bottom: calc(100% + …)` floating pill
  in `AgentChannelActivityArea`.
- Fixed-height, single line, truncates. Appear/disappear is a height+opacity
  transition that pushes the composer (no neighbor reflow jitter — B7 spirit).
  Verify transcript autoscroll-to-bottom still settles correctly when the row
  shows/hides.
- Neutral and readable: label at `--text-secondary` (not `--text-faint`); chrome
  consistent with the composer; concentric radius from the token chain.

### Collapsed content — "X is working" only

- The row shows the **generic working state only**, never per-agent state:
  - 1 agent → "{name} is working…"
  - ≥2 agents → "{n} agents are working…" (lean; see open question).
- Avatar stack (`AgentIdentityAvatar` size `xs`) + label + animated 3-dot.
  `prefers-reduced-motion` → static dots / no wave (B8).
- The whole row is the trigger that opens the detail overlay.

### Expanded detail — a proper overlay, also fixes 穿模

- **Clicking** the trigger (not hover) toggles an anchored `menu` popover built on
  the existing `MenuSurface` + `useAnchoredOverlay` + `useMenuKeyboard` (same basis
  as `AnchoredActionMenu`), portaled to `document.body`, `placement: 'top-end'`.
  Click — not hover — is the only model that composes cleanly with focus management
  and lets the menu be *pinned*: a hover-opened menu can't be entered to click a
  row without a hover-bridge hack, and offers no stable target for Escape /
  focus-restore. The trigger is a real `menu` button (`aria-haspopup="menu"`,
  `aria-expanded`, `aria-controls`). Because it is a real level-1 overlay
  (`--overlay-shadow-level-1`, solid `--overlay-bg`, central
  `prefers-reduced-transparency` opaque fallback) it never bleeds through content
  the way the old bespoke `opacity`-toggled absolute `div` did.
- Each row: avatar + name + **per-agent state** (thinking / using tools /
  received, reusing `activityStates.*`) + a per-run **Stop** button (only rows
  with a `runId` are stoppable).
- A header **"Stop all"** action stops every running run of the round.
- Clicking a row body (not Stop) opens that agent's run-details drill-in (existing
  `setSelectedActivityEntryId`) and closes the menu. No snapshot-freeze: the list
  is the **live** working set (a frozen snapshot would go stale and is unnecessary
  once the menu is click-pinned rather than hover-tracked).
- Keyboard accessible for free via `useMenuKeyboard` (roving, Escape, focus
  restore to the trigger).

### Optimistic light-up — projection change

Rework `buildChannelActivityEntries` from a **single-active-run** view into a
**round-based, multi-run** view:

- Pending/active set = agents addressed by the latest still-open user message
  (explicit `@`s, or the coordinator when there is no `@`), minus any that have
  already delivered their reply for that addressing.
- Per agent:
  - currently-running run → `{ state: thinking | using_tools, runId }`
  - addressed but not yet started → `{ state: 'received', runId: null }`
- Effects: entries appear the **instant the user message is persisted** (before
  any run starts) → no silent gap; every running agent carries its own `runId` →
  per-run Stop works for all of them, and genuinely parallel agents each show as
  working (no longer collapsed to one "active" + others "received").

### Stop semantics

- Per-run: `stopRun(entry.runId)`.
- Stop all: iterate running entries → `stopRun` each (matches the round-level stop
  semantics — `channel-im-semantics` #6: stop kills all active runs of the round).

### In-flight drill-in reuses the DM message/process UI

Today the drill-in (`agent-channel-run-panel`, `AgentChatPanel.tsx:1823-1862`) is
bespoke: a header + body that renders only the running run's **flat
`streamingText`** via `AgentMarkdown`. No thinking blocks, no tool-call rows, no
"Worked for {duration}" fold — tool progress shows only as a header word. That is
a second, lower-fidelity UI for the same thing DM already renders richly.

Root cause is data, not intent: DM's live process renders because the streaming
assistant message lives in the transcript as a structured `AgentMessageEntry`
(thinking + tool-call parts), shown via `AgentMessageRow` in `streaming` mode. A
Channel **filters that streaming entry out** of the thread (whole-utterance) and
keeps only a flat `streamingText` on the activity entry.

**Constraint found while building (this splits the work):** the in-flight channel
turn is *not just filtered in the renderer* — the core projection
**suppresses it at the source**. `buildTranscriptRows`
(`agentRenderProjection.ts`) drops any message whose run is in the live set
("a running Channel turn is never a transcript row"), so the structured in-flight
`AgentMessageEntry` (with thinking + tool-call parts) **never reaches the renderer
`entries`** for a Channel — only the flat `streamingText` (`run.assistantText`) is
exposed on the activity entry. The renderer-side thread filter that keys on
`entry.streaming` is effectively dead for Channels (the `streaming` flag is
DM-only, set from `dmStreaming`).

Therefore full DM-process reuse requires a **projection/main change** to expose
the suppressed in-flight structured message for a running Channel run (keyed by
run), which the drill-in would then render via `AgentMessageRow` (streaming). That
is a larger, separable change.

**This PR** keeps the existing `streamingText` live-text drill-in (it works in
production — `run.assistantText` is populated). The full structured-process reuse
is a **follow-up** (`channel-drill-in-process-reuse`, to be drafted), since it
needs the projection to surface the suppressed message. Delivery/IM model is
unchanged either way.

### Correction after reading the production code

The production producer is **`AgentRuntime.channelActivityEntries`**
(`src/main/agentRuntime.ts:4557`), fed into `buildAgentRenderProjection` via
`options.channelActivityEntries` (`:4477`). The core `buildAgentRenderProjection`
(`agentRenderProjection.ts`) *is* on the production path, but its internal
`buildDerivedActivityEntries` fallback is test-only. (`src/main/agentRuntime.ts`
carries an embedded null byte, so plain `grep` skips it as binary — use `rg -a`.)

That producer **already** delivers everything the design needs, so there is **no
projection/main rewrite**:

- One entry per live run, each with its own `runId` (`:4566-4579`) → per-run Stop
  works as-is; parallel agents each appear (not collapsed to one "active").
- Pending (capacity-gated) addressed turns appear as `state: 'received'`
  (`:4582-4595`).
- Entries appear at **send time** (turns are enqueued + a projection is emitted on
  accept) → optimistic light-up is already there at the data level; the only gap
  was the faint corner UI + round-trip, not missing data.
- `streamingText` **is** populated (`run.assistantText`, `:4577`) — it was never
  dead; the null-byte grep hid it.

So the work is **renderer + CSS + i18n only**.

## Files

- `src/renderer/ui/agent/AgentChatPanel.tsx` — replace `AgentChannelActivityArea`
  with `ChannelWorkingRow` (in-flow, above the composer) + an opaque detail popover
  (absolutely-positioned child, not an over-transcript overlay); collapsed =
  "X is working", expand = per-agent state; wire per-run Stop + Stop all + drill-in.
  Drill-in keeps the `streamingText` live-text body for this PR (see the constraint
  above); full `AgentMessageRow` process reuse is the follow-up.
- `src/renderer/styles/agent-message.css` (+ `agent-composer.css` as needed) —
  delete the `position:absolute` floating pill; add in-flow row styles
  (`--text-secondary`, fixed height, reduced-motion dots); detail popover rides
  `MenuSurface`.
- `src/core/i18n/messages/en.ts`, `src/core/i18n/messages/zh-Hans.ts` — new copy
  (working summary 1 / N, "Stop all"); reuse `activityStates.*`,
  `stopActivityEntry`.
- Reuse: `MenuSurface`, `useAnchoredOverlay`, `useMenuKeyboard`,
  `AgentIdentityAvatar`, `IconButton` + `StopIcon`, `AgentMessageRow`.
- Core/main: **no change expected** (verify the data suffices; only touch
  `AgentRenderActivityEntry` if a field is genuinely missing).
- Tests: e2e for the working row (collapsed summary copy 1 / N, click opens the
  menu, opaque/portaled/anchored detail, per-run Stop / Stop-all wiring, live list
  on re-emit, drill-in opens the per-run live-text detail); update existing
  activity-area tests/e2e to the new DOM. (Full `AgentMessageRow` drill-in reuse is
  the follow-up — see Decisions.)

## Risks

- **Projection rewrite** touches core logic with existing tests/snapshots — update
  carefully; re-confirm the independence cut is unaffected.
- **Layout**: the appearing row must not cause a scroll jump; verify
  autoscroll-to-bottom and the empty→working→idle transitions.
- **Menu a11y**: click-toggled `menu` with `useMenuKeyboard` (roving, Escape,
  focus-restore to the trigger); the outside-pointer handler ignores the trigger
  so a click toggles rather than close-then-reopen.
- **Visual**: verify light + dark, `prefers-reduced-motion`,
  `prefers-reduced-transparency` (the opaque fallback is the whole point).
- **Drill-in reuse** (follow-up): `AgentMessageRow` carries many props/handlers
  (edit, retry, branch, reply anchors). In the drill-in those should be
  inert/omitted — render it as a read-only live view, not an editable transcript
  row. The follow-up must also confirm the streaming entry is still excluded from
  the main transcript after it is also surfaced to the drill-in. (This PR keeps the
  simpler `streamingText` live-text drill-in — see Decisions.)

## Shape

(a) ONE complete feature in one PR — the internal order is projection →
renderer/CSS → i18n/tests, build-order within the single PR (A7), not separable
releases.

## Decisions (PM-ratified)

- Collapsed summary: **≤2 agents → names; ≥3 → "{n} agents working"** (count).
- Detail menu opens on **click** (a `menu` button toggle), not hover: it is the
  only model that composes cleanly with focus management and lets the menu be
  pinned (the earlier hover/focus framing could not be entered to click a row, and
  gave no stable Escape / focus-restore target). Clicking a row body opens the
  drill-in and closes the menu; the list is the **live** working set (no
  snapshot-freeze — a frozen snapshot goes stale and is needless once click-pinned).
  A hover-peek refinement can come later as a follow-up if desired.
- Drill-in DM-process reuse: **split to a follow-up PR** (PM-ratified after the
  build surfaced that the in-flight Channel message is suppressed at the
  projection source — see the constraint above). This PR keeps the working
  `streamingText` live-text drill-in. Follow-up: expose the suppressed in-flight
  structured Channel message (keyed by run) so the drill-in renders via
  `AgentMessageRow` (streaming), matching DM.
