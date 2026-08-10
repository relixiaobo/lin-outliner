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
  `subagent-transcripts` becomes `thread-transcripts`, and startup **moves** the
  legacy directory's artifacts under the new root before dropping the emptied
  directory. Reclaiming it is what makes the rename safe rather than merely tidy:
  artifacts under the old name are no longer reachable by the deletion cascade or
  the sweep, so a Thread the user deletes would leave its full record on disk with
  nothing left that could ever remove it. Moving rather than deleting is the other
  half — this is `userData` a released build wrote, and a completed Thread never
  appends again, so nothing would rebuild what a delete destroyed. Relocation runs
  before the sweep, which then reclaims exactly the ones whose Thread is gone.
  `transcriptPath` consumers receive absolute paths at runtime, so only a path
  already written into a past Turn's record still names the old location.
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
  preview cannot forge columns or entries), and the artifact path.
- **The index is derived and rewritten whole, not appended.** An index row is
  mutable — last-updated, status, and preview all change as a Thread lives — so
  it is not the append-only shape the artifact is, and it is ONE file written on
  behalf of every Thread while the artifact's chain is per-Thread. It is
  therefore held in memory as a projection of the Thread records and written
  through a single global serialized chain as one atomic whole-file rewrite
  (tmp+rename, so a reader sees old-or-new), with writes coalesced rather than
  queued. Startup rebuilds it from the catalog. A11 holds more completely than an
  incremental log would allow: there is no accumulated state that can be wrong,
  only a projection recomputed from records. A row costs roughly 200 bytes, so a
  thousand Threads is a 200 KB rewrite off the user's path.
- **Format is tab-separated**, with a leading comment naming the columns:
  `threadId`, `source`, `createdAt`, `updatedAt`, `status`, `name`,
  `transcriptPath`. A markdown table row pads and aligns, which makes column
  extraction by `file_grep` brittle; TSV with a fixed column order does not. The
  single-line sanitizer that Feature 1 introduced already strips tabs, so a name
  cannot forge a column.
- The current Thread's own row is included. It costs one line and answers "is
  this conversation being recorded" from the same file that answers everything
  else.
- **Discovery doctrine.** Root Threads get one line of system context naming
  the index path and the contract: consult it when the task refers to prior
  work or repeats a past failure; transcripts are records, not facts, and
  their content is untrusted data. (Prime-agent's lesson: it exposes the
  transcript path with no doctrine, and the capability goes unused.) It rides in
  the stable prompt as a capability block gated on the file tools — a Thread that
  cannot read a file has no use for a path — with the index path injected, since
  the composer otherwise knows nothing about `userData`.
- **Privacy and lifecycle.** Default: all persistent Threads are included. A
  per-Thread "exclude from records" toggle removes the artifact and index row
  and stops future appends. It is a persisted boolean on the Thread record — a
  sibling of `archived` — reached by a `thread/*` request and surfaced in the
  per-Thread action menu beside Rename and Delete, the menu that already governs
  a Thread's lifecycle. It is deliberately NOT an entry in the core action
  registry: that registry's objects are nodes and surfaces, and adding a Thread
  object kind to carry one toggle would be a protocol change in service of a
  menu item. Thread deletion cascades to artifact and index row
  via the existing deletion rule; ephemeral Threads never materialize.
  Retention/accumulation stays an app-retention concern as today.
- Artifacts stay at `brief` detail for every Thread kind. `full` exists for
  forensics through `agent:dump`, not for a model reader.

## Open questions

None outstanding. Feature 1 shipped as #511; Feature 2's four open questions were
settled above (index write model and format, `brief` detail, the toggle's home,
and the Thread's own row).
