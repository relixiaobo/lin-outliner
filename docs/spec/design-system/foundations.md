# Foundations

## Canonical Tokens

Use these default desktop tokens before adding component-specific values:

```css
:root {
  --font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-family-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

  --app-bg: #fafafa; /* Zinc-50 */
  --panel-bg: #ffffff;
  --text-main: #09090b; /* Zinc-950 */
  --text-sub: #52525b; /* Zinc-600 */
  --text-muted: #a1a1aa; /* Zinc-400 */
  --row-hover: #f4f4f5; /* Zinc-100 */
  --row-selected: #f4f4f5; /* Zinc-100 */
  --border-subtle: #e4e4e7; /* Zinc-200 */
  --border-muted: #d4d4d8; /* Zinc-300 */
  --overlay-bg: var(--panel-bg);
  --overlay-active-bg: var(--row-selected);
  --overlay-shadow-level-1: 0 0 0 1px var(--border-subtle), 0 4px 12px -4px rgba(0, 0, 0, 0.08);

  --space-micro: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;

  --layout-gap: var(--space-sm);
  --shell-padding-x: var(--layout-gap);
  --shell-padding-top: var(--layout-gap);
  --shell-padding-bottom: var(--layout-gap);
  --shell-gap: var(--layout-gap);
  --panel-gap: var(--layout-gap);

  --chrome-control-height: 26px;
  --chrome-height: calc(var(--layout-gap) + var(--chrome-control-height));
  --traffic-light-x: 13px;
  --traffic-light-y: 8px;

  --sidebar-width: 196px;
  --sidebar-min-width: 152px;
  --sidebar-max-width: 280px;
  --sidebar-collapsed-width: 0px;

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
  --panel-radius: var(--radius-md);

  --resize-gap: var(--panel-gap);
  --resize-hit-width: 10px;
  --resize-pill-width: 4px;
  --resize-pill-height: 32px;

  --tab-bg: transparent;
  --tab-active-bg: #e4e4e7; /* Zinc-200 */
  --control-hover: rgba(0, 0, 0, 0.055);
  --control-active: rgba(0, 0, 0, 0.08);
  --focus-ring: rgba(9, 9, 11, 0.24);

  --accent-brand: #f43f5e; /* Rose-500, sparse brand/status indicator only */
  --accent-danger: #e11d48; /* Rose-600 */
  --semantic-success: #4cb27b; /* Sage-500 */
  --semantic-warning: #e9b43d; /* Mustard-500 */
  --semantic-info: #3288d0; /* Sapphire-500 */

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

## Typography

| Token | Size | Line height | Use |
| --- | ---: | ---: | --- |
| `xs` | 12px | 16px | Metadata, tags, badges, tooltips, timestamps. |
| `sm` | 13px | 20px | Sidebar navigation, tabs, context menus, descriptions. |
| `base` | 14px | 24px | Main controls, inputs, agent messages, default body text. |
| `lg` | 16px | 24px | Emphasized text or agent subheaders. |
| `xl` | 20px | 28px | Empty-state titles or secondary panel headers. |
| `2xl` | 24px | 32px | Primary top-level panel titles. |

Rules:

- Use the system sans stack for normal UI.
- Use the native monospace stack only for code, exact technical metrics,
  timestamps, and keyboard shortcuts.
- Do not scale font size with viewport width.
- Do not use oversized typography inside panels unless it is the real
  `NodePanel` title style.
- Sidebar items and workspace tabs use `13px`. Outliner rows are an explicit
  product exception: row text uses `15px / 24px`, panel title uses
  `26px / 36px`, and descriptions use `13px / 18px`.

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
