# Subagent UX Unification

One delegated unit of work is one visual entity with one position and one
human-readable name, for its whole lifecycle; viewing it is a detail overlay,
not a navigation destination. This plan removes the four ways the current
presentation splits that entity apart (duplicate rows, the top-pinned card, the
machine name, the full-view navigation swap) and replaces them with in-place
live rows plus a bottom drawer.

Ratified by the PM on 2026-08-07 from the UX walkthrough. Two earlier rulings
are deliberately revised (recorded per PR below): the Q1 "delegation card
replaces rows" shape (2026-07-30) and PR 2's breadcrumb navigation into child
Threads (`docs/plans/archive/agent-subagent-interaction.md`). The rest of that
plan's rulings stand unchanged: no dock-level agents panel, composer-less
children, interrupt-only user control, Stop-closes-the-request (Q2), no token
quantities on any delegation surface (Delegation Contract §3).

## Goal

From the user's perspective, after this plan:

1. **One delegation = one row.** A delegated child appears exactly once in the
   parent timeline, at the canonical position of the tool call that spawned it.
   Live: form icon + name + `Running · 16s` + spinner + Stop. Settled: the same
   row, same place, terminal glyph + `Completed · 3m 12s` (or danger-tinted
   failure copy). No separate skill tool row, no top-pinned card, no layout
   jump at completion; the post-hoc rendering IS the settled live row.
2. **Names are human.** An isolated-Skill child reads as its skill name
   ("research"), never `skill_research_e91f690effe5` — in rows, drawer title,
   Thread Details, tooltips, and accessible labels.
3. **Viewing a child is a drawer, not a place.** Clicking a delegation row (or
   a Thread Details subagent row) slides a drawer up over the dock; a scrimmed
   band of the parent stays visible at the top. Esc / scrim / close dismisses
   it back to an untouched parent view. Child Threads are never a dock
   navigation destination, completing the PR 2 ruling that they are not
   conversations.
4. **The child's transcript says whose words are whose.** Parent-authored task
   messages render as a neutral, left-aligned task presentation labeled as
   coming from the parent — not as user bubbles. A static footer note explains
   the missing composer.

## Non-goals

- No change to collaboration tool contracts, budget semantics, Stop/request
  semantics (Q2), or the transcript artifact.
- No child composer (R1 ruling stands); no lifting of interrupt-only control.
- No token quantities on any delegation surface, including title/aria (§3).
- No change to `taskPath` addressing: `skill_<slug>_<hex>` stays the
  session-unique host address; this plan changes only what the user reads.
- No Thread-list changes (children already left the list) and no dock-level
  agents panel.
- `collaboration.wait_agent` tool rows stay in the timeline (the parent's own
  synchronization act; the "Waiting on N subagents" divider already carries
  the aggregate). Revisit only if it reads as noise after this ships.

## Shape

Shape **(b): three independent complete features, each its own PR**, ordered by
priority. B and C do not depend on each other; both read better after A.

- **PR A — human identity for isolated-Skill children.**
- **PR B — one delegation, one row** (card removed, rows upgrade in place).
- **PR C — the subagent drawer** (replaces child navigation).

## Collision result

Checked 2026-08-07: `gh pr list` shows only #497 (`main-agent/launcher-hardening`)
— launcher/sidebar/settings scope, no overlap. The board shows cc-2 building
`agent-model-first-picker` (no Draft PR yet); its likely surface is the composer
config region of `ThreadView.tsx`, adjacent to but disjoint from the process
block and dock header this plan touches — coordinate at rebase time, not by
serializing. `agent-subagent-interaction` and `agent-run-presentation-consistency`
are complete/archived; no open claim touches the subagent presentation region.

## Design

### PR A — human identity for isolated-Skill children

The machine tail leaks today because `spawnIsolatedSkillThread`
(`SubagentCollaboration.ts`) names the child Thread after the taskPath's last
segment (`skill_<slug>_<hex>`), and `subagentDisplayName`
(`subagentPresentation.ts`) prefers the taskPath tail over everything else.

- **Spawn records the human name.** The isolated-Skill spawn sets the child
  Thread's `name` (and its nickname field) to the skill's name; the generated
  `skill_<slug>_<hex>` remains only the taskPath address.
