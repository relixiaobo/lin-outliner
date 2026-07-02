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
| `CheckboxMark` | `CheckboxMark.tsx` | Decorative `16px` checkbox mark with `3px` radius. Unchecked is outlined; checked uses `--control-on` with a fixed-white check glyph (`--text-on-accent`, theme-independent). Does not own row behavior or persistence. |
| `CheckboxControl` | `CheckboxControl.tsx`, `AgentSettingsView.tsx` | Labeled native checkbox wrapper for settings/forms. Keeps native checkbox semantics and `CheckboxMark` visual together. |
| `SwitchControl` / `SwitchMark` | `SwitchControl.tsx`, `SwitchMark.tsx`, `DefinitionConfigControls.tsx`, `AgentSettingsView.tsx`, `AgentEditor.tsx`, `DateValuePicker.tsx` | Semantic switch wrapper plus shared `30px x 18px` track and `14px` thumb. Does not own labels or persistence. |
| `IconButton` | `IconButton.tsx` | Icon-first button with explicit accessible label and tokenized icon size. Visual variant stays caller-owned. |
| `MenuSurface` | `MenuSurface.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx` | Shared menu/popover wrapper. Caller owns role, positioning, keyboard navigation, filtering, and execution. Edge separation comes from pure overlay shadow, not border. |
| `MenuItem` | `MenuItem.tsx`, command/menu rows | Stable row contract for icon, label, metadata, active, disabled, selected, and danger states. |
| `useAnchoredOverlay` / `AnchoredActionMenu` | `useAnchoredOverlay.ts`, `AnchoredActionMenu.tsx` | Viewport-aware anchored positioning, shared action-menu shell, and outside-dismissal wiring. Does not own menu contents or commands. |
| `PopoverListbox` | `PopoverList.tsx`, trigger/option/tag/reference/slash popovers | Listbox shell and option item structure. Active index and filtering remain caller-owned. |
| `Dialog` | `Dialog.tsx`, `ConfirmDialog.tsx`, `CommandPalette.tsx` | Modal shell with label linkage, Escape handling, focus trap, initial focus, and focus restoration. |
| `Button` | `Button.tsx`, `styles/button.css` | Shared text/action button primitive. `primary` is the neutral filled-default idiom (`--surface-inverse` + `--panel-bg`), `secondary` is neutral filled, `ghost` is transparent until hover, and `danger` carries danger text or a solid danger fill only for destructive confirmation. It owns visual state and default `type="button"`; callers own command behavior. |
| `ButtonControl` | `ButtonControl.tsx` | Low-level native button wrapper with default `type="button"` and ref forwarding. Use it for icon-only or highly custom controls whose visual contract is owned by the surrounding component. |
| `Input` / `Textarea` / `Field` | `Input.tsx`, `Textarea.tsx`, `Field.tsx`, `styles/input.css` | Shared form-control skin. `boxed` is the tokenized neutral control surface, `bare` inherits the surrounding inset-row focus model. `Field` is the single label/control wrapper: it can provide the default field stack, or accept caller layout classes for inset rows. Helper text, parsing, draft/commit behavior, and validation stay caller-owned. |
| `SelectControl` | `SelectControl.tsx` | Native select wrapper. `plain` stays caller-styled, `popup` is the compact settings pop-up control, and `boxed` / `bare` share the `Input` visual skin with a passive chevron affordance. Options and value coercion stay caller-owned. |
| `FeedbackState` | `FeedbackState.tsx`, `styles/feedback-state.css` | Shared quiet empty/loading/error state. It reserves a stable inline or panel slot, uses muted neutral text by default, spins only for loading, honors reduced motion, and pairs error color with text/icon/action rather than color alone. |
| `TextInputControl` / `NumberInputControl` | `TextInputControl.tsx`, `NumberInputControl.tsx` | Legacy thin native wrappers retained for specialized call sites during migration. New shared form surfaces use `Input` / `Textarea`. |
| `PanelSurface` | `WorkspacePanelSurface.tsx` | Opaque content pane (`--bg-content`), flush within the content base — no card radius, no gap. Panes are divided by a 1px `--separator` (the resize handle), not a per-pane border. Active pane indication is a subtle neutral control-state cue, never a box outline. |
| `ResizeHandle` | `ResizeHandle.tsx` | Shared resize button structure. Pointer behavior stays in `useResizableLayout`. |
| `AppliedTag` | `AppliedTag.tsx` | Fixed measured tag pill using tag palette background/text colors. Hover/focus must not shift row width. |
