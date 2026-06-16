# Agent Debug, Run-Grounded — debug as a view over the run truth source

Rebuild the agent **debug surface** from scratch as a faithful, read-only
**view of the execution tree** — `conversation → runs → rounds →
request / response / tool-exchange` — sourced entirely from the run ledgers that
are already the system's truth, plus one gated transport sidecar (the exact
outbound wire bytes) the semantic ledger cannot reconstruct.

Designed greenfield (no debug-snapshot baggage), grounded on the **real** DM and
Channel implementation: the per-run `AgentRunMetaProjection`, the per-run event
ledger (`runs/<runId>/events.jsonl`), and the conversation run index.

**Shape: (a) ONE complete PR.** The run streams are **already** independent and
replayable today — verified on-disk: a `turn` run's `runs/<id>/events.jsonl` holds
its full `run.started … assistant_message.* … run.completed` stream and
`replayRunStream(runId)` replays it alone, exactly as a `delegation` run does. The
only difference is the *seq numbering* (turn runs carry conversation-global seq,
delegation runs carry run-private seq), and **the debug read model is agnostic to
it** — it walks one run's events in order. So the debug surface reads the current
streams directly; there is **no** event-storage refactor. The only new writes are
a small, additive capture (per-run `system`/`tools` snapshot + transport metadata
+ the already-existing gated wire). Everything else is deletion + a read model + a
UI rewrite — a net code removal.

**Why no seq-renumbering (considered and dropped).** An earlier framing made this
two PRs: a "finish run-unification" foundation (renumber turn runs to private seq,
assemble the transcript by splice) then the debug view. Code-grounding showed the
renumbering buys only seq-value *uniformity* — turn runs already replay alone — at
the cost of rewriting the most load-bearing invariant in the agent store: the
single conversation-global `seq` that the conversation index, search index,
checkpoint tail-match, dream evidence ranges, and unread/attention all use as a
monotonic *change cursor*. Per-stream seq removes that single value (a run can
advance without the backbone moving), forcing a conversation change-cursor rework
**and** a per-stream checkpoint reshape — none of which the debug surface needs.
No current consumer needs the uniformity; if one ever does, it is its own scoped
refactor, not bundled here where it only adds risk. See **Decisions**.

## Goal

A developer opens the debug panel on any conversation and sees, faithfully:

- **Every LLM call the system made**, as a complete `(request, response)` pair —
  one entry per provider round — including the main agent, every Channel peer
  agent, and every delegated child run.
- Organized by the conversation's own shape: **DM** is a single linear column of
  rounds; **Channel** is the same timeline attributed per executing agent. (DM is
  the degenerate single-member case of the Channel view — one rendering, not two.)
- With **real** numbers (token usage / cost / context size from the response,
  not a `bytes/4` estimate), **real** stop reasons, and — when wire capture is
  enabled — the **exact** outbound wire bytes per round.
- Live: as the active run appends events, the tree grows; the in-flight round
  shows its request before the response arrives.

## Non-goals

- **No event-storage refactor.** Seq numbering, `readEvents` merge, checkpoint
  format, and the search/dream/attention watermarks are untouched. This is a
  read model + additive capture + a UI rewrite.
- No migration / back-compat. Pre-release: a format change wipes
  `~/.lin-outliner-*` dev userData ([[agent-data-model]] cut-over discipline).
  Removing `debug.snapshot.created` is exactly such a change.
- Not a new chat-transcript UX — only the developer debug panel.
- Reflective / `dream` runs (anchored to a principal, not a conversation) are out
  of the conversation debug view (see Decisions).

## Background: the truth source today (code-grounded)

A conversation's LLM activity is already fully event-sourced. Verified against
real on-disk data (`~/.lin-outliner-main`):

- **`runs/<runId>/meta.json` = `AgentRunMetaProjection`** is the per-run truth:
  `agentId`, `kind` (`turn` / `delegation` / `reflective`), `status`,
  `anchor {type, conversationId, agentId}`, `trigger {type:'message', messageId}`
  (the conversation-timeline anchor), **real `usage` + `cost`**, `fingerprint`
  (`promptHash` / `modelConfig`), `parentRunId`, `latestSeq`, `createdAt`.
