# Dream Channel & Memory Retire

Make Dream — the memory-consolidation run — **transparent** to the user by
giving it a dedicated channel that shows each run's complete process, and retire
the now-vestigial Settings Memory surfaces left over from the #302 teardown.

## Goal

- Dream is currently invisible: it runs in a transient conversation that is
  **created then deleted** (`agentRuntime.ts` `runMemoryDreamChildAgent` /
  `cleanupMemoryDreamChildRun`, ~`:3626`/`:3661`), so the user never sees what it
  read, how it reasoned, or what it wrote. Make every run land in a **persistent
  Dream channel** rendered as the existing agent transcript (the #312 renderer,
  `docs/spec/agent-event-log-rendering.md`): the run's `past_chats` reads →
  reasoning → `node_*` writes → result are the channel's content.
- Replace the **opaque seq-watermark** source model with **date windows** the
  user can actually understand and steer, and let the user launch a manual Dream
  over any window with optional guidance ("常梦常新" — re-dreaming a window is
  allowed, not gated).
- Finish the #302 teardown: now that durable memory is the `#d-*` outliner nodes
  and Dream activity has a channel home, **delete the legacy believer-pool store
  and the Settings → Memory category** that still read it.

## Non-goals

- **Not a chat.** The Dream channel is not a place to converse with Neva. Its
  composer is a structured Dream launcher (date range + guidance + run), not a
  message box. The agent never "replies" there.
- **Not a second memory store.** Durable memory stays the `#d-*` outliner
  timeline nodes (the truth source). The channel is the **activity view** of
  consolidation runs, not a store; it holds the run transcripts, nothing
  authoritative beyond what the runs themselves wrote into the outliner.
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
  Dream launcher** (below). `usesChannelActivitySurface()`-style id-conditioning
  already exists as the seam for per-channel behavior.
- **Run-as-transcript.** Each Dream run is a persisted conversation turn in this
  channel rather than a create→delete transient. The run renders as the existing
  agent transcript: an anchoring "user message" (the launch, serialized — see
  below) followed by the run's real process — `past_chats` tool reads, reasoning
  rows, `node_create`/`node_edit`/`node_delete` writes, and the final result.
  Reusing the #312 renderer is the whole point: the process **is** the transcript;
  we render what is already recorded, we do not summarize it into a feed.

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

### Date windows, and the marker the watermark becomes

Today the source scope is a seq-watermark (`collectDreamConversationInputs`'
`fromSeqExclusive`): watermarked content is consumed once and **can never
re-enter** a future run. Two problems the user named: (1) users understand dates,
not seq numbers, and (2) hard-gating already-consumed chat conflicts with
reconsolidation — re-dreaming a window in light of newer context is *desirable*
("常梦常新").

But auto-run still needs to tell **new days** from already-covered ones, or the
nightly run either re-grinds everything or has no default window. So the marker
does **not** disappear — it **changes role**:

