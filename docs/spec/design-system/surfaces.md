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

The Title marker slot aligns with the Title header label. Its disclosure occupies
the reserved gutter immediately before the column, while the compensated row
width keeps the Title column boundary fixed across leaf, expanded, hover, and
selection states.

Search Outline and Table share one compact icon-first result-view band and never
stack a query-summary row with a full toolbar. Name search expands inline only
while active. A single two-option Outline/Table mode selector remains visible in
both modes and reuses the ordinary Outline toolbar's mode component; the context
menu is its secondary text entry point. Outline aligns the band with its result
text axis derived from the shared row geometry; Table places it between the
owner heading and field header on the Title label axis. The band has no fill,
frame, summary chips, result count, manual refresh, or decorative separators.
Its icon controls retain the token control size and wrap as complete units when
the available pane is narrower than one row; the two mode options never split
across lines. Tooltips follow the hovered or keyboard-focused control across
wrapped rows and remeasure each label's intrinsic width when focus moves, so
their anchor and box never carry over from a sibling control. The Table field header
therefore remains pure column semantics, and header and row separators provide
its only horizontal structure.

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
selectable rows. Search Outline adds Display and Group to the shared mode, name,
Sort, and Filter controls; Search Table keeps the same mode selector, name search,
Sort, and Filter while hidden columns remain directly recoverable through Add
field. A nested table is
an unframed indented scope with one
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
toolbar is visually unified with the textarea; attach/send controls are capsules.
The attachment carousel stays within that inset, hides its redundant visual scrollbar,
and preserves touchpad scrolling, edge buttons, and keyboard navigation. Card hover keeps
the existing 1 px boundary and changes only its neutral colour; its radius-aligned Remove
control is unboxed and deepens only the glyph. Card gaps use the 8 px spacing rung, and
the card-height viewport keeps a straight overflow cut with a narrow tokenized inner
shadow only where more content remains.
Structured user-input requests render above the editor as bounded in-dock forms,
not permission prompts or floating overlays. The submit action uses the neutral
filled-default idiom; secondary actions remain neutral.

### Settings Window