- **`runs/<runId>/events.jsonl`** is the run's ledger: `payload.created`
  (`role:'debug'`, sanitized outbound request bytes), `assistant_message.started`
  (`providerId` / `modelId` / `apiId`), `assistant_message.completed` (content +
  usage + stopReason), `tool_call.*`, `tool_result.created`, `tool.permission.*`,
  `run.started` / `run.completed`. **Every run has one** — turn runs included
  (observed turn run: `run.started … assistant_message.delta ×30 …
  assistant_message.completed … run.completed`).
- **`conversations/<id>/runs.json`** indexes the conversation's runs (`runIds`,
  `delegationRunIds`, `latestSeqByRunId`).
- **DM** = a single agent (`built-in:tenon:assistant`): one `turn` run per user
  message, an occasional `delegation` child run.
- **Channel** = multiple agents: `turn` runs carry differing `agentId`, each
  anchored to its addressing message via
  `run.started.addressedByMessageId` / `trigger.messageId`.

**Why the current debug panel shows nothing useful.** `agentDebugProjection`
re-pairs `debug.snapshot.created` (provider_payload) with
`assistant_message.completed` by global seq, then `agentDebug` re-parses the
provider wire JSON into message rows. This is a *parallel representation* of what
the ledger already holds. Every round also writes a second, content-free
`provider_response` snapshot (status/headers only), and `slice(-20)` then halves
the visible rounds. The data is all in the ledger; the snapshot layer is redundant
and noisy — and `replayRunStream(runId)` already gives the clean per-run truth the
snapshot layer reconstructs.

## Design — the debug surface as an execution-tree view

**The unit is the round** = one provider call = `(request, response)`. Above it:
`conversation → run (per agent) → round → request / response / tool-exchange` —
the literal shape of run-meta + run-ledger.

**Read model (main process).** New IPC reads replace
`agent_debug_snapshot` / `_history` / `_totals` / `_payload`:
- `agentDebugView(conversationId)` → the tree summary. Enumerate `runs.json.runIds`
  (exclude principal-anchored reflective runs; include `delegation`), read each
  `AgentRunMetaProjection`, and return per-run nodes (agent, kind, status,
  `trigger` / `addressedByMessageId`, `parentRunId` / `parentToolCallId`, model,
  **real usage**, `roundCount`) plus conversation shape (DM/Channel from id +
  `meta.members`) and totals (sum of run usage).
- `agentDebugRun(conversationId, runId)` → one run's rounds, derived lazily by
  `replayRunStream(runId)` (reusing the `childRunTranscript` cache-by-`latestSeq`
  pattern). Works for `turn` and `delegation` runs alike — the seq convention is
  irrelevant to a single-stream walk.

