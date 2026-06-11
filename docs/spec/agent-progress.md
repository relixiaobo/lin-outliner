# Agent Progress

This document is the working checklist for Lin's local agent integration. Keep
it current whenever a meaningful agent milestone lands or a priority changes.

Last updated: 2026-06-10

## Current Direction

Lin uses pi-mono as the current TypeScript agent core. Local document tools,
file tools, bash, web access, validation, previews, approval policy/schema,
persistence, and undo stay inside Lin's TypeScript/Electron boundary.

Agent persistence, debug, streaming, multimedia payloads, and transcript
rendering now follow `docs/spec/agent-event-log-rendering.md`: the durable
source of truth is the per-conversation event log plus referenced payloads, while
pi-mono messages, render rows, debug timelines, indexes, and checkpoints are
derived projections.

Do not add Rust runtime code for the product agent path.

Agent optimization should follow `docs/spec/agent-event-log-rendering.md`:
pi-mono stays the core, Lin records normalized events, React renders a coalesced
projection, and the debug panel reads derived views without owning runtime
truth.

## Completed

- [x] pi-mono runtime integration in Electron main.
- [x] Agent UI dock, composer, model/reasoning settings, API settings, message
  stream rendering, stop/steer/follow-up behavior, and debug panel.
- [x] Loro-native document core with projection, operation journal, rollback on
  failed transactions, grouped text patches, and serialized workspace state.
- [x] Outliner agent tools:
  - `node_search`
  - `node_read`
  - `node_create`
  - `node_edit`
  - `node_delete`
  - `operation_history`
- [x] Lin Outline parser shared by create, edit, and search flows.
- [x] Agent node tool docs, return value docs, and command protocol updates.
- [x] Local agent tool roles wired into the agent runtime:
  - `file_read`
  - `file_glob`
  - `file_grep`
  - `file_edit`
  - `file_write`
  - `bash`
  - `task_stop`
- [x] Local tool capability parity pass:
  - `file_read` image dimensions, PDF text extraction via `pdftotext`,
    PDF page rendering via `pdftoppm`, and notebook parsing
  - `file_glob` and `file_grep` return local-root-relative paths
  - `file_grep` backed by ripgrep with paginated output modes
  - `file_edit` narrowed to exact non-empty replacements after a full read
    with compact local hunks
  - `bash` background task output files with live status headers
- [x] Web read tools:
  - `web_search`
  - `web_fetch`
- [x] Per-turn hidden context reminders for current outliner context and
  visible user-view state.
- [x] Local file mentions in the agent composer:
  - `@` suggestions include recent nodes, local files, and folders
  - selected files/folders/images render as inline tokens in the shared
    `.inline-ref` mention language (node = plain text, file = leading
    monochrome icon + text) — the same rendering as the outliner; see the
    inline-reference rendering note in `design-system.md`
  - model-facing text preserves files/folders/images with
    `[[file:<label>^<path>]]`; pathless attachments are staged under the agent
    local file root first
  - image bytes remain available as inline image content blocks while the file
    marker gives tools a readable path
- [x] Lin-specific stable system prompt module for agent identity, tool
  boundaries, dynamic reminder handling, and safety posture.
- [x] Event-sourced agent runtime foundation:
  - target-oriented conversation/run/agent event-log family
  - scoped payload directory layout
  - replay reducer, branches, and active-path projection
  - event-derived pi-mono `Message[]`
  - compact render projection IPC instead of chat snapshots
  - source image payload refs with runtime image rehydration
  - provider debug payload refs with lazy raw JSON loading
  - debug history/totals derived from debug events, assistant completions, and
    debug payload refs
  - provider request debug payload capture awaited before the provider stream
    starts, plus provider response metadata capture before body consumption
  - debug projection restore regression coverage from event log plus payload refs
  - large tool output payload refs with stable model-visible preview references
  - lightweight derived conversation index for listing
  - on-demand full text loading and bounded rendering for large tool output
  - transcript row virtualization for long agent conversations
  - payload-aware assistant turn copy for persisted tool output
  - run-end checkpoint projection with target-offset tail replay and
    corrupt-checkpoint fallback
  - atomic checkpoint writes with best-effort retention of the latest three
    valid checkpoint files per conversation
  - checkpoint tail guards against stale replay state before writing checkpoints
  - derived conversation/search/user-message indexes with event-log rebuild
  - large-conversation regression coverage for checkpoint replay, indexes, render
    projection, and payload-bounded JSONL
