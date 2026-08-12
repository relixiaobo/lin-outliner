# Tenon Design System Components

This file owns reusable UI primitives. Component contracts define structure,
state, semantics, and non-goals; product behavior stays with the owning surface.
Start at the [design-system kernel](../design-system.md) for product principles,
decision routing, exceptions, and validation.

## Components

Components are thin contracts. They should define structure, state, semantics,
and non-goals; product behavior stays with the owning surface.

| Component | Sources | Contract |
| --- | --- | --- |
| `CheckboxMark` | `CheckboxMark.tsx` | Decorative `16px` checkbox mark with `3px` radius. Unchecked is outlined; checked uses `--control-on` with a fixed-white check glyph (`--text-on-accent`, theme-independent). Does not own row behavior or persistence. See [Form Controls](#form-controls). |
| `CheckboxControl` | `CheckboxControl.tsx` | Labeled native checkbox wrapper for settings/forms. Keeps native checkbox semantics and `CheckboxMark` visual together. See [Form Controls](#form-controls). |
| `SwitchControl` / `SwitchMark` | `SwitchControl.tsx`, `SwitchMark.tsx`, `DefinitionConfigControls.tsx`, `SettingsProvidersSection.tsx`, `SettingsSkillLibrarySection.tsx`, `SettingsPreviewSection.tsx`, `MemorySettingsGroup.tsx`, `DateValuePicker.tsx` | Semantic switch wrapper plus shared `30px x 18px` track and `14px` thumb. Does not own labels or persistence. See [Form Controls](#form-controls). |
| `IconButton` | `IconButton.tsx` | Icon-first button with explicit accessible label and tokenized icon size. Visual variant stays caller-owned. See [Buttons And Icon Controls](#buttons-and-icon-controls). |
| `MenuSurface` | `MenuSurface.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx` | Shared menu/popover wrapper. Caller owns role, positioning, keyboard navigation, filtering, and execution. Edge separation comes from pure overlay shadow, not border. See [Overlays](#overlays). |
| `MenuItem` | `MenuItem.tsx`, command/menu rows | Stable row contract for icon, label, metadata, active, disabled, selected, and danger states. See [Overlays](#overlays). |
| `useAnchoredOverlay` / `AnchoredActionMenu` | `useAnchoredOverlay.ts`, `AnchoredActionMenu.tsx` | Viewport-aware anchored positioning, shared action-menu shell, and outside-dismissal wiring. Does not own menu contents or commands. See [Overlays](#overlays). |
| `PopoverListbox` / `PopoverListItem` / `PopoverEmpty` | `PopoverList.tsx`, trigger/option/tag/reference/slash popovers | Listbox shell, option item structure, and empty-list state. Active index and filtering remain caller-owned. See [Overlays](#overlays). |
| `Dialog` / `ConfirmDialog` | `Dialog.tsx`, `ConfirmDialog.tsx` | Modal shell with label linkage, Escape handling, focus trap, initial focus, and focus restoration. `ConfirmDialog` is the confirmation wrapper over `Dialog`. See [Overlays](#overlays). |
| `Button` | `Button.tsx`, `styles/button.css` | Shared text/action button primitive. `primary` is the neutral filled-default idiom (`--surface-inverse` + `--bg-content`), `secondary` is neutral filled, `ghost` is transparent until hover, and `danger` carries danger text or a solid danger fill only for destructive confirmation. It owns visual state and default `type="button"`; callers own command behavior. See [Buttons And Icon Controls](#buttons-and-icon-controls). |
| `ButtonControl` | `ButtonControl.tsx` | Low-level native button wrapper with default `type="button"` and ref forwarding. Use it for icon-only or highly custom controls whose visual contract is owned by the surrounding component. See [Buttons And Icon Controls](#buttons-and-icon-controls). |
| `Input` / `Textarea` / `Field` | `Input.tsx`, `Textarea.tsx`, `Field.tsx`, `styles/input.css` | Shared form-control skin. `boxed` is the tokenized neutral control surface, `bare` inherits the surrounding inset-row focus model. `Field` is the single label/control wrapper: it can provide the default field stack, or accept caller layout classes for inset rows. Helper text, parsing, draft/commit behavior, and validation stay caller-owned. See [Form Controls](#form-controls). |
| `SelectControl` | `SelectControl.tsx` | Native select wrapper. `plain` stays caller-styled, `popup` is the compact settings pop-up control, and `boxed` / `bare` share the `Input` visual skin with a passive chevron affordance. Options and value coercion stay caller-owned. See [Form Controls](#form-controls). |
| `SegmentedControl` | `SegmentedControl.tsx` | Compact mutually-exclusive option group with roving tabindex and neutral selected fill. Caller owns options, persistence, and any value coercion. See [Form Controls](#form-controls). |
| `FeedbackState` / `EmptyState` / `ErrorState` | `FeedbackState.tsx`, `styles/feedback-state.css` | Shared quiet empty/loading/error state. It reserves a stable inline or panel slot, uses muted neutral text by default, spins only for loading, honors reduced motion, and pairs error color with text/icon/action rather than color alone. `EmptyState` and `ErrorState` are the JSX exports. See [patterns.md → Content & States](./patterns.md#content--states). |
| `WorkingText` | `WorkingText.tsx`, `styles/working-text.css` | Text-only active-work primitive. Its normal-flow base is the sole accessible copy; an absolute pointer-inert `aria-hidden` duplicate carries a paint-contained, background-clipped cadenced sweep. It does not animate transforms, masks, or a parent material surface. Optional truncation applies identical width, white-space, overflow, and ellipsis rules to both copies. Reduced motion and increased contrast remove the duplicate treatment, while the caller retains semantic identity and a static in-progress cue. See [patterns.md → Content & States](./patterns.md#content--states). |
| `TextInputControl` / `NumberInputControl` | `TextInputControl.tsx`, `NumberInputControl.tsx` | Legacy thin native wrappers retained for specialized call sites during migration. New shared form surfaces use `Input` / `Textarea`. See [Form Controls](#form-controls). |
| `InsetGroup` / `InsetRow` / `SettingsRowMenu` | `SettingsInsetList.tsx`, `SettingsRowMenu.tsx`, `styles/settings-inset-list.css` | Grouped preference-list primitive: sentence-case section header, one rounded elevated card, content-aligned row separators, split row main/trailing interaction, and an optional `...` row action menu. Product copy, row selection, persistence, and action contents stay caller-owned. See [Inset Groups And Rows](#inset-groups-and-rows). |
| `PanelSurface` / `WorkspacePanelSurface` | `WorkspacePanelSurface.tsx` | Opaque content pane (`--bg-content`), flush within the content base — no card radius, no gap. Panes are divided by a 1px `--separator` (the resize handle), not a per-pane border. Active pane indication is a subtle neutral control-state cue, never a box outline. `WorkspacePanelSurface` is the JSX implementation. See [surfaces.md → Workspace And Panels](./surfaces.md#workspace-and-panels). |
| `ResizeHandle` | `ResizeHandle.tsx` | Shared resize button structure. Pointer behavior stays in `useResizableLayout`. See [surfaces.md → Workspace And Panels](./surfaces.md#workspace-and-panels). |
| `AppliedTag` | `AppliedTag.tsx` | Fixed measured tag pill using tag palette background/text colors. Hover/focus must not shift row width. See [patterns.md → Tag Hover](./patterns.md#tag-hover). |

## Contract Shape

Every reusable component contract answers the same questions:

- **Anatomy:** stable slots, measured areas, and which slots may contain
  interactive children.
- **State:** rest, hover, pressed, selected, focus, disabled, loading, and error
  mappings to [patterns.md → Interaction States](./patterns.md#interaction-states).
- **Tokens:** foundation tokens or component-private tokens derived from them.
- **Accessibility:** role, label, keyboard behavior, focus ownership, and focus
  restoration where relevant.
- **Non-goals:** product behavior, persistence, parsing, or command execution
  that must stay with the owning surface.

## High-Leverage Contracts

### Buttons And Icon Controls

`Button` owns text/action-button visual state. `primary` is the neutral
filled-default idiom (`--surface-inverse` / `--surface-inverse-strong`), not a
brand action; `secondary` is a neutral filled push button; `ghost` is transparent
until hover; `danger` uses danger text or a solid danger fill only for destructive
confirmation. `ButtonControl` owns only native button semantics and ref forwarding
for bespoke controls.

`IconButton` and icon-only chrome controls use an accessible label, fixed icon
slot, and colour-deepen feedback. They do not gain a rounded-square hover box; if
a fill is genuinely needed, it is circular or pill-shaped and scoped to the open
or selected affordance.

### Overlays

`MenuSurface`, `MenuItem`, `PopoverListbox`, `AnchoredActionMenu`,
`useAnchoredOverlay`, and `Dialog` form the overlay stack:

- Menus/popovers use the level-1 elevated-overlay tier:
  `--material-popover`, `--material-backdrop`, level-1 shadow, and no real outer
  border.
- Dialogs use the opaque elevated tier:
  `--bg-elevated` plus level-2 shadow.
- Menu rows reserve stable slots for icon, label, metadata, active/selected,
  disabled, and danger states. Row hover stays neutral.
- Escape closes overlays; non-modal popovers close on outside pointer down;
  dialogs trap focus, restore focus on close, and keep focus-visible rings inside
  the overlay.
- Tooltips are read-only names for controls on the level-1 elevated-overlay
  tier: small `--material-popover` + `--material-backdrop` surfaces,
  `--font-meta`, level-1 shadow, hover/focus reveal, instant dismiss, no action
  content. Reduced-transparency mode makes the material opaque. Pointer-delayed
  previews are a separate inline/file-preview pattern, not the general tooltip
  contract.

### Form Controls

`Input`, `Textarea`, `Field`, and `SelectControl` own shared form chrome.
`boxed` uses the neutral control surface, `bare` inherits row/inset focus, and
`popup` select renders as compact transparent-at-rest text chrome with a passive
chevron. Parsing, validation, draft/commit, option filtering, and persistence
stay with the caller.

Text controls show keyboard focus only after keyboard navigation. Borderless
fields inside clipped inset cards move focus to the row with `:focus-within` so
the ring is not clipped.

### Inset Groups And Rows

`SettingsInsetList.tsx` (`InsetGroup` + `InsetRow`) and `SettingsRowMenu.tsx` are
the grouped-list primitive for preference-like surfaces. They render a
sentence-case section header above one rounded `--bg-elevated` card whose rows
are split by content-aligned hairlines. Rows use `--row-h-comfortable`, text-led
layout, optional non-interactive `leading`, `label`, optional `sublabel`, and a
sibling `trailing` interactive control. A switch/select/segmented control never
nests inside the row button.

Inset rows carry no row-wide hover fill by default. Hover or keyboard focus
reveals the row action affordance (`Configure`, `...`, etc.); selected/focused
states stay neutral and fill the whole row. The card uses inset focus rings so
keyboard focus remains visible inside `overflow: hidden`.

### Inline References

Inline references render as text-flow links, not chips. Node references are plain
text; local file/directory/image references add one leading monochrome masked icon
from `inlineFileIcon.ts`, painted with `currentColor`, and keep icon + first name
segment together. Render sites must not invent a second inline-file species.

Path-backed local-file refs expose shared preview metadata, open the Tenon preview
surface through the preload/main bridge, and use `preview-local://` or `asset://`
stream URLs. Renderer code consumes only the shared `streamUrl`; it must not
navigate to `file://`, read local bytes, or call `openExternal` for file paths.

### File Preview Frame And HUD

File previews use one rounded viewport with a token inset on every side, an inset
hairline edge, and concentric inner document-page corners. Preview pages scroll
inside the viewport content box; pages never render into the frame inset. The
bottom-center preview action bar is a fixed-width primary capsule plus a separate
circular `...` action, never a segmented control. It uses the shared
`--media-hud-*` fixed-contrast pair plus the file-preview-only
`--preview-action-shadow` because it floats over arbitrary document/image pixels.
Only these registered preview actions add `--material-backdrop`; compact media-HUD
consumers such as gallery count badges keep the shared contrast pair without blur
or preview elevation.

External document pixels may force a light document canvas inside the preview
iframe/page renderer. That exception is confined to document pixels; preview
chrome, overlays, selection handles, and HUD controls stay tokenized.

### Activity And Disclosure Rows

Process summaries, tool-call disclosures, run activity rows, and similar compact
status rows reserve one measured disclosure/status slot. Labels must not jump
between rest, hover, focus, loading, and expansion. Stop/close actions in dense
rows default to unboxed icon controls whose glyph colour deepens on hover/focus.
Active tool and Subagent rows retain their semantic glyph and apply
`WorkingText` only to the advancing action/status phrase; an in-progress tool
action also uses stronger neutral colour at the same weight as its metric-stable
non-motion cue. A collapsed running group owns
the sweep on its summary, while expansion freezes that summary and transfers the
sweep to its running members. Finished members remain static.
Turn-local Plan progress uses the same compact status register above the
composer; its level-1 checklist popover appears on hover or summary activation
without moving the composer or transcript. The summary is a disclosure button;
the open popover is focusable and scrollable, and Escape restores summary focus.
An incomplete closed summary keeps the Plan glyph and moves only its text; an
open Plan is entirely static, with its current step identified by strong 600
weight text, a neutral filled dot, and `aria-current="step"`. Completed steps use
the check glyph and pending steps use a hollow dot.