- **From a seq number to a date (day-granularity) cursor.** User-legible ("last
  dreamed through 2026-06-07"). Day granularity is enough because the cadence is
  daily and memory is organized into per-day `#d-memory` containers; sub-day seq
  precision is not needed for the auto frontier — so the cursor drops seq
  entirely.
- **From a hard gate to a default frontier.** The cursor sets where the *next
  auto-run* starts and seeds the *manual* quick-dream default range. It **never
  forbids** re-dreaming behind it.

Run scope is then a **date range** (`buildMemoryDreamPrompt` /
`collectDreamConversationInputs` change from "since watermark seq" to "within
[start, end] dates"); the prompt still passes only source *pointers* — the agent
reads content via the `past_chats` tool, never inlined.

**Auto vs manual — who owns the cursor (the crux of "which days to include"):**

- **Scheduled (auto) run** dreams the days between the cursor and yesterday, then
  **advances the cursor** to yesterday. The cursor is precisely the auto path's
  answer to "which days are new".
- **Manual run** dreams whatever window the user picks — including fully behind
  the cursor — and **does not move the cursor**. It is a reconsolidation overlay,
  not auto-progress, so 常梦常新 re-dreams never corrupt the auto frontier.

So what we *remove* is the watermark's **consumed-once hard-gate semantics**;
what we *keep* is a legible forward date cursor that **only the auto path
advances**.

### Scheduled (automatic) runs

Auto-run is retained (see Open question 1). A scheduled run posts into the same
channel with a **synthetic anchor message** (`Scheduled Dream · [range]`, no user
author) and the same full-process transcript below it; manual and scheduled runs
are just two sources of the same channel entry shape.

**Frequency becomes user-configurable.** Today the cadence is the fixed constant
`DEFAULT_DREAM_SCHEDULE` (`'2026-01-01T03:00 RRULE:FREQ=DAILY'`). Expose a
frequency control (reuse the scheduled-routine surface) so the default range and
cadence are user settings, not a hard-coded constant.

### Retire Settings → Memory and the believer pool

With memory living in the `#d-*` outliner nodes and Dream activity in the
channel, the Settings Memory surfaces are vestigial:

- **Dream history** (`AgentSettingsView` `DreamHistoryGroup` /
  `agentListDreamHistory`) is now the channel feed — remove it from Settings.
- **The Memory pane** (`listMemory` → `getEventStore().listMemoryEntries`,
  `agentRuntime.ts:~1115`, plus the `startEditMemory` / `memoryDraftFact` edit
  plumbing) reads the **believer-pool event store**, which is **separate** from
  the `#d-*` nodes Dream writes (`agentRuntime.ts:~7536`). Recall is already
  pull-only via `node_search` / `node_read`, so the pool is no longer a source of
  truth. Confirm nothing else reads it, then **delete the pool store + the
  `agent_list_memory` command + the memory-edit plumbing + the Settings Memory
  category**. This finishes the "believer-pool store still ships under the hood"
  teardown noted on the #302 board item.
- Touches `src/core/commands.ts` (protocol surface) — land interface-first and
  coordinate per the infrastructure-ownership rule.

## Shape

**(b) A SET of independent complete features**, ordered by genuine dependency.
Each PR is shippable and reviewable on its own — none is a scaffold a later PR
"fills in".

- **PR1 — Dream channel + persisted full-process transcript.** Add the dedicated
  Dream channel; persist the run conversation instead of create→delete; render it
  with the #312 transcript renderer; relocate Dream history here; keep the
  existing `agent_run_dream_now` trigger and the watermark **unchanged**.
  *Complete feature:* Dream now has a transparent, persistent home. UI gate =
  light/dark visual.
- **PR2 — Date-window invocation + structured launcher + frequency.** Replace the
  watermark with date-range scope computation and the visible "last dreamed"
  cursor; build the in-channel structured launcher (date range + guidance →
  serialized anchor message); make frequency user-configurable. *Depends on PR1*
  (needs the channel + persisted transcript). UI gate = light/dark visual.
- **PR3 — Retire Settings Memory + believer pool.** Remove the Settings Memory
  category and delete the believer-pool store + `agent_list_memory` + memory-edit
  plumbing. *Depends on PR1* (channel is the replacement history surface); can
  land in parallel with PR2. Touches `commands.ts` — **interface-first,
  coordinate**. Escalate the "delete the pool outright" call if anything still
  reads it.

## Open questions

1. **Auto-run: keep or drop?** (Directional — PM ratifies.)
   - *甲 (recommended):* keep scheduled auto-run **and** add manual override.
     Consolidation still happens unattended; the launcher is for steering a
     specific window. Requires the "last dreamed" cursor as the auto-run default.
   - *乙:* purely on-demand — no scheduler; Dream only runs when the user launches
     it. Simpler, but loses unattended upkeep.
   The plan is written to accommodate either; 甲 is the working assumption.
2. **One Dream channel, or per-window threads?** Working assumption: a single
   `lin-agent-channel-dream` with each run as a turn. Per-window separate channels
   are rejected as clutter unless a reason emerges.
3. **Believer-pool deletion blast radius.** PR3 assumes only the Settings pane
   reads the pool. Verify no recall/extraction path still depends on
   `listMemoryEntries` before deleting; if one does, that's an escalation, not a
   drive-by.
4. **Should a frontier-reaching manual dream advance the cursor?** If a manual
   run happens to cover cursor→now, advancing the cursor would stop that night's
   auto-run re-dreaming the same span. Recommend **no for v1** (only auto
   advances — simplest, and a redundant re-dream is cheap and on-theme for
   常梦常新); revisit if cost shows up.

## Build checklist

- [ ] PR1: Dream channel id + default-restore; persist run conversation
      (drop create→delete); render run-as-transcript; relocate Dream history;
      light/dark visual gate.
- [ ] PR2: date-range scope in `buildMemoryDreamPrompt` /
      `collectDreamConversationInputs` (replace watermark seq with a
      day-granularity date cursor — auto advances it, manual does not); structured
      launcher UI + serialized anchor message; user-configurable frequency;
      light/dark visual gate.
- [ ] PR3: interface-first `commands.ts` change; delete believer-pool store +
      `agent_list_memory` + memory-edit plumbing + Settings Memory category;
      confirm no remaining readers; wipe dev userData (no migration).
