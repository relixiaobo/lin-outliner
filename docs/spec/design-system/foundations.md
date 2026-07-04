# Tenon Design System Foundations

This file owns Tenon's foundation layer: tokens, colour, material, typography,
spacing, elevation, radius, icon, and motion contracts. Start at the
[design-system kernel](../design-system.md) for product principles, decision
routing, exceptions, and validation.

## Foundations

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
  --font-content: 1rem; /* 16px */
  --line-content: 1.625rem; /* 26px */
  --font-code-inline: 0.875em;
  --line-code-inline: 1.18;
  --font-code-block: var(--font-ui-sm); /* 13px */
  --line-code-block: var(--line-ui-sm); /* 20px */
  --content-control-height: var(--line-content);
  --font-description: var(--font-ui-sm);
  --line-description: 1.125rem; /* 18px */
  /* One large heading size (markdown h1); h2/h3 reuse --font-content (16) and
     --font-ui-md (14) rather than a parallel heading ladder. */
  --font-heading-lg: 1.125rem; /* 18px */
  --line-heading-lg: 1.625rem; /* 26px */
  --font-panel-title: 1.5rem; /* 24px — top of the type scale */
  --line-panel-title: 2rem; /* 32px */
  --title-display: var(--font-panel-title);
  --title-section: var(--font-heading-lg);
  --title-group: var(--font-ui-sm);
  font-size: var(--font-scale);

  color-scheme: light dark;

  /* ── Ink: the single per-theme base for every alpha-on-base colour. Flip this
        one channel triple in dark mode and all the text/fill/separator levels
        below follow. (macOS uses black ink in light, white ink in dark.) ── */
  --ink: 0 0 0;

  /* ── Text (label) levels — alpha on --ink, identical alphas in both themes ── */
  --text-primary: rgb(var(--ink) / 0.88);    /* primary text + glyphs */
  --text-secondary: rgb(var(--ink) / 0.55);  /* subtitles, secondary labels */
  --text-tertiary: rgb(var(--ink) / 0.30);   /* placeholders, faint meta */
  --text-quaternary: rgb(var(--ink) / 0.16); /* watermark, disabled */

  /* ── Neutral fills — control / hover / active / selection backgrounds. These
        are the everyday functional surfaces. NOT brand, NOT system accent. ── */
  --fill-1: rgb(var(--ink) / 0.04);  /* subtle hover */
  --fill-2: rgb(var(--ink) / 0.07);  /* hover, resting control */
  --fill-3: rgb(var(--ink) / 0.10);  /* active / selected row */
  --fill-4: rgb(var(--ink) / 0.16);  /* pressed / strong */

  /* ── Separators ── */
  --separator: rgb(var(--ink) / 0.10);  /* hairline, lets backdrop blend */
  --separator-opaque: #d8d8dc;          /* solid divider (per-theme) */

  /* ── Opaque surfaces (literal per-theme values) ── */
  --bg-window: #ececec;   /* window/chrome base behind the OS material */
  --bg-content: #ffffff;  /* opaque content panel — never translucent */
  --bg-elevated: #ffffff; /* menus/popovers/HUD — float above content. In light
                             this equals content (macOS light menus are white);
                             elevation reads through the drop shadow. Dark mode
                             lightens it past content so it reads as forward. */

  /* ── Materials: translucent chrome tint, layered over the OS vibrancy
        (Electron) + backdrop-filter. Chrome only — never the content layer.
        There is no toolbar material: the top strip is transparent over the
        content base and inherits a rail's material only where it crosses one. ── */
  --material-sidebar: rgba(246, 246, 246, 0.60); /* the floating-rail material */
  --material-popover: rgba(250, 250, 250, 0.80);
  --material-blur: 30px;        /* constant blur radius for every glass surface */
  --material-saturate: 112%;    /* slight saturation lift under the blur */
  --material-backdrop: blur(var(--material-blur)) saturate(var(--material-saturate));
  --rail-edge: rgb(var(--ink) / 0.10); /* 0.5px inset hairline on the glass rail */
  /* File-preview HUD controls float over arbitrary document pixels, so they own
     a contrast pair instead of using the app-surface fill ladder. */
  --preview-action-bg: rgba(46, 46, 50, 0.78);
  --preview-action-hover-bg: rgba(31, 31, 35, 0.88);
  --preview-action-fg: rgba(255, 255, 255, 0.94);
  --preview-action-outline: rgba(255, 255, 255, 0.12);

  /* ── Selection & focus = NEUTRAL (Raycast/Finder model). Functional state is
        never the brand colour and never the system accent. ── */
  --selection-bg: var(--fill-3);    /* selected row */
  --selection-soft: var(--fill-2);  /* multi-select / range / hover */
  --focus-ring: rgb(var(--ink) / 0.45);
  --focus-ring-shadow: 0 0 0 2px rgb(var(--ink) / 0.22);
  --focus-ring-shadow-inset: inset var(--focus-ring-shadow);
  /* Editor text-selection highlight (::selection): NEUTRAL, not the system
     accent and not rose — a touch stronger than a selected row so glyphs stay
     legible through it. Glyph colour is unchanged under selection. */
  --text-selection-bg: rgb(var(--ink) / 0.14);
  --document-selection-bg: rgba(0, 0, 0, 0.30);
  --drop-line: var(--focus-ring); /* neutral drag insertion line */

  /* ── Accent = brand rose, used SPARSELY: text caret, brand marks, small
        status badges. Never selection, focus, active rows, default actions,
        and no longer links. ── */
  --accent: #f43f5e;
  --accent-strong: #e11d48;
  --caret: var(--accent);
  --text-on-accent: #ffffff;
  /* ── Link = native macOS link blue (the FIXED linkColor, not the variable
        system accent). Decoupled from the brand rose so clickable text reads as
        a link, not an error — rose sat too near --status-danger. Exactly one
        link colour; theme-adapted by the dark override. ── */
  --link: #0a66d6;
  --link-hover: color-mix(in srgb, var(--link) 78%, var(--text-primary));

  /* ── Status ── */
  --status-success: #3f9e6a;
  --status-success-strong: #3f865d;
  --status-warning: #d99a1c;
  --status-danger: #e5484d;
  --status-danger-solid-hover: color-mix(in srgb, var(--status-danger) 88%, #000000);
  --status-danger-muted: #9a3f34;
  --status-info: #3b82c4;
  --control-on: #3f9e6a; /* checked/on controls, not semantic status */

  /* ── Identity / categorical visualization tints ── */
  --identity-tint-0: #e11d48;
  --identity-tint-1: #ea580c;
  --identity-tint-2: #ca8a04;
  --identity-tint-3: #059669;
  --identity-tint-4: #0d9488;
  --identity-tint-5: #2563eb;
  --identity-tint-6: #7c3aed;
  --identity-tint-7: #db2777;
  --usage-input: var(--identity-tint-5);
  --usage-output: var(--identity-tint-6);
  --usage-cache-read: var(--identity-tint-3);
  --usage-cache-write: var(--identity-tint-2);

  /* ── Inline code / highlighted prose ── */
  --inline-code-bg: rgb(var(--ink) / 0.06);
  --highlight-mark: rgba(247, 236, 139, 0.6);

  /* ── Elevation: drop shadows scale; outlines/dividers are alpha-on-ink so they
        invert with the theme instead of staying black ── */
  --overlay-bg: var(--bg-elevated);
  --overlay-active-bg: var(--fill-2);
  /* Elevation tiers, softest → strongest: rail (floating chrome) < level-1
     (menus/popovers) < level-2 (dialogs). */
  --shadow-rail: 0 8px 26px -10px rgba(0, 0, 0, 0.26), 0 1px 3px rgba(0, 0, 0, 0.10);
  --overlay-shadow-level-1: 0 8px 20px -12px rgba(0, 0, 0, 0.22), 0 2px 8px -4px rgba(0, 0, 0, 0.10);
  --overlay-shadow-level-2: 0 18px 48px -20px rgba(0, 0, 0, 0.24), 0 6px 18px -10px rgba(0, 0, 0, 0.14);
  --outline-faint: inset 0 0 0 1px rgb(var(--ink) / 0.04);
  --outline-subtle: inset 0 0 0 1px rgb(var(--ink) / 0.07);
  --outline-muted: inset 0 0 0 1px rgb(var(--ink) / 0.10);
  --outline-emphasis: inset 0 0 0 1px rgb(var(--ink) / 0.16);
  --outline-focus: inset 0 0 0 1px var(--focus-ring);
  --underline-focus-shadow: inset 0 -1px 0 rgb(var(--ink) / 0.20);
  --tag-focus-shadow: 0 0 0 2px color-mix(in srgb, var(--tag-text, currentColor) 22%, transparent);
  --shadow-thumb: 0 1px 2px rgba(0, 0, 0, 0.14);
  --shadow-thumb-strong: 0 1px 2px rgba(0, 0, 0, 0.18);

  /* ── Legacy product-token aliases. Existing component CSS keeps working; new
        code uses the semantic tokens above. Migrate opportunistically. NOTE:
        --accent-brand maps to the brand rose for its sparse accent roles only;
        where it (or the now-removed --primary) historically painted primary
        buttons / active states rose, those usages move to neutral --fill-*. ── */
  --deck-bg: var(--bg-window);
  --app-bg: var(--bg-window);
  --panel-bg: var(--bg-content);
  --surface: var(--bg-content);
  --surface-soft: var(--bg-elevated);
  --surface-disabled: var(--fill-3);
  --surface-user-bubble: var(--fill-3);
  --surface-inverse: #2e2e32;
  --surface-inverse-strong: #1f1f23;
  --text-main: var(--text-primary);
  --text-strong: var(--text-primary);
  --text-body: var(--text-primary);
  --text-sub: var(--text-secondary);
  --text-soft: var(--text-secondary);
  --text-muted: var(--text-tertiary);
  --text-faint: var(--text-tertiary);
  --text-disabled: var(--text-quaternary);
  --row-hover: var(--fill-2);
  --row-selected: var(--selection-bg);
  --border-subtle: var(--separator);
  --border-muted: var(--separator);
  --border-emphasis: rgb(var(--ink) / 0.18);
  --border-strong: rgb(var(--ink) / 0.30); /* strong control border, not the hairline */
  --control-hover: var(--fill-2);
  --control-active: var(--fill-3);
  --focus-border: var(--focus-ring);
  --accent-brand: var(--accent);
  /* NOTE: no --primary alias. It is deliberately absent (see Color & Appearance):
     its name implies a primary-action colour, but it historically mapped to rose
     and silently violated "functional state is neutral". Do not reintroduce it;
     action surfaces use the neutral --fill-* ladder + --focus-ring. */
  --semantic-success: var(--status-success);
  --semantic-success-strong: var(--status-success-strong);
  --semantic-danger-muted: var(--status-danger-muted);
  --semantic-warning: var(--status-warning);
  --semantic-info: var(--status-info);
  --resize-cursor: ew-resize;
  --resize-cursor-y: ns-resize;

  --space-hairline: 1px;
  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 10px;
  --space-6: 12px;
  --space-8: 16px;
  --space-micro: var(--space-2);
  --space-sm: var(--space-4);
  --space-md: var(--space-8);
  --space-lg: 24px;
  --space-xl: 32px;
  --layout-gap: var(--space-sm);

  /* Control box sizes — a tight 3-step ladder (20 / 24 / 28). */
  --control-size-xs: 20px;
  --control-size-md: 24px;
  --control-size-xl: 28px;
  --breadcrumb-height: var(--control-size-xl);
  --row-h-dense: var(--line-content);
  --row-h-comfortable: 44px;
  --icon-size-xs: 12px;
  --icon-size-sm: 14px;
  --icon-size-md: 16px;
  --icon-size-lg: 18px;
  --checkbox-mark-size: var(--icon-size-md);
  --checkbox-mark-radius: var(--radius-xs);
  --switch-mark-width: 30px; /* documented 30x18 track, wider than the 28px control box */
  --switch-mark-height: var(--icon-size-lg);
  --switch-mark-thumb-size: var(--icon-size-sm);
  --switch-mark-inset: var(--space-1);

  /* Radius is a deliberately short set. The everyday step is 5 / 6 / 8:
     rows 5, controls/chips/icon-buttons 6, small surfaces & the composer 8.
     Larger structural radii (10 menus, 12, 16 rail, 24 window) sit above it. */
  --radius-none: 0;
  --radius-2xs: 2px;
  --radius-xs: 3px;          /* checkbox / switch marks */
  --radius-row: 5px;         /* outliner rows */
  --radius-sm: 6px;          /* controls, chips, icon buttons */
  --radius-md: 8px;          /* small surfaces, composer */
  --radius-overlay-sm: 10px; /* menus / popovers */
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-window: 24px; /* OS window outer radius (macOS Tahoe). We don't draw
                            it — the OS does — but it is the head of the
                            concentric chain the floating rails inset from:
                            window 24 → (inset --layout-gap 8) → rail 16
                            → (inset --layout-gap 8) → composer 8. Every step
                            subtracts the gap, so all the nested corners share
                            one centre. */
  --radius-pill: 999px;
  /* concentric chain in code: rail = window − gap (24 − 8 = 16). */
  --workspace-surface-radius: calc(var(--radius-window) - var(--layout-gap));
  --panel-radius: var(--workspace-surface-radius);
  /* Composer is inset by --layout-gap inside the agent rail, so its bottom
     corners are CONCENTRIC with the rail's bottom corners: 16 − 8 = 8. */
  --agent-composer-radius: calc(var(--panel-radius) - var(--layout-gap));

  --motion-fast: 120ms ease;
  --motion-layout-duration: 160ms;
  --motion-layout: var(--motion-layout-duration) ease;
  --chrome-zone-backing-delay: var(--motion-layout-duration);
  --z-base: 0;
  --z-raised: 10;
  --z-resize: 30;
  --z-popover: 100;
  --z-agent-menu: 120;
  --z-editor-toolbar: 140;
  --z-modal: 200;
  --z-toast: 300;

  --row-edge: 6px;
  --row-leading-width: 42px;
  --row-leading-height: var(--line-content);
  --row-chevron-width: 15px;
  --row-chevron-gap: var(--space-2);
  --row-bullet-width: 15px;
  --row-content-gap: var(--space-4);
  --row-selection-start: 21px;

  /* Reading measure: outliner content centres in a bounded column on wide panes
     (~70–80 chars at 16px). Settings keeps a wider utility cap for two-column
     control grids. Chrome like the breadcrumb hugs the pane edge. */
  --reading-max: 720px;
  --settings-content-max-width: 920px;
  --panel-content-max: var(--reading-max);

  /* Native overlay scrollbar: thumb is a neutral ink alpha, never coloured and
     never permanently visible. Honors the OS "show scrollbars" setting. */
  --scrollbar-thumb: rgb(var(--ink) / 0.22);
}

