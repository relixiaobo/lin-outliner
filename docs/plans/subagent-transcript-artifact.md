# Subagent Transcript Artifact — the Delegation Contract's account layer, zero new tools

Shape: **(a) ONE complete feature in one PR.** Line references are against
main at `7f9b38cb` (post-#451 decomposition); re-derive with `rg` at build
time (A11).

## Goal

Implement the account layer of the Delegation Contract
(`docs/spec/agent-subagent-threads.md`, Delegation Contract §2): the process
behind a delegated result, readable by the parent MODEL and by debugging
agents/humans, pulled on demand, reader-pays, independent of the child's
liveness or budget. Two ports over ONE faithful renderer, no new model tools:

1. **Terminal artifact**: at child terminal state the host materializes a
   bounded, self-contained transcript file; its path travels in the terminal
   outcome. The parent reads it with the EXISTING `file_read`/`file_grep`.
2. **Operator dump**: `bun run agent:dump <userDataDir> <threadId>` prints the
   same projection (full detail, any thread, any state) to stdout — forensics
   becomes a command instead of hand-written parsers.

## Non-goals

- No new model tools (tool-count vigilance: composition covers the need).
- No second truth: the artifact and dump are derived projections; canonical
  data stays in rollouts/payloads. Artifacts are disposable and rebuildable.
- No live-updating artifact for RUNNING children (steering/messages serve live
  interaction; the artifact is written once at terminal state, immutable).
- No raw rollout/JSONL exposure and no storage-format coupling of any reader.
- No renderer/UI changes (the human account surface already exists).
- No change to wait/steering/budget semantics.

## Current state (verified facts)

- Terminal outcomes are produced in
  `thread/SubagentCollaboration.ts:484` (`collaborationTerminalOutcome`),
  consumed by `wait_agent`/idle views (`:372`, `:475`); child terminal
  activities queue via `queueChildTurnActivity:524`.
- `collaborationTerminalOutcomeSchema` lives at `src/core/agent/tools.ts:327`
  and already carries `result`; `wait_agent`'s output schema embeds it
  (`:373`).
- Children share the parent's `cwd` (spawn copies it), so a file under the
  session's workdir is reachable by the existing file tools without any
  permission change.
- Faithful turn→text rendering exists NOWHERE reusable: compaction's
  `deterministicSummary` is LOSSY BY CONTRACT (one line per item — exempt, do
  not unify; document why in the module header), and Model Interactions copy
  lives renderer-side. This plan's renderer becomes the sole faithful
  authority (anti-parallel-copy clause).
- Bounded-content caps exist as `MAX_PERSISTED_*` exports
  (`runtime/PiTurnExecutor.ts:86-89`).
- Thread deletion cascades in `thread/ThreadCatalogOps.ts:512-521`
  (history/payloads per descendant) — the artifact join point.
- Turn/item read surface for the projection: `ThreadCore` canonical reads +
  `ToolPayloadStore` (`readContext`/`readTextReference`) — all main-process,
  no new persistence.

## Design

### 1. `thread/TranscriptRenderer.ts` — the single faithful renderer

`renderTranscript(turns, reader, options): string` — pure function over
canonical Turns plus a payload reader; produces self-contained readable text:
per Turn a header (ordinal, status, duration, usage), then items in canonical
order — user/steering inputs verbatim, assistant text, reasoning summaries,
tool calls as `name(args…) → bounded output`, evidence/compaction as one-line
markers. Every content field truncated via the `MAX_PERSISTED_*` caps with an
explicit `[truncated N bytes]` suffix. Options: `detail: 'brief' | 'full'`
(`full` adds item IDs, payload digests, and per-call usage for forensics; the
artifact uses `brief`, the dump defaults to `full`).

Module header carries the authority clause: this is the ONLY faithful
turn→text projection; future faithful-text needs route here; compaction's
`deterministicSummary` is exempt (lossy contract, different consumer) — do
not unify them.

### 2. Terminal artifact (SubagentCollaboration)

At the child-terminal point that already builds the outcome
(`collaborationTerminalOutcome`), materialize once per child:
`<child cwd>/subagent-transcripts/<taskPath-with-dashes>.md` (collision-free:
taskPath is session-unique). Write is best-effort under A12 (failure logs and
leaves `transcriptPath` null — an account-layer miss must never fail the
turn or the outcome delivery). `collaborationTerminalOutcomeSchema` gains
optional `transcriptPath: { type: ['string','null'] }`; the `wait_agent` and
skill-result descriptions gain one sentence ("verify details by reading
transcriptPath with file tools"). Isolated-Skill children use the same path
(uniform per the Delegation Contract); their result envelope already carries
threadId — append the path line there too.

Cleanup: `ThreadCatalogOps.deleteThread`'s descendant cascade removes the
child's artifact file. Re-runs after crash: materialization is idempotent
(overwrite by path).

### 3. Operator dump (`scripts/agent-dump.ts` + package.json script)

Stateless CLI: opens the given userData's stores read-only, loads the
thread's canonical turns (any thread, any state, including running — it
projects whatever is persisted so far), prints `renderTranscript(..., full)`
to stdout. No file output, no flags beyond `--brief`. `package.json` gains
`"agent:dump": "bun scripts/agent-dump.ts"` — package.json is an
infrastructure-ownership file: this PR is the coordinated change; note it in
the PR body scope line.

## Tripwires

- `rg "collaborationTool\(" src/main/agent/runtime/ToolRuntime.ts | wc -l`
  unchanged (six — no new tools).
- Renderer purity: `thread/TranscriptRenderer.ts` imports no stores directly
  (turns + reader injected); one faithful renderer —
  `rg -l "renderTranscript" src/` covers every call site reviewed at gate.
- Canonical surfaces untouched: `git diff origin/main -- src/core/` limited
  to the one schema field; rollout/payload codecs untouched.
- A12: artifact write failures cannot change turn/outcome status (test).

## Verification

`typecheck` / `test:core` / `test:renderer` / `docs:check`. New tests:
renderer golden test (fixture turns → expected text, truncation markers,
brief/full); terminal materialization (path in outcome, idempotent overwrite,
failure → null path + delivered outcome); deletion cascade removes the file;
isolated-skill parity. Real run: spawn a child, `wait_agent`, parent
`file_grep`s the transcript for a claim from the result; `bun run agent:dump`
against the same thread and a RUNNING thread; delete the thread and confirm
the artifact is gone.

## Spec updates (same PR)

`docs/spec/agent-subagent-threads.md` Delegation Contract §2: mark the
account layer shipped, name the renderer authority + compaction exemption +
artifact path/lifecycle. `docs/spec/agent-tool-design.md`: the two description
sentences.

## Open questions

None blocking. Deferred: surfacing `transcriptPath` in the task panel UI
(renderer polish; time/status language per the user-irrelevance boundary).

## Checklist

- [ ] TranscriptRenderer + golden tests (authority + exemption documented)
- [ ] Terminal artifact + schema field + cleanup cascade + A12 test
- [ ] agent:dump CLI + package.json script
- [ ] Spec updates; real-run evidence in PR body
