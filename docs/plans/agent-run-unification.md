---
status: draft
priority: P1
owner: unassigned
created: 2026-06-10
updated: 2026-06-10
---

# Run unification: dissolve the subagent entity

**Shape: (a) ONE complete feature in one PR** (internal build order below).
**PM-ratified 2026-06-10.** Sequenced: storage clean-cut → M3-A → **this** →
M3-B.

## Goal

The concept model says there are 7 primitives — and "subagent" is not one of
them: there is only **Agent**, and a delegation is just **a Run whose
`parentRunId` points at another run**. The code disagrees: today "subagent" is
an entity-grade species with its own machinery, storage shape, and coordinate
system. This PR makes the code honor the model. After it:

- A delegated (child) run is an **ordinary Run**: its own `runs/<runId>/`
  append-only ledger, `parentRunId` + conversation anchor on its meta, executor
  = an ordinary agent identity.
- **One evidence addressing scheme** everywhere: stable seq/eventId — the
  conversation scheme. The `runId:message:N` codec and payload pinning are
  deleted.
- **One watermark shape**: `{seq, eventId}` per stream (conversation or run).
  `AgentDreamAgentRunWatermarkCursor {messageCount, payloadId}` is deleted.
- **One compaction semantics**: event-sourced (append a compaction event,
  re-anchor the active path) — the snapshot-rewrite path is deleted, and the
  §13.17 evidence-preserving invariant holds *structurally* instead of by
  guard.
- The word `Subagent` leaves the type system; the relationship vocabulary is
  *delegation / child run*.

## The asymmetry (verified this session, `file:line`)

| | Conversation evidence | Child-run evidence (today) |
|---|---|---|
| Storage | append-only ledger, seq-addressed | payload snapshot blob (`run.transcriptPayloadId`) in parent state (`state.subagents[runId]`) |
| Coordinates | stable `eventId`/seq | `runId:message:N` codec (`agentSubagentTranscript.ts:57-81`) + payload pin (`AgentMemorySource.eventId`) |
| Compaction | event-sourced | **payload rewrite** (`agentSubagents.ts` auto-compact ~:918+) — all prior coordinates die |
| Dream watermark | `{seq, eventId}` (`agentEventLog.ts:431-434`) | `{messageCount, payloadId}` (`:436-439`) — positional, #178-guarded |

The #164 review (10 findings) and #178 (2 holes) were the interest paid on
this unacknowledged eighth primitive. #178 made it *correct*; this PR makes it
*gone*.

## Design (build order within the one PR)

1. **Ledger:** child runs write their transcript (assistant deltas/messages,
   `tool_call ↔ tool_result`, thinking) as run-log events in their own
   `runs/<runId>/` — the same `AgentRunLogEvent` union and retention machinery
   as main-agent runs. The parent run stores only the join
   (`parentToolCallId ↔ childRunId`); `state.subagents`/transcript payloads go.
2. **Evidence:** run-sourced `AgentMemorySource` carries stable run-ledger
   ids (same shape as conversation sources). Resolution drops the
   envelope/window path (`agentPastChats.ts:396-434`) for the ledger read path.
   **No positional coordinate may survive** — pinned.
3. **Watermark:** one cursor type keyed by stream id; delete the agent-run
   variant; Dream's "what's new" reads the child-run ledger like any stream.
