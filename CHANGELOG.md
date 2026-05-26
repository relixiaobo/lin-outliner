# Changelog

All notable changes to Lin Outliner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries reference the pull request that introduced them.

## [Unreleased]

Tracks `main`; not yet tagged for release. `package.json` is at `0.1.0`.

### Added

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

- **Three-clone parallel-agent hub model** — `lin-outliner` (main: review /
  merge / integration) plus `lin-outliner-cc`, `lin-outliner-cc-2`, and
  `lin-outliner-codex` dev clones sharing one GitHub origin, integrating via PRs
  to `main`, with per-clone `userData` isolation (`dev:main` / `dev:cc` /
  `dev:cc-2` / `dev:codex`).
