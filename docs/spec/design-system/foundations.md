# Foundations

## Canonical Tokens

Use these default desktop tokens before adding component-specific values:

```css
:root {
  --font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-family-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --font-scale: 100%;
  --font-ui-2xs: 0.625rem; /* 10px */
  --line-ui-2xs-tight: 0.8125rem; /* 13px */
  --line-ui-2xs: 0.875rem; /* 14px */
  --font-ui-xs: 0.6875rem; /* 11px */
  --line-ui-xs: 0.9375rem; /* 15px */
  --line-ui-xs-relaxed: 1rem; /* 16px */
  --font-meta: 0.75rem; /* 12px */
  --line-meta-tight: 1.0625rem; /* 17px */
  --line-meta: 1.125rem; /* 18px */
  --font-ui-sm: 0.8125rem; /* 13px */
  --line-ui-sm-tight: 1.1875rem; /* 19px */
  --line-ui-sm: 1.25rem; /* 20px */
  --font-ui-md: 0.875rem; /* 14px */
  --line-ui-md: 1.375rem; /* 22px */
  --font-content: 0.9375rem; /* 15px */
  --line-content: 1.5rem; /* 24px */
  --font-description: var(--font-ui-sm);
  --line-description: 1.125rem; /* 18px */
  --font-heading-sm: 0.875rem; /* 14px */
  --line-heading-sm: 1.375rem; /* 22px */
  --font-heading-md: 1rem; /* 16px */
  --line-heading-md: 1.5rem; /* 24px */
  --font-heading-lg: 1.125rem; /* 18px */
  --line-heading-lg: 1.625rem; /* 26px */
  --font-heading-xl: 1.25rem; /* 20px */
  --line-heading-xl: 1.75rem; /* 28px */
  --font-heading-2xl: 1.5rem; /* 24px */
  --line-heading-2xl: 2rem; /* 32px */
  --font-panel-title: 1.625rem; /* 26px */
  --line-panel-title: 2.25rem; /* 36px */
  font-size: var(--font-scale);

  --app-bg: #fafafa; /* Zinc-50 */
  --panel-bg: #ffffff;
  --text-main: #09090b; /* Zinc-950 */
  --text-sub: #52525b; /* Zinc-600 */
  --text-muted: #a1a1aa; /* Zinc-400 */
  --text-strong: #1f1f22;
  --text-body: #29292d;
  --text-soft: #66666b;
  --text-faint: #8b8b91;
  --text-disabled: #c4c4c8;
  --row-hover: #f4f4f5; /* Zinc-100 */
  --row-selected: #f4f4f5; /* Zinc-100 */
  --border-subtle: #e4e4e7; /* Zinc-200 */
  --border-muted: #d4d4d8; /* Zinc-300 */
  --border-emphasis: rgba(9, 9, 11, 0.18);
  --border-strong: #9d9da3;
  --overlay-bg: var(--panel-bg);
  --overlay-active-bg: var(--row-selected);
  --overlay-shadow-level-1: 0 0 0 1px var(--border-subtle), 0 4px 12px -4px rgba(0, 0, 0, 0.08);
  --overlay-shadow-level-2: 0 0 0 1px var(--border-subtle), 0 12px 32px -8px rgba(0, 0, 0, 0.12);
  --outline-faint: inset 0 0 0 1px rgba(0, 0, 0, 0.035);
  --outline-subtle: inset 0 0 0 1px rgba(0, 0, 0, 0.055);
  --outline-muted: inset 0 0 0 1px rgba(9, 9, 11, 0.12);
  --outline-emphasis: inset 0 0 0 1px var(--border-emphasis);
  --outline-focus: inset 0 0 0 1px var(--focus-border);
  --outline-primary: inset 0 0 0 1px color-mix(in srgb, var(--accent-brand) 26%, transparent);
  --outline-primary-strong: inset 0 0 0 1px color-mix(in srgb, var(--accent-brand) 58%, var(--border-subtle));
  --underline-focus-shadow: inset 0 -1px 0 rgba(26, 26, 26, 0.18);
  --tag-focus-shadow: 0 0 0 2px color-mix(in srgb, var(--tag-text, currentColor) 22%, transparent);
  --shadow-thumb: 0 1px 2px rgba(0, 0, 0, 0.14);
  --shadow-thumb-strong: 0 1px 2px rgba(0, 0, 0, 0.18);

  --space-hairline: 1px;
  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 10px;
  --space-6: 12px;
  --space-7: 14px;
  --space-8: 16px;
  --space-micro: var(--space-2);
  --space-sm: var(--space-4);
  --space-md: var(--space-8);
  --space-lg: 24px;
  --space-xl: 32px;

  --layout-gap: var(--space-sm);
  --shell-padding-x: var(--layout-gap);
  --shell-padding-top: var(--layout-gap);
  --shell-padding-bottom: var(--layout-gap);
  --shell-gap: var(--layout-gap);
  --panel-gap: var(--layout-gap);

  --control-size-xs: 20px;
  --control-size-sm: 22px;
  --control-size-md: 24px;
  --control-size-lg: 26px;
  --control-size-xl: 28px;
  --control-size-2xl: 30px;
  --control-size-3xl: 32px;
  --icon-size-xs: 12px;
  --icon-size-sm: 14px;
  --icon-size-md: 16px;
  --icon-size-lg: 18px;

  --chrome-control-height: 26px;
  --chrome-height: calc(var(--layout-gap) + var(--chrome-control-height));
  --traffic-light-x: 13px;
  --traffic-light-y: 8px;

  --sidebar-width: 196px;
  --sidebar-min-width: 152px;
  --sidebar-max-width: 280px;
  --sidebar-collapsed-width: 0px;
  --sidebar-section-gap: 30px;

  --agent-width: 344px;
  --agent-min-width: 280px;
  --agent-max-width: 520px;
  --agent-collapsed-width: 0px;

  --outline-panel-min-width: 360px;
  --outline-panel-ideal-width: 520px;
  --panel-content-x: 28px;
  --panel-content-top: 10px;
  --panel-content-bottom: 30px;
  --panel-content-max: 720px;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xs: 2px;
  --radius-xs: 3px;
  --radius-control-xs: 5px;
  --radius-control-md: 7px;
  --radius-control-lg: 9px;
  --radius-overlay-sm: 10px;
  --radius-pill: 999px;
  --panel-radius: var(--radius-md);
  --agent-composer-radius: var(--radius-xl);
  --agent-composer-corner-inset: var(--space-3);
  --agent-composer-corner-radius: calc(var(--agent-composer-radius) - var(--agent-composer-corner-inset));
  --motion-fast: 120ms ease;
  --motion-layout: 160ms ease;

  --resize-gap: var(--panel-gap);
  --resize-hit-width: 10px;
  --resize-pill-width: 4px;
  --resize-pill-height: 32px;

  --tab-bg: transparent;
  --tab-active-bg: #e4e4e7; /* Zinc-200 */
  --control-hover: rgba(0, 0, 0, 0.055);
  --control-active: rgba(0, 0, 0, 0.08);
  --focus-border: rgba(9, 9, 11, 0.52);
  --focus-ring: rgba(9, 9, 11, 0.24);

  --accent-brand: #f43f5e; /* Rose-500, sparse brand/status indicator only */
  --accent-danger: #e11d48; /* Rose-600 */
  --semantic-success: #4cb27b; /* Sage-500 */
  --semantic-success-strong: #3f865d;
  --semantic-danger-muted: #9a3f34;
  --semantic-warning: #e9b43d; /* Mustard-500 */
  --semantic-info: #3288d0; /* Sapphire-500 */
  --surface-user-bubble: #dedfe2;
  --surface-inverse: #2e2e32;
  --surface-inverse-strong: #1f1f23;
  --surface-disabled: #d6d6da;

  --z-base: 0;
  --z-raised: 10;
  --z-popover: 100;
  --z-modal: 200;
  --z-toast: 300;
}
```

