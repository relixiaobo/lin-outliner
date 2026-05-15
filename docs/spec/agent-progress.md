# Agent Progress

This document is the working checklist for Lin's local agent integration. Keep
it current whenever a meaningful agent milestone lands or a priority changes.

Last updated: 2026-05-15

## Current Direction

Lin uses pi-mono as the current TypeScript agent core. Local document tools,
file tools, bash, web access, validation, previews, approval, persistence, and
undo stay inside Lin's TypeScript/Electron boundary.

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

## Next Milestone

Implement local tools based on cc-2.1's tool roles, with Lin-specific TypeScript
execution and approval boundaries.

- [ ] `file_read`: bounded file reads with offset/limit and clear truncation.
- [ ] `file_glob`: workspace-rooted file discovery.
- [ ] `file_grep`: bounded content search with useful match context.
- [ ] `file_edit`: exact string replacement with uniqueness checks.
- [ ] `file_write`: create or full-file rewrite with approval.
- [ ] `bash`: command execution with timeout, output caps, cwd policy, and
  background task support.
- [ ] `task_stop`: stop background commands created by `bash`.
- [ ] Approval rendering for mutating local tools.
- [ ] Debug panel visibility for local tool inputs, outputs, status, and
  truncation.

## Following Milestones

- [ ] Web tools:
  - `web_search`
  - `web_fetch`
- [ ] Agent context reminders:
  - active panel and selected node context
  - visible outline window
  - recent user edits
  - available local/document tool summary
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
- Keep implementation notes short here; this file is for status and next work,
  not full design.
