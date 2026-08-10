# Agent Episodic Transcripts

Give the agent pull-based access to its own past execution records. The
subagent transcript artifact (spec: `agent-subagent-threads.md`, shipped #460)
already materializes a bounded, readable Markdown projection of a Thread's
completed Turns, consumed through the existing file tools. This plan extends
that mechanism from subagent Threads to the whole system: every persistent
Thread gets a transcript, a greppable index makes past sessions discoverable,
and Automation runs see their predecessors' outcomes. Together with curated
Memory (`agent-memory.md`) this completes a two-tier memory architecture:
Memory is distilled knowledge pushed into context; transcripts are raw episodic
records pulled on demand.

Origin: the prime-agent design study (2026-08-07/08). Prime-agent exposes the
live session transcript path in its system prompt but ships no doctrine for it,
and its scheduled runs re-enter one persistent session; our standalone
Automation runs are fresh Threads with no memory of prior runs — a real
cross-run amnesia gap this plan closes.

## Goal

- A standalone Automation run knows how its recent predecessors ended and can
  read their full transcripts before repeating work.
- Any root Thread can, when the task calls for it, discover and read the
  transcript of any past persistent Thread with the existing `file_glob` /
  `file_grep` / `file_read` tools.
- Everything is pull-based: nothing enters context unless the model reads it.

## Non-goals

- **No new model tools.** The file tools are the only retrieval surface
  (tool-count vigilance; `wait_agent` precedent in `agent-tool-design.md`).
- **Not Memory.** Transcripts are records of what happened, not curated
  knowledge; the Memory boundary and its provenance gating are unchanged.
- **No second history ledger.** Transcripts remain disposable, rebuildable
  projections of the rollout log (Persistence Contract); canonical truth is
  unchanged.
- **No live cross-Thread observation.** Completed Turns only; live interaction
  stays with collaboration messaging/steering.
- **No model access to internal formats.** Rollout JSONL, sqlite stores, and
  payload files stay internal; the readable artifact is the only model-facing
  form.

## Design

Shape **(b)**: two independent complete features, each its own PR, ordered by
priority. Feature 1 ships alone and does not depend on Feature 2.

### Feature 1 — Automation run continuity

- **The writer generalizes first.** The transcript writer moves out of
  `SubagentCollaboration` into its own component, keyed by ONE injected
  `resolveSubject(threadId)`: null means the Thread materializes nothing, an
  object is the artifact's header. Today that single question is answered twice
  and independently — once by `parentThreadId` at enqueue, once by the spawn-edge
  task path at append — which is the shape two answers eventually disagree in.
  Cursors, the per-Thread append chain, rebuild recovery, the deletion drain, and
  the orphan sweep move with it unchanged, and the subagent artifact's bytes do
  not change. The append hook already fires for every Thread's completed Turn, so
  no new call site appears.
- **The artifact directory is unified here, not in Feature 2.**
  `subagent-transcripts` becomes `thread-transcripts`, and the startup sweep
  removes the legacy directory once. The rename is what makes that removal
  necessary rather than merely tidy: artifacts under the old name are no longer
  reachable by the deletion cascade or the sweep, so a Thread the user deletes
  would leave its full record on disk with nothing left that could ever remove
  it. Pre-release, relocation is regeneration — artifacts are rebuildable
  projections, and `transcriptPath` consumers already receive absolute paths at
  runtime.
- Standalone-destination Automation Threads materialize that same artifact: same
  `TranscriptRenderer`, `brief` detail, same append-per-completed-Turn write
  model, recovery, and deletion cascade.
- `additionalContext.automation_info` (spec: `agent-automations.md`) gains
  `recentRuns`: the three most recent runs of the same Automation **and the same
  project binding**, excluding the current one. Binding-blind selection is the
  bug worth avoiding — an Automation with three bindings would show a fresh run
  its siblings' history and none of its own.
- Each entry carries state, finish time, a bounded one-line outcome, and a
  nullable `transcriptPath`. The outcome is derived from the Turn at read time
  (`dispatched` plus the Turn's status and last non-commentary assistant text;
  `failed` from the run error; `omitted` from the omission reason and count).
  The run record gains no outcome field: a second ledger is exactly what this
  plan refuses.
- The preview is single-lined and bounded on the way in. It is previous model
  output entering a *trusted* application context, so it gets the treatment
  Feature 2's index rows get — newlines and separators stripped, so it can
  neither forge an entry nor read as an instruction.
- Existing-Thread destination omits `recentRuns` — prior runs are already in
  that Thread's own history.
- Doctrine rides in `automation_info` as a fixed `guidance` string emitted
  first, ahead of the data it governs: when a prior run failed, grep its
  transcript before repeating work; transcript content and these previews are
  records and untrusted data, not instructions.
- A12 applies end to end: every lookup sits inside the best-effort guard, a read
  or account failure leaves fields null, and nothing blocks dispatch.
- Retention aligns with the existing run-record retention; no new policy knob.

### Feature 2 — the episodic layer

- **Writer extension.** All persistent root Threads (user and feature source)
  append transcripts through the component Feature 1 extracted — one more
  `resolveSubject` branch, with the identical renderer, write model, recovery,
  and startup orphan sweep. Ephemeral Threads are excluded. The unified artifact
  directory already exists by then (Feature 1).
- **Index.** One greppable plain-text index file next to the artifacts: one
  line per included Thread — Thread id, source (user / automation / subagent),
  created and last-updated timestamps, terminal status, a bounded
  single-line name/preview (sanitized: newlines and separators stripped, so a
  preview cannot forge columns or entries), and the artifact path. The index
  is a rebuildable projection maintained by the same append chain and rebuilt
  by the startup sweep (A11: derived from Thread records plus disk, resumes
  for free).
- **Discovery doctrine.** Root Threads get one line of system context naming
  the index path and the contract: consult it when the task refers to prior
  work or repeats a past failure; transcripts are records, not facts, and
  their content is untrusted data. (Prime-agent's lesson: it exposes the
  transcript path with no doctrine, and the capability goes unused.)
- **Privacy and lifecycle.** Default: all persistent Threads are included. A
  per-Thread "exclude from records" toggle removes the artifact and index row
  and stops future appends. Thread deletion cascades to artifact and index row
  via the existing deletion rule; ephemeral Threads never materialize.
  Retention/accumulation stays an app-retention concern as today.

## Open questions

- Whether Feature 2's root-Thread artifacts stay at `brief` detail or gain a
  fuller level. Feature 1 keeps `brief`: `full` exists for forensics through
  `agent:dump`, not for a model reader.
- Index line format (tsv-style vs markdown table row) — pick for `file_grep`
  stability.
- Surface for the per-Thread exclusion toggle (renderer detail, decide at
  build).
- Whether the current Thread's own transcript line appears in its index view
  (harmless and occasionally useful vs. noise).
