# Agent Debug, Run-Grounded — debug as a view over the run truth source

Rebuild the agent **debug surface** from scratch as a faithful, read-only
**view of the execution tree** — `conversation → runs → rounds →
request / response / tool-exchange` — sourced entirely from the run ledgers that
are already the system's truth, plus one gated transport sidecar (the exact
outbound wire bytes) that the semantic ledger cannot reconstruct.

Designed greenfield (no debug-snapshot baggage), but grounded on the **real** DM
and Channel implementation: the per-run `AgentRunMetaProjection`, the per-run
event ledger (`runs/<runId>/events.jsonl`), and the conversation run index.

**Part of finishing [[agent-run-unification]].** That shipped plan dissolved the
"subagent" entity — *"there is only Agent; a delegation is just a Run whose
`parentRunId` points at another run"* — and made **child** runs independent
`{seq, eventId}` streams. It left **turn** runs on the conversation-shared seq
scheme. This plan pays down that asymmetry (PR 1) and builds the debug view on
the resulting uniform model (PR 2).

**Shape: (b) a SET of two independent complete PRs, ordered by genuine
dependency.**
- **PR 1 — Foundation (refactor):** finish run-unification — every run is an
  independent, private-seq stream; the conversation transcript is assembled by
  *splice*, not global-seq merge. All existing consumers (chat transcript,
  search, dream evidence, *and the current debug panel*) keep working
  identically. Independently shippable: it is a debt-paydown refactor with
  standalone value, not scaffold — every consumer runs on it the moment it lands.
- **PR 2 — Consumer (feature):** the run-grounded debug surface. Deletes the
  debug-snapshot stream, its provider-wire parser, and its seq-matching
  projection; replaces them with a per-run execution-tree view. Depends on PR 1.

PR 1 is the [[agent-program]] A7 foundation; PR 2 is its consumer. They are split
(not one PR) because PR 1 keeps `readEvents` returning an ordered merged stream —
a *general* capability used by search / checkpoints / past-chats / dream
evidence, not a debug-only bridge — so the current debug panel survives PR 1 with
no throwaway, and PR 2 then replaces it cleanly.

## Goal

A developer opens the debug panel on any conversation and sees, faithfully:

- **Every LLM call the system made**, as a complete `(request, response)` pair —
  one entry per provider round — including the main agent, every Channel peer
  agent, and every delegated child run.
- Organized by the conversation's own shape: **DM** is a single linear column of
  rounds; **Channel** is the same timeline attributed per executing agent. (DM is
  the degenerate single-member case of the Channel view — one rendering, not two.)
- With **real** numbers (token usage / cost / context size from the response,
  not a `bytes/4` estimate), **real** stop reasons, and the **exact** outbound
  wire bytes available on demand.
- Live: as the active run appends events, the tree grows; the in-flight round
  shows its request before the response arrives.

## Non-goals

- No migration / back-compat. Pre-release: a format change wipes
  `~/.lin-outliner-*` dev userData ([[agent-data-model]] cut-over discipline).
- Not a redesign of the agent runtime's *behavior* — only its event-stream
  storage uniformity (PR 1) and the debug *view* (PR 2).
- Not a new chat-transcript UX. PR 1's invariant is that the visible transcript
  is **byte-for-byte identical**; only its assembly changes.
- Reflective / `dream` runs (anchored to a principal, not a conversation) are out
  of the conversation debug view (see Open questions).

## Background: the truth source today (code-grounded)

A conversation's LLM activity is already fully event-sourced. Verified against
real on-disk data (`~/.lin-outliner-main`, DM `lin-agent-dm-2c31f9f55b1c0da1`
and Channel `lin-agent-channel-f78952f6…`):

- **`runs/<runId>/meta.json` = `AgentRunMetaProjection`** is the per-run truth:
  `agentId`, `kind` (`turn` / `delegation` / `reflective`), `status`,
  `anchor {type, conversationId, agentId}`, `trigger {type:'message', messageId}`
  (the conversation-timeline anchor), **real `usage` + `cost`**, `fingerprint`
  (`promptHash` / `modelConfig`), `parentRunId`, `latestSeq`, `createdAt`.
