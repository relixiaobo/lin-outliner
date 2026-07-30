# Agent Tool Path Modifier-click

## Goal

Render local paths in Agent tool arguments and results like terminal text: keep
the original code typography and line geometry, allow ordinary text selection,
and activate a path only with the platform primary modifier. Cmd-click on macOS
and Ctrl-click elsewhere retain the established new-pane navigation semantics.

## Non-goals

- Do not change inline file references in messages, the composer, or the
  outliner.
- Do not change local-file preview authorization, trusted-root checks, or tool
  filesystem access.
- Do not change the tool argument/result data model or introduce a second tool
  presentation model.
- Do not make glob expressions navigable as concrete files.

## Shape

This plan is shape (a): one complete feature in one PR. The renderer interaction,
visual treatment, path-recognition correction, specification, and regression
coverage ship together.

## Collision Result

- `gh pr list` found no open PR claims.
- `docs/TASKS.md` contains no active item for tool-path modifier activation.
- The change is confined to Agent tool code rendering, its local styles and
  tests, and `docs/spec/agent-thread-rendering.md`; it does not touch an
  infrastructure-ownership file.
- This dev PR does not edit main-owned `docs/TASKS.md` or `CHANGELOG.md`.

## Design

### Terminal-style Rendering

Keep recognized path text byte-for-byte within the existing read-only code
surface. A tool path has no file icon, resting background, resting link colour,
or independent wrapping rule. It inherits the surrounding monospace code
metrics and `white-space: pre`, so narrow docks scroll horizontally rather than
wrapping a path differently from adjacent JSON or command text.

Path recognition remains a renderer-only enhancement. Glob expressions are not
concrete preview targets and remain ordinary code text even when they contain a
slash and file extension.

### Modifier-only Activation

Render a recognized concrete path as a dedicated tool-path anchor rather than
the shared prose `InlineFileReference`. Ordinary hover and click behave as code
text and preserve selection. While the platform primary modifier is held, hover
reveals the established link colour and underline; activating the path dispatches
the existing preview-open event with `newPane: true`.

Keyboard users can focus the path and press Enter to open it in the current pane.
The visible focus ring remains independent from pointer modifier activation.
No renderer interaction grants filesystem authority; main-process preview
resolution remains authoritative.

## Open Questions

None. The PM ratified the established global modifier meaning: Cmd/Ctrl-click
opens the target in a new pane.

## Verification

- Renderer tests cover absolute and working-directory-relative path recognition,
  glob exclusion, and unchanged source text.
- Agent E2E covers resting terminal styling, no wrapping/icon/background,
  ordinary-click no-op, Cmd-click new-pane dispatch, and keyboard activation.
- Visually verify the expanded tool disclosure in light and dark themes at a
  narrow Agent dock width.
- Run `bun run typecheck`, `bun run test:renderer`, the relevant Agent E2E scope,
  `bun run docs:check`, and `git diff --check`.
