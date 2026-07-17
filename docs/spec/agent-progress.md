# Agent Progress

This document is the working checklist for Lin's local agent integration. Keep
it current whenever a meaningful agent milestone lands or a priority changes.

Last updated: 2026-07-16

## Current Direction

Lin uses pi-mono as the current TypeScript agent core. Local document tools,
file tools, bash, web access, validation, previews, capability boundary/schema,
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
  - `outline_undo_stack`
- [x] Lin Outline parser shared by create, edit, and search flows.
- [x] Agent node tool docs, return value docs, and command protocol updates.
- [x] Local agent tool roles wired into the agent runtime:
  - `file_read`
  - `file_glob`
  - `file_grep`
  - `file_edit`
  - `file_write`
  - `bash`
  - `bash_stop`
- [x] Local tool capability parity pass:
  - `file_read` image dimensions, runtime PDF text extraction via `pdftotext`,
    PDF page rendering via `pdftoppm`, provider-neutral PDF tool results, and
    notebook parsing
  - `file_read` rich-document Markdown ingestion through optional MarkItDown for
    `.docx`, `.pptx`, `.xlsx`, `.xls`, and `.epub`
  - local tool subprocesses use the app environment plus
    `LIN_AGENT_EXTRA_TOOL_PATH` and common macOS Homebrew/system binary paths, so
    GUI-launched app processes can still find optional conversion tools like
    Poppler; Tenon's ripgrep provider also appends bundled `rg` after those paths
    so Bash can discover it without shadowing an installed user/system `rg`;
    missing Poppler or MarkItDown errors tell the agent to use `bash`
    to detect available local tooling, install the dependency without assuming
    Homebrew, then retry the same file tool call
  - `file_glob` and `file_grep` return Run-workdir-relative paths
  - `file_grep` backed by Tenon's ripgrep provider with streamed paginated
    output modes
  - `file_edit` narrowed to exact non-empty replacements after a full read
    with compact local hunks
  - `bash` file-first bounded output capture and background task output files
- [x] Web read tools:
  - `web_search`
  - `web_fetch`
- [x] Per-turn hidden context reminders for current outliner context and
  visible user-view state.
