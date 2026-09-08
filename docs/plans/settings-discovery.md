# Settings Discovery With macOS Interaction Conventions

## Goal

People can find a preference, change it, or open its domain manager from a
lightweight Settings window. This specializes Unit G of
[File-First Settings](settings-control-plane.md), preserving its capability and
source-ownership contracts. The target is the existing Electron application;
Apple's macOS interaction conventions and Tenon's
[design system](../spec/design-system.md) govern every changed surface.

The delivery shape is **one complete feature in one PR**. Settle shared domain
contracts first, then build the discovery consumers and retire the category
shell within that same PR. The shared-type and consumer cutover is coordinated
as one delivery, as explicitly directed by the PM.

## Non-goals

New preferences, global translation defaults, Agent runtime or storage recovery,
a new Settings CLI/tool, configuration migrations, a framework rewrite, and
app-wide restyling are outside this work. Existing credentials, confirmations,
root Profiles, Skill lifecycle, contextual translation, and native menus retain
their domain semantics.

## Design

### Overview, Decision, Constraints, And Evidence

`AgentSettingsView` eagerly queries Providers, capabilities, and Skills, owns
their mutation/error state, and subscribes to broad Settings changes.
`AgentProviderSettingsView` combines model information with runtime/delegation
preferences. These concrete ownership seams must be settled before the discovery consumers.
`SettingsOpenTarget` still requires categories and secondary pages; several
Settings-surface paragraphs also describe retired Roles. Replace those premises
when the corresponding code changes, without restoring retired features.

The selected target is one flat Settings window plus independently opened domain
managers. Short labeled groups organize reading, not another category hierarchy.
Reuse existing domain editors and form primitives after checking their actual
keyboard, focus, and visual behavior; existing code is not evidence of compliance.

### Interaction Requirements And Flows

| Flow | Observable behavior |
| --- | --- |
| FR-1: Open | App menu **Settings…** and `Command+,` open/focus one **Tenon Settings** window. Keep real traffic lights; disable minimize, zoom, and fullscreen. Retain bounded resizing and vertical scrolling for larger text. An already open window preserves query, scroll, and focus unless an explicit target is supplied. |
| FR-2: Find | A persistent trailing toolbar search field has a search symbol, clear control, and localized search prompt. `Command+F` focuses it. Search labels, descriptions, aliases, and stable IDs locally; keep internal IDs out of ordinary row labels. Put an **All / Modified** filter in the content area. Clearing the query restores the current filter. No-results feedback offers Clear Search/Show All as applicable. |
| FR-3: Edit | Common scalar preferences use labeled controls in aligned inset rows. Use a pop-up button for a mutually exclusive list, a segmented control for a small peer choice such as appearance, a checkbox for subordinate options, and compact switches for emphasized on/off settings. Keep native select menus and text editing. Choices commit immediately; text/number edits validate on Return or blur, with Escape restoring the uncommitted field value. No window-wide Save/Apply footer. |
| FR-4: Reset | Modified means an explicit source override, including an explicit default. A named per-row **Reset** removes only that override. Keep its action slot stable and keyboard-reachable. Invalid sources cannot be structurally edited; their error and Open File action stay visible under every search/filter. Use the last accepted state as explicitly retained data, not evidence that invalid saved input applied. |
| FR-5: Open a manager | Named commands open/focus the relevant Models, Agents, Skills, Memory, Access, Data, or Keyboard Shortcuts window directly, without a category/back stack. Reuse at most one window per domain. Load only that domain; model setup remains reachable without an Agent. Credential editing stays a modal child of its owning manager. Closing a manager does not discard accepted writes or cancel domain work implicitly. |
| FR-6: Recover and return | Pending/error feedback belongs to the affected row or operation. Preserve entered text on validation/write failure; a stale source requires refresh/retry against the new observation. No unrelated pane becomes busy. Escape first belongs to IME, an active editor, or the frontmost menu/sheet; otherwise it clears a focused nonempty search. `Command+W` closes the active window. Restore focus to the invoking control when its child closes. |

Contextual application entry points open the same domain destinations. About
stays in the App menu and Help in the Help menu; diagnostics are reachable there
and by discovery. Preview translation stays in its preview. Search metadata may
advertise structured fields and their exact editor/source destination without
loading live catalogs, credentials, counts, badges, or background probes.

### Ownership, Failure, And Implementation Boundaries

- Derive scalar descriptors, defaults, validation, search metadata, and source
  paths from the owning configuration definitions. Each supported field gets a
  direct control or an exact domain-editor/source destination. Modified/search
  inspection reads bounded public source observations, never a composite runtime
  Settings snapshot. Each source supplies its own accepted/effective/error state.
