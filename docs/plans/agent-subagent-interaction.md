# Agent Subagent Interaction

## Goal

Make delegated work visible, truthful, and controllable while it runs. Today a
running Subagent is a black box in its parent transcript: status rows lie
permanently, completion can stay invisible until the user's next message, the
user cannot stop a runaway child (short of deleting its Thread), and there is
no way back to the parent after inspecting a child. This plan fixes the
truth/reachability layer, then the navigation/list layer, and finally adds the
live delegation surface plus user control — the human-facing half of the
Delegation Contract's "Account" product
(`docs/spec/agent-subagent-threads.md`, Delegation Contract §2).

All `file:line` references are against `main` at `7bd60a04`.

## Non-goals

- No change to the collaboration tool contracts (`spawn_agent`, `wait_agent`,
  `send_message`, `followup_task`, `list_agents`, `interrupt_agent`) or their
  model-facing semantics; this plan changes what the *user* sees and can do.
- No lifting of the `request_user_input` root-Thread scope. The "a child
  cannot ask the user" deferral (`docs/plans/agent-program.md:90-91`) stands;
  this plan only makes the blocked state visible.
- No child composer. Child Threads stay read-only per
  `docs/spec/agent-thread-rendering.md:360-363`; user control is limited to
  interrupt.
- No token numbers on user surfaces (Delegation Contract §3: receipts are
  internal; user surfaces speak time/status).
- No transcript-artifact work (owned by the queued
  `subagent-transcript-artifact` item).

## Shape

Shape **(b): a set of three independent complete features, each its own PR.**

- **PR 1 — status truth in the parent transcript.**
- **PR 2 — navigation and Thread-list hygiene.**
- **PR 3 — live delegation card + user interrupt** (pending the open
  questions below).

PR 1 and PR 2 are independent. PR 3 builds on PR 1's live-status projection
but replaces its row presentation; it must land after PR 1.

## Collision Result

- `gh pr list` (2026-07-30): #451 (`codex-2/threadservice-decomposition`) is
  an open non-draft PR decomposing `src/main/agent/ThreadService.ts` — PR 1's
  small backend touches (activity flush points, `agentsStates` payload) and
  PR 3's interrupt seam overlap that file's future shape. **Order this plan's
  backend work after #451 merges** and write it against the decomposed
  services. #450 (subagent budget PR B) touches kernel/budget paths, not this
  UI surface; no conflict. #453 overlaps `ThreadItemView.tsx` (tool-path
  links) — mechanical rebase only.
- Renderer-only parts of PR 1/PR 2 can proceed regardless.
- No infrastructure-ownership files. `src/core/agent/protocol.ts` changes
  (PR 1) are a coordinated protocol-adjacent change: flagged here for the
  gate, and pre-release policy applies — no migration, no legacy readers;
  wipe `~/.lin-outliner-*` dev userData on the Item-shape change.

## Current defects (evidence)

### Status truth (PR 1)

- **S1 — A permanently lying "Running" row.** `subAgentActivity` Items are
  append-only; the `started` row maps to "Running" forever
  (`ThreadItemView.tsx:843-848`), never rewritten when the child ends — the
  terminal state arrives as a *second* row.
- **S2 — A permanently lying spawn row.** The spawn tool row's `agentsStates`
  is synthesized as a hard-coded `'running'` from the tool result
  (`PiTurnExecutor.ts:1229-1231`) and has no later writer.
- **S3 — Completion can be invisible for a long time.** Terminal child
  activity is flushed into the parent only at `wait_agent` return, next-Turn
  admission, or parent-Turn end (`ThreadService.ts:2437`, `2474`,
  `2691-2728`, `2849`); fire-and-forget children finish silently until the
  user's next message.
- **S4 — No live signal at all from a running child.** No elapsed time, no
  current activity, no turn count in the parent row (`ThreadItemView.tsx:
  168-183`); the Turn divider says only "Working for …"
  (`ThreadView.tsx:1541-1552`).
- **S5 — Failure looks like success.** Terminal `errored`/`interrupted` rows
  are styled identically to `completed` (`ThreadItemView.tsx:168-183`,
  `thread.css:1460-1500`); the failure reason is not in the Item, only inside
  the child Thread or the raw `wait_agent` output JSON
  (`ThreadItemView.tsx:789-822`, `606-618`).
- **S6 — Children are truncated UUIDs.** Spawn/wait rows list
  `shortThreadId` + status only (`ThreadItemView.tsx:806`, `838-840`) because
  the persisted Item shape drops `taskPath`/`nickname`/`role`
  (`protocol.ts:917-927` vs the tool result at `ThreadService.ts:318-327`).
- **S7 — Model jargon on a user surface.** "Using spawn_agent", "Using
  wait_agent", "spawn_agent failed" (`ThreadItemView.tsx:869-870`, `881-887`;
  `en.ts:1239-1241`).
