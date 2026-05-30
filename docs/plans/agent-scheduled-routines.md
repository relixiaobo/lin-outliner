---
status: draft
priority: P2
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-30
---

# Proactive Agent — Command Nodes

## Essence

> A **command node** is a node whose content is a natural-language brief to the
> agent. Setting its `date` (and optionally `repeat`) makes it run on a schedule;
> writing those fields is the only thing only the user can do. That is the entire
> safety surface.

The core has exactly two ideas, both already native to Lin:

- **`command` is a NodeType** — sibling of `search` / `codeBlock` / `embed` /
  `reference`. Any node can be converted in or out of it. Its **content** is a
  natural-language brief; the agent executes it end-to-end (no command chain, no
  DAG).
- **`date` and `repeat` on a command node are user-only-writable** (protected on
  the `command` NodeType, not on the field types globally). This is the **one
  bright line** of the whole feature: agents can draft the brief and propose
  values, but **only the user can arm a schedule**.

**Litmus test:** delete every mention of RSS / feed / task / note from this
document and the system is unchanged. The engine knows only nodes, `date`,
`repeat`, runs, and a per-command success timestamp. RSS, task review, and note
digests are the same mechanism, written differently by the user.

## Goal

Let a user say once — "every morning summarize my feeds into today's note," or
"research competitor X before Monday" — and have it happen without re-prompting.
The same machinery serves a one-off ("by Friday…") and a recurring job ("every
Monday…") with no scenario-specific code: they differ only in whether `date` has
a `repeat` paired with it. The execution substrate is "our client is running"
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
- **No full cron grammar** (v1: one-off `date` and `repeat ∈ {daily, weekdays,
  weekly + day}` at `HH:mm`).

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
  (`date` / `repeat` writes) at the type level, instead of detecting "this
  random node became a schedule" via magic fields. This is the openclaw pattern
  ("creation of an automation is a typed, gateable operation") — we can adopt
  it because we now have the type.

### The bright line

> **Only the user can write `date` or `repeat` on a command node.**

This is the entire safety kernel. Three consequences:

- The agent **can** draft a command (write its text, propose values).
- The agent **cannot** arm an unattended run (cannot write `date` / `repeat` on
  a command node).
- The scheduler reads only `date` and `repeat`; it never scans node content to
  decide what to execute.

Protection is on **type × field**, not on field types globally. `date` on a
regular todo node remains ordinary, model-writable content (a due date). `date`
on a `command` node is user-only.

Run now is **attended** and inherits whatever capabilities the agent has in
interactive use — same trust model, no extra fence. The bright line covers only
the unattended case, which is the only case the user is not present for.

### When = `date` + `repeat`

`When` is the conceptual name for two ordinary fields on a command node:

| Field | Type | Notes |
|---|---|---|
| **`date`** | existing `date` FieldType, unchanged | Anchor; also the trigger time for a one-off |
| **`repeat`** | v1: `options(daily / weekdays / weekly+day) + time-of-day`; end-state: a new `recurrence` FieldType (RRULE + IANA TZID) | Rule only, **not** the anchor (anchor lives in `date`) |

**v1 introduces zero new FieldTypes.** `repeat` is encoded with existing
`options` + a time component. The proper `recurrence` FieldType lands when
interval / until / count / monthly / cross-TZ recurrence is needed.

Combinations:

| `date` | `repeat` | Behavior |
|---|---|---|
| empty | empty | Manual only (Run now still available) |
| set | empty | One-off: fires once at that datetime, then done |
| set | set | Recurring: anchor at `date`, future occurrences from `repeat` |
| empty | set | **Invalid** (no anchor) |

This matches iCalendar (`DTSTART` + `RRULE`) and consumer calendar apps. The
generic `date` FieldType is **not** redesigned; the recurrence rule is its own
piece. No timezone is added to `date`.

### Run now ↔ Enable schedule (orthogonal)

A command node supports two distinct actions:

| Action | Human present? | Authority | Gate |
|---|---|---|---|
| **Run now** | Yes | Same as interactive chat | None |
| **Enable schedule** | No (runs while you are away) | User-only write of `date`/`repeat` | The bright line |

These are orthogonal. One node covers three temporal patterns by `When` value
alone:

- **Immediate once** — Run now, `date` empty.
- **One-off later** — `date` set, `repeat` empty.
- **Recurring** — both set.

A recurring command can still be Run-now'd on demand (test it; get today's
output early). Run-now never disturbs the schedule.

## Scheduler

Anacron-style: presence-triggered + catch-up, not wall-clock alarms.

**Decision is a pure function of three inputs:**

