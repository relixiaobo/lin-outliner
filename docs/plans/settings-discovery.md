# Settings Discovery With macOS Interaction Conventions

## Goal

People can find and change preferences in one familiar Settings window, without
opening another window for each category. This specializes Unit G of
[File-First Settings](settings-control-plane.md), preserving its source and
operation ownership. Apple's macOS interaction conventions and Tenon's
[design system](../spec/design-system.md) govern every changed surface.

The delivery shape is **one complete feature in one PR**. Settle shared domain
contracts before building their consumers, within the same coordinated delivery.

## Non-goals

New preferences, global translation defaults, Agent runtime/storage recovery,
configuration migrations, a new Settings CLI/tool, a framework rewrite, and
app-wide restyling. Existing credentials, confirmations, root Profiles, Skills,
contextual translation, and native menus retain their domain semantics.

## Design

### Decision And Evidence

The aggregate `AgentSettingsView` owns unrelated loads, mutations, and failures;
`AgentProviderSettingsView` mixes models with delegation preferences. Split those
ownership seams. A shared navigation view must not restore aggregate domain state.

Use one Settings window with a left category list and right content. Category
navigation is presentation, not a security or service boundary.
The window uses the app's three-container composition: a floating left rail,
a separate toolbar above the right content viewport, and opaque content. Reuse
shared gaps, concentric corners, rail elevation, and chrome-only materials. Native
traffic lights sit over the rail's top spacer. About retains its normal App-menu
window; credentials remain an owned modal child.

### Interaction Requirements

| Flow | Observable behavior |
| --- | --- |
| FR-1: Open and navigate | App menu **Settings…** and `Command+,` open/focus one **Tenon Settings** window. General, Models, Agents, Skills, Memory, Access, Data, Keyboard Shortcuts, and Advanced switch inside it. Untargeted reopening preserves selection, search, scroll, and focus. Explicit application destinations select the corresponding pane without a reload. Native minimize, zoom, and fullscreen are disabled; resizing and scrolling remain available. |
| FR-2: Find | A persistent trailing search field matches localized labels, descriptions, aliases, and stable IDs. `Command+F` focuses it. Results expose matching scalar controls and category destinations; category results navigate locally. Clearing search returns to the selected category. Search never loads catalogs for unvisited panes. |
| FR-3: Organize and edit | General contains appearance, language, and automatic updates. Models groups request policy under a collapsed Request Options disclosure. Agents owns delegation, with capacity limits under a collapsed advanced disclosure. Memory owns its enable switch and maintenance. Advanced contains diagnostics, configuration files, and a collapsed scalar inspector with All / Modified filtering. Choices commit immediately; numbers commit on Return/blur and Escape cancels an uncommitted edit. Keyboard Shortcuts uses compact command rows with a leading checkbox and trailing editable key combination; secondary actions live in menus, and IDs/badges stay out of ordinary rows. No window-wide Save/Apply footer. |
| FR-4: Reset and repair | Modified means an explicit source declaration, including an explicit default. Show a named Reset action only for modified rows; reset deletes only that declaration. Invalid sources disable their structural controls and retain an Open File repair action regardless of category or query. Show retained effective values separately from source acceptance and runtime application. |
| FR-5: Keep context | Mount a domain pane on first visit, then keep it mounted but hidden on navigation. Preserve drafts, errors, disclosure state, scroll, queues, and accepted operations. Only the visible pane enters the accessibility tree and focus order. Each domain owns its subscriptions and progress. Credential input opens a modal child of Settings; navigation cannot switch its owner underneath it. An active in-app modal editor likewise takes precedence over a menu deep link. |
| FR-6: Keyboard and recovery | A vertical tablist uses roving focus with Up/Down/Home/End; Tab enters content. Source conflicts preserve the draft and require an explicit retry against the new observation. Escape first belongs to IME, editor, or frontmost menu/sheet, otherwise it clears a focused nonempty search. `Command+W` closes the active native window. Child dismissal restores the invoking control. Shortcut recording ends on blur or category change and only captures its focused field. No unrelated domain becomes busy. |

About and Help keep their App/Help menu homes. Preview translation remains
contextual. Public source observations may supply bounded errors/modified state;
settings navigation never depends on live counts, badges, credentials, or probes.

### Consistent Controls Across Panes