/* Dark appearance. Follows the OS via prefers-color-scheme; the in-app
   light/dark/system control drives it through nativeTheme.themeSource, so this
   one block is the whole dark theme. Only the per-theme literals change — every
   alpha-on-ink token above (text, fills, separators, outlines) inverts for free
   when --ink flips to white. Elevated surfaces are LIGHTER than content. */
@media (prefers-color-scheme: dark) {
  :root {
    --ink: 255 255 255;

    --separator-opaque: #3a3a3c;
    --highlight-mark: rgba(120, 100, 30, 0.55);

    --bg-window: #2a2a2c;    /* chrome base behind the material */
    --bg-content: #1e1e1e;   /* opaque document canvas */
    --bg-elevated: #2e2e30;  /* menus/popovers float above content → lighter */

    --material-sidebar: rgba(40, 40, 42, 0.55);
    --material-popover: rgba(48, 48, 50, 0.72);
    --rail-edge: rgb(var(--ink) / 0.12);
    --shadow-rail: 0 8px 26px -8px rgba(0, 0, 0, 0.60), 0 1px 3px rgba(0, 0, 0, 0.40);

    /* brand + status nudged up for legibility on dark */
    --accent: #ff5d76;
    --accent-strong: #ff7088;
    --link: #4c9bff; /* link blue lifted to match macOS dark linkColor */
    --status-info: #5aa0e0;
    --status-success-strong: #5fc88a;

    /* inverse chips invert (dark-on-light in light mode → light-on-dark here) */
    --surface-inverse: #e6e6ea;
    --surface-inverse-strong: #f4f4f6;

    /* drop shadows go deeper so elevation still reads on a dark backdrop */
    --overlay-shadow-level-1: 0 8px 22px -12px rgba(0, 0, 0, 0.55), 0 2px 8px -4px rgba(0, 0, 0, 0.40);
    --overlay-shadow-level-2: 0 18px 50px -20px rgba(0, 0, 0, 0.60), 0 6px 18px -10px rgba(0, 0, 0, 0.45);
    --overlay-backdrop: rgba(0, 0, 0, 0.45);
    --overlay-backdrop-strong: rgba(0, 0, 0, 0.88);
  }
}
```

### Token Rules

- Product CSS keeps raw hex and raw functional color literals (`rgb()`, `rgba()`,
  `hsl()`, `hsla()`) inside token declarations only.
- Component CSS may use `color-mix()` for local alpha states, but the base color
  comes from a token.
- Primary text parity matters: outliner row text, field values, agent assistant
  prose, user bubbles, and the agent composer use
  `--font-content / --line-content`.
- Do not scale font size with viewport width.
- Inline code uses `--font-family-mono`, `--font-code-inline`, and the shared
  inline code color/background tokens. It should read as a compact badge inside
  prose, slightly smaller than body text. Use `--line-code-inline` so Latin and
  CJK fallback glyphs share a stable visual box.
- Code blocks use `--font-family-mono`, `--font-code-block`, and
  `--line-code-block`. They should be compact but not meta-sized; reserve
  `--font-meta / --line-meta` for labels and tool summaries.
- Code block chrome floats as top-right translucent controls over the opaque
  code surface. The language selector and copy button are separate surfaces,
  revealed on hover, keyboard focus, or while the language menu is open. Each
  surface uses `--material-popover` + `--material-backdrop`, so
  reduced-transparency and high-contrast fall back through the shared material
  tokens. Language and copy controls stay neutral; the copy affordance is
  circular, never a branded or square hover fill. The text viewport is inset
  inside the outer frame like file/PDF previews; long-line scrolling must not let
  text sit directly on the frame edge, and horizontal scrollbars sit in a
  reserved bottom gutter below the text, close to the frame's bottom edge rather
  than floating in the content field. Editable outliner code blocks grow
  naturally until `min(42vh, 420px)`, then scroll internally; the syntax
  highlight layer must stay synced to the textarea's horizontal and vertical
  scroll offsets.
- `--workspace-surface-radius` is the canonical outer radius for workspace
  structural surfaces. `--panel-radius` and `--agent-composer-radius` both map
  to it.
- **Concentric corners.** When one rounded surface nests inside another, the
  inner radius is `parent radius − inset`, so both corners share a single centre
  and the curves stay parallel. The canonical chain is window → rail:
  `--radius-window 24` − gap 8 = rail `16` (`--panel-radius`). A card nested
  inside the rail derives from 16 the same way (rail 16 − inset); never pick a
  nested radius by eye. The agent composer is the deliberate exception: it is
  *flush*, not a nested card, so it reuses the rail's own `--panel-radius` on its
  top corners (see [surfaces.md → Agent](./surfaces.md#agent)) rather than a
  concentric inset.
- **Interactive controls are capsules, not links in the concentric chain (B6).**
  Icon buttons and the composer's send / attach controls are *fully
  rounded* via `--radius-pill`: a square control renders as a circle, a wide one
  as a stadium, so every control of the same height shows the same corner arc
  (= half its height) and they line up regardless of which surface they float in.
  The concentric chain governs nested *surfaces*; a control floating inside a
  surface (with padding all around it) does not share that surface's corner, so it
  does NOT derive `parent − inset`. Never give such a control a small
  rounded-square radius — the failure mode is a 2px box sitting next to a circle
  (the composer send/attach controls had exactly this bug).
- **The 24pt window corner needs the native addon compiled (`bun run
  build:native`); once built it renders in `dev:*`, not only in a packaged
  build.** The OS owns the window's outer corner; the native addon
  (`applyMacWindowCorner`) rounds it to `--radius-window 24`. That addon
  (`native/window-corner/build/Release/window_corner.node`) is gitignored build
  output, so each clone must run `bun run build:native` once; until it does the
  call silently no-ops and the window keeps the OS-default 16pt corner — which
  reads as a *broken* radius, not a missing feature. With the addon built the
  24 → 16 → 8 concentric chain is verifiable in `dev:*`. A packaged build (`bun
  run app:build`, then install/launch the `.dmg`) is still required only for the
  provider-config modal-child window's native presentation — sheet-attach and
  parent-dim — which dev does not reproduce (D7).
- Overlay shadow tokens are pure drop shadows. Floating menus, popovers,
  tooltips, and dialogs do not use a real outer border.
- Focus uses neutral focus tokens, not brand color, unless the state is an
  error or destructive action.
- Product CSS references elevation, outline, size, spacing, and motion tokens
  instead of writing one-off system values.

### Color & Appearance

The colour system is **two themes over one semantic layer**, aligned with macOS.

- **Alpha-on-base ink.** Text, fills, separators, and outlines are an alpha over
  a single base, `--ink` (black in light, white in dark). Flipping `--ink` in the
  dark `@media` block re-themes all of them at once; only opaque surfaces,
  materials, and the accent carry explicit per-theme values.
- **Where alpha-on-ink is valid (hard boundary).** `--text-*` and `--fill-*` are
  only guaranteed legible on the neutral surfaces they were designed for:
  `--bg-window`, `--bg-content`, `--bg-elevated`, and the material tints. They are
  **not** valid on colored semantic surfaces. Any colored surface — tag
  backgrounds, status badges, the inverse chip, text over a strong material, user
  bubbles — must define its **own** foreground/background pair, not reach for the
  neutral ink levels.
- **Appearance.** `color-scheme: light dark` on `:root`; dark mode is one
  `@media (prefers-color-scheme: dark)` block. The in-app light/dark/system control
  (Settings › General › Theme) drives it through `nativeTheme.themeSource` (which
  sets the renderer's `prefers-color-scheme`), so the CSS needs no extra wiring; the
  choice persists in `app-preferences.json` and is reapplied before first paint.
  Scoped `@media (prefers-color-scheme: dark)` rules are allowed only for
  third-party / generated colour streams that cannot be expressed as foundation
  tokens (for example Shiki's `--shiki-light` / `--shiki-dark`) or for a documented
  blend-mode correction that would otherwise become illegible. They must stay
  local, commented, and must not introduce a renderer `[data-theme]` bridge.
- **Two-layer model (Liquid Glass).** Chrome — sidebar, toolbar, menus, floating
  controls — is the translucent material layer (`--material-*`, over Electron
  vibrancy + `backdrop-filter`). The content panel is the opaque layer
  (`--bg-content`) and stays fully legible. Never put a material on the content
  layer; never stack material on material.
- **Inactive-window chrome.** When the window loses OS focus, only the chrome
  material layer desaturates — the two floating rails — and **never** the content
  layer, the neutral functional-state ladder (selection / hover / focus), or the
  rose accent. Rationale: functional state is neutral by design and must stay
  legible regardless of focus (B3), and the single rose accent is too sparse for a
  global desaturate to read as anything but inconsistent (B4). macOS already greys
  the native traffic lights for free (`hiddenInset`), so the CSS only reinforces
  inactivity on the chrome glass; because the palette is near-monochrome the rail
  rule pairs a `saturate()` drop with a slight `brightness` dip (the part that
  actually reads as dimmed). Renderer wiring: a `window-inactive` root class fed
  by the main process's focus/blur (`core/windowActivity.ts` → App.tsx →
  shell.css).
- **Functional state is neutral.** Selection, hover, active rows, and ordinary
  interactive state use the neutral `--fill-*` ladder and neutral `--focus-ring`
  — not the brand colour and not the macOS system accent. The filled default
  action button is also neutral, but uses the inverse-surface idiom
  (`--surface-inverse` / `--surface-inverse-strong`) instead of the row-fill
  ladder so it reads as the default command without becoming a brand action.
  Native feel comes from materials, layout, and behaviour, not from coloured
  selection. The toggle / checkbox **on**-state carries `--control-on` (the macOS
  on-switch idiom) with a fixed-white knob / check glyph (`--text-on-accent`) in
  BOTH themes. It is deliberately separate from `--semantic-success`, so status
  green does not leak into non-status controls.
- **Text selection is neutral too.** The editor text-selection highlight
  (`::selection`, `--text-selection-bg`) is a neutral ink alpha — the one place
  the OS would normally paint its system accent, kept neutral for consistency
  with the rest of functional state. It is slightly stronger than a selected row
  so glyphs stay legible; the glyph colour itself does not change under selection.
- **Brand accent is sparse.** `--accent` (rose) appears only in: the text caret
  (`--caret`), the workspace-root avatar (the single in-rail brand mark — there
  is no separate static app brand header), the agent streaming / still-generating
  activity mark, and small status badges. The streaming mark is a branded activity
  beat, not a functional state; rose still never paints selection, focus, active
  rows, default actions, or links.
- **Links use a native link blue, not the rose.** `--link` is a fixed macOS link
  blue (`linkColor`) — the app's one coloured clickable affordance. It is
  decoupled from `--accent` so clickable text (external links, file and node
  references) reads as interactive, not as an error: the rose sat too close to
  `--status-danger`. It is the *fixed* link colour, NOT the user's variable
  system accent — adopting the variable accent for selection/focus is deliberately
  deferred, and those stay neutral per B3. Exactly one link colour app-wide:
  hover uses `--link-hover`, never rose.
- **Surfaces.** `--bg-window` is the chrome base behind the material;
  `--bg-content` is the opaque content panel; `--bg-elevated` is menus / popovers
  / HUD — in dark mode it is *lighter* than content so floating surfaces read as
  elevated.
- **Status.** `--status-success` (Sage), `--status-warning` (Mustard),
  `--status-info` (Sapphire), `--status-danger`. Status colour is reserved for
  genuine semantic state, not decoration. **It must never leak into interactive
  meaning** — status colours never paint selection, hover, active rows, focus, or
  any non-link clickable affordance. In particular `--status-info` (Sapphire) is
  for an *informational status* only; it is not a selection or accent colour, and
  painting functional state with it would read as a smuggled-in system accent
  (which we deliberately avoid — selection/focus stay neutral per B3). It is a
  distinct blue from `--link`: status blue marks state, the native link blue marks
  a clickable link, and the two never swap roles. The app has one accent (rose)
  and one link colour (the native link blue). Destructive confirmation buttons
  may use a solid danger fill (`--status-danger` with
  `--status-danger-solid-hover`) only when the command itself is destructive;
  ordinary destructive affordance hover remains neutral per the state table.
- **Dark-mode rules.** Avoid pure `#000`/`#fff`; lean on the alpha-on-ink levels
  and the `#1e1e1e` / `#2a2a2c` / `#2e2e30` surface seeds. Separators and outlines
  invert with `--ink` automatically; drop shadows deepen.