- **`runs/<runId>/events.jsonl`** is the run's ledger: `payload.created`
  (`role:'debug'`, the sanitized outbound request bytes), `assistant_message.started`
  (`providerId` / `modelId` / `apiId`), `assistant_message.completed` (content +
  usage + stopReason), `tool_call.*`, `tool_result.created`, `tool.permission.*`,
  `run.started` / `run.completed`.
- **`conversations/<id>/runs.json`** indexes the conversation's runs (`runIds`,
  `delegationRunIds`, `latestSeqByRunId`).
- **DM** = a single agent (`built-in:tenon:assistant`): one `turn` run per user
  message, an occasional `delegation` child run.
- **Channel** = multiple agents: `turn` runs carry differing `agentId`
  (observed: `built-in:tenon:assistant` ×10 interleaved with
  `user:…:my-agent` ×7), each anchored to its addressing message via
  `run.started.addressedByMessageId` / `trigger.messageId`.

**The asymmetry this plan removes.** Run-unification made child runs independent
`{seq, eventId}` streams (observed child `latestSeq` ≈ 68, run-private), but turn
runs still ride the **conversation-shared** seq via the write-time split
(`agentEventStore.appendSplitEvents` + `isRunLogEvent`): observed turn-run
`latestSeq` values 168, 229, … 1190 are conversation-global. So one
`runs/<id>/` directory holds **two seq conventions** depending on run kind, and a
consumer must branch on kind. PR 1 makes every run identical.

**Why the current debug panel shows nothing useful.** `agentDebugProjection`
re-pairs `debug.snapshot.created` (provider_payload) with
`assistant_message.completed` by global seq, then `agentDebug` re-parses the
provider wire JSON into message rows. This is a *parallel representation* of what
the ledger already holds. Every round also writes a second, content-free
`provider_response` snapshot (status/headers only), and `slice(-20)` then halves
the visible rounds. The data is all in the ledger; the snapshot layer is
redundant and noisy.

## Design

### PR 1 — Finish run-unification: every run is an independent stream

**Target invariant.** A run stream is self-contained and portable: it replays
*alone* into its own `AgentEventReplayState`, in its own private seq space,
written by **one** writer — identical for `turn`, `delegation`, `background`,
`scheduled`, and Channel-peer runs. The only difference between runs is
`meta.kind` and `meta.anchor`. This is the symmetry [[agent-run-unification]]
already asserts for the model; PR 1 makes turn runs honor it.

**One run-stream writer.** Generalize `AgentRunLedgerWriter`
(`src/main/agentRunLedger.ts`) — today scoped to child runs — into the writer for
*every* run (`AgentRunStreamWriter`). Turn runs stop routing their run-scoped
events through `appendConversationEvents → appendEvents → appendSplitEvents`
(conversation seq) and instead append to their own stream via
`appendRunStreamEvents` (private seq), exactly as child runs do today. The
write-time `isRunLogEvent` split and `compareAgentEventsForReplay`'s global-seq
merge stop being load-bearing for run content.

**Conversation = backbone + splice.** The conversation log keeps only genuinely
conversation-scoped events (`conversation.*`, `user_message.created`,
`branch.selected`, `member.*`, `follow_up.*`, `checkpoint.created`, and the
conversation-level `compaction.completed` / `dream.finished` markers). The
visible transcript is assembled by **splicing** each run's replayed messages into
the backbone at its anchor (`run.started.addressedByMessageId` /
`trigger.messageId`), ordered among sibling runs by anchor then `createdAt`. This
**generalizes the splice that already exists** for Channel peer replies
(`agentEventLog.getAgentEventVisibleTranscriptPath` /
`activeChannelReplySlotsForParent`) from "channel reply slots" to "every run".

**`readEvents` stays an ordered merged stream.** Existing consumers that want a
single ordered event list (search indexing, checkpoints, past-chats, dream
evidence, *and the current debug projection*) keep getting one — now produced by
ordering run streams by their anchor + private seq, rather than a naive global
seq sort. This is the seam that lets PR 1 ship without touching debug and without
a throwaway bridge.

**One debug-request capture seam.** `createConfiguredAgent`'s `onPayload`
(`src/main/agentRuntime.ts`) already receives the exact outbound payload for
*every* agent it builds (DM, Channel peer, delegation). Route capture through the
run-stream writer — `writer.recordRequestPayload(runId, sanitizeForDebug(payload))`
appending the existing `payload.created` (`role:'debug'`, run scope) to the run's
stream. Because the writer is now uniform, **delegated child runs get request
capture for free** — closing the observed gap where child ledgers have zero
request payloads. Capture is gated (see PR 2 / Open questions); when off, the
semantic stream is unaffected.