4. **Compaction:** child-run auto/manual compaction = the conversation
   compaction machinery (compaction event + re-anchored active path + summary
   as evidence per #178). Delete the snapshot-rewrite path and the
   `dreamEvidenceStartMessageIndex` payload-coordinate bridge — the fork
   boundary becomes a ledger position.
5. **Vocabulary:** `AgentSubagentRunRecord` → child-run record on the normal
   run index; `agentSubagents.ts` machinery folds into the run runtime;
   `resolveSubagentMemoryOwner` semantics unchanged (#164 ratified), renamed.
   `agentSubagentIdentity.ts` / `agentSubagentTranscript.ts` shrink or vanish.
   While folding, **consolidate the duplicated frontmatter machinery onto
   `core/agentMarkdown.ts`** (PM-ratified 2026-06-10, from the pre-release
   architecture sweep): the AGENT.md parser copy (`agentSubagents.ts:1444` vs
   `agentMarkdown.ts:43` — already drifted in formatting) and the 7 private
   helper copies (`parsePermissionMode`/`parseBoolean`/`parsePositiveInteger`/
   `normalizeModelField`/`coerceString`/`isPlainRecord`/`parseStringList`,
   `agentSubagents.ts:1828-1902`) die with the module; point `agentSkills.ts`'s
   private copies (`:1323`, `:1681`) at the same exports so the parser exists
   exactly once.
6. **Old-format clean-cut — the `layout.json {v}` version sentinel
   (PM-ratified 2026-06-10, upgrading the deferred #180 gate finding #4):**
   this PR is the next format break, and instead of hand-authoring a third
   detector it lands the structural fix. The store writes a root
   `layout.json {v: N}` once per format generation; startup reads that one
   file — `v` current → proceed (no per-conversation probing), `v` stale or
   file missing → wipe the agent data root (a fresh install wipes an empty
   dir, harmless) and write the current sentinel. This **deletes the #180
   detector pile** (`hasLegacyEventVocabulary`, `readFirstLine`, the
   `LEGACY_SESSIONS_DIR`/`LEGACY_SESSION_INDEX_FILE` constants) and
   structurally closes its recorded follow-ups: content-triggerability
   (nothing inspects content), the per-launch O(N-conversations) head scan
   (one 1-line read), and the user-pool-only false negative (no artifact
   enumeration to miss). Two #180 gate constraints carry over as invariants:
   **the destructive path requires positive proof** (an unreadable/corrupt
   sentinel is ambiguity → fail open to the current layout, log, re-probe
   next launch — never wipe on error) and **fail open to operation, never to
   a wipe**. Future format breaks bump the integer instead of authoring
   another `hasLegacyX`.
7. **Spec sync (A6):** `agent-architecture.md` (sub-agent bullet → pure
   relationship; status row), `agent-data-model.md` §3/§5 run section + §13.17
   note ("holds structurally"), `agent-subagent-runtime-plan.md` spec doc
   re-worded to delegation vocabulary.

## Behavior contracts that must NOT change

- **fork vs fresh semantics** (#164 ratified): fork = the same agent continuing
  in a child run, shares the parent's memory line; fresh = a typed agent with
  its own identity + memory line. Only the *representation* changes.
- Memory ownership resolution, permission flow, sidechain transcript rendering
  (now fed from the child ledger), Task-panel visibility, background lifecycle.
- The #164/#178 regression suite migrates with its *intents intact*: every
  scenario (fork + auto-compact + Dream coverage; pinned-evidence resolution
  after compaction) must still pass, now via the unified representation.

## Non-goals (boundary — 钉死)

- NOT the session→conversation rename (`agent-storage-clean-cut`, lands first).
- NOT memory deltas D1/D3/D4, NOT M3-B sharing — they build on this.
- NOT any change to what subagents can do (tools, permissions, budgets).

## Acceptance

- [ ] Greps: `rg -i subagent src/` → 0 (excluding historical docs);
      `rg "transcriptPayloadId|agentRunMessageId|messageCount" src/` → 0 in
      live code paths.
- [ ] A delegated run round-trips: spawn → transcript in own ledger → parent
      join renders sidechain → auto-compact (event-sourced) → Dream consolidates
      with the unified `{seq, eventId}` cursor → evidence resolves or fails
      loud. One integration test covers the chain.
- [ ] Migrated #164/#178 scenario tests green; full `test:core` +
      `test:renderer` vs baselines; `CHECKPOINT_VERSION` bumped.
- [ ] Sentinel fixture tests: pre-sentinel data (no `layout.json`) → wiped +
      sentinel written; current `v` → no wipe, no per-conversation probing;
      stale `v` → wiped; unreadable/corrupt sentinel → fail-open (no wipe,
      store fully functional, re-probe next launch). The #180 regression
      intents (content can never trip a wipe; probe errors don't brick the
      store) migrate onto the sentinel read path.
- [ ] The #180 detector pile is gone: `rg "hasLegacyEventVocabulary|LEGACY_SESSIONS_DIR|LEGACY_SESSION_INDEX_FILE" src/` → 0.
- [ ] Spec synced per Design 7; plan archived `done`.

## Collision self-check (2026-06-10, plan time)

Touches `agentEventLog.ts` (protocol surface, A4), `agentEventStore.ts`,
`agentRuntime.ts`, `agentSubagents*.ts`, Dream/recall paths. Queues strictly
behind `agent-storage-clean-cut` (cc-2, in build) and M3-A (#179, paused →
resumes first); lands before M3-B/D1/D3. Re-verify all `file:line` anchors at
claim time — both predecessors will have moved them.