- **Legacy aliases.** `--deck-bg`, `--panel-bg`, `--text-main`, … are aliased onto
  this layer so existing components keep working; migrate to the semantic tokens
  opportunistically.
- **There is no `--primary` token — do not reintroduce it.** Its name implies a
  primary-action colour, but it historically mapped to the rose accent, so every
  surface that read it (many old primary buttons, active rows, focus surfaces) stayed
  rose and silently violated "functional state is neutral." Action surfaces use
  neutral state: rows and secondary controls use the `--fill-*` ladder (rest
  transparent or `--fill-1`, hover `--fill-2`, pressed `--fill-4`, selected
  `--fill-3`), keyboard focus uses neutral `--focus-ring`, and the default filled
  button uses the neutral inverse-surface pair (`--surface-inverse` /
  `--surface-inverse-strong`). Pre-launch means no compatibility burden: migrate
  any remaining `--primary` / `--accent-brand`-as-action usage in live CSS to the
  neutral contract and delete the alias outright, rather than keeping a rose shim.
  The brand colour survives only for the sparse accent roles above (caret, brand
  marks, status badges).

User-defined tag palette:

- Pickable presets are Red, Orange, Amber, Green, Blue, Purple, Pink, and Gray,
  stored as canonical color tokens.
- Chromatic tags keep a fixed accent hue for text and derive the chip background
  with `color-mix(in srgb, <accent> 12%, var(--surface))`, so the tint follows
  the live surface in light and dark mode.