```
let mostRecentDue  = mostRecentDue(date, repeat, now)   // computed
let lastSuccessAt  = node.sys.lastRunAt                  // stored (see below)

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

| User action | schedule | `sys:lastRunAt` | content / session |
|---|---|---|---|
| Edit the brief (prompt text) | unchanged | unchanged | takes effect immediately; no re-confirm |
| Edit `date` or `repeat` (user-only) | recomputed | **reset to now** (re-arm) | — |
| Clear `date` | becomes manual-only | unchanged | — |
| Convert node out of `command` | schedule released | retained on node | fields linger; convert back to re-enable |
| Move node to trash | paused | unchanged | session preserved |
| Restore from trash | **re-armed** at restore time | reset to now | — |
| Permanently delete | released | gone with node | session becomes an orphan, preserved unless user deletes it separately |

**In-flight when the user deletes / converts.** The active Run receives a
cancel signal; whatever was already emitted into its session is preserved.
No Result node is materialized.

**Why the brief stays freely editable.** We deliberately cut snapshot /
re-confirm. The brief is ordinary content, agent-writable like any node text.
The safety property comes from `date`/`repeat` being user-only, not from
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

## Sessions and history

Run transcripts live in **the existing session infrastructure**, not in any new
sidecar:

```
${userData}/agent/
  sessions/<sessionId>/        ← per-session event log + payloads
  indexes/SESSION_INDEX_FILE   ← session list
  indexes/SEARCH_INDEX_FILE    ← full-text index over sessions