**Round derivation (from a run's replayed stream).** Walk the run's events in
order; each `assistant_message.started` opens a round (this boundary is *always*
present, independent of the gated wire capture), its `.completed` closes the
response, and the intervening `tool_call.*` / `tool_result.created` are that
round's tool exchanges. The round's **structured request** = the run's
`system` / `tools` (the once-per-run capture below — flag a per-round change by
hash) + the message window the model saw, reconstructed by replaying the run up to
that round; so a round renders the *new* context (preceding tool results / the
triggering message) + the response, not the whole growing history. The
**byte-exact wire** (`payload.created` `role:'debug'`) attaches to its round when
wire capture was on, else the raw disclosure is empty with an "enable wire capture"
hint. Transport metadata (`status` / `latency` / `request-id`) folds into the
round from the always-on capture.

| Debug concept | Real event / field |
|---|---|
| run node (agent / kind / status / usage / model) | `AgentRunMetaProjection` |
| round boundary | `assistant_message.started` (always present) |
| round request — structured (always) | per-run `system` / `tools` snapshot + message window from `replayRunStream` |
| round request — byte-exact (gated) | `payload.created` `role:'debug'` (sanitized), via `readPayload`, when wire capture on |
| round response — content / usage / stop | `assistant_message.completed` |
| round transport — status / latency / request-id | `onResponse` capture, folded into the round (always) |
| round model / provider / api | `assistant_message.started` + meta `fingerprint` |
| tool exchange | `tool_call.*` → `tool_result.created` |
| timeline anchor | `trigger.messageId` / `run.started.addressedByMessageId` |
| delegation nesting | `parentRunId` + `child_run.started.parentToolCallId` |
| agent attribution | per-run `meta.agentId` |

**Capture (the only new writes — additive, per-run stream).** The whole semantic
tree is *already* in the ledger; capture fills the two gaps the ledger lacks, both
written to the run's own stream (turn runs via the conversation append path's
split, child runs via the run-ledger writer — each unchanged, just one new event):
- **Per-run `system` / `tools` snapshot — always on, once per run, hash-deduped.**
  `createConfiguredAgent`'s `onPayload` (`src/main/agentRuntime.ts`) receives the
  outbound payload (system + tools + messages) for *every* agent (DM, Channel peer,
  delegation). The messages are already in the ledger; persist only `system` +
  `tools` once per run (skip if the hash is unchanged). Closes the observed gap
  where delegation ledgers carry no request context.
- **Transport metadata — always on, per round.** `onResponse` captures
  `status` / `latency` / `request-id`; fold it into the round (tiny).
- **Byte-exact wire — gated, default-off, capped.** Already exists as
  `payload.created` (`role:'debug'`); keep it behind the wire toggle, bounded
  retention (cap last-N rounds / by size). When off, nothing is written and the
  structured view is unaffected.

**One timeline for DM and Channel.** A single `DebugTimeline` renders both: runs
ordered by anchor; each run a group with an agent-attributed badge/color; rounds
within; delegation runs nested under their originating round + `parentToolCallId`;
parallel runs fanned out under a shared addressing message (faithful to Channel's
independent-answers concurrency); an agent filter for isolating one agent. DM is
this view with one member.

**Deletions (net code removal = the cleanliness signal).**
- `debug.snapshot.created` event type + `DebugSnapshotCreatedEvent`
  (`src/core/agentEventLog.ts`) and its replay-neutral handling; the
  `provider_response` and `runtime_state` snapshot sources.
- `src/main/agentDebugProjection.ts` (the seq-matching projection) — gone.
- `agentDebug`'s provider-wire parser (`extractPayload` / `extractMessages` /
  `extractContentBlockParts` / `extractOpenAiToolCall`, ~250 lines) — gone;
  response comes from the ledger's structured `AgentPersistedContent`, the raw
  payload is shown as bytes, not parsed.
- The double-snapshot capture (provider_payload + provider_response per round) →
  an always-on per-run snapshot + transport, plus the one gated byte-exact wire.

**Files.**
- `src/core/agentTypes.ts` — replace `AgentDebugSnapshot*` with execution-tree
  types (`AgentDebugConversation` / `AgentDebugRunSummary` / `AgentDebugRun` /
  `AgentDebugRound`); keep `AgentDebugUsage` / `AgentDebugTotals`.
- `src/core/agentEventLog.ts` — remove the debug-snapshot event variant; add the
  per-run `system`/`tools` snapshot event (small, additive).
- `src/main/agentDebug.ts` — rewrite as round derivation; delete the parser.
- `src/main/agentDebugProjection.ts` — delete.
- `src/main/agentRuntime.ts` — new debug IPC (`agentDebugView` / `agentDebugRun`
  / gated `agentDebugWire`); the additive `onPayload` snapshot + `onResponse`
  transport capture.
- `src/main/agentRunLedger.ts` — emit the per-run snapshot for child runs too.
- `src/renderer/api/client.ts` — new IPC methods.
- `src/renderer/ui/agent/AgentDebugPanel.tsx` — rewrite as `DebugTimeline`.
- `src/renderer/styles/agent-debug.css` — restyle.
- `src/core/i18n/messages/{en,zh-Hans}.ts` — new labels (also clears the
  OS-locale-timestamp debt noted in TASKS).
