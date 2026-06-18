# Agent Progress

This document is the working checklist for Lin's local agent integration. Keep
it current whenever a meaningful agent milestone lands or a priority changes.

Last updated: 2026-06-18

## Current Direction

Lin uses pi-mono as the current TypeScript agent core. Local document tools,
file tools, bash, web access, validation, previews, approval policy/schema,
persistence, and undo stay inside Lin's TypeScript/Electron boundary.

The product is **single-agent**: one user-customizable agent, **Neva** (stable
`agentId` `built-in:tenon:assistant`, handle `assistant`), editable in
Settings → Agent through a stored overlay. There is no multi-agent roster, no
peers, and no `@`-routing. Conversations are the only conversation primitive —
single-agent, inline-streaming, members always `{user, Neva}`; there is no DM
vs. Channel split. Delegation (child runs / sub-agents for tasks) stays, but
sub-agents are task runtimes, not conversational peers.

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
  - immutable code-registered built-in skills, including the `/skillify`
    authoring workflow
  - automatic and slash skill loading from `.agents/skills`
  - path-conditional and dynamically discovered skills with gitignore guards
  - governed `.agents/skills/**` writes through normal file tools with
    validation, provenance, rollback metadata, and hot reload
  - embedded skill shell expansion through the shared permission layer
  - manual, automatic, and reactive compaction with prompt-too-large retry
  - stable tool-output slimming and recent file-context restore across compact
  - same-conversation `Agent`, `AgentStatus`, `AgentSend`, and `AgentStop`
  - fresh and fork child runs, each with its OWN run ledger (run unification;
    sidechain transcripts replay from the ledger) and background
    notifications
  - conversation task panel derived from the shared render task projection: it
    shows only child-run tasks with open-details/stop actions (Dream history
    moved to the Settings → Agent "Memory & activity" panel)
  - skill `execution: isolated` routed through the delegation runtime
  - provider overflow detection, response debug capture, stream option pass-through,
    and session resource cleanup via pi-ai
- [x] Agent memory foundation (one believer-keyed first-person pool):
  - a single believer-keyed memory pool on the shared append-only seq-log
    primitive (alongside the conversation/run logs); facts are stored
    subject-named in the **third person** and the pool is one undivided
    body of first-person knowledge — `originWorkspace` is provenance metadata,
    never a retrieval fence
  - single model-visible `recall` tool over the active durable memory entries,
    with optional nested evidence expansion through `MemoryEntry.sources`
  - bounded `<memory>` turn briefing injection: derived schema overview +
    activation-ranked fact selection rendered as a **flat `<memory>` bullet
    list** of verbatim third-person facts (no `<self>`/`<principal>` zones;
    storage scaffolding hidden; facts pass the shared secret-like redaction
    heuristic before injection)
  - Settings → Agent Memory pane for list/edit/forget
  - runtime-owned Dream write-back as a scheduled/manual reflective run: **one
    Dream** consolidates conversation evidence into the pool with a subject-aware
    consolidation prompt; the automatic path uses the shared `date` schedule
    primitive plus a minimum-volume gate, `/dream` forces a Dream over the
    conversation, raw evidence is read since the Dream watermark, and
    `dream.completed` records the processed range; Dream history is surfaced in
    the Settings → Agent "Memory & activity" panel; the foreground `dream` tool
    can request the same runtime-owned path without supplying memory facts
  - run-sourced memory sources bind evidence to stable run-ledger ids
    (`{seq, eventId}` + message ids, post-#184), and Dream tasks appear in the
    shared task projection
  - projected-state cache, idempotent explicit forget, two-strength access
    projection from `memory.accessed`, and high-churn log compaction
  - permission classification for read-only `agent.memory.recall` and
    trigger-only `agent.memory.dream`
  - prompt guidance that foreground memory writes are handled by the
    Settings → Agent UI and runtime-owned consolidation (Dream), not by a
    model-visible CRUD tool
- [x] Agent M1 self-maintenance and structured input:
  - `ask_user_question` tool with pending question persistence and renderer
    resolution
  - `runtime_status`, `config`, `doctor`, and `dream` tools with
    permission-gated config/Dream writes
  - mixed-resolution compaction source ranges for replay/render/runtime context
- [x] Single-agent collapse (one editable agent; conversations-only; one memory
  pool): the prior multi-agent Channel apparatus was removed and the model
  collapsed to a single user-customizable agent.
  - **One editable agent, Neva** — `built-in:tenon:assistant` (handle
    `assistant`), edited in Settings → Agent via a stored overlay; no
    multi-agent roster, peers, or `@`-routing
  - **Conversations are the only conversation primitive — no DM.**
    Conversations are single-agent and inline-streaming with members always
    `{user, Neva}`; one conversation list, no nav-lock, "General" as the default
    landing. Removed `canonicalDmAgentId`, the DM-vs-Channel branching, and the
    two-list / two-"+" UI
  - **Render projection collapsed** to one `runActive` flag (the old
    `dmRunActive`/`channelRunsActive` split is gone) with inline transcript
    streaming; the channel activity surface was removed
  - **Removed multi-agent apparatus:** channel-org tools
    (`channel_create`/`channel_update`/`channelOrg`), member roster +
    `@`-routing/typeahead/handoff, POV/independence + the POV inspector, the
    channel activity surface, channel permission gates, multi-agent channel-turn
    execution + parallel-channel runtime, ChannelConfigWindow configure
    plumbing, and the message-addressing protocol fields (`addressedTo`,
    `member.added`/`member.removed`)

## Next Milestone

Finish runtime polish on top of the event log and delegation foundation.

- [ ] Add richer non-text media payload lazy loading UI in debug/render details.
- [ ] Add performance instrumentation around replay, projection, IPC payload size,
  and long transcript rendering.
- [x] Permission policy wired end to end: default-allow decisions, hard redlines,
  user blocklist, built-in soft blocks with allow-once / always-allow / auto-block
  cards (child-run + skill-shell bubbling, pending-request queue), and joinable
  `tool.permission.*` plus `approval.*` events persisted to the log (PR #51,
  redesigned for default-allow blocklists in #277).
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
