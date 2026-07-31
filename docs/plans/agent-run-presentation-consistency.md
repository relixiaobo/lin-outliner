# Agent Run Presentation Consistency

## Goal

Make every run-state presentation truthful and design-system-conformant:

1. A failed or interrupted tool row keeps the tool's own identity and signals
   status by color, not by a substituted mystery glyph (PM-ratified direction,
   2026-07-30).
2. Process labels, timers, and dividers never lie about what the run is doing
   (no "Working" on finished turns, no spinner while blocked on the user, no
   duplicated terminal labels, no flash states).
3. The transient Plan progress becomes a centered pill that always shows the
   current step's text with a visible current-step highlight (PM-ratified
   direction, 2026-07-30), and the `update_plan` leak into Turn Diagnostics is
   closed.

All `file:line` references are against `main` at `7bd60a04`.

## Non-goals

- No change to the transient-Plan architecture from
  `docs/plans/archive/agent-execution-interaction-consistency.md` (#438): the
  Plan stays a `turn/plan/updated` transient snapshot, never an Item, and is
  still discarded at terminal state / reload. Post-hoc plan review is out of
  scope.
- No change to the commentary/final-response phase model. The
  streaming-text-relocation problem (an assistant paragraph jumping into the
  process timeline when a tool call starts —
  `PiTurnExecutor.ts:1248-1260`, `ThreadView.tsx:1629-1669`) is real but
  structural; it needs its own plan and is explicitly excluded here.
- No new status colors or tokens beyond the existing `--status-*` set.
- No scroll/follow changes (owned by `agent-thread-scroll-follow.md`).

## Shape

Shape **(b): a set of three independent complete features, each its own PR**,
ordered only by convenience:

- **PR A — tool-row status visuals** (failed / interrupted / group rows).
- **PR B — process-state truthfulness** (labels, timers, flash states).
- **PR C — plan progress pill** (centered pill + current step + leak fix).

Each is shippable and verifiable alone; they share files
(`ThreadItemView.tsx`, `ThreadView.tsx`, `thread.css`, i18n messages) but not
mechanisms.

## Collision Result

- `gh pr list` (2026-07-30): #453 (`codex-4/tool-path-modifier-click`, Draft)
  claims tool-path rendering in `ThreadItemView.tsx` — PR A overlaps that file;
  coordinate landing order (whichever lands first, the other rebases; no
  contract conflict). #450/#451/#452 do not overlap this renderer surface.
- No infrastructure-ownership files are touched. i18n message additions go in
  `src/core/i18n/messages/en.ts` + `zh-Hans.ts` (not protocol files).

## Current defects (evidence)

### Tool rows (PR A)

- **T1 — Mystery icon by construction.** On failure the tool's own glyph is
  discarded and replaced by `CircleX` (`executionStatusNode`,
  `ThreadItemView.tsx:1135-1140`; `ToolErrorIcon` = `CircleX`,
  `src/renderer/ui/icons.ts:26`), rendered at 9px inside a 14px red pill
  (`thread.css:1251-1265`). The row loses tool identity exactly when the user
  needs to know which tool broke.
- **T2 — The row text is not tinted.** `.thread-tool` label stays `--text-soft`
  and brightens to `--text-strong` on hover in failed state too
  (`thread.css:1148-1153`, `1173-1180`); no selector tints
  `.thread-tool-label` for `thread-tool-failed`.
- **T3 — The failure mark vanishes on interaction.** Hover, focus, and
  expansion swap the status glyph for the chevron
  (`thread.css:1223-1241`), so an expanded failed row carries no failure mark
  at all.
- **T4 — The status fill contradicts the design system.**
  `docs/spec/design-system/patterns.md:23`: the status colour rides on the
  label; fills are reserved for destructive commands. The failed pill uses a
  15% `--status-danger` background + 40% border and overrides the shared slot
  geometry (`thread.css:1252-1258` vs `1204-1211`), against the one-slot rule
  (`patterns.md:46-47`).
- **T5 — `interrupted` is unstyled and mislabeled.** No
  `.thread-tool-interrupted` CSS rule exists anywhere in
  `src/renderer/styles/`; `summarizeThreadToolItem` has no interrupted branch,
  so an aborted tool reads as past-tense success ("Ran …")
  (`ThreadItemView.tsx:857-889`).
- **T6 — Group rows encode failure by color alone.** `groupStatus` computes
  `failed` (`ThreadItemView.tsx:932-937`) but `toolActivityPhrase`
  (`:1043-1070`) has no failed/interrupted wording — violating
  `patterns.md:186-187` (never encode state by color alone).
- **T7 — Completed/failed sub-rows spin inside a running group.** The
  descendant selector `.thread-tool-inProgress .thread-disclosure-status svg`
  (`thread.css:1361-1363`) animates finished children's glyphs.
- **T8 — No accessible name, no tooltip.** The status glyph has no
  `title`/`aria-label` (`ThreadItemView.tsx:1137`, `664-671`); the truncating
  label has no `title` (`thread.css:1182-1189`, `ThreadItemView.tsx:617`); the
  expanded error paragraph has no `role` (`ThreadItemView.tsx:642`) while the
  turn banner uses `role="alert"` (`ThreadView.tsx:1176`).
- **T9 — Error text is missing or fabricated for some tools.** `fileChange`
  and `collabAgentToolCall` surface no error message
  (`ThreadItemView.tsx:740-755`, `790-823`); `dynamicToolCall` degrades to the
  bare word "Failed" (`:780`, `en.ts:1191`); command failures synthesize
  "exit code 1" even for timeouts/kills (`PiTurnExecutor.ts:954`).

### Process states (PR B)

- **P1 — "Working" on a completed turn.** The process-summary fallback
  returns `t.agent.thread.working` for a non-`inProgress` turn
  (`ThreadView.tsx:1559-1571`, worst case `:1571`).
- **P2 — Blocked-on-user looks like hard work.** `waitingOnUserInput` is set
  by the service (`ThreadService.ts:2040`) and has an i18n label
  (`en.ts:1132`), but nothing in `src/renderer` reads the flag — the divider
  keeps spinning "Working for 4m" while the run waits on the user.
- **P3 — A running tool's spinner disappears on hover/expand.**
  `.thread-disclosure-status { opacity: 0 }` on hover/focus/expanded
  (`thread.css:1223-1231`) hides the only in-progress indicator
  (`ThreadItemView.tsx:616`, `664-671`).
- **P4 — "Turn interrupted" prints twice.** With no response item, both the
  divider (`ThreadView.tsx:1554`) and the synthetic response tail
  (`:1137-1144` → `:1181-1186`) print the same sentence a line apart
  (`terminalResponseOwnsStatus`, `:1475-1476`).
- **P5 — Headerless orphan timeline.** A failed/interrupted turn with a
  response suppresses the divider and rule but keeps the timeline
  (`ThreadView.tsx:1478`, `1481`, `1503`) — an unlabeled list of rows.
- **P6 — Live and final durations disagree.** The live label uses the
  renderer clock with `Math.round` (`ThreadView.tsx:1528-1552`, `1587`); the
  final label uses server `turn.durationMs` (`:1556`) — "Working for 4s" can
  be followed by "Worked for 3s".
- **P7 — ~~`/compact` and `/clear` flash a bogus working block~~ — already
  fixed, dropped from PR B.** Re-validated on `main` at `a27fb99b`:
  `isStandaloneContextBoundaryTurn` no longer requires terminal status, it
  checks item count, trigger kind, and item type only. Nothing to do.
- **P8 — Present-tense group counts over historical work.**
  `summarizeThreadToolActivity` ORs `running` across the bucket but reports
  the whole subject count — "Reading 6 files" when 5 finished
  (`ThreadItemView.tsx:990-994`, `:1037`, `:1054`).
- **P9 — Mid-run reasoning snaps shut and shifts layout.** The reasoning
  disclosure auto-collapses the instant any newer item is appended
  (`ThreadItemView.tsx:544`, `ThreadView.tsx:1103`) and when
  `isSoloResultlessReasoning` flips (`ThreadView.tsx:1090`, `1671-1688`); the
  empty-reasoning placeholder also lacks the `thread-item` class so the first
  token changes the element's class set (`ThreadItemView.tsx:543` vs `:547`).
- **P10 — The reconnect spinner ignores reduced motion and can go stale.**
  `.thread-provider-retry svg` (`thread.css:939-942`) is missing from the
  reduced-motion reset (`thread.css:2550-2564`); the retry status is not
  cleared by `turn/started` or `reloadThreads`
  (`threadStore.ts:104-110`, `419-420`, `434-436`, `458-460`).
- **P11 — A completed turn marks its still-open items `failed`**, showing a red
  mark on successful work. Re-validated: the site moved during #451's
  ThreadService decomposition and is now
  `TurnLifecycle.ts:882` — `finishOpenItems(status === 'completed' ? 'failed' :
  status)`. An item the turn finished without closing was cut off, not errored.

### Plan progress (PR C)

- **L1 — The current step's text is never visible without hover.** The
  persistent affordance is only `Step {n} / {total}`
  (`ThreadView.tsx:1320`, `en.ts:1161`); the checklist hides behind
  `visibility: hidden` until hover/open (`thread.css:1814-1840`).
- **L2 — No current-step highlight.** `is-in_progress` styling is only the
  spinning icon (`thread.css:1809-1812`); under reduced motion even that stops
  (`thread.css:2550-2563`); no text rule exists.
- **L3 — Misleading counter.** With nothing `in_progress` the counter falls
  back to the first `pending` index (`ThreadView.tsx:1291-1292`); all-done
  shows `Step N / N` distinguishable only by a check icon (`:1293`,
  `1317-1320`).
- **L4 — ~~`update_plan` leaks into Turn Diagnostics~~ — dropped from PR C.**
  Implemented and then reverted: the PM ruled on 2026-07-31 that the session
  must show the complete, actual process, which is the opposite of hiding a
  real execution. Making the Plan visible in the transcript is its own unit
  (`docs/plans/agent-plan-visibility.md`); Turn Diagnostics keeps its rows in
  the meantime.
- **L5 — Focus is stolen and the popover cannot pin.** Activating the summary
  focuses the popover region and only Escape/blur exits
  (`ThreadView.tsx:1297-1313`, `1326-1334`); open state is ephemeral local
  state (`:1287`).
- **L6 — Subagent/automation threads never show their plan.** The chip mounts
  only inside the `composerEnabled` branch (`ThreadView.tsx:883-884`;
  `ThreadDock.tsx:294`), while `update_plan` is `anyThread`-scoped
  (`src/core/agent/tools.ts:423`).
- **L7 — Status is invisible to assistive tech.** Step icons are
  `aria-hidden` with no text alternative (`ThreadView.tsx:1340`); only the
  summary string is live (`:1304`).
- **L8 — Chrome-scale typography and a dead i18n key.** Steps render at
  `--font-ui-sm` on popover glass (`thread.css:1861-1868`) vs `--font-content`
  transcript text; `item.plan` ('Plan') exists in both locales with no
  consumer (`en.ts:1169`, `zh-Hans.ts:1103`).

## Design

### PR A — tool-row status visuals

- `executionStatusNode` (`ThreadItemView.tsx:1135-1140`): `failed` and
  `interrupted` return the tool's own glyph (the `completed` node);
  `inProgress` keeps `LoaderIcon`. Status is carried by color and label, not
  by glyph substitution.
- `thread.css`: delete the failed pill block (`:1251-1265`). Add color-only
  rules: `.thread-tool-failed` tints both the status slot and
  `.thread-tool-label` with `var(--status-danger)`, including an explicit
  hover rule so the generic `--text-strong` hover (`:1173-1180`) does not
  strip the tint. Add `.thread-tool-interrupted` with a muted treatment
  (`--text-faint` glyph + label, explicit and intentional). The shared slot
  geometry (`:1204-1211`) is no longer overridden (T4, patterns.md one-slot
  rule).
- The hover/expand chevron swap (`:1223-1241`) is retained — the persistent
  label tint now carries the state through interaction (fixes T3 without a
  second mechanism). For `inProgress` rows the spinner is excluded from the
  hover/expanded hide so a running tool never looks idle (P3 lands here since
  it is the same selector block).
- Labels: add interrupted branches to `summarizeThreadToolItem` /
  `namedToolSummary` ("… interrupted"), and failed/interrupted wording to
  `toolActivityPhrase` + `summarizeThreadToolActivity` ("Ran 3 commands · 1
  failed"), with keys in `en.ts` + `zh-Hans.ts` (T5, T6).
- Scope the spin animation to the row's own status
  (`.thread-tool-inProgress > … .thread-disclosure-status svg` or an explicit
  per-row class) so finished children of a running group do not rotate (T7).
- Accessibility: status glyph gets a visually-hidden text/`aria-label`
  ("failed", "interrupted"); the truncating label gets `title`; the expanded
  `.thread-inline-error` gets `role="status"` (T8).
- Error text floors (T9): `fileChange` and `collabAgentToolCall` failures
  render the generic failure sentence when no message exists;
  `dynamicToolCall` failure prose renders under the error treatment instead of
  a neutral "Result"; command failures with a synthesized exit code render
  "Command failed" without inventing "exit code 1"
  (`PiTurnExecutor.ts:954` stops forcing `1`; protocol field stays
  `number | null`).
- Contrast gate: `--status-danger` (#e5484d) has no dark-mode override and is
  recorded as borderline on dark ink
  (`docs/plans/dark-mode-contrast-pass.md:104`); PR A verifies label-size
  contrast in both themes and, if needed, introduces a dark-theme value for
  `--status-danger` in the token layer rather than a local hex (B1/B11).

### PR B — process-state truthfulness

- **P1:** the completed-turn fallback label becomes past-tense ("Worked");
  the literal `working` string is reserved for `inProgress`.
- **P2:** the renderer reads the thread's `waitingOnUserInput` active flag
  (`protocol.ts:48`) and, while set, the divider shows the existing
  `waitingOnUserInput` label with the spinner paused and the timer frozen; the
  flag clearing resumes the live label. (Display-only; no protocol change.)
- **P4:** when a turn is terminal and there is no final response, the divider
  owns the terminal label and the synthetic response tail renders actions only
  (no second "Turn interrupted"), keeping exactly one status owner per turn —
  the inverse of today's `terminalResponseOwnsStatus` for the no-response
  case.
- **P5:** when `terminalResponseOwnsStatus` suppresses the divider, the
  timeline keeps a neutral, non-status header ("Worked for …" when duration is
  known, else the activity phrase) so no orphan unlabeled list renders.
- **P6:** live elapsed and final duration both use `Math.floor` over the same
  origin (`startedAt`), and the interval tick aligns its phase to `startedAt`
  so seconds do not skip; accept a ≤1s live/final delta and clamp the final
  label to never read lower than the last live value shown.
- **P8:** group phrases split the running subset: "Read 5 files · reading 1"
  (new i18n keys), with counts derived per-status instead of OR-ing `running`
  across the bucket.
- **P9:** live reasoning stays open while its item is `inProgress` regardless
  of newer items; `defaultReasoningExpanded` is latched at first render of the
  turn's terminal state instead of flipping mid-run; the empty placeholder
  gets the same `thread-item` class as the populated branch.
- **P10:** add `.thread-provider-retry svg` to the reduced-motion reset;
  clear `providerRetryByThread` on `turn/started` and in `reloadThreads`.
- **P11:** `finishOpenItems` marks still-open items on a **completed** turn
  `interrupted` rather than `failed` (`TurnLifecycle.ts:882`) — they were cut
  off, they did not error; with PR A's muted interrupted treatment this stops
  painting red on successful turns. A failed or interrupted turn keeps its own
  status, unchanged.

**Re-validation note (2026-07-31).** The `file:line` references above were taken
against `main` at `7bd60a04`; PR B was built against `a27fb99b`, after #458
rewrote much of `ThreadView.tsx`. Every item was re-checked before implementation:
P3 shipped with PR A, P7 was already fixed independently, P11 moved to
`TurnLifecycle`, and P1/P2/P4/P5/P6/P8/P9/P10 were confirmed still live.

### PR C — plan progress pill

PM-ratified presentation (2026-07-30): a compact pill, horizontally centered
above the composer, always carrying the current step's text.

- Summary content: `{n}/{total} · {current step text}` with the step text
  ellipsized to one line; when every step is completed the pill reads a
  localized "Done" wording with the check icon (no more bare `Step N / N`,
  L3). The `current` derivation prefers `in_progress`, then first `pending`;
  an all-completed snapshot renders the done state.
- Presentation: `--radius-pill`, existing popover material and neutral chrome
  (B3/B5), centered via the composer-region layout; the pill never reflows the
  composer (fixed single-line height). Typography moves to the transcript
  content scale for the step text where it fits the pill (L8); the dead
  `item.plan` i18n key is deleted.
- Popover: unchanged mechanics (hover preview, click to open, Escape to
  close) plus: the current step row gets a visible highlight — `--text-strong`
  + weight, not color-only, so reduced-motion and colorblind users keep the
  cue (L2, patterns.md:186-187); completed rows keep the existing dim.
  Activating the summary still moves focus into the checklist
  (spec `:457-459` retained), but closing by any path (Escape, blur, outside
  click) restores focus to the composer per the terminal model (L5).
- Accessibility: each step row carries visually-hidden status text
  ("current", "completed", "pending"); the summary's `aria-live` announcement
  includes the current step text, not just the counter (L7).
- Non-composer threads (L6): the pill renders read-only above the transcript
  footer for child/automation threads (outside the `composerEnabled` gate), so
  a watched subagent shows its own progress. No composer, no focus handoff.
- Spec: update the `turn/plan/updated` presentation paragraph
  (`docs/spec/agent-thread-rendering.md:454-462`) in the same PR.

## Verification

- PR A: renderer unit tests for `executionStatusNode` glyph retention and
  label branches; guard-test additions for the new status classes; light +
  dark visual verification of failed/interrupted/running rows and groups
  (B11 — fix CSS, don't widen guards); contrast check for `--status-danger`
  label text in both themes.
- PR B: renderer tests for divider label selection (completed fallback,
  waiting flag, single status owner); E2E for `/compact`-`/clear` no-flash and
  interrupted single-label; reduced-motion audit of every spinner selector.
- PR C: renderer tests for pill content derivation (in_progress / pending /
  done), focus restoration, and the Turn Details filter; E2E for pill
  visibility on child threads; light + dark visual verification.
- All PRs: `bun run typecheck`, `bun run test:renderer`, focused
  `bun run test:e2e` scope, `bun run docs:check`, spec updated in the same
  change (A6).

## Open questions

None. The tool-row tint direction and the centered current-step pill were
ratified by the PM on 2026-07-30; everything else corrects implementation
against already-specified behavior.
