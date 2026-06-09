---
status: in-progress
priority: P2
owner: relixiaobo
created: 2026-05-26
updated: 2026-06-09
---

# Proactive Agent — Command Nodes

## Build status (2026-06-08, PR #165, cc-2)

PM-ratified directional calls (2026-06-07):

1. **Schedule storage = command-scoped, thin-B1.** The canonical
   `<endpoint> RRULE:...` lives on the command node (`commandSchedule`), parsed by
   the shipped `dateSchedule.ts`. The broader decision **B1** (recurrence on the
   *generic* `date` FieldType, with a date-picker Repeat section) was originally
   deferred — **it has since landed in this PR** (see the field-unification
   follow-up below); the `DATE_OVERLAPS`/`OVERDUE` RRULE search-tolerance part
   remains deferred.
2. **Safety = interactive trust inheritance.** Bright line via the node-tool
   gateway + `protectedFields` + `origin`; Run-now is attended, no extra fence.
3. **v1 includes the full builder UI** (command builder panel + smart-convert).

Shipped on the branch:

- **Kernel (done, tested).** `command` NodeType shape reconciled (brief = node
  content; `commandSchedule` + system `sysLastRunAt`); `protectedFields`
  enforcement primitive; `set_command_node` / `set_command_schedule` /
  `mark_command_fired`; Loro persistence of the new fields; the anacron scheduler
  (`commandScheduler.ts` + a 60s tick alongside Dream + launch + `powerMonitor.resume`
  catch-up); `startTriggeredRun` (no-human-turn, conversation-anchored,
  `{type:'schedule'}` trigger). typecheck + `test:core` + `test:renderer` green.

- **UI (done, tested).** The `/command` slash command converts a row into a
  command node; `CommandNodeControls` renders a neutral schedule chip + inline
  date/time/repeat/ends editor (writes the canonical string through the user-only
  gateway) + a **Run now** button. `agent_run_command_now` runs the brief
  attended (`{type:'node'}` trigger, no watermark advance). en + zh-Hans strings;
  token-only CSS (B3/B4 neutral state, guard-clean). typecheck + `test:core` +
  `test:renderer` green.

- **Self-review hardening (xhigh, done).** A 9-angle self-review surfaced real
  defects, all fixed: a failed scheduled run no longer advances the watermark
  (`runCommandTurn` detects the errored run; backoff now actually engages); the
  watermark is written at completion time and is forward-only (no double-fire /
  no clobber of a user re-arm); empty briefs and inline references are handled
  (`richTextToReferenceMarkup`); command turns get the skill/subagent listings;
  Run-now coordinates with the sweep (no collision / false backoff); the sweep
  fires concurrently (no head-of-line blocking) and prunes backoff + delivery
  conversations for removed nodes; the bright line is keyed to the node-type
  invariant; the editor preserves custom recurrence + blocks end-before-start;
  the chip summary is localized; controls honor `displayed.locked`; scheduler has
  a teardown + zero-command early-out. See the corrected semantics in
  `docs/spec/commands.md`.

Follow-up (PM-ratified 2026-06-08, same PR) — execution & card redesign:

- **Runs are subagents, not main-conversation turns.** A fire (scheduled +
  Run-now) now runs the brief as a **subagent** on the command's delivery
  conversation (`runCommandSubagent` → `session.subagentRuntime.invokeAgent`,
  awaited to completion; a background-flagged agent is polled via `status({wait})`),
  so each run shows up as a task in that conversation's task panel. The watermark
  still advances only on completion; failures arm the same backoff.
- **Per-command agent.** New `commandAgent` (an `AgentDefinition.name`,
  `set_command_agent`; empty = main agent via context fork). The picker is
  populated by the existing `agent_list_all_definitions` IPC.
- **Multi-line task details.** New `commandDetails` (`set_command_details`),
  appended to the one-line brief at run time.
- **Framed task card.** `CommandNodeControls` is now a bordered task card: Task
  details textarea (commit-on-blur) → meta row (schedule chip/enable + Agent
  picker) → Run + status, with the schedule builder expanding inline. Current
  behavior documented in `docs/spec/commands.md`.

Follow-up (PM-ratified 2026-06-08, same PR) — **field-native redesign** (supersedes
the framed-card UI above; the execution layer + bright line are unchanged):

The PM chose "全字段化": a command node should look like every other node — a
command glyph instead of a bullet, its config as **inline field rows**, and its
prompt as **ordinary child nodes**. Architecture (ratified):

- **Storage stays the gated scalars.** `commandSchedule` / `commandAgent` remain
  node scalars written through the user-only `set_command_schedule` /
  `set_command_agent` gateways — the bright line keeps its node-type invariant and
  cannot fail open. The scheduler keeps reading the scalars. No execution change.
- **Surfaced as system fields backed by those scalars** (the `sys:done`-backed-by-
  `completedAt` pattern): `sys:commandSchedule` + `sys:commandAgent` resolve their
  value from the owner's scalar and render as field rows under the command node
  (auto-seeded by `set_command_node`).
