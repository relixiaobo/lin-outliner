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

**Top strip.** One drag-region strip at traffic-light height holds:

- left: traffic lights + sidebar toggle;
- center: each pane breadcrumb header and its close affordance;
- right: agent conversation header when open plus the fixed agent toggle.

Everything shares the traffic-light centreline. Header controls follow
[patterns.md → Header Chrome](./patterns.md#header-chrome): fixed position,
stable hit target, colour-deepen hover, no rounded-square hover box.

**Rail toggles.** Sidebar and agent toggles are fixed window-chrome controls in
stable absolute positions. They change state in place, never move with pane count,
and never use a selected background to show open state. When the sidebar
collapses, traffic lights and the toggle stay anchored to the window's top-left;
only the rail slides away.

**Agent rail shell.** The agent rail floats on the right. Open makes it the
rightmost column and squeezes the workspace; closed hides it. Default width is
`330px`, range `300px–520px`. Its header is a compact title trigger: DM avatar +
name, or Channel hash + title + member count. It carries no static brand mark.

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
Its scroll scope may use the full panel width, but the data strip remains
content-sized instead of stretching empty columns across the pane. Optional
columns overflow through a table-local native horizontal scroller without
widening the panel or adjacent panes; the panel remains the only vertical
scroller.

Header and body use one shared grid template. Title has a compact fixed default;
field columns use narrower clamped persisted widths; the trailing `+ Add` command
sits outside the data separators. The opaque content base, quiet horizontal row
separators, a hierarchy guide aligned with the owner bullet,
`--field-row-min-height` rhythm, content type scale, and neutral text hierarchy
keep the surface scannable in light and dark mode. Vertical cell borders and a
top frame are absent at rest. The header may stick inside the panel but does not
become translucent chrome.

An active cell uses the neutral fill ladder plus the shared focus outline only
while focus is actually within its grid; an idle table never paints a synthetic
first-cell selection. Authored field values always use the ordinary node
renderer, including its standard bullet, single-click editor, disclosure,
children, and context menu. Table never substitutes bare cell copy or a bespoke
bullet for those nodes. A missing value may show the same standard marker in a
quiet inert state without materializing data. The disclosure chevron and bullet
always occupy their separate standard leading slots; hover never swaps one for
the other.
Column menu and add-column icon controls deepen colour without a rounded-square
hover box. The resize separator expands its invisible hit target without changing
column geometry and exposes a visible neutral line/focus ring only on interaction.
Hover, focus, selection, resizing, and editor entry never change row or control
dimensions.

Column and add-field overlays are level-1 material popovers with the shared
reduced-transparency fallback. A nested table is an unframed indented scope with
one quiet separating edge, not a card inside the parent table. Each nested scope
owns its own column template and local horizontal overflow.

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

Menus, popovers, tooltips, compact modal dialogs, and the command palette use the
shared overlay stack in [components.md → Overlays](./components.md#overlays).
This surface only owns where product overlays appear and which command behavior
they execute. Overlay positioning should render through a shell-level overlay
host when clipping or stacking conflicts are possible.

### Agent

The agent dock is a right glass rail subordinate to the outliner workspace. It is
toggled by the fixed top-right control; open squeezes the layout, closed hides the
rail. Motion follows [foundations.md → Motion](./foundations.md#motion).

**Header and conversation menu.** A DM header shows avatar + agent name. A Channel
header shows hash icon + Channel name + member count including the user. No header
subtitle, decorative status dot, model line, member stack, or DM-to-Channel action
appears in the title row. The title trigger follows the Header Chrome pattern.

The conversation menu is a single Channels list with one section-header
`New Channel` affordance rather than a fake row. Rows are scan-first and
single-line; Channels show hash + name, active rows suppress unread badges, and
ordinary Channel rows show trailing edit/delete icon actions for inline rename
and confirmed deletion. Protected default Channels do not show rename or delete
controls.

**Config and inline edits.** Agent authoring uses a dedicated native child window
(`?surface=agent-config`) opened through the main process. Channel creation is
inline-lightweight: the Channels `+` creates an untitled Channel immediately and
focuses the composer. Ordinary Channel rows expose a trailing edit icon for inline
rename and a trailing trash icon for confirmed deletion; protected default
Channels do not show rename or delete controls. Channel settings surfaces, when
opened directly, use the settings sheet/inset-list language for remaining
per-Channel settings such as Dream-data inclusion. Agent and Channel config
windows render their header, field structure, and footer actions before their
agent/conversation IPC data resolves; the body carries `aria-busy` and disables
mutable controls instead of replacing the child window with a generic loading
state.

**Transcript.** Agent UI uses Tenon foundations: neutral text, translucent chrome,
opaque content surfaces, sparse semantic colour, low elevation, and compact
controls. Assistant prose, user bubbles, and composer input use
`--font-content / --line-content`. Empty agent conversations stay visually blank
when a provider is ready; the provider-missing state shows one quiet settings CTA.
Long user messages collapse after roughly five content lines while copy/edit still
operate on the full message. Submitting a local user message creates a one-shot
scroll target for that newly rendered user row, even when the reader was inspecting
older history. Later assistant streaming does not keep taking the scroll position;
ordinary near-bottom following resumes only after the user scrolls again.
Root Issue completion and failure appear as a compact, unboxed transcript status
row between turns. It spans the content column, aligns left, and reads title-first
(`"Compile the report" completed`, or the localized equivalent). It has no leading
concept or status icon; the neutral text carries the result, and an inline
chevron uses the same size and placement as adjacent process disclosures. The row
opens canonical Issue detail directly over the current chat instead of routing
through the Work list. Closing the detail returns to the same conversation and
scroll position. The row remains present when the Agent chooses to handle the
notification without a visible reply.

**Identity and attribution.** Agent identity is a circular initial chip
(`AgentIdentityAvatar`) with deterministic hue from the stable principal/agent id.
It is identity only: no functional state colour, no square hover fill, no
generated image dependency. Channel assistant rows show the speaking agent from
recorded message actor/member metadata; attribution is avatar + speaker name above
a full-width reply body aligned to the avatar's left edge.

**Activity and process.** In-flight work appears as the Agent Conversation Flow in
[patterns.md](./patterns.md#agent-conversation-flow): an in-flow presence row above
the composer, shared overlay primitives for the activity menu, stable measured
status/action slots, and unboxed dense stop controls. Process summaries, thinking
rows, and tool summaries use `--font-meta / --line-meta`. Process/tool disclosures
use the shared measured disclosure/status slot.

**Composer.** The composer is a flush full-bleed input region at the rail bottom,
not an inset card. It uses neutral fill (`--fill-1`, focus/drag `--fill-2`), top
corners at the rail radius, and text inset to the shared agent content column. Its
toolbar is visually unified with the textarea; attach/send controls are capsules.
The footer model/effort chip is a profile shortcut only, never provider settings,
conversation identity, or a per-message override. Capability and user-question
states render as in-composer blocking cards above the editor/toolbar, not as
floating overlays. Their primary/submit action uses the neutral filled-default
idiom; secondary, deny, and discussion actions stay neutral filled. The details
disclosure stays local to the card.

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

**Category rail and content.** The left rail lists categories: General,
Providers, Security, Skills, Agent Profiles. The content pane is a flat opaque
Preferences base with constrained grouped content (`--settings-content-max-width`,
920px). There is no permanent detail pane; per-provider config opens a native
child window. Categories, not providers, are top-level rail rows. The rail,
toolbar, and selected category surface render immediately; provider/runtime data
loads into the pane asynchronously instead of replacing the window with a loading
page.

**General.** General owns app-wide preferences: Theme and Language. Theme uses
`SegmentedControl` (System / Light / Dark) with neutral selected state, ARIA
`radiogroup`, roving tabindex, arrow-key navigation, and neutral focus. Language
uses `SelectControl variant="popup"`. Both apply immediately across windows
without a save footer.

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

**Provider config.** Per-provider config is a native modal child window
(`?surface=provider-config`) and owns connection only. It has no traffic lights,
no in-renderer backdrop, and closes through Cancel / Save / Escape. One inset card
holds credential mode, key/base URL/provider id as needed, and async
non-blocking validation. Model and effort belong to the agent profile, not the
provider connection. Saved user-pasted keys stay masked until explicit show/copy;
externally managed keys such as CC Switch registry keys are never shown or copied.
Raw-key show/copy is available only inside the provider config child window, and
main rejects the dedicated key-read IPC from all other windows. Before provider
settings resolve, the window still paints the provider title/avatar, reserved
credential/base-URL rows, and disabled footer actions with `aria-busy`; it never
falls back to a whole-window loading page.

Every framed content block in the config window uses `--radius-md`; row-level
field focus uses `:focus-within` on the row because inset cards clip outer rings.
Validation success/failure uses status colour for status only. The primary footer
action uses the neutral filled-default idiom; destructive actions use danger text.
