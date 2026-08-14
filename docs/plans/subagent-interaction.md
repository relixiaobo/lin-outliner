# Subagent Interaction

**Shape:** (a) ONE complete feature in one PR. Agent-registry projection, all
conversation anchors, the work strip, the stacked detail view, foreground
placement, notification policy, tests, and the spec update ship together. The
build order at the end is internal sequencing, not separate releases.

## Goal

Give the fresh/background-default Subagent protocol (design:
`claude-code-subagent-parity`) a process-shaped interaction model inside the
344px agent deck (`--agent-width`), replacing the turn-anchored, wait-era
presentation that `projectSubagentsForTurn` builds today.

The old protocol made delegation an episode inside one Turn: the parent
visibly waited, children were one-shot, and rows were derived from the
delegating Turn's items (`waitingForSubagents`). The new protocol makes a
subagent a durable, resumable entity spanning many Turns — spawned in one,
steered in another, resumed in a third, each generation ending in a host
notification. A turn-anchored projection has no place to put that lifecycle;
the same child would duplicate under multiple Turns or orphan visually.

The governing principle is three surfaces, each with exactly one job:

- **The conversation is the only narrative.** Everything the user must read
  arrives as the main agent's prose. Other surfaces carry state and depth, never
  required reading.
- **The work strip is the only ambient status.** One pill in the deck header
  that does not exist when nothing runs.
- **The detail view is the only deep dive.** Full-deck stack navigation, pushed
  only by an explicit click.

Four rules bind the surfaces:

1. **Absent when idle.** Zero background work renders zero subagent UI. The
   idle deck and the everything-finished deck look identical.
2. **Results are delivered only in the conversation.** The strip never becomes
   an archive; finished rows linger briefly and fade. The conversation is the
   archive, and every lifecycle event leaves a clickable anchor there.
3. **Only terminal delivery notifies.** Running is quiet and completion remains
   narratively quiet because the conversation speaks for itself. An unfocused
   window may issue one content-free OS notification for a terminal background
   generation; there is no Agent approval or needs-input state.
4. **User stop outranks the model.** A user-stopped Agent refuses model
   resume until the user sends a message from its detail view — the composer
   placeholder states this, so the authority rule is felt, not documented.

## Non-goals

- No cross-Thread global agent manager; the strip scopes to its own root
  conversation. (Claude Code's session-level agent view maps to Tenon's Thread
  list, not to this surface.)
- No manual spawn UI; delegation stays a model behavior the user requests in
  prose.
- No live token meters anywhere in the UI — budget visibility was dropped from
  the model surface (PM-ratified with the parity plan) and the renderer already
  deliberately hides token counts on budget errors.