- **Custom value editors, branched (not a general registry).** Shipped approach:
  `OutlinerFieldRow` branches on `systemDisplay.kind` for the two command fields
  and renders dedicated connected editors (`CommandScheduleFieldValue` +
  `CommandAgentFieldValue` in `CommandFieldValue.tsx`). Schedule → the
  date+recurrence builder (`CommandScheduleBuilderPanel`, now an inline popover)
  routing to `set_command_schedule`, with the Run-now action co-located; Agent → a
  registry picker routing to `set_command_agent`. A *general* per-field editor
  registry was deemed unnecessary for two fields and deferred (deviation below).
- **Prompt = the command node's non-field child nodes**, serialized to a nested
  bullet outline at run time (`commandBriefText` + `serializeCommandBody`, inline
  references reconstructed). `commandDetails` is removed (the prompt body is
  ordinary outline content now).
- **Command glyph**: a new `command` `RowMarker` variant; command nodes are always
  shown expanded (`isRowExpanded`) so the config + steps stay visible.
- Removes the `CommandNodeControls` card + `commandDetails` field/command/client.

Status: **shipped** in this PR. The substance is folded into
`docs/spec/commands.md`.

Review-fix hardening (2026-06-09, main review on PR #165), all folded into
`docs/spec/commands.md`:

- **At-most-once across a crash.** A new `sysLastAttemptAt` marker is persisted
  via `mark_command_attempted(dueAt)` **before** each fire; a one-time startup
  `reconcileCommandAttempts()` advances the watermark past any occurrence whose
  attempt is newer than its fire (a crash mid-run is **skipped, not re-fired**).
  The due check still reads only `sysLastRunAt`, so an in-process failure keeps
  retrying through the backoff ladder.
- **Watermark writes are agent-barred.** `mark_command_fired` /
  `mark_command_attempted` now reject `origin === 'agent'` (symmetric to the
  schedule bright line — an agent can't suppress a schedule by jumping the
  watermark). The gate is keyed to the `command` node-type invariant;
  `protectedFields` is descriptive metadata, not the enforcement.
- **Unattended permission model.** Scheduled fires pass `unattended: true` → no
  `approvalHandler` → `interactionAvailable: false`: an **ask** decision denies
  and reports (the run never hangs) while the global **always-allow** list still
  runs. Run-now stays attended.
- **Backoff from failure time.** The ladder is measured from the failure
  timestamp rather than the sweep-start time, so a slow run doesn't collapse it.
- Latent fail-opens closed (agent-tool `meta.origin` spread ordering); daily +
  weekly DST spring-forward regression tests added.

Deviations from the directional calls, for the gate:

- **Smart-convert deferred.** Call #3 listed "command builder panel + smart-
  convert"; the *conversion* path shipped is the explicit `/command` slash
  command (deterministic, no model round-trip). LLM smart-convert (detect a
  natural-language routine in a plain row and offer to convert) needs a live
  provider + a UX affordance and is split to a follow-up — it does not gate the
  bright line or the scheduler.
- **Result routing to Today** rides on the existing delivery-conversation
  surfacing (the run is anchored to the command's own conversation); no new
  "Today" routing was added in this PR.
- **General per-field editor registry deferred.** The field-native plan proposed a
  registry letting any field def declare a custom value editor. For exactly two
  command fields that was over-built; the shipped code branches on the system-field
  kind in `OutlinerFieldRow` instead. A general registry can be extracted later if
  a third custom-edited field appears.
- **Run-now placement.** With the card gone, Run lives inside the Schedule field
  value (co-located with the schedule). A command node's config rows are always
  visible because command nodes are force-expanded — preserving the old card's
  always-on visibility rather than hiding config behind a collapse.
- **Light+dark visual verification** is the main-agent gate (step 4). CSS is
  token-only and passes the static design-system guards by construction; the
  formal light/dark sign-off happens at the merge gate.

Follow-up (PM-ratified 2026-06-08, same PR) — **subagent run boundary in the
message stream**:

The PM's complaint: a run opening the task list directly was abrupt ("现在直接
打开 task list 有点突兀"), and a main-agent-spawned subagent read as a raw tool
interaction. Ratified scope (AskUserQuestion): unify **both** kinds — a parentless
command fire *and* a main-agent spawn — behind one inline boundary, with the
main-agent case **suppressing its tool-call block**; click behavior is
inline-expand of the result summary plus a "View full run" link. And: every
subagent's final result must be recorded in its own DM/channel. Architecture
(shipped):

- **A new transcript row + entry kind `subagent`**, mirroring the
  compaction/dream boundaries. `agentRenderProjection` inserts one boundary row
  per run into `transcriptRows` (`insertSubagentRows` / `subagentInsertIndex`):
  a parented run anchors after its tool-result row (else after the assistant
  message that issued the call); a parentless run is ordered by start time. The
  active `rows` path is untouched.
- **`AgentSubagentBoundary`** (clone of `AgentCompactionBoundary`): a centered
  control between two rules. Running → live status line (not yet expandable);
  sealed → expands to the result/error (`AgentMarkdown`) with a "View full run"
  link wired to `onOpenTranscript` → the subagent details panel.
- **Tool-block suppression** for parented runs lives in one place —
  `AgentMessageRow`'s `renderAssistantBlocks` filters out a tool call that a
  subagent run claims (`subagentsByParentToolCallId`), and an assistant turn left
  with no blocks is dropped — so the run reads as one boundary, not a tool call
  plus an empty bubble.
- **Run no longer auto-opens the task panel.** The Schedule field's Run action
  reveals the agent conversation only; the run streams in as the inline boundary.

Status: **shipped** in this PR. Folded into `docs/spec/agent-event-log-rendering.md`
(render-projection rules) and `docs/spec/commands.md`.

Follow-up (PM-ratified 2026-06-08, same PR) — **config fields use standard field
editors (B1 + Agent select)**:

The PM's question: the Schedule field should be "the standard `date` with repeat"
and the Agent field "just an ordinary field" — both showed the plain-text (`T`)
glyph and bespoke editors. Ratified scope: full unification in this PR, **storage
unchanged** (Schedule stays the user-gated scalar; the bright line is untouched —
only the editor/display are unified). Architecture (shipped):

- **B1 — the generic `date` FieldType gained recurrence.** `DateFieldValue`'s
  `single` variant carries an optional `recurrence` (a `range` never does),
  encoded as the canonical `<endpoint> RRULE:...`. The recurrence-rule primitives
  (`DateRecurrenceRule`, `parseDateRecurrenceRule`, `formatDateRecurrenceRule`,
  `WEEKDAY_PRESET`, `isWeekdayPreset`) moved down into `dateFieldValue.ts` (the
  value-model layer); `dateSchedule.ts` now builds its fire-evaluation on them and
  re-exports them for back-compat (no import cycle). `DateValuePicker` gained a
  **Repeat / Ends** section (single-only; hidden in range mode), so *every* date
  field can now repeat. See `docs/spec/date-field-values.md`.
- **Shared recurrence form helpers** (`src/renderer/ui/outliner/dateRecurrence.ts`):
  `RecurrencePreset`, `SELECTABLE_PRESETS`, `presetFromRecurrence`,
  `buildScheduleString`, `scheduleChipSummary` — consumed by both the date picker
  and the command Schedule field. The recurrence i18n moved to the shared
  `outliner.field.datePicker` namespace.
- **Schedule field reuses `DateValuePicker`** (`allowRange={false}`) instead of the
  bespoke builder panel (now deleted), committing live through the user-gated
  `set_command_schedule`. It gets a **calendar** marker icon.
- **Agent field** is a registry-sourced single-select with an **agent** marker
  icon. Storage stays the (ungated) `commandAgent` scalar + system field — not
  demoted to a field-value node, because agent definitions are a runtime registry,
  not document nodes.
- **Marker icon override.** System fields default to the plain-text glyph; a new
  optional `markerIcon` on `RowLeading`/`RowMarker` lets the two command config
  rows carry a meaningful icon.

Second iteration (PM-ratified 2026-06-08, same PR) — **values use the standard
outliner style; Run moves to the title.** The first cut still drew the two values
as bespoke controls (a schedule chip + inline Run/status; a pill `<select>`). The
PM asked for both to read like ordinary outliner values, and for Run to leave the
date value entirely:

- **Schedule value = standard date-value style.** Plain summary text + a muted
  calendar glyph (no chip pill, no inline Run); clicking it opens the same
  `DateValuePicker`, still via the gated `set_command_schedule`.
- **Agent value = standard outliner listbox.** Plain agent text + a chevron,
  opening a `PopoverListbox` (the same surface as the field-name / options
  pickers) — replacing the native `<select>`. The chosen agent is marked
  `aria-selected`.
- **Run on the title, not the Schedule value.** A labelled **Run** button
  (`CommandRunButton` — a text action button with a background, aligned with the
  title like the inline Done checkbox) at the start of the command title;
  `useCommandRun` holds the run state. While a run is in flight the **command
  bullet glyph becomes a spinner** (`RowMarker` `processing` → `.is-processing`) —
  the *only* running indicator; the button never shows running/failed (a
  `runningRef` just guards a double-trigger). The ensure → reveal → run
  orchestration is unchanged.

Decide-and-note: the Agent field keeps its scalar storage (agent definitions are a
runtime registry, the wrong fit for `options_from_supertag`) but now uses the
shared outliner listbox surface instead of a native `<select>`, so it matches the
rest of the outliner (the PM's "standard style" ask) — the earlier B10
native-`<select>` call is superseded for this control.

Status: **shipped** in this PR. Folded into `docs/spec/date-field-values.md`
(recurrence grammar) and `docs/spec/commands.md` (the two config-field editors +
the title Run / bullet spinner).

## Essence

> A **command node** is a node whose content is a natural-language brief to the
> agent. Setting its `date` — one field that carries both *when to start* and
> *how to repeat* — makes it run on a schedule; writing that field is the only
> thing only the user can do. That is the entire safety surface.

The core has exactly two ideas, both already native to Lin:

- **`command` is a NodeType** — sibling of `search` / `codeBlock` / `embed` /
  `reference`. Any node can be converted in or out of it. Its **content** is a
  natural-language brief; the agent executes it end-to-end (no command chain, no
  DAG).
- **`date` on a command node is user-only-writable** (protected on the
  `command` NodeType, not on the field type globally). This is the **one bright
  line** of the whole feature: agents can draft the brief and propose a
  schedule, but **only the user can arm it**.

**Litmus test:** delete every mention of RSS / feed / task / note from this
document and the system is unchanged. The engine knows only nodes, `date`
(anchor + recurrence), runs, and a per-command success timestamp. RSS, task
review, and note digests are the same mechanism, written differently by the
user.

## Goal

Let a user say once — "every morning summarize my feeds into today's note," or
"research competitor X before Monday" — and have it happen without re-prompting.
The same machinery serves a one-off ("by Friday…") and a recurring job ("every
Monday…") with no scenario-specific code: they differ only in whether `date`
carries a recurrence rule. The execution substrate is "our client is running"
(no cloud); tray + launch-at-login is the first-class compensation.

This builds on the existing agent runtime: it reuses the run/subagent execution
engine (agent profile, background lifecycle, sidechain transcript persistence,
restore) from `docs/spec/agent-subagent-runtime-plan.md` and the node tools
from `docs/spec/agent-tool-design.md`.

## Non-goals

- **No participant / multi-agent system in v1.** A single default assistant runs
  every command. No `Assignee` field, no agent roster, no `@agent` in the
  composer.
- **No DAG / command chain / step list.** Agent reasoning replaces scripted
  workflows. The one Tana convention we deliberately do *not* adopt.
- **No domain subsystems.** No `#feed` watcher, RSS fetcher, or `feed_fetch`
  tool. RSS/task/note review are emergent uses of the same engine, written by
  the user.
- **No fence-as-configuration.** Tools / read scope / write target are not
  fields. A scheduled run inherits the same capabilities the agent has in
  interactive use; there is no per-run tool profile, no per-run write-target
  lock, no policy blob.
- **No snapshot / re-confirm gate.** Editing a command after enabling takes
  effect on the next fire. No frozen copy of the prompt.
- **No cloud tier, no IM channel** (Telegram and reachability tiers are
  deferred entirely — see *Deferred*).
- **No full cron grammar** (v1: a `date` with an optional `RRULE` subset —
  `FREQ` daily/weekly/monthly/yearly, `INTERVAL`, `BYDAY`, `UNTIL` — at
  `HH:mm`; no `BYSETPOS` "first Monday", no raw cron expressions).

## The model

### command is a NodeType

`command` joins `search` / `codeBlock` / `image` / `embed` / `reference` /
`tagDef` / `fieldDef` / `viewDef` / `search` / `queryCondition` in
`src/core/types.ts:NodeType`. NodeType / mode / identity all refer to the same
thing: a node converted into command mode is a node whose **role** is
"a unit of agent work."

- Conversion is bidirectional, like turning a node into a search node or code
  block. The conversion gesture is the same UI surface.
- The node's **text content** is the brief. The agent reads it and reasons
  end-to-end. There are no step children, no operator buttons, no DAG.
- Having `command` as a real NodeType lets us protect operations on it
  (`date` writes) at the type level, instead of detecting "this
  random node became a schedule" via magic fields. This is the openclaw pattern
  ("creation of an automation is a typed, gateable operation") — we can adopt
  it because we now have the type.

### The bright line

> **Only the user can write `date` on a command node.**

This is the entire safety kernel. Three consequences:

- The agent **can** draft a command (write its text, propose a schedule).
- The agent **cannot** arm an unattended run (cannot write `date` on
  a command node).
- The scheduler reads only `date`; it never scans node content to
  decide what to execute.

Protection is on **type × field**, not on the field type globally. `date` on a
regular todo node remains ordinary, model-writable content (a due date). `date`
on a `command` node is user-only.

Run now is **attended** and inherits whatever capabilities the agent has in
interactive use — same trust model, no extra fence. The bright line covers only
the unattended case, which is the only case the user is not present for.

### When = `date`, made powerful (one field)

`When` is **one field**, not two: the existing `date` value, extended into a
full schedule — an anchor (date + optional time) plus an optional recurrence
rule. We do **not** add a separate `repeat` field. A schedule is intrinsically
`{anchor + recurrence + end}`; splitting it across two fields creates invalid
combinations (a recurrence with no anchor) and two controls for one concept.
Every serious product models it as one object — Todoist's `due`, Apple
`EKRecurrenceRule`, iCalendar `DTSTART` + `RRULE` — and so do we. This is the
Todoist interaction exactly: in its date picker, *Repeat* lives **inside** the
date control.

**Storage is structured, not Todoist's natural-language string.** The
recurrence is a standard `RRULE` subset appended to the date endpoint:

```
2026-05-30T09:00 RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
```

The existing endpoint parser (`src/core/dateFieldValue.ts`) is unchanged; a new
step splits off the trailing ` RRULE:…`. Only the `single` kind carries a rule
(ranges do not). Why structured rather than NL: Todoist re-parses its NL string
server-side on every change, but our scheduler is offline anacron and must read
the rule **cold at tick time, without invoking the model**. So the structured
rule is the source of truth and `sys:lastRunAt` is the only cache.

Supported rule shape (mirrors Todoist's "Custom repeat"):

| Part | Values |
|---|---|
| `FREQ` | `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY` |
| `INTERVAL` | every N (default 1; "every 2 weeks") |
| `BYDAY` | weekday set for weekly; the "weekday" preset = `MO,TU,WE,TH,FR` |
| `BYMONTHDAY` | implied from the anchor for monthly |
| `UNTIL` | end date ("Ends: never / on date"); `COUNT` deferred |
| based-on | `scheduled` vs `completed` (Todoist's `every` vs `every!`) — next fire anchors on the schedule vs on `sys:lastRunAt`; a small flag, not shown in the chip |

Combinations:

| `date` value | Behavior |
|---|---|
| empty | Manual only (Run now still available) |
| anchor, no rule | One-off: fires once at that datetime, then done |
| anchor + rule | Recurring: anchor is `DTSTART`, occurrences from the rule |

**Display is text-only — no icon.** The date chip (`DateFieldControl.tsx`,
`typed-field-date-trigger`) shows the canonical string. One-off dates render
exactly as today (zero regression). Recurring values show the rule string
instead, e.g. `Every weekday 09:00`, `Monthly on the 30th 09:00`,
`Every 2 weeks on Mon 09:00 · until Dec 31`. based-on is not shown in the chip.
The formatter `formatRecurrence(rule)` lives in core (beside `dateFieldValue.ts`)
so the chip, read-only renders, and agent text share one vocabulary.

**Authoring copies Todoist.** The agent fills the field from natural language
(it *is* the NL parser), and a human edits it in the date popover, whose
calendar gains a small "Repeat" section (presets + a custom form: based-on /
every N unit / ends). Both paths write the same structured value.

This **extends the generic `date` FieldType** (decision **B1**): any date value
may carry an optional recurrence rule, so recurrence becomes a general
capability — reusable later for recurring events / todos — not a command-only
concept. See Open questions for the consequences this pulls into scope.

### Run now ↔ Enable schedule (orthogonal)

A command node supports two distinct actions:

| Action | Human present? | Authority | Gate |
|---|---|---|---|
| **Run now** | Yes | Same as interactive chat | None |
| **Enable schedule** | No (runs while you are away) | User-only write of `date` | The bright line |

These are orthogonal. One node covers three temporal patterns by `When` value
alone:

- **Immediate once** — Run now, `date` empty.
- **One-off later** — `date` set, no recurrence rule.
- **Recurring** — `date` carries a recurrence rule.

A recurring command can still be Run-now'd on demand (test it; get today's
output early). Run-now never disturbs the schedule.

## Scheduler

Anacron-style: presence-triggered + catch-up, not wall-clock alarms.

**Decision is a pure function of three inputs:**

```
let mostRecentDue  = mostRecentDue(date, now)   // date = anchor + optional RRULE
let lastSuccessAt  = node.sys.lastRunAt         // stored (see below)

fire(node) if  now >= mostRecentDue
           AND lastSuccessAt < mostRecentDue
```

- `mostRecentDue` is **computed on every tick** (never stored). It is the most
  recent occurrence of the rule at or before `now`.
- `lastSuccessAt` is a small system field on the command node: `sys:lastRunAt`
  (sibling of `sys:createdAt` / `sys:updatedAt` in
  `src/core/types.ts:ViewSystemField`). System-managed (agent-unwritable),
  updated by the harness after a successful Run.

**Tick triggers:**

1. App launch (after `DocumentService.initWorkspace()` resolves).
2. `powerMonitor.resume` (system wake from sleep/standby).
3. A coarse heartbeat (~60 s) while the app is open.

`node-cron`/`setTimeout` are never the source of truth for whether a run
happened; the persisted `sys:lastRunAt` is.

**Catch-up coalesces by construction.** If the app was closed for three days
(daily command), `mostRecentDue` = today's occurrence and `lastSuccessAt` is
three days ago — so it fires **once**, not three times. The one fire is a
"covering the last few days" digest by virtue of `lastSuccessAt` being passed
to the prompt (see *Result*).

**Failure** does not advance `lastSuccessAt`. A lightweight in-memory backoff
(e.g. `[30s, 60s, 5m, 15m, 1h]`, openclaw-style) prevents tight retry loops;
this state is process-level, not persisted.

## Lifecycle — the re-arm rule

A single rule covers every state change:

> **Any user gesture that re-enables or changes timing sets
> `sys:lastRunAt = now` (re-arm; no retroactive fire). Catch-up only applies to
> passive lapses (app / device off).**

This split — *active gestures re-arm*, *passive lapses catch up* — keeps every
case below predictable:

| User action | schedule | `sys:lastRunAt` | content / conversation |
|---|---|---|---|
| Edit the brief (prompt text) | unchanged | unchanged | takes effect immediately; no re-confirm |
| Edit `date` (user-only) | recomputed | **reset to now** (re-arm) | — |
| Clear `date` | becomes manual-only | unchanged | — |
| Convert node out of `command` | schedule released | retained on node | fields linger; convert back to re-enable |
| Move node to trash | paused | unchanged | delivery conversation preserved |
| Restore from trash | **re-armed** at restore time | reset to now | — |
| Permanently delete | released | gone with node | delivery conversation becomes an orphan, preserved unless user deletes it separately |

**In-flight when the user deletes / converts.** The active Run receives a
cancel signal; whatever was already emitted into its delivery conversation is preserved.
No Result node is materialized.

**Why the brief stays freely editable.** We deliberately cut snapshot /
re-confirm. The brief is ordinary content, agent-writable like any node text.
The safety property comes from `date` being user-only, not from
freezing the prompt — the agent cannot move the schedule, only the user can.

## Result

| Trigger | Result lands at |
|---|---|
| **Run now** (attended) | Under the command node (you see it right where you ran it) |
| **Scheduled fire** (unattended) | **Today** (via `ensure_date_node`); the command node shows a back-link |
| **Empty result** | Nothing is materialized; `sys:lastRunAt` still advances |

The empty-result rule prevents "an empty daily entry forever" clutter. A quiet
day just moves `lastSuccessAt` forward.

A Result node carries `producedBy:: [[command]]` so the command's history is a
query, and the command node stays clean across N occurrences.

## History (conversation + run, post-F2)

Run transcripts live in the **existing event-store infrastructure** (no new sidecar).
M0 stores the delivery thread under `conversations/<id>` and each execution under
`runs/<id>` — see [[agent-data-model]]. This plan is sequenced at **M2**, on top of that
split, so it is written against the conversation/run model, not the old flat
`session` directory.

```
${userData}/agent/
  conversations/<id>/       # delivery conversation
  runs/<id>/                # one execution log per fire
  indexes/conversation-index.json
  indexes/search-index.json
```

Code: `src/main/agentEventStore.ts`, rooted at `${userData}/agent/` (see
`agentRuntime.ts:1494`). Per-clone isolation via `ELECTRON_USER_DATA_DIR` (CLAUDE.md).

**One delivery conversation per command; each fire is a Run.** All fires of a command post
into the **same delivery conversation** (one thread, one entry in the list); each fire is a
`Run` with `trigger:{type:'node', nodeId}` anchored to that conversation
([[agent-data-model]] — the node is the *trigger*, the conversation is the *home*; no
conversation-less runs). Each fire executes with **bounded context** (the brief +
`lastSuccessAt`), *not* a full-transcript replay — otherwise cost grows with history.
Opening the conversation to chat is a normal interactive run that *does* see history (you
can steer it: "make it shorter").

**User visibility — target UI.** Each fire appends to the routine's
**conversation** (a routine owns one durable conversation that anchors its runs —
see [agent-data-model.md](agent-data-model.md) §3–§4), which shows up in
`AgentChatPanel` (`src/renderer/ui/AgentDock.tsx` → `AgentChatPanel`) like any
other chat. This plan builds only on conversation/channel IPC; it must not preserve
`agent_*_session` aliases or add a scheduled-run compatibility path over the old
session surface. The agent can also recall durable facts it has remembered via
the read-only `recall` tool; raw past-conversation search is internal-only (no
model-visible `past_chats` tool — see [agent-conversation-model.md](agent-conversation-model.md)
§Memory).

**Deletion semantics.** Deleting the routine's conversation clears its
communication history only; the schedule keeps running off `date` +
`sys:lastRunAt`. The scheduler tolerates a missing conversation and
find-or-creates one on the next fire (canonical-anchor semantics, not a fresh
session each time). To stop the command, clear its `date` or trash the node.

## Smart convert

When converting a node into `command`, the agent reads the existing title/text
and pre-fills the command:

- Extracts "每天早上" / "every morning" → suggests a `date` with a recurrence rule.
- Rewrites the rest into a clean prompt (the brief).
- Infers chips ("needs network" / "writes to Today") for display only.

**All of this is a draft.** Nothing is armed until the user clicks **Enable
schedule** — that one click is the user-only write of `date` that
arms the run.

This handles the on-ramp gracefully: write a line of natural-language ("每天早上
总结我的 feeds"), convert, glance, click. No form to fill.

## Builder UI

Parallels the existing Query builder (used by `search` nodes):

| Region | Query builder (search) | command builder |
|---|---|---|
| Body | Structured operator area (AND/OR/NOT, field pickers) | **Natural-language prompt area** (large prose box) |
| Insertion | `@` for nodes/tags, `>` for fields, plain text = keyword | Same `@` / `>` grammar, anchoring nodes/tags inside the brief |
| Trigger strip | — | `date` row (with a Repeat section) below the prose box |
| Footer | Run once / Done | **Run now** / **Enable schedule** (the user-only arming button) |

The structural emptiness of the command body — no operators, no step builder —
is intentional. It is what the *no-DAG* non-goal looks like in the UI: the
agent does the thinking; the user writes a brief.

(`tmp/command-node-demo.html` was an inline-card sketch; the panel form
matching this table is the intended target.)

## v1 footprint — what we are actually building

Counted, ordered:

1. **Add `command` to `NodeType`** in `src/core/types.ts` (coordinated file —
   protocol surface).
2. **Add a `protected` field property** (or equivalent type×field
   user-only-write enforcement at the node-tool gateway) so that `date` writes
   on a `command` node are rejected for non-user origins.
3. **Extend the generic `date` value** (decision B1) to carry an optional
   `RRULE` (single kind only): `parseDateFieldValue` returns the rule; add
   `formatRecurrence(rule)` and `mostRecentDue(date, now)` as pure functions in
   core, unit-tested. The date chip renders the canonical string (text-only);
   the popover gains a Repeat section. Teach the date search ops
   (`DATE_OVERLAPS`, `OVERDUE`) and `DateFieldControl` to tolerate a trailing
   rule (ignored by range math; values sort/overlap by anchor).
4. **Add `sys:lastRunAt`** to `ViewSystemField` (`src/core/types.ts`).
5. **Anacron scheduler** in main process: tick on launch / `powerMonitor.resume`
   / 60 s heartbeat; for each command node compute `mostRecentDue` and compare.
6. **`startTriggeredRun`** entry beside `sendMessage`: starts a `Run` with no
   human turn, `trigger:{type:'node', nodeId}` **anchored to the command's delivery
   conversation** ([[agent-data-model]]), hands the agent the brief +
   `lastSuccessAt`, runs under inherited interactive capabilities.
7. **Result routing** by trigger: `Run now` → under the command node;
   scheduled fire → `Today` (via existing `ensure_date_node`). Empty result =
   no node, `lastSuccessAt` still advances.
8. **Smart convert hook** on NodeType change *into* `command` (can be deferred
   one cut behind the kernel; the manual fill is functional without it).
9. **Builder panel UI** mirroring the Query builder (likewise deferrable —
   inline editing works as a first cut).

**The `When` half is the generic `date` FieldType extended with an optional
`RRULE` subset (decision B1).** Recurrence is a general date capability, not a
command-only value. The rule is structured and offline-readable, not Todoist's
NL string.

## Negative space — what we are not building

Each of these was considered during design and explicitly dropped:

- `systemRunPolicy` blob, enable-time `snapshot`, fingerprint diff, re-confirm
  gate — defense-in-depth that did not earn its conceptual weight.
- A separate state file (`tasks-state.json`), an out-of-document grant store —
  collapsed into `sys:lastRunAt` (one field, on the node).
- Two-profile fence (local-only / network-summary) as setup configuration,
  per-run `toolPolicy`, write-target gateway lock — interactive trust inheritance
  replaces them.
- A kernel `watermark` field — `sys:lastRunAt` already serves as "what's new
  since" for the agent's prompt.
- `Assignee` field, participant model, multi-author transcript UX, `@agent` in
  the composer — the v1 single-assistant model needs none of this.
- Domain-specific tools (`feed_fetch`, GUID dedup, `#routine` supertag) —
  RSS-as-feature would import scenario logic; instead it is an emergent use.
- Three-axis reachability framing (trigger / transport / sink), IM channels,
  Telegram-as-transport, async approval over the channel — all extension-tier,
  deferred entirely.

## Deferred (separate, future features)

- **Multi-participant.** Named agents (Assignee), multi-author transcripts,
  `@agent` references, agent roster. Boundary: agents live in `.agents/`,
  referenced by name, never embedded in document content.
- **Cloud / headless tier.** True device-off execution. v1 substrate is
  "the client is running," with tray + launch-at-login as the first-class
  guarantee.
- **Event triggers.** Run on data change, not only on time. Needs a loop guard;
  v1 is cascade-safe by construction (only `date` triggers the
  scheduler, never node content).
- **Raw cron grammar**, full `RRULE` (`BYSETPOS`, `COUNT`, IANA `TZID`) beyond
  the v1 subset, a generic `fetch + seen-set` tool, curation by "unread" —
  each an isolated future cut.
- **The optional "B" heads-up** for unattended + network commands. v1 ships
  without it (interactive trust inheritance, no exceptions); it can be added
  later as a one-line notice the first time a command both runs unattended and
  has network capability.

## Prior art

- **Tana — command node as a NodeType.** A node flipped into execution mode,
  children = steps, params = fields. Our shape matches Tana's *object model*
  (command as a typed node), but our **execution model is the opposite**:
  Tana's command runs a deterministic command-chain (AI is one optional step);
  ours runs an agent end-to-end (the prose is the program). Tana also has *no
  native scheduling* and *no persistent run model* — precisely our gap.
- **openclaw (verified against source, 2026-05-28).** Validates the
  anacron + catch-up + coalesce pattern, the failure-backoff schedule, and the
  no-human-turn entry (`systemEvent` / `agentTurn` instead of a synthetic user
  message). Its divergence — "create a cron job is itself a privileged tool"
  — is one we *can* now adopt, because `command` is a typed object (not
  arbitrary content): writes to `date` on a command node are exactly
  that kind of typed, gateable operation.
- **Anacron / APScheduler `misfire_grace_time` + `coalesce` / Electron
  `powerMonitor` + `app.setLoginItemSettings`.**
  https://apscheduler.readthedocs.io/en/3.x/userguide.html ·
  https://www.electronjs.org/docs/latest/api/power-monitor
- **ChatGPT Tasks / Gemini Scheduled Actions.** Consumer convergence on
  one-off and recurring in a single list, NL authoring + notification + an
  in-app surface. https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- **Todoist — recurrence inside the date control.** Repeat is a button in the
  date picker, not a separate field; the `due` object holds date + recurrence as
  one unit. We copy the interaction (one control) but not the storage (Todoist
  keeps the NL string canonical; we store a structured `RRULE` subset because
  the scheduler is offline).

## Open questions

1. **How is "protected on type × field" enforced?** Cleanest implementation
   point — node-tool gateway rejection of writes to `date` on a
   `command` node from non-user origins, vs. a more general field-property
   ("`protected`") on `FieldConfigPatch`. Each has different blast radius;
   first cut can be inline at the gateway.
2. **Smart convert as v1 or v1.1?** The kernel works without it (user fills
   `date` manually after conversion). Smart convert is high-value
   UX but adds an agent dependency at conversion time.
3. **Builder panel form vs first-cut inline editing.** Long term: panel
   matching the Query builder. First cut: inline editing of the brief +
   the `date` chip on the node. Both can coexist (panel for edit, inline
   for browse).
4. **`startTriggeredRun` refactor depth.** Without per-run `toolPolicy` or a
   `scheduled_fire` context projection (both cut), this is mostly: extract the
   shared execution path below `sendMessage`, add a no-human-turn entry, anchor
   the `Run` (`trigger:{node}`) to the command's delivery conversation. Materially
   smaller than the prior plan assumed.
5. **Where recurrence lives — DECIDED: B1 (extend the generic `date`
   FieldType).** Any date value may carry an optional `RRULE`; recurrence is a
   general capability (reusable for future recurring events / todos), not a
   command-only value. Rejected **B2** (a dedicated `recurrence`/`schedule`
   value used only by `command` nodes) — it would add a second date-like
   concept overlapping `date`. This is the Todoist `due` / iCal
   `DTSTART`+`RRULE` shape, and the rule is optional, so a plain date field
   simply never sets one. Consequence pulled into scope: the date codec,
   `DateFieldControl`, and date search semantics (`DATE_OVERLAPS`, `OVERDUE`)
   must tolerate an optional rule — rule-bearing values still sort and overlap
   by their anchor; the rule is ignored by range math. Storage is settled: a
   structured `RRULE` subset, never the NL string.

## MVP slice

Resequenced to match the converged model — kernel first, polish next:

1. **`command` NodeType + protected `date`.** Add to `NodeType`; wire
   the user-only-write enforcement at the node-tool gateway. Without this,
   nothing is safe to ship.
2. **`date` value carries an optional `RRULE`** + `mostRecentDue(date, now)` and
   `formatRecurrence` in core, unit-tested. The shared pure schedule primitive
   now exists in `src/core/dateSchedule.ts`; wiring it into generic date field
   parsing, the date picker, search tolerance, and command-node scheduling is
   still part of this plan.
3. **`sys:lastRunAt` system field** on command nodes (system-managed, like
   `sys:updatedAt`).
4. **Anacron scheduler** (tick + `mostRecentDue` + the fire condition). Verify
   catch-up coalesce, `powerMonitor.resume`, sweep-after-document-load.
5. **`startTriggeredRun`** entry: no-human-turn `Run` (`trigger:{node}`) anchored
   to the command's delivery conversation, agent gets `brief + lastSuccessAt`.
6. **One local-only task review command** — e.g. "summarize what's overdue and
   due today," `date: today`, no recurrence. Result lands under the node on
   Run-now; Today on schedule. Proves: only enabled commands fire, fire on
   time, catch up on launch, empty result skips materialization, history
   readable in the chat panel.
7. **Smart convert hook** (NodeType-change time agent pre-fill).
8. **Builder panel UI** mirroring the Query builder.

After kernel — tray + launch-at-login (the substrate guarantee for "client is
running"), agent self-curation (flag broken commands, suggest merges — never
silent delete), and full `RRULE` (`BYSETPOS` / `COUNT` / IANA `TZID`) beyond
the v1 subset when cross-TZ or "first Monday" rules become real, and only then
any consideration of the deferred features (multi-participant, IM, cloud).

## Validation

- `bun run typecheck`.
- **Bright line:** a node-tool call that attempts to write `date`
  on a `command` node, from any non-user origin, is rejected at the gateway.
  A command whose `date` is unset never fires.
- **Scheduler core:** `mostRecentDue` correct for a one-off date, daily,
  weekday-set, weekly, monthly, and every-N rules. Launch / `powerMonitor.resume`
  catch-up. Three-day gap fires exactly once (coalesce). Failures do not
  advance `sys:lastRunAt`.
- **Re-arm rule:** edits to `date` reset `sys:lastRunAt` to now,
  so a same-day time change does not trigger a duplicate fire. Restore from
  trash same behavior.
- **Result routing:** Run-now nests under the command; scheduled fire lands in
  Today via `ensure_date_node`; empty result materializes no node, but
  `sys:lastRunAt` still advances.
- **Conversation/run lifecycle:** all fires of one command are `Run`s posting into a
  single delivery conversation; scheduled fires use bounded context (brief +
  `lastSuccessAt`), not a full replay; deleting the conversation does not stop the command
  (next fire recreates it); the conversation is visible in `AgentChatPanel` with normal
  list/rename/delete via existing IPC.
- **Smart convert:** converting a node into `command` pre-fills `date`
  (with any recurrence) and rewrites the prose into a brief; nothing is armed
  until the user clicks **Enable schedule** (which is the user-only write).
