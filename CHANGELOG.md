# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Added

- **Local file mentions in the agent composer** — the `@` mention menu now
  combines recent nodes, local files, folders, and live file-search results
  (Spotlight `mdfind` on macOS, `rg` fallback elsewhere); selected entries
  render as inline tokens with native icons, image thumbnails, and hover
  previews. The model-facing prompt preserves positional intent with
  `[[file:<ref>]]` markers while a hidden `<user-attachments>` table maps each
  `ref` to its local path, kind, MIME type, and size, so files, folders, inline
  text, and images share one resolution path. Folders are exposed to the agent
  via a symlink into the local root for `file_glob`. Trashed nodes are excluded
  from both outliner and agent `@` suggestions.
  ([#21](https://github.com/relixiaobo/lin-outliner/pull/21))
- **Eager-materialized trailing draft row** — the Tana-style blank line at the
  bottom of the outline is now a real draft row: typing the first committed
  character materializes an actual node in place (IME-seamless, no editor
  remount) via a client-proposed node id, and drops a fresh empty draft below.
  Create + the first text edits collapse into one undo step. Structural keys
  work on the draft (Enter / Tab indent-under-previous-sibling / Shift+Tab /
  Backspace), plus fixes for leading-inline-ref backspace and merging a row
  into a reference node (converts it to a leading inline reference). Main
  outliner only; `FieldValueOutliner` keeps its typed-control trailing input.
  ([#16](https://github.com/relixiaobo/lin-outliner/pull/16))
- **Agent composer with inline references** — replaced the agent composer
  textarea with a ProseMirror editor supporting slash commands, inline node
  references (rendered consistently across user / assistant / tool output and
  clickable, with Cmd/Ctrl-click opening a new tab), inline file references,
  and paste/drop + native-picker file attachments sent inline to the model.
  ([#15](https://github.com/relixiaobo/lin-outliner/pull/15))
- **Inline images and a local asset subsystem** — paste an image or pick one
  via `/image`; images render inline on a reusable, focusable block-node shell.
  A content-addressed asset store (MIME sniffing, intrinsic-dimension probe,
  path-traversal-safe ids) is served through the privileged `asset://` protocol.
  Each image has a hover toolbar (caption / fullscreen lightbox / open original);
  the caption is the node's description.
  ([#8](https://github.com/relixiaobo/lin-outliner/pull/8))
- **Remote image sources** — image nodes accept a remote `mediaUrl` (validated
  http/https) alongside local assets; pasting a lone image URL creates a remote
  image, while pasting a URL over a selection links the text instead.
  ([#10](https://github.com/relixiaobo/lin-outliner/pull/10))
- **Dedicated code block editor** — `codeBlock` nodes with Shiki syntax
  highlighting, a language picker, horizontal scroll, and cross-row selection.
  ([#2](https://github.com/relixiaobo/lin-outliner/pull/2))
- **`past_chats` agent recall tool** — recent / search / read access over prior
  agent conversations, backed by the event store; tool-call JSON is
  Shiki-highlighted in the UI and renders identically live versus reloaded.
  ([#1](https://github.com/relixiaobo/lin-outliner/pull/1),
  [#4](https://github.com/relixiaobo/lin-outliner/pull/4),
  [#7](https://github.com/relixiaobo/lin-outliner/pull/7))

### Changed

- **Tool output shows the model-visible payload** — the agent tool-call Output
  region now renders exactly the slimmed `content` the model received (a
  syntax-highlighted JSON envelope) instead of reconstructing the fuller
  `details` envelope. This makes "what you see" match "what the model got" and
  removes the prior live-vs-reload inconsistency (`details` is not persisted).
  ([#19](https://github.com/relixiaobo/lin-outliner/pull/19))
- **View toolbar redesign** — per-node Display / Group by / Sort by / Filter by
  moved from inline panels to anchored popovers that no longer shift the row
  list; progressive, field-type-aware filter editors (boolean / options / date /
  number / text); date-aware filter matching; humanized group labels and
  field-semantic sort directions; an active-state summary line; and removal of
  the non-functional "View as" switcher.
  ([#9](https://github.com/relixiaobo/lin-outliner/pull/9))
- **Structure-aware clipboard paste** — inline marks, fenced code into code
  blocks, rich-HTML routing, and single-line URL linking; later extracted into a
  shared `classifyMediaPaste` classifier used by both the inline editor and the
  trailing input (Phase 1 of the node-line editor unification).
  ([#5](https://github.com/relixiaobo/lin-outliner/pull/5),
  [#11](https://github.com/relixiaobo/lin-outliner/pull/11))

### Internal

- **Bounded local-file caches** — the local file search / icon / thumbnail
  caches now evict oldest-first via a shared bounded helper instead of clearing
  wholesale at 1000 entries. The wholesale clear could drop the `id -> path`
  mappings that prepare/preview rely on, making recently surfaced `@`-mention
  files unselectable mid-session. Follow-up to #21.
  ([#22](https://github.com/relixiaobo/lin-outliner/pull/22))
- **Subagent next-step guidance on the envelope** — the `Agent` / `AgentStatus`
  / `AgentSend` / `AgentStop` subagent tools now carry their next-step
  `instructions` via the envelope's top-level `instructions` field
  (`successEnvelope(tool, data, { instructions })`) instead of duplicating it on
  `data.instructions` in the model-visible projection. Follow-up to #17.
  ([#20](https://github.com/relixiaobo/lin-outliner/pull/20))
- **Slimmer model-visible tool output** — `web_search`, `web_fetch`,
  `file_glob`, `file_grep`, `bash`, `task_stop`, `operation_history`, and the
  `Agent`/`AgentStatus`/`AgentSend`/`AgentStop` subagent tools now project a
  trimmed view to the model via `agentToolResult(envelope, modelData)`, dropping
  echoed call arguments, constant provider metadata, and telemetry
  (`durationMs`, `byteLength`, `finalUrl`, the Loro cursor, etc.). The full data
  stays on the envelope (`details`); conditional fields (redirect `finalUrl`,
  non-200 `statusCode`, pagination) are emitted only when meaningful. Adds
  projection unit tests per tool.
  ([#17](https://github.com/relixiaobo/lin-outliner/pull/17))
- **Shared node-line view helpers** — extracted `nodeLineView.ts`
  (`caretAnchor`, `selectionTextOffsets`, and a unified inline-ref-aware
  `selectionForPlacement` / `applyCursorPlacement`) from `RichTextEditor` and
  `TrailingInput`, which both now delegate to it. Behavior-preserving (the
  trailing input's old `1 + offset` math reduces to the shared version for
  plain text, pinned by unit tests); Phase 2a of the node-line editor
  unification. ([#12](https://github.com/relixiaobo/lin-outliner/pull/12))
- **Node-line editor core build contract** — design doc
  (`docs/plans/node-line-editor-core-design.md`) pinning the Phase 2b
  approach: drop the monolithic `useNodeLineEditor` hook in favor of shared
  pure modules, and route trigger application through `resolveTargetId`.
  ([#13](https://github.com/relixiaobo/lin-outliner/pull/13))
- **Three-clone parallel-agent hub model** — `lin-outliner` (main: review /
  merge / integration) plus `lin-outliner-cc`, `lin-outliner-cc-2`, and
  `lin-outliner-codex` dev clones sharing one GitHub origin, integrating via PRs
  to `main`, with per-clone `userData` isolation (`dev:main` / `dev:cc` /
  `dev:cc-2` / `dev:codex`).
