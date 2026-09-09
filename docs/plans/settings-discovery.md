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
The window uses a floating left rail beside an opaque right canvas. Search sits
below the rail's native traffic-light spacer. An unboxed toolbar above the right
content viewport holds a compact Back/Forward group and the page title. A pane's
local search belongs at the trailing edge of this toolbar; Keyboard
Shortcuts retains its own filter state while inactive and removes its toolbar
controls during other categories or global search. Search and the Back/Forward
group share one height, capsule background, and hairline outline. Configuration
files belong in Advanced; a rejected shortcut source exposes a direct repair
action beside its error instead of a permanent toolbar menu. Narrow windows and larger text
can wrap trailing controls within the toolbar without squeezing the title. The rail keeps its elevation; the toolbar has no full-width capsule, border,
or shadow. Content scrolls behind a shared-material toolbar backing with a soft
blurred edge. Measure toolbar height to support wrapping and scroll-padding;
Reduced Transparency/Increase Contrast use an opaque backing. Remove the content
viewport frame and its redundant focus stop; focus actual controls instead. Shared gaps and concentric corners retain Tenon's container grammar.
About retains its normal App-menu window; credentials remain an owned modal child.

### Interaction Requirements

| Flow | Observable behavior |
| --- | --- |
| FR-1: Open and navigate | App menu **Settings…** and `Command+,` open/focus one **Tenon Settings** window. General, Models, Agents, Skills, Memory, Access, Data, Keyboard Shortcuts, and Advanced switch inside it. Untargeted reopening preserves selection, search, scroll, and focus. Explicit application destinations select the corresponding pane without a reload. Back/Forward traverse category history; choosing a new category clears the forward branch. Back from search returns to the selected pane first. Native minimize, zoom, and fullscreen are disabled; resizing and scrolling remain available. |
| FR-2: Find | A persistent sidebar search field matches localized labels, descriptions, aliases, and stable IDs. `Command+F` focuses it. Results expose matching scalar controls and category destinations; category results navigate locally. Clearing search returns to the selected category. Search never loads catalogs for unvisited panes. |
| FR-3: Organize and edit | General contains appearance, language, and automatic updates. Models groups request policy under a collapsed Request Options disclosure. Agents owns delegation, with capacity limits under a collapsed advanced disclosure. Memory owns its enable switch and maintenance. Advanced contains diagnostics, configuration files, and a collapsed Configuration Inspector with All / Modified filtering, defaulting to Modified and explaining that these are the same preferences shown in each category. Choices commit immediately; numbers commit on Return/blur and Escape cancels an uncommitted edit. Keyboard Shortcuts uses compact command rows with a name and trailing editable key combination; secondary actions live in contextual menus, and IDs/badges stay out of ordinary rows. No window-wide Save/Apply footer. |
| FR-4: Reset and repair | Modified means an explicit source declaration, including an explicit default. Show a named Reset action only for modified rows; reset deletes only that declaration. Invalid sources disable their structural controls and retain an Open File repair action regardless of category or query. Show retained effective values separately from source acceptance and runtime application. |
| FR-5: Keep context | Mount a domain pane on first visit, then keep it mounted but hidden on navigation. Preserve drafts, errors, disclosure state, scroll, queues, and accepted operations. Only the visible pane enters the accessibility tree and focus order. Each domain owns its subscriptions and progress. Credential input opens a modal child of Settings; navigation cannot switch its owner underneath it. An active in-app modal editor likewise takes precedence over a menu deep link. |
| FR-6: Keyboard and recovery | A vertical tablist uses roving focus with Up/Down/Home/End; Tab follows the toolbar and content controls. Source conflicts preserve the draft and require an explicit retry against the new observation. Escape first belongs to IME, editor, or frontmost menu/sheet, otherwise it clears a focused nonempty search. `Command+W` closes the active native window. Child dismissal restores the invoking control. The content region is not an extra tab stop; search navigation focuses a real control. Actual controls retain neutral keyboard focus, and empty content clicks never paint a viewport outline. Shortcut recording ends on blur or category change and only captures its focused field. No unrelated domain becomes busy. |

