# Tenon Design System Patterns

This file owns cross-component interaction and content patterns: canonical states,
app shell patterns, multi-panel behavior, drag and drop, content states,
accessibility, and the native-feel capability boundary. Start at the
[design-system kernel](../design-system.md) for product principles, decision
routing, exceptions, and validation.

## Interaction States

Every interactive component shares one canonical state model mapped to tokens.
Per-component contracts only note deviations from this table.

| State | Treatment |
| --- | --- |
| Rest | Transparent, or `--fill-2` for a resting control. Text `--text-primary` / `--text-secondary`. |
| Hover | Region/row controls: `--fill-1` (subtle) or `--fill-2`. Icon-only controls: deepen the glyph colour (`--text-secondary` → `--text-primary`), no fill. Layout must not shift; cursor stays default on rows. |
| Pressed / active | `--fill-4`. |
| Selected | `--selection-bg` (`--fill-3`); multi-select / range uses `--selection-soft` (`--fill-2`). |
| Focus (keyboard) | `--outline-focus` + `--focus-ring-shadow`. Always visible, neutral — never brand or system accent. Every shared focus indicator carries paint only after keyboard navigation (`:root[data-input-modality="keyboard"]`); pointer focus and pointer-triggered programmatic restoration stay visually quiet. Text controls rely on the caret or local editing affordance after pointer input so ordinary clicks do not turn into web-form boxes. Borderless inputs inside clipped inset cards move the keyboard ring to the **row** (`:focus-within`) because an outer ring would be cropped by the card's `overflow:hidden`. Editor-owned text canvases and non-tabstop structural controls may suppress the shared box only when another visible local focus mechanism owns the state, and every such suppression must be named in validation. |
| Disabled | `--text-quaternary`; no hover; reduced-intensity fill. |
| Working | Keep the semantic identity/status glyph stable and apply the cadenced `WorkingText` treatment only to the named action phrase. The readable base and a static cue remain when motion is disabled. |
| Loading | Reserve one measured slot so the label and size do not jump; spinner uses `--text-secondary`. |
| Error / destructive | `--status-danger` text/outline marks the resting destructive affordance. Ordinary destructive hover stays neutral (`--control-hover`), not a status tint — functional state is neutral (B3); the status colour rides on the label, not the hover fill. Solid destructive confirmations follow the Button contract and may use the status-danger fill because the command itself is destructive. |

Rules:

- **Every operable control gives feedback.** No interactive element is visually
  inert on hover, press, or focus — at minimum the hover state deepens the glyph
  colour (icon controls) or shows a fill (rows/regions), and the active state is
  always distinct from rest. Feedback on every action is a baseline, not a polish
  item; a control the pointer can act on must visibly acknowledge the pointer.
- **Functional state is never brand or system accent** — only the neutral fills
  and neutral focus tokens above (principle 3).
- **Icon controls deepen colour; they do not gain a box.** An icon-only chrome
  control (rail toggles, pane close, header actions) signals hover/active by
  colour, not a `--fill-*` background — restraint with backgrounds keeps the
  chrome quiet. Reserve fills for row/region hover. If an icon control genuinely
  needs a hover fill, it is circular or pill-shaped (echoing the glyph), never a
  rounded square.
- **Hover never changes layout.** No size, height, or neighbor reflow on hover
  (generalizes the tag-hover rule).
