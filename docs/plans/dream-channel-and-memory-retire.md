# Dream Channel & Memory Retire

Make Dream — the memory-consolidation run — **transparent** to the user by
giving it a dedicated channel that shows each run's complete process, and retire
the now-vestigial Settings Memory surfaces left over from the #302 teardown.

## Goal

- Dream is currently invisible: it runs as a **parentless child run** inside a
  transient conversation that is **created then deleted** (`agentRuntime.ts`
  `runMemoryDreamChildAgent` — create at ~`:3659`
  `ensureConversationWithId(MEMORY_DREAM_CONVERSATION_ID)`, delete at ~`:3694`
  `deleteConversation`), so the user never sees what it read, how it reasoned, or
  what it wrote. Make every run land in a **persistent Dream channel** whose
  process renders **inline** as the existing agent transcript (the #312 renderer,
  `docs/spec/agent-event-log-rendering.md`): the run's `past_chats` reads →
  reasoning → `node_*` writes → result are the channel's content. (This requires
  Dream to run as a **top-level run** in the channel, not a child run — see
  *Run-as-transcript* below.)
- Replace the **opaque seq-watermark** source model with **date windows** the
  user can actually understand and steer, and let the user launch a manual Dream
  over any window with optional guidance ("常梦常新" — re-dreaming a window is
  allowed, not gated).
- Finish the #302 teardown: now that durable memory is the `#d-*` outliner nodes
  and Dream activity has a channel home, **delete the legacy believer-pool memory
  projection and the Settings → Memory category**. The pool is the **per-principal
  `memory/events.jsonl` projection + its memory API** inside `AgentEventStore`
  (`recordMemoryEpisode` / `listMemoryEntries` / `updateMemoryEntry` /
  `removeMemoryEntry` / `appendDreamCompleted` / `readDreamState` / …, `:754–1037`)
  — **not** the `AgentEventStore` class itself, which also stores every
  conversation's events, run streams, payloads, run-meta, and index and stays. That
  pool is **dual-purpose** — a vestigial memory-entry half (Settings-only) *and* a
  load-bearing dream-state half (the watermark + `lastSuccessAt`, read by
  scheduling / readiness / history). The clean teardown is not to migrate the
  dream-state half but to **eliminate stored dream-state**: once the Dream channel
  is the source of truth, the cursor is derived from it and the whole memory
  projection is dead (see *Date windows* below).

## Non-goals

- **Not a chat.** The Dream channel is not a place to converse with Neva. Its
  composer is a structured Dream launcher (date range + guidance + run), not a
  message box. The agent never "replies" there.
- **Not a second memory store.** Durable memory *content* stays the `#d-*`
  outliner timeline nodes (the truth source). The channel is the **activity view**
  of consolidation runs: it is authoritative for the *run history* (and hence the
  derived "last dreamed" frontier), but holds nothing authoritative about memory
  *content* beyond what the runs themselves wrote into the outliner.
- **No multi-agent re-introduction.** The Dream channel is a single-agent
  channel like every other (`isChannelConversationId`, members `{user, Neva}`);
  this does not revive coordinator/`@`-routing/activity-surface apparatus.
- **No migration.** Pre-release: on any format/store change, wipe
  `~/.lin-outliner-*` dev userData rather than ship a reader.

## Design

### The Dream channel

A **second default channel** alongside General, created on first launch the same
way General is restored (`restoreOrCreateGeneralChannel`). It is a normal
id-namespaced single-agent channel (`lin-agent-channel-dream`, members
`{user, Neva}`) so it reuses the whole channel container — list entry, transcript
renderer, persistence — with **no new conversation primitive**.

What makes it special is presentation, driven off its channel id:

- **No chat composer.** In place of the message composer it shows a **structured
  Dream launcher** (below). This is a small **new** per-channel-id branch at the
  composer mount (`AgentChatPanel.tsx:~1407`, `conversationId` already in scope) —
  *not* an existing seam: `usesChannelActivitySurface()` (`agentChannel.ts:33`) is
  dead code from the single-agent collapse (always `false`, zero call sites), so
  there is nothing to "ride".