- [x] Agent skills, compaction, and delegation (child runs):
  - immutable code-registered built-in skills, including slash-only `/skillify`
  - automatic and slash skill loading from `.agents/skills`
  - path-conditional and dynamically discovered skills with gitignore guards
  - governed `.agents/skills/**` writes through normal file tools with
    `agent.skill.write` permission, validation, rollback metadata, and hot reload
  - embedded skill shell expansion through the shared permission layer
  - manual, automatic, and reactive compaction with prompt-too-large retry
  - stable tool-output slimming and recent file-context restore across compact
  - same-conversation `Agent`, `AgentStatus`, `AgentSend`, and `AgentStop`
  - fresh and fork child runs, each with its OWN run ledger (run unification;
    sidechain transcripts replay from the ledger) and background
    notifications
  - task panel derived from the shared render task projection: child-run tasks keep
    open-details/stop actions, and agent-level Dream runs show as read-only
    reflective tasks with trigger, processed count, and memory-change count
  - skill `context: fork` routed through the delegation runtime
  - provider overflow detection, response debug capture, stream option pass-through,
    and session resource cleanup via pi-ai
- [x] Agent memory foundation:
  - per-principal memory pools keyed by `MemoryEntry.principal` (`principalKey =
    user:<userId> | agent:<agentId>`): every pool lives under
    `principals/<agent-<agentId> | user-<userId>>/memory/events.jsonl`
    (`agents/<agentId>/` keeps only `identity.json`), on the shared append-only
    seq-log primitive with conversation/run logs
  - single model-visible `recall` tool over active durable memory entries, reading
    the reader's own pool + every conversation co-member principal's pool, with
    optional nested evidence expansion through `MemoryEntry.sources` gated in the
    evidence service to the reader's own pool (cross-principal requests return a
    typed refusal and distilled facts only)
  - bounded `<memory>` turn briefing injection: derived schema overview +
    activation-ranked fact selection over the reader's own pool + every
    conversation co-member principal's pool, rendered into reader-relative
    `<self>` / `<principal>` zones as verbatim bullet lists (one phrasing rule:
    third-person-singular subject-elided storage, no subject prepending at render
    — [[agent-memory-realignment]] D-2; storage scaffolding hidden; foreign facts
    pass the shared secret-like redaction heuristic before injection)
  - runtime `memoryIsolation` modes: global and read-only-global (pause Dream
    writes); a pool is one undivided self-model — `originWorkspace` is provenance
    metadata, never a retrieval fence
  - Settings Memory pane for list/edit/forget
  - runtime-owned per-principal Dream write-back as a scheduled/manual reflective
    run: the **agent-Dream** consolidates an agent's run log into its pool, the
    **user-Dream** consolidates the user's member-conversations into the user pool,
    with subject-aware consolidation prompts; the automatic path uses the shared
    `date` schedule primitive plus a minimum-volume gate (firing one Dream per
    pool), `/dream` forces the user-Dream over the conversation, raw evidence is
    read since the Dream watermark, and `dream.completed` records the processed
    range; a Dream run is **principal-anchored** — anchored to the pool it
    maintains, with the executing main agent recorded separately — so each
    principal's reflective-run index lives beside its pool and the task panel
    joins run meta with completions locally per principal (rows are labelled with
    the pool they maintain); manual `/dream` projects a chat-stream Dream
    boundary, and the foreground `dream` tool can request the same runtime-owned
    path without supplying memory facts
  - fresh typed child agents use their own agent identity for the `<memory>` briefing,
    `recall`, and child-ledger Dream evidence; forks inherit the
    parent agent's memory owner and use the structural fork boundary (events past
    the child ledger's first `run.started`); run-sourced memory sources bind
    evidence to stable run-ledger ids (`{seq, eventId}` + message ids, post-#184),
    and owner-anchored Dream tasks appear in the shared task projection
  - projected-state cache, idempotent explicit forget, two-strength access
    projection from `memory.accessed`, and high-churn log compaction
  - permission classification for read-only `agent.memory.recall` and
    trigger-only `agent.memory.dream`
  - prompt guidance that foreground memory writes are handled by Settings/Profile
    UI and runtime-owned consolidation (Dream), not by a model-visible CRUD tool
- [x] Agent M1 self-maintenance and structured input:
  - canonical DM restore plus user-created single-agent Channels
  - `ask_user_question` tool with pending question persistence and renderer
    resolution
  - `runtime_status`, `config`, `doctor`, and `dream` tools with
    permission-gated config/Dream writes
  - mixed-resolution compaction source ranges for replay/render/runtime context
- [x] Agent M3-A multi-agent Channel (membership + routing + peer reply, #179;
  IM group-chat semantics PM-ratified 2026-06-10):
  - `member.added`/`member.removed` events applied on replay and folded into the
    conversation index (membership events only — ordinary event actors never
    resurrect a removed member); `addressedTo` persisted on user messages AND on
    handing-off assistant replies
  - Channel creation with a member set + goal seed; "add agent to DM" spawns a
    seeded Channel (the canonical DM never converts); coordinator and DM members
    are immovable; member removal blocked while a round is active;
    mention-token collisions rejected at create/add time
  - routing: explicit user `@`s all run, uncounted (independent answers — each
    run's context cuts at the message that addressed it,
    `cutChannelPathForRun`); no `@` routes to the coordinator (PM-ratified); an
    agent reply `@`-ing members hands off, routed from the persisted record,
    **unbounded** (user stop is the circuit breaker: kills the active run and
    discards unstarted routing with a thread trace); one addressee's failure
    never skips siblings
  - delivery: Channel replies are not streamed — typing indicator while the run
    is active (drill-in opens the run working-state panel), whole reply lands on
    completion; the thread renders utterances only; a user message sent during
    any active Channel run (round or non-round turn) queues (no steer in
    Channels) and is persisted when routed — non-round turns drain the queue on
    settle, quit flushes it unrouted — shown from the projection's
    `queuedMessages` meanwhile; DM behavior unchanged
  - each peer turn executes as the addressed agent (definition, model/effort,
    skills, memory line, `actor` stamp) and reads the thread through the
    transient per-POV flatten (own turns verbatim; other principals coalesced
    into identity-preambled user-role blocks; selected by transcript content,
    not the live roster); the persisted log stays reader-neutral
  - UI: composer `@` member typeahead, member strip + "+" member menu on the
    Channel header (add member incl. the DM-spawn path, remove member),
    conversation-list member display, speaker badges on non-coordinator
    assistant rows that survive member removal

## Next Milestone

Finish runtime polish on top of the event log and delegation foundation.

- [ ] Add richer non-text media payload lazy loading UI in debug/render details.
- [ ] Add performance instrumentation around replay, projection, IPC payload size,
  and long transcript rendering.
- [x] Permission approvals wired end to end: `allow | ask | deny` policy
  computed in TypeScript, `ask` suspends the tool call and requests user
  approval (composer card, child-run + skill-shell bubbling, pending-request
  queue), and joinable `tool.permission.*` plus `approval.*` events persisted to
  the log (PR #51, hardened after M1).
- [ ] Emit and render the remaining schema-reserved runtime events that are not
  active yet: persisted follow-ups, metrics, and explicit cancellation details.
- [ ] Refine checkpoint retention settings if real user conversations show unusual
  storage pressure.

## Following Milestones

- [ ] Agent context reminder expansion:
  - active panel and selected node context beyond today's default node
  - visible outline window
  - recent user edits
  - available local/document tool summary
- [ ] Prompt/context budget split:
  - keep stable behavior in `agentSystemPrompt.ts`
  - keep changing UI and document state in per-turn `<system-reminder>` blocks
  - keep exact argument rules in tool schemas and descriptions
- [ ] Agent approval UX polish:
  - compact tool cards
  - preview diffs for file edits and node edits
  - clear failure states without transient false failures
- [ ] Tool prompt budget review:
  - confirm every enabled tool is necessary for the current milestone
  - keep large schemas out of the prompt until the tool is enabled

## Maintenance Rules

- Update this file when a milestone is completed or reprioritized.
- Keep detailed API contracts in `docs/spec/agent-tool-design.md`.
- Keep event/debug/render projection architecture in
  `docs/spec/agent-event-log-rendering.md`.
- Keep runtime architecture details in `docs/spec/agent-pi-mono-implementation.md`.
- Keep event log, debug, and render projection architecture in
  `docs/spec/agent-event-log-rendering.md`.
- Keep implementation notes short here; this file is for status and next work,
  not full design.
