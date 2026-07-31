# Subagent Transcript Artifact — the Delegation Contract's account layer, zero new tools

Shape: **(a) ONE complete feature in one PR.** Line references are against
main at `7f9b38cb` (post-#451 decomposition); re-derive with `rg` at build
time (A11).

> Revised 2026-07-30 after the #460 gate (8 findings, 6 CONFIRMED — five
> sharing one root cause: an eagerly rewritten derived file in the user's
> workspace). The revision adopts the storage pattern Claude Code and Codex
> converge on, verified on-disk: app-owned storage, append-only, result as
> return value, on-demand inspection — neither ever writes into the
> workspace. (Claude Code: `~/.claude/projects/<slug>/<session>/subagents/
> agent-<id>.jsonl`; Codex: `~/.codex/sessions/…/rollout-*.jsonl`.)

## Goal

Implement the account layer of the Delegation Contract
(`docs/spec/agent-subagent-threads.md`, Delegation Contract §2): the process
behind a delegated result, readable by the parent MODEL and by debugging
agents/humans, pulled on demand, reader-pays, independent of the child's
liveness or budget. Two ports over ONE faithful renderer, no new model tools:

1. **Transcript artifact**: an append-only file under **`userData`** (never
   the workspace), extended once per *completed* child turn; its absolute
   path travels in the terminal outcome. The parent reads it with the
   EXISTING `file_read`/`file_grep`.
2. **Operator dump**: `bun run agent:dump <userDataDir> <threadId>` prints the
   same projection (full detail, any thread, any state) to stdout — forensics
   becomes a command instead of hand-written parsers.

## Non-goals

- No new model tools (tool-count vigilance: composition covers the need —
  the capability layer already resolves absolute and `~/` paths,
  `agentCapabilities.ts:391`, so a `userData` path needs no permission
  change).
- No second truth: the artifact and dump are derived projections; canonical
  data stays in rollouts/payloads. Artifacts are disposable and rebuildable.
- No per-item live streaming: append granularity is the **completed turn**
  (immutable in the event-sourced store). A mid-run read simply sees the
  completed-turn prefix; steering/messages remain the live-interaction
  surface.
- No workspace writes of any kind — nothing under the child or parent `cwd`;
  git never sees a transcript (no gitignore, no workspace sweep, no
  secret-commit vector).
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
- The agent file tools are NOT sandboxed to the workspace: capability
  classification resolves absolute paths and expands `~/` / `$HOME/`
  (`agentCapabilities.ts:384-393`), gated by the permission policy, so the
  parent can read an absolute `userData` path with zero protocol change.