- Use the existing JSONC structural writer with the caller's observed digest,
  per-source serialization, pre-replacement recheck, and post-apply observation.
  Reset must preserve comments and unrelated overrides. Do not add a second
  desired-value store or expose private configuration files to renderers.
- Give Models, root configuration/delegation, Skills, Access, and other owners
  separate projections/subscriptions. Update Composer, Thread store, provider
  forms, and external-file refresh consumers together. Replace blanket
  `assertSettingsSender` admission with exact window/operation capabilities;
  broadening every auxiliary window to all operations is not a valid shortcut.
- Keep errors, generation fencing, queues, and progress with their owner across
  mounts. Retire aggregate Settings notifications, polling/count/badge coupling,
  composite DTO fields, old category routes, and misleading component names.
  Preserve credential-only sender checks and the existing preview/Agent boundary.

### Apple Design And Acceptance Criteria

The official references are [Settings](https://developer.apple.com/design/human-interface-guidelines/settings),
[Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields),
[Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles),
[Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons),
and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).
They guide control semantics and window behavior; flat discovery and independent
managers are Tenon decisions. Retain neutral functional states, tokenized geometry,
system typography, opaque content, chrome-only materials, and native scrollbars.
Do not imitate SwiftUI with screenshots, ornamental panels, or decorative motion.

- **AC-1:** When Settings opens, its controls and discovery list shall render
  without querying unrelated domain catalogs or blocking on their failures (FR-1, FR-5).
- **AC-2:** When searching, filtering, resetting, deep-linking, or repairing a
  source, the UI shall follow the flows above; UI/manual/Agent edits shall agree
  on the current source digest and effective result. Test explicit-default
  overrides, invalid sources, stale writes, deletion, and restart (FR-2 through FR-4, FR-6).
- **AC-3:** Every retained capability shall remain reachable through its actual
  owner after shell retirement. Verify clean model bootstrap, credential sheets,
  Skill changes, confirmed Memory/Data operations, and shortcut recording (FR-5).
- **AC-4:** Every changed control shall work by keyboard with visible focus,
  correct accessible name/state, and focus restoration; VoiceOver shall announce
  labels, values, errors, and busy state without repeated whole-page narration (FR-1 through FR-6).
- **AC-5:** At 560px and 900px widths, 200% text, and long English/Chinese copy,
  controls shall remain readable and reachable without horizontal clipping or
  hover reflow. Verify light/dark, Increase Contrast, Reduce Motion, and Reduce
  Transparency in the actual Electron window, including modal ownership.
- **AC-6:** Artifact-derived retirement checks shall find no old category route,
  aggregate Settings event/DTO, or settings-owned domain lifecycle. Run typecheck,
  relevant Core/renderer/E2E and native smoke tests, docs/diff checks, and visual
  inspection; preserve all security and design guards.

### Delivery, Files, Risks, And Collisions

**Build order within the single PR — domain contracts first:** split the composite provider/runtime projection
and events, move state/queues to domain consumers, and update all current callers
in one working refactor. The current UI remains usable. Coordinate the protected
`src/core/types.ts` edit and all consumers in the same PR.
**Then complete discovery:** implement the flows above, direct manager windows,
source-aware controls/search/reset, exact sender routing, and old-shell retirement.
The PR includes all owning specification changes and regression evidence.

Expected files: `src/core/types.ts`, `src/core/settingsWindow.ts`,
`src/main/configuration/`, `src/main/agent/capabilities/agentSettings.ts`,
`src/main/desktopHost.ts`, `src/main/hostPlatform/windowApplicationHost.ts`,
`src/preload/index.ts`, renderer API/entry/window/domain components, Composer and
Thread store notification consumers, Settings CSS/primitives as required,
English/Chinese messages, and related tests and specifications. No dependency,
build configuration, document command, board, or changelog edits are claimed.

The main risks are stale notification consumers, widened window authority,
accidental operation cancellation, and a visually flat page that still eagerly
loads every domain. The acceptance checks target those boundaries directly.
Open #653/#654 currently change recovery/session-record plans only; their future
Host/preload scope intersects the window integration. #655 currently changes its verification plan
and claims execution contracts/ThreadService, not these Settings UI consumers.
There is no current file collision; refresh remote scopes before each claim and
coordinate any newly overlapping shared contract through the PR artifacts.

## Open questions

The PM has selected one complete PR for the domain-contract and UI cutover.
No unresolved product question blocks implementation. Window pixel dimensions
and private helper names are reversible local choices.