- **S8 — Misleading aggregate states.** An idle-but-alive child reports
  "Completed" (`ThreadService.ts:3659-3667`); a failed collab *tool* marks
  every receiver `errored` (`PiTurnExecutor.ts:1235-1246`); "Working with N
  agents" counts a `wait_agent` row as an agent (`ThreadItemView.tsx:
  1016-1019`, `1049`).
- **S9 — Blocked state is dead data.** `waitingOnUserInput`
  (`protocol.ts:48`, set at `ThreadService.ts:2040`) is read by nothing in
  `src/renderer`.

### Navigation & list (PR 2)

- **S10 — No way back to the parent.** Opening a child replaces the dock view
  wholesale (`ThreadDock.tsx:293-325`); the header has no
  breadcrumb/back (`:229-255`); the child often sorts *above* its parent in
  the flat recency list (`threadStore.ts:624-626`).
- **S11 — Dead links fail silently.** Transcript rows call `selectThread`,
  which throws for a Thread missing from the catalog (`threadStore.ts:115`)
  behind a bare `void` (`ThreadItemView.tsx:174`, `810`); the recovering
  `openThreadById` (`threadStore.ts:120-127`) is wired only into Automations.
- **S12 — Thread-list pollution and spec violation.** Every child ever
  spawned is a permanent flat row (`ThreadService.ts:1240-1263`); "nesting" is
  a left margin only (`ThreadList.tsx:126`, `201-215`), while the spec
  promises "Child Threads are visibly nested under their parent"
  (`docs/spec/agent-thread-rendering.md:14-16`). No run-status indicator
  (`thread.status`/`activeFlags` unread in `ThreadList.tsx`), no filter, no
  bulk cleanup; isolated-Skill children (`skill_<slug>_<hex>`,
  `ThreadService.ts:2264-2269`) are listed but unreachable from the transcript
  (no `subAgentActivity` for `source !== 'collaboration'`,
  `ThreadService.ts:2203-2211`).
- **S13 — The child link is 3 clicks deep post-run.** The process block folds
  under "Worked for …" (`ThreadView.tsx:1471-1478`), then the group, then the
  spawn row (`ThreadItemView.tsx:238`, `594`).

### Control (PR 3)

- **S14 — The user cannot stop a running child.** Child views have no
  composer and no Stop (`ThreadDock.tsx:294`, `ThreadView.tsx:883`,
  `949-961`); parent Stop does not cascade (`interruptTurn` aborts only the
  addressed Thread, `ThreadService.ts:1996-2002`);
  `collaboration.interrupt_agent` is model-only (`ToolRuntime.ts:243-250`).
  The only user-reachable stop is deleting the Thread — which destroys the
  subtree (`ThreadService.ts:1617-1647`).
- **S15 — No aggregate "what are my agents doing" surface.** The program docs
  describe a task panel as the intended background-visibility surface
  (`docs/plans/agent-program.md:75-76`,
  `docs/plans/agent-conversation-model.md:636-643`); nothing exists in `src/`.

## Design

### PR 1 — status truth in the parent transcript

**One presentation row per child, driven by live state.** The canonical
Items stay append-only; the renderer builds a per-Turn *presentation
projection* over them (same pattern as the existing Turn process projection,
`docs/spec/agent-thread-rendering.md:76-88`):

- All `subAgentActivity` Items for the same `agentThreadId` within a Turn
  collapse into one row; the rendered status is the latest kind
  (`started` superseded by `completed`/`interrupted`/`errored`). The row keeps
  its position at the first activity's canonical slot. No duplicate
  Running-then-Completed pairs (S1).
- While no terminal activity Item exists, the row's status is read from the
  live Thread catalog in `threadStore` — child `thread/started` /
  `turn/completed` notifications already reach the renderer and update catalog
  metadata (`threadStore.ts:400-406`). This makes child completion visible the
  moment it happens, independent of the parent-side flush timing (S3), and
  adds a live elapsed time for running children (S4). Canonical history is
  untouched; on reload the terminal Items are authoritative.
- Spawn/wait tool rows stop rendering the stale `agentsStates` snapshot as if
  it were current: per-child lines derive from the same live projection, and
  the persisted snapshot remains visible only inside the expanded raw
  argument/result JSON (S2, S8). The "Working with N agents" count derives
  from distinct child Thread IDs in the projection, not from receiver arrays
  or item ids (S8).
- **Protocol addition (coordinated, pre-release no-migration):**
  `collabAgentToolCall.agentsStates` values widen from bare status to
  `{ status, taskPath, nickname, role }` — data the service already has at
  completion (`ThreadService.ts:318-327`) — so rows show `/root/research`
  instead of a truncated UUID after the child Thread is deleted (S6).
  `subAgentActivity` already carries `agentPath` (`protocol.ts:929-934`).
- Failure presentation reuses the tool-row status vocabulary from
  `agent-run-presentation-consistency.md` PR A: `errored` tints the row's
  icon + label with `--status-danger`; `interrupted` uses the muted
  treatment; the terminal row exposes the child's bounded error summary when
  the outcome carries one (`CollaborationTerminalOutcome.error`,
  `ThreadService.ts:329-335`) instead of leaving it inside raw JSON (S5).
- Copy: collaboration rows read as product language — "Started subagent
  research", "Waited for 3 subagents", "Subagent research failed" — via typed
  i18n keys (en + zh-Hans), replacing "Using spawn_agent" (S7). An
  idle-but-alive child renders "Idle", distinct from "Completed" (S8; the
  model-facing `wait_agent` payload is unchanged).
- `waitingOnUserInput` renders on the child row as a paused "Waiting for
  input" state (S9) — visibility only; answering still happens through the
  parent's flow by steering the parent.

### PR 2 — navigation and Thread-list hygiene

- **Back to parent.** When the selected Thread has a `parentThreadId`, the
  dock header shows a back affordance labeled with the parent's name
  (the `BackIcon` pattern already exists for Automations,
  `ThreadDock.tsx:245-255`); activating it selects the parent. Breadcrumb
  depth beyond one level collapses to the immediate parent (S10).
- **Resilient links.** Transcript child links route through `openThreadById`
  (catalog-recovering, `threadStore.ts:120-127`); a genuinely deleted Thread
  produces the existing transient feedback affordance instead of a silent
  throw (S11).
- **List hygiene (S12, S13).** The Thread list groups children directly under
  their parent row (true adjacency, not margin-only), collapsed by default
  behind a per-parent count chip ("3 subagents"); running children show a
  neutral in-progress indicator dot derived from catalog status, and
  `waitingOnUserInput` shows an attention badge. A list-level filter hides
  terminal subagent rows by default (toggle to show). Isolated-Skill children
  stay behind that filter and additionally become reachable from their
  invoking `skill` tool row via a child-Thread link (the same supplemental
  affordance collaboration rows have,
  `docs/spec/agent-thread-rendering.md:54-66`). Bulk cleanup ("Delete
  finished subagents" on the parent's row menu) cascades through the existing
  delete path (`ThreadService.ts:1617-1647`).
- Spec: `docs/spec/agent-thread-rendering.md:14-16` (nesting) and the Thread
  list section are updated in the same change.

### PR 3 — live delegation card + user interrupt

Pending the open questions below; the intended shape:

- **One live delegation card per Turn** in the parent process block while at
  least one child spawned by that Turn is alive: one line per child —
  readable name, live status, elapsed time, terminal glyph on completion —
  replacing the individual projection rows from PR 1 (which remain the
  fallback and the post-hoc rendering). Time/status only; no token numbers
  (Delegation Contract §3).
- **User interrupt.** Each running child line, and the child Thread view
  header, exposes Stop. It calls the existing `interruptTurn` seam over a new
  renderer→main request (`thread/interrupt` already exists for the composer
  path; this exposes it for descendant Threads with the same authorization:
  the target must be a descendant of a user-owned root). Per the user bright
  line, a human-triggered interrupt is never budget- or state-gated: it
  aborts the active child Turn and leaves the Thread for follow-up
  (`ThreadService.ts:1996-2002` semantics unchanged) (S14).
- Whether parent Stop cascades to the subtree is open question Q2.

## Open questions (for PM/main ratification)

- **Q1 — Delegation card scope (S15).** Is the per-Turn in-transcript card
  enough, or should a dock-level "agents" panel (the task-panel concept from
  `agent-program.md`) aggregate across Turns and Threads? Recommendation:
  ship the per-Turn card first; it needs no new surface and covers the common
  case.
- **Q2 — Should parent Stop cascade?** Options: (a) parent Stop aborts the
  parent Turn only (today), (b) also interrupts all live descendants, (c) two
  affordances (Stop / Stop all). Recommendation: (b) — a user pressing Stop
  on a delegating Turn almost always means "stop the work", and children keep
  their Threads for follow-up.
- **Q3 — Blocked-child surfacing depth.** PR 1/PR 2 make
  `waitingOnUserInput` visible (row state + list badge). Should the parent
  Turn's divider also switch to "Waiting on subagent input" while any child
  is blocked? Recommendation: yes, it is the same paused-state rule as
  `agent-run-presentation-consistency.md` PR B/P2.

## Verification

- PR 1: renderer tests for the per-child projection (dedupe, latest-state
  precedence, live catalog fallback, terminal-Item authority on reload);
  core tests for the widened `agentsStates` payload; E2E: spawn → row shows
  live Running with elapsed; child completes mid-parent-Turn → row flips
  without waiting for flush; child failure shows tinted row + error summary.
- PR 2: E2E for back-affordance round-trip (child → parent preserves parent
  scroll per the existing snapshot mechanism), grouped list rendering,
  filter behavior, skill-row child link; renderer test for `openThreadById`
  fallback feedback.
- PR 3: E2E for card lifecycle (spawn/live/terminal), user interrupt of a
  running child, and (per Q2) cascade behavior; light + dark visual
  verification for card and badges.
- All PRs: `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  focused `bun run test:e2e` scope, `bun run docs:check`; spec updated in the
  same change (A6); dev userData wipe noted in the PR body for the PR 1
  protocol change.