- `docs/spec/agent-debug.md` (new) + `docs/spec/README.md` map entry
  (index is main-owned — coordinate).

**Build order (within this one PR — A7 build-order, not separate releases).**
1. Additive capture (per-run `system`/`tools` snapshot + transport) — green,
   nothing reads it yet.
2. Read model + execution-tree types (`agentDebugView` / `agentDebugRun`) — green,
   alongside the old IPC.
3. `DebugTimeline` UI on the new IPC — green.
4. Delete the old (`debug.snapshot.created`, `agentDebugProjection`, the wire
   parser, the old IPC + types) once nothing references them — green.

**Guard.** The visible-transcript store round-trip guard
(`tests/core/agentRunUnificationGuard.test.ts`, DM / Channel / delegation) stays
green throughout — this PR must not perturb the conversation transcript. Plus a
round-derivation test: a fixture run stream → the expected rounds (boundaries,
tool exchanges, usage).

## Decisions (settled — folded into Design above)

- **No seq-renumbering / run-unification refactor.** Turn runs already replay
  alone; the debug read model is agnostic to the seq convention. Renumbering buys
  only cosmetic uniformity at the cost of rewriting the conversation change-cursor
  + checkpoint format — dropped. (The path-not-taken is preserved in git history;
  the foundation spike — a per-stream-tolerant replay + a lifted run-stream
  classifier — was reverted to keep the store at `main`.)
- **Capture is two-tier.** Structured request (per-run `system`/`tools` once +
  message window from replay) is always on, free, retroactive; the byte-exact
  wire payload is gated **default-off** and capped.
- **Transport metadata** (status / latency / request-id) is folded into the
  round, **always on** (tiny; latency profiling + provider escalation are worth
  it).
- **Reflective / `dream` runs** (principal-anchored) are **excluded** from the
  conversation view (attaching a multi-conversation memory run to one
  conversation is a category error). A principal-scoped debug surface is future
  work, not this plan.

## Open questions

- *(none open)* — the seq/checkpoint question is moot under the no-renumbering
  decision.

## Checklist

- [x] Visible-transcript store round-trip guard (DM / Channel / delegation),
  green against `main`.
- [ ] Additive capture: per-run `system`/`tools` snapshot (once, hash-deduped) in
  `onPayload`, emitted for turn AND child runs; transport metadata
  (status/latency/request-id) in `onResponse`.
- [ ] Execution-tree types (`AgentDebugConversation` / `AgentDebugRunSummary` /
  `AgentDebugRun` / `AgentDebugRound`).
- [ ] `agentDebugView` / `agentDebugRun` / gated `agentDebugWire` IPC; round
  derivation from `replayRunStream` (boundary = `assistant_message.started`;
  structured request from per-run snapshot + replayed window).
- [ ] `DebugTimeline` (DM = single-member Channel); agent attribution + filter;
  delegation nesting; always-on structured request + transport; gated raw-wire
  disclosure.
- [ ] Delete `debug.snapshot.created` + `DebugSnapshotCreatedEvent`,
  `agentDebugProjection.ts`, the wire parser, the old debug IPC + types.
- [ ] i18n + CSS; `docs/spec/agent-debug.md` + `docs/spec/README.md` map entry.

## Sequencing & collision

ONE PR. Collision self-check (open PRs + `docs/TASKS.md` + file grep): the
`agentDebug*`, `AgentDebugPanel`, and `agent-debug.css` files are unclaimed; open
PRs #251 (`conversational-agent-authoring`, docs only) and #261
(`codex-4/remember-agent-conversation`, `src/renderer/agent/runtime.ts`) do not
overlap. The change touches the protocol-adjacent `agentEventLog.ts` event union
(remove `debug.snapshot.created`, add the per-run snapshot event) and
`agentTypes.ts` debug types — additive-then-delete, coordinated as the diff is
small and self-contained. `docs/spec/README.md` map entry is main-owned —
coordinate at the gate.