- Gray is neutral, not a hardcoded slate chip: text uses `--text-secondary` and
  background uses `--fill-3`.
- The palette is closed: raw-hex or alias tag values are invalid/unset and fall
  back to deterministic identity tinting. Do not add legacy raw-hex readers or
  baked light-mode chip backgrounds.

### Materials & Liquid Glass

The material system is the new brand-defining layer. It is **inspired by**
Apple's Liquid Glass two-layer model — approximated within Electron, not the real
thing (see Cross-Platform Native Feel for the capability boundary): a translucent
**navigation/chrome layer** floats above an opaque, fully legible **content
layer**.

- **Content layer (the base):** the outliner panes and document canvas. Opaque
  (`--bg-content`), always fully legible, never translucent. It is a **full-bleed
  base** that fills the window and extends *underneath* the floating glass rails.
- **Chrome (glass) layer (floats on top):** the sidebar and the agent dock float
  as glass rails on a higher layer over the content base; menus, popovers, HUD,
  and floating controls are also chrome. The main app window has a single native
  window material (`under-window` vibrancy on macOS, Mica on Windows where
  available). Renderer surfaces opt into the app's glass layer with
  `background: var(--material-*)` plus `backdrop-filter: var(--material-backdrop)`.
  Menus and popovers are CSS material surfaces inside the window, not separate
  Electron vibrancy surfaces.