- **Expansion grows from a fixed edge.** Opening a disclosure, or a floating
  surface growing while it is open, must leave what the reader is already looking
  at exactly where it is. The fixed point is at or above the top of what grows: a
  chevron above its content is that point; a control that hangs BELOW its own
  content is not, and anchoring it opens every revealed line upward, off the top
  of the viewport. Two things this does not say. A scroller riding a tail it can
  actually scroll keeps holding the control, since there holding it IS staying at
  the bottom — but a surface shorter than its viewport has no tail to ride, and
  scroll range borrowed by the machinery itself does not count as one. And nothing
  grows on the way back: **collapsing holds the control**, which is what the reader
  just clicked and the only point the geometry guarantees is on screen, while the
  block's top edge may by then be far above it. A floating surface absorbs its own
  growth by scrolling inside a ceiling derived from where it was placed; deriving
  the position from its own current height instead answers growth by teleporting
  out from under the cursor, and feeding back a clipped height turns the position
  into a one-way valve that never returns to its anchor. Content that lands late
  (an image, a lazily measured row, an injected translation) obeys the same rule:
  reserve the box, or hold the topmost thing still on screen.
  (`messageDisclosureAnchor.ts`, `disclosureScrollAnchor.ts`, `flyoutPlacement.ts`.)
- **No pointer cursor on hoverable rows.** Native lists do not switch the cursor;
  a pointer cursor reads as web. Text cursor only on real text. `cursor: help` is
  allowed for inline diagnostic hints or native-title tooltips, and resize cursors
  use the shared `--resize-cursor` / `--resize-cursor-y` tokens.
- **One disclosure/status slot.** Labels must not move across rest, hover, focus,
  working, loading, and expansion (generalizes the agent disclosure rule).

## Patterns

### App Shell

Desktop layout is chrome + persistent docks + canvas. The first viewport should
be the working surface, not a marketing or tutorial layout.

### Multi-Panel Canvas

Panels tile by ratio and fill available width. Resizing preserves adjacent
panel total size. Single-panel mode can center bounded content but must fill
when narrow.

### Tag Hover

Tag hover/focus swaps or reveals affordances within a measured pill. It must not
move row text, change row height, or reflow neighboring tags.

### Drag And Drop

Dragging (outliner row reorder/indent, multi-select drag, and external file
insertion) stays neutral and quiet, like the rest of functional state:

- **Insertion line:** a thin neutral line (`--drop-line`, the neutral focus
  weight) at the exact drop position, with a small indent marker showing the
  target depth. Never a rose/blue line.
- **Drag image:** a translucent copy of the dragged row(s) following the pointer
  (~`0.6` opacity), not a re-styled card. Multi-select shows the rows stacked
  with a small neutral count badge.
- **Drop target:** a subtle `--fill-2` wash on the container being dropped into;
  no coloured outline.
- **Cursor:** the grabbing cursor *is* allowed during an active drag (it is
  functional, not decorative — distinct from the no-pointer-on-rows rule).
- **No layout thrash:** rows do not resize or animate height while a drag hovers;
  only the insertion line moves.

### Native Desktop Feel

Desktop controls should feel dense, quiet, and predictable. Use icons where a
common symbol exists; use text buttons only for clear commands. Avoid decorative
nested cards.

### Header Chrome

Window chrome, rail toggles, pane close buttons, and compact surface headers share
one idiom: stable position, fixed hit target, icon or short title, and colour
deepening instead of boxed hover. Header controls never move with dynamic content
counts; state changes in place. A title trigger may reveal a chevron only on
hover, focus, or open state, but it does not gain decorative background chrome.

### Preference Window

Preference/configuration windows borrow macOS System Settings' interaction idiom
without copying Apple chrome. The surface is a standalone native child or
settings window, not an in-renderer overlay, when the task is modal to settings.
The left side is category navigation; the right side is a flat content base with
constrained grouped cards. Category titles live in the toolbar, not repeated as a
second in-content heading.

Rows are text-led, controls trail, and each pane uses the same inset-list
primitive. There is no permanent detail side pane; row launch points open child
windows or dedicated editors. Single-action rows reveal one quiet secondary
button; multi-action rows reveal one `...` menu. Pane intros are avoided unless
they carry information that cannot live in a section header or row sublabel.

### Inline Reference Flow

