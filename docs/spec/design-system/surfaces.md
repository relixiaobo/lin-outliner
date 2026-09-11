# Tenon Design System Surfaces

This file owns product-specific UI surfaces: shell, workspace, outliner,
references, fields, overlays, agent, and settings. It composes the shared
[foundations](./foundations.md), [components](./components.md), and
[patterns](./patterns.md). It should stay thin: when a rule applies to more than
one surface, promote it out of this file.

## Surfaces

### Shell

The shell is a full-bleed opaque content base with two floating glass rails
(sidebar left, agent rail right) and one top strip that holds all column headers.
There is no global tab strip; the sidebar is the switcher. The material model is
defined in [foundations.md → Materials & Liquid Glass](./foundations.md#materials--liquid-glass).

**Layering.** The content base fills the window edge to edge. Rails float above it
with rounded corners, inset margins, soft elevation, and the shared chrome
material. A rail/content boundary is float + blur-through, not a hairline.

**Sidebar.** The sidebar runs full height as the left glass rail. Traffic lights
and the sidebar toggle sit at its top. Default width is `216px`, range
`180px–280px`. Navigation rows use one quiet grammar: `28px` row height, `6px`
radius, `16px` icon slots, neutral hover, and no persistent selected-fill for the
workspace tree. Product Settings stays pinned at the bottom.

**Top strip.** One visually continuous strip at traffic-light height holds:

- left: traffic lights + sidebar toggle;
- center: each pane breadcrumb header and its close affordance;
- right: selected Thread header when open plus the fixed agent toggle.

Everything shares the traffic-light centreline. Native window dragging is split
across the fixed left/right `WindowChrome` zones and pane breadcrumb chrome; it
is not inherited by every header aligned to the strip. In particular, the
selected Thread header is visually aligned but is not a drag region because its
box overlaps the fixed agent toggle from a sibling DOM tree. Header controls
follow [patterns.md → Header Chrome](./patterns.md#header-chrome): fixed
position, stable hit target, colour-deepen hover, no rounded-square hover box.

**Rail toggles.** Sidebar and agent toggles are fixed window-chrome controls in
stable absolute positions. They change state in place, never move with pane count,
and never use a selected background to show open state. When the sidebar
collapses, traffic lights and the toggle stay anchored to the window's top-left;
only the rail slides away.

**Agent rail shell.** The agent rail floats on the right. Open makes it the
rightmost column and squeezes the workspace; closed hides it. Default width is
`330px`, range `300px–520px`. Its header is a compact title trigger: DM avatar +
name or selected Thread title. It carries no static brand mark.

**Navigation.** There are no main-window back/forward buttons. Page history is
owned by pane breadcrumbs and keyboard shortcuts; date steppers inside outliners
are unrelated calendar navigation. Settings is its own window and keeps
preference-window history controls.

### Workspace And Panels

The content area is one opaque `--bg-content` base containing one or more tiled
outliner panes. Panes are real outliner panes, not cards in cards and not
floating cards over a deck.

- Panes are flush and divided only by the 1px resize handle / `--separator`.
- Each pane owns its own breadcrumb header, title, metadata rows, outliner tree,
  and scroll container.
- Pane content owns local overflow; the canvas does not become a horizontal
  scrolling surface.
- Active pane indication is a subtle neutral cue, never a box outline or brand
  colour.
- Closing the active pane focuses the nearest remaining pane. The last pane
  cannot be closed.
- Pane selection uses the shared neutral selection tokens.

`PanelSurface` and `ResizeHandle` own the reusable structural contracts; see
[components.md](./components.md#high-leverage-contracts).

### Outliner

The outliner is the primary content surface. Its product-specific contract is the
row/page model; reusable text, state, preview, and reference contracts live in
components and patterns.

**Page header.** The panel title uses `--title-display / --line-panel-title`.
Breadcrumbs are sticky, `--font-ui-sm`, muted, and aligned to the outliner leading
grid. The breadcrumb belongs to the panel edge, not the centered reading column.
When the large title scrolls under it, the current page title docks into the
breadcrumb. Breadcrumb segments drive pane-local page history and never undo
document operations.

**Row rhythm.** Row editor text uses `--font-content / --line-content`.
Description text uses `--font-description / --line-description`; `Ctrl+I` toggles
between row text and description. Editing stays borderless with no underline or
boxed focus treatment. Minimum row height is `--row-h-dense`; row radius is
`--radius-row`; row padding is `1px 6px`.

**Leading grid.** Rows share one structural leading grid:
`15px 4px 15px 8px`, width `42px`. The second `15px` column is the marker
interaction cell. Content dots, reference markers, file icons, field icons, and
command glyphs all center in that same cell. Expanded-scope guides derive from
actual rendered marker rects, not depth constants or glyph size.

**Row state.** Selection fill starts at the shared `21px` axis. Parent chevrons
are hover/focus affordances for the current row only. Empty trailing hints follow
the nodex idle-hint rule: only the focused trailing editor reveals
`Type here or '/' for commands`, after a short delay. New blank rows suppress
placeholder flash while focus or input is pending.

**Block-node files.** Attachment rows are block-node bodies, not nested cards.
They use the content base, neutral surface tokens, `--radius-md`, restrained
stroke, compact UI/meta text, and read-only filename flow. File actions are
centralized in the preview surface except image rows, which keep the top-right
hover action.

**File previews.** File preview frame, HUD, document-pixel exception, summary
mode, expanded reader, non-previewable metadata card, and local resize behavior
are owned by [components.md → File Preview Frame And HUD](./components.md#file-preview-frame-and-hud)
and [patterns.md → File Preview Flow](./patterns.md#file-preview-flow).

**Fields in the outliner.** `>` in an empty row converts that row into a field row
in place. Trailing field creation appends a field row at the trailing position.
Field name `Enter` creates a sibling node; it does not jump into the value child.
The field entry itself is not expandable because its direct children are the
values rendered in its value column. Each stored value is an ordinary expandable
node: it uses the shared leading disclosure grid, may contain ordinary child rows
or nested field rows, and keeps those descendants inside the value column. An
empty checkbox field uses a standalone toggle; once stored, its boolean value uses
the same row geometry and renders that toggle in place of editable text.

### Table View

Table is a dense, unframed content surface, never a card or a stack of row cards.
Its header and rows fill the available content width whenever their minimum
tracks fit. Title absorbs spare space so long record names remain scannable and
Add field stays at the trailing edge. Optional columns overflow through a
table-local native horizontal scroller without widening the panel or adjacent
panes; the panel remains the only vertical scroller.

Header and body use one shared responsive grid template. Title is
`minmax(260px, 1fr)`; field columns default to 180px, clamp no narrower than
112px, and honor persisted widths; the stable trailing Add field command sits
outside the data separators. Header labels and Add field use `--font-ui-sm`,
while titles and values use `--font-content` / `--line-content`; all inherit the
shared sans family. The opaque content base, quiet horizontal row separators, a
hierarchy guide aligned with the owner bullet, `--field-row-min-height` rhythm,
and neutral text hierarchy keep the surface scannable in light and dark mode.
Vertical cell borders and a top frame are absent at rest. The header may stick
inside the panel but does not become translucent chrome.

Title and authored-field headers reuse the row leading grid. A reserved chevron
slot precedes each kind icon, so header icons align with body bullets and header
labels align with body text. The Title disclosure occupies the reserved gutter
immediately before the column, while the compensated row width keeps the Title
column boundary fixed across leaf, expanded, hover, and selection states.

`ViewToolbar` owns one stable presentation and control order rather than deriving
a variant from owner type or renderer. Every Node uses the same full bar in
Outline and Table, including the same labels, Filter rule chips, popovers, and
tooltips.
The toolbar has no frame or decorative separators; spacing and control grouping
carry its hierarchy.
Name search expands inline only while active. View mode is not duplicated in the
configuration bar; the Node context menu is its single entry point, with
**View as** opening a side submenu on hover, click, or `ArrowRight`.
Toolbar controls retain the token control size and stay on one line; when the
available pane is narrower, the toolbar owns native horizontal overflow without
painting a scrollbar. It consumes the remaining pane width before overflowing;
trackpads scroll natively, while a vertical wheel moves the row horizontally
until it reaches an edge. Custom
tooltips follow the hovered or keyboard-focused control across the scroller and
remeasure each label's intrinsic width when focus moves, so their anchor and box
never carry over from a sibling control.
The Table field header therefore remains pure column semantics, and header and
row separators provide its only horizontal structure.

An active cell wrapper uses the neutral fill ladder plus the shared focus outline
only while the wrapper itself owns focus; an idle table never paints a synthetic
first-cell selection. Once focus enters an authored node editor, the wrapper
returns to transparent so an expanded subtree is never flooded with a cell-wide
fill. Authored field values always use the ordinary node renderer, including its
standard bullet, single-click editor, disclosure, children, and context menu.
Table never substitutes bare cell copy or a bespoke bullet for those nodes. A
missing value may show the same standard marker in a quiet inert state without
materializing data. The disclosure chevron and bullet always occupy their
separate standard leading slots; hover never swaps one for the other.
Selecting a record through its Title node paints one continuous neutral surface
across the complete table row; the nested Title row suppresses its local
selection fill so the result never becomes a stack of cell-sized pills. Selection
of an authored value node remains node-local and does not select its record.
When a record expands, no active authored field repeats as a field row beneath
it: visible, hidden, and not-yet-configured active fields all belong to the
column model. Ordinary children keep their normal outline presentation, while
the Title node's child/disclosure state, keyboard order, and agent-visible
structure follow that same active-field-free child set. Hidden active fields
remain recoverable through the column controls rather than through duplicate
body rows. An orphaned field entry whose definition is missing or in Trash is
the recovery exception and uses the ordinary field-row surface so its stored
values remain visible and reachable.
An authored field's header glyph is an icon-only navigation control into that
field definition's configuration page. Hover deepens only the glyph without a
background box, owning-header outline, or geometry change. System-field glyphs
remain informational and expose no hover state because they have no definition
page.
Column menu and add-column icon controls deepen colour without a rounded-square
hover box. The resize separator expands its invisible hit target without changing
column geometry and exposes a visible neutral line/focus ring only on interaction.
Hover, focus, selection, resizing, and editor entry never change row or control
dimensions.

Column and add-field overlays are level-1 material popovers with the shared
reduced-transparency fallback. Column headers use Hide as their only removal
action. Add column groups current-record custom fields first, other Schema custom
fields second, and system fields last; the Outline Display editor likewise places
custom Fields before System fields. Section labels remain compact metadata, not
selectable rows. Search Outline and Table share the same name, Display, Group,
Sort, and Filter controls. Singular settings use the neutral active state
on their own icon controls instead of text summaries. A configured control
uses `--control-on` on its glyph without a background; the pill fill means its
popover is open.
Individual Filter rule chips follow the configured Filter control and stay with
it in the toolbar's single line. Their labels summarize the effective condition rather
than repeating only the field name; presence rules and timestamp system fields
use compact labels while their editor keeps the complete wording.
Hidden Table columns remain directly recoverable through Add field. A
nested table is an unframed indented scope with one
quiet separating edge, not a card inside the parent table. Each nested scope owns
its own column template and local horizontal overflow.

### References

Reference nodes and inline references follow nodex interaction semantics while
using Tenon's neutral state and link colour model.

- Mixed selections containing reference links and normal nodes use normal batch
  block operations.
- Deleting a reference node deletes the reference link itself.
- Reference visuals follow the shared row selection axis and neutral colour
  system.
- Inline reference atoms must not break cursor, split/merge, paste, or IME
  behavior.
- Block reference rows keep the neutral dashed reference marker.

Inline node/file/directory/image mentions are owned by
[components.md → Inline References](./components.md#inline-references) and
[patterns.md → Inline Reference Flow](./patterns.md#inline-reference-flow).

### Fields And Definition Configuration

Field entries are ordinary outliner rows in document order. Field row layout uses
`FieldEntryGrid` for name/value/description slots. Every active field row reveals
both its top and bottom separators on hover or focus, including rows in the middle
of a contiguous field group; the separators otherwise stay hidden. Pointer hover
takes precedence over focus on a different field so a shared edge is painted once.

Field type glyphs use normal row icon sizing. Checkbox field type glyphs do not
use `CheckboxMark`; checkbox field values do. Boolean field values use
`SwitchMark`.

Date field values use an anchored level-1 popover, no real outer border, shared
calendar day states, and `SwitchMark` for range/time toggles. Calendar grids use
fixed square day cells with matching row/column gaps; do not stretch days through
`1fr` columns.

Definition configuration rows are dense configuration controls, not editable
outliner rows. They may visually rhyme with field rows but must not inherit row
selection behavior.

### Menus, Popovers, And Dialogs

Menus, popovers, tooltips and compact modal dialogs use the
shared overlay stack in [components.md → Overlays](./components.md#overlays).
This surface only owns where product overlays appear and which command behavior
they execute. Overlay positioning should render through a shell-level overlay
host when clipping or stacking conflicts are possible.

### Agent

The agent dock is a right glass rail subordinate to the outliner workspace. It is
toggled by the fixed top-right control; open squeezes the layout, closed hides the
rail. Motion follows [foundations.md → Motion](./foundations.md#motion).

**Header and Thread list.** The header shows the selected Thread title followed
by an always-visible downward chevron that rotates when the Thread list opens.
It carries no redundant agent glyph, provider line, decorative status dot, or
member chrome. The Thread list is scan-first and single-line. Child Threads are
visibly nested; ordinary rows expose a compact actions menu for fork, rename,
and delete.

Creating a Thread is immediate and focuses the composer. Rename uses the shared
dialog and delete uses the shared confirmation surface. The selected row is a
neutral functional state and does not use accent colour.

**History.** Agent UI uses Tenon foundations: neutral text, translucent chrome,
opaque content surfaces, sparse semantic colour, low elevation, and compact
controls. Assistant prose, user bubbles, and composer input use
`--font-content / --line-content`. Empty Threads stay visually blank
when a provider is ready; the provider-missing state shows one quiet settings CTA.
Submitting a user message scrolls that row into view once. Later streaming does
not keep stealing scroll position from a reader inspecting earlier history.
Command, file, tool, reasoning, collaboration, and Goal facts render from their
canonical Items without nested decorative cards.

**Activity and process.** In-flight work follows the Agent Thread Flow in
[patterns.md](./patterns.md#agent-thread-flow): stable status/action slots and
unboxed dense controls. Tool and reasoning metadata uses
`--font-meta / --line-meta`.

**Composer.** The composer is a flush full-bleed input region at the rail bottom,
not an inset card. It uses neutral fill (`--fill-1`, focus/drag `--fill-2`), top
corners at the rail radius, and text inset to the shared agent content column. Its
toolbar is visually unified with the textarea. Add (`+`) is a neutral unboxed
icon entry for attachments and a searchable Project flyout with recent choices first, the full scrolling
catalog, and a fixed creation footer. An empty catalog contains only New Project,
without status text, search or separators. Project creation uses an icon/name field and
a bordered, fully clickable empty source-folder area. Search and menu rows share
a 16px icon slot, 4px label gap and 28px height; bare inputs do not add a second
horizontal inset. Primary-folder state uses a readable label. Edit Project opens
the same form with saved values and a separate deletion confirmation. All chat
Project operations live here; the Thread chooser only displays Project grouping.
A selected Project adds one compact chip directly beside it: click its name to
change selection. Its leading folder icon switches in place to a remove button on
hover or keyboard focus, with neutral pill feedback and no geometry change.
All four toolbar controls, including Send, use `--control-size-xl` height and
vertical alignment before and during hover. Project and model pills retain
`--space-4` horizontal padding so text has equal breathing room at the edges. Add, Project and model selection share `--control-hover`; Add uses a circular
hit area, while text controls hug content plus padding under their truncation
ceilings. Narrow model controls retain both horizontal padding and the dropdown
caret, truncating the name inside the content area. The spacer absorbs spare
toolbar width, never a hover background. Full paths remain in the Project editor;
no selection adds no status row. Project names truncate before the application-
default qualifier. Flexible space precedes the compact model/effort button and
Send/Stop. Full model and effort identity remains accessible from keyboard and
menus, and narrow layouts preserve these controls without hover reflow.
Add folders opens a native directory picker with multiselection. Cancellation
leaves the draft unchanged. A batch appends distinct new paths in picker order;
the first added folder supplies the initial name suggestion and primary only
when the source list was empty. Existing names and primaries remain unchanged.
A batch exceeding the 20-folder total is rejected with a visible message,
without partially adding its folders.

Project folder rows are single-line and share icon, path, primary-action and
remove columns. The Project dialog is 560px wide, capped to the viewport with
16px outer insets. The final folder name takes its intrinsic width before the
parent path receives the remaining space; only names exceeding the entire path
column are themselves truncated. Long paths elide parent segments first;
hover titles preserve the full path. Make primary appears on row hover or
keyboard focus while its column stays reserved, so neither text nor neighbors
move. The selected Primary label stays visible. Editing feedback appears above
the action row, and closing restores focus to the Project chip or Add after
deleting the selected Project.

The attachment carousel stays within that inset, hides its redundant visual scrollbar,
and preserves touchpad scrolling, edge buttons, and keyboard navigation. Card hover keeps
the existing 1 px boundary and changes only its neutral colour; its radius-aligned Remove
control is unboxed and deepens only the glyph. Card gaps use the 8 px spacing rung, and
the card-height viewport keeps a straight overflow cut with a narrow tokenized inner
shadow only where more content remains.
Structured user-input requests replace the composer with bounded in-dock forms;
the hidden message editor retains its independent draft. Header browsing, question
content, and footer actions share the dock's existing inset and type hierarchy.
Options use compact neutral radio marks; reply fields and actions reuse Textarea,
Button, and IconButton. The primary action uses the neutral filled-default idiom.
The [question interaction contract](../agent-thread-rendering.md)
owns navigation, submission, timeout, and draft restoration.

### Settings Window

The settings surface follows the Preference Window pattern in
[patterns.md](./patterns.md#preference-window): macOS System Settings interaction
and container hierarchy expressed through Tenon's foundation tokens.

**Window shell.** `Cmd+,` and the App menu open/focus one **Tenon Settings**
window. The Host keeps its native title stable, uses real inset traffic lights,
and disables minimize, maximize, and fullscreen. Bounded resizing and vertical
scrolling keep larger text reachable. The shell uses an inset floating category
rail beside an opaque content canvas. The rail owns `--rail-surface-shadow`,
shared material/fallback tokens, and a persistent pill-shaped search field below
the native traffic-light spacer. The right toolbar is unboxed: its background
merges with the content canvas, with no full-width capsule, border, or shadow.
The opaque content viewport extends behind it; a shared-material chrome layer
blurs the actual scrolling content and feathers its lower edge. A measured toolbar
height keeps initial content and keyboard scroll targets clear of wrapped controls.
Reduced Transparency and Increase Contrast replace the feathered glass with an
opaque backing. The content viewport has no separate rounded frame.
The chrome uses the canvas's concentric upper corners and a graduated lower mask;
clipping introduces no viewport stroke, shadow, or extra focus stop.
Only the Back/Forward button group has a compact pill outline beside the page
title. Region spacing and rail corners use `--layout-gap` and `--panel-radius`.

`Cmd+F` focuses sidebar search. Back/Forward traverse visited categories without
reloading their panes; a new category clears the forward branch. Back from search
first restores the selected pane. History is bounded to 50 entries. There is no
in-content Close or new window per category. The content scroller is not an added tab stop. Keyboard navigation
and search-result activation reach actual controls, which retain neutral focus
indicators; clicking empty content never selects or outlines the whole viewport.

**Organization and discovery.** General contains appearance, language, and
automatic updates. Other categories are Models, Agents, Skills, Memory, Access,
Data, Keyboard Shortcuts, and Advanced. Models contains connections and default
model choices; Agents folds delegation capacity limits into its advanced disclosure.
Advanced contains diagnostics, a collapsed Model Requests group for timeout,
retry and prompt-cache preferences, public configuration files, and a collapsed scalar
Configuration Inspector with **All / Modified** filtering, initially **Modified**.
Its explanation identifies these as the same preferences shown in the categories;
it supports troubleshooting and reset rather than presenting a second set of settings.
Modified means an explicit source
override, even when equal to its default.

Search matches localized labels, descriptions, aliases, and stable IDs; IDs are
not ordinary row labels. Results expose matching scalar controls and category
destinations, which navigate locally. Clearing search restores the selected pane.
Public source observations report modified state/errors without loading runtime
catalogs. Source repair remains visible across category and search changes.

**Commit model.** Choices commit immediately. Numeric edits validate on Return
or blur; Escape restores the uncommitted value, and failed writes preserve the
entered value. Ordinary category and search rows show only their setting control.
Source-level Reset belongs in Configuration Inspector, where it deletes only that
scalar declaration. Its named action has an accessible label and appears only for
explicit overrides. Appearance returns to following macOS by choosing System.
Source rejection disables that source's structural controls while
showing its retained effective values and an Open File repair action regardless
of query/filter. Runtime application and file acceptance are separate facts;
per-owner failures preserve only the affected owner's previous effective values.
There is no window-wide Save/Apply footer.

**Controls and accessibility.** Appearance uses three labeled, miniature Tenon
window previews in a native radio group. System combines light and dark samples;
Light and Dark show their fixed palettes regardless of the current OS theme.
These decorative samples do not change the renderer theming mechanism. A neutral
outline marks the selected preview; native arrow keys change selection, and a
pending write immediately marks the requested preview and retains focus while
preventing another edit. Failure restores the effective choice and shows its error. General omits the
duplicate Appearance group heading and lets the previews explain the choices.
Language and other mutually exclusive choices use native pop-up selects.
Immediate on/off settings, including provider connections, Skills, and delegation
runners, use compact trailing switches. An off service retains readable labels
and its Configure action. Only selecting members of an Agent capability set uses
checkboxes. These controls follow the `--control-on` exception in Foundations.
Settings pop-up selectors size to the selected value, cap long labels, align
consistently at the trailing edge, and show a value and menu indicator without a
resting bezel. Domain and scalar rows share low-contrast filled groups without an
outer stroke, the large inset radius, separators inset on both sides, regular
weight row labels, and semibold section headings; default
text/image model choices share one Default models group. Ordinary copy describes
the user action rather than naming internal tool functions. Settings separators
use a half-pixel line on the quiet fill rung, strengthening to the separator token
and a full pixel with Increase Contrast. Integer fields show their accepted bounds
beside their existing unit/default explanation. Search,
controls, and Reset remain keyboard reachable with neutral focus indicators.
Escape belongs first to IME, an editor, or a menu/sheet; otherwise it clears a
focused nonempty search. `Cmd+W` closes the active native window. Closing a child
restores its invoking control. Text wraps at narrow widths and 200% text size;
chrome is nonselectable and the hand cursor is reserved for content links.

**Navigation and domain ownership.** `SettingsOpenTarget.destination` selects
`settings|models|agents|skills|memory|access|data|shortcuts|diagnostics` in the same
Settings renderer; `about` opens the separate App-menu window. An optional
`settingId` filters Settings to its matching row. Untargeted reopening preserves
selection, search, scroll, and focus. The vertical tablist has roving keyboard
focus with Up/Down/Home/End; Tab follows the toolbar and content controls. Each
visited pane stays mounted but hidden when inactive, preserving drafts, errors,
scroll, and accepted work;
unvisited panes never load their catalogs. Hidden panes do not enter the focus
order or accessibility tree.

Each domain owns its loads, errors, queues, and subscriptions. Provider responses
share a model queue; Skill availability writes retain keyed generation guards and
their own queue. The navigation shell owns no live counts, badges, or polling.
Credential editing is a modal child of Settings. Explicit navigation cannot switch
its owner underneath it, and an active in-app modal editor takes precedence over
menu deep links. Closing Settings does not revoke accepted domain work;
pre-acceptance reviews retain the owning service's cancellation rules.

**Operation feedback.** Each row owns the progress, outcome, and failure of its
operations. A single-Skill update check reports Checking, Up to date, Update
available, or its failure directly on that Skill. A library-wide check reports a
summary beside its list and specific failures on the affected rows. Acquisition
feedback stays in its open dialog; a completed installation or removal names the
Skill when its original row is absent. Read failures belong to the affected group
or pane; only shared source acceptance/recovery failures span categories.

Model changes, shortcut writes, delegation options, diagnostics actions, and
source-file opening report beside their control. Reset All reports by its footer.
A successful immediate toggle is confirmed by the resulting switch/status rather
than an extra generic success banner. Memory enablement waits for owner application;
reset evidence stays on Reset Memory even when another operation runs. Translation
and website cleanup retain separate operation outcomes, and only the affected
button says Clearing. Canceling clears that operation's pending feedback without
reporting completion. Unrelated operations never erase or relocate each other's
feedback. Existing queues, rollback rules, and stale-response guards remain in force.

Settings operations are window-owned services. Agent edits use public
configuration files, existing file tools, and the configuration Skill; its
guidance routes non-declarative work to the appropriate UI.

**Agent configuration and Access.** The root Agent editor handles the existing
main persona, standing instructions, and capability ceiling. It does not restore
retired Roles, per-type execution, or duplicated built-in Agents. Delegation
preferences and runner readiness load through their own projection within Agents,
separately from Models. A visible Edit action opens the root editor; its copy
names editable instructions and capabilities. The editor keeps its header and
Save/Cancel footer outside its scrolling body. Identity and Apply to precede
standing instructions, then capability restrictions. Colour choices have complete
circular selection rings, support roving arrow navigation, and update the header
preview. Default name/colour previews follow the loader's whole-object presentation
override rules. Saving locks editing and dismissal; errors preserve the draft.
Source observations stay separate from the draft. After a rejected write, the
editor refreshes only that layer's observation and requires an explicit Save to
retry against it. Background refreshes never advance an open editor's admission
token; another source change rejects again. Retrying preserves unrelated source
fields and JSONC comments. A failed observation refresh keeps the previous token
and the draft, without issuing another write.

Tools defaults to All available; Skills defaults to Follow Skill Library. Only
Custom selection expands a searchable membership checklist. Library-disabled
Skills are labelled Off in Skill Library; selecting one does not turn it on.
Explicit lists remain exact even when they currently contain every catalog member;
only choosing the default option restores inheritance. An empty custom list allows
none. Library status is read separately through its existing service and never
blocks editing or rewrites profile selections when unavailable. The library page
explains that its switches govern shared availability and Agent selections can
only narrow that availability. No new model tool or IPC channel is introduced.

Delegation explains its purpose and names the runner to which the
model/access/time options apply. Access states the Full Access boundary and lists explicit
blocks; removal commits on its row. The boundary explanation is a footnote.

Models exposes a visible Configure action on connections and catalog rows;
additional actions stay in the menu. Defaults stay disabled until the provider
view arrives. Automatic selection is named in full rather than abbreviated.
Each default-model choice is captured before its save enters the shared provider
queue. The displayed selection follows the stored result, including after reopening
Settings or restarting; a failed save keeps the previous selection and reports the
error on that row.

**Skills, Memory, and Data.** Skills owns acquisition, source bindings, enabled
state, and updates. Check All and Add live in the page toolbar;
the list does not repeat the Skills title. Portaled actions disappear when the
pane is inactive or global search is open; pending work still settles in its pane. Skill descriptions stay clamped to two lines; menu/switch
focus never expands a row. Check Skill Files lives in a collapsed Troubleshooting
section, with its scope explained before invocation: missing resources, exact
duplicates, and retired tool names in unchanged Agent-written user/project Skills.
It does not scan installed or built-in Skills, assess quality, or change files.
The read-only report shows checked/skipped results and omits content hashes.
Memory and Data own their inspection and confirmed maintenance
actions. Memory separates resetting from ordinary use/open controls, explains
the scope in terms of entries and nested notes, and states when new memories are
not being saved. Data shows readable storage units and keeps the consequences of
clearing visible before the native confirmation. Translation controls remain
contextual in previews; Data owns global translation-cache and website-data cleanup.

**Keyboard Shortcuts.** The searchable pane owns the public keybindings source.
Its compact Search shortcuts field occupies the trailing edge of
the page toolbar, leaving the content scroller to start with the list. Search and
the Back/Forward group share their height, pill radius, neutral fill, and inset
hairline; their height accommodates larger text. Global
Search Settings remains in the sidebar. The local filter stays owned by the pane
and survives navigation; its toolbar controls disappear in other categories and
global search results. At narrow widths or larger text the controls wrap within
the toolbar, retaining usable field and title widths.
One filled list surface contains an editing instruction and context headings.
Rows have comfortable vertical padding and inset hairline separators; context
groups have wider separation. There is no alternating fill or resting row selection. Each row shows its command name and plain,
right-aligned key combinations, without checkboxes or per-row action buttons. IDs and default badges do not
appear in ordinary rows; IDs and descriptions remain searchable, and descriptions
are accessible help.
Alternate/removal/per-command reset actions live in a contextual menu opened by
right-click or Shift+F10/Context Menu on a key field. Open File lives in Advanced's
Configuration Files group; the shortcuts toolbar has no permanent overflow menu.
A rejected source shows a direct Open Keybindings File action beside its error.
Restore Defaults sits below the list at the leading edge.
Live source changes supersede a pending initial read, including its errors.
The pane retains the latest bindings and source digest for subsequent edits.

Key combinations have no resting button bezel. Double-clicking starts recording
in fixed field dimensions; keyboard and assistive activation use Return or Space.
A single pointer click focuses without recording. Only editing adds a neutral
field fill; keyboard focus keeps its neutral ring. Delete clears the edited
binding, Escape cancels, and Tab leaves the recorder. An unassigned command
shows an editable None field, so assigning it uses the same double-click gesture. Recording
captures only the focused field, and blur or leaving the pane ends recording. It cannot intercept typing in
another category. Source rejection and effective-binding failure stay local.

**About.** Identity/version with copy, Software Update, What's New for the running
version, support, and legal. The native About item opens its independent window. Software
Update shows checking, current, available, automatic-off, and explicit-failure
states; an automatic-check switch and explicit Check now action apply immediately.
Version-copy feedback stays with the version row; automatic-check, manual-check,
and download/open failures stay beside their respective controls.
Ambient failures render nothing and preserve cached availability. Explicit check
and external-open failures stay inline in this group rather than using the manager
alert, an app toast, dialog, banner, notification, dock badge, or main-
window surface.

An available release shows only the newest stable version and its exact-tag
user-register note. The action says **Download update** only when Main verified a
GitHub release `.dmg`; otherwise it says **View release** and opens the verified
release page. Both actions are URL-free commands across preload. Tenon opens the
destination in the default browser and does not claim to install, relaunch, or
automatically download the build.

`AppInfo.version` selects its `CHANGELOG` section — note or not, since that is
the build's own record. A build running **ahead** of the last release (a dev
build, or any build before the next freeze) falls back to the newest release that
*has* a note. **`Unreleased` is never selected.** Its opening block is the
maintainer bookkeeping naming the train `main` is on, not a note; selecting it
rendered "`main` is the `0.2.0` train; entries here move under the next tag" as
somebody's What's New. When no release carries a note the group does not render.

The group is headed **"What's new in `<the selected release's version>`"** — for a
published build that is the running version; on a build ahead of the last release
the two differ, and naming the release is the honest reading, since the identity
group directly above states what is installed. There is no version picker:
browsing other releases' notes is a maintainer's errand served by the full
changelog, and the control existed mainly to surface `Unreleased` — the repo's
word for itself, which meant nothing to the person reading it.

What's New renders **only** that section's opening user-register note — the block
above its first heading of any depth — inline and uncollapsed, followed by one
external "Full changelog" row. The `### Added` … `### Internal` categories are the
engineering ledger: hundreds of entries per release describing work no user
experiences, so they are never rendered here, collapsed or otherwise, and the note
is short enough to need neither a scroll bound nor the focus stop one would carry
(a table inside a note scrolls within itself instead). The note boundary is *any*
heading below the version heading, not `###` specifically — a depth test that
holds only while every section follows the convention would let a `####` section
pour its whole ledger, Internal included, into both user surfaces.

The link pins to the tag of the release being shown
(`blob/vX.Y.Z/CHANGELOG.md#anchor`), so an old build lands on its section as it
shipped. It is always a tag, never `main`: the selected release is always a real
version, so a development build links to the last release's tag rather than the
live file. Between the freeze commit and the tag push the running version matches
a dated section whose tag does not exist yet, and the app cannot tell that state
from a published one — that window belongs to whoever is cutting the release,
never to a user, since every build a user has was published. A section written
before the convention has no note and degrades to the link alone rather than
dumping categories.

`scripts/release-notes.ts` lifts the same note through the same parser for the
GitHub Release body and appends the same "Full changelog" link from the same
helper, so the two user surfaces can neither disagree about what a release says
nor point at different places for the entries. It exits non-zero when the section
or its note is missing, when asked for `Unreleased`, and when the note is still
the `[Unreleased]` train line — the one bad note with a straight path to
production, since freezing by renaming the heading carries that line into the
released section where it reads as perfectly non-empty prose. Beyond that it
cannot judge whether a note is *good*, which is what the release-freeze rule in
`AGENTS.md` — main drafts, the PM ratifies — is for.
Changelog links use external navigation; legal links to the actual MIT license.

**Grouped rows.** Every pane uses the `InsetGroup` / `InsetRow` primitive in
[components.md → Inset Groups And Rows](./components.md#inset-groups-and-rows).
Pane-level intro copy is minimized. Rows are text-led; switches, selects, and
segmented controls trail. Inline chips show quiet metadata only and do not
duplicate a trailing control's value. Empty/loading states use `FeedbackState`;
loading states are local to a row group or content section, never the whole
window. Notices use neutral fill with status colour on text only.

**Provider rows.** Providers group into Configured and Add Providers. Configured
means a deliberate Tenon row or an externally configured provider such as CC
Switch. Configured rows expose a trailing enable switch; disabling a row keeps
credentials/endpoints but removes it from model pickers and runtime fallback. Each
row shows a neutral avatar tile plus provider name; clicking opens config unless
the row is a direct external enable row. Vendored logos may keep identity colour,
but the tile never carries functional colour. Row separators stay inset; the
trailing More button is icon-only and unboxed at rest.

An enabled provider whose language or image capability is refreshable exposes a
row refresh command. Capability, not provider identity, controls this affordance,
so a dynamic provider with an empty initial catalog can still recover and then
populate its model choices. Refresh remains an explicit network action; ordinary
settings loading uses only the last persisted catalog.

**Provider config.** Per-provider config is a focused native modal child window
(`?surface=provider-config`, 520 × 400 logical pixels; 480 high for custom providers). A stable provider icon/title replaces model marketing and capability tables;
ordinary connections omit a generic purpose subtitle. The scrolling body owns
connection inputs; the fixed footer owns Cancel and Save. Default-provider and
removal actions stay in the Models list so they cannot discard a connection draft.
Before settings resolve, the title and Cancel remain available with a loading
status; a failed load offers Try Again without guessing the authentication form.

Every input has a visible label and its own framed keyboard focus. Standard API
providers show the key first, with the optional Base URL under Advanced; an
existing override opens that disclosure. Custom and local API servers show the
endpoint prominently. Custom providers require a unique ID and a complete HTTP(S) endpoint;
loopback servers may omit the key. Managed providers explain their credential
source instead of asking for a key. Show/Hide and Copy live inside the key input,
with separate keyboard stops and room reserved for their hit targets. Saved keys
show up to four characters at each end, one mask character per concealed character,
and the exact total character count; short keys keep at least half concealed.
Long masks clip only their middle display so both ends remain visible; the count
always reports the full length. New input uses password editing and the same
preview on blur. A short replacement hint takes the place of repeated instructions.
The display-only preview never becomes the input draft. Pasting replaces the key;
clearing the field retains the saved credential, including after an explicit reveal.

The existing owned-child-only key IPC requires an explicit `preview` or `reveal`
mode. Main computes previews without returning concealed characters; only explicit
Show/Copy actions request the complete user-pasted key. Missing previews fall back
to a truthful Saved key placeholder without blocking editing. Externally managed,
environment and OAuth credentials never enter this display/read path. No Agent
tool is involved.

Test Connection is an optional stateful button without a separate result panel.
It changes from Test Connection to Testing, then Connection successful (checkmark)
or Retry Connection (warning). Completed results remain actionable; normal form
validity and busy-state restrictions still apply. Status icons carry status color
while the button keeps its neutral styling. A polite live label announces changes. The completed
check's absolute time and repeat-test hint belong in the button tooltip. Only a
failure exposes its full explanation beside the button, wrapping when necessary.
Testing does not save draft inputs. Editing the draft invalidates a pending or
completed result and restores the Test Connection action.
The key caption renders only when it has a hint, character count, or copy feedback;
an empty key reserves no description line. Connection fields use `--space-8`
between fields and `--space-3` within a field. Settings section stacks own their
`--space-lg` group separation, without adding child group/disclosure margins.
Inline shortcut errors reset paragraph margins so feedback uses only its row gap.
Copy feedback stays with the key, and save failures stay next to the footer while
preserving input. Return submits a valid changed draft. Save disables editing and
Cancel/Escape until the write completes and rejects duplicate submissions. Save
does not require a successful test.

Credential mode follows main's provider auth descriptor. Dual-auth providers have
an Account / API key choice that works in both directions and preserves an
unfinished key/endpoint draft. An existing stored key selects the key form on
opening. OAuth-only providers show sign-in directly. Browser URLs, device codes,
progress, selection, and manual-code prompts share the same header and footer;
closing or cancelling aborts outstanding prompts. Failed replies remain
cancellable. Connected-account maintenance stays with its status; Done is the
footer action. Completing OAuth can populate a dynamic model catalog without
turning the connection sheet into a model browser.

Save commits before its non-blocking probe; OAuth completion follows the same
path, while opening Settings never probes. Using the stored Base URL, the probe
lists models and sends a one-token completion. It records timestamped, redacted
`ok`, confident 401/403 `rejected`, or other `unreachable`. Connection changes
clear the result and advance a main-only generation; results commit only when
their generation still matches. Explicit Test persists only for the stored
endpoint and credential, compared via fixed-size digests in constant time.

A *connection* change is a change to what the verdict was about: the endpoint, or
the durable half of the credential — the API key, or the OAuth refresh token that
identifies the login. An access token rotating under one login is not one. Every
write counting as a change wiped an OAuth verdict roughly hourly and made it
impossible to record at all, because pressing Test on an expired token refreshes
it mid-probe and so advanced the generation the probe had captured. Endpoints are
compared normalized, so an absent and an empty Base URL are the same endpoint, and
the list's enable switch sends the row's own endpoint — never a catalog default the
user did not enter.

The stored verdict is displayed as an age ("Checked just now", "Checked 5 minutes
ago"), localized as a whole sentence rather than an English fragment placed in a
localized frame.

OAuth step cards use `--radius-md`; inputs retain their own visible focus rings.
Connection test success/failure uses status colour for status only. The primary footer
action uses the neutral filled-default idiom; destructive actions use danger text.