Rules:

- **Glass only on chrome.** Never apply a material to the content layer.
- **Never glass-on-glass.** A popover over the sidebar uses an elevated, more
  opaque material — not a second sheet of the same blur over the first.
- **Over-glass elements use fills, not their own blur.** Sidebar rows and toolbar
  buttons sit on the material with neutral `--fill-*` and vibrancy-aware text;
  they do not each carry a `backdrop-filter`.
- **Don't fake what only Metal can draw.** Refraction, lensing, specular edge
  highlights, and light-bending are not achievable in CSS. Approximate glass with
  blur + saturation and at most a thin top highlight — never simulate it with
  heavy shadows or busy gradients.
- **Tint adapts per theme; blur is constant.** `--material-*` carries the
  light/dark tint; the blur is a single constant across themes and surfaces —
  `--material-blur` (30px) with `--material-saturate` (112%). Don't hand-tune a
  different blur per surface.
- **Rails are floating, rounded, inset.** The sidebar and agent rails float on a
  higher layer: rounded corners and a small inset margin from the window edges,
  with a soft elevation so they read as forward of the content. Separation
  between a rail and the content is this float + the blur-through, **not** a flat
  hairline.
- **Hairlines live inside the content layer only.** Divisions *within* the content
  base — outliner pane ↔ pane — use a 1px `--separator` that thickens into the
  drag handle on hover. Do not draw a hairline between a glass rail and content;
  there the float does the separating.