Node, file, directory, and image mentions share one inline-reference language
across outliner rows, the agent composer, and agent messages. The text remains
selectable/editable where the owning editor requires it. Hover/focus may add a
neutral fill/halo but must not change line height, split the icon from the name,
or introduce a chip surface. File preview popovers are delayed on pointer hover
and immediate on keyboard focus.

### File Preview Flow

Previewable files start summarized and expand into a scroll reader without
changing the action model. Non-previewable files use the same frame as a compact
metadata card. File actions stay in the same bottom HUD position for previewable
and non-previewable formats, so Open/Expand/system actions do not move across
file kinds. The preview frame may resize locally, but it must not resize sibling
rows or use a canvas-level horizontal scroll as a rescue path.

### Agent Thread Flow

Agent chrome is subordinate to the outliner workspace. Thread identity is shown
through a compact title and scan-first list, not provider/model strings. Work in
flight appears in canonical Item order, never as a floating corner pill. Live
controls use shared overlay primitives and dense unboxed actions.

A speaker header is NOT aligned to the content rows beneath it. Identity
chrome and content rows answer different questions — who is speaking versus
what was done — and a mark sized to anchor a two-line header cannot share an
axis with a content row's 12px glyph. The header keeps its own internal column
instead (PM 2026-08-19, superseding the shared-glyph-column rule of
2026-08-15).

PARTICIPANT identity is the one place identity colour lives: a generated mark
(one shared form filled with the identity's `--identity-tint-*` hue, two eye
holes) plus a persona and the Agent type, in the speaker header. Identity is its own decorative category — not a functional
state (B3), not a status (B4), not the rose accent — and it stays on the mark:
a card, a chip, or a row that carries a participant's work keeps neutral chrome,
so nothing outside the mark has to be read as a colour code.

Composer controls stay subordinate to the send/stop slot. Product-input requests
remain in the dock and never become authorization overlays.

## Content & States

- **Voice & tone:** concise, calm, factual. No marketing exclamation. Action
  labels are verbs (`New page`, not `Create a brand-new page!`). Error messages
  say what happened and what to do — no blame, no stack traces in product UI.
- **Empty states:** a single quiet hint at the point of action (the outliner idle
  hint `Type here or '/' for commands`), not an illustrated empty-state card. The
  empty Thread follows the same rule: when a provider is usable it stays
  visually blank until the user types or work appears; when provider settings have
  **loaded** and none is usable it shows a quiet onboarding line + a neutral CTA
  that opens Settings › Providers, and the composer send is disabled (neutral,
  with a tooltip) — gated on the loaded state so a key-holding user never sees the
  onboarding flash during the async load.
  Whole-panel empty results (search with no matches, an empty Trash/Recents view)
  use `FeedbackState` so the hint is centered in a reserved slot, muted, and
  icon-supported without becoming an illustrated card. Editable empty outline
  pages do **not** get a centered empty-state block; the trailing editor line is
  the action point.
- **Working:** a named action that Tenon is actively advancing keeps its semantic
  glyph and puts motion on its action phrase through `WorkingText`. One normal,
  accessible text layer supplies its own paint-contained, background-clipped
  smooth sweep: it starts after `300ms`, crosses in approximately `1.4s`, and
  repeats every `2.4s`. Rendering the glyph only once is required; overlaid text
  copies change anti-aliasing density and look like a font-weight shift. The
  effect never animates transforms or masks, so a translucent parent material
  does not become the animation surface. Truncation, white-space, overflow, and
  ellipsis belong to that same text layer. Within a disclosure hierarchy, only the
  most specific mounted eligible representation moves: a collapsed summary hands
  motion to an expanded live child, or stops when the expanded child has sufficient
  static cues. `prefers-reduced-motion: reduce` and `prefers-contrast: more`
  restore ordinary static text fill, so progressive wording, neutral colour, or
  a status mark must identify the state without motion. A tool may deepen only
  its fixed semantic glyph under those preferences; do not change the working
  phrase's colour, weight, or metrics. Waiting on a person or
  external authorization, retry backoff,
  disconnected dependencies, terminal outcomes, and ordinary resource loading do
  not use `WorkingText`.