```

Code: `src/main/agentEventStore.ts`, rooted at `${userData}/agent/` (see
`agentRuntime.ts:1494`). Per-clone isolation via `ELECTRON_USER_DATA_DIR`
(CLAUDE.md).

**One session per command.** All fires of a command append to the same session
(one thread, one entry in the chat list). Each fire executes with **bounded
context** (the brief + `lastSuccessAt`), *not* a replay of the full transcript
— otherwise cost grows with history. Opening the session to chat is a normal
interactive run that *does* see history (you can steer it: "make it shorter").

**User visibility — existing UI.** The session shows up in `AgentChatPanel`
(`src/renderer/ui/AgentDock.tsx` → `AgentChatPanel`) like any other chat. IPC
already exposes `agent_list_sessions` / `agent_restore_session` /
`agent_rename_session` / `agent_delete_session` (`src/main/main.ts:300-345`).
The agent can also query its own past work via the `past_chats` tool.

**Deletion semantics.** Deleting the session clears history only; the schedule
keeps running off `date` + `repeat` + `sys:lastRunAt`. The scheduler tolerates
a missing session and recreates one on the next fire. To stop the command,
clear its `date` or trash the node.

## Smart convert

When converting a node into `command`, the agent reads the existing title/text
and pre-fills the command:

- Extracts "每天早上" / "every morning" → suggests `date` + `repeat`.
- Rewrites the rest into a clean prompt (the brief).
- Infers chips ("needs network" / "writes to Today") for display only.

**All of this is a draft.** Nothing is armed until the user clicks **Enable
schedule** — that one click is the user-only write of `date` / `repeat` that
arms the run.

This handles the on-ramp gracefully: write a line of natural-language ("每天早上
总结我的 feeds"), convert, glance, click. No form to fill.

## Builder UI

Parallels the existing Query builder (used by `search` nodes):

| Region | Query builder (search) | command builder |
|---|---|---|
| Body | Structured operator area (AND/OR/NOT, field pickers) | **Natural-language prompt area** (large prose box) |
| Insertion | `@` for nodes/tags, `>` for fields, plain text = keyword | Same `@` / `>` grammar, anchoring nodes/tags inside the brief |
| Trigger strip | — | `date` + `repeat` row below the prose box |
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
   user-only-write enforcement at the node-tool gateway) so that `date` and
   `repeat` writes on a `command` node are rejected for non-user origins.
3. **Add `sys:lastRunAt`** to `ViewSystemField` (`src/core/types.ts`).
4. **Anacron scheduler** in main process: tick on launch / `powerMonitor.resume`
   / 60 s heartbeat; for each command node compute `mostRecentDue` and compare.
5. **`startTriggeredRun`** entry beside `sendMessage`: starts a run with no
   human turn, attaches to the command's session, hands the agent the brief +
   `lastSuccessAt`, runs under inherited interactive capabilities.
6. **Result routing** by trigger: `Run now` → under the command node;
   scheduled fire → `Today` (via existing `ensure_date_node`). Empty result =
   no node, `lastSuccessAt` still advances.
7. **Smart convert hook** on NodeType change *into* `command` (can be deferred
   one cut behind the kernel; the manual fill is functional without it).
8. **Builder panel UI** mirroring the Query builder (likewise deferrable —
   inline editing works as a first cut).

**Zero new FieldType.** v1 reuses `date` and `options` for the `When` half.

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
  v1 is cascade-safe by construction (only `date`/`repeat` triggers the
  scheduler, never node content).
- **Raw cron grammar**, the proper `recurrence` FieldType, a generic
  `fetch + seen-set` tool, curation by "unread" — each an isolated future cut.
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
  arbitrary content): writes to `date`/`repeat` on a command node are exactly
  that kind of typed, gateable operation.
- **Anacron / APScheduler `misfire_grace_time` + `coalesce` / Electron
  `powerMonitor` + `app.setLoginItemSettings`.**
  https://apscheduler.readthedocs.io/en/3.x/userguide.html ·
  https://www.electronjs.org/docs/latest/api/power-monitor
- **ChatGPT Tasks / Gemini Scheduled Actions.** Consumer convergence on
  one-off and recurring in a single list, NL authoring + notification + an
  in-app surface. https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

## Open questions

1. **How is "protected on type × field" enforced?** Cleanest implementation
   point — node-tool gateway rejection of writes to `date` / `repeat` on a
   `command` node from non-user origins, vs. a more general field-property
   ("`protected`") on `FieldConfigPatch`. Each has different blast radius;
   first cut can be inline at the gateway.
2. **Smart convert as v1 or v1.1?** The kernel works without it (user fills
   `date` / `repeat` manually after conversion). Smart convert is high-value
   UX but adds an agent dependency at conversion time.
3. **Builder panel form vs first-cut inline editing.** Long term: panel
   matching the Query builder. First cut: inline editing of the brief +
   `date`/`repeat` chips on the node. Both can coexist (panel for edit, inline
   for browse).
4. **`startTriggeredRun` refactor depth.** Without per-run `toolPolicy` or a
   `scheduled_fire` context projection (both cut), this is mostly: extract the
   shared execution path below `sendMessage`, add a no-human-turn entry, attach
   to the command's session. Materially smaller than the prior plan assumed.

## MVP slice

Resequenced to match the converged model — kernel first, polish next:

1. **`command` NodeType + protected `date`/`repeat`.** Add to `NodeType`; wire
   the user-only-write enforcement at the node-tool gateway. Without this,
   nothing is safe to ship.
2. **`sys:lastRunAt` system field** on command nodes (system-managed, like
   `sys:updatedAt`).
3. **Anacron scheduler** (tick + `mostRecentDue` + the fire condition). Verify
   catch-up coalesce, `powerMonitor.resume`, sweep-after-document-load.
4. **`startTriggeredRun`** entry: no-human-turn, attached to the command's
   session, agent gets `brief + lastSuccessAt`.
5. **One local-only task review command** — e.g. "summarize what's overdue and
   due today," `date: today`, no `repeat`. Result lands under the node on
   Run-now; Today on schedule. Proves: only enabled commands fire, fire on
   time, catch up on launch, empty result skips materialization, history
   readable in the chat panel.
6. **Smart convert hook** (NodeType-change time agent pre-fill).
7. **Builder panel UI** mirroring the Query builder.

After kernel — tray + launch-at-login (the substrate guarantee for "client is
running"), agent self-curation (flag broken commands, suggest merges — never
silent delete), recurring + the proper `recurrence` FieldType when intervals /
monthly / TZID become real, and only then any consideration of the deferred
features (multi-participant, IM, cloud).

## Validation

- `bun run typecheck`.
- **Bright line:** a node-tool call that attempts to write `date` or `repeat`
  on a `command` node, from any non-user origin, is rejected at the gateway.
  A command whose `date` is unset never fires.
- **Scheduler core:** `mostRecentDue` correct for `date` alone, `date + daily`,
  `date + weekdays`, `date + weekly+day`. Launch / `powerMonitor.resume`
  catch-up. Three-day gap fires exactly once (coalesce). Failures do not
  advance `sys:lastRunAt`.
- **Re-arm rule:** edits to `date` / `repeat` reset `sys:lastRunAt` to now,
  so a same-day time change does not trigger a duplicate fire. Restore from
  trash same behavior.
- **Result routing:** Run-now nests under the command; scheduled fire lands in
  Today via `ensure_date_node`; empty result materializes no node, but
  `sys:lastRunAt` still advances.
- **Session lifecycle:** all fires of one command append to a single session;
  scheduled fires use bounded context (brief + `lastSuccessAt`), not a full
  replay; deleting the session does not stop the command (next fire recreates
  the session); session is visible in `AgentChatPanel` with normal
  list/rename/delete via existing IPC.
- **Smart convert:** converting a node into `command` pre-fills `date` /
  `repeat` and rewrites the prose into a brief; nothing is armed until the
  user clicks **Enable schedule** (which is the user-only write).