- **Reserve drop shadows for surfaces that genuinely float free** (menus,
  dialogs, peek overlays). Rails use a soft, low elevation, not a heavy shadow.

**Material vs overlay taxonomy** (so implementers know what each surface uses):

| Tier | Surfaces | Treatment |
| --- | --- | --- |
| Chrome material | sidebar rail, agent rail | Translucent rail material (`--material-sidebar`) over OS vibrancy. |
| Elevated overlay | menus, popovers (`MenuSurface`) | Higher-opacity material (`--material-popover`) + level-1 shadow. Floats over content; not the same sheet as the rails. |
| Opaque elevated | dialogs, in-app command palette | Opaque `--bg-elevated` + level-2 shadow. Never translucent — these own the user's focus over busy in-app content. |
| System launcher | the global capture launcher (its own window) | Vibrant Spotlight/Raycast glass: OS `vibrancy` (`hud`) under a **transparent** CSS surface; functional fills + alpha-on-ink separators tint the glass, no second `backdrop-filter`. Native window shadow + custom 16px corner. Opaque `--bg-elevated` fallback under reduced-transparency / increased-contrast. |

So `MenuSurface` uses `--material-popover`; a `Dialog`/in-app command palette uses
`--bg-elevated`. Never glass-on-glass: an overlay opened over a rail steps up to
the elevated-overlay tier rather than stacking another rail material.