- **Run-as-transcript (Dream is a top-level run).** Each Dream run is a persisted
  turn in this channel rather than a create→delete transient, and it runs as a
  **top-level run anchored to the Dream channel** — *not* a parentless child run.
  This is load-bearing: today a parentless child run renders only as a single
  `kind:'child-run'` **boundary row** (a clickable summary), its full ledger fetched
  separately into `AgentChildRunDetailsPanel` (`agentRenderProjection.ts:~538`,
  `AgentChildRunDetailsPanel.tsx:~230`) — which would give a summary, not
  transparency. As a top-level run the process renders **inline** like any agent
  turn: an anchoring "user message" (the launch, serialized — see below) followed by
  the run's real process — `past_chats` reads, reasoning rows,
  `node_create`/`node_edit`/`node_delete` writes, and the final result. The #312
  renderer then renders it with no Dream-specific work: the process **is** the
  transcript; we render what is already recorded, we do not summarize it into a feed.

### The structured Dream launcher (manual runs)

The launcher is the channel's composer-replacement and the user-friendly front
end. It collects, with visible controls:

- a **date range** (a date-range picker, defaulting to "since last dreamed → now"
  — a one-click quick dream; expand to pick any window), and
- optional **guidance** text ("重点关注 X，忽略 Y"), and
- a **Dream** button.

On submit it (1) **serializes the inputs into the anchoring message** for the run
— a human-readable line such as `Dream · 2026-06-01 → 2026-06-07 · 重点关注 X` —
which is what renders as the turn's "user message", and (2) launches the run with
those parameters.

**Slash command vs structured launcher** is a *front-end* choice, not a mechanism
choice. The launcher is the primary, discoverable surface (a date picker beats
typing a `start/end` string and directly delivers the "users understand dates,
not watermarks" win). Under the hood the inputs map to the dream invocation's
parameters; our skill system already supports arguments end-to-end
(`agentSkills.ts` `parseSkillSlashCommand`, `substituteArguments`, `$ARGUMENTS`,
`argument-hint`, `userInvocable`), so a typed `/dream start/end guidance` path
can ride the same wiring later if wanted, but is **not required** for v1 and is
explicitly out of the "no chat" composer.

### Date windows, and eliminating the stored watermark

Today the source scope is a seq-watermark (`collectDreamConversationInputs`'
`fromSeqExclusive`, the seq stored in the believer pool's dream-state and read
through `collectDreamEvidence`): watermarked content is consumed once and **can
never re-enter** a future run. Two problems the user named: (1) users understand
dates, not seq numbers, and (2) hard-gating already-consumed chat conflicts with
reconsolidation — re-dreaming a window in light of newer context is *desirable*
("常梦常新").

The scope becomes a **date range**, day-granularity (enough because the cadence
is daily and memory is organized into per-day `#d-memory` containers; sub-day seq
precision is not needed for the auto frontier). `buildMemoryDreamPrompt` /
`collectDreamConversationInputs` change from "since watermark seq" to "within
[start, end] dates"; the prompt still passes only source *pointers* — the agent
reads content via the `past_chats` tool, never inlined.

**Date → seq mapping (the evidence layer stays seq-based).** Evidence collection
and the `past_chats` source read are seq-ranged, not date-ranged
(`extractMemoryStreamEvidence` `agentDreamExtraction.ts:~366`; `readSource`
`agentPastChats.ts:~395`). A date window must therefore be **translated to a seq
range** before it reaches them. Pin the semantics up front: **local-day**
boundaries (`yesterday` is a user-facing local-calendar concept), inclusive
`[start, end]`, and the translation must clamp by event **timestamp** (not just
seq) so a seq range straddling a day boundary cannot pull an out-of-window message
in.

**The frontier is derived from the Dream channel, not stored.** Auto-run still
needs to tell **new days** from already-covered ones — but that information is
already in the channel once every run is a persisted turn whose anchor records the
window it covered. So instead of relocating the watermark to a new store, we
**eliminate stored dream-state**:

> **`last-dreamed-through` = the max covered-window `end` across the Dream
> channel's *cleanly completed* run turns that the frontier trusts (scheduled
> turns by default — see Open question 4).**