**Checkpoints / indexes / resume.**
- *Indexes:* search + conversation indexes already must fold run-stream
  `assistant_message.completed`; centralize that in the writer's append path
  (today partial via `updateRunMeta` / `updateRunIndexes`).
- *Resume / restore:* turn-run resume generalizes child-run restore
  (`AgentRunLedgerWriter.restore` / `restoreChildRunLedger` →
  `restoreRunLedger` for all kinds).
- *Checkpoints:* re-scope to `{conversation-backbone latestSeq}` + per-run
  cursors (runs replayed lazily), instead of a single merged-state checkpoint.

**Guard invariant.** A guard test asserts the spliced visible transcript equals
today's `getAgentEventVisibleTranscript` output for representative DM, Channel,
and delegation fixtures — the refactor is correct iff the transcript is identical.

### PR 2 — The debug surface as an execution-tree view

**The unit is the round** = one provider call = `(request, response)`. Above it:
`conversation → run (per agent) → round → request / response / tool-exchange` —
the literal shape of run-meta + run-ledger.

**Read model (main process).** Two IPC reads replace
`agent_debug_snapshot` / `_history` / `_totals` / `_payload`:
- `agentDebugView(conversationId)` → the tree summary. Enumerate `runs.json.runIds`
  (exclude principal-anchored reflective runs; include `delegation`), read each
  `AgentRunMetaProjection`, and return per-run nodes (agent, kind, status,
  `trigger` / `addressedByMessageId`, `parentRunId` / `parentToolCallId`, model,
  **real usage**, `roundCount`) plus conversation shape (DM/Channel from id +
  `meta.members`) and totals (sum of run usage).
- `agentDebugRun(conversationId, runId)` → one run's rounds, derived lazily by
  `replayRunStream(runId)` (reusing the `childRunTranscript` cache-by-`latestSeq`
  pattern).

**Round derivation (from a run's replayed stream).** Walk the run's events in
order; each request marker (`payload.created` `role:'debug'`) opens a round, the
following `assistant_message.started` / `.completed` closes its response, and the
intervening `tool_call.*` / `tool_result.created` are that round's tool
exchanges. System prompt and tool schemas are shown **once at run level**
(constant within a run, modulo skill injection / compaction — flag a per-round
change by wire hash), so a round renders the *new* context (preceding tool
results / the triggering message) + the response, not the whole growing history.

| Debug concept | Real event / field |
|---|---|
| run node (agent / kind / status / usage / model) | `AgentRunMetaProjection` |
| round request — exact bytes | `payload.created` `role:'debug'` (sanitized), via `readPayload` |
| round response — content / usage / stop | `assistant_message.completed` |
| round model / provider / api | `assistant_message.started` + meta `fingerprint` |
| tool exchange | `tool_call.*` → `tool_result.created` |
| timeline anchor | `trigger.messageId` / `run.started.addressedByMessageId` |
| delegation nesting | `parentRunId` + `child_run.started.parentToolCallId` |
| agent attribution | per-run `meta.agentId` |

**Raw wire is the only captured thing, and it's gated.** The semantic view
(messages, response, usage, tools, stop reasons) is *always* available — it is
the run itself. The exact outbound bytes + inbound HTTP metadata
(`status` / `latency` / `request-id`) are the one irreducible debug capture,
gated behind a debug toggle (large + sensitive). Debug-off still yields a rich
tree; debug-on adds the raw `<pre>` payload and transport metadata per round.

**One timeline for DM and Channel.** A single `DebugTimeline` renders both: runs
ordered by anchor; each run a group with an agent-attributed badge/color; rounds
within; delegation runs nested under their originating round + `parentToolCallId`;
parallel runs fanned out under a shared addressing message (faithful to Channel's
independent-answers concurrency); an agent filter for isolating one agent. DM is
this view with one member.

**Deletions (net code removal = the cleanliness signal).**
- `debug.snapshot.created` event type + `DebugSnapshotCreatedEvent`
  (`src/core/agentEventLog.ts`); the `provider_response` and `runtime_state`
  sources.
- `src/main/agentDebugProjection.ts` (the seq-matching projection) — gone.
- `agentDebug`'s provider-wire parser (`extractPayload` / `extractMessages` /
  `extractContentBlockParts` / `extractOpenAiToolCall`, ~250 lines) — gone;
  response comes from the ledger's structured `AgentPersistedContent`, the raw
  payload is shown as bytes, not parsed.