About and Help keep their App/Help menu homes. Preview translation remains
contextual. Public source observations may supply bounded errors/modified state;
settings navigation never depends on live counts, badges, credentials, or probes.

### Consistent Controls Across Panes

Audit General, Models, Agents, Skills, Memory, Access, Data, Shortcuts, and Advanced
as one system. Category headers should not repeat a single row label. Text/image
model defaults share one group; popup menus size to the selected value with a
bounded long-label fallback and consistent trailing alignment. Immediate service
and feature enablement uses trailing switches. Checkboxes are reserved for
selecting members of an Agent capability set. Use low-contrast filled groups without outer strokes,
separators inset on both sides, regular row labels, and semibold section headings
across domain and scalar rows. Popups show their value and indicator without a
resting bezel. Keyboard Shortcuts uses one comfortably spaced list with inset separators and context
headings and instructions above the rows. Key combinations read as trailing text;
double-click or keyboard activation starts recording in stable field dimensions,
and a single pointer click only focuses. Delete clears a binding; None is also
directly editable. Right-click/Shift+F10 exposes additional actions without
per-row menu buttons; Restore Defaults sits below the list at the leading edge.
Hide ordinary technical IDs/badges and internal tool names where
they do not help a person make a choice. Keep errors and meaningful source/status
information visible. Check every pane in English/Chinese, light/dark, and large
text, and verify focus, popup behavior, and retained operations on the real app.

Choose presentation by the decision a person is making, across every category:

| Category | Presentation and interaction |
| --- | --- |
| General | Labeled miniature app previews compare System, Light, and Dark; native radios keep keyboard behavior. Language remains a named popup, and automatic updates remain an immediate switch. |
| Models | Defaults name Automatic selection; unavailable/loading states cannot masquerade as an editable default. Visible Configure actions reveal connection editing; secondary actions stay in menus. Request fields explain units, defaults, and accepted bounds. |
| Agents | A visible Edit action and accurate copy expose instructions/capabilities. Colour choices support arrow navigation. Delegation explains its purpose and the runner affected by the following options; advanced limits remain disclosed. |
| Skills | Keep descriptions and meaningful availability/source information. Put read-only Skill File Diagnostics in collapsed Troubleshooting with a plain explanation of its limited scope; omit hashes from the report. Acquisition, review, and destructive decisions retain their existing ownership. |
| Memory | Separate everyday enable/open controls from reset. Use readable lifecycle and deletion-scope copy; an off feature cannot claim it is ready to save new memories. |
| Access | State the fixed access boundary as information; list explicit blocks with readable labels and exact rules available for inspection. |
| Data | Show readable storage units and explain the effects of clearing before confirmation. Do not conflate cache bytes with total website data or logical translation size with physical disk usage. |
| Keyboard Shortcuts | Preserve the compact text list, deliberate editing, searchable help, focused recorder, and contextual actions without checkbox enablement. |
| Advanced | Keep diagnostics, repair files, and the scalar inspector discoverable; show numeric bounds and preserve source-conflict drafts. |

Shared row separators are quiet half-pixel rules with matching content insets;
Increase Contrast strengthens both their opacity and width. Appearance previews
use fixed illustration palette tokens, never a renderer theme bridge.

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

### Operation Feedback And Toolbar Ownership

Keep this within the same complete PR. Skills moves group-wide Check and Add
into the page toolbar and removes its duplicate list title. File diagnostics
stays in a collapsed Troubleshooting section with a clear scope explanation. Toolbar
portals render only for their active pane, including during global search.