Token rules:

- Use the token scale before introducing a one-off pixel value.
- Shell outer insets, dock gaps, and panel-to-panel gaps use `--layout-gap` by
  default.
- `--layout-gap` should stay in the `4px` to `8px` range unless a dock is
  intentionally separated. Desktop defaults to `8px`.
- Panel surfaces use `--panel-radius` (`8px`). Larger radii are reserved for
  floating overlays or document preview containers, not outline panels.
- Resize boundaries use an `8px` gap with a centered `4px` visible pill. This
  leaves `2px` clearance on each side of the pill.

## Color

| Token group | Use |
| --- | --- |
| `--text-main`, `--text-sub`, `--text-muted` | Canonical product text hierarchy. |
| `--text-strong`, `--text-body`, `--text-soft`, `--text-faint`, `--text-disabled` | Dense neutral text states where the canonical three-step hierarchy is not precise enough. |
| `--app-bg`, `--panel-bg`, `--row-hover`, `--row-selected` | Workspace, panel, and row surfaces. |
| `--surface-user-bubble`, `--surface-inverse`, `--surface-inverse-strong`, `--surface-disabled` | Specific repeated surfaces that must remain visually stable. |
| `--accent-brand`, `--accent-danger`, `--semantic-*` | Sparse brand/status color. Do not use accent color for normal focus borders. |
| `--border-subtle`, `--border-muted`, `--border-emphasis`, `--border-strong` | Borders and dividers. Prefer spacing before adding a divider. |