- No mid-flight foreground→background conversion (Claude Code's Ctrl+B). A
  foreground child shares the parent Turn's cancellation lifetime by contract.
- No pane system. Claude Desktop answers this problem with dockable tasks and
  subagent panes for an IDE audience; a 344px outliner rail wants ambient, not
  arrangeable, surfaces.
- Automation runs stay out of the strip. Their results land in destination
  Threads with read state — "something arrived" surfaces, not "someone I sent
  came back".
- The task-chip suggestion pattern (agent proposes out-of-scope work as a
  clickable chip) is noted as future material, not built here.

## Design

### Anchors in the conversation

Every lifecycle event leaves an anchor at the point where it happened; all
anchors open the same detail view.

- **Spawn chip.** At the delegation point, on its own line (never inline with
  message text): status mark (`◇` running / `✓` done / `⏹` stopped), truncating
  name, muted type, `⎇` when worktree-isolated, and a compact live meta
  (elapsed only; tool-call count in the tooltip). Hover deepens color, never
  reflows.
- **Resume chip.** A later steer/resume renders a new `↻` chip at the resume
  point, referencing the same Agent.
- **Completion divider.** The host-notification continuation is introduced by a
  thin attribution divider — `— Research complete · Details —` — whose center
  is a button
  opening the detail view. This answers "why did the agent just speak" in one
  muted line and gives completion its own anchor, so reviewing a finished
  Agent never requires scrolling back to the spawn point.
- **Stopped note.** An Agent stopped by the user renders a one-line system note
  in place of its completion narration, naming the resume path.

### Work strip

A pill in the deck header, present only while this conversation has live or
just-finished background Agents: spinner + `N running`. Clicking opens a full-
width dropdown under the header (level-1 glass with the reduced-transparency
opaque fallback — the deck is too narrow for a side-hung popover).

Rows are sorted running > stopped > just-finished. Each row contains a status
glyph, truncating name plus muted type, meta (`elapsed` / `Stopped` / `Just
finished`), and a hover-revealed stop control while running. A parent with live
descendants may append a `· N child tasks` hint to its meta — the tree itself
never flattens into the strip. Finished rows linger briefly, fade, and leave;
when the last row leaves, the pill leaves with it. Rows and chips open the same
detail view.

### Detail view: stack navigation

330px of drawer over a 344px deck is meaningless, so detail is a full-deck
pushed view (iOS-style): clicking any anchor pushes it; `‹` pops. The back
button shows the parent level's name (`‹ Back` from the conversation, the
parent Agent's label when nested), so position in the stack is always legible.

Contents: header (name, type, `⎇` worktree, status, elapsed, Stop);
generation dividers (`— Generation 2 · Continued by main —`) between runs on the
same Agent; the read-only live transcript; nested children as indented chips at
their spawn points (the same chip component, recursing the same detail view —
depth ≤ 3 bounds the stack at four levels); a worktree footer when a changed
worktree is retained (`⎇ branch · N files` with reveal-in-Finder and view-diff
actions); and a composer.

The composer is the physical form of user authority: a message here is the
top-priority instruction, and on a user-stopped Agent its placeholder reads
`Message this Agent... (resumes after your stop)`. Sending creates a user-owned
child Turn, so it is the only detail action that clears user-stop provenance.

### Foreground placement

Foreground and background use the same components; the entire distinction is
placement:

- A foreground child's chip renders inside the main agent's working indicator
  (the semantic working-state line), with an explicit waiting note — visually
  part of "the main agent is working", because stopping the main Turn stops the
  child with it. It never enters the work strip: foreground is not background
  work.
- Completion continues in place — no attribution divider, because the main
  agent never left.
- Foreground `explore`/`plan` one-shots expose no model address, but the
  Agent execution record persists, so the chip keeps opening the same detail
  after completion. The model cannot target that invocation with
  `agent_message`; the user may still continue it from the detail composer,
  which addresses the internal Agent identity and starts a new generation.
  UI identity therefore outlives model addressability.

### Authority and OS notifications

Tenon remains Full Access plus explicit capability blocks. This feature adds no
permission mode, approval card, pause/resume authorization state, or needs-input
badge. Agent traffic shown in the conversation remains non-user content and
cannot answer a user question, approve a plan, expand capabilities, or clear a
user stop. Only a deliberate message from the detail composer creates new user
authority for that child.

OS notifications follow the Claude Desktop precedent, made strict: fire once for
a terminal background generation only while the window is unfocused, with fixed
content-free copy. Running, steering, and foreground settlement never notify.

### Projection and implementation surface

Presentation re-derives lifecycle from the canonical Agent execution record
(stable Agent ID, generation, status, stop provenance, notification state, and
worktree metadata), never from an in-progress wait Item or a model-maintained
roster. Canonical Turn Items still locate spawn, steer/resume, foreground, stop,
and notification anchors in the narrative. `projectSubagentsForTurn` and the
collaboration-era vocabulary it projects (`SubagentDelegationForm`'s
`'collaboration' | 'isolatedSkill'`, the `collabAgentToolCall` `agentsStates`
merge; the `waitingForSubagents` inference an earlier draft named was already
removed with the parity implementation) are replaced by an Agent registry keyed
by Agent ID plus generation; chips are per-Turn references onto that registry.
This makes cross-Turn resume render as one Agent rather than duplicate or
orphaned rows.

**Registry inputs must first cross the seam.** The canonical record this
projection consumes — `SubagentExecutionRecord`: stable Agent ID, `generation`,
run mode, terminal status, `SubagentStopProvenance`,
`SubagentNotificationState`, worktree metadata — shipped with the parity
implementation in `persistence/SubagentExecutionLedger.ts` and is main-side
only today: nothing in `src/core` or the renderer names it, and the renderer
sees execution state only through Turn items. The registry therefore needs a
main→renderer execution projection (records on Thread load plus per-change
updates). That is a protocol-surface addition (`src/core/types.ts` — an A4
coordinated change); land it as the PR's first commit so the rest of the build
consumes a settled shape.

**Identity-stable output is part of the registry's contract** (absorbed
2026-08-14 from the `agent-streaming-followups` restructure — that plan
memoizes `ThreadItemView` and bridges output-identity reuse onto the projection
this one replaces; the registry inherits the contract and retires the bridge).
A registry recomputation reuses the previous entry object for every agent whose
projected fields did not change, so a streaming delta that does not touch a
child re-projects nothing and memoized rows keep their props by identity. The
inputs that legitimately invalidate beyond a single agent are
collection-scoped and are modeled as such, never per-row: eligible-membership
changes (a newly admitted child can arrive through catalog/Turn notifications
before any parent Item changes), the parent Turn's own presentation fields
(settlement changes rows with no child change), and the display-name collision
set (a child's join, rename, or removal renumbers same-named siblings — apply
ordinals compare-and-reuse so unaffected siblings keep their objects).