A purely derived cursor (single source of truth — it cannot drift from the
channel's actual content); optionally cached as a thin field only if a
scheduling-scan cost ever shows up (A9 — measure first). This is the move that
makes the believer pool fully deletable: its dream-state half stops being
authoritative.

- **User-legible** ("last dreamed through 2026-06-07") — it *is* the latest Dream
  turn's end date.
- **A default frontier, not a hard gate.** It sets where the *next auto-run*
  starts and seeds the *manual* quick-dream default range; it **never forbids**
  re-dreaming behind it.

**Auto vs manual — who moves the frontier (the crux of "which days to include"):**

- **Scheduled (auto) run** dreams `[cursor + 1 day .. yesterday]` (a multi-day
  catch-up window if the app was closed for days), then — by virtue of writing a
  turn that covers through yesterday — the derived cursor advances to yesterday on
  its own. There is no separate "advance the cursor" write.
- **Manual run** dreams whatever window the user picks — including fully behind
  the cursor — and (recommended for v1, Open question 4) does **not** move the
  frontier: the cursor derives over cleanly-completed *scheduled* turns only, so a
  narrowly-guided manual re-dream ("重点关注 X") never makes the comprehensive
  nightly pass skip a day. 常梦常新 re-dreams never corrupt the auto frontier.

**Preserve from #319:** a truncated run (maxTurns / context overflow — the
`incomplete` flag set in `agentDelegation.ts`) must **not** advance the frontier.
Derive over `completed && !incomplete` turns only, so the truncated-empty-retry
semantics #319 shipped survive unchanged.

**Requires (protocol surface — interface-first):** the covered window must persist
as **structured metadata** (`{ start, end }`), not only the human-readable string
`Dream · A → B`. There is no field for it today, so add `window?: { start, end }`
to the existing **`dream.finished`** event (`agentEventLog.ts:~1034`) — it already
carries `trigger` / `status` / `startedAt` / `completedAt` / `changes`, making it
the single record the cursor and `lastSuccessAt` derive from
(`status === 'completed' && trigger === 'schedule'`). The `user_message.created`
anchor (`:~720`) has no metadata field and is *not* the home. Changing the event
shape is a coordinated `agentEventLog.ts` change.

### Scheduled (automatic) runs

Auto-run is retained (Open question 1 — resolved 甲). A scheduled run posts into the same
channel with a **synthetic anchor message** (`Scheduled Dream · [range]`, no user
author) and the same full-process transcript below it; manual and scheduled runs
are just two sources of the same channel entry shape.

**Frequency becomes user-configurable.** Today the cadence is the fixed constant
`DEFAULT_DREAM_SCHEDULE` (`'2026-01-01T03:00 RRULE:FREQ=DAILY'`). Expose a
frequency control (reuse the scheduled-routine surface) so the default range and
cadence are user settings, not a hard-coded constant.

### Retire Settings → Memory and the believer pool

With memory living in the `#d-*` outliner nodes and Dream activity in the
channel, the Settings Memory surfaces are vestigial. The believer-pool
`AgentEventStore` (`src/main/agentEventStore.ts`) does two jobs, so the teardown
is precise:

- **Memory-entry half — vestigial, safe to delete.** The Memory pane (`listMemory`
  → `getEventStore().listMemoryEntries`, `agentRuntime.ts:~1133`; entry edit via
  `updateMemoryEntry` / `removeMemoryEntry`, plus the `startEditMemory` /
  `memoryDraftFact` plumbing) is the **only** reader/writer of the pool's memory
  entries. Recall is pull-only via `node_search` / `node_read` over the `#d-*`
  nodes Dream writes (`buildMemoryDreamPrompt`, `agentRuntime.ts:~7553`) and never
  touches the pool; `queryMemoryEntries` / `activateMemoryEntries` have **zero**
  production call sites. So the memory-entry API + Settings Memory category +
  `agent_list_memory` (+ update/forget) commands delete cleanly.