Rules:

- Product CSS keeps raw hex colors inside token declarations only.
- Component CSS may use `rgba()` or `color-mix()` for alpha states, but the base
  color should come from a token whenever the value is semantic.
- Focus states use neutral focus tokens, not brand red, unless the state is an
  actual error or destructive action.

## Typography

| Token | Size | Line height | Use |
| --- | ---: | ---: | --- |
| `--font-ui-2xs` | 10px | 13-14px | Tiny counters, dense state labels, calendar weekday labels. |
| `--font-ui-xs` | 11px | 15-16px | Secondary metadata, payload labels, small captions. |
| `--font-meta` | 12px | 18px | Metadata, timestamps, process rows, tool summaries, compact debug labels. |
| `--font-ui-sm` | 13px | 20px | Sidebar navigation, tabs, context menus, dense secondary controls. |
| `--font-ui-md` | 14px | 22px | Main controls, dock titles, field configuration labels. |
| `--font-content` | 15px | 24px | Outliner rows, field values, agent assistant text, user bubbles, composer input. |
| `--font-description` | 13px | 18px | Node descriptions and compact explanatory text tied to a node. |
| `--font-panel-title` | 26px | 36px | `NodePanel` title editor only. |
| `--font-heading-*` | 14-24px | 22-32px | Markdown headings and section headings inside compact surfaces. |

Rules:

- Use the system sans stack for normal UI.
- Use the native monospace stack only for code, exact technical metrics,
  timestamps, and keyboard shortcuts.
- `--font-scale` is the single future user preference hook. Components reference
  semantic font tokens; they must not hard-code primary reading sizes directly.
- Do not scale font size with viewport width.
- Do not use oversized typography inside panels unless it is the real
  `NodePanel` title style.
- Primary text parity matters more than historical component defaults:
  outliner row text, field values, agent assistant prose, user bubbles, and the
  agent composer all use `--font-content / --line-content`.
- Non-token `font-size` and `line-height` declarations are only allowed for
  proportional rich-text marks, icon glyphs, `line-height: 1`, and inherited
  component internals.

## Radius

| Token | Value | Use |
| --- | ---: | --- |
| `--radius-2xs` | 2px | Precise inline marks and very small selection affordances. |
| `--radius-xs` | 3px | Tiny glyph boxes, code marks, and compact inline focus boxes. |
| `--radius-control-xs` | 5px | Small icon targets and narrow toolbar controls. |
| `--radius-sm` | 6px | Compact controls, menu rows, small chips, toolbar items. |
| `--radius-control-md` | 7px | Dense settings rows and existing compact controls that need slightly softer corners than `--radius-sm`. |
| `--radius-md` | 8px | Panels, cards, popovers, composer surface, primary product containers. |
| `--radius-control-lg` | 9px | Composer-internal controls whose corners must align optically with a parent `--radius-md` surface. |
| `--radius-overlay-sm` | 10px | Small floating overlays that need more separation than row controls. |
| `--radius-lg` | 12px | Larger modal/dialog surfaces or broad floating overlays. |
| `--radius-xl` | 16px | Large input surfaces with embedded corner controls, and rare immersive preview containers. |
| `--radius-pill` | 999px | True circles, status dots, switches, and fully rounded pills only. |

