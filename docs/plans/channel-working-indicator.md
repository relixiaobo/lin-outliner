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

- On hover **or** focus/click, open an anchored popover built on the existing
  `MenuSurface` + `useAnchoredOverlay` (same basis as `AnchoredActionMenu`),
  portaled to `document.body`, `placement: 'top-end'`. Because it is a real
  level-1 overlay (`--overlay-shadow-level-1`, solid `--overlay-bg`, central
  `prefers-reduced-transparency` opaque fallback) it never bleeds through content
  the way the current bespoke `opacity`-toggled absolute `div` does.
- Each row: avatar + name + **per-agent state** (thinking / using tools /
  received, reusing `activityStates.*`) + a per-run **Stop** button (only rows
  with a `runId` are stoppable).
- A header **"Stop all"** action stops every running run of the round.
- Clicking a row body (not Stop) opens that agent's run-details drill-in (existing
  `setSelectedActivityEntryId`). Keep the snapshot-freeze so the list does not
  shift while the pointer is inside it.
- Keyboard accessible for free via `useMenuKeyboard` (roving, Escape, focus
  restore to the row).

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

Change: stop degrading it to a string. Surface the running run's **in-flight
`AgentMessageEntry`** (the same shape the DM path renders), keyed by run, and have
the drill-in render it through `AgentMessageRow` in `streaming` mode — identical
thinking stream + tool-call rows live, folding to "Worked for {duration}" on
completion. Delete the `streamingText`-only branch.

Delivery is unchanged: the streaming entry stays **filtered from the main
transcript** (the thread is still whole-utterance, completion-order); only the
drill-in surfaces the structured live view. So the only thing that changes is the
drill-in's fidelity, not the IM model.

## Files

- `src/core/agentRenderProjection.ts` — rewrite `buildChannelActivityEntries`
  (round-based, multi-run, optimistic). Keep the independence-cut invariant
  untouched (it governs visibility, not this surface). Also surface each running
  run's in-flight `AgentMessageEntry` for the drill-in (replacing the flat
  `streamingText` field, which becomes unnecessary).
- `src/renderer/ui/agent/AgentChatPanel.tsx` — replace `AgentChannelActivityArea`
  with `ChannelWorkingRow` (in-flow) + the anchored detail popover; wire per-run
  Stop + Stop all + drill-in. Replace the bespoke `agent-channel-run-panel`
  drill-in body with `AgentMessageRow` (streaming mode) fed the run's in-flight
  entry (it already has `index` / `toolResults` / `childRunsByParentToolCallId` in
  scope to pass through).
- `src/renderer/styles/agent-message.css` (+ `agent-composer.css` as needed) —
  delete the absolute floating pill; add in-flow row styles, reduced-motion dots;
  detail popover rides `MenuSurface` styles.
- `src/core/i18n/messages/en.ts`, `src/core/i18n/messages/zh-Hans.ts` — new copy
  (working summary 1 / N, "Stop all"); reuse `activityStates.*`,
  `stopActivityEntry`.
- Reuse: `MenuSurface`, `useAnchoredOverlay`, `useMenuKeyboard`,
  `AgentIdentityAvatar`, `IconButton` + `StopIcon`.
- Tests: projection units (optimistic appears pre-run; parallel multi-run;
  per-run runId present; agent drops after it replies); renderer test for the
  working row (collapsed summary copy, expand opens detail, Stop / Stop-all
  wiring); update existing activity-area tests.

## Risks

- **Projection rewrite** touches core logic with existing tests/snapshots — update
  carefully; re-confirm the independence cut is unaffected.
- **Layout**: the appearing row must not cause a scroll jump; verify
  autoscroll-to-bottom and the empty→working→idle transitions.
- **Hover overlay + a11y**: must also be focus/click reachable; must not fight the
  outside-pointer dismissal / snapshot-freeze.
- **Visual**: verify light + dark, `prefers-reduced-motion`,
  `prefers-reduced-transparency` (the opaque fallback is the whole point).
- **Drill-in reuse**: `AgentMessageRow` carries many props/handlers (edit, retry,
  branch, reply anchors). In the drill-in those should be inert/omitted — render
  it as a read-only live view, not an editable transcript row. Confirm the
  streaming entry is still excluded from the main transcript after it is also
  surfaced to the drill-in.

## Shape

(a) ONE complete feature in one PR — the internal order is projection →
renderer/CSS → i18n/tests, build-order within the single PR (A7), not separable
releases.

## Decisions (PM-ratified)

- Drill-in reuses the DM message/process UI, **in this same PR** (one complete
  feature: indicator + what it opens into).
- Collapsed summary: **≤2 agents → names; ≥3 → "{n} agents working"** (count).
- Detail overlay opens on **hover or focus**; clicking a row body opens the
  drill-in; snapshot-freeze keeps the list stable while the pointer is inside.