- **Dream-state half — load-bearing until PR2.** The same projection also holds the
  dream-state (`appendDreamCompleted` `:869` writes it; `readDreamState` `:902` is
  read by `fireDreamForPool` scheduling `:3457`, `previewDreamReadiness` `:3794`,
  and `collectDreamTasks` `:3764` for Dream history). It carries **two** scheduler
  inputs beyond the cursor: `lastSuccessAt` (drives `shouldFireDateSchedule`) and —
  separately — the per-due "already attempted" guard, which already lives in **run
  meta** (`hasScheduledDreamAttemptForDue` → `listPrincipalRunMetaProjections`
  `:3488`), *not* the memory projection, so it survives the teardown untouched. PR2
  must therefore re-derive only `lastSuccessAt` (= max `completedAt` over the
  channel's `status === 'completed'` `dream.finished` events). The dream-state is
  **not** orphaned today — which is why deleting the projection is an **escalation,
  not a drive-by** until cursor + `lastSuccessAt` derive from the channel (PR2) and
  Dream history is the channel feed (PR1). After PR1 + PR2 the projection is dead and
  **deleted** — the `AgentEventStore` *class* stays (it still stores conversation
  events / run streams / payloads / run-meta / index). No relocation, no migration
  (pre-release: wipe `~/.lin-outliner-*`).
- Touches `src/core/commands.ts` (protocol surface) — land interface-first and
  coordinate per the infrastructure-ownership rule. Core tests that exercise the
  pool (`tests/core/agentEventStore.test.ts`, ~250 lines of memory-entry cases) are
  removed with it.

## Shape

**(b) A SET of independent complete features**, ordered by genuine dependency.
Each PR is shippable and reviewable on its own — none is a scaffold a later PR
"fills in".

- **PR1 — Dream channel + persisted full-process transcript.** Add the dedicated
  Dream channel; **run Dream as a top-level run anchored to it** (not a parentless
  child run) so the #312 renderer shows the process **inline**, not a child-run
  boundary summary; persist the run instead of create→delete; relocate Dream history
  here; add `window?: { start, end }` to the `dream.finished` event and stamp each
  run's covered window on it (protocol — interface-first). Keep the existing
  `agent_run_dream_now` trigger and the seq-watermark **unchanged** (it still drives
  scope this PR). *Complete feature:* Dream has a transparent, persistent home. UI
  gate = light/dark visual.
- **PR2 — Date-window invocation + derived cursor + launcher + frequency.** Switch
  scope to date ranges via a **date→seq translation** over the still-seq-based
  evidence / `past_chats` layer (local-day, inclusive, no out-of-window leak);
  **derive both the "last dreamed" cursor and `lastSuccessAt` from the channel's
  `dream.finished` events and stop reading `readDreamState`** (this is what frees
  PR3 — the per-due attempt guard already lives in run meta and is untouched); build
  the in-channel structured launcher (date range + guidance → serialized anchor);
  make frequency user-configurable. Preserve the #319 `incomplete` gate (derive over
  cleanly-completed turns only). The composer-swap is a **new** per-channel-id branch
  (`usesChannelActivitySurface()` is dead code), not an existing seam. *Depends on
  PR1* (needs the channel + `dream.finished.window`). UI gate = light/dark visual.
- **PR3 — Delete the believer-pool memory projection + Settings Memory.** Remove the
  Settings Memory category, the `agent_list_memory` (+ update/forget) commands, the
  memory-edit plumbing, and — now that PR2 derives cursor + `lastSuccessAt` from the
  channel — the **per-principal memory projection + its memory API inside
  `AgentEventStore`** (`:754–1037`) plus the pool-only core tests. **Keep the
  `AgentEventStore` class** (it still stores conversation events / run streams /
  payloads / run-meta / index). *Depends on PR2* (**not** parallel: the dream-state
  is live until PR2 derives off the channel). Touches `commands.ts` —
  **interface-first, coordinate**.