Rules:

- `--panel-radius` is the canonical workspace panel radius and currently maps
  to `--radius-md`.
- Nested controls must derive their radius from the parent where the corners
  need to visually align, such as the agent composer action slot.
- Corner containment is measured, not guessed: for a control anchored in a
  rounded parent corner, the horizontal inset and vertical inset must match, and
  the nested control radius is `parent radius - inset`. The agent composer uses
  this rule for the model, attachment, send, and stop controls. The parent
  radius must be large enough that the derived control radius still reads as a
  native-feeling rounded control, not a square button.
- Do not invent one-off radii for ordinary controls. A one-off value is only
  acceptable for precise icon glyph geometry or a measured interaction target.
- Avoid rounded nested cards. Repeated item cards may use `--radius-md`; dense
  row controls should usually use `--radius-sm`.

## Motion

| Token | Value | Use |
| --- | ---: | --- |
| `--motion-fast` | 120ms ease | Hover, opacity, icon transform, and compact state changes. |
| `--motion-layout` | 160ms ease | Layout column changes and shell-level size transitions. |

Rules:

- Product CSS must not introduce raw `ms` values. Add a named motion token
  first, then use it from components.
- Motion should clarify state, not decorate the workspace. Avoid chained
  animations that compete with typing or outline navigation.

## Elevation

| Token | Use |
| --- | --- |
| `--overlay-shadow-level-1` | Menus, popovers, and compact floating surfaces. |
| `--overlay-shadow-level-2` | Dialogs and higher-level overlays. |
| `--outline-faint` / `--outline-subtle` / `--outline-muted` | Inset outline variants for composed controls. |
| `--outline-focus` | Focus state for controls that use inset outlines instead of external rings. |
| `--shadow-thumb` / `--shadow-thumb-strong` | Switch thumbs and small draggable affordances. |

Rules:

- Use elevation only to show stacking or interaction state. Do not use shadows
  as decoration inside ordinary outline rows.
- Product CSS should reference elevation and outline tokens instead of writing
  raw `box-shadow` values.

## Sizing

| Token | Value | Use |
| --- | ---: | --- |
| `--control-size-xs` | 20px | Very compact toolbar targets and small row affordances. |
| `--control-size-sm` | 22px | Small icon buttons in dense rows. |
| `--control-size-md` | 24px | Default compact controls. |
| `--control-size-lg` | 26px | Chrome controls and common toolbar targets. |
| `--control-size-xl` | 28px | Larger panel controls and row action targets. |
| `--control-size-2xl` | 30px | Switches and wider compact controls. |
| `--control-size-3xl` | 32px | Larger square action targets. |
| `--icon-size-xs` | 12px | Tiny status and metadata icons. |
| `--icon-size-sm` | 14px | Compact UI icons. |
| `--icon-size-md` | 16px | Default UI icons. |
| `--icon-size-lg` | 18px | Prominent toolbar icons. |

Rules:

- Prefer the control and icon size tokens for repeated UI targets.
- Outliner geometry values such as bullet columns, chevron columns, and resize
  handles remain measured layout tokens because they define alignment, not
  visual style.

## Spacing

| Token | Value | Use |
| --- | ---: | --- |
| `--space-hairline` | 1px | Border-like gaps and dense list separators only. |
| `--space-1` | 2px | Optical nudges and paired corner insets. |
| `--space-2` | 4px | Micro gaps, icon/text breathing room. |
| `--space-3` | 6px | Compact row padding and small control gaps. |
| `--space-4` | 8px | Default shell gaps, dock insets, panel gaps. |
| `--space-5` | 10px | Slightly larger dense padding. |
| `--space-6` | 12px | Compact card/content padding. |
| `--space-7` | 14px | Transitional value for existing dense surfaces. |
| `--space-8` | 16px | Standard content section padding. |
| `--space-lg` | 24px | Large vertical groups and section separation. |
| `--space-xl` | 32px | Page-level section separation. |

