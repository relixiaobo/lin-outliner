# Agent Progress

This document is the working checklist for Lin's local agent integration. Keep
it current whenever a meaningful agent milestone lands or a priority changes.

Last updated: 2026-05-18

## Current Direction

Lin uses pi-mono as the current TypeScript agent core. Local document tools,
file tools, bash, web access, validation, previews, approval, persistence, and
undo stay inside Lin's TypeScript/Electron boundary.

Do not add Rust runtime code for the product agent path.

Agent optimization should follow `docs/spec/agent-event-log-rendering.md`:
pi-mono stays the core, Lin records normalized events, React renders a coalesced
projection, and the debug panel reads derived views without owning runtime
truth.

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

## Next Milestone

Finish approval and UI/debug polish for the local tools that now execute through
the TypeScript main-process tool gateway.

- [ ] Agent event log and render projection architecture groundwork.
- [ ] Frame-coalesced streaming updates for the agent transcript.
- [ ] Approval rendering for mutating local tools.
- [ ] Debug panel visibility for local tool inputs, outputs, status, and
  truncation.
- [ ] Dedicated diff preview UI for `file_edit` and `file_write`.
- [ ] Background task completion notifications surfaced in the message stream.
- [ ] Host permission and offline/private-mode checks for web tools.

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
- Keep runtime architecture details in `docs/spec/agent-pi-mono-implementation.md`.
- Keep event log, debug, and render projection architecture in
  `docs/spec/agent-event-log-rendering.md`.
- Keep implementation notes short here; this file is for status and next work,
  not full design.