**The global launcher is the deliberate exception to the opaque-palette rule.**
As a *system* overlay summoned over other apps and the desktop (the Spotlight /
Raycast idiom), it IS vibrant glass, not the in-app opaque command palette. The
distinction is the backdrop: an in-app palette floats over our own busy content
(opaque, to own focus); the system launcher floats over the OS, where glass is
the native expectation. A `⌘K` menu opened inside it steps up to the opaque
elevated tier (`--bg-elevated` + level-1 shadow) — not a second sheet of glass.

**Reduced transparency fallback.** Honor `prefers-reduced-transparency` (the user
turned on macOS "Reduce transparency"): all materials collapse to their opaque
seeds — rails become `--bg-window`, overlays become `--bg-elevated`, blur is
dropped. HUD material tokens such as `--preview-action-*` also receive opaque
fallbacks; legibility never depends on the blur being present.

**Increased contrast.** Honor `prefers-contrast: more` (macOS "Increase
contrast"): strengthen the alpha-on-ink separators and outlines (step the
`--separator` / `--outline-*` ladder up), let materials lean more opaque, and
ensure text clears AA comfortably (approach AAA on primary text). State is still
neutral — contrast is raised by stroke weight, not by introducing colour.

**Inactive window.** When the app loses focus, follow the platform: native window
materials and traffic lights already desaturate, and the renderer reinforces that
only on the chrome material layer. A `.window-inactive` state (driven by the
BrowserWindow blur/focus events) desaturates and slightly darkens the floating
rails. It does **not** alter content, selected rows, text selection, breadcrumbs,
brand marks, or status colours; functional state remains legible and stable in a
backgrounded window.

Window material mapping:

| Window / surface | Native material | Renderer material contract |
| --- | --- | --- |
| Main app window | macOS `vibrancy: 'under-window'`; Windows `backgroundMaterial: 'mica'` when available | Root receives the detected `data-window-material`; rails and in-app material overlays use `--material-*` + `--material-backdrop` over the window material. |
| Sidebar and agent rails | Same main-window material underneath | Floating CSS rail surfaces use `--material-sidebar`, `--material-backdrop`, and `--rail-edge`. |
| Menus / popovers inside the app | Same main-window material underneath | CSS elevated-overlay tier: `--material-popover` + `--material-backdrop` + level-1 shadow. |
| Dialogs / in-app command palette | Same main-window material underneath | Opaque `--bg-elevated` + level-2 shadow; never translucent. |
| Global launcher window | macOS `vibrancy: 'hud'` | Transparent launcher surface over HUD material; functional fills tint the glass, no second `backdrop-filter`. |
| Settings / provider / agent / channel child windows | No OS material | Opaque preferences/config surfaces; no `data-window-material` glass contract. |

There is no separate full-width toolbar material: the top strip is the window's
drag region; over the content base it is transparent, over a rail it is the
rail's own material.

### Typography

Type roles map onto the Foundations font tokens; do not introduce new sizes.

- **Panel title:** `--title-display / --line-panel-title`, weight `600`.
- **Headings:** the title scale names the surface heading steps:
  `--title-display` (24), `--title-section` (18, markdown h1 / large section),
  and `--title-group` (13, list-section caption). Smaller headings reuse
  `--font-content` (16) and `--font-ui-md` (14) rather than a parallel ladder.
  Weight `600`.
- **Body / content (the reading + editing baseline):** `--font-content /
  --line-content` (16/26). Outliner rows, field values, agent assistant prose,
  user bubbles, and the composer all share this — primary-text parity is a rule.
- **UI / controls:** `--font-ui-2xs … --font-ui-md` (10–14px) for chrome, tabs,
  menus, and controls.
- **Meta:** `--font-meta` (12px) for labels, process rows, and tool summaries.
- **Code:** inline `--font-code-inline`; block `--font-code-block`.

Weights: body `400`; emphasis and titles `500`/`600`. Never signal state by
weight alone — pair it with color or fill. The system font stack supplies native
weights (SF on macOS).

CJK + Latin mixing: line-height tokens are tuned so Latin and CJK glyph boxes
share a stable visual line, so mixed runs do not change row height. Product CSS
keeps `letter-spacing: 0`; do not introduce tracking for labels, headings, codes,
or CJK text.

Scale: `--font-scale` on `:root` scales the whole system through `rem`. Never
scale font size with viewport width.

### Spacing & Grid

- **Base unit:** `2px` atomic (`--space-1`) on a `4 / 8` rhythm
  (`--space-4 = 8px`). Compose spacing from tokens; no one-off pixel values.
- **Layout gap:** shell gaps and insets use `--layout-gap` (`--space-sm`, 8px).
- **Alignment spine:** the outliner leading grid (`--row-leading-*`, columns
  `15px 4px 15px 8px`) is the shared spine. Breadcrumb, normal rows, reference
  rows, and field rows all align text-start to it.
- **Reading column:** outliner content is a centered, bounded reading column on
  wide panels — max width `--reading-max` (720px, ~70–80 chars at 16px), surfaced
  to panels as `--panel-content-max`. Chrome like the breadcrumb hugs the panel's
  left edge instead. Settings uses the distinct
  `--settings-content-max-width` (920px) utility cap because grouped control grids
  need more measure than prose.