- **Display derivation prettifies the address as a last resort.** In
  `subagentDisplayName`, a taskPath tail matching
  `^skill_(.+)_[0-9a-f]{12}$` renders as the captured slug. This covers every
  fallback path — including a deleted child whose only surviving identity is
  the activity Item's `agentPath`, where `form` can no longer be resolved.
- **No machine identity in any user-facing text.** The `title`/`aria-label`
  fallbacks that currently prefer `taskPath` over the display name
  (`ThreadDelegationCard.tsx`, `ThreadItemView.tsx` subagent rows) switch to
  the display name. Thread Details subagent rows show the Thread name and are
  fixed by the spawn change alone.

Files: `src/main/agent/thread/SubagentCollaboration.ts`,
`src/renderer/agent/subagentPresentation.ts`, the two row components' label
fallbacks, core + renderer tests. Spec: the naming sentence in
`docs/spec/agent-thread-rendering.md` (subagent identity order).

### PR B — one delegation, one row

**Protocol widening (coordinated, pre-release no-migration):**
`subAgentActivity` gains `spawnItemId: string | null` — the Item id of the
tool call that delegated (the `skill` call or the collaboration spawn call).
The recorder has it at spawn (`recordSubagentActivity` receives
`parentItemId`), and the spawn edge already stores it for terminal enqueue.
Exact-key codec update in `src/core/agent/codec.ts`; wipe `~/.lin-outliner-*`
dev userData; no legacy reader.

**Projection merges cause and child.** `projectSubagentsForTurn` suppresses a
tool-call row claimed by a child's `spawnItemId` and renders the delegation row
at that suppressed row's canonical slot — the cause's position, so the row can
never appear above the reasoning that produced it. The raw tool exchange
remains in Turn Diagnostics; the delegation row is the only transcript
presentation of that delegation. Applies to both forms (the isolated `skill`
tool row and the collaboration spawn row); `wait_agent` rows are untouched
(non-goal).

**The card is deleted; rows are live in place.**

- Delete `ThreadDelegationCard`, its CSS block, the `delegationCard` copy, and
  the ThreadView filtering that stands rows down while the card is live.
- The subagent activity row becomes the single lifecycle presentation:
  form-specific icon (SkillIcon for `isolatedSkill`, AgentIcon for
  `collaboration`), name-first label `<name>`, status segment
  `Running · 16s` / `Completed · 3m 12s` from the existing `subagentStatuses`
  vocabulary, spinner while running, Stop `IconButton` on running rows
  (`onInterruptThread` threaded down to `ThreadItemView`), danger tint +
  bounded classified error copy on failure (unchanged rules). The
  "Started subagent …" event phrasing is deleted with the card.
- **Row typography joins the process ramp.** Today the subagent row is the
  only process row rendered at content scale: `button.thread-inline-activity`
  uses `font: inherit` (the transcript's content size) and `--text-secondary`,
  while every tool row uses `--font-meta`/`--line-meta` over `--text-soft`
  (`thread.css`). Post-hoc it therefore reads as a bright, body-sized line
  jammed between small muted rows. The rebuilt delegation row adopts the same
  meta ramp and soft base color as its tool-row neighbors; status tints
  (danger/muted) layer on top unchanged.
- **Hover affordance (B6):** the row's text deepens on hover/focus-visible; no
  fill box, no layout change (B7).
- **Delegation rows never fold into activity groups**, live or settled — each
  is a first-class click-into-child affordance (`groupTurnContent` exemption).
- **Stop glyph:** replace the Lucide outline `Square` mapped as `StopIcon`
  (`icons.ts`) with a filled-square stop glyph, matching the composer's stop
  affordance, everywhere StopIcon is used. An outlined square alone reads as
  an unchecked checkbox.

Spec: rewrite the delegation-card paragraphs of
`docs/spec/agent-thread-rendering.md` to the in-place live-row shape, recording
the Q1 revision (PM 2026-08-07): "no dock-level panel" stands; "card replaces
rows" is replaced by "rows upgrade in place". Files: `subagentPresentation.ts`,
`ThreadView.tsx`, `items/ThreadItemView.tsx`, `thread.css`, `icons.ts`,
protocol/codec, both locale catalogs, renderer + core tests, E2E.

### PR C — the subagent drawer

**Store seam.** `threadStore` exposes `ensureThreadHistory(threadId)` (public
wrapper over the private `loadTurns`). Histories live in the per-thread
`turnsByThread` map and live notifications already apply to any loaded history
(`applyNotification` gates on `turnsByThread.has`, not on selection), so the
parent stays selected and live behind the drawer with no store rework.

**The drawer.** A new dock-scoped overlay (`SubagentDrawer`): slides up from
the dock's bottom edge, covering content and composer; the dock header plus a
scrimmed sliver of the parent transcript stay visible above it — the "I never
left" anchor. Level-2 overlay elevation (B10); opaque content surface (B5 —
this is content, not chrome); slide respects `prefers-reduced-motion`; close
via Esc, scrim click, or the ✕ button; focus is trapped inside and restored to
the opening row on close (B8).

