# Thread Interaction Polish

**Shape:** (a) ONE complete Agent Thread interaction polish feature in one PR.

## Goal

Make a new Agent Thread available from the ChatGPT-familiar `Command+Shift+O`
shortcut, teach that shortcut at the existing New Thread control, and remove the
always-visible Thread-header Trajectory button because Trajectory is a technical
inspection surface rather than an everyday command. Keep short conversations
visually settled after send instead of manufacturing enough blank runway to pin
their newest user message to the top of the transcript. Restore Trajectory detail
reads when provider cache breakpoints contain their canonical JSON paths.

## Non-goals

- No Trajectory removal. Turn-level response actions, native message menus, and
  workspace Trajectory views remain available on demand.
- No custom shortcut editor or persisted key binding.
- No change to Thread creation, provider admission, or Agent protocol contracts.
- No `Command+N` alias; it remains available for conventional window/document
  semantics, and `Command+Shift+N` remains unclaimed.
- No change to long-conversation send anchoring, streaming follow, scroll
  restoration, disclosure anchoring, virtualization, or failed-send rollback.

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
  Command+O` hint in its native hover title and declares the equivalent
  `aria-keyshortcuts` value without changing its accessible command name.
- **FR-5:** The Thread header no longer renders a Thread-wide Trajectory button.
  Response-level Open Trajectory actions remain unchanged.
- **FR-6:** A send made while the real transcript fits within its viewport uses
  ordinary bottom-follow and creates no send-anchor spacer. A send made after the
  real transcript has overflowed retains the existing top anchor and temporary
  runway behavior.
- **FR-7:** The short-versus-overflowing decision is captured from pre-send real
  transcript geometry. Optimistic content, temporary disclosure runway, and a
  later-growing response cannot retroactively switch the mode.
- **FR-8:** Trajectory provider-call evidence decodes `cacheBreakpoints` as JSON
  path strings, matching the retained Turn diagnostics contract, rather than as
  SHA-256 digests.

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
`New Thread (⇧⌘O)`, and its DOM node exposes
`aria-keyshortcuts="Meta+Shift+O"`. Disabled provider copy remains more important
than the shortcut hint and continues to replace the tooltip while creation is
unavailable.

### Send placement

Extract the pre-send overflow decision into the existing `threadScrollFollow`
geometry module. A transcript needs a send anchor only when its real
`scrollHeight` exceeds its `clientHeight` beyond browser rounding tolerance.
When it does not, `ThreadView.submit` still renders the
optimistic row and engages ordinary follow, but does not register a pending send
anchor or mount `.thread-send-anchor-spacer`; the sent message therefore remains
in natural document flow. Overflowing conversations keep the existing pending
anchor, settlement, virtualization coverage, and failure restoration paths.

### Trajectory evidence decoding

Use the same `stringArray` decoder for provider-call cache breakpoints in both
canonical Turn diagnostics and projected Trajectory details. Request
fingerprints remain SHA-256 digests; cache breakpoints remain paths such as
`$.messages[0].content[0].cache_control`.

## Verification

- Renderer tests prove registry matching and formatting for `global.new_thread`.
- E2E proves `Command+Shift+O` creates exactly one Thread, respects provider
  blocking, opens the rail only on success, and presents the shortcut in the New
  Thread control's hover title and accessibility metadata. The listener's
  repeated-keydown guard remains explicit in `ThreadDock`.
- E2E proves the production surface creates and selects an untitled Thread with
  `Command+Shift+O`, and that the Thread header has no Thread-wide Trajectory
  button while response-level Open Trajectory remains available.
- Unit tests pin the pre-send overflow boundary. E2E proves a short transcript
  creates no send spacer and does not move its new message to the top, while the
  existing overflowing-transcript case still anchors at the top and follows its
  streamed response.
- A core projection/codec regression test proves a non-empty cache-breakpoint
  JSON path survives the Trajectory detail response decoder.
- Run `bun run typecheck`, relevant renderer/E2E tests, `bun run docs:check`, and
  `git diff --check`; visually verify the dock header and tooltip in light and
  dark mode.

## Acceptance Criteria

- **AC-1:** `Command+Shift+O` creates one selected root Thread and reveals its
  composer without creating duplicates from keyboard repeat.
- **AC-2:** The visible New Thread control teaches `⇧⌘O` in its hover title and
  exposes `Meta+Shift+O` to assistive technology while retaining `New Thread` as
  its command name.
- **AC-3:** The always-visible Thread-header Trajectory control is absent, while
  response-scoped Trajectory access and the Trajectory workspace remain intact.
- **AC-4:** Provider-disabled creation stays disabled and the shortcut does not
  bypass that condition.
- **AC-5:** Sending from a transcript shorter than one viewport produces no
  send-anchor spacer and no top alignment; its latest content follows naturally
  at the bottom.
- **AC-6:** Sending from an already overflowing transcript preserves the current
  top-anchor, temporary-runway, streaming-follow, and failed-send behavior.
- **AC-7:** Opening Trajectory detail for diagnostics with non-empty provider
  cache breakpoints succeeds and preserves each recorded JSON path.

## Open questions

None. The PM selected the shortcut, removal boundary, and combined PR scope
before implementation.
