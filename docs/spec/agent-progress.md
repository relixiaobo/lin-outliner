# Agent Progress

This document is the working checklist for Lin's local agent integration. Keep
it current whenever a meaningful agent milestone lands or a priority changes.

Last updated: 2026-05-19

## Current Direction

Lin uses pi-mono as the current TypeScript agent core. Local document tools,
file tools, bash, web access, validation, previews, approval, persistence, and
undo stay inside Lin's TypeScript/Electron boundary.

Agent persistence, debug, streaming, multimedia payloads, and transcript
rendering now follow `docs/spec/agent-event-log-rendering.md`: the durable
source of truth is the per-session event log plus referenced payloads, while
pi-mono messages, render rows, debug timelines, indexes, and checkpoints are
derived projections.

Do not add Rust runtime code for the product agent path.

## Completed

- [x] pi-mono runtime integration in Electron main.
- [x] Agent UI dock, composer, model/reasoning settings, API settings, message
  stream rendering, stop/follow-up behavior, and debug panel.
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
- [x] Local cc-style tool roles wired into the agent runtime:
  - `file_read`
  - `file_glob`
  - `file_grep`
  - `file_edit`
  - `file_write`
  - `bash`
  - `task_stop`
- [x] Local tool capability parity pass:
  - `file_read` image dimensions, cc-style PDF text extraction via `pdftotext`,
    PDF page rendering via `pdftoppm`, and notebook parsing
  - `file_glob` and `file_grep` return local-root-relative paths
  - `file_grep` backed by ripgrep with cc-style output modes
  - `file_edit` narrowed to exact non-empty replacements after a full read
    with compact local hunks
  - `bash` background task output files with live status headers
- [x] Web read tools:
  - `web_search`
  - `web_fetch`
- [x] Per-turn hidden context reminders for current outliner context and
  uploaded file metadata.
- [x] Lin-specific stable system prompt module for agent identity, tool
  boundaries, dynamic reminder handling, and safety posture.
- [x] Event-sourced agent runtime foundation:
  - per-session `events.jsonl`
  - payload directory layout
  - replay reducer, branches, and active-path projection
  - event-derived pi-mono `Message[]`
  - compact render projection IPC instead of chat snapshots
  - source image payload refs with runtime image rehydration
  - provider debug payload refs with lazy raw JSON loading
  - debug history/totals derived from debug events, assistant completions, and
    debug payload refs
  - provider debug payload capture awaited before the provider stream starts, so
    debug snapshots and assistant completions keep stable event order
  - debug projection restore regression coverage from event log plus payload refs
  - large tool output payload refs with stable model-visible preview references
  - lightweight derived session index for listing
  - on-demand full text loading and bounded rendering for large tool output
  - transcript row virtualization for long agent sessions
  - payload-aware assistant turn copy for persisted tool output
  - run-end checkpoint projection with tail replay and corrupt-checkpoint
    fallback
  - atomic checkpoint writes with best-effort retention of the latest three
    valid checkpoint files per session
  - checkpoint tail guards against stale replay state before writing byte offsets
  - derived session/search/user-message indexes with event-log rebuild
  - large-session regression coverage for checkpoint replay, indexes, render
    projection, and payload-bounded JSONL

## Next Milestone

Finish the performance and analysis projections on top of the event log.

- [ ] Add richer non-text media payload lazy loading UI in debug/render details.
- [ ] Add payload-aware full-session export for long sessions.

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
- Keep implementation notes short here; this file is for status and next work,
  not full design.