- **Row-height tier:** `--row-h-dense` (26px) and `--row-h-comfortable` (44px) are
  the two consumed density steps. Outliner rows use the dense step; Settings inset
  rows use the comfortable step; agent process rows stay compact through their own
  line/padding geometry rather than a fixed row-height token, so the tier carries
  no separate "compact" rung.
- **Text gutters:** outliner, agent, and settings body text starts are intentionally
  tiered by each surface's affordance width. Do not flatten them into one x-offset;
  converge within a surface instead.
- **Dock widths:** sidebar `216px` (`180–280`); agent dock `330px` (`300–520`).

### Elevation, Radius & Stroke

- **Elevation:** two drop-shadow levels — level 1 (menus, popovers, tooltips) and
  level 2 (dialogs, command palette). Shadows are pure drop shadows; floating
  surfaces carry no real outer border. Dark mode deepens them. The glass rails
  carry their own *soft, low* elevation (they float above the content base) —
  `--shadow-rail`, the softest tier (rail < level-1 menus < level-2 dialogs), not
  a level-1/2 overlay shadow and not a hairline.
- **Radius:** a deliberately short ladder. The everyday step is **5 / 6 / 8** —
  rows `--radius-row` (5), controls/chips/icon-buttons `--radius-sm` (6), small
  surfaces & composer `--radius-md` (8). Above it sit the structural radii: menus
  `--radius-overlay-sm` (10), `--radius-lg` (12), the floating rail
  `--workspace-surface-radius` (16, = `--panel-radius`), and the OS window
  `--radius-window` (24) at the head of the concentric chain. Pills use
  `--radius-pill`. Nested corners always derive `parent radius − inset` so they
  stay concentric (see Token Rules).
- **Stroke / separators:** hairline `--separator` (alpha-on-ink, lets the
  backdrop blend) for in-content dividers; `--separator-opaque` for solid
  dividers; the `--outline-faint … --outline-emphasis` ladder for inset 1px
  outlines; `--outline-focus` for focus. Never a literal 1px black/white border —
  use the alpha-on-ink outline tokens so strokes invert with the theme.

### Icons

- **Style:** line (outline) icons aligned to SF Symbols' metrics and weight on
  macOS so they sit native beside system glyphs. Use filled variants only for
  selected/active toggles where a fill reads clearer.
- **Delivery:** `lucide-react` is the single product icon library rendered in the
  WebView — *not* the SF Symbols font. SF Symbols is licensed for system UI only
  and cannot be embedded, so we use lucide outline glyphs sized to the product
  grid and painted with `currentColor` so they inherit text-colour tokens. Keep
  one product icon source; provider logos and inline-file masks are separate
  identity/file-kind assets, not a second control icon library.
- **Grid & sizing:** icons live in fixed slots — `--icon-size-xs … --icon-size-lg`
  (12/14/16/18). The outliner bullet/chevron slot is `15px`; sidebar and tab icon
  slots are `16px` (bullets, emoji, and svg icons share the slot so titles do not
  shift).
- **Stroke:** ~`1.5px` optical at 16px, scaling with size; match the surrounding
  font weight so icons never look heavier than text.
- **Color:** icons inherit text-color tokens (`--text-secondary` at rest,
  `--text-primary` when active); never brand-colored except true brand marks.
- **Hover/active feedback:** an icon control responds by **deepening its colour**
  (`--text-secondary` → `--text-primary`), not by gaining a `--fill-*` box — see
  Interaction States. The colour change is mandatory (every control acknowledges
  the pointer); the box is what we omit. A control already at `--text-primary`
  (an active toggle) may instead carry the active state and needs no extra hover
  shift.
- **Naming:** semantic names for the concept or action (`disclosure`, not
  `chevron-right`), kebab-case, matching the owning component where applicable.

### Motion

- **Tokens:** `--motion-fast` (120ms) for hover/press/affordance reveals;
  `--motion-layout-duration` / `--motion-layout` (160ms) for layout shifts
  (resize, collapse, panel changes).
  Add new durations only with a clear role.
- **Easing:** standard `ease`; motion is functional feedback, never decoration.
- **What animates:** state and layout transitions. Content does not animate in;
  the first frame is the working surface (startup rule), not an entrance.
- **Rail slide (agent open/close).** The agent rail opens and closes by sliding,
  mirroring the sidebar: collapsing animates `transform: translate3d(...)` off the
  right window edge plus `opacity`, over `--motion-layout`. Only transform and
  opacity animate, so the rail moves as one GPU-composited layer and its
  transcript + composer ride along rigidly — they never re-wrap mid-animation.
  Rail slides are sibling-stable: opening or closing one floating rail must not
  mutate, resize, or repaint the opposite rail as part of the same reveal.
  Content-triggered reveals (for example, an outliner chat-source inline
  reference) follow the same choreography as the rail toggle: open the rail
  first, then scroll/highlight transcript content only after the rail reaches the
  open state. A collapsed, off-screen rail must not perform hidden scroll work
  during the opening frame.
  (Animating width/inset to "grow from the toggle" would reflow the panel body
  every frame; a content-bearing rail can't afford that, which is why it slides
  like the sidebar rather than unfurling.) The rail keeps its open width/position
  while collapsed; the fixed top-right toggle (window chrome) is the collapse
  control in both states. The collapsed corner chrome's opaque backing appears
  only after the rail slide completes, so it never paints a square over the
  rail's rounded corner during the close transition.
- **Reduced motion:** honor `prefers-reduced-motion` — collapse transitions to
  near-instant (the rail snaps open/closed, no slide). Never gate comprehension
  on an animation completing.