Rules:

- Layout surfaces use semantic aliases first: `--layout-gap`,
  `--shell-padding-*`, `--panel-gap`, `--agent-dock-inset-x`, and
  `--panel-content-*`.
- Component internals use the numeric space scale before introducing a new
  literal pixel value.
- One-off spacing is allowed only when it is a measured geometry constraint,
  such as outliner leading columns, bullet centers, resize hit width, or
  calendar cell geometry.
- Dense UIs should reduce hierarchy through text color and spacing, not through
  extra borders or decorative cards.

## Color

Neutral color should carry most UI hierarchy. Rose is not the everyday active
state.

- App background: `--app-bg`.
- Panel background: `--panel-bg`.
- Active navigation rows use neutral gray, not brand color.
- Solid Rose-600 is reserved for destructive actions and high-severity alerts.
- Rose-500 may be used sparingly for brand dots, temporary agent indicators, or
  active recording/status dots.
- Warning uses Mustard, not Rose.
- Success uses Sage.
- Info uses Sapphire.

User-defined tag palette:

| Name | Text | Background |
| --- | --- | --- |
| Red | `#e11d48` | `#fff1f2` |
| Orange | `#ea580c` | `#fff7ed` |
| Yellow | `#ca8a04` | `#fefce8` |
| Green | `#059669` | `#ecfdf5` |
| Blue | `#2563eb` | `#eff6ff` |
| Purple | `#9333ea` | `#faf5ff` |
| Pink | `#db2777` | `#fdf2f8` |
| Gray | `#475569` | `#f8fafc` |

## Elevation And Layering

Lin uses low elevation. Panels are structural surfaces, not floating cards.

- Outline panels: no decorative shadow; use background and optional subtle active
  outline.
- Level 1 float: `0 4px 12px -4px rgba(0, 0, 0, 0.08)` for menus and tooltips.
- Level 2 overlay: `0 12px 32px -8px rgba(0, 0, 0, 0.12)` for command palette,
  modals, and approval overlays.
- Popover and menu background: `--overlay-bg`, which defaults to
  `--panel-bg`.
- Popover and menu active row: `--overlay-active-bg`, which defaults to the
  neutral selected row token, not the theme accent.
- Semantic glow: only for live status dots such as recording or streaming.

Stacking order:

- Base shell and panels: `--z-base`.
- Raised transient panel internals: `--z-raised`.
- Popovers, context menus, trigger menus: `--z-popover`.
- Modal dialogs and command palette: `--z-modal`.
- Toasts or global status overlays: `--z-toast`.

Overlays should render through a shared shell-level overlay host to avoid panel
clipping and stacking conflicts.

## Scrollbars

Scrollbars are product infrastructure, not decorative chrome.

- Scrollbars stay visible when a region can scroll; do not hide them globally.
- Use thin neutral thumbs with transparent tracks.
- Scroll containers reserve gutter space where possible so the thumb does not
  cover text, row controls, or debug/code output.
- Avoid dark, thick, platform-default scrollbars inside panels, popovers, debug
  inspectors, composer menus, and long code/tool blocks.

## Motion

- Hover/color transitions: `100ms` to `150ms`.
- Dock collapse, modal entrance, or panel layout transitions: `150ms` to
  `220ms`.
- Prefer `cubic-bezier(0.4, 0, 0.2, 1)` for layout transitions and standard
  `ease` for simple color transitions.
- Respect `prefers-reduced-motion: reduce` by disabling nonessential movement.

## Accessibility

- Text and meaningful icons must meet WCAG AA contrast for their size.
- Icon-only buttons need accessible names.
- Keyboard focus must be visible with `:focus-visible`; do not remove the focus
  ring without a replacement.
- Resize handles must expose accessible labels. Keyboard resizing should be
  supported before resize is considered complete.
- Collapsed/expanded controls use `aria-pressed` or `aria-expanded` as
  appropriate.
- Disabled controls use actual `disabled` when they cannot act.
- Color-coded tags and statuses must have text labels or accessible names.
- Hit targets for dense desktop controls may be visually small, but pointer hit
  areas should be at least `24px` where possible.