- **Loading:** the first frame is the working surface, not a splash. Persistent
  chrome, rails, and navigation render before async data resolves. For slow
  operations, use an in-place reserved slot; when a spinner is necessary, render
  it through `FeedbackState` so reduced motion can disable the spin. Do not gate
  whole windows or preference panes behind a generic loading page.
- **Error / offline:** surface errors inline near their cause; reserve full
  surfaces for genuine whole-view failures. Status color is used sparingly and
  always paired with text or an icon, never color alone.

## Accessibility

- **Contrast:** text levels target WCAG AA on their surfaces. `--text-primary`
  (.88 ink) is the reading level; do not set essential reading text in
  `--text-tertiary`/`--text-quaternary`. Verify in both themes.
- **Focus visibility:** keyboard focus is always visible (`--outline-focus`) and
  works inside overlays. Never remove focus outlines to "clean up" a control.
- **Hit targets:** interactive controls use the `--control-size-*` ladder. Dense
  desktop norms apply (not 44pt touch), but primary actions keep a comfortable
  target — avoid sub-16px hit areas for primary commands.
- **Keyboard parity:** every primary action is reachable by keyboard — command
  palette, Escape to close overlays, focus trap + restore in dialogs, navigation
  history via keys.
- **Reduced motion:** honor `prefers-reduced-motion`; never gate comprehension on
  an animation.
- **Dynamic type:** `--font-scale` scales the system; layout must reflow rather
  than clip when scaled up.
- **Color independence:** never encode state by color alone — pair with icon,
  weight, or text. Critical for status colors.
- **Screen reader:** controls carry accessible labels (`IconButton` requires
  one); menus, dialogs, and listboxes use correct roles.

## Cross-Platform Native Feel

**Tenon is an Electron app (TypeScript only — no Rust/Tauri/native shell).** There
is no native Swift/AppKit shell that owns the window. "Native feel" therefore
comes from Electron's platform-integration surface plus CSS — not from drawing
chrome in native code. macOS-first today; the same approach extends to Windows.

**Capability boundary (be honest about it).** Electron's `BrowserWindow` gives a
real OS material *behind* the window: `vibrancy` (NSVisualEffectView) on macOS,
and `backgroundMaterial` (acrylic/mica) on Windows later. On top of that, CSS
adds tint + `backdrop-filter`. This composition **approximates** Apple's Liquid
Glass; it is not the real thing. What it cannot do — and what the spec must not
promise — is refraction, lensing, specular edge highlights, or live per-element
native materials inside the WebView beyond `backdrop-filter`. Approximate with
blur + saturation + tint; never fake the rest with heavy shadows or gradients.

- **Use the OS material, don't hand-roll blur** where Electron exposes it
  (`vibrancy` / `backgroundMaterial`).
- **Neutral functional state on every platform** — a *deliberate trade-off*: we
  give up following the OS system accent (which a fully native app might adopt) in
  exchange for one consistent cross-platform Tenon brand. This is the resolution of
  the apparent tension between "Native over branded chrome" (principle 1) and "no
  system accent" (principle 3): we adopt the platform's *materials and
  conventions* while keeping our own restrained *color* identity. Precedent:
  Raycast and Finder both keep functional state neutral.
- **Respect window conventions.** macOS traffic lights are positioned via
  Electron `titleBarStyle` + `trafficLightPosition`, aligned to the top strip
  through shared geometry constants — never tune `BrowserWindow` and CSS
  positions independently. Windows caption buttons mirror to the right (future).
  Do not render one platform's window affordances on another.

Trade-off (name what we give up): Electron's runtime footprint is the cost of one
shared TypeScript/React/Electron codebase. We accept it for product velocity and
a single design language; we explicitly do **not** add a native shell, so
materials stay approximations within Electron's capabilities.