- [x] Local file mentions in the agent composer:
  - `@` suggestions include recent nodes, local files, and folders
  - selected files/folders/images render as inline tokens in the shared
    `.inline-ref` mention language (node = plain text, file = leading
    monochrome icon + text) — the same rendering as the outliner; see
    [`design-system/surfaces.md`](./design-system/surfaces.md#references)
  - model-facing text preserves files/folders/images with
    `[[file:<label>^<path>]]`; pathless attachments are staged under the
    app-owned scratch root first
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
  - embedded skill shell expansion through the shared capability layer
  - manual, automatic, and reactive compaction with prompt-too-large retry
  - stable tool-output slimming and recent file-context restore across compact
  - internal same-conversation delegation executor retained for Agent Sessions
    and isolated skills; ordinary work management uses Issue and Agent Session
    tools, with no direct delegated-Run compatibility tool profile
  - child runs with full/brief/none context modes, verifier retry, and their OWN
    run ledger (run unification; sidechain transcripts replay from the ledger)
    plus background notifications for ordinary non-Session detached work
  - Issue-first Work view backed by `agent_issue_search` / `agent_issue_read`:
    it replaces the agent dock's chat body with root Issue / Recurring Issue smart
    filters and Issue detail; child Issues use hierarchical navigation, while
    Agent Session executions render inside Activity and Dream history stays in
    the Settings → Agent "Memory & activity" panel
  - origin-derived Issue trees route root completion/error to the visible
    conversation and child completion/cancellation/error to the direct parent
    Agent Session through a leased, retryable terminal-delivery outbox; a root
    delivery starts a new hidden-user-input conversation Run instead of appending
    raw Session output as an assistant message, projects one linked Issue status
    row, and lets the conversation Agent reply, use tools, wait, or finish silently
  - parent completion/cancellation/start and Session stop preserve unresolved
    child edges; delivery acknowledgement and parent finalization are atomic, and
    compaction carries exact pending child payloads across repeated summaries
  - Agent Session binding precedes the first Run ledger lifecycle event;
    Session-owned controller children bypass generic notifications and detached
    summaries, using only the Issue terminal-delivery outbox
  - live delegated execution frames retain their conversation runtime headlessly
    across close/reopen; cold-start recovery reconciles terminal Run ledgers into
    Session state before marking only residual executions stale
  - durable objective/criteria amendments fence old verification work, budget-only
    amendments preserve its verdict, and verification-required
    `completed + active` Sessions remain active
  - skill `execution: isolated` routed through the delegation runtime
  - provider overflow detection, response debug capture, stream option pass-through,
    and session resource cleanup via pi-ai
- [x] Agent memory foundation (timeline outline memory):
  - durable memory is ordinary timeline outline content: per-day `#d-memory`
    containers with generated daily headlines, `#d-episode` source episodes, and
    `#d-belief` durable beliefs, with optional `#d-question` unresolved tensions
    and `#d-guidance` future handling notes when useful
  - model memory is pull-only through `node_search` / `node_read`; the old
    resident `<memory>` briefing and model-visible `recall` tool are removed
  - read-only `past_chats` exposes visible prior conversation history and raw
    cited spans, and `chat-source` inline refs let memory nodes cite exact
    conversation/run seq ranges
  - write-time validation dereferences every `chat-source` marker before
    mutating nodes, so fabricated or stale raw-source coordinates fail loudly
  - runtime-owned Dream write-back is a private `memory-dream` skill run in the
    protected Dream channel with only `past_chats` and `node_*` memory tools;
    scheduled runs use the fixed runtime schedule and retry a due at most three
    times, while Settings can trigger a manual date-window run; both paths read
    date-clamped sources derived from Dream-channel completed windows when
    sources exist, while the Dream channel itself rejects ordinary chat messages,
    is forced out of Dream evidence, and contributes no prior active-path transcript
    to later Dream model context; the Dream channel retains the newest 512 run
    transcripts and prunes older run ledgers, anchors, terminal markers, and
    search entries; runs gather relevant prior memory/workspace context with `node_search` /
    `node_read`, apply the
    human-dream cycle and valuable-memory filter, and — when the filter leaves
    memory worth writing — update the source-date `#d-memory` container, write
    optional `#d-episode` / `#d-belief` / `#d-question` / `#d-guidance` nodes, and
    may delete obsolete nodes with `node_delete`; a run that finds nothing worth
    remembering writes nothing, and a clean run records a windowed
    `dream.finished` marker either way — but a run cut off mid-work by unresolved
    context overflow is flagged `incomplete` and, with zero writes, is retried
    instead of recording a completed window; manual
    consolidate-only runs can reconcile outline/prior Dream context without new
    chat spans
  - `/dream` and the foreground `dream` tool are removed; Dream history remains
    a runtime task/history projection plus the protected Dream channel
    transcript, not a model command surface
  - the action catalog keeps `past_chats` as read-only
    `agent.memory.recall`; no `agent.memory.dream` action remains
- [x] Agent M1 structured input and compaction:
  - `ask_user_question` tool with pending question persistence and renderer
    resolution
  - mixed-resolution compaction source ranges for replay/render/runtime context
  - (the `runtime_status` / `config` / `doctor` self-maintenance tools shipped in
    M1 were later removed as over-built; runtime settings are user-managed)
- [x] Single-agent collapse (one editable agent; conversations-only; timeline
  memory): the prior multi-agent Channel apparatus was removed and the model
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
    execution + parallel-channel runtime, the ChannelConfigWindow
    **member-management** plumbing (the window survives as a name-only
    create/rename dialog), and the message-addressing protocol fields (`addressedTo`,
    `member.added`/`member.removed`). The Channel container itself survives: every
    conversation is an id-namespaced single-agent channel, "General" is the default,
    and users create, rename, and delete ordinary channels from the one list
    (no agent-facing `channel_create` tool — UI action only).

## Next Milestone

Finish runtime polish on top of the event log and delegation foundation.

- [ ] Add richer non-text media payload lazy loading UI in debug/render details.
- [ ] Add performance instrumentation around replay, projection, IPC payload size,
  and long transcript rendering.
- [x] Full Access-only capability model wired end to end: typed file tools,
  foreground/background processes, Skill shell, converters, and delegated Runs
  execute under the host account; ambient user credentials are preserved while
  explicitly private injected values are removed; explicit command/action
  blocks and scoped Run tool catalogs remain; joinable
  `tool.capability.checked` / `tool.capability.resolved` events use
  `allow | unavailable`; and there is no agent process sandbox, folder
  acquisition/recovery transport, or concurrency isolation between Runs.
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
- [ ] Agent tool UX polish:
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