The settings surface follows the Preference Window pattern in
[patterns.md](./patterns.md#preference-window): macOS System Settings interaction,
Tenon foundations, no Apple chrome copying.

**Window shell.** Settings is a standalone frameless window with inset traffic
lights, the shared 24px native corner, and a renderer top drag region. Geometry
matches the main shell: `--layout-gap`, `--sidebar-width`, `--panel-radius`, and
traffic-light centreline alignment.

**Toolbar.** The drag region carries the settings history capsule (`‹ ›`) and the
selected category title. History controls reuse the main chrome control family
inside one neutral `--radius-pill` capsule with a center divider. The content
scrollport starts below fixed chrome via margin, not scroll padding.

**Category rail and content.** The left rail lists General, Agent, and Preview,
cut along user intent rather than implementation subsystem. The content pane is
an opaque Preferences base constrained to `--settings-content-max-width` (920px).
Rail, toolbar, and category render immediately; provider/runtime data loads locally.

**Pages.** Model services, Agents, and Skills sit under Agent; About sits under
General.
An unbounded collection the user installs or connects becomes a page; bounded
settings stay inline. Page rows carry chevrons, history walks real routes, and
per-provider configuration remains a native child window. Entering, leaving, or
switching a secondary page resets the content scrollport before paint; ordinary
category-to-category navigation does not trigger that reset. An explicit deep-
link anchor then positions its requested group.

**Deep links.** Categories are `general|agent|preview`; pages are
`agent/services`, `agent/agents`, `agent/skills`, and `general/about`. An optional bounded
lowercase-slug anchor (`[a-z0-9][a-z0-9-]{0,63}`) scrolls to and briefly
highlights a group. Category/page mismatches do not route; retired ids have no
aliases. Explicit targets retarget an open window, while `Cmd+,` only focuses it.

**Commit model.** Controls apply immediately with no footer or draft. Optimistic
writes revert on failure, show a localized row-owned `role="alert"`, and record
raw errors only in diagnostics. Writes serialize per key; independent Agent
mutations use independent keys and a shared pending count. Provider commands
also share a response queue because they return full settings snapshots, so an
older Set active, Remove, Refresh, or image-model response cannot overwrite a
later enable intent. Composite Preview writes serialize from the last persisted
snapshot: failure rolls back only its field, later pending fields stay visible,
and broadcasts merge below pending values. Settings and the preview popover use
the same failure contract. Only the modal provider form retains Cancel/Save.

**General.** Appearance (Theme and Language), Diagnostics, and About. Theme is a
neutral `SegmentedControl` radiogroup with roving tabindex and arrow navigation;
Language is `SelectControl variant="popup"`. When a verified stable app release
is newer than the running build and automatic checks remain enabled, General in
the category rail and the About row each show the same fixed 6px rose status dot.
It has a non-live accessible update-available name and no count or animation. Its
fixed slot is reserved while hidden so async state cannot move adjacent content.
This is a presence-based status, not unread state: opening About does not clear it; catching
up to the release or disabling automatic checks does.

**Agent.** Model services, Agents, and Skills are pages; Memory and Permissions
stay inline. Permissions states the Full Access boundary, lists explicit blocks,
and commits removal on the row; boundary explanation is a footnote under that row.
The Skill library is a scan-and-toggle surface: descriptions stay clamped to two
lines, and focusing or operating a row's menu or switch never expands the row.

The Agents page lists the Roles a user wrote above the built-in types, each row
wearing the same generated mark the transcript draws for it, so the editor and
the conversation are visibly about one participant. A row opens a level-2 editor
dialog rather than a third route, remounted per subject so it never holds the
previous agent's fields. Identity (name, colour) for every agent; **the
conversation agent** additionally gets its standing instructions and the
capability ceiling; a Role gets definition (type, use-it-for, instructions,
layer) and its own narrowing. Capabilities are checkbox lists of everything the
install has, all checked, because unchecking is the whole gesture — a list can
only narrow what the agent handing out work already had, never grant. Colour swatches
are the mark itself, so a hue is chosen against what it produces; the chosen
swatch is marked on the neutral ladder, never by tinting the mark. A leading
**Default** swatch shows what would be inherited and is the only way to send an
empty colour — without it the documented reset is unreachable from the UI. A built-in
shows identity only and offers no Delete, because there is nothing of the user's
to remove — instead it offers **Duplicate**, which seeds a new Role from the
built-in's real description and instructions rather than a blank form. An existing Role's type is fixed — it is the key both dispatch and
identity are stored under — and a new Role whose type is already taken says so
in the card rather than at the write boundary, where finding out would cost the
user the rest of what they typed. A refused write leaves the dialog standing
with its values and reports the write boundary's own sentence **inside the
dialog**: the pane's shared feedback block is a sticky element at `z-index: 1`
and the modal backdrop is fixed at `--z-modal`, so an error raised there landed
behind it and Save read as doing nothing at all.

**Preview.** Translation owns target language, webpage/EPUB auto-translation,
model, and clearing saved translations; Websites clears URL-preview session data.
The preview Languages popover writes the same cross-window preference store.

**About.** Identity/version with copy, Software Update, What's New for the running
version, support, and legal. The native About item opens this page. Software
Update shows checking, current, available, automatic-off, and explicit-failure
states; an automatic-check switch and explicit Check now action apply immediately.
Ambient failures render nothing and preserve cached availability. Explicit check
and external-open failures stay inline in this group rather than using the shared
Settings alert, an app toast, dialog, banner, notification, dock badge, or main-
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

**Provider config.** Per-provider config is a native modal child window
(`?surface=provider-config`) and owns connection only. It has no traffic lights,
no in-renderer backdrop, and closes through Cancel / Save / Escape. One inset card
holds credential mode, key/base URL/provider id as needed, and async
non-blocking validation. Model and effort belong to the Thread Configuration Profile, not the
provider connection. Saved user-pasted keys stay masked until explicit show/copy;
externally managed keys such as CC Switch registry keys are never shown or copied.
Raw-key show/copy is available only inside the provider config child window, and
main rejects the dedicated key-read IPC from all other windows. Before provider
settings resolve, the window still paints the provider title/avatar, reserved
credential/base-URL rows, and disabled footer actions with `aria-busy`; it never
falls back to a whole-window loading page.

Credential mode follows main's provider auth descriptor. OAuth-capable providers
show the shared sign-in flow for browser URLs, device codes, progress, selection,
and manual-code prompts; closing or cancelling the flow aborts outstanding
prompts. When that same provider accepts a normal user API key, the sheet offers
"Use an API key instead" and returns to the standard key form. Reopening a
provider that already has a stored API key starts on that key form rather than
presenting it as a disconnected OAuth account. OAuth-only providers omit the
fallback. A completed sign-in may populate a dynamic model catalog without
changing the sheet's connection-only ownership. Capability rows render only
non-empty model groups; provider-level refreshability remains available to the
settings row when a dynamic catalog is empty.

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

Every framed content block in the config window uses `--radius-md`; row-level
field focus uses `:focus-within` on the row because inset cards clip outer rings.
Validation success/failure uses status colour for status only. The primary footer
action uses the neutral filled-default idiom; destructive actions use danger text.