**Elapsed ticking is leaf state** (absorbed 2026-08-14, same restructure).
Today `SubagentActivityItem` and `SubagentStateItem` own `useSubagentElapsedMs`
above the subtree that renders `SubagentRunDetail`, so an expanded child
transcript re-renders every second even when nothing streamed. In the
redesigned components the 1 Hz tick lives in the leaf header/chip component
that displays the elapsed value — including the row's `aria-label` and `title`,
so assistive text stays fresh — and no ticking state sits above a transcript
subtree.

| Layer | Surface |
| --- | --- |
| Projection | `subagentPresentation.ts` rework: Agent registry keyed by Agent ID + generation; per-Turn anchor references |
| Components | work-strip pill + dropdown (new); `SubagentRunDetail` evolves into the stacked detail view; chip/divider/stopped-note anchors in `ThreadItemView` |
| Vocabulary | consumes `semantic-working-state`'s Working / terminal presentation states |
| i18n | typed strings for all new copy |
| Tests | `subagentPresentation.test.ts` (registry projection, anchor references, strip sorting/fading), renderer item tests for chips/dividers/stopped notes, `agent-thread.spec.ts` e2e for the stack navigation and strip lifecycle |
| Docs | fold into `agent-thread-rendering.md` in the same PR |

Design-system compliance: chips, rows, and dividers use the neutral `--fill-*` /
`--text-*` ladders; terminal status color carries status meaning only; glass
appears solely on the strip dropdown (overlay chrome) with the opaque fallback,
while the pushed detail view is opaque content; hover deepens color without
reflow; working liveness uses the semantic working-state shimmer, not color;
radii and z-tiers come from the token ladders.

### Dependencies and sequencing

Builds strictly on the shipped `claude-code-subagent-parity` implementation
(Agent identity, generations, stop provenance, notification generation) and on
`semantic-working-state`'s vocabulary — both must land first (A7). The parity
PR's renderer scope is the minimal re-wiring that keeps current presentation
correct; this plan is the interaction redesign on top. Living with the shipped
mechanics for a few days before building this is intentional.

The slimmed `agent-streaming-followups` PR (metadata-record cache, incremental
streaming lex, `memo(ThreadItemView)` with projection output-identity reuse)
lands before this one: it supplies the item memoization this plan's
identity-stable registry contract feeds, and its projection-output bridge is
what the registry retires.

## Verification

- `bun run typecheck`, `bun run test:renderer`, `bun run test:e2e`.
- Guard tests stay green without widening exceptions (B11).
- Visual verification in light and dark themes at the gate, including
  reduced-transparency and reduced-motion passes over the strip dropdown and
  detail transition.
- Manual pass of the ratified walkthrough: delegate → parallel work → completion
  fade-out → resume → nested push/pop → foreground wait →
  user-stop and user-resume.
- Renderer counter tests for the absorbed performance contract: a streaming
  delta that does not touch a child leaves every registry entry
  identity-stable (and memoized rows unrendered); the elapsed tick re-renders
  a row header, never the transcript fixture.
- **A9 manual:** expanded child transcript during a long parent stream —
  renderer CPU before/after, recorded in the PR body (the half of the
  `agent-streaming-followups` measurement that moved here with the ticker).

## Open Questions

None. Agent steering inside strip rows was considered and explicitly deferred:
the detail composer remains the one place for direct user instruction in v1.

## Build Order

- [ ] Agent-registry projection + anchor reference model replacing
  `projectSubagentsForTurn`; unit tests.
- [ ] Conversation anchors: chips (spawn/resume/foreground), completion
  dividers, and stopped notes.
- [ ] Work strip pill + dropdown with sorting, fading, and stop.
- [ ] Stacked detail view: generations, nested recursion, composer authority,
  worktree footer; e2e + visual verification + spec fold.