Scope progress/errors/outcomes by row or operation: individual Skill checks,
model defaults/providers, shortcut commands, delegation fields, Memory actions,
translation/website data cleanup, and diagnostics/source-file opening. A batch
check or removal of a row uses a named group summary. Acquisition keeps its
feedback in the active dialog. Reset All uses the footer. Source read/recovery
errors retain their broader scope, while preference application failures stay
with their affected controls. A change in one row cannot clear another row's
outcome, and shared serialization must not make unrelated buttons claim work.
About copy, automatic-update, manual-check, and download feedback follow the same
rule. Preserve cancellation, stale-response guards, accepted writes, and per-owner
rollback behavior; do not introduce backend contracts for visual feedback.

### Configuration Without Additional Agent Tools

Remove the twelve Settings-era model tools for Skill lifecycle, Memory, preview
translation/data, and application/diagnostics operations. The canonical model
catalog, action descriptors, runtime adapters, and Agent Host wiring no longer
publish or execute them. Keep existing ordinary file tools and the configuration
Skill as the Agent surface for public declarative preferences, including schema
and current-Host acceptance/effectiveness verification. Do not add a replacement
tool or CLI. Human Settings, preview, About, and Help keep their existing internal
services, confirmations, and IPC admission; these are not model tools. Operation
requests without a declarative setting point to that user interface. Update active
specifications and replace retired adapter coverage with registry exclusion and
retained UI/domain operation coverage.

The scroll-under material follows the right canvas's concentric upper corners.
A longer graduated mask softens the blurred backing without exposing a rectangular
strip or a separate content frame; accessibility fallbacks stay opaque.

### Provider Connection Flow

Keep the provider modal focused on authentication and endpoint configuration.
Remove capability tables and duplicate status/actions; label every field. Standard
endpoints belong under Advanced, while custom/local endpoints stay visible and
custom providers require a unique ID and an HTTP(S) URL. Test Connection is optional, has local
feedback, and never saves the draft. Save preserves failed input, blocks duplicate
writes/closing while committing, and keeps the existing background probe.
Dual-auth providers support switching both ways without losing the key draft;
OAuth account maintenance belongs with connected status. The native child grows
to 520 × 400 (480 high for custom providers), with a scrolling body and stable
actions. Cover stored keys, local servers, managed credentials, dual auth, interrupted tests, failed writes, and
light/dark layout at normal and enlarged text.

Keep Show/Copy inside the key field, with accessible hit targets. Main supplies a
preview containing up to four characters at either end, the actual mask length,
and a total count. Short keys conceal at least half their characters; long keys
keep both ends visible with an exact count beside a concise replacement hint.
The preview is presentation-only: empty input preserves a saved key, and input
replaces it directly. The existing sender-checked key IPC requires explicit preview
or reveal mode; full reads occur only on Show/Copy. Remove generic connection copy
and the separate replacement action. No Agent tools or IPC channels are added.

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
[Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views),
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
English/Chinese messages, notification consumers, and corresponding tests/specs. Retirement also touches the Agent tool catalog,
capability derivation, four model adapters, Agent Host composition, and the
built-in configuration Skill.
No dependencies/build configuration, document commands, board, or changelog edits.

Risks: stale notification consumers, accidentally broad IPC admission, loss of
in-flight work on navigation, and eager catalog loading behind a shared shell.
Tests target these boundaries directly. PR #655 shares only the existing
`docs/spec/agent-model-runtime.md` scope, in distinct ownership paragraphs; its
execution-contract/ThreadService implementation is outside this change. It has
merged, as has #658 (process execution and Tool Tasks). Open #659 retires
file_delete and shares catalog/specification surfaces with this PR's tool retirement;
its author has checked integration against this claim. Open #660 is a documentation
plan for further tool retirement. Neither claims Provider forms or credential
preview code. Keep shared specification edits in their respective sections.

## Open questions

The PM selected one complete PR and single-window category navigation. No unresolved
product question blocks implementation. Private helpers and bounded window
geometry are reversible local choices.