- **Header:** form icon + display name + live `status · elapsed` + Stop while
  running (same `interruptThread` path) + ✕. This absorbs the child-view
  breadcrumb and the dock-header child Stop, both deleted from `ThreadDock`.
- **Content:** the same `ThreadView` with `composerEnabled=false`, keyed by
  child Thread id. Scroll and disclosure anchoring are inherited from the
  component (the #469 mechanism applies unchanged).
- **Task provenance:** in a child Thread every `userMessage` is
  parent-authored (children are composer-less), so the child view renders them
  as a neutral, left-aligned task presentation labeled "Task from the parent
  conversation" (i18n en + zh-Hans) instead of the right-aligned user bubble.
- **Footer:** where the composer would be, one static line: driven by the
  parent conversation, can be stopped anytime (i18n).
- **Entry convergence:** delegation rows and Thread Details subagent rows open
  the drawer (`openSubagent(threadId)` dock state); the Details dialog closes
  first. `openThread` no longer selects child Threads; the child branch of the
  dock breadcrumb is deleted. A deleted child produces the existing transient
  feedback instead of an empty drawer; deletion while open closes the drawer
  with the same feedback.
- **Depth 2:** a delegation row inside the drawer swaps the drawer content to
  the grandchild and the header gains a back-to-child affordance; no stacked
  drawers (depth is capped at 2, so at most one level of back).

Spec: rewrite the child-view/navigation section of
`docs/spec/agent-thread-rendering.md` (breadcrumb → drawer; children are
neither list rows nor navigation destinations), recording the PR 2 navigation
revision (PM 2026-08-07). Files: `ThreadDock.tsx`, new `SubagentDrawer.tsx`,
`store/threadStore.ts`, `ThreadView.tsx` (child user-message presentation),
`ThreadDetailsDialog.tsx`, `thread.css`, both locale catalogs, renderer tests,
E2E.

### Decided locals (recorded, reversible)

- The drawer covers the parent composer; steering the parent means closing the
  drawer first (one Esc). Chosen for reading space in a narrow rail.
- Suppressed spawn rows lose their inline args/result disclosure; the child
  transcript and Turn Diagnostics carry that information.
- Multiple runs of the same skill show the same name in Thread Details;
  status + time disambiguate.

## Open questions

None. Direction ratified by the PM 2026-08-07 (this conversation); the Q1 and
PR 2 revisions above are the two deliberate ruling changes.

## Verification

- **PR A:** core test that isolated-Skill spawn records the human name;
  renderer tests for display derivation (nickname-first for `isolatedSkill`,
  slug prettification fallback, no machine tail in label/title/aria).
- **PR B:** `/code-review ultra` gate (protocol-adjacent) + dev-userData wipe
  note in the PR body. Renderer tests: spawn-row suppression by `spawnItemId`,
  canonical-slot placement, group exemption, live→settled row identity (same
  element position), Stop on running rows only, and the delegation row sharing
  the tool-row meta typography ramp. Core tests for the widened
  Item + codec. E2E: delegation row lifecycle live→terminal without the card;
  row Stop interrupts one child. Light + dark visual pass at the gate.
- **PR C:** renderer tests: `ensureThreadHistory` loads without selection
  change; drawer open/close restores focus; task-provenance presentation for
  child user messages; deleted-child feedback. E2E: open drawer from a live
  row, watch streaming, Esc restores parent scroll; open from Thread Details;
  grandchild back affordance. Light + dark visual pass at the gate.
- All PRs: `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  focused `bun run test:e2e`, `bun run docs:check`; specs updated in the same
  change (A6).
