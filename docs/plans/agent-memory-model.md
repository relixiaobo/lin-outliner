---
status: in-progress
priority: P1
owner: relixiaobo
executor: cc-2
created: 2026-06-08
updated: 2026-06-09
---

# Agent Memory Model — Render, Dream & User-as-Agent (atop agent-data-model)

This plan sits **on top of** [[agent-data-model]], which **owns** the memory persistence
contract. It does **not** re-specify the stored shapes — it adds the three things the data
model deliberately leaves open: **(1)** how the distilled-memory prefix is *rendered* into
context, **(2)** what `Dream` *produces* and how it consolidates, and **(3)** the
*user-as-an-ordinary-agent* + cross-agent sharing idea (a ratifiable **extension** to the
data model, not a re-decision).

**Part of the [[agent-program]].** A protocol-surface change here is a change to
[[agent-data-model]], landed **there, once**, interface-first ([[agent-program-is-plan-authority]]).
Pre-release clean cut — no migrations; wipe `~/.lin-outliner-*` dev userData
([[storage-format-no-backcompat-prerelease]]).

## Reconciliation with agent-data-model.md (read first)

The earlier draft re-invented half the data model. This is the corrected split:

| Concern | Owner | This plan |
|---|---|---|
| `MemoryEntry` shape `{id, agentId, fact, originWorkspace?, sources[], status, createdAt}` | **data-model §3** (authoritative) | consumes as-is; **adds no `kind`/`confidence`/`salience` fields** (see §1) |
| `Principal = {user}\|{agent}` | **data-model §3** | reuses it for §3's proposal (the earlier `AgentActor` was wrong — that union also admits `tool`/`system`) |
| Write surface — runtime-owned append (`memory.entry_added/updated/removed`), event-sourced, not `file_write` (D1) | **data-model §3 / inv. 12, 16** | `Dream` is a *client* of this surface (§2) |
| Retrieval — global pool by default + opt-in `isolated`/`read-only-global` tiers; `originWorkspace` always recorded (D2) | **data-model §3 / inv. 13** | the cross-agent sharing proposal (§3) must reconcile *with* this axis, not add a parallel one |
| Model-facing read = the **single** `recall(query, include_evidence?, max_chars?)` tool; evidence nested under entries via `sources`; no second tool / `past_chats` | **data-model §4 / OQ (DECIDED 2026-06-07)**; ships as `src/main/agentRecallTool.ts` | reuses it; **drops the proposed `memory_search`/`memory_recall` pair** |
| Cache layout — volatility-ordered, append-only prefix, single volatile tail: `[3]` distilled-memory prefix + `[5]` query-specific recall in tail; compact at segment boundaries | **data-model §8 / inv. 7** | the render (§2) *produces* `[3]`; freshness rides `[5]` — no new cache machinery (see §2 "Cache") |

The net effect: the plan is much smaller, and the findings about no-producer / silent-drop /
patch-not-widened / two-visibility-systems / ref-handle-has-no-home all dissolve, because the
fields and tools that caused them are no longer added here.

## Goal

Define the **subjective** half of memory that the data model leaves to consumers: turn the
agent's `MemoryEntry` set into context the model can absorb (render), and define the `Dream`
that fills it. Replace today's `formatMemoryReminder` flat dump (`- id=… fact="…"`,
`agentRuntime.ts`) with a rendered briefing; replace nothing in the storage contract.

## Non-goals

- **Not** a storage-shape change. Any `MemoryEntry` field add (e.g. a future `salience`) is a
  data-model edit (its OQ "top-N by recency/salience"), not made here.
- **Not** a second recall tool, a foreground write tool, or a markdown memory-file tree
  (all ruled out by data-model).
- **Not** a change to `compact`'s *product*. The render may reuse compaction's *timing* as a
  re-anchor (§2 Cache); the compaction summary is a **separate block** and never a memory source.

---

## 1. Two-tier recall = the data model's distillation ladder (no new kinds)

The earlier draft added `kind:'episode'|'cognition'` to the entry. That was **redundant with
the ladder the data model already has**, and it put kind-conditional fields on one record (the
exact "second taxonomy" smell the draft claimed to avoid). Corrected mapping:

```
源 raw log         = conversation segments + run events            (data-model §3)
索引 index         = per-conversation DistillationNode summaries    (data-model §3, the nav spine)
                     + every MemoryEntry's `sources[]` down-pointer (data-model inv. 6)
萃取 distillation  = MemoryEntry — the agent's subjective fact      (data-model §3)
```

So **there is one stored entry kind (`MemoryEntry` = cognition); an "episode" is not a new
record — it is located raw**, reached through a `MemoryEntry`'s `sources` (or the summary
spine). The two-tier recall the draft wanted is exactly the data model's two injection sites:

- **resident cognition** = `MemoryEntry`s rendered into the `[3]` distilled-memory **prefix**.
- **on-demand episode** = `recall(query, include_evidence:true)` in the `[5]` **tail**, which
  expands an entry's `sources` to raw evidence.

`confidence` and `salience` do **not** become fields: `confidence` is a *render-phrasing*
concern (§2); `salience` is data-model's open question on injection budget — if it ever lands,
it lands on `MemoryEntry` there. Dropping both keeps the authoritative record flat and means
no new producer, patch-`Pick`, normalizer, or view-mirror work.

## 2. Render — the injection projection (the core contribution)

The data model says distilled memory goes in prefix `[3]`; it does **not** say in what *form*.
That form is this plan's main job. **Storage representation ≠ injection representation**:
the assembly layer needs the structured `MemoryEntry` fields to select/rank; the model needs
coherent prose. Recall is **select → render**.

**Select** = the data model's read path: resident `MemoryEntry`s for `[3]`; `recall(query)`
for `[5]`. Ranking and per-injection budget are data-model's `[3]` concern (its OQ); this plan
only fixes the *render*.

**Render** is a pure projection of the selected entries — a cache, never a source
(data-model inv. 14). Rules:

- **Hide storage scaffolding.** `id`, `status`, any future ranking score → never in the prose.
  (No `ref`/handle either: the model re-reaches raw via `recall(query, include_evidence)`, not
  by quoting an id — so the earlier "stable handle" question is moot.)
- **Confidence is phrasing, not a tag.** A fact the principal stated reads "he wants…"; a
  Dream inference reads "you've noticed…". `Dream` authors the fact text so authority is
  legible without a stored field.
- **Compose, don't list.** Atomic facts → a coherent briefing, grouped into zones; **XML tags
  separate the zones** (models parse the boundaries reliably), zone bodies are prose.
- **Reuse the existing reminder primitive.** The briefing is emitted through
  `systemReminder()` and classified by `isHiddenAgentContextBlock` (`src/core/agentAttachments.ts`)
  — the same render-prose-into-a-trusted-hidden-block mechanism `compactSummaryReminder`
  (`src/main/agentCompaction.ts`) uses — so it is excluded from stored history and can't be
  spoofed. It replaces `formatMemoryReminder` / the `<agent-memory>` block
  (`src/main/agentRuntime.ts`), which is deleted.

**Person.** Storage stays **person-neutral** — `fact` states the proposition with the
principal as the elided subject (`"prefers terse code reviews"`), never a baked-in pronoun, so
one entry renders to any reader. Render assigns person by reader relationship: **the reading
agent is always "you"; a subscribed principal is third-person / named.** (This requires `Dream`
to write subject-elided predicates — see §2 of the Dream contract.)

```xml
<memory>
  <principal name="lixiaobo">
    You're working with lixiaobo. He works in Chinese but wants everything in the repo in
    English (he's told you so). In code review he wants terse — no preamble; you've noticed
    this. He cares a lot about reconstructability.
  </principal>
  <self>
    You verify a worktree's HEAD before trusting a gate run — a stale branch once ran old code.
  </self>
</memory>
```

`<principal>` = a subscribed self-model (§3; may repeat), `<self>` = the reader's own
`MemoryEntry` set. Which zone an entry lands in is decided purely by `entry.agentId === me`.
There is no `<recall>` zone in the prefix: relevant raw episodes arrive in the `[5]` tail via
the `recall` tool, not as pre-listed prefix pointers.

