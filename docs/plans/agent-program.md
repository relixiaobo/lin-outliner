---
status: meta
priority: P1
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-09
---

# Agent Program — Foundation, Dependency Graph, Release Milestones

The umbrella for the agent-subsystem rebuild. It does **not** describe a feature; it
owns what no single feature plan should own alone: the shared **L0 foundation**, the
**cross-plan event taxonomy**, the consolidated **protocol-surface change list**, the
**dependency graph**, and the **release milestones M0–M3**. Member feature plans
*reference* this doc; they must not re-describe the foundation.

This is a **`meta`** plan — a standing reference (like `performance-optimization.md`
and `ui-quality-roadmap.md`), not a unit of work. It exists because analyzing
[[agent-conversation-model]] and [[agent-self-modification]] together revealed they are
**not two plans but one program over a shared foundation** — and that foundation is
mostly the *same* set of seams every agent plan was independently planning to cut.

## Member plans

| Plan | Owns | Milestone(s) |
|---|---|---|
| [[agent-data-model]] | The **authoritative** persistence + context contract: types, the three log instances, on-disk layout, distillation ladder, assembly invariants (F2/F3/F6 cut against it) | M0 (the data foundation) |
| [[agent-conversation-model]] | Agent identity, DM/Channel conversations, the memory line, background tasks, multi-agent + coordinator routing | M0–M3 (the spine) |
| [[agent-memory-model]] | The **render** projection of distilled memory + **Dream** consolidation semantics + the **user-as-agent** proposal (a thin layer atop data-model) | M1–M3 |
| [[agent-skills-authoring]] | Skill **structure** (unified library + binding + `built-in` floor) and **governed self-authoring** | M0–M2 |
| [[agent-self-modification]] | Self-observation, the `config` tool, **hooks**, config recovery, curation policy | M1–M3 |
| [[agent-ask-user-question-tool]] | The `ask_user_question` tool (structured pause/resume) | M1 — **v1 landed #153**; full version (refs/attachments/clarification) pending |
| [[agent-import-skill]] | Data import from other products (consumer of skills + ask_user_question) | M1–M2 |
| [[agent-scheduled-routines]] | `command` NodeType + anacron scheduler + triggered runs | **done (#165)** |
| [[agent-generative-ui]] | Inline HTML/SVG widgets in chat | M1–M2 (P3 priority) |
| `docs/plans/archive/agent-tool-permissions-hardening.md` | Post-#60 permission correctness/hardening | done (#154) |
| `agent-tool-result-trim` | Model-visible tool-result trimming | shipping (#128) |

## Shipped foundation (build on this — A8)

Already real; the rebuild sits **on top**, it does not re-implement these:

- **Event-sourced persistence** — target-oriented agent event-log family with
  `conversations/<id>`, `runs/<id>`, `agents/<id>`, and derived `indexes/`;
  payloads are scoped to conversation or run storage, `runs.json` indexes the
  runs anchored to each conversation, checkpoints replay from per-target offsets
  plus `seq`, and `AgentEventStore.readEvents()` is the minimal join seam back to
  the current reducer/runtime (`docs/spec/agent-event-log-rendering.md`).
- **Stable runtime identity** — the built-in assistant has a persisted
  `AgentIdentityRecord`, run meta carries `agentId`/trigger/fingerprint/retention,
  and message records carry a principal actor instead of the old implicit
  `'pi-mono'` author.
- **Domain event infrastructure** — a small internal bus separates persisted-log,
  renderer-projection, trusted-observer, and hook-interceptor lanes. It is the
  shared M0 dispatch seam; hook execution policy remains later work.
- **Run-local runtime state** — the active run owns run id, assistant text,
  tool-output payload refs, tool-call message ids, and the last submitted prompt.
  Remaining runtime-session object state is internal bridge debt, not a protocol
  shape for new consumers.
- **Compaction** — manual / automatic / reactive + tool-output slimming + recent-file
  restore; `compaction.completed` already records a summary over a **retained**
  range (the distillation backbone).
- **Skills** — discovery + invocation from `built-in` / `user` / `project` /
  additional / `dynamic` sources; path-conditional; embedded shell; `allowed-tools`
  run-scoped preapproval; `model`/`effort` override; `context: fork`; slash-only
  built-in `/skillify`; governed file-tool self-authoring with hot-reload and
  `skill.*` audit events (`docs/spec/agent-skills.md`).
- **Permissions** — `allow | ask | deny` + platform hard blocks + bash classifier +
  ask resolver + approval UI + permission events (#60,
  `docs/spec/agent-tool-permissions.md`). Conversation-scoped allow rules were
  removed by the archived hardening pass.
- **Subagents** — fresh / fork / background runs + sidechain transcripts + background
  notifications + `Agent` / `AgentStatus` / `AgentSend` / `AgentStop`
  (`docs/spec/agent-subagent-runtime-plan.md`).
- **Memory v1 + retrieval authority** — event-sourced per-agent durable memory
  (`memory.entry_*`), global-default retrieval with opt-in isolation tiers, and the single
  read-only `recall` tool (#152/#158). Write authority is exactly Settings/Profile UI +
  Dream — no model-visible write tool (#157; [[agent-data-model]] D1/D2).
- **Dream (reflective memory write-back)** — agent-level no-tools reflective run on a
  built-in daily schedule + manual `/dream`; summaries-as-locators then raw evidence;
  add/update/forget; extended to agent-owned subagent memory + a model-visible `dream`
  trigger + a chat-feedback boundary (#159/#161/#162/#163/#164).
- **Background visibility** — the conversation **task panel** listing subagent runs (#160)
  and **off-floor notifications** + attention delivery (#166).
- **Scheduled commands** — `command` NodeType + anacron scheduler + builder UI + run-on-boot
  catch-up (#165; [[agent-scheduled-routines]], now done).
- **Agent authoring** — user-facing create / edit / duplicate / manage `AGENT.md`
  definitions (Form⇄Raw editor, hot-reload, disable-by-identity) + subagent system-prompt
  unification (#167).

**Not shipped (the remaining build surface, as of #169 / 2026-06-09):** prompt-only hook
policy/execution; config recovery/rollback; skill curation; durable multi-agent
registry/coordinator + per-agent POV; the user-as-agent / cross-agent memory sharing
extension ([[agent-memory-model]] §4). Mid-run **`needs-input` is deferred by decision** —
subagents surface clarifications via their terminal result, not a mid-run ask.

## Execution policy — pre-release clean cut

Tenon has not shipped with production agent data. Agent work therefore optimizes for
the best target design, not persisted-data compatibility.

- **No compatibility layers.** Do not add old-format readers, dual-writes,
  migration scripts, or legacy session aliases for agent storage/protocol changes.
  A format change means wiping clone-local dev `userData`.
- **No new `session` surface.** New APIs, events, docs, tests, and plans use
  `conversationId`, `runId`, and `agentId`. Existing `sessionId` names are treated
  as M0 bridge debt and must not be copied into M1+ work.
- **One source of truth.** Durable event logs are authority. `meta.json`,
  `cursors.json`, checkpoints, and indexes are projections/caches and must never
  become a second writable truth.
- **Build on target seams only.** Consumers use the M0 conversation/run/agent
  store, domain event bus, principal actors, and active-run state directly. If a
  consumer would need an interim adapter, clean the seam first.
- **Delete, don't preserve, incorrect pre-release behavior.** If the current
  implementation shape is wrong for the target, replace it in the PR that depends
  on it rather than carrying a compatibility branch.

## The L0 foundation (M0) — shared seams, interface-first

Six seams the whole program rests on. They are mostly **protocol-surface** (A4) and
must land **interface-first** before consumers build on them (A7). Each names the plans
that consume it — proof it belongs here, not inside one feature plan.

| # | Seam | What | Consumers |
|---|---|---|---|
| F1 | **Agent identity record** | Stable `agentId` + persisted identity record exist for the built-in assistant; registry unification and multi-agent identity management stay in M3 | conversation-model (memory), self-modification (config/status), skills (binding) |
| F2 | **session → `{conversation, run}` (+ minimal join)** | Storage is re-keyed to conversation/run/agent families, run meta anchors execution to one conversation, conversation meta/cursors are separate files, and the current read seam joins target logs back into the reducer/runtime. Mixed-resolution (old segments → summaries) remains the **M1** enhancement. | conversation-model, scheduled-routines (persistence), single `recall` tool + internal evidence search, ask-question (events) |
| F3 | **`actor` on message records** | `AgentEventMessageRecord.actor` is required; runtime-authored events use the stable assistant principal instead of a hardcoded `'pi-mono'` author | conversation-model (notifications, multi-agent POV, forwarding), task delivery |
| F4 | **Internal domain-event bus + taxonomy** | The M0 bus exists with persisted-log, renderer-projection, trusted-observer, and hook-interceptor lanes. Consumer-specific notification/hook policy remains later work. | **notifications** (conv-model, trusted observer) + **hooks** (self-mod, untrusted) + ask-question + gen-ui + scheduled + config + skills |
| F5 | **`AgentSessionState` split** | Active-run state is structurally separated from the runtime session object and aligns with the F2 run log. Remaining session-shaped runtime fields are internal bridge debt, not a protocol shape for new consumers. | background tasks, scheduled routines, multi-agent channels |
| F6 | **Protocol-surface type adds (consolidated)** | Consolidated event/type reservations landed for task, notification, config, review-card, skill audit, user-question/widget state, run meta, payload scope, and command nodes | all plans |

### Cross-plan event taxonomy (design ONCE)

Every member plan independently planned to add events to `agentEventLog.ts` /
`agentTypes.ts`. **Reconcile them into one taxonomy here**, then each plan emits/consumes
its slice. cc-2.1's hook-event vocabulary (from self-modification) is the reference
naming; align lifecycle points to it rather than inventing variants.

| Event family | Emitted by | Consumed by | Notes |
|---|---|---|---|
| **Lifecycle** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PostCompact`, `Stop`) | runtime | hooks (self-mod), notifications | cc-2.1 names; the hook event surface |
| **Run / execution** (`run.started/completed/failed`, `*_message.delta`, `thinking.delta`, `tool_call.*`, `tool_result.created`) | the run loop | run log, debug panel | live in the **run log** (F2), not the conversation log — keeps `tool_call ↔ tool_result` pairs off the shared channel stream |
| **Permission** (`tool.permission.checked` → `tool.permission.resolved`, keyed by request id) | permission engine | approval UI, hooks, run log, `needs-input` | **M0 pins ONE canonical vocabulary + the request-id join** — reconciles today's `tool.permission.checked/resolved` + `approval.*` dual-track, which the spec admits can't join (`docs/spec/agent-tool-permissions.md:144,189`) |
| **Distillation** (`compaction.completed`, generalized) | compaction / consolidation | context assembly, navigation, recall, Dream span location | a recorded summary over a **retained** range; carries the addressable `source` down-pointer; Dream uses summaries as locators, then reads raw conversation/run evidence before writing memory ([[agent-data-model]]) |
| **Task** (`TaskCreated`, `TaskCompleted`, `needs-input`) | task plane (conv-model) | task panel, notifications, hooks | self-mod's `TaskCreated/Completed` hooks **depend on conv-model building this** |
| **Notification / attention** | task plane, runs | origin conversation (in-stream + unread/OS) | trusted internal observer; reuses **F3 `actor`** |
| **`user_question.*`** (requested / answered / cancelled) | ask_user_question | ask-question UI, `needs-input` tasks | [[agent-ask-user-question-tool]] |
| **`widget_state.updated`** | generative-ui | widget renderer, next-turn context | [[agent-generative-ui]] |
| **`ConfigChange`** | config tool | config recovery, hooks, audit | [[agent-self-modification]] |
| **`skill.*`** (create / patch / replace / enable / disable / rollback / curation) | skills authoring | skill audit, curation, hooks | [[agent-skills-authoring]] |
| **`sys:lastRunAt`** (schedule fire cache) | scheduler | catch-up decision | [[agent-scheduled-routines]] |

**Trust split (shared bus, separate dispatch).** Notifications are **trusted async
observers**; hooks are an **untrusted extension surface** with interceptors
(synchronous, can block/mutate, e.g. `PreToolUse`-deny) needing a sandbox/trust gate.
Both ride the same F4 bus; they differ in dispatch + trust, not in the event taxonomy.
Hook trust precedence: `system/admin > user > project > skill > model-suggested
session hook` (self-modification). Caution (from cc-2.1 + hermes): both fragmented into
per-consumer registries — "design the taxonomy once" is the cleaner target, but the
fragmentation pressure is real; keep the *event definitions* unified even if dispatch
is per-consumer.

### Consolidated protocol-surface changes (A4 / A7, interface-first)

Landed/reserved as coordinated M0 protocol surface (the infrastructure-ownership
list — `src/core/types.ts`, `commands.ts`, `agentEventLog.ts`):

- `actor` on `AgentEventMessageRecord` (F3).
- `Principal` type + conversation `members` (`meta.json` = projection; `cursors`
  a separate per-principal store); stable `agentId`; `RunMeta`
  (`conversationId` anchor + `trigger` provenance + `fingerprint` + `retention`);
  **no stored `kind`** (F2).
- `DistillationNode.source` (explicit both-ends range) + `MemoryEntry.sources` down-pointer (incl. `runId`/`eventId` for invalidation; [[agent-data-model]]).
- `MessageEvent.role` narrowed to `user | assistant`; `tool_result` events move to the run-log vocabulary; `MessageEvent.forwarded` provenance (`actor` stays native speaker) ([[agent-data-model]]).
- `MemoryEntry` schema (`memory.entry_added/...`) + `originWorkspace` +
  isolation tier + `status: active|invalidated`; M1 implements the runtime-owned
  memory append/retrieval surface, while extraction/consolidation stays M2+.
- Canonical `tool.permission.*` names + request-id join (the archived hardening
  pass reconciled the `checked/resolved` + `approval.*` dual-track).
- `'built-in'` on `SkillDefinition.source` ([[agent-skills-authoring]]).
- Pending-interaction types for `user_question.*` ([[agent-ask-user-question-tool]]) — **landed #153**.
- `widget_state.updated` event ([[agent-generative-ui]]) — still reserved (gen-ui not built).
- `command` NodeType + protected-field property + `sys:lastRunAt`
  (`CommandNode.sysLastRunAt`) ([[agent-scheduled-routines]]) — **landed #165**.
- Review/approval-card + `ConfigChange` event types ([[agent-self-modification]]).

(Not every item must land in one PR — but the **event taxonomy and naming** are decided
together, here, so consumers don't diverge.)

## Dependency graph

```
L0 FOUNDATION (M0, interface-first)
   F1 identity · F2 session→{conversation,run}+Principal/members+minimal-join · F3 actor
   · F4 internal domain bus (≠ renderer IPC) + ONE taxonomy · F5 AgentSessionState split · F6 protocol type adds
        │
L0.5 CLEAN CUT (pre-M1)
   remove session-named agent protocol/index/API bridge debt
   · event store deletes obsolete sessions/ + derived indexes
   · verify every active consumer plan targets conversation/run/agent seams directly
        │
L1 SINGLE-AGENT CAPABILITY (M1)
   memory foundation (conv-model) · skills self-authoring (skills-authoring)
   · self-observation + config tool (self-mod) · ask_user_question (its plan)
        │
L2 OFF-FLOOR + EXTENSION (M2)
   background task panel + notifications + needs-input (conv-model)
   · prompt-only hooks (self-mod) · single recall tool + Dream extraction
     (raw-record evidence, no foreground inline memory writer, no model-visible past_chats)
   · config recovery + curation
        │
L3 MULTI-AGENT (M3)
   sequential Channels + coordinator (conv-model) · per-agent POV derivation
   · cross-agent configuration · command hooks (self-mod) · memory v3 · registry unification
```

Feature consumers slot where their deps land: [[agent-import-skill]] at M1 (needs
skills save-as-adapter + ask_user_question), [[agent-scheduled-routines]] at M2 (needs
F5 split + triggered runs), [[agent-generative-ui]] at M1/M2 (needs F4 bus; P3 priority,
mostly independent).

## Release milestones

| Milestone | Content | User-visible value |
|---|---|---|
| **M0 — Foundation** · ✅ #150 | F1–F6: identity · session→`{conversation, run}` (+ `Principal`/`members`, no stored `kind`, **+ minimal run-log-join assembly**) · actor · **internal domain bus** + taxonomy (canonical permission names) · AgentSessionState split · consolidated protocol-surface adds | none directly — unblocks the whole program, one design pass, no rework |
| **M0.5 — Clean cut** · ✅ #151 | Rename/remove remaining agent `session*` protocol/index/API bridge debt; update consumers to `conversationId`/`runId`/`agentId`; delete old aliases instead of preserving compatibility; event store deletes obsolete `sessions/` + derived `indexes/` after the format cut | none directly — prevents M1 from building on transitional names or stale storage assumptions |
| **M1 — Single-agent "self"** · ✅ #152–#156 | memory foundation (global-default + **opt-in isolation**; **runtime-owned append surface**, not file_write; profile UI; reminder injection) · **mixed-resolution enhancement** (old segments render as compaction summaries — the run-log join itself ships in M0) · canonical DM + user-creatable Channels · skills self-authoring · config tool + runtime_status + doctor · ask_user_question | the agent can **use remembered context**, can be **configured**, can **author its own skills**, can **ask structured questions** — the bulk of perceived value |
| **M2 — Off-floor + extension** · ▣ mostly landed #157–#167 (remaining: prompt-only hooks · config recovery · skill curation) | background task panel + notifications + needs-input · prompt-only hooks · clean-cut removal of foreground inline memory writes and model-visible `past_chats` · single read-only `recall` tool over active memory entries with optional nested evidence expansion · memory v2 Dream extraction over raw conversation/run records, with summaries/search only as locators · config recovery + skill curation | long tasks **don't go silent**, work is **observable**, memory becomes **automatic and less overfit**, runtime self-heals; old conversations not distilled into memory are intentionally not foreground-recallable |
| **M3 — Multi-agent** · ◻ not started | sequential Channels + coordinator · per-agent POV · cross-agent configuration · command hooks · memory v3 consolidation · main-agent registry unification | **IM-native multi-agent** collaboration |

**Cross-milestone note — per-agent identity started early (2026-06-07, #164).** Agent-owned
subagent memory (an M2 slice on top of the Dream milestone) gives every fresh typed subagent its
own `memoryOwnerAgentId` (the called agent definition), its own durable memory line, owner-scoped
`recall` / `<agent-memory>`, and a per-owner scheduled Dream; forks inherit the parent owner. This
is the first **per-agent identity for a non-foreground agent** — groundwork the map had placed in
**M3** (per-agent POV · registry unification). M3 therefore *unifies* an already-real multi-owner
memory model rather than introducing it: the registry/POV work builds on `agentSubagentIdentity.ts`
(the single owner-resolution seam) + `agentSubagentTranscript.ts` (id-addressing), and must not
redesign them. Open consequence for M3: a built-in subagent owner id is workspace-independent, so its
memory line spans workspaces — `isolated`-tier scoping for such shared owners is settled for the
single-host case (#164) but is a known design surface when multi-host/registry lands.

## M3 sequencing & readiness (verified 2026-06-10 read-only audit; debt-first)

A read-only code audit (storage / membership / multi-agent readiness) settled what M3
actually builds on and re-sequenced it **debt-first** (PM-ratified 2026-06-10). The map
of the whole subsystem now lives in `docs/spec/agent-architecture.md` (the 7 primitives +
this status table).

**Audit outcome — the foundation is clean; load-bearing debt is small and contained.**
- ✅ **built:** three-ledger storage + write-time split (legacy flat `sessions/` deleted
  on startup); `Principal` + per-message `actor`; `members[]` populated **and already used
  for memory Dream scope**; run→conversation anchor + per-conversation run index; typed
  sub-agent identity + per-agent memory line (#164).
- ⚠ **scaffolded (connect, don't remove):** `addressedTo`, `member.added/removed`, the
  foreign-`<principal>` render hook — types exist, never written/read; they are the M3
  work itself, not separate debt.
- ◻ **missing (the M3 build):** create a >1-agent conversation (Channel —
  `defaultConversationMembers` is hardcoded `[user, mainAgent]`); routing/coordinator;
  peer-agent reply in the shared thread; **cross-agent memory sharing + a cross-principal
  isolation gate** (the *one* genuinely new primitive); per-agent POV projection.
- ⚠ **the one load-bearing code debt:** #164 memory-source binding under compaction.
  Narrowed by the follow-up audit: `sources[]` are already ID-pinned + fail-loud (robust);
  the residual hole is the **positional Dream watermark** — a fork run that auto-compacts
  can be skipped forever, dropping its summary as evidence. Cross-agent citing would
  inherit it. **Must harden before the sharing step** — plan (PM-ratified 2026-06-10):
  `agent-memory-source-binding`.

**Finding:** M3 = **rules + views + ONE new primitive** (cross-agent memory sharing),
all riding the existing 7 primitives — it does *not* re-inflate the concept count.
**Ratified:** build the **peer model** the data-model already designed (`members` +
`addressedTo` + "a run iff a principal is addressed"); connect the scaffolding, don't
reinvent.

**Debt-first order (each phase pays its load-bearing debt before the next builds on it — A7 at roadmap level):**

- **Phase 0 — settle the map.** `docs/spec/agent-architecture.md` (done) + this
  reconciliation + ratify the peer model. ~no code.
- **Phase 1 — fix the one load-bearing debt.** Harden #164 memory-source binding —
  ratified plan: `agent-memory-source-binding`. **Merged #178.**
- **Phase 1.5 — storage clean-cut (PM-ratified 2026-06-10, full scope).** The
  "optional cheap clean-cut" is now a real plan: `agent-storage-clean-cut` —
  stored event types `session.*` → `conversation.*`, `sessionId` field →
  `conversationId`, ALL code identifiers renamed (the #151 translation seam
  dissolves), pools unified under `principals/<principalKey>/memory/`,
  store-owned old-format wipe. **Lands after M3-A + the memory-alignment PR
  merge, before M3-B/D1** — the new event family and cross-agent read path
  build on clean names (A7).
- **Phase 2 — multi-agent (shape (b): a SET of 3 independent complete features,
  dependency-ordered; each has a drafted plan file — dispatch is a one-liner):**
  - **M3-A — working multi-agent Channel** (ONE PR): membership + routing
    (`addressedTo`, coordinator) + peer-agent reply (`actor` = agent principal) +
    the §8 POV flatten at assembly. Membership-without-reply would be a scaffold
    slice, so these ship together. Plan: `agent-channel-peers`. In build (cc).
  - **M3-B — cross-agent memory sharing + the cross-principal isolation hard gate**
    (the one new primitive; depends on Phase 1 + M3-A + the storage clean-cut).
    Plan: `agent-cross-agent-memory`.
  - **M3-C — per-agent POV inspector** (derived view over M3-A's assembly
    derivation). Plan: `agent-pov-projection`.
  - Open PM gates carried inside the plans: group default-`addressedTo` (M3-A Q1)
    · uniform co-member pool rule (M3-B Q1). `who-configures-whom` stays deferred
    (main-agent-first default, untouched by M3); `doc snapshot+delta` belongs to
    the memory-prefix/cache work, not M3.
- **Parallel (orthogonal, not blocked):** `agent-skill-acceptance` (PR A, cc) — **merged
  #175** (skills-only; zero overlap with the M3 spine, confirmed by diff).

## How this reorg changes the member plans

- **[[agent-conversation-model]]** — slimmed: its §Skills moves to
  [[agent-skills-authoring]] (a structural-facts stub + pointer remains). The L0 seams
  it analyzed (identity, actor, session→{conversation,run}, AgentSessionState split) **keep
  their detailed, code-grounded design in conv-model**; this program doc owns only their
  **sequencing, the unified event taxonomy, and protocol-change coordination** (so
  consumers don't diverge). It remains the owner of conversations / memory / tasks /
  multi-agent.
- **[[agent-self-modification]]** — slimmed: §7 Skill Maintenance + §8 Curation move to
  [[agent-skills-authoring]]; its hook system references the **F4 event bus** here; its
  `TaskCreated/TaskCompleted/TeammateIdle/Notification` hooks are explicitly **gated on
  conv-model's task/channel layer (M2/M3)**.
- **[[agent-skills-authoring]]** — new; the single home for skill structure + authoring.
- The remaining plans (**ask-user-question, generative-ui, scheduled-routines,
  import-skill, permissions-hardening**) stay as feature plans; their event additions
  are reconciled into the taxonomy above; their build slots into the milestones.

## Open questions (program-level)

- **Milestone granularity for PRs.** M0 landed as one foundation implementation;
  later milestones should prefer feature-sized PRs now that the shared seams exist.
- **Who configures whom** (cross-agent configuration scope: main-agent-first vs every
  specialist) — directional, owned by [[agent-conversation-model]] / [[agent-self-modification]].
- **Event taxonomy ownership after M0.** M0 event/type facts are folded into
  `docs/spec/agent-event-log-rendering.md`; this meta plan remains the milestone
  map rather than the runtime contract.