## Open questions

1. **Auto-run: keep or drop? — resolved 甲 (PM-ratified).** Keep scheduled
   auto-run **and** add the manual launcher as a steering override. Unattended
   consolidation stays — it is the core "sleep-style" premise (固化 is involuntary,
   not user-triggered); the launcher steers a specific window. The auto-run default
   window is `[derived cursor + 1 day .. yesterday]`. 乙 (purely on-demand, no
   scheduler) is the path not taken — simpler, but loses unattended upkeep.
2. **One Dream channel, or per-window threads?** Working assumption: a single
   `lin-agent-channel-dream` with each run as a turn. Per-window separate channels
   are rejected as clutter unless a reason emerges.
3. **Believer-pool deletion blast radius — resolved by inspection.** The
   *memory-entry* readers are Settings-only and recall is pool-independent
   (`node_search` / `node_read`; `queryMemoryEntries` / `activateMemoryEntries` are
   dead), so that half deletes cleanly. The real coupling is the *dream-state* half
   (`readDreamState` / `appendDreamCompleted` — the watermark, read by scheduling /
   readiness / history), which is why PR3 is sequenced **after** PR2's derived
   cursor rather than parallel to it. No remaining open risk; the "escalation vs
   drive-by" question is answered by the PR2 → PR3 ordering.
4. **Should a frontier-reaching manual dream advance the cursor?** Recommend **no
   for v1**: derive the cursor over cleanly-completed *scheduled* turns only (a
   one-line `trigger === 'schedule'` predicate on the derivation). A manual run can
   be narrowly guided ("重点关注 X"), so letting it satisfy the comprehensive
   nightly frontier would make auto-run skip a day it never fully consolidated; a
   redundant re-dream is cheap and on-theme for 常梦常新. Note the derived-cursor
   reframe *inverts the cost*: "all completed turns advance" is now the zero-code
   default and "scheduled-only" is the (recommended) one-predicate filter — the
   opposite of the old stored-cursor model. Revisit if the redundancy cost shows up.

## Build checklist

- [ ] PR1: Dream channel id + default-restore (parallel to
      `restoreOrCreateGeneralChannel`, `agentRuntime.ts:~868`); **run Dream as a
      top-level run anchored to the channel** (not a parentless child run) so the
      process renders inline, not a `child-run` boundary summary; persist the run
      (drop create→delete `:3659` / `:3694`); add `window?:{start,end}` to
      `dream.finished` (`agentEventLog.ts:~1034`, interface-first) + stamp it;
      relocate Dream history; light/dark visual gate.
- [ ] PR2: date→seq translation feeding the still-seq evidence/`past_chats` layer
      (`agentDreamExtraction.ts:~366`, `agentPastChats.ts:~395`; local-day,
      inclusive, no out-of-window leak); derive cursor **and** `lastSuccessAt` from
      the channel's `dream.finished` events (drop `readDreamState`; the per-due guard
      stays in run meta `:3488`; keep the #319 `incomplete` gate); structured
      launcher — composer-swap is a **new** per-channel-id branch at
      `AgentChatPanel.tsx:~1407` (`usesChannelActivitySurface()` `agentChannel.ts:33`
      is dead code, always `false`), not a seam; user-configurable frequency (confirm
      a reusable scheduled-routine surface exists, else this is more than a config
      toggle); light/dark visual gate.
- [ ] PR3: interface-first `commands.ts` change; delete the **memory projection +
      memory API inside `AgentEventStore`** (`:754–1037`) — **keep the class** —
      `agent_list_memory` (+ update/forget) + memory-edit plumbing + Settings Memory
      category + pool-only core tests; **after PR2** (cursor + `lastSuccessAt` no
      longer read the projection); wipe dev userData (no migration).