- The double-snapshot capture → a single request-payload sidecar.

**Files.**
- `src/core/agentTypes.ts` — replace `AgentDebugSnapshot*` with execution-tree
  types (`AgentDebugConversation` / `AgentDebugRunSummary` / `AgentDebugRun` /
  `AgentDebugRound`); keep `AgentDebugUsage` / `AgentDebugTotals`.
- `src/core/agentEventLog.ts` — remove the debug-snapshot event variant.
- `src/main/agentDebug.ts` — rewrite as round derivation; delete the parser.
- `src/main/agentDebugProjection.ts` — delete.
- `src/main/agentRuntime.ts` — new debug IPC (`agentDebugView` / `agentDebugRun`
  / gated `agentDebugWire`); capture via the unified writer.
- `src/renderer/api/client.ts` — new IPC methods.
- `src/renderer/ui/agent/AgentDebugPanel.tsx` — rewrite as `DebugTimeline`.
- `src/renderer/styles/agent-debug.css` — restyle.
- `src/core/i18n/messages/{en,zh-Hans}.ts` — new labels (also clears the
  OS-locale-timestamp debt noted in TASKS).
- `docs/spec/agent-debug.md` (new) + `docs/spec/README.md` map entry
  (index is main-owned — coordinate).

## Open questions

1. **Raw-wire capture: default on or off?** Recommend **default-off** (semantic
   tree always on; raw bytes are the gated luxury). Confirm; decide retention
   (keep per conversation vs cap last N).
2. **System / tools exactness without raw-wire.** Off-wire, system comes from
   `AgentIdentityRecord` and tools from the registry (approximate); on-wire they
   are exact. Acceptable, or always capture a *tools+system* digest cheaply?
3. **Transport metadata** (`httpStatus` / `latency` / `request-id`) from
   `onResponse`: fold into the round (small, useful) or skip?
4. **Reflective / `dream` runs** (principal-anchored): excluded from the
   conversation view here. Future principal-scoped debug surface, or surfaced as
   a separate "background runs" section?
5. **PR 1 checkpoint re-scoping** is the riskiest sub-piece — settle the
   backbone-cursor + per-run-cursor shape before the splice lands.

## Checklists

**PR 1 — finish run-unification (foundation)**
- [ ] Generalize `AgentRunLedgerWriter` → one writer for all run kinds (private seq).
- [ ] Turn runs append to their own stream; remove the write-time conversation-seq split for run content.
- [ ] Conversation transcript assembled by splice (generalize the channel-reply splice to all runs).
- [ ] `readEvents` keeps yielding an ordered merged stream (consumers unaffected).
- [ ] `recordRequestPayload` on the writer; wire once in `createConfiguredAgent.onPayload` (covers child runs).
- [ ] Generalize resume/restore and index folding; re-scope checkpoints.
- [ ] Guard: visible transcript identical for DM / Channel / delegation fixtures.

**PR 2 — run-grounded debug surface (consumer)**
- [ ] Execution-tree types; remove snapshot types + `debug.snapshot.created`.
- [ ] `agentDebugView` / `agentDebugRun` / gated `agentDebugWire` IPC; delete old debug IPC.
- [ ] Round derivation from `replayRunStream`; delete `agentDebugProjection` + the wire parser.
- [ ] `DebugTimeline` (DM = single-member Channel); agent attribution + filter; delegation nesting; gated raw payload.
- [ ] i18n + CSS; `docs/spec/agent-debug.md`.

## Sequencing & collision

PR 2 depends on PR 1. Collision self-check (open PRs + `docs/TASKS.md` + file
grep): no overlap with the three open PRs (`agent-context-architecture`,
`agent-permission-redesign`, `conversational-agent-authoring`); the
`agentDebug*` and panel files are unclaimed. PR 1 touches the protocol-adjacent
`agentEventLog.ts` event union and the conversation-replay path — coordinate as
a shared-interface-first change before building PR 2 on top.
