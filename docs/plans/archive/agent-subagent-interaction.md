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
(`docs/spec/agent-delegation.md`; the former Delegation Contract was retired).

All `file:line` references are against `main` at `72a38285` (PR 1 landed).
Prefer the symbol names in "PR 1 landed" below over the line numbers here — the
line numbers have already rotted twice, once through #451's decomposition and
once through #463's extraction.

## Non-goals

- No change to the collaboration tool contracts (`spawn_agent`, `wait_agent`,
  `send_message`, `followup_task`, `list_agents`, `interrupt_agent`) or their
  model-facing semantics; this plan changes what the *user* sees and can do.
- No lifting of the `request_user_input` root-Thread scope. The "a child
  cannot ask the user" deferral in `docs/plans/archive/agent-program.md` stands;
  this plan only makes the blocked state visible.
- No child composer. Child Threads stay read-only per the child-Trajectory
  contract in `docs/spec/agent-thread-rendering.md`; user control is limited to
  interrupt.
- No token judgement asked of the user (Delegation Contract §3: receipts are
  internal; product surfaces speak time/status). The Turn Diagnostics Model
  Interactions inspector stays token-denominated — it is forensic, not a
  decision surface.
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

Refreshed 2026-07-31 after the PR 1 merge (#466). #451, #455, #456, #460,
#463, #464, and PR 1 itself have all merged; all pre-decomposition backend
evidence below is relocated to its current owner.

- **#463 (`process-state-truthfulness`) is merged, and PR 1 was integrated on
  top of it** — see "PR 1 landed" for the resulting shared shape. #463 owns the
  generic process divider states, duration/boundary rules, and `TurnLifecycle`
  finalization; PR 1 owns only the `wait_agent`-exclusive bottleneck derivation
  and copy in that region, and does not change `waitingOnUserInput`
  presentation. **PR 2 and PR 3 inherit this adjacency**: the process divider
  is now co-owned, so a change there must say which of the two concerns it is
  touching.
- **#467 (`cc-2/plan-progress-pill`, open Draft) is the live collision for
  PR 3.** It adds a pill to the same parent process block PR 3 puts its
  delegation card in. Whichever claims second rebases; check `gh pr list`
  before starting PR 3.
- **#464 (`red-e2e-on-main`) is merged:** `test:e2e` is a clean gate signal
  again, so an E2E failure on a PR 2/PR 3 branch is that branch's own.
- **#455 (`subagent-budget-propagation-pr-c`) is merged:** its user-irrelevance
  boundary governs S5. A terminal Subagent activity carries the canonical
  `TurnError`; renderer classification uses the closed `Turn.error.code` set
  (`runtime_failure`, `host_restart`, `subagent_budget_exhausted`,
  `subagent_structural_limit`). Budget-shaped failure copy is localized
  resource-limit language saying completed results were preserved; no user
  surface renders token quantities or classifies errors by message text.
- **#460 (`subagent-transcript-artifact`) is merged:**
  `CollaborationTerminalOutcome` now also carries `transcriptPath`; PR 1 keeps
  that account-layer field unchanged.
- No infrastructure-ownership files. `src/core/agent/protocol.ts` changes
  (PR 1) are a coordinated protocol-adjacent change: flagged here for the
  gate, and pre-release policy applies — no migration, no legacy readers;
  wipe `~/.lin-outliner-*` dev userData on the Item-shape change.

## Current defects (evidence)

### Status truth (PR 1)

- **S1 — A permanently lying "Running" row.** `subAgentActivity` Items are
  append-only; the `started` row maps to "Running" forever
  (`ThreadItemView.tsx:172-185`), never rewritten when the child ends — the
  terminal state arrives as a *second* row.
- **S2 — A permanently lying spawn row.** The spawn tool row's `agentsStates`
  is synthesized as a hard-coded `'running'` from the tool result
  (`PiTurnExecutor.ts:1243-1251`) and has no later writer
  (`PiTurnExecutor.ts:1009-1022`).
- **S3 — Completion can be invisible for a long time.** Terminal child
  activity is flushed into the parent only at `wait_agent` return, next-Turn
  admission, or parent-Turn end (`SubagentCollaboration.ts:509-512`, `545`;
  `TurnLifecycle.ts:810-848`, `979-980`); fire-and-forget children finish
  silently until the user's next message. The renderer receives the canonical
  child `turn/completed` notification but currently discards it when that
  child's history is not loaded (`threadStore.ts:387-450`).
- **S4 — No live signal at all from a running child.** No elapsed time, no
  current activity, no turn count in the parent row
  (`ThreadItemView.tsx:172-185`); the Turn divider says only "Working for …"
  (`ThreadView.tsx:1921-1924`).
- **S5 — Failure looks like success.** Terminal `errored`/`interrupted` rows
  are styled identically to `completed` (`ThreadItemView.tsx:172-185`,
  `thread.css:1643-1683`); the failure reason is not in the Item, only inside
  the child Thread or `CollaborationTerminalOutcome.error`
  (`SubagentCollaboration.ts:638-662`). #461 already shipped the shared
  tool-row failure vocabulary and tint (`thread.css:1391-1403`); the remaining
  defect is Subagent-activity-specific.
- **S6 — Children are truncated UUIDs.** Spawn/wait rows list
  `shortThreadId` + status only (`ThreadItemView.tsx:894-910`) because
  the persisted Item shape drops `taskPath`/`nickname`/`role`
  (`protocol.ts:944-960` vs the live collaboration view at
  `SubagentCollaboration.ts:591-615`).
- **S7 — Resolved by #461.** Collaboration rows now use the closed product
  vocabulary in `ThreadItemView.tsx:1037-1051`; model-facing names such as
  `spawn_agent` and `wait_agent` no longer reach the row label. Readable child
  identity remains S6 and is still in PR 1 scope.
- **S8 — Misleading aggregate states.** An idle-but-alive child reports
  "Completed" (`SubagentCollaboration.ts:591-615`); a failed collab *tool*
  marks every receiver `errored` (`PiTurnExecutor.ts:1010-1015`,
  `1254-1264`); "Working with N agents" counts a `wait_agent` row as an agent
  (`ThreadItemView.tsx:1226-1229`, `1339`).
- **S9 — Blocked state is dead data.** `waitingOnUserInput`
  (`protocol.ts:48`, set at `TurnLifecycle.ts:491`) is read by nothing in
  `src/renderer`. (Parent-side rendering is owned by
  `agent-run-presentation-consistency.md` PR B; a child can never carry the
  flag — see the PR 1 correction below.)

### Navigation & list (PR 2)

- **S10 — No way back to the parent.** Opening a child replaces the dock view
  wholesale (`ThreadDock.tsx:293-325`); the header has no
  breadcrumb/back (`:229-255`); the child often sorts *above* its parent in
  the flat recency list (`threadStore.ts:626-627`).
- **S11 — Dead links fail silently.** Transcript rows call `selectThread`,
  which throws for a Thread missing from the catalog
  (`threadStore.ts:114-126`) through the dock callback
  (`ThreadDock.tsx:308`) behind bare `void` calls
  (`ThreadItemView.tsx:178`, `903`); the recovering `openThreadById` is wired
  only into Automations (`ThreadDock.tsx:330-332`).
- **S12 — Thread-list pollution and spec violation.** Every child ever
  spawned is a permanent flat row (`ThreadCatalogOps.ts:148-171`); "nesting" is
  a left margin only (`ThreadList.tsx:126`, `201-215`), while the spec
  promises "Child Threads are visibly nested under their parent"
  (`docs/spec/agent-thread-rendering.md:14-16`). No run-status indicator
  (`thread.status`/`activeFlags` unread in `ThreadList.tsx`), no filter, no
  bulk cleanup; isolated-Skill children (`skill_<slug>_<hex>`,
  `SubagentCollaboration.ts:325-341`) are listed but unreachable from the transcript
  (no `subAgentActivity` for `source !== 'collaboration'`,
  `SubagentCollaboration.ts:274-282`).
- **S13 — The child link is 3 clicks deep post-run.** The process block folds
  under "Worked for …" (`ThreadView.tsx:1843-1866`), then the group
  (`ThreadItemView.tsx:225-278`), then the spawn row
  (`ThreadItemView.tsx:589-660`, `894-910`).

### Control (PR 3)

- **S14 — The user cannot stop a running child.** Child views have no
  composer and no Stop (`ThreadDock.tsx:293-295`,
  `ThreadView.tsx:1237-1324`); parent Stop does not cascade (`interruptTurn`
  aborts only the
  addressed Thread, `TurnLifecycle.ts:448-453`);
  `collaboration.interrupt_agent` is model-only
  (`SubagentCollaboration.ts:166-173`).
  The only user-reachable stop is deleting the Thread — which destroys the
  subtree (`ThreadCatalogOps.ts:513-547`).
- **S15 — No aggregate "what are my agents doing" surface.** The program docs
  describe a task panel as the intended background-visibility surface
  (`docs/plans/agent-program.md:75-76`,
  `docs/plans/agent-conversation-model.md:636-643`); nothing exists in `src/`.

## Design

### PR 1 landed — what PR 2 and PR 3 build on

Shipped in #466 (merged 2026-07-31). The full behavior lives in
`docs/spec/agent-thread-rendering.md` and `docs/spec/agent-subagent-threads.md`;
this section records only the seams PR 2 and PR 3 attach to, by symbol name
rather than line number.

- **`src/renderer/agent/subagentPresentation.ts` is the projection module.**
  `projectSubagentsForTurn(turn, threadsById, latestTurnByThread)` returns a
  `SubagentTurnProjection` — `items` (the collapsed Item list the transcript
  actually renders), `byThreadId`, and `activeThreadIds`.
  `presentationFromSnapshot` builds the same `SubagentPresentation` from a
  persisted `agentsStates` entry. **PR 3 replaces the row presentation, not
  this projection** — take the delegation card's per-child lines from
  `byThreadId` and keep the rows as the post-hoc fallback.
- **The transcript renders projected Items, not raw Turn Items.** `ThreadView`
  computes `contentBlocks = groupTurnContent({ ...turn, items: subagents.items })`.
  Anything deriving from "the Turn's Items" in this region must decide
  deliberately whether it means canonical or projected; `hasProcessBlock` means
  projected, because that is what reaches the reader.
- **The process divider is co-owned with #463.**
  `threadProcessSummary(turn, items, hasFinalResponse, liveElapsedMs, t, index,
  subagents, blockedOnUser)` carries both concerns, and #463's extracted
  `threadProcessNeutralHeader(turn, items, t, index, subagents)` takes the
  projection too. **Integration warning for PR 2/PR 3:** when #466 merged, git
  auto-merged this branch's edit *into* the body #463 had extracted into a new
  helper, without carrying the parameter — a clean textual merge that did not
  compile. Extraction refactors in this region merge silently wrong; after any
  rebase here, trust `bun run typecheck`, not the absence of conflict markers.
- **`threadStore` keeps `latestTurnByThread`**, maintained on both
  `turn/started` and `turn/completed` and cleared by reload omission, rollback,
  and subtree deletion. It is the live fallback when child history is unloaded.
  PR 2's Thread Details children section can read child status from it without
  loading each child's history.
- **The protocol shapes are settled.** `agentsStates` values are
  `{status, taskPath, nickname, role}`; `subAgentActivity` carries `error`
  (the child's exact terminal `TurnError`). Both are exact-key decoded in
  `src/core/agent/codec.ts` — a pre-release clean cut with no legacy reader, so
  **wipe `~/.lin-outliner-*` dev userData before running any branch off this
  point**.
- **Constraints PR 2 and PR 3 must preserve.** No token quantities on a product
  surface — delegation rows, cards, failure copy, and the Turn Details reading
  flow, counting the non-visual leak paths (`title`, accessible text, Turn copy)
  that are easiest to forget. The Turn Diagnostics Model Interactions inspector
  is the deliberate exception and stays token-denominated: the rule is that no
  user is asked to *decide* on a token number, not that no number exists
  anywhere. Also: failures classified only by `Turn.error.code`, never by
  message text; raw collaboration output stays out of user surfaces; child
  Threads stay composer-less.

### PR 1 — status truth in the parent transcript

*Implemented in #466 and folded into `docs/spec/`. Kept here for the design
rationale; read the section above for what it left behind to build on.*

**One presentation row per child, driven by live state.** The canonical
Items stay append-only; the renderer builds a per-Turn *presentation
projection* over them (same pattern as the existing Turn process projection,
`docs/spec/agent-thread-rendering.md:151-163`):

- All `subAgentActivity` Items for the same `agentThreadId` within a Turn
  collapse into one row; the rendered status is the latest kind
  (`started` superseded by `completed`/`interrupted`/`errored`). The row keeps
  its position at the first activity's canonical slot. No duplicate
  Running-then-Completed pairs (S1).
- While no terminal activity Item exists, the row's status is read from the
  live canonical state in `threadStore`: the Thread catalog supplies
  `active`/`idle`, while the latest canonical `turn/started` or
  `turn/completed` notification supplies start time, terminal status, and
  `TurnError`. The store currently consumes those notifications at
  `threadStore.ts:387-450`; PR 1 retains one latest canonical Turn per Thread
  even when that child's paged history is not loaded. This makes child
  completion visible the moment it happens, independent of the parent-side
  flush timing (S3), and adds a live elapsed time for running children (S4).
  This is a cache of the canonical DTO, not a parallel execution model;
  canonical parent history is untouched, and on reload terminal Items are
  authoritative.
- Spawn/wait tool rows stop rendering the stale `agentsStates` snapshot as if
  it were current: per-child lines derive from the same live projection, and
  the persisted snapshot remains visible only inside the expanded raw
  argument/result JSON (S2, S8). The "Working with N agents" count derives
  from distinct child Thread IDs in the projection, not from receiver arrays
  or item ids (S8).
- **Protocol addition (coordinated, pre-release no-migration):**
  `collabAgentToolCall.agentsStates` values widen from bare status to
  `{ status, taskPath, nickname, role }` — data the service already has at
  completion (`SubagentCollaboration.ts:591-615`) — so rows show `/root/research`
  instead of a truncated UUID after the child Thread is deleted (S6).
  `subAgentActivity` already carries `agentPath` (`protocol.ts:955-960`).
- Failure presentation reuses the tool-row status vocabulary from
  `agent-run-presentation-consistency.md` PR A: `errored` tints the row's
  icon + label with `--status-danger`; `interrupted` uses the muted
  treatment. `subAgentActivity` widens with `error: TurnError | null`, copied
  from the exact child Turn when terminal activity is queued; the terminal row
  exposes the bounded user-safe summary instead of leaving it inside raw JSON
  (S5). Budget-shaped errors are selected only by the closed code and translated
  to the existing localized resource-limit/result-preserved copy; token numbers
  never reach the row, its accessible label, title, or copy text.
- Copy: individual child rows read as product language — "Started subagent
  research", "Subagent research failed" — via typed i18n keys (en + zh-Hans).
  #461 already fixed the generic collaboration tool-row vocabulary (S7). An
  idle-but-alive child renders "Idle", distinct from "Completed" (S8; the
  model-facing `wait_agent` payload is unchanged).
- **Correction (PM discussion, 2026-07-30):** a child Thread can never carry
  `waitingOnUserInput` — `request_user_input` is root-scoped and hard-rejected
  for children (`src/core/agent/tools.ts:414-418`,
  `TurnLifecycle.ts:462-466`), so the earlier "blocked child" framing was
  wrong. Blocked-on-input surfacing applies to the parent only and is owned by
  `agent-run-presentation-consistency.md` PR B. What this PR adds instead
  (Q3, ratified): while the parent Turn's only in-progress work is
  `collaboration.wait_agent`, the Turn divider names the actual bottleneck —
  "Waiting on N subagents · elapsed" — instead of the generic "Working"; the
  timer keeps counting because work is genuinely progressing in the children.
  Renderer-only derivation from the in-progress wait tool Item plus the live
  child projection; new i18n keys (en + zh-Hans).

### PR 2 — navigation and Thread-list hygiene

- **Back to parent.** When the selected Thread has a `parentThreadId`, the
  dock header shows a back affordance labeled with the parent's name
  (the `BackIcon` pattern already exists for Automations,
  `ThreadDock.tsx:245-255`); activating it selects the parent. Breadcrumb
  depth beyond one level collapses to the immediate parent (S10).
- **Resilient links.** Transcript child links route through `openThreadById`
  (catalog-recovering, `threadStore.ts:120-126`); a genuinely deleted Thread
  produces the existing transient feedback affordance instead of a silent
  throw (S11).
- **Children leave the Thread list (PM-ratified, 2026-07-30; S12, S13).**
  The history list is "conversations the user had"; a child Thread is an
  execution artifact of a Turn, not a conversation — and the current
  indentation-without-adjacency rendering (recency sort,
  `threadStore.ts:626-627`, plus margin-only depth, `ThreadList.tsx:126`,
  `201-215`) is internally contradictory. Rather than building true nesting
  (tree rendering, expand state, sort ambiguity, a fight with the flat keyset
  pagination), child Threads stop being list rows entirely:
  - `thread/list` returns root Threads only (service-side filter,
    `ThreadCatalogOps.ts:148-171`), so children stop occupying keyset cursor
    slots and cannot displace roots between pages. The lineage-indent
    rendering is deleted.
  - A root Thread with any live descendant shows a neutral
    background-activity indicator on its list row (derived from catalog
    status notifications) — "this conversation has background work running",
    which also covers fire-and-forget children whose parent Turn already
    ended.
  - Thread Details for a root Thread gains a children section: readable
    name, status, last activity; each row opens the child (via
    `openThreadById`) and offers Delete, plus a "Delete finished subagents"
    bulk action through the existing cascading delete path
    (`ThreadCatalogOps.ts:513-547`). This is the fallback browse surface now
    that the list no longer carries children.
  - Isolated-Skill children (`skill_<slug>_<hex>`) equally leave the list and
    become reachable from their invoking `skill` tool row via the same
    supplemental child-Thread link affordance collaboration rows have
    (`docs/spec/agent-thread-rendering.md:140-141`).
- **Isolated-Skill delegation gets a status row, not just a link** (PM ruling
  2026-07-31). `subAgentActivity` is recorded behind two gates that admit only
  `source === 'collaboration'` — `SubagentCollaboration.recordSubagentActivity`
  at spawn and the terminal enqueue in `queueChildTurnActivity`. An isolated
  Skill child (`source: 'agent.skill'`) therefore produces no per-child row: the
  parent shows one in-progress `skill` tool row for the whole child run, with no
  indication a delegated agent is working, no live elapsed, and no way in. The
  `skill` call *is* awaited, so the child's outcome does reach the row's status,
  and `enqueueTranscriptTurn` already runs for every delegated form — the
  account exists; the **process** does not. Widen both gates from
  `source === 'collaboration'` to "any child Thread with a `parentThreadId`", so
  every delegated form is projected by the #466 projection that already handles
  dedupe, latest-state precedence, and the live catalog fallback. This is the
  same defect as the link (S12) seen from the other side, and shipping only the
  link would leave a child you can open but cannot tell is running. The judgment
  it answers is the one #468 settled: a session shows the complete, actual
  process, and isolated Skills are that rule's largest surviving exception.
  Spec: `docs/spec/agent-subagent-threads.md` changes in the same PR.
- Spec: rewrite `docs/spec/agent-thread-rendering.md:14-16` and the Thread
  list section in the same change — child Threads are not Thread-list rows;
  they are reachable from the parent transcript and parent Thread Details.

#### The descendant budget pool is scoped to a user Turn, not to a Thread

PM ruling 2026-07-31, adopting the Claude Code scope. **This is a persistence
change riding in a navigation PR — it is the widest thing in PR 2, it crosses a
fail-closed write boundary (A12), and it carries a schema change. Gate PR 2 at
`/code-review ultra` accordingly, and put the dev-userData wipe in the PR body.**

**The defect.** `SubagentCollaboration.spawnChild` keys the pool on the *parent
Thread* when no explicit `max_total_tokens` is given
(`const poolThreadId = tokenCap === null ? parent.thread.id : thread.id`), so
`subagent_budget_pools.tokens_used` accumulates across every Turn of that
Thread's life against the 1.5M default (`agentSettings.ts:126`). Once it
crosses, `TurnLifecycle.assertResolvedSubagentBudgetAvailable` throws
`SubagentBudgetExhaustedError` on *every* later spawn, forever. The only reset
is `SubagentBudgetLedger.clearThread`, reachable solely from the subtree-delete
path (`ThreadService.ts:395` ← `ThreadCatalogOps.ts:503,538`); `/clear` does not
touch the ledger and no statement zeroes `tokens_used`. So a long conversation
silently and permanently loses the ability to delegate, while the user — who by
design never sees token numbers — gets no cause and no recovery. That is the
worst of both: no decision *and* no way out.

**The rule.** Separate the two kinds of limit by what each defends against:

- **Spend is request-scoped.** A pool belongs to the explicit **user Turn** that
  initiated the delegation, and every descendant spawned inside that Turn's
  subtree shares it. A new user Turn gets a new pool. What the circuit breaker
  defends against is runaway recursion inside one request; "how much this
  conversation has done over two weeks" is not an anomaly signal and must not be
  one.
- **Structure stays Thread-lifetime.** Depth 2 and the durable 16-direct-children
  count are unchanged — they defend against topology, and topology is a property
  of the conversation. `docs/spec/agent-subagent-threads.md` already declares the
  count deliberately non-resettable; keep that sentence and do not generalize it
  to spend.

This closes the principle the product runs on: the user states a need and never
reasons about tokens, so restating the need must be a real recovery path. Under
Thread-scoped spend it is not.

**Fire-and-forget children (decide here, do not discover it in code).** A child
can outlive the Turn that spawned it, so "the Turn's pool" needs a lifetime rule:
the pool is keyed by its originating user Turn and **survives that Turn's end**,
staying chargeable until every member Thread is terminal; it is reaped after.
A child therefore keeps charging the request that asked for it, even when the
parent Turn has already returned — the alternative (migrating orphans to the
next Turn's pool) would let one runaway child eat a budget the user never spent
it on.

**Resolution gets simpler, not harder.** Today `resolveSubagentBudgetFrom` walks
the Thread parent chain looking for a pool. With a Turn-keyed pool the member row
already carries the reference — `createMember(threadId, poolId, …)` — so
resolution reads the member instead of walking. Validate that this holds for
inherited budgets and for the local-cap case (`tokenCap !== null` still keys its
own pool on the child Thread) before assuming the walk can be deleted.

Pre-release policy applies: change the column, delete the old reader, wipe
`~/.lin-outliner-*` — no migration.

Spec: `docs/spec/agent-subagent-threads.md` — the budget section states pool
lifetime explicitly, which it does not today; that silence is what let the
Thread-scoped reading look intended.

### PR 2 landed — what PR 3 builds on

Shipped in #471 (merged 2026-08-01), after a high gate whose ten findings were
answered in one hardening commit (`ec253672`). Behavior lives in
`docs/spec/agent-thread-rendering.md` and `docs/spec/agent-subagent-threads.md`;
this section records only the seams PR 3 attaches to, by symbol name.

- **`thread/descendants` is a new protocol request** (`protocol.ts`, exact-key
  decoded in `codec.ts`): `{threadId}` in, `{data: Thread[],
  queuedWorkThreadIds: ThreadId[]}` out. `ThreadDescendantsView` in
  `threadStore` is its renderer shape and already backs
  `ThreadDetailsDialog`. **PR 3 reads this rather than adding a parallel
  descendant view.**
- **`queuedWorkThreadIds` puts a question on PR 3's desk that did not exist
  before.** It names descendants holding queued work that has not started a
  Turn. Such a child has **no Turn to interrupt**, so the Q2 cascade cannot be
  a pure walk of active Turns: leaving queued children to start *after* the
  user pressed Stop is the same trust violation Q2 was ratified to prevent.
  PR 3 must say explicitly what Stop does to queued-but-not-started work —
  drop it, or refuse admission for the rest of the parent Turn — and cover it
  in a test. This is the one genuinely open thing in PR 3's scope.
- **The projection distinguishes delegation forms.**
  `SubagentPresentation.form` is `'collaboration' | 'isolatedSkill'`, and
  `SubagentTurnProjection.collaborationThreadIds` is the pre-derived set a wait
  blocks on — its comment says it is derived once precisely so consumers do not
  re-derive it. The card replaces the row *presentation*, not the projection:
  take per-child lines from `byThreadId`, take "what the wait is accountable
  for" from `collaborationThreadIds`, and do not re-split by source.
- **Budget pool ids are scoped values now**: `SubagentBudgetPoolScope` is
  `'turn' | 'thread'`, with `turnBudgetPoolId(turnId)` and
  `childBudgetPoolId(threadId)`. PR 3 changes no budget behavior, but its
  cascade must not disturb pool reclamation, and the bright line stands — a
  human interrupt is never budget- or state-gated.
- **`interruptTurn` is unchanged and is still the only seam**
  (`TurnLifecycle.ts:450`, exposed at `ThreadService.ts:705`). PR 3 extends
  reach to descendants with authorization, not the semantics.
- **Cross-thread awareness already exists**: a root row renders
  `.thread-list-activity` from `backgroundWork` (`ThreadList.tsx:136`). This is
  the evidence behind "no dock-level agents panel" — the awareness gap the
  panel would have filled is filled.
- **#469 landed disclosure scroll anchoring** the same day
  (`ui/interactions/disclosureScrollAnchor.ts`). The card is a live,
  height-changing element inside the process block, which is the case that
  mechanism governs; check it before inventing scroll handling.

### PR 3 — live delegation card + user interrupt

Ratified shape (Q1/Q2, PM 2026-07-30):

- **One live delegation card per Turn (Q1)** in the parent process block
  while at least one child spawned by that Turn is alive: one line per child
  — readable name, live status, elapsed time, terminal glyph on completion —
  replacing the individual projection rows from PR 1 (which remain the
  fallback and the post-hoc rendering). Time/status only; no token numbers
  (Delegation Contract §3). **No dock-level "agents" panel:** the per-Turn
  card keeps status in the conversation where the delegation happened, and
  the list-row activity indicator (PR 2) covers cross-thread awareness; a
  global panel is a mostly-empty persistent surface and is reconsidered only
  on demonstrated need. That need already had its trial: a dock task panel
  shipped in #160 (`f4c1555a`), was refactored (`4dbc37b7`), and was
  dissolved in the IM-era rebuild for lack of pull — the strongest precedent
  against resurrecting the surface speculatively.
- **User interrupt (S14).** Each running child line, and the child Thread
  view header, exposes Stop. It calls the existing `interruptTurn` seam over
  a renderer→main request, extended to descendant Threads with explicit
  authorization: the target must be a descendant of a user-owned root. Per
  the user bright line, a human-triggered interrupt is never budget- or
  state-gated: it aborts the active child Turn and leaves the Thread for
  follow-up (`TurnLifecycle.ts:448-453` semantics unchanged).
- **Parent Stop closes the request (Q2, rescoped by PM ruling 2026-08-01).**
  The composer Stop on a delegating Turn interrupts that Turn and every live
  member of **its budget pool** — the set already defined by
  `SubagentBudgetLedger`, not a bespoke walk of the Thread tree. A user
  pressing Stop means "stop the request I made"; the pool is precisely "the
  delegated work this request owns", so the semantics fall out of an existing
  invariant instead of being chosen.

  **Why not a descendant-tree walk.** The original Q2 wording said "every live
  descendant Turn", which is ambiguous between the Turn's descendants and the
  Thread's, and both readings are guesses at a set the ledger already knows.
  Worse, the argument for the widest reading — "leaving children burning
  invisibly after Stop is a trust violation" — no longer holds: PR 2 shipped
  the list-row activity indicator and PR 3 ships the card, and those are what
  take earlier fire-and-forget work *out* of the invisible. The same evidence
  cannot both justify skipping a dock panel (old work is visible and
  reachable) and justify killing old work on sight (it is burning unseen). A
  fire-and-forget child from an earlier request keeps running, stays visible on
  its own Turn's card, and has a precise per-child Stop there.

  **One definition, four consumers.** Binding Stop to pool membership is the
  point of this rescope. The budget already answers "which request owns this
  work"; PR 3 was about to answer it a second time under another name, and this
  repository's recurring defect is exactly that — see the
  `collaborationThreadIds` comment, which exists because a re-derived set has
  to be re-found every time a delegation form is added. After this, the pool
  set serves budget, Stop, queued-work handling, and the card.

  Two consequences that remove work rather than adding it:
  - **Queued work needs no special case.** A child holding queued work is a
    pool member even with no active Turn, so closing the pool covers the
    `queuedWorkThreadIds` gap without a separate drop-the-mailbox mechanism.
    Reclamation cannot race this: `reapSubagentPoolIfSettled`
    (`TurnLifecycle.ts:1144-1152`) refuses to reap while the originating Turn is
    active, and Stop is pressed exactly then, so membership is intact.
  - **No new stop barrier and no new background release.** "This pool is
    closed" is state on a row whose lifecycle already exists; admission reads
    it. A bespoke `stoppingThreads`-style barrier would need its own release
    path, and a release that never fires would permanently disable delegation
    for that subtree — the same failure shape as the Thread-scoped pool this
    plan already had to fix (A12).

  There is no second global button — selective control is the per-child Stop on
  the card.
- **The request identity must exist without a budget** (the one prerequisite).
  `createMember` is already unconditional and carries `originTurnId`
  (`SubagentCollaboration.ts:276-284`), but `poolId` is only set when a budget
  is configured (`:250-251`), and `subagentTokenBudget` is nullable. So today
  the request set materializes only when someone put a number on it. Make the
  pool unconditional — a null `tokenBudget` means *this request is unbounded*,
  not *this request has no identity* — so ownership is a property of delegation
  and the budget is an optional attribute of the owner. Grandchildren already
  inherit the ancestor pool, so transitivity is unchanged. `originTurnId` stays
  the durable per-hop provenance and survives `reapPool`, which unbinds
  `poolId` only.

  **This is a ledger change, so PR 3 gates at `/code-review ultra`** and carries
  the dev-userData wipe note. Taken deliberately under A7: the descendant-tree
  walk is an interim mechanism we already know we would replace, and writing
  against one is the specific mistake A7 exists to prevent. It also makes PR 3
  smaller — no traversal, no queued-work special case, no barrier lifecycle.
- **Composer-less children are the product line (R1 ruling, PM 2026-07-30):**
  user control on a child Thread is interrupt-only; recovery from an
  exhausted or terminal child is parent respawn/synthesis plus the
  transcript artifact (`subagent-transcript-artifact`, queued), and the
  admission-level user bright line remains defense-in-depth, not an
  in-product manual-continue journey (spec/budget wording aligned on main at
  `45238fde`).

## Open questions

None. Ratified by the PM on 2026-07-30, from the UX discussion:

- **Q1** — per-Turn delegation card; no dock-level agents panel.
- **Q2** — parent Stop closes the request: it interrupts the Turn and every
  live member of that Turn's budget pool; per-child Stop on the card covers
  selective control. **Rescoped by PM ruling 2026-08-01** from "cascades to all
  live descendants" — that wording was ambiguous between a Turn's and a
  Thread's descendants, and both readings re-derive a set the ledger already
  owns. Its premise also expired: the "children burning invisibly" argument
  predates PR 2's activity indicator and PR 3's card, which are what make
  earlier delegated work visible and individually stoppable.
- **Q3** — the parent divider names the `wait_agent` bottleneck ("Waiting on
  N subagents"); the original "waiting on subagent input" framing was
  corrected — a child can never request user input.
- **Thread list** — child Threads leave the history list entirely (PR 2);
  the list is root conversations only.

## Verification

- PR 1: renderer tests for the per-child projection (dedupe, latest-state
  precedence, live catalog fallback, terminal-Item authority on reload);
  core tests for the widened `agentsStates` payload; E2E: spawn → row shows
  live Running with elapsed; child completes mid-parent-Turn → row flips
  without waiting for flush; child failure shows tinted row + error summary;
  `wait_agent` as the only in-progress work produces the localized "Waiting
  on N subagents · elapsed" divider.
- PR 2: E2E for back-affordance round-trip (child → parent preserves parent
  scroll per the existing snapshot mechanism); the Thread list excludes
  children while the parent row shows the activity indicator during a live
  child run; Thread Details children section opens a child and deletes
  finished ones; skill-row child link; renderer test for `openThreadById`
  fallback feedback; core test for the root-only `thread/list` page shape; core
  test that an isolated-Skill child records `subAgentActivity` at spawn and at
  terminal, and E2E that its live row is in the parent transcript while the
  `skill` call is still in flight. For the Turn-scoped pool: a core test that
  exhausting a pool blocks further spawns **within** that user Turn while the
  next user Turn spawns successfully (the regression that motivated the change);
  that a fire-and-forget child outliving its parent Turn still charges the
  originating pool, and that the pool is reaped only once its last member is
  terminal; and that depth-2 plus the durable 16-child count are **unchanged**
  by the rescope — the structural limits must not follow spend into request
  scope.
- PR 3: E2E for card lifecycle (spawn/live/terminal), per-child interrupt of a
  running child, and parent Stop interrupting every live member of the Turn's
  pool. Core tests for what the rescope turns on: a child holding only queued
  work is settled by Stop (the case a walk of active Turns silently misses); a
  fire-and-forget child belonging to an **earlier** request is *not* touched,
  and remains individually stoppable from its own Turn's card; delegation with
  `subagentTokenBudget: null` still produces a pool, so the request set exists
  without a budget; `reapPool` still unbinds `poolId` while `originTurnId`
  survives; and interrupt authorization rejects a `threadId` that is not a
  user-owned root or its descendant. Light + dark visual verification for card
  and indicators.
- All PRs: `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  focused `bun run test:e2e` scope, `bun run docs:check`; spec updated in the
  same change (A6); dev userData wipe noted in the PR body for the PR 1
  protocol change.
