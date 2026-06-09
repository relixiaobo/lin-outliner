# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Fixed

- **Tenon shows its dock icon again (fast-track)** — the packaged app ran in macOS "accessory" activation
  policy (window + menu bar present, but no dock icon and no ⌘Tab entry) — a side effect of the always-present
  non-activating launcher NSPanel. The prior `app.dock.show()` re-assert did not restore it (that API only
  un-does an explicit `dock.hide()`); replaced with `app.setActivationPolicy('regular')` right after the
  launcher is created, which forces the app back to a regular foreground app. Verified by typecheck; the dock
  icon itself needs a one-time packaged-build eyeball (same as the ⌘Q fix).
- **First ⌘Q quits the packaged app (PR #170)** — the prewarmed global launcher window called
  `setVisibleOnAllWorkspaces(true)` at creation and kept it forever, even while hidden; a window that
  permanently joins all Spaces makes AppKit skip `applicationShouldTerminate:` on the first ⌘Q, so the
  `before-quit` flush never fired and the app needed two presses. The all-Spaces (incl. other apps'
  full-screen) collection behavior is now toggled **only while the launcher is visible** — set in
  `showLauncherWindow`, cleared in `hideLauncherWindow` (every dismissal routes through it) — so the common
  quit path (launcher hidden) is free of the bug, while cross-Space float is unchanged while it is open.
  Gate: `/code-review` + hide/show path audit (sole `.hide()` / `setVisibleOnAllWorkspaces` callers) +
  typecheck + `test:core` 766/0; the packaged first-⌘Q outcome still needs a one-time manual eyeball on the
  `.dmg`. ([#170](https://github.com/relixiaobo/lin-outliner/pull/170))

### Internal

- **Redirect `agent-task-model` → fold post-#167 cleanup into the conversation model (PR #168)** — docs-only.
  A drafted standalone "dissolve subagent into Agent(profile)+Task(run)" plan was reviewed and found to
  reinvent the already-approved, in-progress agent program (`agent-program` M0–M3 / `agent-conversation-model`
  / `agent-data-model`) and to conflict with several ratified decisions. **Redirected:**
  `docs/plans/agent-task-model.md` archived as `status: superseded` (slimmed to the path-not-taken record +
  a verified conflict table), and only the sound post-#167 kernel folded into `agent-conversation-model.md`
  §Code mapping as a **bounded CLEAN-CUT** note — retire `general` (empty-body built-in post-#167, redundant
  with the primary identity run fresh), `fork` as a context *mode* (not a pseudo-`AgentDefinition`), and drop
  the `Agent` tool's per-call `model`/`effort` overrides (capability is profile-only). Bounds held at the
  gate: no stored conversation `kind` (F2), no redesign of the protected `agentSubagentIdentity.ts` /
  `agentSubagentTranscript.ts` seams, "Task" stays the off-floor `background` run (`RunMeta.kind`), the
  model-facing rename is contract + UX only (storage names may stay), and any identity-string change (e.g.
  retiring `general`'s owner key) is a dev-`userData` wipe — not a no-op rename. No code or spec change.
  ([#168](https://github.com/relixiaobo/lin-outliner/pull/168))

- **Revise agent memory planning toward the target write/read surface (PR #157)** — docs-only plan
  adjustment (PM-ratified 2026-06-07) across four `docs/plans/*.md`, no production or spec change. Pins two
  decisions for the M2 build. **Write authority — DECIDED:** the durable memory line is written by exactly
  two runtime-owned writers (Settings/Profile UI for explicit edits, Dream/extraction for automatic
  consolidation); there is no model-visible memory write tool and no synchronous foreground "remember this"
  path. **Read surface — DECIDED:** a single model-visible read-only `recall` tool over durable memory (no
  model-visible `past_chats` and no second chat-search tool); `include_evidence` defaults to false and, when
  true, returns raw conversation/run excerpts only as an `evidence[]` field nested under the matching
  `MemoryEntry` (never a sibling in the ranked list, expandable only through the entry's provenance), with
  `status:'invalidated'` filtering, isolation-tier enforcement, and a `max_chars` cap. States the accepted
  consequence explicitly: old conversations Dream never distilled into a `MemoryEntry` are not
  foreground-recallable by design. Spec left untouched on purpose (A6 — current code still ships the inline
  memory tool / `past_chats`; reconcile in the M2 implementation PR).
  ([#157](https://github.com/relixiaobo/lin-outliner/pull/157))

- **Close agent M1 tail verification + plan hygiene (PR #156)** — no production code: added e2e coverage for
  the pending `ask_user_question` card (light/dark `prefers-color-scheme`, real `user_question_request` event
  path + `agent_resolve_user_question` submit) and for the Settings Memory view/edit/forget pane
  (`agent_list/update/forget_memory` IPC + renderer-mock support); marked the M1 "Profile UI" and
  "visual verification" checklist items done; archived the completed `agent-tool-permissions-hardening` plan
  (`status: done`) and repointed its references. ([#156](https://github.com/relixiaobo/lin-outliner/pull/156))

### Changed

- **Auto-initialize field config is one multi-select picker (PR #169)** — a `date` field's Auto-initialize
  strategies previously rendered as several identical-looking "No" switches (the strategy name lived only in an
  invisible `aria-label`); they now collapse into a single multi-select picker (closed: the chosen strategies
  inline; open: a checklist that toggles membership without closing). Implemented as an additive, gated
  `multiple` mode on the shared `NodeValuePicker` — the single-select callers pass no new props and are
  unchanged. Also fixes a **silent data-loss bug** found at the gate: changing a field's type left stored
  strategies the new type doesn't offer lingering invisibly, to be dropped on the next unrelated edit — now
  `setFieldConfig` prunes auto-init strategies to the new type's valid set at the core seam (the deep fix), not
  just in the picker. The on-disk value contract (comma-joined strategy string) is unchanged.
  ([#169](https://github.com/relixiaobo/lin-outliner/pull/169))

- **Runtime-owned Dream memory extraction, per-turn slice (PR #159)** — the automatic half of the #157 M2
  write authority. After each completed foreground run, a runtime-owned worker (`agentDreamExtraction.ts` +
  `AgentRuntime` wiring) sends the raw current-turn evidence (user/assistant/tool messages, not summaries)
  plus the currently visible memory through a bounded no-tools model completion, then applies the proposed
  add/update/forget actions to the durable memory event store with `conversationId`/`messageRange`/`runId`/
  `eventId` provenance. It is fire-and-forget after the turn emits idle (a Dream failure can never break the
  foreground turn), serialized on one runtime queue, and bounded (≤5 actions, fact-length clamp, transcript
  char budgets). Isolation is enforced on the write path: `read-only-global` runs no extraction (facts learned
  in a workspace don't enter the global pool), `isolated` only reads/updates/forgets memory scoped to the
  session's `originWorkspace`, and `add` tags the originWorkspace while `update` preserves the entry's own.
  Injected `<agent-memory>` reminders are filtered out of the evidence (no self-feedback loop). The secret/
  credential capture surface is guarded only by the extractor prompt — a PM-accepted, prompt-level decision
  (2026-06-07) matching the runtime-owned write design, with a defense-in-depth code guard backlogged as
  `agent-dream-secret-redaction` (P3). This is the per-turn slice only; time/activity/lock-gated offline
  consolidation (`autoDream`) and the task panel remain later P2/P3 work. Gate: typecheck + `test:core` 661/0
  (incl. runtime isolation/`read-only-global`/no-op-update regression tests + a new `agentDreamExtraction`
  unit suite); two high-effort finder passes (security + correctness) cleared, two low correctness findings
  (provenance run-boundary, no-op update churn) fixed before merge. ([#159](https://github.com/relixiaobo/lin-outliner/pull/159))

- **Agent memory recall clean cut: one read-only `recall` tool (PR #158)** — implements the #157 M2 decision.
  Removed the two model-visible memory tools from the foreground agent pool — the `memory` CRUD tool
  (`agentMemoryTool.ts`, deleted) and the `past_chats` tool (`agentPastChatsTool.ts`, deleted) — and replaced
  them with a single read-only `recall` tool (`agentRecallTool.ts`) over active durable memory entries.
  `recall` reads only `status:'active'` entries, enforces the agent's `memoryIsolation` tier (`isolated`
  retrieves only entries whose `originWorkspace` matches the session — unscoped and other-workspace entries
  are excluded), bounds results by `limit` (default 8 / max 20), and optionally expands raw evidence only
  when `include_evidence:true` — nested under the matching entry and resolved solely from that entry's
  recorded `MemoryEntry.sources`, never via a free-text transcript search, within a shared `max_chars` budget
  (default 4000 / max 12000). The internal `agentPastChats` evidence search is retained as `recall`'s
  backing service (no longer model-visible); Settings/Profile list/edit/forget remain the human write path.
  Permission surface is a net reduction: the writable `agent.memory.manage` (auto-allowed) is replaced by
  read-only `agent.memory.recall` (`accessScope:'none'`, no external effect), and `memory` is dropped from the
  control/auto-allow mutation sets — A3 intact. Prompt guidance, tool-call UI label/icon (`recall` →
  `BrainIcon`), i18n (en + zh-Hans), and the active specs (`agent-tool-design.md`, `agent-progress.md`, et al.)
  were updated in the same change (A6). Gate: typecheck + `test:core` 655/0 (incl. a new runtime isolation
  regression test asserting `isolated` recall excludes other-workspace/unscoped/invalidated entries) +
  `test:renderer` 354/0; two high-effort finder passes (removal-completeness + recall correctness/security)
  returned no findings. ([#158](https://github.com/relixiaobo/lin-outliner/pull/158))

- **Guide agent memory use in the system prompt (PR #155)** — added a stable `Memory` section to the Tenon
  agent system prompt: use the `memory` tool for concise durable facts / stable preferences / corrections
  that should carry forward; treat `<agent-memory>` as background context (not user-authored instructions);
  update or forget a remembered fact when the user corrects it; and do NOT store transient task state, raw
  conversation summaries, secrets/credentials, guesses, or current-conversation-only facts (use `past_chats`
  for raw prior-conversation recall). Closes the M1 "inline memory write instructions in the agent prompt"
  checklist item. Gate: typecheck + `agentSystemPrompt.test.ts` 3/0 (tool names + tag verified against the
  runtime). ([#155](https://github.com/relixiaobo/lin-outliner/pull/155))

- **Harden agent permission approval semantics (PR #154)** — removed conversation-scoped approval from the
  permission model: approval scopes are now only `once` / `always`, and stale conversation-shaped rule
  fixtures can no longer relax a configured/default `ask`. `approval.*` UI events and `tool.permission.*`
  policy events now share one `permission-<uuid>` request id so a single decision is joinable across both
  families — including the skill-shell path, which now emits the full `tool.permission.checked/resolved`
  pair (previously it surfaced only the UI half). Denied-reason strings are canonicalized to one contract
  (`configured_deny`, `policy_denied`, `classifier_blocked`, `classifier_unavailable`, `platform_hard_block`,
  `run_aborted`, `runtime`, `user_denied`) backed by a single `PERMISSION_DENIED_CONTRACT` table that drives
  `recoverable` / `resolvedBy` / `source` / `status` for every reason — so durable policy blocks
  (`tool_denied` / `tool_not_preapproved` → new `policy_denied`) are correctly non-recoverable, and the
  audit record can no longer contradict itself (e.g. a runtime denial is no longer logged as `user_once`).
  Gate: typecheck + `test:core` 662/0 + `test:renderer` 356/0 + 7-angle high-effort review → 7 findings, all
  fixed before merge (29dd688) with regression tests. ([#154](https://github.com/relixiaobo/lin-outliner/pull/154))

### Added

- **Scheduled command nodes (PR #165)** — a new `command` NodeType whose content is a natural-language brief
  to the agent; arming its schedule field (one field carrying both *when to start* and *how to repeat*, an
  endpoint + optional `RRULE`) makes it run on an anacron-style schedule, with **Run now** for manual fires.
  A fire spawns a triggered subagent run (optionally a chosen `commandAgent`) that posts back into a per-command
  delivery conversation, rendered with a subagent boundary. The **user-only bright line** (only the user can
  arm a schedule) is enforced inline in `setCommandSchedule`, keyed to the `node.type === 'command'` invariant.
  Review-gate hardening landed with it: **at-most-once crash recovery** (a `sysLastAttemptAt` marker persisted
  before the run + a startup reconciliation skips an interrupted occurrence instead of re-firing its
  non-idempotent side effects), the fire watermark is **agent-barred** (`markCommandFired`/`markCommandAttempted`
  reject `agent` origin — symmetric with the arm gate), failure **backoff is measured from the failure moment**
  (not the sweep start, so the 30s→1h ladder can't collapse into a 60s retry loop), and **unattended runs have
  no interactive approval channel** — a tool needing approval is denied-and-surfaced rather than hanging the
  unwatched run, while globally always-allowed tools still run. The agent-tool-host origin stamp was flipped to
  `{ ...meta, origin: 'agent' }` so a caller can never override the forced origin. Verified on the merged tree:
  typecheck + `test:core` 766/0 + `test:renderer` 389/0; merged with two trivial import-union conflicts
  resolved at the gate (it predated #166/#167). ([#165](https://github.com/relixiaobo/lin-outliner/pull/165))

- **Agent authoring & management (PR #167)** — create, edit, duplicate, enable/disable, and locate your
  own **agent definitions** (`AGENT.md` persona files) from Settings → Agents, without hand-editing files
  or restarting. One **Form ⇄ Raw editor** serves every agent (built-ins are read-only with "Duplicate to
  my agents"); you choose global (`~/.agents/agents`) vs workspace (`<project>/.agents/agents`) storage, and
  changes **hot-reload** into the subagent picker and list. A new `AGENT.md` format module
  (`src/core/agentMarkdown.ts`) round-trips the serialize/parse pair, and `disabledAgents` is now keyed on
  the full agent identity so same-named agents from different sources disable independently. The **model
  never reaches the write surface** — authoring is user-driven only (mirrors the closed memory-write
  surface). Also unifies the **subagent system prompt**: a fresh subagent now reuses the shared core of the
  main system prompt (capabilities / tool conventions / safety) plus a headless directive, and built-in
  `general` collapses to a zero-persona default. *Note:* re-keying `disabledAgents` from name to identity is
  a stored-settings change with no migration — a pre-existing disabled agent re-enables once (wipe dev
  `userData`), per the pre-release no-back-compat policy.
- **Agent notifications + off-floor attention delivery (PR #166)** — long-running background tasks and
  subagents no longer go silent. Per-conversation unread is event-sourced (`notification.created` /
  `notification.read`) and folded incrementally onto the persisted conversation index, so a badge is **seeded
  on launch** for listed conversations before they are reopened. Optional **OS banners** fire only from the
  main process (`new Notification` — the A2/A3 seam is untouched) behind a **default-OFF** opt-in preference
  (consolidated in `appPreferences.ts`), are suppressed only when the user can actually see the conversation
  (main layers a window-focus check over the renderer-reported **viewed conversation**, which is dock-open and
  CSS-collapse aware), and deep-link to the conversation on click. Durable mark-read is renderer-driven on
  genuine opens only (never a config reload), and its `notification.read` cursor takes `throughSeq` **inside**
  the serialized append so the incremental unread fold can never drift from the replay reducer when a delivery
  races a read. *Needs-input is intentionally deferred* — a subagent surfaces a clarification through its
  terminal result, not a mid-run prompt.
- **Agent-owned subagent memory + `dream` trigger tool (PR #164)** — extends the Dream milestone to
  subagents. Run records, task projections, tool results, and persisted transcript envelopes now carry an
  explicit **execution + memory-owner identity**: a fresh typed subagent routes its `<agent-memory>` reminder,
  `recall`, and scheduled Dream through the **called agent** owner (its own durable memory line); a fork keeps
  the **parent** owner and Dream skips the copied parent-context prefix via a persisted boundary index (not a
  content scan). Two new shared modules — `agentSubagentIdentity.ts` (single owner-resolution seam) and
  `agentSubagentTranscript.ts` (transcript decode + `${runId}:message:N` addressing) — single-source the logic
  across reminders, recall, and Dream; Dream watermarks and recall evidence key on the content-addressed
  `payloadId` and the Dream-pinned `source.eventId`. Adds a model-visible **`dream` tool** — a *trigger-only*
  request for a runtime-owned Memory Dream (the model cannot specify facts; `reason` is not accepted; gated
  `agent.memory.dream`, in `ALLOW_FORBIDDEN_ACTIONS`, always asks) — and a **Dream chat-feedback** boundary
  (`AgentDreamBoundary`) emitted by both `/dream` and the tool path. The memory-write surface stays closed
  (no model-written facts). Also invalidates shape-stale agent checkpoints to prevent a `dream.finished`
  tail-replay crash. Gate (two high-effort review rounds): all prior findings + three confirmed
  isolation/UX findings fixed (fresh-subagent workspace scope, multi-workspace Dream partition, benign
  concurrent-Dream skip, zh-Hans 886/886, `dream` boundary symmetry, dead `reason` removed) + a latent
  stale-checkpoint crash; typecheck + `test:core` 686/0 + `test:renderer` 361/0. Residual low items tracked in
  `agent-dream-followups` (f)/(g). ([#164](https://github.com/relixiaobo/lin-outliner/pull/164))

- **Agent Dream — scheduled reflective memory consolidation (PR #163)** — Dream prerequisite ③, the thin
  assembly that makes Dream a real, visible capability. Memory write-back now happens in an agent-level
  **reflective run** triggered by a built-in **daily schedule** or a manual **`/dream`** (replacing #159's
  per-turn inline extraction); during waking hours the agent still only reads durable memory. `fire(agent,
  source)` gates the run: a per-agent in-flight **lock**, **provider/online** check, a **1,000-rendered-char**
  new-evidence minimum on the auto path (`/dream` bypasses → consolidate-only when nothing is new). Evidence
  is raw conversation events since a **per-conversation watermark cursor** (persisted in a new `dream.completed`
  memory event with processed ranges + change counts); `memory.*`/`dream.*` are excluded so a Dream's own
  writes never re-trigger it. The run reuses #159's no-tools `completeSimple` + `applyDreamMemoryActions`
  (isolation/provenance/dedup intact: `read-only-global` writes nothing, `isolated` stays scoped). Dream runs
  are agent-anchored (`{ type: 'agent' }`, PR #162) and indexed in a per-agent run index, kept out of every
  conversation index/replay/delete cascade. The task panel gains a shared render task projection (`taskIds` +
  `entities.tasks`) and renders Dream as a **read-only** row (trigger · processed count · memory-change count
  · time); subagent open/stop stays subagent-only. Protocol additions are additive (`reflective` run kind,
  `schedule` trigger, `dream.completed`). Gate: typecheck + `test:core` 680/0 + `test:renderer` 358/0; four
  finder passes (gating/watermark, agent-anchored persistence, task projection, security/isolation) clean;
  light/dark visual verification; one visual finding (Dream meta row truncation) fixed before merge.
  Follow-ups tracked: Settings schedule UI, large-backlog chunking, precise cross-conversation provenance.
  ([#163](https://github.com/relixiaobo/lin-outliner/pull/163))

- **Generalize the agent run anchor (PR #162)** — Dream prerequisite ②, an interface-first protocol change
  on the agent run-meta surface. `AgentRunMeta` replaces its flat mandatory `conversationId` with the
  PM-ratified `anchor: AgentRunAnchor` discriminated union (`{ type: 'conversation'; agentId; conversationId }`
  | `{ type: 'agent'; agentId }`), plus a `conversationIdOfRun(meta)` accessor; `RunStartedEvent` gains an
  optional `anchor`. This lets a future agent-level Dream run exist without a fake `conversationId`. Behavior
  is fully neutral for every current run (all conversation-anchored): the store projection extends the core
  type, `normalizeRunMeta` keeps a legacy-read shim (old flat `conversationId` reads as a conversation
  anchor), and BOTH the live-append and rebuild conversation-index paths filter agent-anchored runs via
  `conversationIdOfRun` (so an agent-anchored run never leaks into a conversation's index, replay, or
  `deleteConversation` cascade). No agent-anchored producer ships yet (that is Dream prerequisite ③). Gate:
  typecheck + `test:core` 676/0 (incl. agent-anchored representability + legacy-rebuild + live-append and
  rebuild exclusion tests); one review finding (the live-append path missed the agent-anchored filter the
  rebuild path had) fixed before merge. ([#162](https://github.com/relixiaobo/lin-outliner/pull/162))

- **Shared `date` schedule primitive (PR #161)** — `src/core/dateSchedule.ts`, the pure decision kernel
  for scheduled agent work (Dream prerequisite ①, shared with `agent-scheduled-routines`). Parses a
  canonical `<endpoint> RRULE:...` schedule over a bounded RRULE subset (`FREQ` daily/weekly/monthly/yearly,
  `INTERVAL`, weekly `BYDAY`, inclusive `UNTIL`); exposes parse/format, `mostRecentDateScheduleDue` (the most
  recent occurrence ≤ now, for anacron-style catch-up/coalescing) and `shouldFireDateSchedule` (fire-once
  decision against a `lastSuccessAt` watermark). DST-safe (occurrences reconstruct local wall-clock; invalid
  calendar days like the 31st / Feb 29 are skipped per RFC 5545). No runtime/heartbeat wiring, no generic
  date-field `RRULE` support, no `RunMeta` change yet — those stay in `agent-scheduled-routines` / later Dream
  steps. Gate: typecheck + `test:core` 672/0 (incl. a `TZ=America/New_York` DST spring-forward regression and
  strict-`INTERVAL` rejection tests); two review findings (a monthly/yearly DST-gap drop, lax `INTERVAL`
  parsing) fixed before merge. The plan also records the **PM-ratified `AgentRunAnchor` discriminated union**
  for the upcoming prerequisite-② (`RunMeta` anchor) interface PR. ([#161](https://github.com/relixiaobo/lin-outliner/pull/161))

- **Agent task panel for subagent runs (PR #160)** — a dedicated side panel listing the conversation's
  subagent runs, opened from a Tasks toggle in the agent composer chrome (mutually exclusive with the
  subagent-details pane). `buildAgentTaskEntries` derives the list from the projection
  (`subagentRunIds` + `entities.subagents`), titled by description→name→id, subtitled
  `contextMode · subagentType · N messages · time`, and totally/stably ordered by status rank
  (running→failed→stopped→completed) then `updatedAt` desc then id. Each row opens the subagent transcript
  or, for a running subagent, stops it through `agent_subagent_stop` (guarded; errors surface as a
  `role="alert"`). New `agent.task.*` i18n keys (en + zh-Hans). Gate: typecheck + `test:core` 661/0 +
  `test:renderer` 356/0 (incl. new `agentRuntimeStore`/`agentSubagentUi` coverage) + light/dark visual
  verification. Follow-up a11y polish landed on `main` after merge: the Tasks toggle's `aria-label` now
  carries the running count (the badge was visual-only) via a new `agent.task.openPanelActive` key, and the
  running/idle summary is an `aria-live="polite"` region so screen readers hear count changes.
  ([#160](https://github.com/relixiaobo/lin-outliner/pull/160))

- **Agent M1: canonical DM + Channels, ask_user_question, self-maintenance, skills self-authoring (PR #153)** —
  a clean-cut M1 build across the agent stack: a canonical single-agent DM plus a Channels vocabulary
  (restore finds/creates the built-in assistant DM; public list/rename/delete operate on Channels; default
  channel deletion falls back to the DM); a mixed-resolution compaction backbone (compaction events carry
  explicit source ranges; bounded mixed-resolution model context); `ask_user_question` v1 (main-agent-only
  structured-question tool with persisted requested/answered/cancelled events, runtime pause/resume, a
  renderer pending-question card, and restart-safe replay that now re-appends the tool result so the blocked
  call resumes); self-maintenance v1 (`runtime_status` / `config` / `doctor` tools with scoped permission
  defaults and audited `config.change` events); skills self-authoring v1 (built-in `/skillify`, governed
  `.agents/skills` writes through `file_write`/`file_edit`, validation against risky escalation, hot registry
  reload, and `skill.created/patched/replaced` audit events); and memory isolation modes (global / isolated /
  read-only-global) wired through runtime config and the memory recall/write/update/forget paths. Gate:
  typecheck + `test:core` 661/0 + `test:renderer` 356/0 + `test:e2e` 288/0 + 7-angle high-effort review.
  The review surfaced 10 findings — all fixed before merge (758c61d) with regression tests, the load-bearing
  one being that a runtime-settings refresh dropped the four M1 tools from the live tool set after the first
  turn; a follow-up on `main` routes the restart-replay tool result through the shared `agentToolResult`
  envelope so it renders identically to the live result the model sees.
  ([#153](https://github.com/relixiaobo/lin-outliner/pull/153))

- **Inline local-file references: hover preview + click-to-open (PR #132)** — agent chat messages can
  now carry `[[file:name^/abs/path]]` references that render as an inline chip (file icon + name); hovering
  shows a preview popover (native icon / image thumbnail, type, size, path, modified date) and clicking
  opens the file with the OS default app. The capability lives entirely in the native host: both new IPC
  handlers (`lin:preview-local-file-reference`, `lin:open-local-file`) re-validate the renderer-supplied
  path through `resolveTrustedLocalFileReference` — `realpath` on **both** the candidate and each allowed
  root (symlink-escape safe), confinement to the agent local root via `isPathInside`, filesystem-root
  rejected, and `\0`/relative/non-string rejected — so the renderer's DOM attributes are never trusted.
  Open is additionally gated by `isSafeLocalFileOpenTarget`: an executable-bit check plus a denylist of
  executables / installers / app + automation bundles **and** location/shortcut files
  (`.fileloc`/`.inetloc`/`.url`/`.webloc`/`.desktop`, `.scptd`/`.action`/`.wflow`/`.shortcut`) that would
  otherwise let a click escape the root by indirection. Opening requires a real user click (preview never
  opens; previews fire one-at-a-time on hover with a 450ms delay); references render as `#`-fragment
  anchors so they never trigger navigation. Gate: typecheck + `test:core` 609/0 + `test:renderer` 354/0 +
  3-angle review (security / renderer-correctness / cross-cutting) + light/dark visual verification; the
  initial path-confinement hardening shipped on the branch, and the location-file denylist gap found at
  the gate was fixed + regression-tested before merge. ([#132](https://github.com/relixiaobo/lin-outliner/pull/132))

- **Outliner expansion survives reload (renderer-local view state) (PR #124)** — each root-node page
  now remembers its expanded rows and revealed hidden-field keys across reload / reopen, instead of
  collapsing back on every reload. A new renderer-local store (`outlineViewState.ts`) persists, per root
  node id, the expanded node ids + hidden-field keys in `localStorage` (scoped to that root's structural
  subtree; references are **not** followed into other roots; pruned to the 500 most-recent roots). It is
  pure **view state** — not core commands, undo/redo, import/export, or agent-editable content. Because
  the renderer keeps one global `expanded` set shared by every split pane, restore is **additive**: it
  merges a root's saved expansion in and never clears rows another pane may be showing; persistence
  writes one entry per visible outliner pane root, and a same-day multi-pane layout (PR #123) replays
  expansion for every restored pane on boot. Gate: re-review after a first pass — all six split-pane /
  scope / spec findings fixed (cross-pane collapse, multi-pane boot restore, non-active-pane persist,
  reference-scope bleed, thin tests, spec drift) — + typecheck + `test:renderer` 350/0 + 3 unit
  (additive merge, reference-scope isolation, colon-id round-trip) + 2 e2e (per-root reload restore,
  multi-pane boot restore). ([#124](https://github.com/relixiaobo/lin-outliner/pull/124))

- **Multi-language (i18n): typed foundation + full en / 简体中文 migration (PR #110)** — the app now
  ships English and Simplified Chinese with a typed message layer. All UI strings live in
  `src/core/i18n/messages/<locale>.ts` keyed off a single `Messages` tree (`= typeof en`), read via
  `t.group.key` so a missing or mistyped key is a compile error; non-`en` locales are `DeepPartial`
  and fall through to English via `deepMerge`. The Settings → General language picker persists the
  choice, which the main process broadcasts to every window (`lin:set-language`) — panes re-render and
  the native menu bar + open-window titles rebuild from the same locale, consistent even on a silent
  save failure. Locale is seeded before first paint (no English flash), `effectiveLocale()` is memoized
  off the ~8-site hot path (no per-call `readFileSync`), and an `i18nCoverage` test asserts key **and
  array-length** parity between every locale and the English canon (828/828). The settings language /
  permission `<select>`s were restyled as design-system pop-up buttons (`SelectControl variant="popup"`:
  elevated thumb + overlaid chevron, no native OS box). Action identifiers (`Action(...)`) stay English
  by design; the textOf/displayName/date boundaries are documented in `docs/spec/i18n.md`. Gate: xhigh
  review (9 findings, all fixed) + typecheck + `test:core` + `test:renderer` 330/330 + light/dark × en/zh
  visual verification. ([#110](https://github.com/relixiaobo/lin-outliner/pull/110))

- **Outliner paste: nodex parity — `<br>` split, format routing, GFM checkboxes, `#tag` / `field::` (PR #113)** —
  brings clipboard paste up to nodex parity (`paste-nodex-parity.md`). `<br>`-separated HTML blocks
  (Gmail / Apple Notes / contenteditable) split into one row per line; list markers widened
  (`+`, `1)`, bullets `•◦▪‣·●`); Google-Docs inline wrappers unwrapped. GFM task lists `- [x]`/`- [ ]`
  become checkbox rows via a `completedAt` sentinel (`undefined` none / `0` unchecked / timestamp
  checked) — merging a task line into an existing **non-empty** row never silently checks it (only an
  empty target adopts the state). `#tag` and `name:: value` are harvested from Markdown/plain lines
  and materialized by core (find-or-create, auto-create unknowns; `options` fields smart-select);
  conservative guards keep code/URLs intact, and link/`code` spans are masked so
  `See [the #section](url)` keeps its label. Markdown-over-flat-HTML routing prefers the faithful
  `text/plain` outline when the HTML is lossy flat `<div>`, but trusts real `<ul>/<ol>/<li>` so a
  rich web-list keeps its marks. Protocol: `CreateNodeTree` gains `tags`/`fields`/`checkbox`/`done`
  (via `PasteRowMeta`); `paste_nodes_into_node` carries `firstMeta` for the merged row. Gate: review
  (6 findings fixed: link/code-safe harvest, non-empty-row checkbox suppression, list routing,
  empty-value-child reuse, comment/`firstMeta` cleanup; e2e de-flaked — 48 runs green) + `typecheck`
  + `pasteParser.test.ts` 19/19 + `core.test.ts` 78/78. Spec folded into `ui-behavior.md` (A6).
  ([#113](https://github.com/relixiaobo/lin-outliner/pull/113))

- **Search retrieval stack: shared analyzer + unified node/past-chat retrieval (PR #111)** —
  implements `search-retrieval-stack.md` Phases 1–4 in one PR (PM-ratified single-PR scope).
  Extracts the text-search primitives (normalization, query analysis, CJK + Latin tokenization,
  snippet building, label ranking) into a shared pure module `src/core/textSearchAnalyzer.ts`,
  leaving `textSearchIndex.ts` to consume them. Adds a main-side `NodeRetrievalService`
  (`src/main/nodeRetrievalService.ts`) around `runSearchExpr` + the live text index and routes
  document search and agent `node_search` through that single indexed path (the duplicate
  `agentNodeToolProjection.scoreTerm` is gone). Reworks `past_chats search` to use the shared
  analyzer semantics with active-branch visible-transcript verification and **relevance-first
  ordering** (relevance → session recency → message recency; `recent` mode stays recency-only).
  Reuses the shared label ranking for the renderer field/slash pickers
  (`fieldOptions`/`slashCommands`/`candidateRanking`) and local filename ordering. No protocol
  change, no new dependencies; heavier Phase 5 machinery (capture-payload, WAND/persisted-index/
  SQLite/embeddings) stays deferred behind measurement (A9), with 10k/50k-node and 200-session
  past-chat probes recorded in the plan. Also fixes the OAuth device-code callback typing that
  blocked `typecheck` on the branch. Gate: medium code review — two regressions found (CJK
  multi-term matching short-circuited to phrase-only; past-chat snippets lost original casing +
  `<mark>` highlight) and both fixed in #111 and re-verified — plus typecheck + `test:core`
  (584 pass; the 2 failures are the pre-existing ripgrep `agentLocalTools` cases). Specs updated
  in the same PR (`agent-tool-design.md`, `agent-event-log-rendering.md`; A6).
  ([#111](https://github.com/relixiaobo/lin-outliner/pull/111))

- **Agent panel: no-provider onboarding + empty-state cleanup (PR #109)** — implements
  `agent-empty-state-onboarding.md`. Removed the hardcoded suggested-prompt chips; an empty
  conversation with a usable provider now shows a single muted greeting line. When provider
  settings have **loaded** and no provider is usable, the panel shows a quiet onboarding line
  with a neutral CTA that opens Settings › Providers (the settings window already defaults to
  the Providers category), and the composer send button is disabled with an actionable tooltip
  (`Add a provider in Settings`) so a message can no longer fire and only fail at runtime. The
  guard is gated strictly on the loaded state, so a key-holding user never sees the onboarding
  flash or a disabled send during the async settings load. The usable-provider predicate is now
  one shared `isProviderUsable` / `resolveUsableActiveProvider` in `providerCatalog.tsx` (the
  duplicated copies in the chat panel + composer, and the ad-hoc copies in ProviderConfigWindow
  + AgentSettingsView, all route through it). Renderer-only; no protocol change. Empty-state
  design folded into `docs/spec/design-system.md` (A6).
  ([#109](https://github.com/relixiaobo/lin-outliner/pull/109))

- **Modeless global launcher + basic-info capture (PR #103)** — first slice of
  `lazy-like-global-launcher.md`. A prewarmed, always-focused global-hotkey launcher window
  (Raycast-style flat list: glyph · title · subtitle · right-aligned type label) whose single
  input is command filter + live node search + capture draft at once. Inline node search resolves
  `search_nodes` hits in main and opens the picked node in the main window
  (`navigateRoot + focusNode`); **Capture to Today** saves the active page/video/note with the
  typed text as the capture's comment. New protocol surface: a `create_capture` command and a
  provenance-only `NodeBase.capture` sidecar (`src/core/{commands,types}.ts`). The launcher
  renderer and offscreen capture stay A3-locked down (contextIsolation/sandbox, no preload on
  remote content, popups denied, navigation fenced to `^https?://`), source-guarded by
  `launcherSecurity.test.ts`; capture source metadata is main-authoritative (the renderer supplies
  only an optional note/intent, intent allow-list-validated). External context is read via a
  read-only AX native addon (`native/browser-tab`) with an `osascript` front-tab fallback. Capture
  nodes flow through the normal mutate path, so they are indexed by the #102 search layer.
  Unsupported features ship **removed, not greyed-out** (no coming-soon placeholders); deferred
  work is split into `launcher-ai-actions.md`, `launcher-capture-destinations.md`,
  `launcher-provider-expansion.md`, and `browser-extension-integration.md`. Gate: high code review
  (9 findings fixed), dedicated A3 security review, rebase/integration review, and light+dark
  visual verification — all green; spec `docs/spec/launcher.md` added (A6).
  ([#103](https://github.com/relixiaobo/lin-outliner/pull/103))

- **Text-search relevance layer (PR #102)** — implements `text-search-relevance-layer.md`.
  A shared in-memory text-search kernel (`src/core/textSearchIndex.ts`) — inverted postings,
  field-aware BM25, exact/prefix/phrase boosts, and CJK + Latin trigram candidate generation
  with strict normalized verification — now backs `search_nodes` (command palette) and the
  agent `node_search` tool, maintained **incrementally** off Core's revision deltas (a full
  rebuild only on load / undo / full-rewrite). No protocol change. Review-gate findings were
  fixed before merge: per-term candidates now **union** the trigram (interior-substring) matches
  instead of early-returning on a prefix hit, so a query like `nation` again recalls
  `internationalization` (pinned by a regression test); `normalizeSearchText` uses
  locale-insensitive `toLowerCase()`; the dead bounded top-k heap was removed and the probe
  retargeted to the real `candidateIds()` + `scoreRecord()` path; and an unrelated OAuth
  device-code callback type was split out of this PR. ([#102](https://github.com/relixiaobo/lin-outliner/pull/102))

- **Field value rows join panel selection (PR #97)** — implements
  `field-value-row-selection.md`. Field **value** rows can now be shift/cmd-selected into the
  global multi-selection (drag and keyboard) alongside content rows, keeping the append-only
  value model. A new `SelectableRow` action-policy layer (`state/selectableRows.ts` +
  `interactions/selectionBatchActions.ts`) is the single source for what each row supports:
  field values delete via `removeFieldValue` while structural ops (move/indent/duplicate) skip
  them, and computed `sysref:` system-reference rows are emitted into the shared model so mouse
  and keyboard selection agree. Review-gate findings were fixed before merge — focus-after-delete
  now carries the row's parentId, the global selectable path includes system-reference rows
  (no drag stall / mouse-keyboard divergence), a locked reference hard-deletes again, and
  shift+click on an inline-ref chip extends the range. Spec updated
  (`outliner-parity-matrix.md`, `ui-behavior.md`, A6).
  ([#97](https://github.com/relixiaobo/lin-outliner/pull/97))

- **Agent OAuth & managed-credential providers (PRs #92–#96)** — implements
  `agent-oauth-providers.md`. Providers that authenticate with a sign-in rather than a
  pasteable key (Anthropic Pro/Max, GitHub Copilot, OpenAI Codex) now have a real
  interactive sign-in flow, and managed providers (Amazon Bedrock, Google Vertex) are
  classified and surfaced correctly instead of showing a misleading key field. **#93** lands
  the protocol surface (`agent_oauth_*` commands + `OAuthLoginEvent` / `ProviderAuthView`
  types). **#94** adds the single credential resolver and a `safeStorage`-encrypted secret
  store: per-path write serialization (no lost cross-provider updates), unique atomic-write
  temp names, and a guard that refuses to overwrite an unreadable encrypted blob so a
  transiently-locked keychain never becomes permanent credential loss. **#95** is the
  main-process login orchestration + IPC — pure callback-bridging/cancellation with the
  composition root split out, a provider config row created on first sign-in (no orphaned
  credential), in-flight sign-ins cancelled on window close/re-target, and events routed to
  the initiating window. **#96** is the interactive sign-in UI (loopback + device-code, reply
  steps, connected / expiry / sign-out), token-only theming (B1–B4), verified light + dark.
  Review-gate findings across the stack (store data-loss races, orphaned-credential blocker,
  window-lifecycle leaks, renderer subscription/respond bugs) were fixed before merge. Design
  folded into `agent-pi-mono-implementation.md` (A6); plan archived.
  ([#92](https://github.com/relixiaobo/lin-outliner/pull/92),
  [#93](https://github.com/relixiaobo/lin-outliner/pull/93),
  [#94](https://github.com/relixiaobo/lin-outliner/pull/94),
  [#95](https://github.com/relixiaobo/lin-outliner/pull/95),
  [#96](https://github.com/relixiaobo/lin-outliner/pull/96))

- **Agent composer attachment path model (PR #86)** — implements
  `agent-composer-attachment-path-model.md`. Composer attachments are now **path-first**:
  pathless files are staged under the agent's local root and every attachment carries a
  readable `[[file:label^path]]` marker; images keep their inline image block **and** gain a
  normal file marker. Out-of-root file markers in user messages are materialized into the
  local root so `file_read` can reach them, and the new-turn `<user-attachments>` resource
  JSON is dropped (historical parsing/rendering preserved). Security hardening from the
  review gate keeps the agent confined to its file sandbox: `node_create`/`node_edit` reject
  `[[file:]]` markers resolving outside the local root, and `node_read`/`node_search` no
  longer materialize markers (no read-side copy sink); materialization canonicalizes paths
  with `realpath`, refuses out-of-root directories and non-regular files, caps size
  (`MAX_MATERIALIZED_ATTACHMENT_BYTES`, 50 MB), and prunes staged copies on a 7-day TTL; the
  `file_read`/`file_glob`/`file_grep` jail is `realpath`-based with nearest-existing-ancestor
  resolution, closing symlink traversal. Agent spec docs updated (A6).
  ([#86](https://github.com/relixiaobo/lin-outliner/pull/86))

- **macOS branding & chrome polish (PR #84)** — implements
  `macos-native-branding-polish.md` (T1–T6). The **app icon** is rebuilt to Apple's macOS
  icon grid: a squircle master (`assets/brand/tenon-icon-master.svg`, 824 / r≈185.4 / 100px
  transparent gutter on 1024) regenerated to `.icns`/`.png` by `scripts/gen-icon.mjs`. The
  Dock "white frame" (白边) is fixed by switching the rasterizer from `qlmanage` — which
  mattes the transparent gutter to opaque white — to headless Chromium with
  `omitBackground`; the gutter is `rgba(0,0,0,0)` (pixel-probed at 1024/512/32), replacing
  the old full-bleed square. The duplicate sidebar brand header (and its `sidebar-brand*`
  CSS) is removed so the **workspace-root row is the sole identity**. The **app menu** gains
  About/Hide/Quit, renames "Preferences…" → "Settings…", sets copyright `© 2026 Lin Lab`
  (About panel + electron-builder), and Help → "Tenon Help" + "Report an Issue…". (In a dev
  run the bold app title still reads "Electron" and ⌘, still reads "Preferences…" because
  those are OS-managed from the Electron dev bundle; a packaged `--dir` build was launched
  and verified to show "Tenon" + "Settings…" with the correct Info.plist and a
  sha256-identical bundled icon.) Design-system spec updated to the single workspace-root
  avatar (A6); no `src/core` protocol surface touched. The true Liquid-Glass `.icon`
  pipeline is deferred to `docs/plans/macos-liquid-glass-icon.md` (P2 draft).

- **Editable workspace root title (rename your workspace)** — the workspace root
  (`WORKSPACE_ID`, "Tenon") is now seeded with `locked=false`, so its title is editable
  rich text in the panel header and the sidebar workspace-root row. Structural protection
  is unchanged: `ensureNodeMovable` still blocks move/delete/reparent via the independent
  `isSystemId` check, so the root stays fixed in the tree while only its title becomes
  editable. The functional sections (Daily notes, Library, Schema, Saved searches, Trash,
  Settings) keep read-only titles. The sidebar brand wordmark (the logo + "Tenon" at
  top-left) is a hardcoded brand string and is unaffected. `ensureSystemNodeDirect`
  reconciles the flag on existing documents, so current data flips to editable on next
  launch with no migration or data wipe; the title-reconcile guard only resets empty/legacy
  titles, so a custom workspace name survives restarts. (Direct merge to `main`, no PR.)

- **Appearance theme toggle: System / Light / Dark (PR #82)** — a new **Settings ›
  General** pane exposes a `SegmentedControl` (System / Light / Dark). Selecting calls
  `lin:set-theme` → the main process sets `nativeTheme.themeSource`, which rewrites every
  renderer's `prefers-color-scheme` so the already-shipped `@media (prefers-color-scheme:
  dark)` rules flip all windows at once (no CSS dark rules changed, no `[data-theme]`
  bridge). The choice persists in `userData/app-preferences.json` and is reapplied in
  `app.whenReady()` before the first window paints (no flash); it applies instantly (no Save
  button). Preload exposes a narrow typed `getTheme`/`setTheme`; the handler validates the
  mode before touching `themeSource`. Closes the `#45` item of design-system-rollout.
  ([#82](https://github.com/relixiaobo/lin-outliner/pull/82))

- **macOS packaging + real-Electron smoke suite (native-feel stage 6) (PR #81)** — a
  real-Electron Playwright smoke suite (`tests/smoke/` + `playwright.smoke.config.ts`) that
  launches the built main process against a throwaway `ELECTRON_USER_DATA_DIR` (prod
  `file://` renderer) and asserts native behaviors the Chromium e2e suite never covered:
  first-frame (no launch flash), native menu shape + `Preferences ⌘,`, CSP enforcement
  (inline-script `securitypolicyviolation`), external-link routing (`shell.openExternal`,
  `file:` never routed), and userData isolation (a real `create_node` mutation persists into
  the isolated dir and survives before-quit). Adds `test:smoke` + `mac.category`. macOS-only
  scope; smokes the built bundle's prod path, not the signed `.dmg`. Completes
  `native-feel-remediation` (all six stages shipped).
  ([#81](https://github.com/relixiaobo/lin-outliner/pull/81))

- **Rebrand: Lin Outliner → Tenon (PR #83)** — full product-identity change. New Tenon
  logo + generated Electron app icons, favicon, sidebar brand mark, and app/window/About
  titles; agent-facing identity copy updated. electron-builder `appId`
  `com.linoutliner.desktop` → `dev.linlab.tenon` and `productName` → `Tenon`, so the
  packaged macOS userData dir is now `~/Library/Application Support/Tenon/`; the system
  workspace title migrates `Lin Outliner` → `Tenon` (display-only, idempotent). All
  internal `lin:*` IPC channels, command names, storage keys, and `provider: 'lin'` are
  preserved — protocol surface unchanged. Dev `$HOME/.lin-outliner-*` override dirs are
  intentionally kept. ([#83](https://github.com/relixiaobo/lin-outliner/pull/83))

- **Unified inline reference foundation: `ReferenceTarget` (node | local-file) (PR #80)** —
  the inline-reference model is unified under one `ReferenceTarget` union so node
  references and local-file/folder references share a single grammar and codec.
  `InlineRef` carries `{ offset, target, displayName?, mimeType?, sizeBytes? }`; the
  marker grammar is `[[node:label^id]]` / `[[file:label^path]]` (value percent-encoded)
  parsed by one `referenceMarkup.ts`; a pure `referenceTargetToResourceItem` serializer
  builds the agent context resource. Local-file references are inline-only with
  path-as-identity (no id/registry/bookmark); backlinks and search stay node-only via
  `inlineRefNodeId`. Foundation for `lazy-like-global-launcher` and
  `agent-composer-attachment-path-model`. Pre-release format break — no migration or
  bare-marker back-compat; dev userData reset.
  ([#80](https://github.com/relixiaobo/lin-outliner/pull/80))

- **Native master-detail Providers settings + own provider-config window (PR #69)** —
  the agent **Settings → Providers** surface reworked to the macOS System Settings
  *interaction* idiom in our own tokens/B-rules. A reusable inset grouped-list primitive
  (`SettingsInsetList`) with content-aligned hairlines, region-by-colour, neutral
  selection/focus, and no row hover fill; Providers grouped **Connected / Available**
  with a brand-avatar identity, neutral status dot, a per-row `⋯` menu (only when a row
  has >1 action) and a trailing **Configure** button otherwise; back/forward category
  history reusing the shared chrome control. The per-provider config opens as its **own
  native window** — a frameless modal child of the settings window
  (`lin:open-provider-config`, `?surface=provider-config`), the System Settings
  attached-dialog idiom — hosting the connection only (credential + base URL inline,
  async non-blocking validate with cancel); it is multi-mode so OAuth / managed
  credentials plug in later. The settings window itself becomes frameless with the main
  shell's geometry (inset traffic lights, 24pt corner). Also fixes dark-mode switch
  thumb / checkbox check / `==highlight==` text rendering near-black. Security defaults
  (A3) match every other window. ([#69](https://github.com/relixiaobo/lin-outliner/pull/69))

- **Reference field type: read-only system reference rows + editable node picker
  (PR #71)** — node-reference field values now follow one model: the reference node
  is always full-featured (double-click edits the target, expandable) and only the
  value *container* differs. Read-only **References / Owner / Day** project synthetic
  read-only `reference` rows (computed render-time over the global reverse index, not
  core's incremental projection) whose set is read-only — no add, no delete — but
  whose rows still edit/expand their target. A new editable **`reference` field type**
  (`FieldType += 'reference'`; protocol command `add_field_reference`, append-any-node
  + deduped, rejects a non-reference field) makes a value draft a node-search box
  (`TrailingReferencePopover`); the typed query is never persisted as free text — a
  value only ever comes from a picked existing node. Also: system-field derivation is
  consolidated into `core/systemFields.ts`, and a node carrying a **Done** field
  auto-shows a synced row checkbox that is read-only on a locked owner (fixing the
  locked-node toggle crash). Removes the now-dead `.field-value-link`. Touches the
  protocol surface (`types.ts`, `commands.ts`) per the plan.
  ([#71](https://github.com/relixiaobo/lin-outliner/pull/71))

- **Field-row UX: name reuse + read-only system fields + Tab relocate (PR #70)** —
  typing a field name (or `Space` on an empty one) now offers a popover of existing
  user fields + built-in system fields to relink to, instead of always minting a
  fresh definition. Adds the protocol command `reuse_field_definition` (`commands.ts`;
  `types.ts` untouched) that repoints the entry's `fieldDefId`, drops the orphaned
  draft def, and clears stored value children when relinking onto a read-only system
  field; a node can't carry the same field twice (renderer-enforced dedupe). Read-only
  system fields now render by their real type — Created / Last-edited / Done-time as a
  date with a calendar glyph, Tags as navigable badges, References / Owner / Day as
  links, and Done as a checkbox that goes **read-only when the owner is locked**
  (fixing the "operation is not allowed on locked node" crash on daily-note date
  pages). And `Tab` / `Shift+Tab` on an empty trailing draft now **relocate** it (pure
  focus + expand — no create, no indent IPC) instead of materializing then indenting,
  removing the flicker and the stray empty node.
  ([#70](https://github.com/relixiaobo/lin-outliner/pull/70))

- **Native shell behaviors (PR-D)** — a standard macOS application menu
  (App / Edit / View / Window / Help) with **Preferences on `Cmd+,`** opening the
  settings window, plus a native right-click context menu (editing roles + spelling
  suggestions on editable fields, Copy on a selection) that fires only for the bare
  right-clicks the renderer's own command menus leave un-`preventDefault`'d, so it
  never double-pops over a custom menu. Dev-only View items (reload / devtools) are
  gated to source runs. Also adds the macOS inactive-window convention: when the
  window loses OS focus the two floating rails desaturate (rails-only, via a
  `window-active` IPC channel — never content, selection, or the rose accent). D6:
  the pre-paint backing colour is aligned to `--bg-window` (`#ececec`); D7: a spec
  note that the 24pt window corner is packaged-build-only.
  ([#68](https://github.com/relixiaobo/lin-outliner/pull/68))

- **Field values create on Enter (node-based field-value editors)** — a field
  value is now a plain outliner node: Enter in a field value materializes the
  trailing draft and appends the next value through the same draft, so "everything
  is a node" holds for field values too. The legacy `TrailingInput` /
  `TypedFieldValueControl` / `DateFieldControl` / `TrailingInputLeading` fork is
  removed; field-value editing flows through the unified `OutlinerItem` draft row
  with additive layers — `CheckboxFieldControl` (the one whole-field control),
  `DateValuePicker` (summoned by Space on an empty draft or a calendar
  affordance), and `TrailingOptionsPopover` (type-to-filter + `Create "x"`).
  Adds id-aware field-value commands (the renderer proposes the draft row's stable
  id so React identity / IME survive materialization, validated in core against
  shape + collisions) and a new `remove_field_value` command whose backspace-an-
  empty-value cleanup promotes an externally-referenced auto-collected value into
  the option pool instead of orphaning the reference. Touches the protocol surface
  (`src/core/commands.ts`, `src/core/types.ts`) per the coordination policy.
  ([#64](https://github.com/relixiaobo/lin-outliner/pull/64))
- A central accessibility layer (`styles/a11y.css`) honoring `prefers-contrast`, `prefers-reduced-motion`, and `prefers-reduced-transparency`, with a reusable `--material-backdrop` opaque-fallback token (PR-B, #63).
- **Agent tool permissions (global runtime policy)** — implements
  `docs/plans/agent-tool-permissions.md`: one global, runtime-owned permission
  policy (allow/ask/deny by action kind) replacing the hidden one-off approval
  matrix. Adds action descriptors and a global JSON permission store
  (`permissions.allow`/`ask`/`deny`) with fail-closed load/save validation that
  rejects forbidden-allow shapes (wildcards, the arbitrary-code shell-prefix
  denylist — interpreters, `eval`/`exec`/`xargs`/`sudo`, package managers
  `npm`/`pnpm`/`yarn`/`bun`/`npx`/`bunx`/`tsx`, `ssh`, PowerShell — and the
  agent/sub-agent-spawn ban). Platform hard blocks are evaluated before any
  allow rule: sensitive-read-plus-network-write exfiltration, credential /
  shell-startup / `.git/hooks` / persistence writes, payment, permission
  self-modification, and unknown/obfuscated shell. The bash classifier handles
  known command families and evaluates compound commands by most-restrictive
  segment (`find -exec`/`-delete` and `sed -i` are treated as
  execution/edit/persistence, not read-only). A classifier-backed `ask` resolver
  is bounded by a `classifierAutoAllowEligible` gate (default `false`) that can
  never auto-allow high-consequence / outward / sensitive actions, and the
  classifier sub-call receives only a classification output contract, never the
  real tools. Ships the composer approval card (Approve once / Always allow this
  kind / Deny once), a permission center UI, structured `permission_denied`
  results, and `tool.permission.checked`/`tool.permission.resolved` event-log
  entries. Reviewed via a deep multi-agent pass that found and confirmed-fixed 1
  critical + 4 high fail-opens before merge; `typecheck` clean, permission tests
  30/0. Non-blocking follow-ups remain (sessionApproved ordering vs
  configured-ask, `parseGlobalToolPermissionSettings` pre-shaped early-return,
  interpreter-stdin exfil sinks, dual `approval.*`/`tool.permission.*` event
  vocabulary, denied-reason literal naming).
  ([#60](https://github.com/relixiaobo/lin-outliner/pull/60))
- **Agent tool permissions plan (authority)** — adds
  `docs/plans/agent-tool-permissions.md` as the single authoritative agent
  permission plan and shelves the two earlier P0 drafts
  (`agent-permissions.md`, `agent-reversible-execution.md`) with pointers to it.
  The plan defines one global runtime-owned policy (allow/ask/deny by action
  kind), platform hard blocks, a classifier-backed `ask` resolver bounded by a
  `classifierAutoAllowEligible` descriptor gate (a deliberate strengthening over
  cc-2.1, which lets its classifier model auto-allow high-consequence actions),
  fail-closed rule validation with an explicit arbitrary-code shell-prefix
  denylist and an agent/sub-agent-spawn allow ban, sensitive-data exfiltration
  redlines, and a defined interactive/unattended fail-safe. Plan refined on merge
  per a cc-2.1 source comparison (precedence wording, the two borrowed validation
  rules, and classifier-callable vs auto-allow-eligible terminology). A second
  pass pinned the concrete defaults cc-2.1 ships (per-action-kind
  `defaultDecision` table — outside-area read / web fetch / delete / publish /
  send-message default to `ask`; in-area read/edit and web search to `allow`),
  added a Classifier Prompt Contract (named block-category taxonomy mirroring
  the deterministic redlines + operational params) and a concrete safe
  auto-allow tool allowlist + outward-facing shell-command list, so the defaults
  are implementable rather than left as `Allow / Ask` placeholders.
  ([#59](https://github.com/relixiaobo/lin-outliner/pull/59))
- **macOS window corner radius (native)** — gives the standard macOS window a
  custom `24pt` continuous corner (matching Raycast) while keeping native traffic
  lights, the OS drop shadow, vibrancy, and live resize. A tiny zero-dependency
  Node-API addon (`native/window-corner/`) sets the corner via the private
  `_cornerRadius`/`_effectiveCornerRadius` selectors on macOS 26 Tahoe (where
  `_cornerMask` is ignored for frame/shadow shaping) and falls back to a
  `_cornerMask` override on older macOS; the vibrancy frost is rounded via the
  public `NSVisualEffectView.maskImage`. The loader degrades to a silent no-op
  off-darwin / when unbuilt, the radius is the `MAC_WINDOW_CORNER_RADIUS` JS
  const (restart-only to tune), and `app:build` runs `build:native` before
  packaging (the `.node` ships via `extraResources`, outside the asar).
  ([#58](https://github.com/relixiaobo/lin-outliner/pull/58))
- **Design system — spec, rollout plan, and Phase 1 token foundation** — adds
  `docs/spec/design-system.md` (the design language as a contract: two-theme
  alpha-on-ink tokens, material/overlay taxonomy, concentric radius chain,
  neutral-functional state with sparse rose brand) and `design-system-rollout.md`
  (4-phase staged plan). Phase 1 is CSS-only in `styles.css`: introduces the
  `--ink` semantic layer (text / fill / separator / surface / material / accent /
  status / selection / focus / elevation / outline) as the source of truth and
  re-points every legacy alias onto it, so components keep working and move to the
  designed light palette. The dark theme is fully defined but **gated behind
  `:root[data-theme="dark"]`** (not `prefers-color-scheme`) so it stays inert
  until the component layer is theme-aware — Phase 2 wires `nativeTheme.themeSource`
  → `data-theme`. ([#55](https://github.com/relixiaobo/lin-outliner/pull/55))
- **Native-feel stage 2 — startup polish, window-state, single-instance** — the
  window is created `show: false` and revealed on `ready-to-show` (no white
  launch flash); a new `windowState.ts` persists and restores normal bounds +
  the maximized flag (validated against connected displays so a now-disconnected
  monitor can't strand the window off-screen); and `requestSingleInstanceLock()`
  focuses the running window instead of spawning a duplicate.
  ([#45](https://github.com/relixiaobo/lin-outliner/pull/45))
- **Native-feel stage 3b — OS window material** — macOS draws `under-window`
  vibrancy and Windows draws `mica` behind the chrome, driven by a shared
  `core/windowMaterial.ts` mapping read by both the main process and preload; the
  renderer tags `<html>` with `data-window-material` on the first painted frame
  so there is no opaque→frosted flash. Other platforms keep the opaque deck.
  ([#47](https://github.com/relixiaobo/lin-outliner/pull/47))
- **Native-feel stage 4a — in-app dialogs (no `window.prompt`/`confirm`)** — the
  remaining blocking browser dialogs are gone: node icon/banner edits use an
  in-menu text-input sub-mode (consistent with the existing tag/move inputs), and
  destructive session-delete uses a reusable `ConfirmDialog` primitive (focus
  trap, Escape-to-cancel, Cancel takes initial focus so a stray Enter can't
  delete). ([#48](https://github.com/relixiaobo/lin-outliner/pull/48))
- **Native-feel stage 4b — settings in its own window** — settings moved from an
  in-app modal into a dedicated Preferences-style window with a native title bar,
  served from the single `index.html` via a `?surface=settings` marker (no second
  build entry) and going through the same stage-1 navigation hardening + CSP. New
  IPC: `lin:open-settings` / `lin:close-settings` / `lin:settings-changed`. The
  stage-4 native right-click `Menu` was intentionally dropped — the rich DOM
  context menu outweighs the native-feel gain.
  ([#49](https://github.com/relixiaobo/lin-outliner/pull/49))
- **Keyboard shortcut parity with nodex** — closes the audited gaps against the
  nodex reference. `Cmd/Ctrl+A` now selects every visible row in the current
  root even from an empty selection (focused editors still get native text
  select-all); `Cmd/Ctrl+Shift+D` goes to today's daily note when no row is
  selected while keeping batch-duplicate when a selection is active; panel
  navigation history gets dedicated `Cmd/Ctrl+[` / `Cmd/Ctrl+]` and
  `Alt+ArrowLeft` / `Alt+ArrowRight` bindings (document undo/redo stays on
  `Cmd/Ctrl+Z`, never overloaded); and a selected option-reference field value
  opens a keyboard-owned option menu where `ArrowUp`/`ArrowDown` move, `Enter`
  selects, and `Escape` closes the menu before clearing the row selection. The
  audit confirmed drag-select and click-away dismissal were already present.
  ([#53](https://github.com/relixiaobo/lin-outliner/pull/53))
- **Agent tool permissions — `allow | ask | deny` with an approval flow** — the
  runtime permission decision evolved from a boolean to a three-state behavior
  computed entirely in TypeScript policy (never from model prose). High-consequence
  actions now suspend the agent and request user approval instead of silently
  running or hard-failing: external GitHub mutations (`git push`, `gh pr/issue/
  release/repo/workflow`), package/deploy/publish changes, database migrations,
  background commands, sandbox overrides, sensitive local-path access
  (`~/.ssh`, `.env`, credential/keychain files), and unscoped recursive deletes
  ask; machine destruction, remote-code-execution pipes, shell obfuscation, and
  sensitive-data network exfiltration are redline `deny` that session rules and
  skills cannot approve. Approvals render in the agent composer (Allow once /
  this session / Deny + details popover), bubble up from subagents and skill-shell
  commands through one path, queue when multiple are pending, and are recorded as
  `approval.requested` / `approval.resolved` in the event log.
  ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Inline Markdown formatting while typing** — typing the closing delimiter now
  converts low-ambiguity inline syntax in the row editor and agent composer into
  the matching mark and drops the delimiters: `` `code` ``, `**bold**`,
  `~~strike~~`, `==highlight==`, and `[text](url)`. `*italic*` and underscore
  variants are intentionally ignored to avoid accidental conversion. The `code`
  mark is non-inclusive and ArrowLeft/ArrowRight can move the caret out of an
  inline code mark even with no adjacent plain text.
  ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Done-state mapping + free-typed options + color swatch picker** — three
  user-facing additions ride with the config-as-nodes refactor. A supertag with
  "Show as checkbox" on can map its done/undone state to one or more option-field
  values (Tana parity): checking the box sets each mapped field's checked value,
  and selecting a mapped checked/unchecked value toggles the box (two-way, single
  write each direction, loop-guarded). Number fields gain a non-blocking
  out-of-range warning (`minValue`/`maxValue`) that never rejects a write. Options
  fields now accept **free-typed** values decoupled from auto-collect (collect on
  ⇒ value becomes a reusable collected option; off ⇒ stored as a plain free-text
  value on that entry alone) and render as inline editable rows. The supertag
  display color is now a preset **swatch picker** (8 base colors + "no color")
  storing a theme-aware token instead of raw hex.
  ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **`` ``` `` / `~~~` shortcut converts a row to a code block** — typing a lone
  triple-backtick (or triple-tilde) fence that owns an empty, plain row now turns
  the row into an empty `codeBlock` and drops the fence text, a markdown-style
  shortcut alongside the `/code` slash command and pasting a fenced block. Fires
  the instant the row text equals the bare fence (mirroring the `>` field
  trigger), focuses the new code editor, and is gated to plain content rows so
  reference / image / existing-code rows opt out. The eager trailing draft
  materializes first, then converts. Language is left unset (pick it from the
  picker). ([#28](https://github.com/relixiaobo/lin-outliner/pull/28))
- **Local file mentions in the agent composer** — the `@` mention menu now
  combines recent nodes, local files, folders, and live file-search results
  (Spotlight `mdfind` on macOS, `rg` fallback elsewhere); selected entries
  render as inline tokens with native icons, image thumbnails, and hover
  previews. The model-facing prompt preserves positional intent with
  `[[file:<ref>]]` markers while a hidden `<user-attachments>` table maps each
  `ref` to its local path, kind, MIME type, and size, so files, folders, inline
  text, and images share one resolution path. Folders are exposed to the agent
  via a symlink into the local root for `file_glob`. Trashed nodes are excluded
  from both outliner and agent `@` suggestions.
  ([#21](https://github.com/relixiaobo/lin-outliner/pull/21))
- **Eager-materialized trailing draft row** — the Tana-style blank line at the
  bottom of the outline is now a real draft row: typing the first committed
  character materializes an actual node in place (IME-seamless, no editor
  remount) via a client-proposed node id, and drops a fresh empty draft below.
  Create + the first text edits collapse into one undo step. Structural keys
  work on the draft (Enter / Tab indent-under-previous-sibling / Shift+Tab /
  Backspace), plus fixes for leading-inline-ref backspace and merging a row
  into a reference node (converts it to a leading inline reference). Main
  outliner only; `FieldValueOutliner` keeps its typed-control trailing input.
  ([#16](https://github.com/relixiaobo/lin-outliner/pull/16))
- **Agent composer with inline references** — replaced the agent composer
  textarea with a ProseMirror editor supporting slash commands, inline node
  references (rendered consistently across user / assistant / tool output and
  clickable, with Cmd/Ctrl-click opening a new tab), inline file references,
  and paste/drop + native-picker file attachments sent inline to the model.
  ([#15](https://github.com/relixiaobo/lin-outliner/pull/15))
- **Inline images and a local asset subsystem** — paste an image or pick one
  via `/image`; images render inline on a reusable, focusable block-node shell.
  A content-addressed asset store (MIME sniffing, intrinsic-dimension probe,
  path-traversal-safe ids) is served through the privileged `asset://` protocol.
  Each image has a hover toolbar (caption / fullscreen lightbox / open original);
  the caption is the node's description.
  ([#8](https://github.com/relixiaobo/lin-outliner/pull/8))
- **Remote image sources** — image nodes accept a remote `mediaUrl` (validated
  http/https) alongside local assets; pasting a lone image URL creates a remote
  image, while pasting a URL over a selection links the text instead.
  ([#10](https://github.com/relixiaobo/lin-outliner/pull/10))
- **Dedicated code block editor** — `codeBlock` nodes with Shiki syntax
  highlighting, a language picker, horizontal scroll, and cross-row selection.
  ([#2](https://github.com/relixiaobo/lin-outliner/pull/2))
- **`past_chats` agent recall tool** — recent / search / read access over prior
  agent conversations, backed by the event store; tool-call JSON is
  Shiki-highlighted in the UI and renders identically live versus reloaded.
  ([#1](https://github.com/relixiaobo/lin-outliner/pull/1),
  [#4](https://github.com/relixiaobo/lin-outliner/pull/4),
  [#7](https://github.com/relixiaobo/lin-outliner/pull/7))

### Changed

- **Workspace tree rows are text-only (PR #146)** — the navigation tree no longer renders a per-node icon
  (neither a node's own emoji nor the fixed fallback glyph the system roots Daily notes / Library / Schema /
  Saved searches / Trash carried); those icons still show in the outliner/canvas and on the primary-nav
  entries + workspace-root avatar, but the tree omits them so the list stays scannable. Drops
  `renderSidebarNodeIcon`/`systemIconForNode` and the `.workspace-tree-label-icon`/`-emoji` CSS; the
  `workspace-layout.spec.ts` guard was updated to the new DOM (15/15). Gate: typecheck + that e2e guard.
  ([#146](https://github.com/relixiaobo/lin-outliner/pull/146))

- **Agent: "Used N tools" summary glyph → chart-no-axes-gantt (PR #139)** — the collapsed process summary
  that lists tool usage swapped its `ListChecks` glyph (generic "options list") for lucide
  `ChartNoAxesGantt` (staggered bars, a "steps / process" feel), via a new `UsedToolsIcon` alias used only
  there. `OptionsIcon` keeps mapping to `ListChecks` for the field-type "options" usages (definition config,
  view toolbar, field presentation), so this is not a global remap. Gate: typecheck + `test:renderer` 354/0
  + light/dark in-context visual. ([#139](https://github.com/relixiaobo/lin-outliner/pull/139))

- **Agent: morphing geometric "still generating" mark (PR #138)** — the flat rose streaming pulse is
  replaced by a richer brand mark: an SVG whose path morphs **triangle → square → circle** and back while
  rotating a full turn. All three shapes are 4-corner rounded polygons sharing one command structure
  (`M, (L Q)×4, Z`) so the `d` interpolates continuously with rounded corners throughout (no sharp points,
  incl. the triangle apex); they carry equal **optical area** (centroid-centered) so the triangle no longer
  reads smaller than the square and the apparent size "breathes" while visual weight stays constant.
  Rotation runs in lock-step with the morph. Adds material depth — a top-lit rose gradient
  (`--accent` → `--accent-strong`) plus a soft rose `drop-shadow` on the non-rotating wrapper. Sized to
  20px (~0.77 of the 26px body line) and centered on the **same 14px icon column** as the tool / thinking
  status icons (measured: icon center == mark center). Also restores `--caret` to brand rose. Gate:
  typecheck + `test:renderer` 354/0 + token guard 8/8 + light/dark visual & alignment; all values tokenized
  (B11). ([#138](https://github.com/relixiaobo/lin-outliner/pull/138))

- **Agent: strip model-visible redundancy across all tools (PR #128)** — the model-visible tool result
  (`content[0].text`) now carries only what the model cannot cheaply derive; the full runtime envelope
  stays on `details` unchanged. A shared `modelVisibleEnvelope` projector backs every tool: it drops
  `tool` (known via tool-call correlation), emits `status` only when informative
  (`partial`/`unchanged`/`denied`, never `success`/`error`), and projects errors to `{ code, message }`.
  Node tools drop `kind`/`action` (always the tool name) and select guidance from a single-source
  `NodeInstructionContext { count?, outcome? }` computed beside the visible result — never re-derived from
  the payload shape, never duplicated at the call site — so a real no-op edit reports "No change was
  needed" instead of "Edit applied". `file_read` text/notebook/pdf paths route through a typed
  `visibleFileRead` (exhaustiveness-guarded) that strips derivable counts / internal paths / base64 /
  duplicated cells, and a partial read now sets `status: "partial"` as a structured truncation signal.
  `data` is omitted from the visible envelope whenever `modelData` is `undefined` (the safe default — the
  prior `NO_MODEL_DATA` sentinel and its undefined-fallback leak are gone). `past_chats`, `file_edit`,
  `task_stop`, `file_grep` shed echoed args / constants / cross-field duplicates. Design folded into
  `docs/spec/agent-tool-design.md`. Gate: re-reviewed (high) after a revision that addressed all nine
  findings; typecheck + `test:core` 602/0 (2 ripgrep-env skips). A follow-up commit fixed the
  `nodeInstructions` exhaustiveness guard, which was cosmetic as merged (it switched on a cast expression
  and assigned `envelope.tool as never`, so adding a `NodeToolName` member did not fail to compile) — now
  it switches on a typed local and the `never` default genuinely enforces coverage (verified: a sixth
  member raises TS2322). ([#128](https://github.com/relixiaobo/lin-outliner/pull/128))

- **Settings: macOS System Settings clarity pass (PR #118)** — the standalone Settings window now reads
  closer to macOS System Settings while keeping Tenon's neutral design system. A fixed toolbar pairs the
  back/forward history controls as one neutral pill capsule (with a hairline divider) and a right-pane
  page title; the content scrollport sits below it via `margin-top` (not scrollable padding) so dense rows
  never pass behind the chrome. The category rail gains a compact neutral icon slot + single-line label
  per row, the content column is constrained to a stable reading width (`--settings-content-max-width`),
  and grouped inset cards drop their heavy border for a 0.5px inset hairline (`--inset-hairline`). Pop-up
  selects are now transparent-at-rest text chrome that gain a neutral fill only on hover/focus/press
  (macOS pop-up rhythm); permission decision pop-ups keep a stable width through the non-allowable last
  row, and raw `Action(...)` rule strings + redundant inline chips are gone from the first visual level.
  **Agent Profiles is now hierarchical:** the category page is a pure drill-down list (chevron only, no
  switch), and clicking a profile pushes an `agent-detail` route — reached through the same back/forward
  capsule — that carries the enable/disable switch as its own row above the persona card. The runtime/
  permission Save footer now appears only when the draft is actually dirty. Gate: typecheck + renderer
  340/0 + agent-settings e2e 19/19 (incl. 5 new drill-down/pop-up/alignment cases) + light/dark visual
  verification; review fixed 3 issues (a `box-shadow` token-guard regression, a dead `data-window-material`
  rail rule + over-claiming spec sentence, and orphaned i18n strings). Design folded into
  `docs/spec/design-system.md`. ([#118](https://github.com/relixiaobo/lin-outliner/pull/118))

- **Perf P1 (PR-A): incremental projection delta over the core↔renderer seam (PR #119)** — the
  keystone of the performance program (`incremental-projection.md`). Instead of shipping the entire
  `DocumentProjection` across IPC on every mutation and having the renderer re-`JSON.stringify` every
  node to rediscover the change set, core's existing change set is delivered as a `ProjectionUpdate`
  discriminated union (`full | delta`). `documentService.buildProjectionUpdate` emits a `delta`
  (changed/removed nodes only) when the revision advances by exactly one, and a `full` on whole-tree
  rewrites / discontinuity; the renderer's `reduceProjection` folds it into the held index,
  **preserving object identity for every unchanged node** (the stable-reference foundation later memo
  work builds on) and deleting the whole-document `nodeSignatures` pass. Measured single-keystroke
  cost at 6k nodes: IPC payload ~1984 kB → 362 B, renderer index pass 7.0 ms → 1.2 ms. A
  `ProjectionSnapshot` resync valve covers any delta gap (belt-and-suspenders; never fires on the one
  ordered channel). Gate: xhigh review — 2 correctness + 1 perf regression caught and fixed
  (merge-node grandchild survival via delete-exact-`removedIds`, idempotent date-ref fallback, no-op
  reseed short-circuit), verified by a new real-core delta integration test (`byId` == full rebuild
  under `LIN_VERIFY_CACHE=1`) + typecheck + renderer 340/0 + core. PR-B (incremental reverse-edge
  maps) tracked separately. ([#119](https://github.com/relixiaobo/lin-outliner/pull/119))

- **Perf P1 (PR-B): incremental reverse-edge index — retire the last O(N) per-keystroke pass (PR #121)** —
  follow-up to #119. `propagateDirty` used to rebuild the reverse-edge index (reference / tag / inline-ref
  target → referrers) from *every node* on every edit. The index (`ReverseEdges`, now `Set`-valued for O(1)
  add/remove) is held in the renderer's `ProjectionState` and patched per delta by `patchReverseEdges`
  (copy-on-write at both the category-map and member-set level, leaving `prev` untouched; a node whose edge
  keys are unchanged is skipped, so a plain text edit allocates nothing). `propagateDirty` now takes the
  held index instead of building it. Bench (edge-build + propagate, single keystroke, ~20% nodes tagged):
  6041 nodes 1.22 ms → 0.29 ms; the patched index is asserted equal to a full rebuild after **every**
  command in `projectionDeltaIntegration.test.ts` (tag/reference/inline-ref churn added). Gate:
  `/code-review` (3 finders + 1.5k-case fuzz, 0 bugs) + typecheck + renderer 345/0; a follow-up dropped a
  redundant `node.tags.slice()` on the hot path (alias the read-only array). Residual per-keystroke O(N)
  (`new Map(prev.byId)`, `nextRevisions`) is the P3 cleanup.
  ([#121](https://github.com/relixiaobo/lin-outliner/pull/121))

- **Perf P0: stop per-token agent index rewrites + drop pretty-print write amplification (PR #117)** —
  first quick-win of the performance-optimization program (`performance-optimization.md`, #116).
  `AgentEventStore.appendEvents` rewrote both `session-index.json` and `search-index.json` (read +
  parse + serialize + atomic write of the **whole** file) on every `assistant_message.delta`, i.e.
  per streamed token batch, scaling O(all messages ever). Delta-only batches now skip the index
  rewrite — content-preserving, since the indexes derive assistant text from
  `assistant_message.completed` and a delta only nudges cosmetic `latestSeq`/`updatedAt` (self-healed
  by the events that follow); `events.jsonl` is still appended per delta (source of truth). Separately,
  `JSON.stringify(_, null, 2)` was dropped from the Loro document snapshot and the two agent index
  writes (~half the bytes per write); readers use `JSON.parse`, so existing on-disk files still load
  (no migration). Human-edited config/permission/debug writes keep pretty-printing. Gate: verified
  content-preserving (index fields are write-only; mixed batches still index) + typecheck + renderer
  330/0 + agent event-store/large-session/past-chats suites green.
  ([#117](https://github.com/relixiaobo/lin-outliner/pull/117))

- **Settings panes unified onto one design language (PRs #105 + #106)** — implements
  `settings-design-consistency.md`. The Settings window no longer reads as two visual
  generations. **#105 (WI-1, conformance):** danger hover → neutral `--control-hover` (B3);
  unified text-control `:focus-visible` rings, with a row-level inset ring for borderless inputs
  inside inset cards so the ring isn't clipped (B8); sheet body-block radius unified to
  `--radius-md`; and deletion of the dead `.settings-provider-sheet` rule + the unwired
  `settings-connection.css`. **#106 (WI-2, migration):** General / Permissions / Skills /
  Agent Profiles moved onto the `InsetGroup`/`InsetRow` idiom (Providers is the reference) —
  no panel titles (rail naming + a one-line muted intro), flat bottoms, filled `--fill-2`
  secondary buttons, text-only empty states, a unified `.settings-chip` + neutral banners, and
  switches/selects relocated to a trailing slot (a new `InsetRow` `wrap` variant), netting −134
  lines of bespoke CSS. Gate: typecheck clean, renderer 293/0, token guards 8/8, agent-settings
  + oauth e2e 21/21; light + dark visual verification passed all five panes; spec synced (A6).
  ([#105](https://github.com/relixiaobo/lin-outliner/pull/105),
  [#106](https://github.com/relixiaobo/lin-outliner/pull/106))

- **Provider settings polish — list tile, auth-sheet hierarchy, OAuth clarity (PR #101)** —
  Parts B/C/D of `provider-config-cleanup.md` (Part A, the core fix, is still in rework after
  the review gate — see TASKS). **B:** every provider mark — vendored brand logo or monogram —
  now sits on one neutral `--fill-2` tile (a bare logo previously read as a "missing
  background"), and provider-row separators are inset on **both** edges via a new tunable
  `--inset-separator-inset-right` on the inset-list primitive (left aligns to the icon tile, a
  matching right inset keeps the hairline within the card). **C:** the auth-sheet primary button
  (`.settings-sheet-primary`) becomes a genuinely strong **neutral** fill — `--surface-inverse`
  + `--panel-bg` text, the same "filled default button" language as `.agent-settings-primary`
  and the composer send button — instead of the faint `--fill-3` tint that read weaker than the
  bordered secondary (status colour stays reserved for status; danger for destructive actions).
  **D:** the Anthropic OAuth hint now names it as the same Claude account Claude Code / claude.ai
  use (pi-ai ships no separate "Claude Code" provider — the Anthropic OAuth flow *is* the Claude
  subscription login), with a new `oauthProviderCoverage` guard test so a future pi-ai OAuth
  provider can't silently surface without sign-in copy. Also adds display names for all 32 pi-ai
  providers and a Xiaomi MiMo brand icon (with `ICON_ALIASES` so the regional token-plan variants
  reuse the one mark). Renderer/CSS/copy only; B1/B11 token guards green; spec updated
  (`design-system.md`, A6). ([#101](https://github.com/relixiaobo/lin-outliner/pull/101))

- **Unified inline mention language (PR #89)** — implements `unify-mention-language.md`.
  One inline-mention language across the outliner, agent composer, and agent message: a
  **node reference is plain accent text with no icon**, and a **local-file / directory / image
  reference is a leading monochrome icon + name** — same rule, same mechanism in all three
  render sites. The icon is a shared `mask-image` glyph (`inline-ref.css`, keyed by
  `data-file-icon-kind`) painted with `currentColor`, so it themes automatically in dark mode
  (B1/B8) — replacing the composer's full-color macOS folder raster that clashed with the
  monochrome/rose surroundings and didn't theme. The kind classifier and `toDOM` children move
  into a shared `src/renderer/ui/editor/inlineFileIcon.ts` (one source of truth), the
  `inline-flex`+`translateY` baseline hack is dropped, and the divergent
  `.agent-composer-inline-file*` / `.agent-message-inline-file*` chip species are deleted.
  Outliner file refs gain the same icon so it is truly one language, not two. Renderer-only;
  no core/protocol surface; spec updated (`design-system.md`, `agent-progress.md`, A6).
  ([#89](https://github.com/relixiaobo/lin-outliner/pull/89))

- **Workspace shell: tabs removed, split panes kept (PR #85)** — implements
  `workspace-tabs-to-single-pane.md`. The multi-**tab** concept is gone; the multi-**pane**
  split view stays and panes become the single top-level canvas primitive. `tabs[] +
  activeTabId` flattens to one `WorkspaceLayout { activePanelId, panels[] }`; tile `size`
  moves onto each panel (the parallel `panelSizes` map is deleted); localStorage bumps
  `:v1`→`:v2` (v1 dropped on load, pre-release). Hooks/flags renamed to tell the truth
  (`useWorkspaceTabs`→`useWorkspaceLayout`, `wantsNewTabFromClick`→`wantsNewPaneFromClick`,
  `NavigateRootOptions.newTab`→`newPane`). Default layout is a **single Today pane**;
  Cmd/Ctrl+click a reference opens a new split pane (replaces the rightmost root at the
  4-pane cap). The sidebar tree shows all root sections (Schema/Settings no longer hidden);
  right-click "Open" → "Open in split pane"; the node **Appearance** (icon/banner)
  context-menu item + submenu are removed (T4 — no UI entry point to set/clear a node
  icon/banner remains, by design). Review-gate hardening: debug-only canvas states no longer
  wipe the canvas (`navigateRoot`), silently drop an agent-debug session (`openPanel` at the
  cap now reverse-finds an outliner pane), boot into a rootless canvas (`sanitizeLayout`
  rejects an all-debug persisted layout), or mis-target page-history / Cmd+M (`activeOutlinerPanel`
  is strict; the ambient fallback drives only sidebar/drag). Net ~−990 lines; no `src/core`
  protocol change. Spec rewritten for the no-tabs model (`docs/spec/workspace-layout.md`, A6).

- **Sidebar / agent rail toggles use static `PanelLeft` / `PanelRight` icons (main)** —
  the two window-chrome rail toggles drop the open/close chevron-swap glyphs
  (`PanelLeftClose/Open`, `PanelRightClose/Open`) for one clean static icon per side;
  open/collapsed state reads from the deepened glyph colour alone (B6), not a glyph swap.
  The workspace-layout guard updated to assert the static glyph + colour-carried state.
  (main)

- **Agent composer is a flush input region, not a floating card (main)** — the
  composer surface drops its `--layout-gap` inset and `--agent-composer-radius`
  card: it is now full-bleed to the rail's side and bottom edges with a neutral
  `--fill-1` background, rounded TOP corners at the rail's own `--panel-radius`
  (the dock's `overflow:hidden` rounds the flush bottom to match), and uniform
  padding. Focus and drag deepen one neutral step to `--fill-2` — no border, no
  brand ring (B3). `design-system.md` (concentric chain + Agent component) and the
  composer geometry guard test updated to match. (main)

- **Provider model dropdowns rank by recency, not a static preferred list** —
  replaces the hand-maintained `PREFERRED_MODEL_IDS` allowlist (which sorted any
  unlisted model to the bottom via `MAX_SAFE_INTEGER`, silently burying Claude Opus
  4.8 / Sonnet 4.6 and keeping them out of the `models[0]` default) with a
  recency-first comparator in a new pure module `src/main/modelRanking.ts`. Ordering:
  product line (version-independent, only so a side line like `gemma-4` can't outrank
  the `gemini-3.x` flagship line) → numeric version desc (the recency signal —
  `gemini-3.5-flash` over `gemini-2.5-pro`, and `4-10` > `4-9`) → `reasoning` → clean
  alias before its dated snapshot → id. Price is deliberately unused (newer Anthropic
  models are cheaper + regional skew, so cost is anti-correlated with recency). The
  default now tracks the current flagship automatically and new model versions need
  zero code changes; the only human-maintained input is `MODEL_LINES`, whose staleness
  is caught by `findUnknownLineModels` + live-catalog guard tests
  (`tests/core/modelRanking.test.ts`).
  ([#67](https://github.com/relixiaobo/lin-outliner/pull/67))
- **Native-feel component pass (CSS-only, PR-C)** — tightens the chrome to the
  strict-native cursor/affordance policy across components. Field-value
  affordances and rail toggles now signal hover/active by deepening color
  (`background: transparent`, `transition: color`) instead of a `--fill-*` box
  (B6); the row bullet deepens its dot color on hover instead of `transform:
  scale` (B7, no layout shift); non-link controls (approval toggle/button, tag
  label) drop `cursor: pointer` so the pointing-hand cursor is reserved for
  content hyperlinks (A5/B10), pinned by a new `cursor-affordances` e2e guard;
  overlays move onto the tiered elevation tokens (menus level-1, dialogs/palette
  level-2, D3); agent chrome text is `user-select: none` (A8); and agent surfaces
  use the semantic `--text-secondary` token (D5). No DOM/behavior changes.
  ([#65](https://github.com/relixiaobo/lin-outliner/pull/65))
- **Upgraded the agent core (`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`) 0.75.4 → 0.78.0.** Brings Claude Opus 4.8 model metadata + Opus adaptive-thinking (0.77.0), a provider retry/timeout overhaul (0.76.0: `maxRetries` reliably honored, SDK retries default to 0, billing-429s no longer retried), `isContextOverflow` detection fixes, Anthropic-compatible replay fixes, and session-disposal abort of in-flight agent/compaction/retry/bash work (0.77.0). Underlying provider SDKs unchanged; only new transitive dep is `@smithy/node-http-handler@4.7.3`. Type-compatible (typecheck clean); no Lin call-site changes needed (we pass `SimpleStreamOptions.maxRetries` explicitly only when configured). ([#66](https://github.com/relixiaobo/lin-outliner/pull/66))
- **Field values no longer have a cardinality** — the single/list `FieldType`
  cardinality concept is removed end to end (`FieldCardinality`,
  `SCHEMA_CARDINALITIES_ID`, the `cardinality` config key/schema/projection, and
  the definition-config Cardinality control). Every value is a node and always
  appends; selecting an option appends a (deduped) reference rather than replacing.
  The done-state checkbox mechanism keeps its binary replace semantics explicitly:
  the forward mapping clears-then-selects, and the reverse mapping now drops the
  opposite-mapped option so a mapped field never holds both checked and unchecked
  at once (#64).
- Dark mode now follows the OS via `@media (prefers-color-scheme)` with `color-scheme: light dark` (native scrollbars/controls theme correctly; the `[data-theme]`+JS bridge and `theme.ts` were removed) (PR-B, #63).
- **Design system — floating-rails shell, neutral token migration,
  dark-follows-OS** — dissolves `TopBar` into a persistent `WindowChrome` (a top
  drag strip that reserves the traffic-light inset plus two centreline rail
  toggles) and per-pane breadcrumb headers; the global tab strip, `WorkspaceTab`,
  and global Back/Forward are gone — the sidebar is now the tab switcher (select /
  create / close), per-pane Back lives in the breadcrumb, and page-nav is on
  `Cmd+[` / `Cmd+]`. The sidebar and agent rails **float** (inset, rounded
  `--radius-panel`, `--shadow-rail`, material + `backdrop-filter` + `--rail-edge`)
  over a full-bleed opaque canvas; the agent rail unfurls from a collapsed seed
  to the open panel without ever remounting `AgentChatPanel` (chat scroll +
  composer draft survive). Components move onto the alpha-on-ink token layer:
  `rgba` → alpha-on-ink tokens, the deprecated rose `--primary*` family →
  neutral `--fill-*` / `--focus-ring` / `--outline-focus` (the family is now
  deleted, zero references), inline-ref blue → rose centralized at the token
  layer, `--danger` → `--status-danger`, new `--text-on-accent`. `theme.ts`
  mirrors the OS colour scheme onto `[data-theme]` so **dark follows the OS**
  (a persisted in-app light/dark/system toggle via `nativeTheme.themeSource` is
  deferred to #45). Resize handles gain double-click-to-reset; the pre-paint
  window background follows `nativeTheme` so a dark-OS launch never flashes a
  light frame. ([#57](https://github.com/relixiaobo/lin-outliner/pull/57))
- **Native-feel stage 3 — strict-native cursor + system font** — removed
  `cursor: pointer` from every chrome control (buttons, toggles, bullets, rows,
  tabs, `summary` disclosures); the pointing-hand cursor is now reserved for
  genuine content hyperlinks (inline references, clickable tag chips, external
  doc links). `--font-family-sans` now leads with `-apple-system` /
  `Segoe UI Variable` so text renders in the platform UI font, keeping `Inter`
  only as a late fallback.
  ([#46](https://github.com/relixiaobo/lin-outliner/pull/46))
- **Inline/code styling on design tokens + simplified agent wording** — inline
  code and code blocks now use shared `--font-code-inline` / `--font-code-block`,
  `--line-code-*`, `--inline-code-bg`, and `--primary-muted-text` tokens (inline
  code reads as a compact badge with `box-decoration-break: clone`) instead of
  ad-hoc font stacks and rgba backgrounds. Product-facing agent/tool wording was
  simplified so the agent keeps the `Lin Agent` identity without over-describing
  itself as a separately branded outliner: "Lin Outline Format" → "outline
  format", "local file root" → "default file area"/"allowed file area", and the
  system-prompt identity line is trimmed. The `dangerouslyDisableSandbox` bash
  parameter is removed from the tool schema (still checked in the policy layer as
  defense-in-depth). ([#51](https://github.com/relixiaobo/lin-outliner/pull/51))
- **Config-as-nodes — definition config lives in the node tree** — definition
  (tag/field) configuration no longer lives as flat typed `Node` fields. Each
  knob is a `defConfig` child node (stable id, locked structure) whose value is
  held as its own child node(s) — the same mechanism field values use: scalars as
  a value node (codec-validated text), refs/enums as a `reference` to a target or
  a derived `systemOption` node. Reads go through typed accessors over
  `buildConfigIndex`; writes go through one registry-governed `setConfigValue`
  chokepoint. Config nodes stay in the projection (so reference labels resolve)
  but are excluded per-consumer via a shared `isInternalConfigNode` predicate. The
  cutover migrated `color`, `extends`, `childSupertag`, `fieldType`, `cardinality`,
  `nullable`, `hideField`, `autocollectOptions`, `autoInitialize`,
  `minValue`/`maxValue`, `sourceSupertag`, `showCheckbox`, and `doneStateEnabled`.
  `FieldType` is slimmed 13 → 8 (`plain`, `options`, `options_from_supertag`,
  `date`, `number`, `url`, `email`, `checkbox`); retired types fall back to `plain`
  instead of crashing. ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **Settings panel info architecture & style normalization** — the agent
  Settings dialog is reorganized from two categories into three: **Providers**,
  **Skills**, and **Agent Profiles**. Providers now infer credential state
  automatically — the "Enabled" toggle (introduced in #38) is replaced by a
  "Set as Active" action with `Active` / `Configured` badges and a list status
  dot (green = active, filled-soft = configured-but-inactive); the API key field
  gains a reveal mask plus a remove (trash) action, Base URL collapses into an
  "Advanced Settings" disclosure, and a "Test Connection" button reports a
  one-shot diagnostic (401 / 404 / 403 / timeout classified). The **Skills** tab
  adds global behavior switches (Automatic Skills, Slash Skills, Compact) and a
  per-skill enable/disable list; the **Agent Profiles** tab pairs a list with a
  read-only detail card (persona prompt, model / reasoning / permission / max-turns,
  tools) and per-agent enable/disable. Disabled skills and agents are filtered
  from model/slash listings and rejected at invocation and spawn. Backed by new
  IPC: `agent_list_all_skills`, `agent_list_all_definitions`, and
  `agent_test_provider_connection`. Supersedes parts of #38 (enablement toggle)
  and #39 (inline Base URL). ([#42](https://github.com/relixiaobo/lin-outliner/pull/42))
- **Custom-provider add button at the top; in-place model search** — the pinned
  "Custom provider" row at the bottom of the provider list is replaced by a
  compact "+" button beside the search box (active fill while the custom draft is
  open). The model search no longer opens as a separate row below the "Models N"
  heading — the search icon expands in place into an inline field (icon + input +
  close) that fills the header row; closing clears the query.
  ([#40](https://github.com/relixiaobo/lin-outliner/pull/40))
- **Provider detail layout polish + brand icons** — the single-field "Advanced"
  disclosure is gone; Base URL shows inline (optional override, default-endpoint
  placeholder) for every non-managed provider. The read-only model catalog is no
  longer collapsed — it renders inline, with the search field tucked behind a
  search icon beside the "Models N" heading that expands a small input (only when
  a provider has more than one model). Provider list rows and the detail header
  now render real brand logos (color variant where one exists, monochrome mark
  for inherently single-color brands like OpenAI / Vercel / Grok), resolved at
  build time from vendored SVGs; providers without a logo keep the monogram
  fallback. Icons are MIT, vendored from `@lobehub/icons-static-svg` with no
  dependency added. ([#39](https://github.com/relixiaobo/lin-outliner/pull/39))
- **Provider enablement gated on a credential; list status + control polish** —
  "Enabled" now means set up and usable: the toggle is disabled until the
  provider has a credential (key / env key / non-key auth), pasting a key
  auto-enables, and save persists the effective state (never enabled without a
  credential). The provider list shows an enablement dot (green = on, hollow =
  configured-but-off). The search box now uses the design-system field idiom
  (icon + soft border) instead of the bare global input, and selecting a provider
  uses a background fill rather than an outline.
  ([#38](https://github.com/relixiaobo/lin-outliner/pull/38))
- **Correct auth class for OAuth / managed-credential providers** — pi-ai
  authenticates providers three ways, but settings modeled every one as a
  pasteable API key. OAuth providers (GitHub Copilot, OpenAI Codex) and
  managed-credential providers (Amazon Bedrock via AWS, Google Vertex via gcloud
  ADC) now show a credential note explaining the real auth method (+ docs link)
  instead of a misleading key field; the Models disclosure stays. API-key
  providers are unchanged. Full OAuth sign-in is specced in
  `docs/plans/agent-oauth-providers.md`.
  ([#37](https://github.com/relixiaobo/lin-outliner/pull/37))
- **Declutter provider detail (progressive disclosure)** — the provider detail
  had buried its primary task (paste an API key) under repeated status and two
  long lists. The API key is now the hero; Base URL moves into a collapsed
  **Advanced** disclosure (known providers) and the read-only model list into a
  collapsed **Models (N)** disclosure. Dropped the dialog subtitle, the duplicate
  middle "Providers" heading + its disconnected right-floating caption, and the
  "ADD KEY" badge (the empty key field conveys it); the badge now shows only
  Active / Disabled / New. Custom providers keep Provider ID + Base URL visible.
  ([#36](https://github.com/relixiaobo/lin-outliner/pull/36))
- **Provider detail: toggle, key-first order, read-only model list** — the
  Enabled control is now the shared switch toggle (was a checkbox); the API key
  is the first field with Base URL ("Optional") below it (was reversed);
  "Remove key" appears only when a key is actually saved, as a subtle danger link
  in the key's meta row (was a permanently-disabled button); and each provider
  shows a read-only list of its catalog models (name, id, reasoning, context)
  with a count and a search box for large catalogs (OpenRouter exposes 266). No
  per-model enable/disable or fetch — that needs backend work.
  ([#35](https://github.com/relixiaobo/lin-outliner/pull/35))
- **Searchable provider list with pinned Custom + correct names** — follow-up to
  the three-pane Providers settings for the real ~32-provider catalog: a
  "Search providers…" box filters the list, the "Custom provider" entry is pinned
  below the scroll area (no longer buried after every known provider), display
  names get acronym-aware casing (Azure OpenAI, Cloudflare AI Gateway, GitHub
  Copilot, …) via an explicit map + token overrides, and the status dot renders
  only for providers with a meaningful state instead of a hollow dot on every
  row. ([#34](https://github.com/relixiaobo/lin-outliner/pull/34))
- **Three-pane Providers settings with metadata** — the Settings dialog's
  Providers category becomes a three-pane layout: category nav, an always-visible
  scrollable provider list (a monogram avatar + name + a status dot), and the
  selected provider's detail. The textual status moves to a badge in the detail
  header next to the Enabled toggle and a data-driven description
  (`Includes <top models>`). The API key field gains a show/hide reveal toggle
  and a "Get your <provider> API key" docs link (for providers we can link), and
  Base URL is now offered as an optional override for every provider — placeheld
  with the provider's default endpoint — not just custom ones (Provider ID stays
  custom-only). Backed by a new optional `AgentProviderOption.defaultBaseUrl`
  sourced from the catalog. ([#33](https://github.com/relixiaobo/lin-outliner/pull/33))
- **Settings window with provider / agent categories** — the cramped "Agent
  settings" dialog (which stacked provider connection, model + reasoning, and
  global behavior in one scroll, with a duplicate "Provider ID" field, a doubled
  "No key", and a pink "SETUP" box) is now a "Settings" window with a left
  category nav. **Providers** is connection-only: a clean provider row list
  (known providers + a `Custom` OpenAI-compatible entry), one API key with a
  single status line, and Enabled — Provider ID / Base URL surface only for a
  custom provider. **Agent** holds model + reasoning (active-provider defaults,
  key-gated) and behavior (permission mode, skills, directories). The composer
  model menu and the backend commands are unchanged.
  ([#31](https://github.com/relixiaobo/lin-outliner/pull/31))
- **Sidebar tree shows only a node's own icon** — the workspace tree no longer
  paints hardcoded fallback glyphs on system nodes (the calendar on Daily notes,
  plus the library / search / trash glyphs), since those nodes carry no icon of
  their own. The top primary-nav shortcuts (Today / Library / Recents / Schema)
  keep their icons. ([#30](https://github.com/relixiaobo/lin-outliner/pull/30))
- **Humanized day-note titles, no date header icon** — a daily-note panel titled
  with its raw ISO date (`2026-05-13`) above a calendar icon now shows a humanized
  read-only label instead: the weekday/month/day (`Wed, May 27`), prefixed with
  `Today` / `Tomorrow` / `Yesterday` for the adjacent days (`Today, Wed, May 27`),
  matching nodex. The docked breadcrumb's current-page label uses the same string,
  and the today panel's calendar header icon is removed so date nodes carry no
  header icon. Day nodes are locked, so this is display-only — the `YYYY-MM-DD`
  content is untouched. ([#29](https://github.com/relixiaobo/lin-outliner/pull/29))
- **Tool output shows the model-visible payload** — the agent tool-call Output
  region now renders exactly the slimmed `content` the model received (a
  syntax-highlighted JSON envelope) instead of reconstructing the fuller
  `details` envelope. This makes "what you see" match "what the model got" and
  removes the prior live-vs-reload inconsistency (`details` is not persisted).
  ([#19](https://github.com/relixiaobo/lin-outliner/pull/19))
- **View toolbar redesign** — per-node Display / Group by / Sort by / Filter by
  moved from inline panels to anchored popovers that no longer shift the row
  list; progressive, field-type-aware filter editors (boolean / options / date /
  number / text); date-aware filter matching; humanized group labels and
  field-semantic sort directions; an active-state summary line; and removal of
  the non-functional "View as" switcher.
  ([#9](https://github.com/relixiaobo/lin-outliner/pull/9))
- **Structure-aware clipboard paste** — inline marks, fenced code into code
  blocks, rich-HTML routing, and single-line URL linking; later extracted into a
  shared `classifyMediaPaste` classifier used by both the inline editor and the
  trailing input (Phase 1 of the node-line editor unification).
  ([#5](https://github.com/relixiaobo/lin-outliner/pull/5),
  [#11](https://github.com/relixiaobo/lin-outliner/pull/11))

### Fixed

- **Page-header icon stays visible in dark mode (PR #148)** — the neutral system-page header icons
  (Library / Schema / Trash / Saved searches), rendered in a `.panel-header-icon` chip styled with
  `mix-blend-mode: multiply` (tuned for a light backdrop), crushed to near-black on the dark content base
  and read as missing (user-reported on Library). A `@media (prefers-color-scheme: dark)` override now
  drops the blend to `normal` so the glyph renders at its intended `--muted-2` tone — the same blend-normal
  the tagDef header icon already used. One isolated override in `panel.css`; the tag `:has()` case (higher
  specificity, already normal) is unaffected. Gate: typecheck + CSS-specificity verification.
  ([#148](https://github.com/relixiaobo/lin-outliner/pull/148))

- **Agent stop button + streaming indicators look right (PR #137)** — the composer **stop button**
  rendered a 10px filled square inside the 28px inverse-fill disc — undersized, and near-white-on-dark
  felt off; the StopIcon is now 14px so the rounded square sits proportionally in the disc (light + dark).
  Separately the **streaming "still generating" signals** (inline `.agent-stream-caret` via `--caret`, and
  the standalone `.agent-streaming-capsule` pulse) painted in brand rose `--accent`, reading as a loud rose
  bar competing with rose links / inline references in the same panel. These are functional state
  indicators, not brand marks (B3/B4): the caret is now neutral via `--text-primary` (inverts with `--ink`)
  and the capsule via `--text-secondary`; the pulse animation carries the liveness. Gate: typecheck +
  token-guard e2e (`typography-tokens.spec.ts`) 8/8 + light/dark visual verification; no raw hex /
  non-token values added (B11). ([#137](https://github.com/relixiaobo/lin-outliner/pull/137))

- **Nested rows now reflect drag / cmd-click multi-selection (PR #136)** — dragging or modifier-clicking to
  multi-select the children **inside an expanded node** did nothing visible — the rows never got the
  `selected` highlight until an unrelated render woke them up ("re-enter a node to fix it"); direct children
  of the view root were fine. Not a focus race: the selection *state* was correct, the `.selected` *class*
  was stale. A row computes that class during its own render from the prop-drilled `ui`; a nested row
  receives `ui` only through its owning expanded ancestor, and the `outlinerItemPropsEqual` memo comparator
  let that ancestor bail out (freezing the forwarded `ui`) when its own memo state was unchanged — it forced
  an ancestor re-render for `expanded` changes but not for selection/focus. (Supertag correlation was
  incidental: tagged nodes routinely carry an expanded child list.) Fix: generalize the expanded-only
  forward to the full set of `ui` slices a descendant's `deriveRowMemoState` reads (focus + selection +
  pending-reference), gated on the row being expanded so only ancestors that own a nested view re-render;
  `focusRequest`/`pendingInputChar` keep their precise `focusAncestorToken` detection. Gate: typecheck +
  `test:renderer` 354/0 + `outliner-selection`(+keyboard) 34/34 incl. new nested drag-select / cmd-click
  regressions + light/dark visual; clean cross-PR merge with #134's `OutlinerItem.tsx` edit.
  ([#136](https://github.com/relixiaobo/lin-outliner/pull/136))

- **Checkbox-row long text wraps beside the checkbox, not under it (PR #131)** — on a checkbox row (a node
  with a Done field / `completedAt`), long content wrapped onto its own line **underneath** the 16px+5px
  done checkbox instead of beside it, breaking the hanging indent. Root cause: `.row-editor` is an
  `inline-block` capped at `max-width:100%`, so it could not share the first line with the 21px checkbox
  gutter and the whole block dropped to the next line. Fix: one CSS rule reserves the gutter, scoped with
  `:has()` so only checkbox rows are touched — `.row-content-line:has(> .done-checkbox) > .row-editor {
  max-width: calc(100% - 21px); }`. The editor now stays beside the checkbox and wraps in a column aligned
  to the text start. Gate: typecheck + new `outliner-checkbox-wrap.spec.ts` guard (editor sits right of +
  shares the checkbox's first line + wraps >1 line; fails pre-fix) + light/dark visual; cross-PR merge with
  #133's outliner.css edit verified conflict-free. ([#131](https://github.com/relixiaobo/lin-outliner/pull/131))

- **Definition template/options blocks invite content via an empty-state placeholder (PR #134)** — a
  tagDef's *Default content* and an options fieldDef's *Pre-determined options* block used to read as an
  orphaned ALL-CAPS label over a near-invisible ghost bullet when empty (the PM's "looks weird"). The
  geometry was never different from a populated field (label left 261px, outliner left 240px in both) —
  the gap was purely content state. The block's trailing draft now carries an "add here" call-to-action
  (`Add default content…` / `Add an option…`) via the existing empty-row placeholder mechanism
  (`.row-editor.is-empty::before`, hidden on focus); the generic body trailing draft stays unlabeled.
  `definitionOutlinerPlaceholder()` mirrors `definitionOutlinerLabel()` one-to-one and threads through
  `NodePanel` → `OutlinerView`/`OutlinerFlatView` to the root-level trailing draft only. The companion
  modelling question (a dedicated option node type) was shelved — Tana/nodex already model options &
  template items as plain id-referenced nodes, so a new type would be more machinery, not less. Gate:
  typecheck + `test:renderer` 353/0 + `definition-config.spec.ts` 3/3 + i18n 832/832 + light/dark visual;
  verified the cross-PR auto-merge with #132's `filePreview` i18n keys is conflict-free and preserves both.
  ([#134](https://github.com/relixiaobo/lin-outliner/pull/134))

- **Sidebar system-node icons restored; tagDef header + colour-picker selection (PR #133)** — three
  sidebar/tag visual fixes. (1) The workspace-tree system rows under Root regained their per-type icons
  (Daily Notes → calendar, Library → library, Schema → supertag, Saved searches → search, Trash → trash)
  via a new `systemIconForNode` mapping in `Sidebar.tsx`, reversing the icon removal from #30 (PM-ratified);
  the `workspace-layout` guard now asserts exactly one icon per system row. (2) The tagDef NodePanel header
  accent chip was being crushed in dark mode by the wrapper's `mix-blend-mode: multiply` — `panel.css` now
  resets `background: transparent; mix-blend-mode: normal` on `.panel-header-icon:has(> .panel-header-tag-icon)`
  so the solid accent fill + white hash reads cleanly in both themes. (3) The selected colour swatch swapped
  the too-faint `--border-emphasis` border for a strong ink ring with a surface-coloured gap; the multi-layer
  shadow lives in a new `--swatch-selected-ring` token (matching `--view-radio-checked-shadow`) so it satisfies
  the box-shadow token guard. Gate: typecheck + `test:renderer` 353/0 + `typography-tokens` 8/8 +
  light/dark visual verification (sidebar icons, tagDef header chip, selected-swatch ring).
  ([#133](https://github.com/relixiaobo/lin-outliner/pull/133))

- **Agent: process block collapses by default; one spinner; never auto-collapses (PR #129)** — the
  thinking/tool process block had three flaws while live: it auto-expanded during a run (instead of a
  compact status), the header *and* the running tool both span (two spinners), and once prose arrived the
  default flipped expanded→collapsed and snapped shut on a user mid-read. New model: the block is
  **collapsed by default in every steady state**. While live + collapsed the header doubles as a status
  line (currently running tool → latest streaming thought, 80-char first-line preview → `Thinking...` →
  `Working...`) and carries the **single** activity spinner; expanding moves the spinner to the running
  tool row inside the timeline and reverts the header to the static group summary. `defaultExpanded` is
  now `turnFailedWithoutProse` only — it never flips on seal, so a user-expanded block keeps its sticky
  override and **never auto-collapses**; only a turn that failed without any prose auto-expands to surface
  the error. Renderer-only (`AgentProcessBlock.tsx`); no new i18n strings. Gate: typecheck +
  `test:renderer` 353/0 (added live-collapsed running-tool / thought-preview / fallback + live-expanded
  static-summary cases) + light/dark visual verification of a live streaming turn (collapsed status line
  with one header spinner; expanded shows zero header spinners and exactly one tool-row spinner).
  ([#129](https://github.com/relixiaobo/lin-outliner/pull/129))

- **Agent: inline node references render as `<a>`, not `<button>` (PR #127)** — in an agent response an
  inline node reference (the rose link) dropped onto its own line with an empty gap before it instead of
  flowing with the sentence. Root cause (corrected from the closed #126, which had wrongly blamed a stray
  model `\n`): interactive references rendered as a `<button>`, an **atomic inline box that cannot break
  across lines** — when it didn't fit the remaining line width it jumped to the next line as a whole, and
  sat ~3.5px off the text baseline. References now render as **`<a href>`**: inline, breakable across
  lines (honoring `.inline-ref { box-decoration-break: clone }`), baseline-aligned, natively
  focusable/clickable/keyboard-activatable. The synthetic `#lin-node:<id>` href (always `#`-prefixed and
  `encodeURIComponent`-escaped) is intercepted (`preventDefault` + `stopPropagation`) and never
  navigated; both render sites (`AgentMarkdown`, `AgentInlineReferenceText`) updated and the scheme prefix
  centralized. Two coordinated CSS keys so anchors don't change the look: `.agent-markdown a` →
  `a:not(.inline-ref)` (the generic rose-link underline must not override inline-ref styling now that refs
  are anchors), and `.agent-message-inline-ref:not(button)` → `:not([href])` (interactive vs
  non-interactive now keys on `href`, both being non-`<button>`). `white-space: pre-wrap` is left
  untouched, so the model's genuine line breaks are preserved (no #126 tradeoff). Supersedes the closed
  #126. Gate: typecheck + `test:renderer` 347/0 + `agent-composer` e2e 34/34 (inline-ref click + cmd+click)
  + light/dark visual (`display:inline`, baseline delta 0px, rose color, no rest underline) + A3 confirmed
  (same-document hash, click intercepted, cmd/middle-click → window-open deny). ([#127](https://github.com/relixiaobo/lin-outliner/pull/127))

- **Agent: code blocks readable in dark mode (PR #125)** — agent (and outliner) code blocks were
  highlighted with a single `github-light` Shiki theme, so syntax tokens were near-invisible on the dark
  surface. Shiki now loads both `github-light` + `github-dark` and emits per-token `--shiki-light` /
  `--shiki-dark` CSS variables (`codeToHtml` with `defaultColor: false`), resolved via
  `@media (prefers-color-scheme: dark)` — pure CSS, no JS theme bridge (design-system **B2**). Also
  flattened `.agent-tool-code` (dropped the redundant border / background / overflow box) and corrected
  chevron-center alignment. App-wide: the outliner and agent code blocks share the same highlighter. Gate:
  typecheck + `test:renderer` 347/0 + outliner-code-block / agent-process e2e + light/dark visual (tokens
  adapt to github-dark, readable in both themes). A pre-existing `typography-tokens` guard failure on
  `shell.css:59` (`transition: background-color 0ms`) is unrelated to this PR. ([#125](https://github.com/relixiaobo/lin-outliner/pull/125))

- **Startup: no more per-launch macOS keychain password prompt** — the unsigned local build
  (`mac.identity: null`) can't present a stable code signature to the macOS Keychain, so Chromium's
  `os_crypt` (cookie / network-state encryption) re-prompted for the keychain password on *every*
  launch — independent of the app's own secret storage (that keychain use was already removed in #115).
  `main.ts` now sets `app.commandLine.appendSwitch('use-mock-keychain')` before `ready`, so `os_crypt`
  never touches the real Keychain. Trade-off: cookie/network-state encryption uses a static key instead
  of a keychain-derived one — acceptable for a local single-user app whose agent keys are already local
  `0600` JSON (the deliberate #115 posture). Revisit when a Developer ID-signed build ships. Fast-track,
  PM-ratified.

- **Outliner: Today navigation, same-day pane restore, and batch drag/drop (PR #123)** — a cluster of
  navigation and drag fixes found in local use. **Today** now resolves/creates the current *local-date*
  node before opening, instead of trusting a possibly-stale renderer `projection.todayId`, so crossing
  midnight with the app open no longer opens yesterday; all entry points (App / command palette / `go to
  today`) route through the same ensure-first helper. **Workspace-layout persistence** gained a local-day
  guard: saved panes restore only on the same calendar day, so a launch on a later day starts at Today
  rather than reopening a stale day's panes. **Drag/drop** now supports dragging a whole block selection
  of structural roots to one target (and dropping onto a trailing draft row to append), clears stale drop
  guide lines on invalid drop / drag end / nested-hover transitions (only the nearest hovered row owns the
  guide, including nested rows), and preserves block selection/focus through a drag. A block drag is now
  **one undoable operation**: a new atomic `batch_move_nodes` core command (validate-the-whole-batch on a
  clone, then apply in one `mutate`) replaces the per-row `move_node` loop, so a multi-row drag is a single
  undo step and a single projection delta — the dedicated command keeps the protocol surface
  (`commands.ts`/`types.ts`) the move's source of truth via the shared `BatchMoveNodeInput`. Finally,
  indent-guide clicks toggle direct-child expansion again — `OutlinerItem`'s memo no longer skips an
  expanded ancestor when only a descendant's expanded state changes. Gate: `/code-review` (re-review after
  the atomic fix) + typecheck + `test:core` 79/0 (incl. a batch-move atomicity/undo test) + `test:renderer`
  342/0 + new e2e (`outliner-drag-drop`, `outliner-trailing-expand`, navigation/workspace-layout specs);
  spec synced (`commands.md`, `ui-behavior.md`, `outliner-parity-matrix.md`).
  ([#123](https://github.com/relixiaobo/lin-outliner/pull/123))

- **Agent secrets: removed the keychain prompt; secrets now stored as local 0600 JSON (PR #115)** —
  Electron `safeStorage`/macOS Keychain backing triggered a macOS password prompt during
  startup/settings reads, a poor first-run experience. Agent provider credentials (API keys / OAuth
  tokens) are now persisted as plaintext `agent-secrets.json` under `userData` with `chmod 0600` on
  the file and `0700` on its parent dir — a deliberate trade of some at-rest security for UX,
  accepted pre-broad-ship (PM-ratified). The atomic temp file is created `0600` from the start (not
  only chmod'd after the rename) so the secret is never even briefly world-readable and a crash
  mid-write can't leave a `0644` file behind; the post-rename chmod stays as a belt-and-suspenders
  guard. Old encrypted `{enc:…}` files read as empty, so a stored api-key row with no `baseUrl` is
  pruned at first launch and the user re-enters the key once. Secrets stay out of the document,
  renderer state, IPC payloads, tool results, and logs. POSIX-only; Windows ACL hardening tracked as
  a follow-up. Gate: security review (one finding fixed, two accepted/scoped) + `typecheck` +
  `test:core` (`agentProviderCredentials`/`agentProviderReconcile` 16/16).
  ([#115](https://github.com/relixiaobo/lin-outliner/pull/115))

- **Agent composer: multi-line paste keeps every line (PR #112)** — pasting multi-line text into
  the agent composer dropped everything after the first line: the composer's ProseMirror schema is
  a single paragraph and its paste handler only intercepted files, so a multi-line `text/plain`
  paste fell through to a default that can't add paragraph breaks. The paste handler now reads
  `text/plain`, normalizes newlines, and inserts each line as inline text separated by `hardBreak`
  nodes (the shape Shift+Enter already produces). Extracted a shared `linesToInlineNodes` helper so
  paste and `editorStateFromText` map text→nodes identically (also fixes a CRLF-normalization drift
  where only the paste path stripped `\r\n`). Renderer-only; gate: medium review (one cleanup, C10,
  applied) + `typecheck` + `agent-composer.spec.ts` 34/34.
  ([#112](https://github.com/relixiaobo/lin-outliner/pull/112))

- **Agent collapse: corner chrome backing no longer flashes a dark square over the rail (PR #114)** —
  collapsing the agent dock briefly painted the opaque corner chrome zone (`--bg-content`) while
  the agent rail was still sliding/fading out, so in dark mode the darker `#1e1e1e` rectangular
  backing cut across the lighter `#2e2e30` rounded rail corner for ~100ms (white-on-white in light,
  so the artifact was dark-mode-only). The collapsed zone's `background-color` now waits a
  `--chrome-zone-backing-delay` (split out of `--motion-layout` as `--motion-layout-duration`,
  160ms) before painting, so the rail finishes sliding away first; a `prefers-reduced-motion`
  override drops the delay to 0. Symmetric delay applied to the sidebar corner zone. Verified with
  a per-frame headless probe (dark): 16 "square over visible rail" frames on `main` → 0 on the fix
  (backing paints ~24ms after the rail clears). Gate: `/code-review` (medium) + dark/light visual;
  test-timing race and reduced-motion coverage hardened pre-merge. Spec updated in the same PR
  (`design-system.md` Motion; A6). ([#114](https://github.com/relixiaobo/lin-outliner/pull/114))

- **Launcher capture: escape the browser app name in the front-tab AppleScript (PR #103 follow-up)** —
  `activeTabScript` interpolated the active app's name into `tell application "…"`. It was safe in
  practice (the name is always an allow-listed browser, gated by `detectBrowserFamily`), but it was
  defense-by-allow-list rather than defense-by-escaping. The app name is now escaped for the
  AppleScript string literal (`\` and `"`), so a future caller that widens the input cannot break
  out of the literal and inject script. A `/code-review` security-gate nit on #103, hardened
  pre-emptively; no behavior change for allow-listed names.

- **OAuth sheet: Done is the primary action once connected** — in the provider OAuth
  sheet the strong-neutral primary button sat on **Re-authenticate** even after a
  successful sign-in (Connected / Active), so the loud default action read as "you must
  sign in again" when the natural next step is to finish. The connected footer now puts
  the primary on **Done** (rightmost, macOS default-button position) and steps
  Re-authenticate back to the bordered secondary; the disconnected footer is unchanged
  (Cancel secondary, Sign in primary). Exactly one primary per footer is preserved (B4).
  Renderer-only (`ProviderOAuthForm.tsx`); surfaced after #101 strengthened the primary
  fill. ([#104](https://github.com/relixiaobo/lin-outliner/pull/104))

- **Provider rows are deliberate; junk rows reconciled safely on load (PR #100)** —
  Part A of `provider-config-cleanup.md`. Fixes the "shows *Add key* yet offers *Remove
  provider*" contradiction, where the main Settings Save unconditionally minted a keyless
  provider row (for whatever provider the draft defaulted to) and `upsertProviderConfig`
  then auto-activated it. Now row creation lives in **one** place — the per-provider config
  window and OAuth login, each storing the credential *before* the row — and the main pane's
  Save persists only runtime settings; an upsert never auto-activates. A one-time **startup**
  reconcile (`reconcileProviderConfig`, `main.ts`) prunes the literal bug shape (a keyless
  api-key catalog row with no stored credential and no `baseUrl`) and repoints a dangling
  active pointer. Crucially the reconcile is **off the read path** (`getProviderSettings` is a
  pure read again) and honors two hard safety rules so a transient/ambient signal can never
  cause permanent loss: it does nothing when the secrets file is unreadable (keychain locked /
  key rotated — the `SecretsUnreadableError` invariant), and it judges rows only by durable
  signals (stored secret-file credential, `baseUrl`, provider kind), never ambient env, with
  managed (Bedrock/Vertex) and oauth kinds exempt. `ProviderConfigForm.canSave` now requires a
  real connection so a keyless no-op row can't be created from the UI. These three gate findings
  (🔴 keychain-lock mass-prune, 🟠 managed/env prune on a shell-less launch, 🟡 composer
  `provider not found`) were fixed before merge. New `agentProviderReconcile` tests (8, incl.
  unreadable-secrets + managed-exempt); spec updated (`agent-pi-mono-implementation.md`, A6).
  ([#100](https://github.com/relixiaobo/lin-outliner/pull/100))

- **Agent composer can @-mention the focused context node (PR #91)** — in the agent
  composer, `@` returned "No mentions" even when a matching node existed, and node search
  died entirely when nothing was focused. The composer reused the outliner's node-candidate
  logic, which excludes `currentNodeId` (a node can't reference itself) and returns `[]` when
  there is no current node — but the composer is not a node, and its `currentNodeId` resolves
  to the *focused/context* node, so that very node was filtered out. `buildReferenceCandidates`/
  `referenceItems`/`nodeCandidates` gain an `excludeCurrentNode?: boolean` (default `true`, so
  the outliner is byte-for-byte unchanged) and `currentNodeId` is widened to `NodeId | null`
  end-to-end; the composer passes `excludeCurrentNode: false` and drops its two `!currentNodeId`
  early returns. Renderer-only; no protocol/core surface; new guard test in
  `rowInteractions.test.ts`. ([#91](https://github.com/relixiaobo/lin-outliner/pull/91))

- **OpenAI provider error handling: schema 400 + inline failed-message render (PR #90)** —
  two fixes for a user-reported OpenAI 400. (1) `node_search`/`node_create`/`node_delete`/
  `node_edit` declared a top-level `oneOf`, which OpenAI's function-schema validation rejects
  (`schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the
  top level`); the top-level `oneOf` is removed from the four node tool schemas
  (`agentNodeToolSchemas.ts`). The mutually-exclusive argument groups are still enforced at
  runtime (the `normalize*` helpers) and documented in the descriptions, and nested
  `anyOf`/`enum` in property subschemas is untouched, so Anthropic is unaffected. (2) A
  provider/run failure now renders **inline as a failed assistant turn with a retry action**
  instead of a red banner pinned to the top of the conversation: the runtime marks the
  terminal assistant message `assistant_message.failed` (error stop reason + `errorMessage`)
  on non-aborted, non-context-overflow failures, and the top-level projection `errorMessage`
  is reserved for transient operational errors (`agentRuntime.ts`). Spec updated (A6).
  ([#90](https://github.com/relixiaobo/lin-outliner/pull/90))

- **System-node protection: `isSystemId` now covers Library and Recents** —
  `isSystemId()` (`src/core/core.ts`) omitted `LIBRARY_ID` and `RECENTS_ID`, so
  the Library section and the Recents saved-search were not treated as the
  authoritative system nodes the other sections are. Library was protected only by
  its `locked` flag, leaving `removeSubtreeDirect` (whose sole guard is
  `isSystemId`) able to hard-delete it, and `isSearchCandidate` wrongly surfaced
  Library/Recents as search results (unlike Daily notes / Schema / Trash /
  Settings). Both ids are now in the list, so they get the same structural
  protection (no move / delete / reparent) and search-exclusion as every other
  seeded section. (Fast-track, direct merge to `main`, no PR.)

- **Security: agent exfiltration redline + skill-shell ask path hardened (PR #79)** —
  the sensitive-data exfiltration hard block now recognizes opaque sinks (inline
  interpreter execution `python -c` / `node -e` / `perl -e` / `ruby -e` / `php -r`
  / `osascript -e`, and `ssh host '<cmd>'`) in addition to network-write verbs, so
  `cat ~/.ssh/id_rsa | python3 -c '...'` is a `platform_hard_block` instead of a
  downgrade to `ask`; `id_dsa`/`id_ecdsa` added to the sensitive-command patterns.
  Separately, the skill-shell permission path now routes `ask` decisions through
  the shared `resolveAgentPermissionAsk` (safe-allowlist + classifier-eligibility
  veto + unattended fail-safe) instead of jumping straight to the approval handler.
  Both changes only tighten policy. Resolves hardening item #3.
  ([#79](https://github.com/relixiaobo/lin-outliner/pull/79))

- **Agent dock header icons (＋ / bug) no longer read as blurry (main)** — they used
  `--text-faint` (ink/0.30), too low-contrast for their thin SVG strokes to resolve as
  crisp edges on the dark rail, while the 0.55 title text beside them looked sharp. They
  now share the window-chrome rail toggles' ink (`--text-secondary`, 0.55) at rest →
  `--text-strong` on hover. Not a glass/vibrancy rendering bug — a contrast one; no
  material change. The composer header guard updated to match. (main)

- **Agent dock header action icons drop the hover fill box + sit on a uniform pitch
  (main)** — ＋/bug hover/focus now only deepen the glyph colour (no `--control-hover`
  rounded-square fill), matching the rail toggles' colour-only chrome idiom (B6; focus
  ring unchanged). The right chrome zone's trailing gap is now `--space-2` (was
  `--space-4`), sliding the buttons one step toward the corner-anchored agent toggle so
  ＋→bug and bug→toggle land on the same 30px icon pitch. (main)

- **Agent composer attachment errors auto-dismiss (main)** — the inline attachment error
  is now a transient hint (`role="status"`, cleared after 5s) instead of a persistent
  banner, so the composer never carries a stale error. (main)

- **Agent dock collapse no longer janks (main)** — the rail collapsed by
  animating `width`/`top`/`right`/`bottom` (layout properties), so the transcript
  and composer re-wrapped every frame. It now slides off the right window edge via
  `transform: translateX` + `opacity` like the sidebar — a rigid GPU-composited
  layer move with no panel reflow. Glass material is applied unconditionally so it
  persists through the collapse fade instead of popping. (main)

- **Toggling Thinking no longer flickers the dock or jumps the model menu (main)**
  — two issues: (1) every model/reasoning change called `reloadSession`, which set
  the projection to empty and published it before re-fetching, flashing the whole
  transcript blank for a frame; a same-session reload now keeps the current
  projection on screen and swaps it atomically. (2) The model menu's reasoning row
  unmounted the 28px level button when Thinking was off, collapsing the row and
  jumping the menu height; the row now reserves the level-button height. (main)

- **Composer overflow scrollbar hugs the panel edge (main)** — the editor's scroll
  viewport was nested inside the surface's padding, so its native scrollbar floated
  ~12px inside the panel with empty padding to its right. The editor now breaks out
  of the horizontal padding (re-insetting its text to `--agent-content-x`) so the
  scrollbar sits at the panel edge like the transcript scroll (B10). (main)

- **Agent model menu uses the canonical menu radius (main)** — the model popover
  and its thinking-level submenu used `--radius-lg` (12) / `--radius-md` (8); they
  now use `--radius-overlay-sm` (10) like every other menu (session, context,
  settings). (main)

- **Agent composer footer controls are capsules, not rounded squares (B6)** — the
  send, attach, and model-selector controls were carrying the composer's 2px
  concentric-inset radius, so the filled send button read as a tiny rounded square
  and the model button's hover fill clashed with it. They now use `--radius-pill`:
  the 28px square icon buttons render as circles, the wide model button as a
  stadium, so every footer control shows the same corner arc (= half its height)
  and they line up. Codifies the systematic rule that interactive icon/pill
  controls are fully-rounded capsules, off the concentric *surface* radius chain
  (design-system.md + the composer layout guard test updated to match). (main)
- **Code-block language picker redesign** — replaced the native `<select>` (which
  opened an OS-styled, uncoordinated dropdown) with the shared menu primitives: a
  compact trigger whose chevron sits next to the label, opening a portaled
  `MenuSurface` popover that matches the design system. Hover now deepens text /
  icon color instead of adding a background fill, for both the language trigger
  and the copy button. ([#27](https://github.com/relixiaobo/lin-outliner/pull/27))
- **Unknown code-block languages fall back to Plain text** — a pasted fence with
  a non-language info string (e.g. `tool` / `tool-error` from an agent
  transcript) no longer shows a bogus language in the picker. A Shiki-backed
  `isKnownCodeLanguage` check coerces any language Shiki cannot highlight to
  Plain text for the label, selected value, and highlighting, while preserving
  real grammars outside the picker list (e.g. `kotlin`). The code block's
  language picker now uses the `SelectControl` primitive and `--control-size-*`
  tokens. ([#26](https://github.com/relixiaobo/lin-outliner/pull/26))
- **Pasting into the trailing draft row** — pasting structured content into the
  blank line at the bottom of the outline threw `CoreError: node not found`,
  because the eager draft row has no core node until its first character
  materializes it. The paste path now appends the pasted trees under the parent
  (via `create_nodes_from_tree`) for a pristine draft, and waits for an in-flight
  materialize otherwise. ([#25](https://github.com/relixiaobo/lin-outliner/pull/25))
- **Pasting fenced code blocks with multi-word info strings** — the paste
  parser only recognized a fence whose info string was a single token, so a
  CommonMark-valid fence like ` ```tool node_create ` leaked as plain text and
  desynced every later open/close pairing (prose swallowed into empty "Plain
  text" code blocks, real code split into one row per line). Any info string is
  now accepted, with its first token used as the language.
  ([#24](https://github.com/relixiaobo/lin-outliner/pull/24))

### Internal

- **Agent M1 memory v1 landed (PR #152)** — first M1 slice: an event-sourced, per-agent durable memory layer.
  Adds a `memory` agent tool (list/remember/update/forget), three IPC commands
  (`agent_list_memory`/`agent_update_memory`/`agent_forget_memory`), a bounded `<agent-memory>` reminder injected
  per turn (score-ranked relevant facts merged with the latest, deduped to 8), and a renderer Memory settings UI
  (edit/forget with provenance). `past_chats` stays raw-transcript recall; memory is the durable-fact layer. As
  part of landing it, the three agent event-log families (conversation, run, memory) were **unified onto one
  `AppendOnlySeqLog<TEvent>` primitive** — single-sourced JSONL serialize/read/tail (the #150
  `readLastNonEmptyLine` chunk-boundary bug class now lives in exactly one place), seq allocation + per-key write
  queue + seq cache, and offset-bounded reads — replacing the duplicated per-family scaffolding. Memory gets a
  projected-state cache (no whole-log re-read/re-sort on the per-turn prompt path), churn-based log compaction
  (`atomicWriteFile` rewrite, gated ≥64 events and ≥2× churn), and is brought under the store-owned clean-cut.
  Review: high-effort adversarial pass (7 finder angles) surfaced 7 correctness findings + the altitude call to
  generalize rather than ship a third parallel log; PM ratified generalizing in-cycle; codex fixed all and
  re-verified. Gate: typecheck + `test:core` 636/0 + `test:renderer` 355/0 + agent/workspace-layout e2e 78/0
  (runtime restore/chat path included since the generalization touched the conversation/run logs). **Next: the
  rest of M1** — canonical DM/Channels, mixed-resolution memory retrieval, ask_user_question, config tool, skill
  self-authoring.
- **Agent M0.5 clean cut landed (PR #151)** — removed the residual `session*` bridge debt now that M0 has
  shipped. The public protocol/IPC/renderer surface is renamed from `session*` to `conversation*` while the
  internal event-log key stays `sessionId` (same string value); the two are joined by an explicit, single
  translation seam — `sessionIdFromConversationId` / `conversationIdFromSessionId` at every public method
  boundary, one typed `emitConversationRuntimeEvent` translator for the closed/error/approval runtime
  events, `rendererProjectionEventFromDomain` for the projection lane, and `entryConversationId` /
  `conversationFieldsForEntry` in past-chats — so the public⇄internal boundary is named in one place instead
  of ~20 inline remaps. The UI-list shape `AgentConversationMeta` is renamed to `AgentConversationListMeta`
  to resolve the collision with the M0 data-model `AgentConversationMeta`; the `metricConversation` i18n
  label is corrected (`Session` → `Conversation`, `会话` → `对话`); the workspace-layout localStorage key is
  bumped (`:v2` → `:v3`) so pre-rename persisted panes are orphaned rather than half-read; and the
  store-owned clean-cut now also sweeps an orphaned legacy `indexes/session-index.json`. Review: 1-round
  high-effort adversarial pass surfaced 5 findings (1 shipped i18n defect, 2 latent altitude issues — the
  name collision and the missing translation seam, 2 cosmetic), all fixed by codex and re-verified. Gate:
  typecheck + `test:core` 629/0 + `test:renderer` 354/0 + agent/workspace-layout e2e 59/0. **Next: M1**
  (memory v1 + canonical DM/Channels + ask-user-question + config tool + skill self-authoring).
- **Agent M0 foundation landed; agent program PM-ratified (PR #150)** — the full M0 storage/runtime
  foundation shipped after a **5-round adversarial review**. Agent persistence is re-keyed from the flat
  `sessions/<id>/` log into split **`conversations/` + `runs/` + `agents/`** storage with joined replay,
  run-scoped payloads, `AgentRunMeta` (fingerprint + usage + retention), byte-offset-bounded seq
  checkpoints, stable identity records, an **internal domain event bus** (single publish; the renderer IPC
  send is just a lane subscriber, not a parallel dispatch), active-run state isolation, and the
  run-scoped-vs-conversation event split derived from run-scoping intent (events carrying a `runId` route
  to the run log). A **store-owned clean-cut** auto-deletes obsolete pre-M0 `agent/sessions/` + stale
  `indexes/` on first access and reconciles the session index against `conversations/` (no legacy reader,
  no migration — per the pre-release no-back-compat policy), so existing dev installs self-heal instead of
  needing a manual userData wipe. Review trail: the original 10 findings (3 perf regressions that had
  re-introduced the #116/#117 write-amplification, 3 correctness — failed/cancelled-run usage loss,
  checkpoint truncation guard, reactive-compaction prompt loss — 4 cleanup/altitude) all fixed; a
  tail-reader P0 (`readLastNonEmptyLine` truncating lines > 4 KB) introduced by the first fix, then fixed +
  regression-tested; and a runtime clean-cut session-restore failure (stale index pointing at unloadable
  ids) fixed with index reconciliation + scenario tests. Gate: typecheck + `test:core` 628/0 +
  `test:renderer` 354/0. **The agent program is now ratified — M0.5** (remove residual `session*` bridge
  debt) **then M1** (memory + DM/Channels + ask-user-question + config + skill authoring) follow.
  ([#150](https://github.com/relixiaobo/lin-outliner/pull/150))

- **Agent M0 F2a run-log join read seam (PR #149)** — replay now exposes two named read seams over the
  still-flat session log: `getAgentEventConversationPath()` returns communication only (user messages +
  final assistant replies, excluding run-scoped execution — tool-result messages and assistant turns whose
  completed content is a tool call / `stopReason: 'toolUse'`), while `getAgentEventRuntimeTranscriptPath()`
  returns the joined pi-agent-core transcript (today ≡ the active parent-linked path). The runtime
  transcript builder (`agentRuntime.ts`) and `deriveAgentPiMessages` route through the runtime seam — a
  behavioral no-op now, but the future physical `conversation`/`run` split can replace it without touching
  consumers. Runtime-emitted `tool_result.created`/`replaced` events now carry `runId` (the run-log join
  key); legacy flat events infer run ownership from the parent assistant message during replay. The
  conversation-path consumer is not wired into the renderer yet (the seam lands first), so the
  communication/execution distinction is currently latent. Gate: typecheck clean + `test:core` 611/0 (new
  run-ownership-inference + seam-split tests) + spec updated (`agent-event-log-rendering.md`).
  ([#149](https://github.com/relixiaobo/lin-outliner/pull/149))

- **Agent M0 data-model protocol types landed (interface-first, replay-neutral) (PR #147)** — the target
  conversation/run/memory contracts from `docs/plans/agent-data-model.md` are now declared in
  `src/core/agentEventLog.ts`: `AgentPrincipal`/`AgentId` (template-literal `sourceKind:instance:name`
  tuple), `AgentConversationEvent` + `AgentRunLogEvent` + `AgentMemoryEvent` discriminated unions (payloads
  per variant, incl. the full `tool.permission.checked/resolved` audit fields mirroring the real
  `ToolPermission*Event`), `AgentRunMeta` (fingerprint + retention + trigger), `AgentIdentityRecord`,
  `AgentMemoryEntry`. The **current flat session log** gains the `user_question.*` + `widget_state.updated`
  event types and an optional `actor` on `AgentEventMessageRecord`; the new events replay **neutrally**
  (bump `latestSeq`, no conversation/active-path effect) until consumers emit/project them.
  `SkillDefinition.source` gains `'built-in'`. Pure additive contract + minimal wiring; no behavior change.
  Gate (no `/code-review ultra` available to the agent): full manual protocol review + `typecheck` clean +
  `test:core` 610/0 (incl. a new replay-neutral test + actor assertions), verified spec-aligned with the
  round-4 data-model. ([#147](https://github.com/relixiaobo/lin-outliner/pull/147))

- **Agent design plans adversarially reviewed (codex + gemini) and the findings closed (docs-only)** —
  the agent plan set (`agent-data-model` / `agent-conversation-model` / `agent-program` + consumers)
  was reviewed by two independent agents; the valid findings were verified against the real code and
  applied. **Two PM-ratified decisions revised:** (1) memory writes go through a **runtime-owned,
  event-sourced append surface** (`memory.entry_added/...`), *not* the privileged `file_write` path —
  reversed because the file tools are realpath-jailed to `workspace.root` (`agentLocalTools.ts:2207`,
  can't reach `userData/agent/`) and whole-file rewrite risks lost-update; (2) memory adds
  **opt-in isolation tiers** (`isolated` / `read-only-global`) + `originWorkspace` over the global
  default, motivated by a cross-project NDA-leak case. **Data-model** also gained: a run-log **retention
  state machine** (`hot→cold-archived→summarized-only→deleted`), `RunMeta.fingerprint` (version boundary
  for "same-fingerprint replay"), a stable `agentId` tuple (`sourceKind:sourceInstanceId:name`, no
  cross-project collision), `meta.json` as a **projection** (+ `cursors` split out), `MessageEvent.forwarded`
  provenance, canonical `tool.permission.*` names, and `MemoryEntry` undo-invalidation (`status` +
  source `runId`/`eventId`). **Program** fixed M0/M1 sequencing (F2 ships the minimal run-log join in M0),
  reframed F4 (a real internal domain bus, not the renderer-IPC `emit`), and added a permission-event
  taxonomy row. **Consumer plans** de-session-ified (scheduled-routines / ask-user-question /
  generative-ui → run/conversation; self-modification consistency note). **A third round (#144) hardened the contract for the M0
interface-first PR:** the run-log event list became a real `RunEvent` **discriminated union
with per-variant payloads** (`RunEventBase` + `runId` anchor, symmetric with `MessageEvent` —
carries `requestId`/`toolCallId`/`request`/`result`/`usage`/`currentState`), and three
load-bearing invariants were pinned — the **event-log stream is the sole authority**
(`meta.json`/checkpoint/`index.json`/render projection are rebuildable projections), **replay
fidelity is gated on `RunMeta.retention`** (`summarized-only`/`deleted` can't claim verbatim
replay), and **memory invalidation has one owner** (the runtime reconciler, never the agent)
**and one trigger** (branch discard/undo, emitted as `memory.entry_updated(status:invalidated)`).
No code; plans only.

- **Agent data-structure design landed, then extracted into a dedicated `agent-data-model` plan** —
  a multi-pass design conversation converged the agent storage model and was written into the plans
  (docs-only; no code); the authoritative shape now lives in its own **`docs/plans/agent-data-model.md`**
  (single source for the persistence + context contract — F2/F3/F6 cut against it), with
  `agent-conversation-model` slimmed to the experience design + a pointer, and `agent-program` adding it as
  a member plan. The model: **three storage families** (linear event log · Loro CRDT · skills file
  tree), **one log engine with three instances** (conversation / run / memory, differing only by id /
  writer / retention / vocabulary), **`session` split into `{conversation, run}`** (messages vs execution
  — keeps the conversation log low-volume and `tool_call ↔ tool_result` off the shared channel stream),
  a **single `Principal` type** (member = actor = addressee) with conversations as **one primitive (no
  stored `kind`** — DM/group derived; spawn-don't-convert preserved as a product rule), **runs anchored
  to exactly one conversation** (trigger = provenance, no conversation-less runs), a **distillation
  ladder** (raw → segment summary → conversation summary → agent memory) generalizing `compaction.completed`
  into a **lossy-but-addressable** multi-consumer node (down-pointer to retained source; powers navigation,
  two-step `recall.overview/expand`, and the memory feedstock), and the **context volatility-ordering /
  cache-discipline invariant** (stable prefix → one volatile tail; distilled memory → prefix, query recall
  → tail; compact at segment boundaries, never slide). Validated against the real runtime: pi-agent-core is
  stateless transcript-replay driven by two seams (`deriveRuntimePiMessages` read / `handlePiAgentEvent`
  write), so the whole structure lives above the engine unchanged. `agent-program` F2/F3/F5/F6, the event
  taxonomy, and the consolidated protocol-surface list were updated to match. Four foundational decisions
  were then **PM-ratified (2026-06-05)**: **canonical DM + user-creatable Channels** (the session list
  becomes the Channel list; the DM is the always-on continuous thread); **split-now + mixed-resolution
  replay** (execution incl. `tool_result` lives only in the run log; recent turns join the run log, old
  segments render as compaction summaries — the agent stops re-seeing old tool outputs verbatim);
  **memory = one global pool with pure-relevance retrieval** (no per-workspace partition; visible/edit/forget
  is the bleed guard); **memory writes via a privileged, permission-exempt `agent-memory/` path** (serialized,
  not a dedicated tool).

- **Refresh stale workspace-layout e2e guards to floating-rails geometry (PR #135)** — three assertions in
  `workspace-layout.spec.ts` still encoded the pre-#57 sidebar/divider shape and failed on current main:
  (1) the panel-resize cursor moved from the 1px `.panel-resize-slot` (now `auto`) to a separate 10px-wide
  `.panel-resize-handle` hit strip, and the grab pill is gone (`::after` width `auto`); (2) sidebar chrome
  now aligns to the tree **chevron** control column (rail-pad 8 + content-start 6), not the label, which
  clears the chevron by a 6px gap; rows inset 8px from the floating rail; (3) a tree row's hover affordance
  is a neutral fill + chevron brighten, not a row-text colour shift. Guards re-pinned to the real shipped
  DOM/CSS (tight numeric checks, not relaxed) — `workspace-layout.spec.ts` 15/15. Resolves the pre-existing
  :61/:320 failures previously tracked as PR-C/PR-D residual. ([#135](https://github.com/relixiaobo/lin-outliner/pull/135))

- **Agent user-message UI cleanups (post-#130 review)** — two behavior-preserving tidies surfaced
  during the PR #130 gate: collapsed the nested empty-state ternary in `AgentChatPanel`
  (`!settingsLoaded ? null : hasUsableProvider ? null : X` → `!settingsLoaded || hasUsableProvider ? null : X`),
  and keyed the collapsible user-content measure on the full `text` rather than `text.length` so an edit
  to a different same-length message re-measures and resets the expand state. Fast-track; typecheck +
  `test:renderer` 353/0 + agent-onboarding/agent-process e2e 8/8.

- **Chrome-zone backing transition off a literal `0ms` (guard hygiene)** — `.window-chrome-zone`
  declared `transition: background-color 0ms`, whose literal `0ms` tripped the `typography-tokens`
  motion guard (durations must be tokenized; there is no zero-duration motion token). Rewritten as the
  longhand `transition-property: background-color` — behavior-identical (default 0s duration → instant
  paint) but with no literal `ms`, and still honoring the `transition-delay` the collapsed / agent-closed
  modifiers use to hold the opaque corner backing back until the rail finishes sliding (so `transition:
  none` was not an option). Pre-existing failure unrelated to any feature PR; fast-track, no user-visible
  change.

- **Agent permission authority folded into spec (PR #78)** — new
  `docs/spec/agent-tool-permissions.md` is the authority for the shipped
  allow/ask/deny policy (evaluation precedence, platform hard blocks, bash
  classifier, ask resolution, sensitive-data redlines, fail-closed store, events,
  UI), with a *Known divergences* section recording shipped-vs-plan gaps verified
  against the implementation. `agent-tool-design.md` Approval Policy slimmed to a
  pointer; the spec README index and the hardening plan re-pointed at the new
  spec. ([#78](https://github.com/relixiaobo/lin-outliner/pull/78))
- **AGENTS.md reorganized to best-practice structure + on-the-loop model (PR #77)** —
  restructured per Anthropic CLAUDE.md guidance (a Commands section up front,
  load-bearing first, `Stack Constraints` folded into A1, userData / packaging /
  `tmp` compressed into one Dev environment section) and folded in the
  collaboration refinements: the PM ratifies a dev-drafted one-pager (on-the-loop,
  not in-the-loop), a what-NOT-to-escalate rule, collision self-check as the dev
  agent's job, explicit cross-agent autonomy boundaries, and mechanical
  review-gate / `significant` triggers. `docs/TASKS.md` drops the hand-maintained
  plan index — the active-plan catalog is derived from `docs/plans/*.md`
  frontmatter. ([#77](https://github.com/relixiaobo/lin-outliner/pull/77))
- **Collaboration-method model folded into `AGENTS.md`; docs restructured (PR #76)** —
  the agreed PM-led parallel-planning model lands in `AGENTS.md`: the main agent
  is the end-stage gate (no up-front framing), with a review-gate table, a WIP
  cap (2 significant changes), a Draft-PR-as-claim collision radar, a
  document-system table, and the plan status legend. `docs/TASKS.md` becomes the
  single live board (folds the deleted `docs/plans/README.md` active-plan index;
  adds the `anti` clone). The 15 terminal plans move to `docs/plans/archive/`;
  the shipped status word is unified to `done`; test fixtures move under
  `tests/fixtures/`; stale references in the READMEs, active plans, and src
  comments are repointed. ([#76](https://github.com/relixiaobo/lin-outliner/pull/76))
- **Agent + launcher planning docs (PRs #72–#75)** — added the
  `agent-self-modification` controlled-self-maintenance plan plus cc-2.1-aligned
  spec guidance (#72), an OAuth agent self-configuration boundary in
  `agent-oauth-providers` (#73), the `lazy-like-global-launcher` plan (#74), and
  the `outliner-local-file-references` plan (#75). Docs-only.
  ([#72](https://github.com/relixiaobo/lin-outliner/pull/72),
  [#73](https://github.com/relixiaobo/lin-outliner/pull/73),
  [#74](https://github.com/relixiaobo/lin-outliner/pull/74),
  [#75](https://github.com/relixiaobo/lin-outliner/pull/75))
- Removed the ~1.3k-line legacy `TrailingInput` editor (plus `TrailingInputLeading`) — its trigger paths (`#`/`@`/`/`/`>`/code/checkbox/image) are re-implemented as atomic-create branches on the `OutlinerItem` trailing draft, collapsing the two-ProseMirror-editor fork to one. Removed the now-dead `resolveTrailingRow*` interaction resolvers. Fixed a focus-propagation bug where a command-outcome focus request (`panelId: null` wildcard) failed the row memo's `targetsRow` predicate and dropped focus to `<body>`; added `focusAncestorToken` so a memoized ancestor re-renders to pass a focus/pending-input request down to a nested target (#64).
- Re-armed the design-system guard e2e specs after the CSS split and floating-rails shell redesign: the typography-tokens guard now globs `src/renderer/styles/*.css` and the workspace-layout spec asserts the shipped DOM; page-title sizing corrected to 24px/32px (PR-A, #62).
- **Modularize `styles.css` into per-surface modules** — the 6851-line monolith
  is split into 30 cascade-ordered modules under `src/renderer/styles/` behind a
  `styles/index.css` barrel; concatenating the modules in barrel order reproduces
  the original byte-for-byte at the split commit. Also fixes two long-standing
  undefined-token references the split surfaced (`--font-mono` →
  `--font-family-mono`, `--control-bg` → `--fill-2`).
  ([#57](https://github.com/relixiaobo/lin-outliner/pull/57))
- **Renderer perf — per-node memo, focus memo, opt-in flat virtualization** —
  `OutlinerItem` is memoized on a per-node `renderRev` (a dev-only
  `LIN_RENDER_PROBE` measures per-command re-render cost), and the global
  `uiGen` re-render is replaced by `deriveRowMemoState` / `rowMemoStateEqual` so a
  row re-renders only when its own UI state moves (behavioural reads route
  through a live `uiRef`, so skipped rows stay correct). A windowed
  `OutlinerFlatView` is gated behind `localStorage 'lin:flat-outliner'`, so
  default behavior is unchanged. Resolved one positional merge conflict in
  `OutlinerItem.tsx` against the #53 keyboard work on the way in (both additions
  kept). ([#54](https://github.com/relixiaobo/lin-outliner/pull/54))
- **Native-feel stage 5b — incremental core state + projection caches** — the
  Core mutation/read path is now O(touched) instead of rematerializing the whole
  document and deep-cloning every node per command; the public IPC contract
  (`DocumentProjection`, `CommandOutcome`, `DocumentState`) is byte-for-byte
  unchanged. A single keystroke in a 1000-node doc dropped from ~770ms to
  ~0.27ms and the old ~2000-node loro crash is gone.
  ([#52](https://github.com/relixiaobo/lin-outliner/pull/52))
- **Native-feel stage 5a — opt-in IPC tracing (measure-first)** — `LIN_TRACE_IPC=1`
  logs one line per command (`[ipc] <command> <ms> <payload kB> nodes=<n>`) around
  the `lin:invoke` chokepoint, with zero overhead when off. The measurement proved
  serialization was a non-issue (<1ms at 1000 nodes), redirecting the stage-5b
  perf work to the Core layer.
  ([#50](https://github.com/relixiaobo/lin-outliner/pull/50))
- **Security shell — host owns navigation + capabilities (native-feel stage 1)**
  — the main process now closes the renderer's default-open Chromium surface.
  `setWindowOpenHandler` denies all child windows (http(s) `target="_blank"`
  links route to the OS browser via `shell.openExternal`); `will-navigate` /
  `will-redirect` block navigating the renderer away from its own document
  (`file://` in prod, the Vite origin in dev) and send external http(s) to the
  OS browser. Permission request/check handlers deny every capability except
  `clipboard-sanitized-write` (the only one the renderer uses). A strict
  `Content-Security-Policy` (`script-src 'self'`, no `unsafe-inline`/`eval`;
  `unsafe-inline` styles only; remote http(s) only as img/media sources;
  `connect-src 'self'`) is injected on the packaged renderer's own `file://`
  main-frame document — scoped so the agent's remote web-fetch windows are
  untouched. Verified against the built bundle and an `electron out/main` run
  (CSP applies, zero violations). The applied behavior remains scoped to the
  main window; agent web-fetch/search windows keep their own navigation
  lifecycle. ([#43](https://github.com/relixiaobo/lin-outliner/pull/43))
- **Discriminated `Node` union — god-record removed** — the ~57-field `Node`
  god-record is now a discriminated union of per-`NodeType` variant interfaces
  over a small uniform `NodeBase` (`ContentNode` = the `type?: undefined`
  variant). Content-type-specialized fields moved onto their owning variant
  (media → `CodeBlockNode`/`ImageNode`/`EmbedNode`; query params → a
  `QueryParams` mixin on `SearchNode`/`QueryConditionNode`; view rules →
  `ViewDefNode`/`SortRuleNode`/`FilterRuleNode`/`DisplayFieldNode`; `configKey` →
  `DefConfigNode`; `fieldDefId` → `FieldEntryNode`; `targetId`/`refRole` →
  `ReferenceNode`). The query-rule target that `search`/`queryCondition` shared
  with references was split out to `queryTargetId` so `targetId` is unambiguously
  the reference pointer. Persistence enumerates `NodeFieldKey = KeysOfUnion<Node>`
  to read/write the flat scalar map generically. References carry an explicit
  `refRole` (`link`/`fieldValue`/`config`/`enum`/`searchResult`/`autoInit`) and
  backlinks use an allowlist instead of parent inference.
  ([#18](https://github.com/relixiaobo/lin-outliner/pull/18))
- **Register the `anti` dev clone** — a fourth parallel dev clone
  (`lin-outliner-anti/`, Claude Code dev agent, branch prefix `anti/<topic>`) is
  documented in `AGENT.md` / `CLAUDE.md`, with a matching `dev:anti` script
  pointing `ELECTRON_USER_DATA_DIR` at `$HOME/.lin-outliner-anti` for userData
  isolation. ([#41](https://github.com/relixiaobo/lin-outliner/pull/41))
- **Drop dead `ProviderChoice` fields** — the Settings dialog's
  `buildProviderChoices` no longer populates `modelId` / `custom` on each
  provider choice; nothing read them (rendering, sort, and status label use only
  `providerId` / `configured` / `active` / `enabled` / `hasCredential`).
  Self-review follow-up to #31, behavior-preserving.
  ([#32](https://github.com/relixiaobo/lin-outliner/pull/32))
- **Prod install isolation + signing** — `userData` now resolves in three
  tiers (`ELECTRON_USER_DATA_DIR` → `$HOME/.lin-outliner-dev` for unpackaged
  source runs → the default path for installed builds), so a bare `bun run dev`
  can never touch the installed prod app's daily-use data. An `afterPack` hook
  deep ad-hoc signs the packaged macOS `.app` (electron-builder skips bundle
  signing under `mac.identity: null`), sealing it so the unsigned arm64 build
  launches on Apple Silicon. Docs cover the resolution order and the build /
  install flow. ([#23](https://github.com/relixiaobo/lin-outliner/pull/23))
- **Bounded local-file caches** — the local file search / icon / thumbnail
  caches now evict oldest-first via a shared bounded helper instead of clearing
  wholesale at 1000 entries. The wholesale clear could drop the `id -> path`
  mappings that prepare/preview rely on, making recently surfaced `@`-mention
  files unselectable mid-session. Follow-up to #21.
  ([#22](https://github.com/relixiaobo/lin-outliner/pull/22))
- **Subagent next-step guidance on the envelope** — the `Agent` / `AgentStatus`
  / `AgentSend` / `AgentStop` subagent tools now carry their next-step
  `instructions` via the envelope's top-level `instructions` field
  (`successEnvelope(tool, data, { instructions })`) instead of duplicating it on
  `data.instructions` in the model-visible projection. Follow-up to #17.
  ([#20](https://github.com/relixiaobo/lin-outliner/pull/20))
- **Slimmer model-visible tool output** — `web_search`, `web_fetch`,
  `file_glob`, `file_grep`, `bash`, `task_stop`, `operation_history`, and the
  `Agent`/`AgentStatus`/`AgentSend`/`AgentStop` subagent tools now project a
  trimmed view to the model via `agentToolResult(envelope, modelData)`, dropping
  echoed call arguments, constant provider metadata, and telemetry
  (`durationMs`, `byteLength`, `finalUrl`, the Loro cursor, etc.). The full data
  stays on the envelope (`details`); conditional fields (redirect `finalUrl`,
  non-200 `statusCode`, pagination) are emitted only when meaningful. Adds
  projection unit tests per tool.
  ([#17](https://github.com/relixiaobo/lin-outliner/pull/17))
- **Shared node-line view helpers** — extracted `nodeLineView.ts`
  (`caretAnchor`, `selectionTextOffsets`, and a unified inline-ref-aware
  `selectionForPlacement` / `applyCursorPlacement`) from `RichTextEditor` and
  `TrailingInput`, which both now delegate to it. Behavior-preserving (the
  trailing input's old `1 + offset` math reduces to the shared version for
  plain text, pinned by unit tests); Phase 2a of the node-line editor
  unification. ([#12](https://github.com/relixiaobo/lin-outliner/pull/12))
- **Node-line editor core build contract** — design doc
  (`docs/plans/node-line-editor-core-design.md`) pinning the Phase 2b
  approach: drop the monolithic `useNodeLineEditor` hook in favor of shared
  pure modules, and route trigger application through `resolveTargetId`.
  ([#13](https://github.com/relixiaobo/lin-outliner/pull/13))
- **Three-clone parallel-agent hub model** — `lin-outliner` (main: review /
  merge / integration) plus `lin-outliner-cc`, `lin-outliner-cc-2`, and
  `lin-outliner-codex` dev clones sharing one GitHub origin, integrating via PRs
  to `main`, with per-clone `userData` isolation (`dev:main` / `dev:cc` /
  `dev:cc-2` / `dev:codex`).
