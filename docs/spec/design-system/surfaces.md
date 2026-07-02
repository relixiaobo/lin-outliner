# Tenon Design System Surfaces

This file owns product-specific UI surfaces: shell, workspace, outliner,
references, fields, overlays, agent, and settings. It applies the shared
foundations, components, and patterns to Tenon's shipped product areas. Start at
the [design-system kernel](../design-system.md) for product principles, decision
routing, exceptions, and validation.

## Surfaces

### Shell

The shell is a full-bleed opaque content base with two floating glass rails (the
sidebar on the left, the agent dock on the right) and a single top strip that
holds every column's header. There is **no global tab strip** — the sidebar is
the switcher.

**Layering.** The content base fills the window edge to edge. The sidebar and
agent rails float above it (rounded, slightly inset, soft elevation, vibrancy
showing the content blurred beneath). See
[foundations.md → Materials & Liquid Glass](./foundations.md#materials--liquid-glass).

**Full-height sidebar.** The sidebar runs top to bottom on the left as a floating
glass rail. The macOS traffic lights sit at its top; the sidebar toggle sits
beside them. Default width `216px`; range `180px` to `280px`. Sidebar rows use one
quiet navigation grammar: `28px` row height, `6px` radius, `16px` icon slots.
Primary entries use `--control-hover` on hover; the workspace tree darkens text
rather than holding a persistent selected fill. The sidebar is the navigator
(Today / Search / Supertags / Library / Recents + the workspace tree, with the
product Settings entry pinned at the bottom).

**Top strip (the drag region).** One horizontal strip at the window top, at
traffic-light height, holds **every column's header in a single row**:
- Far left: traffic lights + the sidebar toggle (in the sidebar rail's top).
- Middle: each outliner pane's own breadcrumb header (`avatar / path / current`)
  with a `×` close at its right. The last remaining pane shows no `×`.
- Far right: the agent dock's header (leading identity avatar for a DM, or a
  hash icon for a Channel, plus the conversation title) when open, and — pinned
  to the absolute top-right corner — the agent toggle.

**One shared centreline.** Everything in the top strip aligns to a single
horizontal centreline (the traffic-light centre): the lights, both rail toggles,
every pane breadcrumb, and the agent header all sit on it. Because the rails are
inset from the window top, a rail's own header row is sized so its content
re-centres on that window centreline, not on the rail's local top.

**Uniform header controls.** The pane `×` close and both rail toggles are one
button family — identical box, radius, and icon size, neutral by default,
**colour-deepen on hover (no fill box)** per Interaction States. They differ only
in glyph (close vs. panel-toggle).

**Symmetric rail toggles.** The sidebar toggle (top-left) and the agent toggle
(top-right) are fixed window-chrome controls in stable absolute positions; they
do not ride on any pane header and do not move with pane count. Each uses a
neutral panel-toggle glyph (the agent's is the mirror of the sidebar's). State
changes in place (open ↔ collapse), position never does. Neither uses a selected
background to signal the open state. A toggle that sits in a rail's corner keeps
**equal margins** from the rail's two corner edges — mirroring how the traffic
lights sit in the sidebar's top-left corner.

**Agent rail.** Floats on the right, toggled by the top-right control. Open =
becomes the rightmost column and squeezes the layout; closed = gone. Default
width `330px`; range `300px` to `520px`. Its header lives in the top strip as a
single compact title trigger: leading DM avatar or Channel hash icon, title, and
hover/open chevron. The agent rail carries no static brand mark in its header.

**Sidebar collapsed.** The traffic lights and the sidebar toggle are **window
chrome anchored to the window's top-left**, not to the sidebar rail — when the
sidebar collapses or hides, they stay exactly in place (only the rail slides
away). The content base then extends to the left window edge, keeping enough
top-left padding to clear the lights + toggle. The lights never move with the
sidebar; that fixed position is what makes the toggle feel like stable window
chrome rather than part of the rail.

**No back/forward in the main-window chrome.** Page-history back/forward controls
are removed here; navigation is via breadcrumb path segments and the sidebar. (The
date `‹ ›` stepper inside an outliner is calendar navigation, unrelated, and stays.
The Settings window is a different surface — it keeps System Settings' `‹ ›`
category history; see "Settings window".)

### Workspace And Panels

- The content area is **one opaque base surface** (`--bg-content`) holding 1..n
  outliner panes side by side. Panes are real outliner panes, not cards inside
  cards, and not floating cards over a deck.
- **Panes are flush**, divided only by a 1px `--separator` that thickens into the
  drag handle on hover. No gaps, no per-pane card radius, no glass between panes
  (the content base never carries a material).
- Each pane is a self-contained column: its breadcrumb header (in the top strip)
  → large title → tag/date rows → outliner tree, with its own scroll.
- Pane content owns local overflow; the content area should not become a normal
  horizontal scrolling surface.
- **Active pane indication is subtle and neutral** — a quiet control-state cue
  (e.g. the active pane's toggle/header reads slightly stronger), never a full
  box outline and never a brand or accent color.
- Closing the active pane moves active focus to the nearest remaining pane;
  closing the last pane is not allowed (it shows no `×`).
- Selection inside panes stays on the neutral `--selection-*` tokens — never a
  blue or accent selection fill.

### Outliner

- Panel title editor: `24px / 32px`, weight `600`.
- Breadcrumb: `13px / 20px`, muted secondary color.
- Breadcrumb back control: `24px` hit target with a `14px` icon. Disabled
  navigation controls use `--text-disabled`.
- Breadcrumb leading alignment reuses the outliner row grid: the back control
  is centered on the chevron column, the root icon is centered on the bullet
  column, and breadcrumb text starts on the row content column.
- Collapsed breadcrumb levels use an `18px` circular More icon button. It must
  expand or reveal the hidden levels; it is not a passive glyph.
- Panel breadcrumb is sticky at the top of the panel scroll container.
- Breadcrumb belongs to the panel edge, not the centered reading column. On
  wide panels it stays near the panel's left inset while the content column
  remains centered; on narrow panels both naturally align.
- Current page title docks into the sticky breadcrumb after the large title
  scrolls under it.
- The breadcrumb (clickable path segments plus its back control) drives outliner
  page history *within a pane*; there is no separate top-strip Back/Forward. Page
  history never undoes or redoes document operations.
- Row editor: `16px / 26px`.
- Description: `13px / 18px`.
- Description editing follows the row text model: `Ctrl+I` toggles between row
  text and description, and the editing surface stays borderless with no
  underline or boxed focus treatment.
- Row minimum height: `26px`.
- Row radius: `5px`.
- Row padding: `1px 6px`.
- Leading cluster width: `42px`.
- Leading cluster columns: `15px 4px 15px 8px`.
- The second `15px` column is the marker interaction cell. Every marker variant
  (content dot, reference marker, file-kind icon, field icon, command glyph)
  shares this cell's hit target and center; variant glyph size may differ, but it
  must be centered inside the cell and must not move the structural marker axis.
  Expanded-scope guides use that transparent marker slot as the single geometry
  source; they never calculate from a visible glyph's size. The visible guide line
  and its hover/click band are aligned from the actual `.row-bullet-button` rects
  that rows render. The flat renderer measures the parent marker and the last
  mounted descendant marker relative to `.outliner-flat-guides`; it does not
  derive guide x/y from estimated row layout, depth constants, or visible glyph
  size. The band starts below the parent marker slot, so marker clicks remain
  owned by the marker itself. The visible glyph (5px dot, file icon,
  reference/field glyph, command glyph) is centered inside the same slot. This
  keeps file icons, small dots, and other marker glyphs using one structural
  marker slot without introducing file-specific layout. The visible line starts
  just below the parent marker slot and ends on the last visible descendant marker
  centerline; tall previews, wrapped content, and glyph size never stretch the
  structural line.
- Selection fill starts at `21px`.
- Parent chevron is a hover/focus affordance for the current row only.
- Empty trailing hints follow the nodex idle-hint rule: only the focused
  trailing editor reveals `Type here or '/' for commands`, after a short delay.
- Blank content-row placeholders are suppressed while focus or typed input is
  pending so newly created nodes do not flash placeholder text.
- Normal rows, reference rows, tag definition rows, field definition rows, field
  entry rows, completed rows, selected rows, and expanded/collapsed parent rows
  keep the same text-start grid.
- Attachment rows are block-node bodies, not nested cards. They use the content
  base's neutral surface tokens, `--radius-md`, a restrained border, and compact
  `--font-ui-sm` / `--font-ui-xs` text. The filename is primary, read-only, and
  wraps like a locked/reference row; a caret can land in the filename for
  selection and node commands, but ordinary input never renames it. Long unbroken
  names may break anywhere inside the content column rather than truncating
  behind an ellipsis or resizing the row. Tag chips are part of the same inline
  filename flow, following the filename instead of dropping into a separate row.
  A PDF thumbnail may replace the
  file-kind glyph; otherwise file type uses the shared monochrome
  `inlineFileIcon` mask mechanism painted with `currentColor`. Non-image rows do
  not carry a trailing action button; file actions are centralized in the preview
  surface, while image rows keep their top-right hover action.
- File previews use one rounded viewport: the structural `--radius-xl`, a soft
  `--inset-hairline` edge instead of a real border, and the content base's soft
  surface. The frame uses one equal token inset on every side so preview pages
  never touch the viewport edge; inner document-page corners derive from the
  parent radius minus that inset so the curves stay concentric. The PDF summary
  strip scrolls inside that content box, so pages never render into the inset
  while horizontally scrolled. The summary strip places the horizontal scrollbar
  in the existing bottom inset, so the scrollbar sits below the pages without
  reducing their display height or adding extra bottom space.
  The shared bottom-center preview action bar sits over the preview frame in one
  consistent location for every non-image file type. It is two separate controls:
  a fixed-width primary capsule (`Expand` / `Collapse`, or short `Open` for
  non-previewable files) plus an independent circular `⋯` button; it is not a
  segmented control and must not use a divider. Because it floats over arbitrary
  file pixels (white PDF pages, images, failed backdrop blur), it uses the
  dedicated `--preview-action-*` HUD tokens rather than the app-surface `--fill-*`
  hover ladder; hover must preserve readable contrast over white preview content,
  including when reduced transparency removes backdrop blur.
  Rendered external document pixels are a deliberate sandbox exception to the app
  theme: HTML/EPUB/PDF page bodies may force a light document canvas
  (`color-scheme: light`, black text, white/Canvas background) inside the preview
  iframe or page renderer so source documents stay inspectable. This exception is
  confined to document content pixels only; the preview frame, controls, overlays,
  selection handles, and action bar stay on design-system tokens.
  Previewable files start in
  summary mode; PDFs show a compact horizontal all-pages strip whose page canvases
  fit the summary viewport height with tight token spacing from each other and
  token spacing from the filename row, then Expand switches to the full vertical
  scroll reader. The full reader also scrolls inside the viewport content box, not
  on the frame itself, so PDF pages never enter the top or bottom inset while
  vertically scrolled. The action bar is an overlay on top of the pages; summary
  content does not reserve a blank bottom band for it. Do not crop the top of the first
  page as the collapsed state. The viewport exposes a neutral bottom-edge resize
  handle; dragging or keyboard arrows adjusts only the local preview height.
  Non-previewable files use the same rounded frame as a compact metadata card:
  show a concise file-kind title such as `zip` with the quiet size on the same
  row, then the modified date on its own quiet row (no icon and no `Type` /
  `Size` labels), with enough inset that it reads
  like a lightweight Quick Look information surface. Keep the short `Open`
  primary plus `⋯` system actions in the same bottom action bar position, so file
  operations do not move between previewable and non-previewable formats.
- `>` in an empty row converts that row into a field row in place. Trailing
  field creation appends a field row at the trailing position.
- Field name `Enter` creates a sibling node. It does not jump into the field
  value child.
- Field values may contain nested field rows, matching normal outliner child
  behavior.

### References

- Reference nodes and inline references follow nodex interaction semantics.
- Mixed selections containing reference links and normal nodes use the normal
  batch block operation model. Deleting a reference node deletes the reference
  link itself.
- Reference selection visuals follow the shared row selection axis and neutral
  color system.
- Inline reference atoms stay in text flow and must not break cursor,
  split/merge, paste, or IME behavior.
- Inline references render as text links: normal text weight, no chip surface,
  first-supertag text color when available, otherwise the `--link` native link
  blue. They must NOT introduce a *second* link colour (e.g. reusing
  `--status-info` blue) — the app has exactly one link colour. Reference nodes
  remain block rows with the neutral dashed reference marker.
- **One inline-mention language across the app.** A reference is a `.inline-ref`
  text link everywhere it renders — the outliner row editor (`pmSchema`), the
  agent composer editor, and the agent message render. A **node** reference is
  plain text with no icon; a **local file / directory / image** reference adds a
  single leading **monochrome** icon (the only thing that distinguishes a file
  from a node — not a different colour or a chip). The icon is one shared
  mechanism — a CSS `mask-image` keyed on `data-file-icon-kind`
  (`.inline-ref-file-icon`, see `inlineFileIcon.ts`) painted with `currentColor`,
  so it themes automatically (B1/B8). The icon and its filename never split across
  a line break: the mention is `white-space: nowrap` and the name re-opens
  wrapping inside its own `.inline-ref-file-name` span, so the icon always travels
  with the start of the (still-wrapping) name and is never orphaned at a line end.
  Render sites never invent a second file-chip species (the retired
  `.agent-composer-inline-file` / `.agent-message-inline-file` were exactly that —
  a parallel `inline-flex` chip with a full-colour macOS icon).
- Local-file inline refs carry shared `data-inline-ref-*` metadata. A global
  `InlineFilePreviewLayer` listens for hover/focus on
  `[data-inline-ref-kind="local-file"]` and shows one neutral popover: images use
  the native thumbnail when available; other files/folders use the same metadata
  card shell with icon, name, type/size, path, modified time, and unavailable
  state. Pointer hover waits briefly before opening to avoid accidental peeks while
  the cursor moves through dense prose; keyboard focus opens immediately. The ref
  itself keeps the normal text-link hover treatment plus a neutral fill/halo that
  does not change layout; the popover uses the elevated popover material + level-1
  shadow with reduced-transparency fallback.
- Clicking a path-backed local-file inline ref opens the file or folder in Tenon's
  preview surface. Live transcript refs keep the workspace file-only reader
  presentation; outliner, agent meta-surface, and loose refs use the normal preview
  pane route. Right-click opens the shared inline file menu: Preview in Tenon, Add
  to Today for files, Open with default app, and Show in Finder. The system actions
  go through the preload bridge and main process only after the main process
  canonicalizes the path under the non-root agent local file root, stats it as a
  regular file/folder, and rejects executable or bundle-like open targets.
  Previewable local files receive an opaque `preview-local://<token>` stream URL
  from the main process, the local-file twin of stored assets' `asset://<id>`
  stream URL. Both internal stream schemes are range-capable byte streams so
  native image and media elements can load large files and audio/video can seek.
  Renderer code consumes only the shared `streamUrl` field; it must not branch on
  source kind, navigate to `file://`, call `openExternal` for file paths, or read
  local bytes directly. Composer local-file atoms expose the same preview
  metadata, but click handling stays with the editor so draft text remains
  selectable and editable.

### Fields And Definition Configuration

- Field entries are ordinary outliner rows in document order.
- Field row layout uses `FieldEntryGrid` for name/value/description slots.
- Field row separators reveal on hover or focus instead of being permanently
  heavy.
- Field type glyphs use normal row icon sizing; checkbox field type glyphs do
  not use `CheckboxMark`.
- Checkbox field values use `CheckboxMark`.
- Boolean field values use `SwitchMark`.
- Date field values use an anchored popover, level 1 overlay shadow, no real
  outer border, shared calendar day states, and `SwitchMark` for range/time
  toggles. Summary rows stay compact and neutral; they should not read as
  stacked cards. Calendar grids use fixed square day cells with matching row
  and column gaps; do not stretch days through `1fr` columns.
- Definition configuration rows are dense configuration controls, not editable
  outliner rows. They may visually rhyme with field rows but must not inherit
  row selection behavior.

### Menus, Popovers, And Dialogs

- Menus and popovers use level 1 overlay shadow.
- Dialogs and command palette use level 2 overlay shadow.
- Menus, popovers, command palette, and compact modal dialogs share the
  `--radius-overlay-sm` radius rung. Menu/popover chrome uses
  `--material-popover` + `--material-backdrop`; the a11y layer provides the
  reduced-transparency opaque fallback from the shared material tokens.
- Overlay shadows are pure drop shadows. Do not add a real outer border to
  floating surfaces.
- Search/input headers stay visually attached to their surface.
- Escape closes overlays. Non-modal popovers close on outside pointer down.
- Focus-visible remains visible inside overlays.
- Modal dialogs trap focus and restore focus on close.
- Popovers should render through a shell-level overlay host when clipping or
  stacking conflicts are possible.
- **Tooltips** are the quietest overlay: a small opaque `--bg-elevated` surface
  (not glass), level-1 shadow, `--font-meta` secondary text, offset ~`--space-3`
  from the anchor. They appear after a ~500ms hover delay and hide instantly on
  leave or any pointer/keyboard action; never animate them in. A tooltip only
  *names* a control — never put an action, link, or essential-only information in
  one. Respect `prefers-reduced-motion` (no fade).

### Agent

- The agent dock is a glass rail on the right (see Shell), subordinate to the
  outliner workspace. It is toggled by the fixed top-right control; open makes it
  the rightmost column and squeezes the layout, closed hides it.
- **Collapsed = slid off-screen; the toggle stays.** Closed, the rail is slid
  fully off the right window edge and faded out (see Motion → Rail slide). The
  fixed top-right toggle is a *bare* icon (no material, shadow, or fill —
  restraint); its hover feedback deepens the glyph color, not a glass chip behind
  it. The toggle is the collapse control in both states.
- Its header lives in the top strip as one centered row. A DM shows only that
  agent's circular identity chip and display name. A Channel shows a leading hash
  icon, the Channel name, and a trailing member count in parentheses
  (`Name (3)`) that includes the user; it never shows member avatar stacks or a
  literal `#` text prefix. No header subtitle, decorative status dot, model line,
  or DM-to-Channel action lives in the row. The title trigger has no hover
  background; it darkens text and reveals its chevron only on hover, focus, or
  open state. The agent header carries no `✦` toggle of its own — collapsing
  happens through the fixed top-right control.
- The conversation menu follows the Slack section-action model: the Direct
  Messages section header owns the `New agent` action, and the Channels section
  header owns the `New Channel` action. Creation commands are header affordances,
  not fake rows mixed into the conversation lists. Section headers do not draw
  hairline borders; spacing and quiet header text separate groups.
- Conversation menu rows stay scan-first and single-line: DMs render only avatar
  + agent name; Channels render only hash icon + Channel name. Optional unread
  badges are numeric pills at the trailing edge and are suppressed for the active
  conversation. Model names, snippets, timestamps, message counts, and member
  stacks do not appear in these lists. Each row reserves a trailing More affordance
  that appears on hover/focus and opens a dropdown. Today that dropdown contains
  only the configuration entry (agent settings or Channel configuration); future
  row actions should hang from that same menu rather than becoming persistent row
  chrome. Hover uses `--control-hover`; the current conversation uses
  `--selection-bg` so hover and current state remain visually distinct.
- New/edit Agent and New/edit Channel use dedicated native child windows
  (`?surface=agent-config` / `?surface=channel-config`) opened through
  `lin:open-agent-config` / `lin:open-channel-config`. The dock and Settings list
  are launch points only; they never embed authoring forms or Channel membership
  editors inline. Agent and Channel config windows use the same native child
  dimensions, each starts with an explicit title header, and each keeps its
  Cancel / Save action bar fixed to the bottom edge while content scrolls behind
  it. Agent config reuses the shared AgentEditor surface, which hosts the
  capability-driven model/effort selector (pick a Provider, then a Model; the
  effort options derive from that model's supported thinking levels — see
  `agent-pi-mono-implementation.md`). The built-in Tenon assistant is read-only
  except for that model/effort: it keeps an editable selector and a real Save
  (persisting to the settings-owned overlay) alongside Duplicate, while name /
  tools / persona stay disabled. Channel config uses the
  same settings sheet/inset-list language for name, optional opening message,
  the per-channel Dream-data inclusion checkbox, current members, and add-member
  actions. Protected default channels keep their names disabled in this sheet;
  the Dream channel also keeps Dream-data inclusion disabled because it is always
  excluded from Dream evidence.
- Agent UI uses Tenon foundations: neutral text, translucent chrome, opaque content
  surfaces, sparse semantic color, low elevation, and compact controls.
- Assistant prose, user bubbles, and composer input use
  `--font-content / --line-content`.
- Empty agent conversations stay visually blank when a provider is ready. The
  provider-missing state replaces the blank area with the settings CTA.
- User message content defaults to a compact view when its rendered content
  exceeds roughly five content lines. The collapsed region covers the whole user
  display group (text, inline references, attachment chips, and image previews);
  copy/edit actions still operate on the full message.
- Agent identity is a circular initial chip (`AgentIdentityAvatar`) with hue
  deterministically derived from the stable principal/agent id. It is an identity
  cue only: no functional state colour, no square hover fill, and no generated
  image dependency.
- Channel assistant rows show the speaking agent for every assistant message,
  including the coordinator. The label comes from the recorded message `actor`
  and member/definition metadata, not from provider/model strings or the current
  live roster alone. Attribution is a header — avatar and speaker name on one
  line — above a full-width reply body that aligns to the avatar's left edge; the
  body is NOT indented into an avatar gutter, so a Channel reply reclaims that
  horizontal space. (A DM assistant row carries no attribution header, so its
  content is full-width already.)
- Channel activity is an in-flow presence row centered directly above the
  composer with the standard `--space-3` vertical gap, not a transcript row,
  bottom toolbar, or floating corner pill. It lives in normal layout flow (it
  occupies its own row, so it never visually overlaps the last transcript
  message), and it is removed entirely when nothing is in flight. The collapsed
  row is a single quiet trigger: a compact stack of up to three working agent
  avatars (a same-size overlapping `+n` count chip stands in for any beyond), a
  generic working summary (≤2 working → names, ≥3 → count; never the per-agent
  state), and an animated typing-dots affordance. The trigger is a real `menu`
  button (`aria-haspopup="menu"`, `aria-expanded`, `aria-controls`) and carries no
  hover layout change (B7) and no system accent (B3/B4). Clicking it opens an
  opaque level-1 menu — NOT translucent material (so transcript text can never
  bleed through it) — built on the shared overlay primitives
  (`MenuSurface` + `useAnchoredOverlay` for viewport flip/clamp +
  `useMenuKeyboard` for Escape / roving / focus-restore), portaled to `<body>`
  and anchored to the trigger so it can never run off-screen. The menu shows the
  live working set (no frozen snapshot), a compact title with a "Stop all" action
  for runs that can be stopped. The menu geometry is fixed and tokenized: 8px
  outer padding on every side, a 24px header row, 6px between header and list, 28px
  list rows, 4px horizontal row inset, 6px avatar-to-status text gap, 8px
  status-to-stop column gap, and a 20px per-run stop control. Each list row shows
  avatar immediately followed by a natural-language status line such as "Neva is
  thinking..." / "Neva is using tools..." / "Neva is waiting..." — no color-coded
  tool-state dots. A per-run stop control uses the same stop glyph as the
  composer but is an unboxed row action by default: no background in the resting
  state, no hover box, and only the glyph color deepens on hover/focus. It sits
  inside the row when stopping is available. "Stop all" is also a quiet text
  action, not a pill: it has no resting or hover background, and keyboard focus is
  indicated with text underline plus color deepening instead of a boxed control.
  Clicking a row drills into that run's detail view and closes the menu. Row hover
  remains neutral fill.
- Message metadata is quiet by default. The transcript does not insert centered
  time separators; right-click opens the native message menu, whose Details
  action shows timestamp, speaker, model, and token usage in a small anchored
  popover.
- Process summaries, thinking rows, and tool summaries use
  `--font-meta / --line-meta`.
- Process and tool-call disclosures use one measured disclosure/status slot so
  labels do not jump across hover, focus, loading, or expansion.
- Composer is flush — a full-bleed input REGION at the rail's bottom, not an
  inset card: zero side/bottom margin, a neutral `--fill-1` background (focus and
  drag deepen one step to `--fill-2`, never a brand ring — B3), and rounded TOP
  corners at the rail's own `--panel-radius`, so the dock's `overflow:hidden`
  rounds the flush bottom to match. The editor's scroll viewport reaches the
  surface edges so its native overflow scrollbar hugs the panel edge like the
  transcript (B10); its own padding re-insets the text to the shared
  `--agent-content-x` column.
- Composer toolbar remains visually unified with the textarea; no internal
  divider. Its footer controls (attach / send) are capsules (B6).
- The composer footer may carry the quick model / effort chip, but it is a
  **profile shortcut**, not a conversation model identity. A DM talks to an agent
  identity and a channel to that agent's conversation space — not to a per-message
  model switch — so the chip edits Neva's standing profile through the same
  agent-profile path Settings owns. It must stay visually quiet and subordinate to
  the send / stop slot. It never edits provider connection state, never implies a
  per-conversation override, and never replaces the diagnostic model/provider
  surfaces: message Details, run/debug panel, ledger metadata, and the agent
  profile editor.
- Settings opens as a standalone window (the `?surface=settings` route), not an
  in-app modal. See "Settings window" below.
- Runtime approval/tool preview types exist, but no renderer approval overlay is
  shipped. Do not render fake approval controls before product behavior exists.

### Settings window

The settings surface follows the macOS System Settings *interaction* idiom
(the Wi-Fi pane is the reference), rendered in Tenon foundations (tokens + B-rules),
not Apple chrome. We borrow the interaction, not the chrome.

- **Frameless window, identical to the main shell's geometry.** The settings
  window is frameless with inset traffic lights (`titleBarStyle: hiddenInset` +
  the shared `MAC_TRAFFIC_LIGHT_POSITION`) and the same custom 24px native corner
  (`MAC_WINDOW_CORNER_RADIUS`) as the main window — not the smaller macOS default.
  There is no native title-bar strip: the renderer draws a top drag region
  (`.settings-drag-region`) and the lights sit over the rail's top. Insets and
  radii match the main shell exactly — `--layout-gap` float + gap, `--sidebar-width`
  rail, `--panel-radius` corners — so the rail nests concentrically inside the
  window corner (window 24 = gap 8 + rail 16, B9).
- **Back / forward toolbar capsule + page title.** The drag region carries macOS
  System Settings' `‹ ›` history controls and the selected category title. The
  arrows reuse the SAME chrome control as the main window's rail toggles — the
  shared `IconButton variant="chrome"` with `.rail-toggle` (icon-only, glyph
  deepens `--text-secondary` → `--text-primary` on hover, dims to
  `--text-disabled` when inert; B6) — NOT a bespoke style. Settings-specific
  styling lives only on the group: `.settings-history-nav` is one neutral
  `--radius-pill` capsule (`--fill-1` + inset hairline) with a center divider;
  individual arrows do not get independent rounded-square boxes. Placement is
  settings-specific: `.settings-toolbar` anchors over the content column on the
  traffic-light centreline (`--chrome-control-inset`), with `.settings-history-nav`
  as the no-drag control group. The content scrollport starts below this fixed
  chrome via `margin-top`, not scrollable padding, so dense rows never pass behind
  the history capsule or title. The `.settings-toolbar-title` is the right-pane
  anchor ("General", "Providers", etc.), so the content no longer relies on the
  rail alone to name the page. History walks a category visit-history stack:
  switching categories pushes (truncating any forward entries), back / forward move
  the cursor; each is disabled when there is nothing to traverse.
- **Floating category rail + constrained grouped content.** A left rail lists settings
  categories (General / Providers / Permissions / Skills / Agent Profiles); the
  window opens to Providers (the primary connection task). The rail is the
  app's own floating glass panel — elevated surface, soft elevation, rounded,
  hairline edge — mirroring the main window's `.sidebar-dock`, so it reads as a
  rail that floats off the content base rather than a flat column. Unlike the main
  window, the Settings window is an opaque Preferences surface (no OS vibrancy
  under it — see `main.ts`, which sets `data-window-material` for the main surface
  only), so the rail floats on an opaque `--bg-elevated`, not a translucent
  material. Rail rows keep the
  category IA, but add a compact neutral icon slot and a single clear label per
  row so scanning is closer to System Settings without explanatory subcopy or
  functional status color. The content pane is the flat window base (no
  surrounding card) and is the single scroll container, so the rail stays put; the
  grouped cards float on it on an opaque `--bg-elevated` surface. The content
  column is constrained
  (`--settings-content-max-width`, 920px) so rows keep a stable utility width
  instead of stretching across the whole window; this is intentionally wider than
  the 720px prose `--reading-max`. There is NO permanent side detail pane:
  per-provider config opens in its own native window (below). Categories — not
  individual providers — are the top-level rail rows.
- **General pane — appearance.** The **General** category holds app-wide
  preferences; today it has **Theme** and **Language** rows. Theme uses a
  `SegmentedControl`
  (System / Light / Dark): a recessed `--fill-1` track (`--segmented-track-shadow`
  inset hairline) whose selected segment is a lifted `--bg-elevated` capsule
  (`--shadow-thumb`) — a neutral functional state, never an accent (B3) — with
  concentric `--radius-md` track / `--radius-sm` segment (B9), rendered as an ARIA
  `radiogroup` with roving tabindex + arrow-key navigation and a neutral
  `:focus-visible` ring (B8). Language uses `SelectControl variant="popup"`: a
  compact pop-up button with an overlaid chevron, no border and no lifted thumb;
  it is transparent at rest and gains a neutral `--fill-*` background only on
  hover / focus / press, so it reads like macOS text chrome rather than a heavy web
  select. The native option list still opens on click (B10). Unlike the
  runtime / permission panes it has **no Save footer**: a pick applies INSTANTLY
  across every window — it sets
  `nativeTheme.themeSource` in the main process (`lin:set-theme`), which rewrites
  each renderer's `prefers-color-scheme` so the one dark `@media` block (see
  Appearance above) drives the flip — and persists to `app-preferences.json` in
  `userData`, reapplied before first paint on the next launch.
- **No redundant chrome.** The window is closed through native window chrome
  (the traffic lights), like System Settings — there is no in-content Close
  button. The right-pane toolbar title names the selected category; sections inside
  the content do NOT repeat that pane title with another `<h3>`. Pane-level intro
  lines are avoided unless they carry information that cannot live in a section
  header or row sublabel. The content pane carries no search field, and the
  Providers list no leading status column — "Configured" vs "Add Providers"
  already carries setup state, so a per-row marker would be redundant. Rows show a
  trailing `⋯` menu ONLY when they have more than
  one action; a single-action row's lone "Configure" is what clicking the row
  already does, so instead it exposes a trailing **"Configure" button** — the macOS
  Wi-Fi "Connect" / "Details" idiom: a quiet secondary control (`--fill-3`,
  deepening to `--fill-4` on its own hover), hidden at rest and revealed on row
  hover / keyboard focus. Its reveal IS the row's hover locator — the row carries no
  fill of its own — and it configures the provider. Custom providers are
  added from the last row of the Available list ("Add custom provider"), not a
  floating control.
- **Inset grouped list (the reusable primitive).** `SettingsInsetList.tsx`
  (`InsetGroup` + a memoized `InsetRow`) renders a sentence-case section header
  above a rounded inset card whose rows are split by hairlines; geometry derives
  from the radius / hairline / row-height ladders (B9). Inset rows use
  `--row-h-comfortable`; section headers use `--title-group` and are chrome text,
  not user-selectable content. The card is its own region by COLOUR —
  `--bg-elevated` floating on the content base — per the surface ladder (`--bg-window`
  < `--bg-content` < `--bg-elevated`), with only an inset hairline shadow rather
  than a heavy border. **Row hairlines are
  content-aligned, not edge-to-edge** (the macOS grouped-list rule): the separator
  is inset on the left to start at the row's content, leaving the leading
  icon/avatar in an undivided gutter, and runs flush to the right edge. The inset is
  one tunable token (`--inset-separator-inset`, default = the row's text padding);
  a consumer with a leading column widens it to clear the icon (Providers →
  pad + avatar + gap). Selection and focus stay NEUTRAL — `--fill-*` + the neutral
  focus ring, never the system accent (B3/B4). Selection fills the WHOLE row
  (`.inset-row`), not just the main button. Rows carry **no hover fill** — like
  native System Settings list rows, hover reveals the row's action affordance (the
  "Configure" button / `⋯` menu) as the locator, not a row-wide tint (which read as
  a redundant box). The in-card focus
  ring is the inset `--outline-focus` so it is not clipped by the card's
  `overflow: hidden`. This is the A7 foundation, now the canonical list idiom for
  **every** Settings pane — see "Settings panes share one idiom" below. An
  `InsetRow` maps richer settings rows onto its slots: a non-interactive mark in
  `leading`, the title (optionally with an inline `.settings-chip`) as `label`, an
  explanatory line as `sublabel`, and any **interactive** control — a switch, a
  decision `select`, a segmented control — in `trailing` (a sibling of the
  selectable button, so a toggle never nests inside it). A `wrap` variant lets the
  title / description wrap instead of single-line ellipsis (and can stack a secondary
  technical line for diagnostics or advanced detail under the description).
- **Settings panes share one idiom.** Every pane (General, Providers, Permissions,
  Skills, Agent Profiles) renders on the same primitives, so the window reads as one
  generation:
  - **Container — flat base.** Panes sit FLAT on the content base
    (`.agent-settings-section` carries no card); the grouped inset cards float on it
    like the rail. No opaque `--fill-1` pane wrapper.
  - **Header — toolbar title + section headers.** The right-pane toolbar carries the
    category title; sub-group headers are the primitive's `.inset-group-header`, not
    a bespoke `<h4>`. Pane intro lines are minimized.
  - **Rows — text-led; controls trailing.** Migrated rows carry no leading tile
    (only Providers leads with the brand avatar); the row toggle / decision select
    lives in the `trailing` slot (native macOS — toggles sit on the right). General's
    Theme/Language, Skills' behaviour switches + installed-skill toggles, Permissions'
    common actions (a compact transparent-at-rest decision pop-up with a stable
    decision width, so rows stay aligned regardless of each select's option text;
    the row sublabel stays human-readable and does not expose raw rule strings),
    Agent Profiles' selectable profile list — all are `InsetRow`s. Agent Profiles
    rows are launch points: clicking a row opens the dedicated Agent config child
    window, while each writable row keeps the enable/disable switch in the trailing
    slot. Do NOT combine inline authoring forms with the list.
  - **One secondary button.** `Button variant="secondary"` uses filled neutral
    `--fill-2`, no border — the native push button, pairing with the filled-strong
    primary; never a ghost outline.
  - **One chip.** `.settings-chip` — `--radius-xs`, `--control-hover`, sentence case
    (no uppercase) — for quiet metadata such as skill source, ignored-rule
    diagnostics, and agent tool tags. Do not duplicate a trailing control's current
    value with an inline chip.
  - **One empty / loading state.** Use `FeedbackState` for plain muted text, no
    dashed box (native, not a web drop-zone); panel-sized states fill a detail pane.
  - **One notice / banner.** Neutral `--fill-1` box with the status colour on TEXT
    only (`.agent-settings-alert` / `.settings-sheet-result`), never a status-tinted
    fill (B4).
- **Provider rows.** Providers group into "Configured" (has a deliberate Tenon
  row or an externally configured provider such as CC Switch) and "Add Providers".
  Configured rows expose a trailing enable switch; disabling a row keeps its
  credentials/endpoints but removes it from model pickers and runtime fallback.
  Each row is the brand avatar as identity + the name; clicking it opens the config
  sheet unless the provider is a direct external enable row. Every provider mark — vendored brand
  logo OR monogram fallback — sits on ONE neutral tile (a quiet `--fill-2` fill +
  concentric radius, like an app icon); the tile never carries brand/system colour
  (B3/B4), but the logo keeps its own (identity, not a functional-state colour). The
  logo is INLINED (not an `<img>`) so monochrome marks using `fill="currentColor"`
  (OpenAI, OpenRouter, Groq, …) follow the light/dark theme via the avatar's
  `color`, while multicolour logos keep their own fills. Row separators are inset on
  BOTH edges — the left aligns with the tile (the row's content padding), a matching
  right inset keeps the hairline within the card rather than bleeding to the panel
  edge. The
  trailing `⋯` (when present) is icon-only — just the glyph, no border or box (B6:
  signal by colour, not a frame); it deepens on hover and takes a quiet circular
  fill only while open. Its floating menu reuses the shared popover glass with the
  `prefers-reduced-transparency` opaque fallback (B5/D2) at the level-1 menu tier
  (B10). Rows are memoized + fed stable handlers, so opening one provider's sheet
  never re-renders the list.
- **Per-provider config — its OWN native window, connection only.** Clicking a row
  (or "Configure…") opens the config as a real native window, NOT an in-renderer
  overlay: a frameless **modal child of the settings window** (`?surface=provider-config`,
  opened by the main process via `lin:open-provider-config`) — the macOS System
  Settings idiom where a list row opens a real attached dialog (cf. the Wi-Fi
  password sheet). The window IS the dialog surface (`.provider-config-window`,
  `ProviderConfigWindow.tsx` → `ProviderConfigForm.tsx`): opaque, filling the frame,
  no traffic lights (closed by its own Cancel / Save or Escape), no backdrop (the OS
  dims the parent). It has a brand-avatar + title/subtitle head and a SINGLE inset
  card holding the **connection only** — no model or thinking-level picker (model
  and effort are owned by the agent profile; see
  [Agent](#agent) and `agent-pi-mono-implementation.md`): a label-less credential row (a key glyph +
  the field, native password-dialog style) and the base URL inline (the lone
  advanced setting — no disclosure). Saved user-pasted keys render as masked
  placeholder text until the user explicitly clicks show or copy; externally managed
  keys (for example CC Switch's Codex key) are never shown or copied here. Raw-key
  show/copy is available only inside this provider config child window; the main
  process rejects the dedicated key-read IPC from all other windows.
  `Test connection` validates reachability with
  an internally-chosen probe model, never a user-picked one. Custom
  (OpenAI-compatible) providers additionally enter a provider id in the same card.
  It fetches its own
  provider settings and commits via the existing agent IPC, then calls
  `notifySettingsChanged` so the main process broadcasts a settings-changed to BOTH
  the settings list (which refetches — `onSettingsChanged`) and the main window. It
  owns its own Cancel / Save — providers commit per-window, so the list surface has
  NO global save bar (apply-per-provider, like native). Validation is async and
  non-blocking: the form stays interactive, shows a pending row, and can be
  cancelled (a request-id guard drops a stale/cancelled result). The form is
  multi-mode so managed credential modes (OAuth, AWS/Vertex) plug in later — an API
  key is one `mode`. Managed-credential providers (e.g. AWS Bedrock) show an auth
  note instead of a key field while keeping model/reasoning/base URL controls
  visible.
- **One radius for sheet content blocks; row-level field focus.** Every framed body
  block in the config window — the field-group inset card, the managed-credential
  note, the OAuth step / code / connected blocks, and the validation banner — shares
  the same radius, `--radius-md` 8 (the small-surface tier); inputs and buttons keep
  their own control radii (B6), which this does not touch. The borderless field rows
  show keyboard focus as the inset `--outline-focus` on the **row** (`:focus-within`),
  because the inset card clips an outer ring (see the Focus row in the control-state
  table).
- **Status colour for status only (B4).** Validation success/failure uses
  `--status-success` / `--status-danger`; the primary action (Save / Sign in /
  Continue) is a genuinely strong NEUTRAL fill — the native "filled default button"
  idiom on `--surface-inverse` (shared with `Button variant="primary"` and the
  composer send button), never a system-blue accent (B4). The earlier `--fill-3`
  tint read weaker than the secondary; the solid fill makes the main action
  unmistakable. Secondary is the filled neutral surface button; danger
  (`--status-danger` text) is reserved for genuinely destructive actions (Sign out /
  Remove provider), so exactly one button per footer reads as primary.