- Faithful turn→text rendering exists NOWHERE reusable: compaction's
  `deterministicSummary` is LOSSY BY CONTRACT (one line per item — exempt, do
  not unify; document why in the module header), and Model Interactions copy
  lives renderer-side. This plan's renderer becomes the sole faithful
  authority (anti-parallel-copy clause). Tool-image identity rendering
  already exists as `dynamicToolImageIdentity` (`ContextProjector.ts:1041`) —
  export and REUSE it, do not duplicate (a #460 finding).
- Bounded-content caps exist as `MAX_PERSISTED_*` exports
  (`runtime/PiTurnExecutor.ts:86-89`).
- Thread deletion cascades in `thread/ThreadCatalogOps.ts:512-521`
  (history/payloads per descendant) — the artifact join point. Deletion also
  *wakes the parent's parked `wait_agent`* via the stop cascade — the race a
  #460 finding confirmed; see Design §2.
- Turn/item read surface for the projection: `ThreadCore` canonical reads +
  `ToolPayloadStore` — all main-process, no new persistence. The injected
  reader interface carries ONLY what rendering uses (a #460 finding: don't
  require members no call site calls).

## Design

### 1. `thread/TranscriptRenderer.ts` — the single faithful renderer

`renderTurn(turn, reader, options): string` — pure async function over ONE
canonical Turn plus a payload reader (whole-transcript rendering is
`renderTranscript(turns, …)` composing `renderTurn`; the incremental artifact
path appends per turn and never re-renders history). Output per Turn: a
header (ordinal, status, duration, usage), then items in canonical order —
user/steering inputs verbatim, assistant text, reasoning summaries, tool
calls as `name(args…) → bounded output`, evidence/compaction as one-line
markers. Every content field truncated via the `MAX_PERSISTED_*` caps with an
explicit `[truncated N bytes]` suffix. Payload reads are async and bounded to
the single turn being rendered. Options: `detail: 'brief' | 'full'` (`full`
adds item IDs, payload digests, and per-call usage for forensics; the
artifact uses `brief`, the dump defaults to `full`).

Module header carries the authority clause: this is the ONLY faithful
turn→text projection; future faithful-text needs route here; compaction's
`deterministicSummary` is exempt (lossy contract, different consumer) — do
not unify them.

### 2. Append-only artifact in userData (SubagentCollaboration)

**Location**: `<userData>/subagent-transcripts/<threadId>.md`. The filename
is the threadId — globally unique and derivable from the thread record alone,
so cleanup and tooling can always reconstruct the path. The file opens with a
header block (taskPath, nickname/role, spawn parentage) for human/grep
orientation.

**Write model — append-only, driven by turn completion.** At the child's
turn-completion point (where the completed Turn is already in hand),
`renderTurn` that one turn and `appendFile` it. Completed turns are immutable,
so the append cursor (last appended turn) is monotonic: staleness and
truncate-rewrite atomicity — two #460 findings — cannot exist by
construction. A concurrent `file_read` during an append sees a valid
completed-turn prefix, never a torn file. Nothing renders on the parent's
`wait_agent` path (a #460 finding: 2-3 full history paginations plus
sequential synchronous sha256 reads froze the main thread inside
`wait_agent`); `wait_agent` stays result-first and merely carries the path.

**Recovery**: the in-session cursor tracks the last appended turn; when the
cursor is unknown (process restart mid-child) or disagrees with the file,
rebuild the whole file once via the existing `atomicWriteFile`
(`jsonFileStore.ts:49`, tmp+rename — readers see old-or-new, never partial)
and resume appending. The artifact stays disposable and rebuildable.

**Contract surface**: `collaborationTerminalOutcomeSchema` gains optional
`transcriptPath: { type: ['string','null'] }` carrying the absolute path; the
`wait_agent` and skill-result descriptions gain one sentence ("verify details
by reading transcriptPath with file tools"). Isolated-Skill children use the
same location and model (uniform per the Delegation Contract); their result
envelope already carries threadId — append the path line there too.

**A12 — end to end**: EVERY read the account performs (spawn-edge lookup,
turn reads, payload reads) sits inside the best-effort guard, not just the
write (a #460 finding: reads outside the try/catch could throw and discard
the delegator's already-assembled result). An account failure logs, leaves
`transcriptPath` null, and never fails the turn, the outcome delivery, or the
skill result.

**Lifecycle**: `ThreadCatalogOps.deleteThread`'s descendant cascade removes
`<userData>/subagent-transcripts/<threadId>.md` (path derived from the id,
per above). Two guards close the confirmed deletion race (deletion wakes the
parked parent `wait_agent`, whose materialization could recreate the file
after the rm): materialization consults `core.stoppingThreads` and skips
silently when the thread is stopping/deleting, AND the cascade removes the
file after coordination-state teardown. Orphan sweep at startup: delete any
transcript whose threadId has no thread record (A11: the work queue is
derived from disk, and accumulation in app storage is an app-retention
concern — git is never involved).

### 3. Operator dump (`scripts/agent-dump.ts` + package.json script)

Stateless CLI: opens the given userData's stores read-only, loads the
thread's canonical turns (any thread, any state, including running — it
projects whatever is persisted so far), prints the full-detail rendering to
stdout. No file output, no flags beyond `--brief`. A top-level try/catch
around `main()` routes ALL failures — including invalid thread ids and
corrupt/torn rollouts, the CLI's primary forensic inputs — through the
USAGE/exit-2 path instead of an unhandled-rejection stack trace (a #460
finding). `package.json` gains `"agent:dump": "bun scripts/agent-dump.ts"` —
package.json is an infrastructure-ownership file: this PR is the coordinated
change; note it in the PR body scope line. (The repo-wide `scripts/`
typecheck gap is tracked on the board as `scripts-typecheck-coverage`, not in
this PR.)

## Tripwires

- `rg "collaborationTool\(" src/main/agent/runtime/ToolRuntime.ts | wc -l`
  unchanged (six — no new tools).
- Renderer purity: `thread/TranscriptRenderer.ts` imports no stores directly
  (turns + reader injected); one faithful renderer —
  `rg -l "renderTranscript|renderTurn" src/` covers every call site reviewed
  at gate; `rg "imageOutputLines" src/` returns only the ContextProjector
  export and its call sites (no duplicate copy).
- No workspace writes: `rg "cwd" src/main/agent/thread/SubagentTranscriptArtifact.ts`
  empty; every artifact path derives from `userData`.
- No rendering on the wait path: `rg "renderTurn|renderTranscript"` inside
  `wait_agent`/`collaborationTerminalOutcome` empty — rendering call sites
  live on turn completion only.
- Canonical surfaces untouched: `git diff origin/main -- src/core/` limited
  to the one schema field; rollout/payload codecs untouched.
- A12: artifact read/write failures cannot change turn/outcome status (test).

## Verification

`typecheck` / `test:core` / `test:renderer` / `docs:check`. New tests:
renderer golden test (fixture turn → expected text, truncation markers,
brief/full); append-per-turn (turn 1 completes → file has turn 1; followup
turn 2 → appended, turn 1 bytes untouched; read between appends sees a valid
prefix); recovery rebuild (stale/unknown cursor → atomic rebuild matches
composed rendering); deletion race (delete while the parent is parked in
`wait_agent` → no file resurrection, `stoppingThreads` consulted); orphan
sweep; failure → null path + delivered outcome (A12, including a throwing
reader); isolated-skill parity. Real run: spawn a child, `wait_agent`, parent
`file_grep`s the userData transcript for a claim from the result; send a
`followup_task` and confirm the transcript grew by exactly the new turns;
`bun run agent:dump` against the same thread, a RUNNING thread, and a garbage
threadId (exit 2, no stack trace); delete the thread and confirm the file is
gone.

## Spec updates (same PR)

`docs/spec/agent-subagent-threads.md` Delegation Contract §2: describe the
account layer as current behavior — renderer authority + compaction
exemption, userData location, append-only-per-completed-turn model, lifecycle
(cascade + orphan sweep). Reference the real PR number at merge time (a #460
finding cited "#458", another agent's open PR — A8). `docs/spec/agent-tool-design.md`:
the two description sentences.

## Open questions

None blocking. Deferred: surfacing `transcriptPath` in the task panel UI
(renderer polish; time/status language per the user-irrelevance boundary);
retention policy beyond the orphan sweep (age/size caps) if real usage shows
accumulation worth bounding.

## Checklist

- [ ] TranscriptRenderer (`renderTurn` + composed `renderTranscript`) +
      golden tests (authority + exemption documented; image identity reused
      from ContextProjector)
- [ ] Append-only userData artifact + schema field + turn-completion driver +
      recovery rebuild + deletion race guards + orphan sweep + A12 tests
- [ ] agent:dump CLI (top-level error path) + package.json script
- [ ] Spec updates; real-run evidence in PR body
