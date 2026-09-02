# New Thread Shortcut

**Shape:** (a) ONE complete interaction feature in one PR.

## Goal

Make a new Agent Thread available from the ChatGPT-familiar `Command+Shift+O`
shortcut, teach that shortcut at the existing New Thread control, and remove the
always-visible Thread-header Trajectory button because Trajectory is a technical
inspection surface rather than an everyday command.

## Non-goals

- No Trajectory removal. Turn-level response actions, native message menus, and
  workspace Trajectory views remain available on demand.
- No custom shortcut editor or persisted key binding.
- No change to Thread creation, provider admission, or Agent protocol contracts.
- No `Command+N` alias; it remains available for conventional window/document
  semantics, and `Command+Shift+N` remains unclaimed.

## Design

### Requirements

- **FR-1:** `Command+Shift+O` creates and selects a root Thread through the same
  `ThreadDock.createThread` path as the visible New Thread control.
- **FR-2:** A successful shortcut invocation opens the Agent rail and restores
  composer focus through the existing explicit-creation behavior.
- **FR-3:** Creation remains single-flight and provider admission remains the
  authority. Repeated keydown while creation is pending does not create duplicate
  Threads, and an unavailable provider does not bypass the disabled state.
- **FR-4:** The New Thread icon in the Thread list exposes the derived `Shift+
  Command+O` hint on pointer hover and keyboard focus, and declares the equivalent
  `aria-keyshortcuts` value without changing its accessible command name.
- **FR-5:** The Thread header no longer renders a Thread-wide Trajectory button.
  Response-level Open Trajectory actions remain unchanged.

### Shortcut ownership

Add `global.new_thread` to the renderer shortcut registry with one
`mod + shift + O` binding. Matching and the visible macOS glyph string come from
that registry, so behavior and teaching copy cannot drift. `ThreadDock` owns the
listener because it also owns creation admission, pending state, list closure,
selection, and composer focus. The handler ignores prevented or repeated events,
uses the existing IME-safe registry matcher, and consumes a matching key only
when the command is admitted.

The dock receives one callback from the shell to open the Agent rail after a
successful creation. This keeps shell layout ownership in `App` and avoids a
second Thread-creation authority.

### Discoverability

The existing New Thread `IconButton` keeps `New Thread` as its accessible label.
Its tooltip title appends the registry-derived macOS hint, for example
`New Thread (\u21e7\u2318O)`, and its DOM node exposes
`aria-keyshortcuts="Meta+Shift+O"`. Disabled provider copy remains more important
than the shortcut hint and continues to replace the tooltip while creation is
unavailable.

## Verification

- Renderer tests prove registry matching and formatting for `global.new_thread`.
- ThreadDock tests prove `Command+Shift+O` creates exactly one Thread, ignores a
  repeated keydown, respects provider blocking, opens the rail only on success,
  and presents the shortcut in the New Thread control's tooltip/accessibility
  metadata.
- E2E proves the production surface creates and selects an untitled Thread with
  `Command+Shift+O`, and that the Thread header has no Thread-wide Trajectory
  button while response-level Open Trajectory remains available.
- Run `bun run typecheck`, relevant renderer/E2E tests, `bun run docs:check`, and
  `git diff --check`; visually verify the dock header and tooltip in light and
  dark mode.

## Acceptance Criteria

- **AC-1:** `Command+Shift+O` creates one selected root Thread and reveals its
  composer without creating duplicates from keyboard repeat.
- **AC-2:** The visible New Thread control teaches `\u21e7\u2318O` by hover/focus and
  exposes `Meta+Shift+O` to assistive technology while retaining `New Thread` as
  its command name.
- **AC-3:** The always-visible Thread-header Trajectory control is absent, while
  response-scoped Trajectory access and the Trajectory workspace remain intact.
- **AC-4:** Provider-disabled creation stays disabled and the shortcut does not
  bypass that condition.

## Open questions

None. The PM selected the shortcut and removal boundary before implementation.