Audit General, Models, Agents, Skills, Memory, Access, Data, Shortcuts, and Advanced
as one system. Category headers should not repeat a single row label. Text/image
model defaults share one group; popup menus size to the selected value with a
bounded long-label fallback and consistent trailing alignment. List membership
uses leading checkboxes outside selectable row buttons. Feature-level enablement
may retain a compact switch. Use one restrained inset/type hierarchy across domain
and scalar rows; hide ordinary technical IDs/badges and internal tool names where
they do not help a person make a choice. Keep errors and meaningful source/status
information visible. Check every pane in English/Chinese, light/dark, and large
text, and verify focus, popup behavior, and retained operations on the real app.

### Ownership And Failure Boundaries

- Share scalar descriptors/defaults/validation with configuration decoding and
  schema generation. Read bounded public-file observations, not an aggregate
  runtime snapshot. Each supported field has a control or owning editor/source.
- Use the JSONC structural writer with observed digests, per-source serialization,
  replacement rechecks, and post-apply observation. Preserve comments and unrelated
  declarations. No second desired-value store or renderer access to private files.
- Models, root configuration/delegation, Skills, and Access retain independent
  projections, events, errors, and queues. Composer, Thread store, provider forms,
  and external-file refresh consumers use their owner-specific subscriptions.
- Native Settings has a finite configuration-operation allowlist. Main-frame and
  actual window identity gate admission; changing a renderer URL or category does
  not grant authority. Document mutations, turn execution, unknown commands, and
  credentials are excluded. Credentials belong only to the provider child; About
  has only its application/update channels. Do not invent tab-level IPC isolation.
- Retire aggregate notifications/DTO fields, category-owned polling/counts/badges,
  old category/page routes, and misleading domain component names. Keeping a
  category navigation view does not restore the retired lifecycle coupling.

### Acceptance Criteria

- **AC-1 (FR-1, FR-2):** General opens without domain catalog requests. All category
  and application destinations reuse the same native Settings window and renderer.
- **AC-2 (FR-2 through FR-4):** Search/reset/source repair work for explicit
  defaults, invalid input, stale writes, deletion, and restart. UI/manual/Agent
  edits agree on source digests and effective values.
- **AC-3 (FR-3, FR-5):** Model bootstrap and credential sheets, root editing,
  Skills, confirmed Memory/Data actions, and shortcut recording remain reachable.
  Navigation preserves an invalid draft and in-flight operation settlement.
- **AC-4 (FR-6):** Keyboard navigation, focus visibility/restoration, and accessible
  names/states/errors work. Hidden panes are excluded from sequential focus and
  accessibility output. Check the native accessibility tree; do not claim a spoken
  VoiceOver pass from automated tree inspection alone.
- **AC-5 (FR-1, FR-3):** At 680px and 900px Settings widths, 200% text, and long
  English/Chinese copy, controls remain readable/reachable without horizontal
  clipping or hover reflow. Verify actual Electron light/dark, Increase Contrast,
  Reduce Motion, and Reduce Transparency. About retains a 560px minimum.
- **AC-6:** Artifact-derived checks find no retired route/event/DTO/lifecycle or
  manager-window map. Run typecheck, relevant Core/renderer/E2E/native smoke,
  docs/diff checks, and visual inspection without relaxing guards.

Apple references: [Settings](https://developer.apple.com/design/human-interface-guidelines/settings),
[Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields),
[Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles),
[Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons),
and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).
These guide semantics; the category layout is Tenon's decision. Keep neutral
functional states, tokenized geometry, system type, opaque content, native
scrollbars, and the existing `--control-on` switch exception.

### Delivery, Files, Risks, And Collision Check

Build order within one PR: split domain contracts and consumers, then complete
single-window discovery/navigation and source-aware controls, retire old ownership,
and update specifications and regression evidence together. The coordinated
`src/core/types.ts` provider/runtime split remains within this one delivery.

Scope: `src/core/settingsWindow.ts`, scalar/delegation definitions, configuration
and window hosts, preload, renderer APIs/domain components, Settings styles,
English/Chinese messages, notification consumers, and corresponding tests/specs.
No dependencies/build configuration, document commands, board, or changelog edits.

Risks: stale notification consumers, accidentally broad IPC admission, loss of
in-flight work on navigation, and eager catalog loading behind a shared shell.
Tests target these boundaries directly. PR #655 shares only the existing
`docs/spec/agent-model-runtime.md` scope, in distinct ownership paragraphs; its
execution-contract/ThreadService implementation is outside this change. It has
merged, and the current open-claim check finds no other PR. Recheck remote file
scopes before publishing any newly shared contract edit.

## Open questions

The PM selected one complete PR and single-window category navigation. No unresolved
product question blocks implementation. Private helpers and bounded window
geometry are reversible local choices.