**Cache.** The render *is* the `[3]` prefix; the data model already ratifies `[3]` as
append-only and `[5]` as the volatile tail, compacting at segment boundaries (inv. 7). So this
plan adds **no new cache machinery and no new freeze trigger**:

- The briefing is the `[3]` prefix, rebuilt **append-only at segment-boundary compaction**
  (data-model's existing trigger) — *not* mutated mid-turn.
- A `Dream` write mid-session does **not** touch the frozen `[3]`; its new facts surface
  through `[5]` `recall` (live) until the next compaction folds `[3]` forward. Freshness rides
  the tail; the prefix stays cache-stable **by construction** (no setInterval-driven prefix
  mutation, no unbounded "delta" list — the open finding about an unenforced freeze).
- This is the data model's own `[3]`/`[5]` discipline, not a re-derivation; the only addition
  is the *render form* of `[3]`. Measure placement with the apply-latency probe before
  committing (A9).

## 3. Dream — consolidation semantics

`Dream` is the **client of the D1 runtime append surface** that produces `MemoryEntry`s. It is
**background substrate, not a skill** (a human never runs it, yet their memory still needs
consolidating). No new run type: a Dream run is `RunMeta.kind:'scheduled'` anchored to a
conversation (data-model §3). It **reuses the existing incremental machinery** — the dream
watermark / processed-cursors (`agentEventLog.ts` `AgentDreamWatermark` etc.) — so it never
rescans full history; this plan does not reinvent it.

**Contract (data-model-ratified):** Dream uses summaries/search **only as locators** and reads
**raw** conversation/run evidence before writing a durable `MemoryEntry` (data-model OQ). It
writes subject-elided, person-neutral `fact` text (§2 Person).

**Three operations**, mapped to the existing events (no new vocabulary):

- `add` → `memory.entry_added`.
- `update` → `memory.entry_updated` (re-distill, merge a duplicate, conditionalize a
  contradiction into one conditional fact, make authority legible in the text).
- `invalidate` → the runtime reconciler's `memory.entry_updated{status:'invalidated'}`
  (data-model inv. 16) — invalidate-don't-delete.

The richer behaviors (bidirectional capture, confidence-promotion-in-text, decay/dedup,
calibration proposals) are **prose heuristics on these three ops**, not new verbs (see Later).

**Coordination — `dream.completed.changes`.** Reshaping the counters touches consumers the
draft missed: `AgentDreamCompletedChanges` (`agentEventLog.ts`) is read by
`AgentDreamBoundary.tsx`, `AgentTaskPanel.tsx`, and the i18n `dreamChangesDetail`
(`en.ts`/`zh-Hans.ts`). Keep the existing `{added, updated, forgotten, skipped}` shape (it
already carries the dedup-health signal `skipped`) rather than silently dropping it; if the
verb naming is aligned to `invalidate`, that rename is a coordinated edit across those four
consumers, not a one-line change.

## 4. Principal-keyed memory (the user is an ordinary principal) — proposal to data-model

This is the one genuinely **new** idea and the one **not yet** in the data model — so it is
written as a **proposal to ratify there**, not a decision taken here. **PM ratified the
direction (2026-06-09)**, and the concrete contract is now **drafted into [[agent-data-model]]**
as its *"Proposed extension — principal-keyed memory"* section (details pending ratification).
The sketch below is the originating rationale; the data-model section is the authority.

**The reframe.** A `MemoryEntry` is keyed by **`principal: Principal`** (the subject it is
about) instead of `agentId` (who owns it). A pool = one principal's self-model. The **user is
just a Principal that owns a pool** — not an `AgentIdentity` instance with its fields nulled.
`principal` is the elided subject of every fact, so it is *also* exactly what §2's render reads:
the split `<self>` vs `<principal>` becomes a stored-field read, no `agentId === me` heuristic,
and person-neutral storage becomes principled (one pool is read by many readers).

**Writing — per-principal Dream (one writer per pool).** A principal's Dream reads that
principal's own activity, models that principal, writes only that pool. This maps onto the
conversation/run split (data-model inv. 3): the **agent-Dream** reads the agent's **run log**
(execution) → its self-model; the **user-Dream** reads the **conversations the user is a member
of** (communication, both sides) → the user's self-model. One writer per pool — no cross-pool
writes, no N-writer contention. (Replaces P2's single per-agent Dream that wrote a mixed pool.)

**Reading — visibility = conversation membership.** Writes are per-principal; reads are
cross-principal. A reader injects its own pool (`<self>`) + every co-member principal's pool
(`<principal>`). The user is always a member → the user's self-model is automatically shared
across all the user's agents. Reuses `conversation.members`; **no `publish`/`subscribe` ACL, no
precedence table.** D2's isolation tiers still scope each pool's own retrieval, orthogonally.

**Security — the read path.** `recall` expands an entry's `sources` to raw evidence; a naive
cross-principal read would dereference **another principal's raw transcript**. Rule:
cross-principal recall returns the **distilled fact only**; `sources` expansion is gated to the
reader's own principal. A foreign-principal fact hits the reader's prefix every turn → highest
load-time-scan bar (Later: Hardening). This gating is part of the proposal, not deferred.

---

# Later layers (deliberately out of scope)

Each is real; kept out so the core stays small. Add when concrete.

- **`salience` / injection budget** — a `MemoryEntry` field + ranking term; it is data-model's
  open question, lands there with a producer (Dream) and a use (top-N `[3]` budget) together,
  with the usage-reinforcement loop — not a static author float.
- **`relation` (cross-agent edges)** — co-owned facts; a different beast from self-memory, not
  a third entry kind.
- **Recall depth** — semantic/embedding retrieval over today's lexical `recall`; recency
  half-life; a recall gate ("NONE" when nothing is confidently relevant).
- **Dream heuristics** — bidirectional capture, conditionalization, confidence-promotion,
  calibration proposals, decay/dedup: how `add`/`update`/`invalidate` behave well.
- **Hardening** — memory as an attack surface (load-time injection scan, `.bak` + drift
  detection); index pruning. Becomes load-bearing once §3's sharing ships.

# Prior art

**Survey (2026-06-08):** Generative Agents (memory stream + reflection; recency×importance×
relevance) → ranking. MemGPT (tiers, self-directed paging) → resident-vs-on-demand = `[3]`/`[5]`.
Zep/Graphiti (temporal KG, invalidate-don't-delete) → `status:'invalidated'`. A-MEM (evolve) →
Dream `update`. Sleep-time compute → Dream as substrate. **Local repos:** *cc-2.1* (four types
+ `MEMORY.md` index, scheduled Dream, per-turn extraction; "what NOT to save" ≈
reconstructability), *openclaw* (scored promotion, recall gate), *hermes* (USER/MEMORY split,
background review, cache-freeze). The one place this design leads all three is the
user-as-agent framing (§4); the rest is now mostly *consumed* from the data model, not novel.

# Open questions

These gate this plan's spine (storage/recall OQs live in [[agent-data-model]]):

1. **Cross-agent sharing mechanism** (→ data-model) — *(PM ratified the direction 2026-06-09:
   principal-keyed memory + per-principal Dream + visibility-by-membership. Concrete contract
   drafted into [[agent-data-model]] "Proposed extension — principal-keyed memory" section;
   remaining forks for the PM: agent↔agent reading now/defer, `<principal>` person, user-Dream
   cadence.)*
2. **Render budget & freshness** — how much of `[3]` to render, and is segment-boundary
   compaction a frequent-enough re-anchor, or is a delta-count threshold also needed? Measure (A9).
3. **`<principal>` provenance for the user-principal** — first-person ("I am you") vs second-person
   ("here's your record") render; leaning second (keeps the human as authority over identity).

# Phasing

**Execution (complete-per-PR).** cc-2's deliverable = **Phase 1 (render) + Phase 2
(Dream) as ONE complete PR** (`cc-2/memory-model`): a person-neutral writer (Dream)
feeding a reader-relative render, verifiable end-to-end (chat → Dream consolidates
person-neutral facts → render injects the briefing). **Phase 3 (user-as-agent) is
NOT in this PR** — greenlit but gated on ratifying the §4 extension into
[[agent-data-model]] first (interface-first, a separate PR). No storage-shape or
protocol change: `MemoryEntry` / `recall` / the memory + `dream.completed` event
types already exist in `agentEventLog.ts`.

**File scope (the Draft-PR claim):**
- *Render* — `src/main/agentRuntime.ts`: replace `buildMemoryReminder` /
  `formatMemoryReminder` / `uniqueMemoryEntries` (the per-turn `<agent-memory>`
  build) with the select→render briefing; it flows out through
  `buildUserPromptMessage` / `buildTurnReminderBlocks`. Reuse
  `src/core/agentAttachments.ts` (`systemReminder` / `isHiddenAgentContextBlock`)
  read-only.
- *Dream* — `src/main/agentDreamExtraction.ts` (extraction request / parse / source
  merge + the subject-elided writer contract) + `src/main/agentRuntime.ts`
  `applyDreamMemoryActions` (add / update / invalidate on the existing events +
  watermark). Coordinate any `dream.completed.changes` rename across its consumers.
- Does **not** touch `src/core/{agentEventLog,types,commands}.ts` or the launcher
  files `cc` holds — disjoint from cc's in-flight launcher work.

**Verification:** typecheck + `test:core` (memory/dream unit tests) + a real run:
chat, trigger Dream, confirm the rendered `<principal>` / `<self>` briefing appears
with correct person and that update/invalidate fold correctly. Cache: the memory
block injects once and mid-session updates ride the volatile tail; the [3] prefix
is only re-anchored at compaction (§2) — measure (A9) before adding any extra
re-anchor trigger.

- [x] **Phase 1 — render.** Replaced `formatMemoryReminder`/`<agent-memory>` with the
      select→render briefing (§2): `<memory>` with `<self>`/`<principal>` XML zones,
      person-neutral storage + reader-relative render, confidence-as-phrasing, emitted through
      `systemReminder()`/`isHiddenAgentContextBlock`. Lives in `src/main/agentMemoryBriefing.ts`
      (pure, unit-tested) and is wired in `agentRuntime.ts` `buildMemoryReminder` (now resident
      selection — query-specific retrieval stays on the `recall` tool). Consumes the existing
      `MemoryEntry` + `recall` tool unchanged; no storage-shape / identity-seam change.
      *Note:* today's single-agent runtime only reads its own pool, so a live run renders just
      `<self>`; the `<principal>` (third-person, foreign-`agentId`) path is implemented + unit-
      tested and lights up with Phase 3's subscribed principals.
- [x] **Phase 2 — Dream quality.** Subject-elided, base-form writer contract + consolidation
      heuristics added to the Dream extraction prompt (`agentDreamExtraction.ts`). The
      `add`/`update`/`invalidate` semantics already map to the existing events
      (`removeMemoryEntry` already invalidates-not-deletes) + watermark in
      `applyDreamMemoryActions`. Kept the `{added, updated, forgotten, skipped}`
      `dream.completed.changes` shape (the `forgotten`→`invalidate` rename was *not* taken —
      it is a coordinated four-consumer edit and out of scope for this PR).
- [ ] **Phase 3 — principal-keyed memory + per-principal Dream (PM ratified direction 2026-06-09).**
      Contract **drafted** into [[agent-data-model]] "Proposed extension — principal-keyed memory"
      section (`MemoryEntry.principal` replaces `agentId`; the user is an ordinary principal;
      per-principal Dream — agent-Dream over runs, user-Dream over the user's conversations;
      visibility by `conversation.members`; cross-principal read-path security gate) — **forks
      awaiting PM ratification**. Once ratified: land the `src/core/*` interface first (the
      `MemoryEntry` re-key), then build. Highest blast radius; interface-first. Lightly revises the
      shipped P1+P2 render key + P2 Dream (pre-launch clean cut, no migration).

> When implemented, fold §2/§3 into `docs/spec/`, push §4 into [[agent-data-model]], and move
> this plan to `docs/plans/archive/`.
